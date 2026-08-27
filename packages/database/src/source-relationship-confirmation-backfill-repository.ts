import {
  MAX_APPROVED_PUBLIC_PLATFORMS,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  normalizedObservationSemanticContentSchema,
  providerPlatformKeySchema,
  type LaunchProviderKey,
  type ProviderSourceCanonicalProjectionPlan,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { writeCanonicalProjectionBatch } from
  "./ingestion-page-batch-writer.ts";
import { PROTECTED_PAYLOAD_RETENTION_DAYS } from "./pipeline-types.ts";
import { providerSourceProjectionCommand } from
  "./provider-source-canonical-page-queries.ts";
import { advanceSettledPublicWatermark } from
  "./public-change-settlement-repository.ts";
import { hashJson } from "./security.ts";

export const SOURCE_RELATIONSHIP_CONFIRMATION_BACKFILL_MAXIMUM_BATCH_SIZE = 500;

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

function requireBatchSize(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > SOURCE_RELATIONSHIP_CONFIRMATION_BACKFILL_MAXIMUM_BATCH_SIZE
  ) {
    throw new RangeError("Source relationship confirmation batch size is invalid.");
  }
  return value;
}

function canonicalNow(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("Source relationship confirmation clock is invalid.");
  }
  return new Date(value.getTime());
}

function platformScope(
  value: readonly string[] | undefined,
): readonly string[] | null {
  if (value === undefined) return null;
  const parsed = value.map((platformKey) =>
    providerPlatformKeySchema.safeParse(platformKey));
  const canonical = parsed.map((result) => result.success ? result.data : "")
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (
    canonical.length < 1
    || canonical.length > MAX_APPROVED_PUBLIC_PLATFORMS
    || parsed.some((result) => !result.success)
    || canonical.some((platformKey, index) =>
      platformKey !== value[index]
      || (index > 0 && canonical[index - 1] === platformKey)
    )
  ) {
    throw new RangeError(
      "Source relationship confirmation platform scope is invalid.",
    );
  }
  return Object.freeze(canonical);
}

function platformPredicate(
  platformKeys: readonly string[] | null,
): Prisma.Sql {
  return platformKeys === null
    ? Prisma.empty
    : Prisma.sql`
        and exists (
          select 1
          from public.provider_sources as provider
          where provider.organization_id = backfill.organization_id
            and provider.id = backfill.provider_id
            and provider.platform_key = any(${[...platformKeys]}::text[])
        )
      `;
}

interface BackfillCheckpointRow {
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly phase: "pending" | "running" | "complete" | "failed";
  readonly targetDeliveryOccurrenceId: bigint;
  readonly retryEligibilityCutoffAt: Date;
  readonly processedThroughSourceRecordId: string | null;
  readonly targetSemanticSetCount: bigint;
  readonly confirmedSemanticSetCount: bigint;
  readonly failureCode: string | null;
}

export interface SourceRelationshipConfirmationBackfillCandidate {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: LaunchProviderKey;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly semanticObservationId: string;
  readonly sourceRecordId: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly normalizedContractVersion: string;
  readonly identityNamespaceKey: string;
  readonly normalizedContent: unknown;
  readonly semanticEffectiveAt: Date;
  readonly collectedAt: Date;
  readonly protectedNativeEvidenceRef: string;
}

interface BackfillCandidateRow
  extends SourceRelationshipConfirmationBackfillCandidate {
  readonly confirmationSetId: string | null;
}

interface ExactCanonicalRevisionRow {
  readonly semanticObservationId: string;
  readonly canonicalRevisionId: string;
  readonly isSemanticOrigin: boolean;
}

export interface SourceRelationshipConfirmationBackfillProgress {
  readonly sourceRevisionId: string | null;
  readonly phase: "idle" | "pending" | "running" | "complete" | "failed";
  readonly targetSemanticSetCount: bigint;
  readonly confirmedSemanticSetCount: bigint;
  readonly failureCode: string | null;
}

