import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLUTCHPACKS_REVIEW_CLUSTER_MARKER_FORMAT,
  CLUTCHPACKS_REVIEW_CLUSTER_ROOT,
  CLUTCHPACKS_REVIEW_DATABASES,
  CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS,
  ClutchpacksReviewProvisionError,
  assertClusterMarker,
  assertCreateClusterInventory,
  assertDistinctClusterProofs,
  assertNoClutchpacksProvisionArguments,
  assertResumableClusterTopology,
  buildClusterMarker,
  buildClutchpacksProvisionPlan,
  readClutchpacksProvisionEnvironment,
  safeClutchpacksProvisionFailure,
} from "./clutchpacks-review-database-plan.mjs";

const ids = Object.freeze({
  organizationId: "0d356452-9b32-4a2a-89cf-44482dd70af6",
  operatorId: "80578eb1-8298-41f3-863e-854b0058f1dd",
  membershipId: "20ff72a6-c9ee-41ef-9231-95ec5a50d076",
  providerId: "62337636-fc39-4071-9427-cb720ac7f82f",
  configVersionId: "419c7850-b186-4e17-a4a6-e72788d9f34c",
  databaseCredentialVersionId: "a35ad9e7-e337-449d-9723-c6c1ae616253",
  databaseNodeId: "3ac50150-824f-457c-b4e7-8a85c91c6a2d",
  activationTestId: "d80e5ca3-3a04-4697-bc11-0ea7ae614850",
  auditEventId: "1523895b-5e65-4926-9959-d72543568e5c",
});

const secrets = Object.freeze({
  centralClusterAdminPassword: "control-cluster-admin-secret-1234",
  providerClusterAdminPassword: "clutch-cluster-admin-secret-1234",
  centralAppPassword: "control-application-secret-1234",
  providerAppPassword: "clutch-application-secret-1234",
  adminPassword: "review-admin-only-secret",
  credentialKey: Buffer.alloc(32, 17).toString("base64"),
});

const validProvisionEnvironment = Object.freeze({
  NODE_ENV: "development",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.action]: "provision",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.target]: "all",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.centralClusterAdminPassword]:
    secrets.centralClusterAdminPassword,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerClusterAdminPassword]:
    secrets.providerClusterAdminPassword,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.centralAppPassword]:
    secrets.centralAppPassword,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerAppPassword]:
    secrets.providerAppPassword,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.organizationSlug]:
    "packscout-local-review",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.organizationName]:
    "PackScout Local Review",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminEmail]: "Admin@Example.test",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminDisplayName]: "Review Admin",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminPassword]: secrets.adminPassword,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.credentialKey]: secrets.credentialKey,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.credentialKeyVersion]: "1",
});

function hasCode(code) {
  return (error) =>
    error instanceof ClutchpacksReviewProvisionError && error.code === code;
}

test("two exact fixed clusters replace every shared-cluster target", () => {
  const expectedRoot = path.join(
    os.homedir(),
    "Library/Application Support/PackScout/postgres-review",
  );
  assert.equal(CLUTCHPACKS_REVIEW_CLUSTER_ROOT, expectedRoot);
  assert.deepEqual(
    {
      key: CLUTCHPACKS_REVIEW_DATABASES.central.clusterKey,
      data: CLUTCHPACKS_REVIEW_DATABASES.central.dataDirectory,
      port: CLUTCHPACKS_REVIEW_DATABASES.central.port,
      database: CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
    },
    {
      key: "control",
      data: path.join(expectedRoot, "control"),
      port: 55_431,
      database: "packscout",
    },
  );
  assert.deepEqual(
    {
      key: CLUTCHPACKS_REVIEW_DATABASES.provider.clusterKey,
      data: CLUTCHPACKS_REVIEW_DATABASES.provider.dataDirectory,
      port: CLUTCHPACKS_REVIEW_DATABASES.provider.port,
      database: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
    },
    {
      key: "clutchpacks",
      data: path.join(expectedRoot, "clutchpacks"),
      port: 55_432,
      database: "packscout_clutchpacks",
    },
  );
  assert.notEqual(
    CLUTCHPACKS_REVIEW_DATABASES.central.clusterAdminRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.clusterAdminRoleName,
  );
  assert.doesNotMatch(JSON.stringify(CLUTCHPACKS_REVIEW_DATABASES), /packscout_dev/u);
});

