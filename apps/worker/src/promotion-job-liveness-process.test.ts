import assert from "node:assert/strict";
import test from "node:test";
import {
  runPromotionJobLivenessProcess,
} from "./promotion-job-liveness-process.ts";

test("one-shot starts central, runs once, and closes gateway before central", async () => {
  const events: string[] = [];
  await runPromotionJobLivenessProcess({
    mode: "once",
    database: {
      client: { authority: "central" },
      async start() { events.push("central:start"); },
      async close() { events.push("central:close"); },
    },
    gateway: {
      async close() { events.push("gateway:close"); },
    },
    createRuntime(client) {
      assert.deepEqual(client, { authority: "central" });
      events.push("runtime:create");
      return {
        async start() { throw new Error("unexpected"); },
        stop() { events.push("runtime:stop"); },
        async runOnce() {
          events.push("runtime:once");
          return { state: "completed", failureCode: null, result: null };
        },
      };
    },
  });
  assert.deepEqual(events, [
    "central:start",
    "runtime:create",
    "runtime:once",
    "runtime:stop",
    "gateway:close",
    "central:close",
  ]);
});

test("daemon signal stops the runtime and removes signal ownership", async () => {
  const listeners = new Map<string, () => void>();
  const removed: string[] = [];
  let resolve!: () => void;
  const running = new Promise<void>((complete) => { resolve = complete; });
  let stops = 0;
  const processRun = runPromotionJobLivenessProcess({
    mode: "daemon",
    database: {
      client: {},
      async start() {},
      async close() {},
    },
    gateway: { async close() {} },
    signals: {
      once(signal, listener) { listeners.set(signal, listener); },
      removeListener(signal) { removed.push(signal); },
    },
    createRuntime() {
      return {
        start: () => running,
        stop() {
          stops += 1;
          resolve();
        },
        async runOnce() {
          return { state: "completed", failureCode: null, result: null };
        },
      };
    },
  });
  // Yield once so listener registration finishes before invoking SIGTERM.
  await new Promise<void>((complete) => setImmediate(complete));
  assert.ok(listeners.has("SIGTERM"));
  listeners.get("SIGTERM")?.();
  await processRun;
  assert.ok(stops >= 1);
  assert.deepEqual(removed.sort(), ["SIGINT", "SIGTERM"]);
});

test("failed one-shot still closes every owned database capability", async () => {
  const events: string[] = [];
  await assert.rejects(
    runPromotionJobLivenessProcess({
      mode: "once",
      database: {
        client: {},
        async start() { events.push("central:start"); },
        async close() { events.push("central:close"); },
      },
      gateway: {
        async close() { events.push("gateway:close"); },
      },
      createRuntime() {
        return {
          async start() {},
          stop() { events.push("runtime:stop"); },
          async runOnce() {
            return {
              state: "failed" as const,
              failureCode: "REGISTRY_ENUMERATION_FAILED",
              result: null,
            };
          },
        };
      },
    }),
    { code: "PROMOTION_JOB_LIVENESS_PROCESS_FAILED" },
  );
  assert.deepEqual(events, [
    "central:start",
    "runtime:stop",
    "gateway:close",
    "central:close",
  ]);
});

test("gateway close failure cannot skip central close or expose dependency detail", async () => {
  let centralClosed = false;
  await assert.rejects(
    runPromotionJobLivenessProcess({
      mode: "once",
      database: {
        client: {},
        async start() {},
        async close() { centralClosed = true; },
      },
      gateway: {
        async close() {
          throw new Error("postgresql://secret@provider.example/private");
        },
      },
      createRuntime() {
        return {
          async start() {},
          stop() {},
          async runOnce() {
            return { state: "completed" as const, failureCode: null, result: null };
          },
        };
      },
    }),
    {
      code: "PROMOTION_JOB_LIVENESS_PROCESS_FAILED",
      message: "Promotion job liveness process failed.",
    },
  );
  assert.equal(centralClosed, true);
});
