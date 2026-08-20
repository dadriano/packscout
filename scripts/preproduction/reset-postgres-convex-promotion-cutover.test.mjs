import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildProtectedSnapshot,
  buildConvexCommandEnvironment,
  computeDatabaseTargetDigest,
  CONVEX_CATALOG_RESET_TABLES,
  CONVEX_HEAT_RESET_TABLES,
  CONVEX_RESET_TABLES,
  createPostgresCutoverDatabaseFromPool,
  CutoverResetError,
  parseCutoverConfiguration,
  POSTGRES_DELETE_STEPS,
  PRESERVED_CONVEX_TABLES,
  PROTECTED_POSTGRES_TABLES,
  runCutoverReset,
} from "./reset-postgres-convex-promotion-cutover.mjs";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const DATABASE_URL =
  "postgresql://cutover:database-secret@preprod-db.example.test/packscout_preprod?sslmode=require";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validEnvironment(overrides = {}) {
  return {
    PACKSCOUT_CUTOVER_ENVIRONMENT: "preproduction",
    PACKSCOUT_CUTOVER_DATABASE_ENVIRONMENT: "preproduction",
    PACKSCOUT_CUTOVER_ORGANIZATION_ID: ORGANIZATION_ID,
    PACKSCOUT_CUTOVER_DEPLOYMENT_KEY: "preproduction-west",
    PACKSCOUT_CUTOVER_CONVEX_DEPLOYMENT:
      "packscout-team:packscout-app:preproduction",
    PACKSCOUT_CUTOVER_DATABASE_TARGET_SHA256:
      computeDatabaseTargetDigest(DATABASE_URL),
    PACKSCOUT_CUTOVER_APPROVAL_REFERENCE: "CUTOVER-314",
    PACKSCOUT_CUTOVER_WORKERS_STOPPED: "YES",
    PACKSCOUT_CUTOVER_EVIDENCE_FILE: "/tmp/packscout-cutover/evidence.jsonl",
    PACKSCOUT_CUTOVER_BACKUP_DIRECTORY: "/tmp/packscout-cutover/backups",
    PACKSCOUT_DATABASE_URL: DATABASE_URL,
    ...overrides,
  };
}

function dryRunConfiguration(overrides = {}) {
  return parseCutoverConfiguration({
    argv: [],
    environment: validEnvironment(overrides),
  });
}

function executeConfiguration(overrides = {}) {
  const environment = validEnvironment(overrides);
  const planned = parseCutoverConfiguration({ argv: [], environment });
  environment.PACKSCOUT_CUTOVER_CONFIRMATION = planned.confirmation;
  return parseCutoverConfiguration({ argv: ["--execute"], environment });
}

function testProtectedSnapshot(label = "same") {
  return buildProtectedSnapshot(
    PROTECTED_POSTGRES_TABLES.map((table, index) => ({
      table,
      rowCount: String(index + 1),
      digest: digest(`${label}:${table}`),
    })),
  );
}

function fakeRuntime({
  commandFailureIndex = null,
  preflightError = null,
  resetError = null,
  resetSnapshot = null,
  verifyBackupError = null,
} = {}) {
  const timeline = [];
  const commands = [];
  const evidenceRecords = [];
  const snapshot = testProtectedSnapshot();
  let commandIndex = 0;
  let resetCalls = 0;
  let clockTick = 0;

  return {
    timeline,
    commands,
    evidenceRecords,
    get resetCalls() {
      return resetCalls;
    },
    dependencies: {
      clock() {
        clockTick += 1;
        return new Date(Date.UTC(2026, 7, 18, 12, 0, clockTick));
      },
      evidence: {
        async append(record) {
          timeline.push(`evidence:${record.stage}`);
          evidenceRecords.push(record);
        },
      },
      commands: {
        async run(command, args) {
          timeline.push(
            args.includes("export")
              ? "command:export"
              : `command:import:${args[args.indexOf("--table") + 1]}`,
          );
          commands.push({ command, args });
          const currentIndex = commandIndex;
          commandIndex += 1;
          if (currentIndex === commandFailureIndex) {
            throw new Error(
              "raw command failure: provider-row-secret deployment-secret",
            );
          }
        },
      },
      artifacts: {
        async prepare() {
          timeline.push("artifacts:prepare");
          return {
            temporaryDirectory: "/private/tmp/provider-row-secret",
            emptyFile: "/private/tmp/provider-row-secret/empty.json",
            backupFile: "/private/backups/deployment-secret.zip",
          };
        },
        async verifyBackup() {
          timeline.push("artifacts:verify-backup");
          if (verifyBackupError) throw verifyBackupError;
          return { byteLength: "4096", sha256: digest("verified-backup") };
        },
        async cleanup() {
          timeline.push("artifacts:cleanup");
        },
      },
      database: {
        async preflight(scope) {
          timeline.push("database:preflight");
          assert.equal(scope.organizationId, ORGANIZATION_ID);
          if (preflightError) throw preflightError;
          return {
            safety: {
              organizationFound: true,
              targetLaneCount: "2",
              targetAttemptCount: "5",
              targetOperationCount: "13",
              liveClaimCount: "0",
              sentOperationCount: "0",
            },
            protectedSnapshot: snapshot,
          };
        },
        async reset(scope, expectedPreflight) {
          timeline.push("database:reset");
          resetCalls += 1;
          assert.equal(scope.deploymentKey, "preproduction-west");
          assert.equal(
            expectedPreflight.protectedSnapshot.combinedDigest,
            snapshot.combinedDigest,
          );
          if (resetError) throw resetError;
          return {
            deleted: {
              promotion_operations: "13",
              promotion_attempts: "5",
              promotion_lanes: "2",
            },
            protectedSnapshot: resetSnapshot ?? snapshot,
          };
        },
        async close() {
          timeline.push("database:close");
        },
      },
    },
  };
}

