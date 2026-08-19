import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CatalogRetentionWorkerRuntime,
  type CatalogRetentionWorkerLogEvent,
} from "./catalog-retention-worker-runtime.ts";

const cycle = (outcome: "released" | "bounded" = "released") => ({
  outcome,
  resumedBarrier: false,
  steps: 1,
  networkRequests: 1,
  operationsAcknowledged: 1,
  postgresRowsDeleted: 0,
} as const);

test("released barriers use the normal cadence and bounded work continues soon", async () => {
  for (const [outcome, expectedWait] of [
    ["released", 3_600_000],
    ["bounded", 1_000],
  ] as const) {
    const waits: number[] = [];
    const runtime = new CatalogRetentionWorkerRuntime({
      workerId: "retention-worker",
      runner: { async runCycle() { return cycle(outcome); } },
      logger: { write() {} },
      intervalMilliseconds: 3_600_000,
      continuationIntervalMilliseconds: 1_000,
      sleeper: {
        sleep(milliseconds) {
          waits.push(milliseconds);
          runtime.stop();
          return Promise.resolve();
        },
      },
    });
    await runtime.start();
    assert.deepEqual(waits, [expectedWait]);
  }
});

test("stop aborts an in-flight retention request and joins the loop", async () => {
  let observedSignal: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const runtime = new CatalogRetentionWorkerRuntime({
    workerId: "retention-worker",
    runner: {
      runCycle(signal) {
        observedSignal = signal;
        entered();
        return new Promise((resolve) => signal?.addEventListener("abort", () =>
          resolve({ ...cycle(), outcome: "stopped" }), { once: true }));
      },
    },
    logger: { write() {} },
    intervalMilliseconds: 3_600_000,
    continuationIntervalMilliseconds: 1_000,
  });
  const running = runtime.start();
  await started;
  runtime.stop();
  await running;
  assert.equal(observedSignal?.aborted, true);
});

test("runtime logs bounded counts and never serializes thrown secrets", async () => {
  const events: CatalogRetentionWorkerLogEvent[] = [];
  const runtime = new CatalogRetentionWorkerRuntime({
    workerId: "retention-worker",
    runner: {
      async runCycle() {
        throw new Error("postgresql://operator:super-secret@db.example/live");
      },
    },
    logger: { write(event) { events.push(event); } },
    intervalMilliseconds: 3_600_000,
    continuationIntervalMilliseconds: 1_000,
  });
  assert.equal(await runtime.runCycle(), null);
  assert.deepEqual(events, [{
    level: "error",
    event: "catalog_retention_cycle_failed",
    failureCode: "CATALOG_RETENTION_CYCLE_ERROR",
    workerId: "retention-worker",
  }]);
  assert.equal(JSON.stringify(events).includes("super-secret"), false);
});