test("actions select only fixed individual lifecycle targets", () => {
  assert.doesNotThrow(() => assertNoClutchpacksProvisionArguments([]));
  assert.throws(
    () => assertNoClutchpacksProvisionArguments(["--data-dir=/tmp/other"]),
    hasCode("ARGUMENTS_FORBIDDEN"),
  );
  assert.deepEqual(
    readClutchpacksProvisionEnvironment({
      NODE_ENV: "development",
      [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.action]: "stop",
      [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.target]: "control",
    }),
    {
      action: "stop",
      target: "control",
      selected: [CLUTCHPACKS_REVIEW_DATABASES.central],
    },
  );
  assert.throws(
    () => readClutchpacksProvisionEnvironment({
      NODE_ENV: "development",
      [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.action]: "start",
      [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.target]: "all",
    }),
    hasCode("CLUSTER_LIFECYCLE_TARGET_MUST_BE_INDIVIDUAL"),
  );
  assert.throws(
    () => readClutchpacksProvisionEnvironment({
      ...validProvisionEnvironment,
      [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.target]: "control",
    }),
    hasCode("PROVISION_REQUIRES_BOTH_CLUSTERS"),
  );
  assert.deepEqual(
    readClutchpacksProvisionEnvironment({ NODE_ENV: "development" }),
    {
      action: "inspect",
      target: "all",
      selected: [
        CLUTCHPACKS_REVIEW_DATABASES.central,
        CLUTCHPACKS_REVIEW_DATABASES.provider,
      ],
      centralAppPassword: null,
      providerAppPassword: null,
    },
  );
});

test("provisioning admits four distinct env-only credentials and current admin input", () => {
  const parsed = readClutchpacksProvisionEnvironment(validProvisionEnvironment);
  assert.equal(parsed.action, "provision");
  assert.equal(parsed.target, "all");
  assert.equal(parsed.selected.length, 2);
  assert.equal(parsed.bootstrap.adminEmail, "admin@example.test");
  assert.equal(parsed.credentialKey.version, 1);
  for (const duplicateKey of [
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerClusterAdminPassword,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.centralAppPassword,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerAppPassword,
  ]) {
    assert.throws(
      () => readClutchpacksProvisionEnvironment({
        ...validProvisionEnvironment,
        [duplicateKey]: secrets.centralClusterAdminPassword,
      }),
      hasCode("CLUSTER_CREDENTIALS_NOT_DISTINCT"),
    );
  }
});

test("legacy shared-cluster and path or port redirect inputs always fail closed", () => {
  for (const key of [
    "PACKSCOUT_LOCAL_POSTGRES_ADMIN_URL",
    "PACKSCOUT_LOCAL_CLUTCHPACKS_DB_MODE",
    "PACKSCOUT_LOCAL_BACKUP_DIRECTORY",
    "PACKSCOUT_LOCAL_CLUTCHPACKS_REBUILD_CONFIRMATION",
    "PACKSCOUT_LOCAL_REVIEW_CLUSTER_ROOT",
    "PACKSCOUT_LOCAL_CONTROL_DATA_DIRECTORY",
    "PACKSCOUT_LOCAL_CLUTCHPACKS_DATA_DIRECTORY",
    "PACKSCOUT_LOCAL_CONTROL_PORT",
    "PACKSCOUT_LOCAL_CLUTCHPACKS_PORT",
    "PACKSCOUT_LOCAL_CENTRAL_DATABASE_NAME",
    "PACKSCOUT_LOCAL_PROVIDER_DATABASE_NAME",
  ]) {
    assert.throws(
      () => readClutchpacksProvisionEnvironment({
        ...validProvisionEnvironment,
        [key]: "browser-supplied-redirect",
      }),
      hasCode("CLUSTER_REDIRECT_FORBIDDEN"),
    );
  }
  assert.throws(
    () => readClutchpacksProvisionEnvironment({
      ...validProvisionEnvironment,
      HOME: "/tmp/browser-supplied-home",
    }),
    hasCode("CLUSTER_REDIRECT_FORBIDDEN"),
  );
});

