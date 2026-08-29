import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLUTCHPACKS_REVIEW_DATABASES,
  CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS,
  CLUTCHPACKS_REVIEW_REBUILD_CONFIRMATION,
  ClutchpacksReviewProvisionError,
  assertCreateOnlyInventory,
  assertNoClutchpacksProvisionArguments,
  assertProvisionedReviewInventory,
  assertRebuildRoleInventory,
  assertVerifiedBackupProofs,
  buildClutchpacksProvisionPlan,
  parseLocalPostgresAdminUrl,
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
  adminUrl:
    "postgresql://local_admin:admin-only-secret@127.0.0.1:5432/postgres",
  centralPassword: "central-app-only-secret-1234",
  providerPassword: "provider-app-only-secret-1234",
  adminPassword: "review-admin-only-secret",
  credentialKey: Buffer.alloc(32, 17).toString("base64"),
});

const validCreateEnvironment = Object.freeze({
  NODE_ENV: "development",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.mode]: "create",
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminDatabaseUrl]: secrets.adminUrl,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.centralAppPassword]:
    secrets.centralPassword,
  [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerAppPassword]:
    secrets.providerPassword,
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

function roleInventory(roleName, login) {
  return {
    roleName,
    exists: true,
    login,
    superuser: false,
    createRole: false,
    createDatabase: false,
    replication: false,
    bypassRls: false,
    membershipCount: 0,
    foreignOwnedDatabaseCount: 0,
  };
}

const boundedRoles = Object.freeze([
  roleInventory(CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName, false),
  roleInventory(CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName, true),
  roleInventory(CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName, false),
  roleInventory(CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName, true),
]);

test("review targets are exact, isolated, and never include packscout_dev", () => {
  const plan = buildClutchpacksProvisionPlan(ids);
  assert.deepEqual(plan.databaseNames, ["packscout", "packscout_clutchpacks"]);
  assert.deepEqual(plan.roleNames, [
    "packscout_control_owner",
    "packscout_control_app",
    "packscout_clutchpacks_owner",
    "packscout_clutchpacks_app",
  ]);
  assert.equal(plan.providerIdentity.providerKey, "clutchpacks");
  assert.equal(plan.providerIdentity.providerId, ids.providerId);
  assert.equal(plan.providerIdentity.databaseRole, "provider");
  assert.equal(plan.providerIdentity.schemaVersion, "distributed-provider-v1");
  assert.doesNotMatch(JSON.stringify(plan), /packscout_dev/u);
});

test("admin admission accepts only the exact local postgres maintenance target", () => {
  assert.deepEqual(parseLocalPostgresAdminUrl(secrets.adminUrl), {
    host: "127.0.0.1",
    port: 5432,
    url: secrets.adminUrl,
  });
  for (const value of [
    "postgresql://admin@db.example.test:5432/postgres",
    "postgresql://admin@127.0.0.1:5432/packscout",
    "postgresql://admin@127.0.0.1:5432/packscout_dev",
    "postgresql://admin@127.0.0.1:5432/postgres?schema=public",
    "postgresql://admin@127.0.0.1:5432/postgres#unsafe",
    "mysql://admin@127.0.0.1:5432/postgres",
    "postgresql://127.0.0.1:5432/postgres",
    "postgresql://admin@127.0.0.1:99999/postgres",
  ]) {
    assert.throws(() => parseLocalPostgresAdminUrl(value));
  }
});

test("mutation inputs are env-only, bounded, and reject target overrides", () => {
  assert.doesNotThrow(() => assertNoClutchpacksProvisionArguments([]));
  assert.throws(
    () => assertNoClutchpacksProvisionArguments(["--database=packscout"]),
    hasCode("ARGUMENTS_FORBIDDEN"),
  );
  const parsed = readClutchpacksProvisionEnvironment(validCreateEnvironment);
  assert.equal(parsed.mode, "create");
  assert.equal(parsed.bootstrap.adminEmail, "admin@example.test");
  assert.equal(parsed.credentialKey.version, 1);

  for (const override of [
    "PACKSCOUT_LOCAL_CENTRAL_DATABASE_NAME",
    "PACKSCOUT_LOCAL_PROVIDER_DATABASE_NAME",
    "PACKSCOUT_LOCAL_CENTRAL_OWNER_ROLE_NAME",
    "PACKSCOUT_LOCAL_CENTRAL_APP_ROLE_NAME",
    "PACKSCOUT_LOCAL_PROVIDER_OWNER_ROLE_NAME",
    "PACKSCOUT_LOCAL_PROVIDER_APP_ROLE_NAME",
    "PACKSCOUT_LOCAL_PROVIDER_KEY",
  ]) {
    assert.throws(
      () => readClutchpacksProvisionEnvironment({
        ...validCreateEnvironment,
        [override]: "browser-supplied-target",
      }),
      hasCode("TARGET_OVERRIDE_FORBIDDEN"),
    );
  }
});

