import { createHash } from "node:crypto";
import { providerPlatformKeySchema } from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";

export interface PersistedPromotionReadinessDiagnostic {
  readonly activeAlertCount: number;
  readonly activeFailureAlertCount: number;
  readonly activeFailureAttemptId: string | null;
  readonly canonicalSettledWatermark: bigint;
  readonly canonicalSettledAt: Date | null;
  readonly canonicalSourceHeadWatermark: bigint;
  readonly confirmedWatermark: bigint;
  readonly laneTargetWatermark: bigint;
  readonly laneTargetAt: Date | null;
  readonly latestFailedAttemptId: string | null;
  readonly latestFailedWatermark: bigint | null;
  readonly latestFailureCode: string | null;
  readonly technicalFailureCount: number;
}

interface ReadinessRow {
  activeAlertCount: number;
  activeFailureAlertCount: number;
  activeFailureAttemptId: string | null;
  canonicalSettledWatermark: bigint;
  canonicalSettledAt: Date | null;
  canonicalSourceHeadWatermark: bigint;
  confirmedWatermark: bigint;
  laneTargetWatermark: bigint;
  laneTargetAt: Date | null;
  latestFailedAttemptId: string | null;
  latestFailedWatermark: bigint | null;
  latestFailureCode: string | null;
  technicalFailureCount: number;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const deploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export type PromotionReadinessScope =
  | Readonly<{
      organizationId: string;
      deploymentKey: string;
      lane: "provider";
      platformKey: string;
    }>
  | Readonly<{
      organizationId: string;
      deploymentKey: string;
      lane: "manifest" | "heat";
      platformKey?: never;
    }>;

export function promotionDeploymentScopeDigest(deploymentKey: string): string {
  if (!deploymentKeyPattern.test(deploymentKey)) {
    throw new RangeError("Promotion deployment scope is invalid.");
  }
  return createHash("sha256")
    .update("packscout.promotion.deployment.v1\0", "utf8")
    .update(deploymentKey, "utf8")
    .digest("hex");
}

/** Loads only allowlisted lane and settlement health for one server-bound scope. */
export class PrismaPromotionReadinessRepository {
  readonly alertLaneKey: string;
  readonly deploymentScopeDigest: string;
  readonly lane: "provider" | "manifest" | "heat";
  readonly platformKey: string | null;
  readonly #deploymentKey: string;
  readonly #failureDedupeKey: string;
  readonly #organizationId: string;
  readonly #recoveryKey: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    scope: PromotionReadinessScope,
  ) {
    const parsedPlatform = scope.lane === "provider"
      ? providerPlatformKeySchema.safeParse(scope.platformKey)
      : null;
    if (
      !uuidPattern.test(scope.organizationId) ||
      !deploymentKeyPattern.test(scope.deploymentKey) ||
      (scope.lane === "provider"
        ? !parsedPlatform?.success || parsedPlatform.data !== scope.platformKey
        : scope.platformKey !== undefined)
    ) {
      throw new RangeError("Promotion readiness scope is invalid.");
    }
    this.#organizationId = scope.organizationId.toLowerCase();
    this.#deploymentKey = scope.deploymentKey;
    this.lane = scope.lane;
    this.platformKey = scope.lane === "provider" ? scope.platformKey : null;
    this.deploymentScopeDigest = promotionDeploymentScopeDigest(
      scope.deploymentKey,
    );
    this.alertLaneKey = scope.lane === "provider"
      ? `provider:${scope.platformKey}`
      : scope.lane;
    const alertScope =
      `promotion:${this.deploymentScopeDigest}:${this.alertLaneKey}`;
    this.#failureDedupeKey = `${alertScope}:failed`;
    this.#recoveryKey = `${alertScope}:health`;
  }

