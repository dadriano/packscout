import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ClutchpacksCatalogCanaryError,
  computeClutchpacksCatalogCanaryTargetBinding,
  parseClutchpacksCatalogCanaryCommand,
  runClutchpacksCatalogCanary,
} from "./run-clutchpacks-catalog-canary.mjs";

const scriptPath = fileURLToPath(new URL(
  "./run-clutchpacks-catalog-canary.mjs",
  import.meta.url,
));

const BASE_ENVIRONMENT = {
    PACKSCOUT_RUNTIME_ENVIRONMENT: "preproduction",
    PACKSCOUT_CUTOVER_WORKERS_STOPPED: "YES",
    PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "preproduction-clutch-canary",
    PACKSCOUT_CLUTCHPACKS_CANARY_MAX_CYCLES: "6",
    PACKSCOUT_CLUTCHPACKS_CANARY_TIMEOUT_MS: "10000",
    PACKSCOUT_PUBLIC_ORGANIZATION_ID:
      "11111111-1111-4111-8111-111111111111",
    PACKSCOUT_DATABASE_URL:
      "postgresql://canary:database-secret@preprod-db.example.test/packscout",
    PACKSCOUT_CONVEX_PUBLICATION_BASE_URL:
      "https://preprod-convex.example.test",
};
const BASE_CONFIRMATION = computeClutchpacksCatalogCanaryTargetBinding(
  BASE_ENVIRONMENT,
).confirmation;

function environment(overrides = {}) {
  return {
    ...BASE_ENVIRONMENT,
    PACKSCOUT_CLUTCHPACKS_CANARY_CONFIRMATION: BASE_CONFIRMATION,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    configuredPlatformKeys: ["clutchpacks"],
    enabledPlatformKeys: ["clutchpacks"],
    ...overrides,
  };
}

function repairCoverage(overrides = {}) {
  return {
    sourceRevisionCount: 3n,
    completeSourceRevisionCount: 3n,
    targetSemanticSetCount: 12n,
    confirmedSemanticSetCount: 12n,
    ready: true,
    ...overrides,
  };
}

function fakeCanary({
  promotion = {},
  repair = repairCoverage(),
  states = [
    { providerComplete: false, manifestComplete: false },
    { providerComplete: false, manifestComplete: false },
    { providerComplete: true, manifestComplete: false },
    { providerComplete: true, manifestComplete: true },
  ],
  providerResult = { outcome: "progressed" },
  manifestResult = { outcome: "activated" },
  sleep,
} = {}) {
  const timeline = [];
  let stateIndex = 0;
  let timeoutCallback = null;
  const configuration = {
    provider: { databaseUrl: "postgresql://secret.invalid/preproduction" },
    promotion: {
      pollIntervalMilliseconds: 1,
      providerCredentials: [{
        platformKey: "clutchpacks",
        keyId: "must-not-be-emitted",
        secret: new Uint8Array(32).fill(7),
      }],
      ...promotion,
    },
  };
  const runtime = {
    async loadState() {
      timeline.push("state");
      const state = states[Math.min(stateIndex, states.length - 1)];
      stateIndex += 1;
      return { snapshot: snapshot(), ...state };
    },
    async runRelationshipConfirmationRepair() {
      timeline.push("repair:clutchpacks");
      return repair;
    },
    async runProviderCycle() {
      timeline.push("provider");
      return {
        snapshot: snapshot(),
        results: [{ platformKey: "clutchpacks", result: providerResult }],
      };
    },
    async runManifestCycle() {
      timeline.push("manifest");
      return { snapshot: snapshot(), result: manifestResult };
    },
  };
  return {
    timeline,
    configuration,
    runtime,
    dependencies: {
      readConfiguration() {
        timeline.push("configuration");
        return configuration;
      },
      async open() {
        timeline.push("open");
        return {
          runtime,
          async close() {
            timeline.push("close");
          },
        };
      },
      async sleep(milliseconds, signal) {
        timeline.push(`sleep:${milliseconds}`);
        if (sleep) await sleep({ signal, timeout: timeoutCallback });
      },
    },
    scheduleTimeout(callback) {
      timeoutCallback = callback;
      return "timeout-handle";
    },
    cancelTimeout(handle) {
      assert.equal(handle, "timeout-handle");
      timeline.push("cancel-timeout");
    },
  };
}