export interface SourceRelationshipConfirmationBackfillCoverage {
  readonly sourceRevisionCount: bigint;
  readonly completeSourceRevisionCount: bigint;
  readonly targetSemanticSetCount: bigint;
  readonly confirmedSemanticSetCount: bigint;
  readonly ready: boolean;
}

interface BackfillCoverageRow {
  readonly sourceRevisionCount: bigint;
  readonly completeSourceRevisionCount: bigint;
  readonly targetSemanticSetCount: bigint;
  readonly confirmedSemanticSetCount: bigint;
}

export interface SourceRelationshipConfirmationBackfillProjectionResolver {
  resolvePullProjection(
    candidate: SourceRelationshipConfirmationBackfillCandidate,
  ): Promise<ProviderSourceCanonicalProjectionPlan>
    | ProviderSourceCanonicalProjectionPlan;
}

class BackfillProjectionError extends Error {
  constructor(
    readonly checkpoint: BackfillCheckpointRow,
    readonly failureCode: string,
    options?: ErrorOptions,
  ) {
    super("Source relationship confirmation projection is invalid.", options);
    this.name = "BackfillProjectionError";
  }
}

export class SourceRelationshipConfirmationBackfillFailedError extends Error {
  constructor(readonly failureCode: string) {
    super(`Source relationship confirmation backfill failed: ${failureCode}`);
    this.name = "SourceRelationshipConfirmationBackfillFailedError";
  }
}

function progress(
  row: BackfillCheckpointRow | null,
): SourceRelationshipConfirmationBackfillProgress {
  return row === null
    ? {
        sourceRevisionId: null,
        phase: "idle",
        targetSemanticSetCount: 0n,
        confirmedSemanticSetCount: 0n,
        failureCode: null,
      }
    : {
        sourceRevisionId: row.sourceRevisionId,
        phase: row.phase,
        targetSemanticSetCount: row.targetSemanticSetCount,
        confirmedSemanticSetCount: row.confirmedSemanticSetCount,
        failureCode: row.failureCode,
      };
}

async function loadNextCheckpoint(
  transaction: PackscoutTransactionClient,
  organizationId: string,
  platformKeys: readonly string[] | null,
): Promise<BackfillCheckpointRow | null> {
  const rows = await transaction.$queryRaw<BackfillCheckpointRow[]>(Prisma.sql`
    select organization_id as "organizationId",
           provider_id as "providerId",
           source_instance_id as "sourceInstanceId",
           source_revision_id as "sourceRevisionId",
           phase,
           target_delivery_occurrence_id as "targetDeliveryOccurrenceId",
           retry_eligibility_cutoff_at as "retryEligibilityCutoffAt",
           processed_through_source_record_id as
             "processedThroughSourceRecordId",
           target_semantic_set_count as "targetSemanticSetCount",
           confirmed_semantic_set_count as "confirmedSemanticSetCount",
           failure_code as "failureCode"
    from public.source_relationship_confirmation_backfills as backfill
    where backfill.organization_id = ${uuid(organizationId)}
      and backfill.phase in ('pending', 'running')
      ${platformPredicate(platformKeys)}
    order by backfill.source_revision_id
    for update skip locked
    limit 1
  `);
  return rows[0] ?? null;
}

