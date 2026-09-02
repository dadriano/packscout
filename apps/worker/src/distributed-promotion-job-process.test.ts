import assert from "node:assert/strict";
import test from "node:test";
import { runDistributedPromotionJobProcess } from
  "./distributed-promotion-job-process.ts";
import {
  PostgresPromotionImmediateDeliverySubscriber,
  type PromotionImmediateDeliverySubscriberClient,
} from "./postgres-promotion-immediate-delivery.ts";

test("one-shot processes start and always close their one role database", async () => {
  const events: string[] = [];
  await runDistributedPromotionJobProcess({
    configuration: {
      mode: "once",
      manualCommandIdentity: null,
      continuationGeneration: null,
    },
    database: {
      client: { role: "provider" },
      async start() { events.push("database:start"); },
      async close() { events.push("database:close"); },
    },
    createRuntime(client) {
      assert.deepEqual(client, { role: "provider" });
      events.push("runtime:create");
      return {
        async start() { events.push("runtime:start"); },
        stop() { events.push("runtime:stop"); },
        async runCycle() {
          events.push("runtime:once");
          return {
            invocations: [],
            reconciledInvocations: 0,
            reconciliationFailures: 0,
            stateReadFailures: 0,
          };
        },
        async runManual() { throw new Error("unexpected"); },
        async runContinuation() { throw new Error("unexpected"); },
      };
    },
  });
  assert.deepEqual(events, [
    "database:start",
    "runtime:create",
    "runtime:once",
    "runtime:stop",
    "database:close",
  ]);
});

test("manual and continuation process modes use their exact one-shot trigger", async () => {
  const observed: string[] = [];
  for (const configuration of [{
    mode: "manual" as const,
    manualCommandIdentity: "verified-upstream-command",
    continuationGeneration: null,
  }, {
    mode: "continuation" as const,
    manualCommandIdentity: null,
    continuationGeneration: 9n,
  }]) {
    await runDistributedPromotionJobProcess({
      configuration,
      database: {
        client: {},
        async start() {},
        async close() {},
      },
      createRuntime() {
        return {
          async start() {},
          stop() {},
          async runCycle() {
            throw new Error("unexpected");
          },
          async runManual(identity) {
            observed.push(`manual:${identity}`);
            return {
              triggerKind: "manual",
              state: "completed",
              outcome: "no_change",
              failureCode: null,
            };
          },
          async runContinuation(generation) {
            observed.push(`continuation:${generation}`);
            return {
              triggerKind: "continuation",
              state: "completed",
              outcome: "no_change",
              failureCode: null,
            };
          },
        };
      },
    });
  }
  assert.deepEqual(observed, [
    "manual:verified-upstream-command",
    "continuation:9",
  ]);
});

test("daemon keeps polling when immediate subscription start and stop fail", async () => {
  const events: string[] = [];
  await runDistributedPromotionJobProcess({
    configuration: {
      mode: "daemon",
      manualCommandIdentity: null,
      continuationGeneration: null,
    },
    database: {
      client: {},
      async start() { events.push("database:start"); },
      async close() { events.push("database:close"); },
    },
    createRuntime() {
      return {
        runtime: {
          async start() { events.push("runtime:start"); },
          stop() { events.push("runtime:stop"); },
          async runCycle() { throw new Error("unexpected"); },
          async runManual() { throw new Error("unexpected"); },
          async runContinuation() { throw new Error("unexpected"); },
        },
        immediateDelivery: {
          async start() {
            events.push("immediate:start");
            throw new Error("listen unavailable");
          },
          async stop() {
            events.push("immediate:stop");
            throw new Error("listener close unavailable");
          },
        },
      };
    },
  });

  assert.deepEqual(events, [
    "database:start",
    "immediate:start",
    "runtime:start",
    "runtime:stop",
    "immediate:stop",
    "database:close",
  ]);
});

test("a hanging LISTEN connection cannot block authoritative polling startup", async () => {
  const events: string[] = [];
  const hangingClient = {
    connect: () => new Promise<never>(() => undefined),
    query: () => Promise.resolve(),
    end: () => Promise.resolve(),
    on: () => undefined,
    removeListener: () => undefined,
  } as unknown as PromotionImmediateDeliverySubscriberClient;
  const immediateDelivery = new PostgresPromotionImmediateDeliverySubscriber({
    databaseUrl: "postgresql://provider.invalid/packscout_alpha",
    authority: "provider_publication",
    delivery: { request: () => Promise.resolve() },
    clientFactory: () => hangingClient,
    logger: { log: () => undefined },
    operationTimeoutMilliseconds: 5,
  });

  await runDistributedPromotionJobProcess({
    configuration: {
      mode: "daemon",
      manualCommandIdentity: null,
      continuationGeneration: null,
    },
    database: {
      client: {},
      async start() { events.push("database:start"); },
      async close() { events.push("database:close"); },
    },
    createRuntime() {
      return {
        runtime: {
          async start() { events.push("runtime:start"); },
          stop() { events.push("runtime:stop"); },
          async runCycle() { throw new Error("unexpected"); },
          async runManual() { throw new Error("unexpected"); },
          async runContinuation() { throw new Error("unexpected"); },
        },
        immediateDelivery,
      };
    },
  });

  assert.deepEqual(events, [
    "database:start",
    "runtime:start",
    "runtime:stop",
    "database:close",
  ]);
});

test("signal shutdown awaits one in-flight listener close before database teardown", async () => {
  const events: string[] = [];
  let signalListener: (() => void) | undefined;
  let finishListenerClose: (() => void) | undefined;
  let listenerStopCount = 0;
  const running = runDistributedPromotionJobProcess({
    configuration: {
      mode: "daemon",
      manualCommandIdentity: null,
      continuationGeneration: null,
    },
    database: {
      client: {},
      async start() { events.push("database:start"); },
      async close() { events.push("database:close"); },
    },
    signals: {
      once(_signal, listener) {
        signalListener = listener;
      },
      removeListener() {},
    },
    createRuntime() {
      return {
        runtime: {
          async start() {
            events.push("runtime:start");
            signalListener?.();
          },
          stop() { events.push("runtime:stop"); },
          async runCycle() { throw new Error("unexpected"); },
          async runManual() { throw new Error("unexpected"); },
          async runContinuation() { throw new Error("unexpected"); },
        },
        immediateDelivery: {
          async start() { events.push("immediate:start"); },
          stop() {
            listenerStopCount += 1;
            events.push("immediate:stop");
            return new Promise<void>((resolve) => {
              finishListenerClose = resolve;
            });
          },
        },
      };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listenerStopCount, 1);
  assert.equal(events.includes("database:close"), false);
  finishListenerClose?.();
  await running;
  assert.equal(listenerStopCount, 1);
  assert.equal(events.at(-1), "database:close");
});
