import { createHash } from "node:crypto";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  decideProviderSourceCanonicalLifecycle,
  providerSourcePageCommitCanonicalJson,
  type ProviderSourceCanonicalProjectionPlan,
  type ProviderSourcePagePlan,
  type ProviderSourcePlannedOutcome,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import {
  enqueueSourceEstimatedEvRecomputationInTransaction,
} from "./estimated-ev-recomputation-repository.ts";
import {
  writeCanonicalProjectionBatch,
  type CanonicalProjectionWriteInput,
} from "./ingestion-page-batch-writer.ts";
import { ProviderSourceCheckpointRepository } from "./provider-source-checkpoint-repository.ts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import {
  ProviderSourceObservationRepository,
  resolveLaunchSourceRecordMeaning,
  type RecordDeliveryOccurrenceInput,
  type SourceDeliveryDisposition,
} from "./provider-source-observation-repository.ts";
import {
  PROVIDER_SOURCE_QUARANTINE_RETENTION_DAYS,
  PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS,
} from "./provider-source-persistence-types.ts";
import {
  ProviderSourceAtomicPagePersistenceError,
  validateProviderSourceAtomicPageInput,
  type ProviderSourceAtomicPagePersistenceInput,
} from "./provider-source-page-validation.ts";
import { lockProviderSourcePageOwnership } from "./provider-source-page-ownership.ts";
import {
  countProviderSourceUnresolvedRelationshipsByTuple,
  hasProviderSourceCanonicalKindConflict,
  loadCompleteProviderSourceEvInput,
  loadProviderSourceCanonicalHistoryByIdentity,
  lockProviderSourceCanonicalProjectionIdentities,
  providerSourceCanonicalProjectionIdentityKey,
  providerSourceProjectionCommand,
  providerSourceUnresolvedRelationshipKey,
  type ProviderSourceCanonicalHistoryRow,
} from "./provider-source-canonical-page-queries.ts";
import { advanceSettledPublicWatermark } from "./public-change-settlement-repository.ts";

const MILLISECONDS_PER_DAY = 86_400_000;

export {
  ProviderSourceAtomicPagePersistenceError,
  type ProviderSourceAtomicPagePersistenceErrorCode,
  type ProviderSourceAtomicPagePersistenceInput,
  type ProviderSourceProtectedNativeEvidence,
} from "./provider-source-page-validation.ts";

export interface ProviderSourceAtomicPageCommitResult {
  readonly kind: "committed" | "already_committed";
  readonly pageId: string;
  readonly checkpointFingerprint: string | null;
  readonly continuation: ProviderSourcePagePlan["normalizedPage"]["continuation"];
  readonly counts: Readonly<{
    inserted: number;
    revised: number;
    duplicate: number;
    quarantined: number;
    warnings: number;
    unresolvedRelationships: number;
    canonicalRevisions: number;
    evRequests: number;
  }>;
}

export interface ProviderSourcePageRepositoryOptions {
  readonly actorPseudonymKey: Uint8Array | string;
  /** Test-only failure injection used to prove the complete page rolls back. */
  readonly beforeCheckpointAdvance?: () => void | Promise<void>;
  /** Test-only barrier after exact canonical identities are serialized. */
  readonly afterCanonicalIdentityLock?: () => void | Promise<void>;
}

interface ExistingPageRow {
  readonly id: string;
  readonly requestAttemptId: string | null;
  readonly payloadHash: string;
  readonly sourceTypeKey: string | null;
  readonly sourceAdapterVersion: string | null;
  readonly normalizedContractVersion: string | null;
  readonly mapperKey: string | null;
  readonly mapperVersion: string | null;
  readonly identityNamespaceKey: string | null;
  readonly sourceInstanceId: string | null;
  readonly sourceRevisionId: string | null;
  readonly connectionProfileId: string | null;
  readonly connectionRevisionId: string | null;
  readonly connectionHealthGeneration: bigint | null;
  readonly runClaimLeaseId: string | null;
  readonly supervisorEpochId: string | null;
  readonly checkpointCodecVersion: string | null;
  readonly checkpointGeneration: bigint | null;
  readonly requestedCheckpointFingerprint: string | null;
  readonly nextCheckpointFingerprint: string | null;
  readonly continuationKind: "continue" | "poll_after" | null;
  readonly minimumDelaySeconds: number | null;
  readonly recordCounts: unknown;
  readonly normalizedCommitHash: string | null;
}

type CommitCounts = ProviderSourceAtomicPageCommitResult["counts"];
type MutableCommitCounts = {
  -readonly [Key in keyof CommitCounts]: CommitCounts[Key];
};

