import type { PromotionJobScheduleLifecycle } from "@packscout/database";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface PromotionJobEvaluatorWatchdogEvidence {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly evaluatorEpoch: bigint;
  readonly cadenceSeconds: number;
  readonly baselineAt: Date | null;
  readonly lastSuccessfulWindowIndex: bigint | null;
  readonly lastSuccessfulEvaluationAt: Date | null;
  readonly evaluatedThrough: Date | null;
  readonly rosterDigest: string | null;
  readonly expectedCount: number | null;
  readonly reachableCount: number | null;
  readonly unavailableCount: number | null;
}

export type PromotionJobEvaluatorWatchdogHealth =
  | "inactive"
  | "healthy"
  | "overdue"
  | "alerting";

export interface PromotionJobEvaluatorWatchdogJudgment {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly health: PromotionJobEvaluatorWatchdogHealth;
  readonly evaluatorEpoch: bigint;
  readonly latestCountableWindowIndex: bigint;
  readonly lastSuccessfulWindowIndex: bigint;
  readonly missedWindowCount: bigint;
  readonly evaluatedAt: Date;
  readonly lastSuccessfulEvaluationAt: Date | null;
  readonly evaluatedThrough: Date | null;
  readonly rosterDigest: string | null;
  readonly expectedCount: number | null;
  readonly reachableCount: number | null;
  readonly unavailableCount: number | null;
}

/** The entire least-privilege response available to an external detector. */
export interface PromotionJobEvaluatorWatchdogResponse {
  readonly lifecycle: PromotionJobScheduleLifecycle;
  readonly health: PromotionJobEvaluatorWatchdogHealth;
  readonly evaluatorEpoch: string;
  readonly missedWindowCount: string;
  readonly evaluatedAt: string;
  readonly lastSuccessfulEvaluationAt: string | null;
  readonly evaluatedThrough: string | null;
  readonly rosterDigest: string | null;
  readonly expectedCount: number | null;
  readonly reachableCount: number | null;
  readonly unavailableCount: number | null;
}

export class PromotionJobEvaluatorWatchdogError extends Error {
  readonly code = "PROMOTION_JOB_EVALUATOR_EVIDENCE_INVALID";

  constructor() {
    super("Promotion job evaluator watchdog evidence is invalid.");
    this.name = "PromotionJobEvaluatorWatchdogError";
  }
}

