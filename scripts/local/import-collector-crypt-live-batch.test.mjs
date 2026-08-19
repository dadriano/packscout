import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  CollectorCryptBatchError,
  collectorCryptOneShotEnvironment,
  collectorCryptBatchSummaryJson,
  executeCollectorCryptBatch,
  readCollectorCryptBatchConfiguration,
  spawnCollectorCryptOneShotWorker,
} from "./import-collector-crypt-live-batch.ts";

function counters(overrides = {}) {
  return {
    pages: 0,
    records: 0,
    accepted: 0,
    duplicate: 0,
    quarantined: 0,
    requestAttempts: 0,
    transientRetries: 0,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    state: "queued",
    reachedProviderHead: false,
    finishedAt: null,
    leaseExpiresAt: null,
    counters: counters(),
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return {
    deadlineMilliseconds: 60_000,
    minimumFreeBytes: 20n * 1024n * 1024n * 1024n,
    pageBudget: 2,
    pollMilliseconds: 100,
    ...overrides,
  };
}

function runtime(initial, afterWorker, overrides = {}) {
  let current = initial;
  let now = new Date("2026-08-19T12:00:00.000Z");
  const calls = [];
  return {
    calls,
    runtime: {
      now: () => new Date(now),
      async sleep(milliseconds) {
        calls.push(["sleep", milliseconds]);
        now = new Date(now.getTime() + milliseconds);
      },
      async requestImport() {
        calls.push("request");
        return {
          organizationId: "10000000-0000-4000-8000-000000000001",
          runId: "20000000-0000-4000-8000-000000000001",
          coalesced: false,
        };
      },
      async readRun() {
        calls.push("read");
        return current;
      },
      async freeDiskBytes() {
        calls.push("disk");
        return 40n * 1024n * 1024n * 1024n;
      },
      async executeOneShot(input) {
        calls.push(["worker", input]);
        current = afterWorker;
        return 0;
      },
      async close() {},
      ...overrides,
    },
  };
}

function hasCode(code) {
  return (error) => {
    assert.ok(error instanceof CollectorCryptBatchError);
    assert.equal(error.code, code);
    return true;
  };
}

test("batch configuration is bounded and has conservative local defaults", () => {
  assert.deepEqual(readCollectorCryptBatchConfiguration({}, []), {
    pageBudget: 25,
    deadlineMilliseconds: 900_000,
    pollMilliseconds: 1_000,
    minimumFreeBytes: 20n * 1024n * 1024n * 1024n,
  });
  assert.deepEqual(
    readCollectorCryptBatchConfiguration(
      {
        PACKSCOUT_COLLECTOR_CRYPT_BATCH_PAGES: "50",
        PACKSCOUT_COLLECTOR_CRYPT_BATCH_DEADLINE_SECONDS: "600",
        PACKSCOUT_COLLECTOR_CRYPT_BATCH_POLL_MS: "250",
        PACKSCOUT_COLLECTOR_CRYPT_BATCH_MIN_FREE_GIB: "30",
      },
      [],
    ),
    {
      pageBudget: 50,
      deadlineMilliseconds: 600_000,
      pollMilliseconds: 250,
      minimumFreeBytes: 30n * 1024n * 1024n * 1024n,
    },
  );
  assert.throws(
    () => readCollectorCryptBatchConfiguration({}, ["--unsafe"]),
    hasCode("ARGUMENTS_INVALID"),
  );
  for (const environment of [
    { PACKSCOUT_COLLECTOR_CRYPT_BATCH_PAGES: "0" },
    { PACKSCOUT_COLLECTOR_CRYPT_BATCH_DEADLINE_SECONDS: "29" },
    { PACKSCOUT_COLLECTOR_CRYPT_BATCH_POLL_MS: "5001" },
    { PACKSCOUT_COLLECTOR_CRYPT_BATCH_MIN_FREE_GIB: "4" },
  ]) {
    assert.throws(
      () => readCollectorCryptBatchConfiguration(environment, []),
      hasCode("BATCH_CONFIGURATION_INVALID"),
    );
  }
});

test("one supervised claim yields the same run with only sanitized count output", async () => {
  const before = snapshot({
    counters: counters({ pages: 10, records: 5_000 }),
  });
  const after = snapshot({
    counters: counters({
      pages: 12,
      records: 6_000,
      accepted: 900,
      duplicate: 80,
      quarantined: 20,
      requestAttempts: 2,
    }),
  });
  const harness = runtime(before, after, {
    async requestImport() {
      return {
        organizationId: "10000000-0000-4000-8000-000000000001",
        runId: "20000000-0000-4000-8000-000000000001",
        coalesced: true,
      };
    },
  });

  const summary = await executeCollectorCryptBatch(
    configuration(),
    harness.runtime,
  );

  assert.equal(summary.outcome, "yielded");
  assert.equal(summary.coalesced, true);
  assert.deepEqual(
    summary.batch,
    counters({
      pages: 2,
      records: 1_000,
      accepted: 900,
      duplicate: 80,
      quarantined: 20,
      requestAttempts: 2,
    }),
  );
  assert.equal(
    harness.calls.filter((call) => Array.isArray(call) && call[0] === "worker")
      .length,
    1,
  );
  const output = collectorCryptBatchSummaryJson(summary);
  assert.deepEqual(Object.keys(JSON.parse(output)), [
    "outcome",
    "reachedProviderHead",
    "coalesced",
    "total",
    "batch",
  ]);
  for (const protectedValue of ["cursor", "bearer", "10000000-", "20000000-"]) {
    assert.doesNotMatch(output, new RegExp(protectedValue));
  }
});

test("a crashed expired lease is reclaimed by exactly one targeted worker", async () => {
  const initial = snapshot({
    state: "running",
    leaseExpiresAt: new Date("2026-08-19T11:59:59.000Z"),
    counters: counters({ pages: 4, records: 2_000 }),
  });
  const completed = snapshot({
    state: "succeeded",
    reachedProviderHead: true,
    finishedAt: new Date("2026-08-19T12:00:10.000Z"),
    counters: counters({ pages: 5, records: 2_500, accepted: 500 }),
  });
  const harness = runtime(initial, completed);

  const summary = await executeCollectorCryptBatch(
    configuration(),
    harness.runtime,
  );

  assert.equal(summary.outcome, "succeeded");
  assert.equal(summary.reachedProviderHead, true);
  assert.equal(summary.batch.pages, 1);
  assert.equal(harness.calls.includes("disk"), true);
  assert.equal(
    harness.calls.filter((call) => Array.isArray(call) && call[0] === "worker")
      .length,
    1,
  );
});

test("disk reserve and deadline guards stop before unsafe work", async () => {
  const lowDisk = runtime(snapshot(), snapshot(), {
    async freeDiskBytes() {
      return 19n * 1024n * 1024n * 1024n;
    },
  });
  await assert.rejects(
    executeCollectorCryptBatch(configuration(), lowDisk.runtime),
    hasCode("DISK_RESERVE_REACHED"),
  );
  assert.equal(
    lowDisk.calls.some((call) => Array.isArray(call) && call[0] === "worker"),
    false,
  );

  const active = snapshot({
    state: "running",
    leaseExpiresAt: new Date("2026-08-19T12:10:00.000Z"),
  });
  const waiting = runtime(active, active);
  await assert.rejects(
    executeCollectorCryptBatch(
      configuration({ deadlineMilliseconds: 250, pollMilliseconds: 100 }),
      waiting.runtime,
    ),
    hasCode("BATCH_DEADLINE_REACHED"),
  );
  assert.equal(waiting.calls.includes("disk"), false);
});

test("one-shot child environment is an exact allowlist and cannot inherit bearer or unrelated secrets", () => {
  const controller = new AbortController();
  const child = collectorCryptOneShotEnvironment(
    {
      NODE_ENV: "production",
      PATH: "/secret/tooling/path",
      PACKSCOUT_DATABASE_URL:
        "postgresql://worker:password@localhost/packscout_dev",
      PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: "actor-key",
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: "credential-key",
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "7",
      PACKSCOUT_WORKER_DATABASE_POOL_MAX: "3",
      PACKSCOUT_COLLECTOR_CRYPT_BEARER_TOKEN: "must-not-cross-process-boundary",
      AWS_SECRET_ACCESS_KEY: "must-not-cross-process-boundary",
      NODE_OPTIONS: "--require=/untrusted/hook.cjs",
    },
    {
      organizationId: "10000000-0000-4000-8000-000000000001",
      runId: "20000000-0000-4000-8000-000000000001",
      pageBudget: 25,
      minimumFreeBytes: 20n * 1024n * 1024n * 1024n,
      timeoutMilliseconds: 60_000,
      signal: controller.signal,
    },
  );

  assert.deepEqual(Object.keys(child).sort(), [
    "NODE_ENV",
    "PACKSCOUT_DATABASE_URL",
    "PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64",
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
    "PACKSCOUT_WORKER_DATABASE_POOL_MAX",
    "PACKSCOUT_WORKER_ID",
    "PACKSCOUT_WORKER_IMPORT_MAX_RUN_MS",
    "PACKSCOUT_WORKER_IMPORT_MIN_FREE_BYTES",
    "PACKSCOUT_WORKER_IMPORT_PAGE_BUDGET",
    "PACKSCOUT_WORKER_MAX_CLAIMS_PER_CYCLE",
    "PACKSCOUT_WORKER_MODE",
    "PACKSCOUT_WORKER_ONE_SHOT_ORGANIZATION_ID",
    "PACKSCOUT_WORKER_ONE_SHOT_RUN_ID",
    "PACKSCOUT_WORKER_SKIP_DOTENV",
  ]);
  assert.equal(child.NODE_ENV, "development");
  assert.equal(child.PACKSCOUT_WORKER_SKIP_DOTENV, "1");
  assert.equal(
    JSON.stringify(child).includes("must-not-cross-process-boundary"),
    false,
  );
  assert.equal("PACKSCOUT_COLLECTOR_CRYPT_BEARER_TOKEN" in child, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in child, false);
  assert.equal("NODE_OPTIONS" in child, false);
  assert.equal("PATH" in child, false);
});

test("parent cancellation forwards its signal and awaits detached-group teardown", async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill() {
      return true;
    },
  });
  const controller = new AbortController();
  let terminationSignal = null;
  let releaseTermination;
  const terminationGate = new Promise((resolve) => {
    releaseTermination = resolve;
  });
  const running = spawnCollectorCryptOneShotWorker(
    {
      PACKSCOUT_DATABASE_URL:
        "postgresql://worker:password@localhost/packscout_dev",
      PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: "actor-key",
      PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: "credential-key",
    },
    "/workspace",
    {
      organizationId: "10000000-0000-4000-8000-000000000001",
      runId: "20000000-0000-4000-8000-000000000001",
      pageBudget: 25,
      minimumFreeBytes: 20n * 1024n * 1024n * 1024n,
      timeoutMilliseconds: 60_000,
      signal: controller.signal,
    },
    {
      spawn() {
        return child;
      },
      async terminate(_child, outcome, options) {
        terminationSignal = options.signal;
        await terminationGate;
        child.signalCode = "SIGINT";
        child.emit("exit", null, "SIGINT");
        return outcome;
      },
    },
  );
  let settled = false;
  void running.finally(() => {
    settled = true;
  });
  controller.abort("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminationSignal, "SIGINT");
  assert.equal(settled, false);

  releaseTermination();
  assert.equal(await running, 1);
  assert.equal(settled, true);
});
