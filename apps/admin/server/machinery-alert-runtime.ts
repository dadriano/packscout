/**
 * Where the machinery conditions are actually evaluated.
 *
 * The pipeline's other periodic work lives inside the worker, which cannot host
 * this: the most dangerous condition is that no worker is alive, and a detector
 * that dies with the fleet reports nothing. The admin server is always on
 * whenever an operator could be looking, so the cycle runs here — reading the
 * same durable evidence and the same shared evaluations the admin's monitoring
 * pages render, and publishing through the existing operational event path
 * rather than a second alerting mechanism.
 *
 * Every cycle is bounded (a capped set of workspaces, capped scans inside each)
 * and best-effort: a failed cycle is logged and the next one runs on schedule.
 */

import {
  PrismaBackgroundWorkRepository,
  PrismaMachineryAlertReadRepository,
  PrismaWorkerFleetReadRepository,
  PrismaWorkerPresenceRepository,
} from "@packscout/database";
import {
  evaluateMachineryConditions,
  evaluateRecomputationBacklog,
  evaluateRetentionCadence,
  isScheduleWedged,
  WORKER_FLEET_SCAN_LIMIT,
  type MachineryConditionFacts,
  type MachineryRunStallFact,
  type MachineryScheduleFact,
  type RetentionExecutionSummary,
} from "@packscout/contracts";
import type {
  MachineryAlertFacts,
  MachineryAlertFactsSource,
} from "@packscout/services";
import {
  evaluateFleetFrom,
  evaluateRunStallFor,
  readWorkerFleetSnapshot,
  resolveLiveTimelinessMs,
  toScheduleHealthView,
} from "./machinery-derivations.ts";

type MachineryDatabase = ConstructorParameters<
  typeof PrismaMachineryAlertReadRepository
>[0];

export interface AdminMachineryAlertRuntimeInput {
  readonly database: MachineryDatabase;
  /** Queue depth a workspace may owe before depth alone counts as a backlog. */
  readonly backlogDepthLimit: number | null;
  /** Workspaces one cycle evaluates. */
  readonly organizationLimit?: number;
  readonly clock?: { now(): Date };
}

const DEFAULT_ORGANIZATION_LIMIT = 50;

/**
 * The retention cadence evaluation reads the same execution summary the
 * background-work page shows, so an overdue badge and an overdue alert are the
 * same judgement about the same execution.
 */
function toRetentionSummary(record: {
  state: RetentionExecutionSummary["state"];
  startedAt: Date;
  finishedAt: Date | null;
  remaining: number;
}): Pick<
  RetentionExecutionSummary,
  "state" | "startedAt" | "finishedAt" | "remaining"
> {
  return {
    state: record.state,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
    remaining: record.remaining,
  };
}

