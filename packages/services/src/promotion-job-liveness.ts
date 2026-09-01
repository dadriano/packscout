import type {
  PromotionJobSchedule,
  PromotionJobScheduleLifecycle,
} from "@packscout/database";

export type PromotionJobScheduleHealth =
  | "inactive"
  | "healthy"
  | "overdue"
  | "alerting";

export interface PromotionJobScheduleLiveness {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly scheduleEpoch: bigint;
  readonly health: PromotionJobScheduleHealth;
  readonly latestCountableWindowIndex: bigint;
  readonly lastAdmittedWindowIndex: bigint;
  readonly missedWindowCount: bigint;
  readonly lastScheduledCheckinAt: Date | null;
  readonly evaluatedAt: Date;
}

export interface PromotionJobScheduleConditionAnchor {
  readonly scheduleEpoch: bigint;
  readonly lastScheduledCheckinAt: Date | null;
}

export type PromotionJobScheduleObservation =
  | Readonly<{
      evidenceSource: "live" | "last_known";
      judgment: PromotionJobScheduleLiveness;
    }>
  | Readonly<{
      evidenceSource: "unavailable";
      judgment: PromotionJobScheduleLiveness | null;
    }>;

export interface PromotionJobLivenessCycleSummary {
  readonly expectedCount: number;
  readonly reachableCount: number;
  readonly unavailableCount: number;
  readonly healthyCount: number;
  readonly overdueCount: number;
  readonly alertingCount: number;
}

export class PromotionJobLivenessError extends Error {
  constructor(readonly code: "PROMOTION_JOB_SCHEDULE_EVIDENCE_INVALID") {
    super("Promotion job schedule evidence is invalid.");
    this.name = "PromotionJobLivenessError";
  }
}

function invalid(): never {
  throw new PromotionJobLivenessError(
    "PROMOTION_JOB_SCHEDULE_EVIDENCE_INVALID",
  );
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function inactiveJudgment(
  schedule: PromotionJobSchedule,
  evaluatedAt: Date,
): PromotionJobScheduleLiveness {
  return {
    lifecycle: schedule.lifecycle,
    scheduleEpoch: schedule.scheduleEpoch,
    health: "inactive",
    latestCountableWindowIndex: 0n,
    lastAdmittedWindowIndex: schedule.lastAdmittedWindowIndex ?? 0n,
    missedWindowCount: 0n,
    lastScheduledCheckinAt: schedule.lastScheduledCheckinAt,
    evaluatedAt,
  };
}

/**
 * Counts only schedule windows whose due instant is strictly before the
 * evaluator instant. Window indexes start at one; the baseline itself is not a
 * due window.
 */
export function evaluatePromotionJobScheduleLiveness(
  schedule: PromotionJobSchedule,
  evaluatedAt: Date,
): PromotionJobScheduleLiveness {
  if (!validDate(evaluatedAt) || schedule.scheduleEpoch < 0n) invalid();
  if (schedule.lifecycle !== "active") {
    return inactiveJudgment(schedule, new Date(evaluatedAt));
  }
  const baselineAt = schedule.baselineAt;
  if (
    schedule.scheduleEpoch < 1n || baselineAt === null ||
    !validDate(baselineAt) || schedule.cadenceSeconds !== 60 ||
    (schedule.lastAdmittedWindowIndex ?? 0n) < 0n ||
    (schedule.lastScheduledCheckinAt !== null &&
      !validDate(schedule.lastScheduledCheckinAt))
  ) invalid();

  const elapsedMilliseconds = evaluatedAt.getTime() - baselineAt.getTime();
  const cadenceMilliseconds = BigInt(schedule.cadenceSeconds * 1_000);
  const latestCountableWindowIndex = elapsedMilliseconds <= 0
    ? 0n
    : (BigInt(elapsedMilliseconds) - 1n) / cadenceMilliseconds;
  const lastAdmittedWindowIndex = schedule.lastAdmittedWindowIndex ?? 0n;
  const missedWindowCount = latestCountableWindowIndex > lastAdmittedWindowIndex
    ? latestCountableWindowIndex - lastAdmittedWindowIndex
    : 0n;
  const health = missedWindowCount >= 3n
    ? "alerting"
    : missedWindowCount === 2n
      ? "overdue"
      : "healthy";
  return {
    lifecycle: schedule.lifecycle,
    scheduleEpoch: schedule.scheduleEpoch,
    health,
    latestCountableWindowIndex,
    lastAdmittedWindowIndex,
    missedWindowCount,
    lastScheduledCheckinAt: schedule.lastScheduledCheckinAt,
    evaluatedAt: new Date(evaluatedAt),
  };
}

/** Reachability alone never recovers an alert: recovery needs trusted progress. */
export function canRecoverPromotionJobScheduleCondition(
  anchor: PromotionJobScheduleConditionAnchor,
  observation: PromotionJobScheduleObservation,
): boolean {
  if (observation.evidenceSource !== "live" || observation.judgment === null) {
    return false;
  }
  const current = observation.judgment;
  if (current.scheduleEpoch < anchor.scheduleEpoch) return false;
  if (current.lifecycle === "paused") return true;
  if (current.scheduleEpoch > anchor.scheduleEpoch) return true;
  if (current.lifecycle !== "active" || current.health !== "healthy") {
    return false;
  }
  if (current.lastScheduledCheckinAt === null) return false;
  return anchor.lastScheduledCheckinAt === null ||
    current.lastScheduledCheckinAt.getTime() >
      anchor.lastScheduledCheckinAt.getTime();
}

/** Summarizes a dynamic provider roster plus the one central manifest row. */
export function summarizePromotionJobLivenessCycle(input: Readonly<{
  providerObservations: readonly PromotionJobScheduleObservation[];
  manifestObservation: PromotionJobScheduleObservation;
}>): PromotionJobLivenessCycleSummary {
  const observations = [
    ...input.providerObservations,
    input.manifestObservation,
  ];
  let unavailableCount = 0;
  let healthyCount = 0;
  let overdueCount = 0;
  let alertingCount = 0;
  for (const observation of observations) {
    if (observation.evidenceSource === "unavailable") {
      unavailableCount += 1;
      continue;
    }
    switch (observation.judgment.health) {
      case "inactive":
      case "healthy":
        healthyCount += 1;
        break;
      case "overdue":
        overdueCount += 1;
        break;
      case "alerting":
        alertingCount += 1;
        break;
    }
  }
  return {
    expectedCount: observations.length,
    reachableCount: observations.length - unavailableCount,
    unavailableCount,
    healthyCount,
    overdueCount,
    alertingCount,
  };
}
