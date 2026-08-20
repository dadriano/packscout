import { canonicalJson } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import {
  PromotionV2PersistenceError,
  assertPromotionV2Failure,
  finiteDate,
  promotionV2Sha256,
  type PromotionRetryExhaustionResult,
  type PromotionV2FailureClass,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";
import {
  lockPromotionConfigurationScope,
  promotionAttemptBootstrapProofIsCurrent,
} from
  "./promotion-v2-bootstrap-proof-guard.ts";
import { supersedeUndispatchedManifestAttempt } from
  "./promotion-v2-stale-attempt.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function recordManifestPromotionRetryExhaustion(
  database: PackscoutPrismaClient,
  binding: PromotionV2ScopeBinding,
  input: Readonly<{
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: PromotionV2FailureClass;
    failureCode: string;
  }>,
): Promise<PromotionRetryExhaustionResult | null> {
  assertPromotionV2Failure(input.failureClass, input.failureCode);
  if (!finiteDate(input.failedAt) || !finiteDate(input.retryAt) ||
    input.retryAt <= input.failedAt) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  return database.$transaction(async (transaction) => {
    await lockPromotionConfigurationScope(transaction, binding);
    const laneRows = await transaction.$queryRaw<Array<{
      nextEvaluationSequence: bigint;
      bootstrapProviderSetSha256: string | null;
    }>>(Prisma.sql`
      select next_evaluation_sequence as "nextEvaluationSequence",
             bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256"
      from public.manifest_promotion_lanes
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
      for update
    `);
    const rows = await transaction.$queryRaw<Array<{
      evaluationSequence: bigint;
      claimToken: string | null;
      claimExpiresAt: Date | null;
      state: string;
      bootstrapProofRevision: bigint;
      bootstrapProviderSetSha256: string;
    }>>(Prisma.sql`
      select evaluation_sequence as "evaluationSequence",
             claim_token::text as "claimToken",
             claim_expires_at as "claimExpiresAt", state,
             bootstrap_proof_revision as "bootstrapProofRevision",
             bootstrap_provider_set_sha256 as "bootstrapProviderSetSha256"
      from public.manifest_promotion_attempts
      where id = ${uuid(input.attemptId)}
        and organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
      for update
    `);
    const attempt = rows[0];
    if (!attempt || attempt.claimToken !== input.claimToken ||
      attempt.claimExpiresAt === null ||
      attempt.claimExpiresAt <= input.failedAt ||
      !["assembling", "ready", "in_progress"].includes(attempt.state)) {
      return null;
    }
    const dispatchedRows = await transaction.$queryRaw<Array<{
      dispatched: boolean;
    }>>(Prisma.sql`
      select exists (
        select 1 from public.manifest_promotion_operations
        where attempt_id = ${uuid(input.attemptId)} and send_count > 0
      ) as dispatched
    `);
    const proofCurrent = await promotionAttemptBootstrapProofIsCurrent(
      transaction, binding, attempt,
    );
    if (!proofCurrent && dispatchedRows[0]?.dispatched !== true) {
      await supersedeUndispatchedManifestAttempt(
        transaction,
        binding,
        {
          id: input.attemptId,
          evaluationSequence: attempt.evaluationSequence,
        },
        laneRows[0]?.bootstrapProviderSetSha256 ?? null,
        input.failedAt,
      );
      const current = await transaction.$queryRaw<Array<{
        requestedEvaluationSequence: bigint;
      }>>(Prisma.sql`
        select requested_evaluation_sequence as "requestedEvaluationSequence"
        from public.manifest_promotion_lanes
        where organization_id = ${uuid(binding.organizationId)}
          and deployment_key = ${binding.deploymentKey}
      `);
      return {
        result: "requeued" as const,
        evaluationSequence: current[0]!.requestedEvaluationSequence,
      };
    }
    if (dispatchedRows[0]?.dispatched === true) {
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
        where organization_id = ${uuid(binding.organizationId)}
          and deployment_key = ${binding.deploymentKey}
      `);
      return {
        result: "status_required" as const,
        evaluationSequence: attempt.evaluationSequence,
      };
    }
    const evaluationSequence = laneRows[0]!.nextEvaluationSequence + 1n;
    const cause = "retry_exhausted";
    const causeIdentity = `${input.attemptId}:${input.failureCode}`;
    const causeSha256 = promotionV2Sha256(canonicalJson({
      cause, causeIdentity,
    }));
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_attempts
      set state = 'failed', retry_count = retry_count + 1,
          terminal_at = ${input.failedAt}, failure_class = ${input.failureClass},
          failure_code = ${input.failureCode}, claim_owner = null,
          claim_token = null, claim_expires_at = null,
          last_heartbeat_at = null, retry_at = null, updated_at = ${input.failedAt}
      where id = ${uuid(input.attemptId)}
    `);
    await transaction.$executeRaw(Prisma.sql`
      insert into public.manifest_promotion_evaluations (
        organization_id, deployment_key, evaluation_sequence, cause,
        cause_identity, cause_sha256, requested_at
      ) values (
        ${uuid(binding.organizationId)}, ${binding.deploymentKey},
        ${evaluationSequence}, ${cause}, ${causeIdentity}, ${causeSha256},
        ${input.failedAt}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set next_evaluation_sequence = ${evaluationSequence},
          requested_evaluation_sequence = ${evaluationSequence},
          requested_at = ${input.failedAt}, next_retry_at = null,
          updated_at = ${input.failedAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
    `);
    return { result: "requeued" as const, evaluationSequence };
  }, PACKSCOUT_TRANSACTION_OPTIONS);
}
