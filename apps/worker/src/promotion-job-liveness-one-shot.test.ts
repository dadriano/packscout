import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromotionJobLivenessConditionDelivery,
} from "@packscout/database";
import type {
  SuccessfulPromotionJobLivenessCycle,
} from "@packscout/services";
import {
  PromotionJobLivenessOneShot,
  type PromotionJobLivenessConditionStorePort,
} from "./promotion-job-liveness-one-shot.ts";

const base = new Date("2026-09-01T12:03:00.001Z");
const organizationId = "10000000-0000-4000-8000-000000000001";
const providerId = "20000000-0000-4000-8000-000000000001";

function cycle(): SuccessfulPromotionJobLivenessCycle {
  const judgment = {
    lifecycle: "active" as const,
    scheduleEpoch: 1n,
    health: "healthy" as const,
    latestCountableWindowIndex: 3n,
    lastAdmittedWindowIndex: 3n,
    missedWindowCount: 0n,
    lastScheduledCheckinAt: new Date("2026-09-01T12:03:00.000Z"),
    evaluatedAt: base,
  };
  return {
    evaluatedAt: base,
    roster: {
      rosterVersion: 7n,
      rosterHighWater: 8n,
      rosterDigest: "a".repeat(64),
      capturedAt: new Date("2026-09-01T12:03:00.000Z"),
      providers: [{
        organizationId,
        providerId,
        providerKey: "provider_one",
      }],
    },
    providerObservations: [{
      provider: { organizationId, providerId, providerKey: "provider_one" },
      observedAt: base,
      failureCode: null,
      observation: { evidenceSource: "live", judgment },
    }],
    manifestObservation: { observedAt: base, judgment },
    summary: {
      expectedCount: 2,
      reachableCount: 2,
      unavailableCount: 0,
      healthyCount: 2,
      overdueCount: 0,
      alertingCount: 0,
    },
  };
}

function delivery(
  overrides: Partial<PromotionJobLivenessConditionDelivery> = {},
): PromotionJobLivenessConditionDelivery {
  return {
    conditionId: "30000000-0000-4000-8000-000000000001",
    eventId: "40000000-0000-4000-8000-000000000001",
    action: "raise",
    scope: "provider",
    subject: "provider_schedule",
    organizationId,
    providerId,
    scheduleEpoch: 1n,
    missedWindowCount: 3n,
    anchorLastScheduledCheckinAt: null,
    evaluatedAt: base,
    attemptCount: 0,
    ...overrides,
  };
}

function store(input: Readonly<{
  deliveries?: readonly PromotionJobLivenessConditionDelivery[];
  failList?: boolean;
  failRecord?: boolean;
  order?: string[];
}> = {}) {
  const recorded: Parameters<
    PromotionJobLivenessConditionStorePort["recordConditionDeliveryResult"]
  >[0][] = [];
  const attempts: Parameters<
    PromotionJobLivenessConditionStorePort["recordConditionDeliveryAttempt"]
  >[0][] = [];
  const implementation: PromotionJobLivenessConditionStorePort = {
    listPendingConditionDeliveries({ limit }) {
      input.order?.push("list");
      if (input.failList) return Promise.reject(new Error("central offline"));
      return Promise.resolve((input.deliveries ?? [delivery()]).slice(0, limit));
    },
    recordConditionDeliveryAttempt(attempt) {
      input.order?.push("attempt");
      attempts.push(attempt);
      return Promise.resolve(true);
    },
    recordConditionDeliveryResult(result) {
      input.order?.push("record");
      if (input.failRecord) return Promise.reject(new Error("ack lost"));
      recorded.push(result);
      return Promise.resolve(true);
    },
  };
  return { implementation, attempts, recorded };
}

