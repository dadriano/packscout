import assert from "node:assert/strict";
import test from "node:test";
import {
  runProviderActivityRelayProcess,
} from "./provider-activity-relay-process.ts";

const completed = {
  state: "completed" as const,
  failureCode: null,
  result: {
    providers: 1,
    delivered: 1,
    deduplicated: 0,
    unreachable: 0,
    failures: 0,
    backpressured: 0,
  },
};

test("one-shot starts central, runs once, then closes gateway before central", async () => {
  const events: string[] = [];
  await runProviderActivityRelayProcess({
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
        async start() { throw new Error("unexpected daemon start"); },
        stop() { events.push("runtime:stop"); },
        async runOnce() {
          events.push("runtime:once");
          return completed;
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

test("isolated provider degradation does not fail the one-shot process", async () => {
  await runProviderActivityRelayProcess({
    mode: "once",
    database: { client: {}, async start() {}, async close() {} },
    gateway: { async close() {} },
    createRuntime() {
      return {
        async start() {},
        stop() {},
        async runOnce() {
          return {
            state: "degraded" as const,
            failureCode: "PROVIDER_ACTIVITY_RELAY_PROVIDER_UNAVAILABLE",
            result: { ...completed.result, unreachable: 1 },
          };
        },
      };
    },
  });
});

test("daemon signal drains the runtime before closing owned connections", async () => {
  const listeners = new Map<string, () => void>();
  const events: string[] = [];
  let resolve!: () => void;
  const running = new Promise<void>((complete) => { resolve = complete; });
  const processRun = runProviderActivityRelayProcess({
    mode: "daemon",
    database: {
      client: {},
      async start() { events.push("central:start"); },
      async close() { events.push("central:close"); },
    },
    gateway: { async close() { events.push("gateway:close"); } },
    signals: {
      once(signal, listener) { listeners.set(signal, listener); },
      removeListener(signal) { events.push(`remove:${signal}`); },
    },
    createRuntime() {
      return {
        start: () => running,
        stop() {
          events.push("runtime:stop");
          resolve();
        },
        async runOnce() { return completed; },
      };
    },
  });
  await new Promise<void>((complete) => setImmediate(complete));
  listeners.get("SIGTERM")?.();
  await processRun;

  const gatewayClose = events.indexOf("gateway:close");
  const centralClose = events.indexOf("central:close");
  assert.ok(gatewayClose > events.lastIndexOf("runtime:stop"));
  assert.ok(centralClose > gatewayClose);
  assert.ok(events.includes("remove:SIGINT"));
  assert.ok(events.includes("remove:SIGTERM"));
});

test("fatal cycle still closes all capabilities with a redacted process error", async () => {
  const events: string[] = [];
  await assert.rejects(
    runProviderActivityRelayProcess({
      mode: "once",
      database: {
        client: {},
        async start() { events.push("central:start"); },
        async close() { events.push("central:close"); },
      },
      gateway: { async close() { events.push("gateway:close"); } },
      createRuntime() {
        return {
          async start() {},
          stop() { events.push("runtime:stop"); },
          async runOnce() {
            return {
              state: "failed" as const,
              failureCode: "PROVIDER_ACTIVITY_RELAY_DIRECTORY_UNAVAILABLE",
              result: null,
            };
          },
        };
      },
    }),
    {
      code: "PROVIDER_ACTIVITY_RELAY_PROCESS_FAILED",
      message: "Provider activity relay process failed.",
    },
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
    runProviderActivityRelayProcess({
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
          async runOnce() { return completed; },
        };
      },
    }),
    {
      code: "PROVIDER_ACTIVITY_RELAY_PROCESS_FAILED",
      message: "Provider activity relay process failed.",
    },
  );
  assert.equal(centralClosed, true);
});
