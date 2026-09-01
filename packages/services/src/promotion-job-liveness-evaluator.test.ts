import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromotionJobSchedule,
  ProviderDatabaseOperationResult,
} from "@packscout/database";
import {
  PromotionJobLivenessCycleError,
  PromotionJobLivenessEvaluator,
  type PromotionJobLivenessCycleFailureCode,
  type PromotionJobLivenessRosterEntry,
  type PromotionJobLivenessRosterSnapshot,
  type SuccessfulPromotionJobLivenessCycle,
} from "./promotion-job-liveness-evaluator.ts";

const evaluatedAt = new Date("2026-09-01T12:03:00.001Z");
const organizationId = "10000000-0000-4000-8000-000000000001";
const providerIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
];

function schedule(
  authority: PromotionJobSchedule["authority"],
  admitted = 3n,
): PromotionJobSchedule {
  return {
    authority,
    lifecycle: "active",
    scheduleEpoch: 1n,
    cadenceSeconds: 60,
    baselineAt: new Date("2026-09-01T12:00:00.000Z"),
    activatedAt: new Date("2026-09-01T12:00:00.000Z"),
    pausedAt: null,
    lastAdmittedWindowIndex: admitted,
    lastScheduledCheckinAt: admitted === 0n
      ? null
      : new Date(`2026-09-01T12:0${Number(admitted)}:00.000Z`),
    nextExpectedCheckinAt: new Date("2026-09-01T12:04:00.000Z"),
  };
}

function provider(index: number): PromotionJobLivenessRosterEntry {
  return {
    organizationId,
    providerId: providerIds[index]!,
    providerKey: `provider_${index + 1}`,
  };
}

function roster(count: number): PromotionJobLivenessRosterSnapshot {
  return {
    rosterVersion: 7n,
    rosterHighWater: 11n,
    rosterDigest: "a".repeat(64),
    capturedAt: new Date("2026-09-01T12:02:59.000Z"),
    providers: Array.from({ length: count }, (_, index) => provider(index)),
  };
}

function reachable(
  entry: PromotionJobLivenessRosterEntry,
  admitted = 3n,
): ProviderDatabaseOperationResult<PromotionJobSchedule> {
  return {
    state: "reachable",
    providerId: entry.providerId,
    value: schedule("provider_publication", admitted),
    observedAt: "2026-09-01T12:03:00.000Z",
  };
}

function harness(input: Readonly<{
  roster?: () => Promise<PromotionJobLivenessRosterSnapshot>;
  provider?: (
    entry: PromotionJobLivenessRosterEntry,
  ) => Promise<ProviderDatabaseOperationResult<PromotionJobSchedule>>;
  failCommit?: boolean;
}> = {}) {
  const successful: SuccessfulPromotionJobLivenessCycle[] = [];
  const failed: PromotionJobLivenessCycleFailureCode[] = [];
  const evaluator = new PromotionJobLivenessEvaluator({
    roster: {
      captureEligibleRoster: input.roster ?? (() => Promise.resolve(roster(2))),
    },
    providers: {
      readSchedule: input.provider ?? ((entry) => Promise.resolve(reachable(entry))),
    },
    manifest: {
      readSchedule: () => Promise.resolve({
        schedule: schedule("manifest_reconciliation"),
        observedAt: new Date("2026-09-01T12:03:00.000Z"),
      }),
    },
    store: {
      commitSuccessfulCycle: (cycle) => {
        if (input.failCommit) return Promise.reject(new Error("offline"));
        successful.push(cycle);
        return Promise.resolve();
      },
      recordFailedCycle: ({ failureCode }) => {
        failed.push(failureCode);
        return Promise.resolve();
      },
    },
    providerConcurrency: 2,
    now: () => evaluatedAt,
  });
  return { evaluator, successful, failed };
}

test("zero eligible providers still evaluates the one central manifest job", async () => {
  const context = harness({ roster: () => Promise.resolve(roster(0)) });
  const cycle = await context.evaluator.runCycle();
  assert.deepEqual(cycle.summary, {
    expectedCount: 1,
    reachableCount: 1,
    unavailableCount: 0,
    healthyCount: 1,
    overdueCount: 0,
    alertingCount: 0,
  });
  assert.equal(context.successful.length, 1);
  assert.deepEqual(context.failed, []);
});

test("one provider outage is retained as one unavailable row", async () => {
  const context = harness({
    provider: (entry) => entry.providerId === providerIds[1]
      ? Promise.reject(new Error("timeout"))
      : Promise.resolve(reachable(entry, 0n)),
  });
  const cycle = await context.evaluator.runCycle();
  assert.deepEqual(cycle.summary, {
    expectedCount: 3,
    reachableCount: 2,
    unavailableCount: 1,
    healthyCount: 1,
    overdueCount: 0,
    alertingCount: 1,
  });
  assert.equal(cycle.providerObservations[0]?.observation.evidenceSource, "live");
  assert.equal(
    cycle.providerObservations[1]?.observation.evidenceSource,
    "unavailable",
  );
  assert.equal(
    cycle.providerObservations[1]?.failureCode,
    "database_unreachable",
  );
});

test("provider reads are bounded without changing roster order", async () => {
  let inFlight = 0;
  let maximumInFlight = 0;
  const context = harness({
    roster: () => Promise.resolve(roster(3)),
    provider: async (entry) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return reachable(entry);
    },
  });
  const cycle = await context.evaluator.runCycle();
  assert.equal(maximumInFlight, 2);
  assert.deepEqual(
    cycle.providerObservations.map(({ provider: row }) => row.providerKey),
    ["provider_1", "provider_2", "provider_3"],
  );
});

test("registry failure marks the cycle unsuccessful instead of reporting zero", async () => {
  const context = harness({
    roster: () => Promise.reject(new Error("registry offline")),
  });
  await assert.rejects(
    context.evaluator.runCycle(),
    (error: unknown) => error instanceof PromotionJobLivenessCycleError
      && error.code === "registry_enumeration_failed",
  );
  assert.deepEqual(context.failed, ["registry_enumeration_failed"]);
  assert.equal(context.successful.length, 0);
});

test("persistence failure marks prior judgments stale and rejects the cycle", async () => {
  const context = harness({ failCommit: true });
  await assert.rejects(
    context.evaluator.runCycle(),
    (error: unknown) => error instanceof PromotionJobLivenessCycleError
      && error.code === "cycle_persistence_failed",
  );
  assert.deepEqual(context.failed, ["cycle_persistence_failed"]);
  assert.equal(context.successful.length, 0);
});
