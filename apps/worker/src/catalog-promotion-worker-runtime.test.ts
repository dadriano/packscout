import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CatalogPromotionWorkerHealthLogger,
  CatalogPromotionWorkerRuntime,
  type CatalogPromotionWorkerLogEvent,
} from "./catalog-promotion-worker-runtime.ts";
import {
  ProviderWorkerRuntime,
} from "./provider-worker-runtime.ts";

test("catalog promotion loop runs on its own sub-minute cadence", async () => {
  const events: CatalogPromotionWorkerLogEvent[] = [];
  const sleeps: number[] = [];
  const runtime = new CatalogPromotionWorkerRuntime({
    runner: {
      async runCycle() {
        return {
          outcome: "idle",
          attemptId: null,
          requestedWatermark: null,
          operationsAcknowledged: 0,
          failureCode: null,
        };
      },
    },
    logger: { write: (event) => void events.push(event) },
    workerId: "worker-1",
    pollIntervalMilliseconds: 5_000,
    sleeper: {
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        runtime.stop();
      },
    },
  });
  await runtime.start();
  assert.deepEqual(sleeps, [5_000]);
  assert.ok(sleeps[0]! < 60_000);
  assert.deepEqual(events.map(({ event }) => event), [
    "catalog_promotion_worker_started",
    "catalog_promotion_cycle_finished",
    "catalog_promotion_worker_stopped",
  ]);
});

test("stop aborts an in-flight catalog cycle and prevents another dispatch", async () => {
  const events: CatalogPromotionWorkerLogEvent[] = [];
  let cycles = 0;
  let observedAbort = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const runtime = new CatalogPromotionWorkerRuntime({
    runner: {
      async runCycle(signal) {
        cycles += 1;
        markStarted();
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        observedAbort = signal?.aborted === true;
        return {
          outcome: "stopped",
          attemptId: "attempt-1",
          requestedWatermark: 20n,
          operationsAcknowledged: 0,
          failureCode: null,
        };
      },
    },
    logger: { write: (event) => void events.push(event) },
    workerId: "worker-1",
    pollIntervalMilliseconds: 5_000,
  });
  const completion = runtime.start();
  await started;

  runtime.stop();
  let timeout!: NodeJS.Timeout;
  await Promise.race([
    completion,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("catalog shutdown exceeded its bound")),
        250,
      );
    }),
  ]).finally(() => clearTimeout(timeout));

  assert.equal(observedAbort, true);
  assert.equal(cycles, 1);
  assert.deepEqual(events.map(({ event }) => event), [
    "catalog_promotion_worker_started",
    "catalog_promotion_cycle_finished",
    "catalog_promotion_worker_stopped",
  ]);
});

test("catalog cycle failures log a bounded code without exception contents", async () => {
  const events: CatalogPromotionWorkerLogEvent[] = [];
  const runtime = new CatalogPromotionWorkerRuntime({
    runner: {
      async runCycle() {
        throw new Error("secret-value-that-must-not-be-logged");
      },
    },
    logger: { write: (event) => void events.push(event) },
    workerId: "worker-1",
    pollIntervalMilliseconds: 5_000,
  });
  assert.equal(await runtime.runCycle(), null);
  const serialized = JSON.stringify(events);
  assert.match(serialized, /CATALOG_PROMOTION_CYCLE_ERROR/u);
  assert.doesNotMatch(serialized, /secret-value/u);
});

test("catalog health logs only safe operational facts", () => {
  const events: CatalogPromotionWorkerLogEvent[] = [];
  const now = new Date("2026-08-15T12:01:00.000Z");
  new CatalogPromotionWorkerHealthLogger(
    { write: (event) => void events.push(event) },
    "worker-1",
    () => now,
  ).report({
    settledWatermark: 45n,
    requestedWatermark: 45n,
    activeAttempt: {
      attemptId: "attempt-1",
      requestedWatermark: 45n,
      state: "retry_wait",
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
      claimExpiresAt: null,
    },
    lastActivatedWatermark: 40n,
    lastActivatedAt: new Date("2026-08-15T11:59:00.000Z"),
    lastUnchangedWatermark: 41n,
    lastUnchangedAt: new Date("2026-08-15T11:59:30.000Z"),
    retryAt: new Date("2026-08-15T12:01:05.000Z"),
    delayedVendorCount: 1,
  });
  assert.deepEqual(events[0], {
    level: "info",
    event: "catalog_promotion_health",
    workerId: "worker-1",
    settledWatermark: "45",
    attemptId: "attempt-1",
    requestedWatermark: "45",
    activeAttemptState: "retry_wait",
    activeAttemptAgeMilliseconds: 60_000,
    lastActivatedWatermark: "40",
    lastActivatedAt: "2026-08-15T11:59:00.000Z",
    lastUnchangedWatermark: "41",
    lastUnchangedAt: "2026-08-15T11:59:30.000Z",
    retryAt: "2026-08-15T12:01:05.000Z",
    delayedVendorCount: 1,
  });
  assert.equal("organizationId" in events[0]!, false);
});

test("provider and catalog loops start concurrently and stop together", async () => {
  let catalogStarted = 0;
  let catalogStopped = 0;
  let resolveCatalog!: () => void;
  const catalogCompletion = new Promise<void>((resolve) => {
    resolveCatalog = resolve;
  });
  const runtime = new ProviderWorkerRuntime({
    scheduler: { async runOnce() { return { kind: "idle" }; } },
    imports: {
      async executeImport() { throw new Error("not called"); },
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
      start() {
        catalogStarted += 1;
        return catalogCompletion;
      },
      stop() {
        catalogStopped += 1;
        resolveCatalog();
      },
    },
    logger: { write() {} },
    workerId: "worker-1",
    sleeper: {
      async sleep() { runtime.stop(); },
    },
  });
  await runtime.start();
  assert.equal(catalogStarted, 1);
  assert.ok(catalogStopped >= 1);
});