function assertCutoverError(error, expectedCode) {
  assert.ok(error instanceof CutoverResetError);
  assert.equal(error.code, expectedCode);
  assert.equal(error.message.includes("database-secret"), false);
  return true;
}

test("reset allowlists exactly the obsolete catalog and seven Heat tables", () => {
  assert.equal(CONVEX_CATALOG_RESET_TABLES.length, 14);
  assert.equal(CONVEX_HEAT_RESET_TABLES.length, 7);
  assert.equal(CONVEX_RESET_TABLES.length, 21);
  assert.equal(new Set(CONVEX_RESET_TABLES).size, CONVEX_RESET_TABLES.length);
  assert.deepEqual(
    new Set(CONVEX_RESET_TABLES),
    new Set([...CONVEX_CATALOG_RESET_TABLES, ...CONVEX_HEAT_RESET_TABLES]),
  );
  assert.deepEqual(PRESERVED_CONVEX_TABLES, ["dataReleaseAuthNonces"]);
  assert.equal(CONVEX_RESET_TABLES.includes("dataReleaseAuthNonces"), false);
  assert.equal(CONVEX_RESET_TABLES.includes("providerReleases"), false);
  assert.equal(CONVEX_RESET_TABLES.includes("catalogManifests"), false);
});

test("configuration defaults to dry-run and rejects ambiguous CLI modes", () => {
  const configuration = dryRunConfiguration();
  assert.equal(configuration.dryRun, true);
  assert.match(
    configuration.confirmation,
    /^RESET PREPRODUCTION [0-9a-f]{16}$/u,
  );

  for (const argv of [
    ["--prod"],
    ["--execute", "--dry-run"],
    ["--dry-run", "--dry-run"],
  ]) {
    assert.throws(
      () =>
        parseCutoverConfiguration({ argv, environment: validEnvironment() }),
      (error) => assertCutoverError(error, "CUTOVER_ARGUMENT_INVALID"),
    );
  }
});

test("Convex child commands do not inherit database or cutover secrets", () => {
  const childEnvironment = buildConvexCommandEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    HTTPS_PROXY: "http://proxy.example.test",
    PACKSCOUT_DATABASE_URL: DATABASE_URL,
    PACKSCOUT_CUTOVER_CONFIRMATION: "target-bound-secret",
    CONVEX_DEPLOY_KEY: "deployment-secret",
    NODE_OPTIONS: "--import=/private/secret-hook.mjs",
    API_TOKEN: "api-secret",
  });
  assert.deepEqual(childEnvironment, {
    PATH: "/safe/bin",
    HOME: "/safe/home",
    HTTPS_PROXY: "http://proxy.example.test",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  });
});