function assertCanaryError(error, expectedCode) {
  assert.ok(error instanceof ClutchpacksCatalogCanaryError);
  assert.equal(error.code, expectedCode);
  assert.doesNotMatch(error.message, /secret|must-not-be-emitted/iu);
  return true;
}

test("command requires explicit modes and exact preproduction protection", () => {
  const parsed = parseClutchpacksCatalogCanaryCommand({
    argv: ["--execute"],
    environment: environment(),
  });
  assert.equal(parsed.dryRun, false);
  assert.equal(parsed.maximumCycles, 6);
  assert.equal(parsed.timeoutMilliseconds, 10_000);
  assert.match(parsed.targetDigest, /^[0-9a-f]{64}$/u);
  assert.equal(parsed.confirmation, BASE_CONFIRMATION);

  for (const [argv, overrides, expectedCode] of [
    [["--execute", "--dry-run"], {},
      "CLUTCHPACKS_CANARY_ARGUMENT_INVALID"],
    [["--execute", "clutchpacks"], {},
      "CLUTCHPACKS_CANARY_ARGUMENT_INVALID"],
    [["--execute"], { PACKSCOUT_RUNTIME_ENVIRONMENT: "production" },
      "CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN"],
    [["--execute"], { PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "preprod-live" },
      "CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN"],
    [["--execute"], {
      PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://catalog-prod.example.test",
    }, "CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN"],
    [["--execute"], { PACKSCOUT_CUTOVER_WORKERS_STOPPED: "NO" },
      "CLUTCHPACKS_CANARY_WORKERS_NOT_STOPPED"],
    [["--execute"], { PACKSCOUT_CLUTCHPACKS_CANARY_MAX_CYCLES: "0" },
      "CLUTCHPACKS_CANARY_ARGUMENT_INVALID"],
    [["--execute"], { PACKSCOUT_CLUTCHPACKS_CANARY_CONFIRMATION: "wrong" },
      "CLUTCHPACKS_CANARY_CONFIRMATION_REQUIRED"],
  ]) {
    assert.throws(
      () => parseClutchpacksCatalogCanaryCommand({
        argv,
        environment: environment(overrides),
      }),
      (error) => assertCanaryError(error, expectedCode),
    );
  }
});

test("dry-run binds the exact targets and never starts repair or publication", async () => {
  const fake = fakeCanary();
  const output = [];
  const result = await runClutchpacksCatalogCanary({
    argv: ["--dry-run"],
    environment: environment({
      PACKSCOUT_CLUTCHPACKS_CANARY_CONFIRMATION: undefined,
    }),
    dependencies: fake.dependencies,
    writeOutput: (line) => output.push(JSON.parse(line)),
    scheduleTimeout: fake.scheduleTimeout,
    cancelTimeout: fake.cancelTimeout,
  });
  assert.equal(result.status, "planned");
  assert.equal(result.requiredConfirmation, BASE_CONFIRMATION);
  assert.match(result.targetDigest, /^[0-9a-f]{64}$/u);
  assert.equal(fake.timeline.includes("repair:clutchpacks"), false);
  assert.equal(fake.timeline.includes("provider"), false);
  assert.equal(fake.timeline.includes("manifest"), false);
  assert.deepEqual(output, [result]);

  const passwordRotation = {
    ...BASE_ENVIRONMENT,
    PACKSCOUT_DATABASE_URL:
      "postgresql://canary:rotated-secret@preprod-db.example.test/packscout",
  };
  assert.equal(
    computeClutchpacksCatalogCanaryTargetBinding(passwordRotation).targetDigest,
    result.targetDigest,
  );
  assert.notEqual(
    computeClutchpacksCatalogCanaryTargetBinding({
      ...passwordRotation,
      PACKSCOUT_CONVEX_PUBLICATION_BASE_URL:
        "https://other-preprod-convex.example.test",
    }).targetDigest,
    result.targetDigest,
  );
});

