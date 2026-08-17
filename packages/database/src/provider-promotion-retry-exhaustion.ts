import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import {
  PromotionV2PersistenceError,
  assertPromotionV2Failure,
  finiteDate,
  parseProviderCheckpointIdentityBody,
  promotionV2Sha256,
  type PromotionRetryExhaustionResult,
  type PromotionV2FailureClass,
  type ProviderPromotionScopeBinding,
} from "./promotion-v2-types.ts";
import {
  lockPromotionConfigurationScope,
  promotionAttemptBootstrapProofIsCurrent,
} from
  "./promotion-v2-bootstrap-proof-guard.ts";
import { supersedeUndispatchedProviderAttempt } from
  "./promotion-v2-stale-attempt.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function recordProviderPromotionRetryExhaustion(
  database: PackscoutPrismaClient,
  binding: ProviderPromotionScopeBinding,
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
    const lanes = await transaction.$queryRaw<Array<{
      nextEvaluationSequence: bigint;
    }>>(Prisma.sql`
      select next_evaluation_sequence as "nextEvaluationSequence"
      from public.provider_promotion_lanes
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
        and platform_key = ${binding.platformKey}
      for update
    `);
    const rows = await transaction.$queryRaw<Array<{
      evaluationSequence: bigint;
      checkpointBody: string;
      checkpointSha256: string;
      claimToken: string | null;
      claimExpiresAt: Date | null;
      state: string;
      bootstrapProofRevision: bigint;
      bootstrapProviderSetSha256: string;
    }>>(Prisma.sql`
      select attempt.evaluation_sequence as "evaluationSequence",
             evaluation.checkpoint_body as "checkpointBody",
             evaluation.checkpoint_sha256 as "checkpointSha256",
             attempt.claim_token::text as "claimToken",
             attempt.claim_expires_at as "claimExpiresAt", attempt.state
             , attempt.bootstrap_proof_revision as "bootstrapProofRevision"
             , attempt.bootstrap_provider_set_sha256
               as "bootstrapProviderSetSha256"
      from public.provider_promotion_attempts as attempt
      join public.provider_promotion_evaluations as evaluation
        on evaluation.organization_id = attempt.organization_id
       and evaluation.deployment_key = attempt.deployment_key
       and evaluation.platform_key = attempt.platform_key
       and evaluation.evaluation_sequence = attempt.evaluation_sequence
      where attempt.id = ${uuid(input.attemptId)}
        and attempt.organization_id = ${uuid(binding.organizationId)}
        and attempt.deployment_key = ${binding.deploymentKey}
        and attempt.platform_key = ${binding.platformKey}
      for update of attempt
    `);
    const attempt = rows[0];
    if (!attempt || attempt.claimToken !== input.claimToken ||
      attempt.claimExpiresAt === null ||
      attempt.claimExpiresAt <= input.failedAt ||
      !["assembling", "ready", "in_progress"].includes(attempt.state)) {
      return null;
    }
    if (promotionV2Sha256(attempt.checkpointBody) !== attempt.checkpointSha256) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
    }
    const dispatchedRows = await transaction.$queryRaw<Array<{
      dispatched: boolean;
    }>>(Prisma.sql`
      select exists (
        select 1 from public.provider_promotion_operations
        where attempt_id = ${uuid(input.attemptId)} and send_count > 0
      ) as dispatched
    `);
    const proofCurrent = await promotionAttemptBootstrapProofIsCurrent(
      transaction, binding, attempt,
    );
    if (!proofCurrent && dispatchedRows[0]?.dispatched !== true) {
      await supersedeUndispatchedProviderAttempt(
        transaction,
        binding,
        {
          id: input.attemptId,
          evaluationSequence: attempt.evaluationSequence,
          evaluationCheckpointBody: attempt.checkpointBody,
          evaluationCheckpointSha256: attempt.checkpointSha256,
        },
        input.failedAt,
      );
      const current = await transaction.$queryRaw<Array<{
        requestedEvaluationSequence: bigint;
      }>>(Prisma.sql`
        select requested_evaluation_sequence as "requestedEvaluationSequence"
        from public.provider_promotion_lanes
        where organization_id = ${uuid(binding.organizationId)}
          and deployment_key = ${binding.deploymentKey}
          and platform_key = ${binding.platformKey}
      `);
      return {
        result: "requeued" as const,
        evaluationSequence: current[0]!.requestedEvaluationSequence,
      };
    }
    if (dispatchedRows[0]?.dispatched === true) {
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
        where organization_id = ${uuid(binding.organizationId)}
          and deployment_key = ${binding.deploymentKey}
          and platform_key = ${binding.platformKey}
      `);
      return {
        result: "status_required" as const,
        evaluationSequence: attempt.evaluationSequence,
      };
    }
    const checkpoint = parseProviderCheckpointIdentityBody(
      attempt.checkpointBody,
    );
    const evaluationSequence = lanes[0]!.nextEvaluationSequence + 1n;
    await transaction.$executeRaw(Prisma.sql`
      update public.provider_promotion_attempts
      set state = 'failed', retry_count = retry_count + 1,
          terminal_at = ${input.failedAt}, failure_class = ${input.failureClass},
          failure_code = ${input.failureCode}, claim_owner = null,
          claim_token = null, claim_expires_at = null,
          last_heartbeat_at = null, retry_at = null, updated_at = ${input.failedAt}
      where id = ${uuid(input.attemptId)}
    `);
    await transaction.$executeRaw(Prisma.sql`
      insert into public.provider_promotion_evaluations (
        organization_id, deployment_key, platform_key, evaluation_sequence,
        checkpoint_body, checkpoint_sha256, settled_checkpoint,
        source_head_checkpoint, requested_at
      ) values (
        ${uuid(binding.organizationId)}, ${binding.deploymentKey},
        ${binding.platformKey}, ${evaluationSequence}, ${attempt.checkpointBody},
        ${attempt.checkpointSha256}, ${checkpoint.settledSequence},
        ${checkpoint.sourceHeadSequence}, ${input.failedAt}
      )
    `);
    await transaction.$executeRaw(Prisma.sql`
      update public.provider_promotion_lanes
      set next_evaluation_sequence = ${evaluationSequence},
          requested_evaluation_sequence = ${evaluationSequence},
          requested_at = ${input.failedAt}, next_retry_at = null,
          latest_checkpoint_body = ${attempt.checkpointBody},
          latest_checkpoint_sha256 = ${attempt.checkpointSha256},
          updated_at = ${input.failedAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
        and platform_key = ${binding.platformKey}
    `);
    return { result: "requeued" as const, evaluationSequence };
  }, PACKSCOUT_TRANSACTION_OPTIONS);
}