test("configuration refuses production and non-attested targets", () => {
  const cases = [
    {
      overrides: { PACKSCOUT_CUTOVER_ENVIRONMENT: "production" },
      code: "CUTOVER_ENVIRONMENT_FORBIDDEN",
    },
    {
      overrides: { PACKSCOUT_CUTOVER_DATABASE_ENVIRONMENT: "live" },
      code: "CUTOVER_ENVIRONMENT_FORBIDDEN",
    },
    {
      overrides: { NODE_ENV: "production" },
      code: "CUTOVER_ENVIRONMENT_FORBIDDEN",
    },
    {
      overrides: { PACKSCOUT_CUTOVER_CONVEX_DEPLOYMENT: "prod" },
      code: "CUTOVER_TARGET_INVALID",
    },
    {
      overrides: {
        PACKSCOUT_CUTOVER_CONVEX_DEPLOYMENT: "team:project:prod",
      },
      code: "CUTOVER_TARGET_INVALID",
    },
    {
      overrides: { CONVEX_DEPLOY_KEY: "prod:secret|secret" },
      code: "CUTOVER_TARGET_INVALID",
    },
    {
      overrides: {
        PACKSCOUT_DATABASE_URL:
          "postgresql://cutover:secret@prod-db.example.test/packscout",
      },
      code: "CUTOVER_ENVIRONMENT_FORBIDDEN",
    },
    {
      overrides: {
        PACKSCOUT_CUTOVER_DATABASE_TARGET_SHA256: "0".repeat(64),
      },
      code: "CUTOVER_TARGET_DIGEST_MISMATCH",
    },
  ];

  for (const { overrides, code } of cases) {
    assert.throws(
      () =>
        parseCutoverConfiguration({
          argv: [],
          environment: validEnvironment(overrides),
        }),
      (error) => assertCutoverError(error, code),
    );
  }
});

test("execution requires stopped workers and the exact target-bound confirmation", () => {
  assert.throws(
    () =>
      parseCutoverConfiguration({
        argv: [],
        environment: validEnvironment({
          PACKSCOUT_CUTOVER_WORKERS_STOPPED: "no",
        }),
      }),
    (error) => assertCutoverError(error, "CUTOVER_WORKER_ATTESTATION_REQUIRED"),
  );

  assert.throws(
    () =>
      parseCutoverConfiguration({
        argv: ["--execute"],
        environment: validEnvironment({
          PACKSCOUT_CUTOVER_CONFIRMATION: "RESET PREPRODUCTION",
        }),
      }),
    (error) => assertCutoverError(error, "CUTOVER_CONFIRMATION_REQUIRED"),
  );
  assert.equal(executeConfiguration().dryRun, false);
});

test("dry-run inspects safety and protected state without backup or mutation", async () => {
  const runtime = fakeRuntime();
  const result = await runCutoverReset(
    dryRunConfiguration(),
    runtime.dependencies,
  );

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.stage, "dry_run_complete");
  assert.equal(runtime.commands.length, 0);
  assert.equal(runtime.resetCalls, 0);
  assert.equal(runtime.timeline.includes("artifacts:prepare"), false);
  assert.deepEqual(
    runtime.evidenceRecords.map(({ stage }) => stage),
    ["validated", "preflight_complete", "dry_run_complete"],
  );
  assert.equal(runtime.timeline.at(-1), "database:close");
});

test("execute backs up Convex, clears only allowlisted tables, then resets PostgreSQL", async () => {
  const runtime = fakeRuntime();
  const result = await runCutoverReset(
    executeConfiguration(),
    runtime.dependencies,
  );

  assert.equal(result.stage, "complete");
  assert.equal(runtime.commands.length, CONVEX_RESET_TABLES.length + 1);
  assert.deepEqual(runtime.commands[0].args.slice(0, 3), [
    "--no-install",
    "convex",
    "export",
  ]);
  assert.equal(runtime.commands[0].args.includes("--prod"), false);

  const importedTables = runtime.commands.slice(1).map(({ command, args }) => {
    assert.equal(command, "npx");
    assert.equal(args.includes("--replace"), true);
    assert.equal(args.includes("--replace-all"), false);
    assert.equal(args.includes("--yes"), true);
    assert.equal(args.includes("--prod"), false);
    assert.equal(
      args[args.indexOf("--deployment") + 1].endsWith("preproduction"),
      true,
    );
    return args[args.indexOf("--table") + 1];
  });
  assert.deepEqual(importedTables, CONVEX_RESET_TABLES);
  assert.equal(importedTables.includes("dataReleaseAuthNonces"), false);

  const firstImport = runtime.timeline.findIndex((entry) =>
    entry.startsWith("command:import:"),
  );
  const lastImport = runtime.timeline.findLastIndex((entry) =>
    entry.startsWith("command:import:"),
  );
  assert.ok(runtime.timeline.indexOf("command:export") < firstImport);
  assert.ok(runtime.timeline.indexOf("artifacts:verify-backup") < firstImport);
  assert.ok(runtime.timeline.indexOf("database:reset") > lastImport);
  assert.deepEqual(result.postgresDeleted, {
    promotion_operations: "13",
    promotion_attempts: "5",
    promotion_lanes: "2",
  });
});

