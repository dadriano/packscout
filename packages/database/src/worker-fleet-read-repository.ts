import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "./database.ts";

/**
 * Read-only access to the durable evidence the admin's worker-fleet view and
 * the pipeline's alerting both judge the machinery by: the import runs a worker
 * currently holds, and every active provider's schedule position.
 *
 * Every predicate here is a durable fact — a run's state, a workspace, a keyset
 * position. No staleness or overdue threshold is expressed in SQL, because those
 * conditions belong to the shared server-side evaluations that the view and
 * alerting must agree on; this repository only bounds the evidence they read.
 */

export type WorkerFleetRunTrigger = "scheduled" | "manual" | "recovery";

export interface RunningImportRunRecord {
  readonly runId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly platformKey: string;
  readonly trigger: WorkerFleetRunTrigger;
  readonly state: "running";
  readonly startedAt: Date | null;
  readonly heartbeatAt: Date | null;
  /** Worker instance identity holding the run, matching worker presence. */
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
}

/**
 * One active provider's schedule position, plus whatever claim history a worker
 * has written for it. A provider that has never been claimed still has a
 * position — the schedule row is only the record of claims, never the record of
 * being scheduled.
 */
export interface ProviderScheduleRecord {
  readonly providerId: string;
  readonly providerName: string;
  readonly platformKey: string;
  readonly nextDueAt: Date;
  /** Worker instance identity holding the claim, matching worker presence. */
  readonly claimOwner: string | null;
  readonly claimExpiresAt: Date | null;
  readonly lastClaimedAt: Date | null;
  readonly lastOutcome: string | null;
  readonly lastRunId: string | null;
}

/** Keyset position: the sort timestamp plus the tie-breaking identity. */
export interface WorkerFleetCursor {
  readonly at: Date;
  readonly id: string;
}

export interface WorkerFleetPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
}

interface RunRow {
  readonly run_id: string;
  readonly provider_id: string;
  readonly provider_name: string;
  readonly platform_key: string;
  readonly trigger: WorkerFleetRunTrigger;
  readonly started_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly last_signal_at: Date | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
}

interface ScheduleRow {
  readonly provider_id: string;
  readonly provider_name: string;
  readonly platform_key: string;
  readonly next_due_at: Date;
  readonly claim_owner: string | null;
  readonly claim_expires_at: Date | null;
  readonly last_claimed_at: Date | null;
  readonly last_outcome: string | null;
  readonly last_run_id: string | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Matches the largest bounded scan any fleet condition evaluation reads. */
const MAXIMUM_LIMIT = 200;

function assertIdentity(...values: readonly string[]): void {
  for (const value of values) {
    if (!uuidPattern.test(value)) {
      throw new RangeError("Worker fleet identity is invalid.");
    }
  }
}

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_LIMIT) {
    throw new RangeError("Worker fleet page limit is invalid.");
  }
  return limit;
}

function assertCursor(cursor: WorkerFleetCursor | undefined): void {
  if (cursor === undefined) return;
  assertIdentity(cursor.id);
  if (!Number.isFinite(cursor.at.getTime())) {
    throw new RangeError("Worker fleet cursor is invalid.");
  }
}

export class PrismaWorkerFleetReadRepository {
  constructor(private readonly database: PackscoutPrismaClient) {}