test("durable evaluation precedes bounded alert delivery and failures only schedule retry", async () => {
  const order: string[] = [];
  const conditions = store({ order });
  let clocks = 0;
  const oneShot = new PromotionJobLivenessOneShot({
    evaluator: {
      runCycle() {
        order.push("commit");
        return Promise.resolve(cycle());
      },
    },
    conditions: conditions.implementation,
    publisher: {
      publish() {
        order.push("publish");
        return Promise.resolve({
          state: "retryable_failure",
          failureCode: "SYSTEM_SINK_OFFLINE",
        });
      },
    },
    now: () => new Date(base.getTime() + clocks++),
  });
  const result = await oneShot.run();
  assert.deepEqual(order, ["commit", "list", "attempt", "publish", "record"]);
  assert.deepEqual(result.delivery, {
    state: "complete",
    selectedCount: 1,
    deliveredCount: 0,
    retryScheduledCount: 1,
    acknowledgementFailureCount: 0,
  });
  assert.equal(conditions.recorded[0]?.result.state, "retry_wait");
  if (conditions.recorded[0]?.result.state !== "retry_wait") return;
  assert.equal(conditions.recorded[0].result.failureCode, "SYSTEM_SINK_OFFLINE");
  assert.equal(
    conditions.recorded[0].result.retryAt.getTime(),
    base.getTime() + 1 + 60_000,
  );
});

test("lost delivery acknowledgement remains retryable without failing liveness", async () => {
  const conditions = store({ failRecord: true });
  const result = await new PromotionJobLivenessOneShot({
    evaluator: { runCycle: () => Promise.resolve(cycle()) },
    conditions: conditions.implementation,
    publisher: { publish: () => Promise.resolve({ state: "delivered" }) },
    now: () => base,
  }).run();
  assert.equal(result.delivery.acknowledgementFailureCount, 1);
  assert.equal(result.delivery.deliveredCount, 0);
  assert.equal(result.cycle.summary.expectedCount, 2);
});

test("an evaluator failure still retries a previously durable condition", async () => {
  const conditions = store();
  let published = 0;
  const failure = new Error("registry unavailable");
  const oneShot = new PromotionJobLivenessOneShot({
    evaluator: { runCycle: () => Promise.reject(failure) },
    conditions: conditions.implementation,
    publisher: {
      publish() {
        published += 1;
        return Promise.resolve({ state: "delivered" });
      },
    },
    now: () => base,
  });
  await assert.rejects(oneShot.run(), (error) => error === failure);
  assert.equal(published, 1);
  assert.equal(conditions.recorded[0]?.result.state, "delivered");
});

test("condition-store outage does not roll back a successful evaluation", async () => {
  const result = await new PromotionJobLivenessOneShot({
    evaluator: { runCycle: () => Promise.resolve(cycle()) },
    conditions: store({ failList: true }).implementation,
    publisher: {
      publish: () => Promise.reject(new Error("must not be called")),
    },
    now: () => base,
  }).run();
  assert.deepEqual(result.delivery, {
    state: "store_unavailable",
    selectedCount: 0,
    deliveredCount: 0,
    retryScheduledCount: 0,
    acknowledgementFailureCount: 0,
  });
});

test("one delivery deadline prevents a failed sink backlog from overrunning the evaluator cadence", async () => {
  const deliveries = Array.from({ length: 50 }, () => delivery());
  const conditions = store({ deliveries });
  let deadlineClock = 0;
  let publishCount = 0;
  const result = await new PromotionJobLivenessOneShot({
    evaluator: { runCycle: () => Promise.resolve(cycle()) },
    conditions: conditions.implementation,
    publisher: {
      publish(_delivery, { deadlineAt }) {
        publishCount += 1;
        assert.equal(deadlineAt, 10_000);
        deadlineClock = deadlineAt;
        return Promise.resolve({
          state: "retryable_failure",
          failureCode: "SYSTEM_SINK_OFFLINE",
        });
      },
    },
    deliveryBudgetMs: 10_000,
    deadlineNow: () => deadlineClock,
    now: () => base,
  }).run();

  assert.equal(result.delivery.selectedCount, 50);
  assert.equal(result.delivery.retryScheduledCount, 1);
  assert.equal(publishCount, 1);
  assert.equal(conditions.attempts.length, 1);
  assert.equal(conditions.recorded.length, 1);
});