  async load(): Promise<PersistedPromotionReadinessDiagnostic> {
    const rows = await this.database.$queryRaw<ReadinessRow[]>(Prisma.sql`
      with canonical as (
        select
          coalesce(max(settled_sequence), 0)::bigint
            as "canonicalSettledWatermark",
          max(settled_at) as "canonicalSettledAt",
          coalesce(max(source_head_sequence), 0)::bigint
            as "canonicalSourceHeadWatermark"
        from public.settled_public_watermarks
        where organization_id = cast(${this.#organizationId} as uuid)
      ), provider_scope as (
        select coalesce(lane.settled_checkpoint, 0)::bigint
          as settled_checkpoint
        from (values (1)) as singleton(value)
        left join public.provider_promotion_lanes lane
          on ${this.lane === "provider"}
         and lane.organization_id = cast(${this.#organizationId} as uuid)
         and lane.deployment_key = ${this.#deploymentKey}
         and lane.platform_key = ${this.platformKey ?? ""}
      ), technical as (
        select count(*)::integer as "technicalFailureCount"
        from public.public_derivation_obligations obligation
        cross join canonical
        cross join provider_scope
        left join public.public_change_catalog_impacts impact
          on impact.organization_id = obligation.organization_id
         and impact.cause_sequence = obligation.cause_sequence
        where obligation.organization_id = cast(${this.#organizationId} as uuid)
          and obligation.state = 'technical_failure'::public.public_derivation_state
          and case ${this.lane}
            when 'provider' then
              obligation.cause_sequence > provider_scope.settled_checkpoint
              and ${this.platformKey ?? ""} = any(impact.provider_platform_keys)
            else obligation.cause_sequence > canonical."canonicalSettledWatermark"
          end
      ), alerts as (
        select count(*)::integer as "activeAlertCount",
               count(*) filter (
                 where admin_alert.dedupe_key = ${this.#failureDedupeKey}
               )::integer as "activeFailureAlertCount",
               max(latest_event.evidence_json ->> 'attemptId') filter (
                 where admin_alert.dedupe_key = ${this.#failureDedupeKey}
               ) as "activeFailureAttemptId"
        from public.admin_alerts admin_alert
        left join public.operational_events latest_event
          on latest_event.id = admin_alert.latest_event_id
         and latest_event.organization_id = admin_alert.organization_id
        where admin_alert.organization_id = cast(${this.#organizationId} as uuid)
          and admin_alert.recovery_key = ${this.#recoveryKey}
          and admin_alert.state <> 'resolved'::public.admin_alert_state
      )
      select
        alerts."activeAlertCount",
        alerts."activeFailureAlertCount",
        alerts."activeFailureAttemptId",
        case ${this.lane}
          when 'provider' then coalesce(provider.settled_checkpoint, 0)
          when 'manifest' then coalesce(manifest.requested_evaluation_sequence, 0)
          else canonical."canonicalSettledWatermark"
        end::bigint as "canonicalSettledWatermark",
        case ${this.lane}
          when 'provider' then provider.settled_at
          when 'manifest' then manifest.requested_at
          else canonical."canonicalSettledAt"
        end as "canonicalSettledAt",
        case ${this.lane}
          when 'provider' then coalesce(provider.source_head_checkpoint, 0)
          when 'manifest' then coalesce(manifest.requested_evaluation_sequence, 0)
          else canonical."canonicalSourceHeadWatermark"
        end::bigint as "canonicalSourceHeadWatermark",
        case ${this.lane}
          when 'provider' then coalesce(provider.completed_checkpoint, 0)
          when 'manifest' then coalesce(manifest.confirmed_evaluation_sequence, 0)
          else coalesce(heat.confirmed_watermark, 0)
        end::bigint as "confirmedWatermark",
        case ${this.lane}
          when 'provider' then coalesce(provider.settled_checkpoint, 0)
          when 'manifest' then coalesce(manifest.requested_evaluation_sequence, 0)
          else coalesce(heat.settled_watermark, 0)
        end::bigint as "laneTargetWatermark",
        case ${this.lane}
          when 'provider' then provider.settled_at
          when 'manifest' then manifest.requested_at
          else heat.settled_at
        end as "laneTargetAt",
        failure.id::text as "latestFailedAttemptId",
        failure.target_watermark as "latestFailedWatermark",
        failure.failure_code as "latestFailureCode",
        technical."technicalFailureCount"
      from canonical
      cross join technical
      cross join alerts
      left join public.provider_promotion_lanes provider
        on ${this.lane === "provider"}
       and provider.organization_id = cast(${this.#organizationId} as uuid)
       and provider.deployment_key = ${this.#deploymentKey}
       and provider.platform_key = ${this.platformKey ?? ""}
      left join public.manifest_promotion_lanes manifest
        on ${this.lane === "manifest"}
       and manifest.organization_id = cast(${this.#organizationId} as uuid)
       and manifest.deployment_key = ${this.#deploymentKey}
      left join public.promotion_lanes heat
        on ${this.lane === "heat"}
       and heat.organization_id = cast(${this.#organizationId} as uuid)
       and heat.deployment_key = ${this.#deploymentKey}
       and heat.lane_key = 'heat'
      left join lateral (
        select candidate.id, candidate.target_watermark,
               candidate.failure_code
        from (
          select attempt.id, attempt.target_checkpoint as target_watermark,
                 attempt.failure_code, attempt.terminal_at
          from public.provider_promotion_attempts attempt
          where ${this.lane === "provider"}
            and attempt.organization_id = cast(${this.#organizationId} as uuid)
            and attempt.deployment_key = ${this.#deploymentKey}
            and attempt.platform_key = ${this.platformKey ?? ""}
            and attempt.state in ('failed', 'cas_lost')
          union all
          select attempt.id, attempt.evaluation_sequence as target_watermark,
                 attempt.failure_code, attempt.terminal_at
          from public.manifest_promotion_attempts attempt
          where ${this.lane === "manifest"}
            and attempt.organization_id = cast(${this.#organizationId} as uuid)
            and attempt.deployment_key = ${this.#deploymentKey}
            and attempt.state in ('failed', 'cas_lost')
          union all
          select attempt.id, attempt.target_watermark,
                 attempt.failure_code, attempt.terminal_at
          from public.promotion_attempts attempt
          where ${this.lane === "heat"}
            and attempt.organization_id = cast(${this.#organizationId} as uuid)
            and attempt.deployment_key = ${this.#deploymentKey}
            and attempt.lane_key = 'heat'
            and attempt.state = 'failed'
        ) candidate
        order by candidate.terminal_at desc nulls last, candidate.id desc
        limit 1
      ) failure on true
    `);
    return rows[0] ?? {
      activeAlertCount: 0,
      activeFailureAlertCount: 0,
      activeFailureAttemptId: null,
      canonicalSettledWatermark: 0n,
      canonicalSettledAt: null,
      canonicalSourceHeadWatermark: 0n,
      confirmedWatermark: 0n,
      laneTargetWatermark: 0n,
      laneTargetAt: null,
      latestFailedAttemptId: null,
      latestFailedWatermark: null,
      latestFailureCode: null,
      technicalFailureCount: 0,
    };
  }
}