async function loadBackfillCandidates(
  transaction: PackscoutTransactionClient,
  checkpoint: BackfillCheckpointRow,
  batchSize: number,
): Promise<BackfillCandidateRow[]> {
  return transaction.$queryRaw<BackfillCandidateRow[]>(Prisma.sql`
    with candidate_records as materialized (
      select distinct occurrence.source_record_id
      from public.source_delivery_occurrences as occurrence
      join public.source_semantic_observations as semantic
        on semantic.id = occurrence.semantic_observation_id
       and semantic.organization_id = occurrence.organization_id
       and semantic.source_record_id = occurrence.source_record_id
       and semantic.normalized_contract_version =
         ${PROVIDER_OBSERVATION_CONTRACT_VERSION}
      where occurrence.organization_id = ${uuid(checkpoint.organizationId)}
        and occurrence.provider_id = ${uuid(checkpoint.providerId)}
        and occurrence.source_instance_id =
          ${uuid(checkpoint.sourceInstanceId)}
        and occurrence.source_revision_id =
          ${uuid(checkpoint.sourceRevisionId)}
        and occurrence.id <= ${checkpoint.targetDeliveryOccurrenceId}
        and (
          ${checkpoint.processedThroughSourceRecordId === null
            ? Prisma.sql`true`
            : Prisma.sql`occurrence.source_record_id > ${uuid(
              checkpoint.processedThroughSourceRecordId,
            )}`}
        )
        and (
          occurrence.disposition in ('inserted', 'revised', 'duplicate')
          or (
            occurrence.disposition = 'quarantined'
            and exists (
              select 1
              from public.quarantine_records as quarantine
              join public.quarantine_attempts as attempt
                on attempt.quarantine_id = quarantine.id
               and attempt.organization_id = quarantine.organization_id
               and attempt.state = 'succeeded'
               and attempt.finished_at <=
                 ${checkpoint.retryEligibilityCutoffAt}
              where quarantine.delivery_occurrence_id = occurrence.id
                and quarantine.organization_id = occurrence.organization_id
                and quarantine.state = 'resolved'
                and quarantine.resolved_at <=
                  ${checkpoint.retryEligibilityCutoffAt}
            )
          )
        )
        and semantic.normalized_content_json ->> 'kind' = 'pull'
      order by occurrence.source_record_id
      limit ${batchSize}
    ),
    latest as (
      select selected.organization_id as "organizationId",
             selected.provider_id as "providerId",
             provider.platform_key as provider,
             selected.source_instance_id as "sourceInstanceId",
             selected.source_revision_id as "sourceRevisionId",
             selected.semantic_observation_id as "semanticObservationId",
             selected.source_record_id as "sourceRecordId",
             source_revision.mapper_key as "mapperKey",
             source_revision.mapper_version as "mapperVersion",
             source_revision.normalized_contract_version as
               "normalizedContractVersion",
             source_revision.identity_namespace_key as "identityNamespaceKey",
             selected.normalized_content_json as "normalizedContent",
             selected.effective_source_time as "semanticEffectiveAt",
             selected.collected_at as "collectedAt",
             selected.native_evidence_reference as
               "protectedNativeEvidenceRef"
      from candidate_records as candidate_record
      cross join lateral (
        select occurrence.organization_id,
               occurrence.provider_id,
               occurrence.source_instance_id,
               occurrence.source_revision_id,
               occurrence.source_record_id,
               occurrence.semantic_observation_id,
               occurrence.collected_at,
               occurrence.native_evidence_reference,
               semantic.normalized_content_json,
               semantic.effective_source_time
        from public.source_delivery_occurrences as occurrence
        join public.source_semantic_observations as semantic
          on semantic.id = occurrence.semantic_observation_id
         and semantic.organization_id = occurrence.organization_id
         and semantic.source_record_id = occurrence.source_record_id
         and semantic.normalized_contract_version =
           ${PROVIDER_OBSERVATION_CONTRACT_VERSION}
        where occurrence.organization_id =
          ${uuid(checkpoint.organizationId)}
          and occurrence.provider_id = ${uuid(checkpoint.providerId)}
          and occurrence.source_instance_id =
            ${uuid(checkpoint.sourceInstanceId)}
          and occurrence.source_revision_id =
            ${uuid(checkpoint.sourceRevisionId)}
          and occurrence.source_record_id = candidate_record.source_record_id
          and occurrence.id <= ${checkpoint.targetDeliveryOccurrenceId}
          and (
            occurrence.disposition in ('inserted', 'revised', 'duplicate')
            or (
              occurrence.disposition = 'quarantined'
              and exists (
                select 1
                from public.quarantine_records as quarantine
                join public.quarantine_attempts as attempt
                  on attempt.quarantine_id = quarantine.id
                 and attempt.organization_id = quarantine.organization_id
                 and attempt.state = 'succeeded'
                 and attempt.finished_at <=
                   ${checkpoint.retryEligibilityCutoffAt}
                where quarantine.delivery_occurrence_id = occurrence.id
                  and quarantine.organization_id = occurrence.organization_id
                  and quarantine.state = 'resolved'
                  and quarantine.resolved_at <=
                    ${checkpoint.retryEligibilityCutoffAt}
              )
            )
          )
          and semantic.normalized_content_json ->> 'kind' = 'pull'
        order by semantic.effective_source_time desc, occurrence.id desc
        limit 1
      ) as selected
      join public.provider_source_revisions as source_revision
        on source_revision.id = selected.source_revision_id
       and source_revision.organization_id = selected.organization_id
       and source_revision.provider_id = selected.provider_id
       and source_revision.source_instance_id = selected.source_instance_id
      join public.provider_sources as provider
        on provider.id = selected.provider_id
       and provider.organization_id = selected.organization_id
    )
    select latest.*,
           confirmation.id as "confirmationSetId"
    from latest
    left join public.source_relationship_confirmation_sets as confirmation
      on confirmation.organization_id = latest."organizationId"
     and confirmation.source_revision_id = latest."sourceRevisionId"
     and confirmation.semantic_observation_id =
       latest."semanticObservationId"
    order by latest."sourceRecordId"
    limit ${batchSize}
  `);
}

