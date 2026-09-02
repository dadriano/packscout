import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderActivityRelayCycleResult } from
  "./provider-activity-relay.ts";
import {
  ProviderActivityRelayRuntime,
  type ProviderActivityRelayRuntimeLogger,
} from "./provider-activity-relay-runtime.ts";

function cycle(
  patch: Partial<ProviderActivityRelayCycleResult> = {},
): ProviderActivityRelayCycleResult {
  return {
    providers: 2,
    delivered: 1,
    deduplicated: 0,
    unreachable: 0,
    failures: 0,
    backpressured: 0,
    ...patch,
  };
}

function logger() {
  const records: Parameters<ProviderActivityRelayRuntimeLogger["log"]>[0][] = [];
  return {
    records,
    value: {
      log(record: typeof records[number]) {
        records.push(record);
      },
    },
  };
}

test("daemon relays immediately and then waits the bounded low-latency cadence", async () => {
  const waits: number[] = [];
  let runs = 0;
  const logs = logger();
  const runtime = new ProviderActivityRelayRuntime({
    coordinator: {
      runCycle() {
        runs += 1;
        return Promise.resolve(cycle());
      },
    },
    logger: logs.value,
    pollMilliseconds: 250,
    async sleep(milliseconds) {
      waits.push(milliseconds);
      runtime.stop();
    },
  });

  await runtime.start();
  assert.equal(runs, 1);
  assert.deepEqual(waits, [250]);
  assert.deepEqual(logs.records.map(({ phase }) => phase), [
    "started",
    "cycle",
    "stopped",
  ]);
});

test("one provider outage is degraded but isolated and logs only aggregate counts", async () => {
  const logs = logger();
  const runtime = new ProviderActivityRelayRuntime({
    coordinator: {
      runCycle: () => Promise.resolve(cycle({
        providers: 12,
        delivered: 4,
        unreachable: 1,
      })),
    },
    logger: logs.value,
  });

  const result = await runtime.runOnce();
  assert.equal(result.state, "degraded");
  assert.equal(
    result.failureCode,
    "PROVIDER_ACTIVITY_RELAY_PROVIDER_UNAVAILABLE",
  );
  assert.equal(result.result?.delivered, 4);
  const rendered = JSON.stringify(logs.records);
  assert.doesNotMatch(
    rendered,
    /71000000-0000-4000-8000-000000000002|postgres(?:ql)?:\/\/|secret/iu,
  );
});

test("central roster failure is a redacted failed cycle", async () => {
  const logs = logger();
  const runtime = new ProviderActivityRelayRuntime({
    coordinator: {
      runCycle: () => Promise.resolve(cycle({
        providers: 0,
        delivered: 0,
        failures: 1,
      })),
    },
    logger: logs.value,
  });

  assert.deepEqual(await runtime.runOnce(), {
    state: "failed",
    failureCode: "PROVIDER_ACTIVITY_RELAY_DIRECTORY_UNAVAILABLE",
    result: cycle({ providers: 0, delivered: 0, failures: 1 }),
  });
});

test("dependency exceptions never enter logs and concurrent calls share one cycle", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const logs = logger();
  const runtime = new ProviderActivityRelayRuntime({
    coordinator: {
      async runCycle() {
        runs += 1;
        await blocked;
        throw new Error(
          "postgresql://relay:secret@central.example/private-provider-id",
        );
      },
    },
    logger: logs.value,
  });

  const first = runtime.runOnce();
  const second = runtime.runOnce();
  release();
  assert.equal(await first, await second);
  assert.equal(runs, 1);
  assert.equal((await first).state, "failed");
  assert.doesNotMatch(
    JSON.stringify(logs.records),
    /central\.example|private-provider-id|postgresql|secret/iu,
  );
});

test("poll cadence rejects hot loops and unbounded waits", () => {
  for (const pollMilliseconds of [0, 99, 60_001, Number.NaN]) {
    assert.throws(
      () => new ProviderActivityRelayRuntime({
        coordinator: { runCycle: () => Promise.resolve(cycle()) },
        logger: logger().value,
        pollMilliseconds,
      }),
      RangeError,
    );
  }
});