function invalid(): never {
  throw new PromotionJobEvaluatorWatchdogError();
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function assertCounts(
  evidence: PromotionJobEvaluatorWatchdogEvidence,
): void {
  const counts = [
    evidence.expectedCount,
    evidence.reachableCount,
    evidence.unavailableCount,
  ];
  if (counts.every((value) => value === null)) return;
  if (
    counts.some((value) => value === null
      || !Number.isInteger(value) || value < 0)
    || evidence.expectedCount! < 1
    || evidence.reachableCount! + evidence.unavailableCount!
      !== evidence.expectedCount
  ) invalid();
}

function assertEvidence(
  evidence: PromotionJobEvaluatorWatchdogEvidence,
): void {
  if (evidence.evaluatorEpoch < 0n || evidence.cadenceSeconds !== 60) invalid();
  assertCounts(evidence);
  const successFields = [
    evidence.lastSuccessfulEvaluationAt,
    evidence.evaluatedThrough,
    evidence.rosterDigest,
    evidence.expectedCount,
  ];
  if (
    successFields.some((value) => value === null)
      !== successFields.every((value) => value === null)
  ) invalid();
  if (
    evidence.lastSuccessfulEvaluationAt !== null
    && (!validDate(evidence.lastSuccessfulEvaluationAt)
      || !validDate(evidence.evaluatedThrough!)
      || !SHA256_PATTERN.test(evidence.rosterDigest!))
  ) invalid();
  if (evidence.lifecycle === "pending_activation") {
    if (
      evidence.evaluatorEpoch !== 0n
      || evidence.baselineAt !== null
      || evidence.lastSuccessfulWindowIndex !== null
      || successFields.some((value) => value !== null)
    ) invalid();
    return;
  }
  if (
    evidence.evaluatorEpoch < 1n
    || evidence.baselineAt === null
    || !validDate(evidence.baselineAt)
    || evidence.lastSuccessfulWindowIndex === null
    || evidence.lastSuccessfulWindowIndex < 0n
  ) invalid();
  // The detector is armed only after one complete evaluator cycle. A paused
  // detector keeps that last successful evidence but accrues no new misses.
  if (successFields.some((value) => value === null)) invalid();
}

/**
 * Uses the same strict due boundary as promotion schedules. At the exact due
 * instant the window is not missed; it becomes countable one millisecond later.
 */
export function evaluatePromotionJobEvaluatorWatchdog(
  evidence: PromotionJobEvaluatorWatchdogEvidence,
  evaluatedAt: Date,
): PromotionJobEvaluatorWatchdogJudgment {
  if (!validDate(evaluatedAt)) invalid();
  assertEvidence(evidence);
  if (evidence.lifecycle !== "active") {
    return {
      lifecycle: evidence.lifecycle,
      health: "inactive",
      evaluatorEpoch: evidence.evaluatorEpoch,
      latestCountableWindowIndex: 0n,
      lastSuccessfulWindowIndex: evidence.lastSuccessfulWindowIndex ?? 0n,
      missedWindowCount: 0n,
      evaluatedAt: new Date(evaluatedAt),
      lastSuccessfulEvaluationAt: evidence.lastSuccessfulEvaluationAt,
      evaluatedThrough: evidence.evaluatedThrough,
      rosterDigest: evidence.rosterDigest,
      expectedCount: evidence.expectedCount,
      reachableCount: evidence.reachableCount,
      unavailableCount: evidence.unavailableCount,
    };
  }
  const elapsedMilliseconds = evaluatedAt.getTime()
    - evidence.baselineAt!.getTime();
  const latestCountableWindowIndex = elapsedMilliseconds <= 0
    ? 0n
    : (BigInt(elapsedMilliseconds) - 1n) / 60_000n;
  const lastSuccessfulWindowIndex = evidence.lastSuccessfulWindowIndex!;
  const missedWindowCount = latestCountableWindowIndex
    > lastSuccessfulWindowIndex
    ? latestCountableWindowIndex - lastSuccessfulWindowIndex
    : 0n;
  return {
    lifecycle: evidence.lifecycle,
    health: missedWindowCount >= 3n
      ? "alerting"
      : missedWindowCount === 2n
        ? "overdue"
        : "healthy",
    evaluatorEpoch: evidence.evaluatorEpoch,
    latestCountableWindowIndex,
    lastSuccessfulWindowIndex,
    missedWindowCount,
    evaluatedAt: new Date(evaluatedAt),
    lastSuccessfulEvaluationAt: evidence.lastSuccessfulEvaluationAt,
    evaluatedThrough: evidence.evaluatedThrough,
    rosterDigest: evidence.rosterDigest,
    expectedCount: evidence.expectedCount,
    reachableCount: evidence.reachableCount,
    unavailableCount: evidence.unavailableCount,
  };
}

export function promotionJobEvaluatorWatchdogResponse(
  judgment: PromotionJobEvaluatorWatchdogJudgment,
): PromotionJobEvaluatorWatchdogResponse {
  return {
    lifecycle: judgment.lifecycle,
    health: judgment.health,
    evaluatorEpoch: judgment.evaluatorEpoch.toString(),
    missedWindowCount: judgment.missedWindowCount.toString(),
    evaluatedAt: judgment.evaluatedAt.toISOString(),
    lastSuccessfulEvaluationAt:
      judgment.lastSuccessfulEvaluationAt?.toISOString() ?? null,
    evaluatedThrough: judgment.evaluatedThrough?.toISOString() ?? null,
    rosterDigest: judgment.rosterDigest,
    expectedCount: judgment.expectedCount,
    reachableCount: judgment.reachableCount,
    unavailableCount: judgment.unavailableCount,
  };
}
