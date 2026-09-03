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
  MachineryAlertObserver,
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

/**
 * One bounded, non-personal line about the alert cycle's own health. It names
 * the failed capability and counts — never a workspace identifier, an upstream
 * message, or any of the evidence the cycle was reading.
 */
export interface MachineryAlertReport {
  readonly event:
    | "admin_machinery_alert_cycle_degraded"
    | "admin_machinery_alert_workspace_unreadable";
  readonly organizations?: number;
  readonly failedOrganizations?: number;
  readonly failedPublications?: number;
}

function logMachineryAlertReport(report: MachineryAlertReport): void {
  console.error(JSON.stringify({ level: "error", ...report }));
}

/**
 * What the admin says out loud about its own alerting.
 *
 * Machinery alerting that publishes nothing because the evidence behind it
 * cannot be read looks exactly like a healthy pipeline from the outside. So a
 * cycle that could not evaluate everything reports itself, and a workspace that
 * could not be read reports itself even though the other workspaces keep their
 * alerting.
 *
 * A healthy cycle says nothing at all: at a one-minute cadence a line per cycle
 * is half a million log lines a year, which is exactly how the one line that
 * matters gets buried.
 */
export function createAdminMachineryAlertObserver(
  report: (line: MachineryAlertReport) => void = logMachineryAlertReport,
): MachineryAlertObserver {
  return {
    cycleCompleted(result) {
      if (result.failedOrganizations === 0 && result.failedPublications === 0) {
        return;
      }
      report({
        event: "admin_machinery_alert_cycle_degraded",
        organizations: result.organizations,
        failedOrganizations: result.failedOrganizations,
        failedPublications: result.failedPublications,
      });
    },
    organizationFailed() {
      report({ event: "admin_machinery_alert_workspace_unreadable" });
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
 * Runs one cycle at a time on a fixed cadence.
 *
 * The next cycle is timed from the end of the previous one rather than by a
 * repeating interval, so a slow cycle genuinely delays the next instead of
 * letting ticks queue behind it. A cycle that outlasts several intervals
 * therefore costs one delayed cycle, not a growing backlog of callbacks and a
 * burst of back-to-back cycles reading the same evidence afterwards.
 *
 * The timer is unreferenced so it can never hold the process open during
 * shutdown, and stopping drains the cycle in flight.
 */
export function startMachineryAlertLoop(
  input: MachineryAlertLoopInput,
): MachineryAlertLoop {
  if (!Number.isInteger(input.intervalMs) || input.intervalMs < 1_000) {
    throw new RangeError("Machinery alert cadence is outside its bounds.");
  }
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (!running) return;
    timer = setTimeout(run, input.intervalMs);
    timer.unref?.();
  };

  function run(): void {
    if (!running) return;
    pending = (async () => {
      try {
        await input.cycle();
      } catch (error) {
        try {
          input.onFailure?.(error);
        } catch {
          // Alerting never depends on failure reporting.
        }
      }
      schedule();
    })();
  }

  schedule();
  return {
    async stop(): Promise<void> {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      await pending;
    },
  };
}
