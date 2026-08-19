import {
  activeCatalogManifestStateV1Schema,
  canonicalJson,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActiveStateRequestSchema,
  catalogManifestReceiptSchema,
  catalogManifestSignedReceiptEnvelopeSchema,
  parseCatalogManifestPublicationJson,
  providerReleaseCompletedHeadResultV1Schema,
  type ActiveCatalogManifestStateV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import {
  loadManifestEligibilitySnapshotInTransaction,
  loadProviderCausalReadinessInTransaction,
} from "./public-change-settlement-repository.provider-read.ts";
import {
  PROMOTION_V2_MAX_MANIFEST_RECEIPT_BYTES,
  PROMOTION_V2_MAX_REQUEST_BYTES,
  PROMOTION_V2_MAX_RESPONSE_BYTES,
  PromotionV2PersistenceError,
  assertPromotionV2Binding,
  assertPromotionV2ClaimInput,
  assertPromotionV2Failure,
  finiteDate,
  promotionV2Sha256,
  type CatalogPromotionBootstrapProof,
  type ExactPromotionOperationInput,
  type ExactPromotionOperationRecord,
  type ExactPromotionReceiptEvidence,
  type ManifestPromotionActiveSelection,
  type ManifestPromotionActiveState,
  type ManifestPromotionCause,
  type ManifestPromotionClaim,
  type ManifestPromotionEvaluationSnapshot,
  type ManifestPromotionHealth,
  type ManifestPromotionPreparedSummary,
  type ManifestPromotionProviderFact,
  type PromotionV2FailureClass,
  type PromotionV2ScopeBinding,
  type ProviderPromotionCompletedHead,
} from "./promotion-v2-types.ts";
import {
  manifestPromotionByteCount,
  manifestPromotionPreparedSummaryBody,
  manifestSnapshotProjection,
  mapManifestPromotionOperation,
  mapManifestPromotionSelection,
  parseManifestPromotionPreparedSummary,
  parseManifestCasErrorBody,
  parseManifestPromotionReceiptEvidence,
  validateManifestPromotionPrepared,
  validateManifestSummaryAgainstProjection,
  type ManifestActiveStateReceiptEvidence,
  type ManifestPromotionAttemptRow,
  type ManifestPromotionCompletedHeadRow,
  type ManifestPromotionLaneRow,
  type ManifestPromotionOperationRow,
  type ManifestPromotionSelectionRow,
} from "./manifest-promotion-repository-validation.ts";
import { loadManifestPromotionEvaluationTrigger } from
  "./manifest-promotion-trigger.ts";
import { deferManifestPromotionCasLoss } from
  "./manifest-promotion-cas-loss.ts";
import { recordManifestPromotionRetryExhaustion } from
  "./manifest-promotion-retry-exhaustion.ts";
import { supersedeUndispatchedManifestAttempt } from
  "./promotion-v2-stale-attempt.ts";
import { loadManifestPromotionHealth } from
  "./manifest-promotion-health.ts";
import {
  replaceManifestPromotionActiveState,
  type ManifestPromotionActiveStateReplacement,
} from "./manifest-promotion-active-state.ts";
import {
  lockPromotionConfigurationScope,
  promotionAttemptBootstrapProofIsCurrent,
} from "./promotion-v2-bootstrap-proof-guard.ts";

type ManifestLaneRow = ManifestPromotionLaneRow;
type ManifestAttemptRow = ManifestPromotionAttemptRow;
type OperationRow = ManifestPromotionOperationRow;
type SelectionRow = ManifestPromotionSelectionRow;
type CompletedHeadRow = ManifestPromotionCompletedHeadRow;
type ActiveStateReceiptEvidence = ManifestActiveStateReceiptEvidence;

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

/** Serialized organization/deployment manifest promotion ledger. */
export class PrismaManifestPromotionRepository {
  readonly #organizationId: string;
  readonly #deploymentKey: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    binding: PromotionV2ScopeBinding,
  ) {
    assertPromotionV2Binding(binding);
    this.#organizationId = binding.organizationId.toLowerCase();
    this.#deploymentKey = binding.deploymentKey;
  }

  async loadEvaluationTrigger(): Promise<Readonly<{
    cause:
      | "lifecycle_settled"
      | "configuration_settled"
      | "observation_succeeded";
    causeIdentity: string;
  }> | null> {
    return loadManifestPromotionEvaluationTrigger(
      this.database, this.#organizationId,
    );
  }

  async enqueueEvaluation(input: Readonly<{
    cause: ManifestPromotionCause;
    causeIdentity: string;
    requestedAt: Date;
  }>): Promise<Readonly<{
    evaluationSequence: bigint;
    result: "created" | "coalesced";
  }>> {
    if (
      !finiteDate(input.requestedAt) || input.causeIdentity.trim() !==
        input.causeIdentity || input.causeIdentity.length < 1 ||
      input.causeIdentity.length > 256
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    return this.database.$transaction(
      (transaction) => this.#enqueueEvaluation(transaction, input),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
  }

  async claim(input: Readonly<{
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }>): Promise<ManifestPromotionClaim | null> {
    assertPromotionV2ClaimInput(input);
    return this.database.$transaction(async (transaction) => {
      const lanes = await transaction.$queryRaw<ManifestLaneRow[]>(Prisma.sql`
        select bootstrap_state as "bootstrapState",
               bootstrap_provider_set_body as "bootstrapProviderSetBody",
               bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
               current_bootstrap_proof_revision
                 as "currentBootstrapProofRevision",
               requested_evaluation_sequence as "requestedEvaluationSequence",
               confirmed_evaluation_sequence as "confirmedEvaluationSequence",
               active_generation as "activeGeneration",
               active_state_body as "activeStateBody",
               active_state_sha256 as "activeStateSha256",
               active_state_receipt_body as "activeStateReceiptBody",
               active_state_receipt_sha256 as "activeStateReceiptSha256",
               active_state_response_body as "activeStateResponseBody",
               active_state_response_sha256 as "activeStateResponseSha256"
        from public.manifest_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
        for update
      `);
      const lane = lanes[0];
      if (!lane || lane.bootstrapState === "unverified") {
        throw new PromotionV2PersistenceError("PROMOTION_V2_BOOTSTRAP_UNVERIFIED");
      }
      let attempt = await this.#lockActiveAttempt(transaction);
      const attemptProofCurrent = attempt === null ? true :
        await promotionAttemptBootstrapProofIsCurrent(transaction, {
          organizationId: this.#organizationId,
          deploymentKey: this.#deploymentKey,
        }, attempt);
      const eligibility = await loadManifestEligibilitySnapshotInTransaction(
        transaction, { organizationId: this.#organizationId },
      );
      const providerSetMatches = eligibility !== null &&
        lane.currentBootstrapProofRevision !== null &&
        lane.bootstrapProviderSetBody !== null &&
        lane.bootstrapProviderSetSha256 === promotionV2Sha256(
          lane.bootstrapProviderSetBody,
        ) && lane.bootstrapProviderSetBody === canonicalJson(
          eligibility.configuredPlatformKeys,
        );
      if (!providerSetMatches || !attemptProofCurrent) {
        if (!attempt) return null;
        const recovery = await transaction.$queryRaw<Array<{
          pending: boolean;
        }>>(Prisma.sql`
          select exists (
            select 1 from public.manifest_promotion_operations
            where attempt_id = ${uuid(attempt.id)} and send_count > 0
          ) as pending
        `);
        if (recovery[0]?.pending !== true) {
          await supersedeUndispatchedManifestAttempt(transaction, {
            organizationId: this.#organizationId,
            deploymentKey: this.#deploymentKey,
          }, attempt, lane.bootstrapProviderSetSha256, input.now);
          return null;
        }
      }
      if (!attempt) {
        if (lane.requestedEvaluationSequence <= lane.confirmedEvaluationSequence) {
          return null;
        }
        const inserted = await transaction.$queryRaw<ManifestAttemptRow[]>(Prisma.sql`
          insert into public.manifest_promotion_attempts (
            organization_id, deployment_key, evaluation_sequence,
            bootstrap_proof_revision, bootstrap_provider_set_sha256
          ) select
            ${uuid(this.#organizationId)}, ${this.#deploymentKey},
            ${lane.requestedEvaluationSequence},
            ${lane.currentBootstrapProofRevision},
            ${lane.bootstrapProviderSetSha256}
          where not exists (
            select 1 from public.manifest_promotion_attempts
            where organization_id = ${uuid(this.#organizationId)}
              and deployment_key = ${this.#deploymentKey}
              and evaluation_sequence = ${lane.requestedEvaluationSequence}
          )
          returning id::text, evaluation_sequence as "evaluationSequence", state,
                    bootstrap_proof_revision as "bootstrapProofRevision",
                    bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
                    prepared_summary_body as "preparedSummaryBody",
                    prepared_summary_sha256 as "preparedSummarySha256",
                    prepared_operation_kind as "preparedOperationKind",
                    evaluation_snapshot_body as "evaluationSnapshotBody",
                    evaluation_snapshot_sha256 as "evaluationSnapshotSha256",
                    claim_token::text as "claimToken",
                    claim_expires_at as "claimExpiresAt", claim_count as "claimCount",
                    retry_count as "retryCount", failure_code as "failureCode",
                    cas_error_body as "casErrorBody"
        `);
        attempt = inserted[0] ?? null;
      }
      if (!attempt) return null;
      if (
        attempt.claimToken !== null && attempt.claimExpiresAt !== null &&
        attempt.claimExpiresAt.getTime() > input.now.getTime()
      ) return null;
      if (attempt.state === "retry_wait") {
        const due = await transaction.$queryRaw<Array<{ due: boolean }>>(Prisma.sql`
          select retry_at <= ${input.now} as due
          from public.manifest_promotion_attempts where id = ${uuid(attempt.id)}
        `);
        if (due[0]?.due !== true) return null;
      }
      const rows = await transaction.$queryRaw<ManifestAttemptRow[]>(Prisma.sql`
        update public.manifest_promotion_attempts
        set claim_owner = ${input.workerId}, claim_token = gen_random_uuid(),
            claim_expires_at = ${input.leaseExpiresAt},
            last_heartbeat_at = ${input.now}, claim_count = claim_count + 1,
            retry_at = null, state = case when prepared_summary_body is null
              then 'assembling' else 'in_progress' end,
            updated_at = ${input.now}
        where id = ${uuid(attempt.id)}
        returning id::text, evaluation_sequence as "evaluationSequence", state,
                  bootstrap_proof_revision as "bootstrapProofRevision",
                  bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
                  prepared_summary_body as "preparedSummaryBody",
                  prepared_summary_sha256 as "preparedSummarySha256",
                  prepared_operation_kind as "preparedOperationKind",
                  evaluation_snapshot_body as "evaluationSnapshotBody",
                  evaluation_snapshot_sha256 as "evaluationSnapshotSha256",
                  claim_token::text as "claimToken",
                  claim_expires_at as "claimExpiresAt", claim_count as "claimCount",
                  retry_count as "retryCount", failure_code as "failureCode",
                  cas_error_body as "casErrorBody"
      `);
      const row = rows[0];
      if (!row?.claimToken || !row.claimExpiresAt) return null;
      if ((row.preparedSummaryBody === null) !==
          (row.preparedSummarySha256 === null) ||
        (row.preparedSummaryBody !== null && (
          promotionV2Sha256(row.preparedSummaryBody) !==
            row.preparedSummarySha256 ||
          row.evaluationSnapshotBody === null ||
          row.evaluationSnapshotSha256 === null ||
          promotionV2Sha256(row.evaluationSnapshotBody) !==
            row.evaluationSnapshotSha256
        ))) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      const preparedSummary = row.preparedSummaryBody === null
        ? null : parseManifestPromotionPreparedSummary(row.preparedSummaryBody);
      if (preparedSummary !== null &&
        preparedSummary.evaluationSnapshotSha256 !==
          row.evaluationSnapshotSha256) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      return {
        attemptId: row.id,
        claimToken: row.claimToken,
        claimExpiresAt: row.claimExpiresAt,
        claimCount: row.claimCount,
        retryCount: row.retryCount,
        recovered: row.claimCount > 1,
        evaluationSequence: row.evaluationSequence,
        state: row.state as ManifestPromotionClaim["state"],
        preparedSummary,
        pendingCasLoss: row.casErrorBody === null ? null : {
          failureCode: parseManifestCasErrorBody(row.casErrorBody),
          canonicalErrorBody: row.casErrorBody,
        },
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async heartbeat(input: Readonly<{
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    leaseExpiresAt: Date;
  }>): Promise<boolean> {
    if (!finiteDate(input.heartbeatAt) || !finiteDate(input.leaseExpiresAt) ||
      input.leaseExpiresAt <= input.heartbeatAt) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.heartbeatAt, true,
      );
      if (!attempt) return false;
      const changed = await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_attempts
        set last_heartbeat_at = ${input.heartbeatAt},
            claim_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.heartbeatAt}
        where id = ${uuid(input.attemptId)}
      `);
      return changed === 1;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadEvaluationSnapshot(input: Readonly<{
    attemptId: string;
    claimToken: string;
    now: Date;
  }>): Promise<ManifestPromotionEvaluationSnapshot | null> {
    if (!finiteDate(input.now)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.now,
      );
      if (!attempt) return null;
      const snapshot = await this.#buildEvaluationSnapshot(
        transaction, attempt.evaluationSequence,
      );
      if (snapshot === null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      const projectionBody = canonicalJson(manifestSnapshotProjection(snapshot));
      if (manifestPromotionByteCount(projectionBody) > 262_144 ||
        attempt.preparedSummarySha256 !== null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_attempts
        set evaluation_snapshot_body = ${projectionBody},
            evaluation_snapshot_sha256 = ${snapshot.snapshotSha256},
            updated_at = ${input.now}
        where id = ${uuid(input.attemptId)}
          and claim_token = ${uuid(input.claimToken)}
          and prepared_summary_body is null
      `);
      return snapshot;
    }, {
      ...PACKSCOUT_TRANSACTION_OPTIONS,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async persistPreparedOperation(input: Readonly<{
    attemptId: string;
    claimToken: string;
    preparedAt: Date;
    summary: ManifestPromotionPreparedSummary;
    operation: ExactPromotionOperationInput | null;
  }>): Promise<ExactPromotionOperationRecord | null> {
    if (!finiteDate(input.preparedAt)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    validateManifestPromotionPrepared(input.summary, input.operation);
    const body = manifestPromotionPreparedSummaryBody(input.summary);
    const digest = promotionV2Sha256(body);
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.preparedAt,
      );
      if (!attempt) return null;
      if (attempt.evaluationSnapshotBody === null ||
        attempt.evaluationSnapshotSha256 === null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      validateManifestSummaryAgainstProjection(
        input.summary,
        attempt.evaluationSnapshotBody,
        attempt.evaluationSnapshotSha256,
        input.operation,
      );
      if (attempt.preparedSummarySha256 !== null) {
        if (attempt.preparedSummarySha256 !== digest) {
          throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
        }
        return this.#loadOperation(transaction, input.attemptId);
      }
      if (input.operation !== null) {
        await transaction.$executeRaw(Prisma.sql`
          insert into public.manifest_promotion_operations (
            attempt_id, organization_id, deployment_key, operation_index,
            operation_id, operation_kind, request_path,
            canonical_request_body, request_sha256
          ) values (
            ${uuid(input.attemptId)}, ${uuid(this.#organizationId)},
            ${this.#deploymentKey}, 0, ${input.operation.operationId},
            ${input.operation.operationKind}, ${input.operation.requestPath},
            ${input.operation.canonicalRequestBody},
            ${promotionV2Sha256(input.operation.canonicalRequestBody)}
          )
        `);
      }
      await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_attempts
        set prepared_operation_kind = ${input.summary.operationKind},
            prepared_summary_body = ${body}, prepared_summary_sha256 = ${digest},
            expected_active_state_sha256 = ${promotionV2Sha256(
              canonicalJson(input.summary.expectedActiveState),
            )}, public_release_id = ${
              input.summary.manifestIdentity === null
                ? Prisma.sql`null`
                : uuid(input.summary.manifestIdentity.publicReleaseId)
            }, manifest_fingerprint = ${
              input.summary.manifestIdentity?.manifestFingerprint ?? null
            }, prepared_at = ${input.preparedAt}, state = 'ready',
            updated_at = ${input.preparedAt}
        where id = ${uuid(input.attemptId)}
      `);
      return input.operation === null
        ? null : this.#loadOperation(transaction, input.attemptId);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async listOperations(input: Readonly<{
    attemptId: string;
  }>): Promise<readonly ExactPromotionOperationRecord[]> {
    const operation = await this.#loadOperation(this.database, input.attemptId);
    return operation ? [operation] : [];
  }

  async firstUnacknowledgedOperation(input: Readonly<{
    attemptId: string;
    claimToken: string;
    now: Date;
  }>): Promise<ExactPromotionOperationRecord | null> {
    const attempt = await this.database.$transaction(
      (transaction) => this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.now, true,
      ),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
    if (!attempt) return null;
    const operation = await this.#loadOperation(this.database, input.attemptId);
    return operation?.state === "acknowledged" ? null : operation;
  }

  async markOperationSent(input: Readonly<{
    attemptId: string;
    operationId: string;
    claimToken: string;
    sentAt: Date;
  }>): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      await lockPromotionConfigurationScope(transaction, {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      });
      const lanes = await transaction.$queryRaw<Array<{
        requestedEvaluationSequence: bigint;
      }>>(Prisma.sql`
        select requested_evaluation_sequence as "requestedEvaluationSequence"
        from public.manifest_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
        for update
      `);
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.sentAt, true,
      );
      if (!attempt) return false;
      const lane = lanes[0];
      if (!lane) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      if (await this.#supersedeIfStaleBeforeFirstDispatch(
        transaction, attempt, lane.requestedEvaluationSequence, input.sentAt,
      )) return false;
      const operation = await this.#loadOperation(transaction, input.attemptId, true);
      if (!operation || operation.operationId !== input.operationId ||
        operation.state === "acknowledged") {
        throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_ORDER");
      }
      const changed = await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_operations
        set state = 'sent', send_count = send_count + 1,
            last_sent_at = ${input.sentAt}, updated_at = ${input.sentAt}
        where attempt_id = ${uuid(input.attemptId)} and state in ('pending', 'sent')
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_attempts
        set state = 'in_progress', updated_at = ${input.sentAt}
        where id = ${uuid(input.attemptId)}
      `);
      return changed === 1;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async acknowledgeOperation(input: Readonly<{
    attemptId: string;
    operationId: string;
    claimToken: string;
    acknowledgedAt: Date;
    evidence: ExactPromotionReceiptEvidence;
  }>): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.acknowledgedAt,
        true,
      );
      if (!attempt) return false;
      const operation = await this.#loadOperation(transaction, input.attemptId, true);
      if (!operation || operation.operationId !== input.operationId ||
        operation.state !== "sent") {
        throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_ORDER");
      }
      const evidence = parseManifestPromotionReceiptEvidence(
        operation,
        input.evidence,
      );
      const changed = await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_operations
        set state = 'acknowledged', acknowledged_at = ${input.acknowledgedAt},
            canonical_receipt_body = ${input.evidence.canonicalReceiptBody},
            receipt_sha256 = ${evidence.receiptSha256},
            exact_response_body = ${evidence.exactResponseBody},
            response_sha256 = ${evidence.responseSha256},
            updated_at = ${input.acknowledgedAt}
        where attempt_id = ${uuid(input.attemptId)} and state = 'sent'
      `);
      return changed === 1;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async scheduleRetry(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: Extract<PromotionV2FailureClass, "technical" | "reconciliation">;
    failureCode: string;
  }>): Promise<boolean> {
    assertPromotionV2Failure(input.failureClass, input.failureCode);
    if (!finiteDate(input.failedAt) || !finiteDate(input.retryAt) ||
      input.retryAt <= input.failedAt) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.failedAt, true,
      );
      if (!attempt) return false;
      await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_attempts
        set state = 'retry_wait', retry_count = retry_count + 1,
            retry_at = ${input.retryAt}, failure_class = ${input.failureClass},
            failure_code = ${input.failureCode}, claim_owner = null,
            claim_token = null, claim_expires_at = null,
            last_heartbeat_at = null, updated_at = ${input.failedAt}
        where id = ${uuid(input.attemptId)}
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_lanes
        set next_retry_at = ${input.retryAt}, updated_at = ${input.failedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
      `);
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async complete(input:
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "activated" | "refreshed" | "rolled_back" | "cleared" | "blocked";
        completedAt: Date;
      }>
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "no_change";
        completedAt: Date;
      }>
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "failed";
        completedAt: Date;
        failureClass: PromotionV2FailureClass;
        failureCode: string;
      }>,
  ): Promise<boolean> {
    if (!finiteDate(input.completedAt)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    if (input.outcome === "failed") {
      assertPromotionV2Failure(input.failureClass, input.failureCode);
    }
    return this.database.$transaction(async (transaction) => {
      await lockPromotionConfigurationScope(transaction, {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      });
      const lanes = input.outcome === "no_change"
        ? await transaction.$queryRaw<Array<{
            requestedEvaluationSequence: bigint;
          }>>(Prisma.sql`
            select requested_evaluation_sequence as "requestedEvaluationSequence"
            from public.manifest_promotion_lanes
            where organization_id = ${uuid(this.#organizationId)}
              and deployment_key = ${this.#deploymentKey}
            for update
          `)
        : [];
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.completedAt, true,
      );
      if (!attempt) return false;
      if (input.outcome === "no_change") {
        const lane = lanes[0];
        if (!lane) {
          throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
        }
        if (await this.#supersedeIfStaleBeforeFirstDispatch(
          transaction,
          attempt,
          lane.requestedEvaluationSequence,
          input.completedAt,
        )) return false;
        if (attempt.preparedOperationKind !== "no_change" ||
          await this.#loadOperation(transaction, attempt.id) !== null) {
          throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
        }
        await this.#terminalize(transaction, attempt, input, null, null);
        await this.#confirmEvaluation(
          transaction, attempt.evaluationSequence, input.completedAt,
        );
        return true;
      }
      if (input.outcome === "failed") {
        await this.#terminalize(
          transaction, attempt, input, input.failureClass, input.failureCode,
        );
        await transaction.$executeRaw(Prisma.sql`
          update public.manifest_promotion_lanes
          set next_retry_at = null, updated_at = ${input.completedAt}
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
        `);
        return true;
      }
      const operation = await this.#loadOperation(transaction, attempt.id, true);
      if (operation?.state !== "acknowledged" ||
        operation.canonicalReceiptBody === null || operation.receiptSha256 === null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      const receipt = catalogManifestReceiptSchema.parse(
        JSON.parse(operation.canonicalReceiptBody),
      );
      if (receipt.result !== input.outcome) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
      }
      if (receipt.operationKind !== "block") {
        if (!("activeState" in receipt.details)) {
          throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
        }
        const state = activeCatalogManifestStateV1Schema.parse({
          ...receipt.details.activeState,
          terminalReceiptSha256: operation.receiptSha256,
        });
        await this.#replaceActiveState(transaction, {
          state,
          canonicalStateBody: canonicalJson(state),
          stateReceiptBody: operation.canonicalReceiptBody,
          stateReceiptSha256: operation.receiptSha256,
          exactResponseBody: operation.exactResponseBody,
          responseSha256: operation.responseSha256,
          reconciledAt: input.completedAt,
          activationOccurred: input.outcome !== "refreshed",
        });
      }
      await this.#terminalize(transaction, attempt, input, null, null);
      await this.#confirmEvaluation(
        transaction, attempt.evaluationSequence, input.completedAt,
      );
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async recordRetryExhaustion(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: PromotionV2FailureClass;
    failureCode: string;
  }>) {
    return recordManifestPromotionRetryExhaustion(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    }, input);
  }

  async recordCasLoss(input: Readonly<{
    attemptId: string;
    claimToken: string;
    canonicalErrorBody: string;
    observedAt: Date;
    activeStateEvidence: ActiveStateReceiptEvidence;
  }>): Promise<Readonly<{ evaluationSequence: bigint }> | null> {
    if (!finiteDate(input.observedAt)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    const failureCode = parseManifestCasErrorBody(input.canonicalErrorBody);
    return this.database.$transaction(async (transaction) => {
      await lockPromotionConfigurationScope(transaction, {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      });
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.observedAt, true,
      );
      if (!attempt) return null;
      if (attempt.casErrorBody !== null && (
        attempt.casErrorBody !== input.canonicalErrorBody ||
        attempt.failureCode !== failureCode
      )) throw new PromotionV2PersistenceError(
        "PROMOTION_V2_OPERATION_CONFLICT",
      );
      const operation = await this.#loadOperation(
        transaction, attempt.id, true,
      );
      if (operation?.state !== "sent") {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      const activeReceipt = this.#parseActiveStateReceipt(
        input.activeStateEvidence,
      );
      try {
        await this.#replaceActiveState(transaction, {
          state: activeReceipt.state,
          canonicalStateBody: canonicalJson(activeReceipt.state),
          stateReceiptBody: input.activeStateEvidence.canonicalReceiptBody,
          stateReceiptSha256: activeReceipt.receiptSha256,
          exactResponseBody: activeReceipt.exactResponseBody,
          responseSha256: activeReceipt.responseSha256,
          reconciledAt: input.observedAt,
          activationOccurred: false,
        });
      } catch (error) {
        if (error instanceof PromotionV2PersistenceError &&
          error.code === "PROMOTION_V2_STATE_CONFLICT") {
          throw new PromotionV2PersistenceError(
            "PROMOTION_V2_ACTIVE_STATE_UNPROVEN",
          );
        }
        throw error;
      }
      await transaction.$executeRaw(Prisma.sql`
        update public.manifest_promotion_attempts
        set state = 'cas_lost', failure_class = 'reconciliation',
            failure_code = ${failureCode},
            cas_error_body = ${input.canonicalErrorBody},
            cas_error_sha256 = ${promotionV2Sha256(input.canonicalErrorBody)},
            terminal_at = ${input.observedAt}, claim_owner = null,
            claim_token = null, claim_expires_at = null,
            last_heartbeat_at = null, retry_at = null, updated_at = ${input.observedAt}
        where id = ${uuid(attempt.id)}
      `);
      const enqueued = await this.#enqueueEvaluation(transaction, {
        cause: "cas_lost",
        causeIdentity: `${attempt.id}:${promotionV2Sha256(
          canonicalJson(activeReceipt.state),
        )}`,
        requestedAt: input.observedAt,
      });
      return { evaluationSequence: enqueued.evaluationSequence };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async deferCasLoss(input: Readonly<{
    attemptId: string;
    claimToken: string;
    canonicalErrorBody: string;
    observedAt: Date;
    retryAt: Date;
  }>): Promise<boolean> {
    return deferManifestPromotionCasLoss(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    }, input);
  }

  async acknowledgeActiveState(input: Readonly<{
    attemptId: string;
    claimToken: string;
    reconciledAt: Date;
    evidence: ActiveStateReceiptEvidence;
  }>): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      await lockPromotionConfigurationScope(transaction, {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      });
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.reconciledAt,
        true,
      );
      if (!attempt) return false;
      const parsed = this.#parseActiveStateReceipt(input.evidence);
      await this.#replaceActiveState(transaction, {
        state: parsed.state,
        canonicalStateBody: canonicalJson(parsed.state),
        stateReceiptBody: input.evidence.canonicalReceiptBody,
        stateReceiptSha256: parsed.receiptSha256,
        exactResponseBody: parsed.exactResponseBody,
        responseSha256: parsed.responseSha256,
        reconciledAt: input.reconciledAt,
        activationOccurred: false,
      });
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadHealth(input: Readonly<{ now: Date }>): Promise<ManifestPromotionHealth> {
    return loadManifestPromotionHealth(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    }, input.now);
  }

  async loadBootstrapAnchor(): Promise<CatalogPromotionBootstrapProof | null> {
    // Implemented by the strict bootstrap repository; this method exists only
    // to make accidental service-memory reconstruction impossible.
    const { PrismaCatalogPromotionBootstrapProofRepository } =
      await import("./catalog-promotion-bootstrap-proof-repository.ts");
    return new PrismaCatalogPromotionBootstrapProofRepository(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    }).loadProof();
  }

  async #enqueueEvaluation(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      cause: ManifestPromotionCause;
      causeIdentity: string;
      requestedAt: Date;
    }>,
  ): Promise<Readonly<{
    evaluationSequence: bigint;
    result: "created" | "coalesced";
  }>> {
    await transaction.$executeRaw(Prisma.sql`
      insert into public.manifest_promotion_lanes (
        organization_id, deployment_key
      ) values (${uuid(this.#organizationId)}, ${this.#deploymentKey})
      on conflict do nothing
    `);
    const rows = await transaction.$queryRaw<Array<{
      nextEvaluationSequence: bigint;
    }>>(Prisma.sql`
      select next_evaluation_sequence as "nextEvaluationSequence"
      from public.manifest_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
      for update
    `);
    const causeBody = canonicalJson({
      cause: input.cause, causeIdentity: input.causeIdentity,
    });
    const causeSha256 = promotionV2Sha256(causeBody);
    const existing = await transaction.$queryRaw<Array<{
      evaluationSequence: bigint;
    }>>(Prisma.sql`
      select evaluation_sequence as "evaluationSequence"
      from public.manifest_promotion_evaluations
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and cause_sha256 = ${causeSha256}
    `);
    if (existing[0]) {
      return { evaluationSequence: existing[0].evaluationSequence, result: "coalesced" };
    }
    const evaluationSequence = (rows[0]?.nextEvaluationSequence ?? 0n) + 1n;
    await transaction.$executeRaw(Prisma.sql`
      insert into public.manifest_promotion_evaluations (
        organization_id, deployment_key, evaluation_sequence,
        cause, cause_identity, cause_sha256, requested_at
      ) values (
        ${uuid(this.#organizationId)}, ${this.#deploymentKey}, ${evaluationSequence},
        ${input.cause}, ${input.causeIdentity}, ${causeSha256}, ${input.requestedAt}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set next_evaluation_sequence = ${evaluationSequence},
          requested_evaluation_sequence = ${evaluationSequence},
          requested_at = ${input.requestedAt}, updated_at = ${input.requestedAt}
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
    `);
    return { evaluationSequence, result: "created" };
  }

  async #lockActiveAttempt(
    transaction: PackscoutTransactionClient,
  ): Promise<ManifestAttemptRow | null> {
    const rows = await transaction.$queryRaw<ManifestAttemptRow[]>(Prisma.sql`
      select id::text, evaluation_sequence as "evaluationSequence", state,
             bootstrap_proof_revision as "bootstrapProofRevision",
             bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
             prepared_summary_body as "preparedSummaryBody",
             prepared_summary_sha256 as "preparedSummarySha256",
             prepared_operation_kind as "preparedOperationKind",
             evaluation_snapshot_body as "evaluationSnapshotBody",
             evaluation_snapshot_sha256 as "evaluationSnapshotSha256",
             claim_token::text as "claimToken", claim_expires_at as "claimExpiresAt",
             claim_count as "claimCount", retry_count as "retryCount",
             failure_code as "failureCode", cas_error_body as "casErrorBody"
      from public.manifest_promotion_attempts
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      for update
    `);
    return rows[0] ?? null;
  }

  async #lockClaimedAttempt(
    transaction: PackscoutTransactionClient,
    attemptId: string,
    claimToken: string,
    now: Date,
    allowSentRecovery = false,
  ): Promise<ManifestAttemptRow | null> {
    await lockPromotionConfigurationScope(transaction, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    });
    const lanes = await transaction.$queryRaw<Array<{
      bootstrapProviderSetSha256: string | null;
    }>>(Prisma.sql`
      select bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256"
      from public.manifest_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
      for update
    `);
    const rows = await transaction.$queryRaw<ManifestAttemptRow[]>(Prisma.sql`
      select id::text, evaluation_sequence as "evaluationSequence", state,
             bootstrap_proof_revision as "bootstrapProofRevision",
             bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
             prepared_summary_body as "preparedSummaryBody",
             prepared_summary_sha256 as "preparedSummarySha256",
             prepared_operation_kind as "preparedOperationKind",
             evaluation_snapshot_body as "evaluationSnapshotBody",
             evaluation_snapshot_sha256 as "evaluationSnapshotSha256",
             claim_token::text as "claimToken", claim_expires_at as "claimExpiresAt",
             claim_count as "claimCount", retry_count as "retryCount",
             failure_code as "failureCode", cas_error_body as "casErrorBody"
      from public.manifest_promotion_attempts
      where id = ${uuid(attemptId)}
        and organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and claim_token = ${uuid(claimToken)} and claim_expires_at > ${now}
        and state in ('assembling', 'ready', 'in_progress')
      for update
    `);
    const row = rows[0] ?? null;
    if (row && !(await promotionAttemptBootstrapProofIsCurrent(transaction, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    }, row))) {
      const operation = await this.#loadOperation(transaction, row.id, true);
      if (operation !== null && operation.sendCount > 0) {
        if (allowSentRecovery) return row;
        throw new PromotionV2PersistenceError(
          "PROMOTION_V2_BOOTSTRAP_UNVERIFIED",
        );
      }
      await supersedeUndispatchedManifestAttempt(
        transaction,
        {
          organizationId: this.#organizationId,
          deploymentKey: this.#deploymentKey,
        },
        row,
        lanes[0]?.bootstrapProviderSetSha256 ?? null,
        now,
      );
      return null;
    }
    return row;
  }

  async #loadOperation(
    database: PackscoutPrismaClient | PackscoutTransactionClient,
    attemptId: string,
    lock = false,
  ): Promise<ExactPromotionOperationRecord | null> {
    const lockClause = lock ? Prisma.sql`for update` : Prisma.empty;
    const rows = await database.$queryRaw<OperationRow[]>(Prisma.sql`
      select operation_index as "operationIndex", operation_id as "operationId",
             operation_kind as "operationKind", request_path as "requestPath",
             canonical_request_body as "canonicalRequestBody",
             request_sha256 as "requestSha256", state, send_count as "sendCount",
             last_sent_at as "lastSentAt", acknowledged_at as "acknowledgedAt",
             canonical_receipt_body as "canonicalReceiptBody",
             receipt_sha256 as "receiptSha256",
             exact_response_body as "exactResponseBody",
             response_sha256 as "responseSha256"
      from public.manifest_promotion_operations
      where attempt_id = ${uuid(attemptId)}
        and organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
      ${lockClause}
    `);
    return rows[0] ? mapManifestPromotionOperation(rows[0]) : null;
  }

  async #loadSelections(
    database: PackscoutPrismaClient | PackscoutTransactionClient,
  ): Promise<readonly ManifestPromotionActiveSelection[]> {
    const rows = await database.$queryRaw<SelectionRow[]>(Prisma.sql`
      select platform_key as "platformKey", active_generation as "activeGeneration",
             manifest_public_release_id::text as "manifestPublicReleaseId",
             provider_public_release_id::text as "providerPublicReleaseId",
             provider_release_fingerprint as "providerReleaseFingerprint",
             selected_checkpoint as "selectedCheckpoint",
             selection_body as "selectionBody", selection_sha256 as "selectionSha256",
             provider_terminal_operation_id as "providerTerminalOperationId",
             provider_terminal_receipt_sha256 as "providerTerminalReceiptSha256",
             publish_artifact_attempt_id::text as "publishArtifactAttemptId",
             activated_at as "activatedAt"
      from public.manifest_active_provider_selections
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
      order by platform_key collate "C"
    `);
    return rows.map(mapManifestPromotionSelection);
  }

  async #supersedeIfStaleBeforeFirstDispatch(
    transaction: PackscoutTransactionClient,
    attempt: ManifestAttemptRow,
    requestedEvaluationSequence: bigint,
    observedAt: Date,
  ): Promise<boolean> {
    const operation = await this.#loadOperation(transaction, attempt.id, true);
    if (operation !== null && operation.sendCount > 0) return false;
    if (
      requestedEvaluationSequence === attempt.evaluationSequence
    ) return false;

    const superseded = await supersedeUndispatchedManifestAttempt(
      transaction,
      {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      },
      attempt,
      attempt.bootstrapProviderSetSha256,
      observedAt,
    );
    if (!superseded) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    return true;
  }

  async #buildEvaluationSnapshot(
    transaction: PackscoutTransactionClient,
    evaluationSequence: bigint,
  ): Promise<ManifestPromotionEvaluationSnapshot | null> {
    const eligibility = await loadManifestEligibilitySnapshotInTransaction(
      transaction, { organizationId: this.#organizationId },
    );
    if (!eligibility) return null;
    const [completedRows, readinessRows, selections, activeState] =
      await Promise.all([
        this.#loadCompletedHeads(transaction, eligibility.enabledPlatformKeys),
        loadProviderCausalReadinessInTransaction(transaction, {
          organizationId: this.#organizationId,
          checkpoints: eligibility.checkpoints,
        }),
        this.#loadSelections(transaction),
        this.#loadActiveState(transaction),
      ]);
    const completed = new Map(
      completedRows.map((head) => [head.platformKey, head]),
    );
    const readiness = new Map(
      readinessRows.map((fact) => [fact.platformKey, fact]),
    );
    const active = new Map(
      selections.map((selection) => [selection.platformKey, selection]),
    );
    const providerFacts: ManifestPromotionProviderFact[] =
      eligibility.checkpoints.map((checkpoint) => {
        const ready = readiness.get(checkpoint.platformKey);
        return {
          platformKey: checkpoint.platformKey,
          checkpoint,
          minimumEligibleCheckpoint: ready!.lifecycleSequence,
          initialBackfillComplete: ready?.completedBackfillAt !== null &&
            ready?.completedBackfillAt !== undefined,
          completedBackfillAt: ready?.completedBackfillAt ?? null,
          lastSuccessfulObservationAt:
            ready?.lastSuccessfulObservationAt ?? null,
          completedHead: completed.get(checkpoint.platformKey) ?? null,
          activeSelection: active.get(checkpoint.platformKey) ?? null,
        };
      });
    const withoutDigest = {
      evaluationSequence,
      eligibility,
      providerFacts,
      activeState,
    };
    const projectionBody = canonicalJson(
      manifestSnapshotProjection(withoutDigest),
    );
    return {
      ...withoutDigest,
      snapshotSha256: promotionV2Sha256(projectionBody),
    };
  }

  async #loadActiveState(
    database: PackscoutPrismaClient | PackscoutTransactionClient,
  ): Promise<ManifestPromotionActiveState | null> {
    const rows = await database.$queryRaw<ManifestLaneRow[]>(Prisma.sql`
      select bootstrap_state as "bootstrapState",
             requested_evaluation_sequence as "requestedEvaluationSequence",
             confirmed_evaluation_sequence as "confirmedEvaluationSequence",
             active_generation as "activeGeneration",
             active_state_body as "activeStateBody",
             active_state_sha256 as "activeStateSha256",
             active_state_receipt_body as "activeStateReceiptBody",
             active_state_receipt_sha256 as "activeStateReceiptSha256",
             active_state_response_body as "activeStateResponseBody",
             active_state_response_sha256 as "activeStateResponseSha256"
      from public.manifest_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
    `);
    const row = rows[0];
    if (row?.activeStateBody === null || row === undefined) return null;
    if (
      row.activeStateSha256 === null || row.activeStateReceiptBody === null ||
      row.activeStateReceiptSha256 === null ||
      promotionV2Sha256(row.activeStateBody) !== row.activeStateSha256 ||
      promotionV2Sha256(row.activeStateReceiptBody) !==
        row.activeStateReceiptSha256 ||
      (row.activeStateResponseBody === null) !==
        (row.activeStateResponseSha256 === null) ||
      (row.activeStateResponseBody !== null &&
        promotionV2Sha256(row.activeStateResponseBody) !==
          row.activeStateResponseSha256)
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    let state;
    try {
      state = activeCatalogManifestStateV1Schema.parse(
        JSON.parse(row.activeStateBody),
      );
    } catch {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    const selections = await this.#loadSelections(database);
    const observed = state.observation?.providerSelections ?? [];
    if (canonicalJson(state) !== row.activeStateBody ||
      BigInt(state.generation) !== row.activeGeneration ||
      selections.length !== observed.length ||
      selections.some((selection, index) =>
        selection.activeGeneration !== row.activeGeneration ||
        canonicalJson(selection.selection) !== canonicalJson(observed[index]))) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    return {
      state,
      canonicalStateBody: row.activeStateBody,
      stateSha256: row.activeStateSha256,
      canonicalActiveStateReceiptBody: row.activeStateReceiptBody,
      activeStateReceiptSha256: row.activeStateReceiptSha256,
      exactResponseBody: row.activeStateResponseBody,
      responseSha256: row.activeStateResponseSha256,
      activeSelections: selections,
    };
  }

  async #loadCompletedHeads(
    database: PackscoutTransactionClient,
    platformKeys: readonly string[],
  ): Promise<readonly ProviderPromotionCompletedHead[]> {
    if (platformKeys.length === 0) return [];
    const laneRows = await database.$queryRaw<Array<{
      platformKey: string;
      completedCheckpoint: bigint;
    }>>(Prisma.sql`
      select platform_key as "platformKey",
             completed_checkpoint as "completedCheckpoint"
      from public.provider_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and platform_key = any(${[...platformKeys]}::text[])
      order by platform_key collate "C"
    `);
    const rows = await database.$queryRaw<CompletedHeadRow[]>(Prisma.sql`
      select lane.platform_key as "platformKey",
             lane.completed_checkpoint as "targetCheckpoint",
             lane.completed_public_provider_release_id::text as "publicProviderReleaseId",
             lane.completed_provider_release_fingerprint as "providerReleaseFingerprint",
             lane.completed_head_body as "completedHeadBody",
             lane.completed_head_sha256 as "completedHeadSha256",
             lane.completed_terminal_operation_kind as "terminalOperationKind",
             lane.completed_terminal_operation_id as "terminalOperationId",
             lane.completed_terminal_receipt_sha256 as "terminalReceiptSha256",
             operation.canonical_receipt_body as "canonicalReceiptBody",
             operation.exact_response_body as "exactResponseBody",
             operation.response_sha256 as "responseSha256",
             lane.completed_at as "completedAt",
             artifact.publish_attempt_id::text as "publishArtifactAttemptId"
      from public.provider_promotion_lanes as lane
      join public.provider_promotion_operations as operation
        on operation.attempt_id = lane.completed_attempt_id
       and operation.operation_id = lane.completed_terminal_operation_id
      join public.provider_release_artifacts as artifact
        on artifact.organization_id = lane.organization_id
       and artifact.deployment_key = lane.deployment_key
       and artifact.platform_key = lane.platform_key
       and artifact.public_provider_release_id = lane.completed_public_provider_release_id
       and artifact.provider_release_fingerprint = lane.completed_provider_release_fingerprint
      where lane.organization_id = ${uuid(this.#organizationId)}
        and lane.deployment_key = ${this.#deploymentKey}
        and lane.platform_key = any(${[...platformKeys]}::text[])
        and lane.completed_checkpoint > 0
      order by lane.platform_key collate "C"
    `);
    const expectedCompleted = laneRows.filter(
      ({ completedCheckpoint }) => completedCheckpoint > 0n,
    );
    if (rows.length !== expectedCompleted.length || rows.some((row, index) =>
      row.platformKey !== expectedCompleted[index]?.platformKey)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    return rows.map((row) => {
      let completedHead;
      try {
        completedHead = providerReleaseCompletedHeadResultV1Schema.parse(
          JSON.parse(row.completedHeadBody),
        );
      } catch {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      if (
        promotionV2Sha256(row.completedHeadBody) !== row.completedHeadSha256 ||
        canonicalJson(completedHead) !== row.completedHeadBody ||
        promotionV2Sha256(row.canonicalReceiptBody) !== row.terminalReceiptSha256 ||
        completedHead.platformKey !== row.platformKey ||
        completedHead.release.publicProviderReleaseId !==
          row.publicProviderReleaseId ||
        completedHead.release.providerReleaseFingerprint !==
          row.providerReleaseFingerprint ||
        completedHead.providerCheckpoint.settledSequence !==
          String(row.targetCheckpoint)
      ) throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      return {
        ...row,
        completedHead,
      };
    });
  }

  #parseActiveStateReceipt(evidence: ActiveStateReceiptEvidence): Readonly<{
    state: ActiveCatalogManifestStateV1;
    receiptSha256: string;
    exactResponseBody: string | null;
    responseSha256: string | null;
  }> {
    if (manifestPromotionByteCount(evidence.requestBody) >
      PROMOTION_V2_MAX_REQUEST_BYTES ||
      manifestPromotionByteCount(evidence.canonicalReceiptBody) >
        PROMOTION_V2_MAX_MANIFEST_RECEIPT_BYTES) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    let request;
    let json: unknown;
    try {
      request = parseCatalogManifestPublicationJson(
        evidence.requestBody,
        catalogManifestActiveStateRequestSchema,
      );
      if (request === null) throw new Error("request");
      json = JSON.parse(evidence.canonicalReceiptBody);
    } catch {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    const parsed = catalogManifestActiveStateReceiptSchema.safeParse(json);
    if (!parsed.success || canonicalJson(parsed.data) !==
      evidence.canonicalReceiptBody ||
      parsed.data.operationId !== request.operationId ||
      parsed.data.requestDigest !== promotionV2Sha256(evidence.requestBody)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    const exactResponseBody = evidence.exactResponseBody ?? null;
    let responseSha256: string | null = null;
    if (exactResponseBody !== null) {
      if (manifestPromotionByteCount(exactResponseBody) >
        PROMOTION_V2_MAX_RESPONSE_BYTES) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
      }
      try {
        const envelope = catalogManifestSignedReceiptEnvelopeSchema.parse(
          JSON.parse(exactResponseBody),
        );
        if (canonicalJson(envelope.receipt) !== evidence.canonicalReceiptBody) {
          throw new Error("receipt");
        }
      } catch {
        throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
      }
      responseSha256 = promotionV2Sha256(exactResponseBody);
    }
    return {
      state: parsed.data.details.activeState,
      receiptSha256: promotionV2Sha256(evidence.canonicalReceiptBody),
      exactResponseBody,
      responseSha256,
    };
  }

  async #replaceActiveState(
    transaction: PackscoutTransactionClient,
    input: ManifestPromotionActiveStateReplacement,
  ): Promise<void> {
    await replaceManifestPromotionActiveState(
      transaction,
      {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
      },
      input,
      () => this.#loadSelections(transaction),
    );
  }

  async #terminalize(
    transaction: PackscoutTransactionClient,
    attempt: ManifestAttemptRow,
    input: { outcome: string; completedAt: Date },
    failureClass: PromotionV2FailureClass | null,
    failureCode: string | null,
  ): Promise<void> {
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_attempts
      set state = ${input.outcome}, terminal_at = ${input.completedAt},
          failure_class = ${failureClass}, failure_code = ${failureCode},
          claim_owner = null, claim_token = null, claim_expires_at = null,
          last_heartbeat_at = null, retry_at = null, updated_at = ${input.completedAt}
      where id = ${uuid(attempt.id)}
    `);
  }

  async #confirmEvaluation(
    transaction: PackscoutTransactionClient,
    evaluationSequence: bigint,
    at: Date,
  ): Promise<void> {
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set confirmed_evaluation_sequence = greatest(
            confirmed_evaluation_sequence, ${evaluationSequence}),
          next_retry_at = null, updated_at = ${at}
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
    `);
  }
}