function invalidPlan(): never {
  throw new ProviderSourceAtomicPagePersistenceError("invalid_page_plan");
}

function asJson(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) invalidPlan();
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function asPrismaBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

function normalizedCommitHash(
  input: ProviderSourceAtomicPagePersistenceInput,
): string {
  return createHash("sha256")
    .update(providerSourcePageCommitCanonicalJson({
      plan: input.plan,
      protectedNativeEvidence: input.protectedNativeEvidence,
    }))
    .digest("hex");
}

function snapshotAtomicPageInput(
  input: ProviderSourceAtomicPagePersistenceInput,
): ProviderSourceAtomicPagePersistenceInput {
  return {
    pins: structuredClone(input.pins),
    plan: structuredClone(input.plan),
    protectedRawResponse: new Uint8Array(input.protectedRawResponse),
    protectedRawResponseSha256: input.protectedRawResponseSha256,
    protectedNativeEvidence: structuredClone(input.protectedNativeEvidence),
    nextCheckpointFingerprint: input.nextCheckpointFingerprint,
    committedAt: new Date(input.committedAt.getTime()),
  };
}

function checkpointBytes(value: string | null): Uint8Array<ArrayBuffer> | null {
  return value === null ? null : asPrismaBytes(new TextEncoder().encode(value));
}

function addRetentionDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * MILLISECONDS_PER_DAY);
}

function sourceRecordKind(
  outcome: Extract<ProviderSourcePlannedOutcome, { kind: "semantic" }>,
): "catalog" | "pull" | "trade" {
  return outcome.observation.kind;
}

function emptyCounts(warnings: number): MutableCommitCounts {
  return {
    inserted: 0,
    revised: 0,
    duplicate: 0,
    quarantined: 0,
    warnings,
    unresolvedRelationships: 0,
    canonicalRevisions: 0,
    evRequests: 0,
  };
}

function storedCounts(value: unknown): CommitCounts | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = [
    "inserted",
    "revised",
    "duplicate",
    "quarantined",
    "warnings",
    "unresolvedRelationships",
    "canonicalRevisions",
    "evRequests",
  ] as const;
  if (
    fields.some(
      (field) =>
        !Number.isSafeInteger(record[field]) || Number(record[field]) < 0,
    )
  ) return null;
  return Object.fromEntries(
    fields.map((field) => [field, Number(record[field])]),
  ) as unknown as CommitCounts;
}

function pageEvidence(
  input: ProviderSourceAtomicPagePersistenceInput,
): Prisma.InputJsonValue {
  return asJson({
    normalizedPage: input.plan.normalizedPage,
    protectedNativeEvidenceReferences: input.protectedNativeEvidence.map(
      ({ reference }) => reference,
    ),
  });
}

function exactQuarantineEvidence(
  evidence: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  references: readonly (string | null)[],
  normalizedObservation: unknown,
): Prisma.InputJsonValue {
  return asJson({
    evidence: references.flatMap((reference) =>
      reference === null
        ? []
        : [{ reference, value: evidence.get(reference) ?? invalidPlan() }],
    ),
    normalizedObservation,
  });
}