test("create-only mode refuses every pre-existing exact database or role", () => {
  assert.doesNotThrow(() =>
    assertCreateOnlyInventory({
      databases: [{ exists: false }, { exists: false }],
      roles: boundedRoles.map((role) => ({ ...role, exists: false })),
    }),
  );
  assert.throws(
    () => assertCreateOnlyInventory({
      databases: [{ exists: true }, { exists: false }],
      roles: [],
    }),
    hasCode("CREATE_TARGET_EXISTS"),
  );
  assert.throws(
    () => assertCreateOnlyInventory({
      databases: [],
      roles: [{ exists: true }],
    }),
    hasCode("CREATE_TARGET_EXISTS"),
  );
});

test("rebuild accepts only separate bounded NOLOGIN owners and LOGIN apps", () => {
  assert.doesNotThrow(() =>
    assertRebuildRoleInventory({ roles: boundedRoles }),
  );
  for (const field of [
    "superuser",
    "createRole",
    "createDatabase",
    "replication",
    "bypassRls",
  ]) {
    assert.throws(
      () => assertRebuildRoleInventory({
        roles: [{ ...boundedRoles[0], [field]: true }],
      }),
      hasCode("REBUILD_ROLE_STATE_UNEXPECTED"),
    );
  }
  for (const role of [
    { ...boundedRoles[0], login: true },
    { ...boundedRoles[1], login: false },
    { ...boundedRoles[2], membershipCount: 1 },
    { ...boundedRoles[3], foreignOwnedDatabaseCount: 1 },
  ]) {
    assert.throws(
      () => assertRebuildRoleInventory({ roles: [role] }),
      hasCode("REBUILD_ROLE_STATE_UNEXPECTED"),
    );
  }
});

test("final topology proof binds each database to its bounded owner and exact schema", () => {
  const inventory = {
    databases: [
      {
        databaseName: "packscout",
        exists: true,
        owner: "packscout_control_owner",
        migrationState: "ready",
        identityState: "ready",
      },
      {
        databaseName: "packscout_clutchpacks",
        exists: true,
        owner: "packscout_clutchpacks_owner",
        migrationState: "ready",
        identityState: "ready",
      },
    ],
    roles: boundedRoles,
  };
  assert.doesNotThrow(() => assertProvisionedReviewInventory(inventory));
  for (const drifted of [
    {
      ...inventory,
      databases: inventory.databases.map((database, index) =>
        index === 0 ? { ...database, owner: "local_admin" } : database
      ),
    },
    {
      ...inventory,
      databases: inventory.databases.map((database, index) =>
        index === 1
          ? { ...database, migrationState: "checksum_mismatch" }
          : database
      ),
    },
    {
      ...inventory,
      roles: boundedRoles.map((role, index) =>
        index === 3 ? { ...role, login: false } : role
      ),
    },
  ]) {
    assert.throws(
      () => assertProvisionedReviewInventory(drifted),
      (error) =>
        hasCode("PROVISION_TOPOLOGY_PROOF_FAILED")(error) ||
        hasCode("REBUILD_ROLE_STATE_UNEXPECTED")(error),
    );
  }
});