function validateProjection(
  checkpoint: BackfillCheckpointRow,
  candidate: BackfillCandidateRow,
  projection: ProviderSourceCanonicalProjectionPlan,
): void {
  const semantic = normalizedObservationSemanticContentSchema.parse(
    candidate.normalizedContent,
  );
  if (
    semantic.kind !== "pull"
    || projection.projectionKind !== "primary"
    || projection.platformKey !== candidate.provider
    || projection.recordKind !== "pull"
    || projection.recordIdScopeKey !== "pull-v1"
    || projection.providerRecordId !==
      semantic.providerRecordIdentity.providerRecordId
    || projection.effectiveAt !== semantic.effectiveAt
    || new Date(projection.effectiveAt).getTime()
      !== candidate.semanticEffectiveAt.getTime()
    || projection.contentFingerprint !== hashJson(projection.content)
    || projection.relationships.length < 1
  ) {
    throw new BackfillProjectionError(
      checkpoint,
      "PROJECTION_LIFECYCLE_MISMATCH",
    );
  }
}

async function loadExactCanonicalRevisions(
  transaction: PackscoutTransactionClient,
  checkpoint: BackfillCheckpointRow,
  candidates: readonly Readonly<{
    candidate: BackfillCandidateRow;
    projection: ProviderSourceCanonicalProjectionPlan;
  }>[],
): Promise<Map<string, string>> {
  if (candidates.length === 0) return new Map();
  const requested = candidates.map(({ candidate, projection }) => Prisma.sql`(
    ${uuid(candidate.semanticObservationId)}, ${projection.platformKey},
    ${projection.providerRecordId}, ${projection.contentFingerprint},
    ${new Date(projection.effectiveAt)}
  )`);
  const rows = await transaction.$queryRaw<ExactCanonicalRevisionRow[]>(Prisma.sql`
    select requested.semantic_observation_id as "semanticObservationId",
           revision.id as "canonicalRevisionId",
           revision.origin_semantic_observation_id =
             requested.semantic_observation_id as "isSemanticOrigin"
    from (values ${Prisma.join(requested)}) as requested(
      semantic_observation_id, platform_key, external_id,
      content_fingerprint, effective_at
    )
    join public.canonical_entities as entity
      on entity.organization_id = ${uuid(checkpoint.organizationId)}
     and entity.platform_key = requested.platform_key
     and entity.record_kind = 'pull'::public.canonical_record_kind
     and entity.external_id = requested.external_id
    join public.canonical_revisions as revision
      on revision.entity_id = entity.id
     and revision.organization_id = entity.organization_id
     and revision.content_hash = requested.content_fingerprint
     and revision.source_updated_at = requested.effective_at
    order by requested.semantic_observation_id,
             (revision.origin_semantic_observation_id =
               requested.semantic_observation_id) desc,
             revision.revision_number
    for share of entity, revision
  `);
  const grouped = new Map<string, ExactCanonicalRevisionRow[]>();
  for (const row of rows) {
    const matches = grouped.get(row.semanticObservationId) ?? [];
    matches.push(row);
    grouped.set(row.semanticObservationId, matches);
  }
  const exact = new Map<string, string>();
  for (const { candidate } of candidates) {
    const matches = grouped.get(candidate.semanticObservationId) ?? [];
    const semanticOriginMatches = matches.filter(
      ({ isSemanticOrigin }) => isSemanticOrigin,
    );
    const selected = semanticOriginMatches.length > 0
      ? semanticOriginMatches
      : matches;
    if (selected.length !== 1) {
      throw new BackfillProjectionError(
        checkpoint,
        selected.length === 0
          ? "CANONICAL_REVISION_NOT_FOUND"
          : "CANONICAL_REVISION_AMBIGUOUS",
      );
    }
    exact.set(
      candidate.semanticObservationId,
      selected[0]!.canonicalRevisionId,
    );
  }
  return exact;
}