test("Clutch-only repair and durable provider completion precede manifest", async () => {
  const fake = fakeCanary();
  const output = [];
  const result = await runClutchpacksCatalogCanary({
    argv: ["--execute"],
    environment: environment(),
    dependencies: fake.dependencies,
    writeOutput: (line) => output.push(JSON.parse(line)),
    scheduleTimeout: fake.scheduleTimeout,
    cancelTimeout: fake.cancelTimeout,
  });

  assert.deepEqual(fake.timeline, [
    "configuration",
    "open",
    "state",
    "repair:clutchpacks",
    "state",
    "provider",
    "sleep:1",
    "state",
    "manifest",
    "sleep:1",
    "state",
    "cancel-timeout",
    "close",
  ]);
  assert.deepEqual(result, {
    schemaVersion: "packscout.clutchpacks-catalog-canary-result.v1",
    status: "published",
    platformCount: 1,
    relationshipSourceRevisionCount: "3",
    relationshipTargetCount: "12",
    relationshipConfirmedCount: "12",
    providerCycleCount: 1,
    manifestCycleCount: 1,
    totalCycleCount: 2,
  });
  assert.deepEqual(output, [result]);
  assert.doesNotMatch(JSON.stringify(output), /secret|must-not-be-emitted/iu);
});

test("any configured, enabled, or credential platform outside Clutch fails before repair", async () => {
  for (const variant of ["configured", "enabled", "credentials"]) {
    const fake = fakeCanary();
    if (variant === "credentials") {
      fake.configuration.promotion.providerCredentials = [{
        platformKey: "courtyard",
      }];
    } else {
      fake.runtime.loadState = async () => {
        fake.timeline.push("state");
        return {
          snapshot: snapshot({
            [`${variant}PlatformKeys`]: ["clutchpacks", "courtyard"],
          }),
          providerComplete: false,
          manifestComplete: false,
        };
      };
    }
    await assert.rejects(
      runClutchpacksCatalogCanary({
        argv: ["--execute"],
        environment: environment(),
        dependencies: fake.dependencies,
        writeOutput() {},
        scheduleTimeout: fake.scheduleTimeout,
        cancelTimeout: fake.cancelTimeout,
      }),
      (error) => assertCanaryError(
        error,
        "CLUTCHPACKS_CANARY_PLATFORM_SCOPE_INVALID",
      ),
    );
    assert.equal(fake.timeline.includes("repair:clutchpacks"), false);
    assert.equal(fake.timeline.includes("provider"), false);
    assert.equal(fake.timeline.includes("manifest"), false);
    assert.equal(fake.timeline.at(-1), "close");
  }
});

test("incomplete aggregate repair proof blocks every catalog lane", async () => {
  const fake = fakeCanary({
    repair: repairCoverage({
      completeSourceRevisionCount: 2n,
      confirmedSemanticSetCount: 11n,
      ready: false,
    }),
  });
  await assert.rejects(
    runClutchpacksCatalogCanary({
      argv: ["--execute"],
      environment: environment(),
      dependencies: fake.dependencies,
      writeOutput() {},
      scheduleTimeout: fake.scheduleTimeout,
      cancelTimeout: fake.cancelTimeout,
    }),
    (error) => assertCanaryError(
      error,
      "CLUTCHPACKS_CANARY_RELATIONSHIP_REPAIR_INCOMPLETE",
    ),
  );
  assert.equal(fake.timeline.includes("provider"), false);
  assert.equal(fake.timeline.includes("manifest"), false);
});

