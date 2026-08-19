import { canonicalJson } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutTransactionClient } from "./database.ts";
import {
  PromotionV2PersistenceError,
  parseProviderCheckpointIdentityBody,
  promotionV2Sha256,
  type PromotionV2ScopeBinding,
  type ProviderPromotionScopeBinding,
} from "./promotion-v2-types.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

/**
 * Retires an attempt whose bootstrap proof changed before any remote dispatch,
 * then preserves the exact checkpoint as a new monotonic evaluation. The new
 * attempt can only be claimed after the current provider set is re-proven.
 */
export async function supersedeUndispatchedProviderAttempt(
  transaction: PackscoutTransactionClient,
  binding: ProviderPromotionScopeBinding,
  attempt: Readonly<{
    id: string;
    evaluationSequence: bigint;
    evaluationCheckpointBody: string;
    evaluationCheckpointSha256: string;
  }>,
  supersededAt: Date,
  replacementCheckpoint: Readonly<{
    body: string;
    sha256: string;
  }> | null | undefined = undefined,
): Promise<boolean> {
  if (promotionV2Sha256(attempt.evaluationCheckpointBody) !==
    attempt.evaluationCheckpointSha256) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  parseProviderCheckpointIdentityBody(attempt.evaluationCheckpointBody);
  const laneRows = await transaction.$queryRaw<Array<{
    nextEvaluationSequence: bigint;
    requestedEvaluationSequence: bigint;
  }>>(Prisma.sql`
    select next_evaluation_sequence as "nextEvaluationSequence",
           requested_evaluation_sequence as "requestedEvaluationSequence"
    from public.provider_promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
      and platform_key = ${binding.platformKey}
    for update
  `);
  const lane = laneRows[0];
  if (!lane) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  const changed = await transaction.$executeRaw(Prisma.sql`
    update public.provider_promotion_attempts as candidate
    set state = 'superseded', terminal_at = ${supersededAt},
        failure_class = null, failure_code = null,
        claim_owner = null, claim_token = null, claim_expires_at = null,
        last_heartbeat_at = null, retry_at = null, updated_at = ${supersededAt}
    where candidate.id = ${uuid(attempt.id)}
      and candidate.organization_id = ${uuid(binding.organizationId)}
      and candidate.deployment_key = ${binding.deploymentKey}
      and candidate.platform_key = ${binding.platformKey}
      and candidate.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      and not exists (
        select 1 from public.provider_promotion_operations as operation
        where operation.attempt_id = candidate.id and operation.send_count > 0
      )
  `);
  if (changed !== 1) return false;

  if (lane.requestedEvaluationSequence > attempt.evaluationSequence) {
    await transaction.$executeRaw(Prisma.sql`
      update public.provider_promotion_lanes
      set confirmed_evaluation_sequence = greatest(
            confirmed_evaluation_sequence, ${attempt.evaluationSequence}),
          next_retry_at = null, updated_at = ${supersededAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
        and platform_key = ${binding.platformKey}
    `);
    return true;
  }

  if (replacementCheckpoint === null) {
    await transaction.$executeRaw(Prisma.sql`
      update public.provider_promotion_lanes
      set confirmed_evaluation_sequence = greatest(
            confirmed_evaluation_sequence, ${attempt.evaluationSequence}),
          next_retry_at = null, updated_at = ${supersededAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
        and platform_key = ${binding.platformKey}
    `);
    return true;
  }

  const checkpointBody = replacementCheckpoint?.body ??
    attempt.evaluationCheckpointBody;
  const checkpointSha256 = replacementCheckpoint?.sha256 ??
    attempt.evaluationCheckpointSha256;
  if (promotionV2Sha256(checkpointBody) !== checkpointSha256) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  const replacement = parseProviderCheckpointIdentityBody(checkpointBody);
  const evaluationSequence = lane.nextEvaluationSequence + 1n;
  await transaction.$executeRaw(Prisma.sql`
    insert into public.provider_promotion_evaluations (
      organization_id, deployment_key, platform_key, evaluation_sequence,
      checkpoint_body, checkpoint_sha256, settled_checkpoint,
      source_head_checkpoint, requested_at
    ) values (
      ${uuid(binding.organizationId)}, ${binding.deploymentKey},
      ${binding.platformKey}, ${evaluationSequence},
      ${checkpointBody}, ${checkpointSha256},
      ${replacement.settledSequence}, ${replacement.sourceHeadSequence},
      ${supersededAt}
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    update public.provider_promotion_lanes
    set next_evaluation_sequence = ${evaluationSequence},
        requested_evaluation_sequence = ${evaluationSequence},
        requested_at = ${supersededAt}, next_retry_at = null,
        latest_checkpoint_body = ${checkpointBody},
        latest_checkpoint_sha256 = ${checkpointSha256},
        updated_at = ${supersededAt}
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
      and platform_key = ${binding.platformKey}
  `);
  return true;
}