test("cluster ownership marker binds system id, directory, port, roles, and state", () => {
  const marker = buildClusterMarker(
    CLUTCHPACKS_REVIEW_DATABASES.central,
    "7532189705087112001",
    "initialized",
  );
  assert.equal(marker.format, CLUTCHPACKS_REVIEW_CLUSTER_MARKER_FORMAT);
  assert.deepEqual(
    assertClusterMarker(marker, CLUTCHPACKS_REVIEW_DATABASES.central),
    marker,
  );
  for (const drift of [
    { ...marker, dataDirectory: "/tmp/redirect" },
    { ...marker, port: 5432 },
    { ...marker, systemIdentifier: "0" },
    { ...marker, appRoleName: "packscout_clutchpacks_app" },
    { ...marker, unexpected: true },
  ]) {
    assert.throws(
      () => assertClusterMarker(drift, CLUTCHPACKS_REVIEW_DATABASES.central),
      hasCode("CLUSTER_MARKER_INVALID"),
    );
  }
});

test("create preflight accepts only absent or owned-empty targets on free ports", () => {
  for (const directoryState of ["absent", "empty"]) {
    assert.doesNotThrow(() =>
      assertCreateClusterInventory({
        parentPrivate: true,
        portOccupied: false,
        directoryState,
      }),
    );
  }
  for (const inventory of [
    { parentPrivate: false, portOccupied: false, directoryState: "absent" },
    { parentPrivate: true, portOccupied: true, directoryState: "absent" },
    { parentPrivate: true, portOccupied: false, directoryState: "nonempty" },
    { parentPrivate: true, portOccupied: false, directoryState: "unsafe" },
  ]) {
    assert.throws(
      () => assertCreateClusterInventory(inventory),
      hasCode("CLUSTER_CREATE_TARGET_UNSAFE"),
    );
  }
});

test("resume accepts only the exact managed partial role and database topology", () => {
  const cluster = CLUTCHPACKS_REVIEW_DATABASES.central;
  const admin = {
    rolname: cluster.clusterAdminRoleName,
    rolcanlogin: true,
    rolsuper: true,
    rolinherit: true,
    rolcreaterole: true,
    rolcreatedb: true,
    rolreplication: true,
    rolbypassrls: true,
    rolconnlimit: -1,
  };
  const owner = {
    rolname: cluster.ownerRoleName,
    rolcanlogin: false,
    rolsuper: false,
    rolinherit: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: -1,
  };
  const app = {
    ...owner,
    rolname: cluster.appRoleName,
    rolcanlogin: true,
    rolconnlimit: 20,
  };
  const baseDatabases = ["postgres", "template0", "template1"].map(
    (datname) => ({ datname, owner_name: cluster.clusterAdminRoleName }),
  );
  assert.deepEqual(
    assertResumableClusterTopology(cluster, {
      roles: [admin, owner].sort((left, right) =>
        left.rolname.localeCompare(right.rolname)
      ),
      databases: baseDatabases,
    }),
    {
      appRoleExists: false,
      ownerRoleExists: true,
      targetDatabaseExists: false,
    },
  );
  assert.deepEqual(
    assertResumableClusterTopology(cluster, {
      roles: [admin, owner, app].sort((left, right) =>
        left.rolname.localeCompare(right.rolname)
      ),
      databases: [
        { datname: cluster.databaseName, owner_name: cluster.ownerRoleName },
        ...baseDatabases,
      ].sort((left, right) => left.datname.localeCompare(right.datname)),
    }),
    {
      appRoleExists: true,
      ownerRoleExists: true,
      targetDatabaseExists: true,
    },
  );
  for (const inventory of [
    { roles: [admin, { ...owner, rolname: "unexpected_role" }], databases: baseDatabases },
    { roles: [admin, { ...owner, rolsuper: true }], databases: baseDatabases },
    {
      roles: [admin, owner, app].sort((left, right) =>
        left.rolname.localeCompare(right.rolname)
      ),
      databases: [
        ...baseDatabases,
        { datname: cluster.databaseName, owner_name: cluster.appRoleName },
      ].sort((left, right) => left.datname.localeCompare(right.datname)),
    },
  ]) {
    assert.throws(
      () => assertResumableClusterTopology(cluster, inventory),
      hasCode("FRESH_CLUSTER_TOPOLOGY_UNEXPECTED"),
    );
  }
});