export function createAdminMachineryAlertFactsSource(
  input: AdminMachineryAlertRuntimeInput,
): MachineryAlertFactsSource {
  const clock = input.clock ?? { now: () => new Date() };
  const presence = new PrismaWorkerPresenceRepository(input.database);
  const fleet = new PrismaWorkerFleetReadRepository(input.database);
  const backgroundWork = new PrismaBackgroundWorkRepository(input.database);
  const alerts = new PrismaMachineryAlertReadRepository(input.database);
  const organizationLimit =
    input.organizationLimit ?? DEFAULT_ORGANIZATION_LIMIT;

  async function readConditionFacts(
    organizationId: string,
    now: Date,
    retentionFailureActive: boolean,
  ): Promise<MachineryConditionFacts> {
    const [snapshot, runs, schedules, queue, latestRetention] =
      await Promise.all([
        readWorkerFleetSnapshot(presence, WORKER_FLEET_SCAN_LIMIT),
        fleet.listRunningRuns({ organizationId, limit: WORKER_FLEET_SCAN_LIMIT }),
        fleet.listSchedules({ organizationId, limit: WORKER_FLEET_SCAN_LIMIT }),
        backgroundWork.aggregateRecomputations({ organizationId, now }),
        backgroundWork.latestRetentionExecution({ organizationId }),
      ]);
    const published = snapshot.settings.settings;
    const stalledRuns: MachineryRunStallFact[] = [];
    for (const record of runs.items) {
      const stall = evaluateRunStallFor(
        record,
        published?.runHeartbeatStaleAfterMs ?? null,
        now,
      );
      if (stall === null) continue;
      stalledRuns.push({
        runId: record.runId,
        providerId: record.providerId,
        stall,
      });
    }
    const scheduleFacts: MachineryScheduleFact[] = schedules.items.map(
      (record) => ({
        providerId: record.providerId,
        health: toScheduleHealthView(
          record,
          published?.presenceStaleAfterMs ?? null,
          now,
          snapshot.identities,
        ).health,
      }),
    );
    const timelyAfterMs = resolveLiveTimelinessMs(snapshot.records, now);
    return {
      fleet: evaluateFleetFrom({
        records: snapshot.records,
        now,
        stalledRuns: stalledRuns.length,
        wedgedSchedules: scheduleFacts.filter((schedule) =>
          isScheduleWedged(schedule.health),
        ).length,
      }),
      fleetStaleAfterMs: published?.presenceStaleAfterMs ?? null,
      stalledRuns,
      schedules: scheduleFacts,
      backlog: evaluateRecomputationBacklog({
        now: now.toISOString(),
        pending: queue.pending,
        readyPending: queue.readyPending,
        claimed: queue.claimed,
        expiredClaims: queue.expiredClaims,
        failed: queue.failed,
        oldestPendingAvailableAt:
          queue.oldestPendingAvailableAt?.toISOString() ?? null,
        timelyAfterMs,
        depthLimit: input.backlogDepthLimit,
      }),
      retention: evaluateRetentionCadence({
        now: now.toISOString(),
        expectedIntervalMs: timelyAfterMs,
        latest: latestRetention ? toRetentionSummary(latestRetention) : null,
      }),
      retentionFailureActive,
    };
  }

  return {
    listOrganizations() {
      return alerts.listOrganizations({ limit: organizationLimit });
    },
    async readFacts(organizationId: string): Promise<MachineryAlertFacts> {
      const now = clock.now();
      const open = await alerts.readOpenAlerts({
        organizationId,
        limit: WORKER_FLEET_SCAN_LIMIT,
      });
      const facts = await readConditionFacts(
        organizationId,
        now,
        open.retentionFailureActive,
      );
      return {
        conditions: evaluateMachineryConditions(facts),
        openAlerts: open.alerts,
      };
    },
  };
}

export interface MachineryAlertLoop {
  stop(): Promise<void>;
}

export interface MachineryAlertLoopInput {
  readonly cycle: () => Promise<unknown>;
  readonly intervalMs: number;
  readonly onFailure?: (error: unknown) => void;
}

/**
 * Runs one cycle at a time on a fixed cadence. Cycles never overlap — a slow
 * cycle delays the next one instead of stacking — and the timer is unreferenced
 * so it can never hold the process open during shutdown.
 */
export function startMachineryAlertLoop(
  input: MachineryAlertLoopInput,
): MachineryAlertLoop {
  if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1_000) {
    throw new RangeError("Machinery alert cadence is outside its bounds.");
  }
  let running = true;
  let pending: Promise<void> = Promise.resolve();
  const run = () => {
    if (!running) return;
    pending = pending.then(async () => {
      if (!running) return;
      try {
        await input.cycle();
      } catch (error) {
        try {
          input.onFailure?.(error);
        } catch {
          // Alerting never depends on failure reporting.
        }
      }
    });
  };
  const timer = setInterval(run, input.intervalMs);
  timer.unref?.();
  return {
    async stop(): Promise<void> {
      running = false;
      clearInterval(timer);
      await pending;
    },
  };
}