/** Manifest equivalent of the provider zero-dispatch supersession boundary. */
export async function supersedeUndispatchedManifestAttempt(
  transaction: PackscoutTransactionClient,
  binding: PromotionV2ScopeBinding,
  attempt: Readonly<{ id: string; evaluationSequence: bigint }>,
  providerSetSha256: string | null,
  supersededAt: Date,
): Promise<boolean> {
  const laneRows = await transaction.$queryRaw<Array<{
    nextEvaluationSequence: bigint;
    requestedEvaluationSequence: bigint;
  }>>(Prisma.sql`
    select next_evaluation_sequence as "nextEvaluationSequence",
           requested_evaluation_sequence as "requestedEvaluationSequence"
    from public.manifest_promotion_lanes
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
    for update
  `);
  const lane = laneRows[0];
  if (!lane) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  const changed = await transaction.$executeRaw(Prisma.sql`
    update public.manifest_promotion_attempts as candidate
    set state = 'superseded', terminal_at = ${supersededAt},
        failure_class = null, failure_code = null,
        claim_owner = null, claim_token = null, claim_expires_at = null,
        last_heartbeat_at = null, retry_at = null, updated_at = ${supersededAt}
    where candidate.id = ${uuid(attempt.id)}
      and candidate.organization_id = ${uuid(binding.organizationId)}
      and candidate.deployment_key = ${binding.deploymentKey}
      and candidate.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      and not exists (
        select 1 from public.manifest_promotion_operations as operation
        where operation.attempt_id = candidate.id and operation.send_count > 0
      )
  `);
  if (changed !== 1) return false;

  if (lane.requestedEvaluationSequence > attempt.evaluationSequence) {
    await transaction.$executeRaw(Prisma.sql`
      update public.manifest_promotion_lanes
      set confirmed_evaluation_sequence = greatest(
            confirmed_evaluation_sequence, ${attempt.evaluationSequence}),
          next_retry_at = null, updated_at = ${supersededAt}
      where organization_id = ${uuid(binding.organizationId)}
        and deployment_key = ${binding.deploymentKey}
    `);
    return true;
  }

  const evaluationSequence = lane.nextEvaluationSequence + 1n;
  const cause = "bootstrap_reconcile";
  const causeIdentity = `${attempt.id}:${providerSetSha256 ?? "unproven"}`;
  const causeSha256 = promotionV2Sha256(canonicalJson({
    cause,
    causeIdentity,
  }));
  await transaction.$executeRaw(Prisma.sql`
    insert into public.manifest_promotion_evaluations (
      organization_id, deployment_key, evaluation_sequence, cause,
      cause_identity, cause_sha256, requested_at
    ) values (
      ${uuid(binding.organizationId)}, ${binding.deploymentKey},
      ${evaluationSequence}, ${cause}, ${causeIdentity}, ${causeSha256},
      ${supersededAt}
    )
  `);
  await transaction.$executeRaw(Prisma.sql`
    update public.manifest_promotion_lanes
    set next_evaluation_sequence = ${evaluationSequence},
        requested_evaluation_sequence = ${evaluationSequence},
        requested_at = ${supersededAt}, next_retry_at = null,
        updated_at = ${supersededAt}
    where organization_id = ${uuid(binding.organizationId)}
      and deployment_key = ${binding.deploymentKey}
  `);
  return true;
}