test("a backup failure stops before every destructive command", async () => {
  const runtime = fakeRuntime({
    commandFailureIndex: 0,
  });
  await assert.rejects(
    runCutoverReset(executeConfiguration(), runtime.dependencies),
    (error) => assertCutoverError(error, "CUTOVER_CONVEX_BACKUP_FAILED"),
  );
  assert.equal(runtime.commands.length, 1);
  assert.equal(runtime.resetCalls, 0);
  assert.equal(
    runtime.evidenceRecords.some(({ stage }) => stage === "recovery_required"),
    false,
  );
  assert.equal(runtime.evidenceRecords.at(-1).stage, "failed");
});

test("a failure after Convex cleanup emits recovery-required evidence", async () => {
  const runtime = fakeRuntime({ commandFailureIndex: 2 });
  await assert.rejects(
    runCutoverReset(executeConfiguration(), runtime.dependencies),
    (error) => assertCutoverError(error, "CUTOVER_RECOVERY_REQUIRED"),
  );
  assert.equal(runtime.resetCalls, 0);
  const recovery = runtime.evidenceRecords.at(-1);
  assert.equal(recovery.stage, "recovery_required");
  assert.equal(recovery.clearedTableCount, 1);
  assert.equal(recovery.postgresResetStarted, false);
  assert.equal(recovery.backup.sha256, digest("verified-backup"));
});

test("public results, evidence, and failures redact every raw target and row value", async () => {
  const runtime = fakeRuntime();
  const configuration = executeConfiguration();
  const result = await runCutoverReset(configuration, runtime.dependencies);
  const serializedPublicArtifacts = JSON.stringify({
    result,
    evidence: runtime.evidenceRecords,
  });
  for (const sensitiveValue of [
    ORGANIZATION_ID,
    "preproduction-west",
    "packscout-team:packscout-app:preproduction",
    "preprod-db.example.test",
    "packscout_preprod",
    "database-secret",
    "provider-row-secret",
    "/private/backups/deployment-secret.zip",
  ]) {
    assert.equal(serializedPublicArtifacts.includes(sensitiveValue), false);
  }

  const failingRuntime = fakeRuntime({
    preflightError: new Error(
      `${ORGANIZATION_ID} provider-row-secret ${DATABASE_URL}`,
    ),
  });
  let publicFailure;
  try {
    await runCutoverReset(dryRunConfiguration(), failingRuntime.dependencies);
  } catch (error) {
    publicFailure = { code: error.code, message: error.message };
  }
  const serializedFailure = JSON.stringify({
    publicFailure,
    evidence: failingRuntime.evidenceRecords,
  });
  assert.equal(serializedFailure.includes(ORGANIZATION_ID), false);
  assert.equal(serializedFailure.includes("provider-row-secret"), false);
  assert.equal(serializedFailure.includes("database-secret"), false);
});

