import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TASK010_PROVIDER_IDENTITIES,
  TASK010_BACKFILL_RECORDS_PER_REQUEST,
  TASK010_REQUIRED_MIGRATION,
  TASK010_SAFETY_VERSION,
  TASK010_SOURCE_EXECUTION_SLOTS,
  Task010SafetyError,
  assessTask010ProviderReconciliation,
  assertBootstrapPasswordAbsent,
  assertEvidenceTokenAbsent,
  assertNoTask010Arguments,
  assertTask010BackfillTopologySnapshot,
  assertTask010BootstrapSnapshot,
  assertTask010DatabaseIdentity,
  assertTask010VolumeBinding,
  loadTask010EnvironmentFile,
  readTask010Environment,
  safeTask010Failure,
  sanitizedTask010WorkerEnvironment,
  task010PageRecordCount,
  task010DatabaseIdentity,
  task010ConfigurationCapacityDecision,
  task010MigrationInvocation,
} from "./provider-source-task010-safety.mjs";

const secret = "task010-test-secret-that-is-never-printed";
const key = Buffer.alloc(32, 7).toString("base64");
const baseEnvironment = Object.freeze({
  NODE_ENV: "development",
  PACKSCOUT_TASK010_LOCAL_ACK: "I_UNDERSTAND_THIS_TARGET_IS_LOCAL_AND_EMPTY",
  PACKSCOUT_TASK010_DATABASE_NAME: "packscout_dataforest_task010",
  PACKSCOUT_DATABASE_URL:
    "postgresql://packscout:password@127.0.0.1:5432/packscout_dataforest_task010",
  PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH: "/var/local/packscout-task010",
  PACKSCOUT_TASK010_ORGANIZATION_ID: "5aef23b7-bcf4-4d58-bb88-6285782a7d55",
  PACKSCOUT_TASK010_ORGANIZATION_SLUG: "packscout-task010-local",
  PACKSCOUT_TASK010_ORGANIZATION_NAME: "PackScout Task 010 Local",
  PACKSCOUT_TASK010_ADMIN_ID: "ae514480-dc08-4a5c-beb0-22aa59a60052",
  PACKSCOUT_TASK010_ADMIN_EMAIL: "admin@example.invalid",
  PACKSCOUT_TASK010_ADMIN_DISPLAY_NAME: "Local Source Administrator",
  PACKSCOUT_SESSION_HASHING_SECRET: secret,
  PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64: key,
  PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64: key,
  PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION: "1",
});

function expectedEnvironment() {
  return readTask010Environment(baseEnvironment);
}

