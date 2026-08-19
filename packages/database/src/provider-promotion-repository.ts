import {
  canonicalJson,
  providerReleaseErrorEnvelopeSchema,
  providerReleaseImmutableProofV1Schema,
  providerReleaseReceiptSchema,
  type ProviderCatalogCompletedReleaseProofV1,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import { loadManifestEligibilitySnapshotInTransaction } from
  "./public-change-settlement-repository.provider-read.ts";
import {
  PROMOTION_V2_MAX_SUMMARY_BYTES,
  PromotionV2PersistenceError,
  assertPromotionV2ClaimInput,
  assertPromotionV2Failure,
  assertProviderPromotionBinding,
  finiteDate,
  parseProviderCheckpointIdentityBody,
  promotionV2Sha256,
  providerCheckpointIdentityBody,
  type ExactPromotionOperationInput,
  type ExactPromotionOperationRecord,
  type ExactPromotionReceiptEvidence,
  type PromotionV2FailureClass,
  type ProviderPromotionCheckpointIdentity,
  type ProviderPromotionClaim,
  type ProviderPromotionCompletedHead,
  type ProviderPromotionPreparedSummary,
  type ProviderPromotionReconciliationFailureCode,
  type ProviderPromotionReleaseArtifact,
  type ProviderPromotionScopeBinding,
} from "./promotion-v2-types.ts";
import {
  parseProviderPromotionPreparedSummary,
  parseProviderPromotionReceiptEvidence,
  providerPromotionByteCount,
  providerPromotionPreparedSummaryBody,
  validateProviderPromotionPrepared,
  type ProviderPromotionOperationRow,
} from "./provider-promotion-repository-validation.ts";
import { recordProviderPromotionRetryExhaustion } from
  "./provider-promotion-retry-exhaustion.ts";
import { loadProviderPromotionHealth } from "./provider-promotion-health.ts";
import { supersedeUndispatchedProviderAttempt } from
  "./promotion-v2-stale-attempt.ts";
import {
  lockPromotionConfigurationScope,
  promotionAttemptBootstrapProofIsCurrent,
} from "./promotion-v2-bootstrap-proof-guard.ts";

type ProviderAttemptState = ProviderPromotionClaim["state"] |
  "published" | "reused" | "superseded" | "cas_lost" | "failed";

interface LaneRow {
  requestedEvaluationSequence: bigint;
  confirmedEvaluationSequence: bigint;
  completedCheckpoint: bigint;
  completedPublicProviderReleaseId: string | null;
  completedHeadBody: string | null;
  completedTerminalReceiptSha256: string | null;
}

interface AttemptRow {
  id: string;
  evaluationSequence: bigint;
  bootstrapProofRevision: bigint;
  bootstrapProviderSetSha256: string;
  targetCheckpoint: bigint;
  state: ProviderAttemptState;
  preparedSummaryBody: string | null;
  preparedSummarySha256: string | null;
  preparedClassification: "publish" | "reuse" | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  claimCount: number;
  retryCount: number;
  evaluationCheckpointBody: string;
  evaluationCheckpointSha256: string;
}

type OperationRow = ProviderPromotionOperationRow;

interface ArtifactRow {
  platformKey: string;
  publicProviderReleaseId: string;
  providerReleaseFingerprint: string;
  immutableProofBody: string;
  immutableProofSha256: string;
  publishAttemptId: string;
  completedAt: Date;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}


function mapOperation(row: OperationRow): ExactPromotionOperationRecord {
  return {
    operationIndex: row.operationIndex,
    operationId: row.operationId,
    operationKind: row.operationKind,
    requestPath: row.requestPath,
    canonicalRequestBody: row.canonicalRequestBody,
    requestSha256: row.requestSha256,
    state: row.state,
    sendCount: row.sendCount,
    lastSentAt: row.lastSentAt,
    acknowledgedAt: row.acknowledgedAt,
    canonicalReceiptBody: row.canonicalReceiptBody,
    receiptSha256: row.receiptSha256,
    exactResponseBody: row.exactResponseBody,
    responseSha256: row.responseSha256,
  };
}

function expectedHeadBodyFromLane(
  platformKey: string,
  lane: LaneRow,
): string {
  if (lane.completedCheckpoint === 0n) {
    return canonicalJson({
      platformKey,
      publicProviderReleaseId: null,
      sharedConfigurationEpoch: null,
      providerCheckpoint: { settledSequence: "0", settledAt: null },
      observation: null,
      terminalReceiptSha256: null,
    });
  }
  if (
    lane.completedHeadBody === null ||
    lane.completedPublicProviderReleaseId === null ||
    lane.completedTerminalReceiptSha256 === null
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  const completed = JSON.parse(lane.completedHeadBody) as {
    release: { sharedConfigurationEpoch: unknown };
    providerCheckpoint: unknown;
    observation: unknown;
  };
  return canonicalJson({
    platformKey,
    publicProviderReleaseId: lane.completedPublicProviderReleaseId,
    sharedConfigurationEpoch: completed.release.sharedConfigurationEpoch,
    providerCheckpoint: completed.providerCheckpoint,
    observation: completed.observation,
    terminalReceiptSha256: lane.completedTerminalReceiptSha256,
  });
}

/** Durable per-platform promotion ledger. All scope is server-bound. */
export class PrismaProviderPromotionRepository {
  readonly #organizationId: string;
  readonly #deploymentKey: string;
  readonly #platformKey: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    binding: ProviderPromotionScopeBinding,
  ) {
    assertProviderPromotionBinding(binding);
    this.#organizationId = binding.organizationId.toLowerCase();
    this.#deploymentKey = binding.deploymentKey;
    this.#platformKey = binding.platformKey;
  }

  async enqueueEvaluation(input: Readonly<{
    checkpoint: ProviderPromotionCheckpointIdentity;
    requestedAt: Date;
  }>): Promise<Readonly<{
    evaluationSequence: bigint;
    result: "created" | "coalesced";
  }>> {
    if (
      input.checkpoint.platformKey !== this.#platformKey ||
      !finiteDate(input.requestedAt)
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_SCOPE_MISMATCH");
    const checkpointBody = providerCheckpointIdentityBody(input.checkpoint);
    const checkpointSha256 = promotionV2Sha256(checkpointBody);
    return this.database.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        insert into public.provider_promotion_lanes (
          organization_id, deployment_key, platform_key
        ) values (
          ${uuid(this.#organizationId)}, ${this.#deploymentKey}, ${this.#platformKey}
        ) on conflict do nothing
      `);
      const lanes = await transaction.$queryRaw<Array<{
        nextEvaluationSequence: bigint;
        settledCheckpoint: bigint;
        sourceHeadCheckpoint: bigint;
        latestCheckpointBody: string | null;
      }>>(Prisma.sql`
        select next_evaluation_sequence as "nextEvaluationSequence",
               settled_checkpoint as "settledCheckpoint",
               source_head_checkpoint as "sourceHeadCheckpoint",
               latest_checkpoint_body as "latestCheckpointBody"
        from public.provider_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
        for update
      `);
      const lane = lanes[0]!;
      const previous = lane.latestCheckpointBody === null
        ? null : parseProviderCheckpointIdentityBody(lane.latestCheckpointBody);
      if (
        input.checkpoint.settledSequence < lane.settledCheckpoint ||
        input.checkpoint.sourceHeadSequence < lane.sourceHeadCheckpoint ||
        (previous !== null && (
          input.checkpoint.sharedConfigurationEpoch.publicChangeSequence <
            previous.sharedConfigurationEpoch.publicChangeSequence ||
          (input.checkpoint.sharedConfigurationEpoch.publicChangeSequence ===
              previous.sharedConfigurationEpoch.publicChangeSequence && (
            input.checkpoint.sharedConfigurationEpoch.configurationKey !==
              previous.sharedConfigurationEpoch.configurationKey ||
            input.checkpoint.sharedConfigurationEpoch.revision !==
              previous.sharedConfigurationEpoch.revision ||
            input.checkpoint.sharedConfigurationEpoch.configurationHash !==
              previous.sharedConfigurationEpoch.configurationHash
          )) ||
          (input.checkpoint.settledSequence === previous.settledSequence &&
            input.checkpoint.settledAt?.getTime() !==
              previous.settledAt?.getTime()) ||
          (input.checkpoint.sourceHeadSequence === previous.sourceHeadSequence &&
            input.checkpoint.sourceHeadAt.getTime() !==
              previous.sourceHeadAt.getTime()) ||
          input.checkpoint.lastSuccessfulObservationAt <
            previous.lastSuccessfulObservationAt ||
          (input.checkpoint.lastSuccessfulObservationAt.getTime() ===
              previous.lastSuccessfulObservationAt.getTime() && (
            input.checkpoint.staleAt.getTime() !== previous.staleAt.getTime() ||
            input.checkpoint.freshness !== previous.freshness
          ))
        ))
      ) throw new PromotionV2PersistenceError(
        "PROMOTION_V2_CHECKPOINT_REGRESSED",
      );
      const existing = await transaction.$queryRaw<Array<{
        evaluationSequence: bigint;
      }>>(Prisma.sql`
        select evaluation_sequence as "evaluationSequence"
        from public.provider_promotion_evaluations
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
          and checkpoint_sha256 = ${checkpointSha256}
        order by evaluation_sequence desc
        limit 1
      `);
      if (existing[0]) {
        return { evaluationSequence: existing[0].evaluationSequence, result: "coalesced" };
      }
      const evaluationSequence = lane.nextEvaluationSequence + 1n;
      await transaction.$executeRaw(Prisma.sql`
        insert into public.provider_promotion_evaluations (
          organization_id, deployment_key, platform_key,
          evaluation_sequence, checkpoint_body, checkpoint_sha256,
          settled_checkpoint, source_head_checkpoint, requested_at
        ) values (
          ${uuid(this.#organizationId)}, ${this.#deploymentKey}, ${this.#platformKey},
          ${evaluationSequence}, ${checkpointBody}, ${checkpointSha256},
          ${input.checkpoint.settledSequence}, ${input.checkpoint.sourceHeadSequence},
          ${input.requestedAt}
        )
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_lanes
        set next_evaluation_sequence = ${evaluationSequence},
            requested_evaluation_sequence = ${evaluationSequence},
            requested_at = ${input.requestedAt},
            latest_checkpoint_body = ${checkpointBody},
            latest_checkpoint_sha256 = ${checkpointSha256},
            settled_checkpoint = ${input.checkpoint.settledSequence},
            settled_at = ${input.checkpoint.settledAt},
            source_head_checkpoint = ${input.checkpoint.sourceHeadSequence},
            source_head_at = ${input.checkpoint.sourceHeadAt},
            updated_at = ${input.requestedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
      `);
      return { evaluationSequence, result: "created" };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async claim(input: Readonly<{
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
  }>): Promise<ProviderPromotionClaim | null> {
    assertPromotionV2ClaimInput(input);
    return this.database.$transaction(async (transaction) => {
      const lanes = await transaction.$queryRaw<LaneRow[]>(Prisma.sql`
        select requested_evaluation_sequence as "requestedEvaluationSequence",
               confirmed_evaluation_sequence as "confirmedEvaluationSequence",
               completed_checkpoint as "completedCheckpoint",
               completed_public_provider_release_id::text as "completedPublicProviderReleaseId",
               completed_head_body as "completedHeadBody",
               completed_terminal_receipt_sha256 as "completedTerminalReceiptSha256"
        from public.provider_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
        for update
      `);
      const lane = lanes[0];
      if (!lane || lane.requestedEvaluationSequence === 0n) return null;
      const bootstrapRows = await transaction.$queryRaw<Array<{
        bootstrapState: "unverified" | "verified_empty" |
          "verified_cleared" | "verified_active";
        providerSetBody: string | null;
        providerSetSha256: string | null;
        currentProofRevision: bigint | null;
      }>>(Prisma.sql`
        select bootstrap_state as "bootstrapState",
               bootstrap_provider_set_body as "providerSetBody",
               bootstrap_provider_set_sha256 as "providerSetSha256",
               current_bootstrap_proof_revision as "currentProofRevision"
        from public.manifest_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
        for share
      `);
      if (!bootstrapRows[0] ||
        bootstrapRows[0].bootstrapState === "unverified") {
        throw new PromotionV2PersistenceError(
          "PROMOTION_V2_BOOTSTRAP_UNVERIFIED",
        );
      }
      let attempt = await this.#lockActiveAttempt(transaction);
      const attemptProofCurrent = attempt === null ? true :
        await promotionAttemptBootstrapProofIsCurrent(transaction, {
          organizationId: this.#organizationId,
          deploymentKey: this.#deploymentKey,
        }, attempt);
      const bootstrap = bootstrapRows[0]!;
      const eligibility = await loadManifestEligibilitySnapshotInTransaction(
        transaction, { organizationId: this.#organizationId },
      );
      const providerSetMatches = eligibility !== null &&
        bootstrap.currentProofRevision !== null &&
        bootstrap.providerSetBody !== null &&
        bootstrap.providerSetSha256 === promotionV2Sha256(
          bootstrap.providerSetBody,
        ) && bootstrap.providerSetBody === canonicalJson(
          eligibility.configuredPlatformKeys,
        );
      if (!providerSetMatches || !attemptProofCurrent) {
        if (!attempt) return null;
        const recovery = await transaction.$queryRaw<Array<{
          pending: boolean;
        }>>(Prisma.sql`
          select exists (
            select 1 from public.provider_promotion_operations
            where attempt_id = ${uuid(attempt.id)} and send_count > 0
          ) as pending
        `);
        if (recovery[0]?.pending !== true) {
          await supersedeUndispatchedProviderAttempt(transaction, {
            organizationId: this.#organizationId,
            deploymentKey: this.#deploymentKey,
            platformKey: this.#platformKey,
          }, attempt, input.now);
          return null;
        }
      }
      if (!attempt) {
        if (lane.requestedEvaluationSequence <= lane.confirmedEvaluationSequence) {
          return null;
        }
        const inserted = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
          insert into public.provider_promotion_attempts (
            organization_id, deployment_key, platform_key,
            evaluation_sequence, bootstrap_proof_revision,
            bootstrap_provider_set_sha256, target_checkpoint
          )
          select ${uuid(this.#organizationId)}, ${this.#deploymentKey},
                 ${this.#platformKey}, evaluation_sequence,
                 ${bootstrap.currentProofRevision},
                 ${bootstrap.providerSetSha256}, settled_checkpoint
          from public.provider_promotion_evaluations
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${this.#platformKey}
            and evaluation_sequence = ${lane.requestedEvaluationSequence}
          returning id::text, evaluation_sequence as "evaluationSequence",
                    bootstrap_proof_revision as "bootstrapProofRevision",
                    bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
                    target_checkpoint as "targetCheckpoint", state,
                    prepared_summary_body as "preparedSummaryBody",
                    prepared_summary_sha256 as "preparedSummarySha256",
                    prepared_classification as "preparedClassification",
                    claim_token::text as "claimToken",
                    claim_expires_at as "claimExpiresAt", claim_count as "claimCount",
                    retry_count as "retryCount",
                    ''::text as "evaluationCheckpointBody",
                    ''::text as "evaluationCheckpointSha256"
        `);
        attempt = inserted[0] ?? null;
      }
      if (!attempt) return null;
      if (
        attempt.claimToken !== null &&
        attempt.claimExpiresAt !== null &&
        attempt.claimExpiresAt.getTime() > input.now.getTime()
      ) return null;
      if (
        attempt.state === "retry_wait" &&
        !(await this.#retryIsDue(transaction, attempt.id, input.now))
      ) return null;
      const claimed = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
        update public.provider_promotion_attempts as attempt
        set claim_owner = ${input.workerId}, claim_token = gen_random_uuid(),
            claim_expires_at = ${input.leaseExpiresAt},
            last_heartbeat_at = ${input.now}, claim_count = claim_count + 1,
            retry_at = null,
            state = case when prepared_summary_body is null
              then 'assembling' else 'in_progress' end,
            updated_at = ${input.now}
        from public.provider_promotion_evaluations as evaluation
        where attempt.id = ${uuid(attempt.id)}
          and evaluation.organization_id = attempt.organization_id
          and evaluation.deployment_key = attempt.deployment_key
          and evaluation.platform_key = attempt.platform_key
          and evaluation.evaluation_sequence = attempt.evaluation_sequence
        returning attempt.id::text, attempt.evaluation_sequence as "evaluationSequence",
                  attempt.bootstrap_proof_revision as "bootstrapProofRevision",
                  attempt.bootstrap_provider_set_sha256
                    as "bootstrapProviderSetSha256",
                  attempt.target_checkpoint as "targetCheckpoint", attempt.state,
                  attempt.prepared_summary_body as "preparedSummaryBody",
                  attempt.prepared_summary_sha256 as "preparedSummarySha256",
                  attempt.prepared_classification as "preparedClassification",
                  attempt.claim_token::text as "claimToken",
                  attempt.claim_expires_at as "claimExpiresAt",
                  attempt.claim_count as "claimCount", attempt.retry_count as "retryCount",
                  evaluation.checkpoint_body as "evaluationCheckpointBody",
                  evaluation.checkpoint_sha256 as "evaluationCheckpointSha256"
      `);
      const row = claimed[0];
      if (!row?.claimToken || !row.claimExpiresAt) return null;
      if (promotionV2Sha256(row.evaluationCheckpointBody) !==
        row.evaluationCheckpointSha256) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      if ((row.preparedSummaryBody === null) !==
          (row.preparedSummarySha256 === null) ||
        (row.preparedSummaryBody !== null &&
          promotionV2Sha256(row.preparedSummaryBody) !==
            row.preparedSummarySha256)) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      return {
        attemptId: row.id,
        claimToken: row.claimToken,
        claimExpiresAt: row.claimExpiresAt,
        claimCount: row.claimCount,
        retryCount: row.retryCount,
        recovered: row.claimCount > 1,
        platformKey: this.#platformKey,
        evaluationSequence: row.evaluationSequence,
        checkpoint: parseProviderCheckpointIdentityBody(
          row.evaluationCheckpointBody,
        ),
        checkpointSha256: row.evaluationCheckpointSha256,
        state: row.state as ProviderPromotionClaim["state"],
        preparedSummary: row.preparedSummaryBody === null
          ? null
          : parseProviderPromotionPreparedSummary(row.preparedSummaryBody),
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async heartbeat(input: Readonly<{
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    leaseExpiresAt: Date;
  }>): Promise<boolean> {
    if (
      !finiteDate(input.heartbeatAt) || !finiteDate(input.leaseExpiresAt) ||
      input.leaseExpiresAt <= input.heartbeatAt
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.heartbeatAt, true,
      );
      if (!attempt) return false;
      const changed = await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_attempts
        set last_heartbeat_at = ${input.heartbeatAt},
            claim_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.heartbeatAt}
        where id = ${uuid(input.attemptId)}
      `);
      return changed === 1;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async persistPreparedOperations(input: Readonly<{
    attemptId: string;
    claimToken: string;
    preparedAt: Date;
    summary: ProviderPromotionPreparedSummary;
    operations: readonly ExactPromotionOperationInput[];
  }>): Promise<readonly ExactPromotionOperationRecord[] | null> {
    if (!finiteDate(input.preparedAt)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    const body = providerPromotionPreparedSummaryBody(input.summary);
    const digest = promotionV2Sha256(body);
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.preparedAt,
      );
      if (!attempt) return null;
      validateProviderPromotionPrepared(
        this.#platformKey, attempt.targetCheckpoint,
        attempt.evaluationCheckpointBody, attempt.evaluationCheckpointSha256,
        input.summary,
        input.operations,
      );
      if (attempt.preparedSummarySha256 !== null) {
        if (attempt.preparedSummarySha256 !== digest) {
          throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
        }
        return this.#listOperations(transaction, input.attemptId);
      }
      for (const operation of input.operations) {
        await transaction.$executeRaw(Prisma.sql`
          insert into public.provider_promotion_operations (
            attempt_id, organization_id, deployment_key, platform_key,
            operation_index, operation_id, operation_kind, request_path,
            canonical_request_body, request_sha256
          ) values (
            ${uuid(input.attemptId)}, ${uuid(this.#organizationId)},
            ${this.#deploymentKey}, ${this.#platformKey},
            ${operation.operationIndex}, ${operation.operationId},
            ${operation.operationKind}, ${operation.requestPath},
            ${operation.canonicalRequestBody},
            ${promotionV2Sha256(operation.canonicalRequestBody)}
          )
        `);
      }
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_attempts
        set prepared_classification = ${input.summary.classification},
            prepared_summary_body = ${body}, prepared_summary_sha256 = ${digest},
            public_provider_release_id = ${uuid(input.summary.publicProviderReleaseId)},
            provider_release_fingerprint = ${input.summary.providerReleaseFingerprint},
            expected_completed_head_sha256 = ${promotionV2Sha256(
              canonicalJson(input.summary.expectedCompletedHead),
            )},
            prepared_at = ${input.preparedAt}, state = 'ready',
            updated_at = ${input.preparedAt}
        where id = ${uuid(input.attemptId)}
      `);
      return this.#listOperations(transaction, input.attemptId);
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async listOperations(input: Readonly<{
    attemptId: string;
  }>): Promise<readonly ExactPromotionOperationRecord[]> {
    return this.#listOperations(this.database, input.attemptId);
  }

  async firstUnacknowledgedOperation(input: Readonly<{
    attemptId: string;
    claimToken: string;
    now: Date;
  }>): Promise<ExactPromotionOperationRecord | null> {
    const attempt = await this.#loadClaimedAttempt(
      input.attemptId, input.claimToken, input.now,
    );
    if (!attempt) return null;
    const rows = await this.database.$queryRaw<OperationRow[]>(Prisma.sql`
      select operation_index as "operationIndex", operation_id as "operationId",
             operation_kind as "operationKind", request_path as "requestPath",
             canonical_request_body as "canonicalRequestBody",
             request_sha256 as "requestSha256", state, send_count as "sendCount",
             last_sent_at as "lastSentAt", acknowledged_at as "acknowledgedAt",
             canonical_receipt_body as "canonicalReceiptBody",
             receipt_sha256 as "receiptSha256",
             exact_response_body as "exactResponseBody",
             response_sha256 as "responseSha256"
      from public.provider_promotion_operations
      where attempt_id = ${uuid(input.attemptId)} and state <> 'acknowledged'
      order by operation_index limit 1
    `);
    return rows[0] ? mapOperation(rows[0]) : null;
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
        latestCheckpointSha256: string | null;
      }>>(Prisma.sql`
        select requested_evaluation_sequence as "requestedEvaluationSequence",
               latest_checkpoint_sha256 as "latestCheckpointSha256"
        from public.provider_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
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
        transaction,
        attempt,
        lane.requestedEvaluationSequence,
        lane.latestCheckpointSha256,
        input.sentAt,
      )) return false;
      const first = await this.#firstPending(transaction, input.attemptId);
      if (!first || first.operationId !== input.operationId) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_ORDER");
      }
      const changed = await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_operations
        set state = 'sent', send_count = send_count + 1,
            last_sent_at = ${input.sentAt}, updated_at = ${input.sentAt}
        where attempt_id = ${uuid(input.attemptId)}
          and operation_id = ${input.operationId}
          and state in ('pending', 'sent')
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_attempts
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
      const first = await this.#firstPending(transaction, input.attemptId);
      if (!first || first.operationId !== input.operationId || first.state !== "sent") {
        throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_ORDER");
      }
      const evidence = parseProviderPromotionReceiptEvidence(
        first,
        input.evidence,
      );
      const changed = await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_operations
        set state = 'acknowledged', acknowledged_at = ${input.acknowledgedAt},
            canonical_receipt_body = ${input.evidence.canonicalReceiptBody},
            receipt_sha256 = ${evidence.receiptSha256},
            exact_response_body = ${evidence.exactResponseBody},
            response_sha256 = ${evidence.responseSha256},
            updated_at = ${input.acknowledgedAt}
        where attempt_id = ${uuid(input.attemptId)}
          and operation_id = ${input.operationId} and state = 'sent'
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
    if (!finiteDate(input.failedAt) || !finiteDate(input.retryAt) || input.retryAt <= input.failedAt) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.failedAt, true,
      );
      if (!attempt) return false;
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_attempts
        set state = 'retry_wait', retry_count = retry_count + 1,
            retry_at = ${input.retryAt}, failure_class = ${input.failureClass},
            failure_code = ${input.failureCode}, claim_owner = null,
            claim_token = null, claim_expires_at = null,
            last_heartbeat_at = null, updated_at = ${input.failedAt}
        where id = ${uuid(input.attemptId)}
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_lanes
        set next_retry_at = ${input.retryAt}, updated_at = ${input.failedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
      `);
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async recordReconciliationLoss(input: Readonly<{
    attemptId: string;
    claimToken: string;
    failureCode: ProviderPromotionReconciliationFailureCode;
    canonicalErrorBody: string;
    observedAt: Date;
  }>): Promise<Readonly<{ evaluationSequence: bigint }> | null> {
    if (!finiteDate(input.observedAt) ||
      providerPromotionByteCount(input.canonicalErrorBody) >
        PROMOTION_V2_MAX_SUMMARY_BYTES) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    let errorJson: unknown;
    try {
      errorJson = JSON.parse(input.canonicalErrorBody);
    } catch {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    const error = providerReleaseErrorEnvelopeSchema.safeParse(errorJson);
    if (!error.success || canonicalJson(error.data) !== input.canonicalErrorBody ||
      error.data.code !== input.failureCode ||
      ![
        "PROVIDER_RELEASE_PREDECESSOR_CONFLICT",
        "PROVIDER_RELEASE_STATE_CONFLICT",
        "PROVIDER_RELEASE_RECONCILIATION_FAILED",
      ].includes(input.failureCode)) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
    }
    return this.database.$transaction(async (transaction) => {
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.observedAt, true,
      );
      if (!attempt) return null;
      const pending = await this.#firstPending(transaction, attempt.id);
      if (pending?.state !== "sent" ||
        promotionV2Sha256(attempt.evaluationCheckpointBody) !==
          attempt.evaluationCheckpointSha256) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      const checkpoint = parseProviderCheckpointIdentityBody(
        attempt.evaluationCheckpointBody,
      );
      const lanes = await transaction.$queryRaw<Array<{
        nextEvaluationSequence: bigint;
      }>>(Prisma.sql`
        select next_evaluation_sequence as "nextEvaluationSequence"
        from public.provider_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
        for update
      `);
      const evaluationSequence = lanes[0]!.nextEvaluationSequence + 1n;
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_attempts
        set state = 'cas_lost', failure_class = 'reconciliation',
            failure_code = ${input.failureCode},
            cas_error_body = ${input.canonicalErrorBody},
            cas_error_sha256 = ${promotionV2Sha256(input.canonicalErrorBody)},
            terminal_at = ${input.observedAt}, claim_owner = null,
            claim_token = null, claim_expires_at = null,
            last_heartbeat_at = null, retry_at = null,
            updated_at = ${input.observedAt}
        where id = ${uuid(attempt.id)}
      `);
      await transaction.$executeRaw(Prisma.sql`
        insert into public.provider_promotion_evaluations (
          organization_id, deployment_key, platform_key,
          evaluation_sequence, checkpoint_body, checkpoint_sha256,
          settled_checkpoint, source_head_checkpoint, requested_at
        ) values (
          ${uuid(this.#organizationId)}, ${this.#deploymentKey},
          ${this.#platformKey}, ${evaluationSequence},
          ${attempt.evaluationCheckpointBody},
          ${attempt.evaluationCheckpointSha256},
          ${checkpoint.settledSequence}, ${checkpoint.sourceHeadSequence},
          ${input.observedAt}
        )
      `);
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_lanes
        set next_evaluation_sequence = ${evaluationSequence},
            requested_evaluation_sequence = ${evaluationSequence},
            requested_at = ${input.observedAt}, next_retry_at = null,
            latest_checkpoint_body = ${attempt.evaluationCheckpointBody},
            latest_checkpoint_sha256 = ${attempt.evaluationCheckpointSha256},
            updated_at = ${input.observedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
      `);
      return { evaluationSequence };
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
    return recordProviderPromotionRetryExhaustion(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
      platformKey: this.#platformKey,
    }, input);
  }

  async complete(input:
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "published" | "reused";
        completedAt: Date;
      }>
    | Readonly<{
        attemptId: string;
        claimToken: string;
        outcome: "superseded";
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
      const attempt = await this.#lockClaimedAttempt(
        transaction, input.attemptId, input.claimToken, input.completedAt, true,
      );
      if (!attempt) return false;
      const lanes = await transaction.$queryRaw<LaneRow[]>(Prisma.sql`
        select requested_evaluation_sequence as "requestedEvaluationSequence",
               confirmed_evaluation_sequence as "confirmedEvaluationSequence",
               completed_checkpoint as "completedCheckpoint",
               completed_public_provider_release_id::text as "completedPublicProviderReleaseId",
               completed_head_body as "completedHeadBody",
               completed_terminal_receipt_sha256 as "completedTerminalReceiptSha256"
        from public.provider_promotion_lanes
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
        for update
      `);
      const lane = lanes[0]!;
      if (input.outcome === "superseded") {
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
        await this.#confirmEvaluation(
          transaction, attempt.evaluationSequence, input.completedAt,
        );
        return true;
      }
      if (attempt.preparedSummaryBody === null) {
        throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      }
      const summary = parseProviderPromotionPreparedSummary(
        attempt.preparedSummaryBody,
      );
      if (
        (input.outcome === "published") !==
          (summary.classification === "publish") ||
        promotionV2Sha256(expectedHeadBodyFromLane(this.#platformKey, lane)) !==
          promotionV2Sha256(canonicalJson(summary.expectedCompletedHead))
      ) throw new PromotionV2PersistenceError(
        "PROMOTION_V2_PREDECESSOR_CONFLICT",
      );
      const operations = await this.#listOperations(transaction, attempt.id);
      const terminal = operations.at(-1);
      if (
        terminal?.state !== "acknowledged" ||
        terminal.canonicalReceiptBody === null ||
        terminal.receiptSha256 === null ||
        terminal.operationKind !== (input.outcome === "published"
          ? "finalize" : "confirmReuse") ||
        operations.some((operation) => operation.state !== "acknowledged")
      ) throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
      const receipt = providerReleaseReceiptSchema.parse(
        JSON.parse(terminal.canonicalReceiptBody),
      );
      if (
        !("details" in receipt) || !("completedHead" in receipt.details) ||
        receipt.platformKey !== this.#platformKey ||
        receipt.publicProviderReleaseId !== summary.publicProviderReleaseId
      ) throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
      const completedHead = receipt.details.completedHead;
      const completedHeadBody = canonicalJson(completedHead);
      const immutableProofBody = canonicalJson(summary.immutableProof);
      let publishArtifactAttemptId = attempt.id;
      if (input.outcome === "published") {
        await transaction.$executeRaw(Prisma.sql`
          insert into public.provider_release_artifacts (
            organization_id, deployment_key, platform_key,
            public_provider_release_id, provider_release_fingerprint,
            immutable_proof_body, immutable_proof_sha256,
            publish_attempt_id, completed_at
          ) values (
            ${uuid(this.#organizationId)}, ${this.#deploymentKey}, ${this.#platformKey},
            ${uuid(summary.publicProviderReleaseId)},
            ${summary.providerReleaseFingerprint}, ${immutableProofBody},
            ${promotionV2Sha256(immutableProofBody)}, ${uuid(attempt.id)},
            ${input.completedAt}
          ) on conflict do nothing
        `);
        const exact = await transaction.$queryRaw<Array<{
          publicProviderReleaseId: string;
          providerReleaseFingerprint: string;
          immutableProofBody: string;
          immutableProofSha256: string;
          publishAttemptId: string;
        }>>(Prisma.sql`
          select public_provider_release_id::text as "publicProviderReleaseId",
                 provider_release_fingerprint as "providerReleaseFingerprint",
                 immutable_proof_body as "immutableProofBody",
                 immutable_proof_sha256 as "immutableProofSha256",
                 publish_attempt_id::text as "publishAttemptId"
          from public.provider_release_artifacts
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${this.#platformKey}
            and public_provider_release_id = ${uuid(summary.publicProviderReleaseId)}
        `);
        const stored = exact[0];
        if (!stored || stored.publicProviderReleaseId !==
          summary.publicProviderReleaseId || stored.providerReleaseFingerprint !==
          summary.providerReleaseFingerprint || stored.immutableProofBody !==
          immutableProofBody || stored.immutableProofSha256 !==
          promotionV2Sha256(immutableProofBody) || stored.publishAttemptId !==
          attempt.id) {
          throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
        }
      } else {
        const artifact = await transaction.$queryRaw<Array<{
          publishAttemptId: string;
        }>>(Prisma.sql`
          select publish_attempt_id::text as "publishAttemptId"
          from public.provider_release_artifacts
          where organization_id = ${uuid(this.#organizationId)}
            and deployment_key = ${this.#deploymentKey}
            and platform_key = ${this.#platformKey}
            and public_provider_release_id = ${uuid(summary.publicProviderReleaseId)}
            and provider_release_fingerprint = ${summary.providerReleaseFingerprint}
        `);
        if (!artifact[0]) {
          throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
        }
        publishArtifactAttemptId = artifact[0].publishAttemptId;
      }
      await this.#terminalize(transaction, attempt, input, null, null);
      await transaction.$executeRaw(Prisma.sql`
        update public.provider_promotion_lanes
        set confirmed_evaluation_sequence = greatest(
              confirmed_evaluation_sequence, ${attempt.evaluationSequence}),
            completed_checkpoint = ${summary.targetCheckpoint},
            completed_at = ${input.completedAt},
            completed_public_provider_release_id = ${uuid(summary.publicProviderReleaseId)},
            completed_provider_release_fingerprint = ${summary.providerReleaseFingerprint},
            completed_head_body = ${completedHeadBody},
            completed_head_sha256 = ${promotionV2Sha256(completedHeadBody)},
            completed_terminal_operation_kind = ${terminal.operationKind},
            completed_terminal_operation_id = ${terminal.operationId},
            completed_terminal_receipt_sha256 = ${terminal.receiptSha256},
            completed_attempt_id = ${uuid(attempt.id)}, next_retry_at = null,
            updated_at = ${input.completedAt}
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and platform_key = ${this.#platformKey}
      `);
      await this.#enqueueManifestEvaluation(transaction, {
        cause: input.outcome === "published"
          ? "provider_completed"
          : "provider_reused",
        causeIdentity: `${this.#platformKey}:${terminal.operationId}:${terminal.receiptSha256}`,
        requestedAt: input.completedAt,
      });
      void publishArtifactAttemptId;
      return true;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async loadCompletedHead(): Promise<ProviderPromotionCompletedHead | null> {
    const laneRows = await this.database.$queryRaw<Array<{
      completedCheckpoint: bigint;
    }>>(Prisma.sql`
      select completed_checkpoint as "completedCheckpoint"
      from public.provider_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and platform_key = ${this.#platformKey}
    `);
    if (!laneRows[0] || laneRows[0].completedCheckpoint === 0n) return null;
    const rows = await this.database.$queryRaw<Array<{
      targetCheckpoint: bigint;
      publicProviderReleaseId: string;
      providerReleaseFingerprint: string;
      completedHeadBody: string;
      completedHeadSha256: string;
      terminalOperationKind: "finalize" | "confirmReuse";
      terminalOperationId: string;
      terminalReceiptSha256: string;
      canonicalReceiptBody: string;
      exactResponseBody: string | null;
      responseSha256: string | null;
      completedAt: Date;
      publishArtifactAttemptId: string;
    }>>(Prisma.sql`
      select lane.completed_checkpoint as "targetCheckpoint",
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
      join public.provider_promotion_attempts as attempt
        on attempt.id = lane.completed_attempt_id
       and attempt.organization_id = lane.organization_id
       and attempt.deployment_key = lane.deployment_key
       and attempt.platform_key = lane.platform_key
      join public.provider_promotion_operations as operation
        on operation.attempt_id = attempt.id
       and operation.operation_id = lane.completed_terminal_operation_id
      join public.provider_release_artifacts as artifact
        on artifact.organization_id = lane.organization_id
       and artifact.deployment_key = lane.deployment_key
       and artifact.platform_key = lane.platform_key
       and artifact.public_provider_release_id = lane.completed_public_provider_release_id
       and artifact.provider_release_fingerprint = lane.completed_provider_release_fingerprint
      where lane.organization_id = ${uuid(this.#organizationId)}
        and lane.deployment_key = ${this.#deploymentKey}
        and lane.platform_key = ${this.#platformKey}
        and lane.completed_checkpoint > 0
    `);
    const row = rows[0];
    if (!row || promotionV2Sha256(row.completedHeadBody) !== row.completedHeadSha256 ||
      promotionV2Sha256(row.canonicalReceiptBody) !== row.terminalReceiptSha256) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    return {
      platformKey: this.#platformKey,
      ...row,
      completedHead: JSON.parse(row.completedHeadBody) as
        ProviderPromotionCompletedHead["completedHead"],
    };
  }

  async findComplete(input: Readonly<{
    platformKey: string;
    sharedConfigurationEpoch: ProviderCatalogCompletedReleaseProofV1["sharedConfigurationEpoch"];
    publicProviderReleaseId: string;
    providerReleaseFingerprint: string;
  }>): Promise<ProviderCatalogCompletedReleaseProofV1 | null> {
    if (input.platformKey !== this.#platformKey) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_SCOPE_MISMATCH");
    }
    const artifact = await this.loadReleaseArtifact({
      publicProviderReleaseId: input.publicProviderReleaseId,
    });
    if (
      artifact === null ||
      artifact.providerReleaseFingerprint !== input.providerReleaseFingerprint ||
      canonicalJson(artifact.immutableProof.sharedConfigurationEpoch) !==
        canonicalJson(input.sharedConfigurationEpoch)
    ) return null;
    return { ...artifact.immutableProof, state: "complete" };
  }

  async loadReleaseArtifact(input: Readonly<{
    publicProviderReleaseId: string;
  }>): Promise<ProviderPromotionReleaseArtifact | null> {
    const rows = await this.database.$queryRaw<ArtifactRow[]>(Prisma.sql`
      select platform_key as "platformKey",
             public_provider_release_id::text as "publicProviderReleaseId",
             provider_release_fingerprint as "providerReleaseFingerprint",
             immutable_proof_body as "immutableProofBody",
             immutable_proof_sha256 as "immutableProofSha256",
             publish_attempt_id::text as "publishAttemptId",
             completed_at as "completedAt"
      from public.provider_release_artifacts
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and platform_key = ${this.#platformKey}
        and public_provider_release_id = ${uuid(input.publicProviderReleaseId)}
    `);
    const row = rows[0];
    if (!row) return null;
    if (promotionV2Sha256(row.immutableProofBody) !== row.immutableProofSha256) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    const operations = await this.#listOperations(
      this.database, row.publishAttemptId,
    );
    const terminal = operations.at(-1);
    if (
      terminal?.operationKind !== "finalize" ||
      terminal.canonicalReceiptBody === null || terminal.receiptSha256 === null ||
      operations.length < 2 || operations[0]?.operationKind !== "start"
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    return {
      ...row,
      immutableProof: providerReleaseImmutableProofV1Schema.parse(
        JSON.parse(row.immutableProofBody),
      ),
      operations,
      terminalReceiptBody: terminal.canonicalReceiptBody,
      terminalReceiptSha256: terminal.receiptSha256,
    };
  }

  async loadHealth(input: Readonly<{ now: Date }>) {
    return loadProviderPromotionHealth(this.database, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
      platformKey: this.#platformKey,
    }, input.now);
  }

  async #lockActiveAttempt(
    transaction: PackscoutTransactionClient,
  ): Promise<AttemptRow | null> {
    const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      select attempt.id::text, attempt.evaluation_sequence as "evaluationSequence",
             attempt.bootstrap_proof_revision as "bootstrapProofRevision",
             attempt.bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
             attempt.target_checkpoint as "targetCheckpoint", attempt.state,
             attempt.prepared_summary_body as "preparedSummaryBody",
             attempt.prepared_summary_sha256 as "preparedSummarySha256",
             attempt.prepared_classification as "preparedClassification",
             attempt.claim_token::text as "claimToken",
             attempt.claim_expires_at as "claimExpiresAt",
             attempt.claim_count as "claimCount", attempt.retry_count as "retryCount",
             evaluation.checkpoint_body as "evaluationCheckpointBody",
             evaluation.checkpoint_sha256 as "evaluationCheckpointSha256"
      from public.provider_promotion_attempts as attempt
      join public.provider_promotion_evaluations as evaluation
        on evaluation.organization_id = attempt.organization_id
       and evaluation.deployment_key = attempt.deployment_key
       and evaluation.platform_key = attempt.platform_key
       and evaluation.evaluation_sequence = attempt.evaluation_sequence
      where attempt.organization_id = ${uuid(this.#organizationId)}
        and attempt.deployment_key = ${this.#deploymentKey}
        and attempt.platform_key = ${this.#platformKey}
        and attempt.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      for update of attempt
    `);
    return rows[0] ?? null;
  }

  async #supersedeIfStaleBeforeFirstDispatch(
    transaction: PackscoutTransactionClient,
    attempt: AttemptRow,
    requestedEvaluationSequence: bigint,
    latestCheckpointSha256: string | null,
    observedAt: Date,
  ): Promise<boolean> {
    const dispatched = await transaction.$queryRaw<Array<{
      present: boolean;
    }>>(Prisma.sql`
      select exists (
        select 1 from public.provider_promotion_operations
        where attempt_id = ${uuid(attempt.id)} and send_count > 0
      ) as present
    `);
    if (dispatched[0]?.present === true) return false;

    if (
      requestedEvaluationSequence === attempt.evaluationSequence &&
      latestCheckpointSha256 === attempt.evaluationCheckpointSha256
    ) return false;

    return supersedeUndispatchedProviderAttempt(transaction, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
      platformKey: this.#platformKey,
    }, attempt, observedAt);
  }

  async #retryIsDue(
    transaction: PackscoutTransactionClient,
    attemptId: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ due: boolean }>>(Prisma.sql`
      select retry_at <= ${now} as due
      from public.provider_promotion_attempts
      where id = ${uuid(attemptId)}
    `);
    return rows[0]?.due === true;
  }

  async #lockClaimedAttempt(
    transaction: PackscoutTransactionClient,
    attemptId: string,
    claimToken: string,
    now: Date,
    allowSentRecovery = false,
  ): Promise<AttemptRow | null> {
    await lockPromotionConfigurationScope(transaction, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    });
    await transaction.$queryRaw(Prisma.sql`
      select requested_evaluation_sequence
      from public.provider_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and platform_key = ${this.#platformKey}
      for update
    `);
    const rows = await transaction.$queryRaw<AttemptRow[]>(Prisma.sql`
      select attempt.id::text, attempt.evaluation_sequence as "evaluationSequence",
             attempt.bootstrap_proof_revision as "bootstrapProofRevision",
             attempt.bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256",
             attempt.target_checkpoint as "targetCheckpoint", attempt.state,
             attempt.prepared_summary_body as "preparedSummaryBody",
             attempt.prepared_summary_sha256 as "preparedSummarySha256",
             attempt.prepared_classification as "preparedClassification",
             attempt.claim_token::text as "claimToken",
             attempt.claim_expires_at as "claimExpiresAt",
             attempt.claim_count as "claimCount", attempt.retry_count as "retryCount",
             evaluation.checkpoint_body as "evaluationCheckpointBody",
             evaluation.checkpoint_sha256 as "evaluationCheckpointSha256"
      from public.provider_promotion_attempts as attempt
      join public.provider_promotion_evaluations as evaluation
        on evaluation.organization_id = attempt.organization_id
       and evaluation.deployment_key = attempt.deployment_key
       and evaluation.platform_key = attempt.platform_key
       and evaluation.evaluation_sequence = attempt.evaluation_sequence
      where attempt.id = ${uuid(attemptId)}
        and attempt.organization_id = ${uuid(this.#organizationId)}
        and attempt.deployment_key = ${this.#deploymentKey}
        and attempt.platform_key = ${this.#platformKey}
        and attempt.claim_token = ${uuid(claimToken)}
        and attempt.claim_expires_at > ${now}
        and attempt.state in ('assembling', 'ready', 'in_progress')
      for update of attempt
    `);
    const row = rows[0] ?? null;
    if (row && !(await promotionAttemptBootstrapProofIsCurrent(transaction, {
      organizationId: this.#organizationId,
      deploymentKey: this.#deploymentKey,
    }, row))) {
      const dispatched = await transaction.$queryRaw<Array<{
        present: boolean;
      }>>(Prisma.sql`
        select exists (
          select 1 from public.provider_promotion_operations
          where attempt_id = ${uuid(row.id)} and send_count > 0
        ) as present
      `);
      if (dispatched[0]?.present === true) {
        if (allowSentRecovery) return row;
        throw new PromotionV2PersistenceError(
          "PROMOTION_V2_BOOTSTRAP_UNVERIFIED",
        );
      }
      await supersedeUndispatchedProviderAttempt(transaction, {
        organizationId: this.#organizationId,
        deploymentKey: this.#deploymentKey,
        platformKey: this.#platformKey,
      }, row, now);
      return null;
    }
    return row;
  }

  async #loadClaimedAttempt(
    attemptId: string,
    claimToken: string,
    now: Date,
  ): Promise<AttemptRow | null> {
    return this.database.$transaction(
      (transaction) => this.#lockClaimedAttempt(
        transaction, attemptId, claimToken, now, true,
      ),
      PACKSCOUT_TRANSACTION_OPTIONS,
    );
  }

  async #listOperations(
    database: PackscoutPrismaClient | PackscoutTransactionClient,
    attemptId: string,
  ): Promise<readonly ExactPromotionOperationRecord[]> {
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
      from public.provider_promotion_operations
      where attempt_id = ${uuid(attemptId)}
        and organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and platform_key = ${this.#platformKey}
      order by operation_index
    `);
    return rows.map(mapOperation);
  }

  async #firstPending(
    transaction: PackscoutTransactionClient,
    attemptId: string,
  ): Promise<OperationRow | null> {
    const rows = await transaction.$queryRaw<OperationRow[]>(Prisma.sql`
      select operation_index as "operationIndex", operation_id as "operationId",
             operation_kind as "operationKind", request_path as "requestPath",
             canonical_request_body as "canonicalRequestBody",
             request_sha256 as "requestSha256", state, send_count as "sendCount",
             last_sent_at as "lastSentAt", acknowledged_at as "acknowledgedAt",
             canonical_receipt_body as "canonicalReceiptBody",
             receipt_sha256 as "receiptSha256",
             exact_response_body as "exactResponseBody",
             response_sha256 as "responseSha256"
      from public.provider_promotion_operations
      where attempt_id = ${uuid(attemptId)} and state <> 'acknowledged'
      order by operation_index limit 1 for update
    `);
    return rows[0] ?? null;
  }

  async #terminalize(
    transaction: PackscoutTransactionClient,
    attempt: AttemptRow,
    input: { outcome: string; completedAt: Date },
    failureClass: PromotionV2FailureClass | null,
    failureCode: string | null,
  ): Promise<void> {
    await transaction.$executeRaw(Prisma.sql`
      update public.provider_promotion_attempts
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
      update public.provider_promotion_lanes
      set confirmed_evaluation_sequence = greatest(
            confirmed_evaluation_sequence, ${evaluationSequence}),
          next_retry_at = null, updated_at = ${at}
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
        and platform_key = ${this.#platformKey}
    `);
  }

  async #enqueueManifestEvaluation(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      cause: "provider_completed" | "provider_reused";
      causeIdentity: string;
      requestedAt: Date;
    }>,
  ): Promise<void> {
    await transaction.$executeRaw(Prisma.sql`
      insert into public.manifest_promotion_lanes (organization_id, deployment_key)
      values (${uuid(this.#organizationId)}, ${this.#deploymentKey})
      on conflict do nothing
    `);
    const laneRows = await transaction.$queryRaw<Array<{
      nextEvaluationSequence: bigint;
    }>>(Prisma.sql`
      select next_evaluation_sequence as "nextEvaluationSequence"
      from public.manifest_promotion_lanes
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
      for update
    `);
    const causeSha256 = promotionV2Sha256(canonicalJson({
      cause: input.cause,
      causeIdentity: input.causeIdentity,
    }));
    const existing = await transaction.$queryRaw<Array<{ present: boolean }>>(
      Prisma.sql`
        select true as present
        from public.manifest_promotion_evaluations
        where organization_id = ${uuid(this.#organizationId)}
          and deployment_key = ${this.#deploymentKey}
          and cause_sha256 = ${causeSha256}
      `,
    );
    if (existing[0]) return;
    const sequence = laneRows[0]!.nextEvaluationSequence + 1n;
    await transaction.$executeRaw(Prisma.sql`
      insert into public.manifest_promotion_evaluations (
        organization_id, deployment_key, evaluation_sequence, cause,
        cause_identity, cause_sha256, requested_at
      ) values (
        ${uuid(this.#organizationId)}, ${this.#deploymentKey}, ${sequence},
        ${input.cause}, ${input.causeIdentity}, ${causeSha256}, ${input.requestedAt}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set next_evaluation_sequence = ${sequence},
          requested_evaluation_sequence = ${sequence},
          requested_at = ${input.requestedAt}, updated_at = ${input.requestedAt}
      where organization_id = ${uuid(this.#organizationId)}
        and deployment_key = ${this.#deploymentKey}
    `);
  }
}
