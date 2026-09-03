import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromotionJobEvaluatorWatchdogEvidenceRecord,
} from "@packscout/database";
import {
  PromotionJobEvaluatorWatchdogBoundary,
} from "./promotion-job-evaluator-watchdog-composition.ts";

const baselineAt = new Date("2026-09-01T12:00:00.000Z");
const successAt = new Date("2026-09-01T12:00:00.000Z");

function evidence(
  overrides: Partial<PromotionJobEvaluatorWatchdogEvidenceRecord> = {},
): PromotionJobEvaluatorWatchdogEvidenceRecord {
  return {
    lifecycle: "active",
    evaluatorEpoch: 1n,
    cadenceSeconds: 60,
    baselineAt,
    lastSuccessfulWindowIndex: 0n,
    lastSuccessfulEvaluationAt: successAt,
    evaluatedThrough: successAt,
    rosterDigest: "a".repeat(64),
    expectedCount: 3,
    reachableCount: 3,
    unavailableCount: 0,
    ...overrides,
  };
}

function boundary(
  record: PromotionJobEvaluatorWatchdogEvidenceRecord,
  now: Date,
): PromotionJobEvaluatorWatchdogBoundary {
  return new PromotionJobEvaluatorWatchdogBoundary({
    async readWatchdogEvidence() {
      return record;
    },
  }, { now: () => now });
}

test("read-only watchdog distinguishes strict healthy overdue and alerting windows", async () => {
  const healthy = await boundary(
    evidence(),
    new Date("2026-09-01T12:02:00.000Z"),
  ).inspect();
  const overdue = await boundary(
    evidence(),
    new Date("2026-09-01T12:02:00.001Z"),
  ).inspect();
  const alerting = await boundary(
    evidence(),
    new Date("2026-09-01T12:03:00.001Z"),
  ).inspect();

  assert.deepEqual([
    healthy.health,
    healthy.missedWindowCount,
    overdue.health,
    overdue.missedWindowCount,
    alerting.health,
    alerting.missedWindowCount,
  ], ["healthy", "1", "overdue", "2", "alerting", "3"]);
});

test("pending and paused watchdogs stay separately visible and inactive", async () => {
  const pending = await boundary({
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
  }, new Date("2026-09-02T12:00:00.000Z")).inspect();
  const paused = await boundary(
    evidence({ lifecycle: "paused" }),
    new Date("2026-09-02T12:00:00.000Z"),
  ).inspect();

  assert.deepEqual(
    [pending.lifecycle, pending.health, paused.lifecycle, paused.health],
    ["pending_activation", "inactive", "paused", "inactive"],
  );
});

test("watchdog projection contains no provider tenant route or mutation detail", async () => {
  let reads = 0;
  const detector = new PromotionJobEvaluatorWatchdogBoundary({
    async readWatchdogEvidence() {
      reads += 1;
      return evidence({ reachableCount: 2, unavailableCount: 1 });
    },
  }, { now: () => new Date("2026-09-01T12:01:00.001Z") });

  const response = await detector.inspect();
  assert.equal(reads, 1);
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
  const serialized = JSON.stringify(response).toLowerCase();
  for (const protectedToken of [
    "organization",
    "providerid",
    "providerkey",
    "tenant",
    "database",
    "route",
    "invocation",
    "operation",
    "request",
    "receipt",
    "credential",
    "secret",
    "token",
    "mutation",
  ]) assert.equal(serialized.includes(protectedToken), false, protectedToken);
});
