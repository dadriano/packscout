import assert from "node:assert/strict";
import test from "node:test";
import type { SuccessfulPromotionJobLivenessCycle } from "@packscout/services";
import {
  PROMOTION_JOB_LIVENESS_EVALUATOR_CADENCE_MS,
  PromotionJobLivenessRuntime,
  type PromotionJobLivenessRuntimeLogger,
} from "./promotion-job-liveness-runtime.ts";

const base = new Date("2026-09-01T12:00:00.000Z");

function cycle(): SuccessfulPromotionJobLivenessCycle {
  return {
    evaluatedAt: base,
    roster: {
      rosterVersion: 1n,
      rosterHighWater: 2n,
      rosterDigest: "a".repeat(64),
      capturedAt: base,
      providers: [],
    },
    providerObservations: [],
    manifestObservation: {
      observedAt: base,
      judgment: {
        lifecycle: "pending_activation",
        scheduleEpoch: 0n,
        health: "inactive",
        latestCountableWindowIndex: 0n,
        lastAdmittedWindowIndex: 0n,
        missedWindowCount: 0n,
        lastScheduledCheckinAt: null,
        evaluatedAt: base,
      },
    },
    summary: {
      expectedCount: 1,
      reachableCount: 1,
      unavailableCount: 0,
      healthyCount: 1,
      overdueCount: 0,
      alertingCount: 0,
    },
  };
}

function logger() {
  const records: Parameters<PromotionJobLivenessRuntimeLogger["log"]>[0][] = [];
  return { records, value: { log: (record: typeof records[number]) => {
    records.push(record);
  } } };
}

test("daemon runs immediately then on one exact minute cadence", async () => {
  const waits: number[] = [];
  let runs = 0;
  const logs = logger();
  const runtime = new PromotionJobLivenessRuntime({
    oneShot: {
      async run() {
        runs += 1;
        return {
          cycle: cycle(),
          delivery: {
            state: "complete",
            selectedCount: 0,
            deliveredCount: 0,
            retryScheduledCount: 0,
            acknowledgementFailureCount: 0,
          },
        };
      },
    },
    logger: logs.value,
    now: () => base,
    async sleep(milliseconds) {
      waits.push(milliseconds);
      runtime.stop();
    },
  });

  await runtime.start();
  assert.equal(runs, 1);
  assert.deepEqual(waits, [PROMOTION_JOB_LIVENESS_EVALUATOR_CADENCE_MS]);
  assert.deepEqual(logs.records.map(({ phase }) => phase), [
    "started",
    "cycle",
    "stopped",
  ]);
});

test("cycle failure is bounded, redacted, and does not escape the daemon", async () => {
  const logs = logger();
  const runtime = new PromotionJobLivenessRuntime({
    oneShot: {
      async run() {
        throw Object.assign(new Error("postgres://secret@host/db"), {
          code: "registry_enumeration_failed",
        });
      },
    },
    logger: logs.value,
    now: () => base,
  });
  const result = await runtime.runOnce();
  assert.deepEqual(result, {
    state: "failed",
    failureCode: "REGISTRY_ENUMERATION_FAILED",
    result: null,
  });
  const rendered = JSON.stringify(logs.records);
  assert.doesNotMatch(rendered, /postgres|secret|provider|organization/iu);
});

test("concurrent requests share one bounded evaluator pass", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const runtime = new PromotionJobLivenessRuntime({
    oneShot: {
      async run() {
        runs += 1;
        await blocked;
        return {
          cycle: cycle(),
          delivery: {
            state: "complete",
            selectedCount: 0,
            deliveredCount: 0,
            retryScheduledCount: 0,
            acknowledgementFailureCount: 0,
          },
        };
      },
    },
    logger: logger().value,
  });
  const first = runtime.runOnce();
  const second = runtime.runOnce();
  release();
  assert.equal(await first, await second);
  assert.equal(runs, 1);
});
