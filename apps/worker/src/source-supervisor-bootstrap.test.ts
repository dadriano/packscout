import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "@packscout/database";
import { runProviderSourceSupervisorOnly } from
  "./source-supervisor-bootstrap.ts";

const sourceConnectionKey = Buffer.alloc(32, 13).toString("base64");
const actorKey = Buffer.alloc(32, 17).toString("base64");

function sourceEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PACKSCOUT_DATABASE_URL: "postgresql://worker:password@db.test/packscout",
    PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: actorKey,
    PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: sourceConnectionKey,
    PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: "3",
    PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: "/tmp",
    ...overrides,
  };
}

test("source-only bootstrap owns startup, graceful stop, and database cleanup", async () => {
  const events: string[] = [];
  const listeners = new Map<string, () => void>();
  let releaseStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let finishRuntime: (() => void) | undefined;
  const runtimeFinished = new Promise<void>((resolve) => {
    finishRuntime = resolve;
  });

  const running = runProviderSourceSupervisorOnly({
    environment: sourceEnvironment(),
    fallbackWorkerId: "source-supervisor:fallback",
    dependencies: {
      createDatabaseLifecycle() {
        return {
          client: {} as PackscoutPrismaClient,
          async start() { events.push("database_started"); },
          async close() { events.push("database_closed"); },
        };
      },
      createRuntime({ configuration }) {
        assert.equal(configuration.workerId, "source-supervisor:fallback");
        assert.equal(configuration.sourceConnectionConfigurationKeyVersion, 3);
        events.push("runtime_created");
        let stopStarted = false;
        return {
          async start() {
            events.push("runtime_started");
            releaseStart?.();
            await runtimeFinished;
          },
          stop() {
            if (stopStarted) return;
            stopStarted = true;
            events.push("runtime_stopped");
            finishRuntime?.();
          },
        };
      },
      signals: {
        once(signal, listener) { listeners.set(signal, listener); },
        removeListener(signal) { listeners.delete(signal); },
      },
    },
  });

  await started;
  listeners.get("SIGTERM")?.();
  await running;

  assert.deepEqual(events, [
    "database_started",
    "runtime_created",
    "runtime_started",
    "runtime_stopped",
    "database_closed",
  ]);
  assert.equal(listeners.size, 0);
});

test("source-only cleanup joins a stop requested during runtime startup", async () => {
  const events: string[] = [];
  const listeners = new Map<string, () => void>();
  let releaseAcquire: (() => void) | undefined;
  const acquireGate = new Promise<void>((resolve) => {
    releaseAcquire = resolve;
  });
  let startEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    startEntered = resolve;
  });
  let stopPromise: Promise<void> | undefined;

  const running = runProviderSourceSupervisorOnly({
    environment: sourceEnvironment(),
    fallbackWorkerId: "source-supervisor:fallback",
    dependencies: {
      createDatabaseLifecycle() {
        return {
          client: {} as PackscoutPrismaClient,
          async start() { events.push("database_started"); },
          async close() { events.push("database_closed"); },
        };
      },
      createRuntime() {
        return {
          async start() {
            events.push("runtime_starting");
            startEntered?.();
            await acquireGate;
            events.push("runtime_start_finished");
          },
          stop() {
            stopPromise ??= acquireGate.then(() => {
              events.push("epoch_released");
            });
            return stopPromise;
          },
        };
      },
      signals: {
        once(signal, listener) { listeners.set(signal, listener); },
        removeListener(signal) { listeners.delete(signal); },
      },
    },
  });

  await entered;
  listeners.get("SIGTERM")?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["database_started", "runtime_starting"]);
  releaseAcquire?.();
  await running;
  assert.deepEqual(events, [
    "database_started",
    "runtime_starting",
    "runtime_start_finished",
    "epoch_released",
    "database_closed",
  ]);
});

