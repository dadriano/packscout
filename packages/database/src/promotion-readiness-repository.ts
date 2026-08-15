import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";

export interface PersistedPromotionReadinessDiagnostic {
  readonly activeAlertCount: number;
  readonly activeFailureAlertCount: number;
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

/** Loads only allowlisted lane and settlement health for one server-bound scope. */
export class PrismaPromotionReadinessRepository {
  readonly #deploymentKey: string;
  readonly #lane: "catalog" | "heat";
  readonly #organizationId: string;

  constructor(
    private readonly database: PackscoutPrismaClient,
    scope: {
      organizationId: string;
      deploymentKey: string;
      lane: "catalog" | "heat";
    },
  ) {
    if (
      !uuidPattern.test(scope.organizationId) ||
      !deploymentKeyPattern.test(scope.deploymentKey)
    ) {
      throw new RangeError("Promotion readiness scope is invalid.");
    }
    this.#organizationId = scope.organizationId.toLowerCase();
    this.#deploymentKey = scope.deploymentKey;
    this.#lane = scope.lane;
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
      ), technical as (
        select count(*)::integer as "technicalFailureCount"
        from public.public_derivation_obligations obligation
        cross join canonical
        where obligation.organization_id = cast(${this.#organizationId} as uuid)
          and obligation.cause_sequence > canonical."canonicalSettledWatermark"
          and obligation.state = 'technical_failure'::public.public_derivation_state
      ), alerts as (
        select count(*)::integer as "activeAlertCount",
               count(*) filter (
                 where dedupe_key = ${`promotion:${this.#lane}:failed`}
               )::integer as "activeFailureAlertCount"
        from public.admin_alerts
        where organization_id = cast(${this.#organizationId} as uuid)
          and recovery_key = ${`promotion:${this.#lane}:health`}
          and state <> 'resolved'::public.admin_alert_state
      )
      select
        alerts."activeAlertCount",
        alerts."activeFailureAlertCount",
        canonical."canonicalSettledWatermark",
        canonical."canonicalSettledAt",
        canonical."canonicalSourceHeadWatermark",
        coalesce(lane.confirmed_watermark, 0)::bigint
          as "confirmedWatermark",
        coalesce(lane.settled_watermark, 0)::bigint
          as "laneTargetWatermark",
        lane.settled_at as "laneTargetAt",
        failure.id::text as "latestFailedAttemptId",
        failure.target_watermark as "latestFailedWatermark",
        failure.failure_code as "latestFailureCode",
        technical."technicalFailureCount"
      from canonical
      cross join technical
      cross join alerts
      left join public.promotion_lanes lane
        on lane.organization_id = cast(${this.#organizationId} as uuid)
       and lane.deployment_key = ${this.#deploymentKey}
       and lane.lane_key = ${this.#lane}
      left join lateral (
        select attempt.id, attempt.target_watermark, attempt.failure_code
        from public.promotion_attempts attempt
        where attempt.organization_id = cast(${this.#organizationId} as uuid)
          and attempt.deployment_key = ${this.#deploymentKey}
          and attempt.lane_key = ${this.#lane}
          and attempt.state = 'failed'
        order by attempt.terminal_at desc nulls last, attempt.id desc
        limit 1
      ) failure on true
    `);
    return rows[0] ?? {
      activeAlertCount: 0,
      activeFailureAlertCount: 0,
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