test("rebuild requires the exact confirmation and an absolute private backup path", () => {
  const rebuild = {
    ...validCreateEnvironment,
    [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.mode]: "rebuild",
  };
  assert.throws(
    () => readClutchpacksProvisionEnvironment(rebuild),
    hasCode("REBUILD_CONFIRMATION_REQUIRED"),
  );
  assert.throws(
    () => readClutchpacksProvisionEnvironment({
      ...rebuild,
      [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.rebuildConfirmation]:
        CLUTCHPACKS_REVIEW_REBUILD_CONFIRMATION,
      [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.backupDirectory]: "relative/backups",
    }),
    hasCode("REBUILD_BACKUP_DIRECTORY_INVALID"),
  );
  const parsed = readClutchpacksProvisionEnvironment({
    ...rebuild,
    [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.rebuildConfirmation]:
      CLUTCHPACKS_REVIEW_REBUILD_CONFIRMATION,
    [CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.backupDirectory]:
      "/private/tmp/packscout-review-backups",
  });
  assert.equal(parsed.mode, "rebuild");
  assert.equal(
    parsed.backupDirectory,
    "/private/tmp/packscout-review-backups",
  );
});

test("verified backup proofs exactly cover existing targets before drop", () => {
  const inventory = {
    databases: [
      { databaseName: "packscout", exists: true },
      { databaseName: "packscout_clutchpacks", exists: false },
    ],
  };
  const backupDirectory = "/private/tmp/packscout-review-backups";
  const proof = {
    databaseName: "packscout",
    path: `${backupDirectory}/packscout-before-rebuild-proof.dump`,
    bytes: 1024,
    sha256: "a".repeat(64),
  };
  assert.doesNotThrow(() =>
    assertVerifiedBackupProofs(inventory, backupDirectory, [proof]),
  );
  for (const invalidProofs of [
    [],
    [{ ...proof, bytes: 0 }],
    [{ ...proof, sha256: "not-a-digest" }],
    [{ ...proof, path: "/private/tmp/wrong/packscout.dump" }],
    [{ ...proof, databaseName: "packscout_dev" }],
  ]) {
    assert.throws(
      () => assertVerifiedBackupProofs(
        inventory,
        backupDirectory,
        invalidProofs,
      ),
      hasCode("REBUILD_BACKUP_PROOFS_INCOMPLETE"),
    );
  }
});

test("rebuild plan gates drop behind durable backups and initializes identity after both migrations", () => {
  const stages = buildClutchpacksProvisionPlan(ids, "rebuild").stages;
  assert.ok(stages.indexOf("backup_existing_targets") <
    stages.indexOf("verify_backup_proofs"));
  assert.ok(stages.indexOf("verify_backup_proofs") <
    stages.indexOf("drop_exact_targets"));
  assert.ok(stages.indexOf("migrate_central") <
    stages.indexOf("initialize_provider_identity"));
  assert.ok(stages.indexOf("migrate_provider") <
    stages.indexOf("initialize_provider_identity"));
  assert.ok(stages.indexOf("initialize_provider_identity") <
    stages.indexOf("register_clutchpacks"));
});

test("executor uses the runtime v1 cipher, revokes PUBLIC initializer access, and syncs the backup directory", () => {
  const executor = readFileSync(
    fileURLToPath(new URL(
      "./provision-clutchpacks-review-databases.mts",
      import.meta.url,
    )),
    "utf8",
  );
  assert.match(executor, /new AesGcmProviderCredentialCipher\(/u);
  assert.match(
    executor,
    /revisionId: input\.ids\.databaseCredentialVersionId/u,
  );
  assert.doesNotMatch(executor, /packscout-provider-credential:v2/u);
  assert.match(
    executor,
    /revoke all on function[\s\S]+?from public,/u,
  );
  assert.match(executor, /error\.code === "42501"/u);
  assert.match(executor, /await directoryHandle\.sync\(\)/u);
  const backupCall = executor.indexOf("backupProofs = await backupExistingTargets");
  const proofCall = executor.indexOf("assertVerifiedBackupProofs", backupCall);
  const dropCall = executor.indexOf("await dropExactTargets(admin)", proofCall);
  assert.ok(backupCall >= 0 && proofCall > backupCall && dropCall > proofCall);
});

test("failures and forbidden argv never echo database or bootstrap secrets", () => {
  const allSecrets = Object.values(secrets);
  const serialized = JSON.stringify(
    safeClutchpacksProvisionFailure(new Error(allSecrets.join("|"))),
  );
  for (const secret of allSecrets) assert.doesNotMatch(serialized, new RegExp(secret, "u"));

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
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(argvSecret, "u"));
});