/**
 * Resumes frozen pre-migration confirmation coverage before Heat repair and
 * promotion start. One source revision and at most 500 semantic pull sets are
 * processed per advisory-locked transaction. Cursor, confirmations, public
 * settlement, and count advance atomically; replays reuse immutable sets.
 */
export class PrismaSourceRelationshipConfirmationBackfillRepository {
  readonly #organizationId: string;
  readonly #actorPseudonymKey: Uint8Array | string;
  readonly #clock: { now(): Date };
  readonly #platformKeys: readonly string[] | null;
  readonly #resolver: SourceRelationshipConfirmationBackfillProjectionResolver;

  constructor(
    private readonly database: PackscoutPrismaClient,
    configuration: Readonly<{
      organizationId: string;
      actorPseudonymKey: Uint8Array | string;
      resolver: SourceRelationshipConfirmationBackfillProjectionResolver;
      clock?: { now(): Date };
      platformKeys?: readonly string[];
    }>,
  ) {
    this.#organizationId = configuration.organizationId;
    this.#actorPseudonymKey = configuration.actorPseudonymKey;
    this.#resolver = configuration.resolver;
    this.#clock = configuration.clock ?? { now: () => new Date() };
    this.#platformKeys = platformScope(configuration.platformKeys);
  }

  async runToCompletion(input: Readonly<{
    batchSize?: number;
    signal?: AbortSignal;
  }> = {}): Promise<SourceRelationshipConfirmationBackfillProgress> {
    const batchSize = requireBatchSize(
      input.batchSize
        ?? SOURCE_RELATIONSHIP_CONFIRMATION_BACKFILL_MAXIMUM_BATCH_SIZE,
    );
    for (;;) {
      if (input.signal?.aborted) {
        throw new Error("Source relationship confirmation backfill was stopped.");
      }
      let result: Readonly<{
        status: "advanced" | "busy" | "complete" | "failed";
        progress: SourceRelationshipConfirmationBackfillProgress;
      }>;
      try {
        result = await this.#advance(batchSize);
      } catch (error) {
        if (error instanceof BackfillProjectionError) {
          await this.#markFailed(error.checkpoint, error.failureCode);
          throw new SourceRelationshipConfirmationBackfillFailedError(
            error.failureCode,
          );
        }
        throw error;
      }
      if (result.status === "complete") return result.progress;
      if (result.status === "failed") {
        throw new SourceRelationshipConfirmationBackfillFailedError(
          result.progress.failureCode ?? "UNKNOWN_FAILURE",
        );
      }
      if (result.status === "busy") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  /** Returns aggregate proof for this repository's exact provider-platform scope. */
  async loadCoverage(): Promise<SourceRelationshipConfirmationBackfillCoverage> {
    const rows = await this.database.$queryRaw<BackfillCoverageRow[]>(Prisma.sql`
      select count(*)::bigint as "sourceRevisionCount",
             count(*) filter (
               where backfill.phase = 'complete'
             )::bigint as "completeSourceRevisionCount",
             coalesce(sum(backfill.target_semantic_set_count), 0)::bigint as
               "targetSemanticSetCount",
             coalesce(sum(backfill.confirmed_semantic_set_count), 0)::bigint as
               "confirmedSemanticSetCount"
      from public.source_relationship_confirmation_backfills as backfill
      where backfill.organization_id = ${uuid(this.#organizationId)}
        ${platformPredicate(this.#platformKeys)}
    `);
    const coverage = rows[0] ?? {
      sourceRevisionCount: 0n,
      completeSourceRevisionCount: 0n,
      targetSemanticSetCount: 0n,
      confirmedSemanticSetCount: 0n,
    };
    return {
      ...coverage,
      ready: coverage.sourceRevisionCount > 0n
        && coverage.completeSourceRevisionCount === coverage.sourceRevisionCount
        && coverage.confirmedSemanticSetCount ===
          coverage.targetSemanticSetCount,
    };
  }

  async #advance(batchSize: number): Promise<Readonly<{
    status: "advanced" | "busy" | "complete" | "failed";
    progress: SourceRelationshipConfirmationBackfillProgress;
  }>> {
    return this.database.$transaction(async (transaction) => {
      const checkpoint = await loadNextCheckpoint(
        transaction,
        this.#organizationId,
        this.#platformKeys,
      );
      if (!checkpoint) {
        const states = await transaction.$queryRaw<BackfillCheckpointRow[]>(
          Prisma.sql`
            select organization_id as "organizationId",
                   provider_id as "providerId",
                   source_instance_id as "sourceInstanceId",
                   source_revision_id as "sourceRevisionId",
                   phase,
                   target_delivery_occurrence_id as
                     "targetDeliveryOccurrenceId",
                   retry_eligibility_cutoff_at as
                     "retryEligibilityCutoffAt",
                   processed_through_source_record_id as
                     "processedThroughSourceRecordId",
                   target_semantic_set_count as "targetSemanticSetCount",
                   confirmed_semantic_set_count as
                     "confirmedSemanticSetCount",
                   failure_code as "failureCode"
            from public.source_relationship_confirmation_backfills as backfill
            where backfill.organization_id = ${uuid(this.#organizationId)}
              ${platformPredicate(this.#platformKeys)}
            order by (backfill.phase = 'complete'), backfill.source_revision_id
            limit 1
          `,
        );
        const state = states[0] ?? null;
        return {
          status: state === null || state.phase === "complete"
            ? "complete"
            : state.phase === "failed" ? "failed" : "busy",
          progress: state === null
            ? { ...progress(null), phase: "complete" }
            : progress(state),
        };
      }
      const locks = await transaction.$queryRaw<Array<{ acquired: boolean }>>(
        Prisma.sql`
          select pg_try_advisory_xact_lock(
            hashtextextended(
              ${`source_relationship_confirmation_backfill:${checkpoint.organizationId}:${checkpoint.sourceRevisionId}`},
              0
            )
          ) as acquired
        `,
      );
      if (locks[0]?.acquired !== true) {
        return { status: "busy", progress: progress(checkpoint) };
      }

      const now = canonicalNow(this.#clock.now());
      await transaction.$executeRaw(Prisma.sql`
        update public.source_relationship_confirmation_backfills
        set phase = 'running',
            started_at = coalesce(started_at, ${now}),
            updated_at = ${now}
        where organization_id = ${uuid(checkpoint.organizationId)}
          and source_revision_id = ${uuid(checkpoint.sourceRevisionId)}
      `);
      const candidates = await loadBackfillCandidates(
        transaction,
        checkpoint,
        batchSize,
      );
      if (candidates.length === 0) {
        if (
          checkpoint.confirmedSemanticSetCount
          !== checkpoint.targetSemanticSetCount
        ) {
          throw new BackfillProjectionError(
            checkpoint,
            "FROZEN_COVERAGE_CURSOR_MISMATCH",
          );
        }
        await transaction.$executeRaw(Prisma.sql`
          update public.source_relationship_confirmation_backfills
          set phase = 'complete', completed_at = ${now}, updated_at = ${now}
          where organization_id = ${uuid(checkpoint.organizationId)}
            and source_revision_id = ${uuid(checkpoint.sourceRevisionId)}
        `);
        return { status: "advanced", progress: {
          ...progress(checkpoint), phase: "complete",
        } };
      }

      const unconfirmed = candidates.filter(
        ({ confirmationSetId }) => confirmationSetId === null,
      );
      const resolved = await Promise.all(unconfirmed.map(async (candidate) => {
        let projection: ProviderSourceCanonicalProjectionPlan;
        try {
          projection = await this.#resolver.resolvePullProjection(candidate);
          validateProjection(checkpoint, candidate, projection);
        } catch (error) {
          if (error instanceof BackfillProjectionError) throw error;
          throw new BackfillProjectionError(
            checkpoint,
            "PROJECTION_RECONSTRUCTION_FAILED",
            { cause: error },
          );
        }
        return { candidate, projection };
      }));
      const revisions = await loadExactCanonicalRevisions(
        transaction,
        checkpoint,
        resolved,
      );
      if (resolved.length > 0) {
        await writeCanonicalProjectionBatch(
          transaction,
          {
            retentionDays: PROTECTED_PAYLOAD_RETENTION_DAYS,
            actorPseudonymKey: this.#actorPseudonymKey,
          },
          resolved.map(({ candidate, projection }, projectionIndex) => ({
            organizationId: candidate.organizationId,
            providerId: candidate.providerId,
            origin: {
              kind: "semantic_observation" as const,
              sourceRevisionId: candidate.sourceRevisionId,
              semanticObservationId: candidate.semanticObservationId,
            },
            projection: providerSourceProjectionCommand(
              projection,
              candidate.collectedAt.toISOString(),
            ),
            projectionIndex,
            becomesCurrent: false,
            acceptedAt: now,
            publicChangeKind: "provider_projection" as const,
            reuseCanonicalRevisionId: revisions.get(
              candidate.semanticObservationId,
            )!,
          })),
          { mode: "source_relationship_confirmation_backfill" },
        );
      }
      await advanceSettledPublicWatermark(transaction, {
        organizationId: checkpoint.organizationId,
        settledAt: now,
      });

      const nextCount = checkpoint.confirmedSemanticSetCount
        + BigInt(candidates.length);
      if (nextCount > checkpoint.targetSemanticSetCount) {
        throw new BackfillProjectionError(
          checkpoint,
          "FROZEN_COVERAGE_COUNT_EXCEEDED",
        );
      }
      const last = candidates[candidates.length - 1]!;
      const isComplete = nextCount === checkpoint.targetSemanticSetCount;
      await transaction.$executeRaw(Prisma.sql`
        update public.source_relationship_confirmation_backfills
        set phase = ${isComplete ? "complete" : "running"},
            processed_through_source_record_id =
              ${uuid(last.sourceRecordId)},
            confirmed_semantic_set_count = ${nextCount},
            completed_at = ${isComplete ? now : null},
            updated_at = ${now}
        where organization_id = ${uuid(checkpoint.organizationId)}
          and source_revision_id = ${uuid(checkpoint.sourceRevisionId)}
      `);
      return {
        status: "advanced",
        progress: {
          sourceRevisionId: checkpoint.sourceRevisionId,
          phase: isComplete ? "complete" : "running",
          targetSemanticSetCount: checkpoint.targetSemanticSetCount,
          confirmedSemanticSetCount: nextCount,
          failureCode: null,
        },
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #markFailed(
    checkpoint: BackfillCheckpointRow,
    failureCode: string,
  ): Promise<void> {
    const now = canonicalNow(this.#clock.now());
    await this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        update public.source_relationship_confirmation_backfills
        set phase = 'failed', failure_code = ${failureCode},
            updated_at = ${now}
        where organization_id = ${uuid(checkpoint.organizationId)}
          and source_revision_id = ${uuid(checkpoint.sourceRevisionId)}
          and phase in ('pending', 'running')
      `);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }
}
