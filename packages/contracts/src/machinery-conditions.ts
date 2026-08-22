/**
 * The alertable machinery conditions.
 *
 * Nothing here decides whether a condition holds. Every verdict arrives already
 * made by the evaluations the admin's monitoring views render —
 * `evaluateWorkerFleet`, `evaluateRunStall`, `evaluateScheduleHealth`,
 * `evaluateRecomputationBacklog`, and `evaluateRetentionCadence` — and this
 * module only names the condition, quotes the measure against the threshold
 * that was crossed, and produces the stable keys the alert lifecycle groups by.
 * A page and an alert therefore cannot disagree about a silent fleet, a stalled
 * run, a wedged schedule, a backed-up queue, or lapsed retention.
 */

import type {
  RecomputationBacklogEvaluation,
  RetentionCadenceEvaluation,
} from "./background-work.ts";
import {
  isScheduleWedged,
  type RunStallEvaluation,
  type ScheduleHealthEvaluation,
  type WorkerFleetEvaluation,
} from "./worker-fleet.ts";

export const machineryConditionKinds = [
  "worker_fleet_silent",
  "import_run_stalled",
  "provider_schedule_overdue",
  "recomputation_backlogged",
  "retention_overdue",
] as const;

export type MachineryConditionKind = (typeof machineryConditionKinds)[number];

/** Stable codes naming the observed state, safe to store as alert evidence. */
export type MachineryOutcomeCode =
  | "WORKER_FLEET_SILENT"
  | "WORKER_FLEET_NEVER_REPORTED"
  | "IMPORT_RUN_STALLED"
  | "PROVIDER_SCHEDULE_OVERDUE"
  | "PROVIDER_SCHEDULE_CLAIM_EXPIRED"
  | "RECOMPUTATION_BACKLOGGED"
  | "RETENTION_OVERDUE";

/** Stable codes naming which threshold the observation crossed. */
export type MachineryThresholdCode =
  | "FLEET_PRESENCE_WINDOW"
  | "RUN_HEARTBEAT_WINDOW"
  | "SCHEDULE_OVERDUE_TOLERANCE"
  | "SCHEDULE_CLAIM_EXPIRY"
  | "BACKLOG_EXPIRED_CLAIMS"
  | "BACKLOG_FAILED_ENTRIES"
  | "BACKLOG_QUEUE_DEPTH"
  | "BACKLOG_OLDEST_PENDING_AGE"
  | "RETENTION_EXPECTED_INTERVAL";

/**
 * One condition that currently holds. `observedMs` and `observedCount` are the
 * measures an operator sees, and either is `null` whenever nothing honest can
 * be measured — a fleet that never reported has no silence duration, and no
 * invented one is ever substituted.
 */
export interface MachineryCondition {
  readonly kind: MachineryConditionKind;
  /** Groups every occurrence of this persisting condition onto one alert. */
  readonly dedupeKey: string;
  /** Closes that alert when the condition clears. */
  readonly recoveryKey: string;
  readonly providerId: string | null;
  readonly runId: string | null;
  readonly outcome: MachineryOutcomeCode;
  readonly threshold: MachineryThresholdCode | null;
  readonly observedMs: number | null;
  readonly thresholdMs: number | null;
  readonly observedCount: number | null;
  readonly thresholdCount: number | null;
}

export interface MachineryRunStallFact {
  readonly runId: string;
  readonly providerId: string;
  readonly stall: RunStallEvaluation;
}

export interface MachineryScheduleFact {
  readonly providerId: string;
  readonly health: ScheduleHealthEvaluation;
}

export interface MachineryConditionFacts {
  /** `evaluateWorkerFleet`'s verdict for the whole fleet. */
  readonly fleet: WorkerFleetEvaluation;
  /** The presence window the fleet published, `null` when nothing has. */
  readonly fleetStaleAfterMs: number | null;
  /** Runs `isImportRunStalled` already judged stalled, with their measures. */
  readonly stalledRuns: readonly MachineryRunStallFact[];
  /** Every schedule the view evaluated; only wedged ones become conditions. */
  readonly schedules: readonly MachineryScheduleFact[];
  readonly backlog: RecomputationBacklogEvaluation;
  readonly retention: RetentionCadenceEvaluation;
  /**
   * Whether a retention *failure* alert is already open. Retention failures
   * have raised their own alert since the pipeline shipped; an execution that
   * failed is not additionally reported as one that stopped running.
   */
  readonly retentionFailureActive: boolean;
}

/** Bounds every condition list so one evaluation stays a bounded unit of work. */
export const MACHINERY_CONDITIONS_PER_KIND_LIMIT = 25;

/** Queue depth a workspace may owe before depth alone counts as a backlog. */
export const RECOMPUTATION_BACKLOG_DEPTH_DEFAULT = 100;

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function fleetCondition(
  facts: MachineryConditionFacts,
): MachineryCondition | null {
  const { fleet } = facts;
  if (fleet.state !== "silent" && fleet.state !== "never_reported") return null;
  const neverReported = fleet.state === "never_reported";
  return {
    kind: "worker_fleet_silent",
    dedupeKey: "worker-fleet:silent",
    recoveryKey: "worker-fleet:health",
    providerId: null,
    runId: null,
    outcome: neverReported
      ? "WORKER_FLEET_NEVER_REPORTED"
      : "WORKER_FLEET_SILENT",
    // Nothing published a window when nothing ever reported, so the condition
    // names no threshold rather than one it cannot have crossed.
    threshold: neverReported ? null : "FLEET_PRESENCE_WINDOW",
    observedMs: neverReported ? null : positive(fleet.silentForMs),
    thresholdMs: neverReported ? null : positive(facts.fleetStaleAfterMs),
    observedCount: fleet.observed,
    thresholdCount: null,
  };
}