test("cluster isolation requires distinct ports, directories, and system identifiers", () => {
  const central = {
    ...CLUTCHPACKS_REVIEW_DATABASES.central,
    systemIdentifier: "7532189705087112001",
  };
  const provider = {
    ...CLUTCHPACKS_REVIEW_DATABASES.provider,
    systemIdentifier: "7532189705087112002",
  };
  assert.doesNotThrow(() => assertDistinctClusterProofs(central, provider));
  for (const drift of [
    { ...provider, port: central.port },
    { ...provider, dataDirectory: central.dataDirectory },
    { ...provider, systemIdentifier: central.systemIdentifier },
    { ...provider, databaseName: "packscout" },
  ]) {
    assert.throws(
      () => assertDistinctClusterProofs(central, drift),
      hasCode("CLUSTER_ISOLATION_PROOF_FAILED"),
    );
  }
});

test("provision plan has no rebuild/drop path and resumes both clusters before migration", () => {
  const plan = buildClutchpacksProvisionPlan(ids);
  const stages = plan.stages;
  assert.ok(stages.indexOf("initialize_or_resume_control_cluster") <
    stages.indexOf("start_control_cluster"));
  assert.ok(stages.indexOf("initialize_or_resume_clutchpacks_cluster") <
    stages.indexOf("start_clutchpacks_cluster"));
  assert.ok(stages.indexOf("start_control_cluster") <
    stages.indexOf("migrate_central"));
  assert.ok(stages.indexOf("start_clutchpacks_cluster") <
    stages.indexOf("migrate_provider"));
  assert.ok(stages.indexOf("initialize_provider_identity") <
    stages.indexOf("register_clutchpacks"));
  assert.doesNotMatch(JSON.stringify(plan), /rebuild|backup|drop/iu);
});