function fakePostgresPool({
  mutateProtectedAfterDelete = false,
  safety = {},
} = {}) {
  const queries = [];
  let deleteStarted = false;
  const client = {
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      if (text.includes("cutover:database-identity")) {
        return {
          rows: [
            {
              database_name: "packscout_preprod",
              database_user: "cutover",
            },
          ],
        };
      }
      if (text.includes("cutover:required-schema")) return { rows: [] };
      if (text.includes("cutover:safety")) {
        const residual = deleteStarted;
        return {
          rows: [
            {
              organization_found: safety.organizationFound ?? true,
              target_lane_count: residual
                ? "0"
                : (safety.targetLaneCount ?? "2"),
              target_attempt_count: residual
                ? "0"
                : (safety.targetAttemptCount ?? "4"),
              target_operation_count: residual
                ? "0"
                : (safety.targetOperationCount ?? "9"),
              live_claim_count: residual ? "0" : (safety.liveClaimCount ?? "0"),
              sent_operation_count: residual
                ? "0"
                : (safety.sentOperationCount ?? "0"),
            },
          ],
        };
      }
      const protectedMatch = /cutover:protected:([a-z_]+)/u.exec(text);
      if (protectedMatch) {
        const changed =
          mutateProtectedAfterDelete &&
          deleteStarted &&
          protectedMatch[1] === PROTECTED_POSTGRES_TABLES[0];
        return {
          rows: [
            {
              row_count: "7",
              content_md5: changed ? "b".repeat(32) : "a".repeat(32),
            },
          ],
        };
      }
      const deleteMatch = /cutover:delete:([a-z_]+)/u.exec(text);
      if (deleteMatch) {
        deleteStarted = true;
        const rowCounts = {
          promotion_operations: 9,
          promotion_attempts: 4,
          promotion_lanes: 2,
        };
        return { rows: [], rowCount: rowCounts[deleteMatch[1]] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      queries.push("CLIENT RELEASE");
    },
  };
  return {
    queries,
    pool: {
      async connect() {
        return client;
      },
      async end() {
        queries.push("POOL END");
      },
    },
  };
}

test("PostgreSQL reset deletes operations, attempts, then lanes and commits after invariants", async () => {
  const fake = fakePostgresPool();
  const database = createPostgresCutoverDatabaseFromPool(fake.pool, {
    databaseName: "packscout_preprod",
    databaseUser: "cutover",
  });
  const scope = {
    organizationId: ORGANIZATION_ID,
    deploymentKey: "preproduction-west",
  };
  const preflight = await database.preflight(scope);
  const result = await database.reset(scope, preflight);

  assert.deepEqual(result.deleted, {
    promotion_operations: "9",
    promotion_attempts: "4",
    promotion_lanes: "2",
  });
  const deleteOrder = fake.queries
    .map((query) => /cutover:delete:([a-z_]+)/u.exec(query)?.[1])
    .filter(Boolean);
  assert.deepEqual(
    deleteOrder,
    POSTGRES_DELETE_STEPS.map(({ name }) => name),
  );
  assert.equal(
    fake.queries.some((query) => /\bTRUNCATE\b/iu.test(query)),
    false,
  );
  const lastProtectedQuery = fake.queries.findLastIndex((query) =>
    query.includes("cutover:protected:"),
  );
  const finalCommit = fake.queries.findLastIndex((query) => query === "COMMIT");
  assert.ok(lastProtectedQuery < finalCommit);
  assert.equal(fake.queries.filter((query) => query === "COMMIT").length, 2);
  assert.equal(fake.queries.includes("ROLLBACK"), false);
  assert.ok(
    fake.queries.findIndex((query) =>
      query.includes("cutover:lock:protected"),
    ) < fake.queries.findIndex((query) => query.includes("cutover:delete:")),
  );
});

test("PostgreSQL reset rolls back when a protected digest changes", async () => {
  const fake = fakePostgresPool({ mutateProtectedAfterDelete: true });
  const database = createPostgresCutoverDatabaseFromPool(fake.pool, {
    databaseName: "packscout_preprod",
    databaseUser: "cutover",
  });
  const scope = {
    organizationId: ORGANIZATION_ID,
    deploymentKey: "preproduction-west",
  };
  const preflight = await database.preflight(scope);
  await assert.rejects(database.reset(scope, preflight), (error) =>
    assertCutoverError(error, "CUTOVER_PROTECTED_STATE_CHANGED"),
  );
  assert.equal(fake.queries.filter((query) => query === "COMMIT").length, 1);
  assert.equal(fake.queries.includes("ROLLBACK"), true);
});

test("PostgreSQL preflight refuses live claims, sent operations, and wrong bindings", async () => {
  for (const [safety, code] of [
    [{ liveClaimCount: "1" }, "CUTOVER_LIVE_WORK_PRESENT"],
    [{ sentOperationCount: "1" }, "CUTOVER_LIVE_WORK_PRESENT"],
    [{ organizationFound: false }, "CUTOVER_TARGET_BINDING_NOT_FOUND"],
    [{ targetLaneCount: "0" }, "CUTOVER_TARGET_BINDING_NOT_FOUND"],
    [{ targetLaneCount: "1" }, "CUTOVER_TARGET_BINDING_NOT_FOUND"],
  ]) {
    const fake = fakePostgresPool({ safety });
    const database = createPostgresCutoverDatabaseFromPool(fake.pool, {
      databaseName: "packscout_preprod",
      databaseUser: "cutover",
    });
    await assert.rejects(
      database.preflight({
        organizationId: ORGANIZATION_ID,
        deploymentKey: "preproduction-west",
      }),
      (error) => assertCutoverError(error, code),
    );
    assert.equal(
      fake.queries.some((query) => query.includes("cutover:protected:")),
      false,
    );
  }
});