function runConditions(
  facts: MachineryConditionFacts,
): readonly MachineryCondition[] {
  return facts.stalledRuns
    .filter((run) => run.stall.stalled)
    .slice(0, MACHINERY_CONDITIONS_PER_KIND_LIMIT)
    .map((run) => ({
      kind: "import_run_stalled" as const,
      dedupeKey: `import-run:stalled:${run.runId}`,
      recoveryKey: `import-run:health:${run.runId}`,
      providerId: run.providerId,
      runId: run.runId,
      outcome: "IMPORT_RUN_STALLED" as const,
      threshold: "RUN_HEARTBEAT_WINDOW" as const,
      observedMs: positive(run.stall.heartbeatAgeMs),
      thresholdMs: positive(run.stall.staleAfterMs),
      observedCount: null,
      thresholdCount: null,
    }));
}

function scheduleConditions(
  facts: MachineryConditionFacts,
): readonly MachineryCondition[] {
  return facts.schedules
    .filter((schedule) => isScheduleWedged(schedule.health))
    .slice(0, MACHINERY_CONDITIONS_PER_KIND_LIMIT)
    .map((schedule) => {
      const expired = schedule.health.state === "claim_expired";
      return {
        kind: "provider_schedule_overdue" as const,
        dedupeKey: `provider-schedule:overdue:${schedule.providerId}`,
        recoveryKey: `provider-schedule:health:${schedule.providerId}`,
        providerId: schedule.providerId,
        runId: null,
        outcome: expired
          ? ("PROVIDER_SCHEDULE_CLAIM_EXPIRED" as const)
          : ("PROVIDER_SCHEDULE_OVERDUE" as const),
        threshold: expired
          ? ("SCHEDULE_CLAIM_EXPIRY" as const)
          : ("SCHEDULE_OVERDUE_TOLERANCE" as const),
        observedMs: positive(schedule.health.overdueByMs),
        thresholdMs: positive(schedule.health.overdueAfterMs),
        observedCount: null,
        thresholdCount: null,
      };
    });
}

/**
 * Which backlog threshold the queue crossed. Stuck work outranks slow work: an
 * expired claim or a failed entry needs an operator, while depth and age only
 * need workers that keep up.
 */
function backlogThreshold(
  backlog: RecomputationBacklogEvaluation,
): MachineryThresholdCode {
  if (backlog.expiredClaims > 0) return "BACKLOG_EXPIRED_CLAIMS";
  if (backlog.failed > 0) return "BACKLOG_FAILED_ENTRIES";
  if (backlog.depthLimit !== null && backlog.depth > backlog.depthLimit) {
    return "BACKLOG_QUEUE_DEPTH";
  }
  return "BACKLOG_OLDEST_PENDING_AGE";
}

function backlogCondition(
  facts: MachineryConditionFacts,
): MachineryCondition | null {
  const { backlog } = facts;
  if (backlog.state !== "backlogged") return null;
  const threshold = backlogThreshold(backlog);
  const byDepth =
    threshold === "BACKLOG_QUEUE_DEPTH" ||
    threshold === "BACKLOG_EXPIRED_CLAIMS" ||
    threshold === "BACKLOG_FAILED_ENTRIES";
  return {
    kind: "recomputation_backlogged",
    dedupeKey: "recomputation:backlogged",
    recoveryKey: "recomputation:health",
    providerId: null,
    runId: null,
    outcome: "RECOMPUTATION_BACKLOGGED",
    threshold,
    observedMs: byDepth ? null : positive(backlog.oldestPendingAgeMs),
    thresholdMs: byDepth ? null : positive(backlog.timelyAfterMs),
    observedCount: backlog.depth,
    thresholdCount: byDepth ? positive(backlog.depthLimit) : null,
  };
}

function retentionCondition(
  facts: MachineryConditionFacts,
): MachineryCondition | null {
  const { retention } = facts;
  if (retention.state !== "overdue" || facts.retentionFailureActive) return null;
  return {
    kind: "retention_overdue",
    dedupeKey: "retention-cadence:overdue",
    recoveryKey: "retention-cadence:health",
    providerId: null,
    runId: null,
    outcome: "RETENTION_OVERDUE",
    threshold: "RETENTION_EXPECTED_INTERVAL",
    observedMs: positive(retention.sinceLastStartMs),
    thresholdMs: positive(retention.expectedIntervalMs),
    observedCount: positive(retention.knownRemaining),
    thresholdCount: null,
  };
}

/**
 * Every machinery condition that currently holds, in the order an operator
 * should read them: a dead fleet first, because it explains the rest.
 */
export function evaluateMachineryConditions(
  facts: MachineryConditionFacts,
): readonly MachineryCondition[] {
  const fleet = fleetCondition(facts);
  const backlog = backlogCondition(facts);
  const retention = retentionCondition(facts);
  return [
    ...(fleet ? [fleet] : []),
    ...runConditions(facts),
    ...scheduleConditions(facts),
    ...(backlog ? [backlog] : []),
    ...(retention ? [retention] : []),
  ];
}