  /**
   * Import runs a worker currently holds, oldest signal first, so the runs most
   * likely to be stalled arrive on the first page. The run's own heartbeat is
   * the sort key, falling back to its start for a run that never beat.
   */
  async listRunningRuns(input: {
    readonly organizationId: string;
    readonly limit: number;
    readonly before?: WorkerFleetCursor;
  }): Promise<WorkerFleetPage<RunningImportRunRecord>> {
    assertIdentity(input.organizationId);
    const limit = assertLimit(input.limit);
    assertCursor(input.before);
    const signal = Prisma.sql`coalesce(runs.heartbeat_at, runs.started_at, runs.created_at)`;
    const keyset = input.before
      ? Prisma.sql`
          and (
            ${signal} > ${input.before.at}
            or (${signal} = ${input.before.at}
                and runs.id > cast(${input.before.id} as uuid))
          )
        `
      : Prisma.empty;
    const rows = await this.database.$queryRaw<RunRow[]>(Prisma.sql`
      select
        runs.id as run_id,
        runs.provider_id as provider_id,
        sources.display_name as provider_name,
        sources.platform_key as platform_key,
        runs.trigger as trigger,
        runs.started_at as started_at,
        runs.heartbeat_at as heartbeat_at,
        ${signal} as last_signal_at,
        runs.lease_owner as lease_owner,
        runs.lease_expires_at as lease_expires_at
      from import_runs runs
      join provider_sources sources on sources.id = runs.provider_id
      where runs.organization_id = cast(${input.organizationId} as uuid)
        and runs.state = 'running'::import_run_state
        ${keyset}
      order by ${signal} asc, runs.id asc
      limit ${limit + 1}
    `);
    return {
      items: rows.slice(0, limit).map((row) => ({
        runId: row.run_id,
        providerId: row.provider_id,
        providerName: row.provider_name,
        platformKey: row.platform_key,
        trigger: row.trigger,
        state: "running" as const,
        startedAt: row.started_at,
        heartbeatAt: row.heartbeat_at,
        leaseOwner: row.lease_owner,
        leaseExpiresAt: row.lease_expires_at,
      })),
      hasMore: rows.length > limit,
    };
  }

  /**
   * Every scheduled provider's position, soonest due first, so the schedules
   * furthest past due lead the first page.
   *
   * The evidence is anchored on the active source and its current revision —
   * the same rows the scheduler claims from — because that is what "is this
   * provider scheduled?" means. `provider_schedules` is claim history: it does
   * not exist until a worker first claims, and it is not cleared when a
   * provider is disabled or archived. Anchoring here instead would hide a
   * newly enabled provider no worker ever reached (exactly the outage worth
   * alerting on) and keep reporting a disabled one forever.
   */
  async listSchedules(input: {
    readonly organizationId: string;
    readonly limit: number;
    readonly before?: WorkerFleetCursor;
  }): Promise<WorkerFleetPage<ProviderScheduleRecord>> {
    assertIdentity(input.organizationId);
    const limit = assertLimit(input.limit);
    assertCursor(input.before);
    const keyset = input.before
      ? Prisma.sql`
          and (
            sources.next_run_at > ${input.before.at}
            or (sources.next_run_at = ${input.before.at}
                and sources.id > cast(${input.before.id} as uuid))
          )
        `
      : Prisma.empty;
    const rows = await this.database.$queryRaw<ScheduleRow[]>(Prisma.sql`
      select
        sources.id as provider_id,
        sources.display_name as provider_name,
        sources.platform_key as platform_key,
        sources.next_run_at as next_due_at,
        schedules.claim_owner as claim_owner,
        schedules.claim_expires_at as claim_expires_at,
        schedules.last_claimed_at as last_claimed_at,
        schedules.last_outcome as last_outcome,
        schedules.last_run_id as last_run_id
      from provider_sources sources
      join provider_config_revisions revisions
        on revisions.id = sources.active_revision_id
       and revisions.organization_id = sources.organization_id
       and revisions.provider_id = sources.id
      left join provider_schedules schedules
        on schedules.provider_id = sources.id
       and schedules.organization_id = sources.organization_id
      where sources.organization_id = cast(${input.organizationId} as uuid)
        and sources.state = 'active'::provider_state
        and sources.next_run_at is not null
        ${keyset}
      order by sources.next_run_at asc, sources.id asc
      limit ${limit + 1}
    `);
    return {
      items: rows.slice(0, limit).map((row) => ({
        providerId: row.provider_id,
        providerName: row.provider_name,
        platformKey: row.platform_key,
        nextDueAt: row.next_due_at,
        claimOwner: row.claim_owner,
        claimExpiresAt: row.claim_expires_at,
        lastClaimedAt: row.last_claimed_at,
        lastOutcome: row.last_outcome,
        lastRunId: row.last_run_id,
      })),
      hasMore: rows.length > limit,
    };
  }
}
