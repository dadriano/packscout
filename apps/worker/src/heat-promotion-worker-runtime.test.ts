import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HeatPromotionRetentionCoordinator,
} from "./heat-promotion-retention.ts";
import {
  HeatPromotionWorkerRuntime,
  type HeatPromotionWorkerLogEvent,
} from "./heat-promotion-worker-runtime.ts";
import { ProviderWorkerRuntime } from "./provider-worker-runtime.ts";

function idleResult() {
  return {
    outcome: "idle" as const,
    attemptId: null,
    frameSequence: null,
    operationsAcknowledged: 0,
    reusedSignalSet: false,
    failureCode: null,
  };
}

test("Heat runs once at each exact closed-minute boundary", async () => {
  let now = new Date("2026-08-15T12:00:30.000Z");
  const boundaries: string[] = [];
  const sleeps: number[] = [];
  const runtime = new HeatPromotionWorkerRuntime({
    runner: {
      async runCycle(boundary) {
        boundaries.push(boundary.toISOString());
        if (boundaries.length === 3) runtime.stop();
        return idleResult();
      },
    },
    retention: {
      async runCycle() {
        return {
          batches: 1,
          deletedOutcomes: 0,
          deletedObservations: 0,
          capReached: false,
        };
      },
    },
    logger: { write() {} },
    workerId: "heat-worker-1",
    clock: { now: () => new Date(now) },
    sleeper: {
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        now = new Date(now.getTime() + milliseconds);
      },
    },
  });
  await runtime.start();
  assert.deepEqual(boundaries, [
    "2026-08-15T12:00:00.000Z",
    "2026-08-15T12:01:00.000Z",
    "2026-08-15T12:02:00.000Z",
  ]);
  assert.deepEqual(sleeps, [30_000, 60_000]);
});

test("stopping Heat aborts an in-flight boundary without retention", async () => {
  let started!: () => void;
  const cycleStarted = new Promise<void>((resolve) => { started = resolve; });
  let observedAbort = false;
  let retentionRuns = 0;
  const runtime = new HeatPromotionWorkerRuntime({
    runner: {
      async runCycle(_boundary, signal) {
        started();
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        observedAbort = signal?.aborted === true;
        return { ...idleResult(), outcome: "stopped" };
      },
    },
    retention: {
      async runCycle() {
        retentionRuns += 1;
        return {
          batches: 0,
          deletedOutcomes: 0,
          deletedObservations: 0,
          capReached: false,
        };
      },
    },
    logger: { write() {} },
    workerId: "heat-worker-1",
    clock: { now: () => new Date("2026-08-15T12:00:01.000Z") },
  });
  const completion = runtime.start();
  await cycleStarted;
  runtime.stop();
  await completion;
  assert.equal(observedAbort, true);
  assert.equal(retentionRuns, 0);
});

test("normalized Heat cleanup is bounded and reports remaining work", async () => {
  let calls = 0;
  const retention = new HeatPromotionRetentionCoordinator({
    async cleanup({ limit }) {
      calls += 1;
      assert.equal(limit, 25);
      return {
        deletedOutcomes: 10,
        deletedObservations: 15,
        hasMore: true,
      };
    },
  }, 25, 3);
  assert.deepEqual(
    await retention.runCycle(new Date("2026-08-15T12:00:00.000Z")),
    {
      batches: 3,
      deletedOutcomes: 30,
      deletedObservations: 45,
      capReached: true,
    },
  );
  assert.equal(calls, 3);
});

test("provider, catalog, and Heat loops fail and stop independently", async () => {
  const events: HeatPromotionWorkerLogEvent[] = [];
  let heatStarted = 0;
  let heatStopped = 0;
  let finishHeat!: () => void;
  const heatCompletion = new Promise<void>((resolve) => { finishHeat = resolve; });
  const providerEvents: Array<{ event: string }> = [];
  const runtime = new ProviderWorkerRuntime({
    scheduler: { async runOnce() { return { kind: "idle" }; } },
    imports: {
      async executeImport(): Promise<never> { throw new Error("not called"); },
      async executeNextImport() { return { kind: "idle" }; },
    },
    retention: {
      async runCycle() {
        return {
          cutoffAt: "2026-08-15T12:00:00.000Z",
          discoveredOrganizations: 0,
          attemptedOrganizations: 0,
          batchesRun: 0,
          expired: 0,
          failed: 0,
          knownRemaining: 0,
          deferredOrganizations: 0,
          capReached: false,
        };
      },
    },
    catalogPromotion: {
      async start() { throw new Error("catalog lane failed"); },
      stop() {},
    },
    heatPromotion: {
      start() {
        heatStarted += 1;
        return heatCompletion;
      },
      stop() {
        heatStopped += 1;
        finishHeat();
      },
    },
    logger: { write(event) { providerEvents.push(event); } },
    workerId: "worker-1",
    sleeper: { async sleep() { runtime.stop(); } },
  });
  await runtime.start();
  assert.equal(heatStarted, 1);
  assert.ok(heatStopped >= 1);
  assert.ok(providerEvents.some(({ event }) =>
    event === "provider_catalog_promotion_runtime_failed"));
  assert.equal(events.length, 0);
});
