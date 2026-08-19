import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PromotionV2PersistenceError,
  finiteDate,
  type ManifestPromotionHealth,
  type PromotionV2ScopeBinding,
} from "./promotion-v2-types.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function loadManifestPromotionHealth(
  database: PackscoutPrismaClient,
  binding: PromotionV2ScopeBinding,
  now: Date,
): Promise<ManifestPromotionHealth> {
  if (!finiteDate(now)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  const rows = await database.$queryRaw<ManifestPromotionHealth[]>(Prisma.sql`
    select lane.bootstrap_state as "bootstrapState",
           lane.requested_evaluation_sequence as "requestedEvaluationSequence",
           lane.confirmed_evaluation_sequence as "confirmedEvaluationSequence",
           lane.active_generation as "activeGeneration",
           lane.active_public_release_id::text as "activePublicReleaseId",
           lane.active_configuration_epoch_sequence as "activeConfigurationEpochSequence",
           lane.delayed_provider_count as "delayedProviderCount",
           attempt.id::text as "activeAttemptId",
           attempt.state as "activeAttemptState",
           attempt.created_at as "activeAttemptStartedAt",
           attempt.retry_at as "retryAt",
           lane.last_activated_at as "lastActivatedAt",
           lane.last_reconciled_at as "lastReconciledAt"
    from public.manifest_promotion_lanes as lane
    left join lateral (
      select candidate.id, candidate.state, candidate.created_at,
             candidate.retry_at
      from public.manifest_promotion_attempts as candidate
      where candidate.organization_id = lane.organization_id
        and candidate.deployment_key = lane.deployment_key
        and candidate.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      limit 1
    ) as attempt on true
    where lane.organization_id = ${uuid(binding.organizationId)}
      and lane.deployment_key = ${binding.deploymentKey}
  `);
  return rows[0] ?? {
    bootstrapState: "unverified",
    requestedEvaluationSequence: 0n,
    confirmedEvaluationSequence: 0n,
    activeGeneration: 0n,
    activePublicReleaseId: null,
    activeConfigurationEpochSequence: null,
    delayedProviderCount: 0,
    activeAttemptId: null,
    activeAttemptState: null,
    activeAttemptStartedAt: null,
    retryAt: null,
    lastActivatedAt: null,
    lastReconciledAt: null,
  };
}