export class ProviderSourcePageRepository {
  readonly #checkpoints: ProviderSourceCheckpointRepository;
  readonly #diagnostics: ProviderSourceDiagnosticRepository;
  readonly #observations = new ProviderSourceObservationRepository();

  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly options: ProviderSourcePageRepositoryOptions,
  ) {
    this.#checkpoints = new ProviderSourceCheckpointRepository(database);
    this.#diagnostics = new ProviderSourceDiagnosticRepository(database);
  }

  async commitPage(
    callerInput: ProviderSourceAtomicPagePersistenceInput,
  ): Promise<ProviderSourceAtomicPageCommitResult> {
    let input: ProviderSourceAtomicPagePersistenceInput;
    try {
      // Snapshot before validation and before the first asynchronous boundary.
      // Callers retain no mutable authority over the validated command.
      input = snapshotAtomicPageInput(callerInput);
      validateProviderSourceAtomicPageInput(input);
    } catch (error) {
      if (error instanceof ProviderSourceAtomicPagePersistenceError) throw error;
      throw new ProviderSourceAtomicPagePersistenceError("invalid_page_plan");
    }
    return this.database.$transaction(async (transaction) => {
      const replay = await this.loadExactReplay(transaction, input);
      if (replay) return replay;
      let committedAt: Date;
      try {
        committedAt = await lockProviderSourcePageOwnership(
          transaction,
          input,
        );
      } catch (error) {
        // A concurrent exact replay can advance the mutable run turn before
        // this transaction reaches the run lock. The already-committed page
        // remains the durable authority, but only after its complete pins and
        // content are revalidated by loadExactReplay.
        const concurrentReplay = await this.loadExactReplay(transaction, input);
        if (concurrentReplay) return concurrentReplay;
        throw error;
      }
      const serializedReplay = await this.loadExactReplay(transaction, input);
      if (serializedReplay) return serializedReplay;

      const canonicalScope = {
        organizationId: input.pins.organizationId,
        provider: input.pins.provider,
      } as const;
      const mappedProjections = input.plan.outcomes.flatMap((outcome) =>
        outcome.kind === "semantic" && outcome.mapping.status === "mapped"
          ? outcome.mapping.projections
          : []
      );
      await lockProviderSourceCanonicalProjectionIdentities(
        transaction,
        input.pins.organizationId,
        mappedProjections,
      );
      await this.options.afterCanonicalIdentityLock?.();

      const requestedCheckpoint = checkpointBytes(
        input.pins.requestedCheckpoint.value,
      );
      const nextCheckpoint = checkpointBytes(
        input.plan.normalizedPage.nextCheckpoint.value,
      );
      const continuation = input.plan.normalizedPage.continuation;
      await transaction.import_pages.create({
        data: {
          id: input.pins.pageId,
          organization_id: input.pins.organizationId,
          provider_id: input.pins.providerId,
          run_id: input.pins.runId,
          page_number: input.pins.pageNumber,
          payload_json: pageEvidence(input),
          payload_hash: input.protectedRawResponseSha256,
          record_counts_json: asJson({ ...input.plan.counts }),
          committed_at: committedAt,
          expires_at: addRetentionDays(
            committedAt,
            PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS,
          ),
          source_instance_id: input.pins.sourceInstanceId,
          source_revision_id: input.pins.sourceRevisionId,
          source_type_key: input.pins.sourceTypeKey,
          source_adapter_version: input.pins.sourceAdapterVersion,
          normalized_contract_version: input.pins.normalizedContractVersion,
          mapper_key: input.pins.mapperKey,
          mapper_version: input.pins.mapperVersion,
          identity_namespace_key: input.pins.identityNamespaceKey,
          connection_profile_id: input.pins.connectionProfileId,
          connection_revision_id: input.pins.connectionRevisionId,
          connection_health_generation: input.pins.connectionHealthGeneration,
          request_attempt_id: input.pins.requestAttemptId,
          run_claim_lease_id: input.pins.runClaimLeaseId,
          supervisor_epoch_id: input.pins.supervisorEpochId,
          checkpoint_codec_version: input.pins.checkpointCodecVersion,
          checkpoint_generation: input.pins.checkpointGeneration,
          requested_checkpoint: requestedCheckpoint,
          requested_checkpoint_fingerprint:
            input.pins.requestedCheckpointFingerprint,
          requested_checkpoint_key:
            input.pins.requestedCheckpointFingerprint ?? "initial",
          next_checkpoint: nextCheckpoint,
          next_checkpoint_fingerprint: input.nextCheckpointFingerprint,
          continuation_kind: continuation.kind,
          minimum_delay_seconds:
            continuation.kind === "poll_after"
              ? continuation.minimumDelaySeconds
              : null,
          protected_raw_response: asPrismaBytes(input.protectedRawResponse),
          protected_raw_response_sha256: input.protectedRawResponseSha256,
          normalized_commit_hash: normalizedCommitHash(input),
        },
      });

      const evidence = new Map(
        input.protectedNativeEvidence.map((item) => [item.reference, item.value]),
      );
      const counts = emptyCounts(input.plan.counts.warnings);
      const evCauses = new Map<string, bigint[]>();

      // The advisory locks above serialize every mapped identity, so the
      // committed history cannot change for the rest of this transaction
      // except through this page's own writes. Those writes are deferred into
      // one batch, and inPageHistoryByIdentity mirrors them so later records
      // decide against exactly the history a reload would have returned.
      const storedHistoryByIdentity =
        await loadProviderSourceCanonicalHistoryByIdentity(
          transaction,
          canonicalScope,
          mappedProjections,
        );
      const inPageHistoryByIdentity = new Map<
        string,
        ProviderSourceCanonicalHistoryRow[]
      >();
      const deferredProjectionWrites: Array<{
        write: CanonicalProjectionWriteInput;
        projection: ProviderSourceCanonicalProjectionPlan;
        becomesCurrent: boolean;
      }> = [];
      const deferredDeliveryOccurrences: RecordDeliveryOccurrenceInput[] = [];
      const deliveredProjectionPlans: Array<
        readonly ProviderSourceCanonicalProjectionPlan[]
      > = [];
      let sourceRevisionFenceVerified = false;

      for (const outcome of input.plan.outcomes) {
        if (outcome.kind === "adapter_invalid") {
          await this.recordQuarantine(transaction, input, outcome, evidence, committedAt, {
            sourceRecordId: null,
            semanticObservationId: null,
            recordKind: null,
            externalId: null,
            collectedAt: committedAt,
            reasonCode: outcome.reasonCode,
          });
          counts.quarantined += 1;
          continue;
        }

        const identity = outcome.semanticContent.providerRecordIdentity;
        const meaning = resolveLaunchSourceRecordMeaning(
          identity.recordIdScopeKey,
        );
        const semantic =
          await this.#observations.upsertSemanticObservationInTransaction(
            transaction,
            {
              organizationId: input.pins.organizationId,
              providerId: input.pins.providerId,
              sourceInstanceId: input.pins.sourceInstanceId,
              sourceRevisionId: input.pins.sourceRevisionId,
              recordIdScopeKey: identity.recordIdScopeKey,
              providerRecordId: identity.providerRecordId,
              effectiveSourceTime: new Date(outcome.semanticContent.effectiveAt),
              normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
              hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
              normalizedContentHash: outcome.normalizedContentHash,
              normalizedContent: outcome.semanticContent,
              ...meaning,
            },
            // The fence fields are page-constant pins, so the first record's
            // check inside this transaction covers every later record.
            { skipSourceRevisionFenceCheck: sourceRevisionFenceVerified },
          );
        sourceRevisionFenceVerified = true;
        if (semantic.kind === "identity_conflict") {
          await this.recordQuarantine(transaction, input, outcome, evidence, committedAt, {
            sourceRecordId: semantic.sourceRecordId,
            semanticObservationId: null,
            recordKind: sourceRecordKind(outcome),
            externalId: identity.providerRecordId,
            collectedAt: new Date(outcome.observation.collectedAt),
            reasonCode: semantic.reasonCode,
          });
          counts.quarantined += 1;
          continue;
        }
        if (outcome.mapping.status === "quarantined") {
          await this.recordQuarantine(transaction, input, outcome, evidence, committedAt, {
            sourceRecordId: semantic.sourceRecordId,
            semanticObservationId: semantic.semanticObservationId,
            recordKind: sourceRecordKind(outcome),
            externalId: identity.providerRecordId,
            collectedAt: new Date(outcome.observation.collectedAt),
            reasonCode: outcome.mapping.reasonCode,
          });
          counts.quarantined += 1;
          continue;
        }

        if (
          await hasProviderSourceCanonicalKindConflict(
            transaction,
            input.pins.organizationId,
            semantic.sourceRecordId,
            outcome.mapping.projections,
          )
        ) {
          await this.recordQuarantine(transaction, input, outcome, evidence, committedAt, {
            sourceRecordId: semantic.sourceRecordId,
            semanticObservationId: semantic.semanticObservationId,
            recordKind: sourceRecordKind(outcome),
            externalId: identity.providerRecordId,
            collectedAt: new Date(outcome.observation.collectedAt),
            reasonCode: "identity_kind_conflict",
          });
          counts.quarantined += 1;
          continue;
        }

        const decisions = [] as Array<{
          projection: ProviderSourceCanonicalProjectionPlan;
          disposition: "inserted" | "revised" | "duplicate";
          becomesCurrent: boolean;
        }>;
        let conflictReason: "identity_kind_conflict" | "immutable_content_conflict" | null = null;
        for (const projection of outcome.mapping.projections) {
          const identityKey =
            providerSourceCanonicalProjectionIdentityKey(projection);
          // Earlier records' accepted-but-deferred writes extend the stored
          // history; this record's own earlier projections do not, matching
          // the immediate-write ordering this loop previously produced.
          const history = [
            ...(storedHistoryByIdentity.get(identityKey) ?? []),
            ...(inPageHistoryByIdentity.get(identityKey) ?? []),
          ];
          const decision = decideProviderSourceCanonicalLifecycle({
            recordIdScopeKey: projection.recordIdScopeKey,
            canonicalKind: projection.recordKind,
            contentFingerprint: projection.contentFingerprint,
            effectiveAt: projection.effectiveAt,
            existingBinding: null,
            revisions: history.map((revision) => ({
              contentFingerprint: revision.contentFingerprint,
              effectiveAt: revision.effectiveAt.toISOString(),
            })),
          });
          if (decision.disposition === "quarantined") {
            conflictReason = decision.reasonCode;
            break;
          }
          decisions.push({
            projection,
            disposition: decision.disposition,
            becomesCurrent: decision.becomesCurrent,
          });
        }
        if (conflictReason) {
          await this.recordQuarantine(transaction, input, outcome, evidence, committedAt, {
            sourceRecordId: semantic.sourceRecordId,
            semanticObservationId: semantic.semanticObservationId,
            recordKind: sourceRecordKind(outcome),
            externalId: identity.providerRecordId,
            collectedAt: new Date(outcome.observation.collectedAt),
            reasonCode: conflictReason,
          });
          counts.quarantined += 1;
          continue;
        }

        const changes = decisions.filter(
          (decision) => decision.disposition !== "duplicate",
        );
        for (const [projectionIndex, change] of changes.entries()) {
          deferredProjectionWrites.push({
            write: {
              organizationId: input.pins.organizationId,
              providerId: input.pins.providerId,
              origin: {
                kind: "semantic_observation" as const,
                sourceRevisionId: input.pins.sourceRevisionId,
                semanticObservationId: semantic.semanticObservationId,
              },
              projection: providerSourceProjectionCommand(
                change.projection,
                outcome.observation.collectedAt,
              ),
              projectionIndex,
              becomesCurrent: change.becomesCurrent,
              acceptedAt: committedAt,
              publicChangeKind: "provider_projection",
            },
            projection: change.projection,
            becomesCurrent: change.becomesCurrent,
          });
          // Mirror the batch writer's durable row for later records: the plan
          // validation pins contentFingerprint to the writer's content hash,
          // and the writer stores source_updated_at as new Date(effectiveAt).
          const identityKey =
            providerSourceCanonicalProjectionIdentityKey(change.projection);
          const pending = inPageHistoryByIdentity.get(identityKey) ?? [];
          pending.push({
            contentFingerprint: change.projection.contentFingerprint,
            effectiveAt: new Date(change.projection.effectiveAt),
          });
          inPageHistoryByIdentity.set(identityKey, pending);
        }

        const disposition: Exclude<SourceDeliveryDisposition, "quarantined"> =
          decisions.some(({ disposition: value }) => value === "revised")
            ? "revised"
            : decisions.some(({ disposition: value }) => value === "inserted")
              ? "inserted"
              : "duplicate";
        counts[disposition] += 1;
        deferredDeliveryOccurrences.push({
          ...this.occurrencePins(input),
          recordIndex: outcome.recordIndex,
          sourceRecordId: semantic.sourceRecordId,
          semanticObservationId: semantic.semanticObservationId,
          collectedAt: new Date(outcome.observation.collectedAt),
          nativeEvidenceReference: outcome.protectedNativeEvidenceRef,
          disposition,
        });
        deliveredProjectionPlans.push(outcome.mapping.projections);
      }

      if (deferredProjectionWrites.length > 0) {
        const writes = await writeCanonicalProjectionBatch(
          transaction,
          { retentionDays: 90, actorPseudonymKey: this.options.actorPseudonymKey },
          deferredProjectionWrites.map(({ write }) => write),
        );
        counts.canonicalRevisions += writes.filter(({ created }) => created).length;
        for (const [index, write] of writes.entries()) {
          const { projection, becomesCurrent } = deferredProjectionWrites[index]!;
          if (!write.created || !becomesCurrent) continue;
          if (projection.evInputStatus !== "ready") continue;
          const packId = projection.recordKind === "pack"
            ? projection.providerRecordId
            : projection.recordKind === "ev_input"
              ? projection.affectedPackProviderRecordId
              : null;
          if (packId) {
            const causes = evCauses.get(packId) ?? [];
            causes.push(write.publicChangeSequence);
            evCauses.set(packId, causes);
          }
        }
      }
      await this.#observations.recordDeliveryOccurrencesInTransaction(
        transaction,
        deferredDeliveryOccurrences,
      );
      if (deliveredProjectionPlans.length > 0) {
        const unresolvedCounts =
          await countProviderSourceUnresolvedRelationshipsByTuple(
            transaction,
            canonicalScope,
            deliveredProjectionPlans.flat(),
          );
        // Sum per delivered record so tuples shared between records keep the
        // same per-record multiplicity the sequential counts produced.
        for (const projections of deliveredProjectionPlans) {
          for (const projection of projections) {
            for (const relationship of projection.relationships) {
              counts.unresolvedRelationships += unresolvedCounts.get(
                providerSourceUnresolvedRelationshipKey(
                  projection,
                  relationship,
                ),
              ) ?? 0;
            }
          }
        }
      }

      for (const [packExternalId, causeSequences] of evCauses) {
        const current = await loadCompleteProviderSourceEvInput(
          transaction,
          {
            organizationId: input.pins.organizationId,
            provider: input.pins.provider,
          },
          packExternalId,
        );
        if (!current) continue;
        const request = await enqueueSourceEstimatedEvRecomputationInTransaction(
          transaction,
          {
            organizationId: input.pins.organizationId,
            providerId: input.pins.providerId,
            sourceInstanceId: input.pins.sourceInstanceId,
            sourceRevisionId: input.pins.sourceRevisionId,
            platformKey: input.pins.provider,
            packExternalId,
            evInputExternalId: current.evInputExternalId,
            packRevisionId: current.packRevisionId,
            evInputRevisionId: current.evInputRevisionId,
            causeSequences: [...new Set(causeSequences)],
            createdAt: committedAt,
          },
        );
        if (request.created) counts.evRequests += 1;
      }

      await transaction.import_pages.update({
        where: { id: input.pins.pageId },
        data: {
          record_counts_json: asJson({
            ...input.plan.counts,
            ...counts,
          }),
        },
      });
      await this.updateRunCounters(transaction, input, counts);
      await this.#diagnostics.appendInTransaction(transaction, {
        organizationId: input.pins.organizationId,
        scope: "source",
        correlationKind: "page",
        eventKind: "source_page",
        severity: "info",
        phase: "commit",
        safeCode: "PAGE_COMMITTED",
        occurredAt: committedAt,
        durationMs: input.plan.normalizedPage.measurements.durationMilliseconds,
        responseBytes: input.plan.normalizedPage.measurements.responseBytes,
        counters: {
          inserted: counts.inserted,
          revised: counts.revised,
          duplicate: counts.duplicate,
          quarantined: counts.quarantined,
          warnings: counts.warnings,
          unresolved_relationships: counts.unresolvedRelationships,
          canonical_revisions: counts.canonicalRevisions,
          ev_requests: counts.evRequests,
          records: input.plan.outcomes.length,
        },
        continuation,
        checkpointFingerprint: input.nextCheckpointFingerprint,
        sourceTypeKey: input.pins.sourceTypeKey,
        sourceAdapterVersion: input.pins.sourceAdapterVersion,
        normalizedContractVersion: input.pins.normalizedContractVersion,
        providerId: input.pins.providerId,
        sourceInstanceId: input.pins.sourceInstanceId,
        sourceRevisionId: input.pins.sourceRevisionId,
        connectionProfileId: input.pins.connectionProfileId,
        connectionRevisionId: input.pins.connectionRevisionId,
        runId: input.pins.runId,
        pageId: input.pins.pageId,
        requestAttemptId: input.pins.requestAttemptId,
        runTrigger: input.pins.runTrigger,
        evidence: { continuation_kind: continuation.kind },
      });

      await this.options.beforeCheckpointAdvance?.();
      const checkpoint = await this.#checkpoints.advanceInTransaction(
        transaction,
        {
          organizationId: input.pins.organizationId,
          providerId: input.pins.providerId,
          sourceInstanceId: input.pins.sourceInstanceId,
          sourceRevisionId: input.pins.sourceRevisionId,
          sourceAdapterVersion: input.pins.sourceAdapterVersion,
          checkpointCodecVersion: input.pins.checkpointCodecVersion,
          checkpointGeneration: input.pins.checkpointGeneration,
          expectedCheckpointFingerprint:
            input.pins.requestedCheckpointFingerprint,
          nextCheckpoint,
          nextCheckpointFingerprint: input.nextCheckpointFingerprint,
          continuation,
          runId: input.pins.runId,
          pageId: input.pins.pageId,
          pageNumber: input.pins.pageNumber,
          requestAttemptId: input.pins.requestAttemptId,
          connectionProfileId: input.pins.connectionProfileId,
          connectionRevisionId: input.pins.connectionRevisionId,
          expectedHealthGeneration: input.pins.connectionHealthGeneration,
          supervisorEpochId: input.pins.supervisorEpochId,
          supervisorOwnerKey: input.pins.supervisorOwnerKey,
          supervisorLeaseToken: input.pins.supervisorLeaseToken,
          runLeaseOwner: input.pins.runLeaseOwner,
          runLeaseToken: input.pins.runLeaseToken,
          committedAt,
        },
      );
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.pins.organizationId,
        settledAt: committedAt,
      });
      return {
        kind: "committed",
        pageId: input.pins.pageId,
        checkpointFingerprint: checkpoint.fingerprint,
        continuation,
        counts,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private occurrencePins(input: ProviderSourceAtomicPagePersistenceInput) {
    return {
      organizationId: input.pins.organizationId,
      providerId: input.pins.providerId,
      sourceInstanceId: input.pins.sourceInstanceId,
      sourceRevisionId: input.pins.sourceRevisionId,
      runId: input.pins.runId,
      pageId: input.pins.pageId,
      requestAttemptId: input.pins.requestAttemptId,
      sourceTypeKey: input.pins.sourceTypeKey,
      sourceAdapterVersion: input.pins.sourceAdapterVersion,
      normalizedContractVersion: input.pins.normalizedContractVersion,
      mapperKey: input.pins.mapperKey,
      mapperVersion: input.pins.mapperVersion,
      identityNamespaceKey: input.pins.identityNamespaceKey,
      checkpointCodecVersion: input.pins.checkpointCodecVersion,
      checkpointGeneration: input.pins.checkpointGeneration,
      connectionHealthGeneration: input.pins.connectionHealthGeneration,
      supervisorEpochId: input.pins.supervisorEpochId,
      connectionProfileId: input.pins.connectionProfileId,
      connectionRevisionId: input.pins.connectionRevisionId,
    } as const;
  }

  private async recordQuarantine(
    transaction: PackscoutTransactionClient,
    input: ProviderSourceAtomicPagePersistenceInput,
    outcome: ProviderSourcePlannedOutcome,
    evidence: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
    committedAt: Date,
    decision: Readonly<{
      sourceRecordId: string | null;
      semanticObservationId: string | null;
      recordKind: "catalog" | "pull" | "trade" | null;
      externalId: string | null;
      collectedAt: Date;
      reasonCode: string;
    }>,
  ): Promise<void> {
    const occurrence =
      await this.#observations.recordDeliveryOccurrenceInTransaction(
        transaction,
        {
          ...this.occurrencePins(input),
          recordIndex: outcome.recordIndex,
          sourceRecordId: decision.sourceRecordId,
          semanticObservationId: decision.semanticObservationId,
          collectedAt: decision.collectedAt,
          nativeEvidenceReference: outcome.protectedNativeEvidenceRef,
          disposition: "quarantined",
          reasonCode: decision.reasonCode,
        },
      );
    const transactionReference = outcome.kind === "semantic"
      ? outcome.protectedTransactionEvidenceRef
      : null;
    await transaction.quarantine_records.create({
      data: {
        organization_id: input.pins.organizationId,
        provider_id: input.pins.providerId,
        source_record_id: null,
        record_kind: decision.recordKind,
        external_id: decision.externalId,
        reason_code: decision.reasonCode,
        sanitized_summary: `Normalized source record quarantined: ${decision.reasonCode}.`,
        payload_json: exactQuarantineEvidence(evidence, [
          outcome.protectedNativeEvidenceRef,
          transactionReference,
        ], outcome.kind === "semantic" ? outcome.observation : null),
        expires_at: addRetentionDays(
          committedAt,
          PROVIDER_SOURCE_QUARANTINE_RETENTION_DAYS,
        ),
        run_id: input.pins.runId,
        page_id: input.pins.pageId,
        record_index: outcome.recordIndex,
        delivery_occurrence_id: occurrence.occurrenceId,
        created_at: committedAt,
      },
    });
  }

  private async updateRunCounters(
    transaction: PackscoutTransactionClient,
    input: ProviderSourceAtomicPagePersistenceInput,
    counts: CommitCounts,
  ): Promise<void> {
    const [row] = await transaction.$queryRaw<Array<{ counters: unknown }>>(Prisma.sql`
      select counters_json as counters
      from public.import_runs
      where id = ${input.pins.runId}::uuid
        and organization_id = ${input.pins.organizationId}::uuid
      for update
    `);
    const current = typeof row?.counters === "object" && row.counters !== null
      ? row.counters as Record<string, unknown>
      : {};
    const increment = (
      key: keyof CommitCounts | "pages" | "records" | "catalog" | "pulls" | "trades",
      value: number,
    ) =>
      Number.isSafeInteger(current[key]) && Number(current[key]) >= 0
        ? Number(current[key]) + value
        : value;
    await transaction.import_runs.update({
      where: { id: input.pins.runId },
      data: {
        counters_json: asJson({
          ...current,
          pages: increment("pages", 1),
          records: increment("records", input.plan.outcomes.length),
          catalog: increment("catalog", input.plan.counts.catalog),
          pulls: increment("pulls", input.plan.counts.pulls),
          trades: increment("trades", input.plan.counts.trades),
          ...Object.fromEntries(
            Object.entries(counts).map(([key, value]) => [
              key,
              increment(key as keyof CommitCounts, value),
            ]),
          ),
        }),
      },
    });
  }

  private async loadExactReplay(
    transaction: PackscoutTransactionClient,
    input: ProviderSourceAtomicPagePersistenceInput,
  ): Promise<ProviderSourceAtomicPageCommitResult | null> {
    const rows = await transaction.$queryRaw<ExistingPageRow[]>(Prisma.sql`
      select id,
             request_attempt_id as "requestAttemptId",
             payload_hash as "payloadHash",
             source_type_key as "sourceTypeKey",
             source_adapter_version as "sourceAdapterVersion",
             normalized_contract_version as "normalizedContractVersion",
             mapper_key as "mapperKey",
             mapper_version as "mapperVersion",
             identity_namespace_key as "identityNamespaceKey",
             source_instance_id as "sourceInstanceId",
             source_revision_id as "sourceRevisionId",
             connection_profile_id as "connectionProfileId",
             connection_revision_id as "connectionRevisionId",
             connection_health_generation as "connectionHealthGeneration",
             run_claim_lease_id as "runClaimLeaseId",
             supervisor_epoch_id as "supervisorEpochId",
             checkpoint_codec_version as "checkpointCodecVersion",
             checkpoint_generation as "checkpointGeneration",
             requested_checkpoint_fingerprint as "requestedCheckpointFingerprint",
             next_checkpoint_fingerprint as "nextCheckpointFingerprint",
             continuation_kind::text as "continuationKind",
             minimum_delay_seconds as "minimumDelaySeconds",
             record_counts_json as "recordCounts",
             normalized_commit_hash as "normalizedCommitHash"
      from public.import_pages
      where run_id = ${input.pins.runId}::uuid
        and organization_id = ${input.pins.organizationId}::uuid
        and provider_id = ${input.pins.providerId}::uuid
        and page_number = ${input.pins.pageNumber}
      for share
    `);
    const page = rows[0];
    if (!page) return null;
    const continuation = input.plan.normalizedPage.continuation;
    const counts = storedCounts(page.recordCounts);
    if (
      page.id !== input.pins.pageId ||
      page.requestAttemptId !== input.pins.requestAttemptId ||
      page.payloadHash !== input.protectedRawResponseSha256 ||
      page.normalizedCommitHash !== normalizedCommitHash(input) ||
      page.sourceTypeKey !== input.pins.sourceTypeKey ||
      page.sourceAdapterVersion !== input.pins.sourceAdapterVersion ||
      page.normalizedContractVersion !== input.pins.normalizedContractVersion ||
      page.mapperKey !== input.pins.mapperKey ||
      page.mapperVersion !== input.pins.mapperVersion ||
      page.identityNamespaceKey !== input.pins.identityNamespaceKey ||
      page.sourceInstanceId !== input.pins.sourceInstanceId ||
      page.sourceRevisionId !== input.pins.sourceRevisionId ||
      page.connectionProfileId !== input.pins.connectionProfileId ||
      page.connectionRevisionId !== input.pins.connectionRevisionId ||
      page.connectionHealthGeneration !== input.pins.connectionHealthGeneration ||
      page.runClaimLeaseId !== input.pins.runClaimLeaseId ||
      page.supervisorEpochId !== input.pins.supervisorEpochId ||
      page.checkpointCodecVersion !== input.pins.checkpointCodecVersion ||
      page.checkpointGeneration !== input.pins.checkpointGeneration ||
      page.requestedCheckpointFingerprint !==
        input.pins.requestedCheckpointFingerprint ||
      page.nextCheckpointFingerprint !== input.nextCheckpointFingerprint ||
      page.continuationKind !== continuation.kind ||
      page.minimumDelaySeconds !==
        (continuation.kind === "poll_after"
          ? continuation.minimumDelaySeconds
          : null) ||
      !counts
    ) {
      throw new ProviderSourceAtomicPagePersistenceError(
        "idempotency_conflict",
      );
    }
    return {
      kind: "already_committed",
      pageId: page.id,
      checkpointFingerprint: page.nextCheckpointFingerprint,
      continuation,
      counts,
    };
  }
}
