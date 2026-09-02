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
const providerIds = Array.from(
  { length: 64 },
  (_, index) =>
    `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

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
    input: Readonly<{ deadlineAt: number }>,
  ) => Promise<ProviderDatabaseOperationResult<PromotionJobSchedule>>;
  providerConcurrency?: number;
  providerCycleTimeoutMs?: number;
  scheduleProviderCycleDeadline?: (
    expire: () => void,
    timeoutMs: number,
  ) => () => void;
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
    providerConcurrency: input.providerConcurrency ?? 2,
    ...(input.providerCycleTimeoutMs === undefined
      ? {}
      : { providerCycleTimeoutMs: input.providerCycleTimeoutMs }),
    ...(input.scheduleProviderCycleDeadline === undefined
      ? {}
      : {
          scheduleProviderCycleDeadline:
            input.scheduleProviderCycleDeadline,
        }),
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

test("one cycle deadline records a 64-provider outage without launching queued reads", async () => {
  const started: string[] = [];
  const deadlines = new Set<number>();
  const rejectStarted: ((reason?: unknown) => void)[] = [];
  const scheduledDeadline: { expire?: () => void } = {};
  let cancelCount = 0;
  let markFirstWaveStarted!: () => void;
  const firstWaveStarted = new Promise<void>((resolve) => {
    markFirstWaveStarted = resolve;
  });
  const context = harness({
    roster: () => Promise.resolve(roster(64)),
    providerConcurrency: 8,
    providerCycleTimeoutMs: 1_000,
    scheduleProviderCycleDeadline(expire, timeoutMs) {
      assert.equal(timeoutMs, 1_000);
      scheduledDeadline.expire = expire;
      return () => { cancelCount += 1; };
    },
    provider(entry, input) {
      started.push(entry.providerId);
      deadlines.add(input.deadlineAt);
      if (started.length === 8) markFirstWaveStarted();
      return new Promise((_, reject) => { rejectStarted.push(reject); });
    },
  });

  const cyclePromise = context.evaluator.runCycle();
  await firstWaveStarted;
  assert.ok(scheduledDeadline.expire);
  scheduledDeadline.expire();
  const cycle = await cyclePromise;

  assert.equal(started.length, 8);
  assert.equal(deadlines.size, 1);
  assert.equal(cancelCount, 1);
  assert.deepEqual(
    cycle.providerObservations.map(({ provider: row }) => row.providerKey),
    Array.from({ length: 64 }, (_, index) => `provider_${index + 1}`),
  );
  for (const observation of cycle.providerObservations) {
    assert.equal(observation.observation.evidenceSource, "unavailable");
    assert.equal(observation.failureCode, "database_unreachable");
  }
  assert.deepEqual(cycle.summary, {
    expectedCount: 65,
    reachableCount: 1,
    unavailableCount: 64,
    healthyCount: 1,
    overdueCount: 0,
    alertingCount: 0,
  });
  assert.equal(context.successful.length, 1);
  assert.deepEqual(context.failed, []);
  for (const reject of rejectStarted) reject(new Error("late provider failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
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