test("Task010 required migration marker matches the terminal schema", async () => {
  const migrationsRoot = new URL(
    "../../packages/database/prisma/migrations/",
    import.meta.url,
  );
  const migrationNames = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const terminalMigration = migrationNames.at(-1);
  assert.ok(terminalMigration, "expected at least one Prisma migration");
  const migrationSql = await readFile(
    new URL(`${terminalMigration}/migration.sql`, migrationsRoot),
  );
  const migrationChecksum = createHash("sha256")
    .update(migrationSql)
    .digest("hex");
  const schemaParityManifest = JSON.parse(
    await readFile(
      new URL(
        "../../packages/database/prisma/schema-parity-manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  assert.deepEqual(TASK010_REQUIRED_MIGRATION, {
    name: terminalMigration,
    checksum: migrationChecksum,
    tableCount: Object.keys(schemaParityManifest.tables).length,
  });
});

test("Task010 environment rejects broad, remote, production, and argument-bearing targets", () => {
  for (const patch of [
    { PACKSCOUT_TASK010_DATABASE_NAME: "postgres" },
    {
      PACKSCOUT_DATABASE_URL:
        "postgresql://packscout:password@db.example.invalid:5432/packscout_dataforest_task010",
    },
    { NODE_ENV: "production" },
  ]) {
    assert.throws(
      () => readTask010Environment({ ...baseEnvironment, ...patch }),
      Task010SafetyError,
    );
  }
  assert.throws(
    () => assertNoTask010Arguments(["--database-url", secret]),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "COMMAND_ARGUMENTS_FORBIDDEN",
  );
  assert.throws(
    () =>
      assertBootstrapPasswordAbsent({
        PACKSCOUT_TASK010_ADMIN_PASSWORD: "",
      }),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "BOOTSTRAP_PASSWORD_PRESENT",
  );
  assert.throws(
    () => assertEvidenceTokenAbsent({ PACKSCOUT_DATA_API_TOKEN: "" }),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "PLAINTEXT_EVIDENCE_TOKEN_PRESENT",
  );
  for (const patch of [
    { PACKSCOUT_TASK010_ADMIN_EMAIL: "REPLACE_WITH_LOCAL_ADMIN_EMAIL" },
    { PACKSCOUT_TASK010_ADMIN_EMAIL: "not-an-email" },
  ]) {
    assert.throws(
      () => readTask010Environment({ ...baseEnvironment, ...patch }),
      (error) =>
        error instanceof Task010SafetyError &&
        error.code === "ADMIN_EMAIL_INVALID",
    );
  }
  assert.throws(
    () =>
      readTask010Environment(
        {
          ...baseEnvironment,
          PACKSCOUT_TASK010_ADMIN_PASSWORD: "replace_from_password_manager",
        },
        { requireAdministratorPassword: true },
      ),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "ADMIN_PASSWORD_INVALID",
  );
});

test("Task010 environment loader requires an owned regular private file", async (context) => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "packscout-task010-env-"));
  context.after(async () => {
    await rm(testRoot, { recursive: true });
  });
  const environmentPath = path.join(testRoot, ".env.task010.local");
  await writeFile(environmentPath, "EXAMPLE=value\n", { mode: 0o600 });
  assert.deepEqual(await loadTask010EnvironmentFile(testRoot), {
    EXAMPLE: "value",
  });

  await chmod(environmentPath, 0o644);
  await assert.rejects(
    loadTask010EnvironmentFile(testRoot),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "TASK010_ENVIRONMENT_FILE_UNSAFE",
  );

  await rm(environmentPath);
  const realEnvironmentPath = path.join(testRoot, "private.env");
  await writeFile(realEnvironmentPath, "EXAMPLE=value\n", { mode: 0o600 });
  await symlink(realEnvironmentPath, environmentPath);
  await assert.rejects(
    loadTask010EnvironmentFile(testRoot),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "TASK010_ENVIRONMENT_FILE_UNSAFE",
  );
});

test("capacity volume must be the database data directory or its same-device ancestor", () => {
  assert.doesNotThrow(() =>
    assertTask010VolumeBinding({
      configuredPath: "/srv/postgres",
      dataDirectoryPath: "/srv/postgres/data",
      configuredDevice: "42",
      dataDirectoryDevice: "42",
      separator: "/",
    }),
  );
  for (const input of [
    {
      configuredPath: "/large-unrelated-volume",
      dataDirectoryPath: "/srv/postgres/data",
      configuredDevice: "42",
      dataDirectoryDevice: "42",
      separator: "/",
    },
    {
      configuredPath: "/srv/postgres",
      dataDirectoryPath: "/srv/postgres/data",
      configuredDevice: "41",
      dataDirectoryDevice: "42",
      separator: "/",
    },
  ]) {
    assert.throws(
      () => assertTask010VolumeBinding(input),
      (error) =>
        error instanceof Task010SafetyError &&
        error.code === "CAPACITY_VOLUME_NOT_DATABASE_BACKING",
    );
  }
});