test("a signal-path stop rejection is sunk and still surfaces at shutdown", async () => {
  const events: string[] = [];
  const listeners = new Map<string, () => void>();
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let startEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    startEntered = resolve;
  });
  const stopFailure = new Error("supervisor stop refused");
  let stopCalls = 0;
  let innerStop: Promise<void> | undefined;

  const running = runProviderSourceSupervisorOnly({
    environment: sourceEnvironment(),
    fallbackWorkerId: "source-supervisor:fallback",
    dependencies: {
      createDatabaseLifecycle() {
        return {
          client: {} as PackscoutPrismaClient,
          async start() { events.push("database_started"); },
          async close() { events.push("database_closed"); },
        };
      },
      createRuntime() {
        return {
          async start() {
            events.push("runtime_starting");
            startEntered?.();
            await startGate;
          },
          stop() {
            stopCalls += 1;
            // The runtime's own stop memo never resets, mirroring the real
            // supervisor: every caller joins the same failed shutdown.
            innerStop ??= Promise.reject(stopFailure);
            return innerStop;
          },
        };
      },
      signals: {
        once(signal, listener) { listeners.set(signal, listener); },
        removeListener(signal) { listeners.delete(signal); },
      },
    },
  });

  await entered;
  listeners.get("SIGTERM")?.();
  // Let the voided signal-path wrapper settle (and clear the wrapper memo)
  // before startup finishes, so the shutdown path must build a fresh wrapper.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  releaseStart?.();
  await assert.rejects(running, (error: unknown) => error === stopFailure);

  assert.equal(stopCalls, 2);
  assert.deepEqual(events, [
    "database_started",
    "runtime_starting",
    "database_closed",
  ]);
});

test("source-only bootstrap fails configuration before database startup", async () => {
  let databaseCreations = 0;
  await assert.rejects(
    runProviderSourceSupervisorOnly({
      environment: sourceEnvironment({
        PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: undefined,
      }),
      fallbackWorkerId: "source-supervisor:fallback",
      dependencies: {
        createDatabaseLifecycle() {
          databaseCreations += 1;
          throw new Error("must not create database");
        },
        createRuntime() {
          throw new Error("must not create runtime");
        },
      },
    }),
    (error: unknown) =>
      error instanceof Error
      && error.name === "ProviderSourceSupervisorConfigurationError",
  );
  assert.equal(databaseCreations, 0);
});

test("source-only bootstrap import graph excludes unrelated worker lanes", async () => {
  const files = [
    "./source-supervisor-bootstrap.ts",
    "./source-supervisor-runtime-config.ts",
  ];
  const sources = await Promise.all(
    files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")),
  );
  const imports = sources.flatMap((source) =>
    [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/gu)]
      .map((match) => match[1]),
  );

  assert.deepEqual(imports.sort(), [
    "./source-supervisor-runtime-config.ts",
    "@packscout/contracts",
    "@packscout/database",
    "node:path",
  ]);
  assert.doesNotMatch(
    imports.join("\n"),
    /convex|promotion|publication|retention/iu,
  );
  assert.doesNotMatch(
    sources.join("\n"),
    /convex|promotion|publication|retention/iu,
  );
});

test("runnable source-only graph has no publication or retention lane", async () => {
  const files = [
    "./source-supervisor-local.ts",
    "./provider-source-supervisor-composition.ts",
    "./provider-source-supervisor-executor.ts",
    "./provider-source-import-composition.ts",
  ];
  const source = (await Promise.all(
    files.map(async (file) => await readFile(new URL(file, import.meta.url), "utf8")),
  )).join("\n");
  assert.doesNotMatch(
    source,
    /convex|promotion|publication|catalogRetention|readProviderWorkerConfiguration/iu,
  );
  assert.match(source, /runProviderSourceSupervisorOnly/u);
  assert.match(source, /createProviderSourceSupervisorRuntime/u);
});

test("connection encryption key flows only into the scoped AES cipher", async () => {
  const source = await readFile(
    new URL("./provider-source-supervisor-composition.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /new AesGcmSourceConnectionConfigurationCipher/u,
  );
  assert.match(source, /uncertainOutcomeKey = input\.configuration\.actorPseudonymKey/u);
  assert.doesNotMatch(
    source,
    /createHmac\([^)]*sourceConnectionConfigurationKey/isu,
  );
});
