/**
 * The single composition of the pipeline's machinery conditions from durable
 * evidence.
 *
 * The fleet page, the background-work page, and the alert cycle all read these
 * functions, so a stalled run, a wedged schedule, a silent fleet, and a backed
 * up queue are decided once. Every threshold still comes from what the fleet
 * published — per-instance staleness through `classifyWorkerPresence`, run
 * heartbeats through `isImportRunStalled`, schedule tolerance and background
 * timeliness through the resolved presence window — and every verdict is the
 * shared evaluation in `@packscout/contracts`. Nothing here invents a rule.
 */

import type {
  PrismaWorkerPresenceRepository,
  ProviderScheduleRecord,
  RunningImportRunRecord,
  WorkerPresenceRecord,
} from "@packscout/database";
import {
  evaluateRunStall,
  evaluateScheduleHealth,
  evaluateWorkerFleet,
  resolveBackgroundWorkTimelinessMs,
  resolveWorkerFleetSettings,
  WORKER_FLEET_SCAN_LIMIT,
  type RunStallEvaluation,
  type ScheduleHealthView,
  type StalledRunView,
  type WorkerFleetEvaluation,
  type WorkerFleetSettingsResolution,
} from "@packscout/contracts";
import { classifyWorkerPresence, isImportRunStalled, workerPresenceAgeMs } from "@packscout/services";

export interface WorkerFleetSnapshot {
  readonly records: readonly WorkerPresenceRecord[];
  readonly settings: WorkerFleetSettingsResolution;
  /** Identities still retained, so a departed lease holder reads as departed. */
  readonly identities: ReadonlySet<string>;
}

/**
 * Every retained presence record, with the settings the fleet published. The
 * settings come from all retained records rather than only live ones, so a
 * fleet that has just died still says what "stale" meant while it was alive.
 */
export async function readWorkerFleetSnapshot(
  presence: Pick<PrismaWorkerPresenceRepository, "listInstances">,
  limit: number = WORKER_FLEET_SCAN_LIMIT,
): Promise<WorkerFleetSnapshot> {
  const records = await presence.listInstances({ limit });
  return {
    records,
    settings: resolveWorkerFleetSettings(
      records.map((record) => record.effectiveSettings),
    ),
    identities: new Set(records.map((record) => record.instanceId)),
  };
}

/**
 * The timeliness window for background work, taken only from instances that are
 * currently live: a stopped or stale instance no longer speaks for the fleet,
 * and an absent fleet is a worker problem rather than a backlog one.
 */
export function resolveLiveTimelinessMs(
  records: readonly WorkerPresenceRecord[],
  now: Date,
): number | null {
  return resolveBackgroundWorkTimelinessMs(
    records
      .filter((record) => classifyWorkerPresence(record, now) === "running")
      .map((record) => record.effectiveSettings),
  );
}

function lastSignalOf(record: RunningImportRunRecord): Date | null {
  return record.heartbeatAt ?? record.startedAt;
}

/**
 * A run counts as stalled only when `isImportRunStalled` says so against the
 * window the fleet published. Without published settings nothing says what
 * "stalled" means, so no run is accused of it and `null` is returned.
 */
export function evaluateRunStallFor(
  record: RunningImportRunRecord,
  staleAfterMs: number | null,
  now: Date,
): RunStallEvaluation | null {
  if (staleAfterMs === null) return null;
  const stalled = isImportRunStalled(
    {
      state: record.state,
      heartbeatAt: record.heartbeatAt,
      startedAt: record.startedAt,
    },
    { runHeartbeatStaleAfterMs: staleAfterMs },
    now,
  );
  if (!stalled) return null;
  return evaluateRunStall({
    now: now.toISOString(),
    stalled,
    lastSignalAt: lastSignalOf(record)?.toISOString() ?? null,
    staleAfterMs,
  });
}

export function toStalledRunView(
  record: RunningImportRunRecord,
  stall: RunStallEvaluation,
  now: Date,
  identities: ReadonlySet<string>,
): StalledRunView {
  return {
    runId: record.runId,
    providerId: record.providerId,
    providerName: record.providerName,
    platformKey: record.platformKey,
    trigger: record.trigger,
    startedAt: record.startedAt?.toISOString() ?? null,
    lastHeartbeatAt: record.heartbeatAt?.toISOString() ?? null,
    stall,
    leaseOwner: record.leaseOwner,
    leaseOwnerPresent:
      record.leaseOwner !== null && identities.has(record.leaseOwner),
    leaseExpiresAt: record.leaseExpiresAt?.toISOString() ?? null,
    leaseExpired:
      record.leaseExpiresAt !== null &&
      record.leaseExpiresAt.getTime() <= now.getTime(),
  };
}

export function toScheduleHealthView(
  record: ProviderScheduleRecord,
  overdueAfterMs: number | null,
  now: Date,
  identities: ReadonlySet<string>,
): ScheduleHealthView {
  return {
    providerId: record.providerId,
    providerName: record.providerName,
    platformKey: record.platformKey,
    nextDueAt: record.nextDueAt.toISOString(),
    health: evaluateScheduleHealth({
      now: now.toISOString(),
      nextDueAt: record.nextDueAt.toISOString(),
      claimOwner: record.claimOwner,
      claimExpiresAt: record.claimExpiresAt?.toISOString() ?? null,
      lastClaimedAt: record.lastClaimedAt?.toISOString() ?? null,
      overdueAfterMs,
    }),
    claimOwner: record.claimOwner,
    claimOwnerPresent:
      record.claimOwner !== null && identities.has(record.claimOwner),
    claimExpiresAt: record.claimExpiresAt?.toISOString() ?? null,
    lastClaimedAt: record.lastClaimedAt?.toISOString() ?? null,
    lastOutcome: record.lastOutcome,
    lastRunId: record.lastRunId,
  };
}

/** The fleet-level verdict, counting the impairments observed alongside it. */
export function evaluateFleetFrom(input: {
  readonly records: readonly WorkerPresenceRecord[];
  readonly now: Date;
  readonly stalledRuns: number;
  readonly wedgedSchedules: number;
}): WorkerFleetEvaluation {
  return evaluateWorkerFleet({
    now: input.now.toISOString(),
    instances: input.records.map((record) => ({
      status: classifyWorkerPresence(record, input.now),
      heartbeatAgeMs: workerPresenceAgeMs(record, input.now),
    })),
    stalledRuns: input.stalledRuns,
    wedgedSchedules: input.wedgedSchedules,
  });
}