test("database identity is bound to immutable target identity, not server version", () => {
  const identity = {
    databaseName: "packscout_dataforest_task010",
    databaseOid: "16432",
    systemIdentifier: "7541020403012209001",
    serverAddress: "127.0.0.1",
    serverPort: 5432,
    serverVersion: "16.6",
  };
  const fingerprint = task010DatabaseIdentity(identity);
  assert.equal(
    assertTask010DatabaseIdentity(identity, {
      expectedDatabaseName: identity.databaseName,
      expectedDatabaseIdentity: fingerprint,
    }),
    fingerprint,
  );
  assert.equal(
    task010DatabaseIdentity({ ...identity, serverVersion: "16.99" }),
    fingerprint,
  );
  assert.notEqual(
    task010DatabaseIdentity({ ...identity, databaseOid: "16433" }),
    fingerprint,
  );
  assert.throws(
    () =>
      assertTask010DatabaseIdentity(
        { ...identity, systemIdentifier: "7541020403012209002" },
        {
          expectedDatabaseName: identity.databaseName,
          expectedDatabaseIdentity: fingerprint,
        },
      ),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "DATABASE_IDENTITY_FINGERPRINT_MISMATCH",
  );
});

test("bootstrap receipt requires exact roots and capacity/schema identity", () => {
  const environment = expectedEnvironment();
  const databaseIdentity = "task010-db:v1:fixture";
  const snapshot = {
    markerCount: 1,
    markerMetadata: {
      version: TASK010_SAFETY_VERSION,
      databaseIdentity,
      migrationName: TASK010_REQUIRED_MIGRATION.name,
      migrationChecksum: TASK010_REQUIRED_MIGRATION.checksum,
      capacityArtifactVersion: "provider-source-capacity-measurement-v1",
      capacityDecision: "approved",
      capacityVolumePath: "/var/local/packscout-task010",
      capacityDatabaseDataDirectory: "/var/local/packscout-task010/pgdata",
      capacityVolumeDevice: "42",
    },
    organizations: [
      {
        id: environment.organizationId,
        slug: environment.organizationSlug,
      },
    ],
    administrators: [
      {
        id: environment.administratorId,
        organizationId: environment.organizationId,
        email: environment.administratorEmail,
        role: "admin",
        state: "active",
      },
    ],
    providers: TASK010_PROVIDER_IDENTITIES.map((provider) => ({
      ...provider,
      organizationId: environment.organizationId,
      state: "active",
      activeRevisionId: null,
      nextRunAt: null,
    })),
  };
  const capacityReceipt = {
    volumePath: "/var/local/packscout-task010",
    databaseDataDirectory: "/var/local/packscout-task010/pgdata",
    volumeDevice: "42",
  };
  assert.doesNotThrow(() =>
    assertTask010BootstrapSnapshot(snapshot, {
      ...environment,
      databaseIdentity,
      capacityReceipt,
    }),
  );
  assert.throws(
    () =>
      assertTask010BootstrapSnapshot(
        {
          ...snapshot,
          markerMetadata: {
            ...snapshot.markerMetadata,
            capacityDecision: "rejected",
          },
        },
        { ...environment, databaseIdentity, capacityReceipt },
      ),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "BOOTSTRAP_RECEIPT_INVALID",
  );
  assert.throws(
    () =>
      assertTask010BootstrapSnapshot(
        {
          ...snapshot,
          providers: snapshot.providers.map((provider, index) =>
            index === 0 ? { ...provider, state: "draft" } : provider,
          ),
        },
        { ...environment, databaseIdentity, capacityReceipt },
      ),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "BOOTSTRAP_PROVIDER_IDENTITY_INVALID",
  );
});

test("backfill topology requires four exact active roots and fully pinned sources", () => {
  const ready = {
    profileCount: 1,
    activeProfileCount: 1,
    sourceCount: 4,
    readySourceCount: 4,
    providerRoots: TASK010_PROVIDER_IDENTITIES.map((provider) => ({
      ...provider,
      state: "active",
      activeRevisionId: null,
      nextRunAt: null,
    })),
    sources: Array.from({ length: 4 }, () => ({
      state: "paused",
      activeRevisionId: "revision",
      connectionProfileMatches: true,
      recordsPerRequest: TASK010_BACKFILL_RECORDS_PER_REQUEST,
    })),
  };
  assert.doesNotThrow(() => assertTask010BackfillTopologySnapshot(ready));
  for (const invalid of [
    { ...ready, activeProfileCount: 0 },
    { ...ready, sourceCount: 3 },
    {
      ...ready,
      providerRoots: ready.providerRoots.map((provider, index) =>
        index === 0 ? { ...provider, state: "draft" } : provider,
      ),
    },
    {
      ...ready,
      providerRoots: ready.providerRoots.map((provider, index) =>
        index === 0 ? { ...provider, platformKey: "unexpected" } : provider,
      ),
    },
    {
      ...ready,
      sources: ready.sources.map((source, index) =>
        index === 0 ? { ...source, activeRevisionId: null } : source,
      ),
    },
    {
      ...ready,
      sources: ready.sources.map((source, index) =>
        index === 0 ? { ...source, recordsPerRequest: 5_000 } : source,
      ),
    },
  ]) {
    assert.throws(
      () => assertTask010BackfillTopologySnapshot(invalid),
      (error) =>
        error instanceof Task010SafetyError &&
        error.code === "BACKFILL_TOPOLOGY_NOT_READY",
    );
  }
});