test("executor pins initdb and pg_ctl, proves live identities, and grants explicit tables", () => {
  const runtime = readFileSync(
    fileURLToPath(new URL(
      "./clutchpacks-review-cluster-runtime.mts",
      import.meta.url,
    )),
    "utf8",
  );
  const executor = readFileSync(
    fileURLToPath(new URL(
      "./provision-clutchpacks-review-databases.mts",
      import.meta.url,
    )),
    "utf8",
  );
  assert.match(runtime, /\/opt\/homebrew\/opt\/postgresql@16\/bin\/initdb/u);
  assert.match(runtime, /\/opt\/homebrew\/opt\/postgresql@16\/bin\/pg_ctl/u);
  assert.match(runtime, /--pwfile=\/dev\/fd\/0/u);
  assert.match(runtime, /input: `\$\{clusterAdminPassword\}\\n`/u);
  assert.match(runtime, /host\(inet_server_addr\(\)\)/u);
  assert.match(runtime, /assertPostmasterBinding/u);
  assert.match(runtime, /pg_control_system\(\)/u);
  assert.match(runtime, /app_connect_databases/u);
  assert.match(runtime, /database\.datname::text/u);
  assert.match(runtime, /state === "nonempty"/u);
  assert.match(executor, /grant select, insert, update on table/u);
  const schemaTables = (source) => [...source.matchAll(/^model\s+(\w+)\s*\{/gmu)]
    .map((match) => match[1])
    .filter((name) => name !== "database_identity")
    .sort();
  const allowlistTables = (match, label) => {
    assert.ok(match, label);
    return [...match[1].matchAll(/"([a-z_]+)"/gu)]
      .map((entry) => entry[1])
      .sort();
  };
  const centralSchema = readFileSync(new URL(
    "../../packages/database/prisma/central/schema.prisma", import.meta.url,
  ), "utf8");
  const providerSchema = readFileSync(new URL(
    "../../packages/database/prisma/provider/schema.prisma", import.meta.url,
  ), "utf8");
  const centralGrantList = /const CENTRAL_RUNTIME_TABLES = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(executor);
  const providerGrantList = /const PROVIDER_RUNTIME_TABLES = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(executor);
  assert.deepEqual(allowlistTables(
    centralGrantList,
    "central runtime grants must remain an explicit table allowlist",
  ), schemaTables(centralSchema));
  assert.deepEqual(allowlistTables(
    providerGrantList,
    "provider runtime grants must remain an explicit table allowlist",
  ), schemaTables(providerSchema));
  const centralDeleteList = /const CENTRAL_DELETE_TABLES = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(executor);
  const providerDeleteList = /const PROVIDER_DELETE_TABLES = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(executor);
  assert.deepEqual(allowlistTables(
    centralDeleteList,
    "central deletes must remain an explicit table allowlist",
  ), [
    "auth_rate_limits",
    "email_link_tokens",
    "email_message_attempts",
    "email_message_intents",
    "manifest_reconciliation_job_delivery_tombstones",
    "manifest_reconciliation_job_invocations",
    "provider_promotion_invocation_projections",
    "worker_instances",
  ]);
  assert.deepEqual(allowlistTables(
    providerDeleteList,
    "provider deletes must remain an explicit table allowlist",
  ), [
    "provider_activity_outbox",
    "provider_promotion_job_delivery_tombstones",
    "provider_promotion_job_invocations",
  ]);
  assert.match(executor, /grant delete on table \$\{qualifiedTables\(CENTRAL_DELETE_TABLES\)\}/u);
  assert.match(executor, /grant delete on table \$\{qualifiedTables\(PROVIDER_DELETE_TABLES\)\}/u);
  assert.match(executor, /deterministicProvisionUuid/u);
  assert.match(executor, /CENTRAL_REGISTRATION_STATE_UNEXPECTED/u);
  assert.match(executor, /updated_at = greatest\(\$3, updated_at \+ interval '1 microsecond'\)/u);
  assert.doesNotMatch(executor, /on all tables|alter default privileges/iu);
  assert.doesNotMatch(`${runtime}\n${executor}`, /drop database|drop role|rebuild|pg_dump/iu);
  assert.doesNotMatch(`${runtime}\n${executor}`, /packscout_dev/u);
  assert.doesNotMatch(`${runtime}\n${executor}`, /\/Users\/lains/u);
});

test("package commands expose independent inspect, start, and stop without rebuild", () => {
  const packageDocument = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
    "utf8",
  ));
  for (const cluster of ["packscout-control", "packscout-clutchpacks"]) {
    for (const action of ["inspect", "start", "stop"]) {
      assert.equal(
        typeof packageDocument.scripts[`db:${action}:${cluster}:local`],
        "string",
      );
    }
  }
  assert.equal(packageDocument.scripts["db:rebuild:clutchpacks-review:local"], undefined);
  assert.doesNotMatch(JSON.stringify(packageDocument.scripts), /PACKSCOUT_LOCAL_POSTGRES_ADMIN_URL/u);
});

test("failures and forbidden argv never echo cluster or admin secrets", () => {
  const serialized = JSON.stringify(
    safeClutchpacksProvisionFailure(new Error(Object.values(secrets).join("|"))),
  );
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false);
  }
  const script = fileURLToPath(new URL(
    "./provision-clutchpacks-review-databases.mts",
    import.meta.url,
  ));
  const argvSecret = "browser-supplied-password-must-not-echo";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, `--password=${argvSecret}`],
    {
      cwd: path.resolve(path.dirname(script), "..", ".."),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "development" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"code":"ARGUMENTS_FORBIDDEN"/u);
  assert.equal(`${result.stdout}${result.stderr}`.includes(argvSecret), false);
});