test("cycle and time limits stop without starting a premature manifest", async () => {
  const capped = fakeCanary({
    states: [
      { providerComplete: false, manifestComplete: false },
      { providerComplete: false, manifestComplete: false },
    ],
  });
  await assert.rejects(
    runClutchpacksCatalogCanary({
      argv: ["--execute"],
      environment: environment({
        PACKSCOUT_CLUTCHPACKS_CANARY_MAX_CYCLES: "1",
      }),
      dependencies: capped.dependencies,
      writeOutput() {},
      scheduleTimeout: capped.scheduleTimeout,
      cancelTimeout: capped.cancelTimeout,
    }),
    (error) => assertCanaryError(
      error,
      "CLUTCHPACKS_CANARY_CYCLE_LIMIT",
    ),
  );
  assert.equal(capped.timeline.filter((item) => item === "provider").length, 1);
  assert.equal(capped.timeline.includes("manifest"), false);

  const timed = fakeCanary({
    states: [
      { providerComplete: false, manifestComplete: false },
      { providerComplete: false, manifestComplete: false },
    ],
    sleep: ({ timeout }) => timeout(),
  });
  await assert.rejects(
    runClutchpacksCatalogCanary({
      argv: ["--execute"],
      environment: environment(),
      dependencies: timed.dependencies,
      writeOutput() {},
      scheduleTimeout: timed.scheduleTimeout,
      cancelTimeout: timed.cancelTimeout,
    }),
    (error) => assertCanaryError(error, "CLUTCHPACKS_CANARY_TIMEOUT"),
  );
  assert.equal(timed.timeline.includes("manifest"), false);
});

test("stable lane failures are reduced to canary codes and close cleanly", async () => {
  const fake = fakeCanary({
    providerResult: {
      outcome: "failed",
      failureCode: "SECRET_PROVIDER_FAILURE",
      providerPayload: "must-not-be-emitted",
    },
  });
  await assert.rejects(
    runClutchpacksCatalogCanary({
      argv: ["--execute"],
      environment: environment(),
      dependencies: fake.dependencies,
      writeOutput() {},
      scheduleTimeout: fake.scheduleTimeout,
      cancelTimeout: fake.cancelTimeout,
    }),
    (error) => assertCanaryError(
      error,
      "CLUTCHPACKS_CANARY_PROVIDER_FAILED",
    ),
  );
  assert.equal(fake.timeline.includes("manifest"), false);
  assert.equal(fake.timeline.at(-1), "close");

  const execution = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--execute"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PACKSCOUT_RUNTIME_ENVIRONMENT: "production",
        PACKSCOUT_CUTOVER_WORKERS_STOPPED: "YES",
        PACKSCOUT_DATABASE_URL:
          "postgresql://operator:database-secret@example.invalid/live",
      },
      timeout: 20_000,
    },
  );
  assert.equal(execution.status, 1, execution.stderr);
  assert.equal(execution.stdout, "");
  assert.deepEqual(JSON.parse(execution.stderr), {
    schemaVersion: "packscout.clutchpacks-catalog-canary-result.v1",
    status: "failed",
    failureCode: "CLUTCHPACKS_CANARY_ENVIRONMENT_FORBIDDEN",
  });
  assert.doesNotMatch(execution.stderr, /database-secret|example\.invalid/iu);
});

test("canary composition cannot construct Heat, retention, supervisor, or combined worker", async () => {
  const [composition, script] = await Promise.all([
    readFile(new URL(
      "../../apps/worker/src/clutchpacks-catalog-canary-composition.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("./run-clutchpacks-catalog-canary.mjs", import.meta.url),
      "utf8"),
  ]);
  const source = `${composition}\n${script}`;
  assert.match(source, /createPromotionV2WorkerRuntime/u);
  assert.match(source, /platformKeys:\s*\[CLUTCHPACKS_PLATFORM_KEY\]/u);
  assert.match(script, /readProviderWorkerSharedConfiguration/u);
  assert.doesNotMatch(script, /readProviderWorkerConfiguration\(/u);
  assert.doesNotMatch(source, /createProductionWorkerRuntime/u);
  assert.doesNotMatch(source, /PrismaNormalizedHeat/u);
  assert.doesNotMatch(source, /CatalogRetention/u);
  assert.doesNotMatch(source, /ProviderSourceSupervisor/u);
  assert.doesNotMatch(source, /createProviderWorkerRuntime/u);
});
