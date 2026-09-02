import assert from "node:assert/strict";
import test from "node:test";
import { runDistributedPromotionJobProcess } from
  "./distributed-promotion-job-process.ts";

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
          return { invocations: [], stateReadFailures: 0 };
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