test("worker environment strips evidence token and pins four Task010 source lanes", async () => {
  const evidenceToken = "evidence-token-must-be-stripped";
  const sanitized = sanitizedTask010WorkerEnvironment({
    ...baseEnvironment,
    PACKSCOUT_DATA_API_TOKEN: evidenceToken,
    PACKSCOUT_SOURCE_EXECUTION_SLOTS: "1",
  });
  assert.equal(TASK010_SOURCE_EXECUTION_SLOTS, "4");
  assert.equal(sanitized.PACKSCOUT_DATA_API_TOKEN, undefined);
  assert.equal(JSON.stringify(sanitized).includes(evidenceToken), false);
  assert.equal(sanitized.PACKSCOUT_TASK010_ADMIN_PASSWORD, undefined);
  assert.equal(sanitized.PACKSCOUT_SOURCE_EXECUTION_SLOTS, "4");
  assert.equal(
    sanitizedTask010WorkerEnvironment(baseEnvironment)
      .PACKSCOUT_SOURCE_EXECUTION_SLOTS,
    "4",
  );
  assert.throws(
    () =>
      assertBootstrapPasswordAbsent({
        PACKSCOUT_TASK010_ADMIN_PASSWORD: "still-loaded",
      }),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "BOOTSTRAP_PASSWORD_PRESENT",
  );
  const starter = await readFile(
    new URL("./start-provider-source-task010-supervisor.mts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(starter, /source-supervisor-local/u);
  assert.match(starter, /sanitizedTask010WorkerEnvironment/u);
  assert.match(starter, /phase === "configuration"/u);
  assert.deepEqual(task010ConfigurationCapacityDecision(), {
    admitted: false,
    state: "blocked",
    safeCode: "TASK010_CONFIGURATION_PHASE",
  });
  const adminStarter = await readFile(
    new URL("./start-provider-source-task010-admin.mts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(adminStarter, /start-admin-embedded/u);
  assert.match(adminStarter, /loadTask010EnvironmentFile/u);
  assert.match(adminStarter, /PACKSCOUT_DATA_API_TOKEN = ""/u);
  assert.match(adminStarter, /assertEvidenceTokenAbsent\(process\.env\)/u);
  assert.match(adminStarter, /assertBootstrapPasswordAbsent\(process\.env\)/u);
  const initializer = await readFile(
    new URL(
      "./initialize-provider-source-task010-environment.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    initializer,
    /PACKSCOUT_ADMIN_ALLOWED_ORIGINS=http:\/\/127\.0\.0\.1:5101,http:\/\/localhost:5101/u,
  );
  assert.match(initializer, /PACKSCOUT_SOURCE_EXECUTION_SLOTS=/u);
  assert.match(initializer, /PACKSCOUT_ADMIN_TRUSTED_PROXIES=/u);
  assert.match(initializer, /PACKSCOUT_SESSION_IDLE_MS=3600000/u);
  assert.match(initializer, /PACKSCOUT_SESSION_ABSOLUTE_MS=43200000/u);

  const bootstrap = await readFile(
    new URL("./bootstrap-provider-source-task010-target.mts", import.meta.url),
    "utf8",
  );
  assert.match(bootstrap, /bootstrapSnapshot\.markerCount === 0/u);
  assert.match(bootstrap, /requireAdministratorPassword: true/u);
  assert.doesNotMatch(
    bootstrap,
    /readTask010Environment\(task010Environment, \{\s*requireAdministratorPassword: true,\s*\}\);\s*if \(!environment/u,
  );

  for (const runner of [
    "inspect-provider-source-task010-target.mts",
    "bootstrap-provider-source-task010-target.mts",
    "start-provider-source-task010-admin.mts",
    "start-provider-source-task010-supervisor.mts",
    "reconcile-provider-source-task010-backfill.mts",
  ]) {
    const source = await readFile(
      new URL(`./${runner}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /loadTask010EnvironmentFile\(workspaceRoot\)/u);
    assert.doesNotMatch(source, /dotenv\.config/u);
  }
});

test("retired migration invocation never returns executable authority", () => {
  assert.throws(() => task010MigrationInvocation({
    nodeExecPath: "/usr/local/bin/node",
    npmExecPath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
    databaseUrl: baseEnvironment.PACKSCOUT_DATABASE_URL,
    environment: {
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      NODE_OPTIONS: "--import=/tmp/attacker.mjs",
    },
  }), (error) => error instanceof Task010SafetyError &&
    error.code === "MIGRATION_WORKFLOW_RETIRED");
});

test("reconciliation blocks every unresolved disposition, quarantine, relationship, EV, and attempt gap", () => {
  const passing = {
    reachedHead: true,
    sourceState: "active",
    pageRecordCount: 10,
    dispositionCount: 10,
    quarantinedDispositionCount: 0,
    quarantineCount: 0,
    openQuarantineCount: 0,
    launchBlockingQuarantineCount: 0,
    unresolvedRelationshipCount: 0,
    failedEvCount: 0,
    pendingEvCount: 0,
    nonterminalRequestAttemptCount: 0,
    missingResponseByteEvidenceCount: 0,
    canonicalPackCount: 4,
    availabilityCount: 4,
    evCalculationMismatchCount: 0,
  };
  assert.deepEqual(assessTask010ProviderReconciliation(passing), {
    status: "PASS",
    failures: [],
  });
  const blocked = assessTask010ProviderReconciliation({
    ...passing,
    pageRecordCount: 11,
    openQuarantineCount: 1,
    unresolvedRelationshipCount: 1,
    pendingEvCount: 1,
    missingResponseByteEvidenceCount: 1,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.deepEqual(blocked.failures, [
    "page_record_disposition_mismatch",
    "open_quarantine",
    "unresolved_relationship",
    "ev_not_terminal",
    "missing_response_byte_evidence",
  ]);
});

test("page record reconciliation counts adapter invalid once and mapper quarantine only through dispositions", () => {
  assert.equal(
    task010PageRecordCount({
      catalog: 4,
      pulls: 3,
      trades: 2,
      adapterInvalid: 1,
      mapperQuarantined: 6,
    }),
    10,
  );
  assert.throws(
    () => task010PageRecordCount({ catalog: -1 }),
    (error) =>
      error instanceof Task010SafetyError &&
      error.code === "PAGE_RECORD_COUNT_INVALID",
  );
});

test("reconciliation query uses durable byte lineage and retained retry diagnostics", async () => {
  const source = await readFile(
    new URL(
      "./reconcile-provider-source-task010-backfill.mts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /TASK010_PAGE_RECORD_COUNT_SQL/u);
  assert.match(source, /source_request_attempts as attempt/u);
  assert.match(source, /compact_source_request_attempts as compact_attempt/u);
  assert.match(
    source,
    /coalesce\(\s*attempt\.response_bytes,\s*compact_attempt\.response_bytes/gu,
  );
  assert.match(source, /phase = 'retry_scheduled'/u);
  assert.doesNotMatch(source, /transientRetries/u);
});

test("safe failures never serialize secret-bearing error messages", () => {
  const output = JSON.stringify(safeTask010Failure(new Error(secret)));
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("postgresql://"), false);
});
