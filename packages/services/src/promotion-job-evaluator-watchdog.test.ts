import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePromotionJobEvaluatorWatchdog,
  promotionJobEvaluatorWatchdogResponse,
  type PromotionJobEvaluatorWatchdogEvidence,
} from "./promotion-job-evaluator-watchdog.ts";

function evidence(
  overrides: Partial<PromotionJobEvaluatorWatchdogEvidence> = {},
): PromotionJobEvaluatorWatchdogEvidence {
  return {
    lifecycle: "active",
    evaluatorEpoch: 1n,
    cadenceSeconds: 60,
    baselineAt: new Date("2026-09-01T12:00:00.000Z"),
    lastSuccessfulWindowIndex: 0n,
    lastSuccessfulEvaluationAt: new Date("2026-09-01T12:00:00.000Z"),
    evaluatedThrough: new Date("2026-09-01T12:00:00.000Z"),
    rosterDigest: "a".repeat(64),
    expectedCount: 4,
    reachableCount: 3,
    unavailableCount: 1,
    ...overrides,
  };
}

test("external evaluator detector uses strict one, two, three window boundaries", () => {
  const one = evaluatePromotionJobEvaluatorWatchdog(
    evidence(),
    new Date("2026-09-01T12:02:00.000Z"),
  );
  const two = evaluatePromotionJobEvaluatorWatchdog(
    evidence(),
    new Date("2026-09-01T12:02:00.001Z"),
  );
  const three = evaluatePromotionJobEvaluatorWatchdog(
    evidence(),
    new Date("2026-09-01T12:03:00.001Z"),
  );
  assert.deepEqual(
    [one.missedWindowCount, one.health, two.missedWindowCount, two.health,
      three.missedWindowCount, three.health],
    [1n, "healthy", 2n, "overdue", 3n, "alerting"],
  );
});

test("pending and paused watchdogs are inactive and never accrue misses", () => {
  const pending = evaluatePromotionJobEvaluatorWatchdog({
    lifecycle: "pending_activation",
    evaluatorEpoch: 0n,
    cadenceSeconds: 60,
    baselineAt: null,
    lastSuccessfulWindowIndex: null,
    lastSuccessfulEvaluationAt: null,
    evaluatedThrough: null,
    rosterDigest: null,
    expectedCount: null,
    reachableCount: null,
    unavailableCount: null,
  }, new Date("2026-09-02T12:00:00.000Z"));
  const paused = evaluatePromotionJobEvaluatorWatchdog(evidence({
    lifecycle: "paused",
  }), new Date("2026-09-02T12:00:00.000Z"));
  assert.deepEqual(
    [pending.health, pending.missedWindowCount, paused.health,
      paused.missedWindowCount],
    ["inactive", 0n, "inactive", 0n],
  );
});

test("watchdog response contains only lifecycle timing counts and digest", () => {
  const response = promotionJobEvaluatorWatchdogResponse(
    evaluatePromotionJobEvaluatorWatchdog(
      evidence(),
      new Date("2026-09-01T12:03:00.001Z"),
    ),
  );
  assert.deepEqual(Object.keys(response).sort(), [
    "evaluatedAt",
    "evaluatedThrough",
    "evaluatorEpoch",
    "expectedCount",
    "health",
    "lastSuccessfulEvaluationAt",
    "lifecycle",
    "missedWindowCount",
    "reachableCount",
    "rosterDigest",
    "unavailableCount",
  ]);
  const serialized = JSON.stringify(response);
  for (const protectedToken of [
    "providerId",
    "providerKey",
    "organization",
    "deployment",
    "database",
    "credential",
    "route",
    "invocation",
    "receipt",
    "payload",
  ]) assert.equal(serialized.includes(protectedToken), false, protectedToken);
});

test("watchdog refuses impossible success counts", () => {
  assert.throws(() => evaluatePromotionJobEvaluatorWatchdog(evidence({
    expectedCount: 4,
    reachableCount: 4,
    unavailableCount: 1,
  }), new Date("2026-09-01T12:03:00.001Z")), {
    code: "PROMOTION_JOB_EVALUATOR_EVIDENCE_INVALID",
  });
});
