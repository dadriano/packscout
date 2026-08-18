import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PromotionV2PersistenceError,
  finiteDate,
  type ProviderPromotionHealth,
  type ProviderPromotionScopeBinding,
} from "./promotion-v2-types.ts";

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`cast(${value} as uuid)`;
}

export async function loadProviderPromotionHealth(
  database: PackscoutPrismaClient,
  binding: ProviderPromotionScopeBinding,
  now: Date,
): Promise<ProviderPromotionHealth> {
  if (!finiteDate(now)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");
  }
  const rows = await database.$queryRaw<Array<Omit<
    ProviderPromotionHealth,
    "platformKey"
  >>>(Prisma.sql`
    select lane.settled_checkpoint as "settledCheckpoint",
           lifecycle."lifecycleState",
           lane.source_head_checkpoint as "sourceHeadCheckpoint",
           lane.requested_evaluation_sequence as "requestedEvaluationSequence",
           lane.confirmed_evaluation_sequence as "confirmedEvaluationSequence",
           lane.completed_checkpoint as "completedCheckpoint",
           lane.completed_public_provider_release_id::text
             as "completedPublicProviderReleaseId",
           active.selected_checkpoint as "activeCheckpoint",
           active.provider_public_release_id::text
             as "activePublicProviderReleaseId",
           active.manifest_public_release_id::text
             as "activeManifestPublicReleaseId",
           attempt.id::text as "activeAttemptId",
           attempt.state as "activeAttemptState",
           attempt.created_at as "activeAttemptStartedAt",
           attempt.retry_at as "retryAt", lane.completed_at as "completedAt"
    from public.provider_promotion_lanes as lane
    left join public.manifest_active_provider_selections as active
      on active.organization_id = lane.organization_id
     and active.deployment_key = lane.deployment_key
     and active.platform_key = lane.platform_key
    left join lateral (
      select impact.lifecycle_state::text as "lifecycleState"
      from public.public_change_catalog_impacts as impact
      join public.catalog_manifest_lifecycle_checkpoints as checkpoint
        on checkpoint.organization_id = impact.organization_id
       and impact.cause_sequence <= checkpoint.settled_sequence
      where impact.organization_id = lane.organization_id
        and impact.lifecycle_platform_key = lane.platform_key
      order by impact.cause_sequence desc
      limit 1
    ) as lifecycle on true
    left join lateral (
      select candidate.id, candidate.state, candidate.created_at,
             candidate.retry_at
      from public.provider_promotion_attempts as candidate
      where candidate.organization_id = lane.organization_id
        and candidate.deployment_key = lane.deployment_key
        and candidate.platform_key = lane.platform_key
        and candidate.state in ('assembling', 'ready', 'in_progress', 'retry_wait')
      limit 1
    ) as attempt on true
    where lane.organization_id = ${uuid(binding.organizationId)}
      and lane.deployment_key = ${binding.deploymentKey}
      and lane.platform_key = ${binding.platformKey}
  `);
  const row = rows[0];
  return {
    platformKey: binding.platformKey,
    lifecycleState: row?.lifecycleState ?? null,
    settledCheckpoint: row?.settledCheckpoint ?? 0n,
    sourceHeadCheckpoint: row?.sourceHeadCheckpoint ?? 0n,
    requestedEvaluationSequence: row?.requestedEvaluationSequence ?? 0n,
    confirmedEvaluationSequence: row?.confirmedEvaluationSequence ?? 0n,
    completedCheckpoint: row?.completedCheckpoint ?? 0n,
    completedPublicProviderReleaseId:
      row?.completedPublicProviderReleaseId ?? null,
    activeCheckpoint: row?.activeCheckpoint ?? null,
    activePublicProviderReleaseId: row?.activePublicProviderReleaseId ?? null,
    activeManifestPublicReleaseId: row?.activeManifestPublicReleaseId ?? null,
    activeAttemptId: row?.activeAttemptId ?? null,
    activeAttemptState: row?.activeAttemptState ?? null,
    activeAttemptStartedAt: row?.activeAttemptStartedAt ?? null,
    retryAt: row?.retryAt ?? null,
    completedAt: row?.completedAt ?? null,
  };
}
