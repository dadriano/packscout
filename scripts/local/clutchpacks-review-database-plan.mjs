import path from "node:path";

export const CLUTCHPACKS_REVIEW_DATABASES = Object.freeze({
  central: Object.freeze({
    appRoleName: "packscout_control_app",
    databaseName: "packscout",
    migrationName: "20260829000000_distributed_central_baseline",
    ownerRoleName: "packscout_control_owner",
    schemaVersion: "distributed-central-v1",
  }),
  provider: Object.freeze({
    appRoleName: "packscout_clutchpacks_app",
    adapterKey: "local-capture-clutchpacks-v1",
    databaseName: "packscout_clutchpacks",
    migrationName: "20260829000000_distributed_provider_baseline",
    providerKey: "clutchpacks",
    ownerRoleName: "packscout_clutchpacks_owner",
    schemaVersion: "distributed-provider-v1",
  }),
});

export const CLUTCHPACKS_REVIEW_REBUILD_CONFIRMATION =
  "rebuild:packscout,packscout_clutchpacks:local";

export const CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS = Object.freeze({
  mode: "PACKSCOUT_LOCAL_CLUTCHPACKS_DB_MODE",
  adminDatabaseUrl: "PACKSCOUT_LOCAL_POSTGRES_ADMIN_URL",
  centralAppPassword: "PACKSCOUT_LOCAL_CONTROL_APP_PASSWORD",
  providerAppPassword: "PACKSCOUT_LOCAL_CLUTCHPACKS_APP_PASSWORD",
  organizationSlug: "PACKSCOUT_LOCAL_ORGANIZATION_SLUG",
  organizationName: "PACKSCOUT_LOCAL_ORGANIZATION_NAME",
  adminEmail: "PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_EMAIL",
  adminDisplayName: "PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  adminPassword: "PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_PASSWORD",
  credentialKey: "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
  credentialKeyVersion: "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
  rebuildConfirmation: "PACKSCOUT_LOCAL_CLUTCHPACKS_REBUILD_CONFIRMATION",
  backupDirectory: "PACKSCOUT_LOCAL_BACKUP_DIRECTORY",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const DATABASE_MODES = new Set(["inspect", "create", "rebuild"]);
const FORBIDDEN_OVERRIDE_KEYS = Object.freeze([
  "PACKSCOUT_LOCAL_CENTRAL_DATABASE_NAME",
  "PACKSCOUT_LOCAL_PROVIDER_DATABASE_NAME",
  "PACKSCOUT_LOCAL_CENTRAL_ROLE_NAME",
  "PACKSCOUT_LOCAL_PROVIDER_ROLE_NAME",
  "PACKSCOUT_LOCAL_CENTRAL_OWNER_ROLE_NAME",
  "PACKSCOUT_LOCAL_CENTRAL_APP_ROLE_NAME",
  "PACKSCOUT_LOCAL_PROVIDER_OWNER_ROLE_NAME",
  "PACKSCOUT_LOCAL_PROVIDER_APP_ROLE_NAME",
  "PACKSCOUT_LOCAL_PROVIDER_KEY",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export class ClutchpacksReviewProvisionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ClutchpacksReviewProvisionError";
    this.code = code;
  }
}

function refuse(code) {
  throw new ClutchpacksReviewProvisionError(code);
}

function required(environment, key, maximumBytes = 4_096) {
  const value = environment[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\r\n\0]/u.test(value)
  ) {
    refuse("PROVISION_INPUT_INVALID");
  }
  return value;
}

function boundedPassword(environment, key) {
  const value = required(environment, key, 512);
  if (value.length < 20 || value.length > 256) {
    refuse("PROVISION_CREDENTIAL_INVALID");
  }
  return value;
}

function normalizedLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!LOOPBACK_HOSTS.has(normalized)) {
    refuse("POSTGRES_ADMIN_TARGET_NOT_LOCAL");
  }
  return normalized;
}

export function assertNoClutchpacksProvisionArguments(argumentsList) {
  if (argumentsList.length !== 0) refuse("ARGUMENTS_FORBIDDEN");
}

export function parseLocalPostgresAdminUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    refuse("POSTGRES_ADMIN_TARGET_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username.length === 0 ||
    url.pathname !== "/postgres" ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    refuse("POSTGRES_ADMIN_TARGET_INVALID");
  }
  const host = normalizedLoopbackHost(url.hostname);
  const port = url.port.length === 0 ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    refuse("POSTGRES_ADMIN_TARGET_INVALID");
  }
  return Object.freeze({ host, port, url: url.toString() });
}

export function parsePrivateBackupDirectory(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    /[\r\n\0]/u.test(value) ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    path.parse(value).root === value
  ) {
    refuse("REBUILD_BACKUP_DIRECTORY_INVALID");
  }
  return value;
}

function credentialKey(environment) {
  const encoded = required(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.credentialKey,
    128,
  );
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== encoded) {
    refuse("PROVIDER_CREDENTIAL_KEY_INVALID");
  }
  const versionValue =
    environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.credentialKeyVersion] ?? "1";
  if (!/^[1-9][0-9]{0,9}$/u.test(versionValue)) {
    refuse("PROVIDER_CREDENTIAL_KEY_VERSION_INVALID");
  }
  const version = Number(versionValue);
  if (!Number.isSafeInteger(version) || version > 2_147_483_647) {
    refuse("PROVIDER_CREDENTIAL_KEY_VERSION_INVALID");
  }
  return Object.freeze({ bytes: new Uint8Array(bytes), version });
}

function bootstrapIdentity(environment) {
  const organizationSlug =
    (environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.organizationSlug]
      ?? "packscout-local-review").trim();
  const organizationName =
    (environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.organizationName]
      ?? "PackScout Local Review").trim();
  const adminEmail = required(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminEmail,
    254,
  ).trim().toLocaleLowerCase("en-US");
  const adminDisplayName = required(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminDisplayName,
    120,
  ).trim();
  const adminPassword = required(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminPassword,
    128,
  );
  if (
    !SAFE_SLUG_PATTERN.test(organizationSlug) ||
    organizationName.length < 1 ||
    organizationName.length > 120 ||
    !EMAIL_PATTERN.test(adminEmail) ||
    adminDisplayName.length < 1 ||
    adminPassword.length < 12
  ) {
    refuse("BOOTSTRAP_ADMIN_INPUT_INVALID");
  }
  return Object.freeze({
    organizationSlug,
    organizationName,
    adminEmail,
    adminDisplayName,
    adminPassword,
  });
}

export function readClutchpacksProvisionEnvironment(environment) {
  if (environment.NODE_ENV !== "development") {
    refuse("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED");
  }
  for (const key of FORBIDDEN_OVERRIDE_KEYS) {
    if (environment[key] !== undefined) refuse("TARGET_OVERRIDE_FORBIDDEN");
  }
  const mode =
    environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.mode] ?? "inspect";
  if (!DATABASE_MODES.has(mode)) refuse("PROVISION_MODE_INVALID");
  const admin = parseLocalPostgresAdminUrl(
    required(environment, CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.adminDatabaseUrl),
  );
  if (mode === "inspect") {
    return Object.freeze({ mode, admin });
  }
  const centralAppPassword = boundedPassword(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.centralAppPassword,
  );
  const providerAppPassword = boundedPassword(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerAppPassword,
  );
  if (centralAppPassword === providerAppPassword) {
    refuse("DATABASE_APP_CREDENTIALS_NOT_DISTINCT");
  }
  if (
    mode === "rebuild" &&
    environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.rebuildConfirmation]
      !== CLUTCHPACKS_REVIEW_REBUILD_CONFIRMATION
  ) {
    refuse("REBUILD_CONFIRMATION_REQUIRED");
  }
  const backupDirectory = mode === "rebuild"
    ? parsePrivateBackupDirectory(required(
        environment,
        CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.backupDirectory,
        1_024,
      ))
    : null;
  return Object.freeze({
    mode,
    admin,
    centralAppPassword,
    providerAppPassword,
    bootstrap: bootstrapIdentity(environment),
    credentialKey: credentialKey(environment),
    backupDirectory,
  });
}

export function assertCreateOnlyInventory(inventory) {
  const existingDatabase = inventory.databases.some((item) => item.exists);
  const existingRole = inventory.roles.some((item) => item.exists);
  if (existingDatabase || existingRole) refuse("CREATE_TARGET_EXISTS");
}

export function assertRebuildRoleInventory(inventory) {
  for (const role of inventory.roles) {
    if (!role.exists) continue;
    const expectedLogin = role.roleName ===
        CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName ||
      role.roleName === CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName;
    if (
      role.login !== expectedLogin ||
      role.superuser ||
      role.createRole ||
      role.createDatabase ||
      role.replication ||
      role.bypassRls ||
      role.membershipCount !== 0 ||
      role.foreignOwnedDatabaseCount !== 0
    ) {
      refuse("REBUILD_ROLE_STATE_UNEXPECTED");
    }
  }
}

export function assertVerifiedBackupProofs(
  inventory,
  backupDirectory,
  proofs,
) {
  const expectedDatabaseNames = inventory.databases
    .filter((database) => database.exists)
    .map((database) => database.databaseName)
    .sort();
  const actualDatabaseNames = proofs
    .map((proof) => proof.databaseName)
    .sort();
  if (
    expectedDatabaseNames.length !== actualDatabaseNames.length ||
    expectedDatabaseNames.some(
      (databaseName, index) => databaseName !== actualDatabaseNames[index],
    ) ||
    proofs.some((proof) =>
      !Number.isSafeInteger(proof.bytes) ||
      proof.bytes < 1 ||
      !/^[0-9a-f]{64}$/u.test(proof.sha256) ||
      !path.isAbsolute(proof.path) ||
      path.dirname(proof.path) !== backupDirectory ||
      !path.basename(proof.path).startsWith(
        `${proof.databaseName}-before-rebuild-`,
      )
    )
  ) {
    refuse("REBUILD_BACKUP_PROOFS_INCOMPLETE");
  }
}

export function assertProvisionedReviewInventory(inventory) {
  const expectedDatabases = new Map([
    [
      CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
    ],
    [
      CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
    ],
  ]);
  const expectedRoles = new Set([
    CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
    CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
  ]);
  if (
    inventory.databases.length !== expectedDatabases.size ||
    inventory.databases.some((database) =>
      !database.exists ||
      database.owner !== expectedDatabases.get(database.databaseName) ||
      database.migrationState !== "ready" ||
      database.identityState !== "ready"
    ) ||
    inventory.roles.length !== expectedRoles.size ||
    inventory.roles.some((role) =>
      !expectedRoles.has(role.roleName) || !role.exists
    )
  ) {
    refuse("PROVISION_TOPOLOGY_PROOF_FAILED");
  }
  assertRebuildRoleInventory(inventory);
}

export function buildClutchpacksProvisionPlan(ids, mode = "create") {
  for (const [name, value] of Object.entries(ids)) {
    if (!UUID_PATTERN.test(value)) {
      throw new TypeError(`${name} must be a UUID.`);
    }
  }
  return Object.freeze({
    databaseNames: Object.freeze([
      CLUTCHPACKS_REVIEW_DATABASES.central.databaseName,
      CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
    ]),
    roleNames: Object.freeze([
      CLUTCHPACKS_REVIEW_DATABASES.central.ownerRoleName,
      CLUTCHPACKS_REVIEW_DATABASES.central.appRoleName,
      CLUTCHPACKS_REVIEW_DATABASES.provider.ownerRoleName,
      CLUTCHPACKS_REVIEW_DATABASES.provider.appRoleName,
    ]),
    identities: Object.freeze({ ...ids }),
    providerIdentity: Object.freeze({
      databaseRole: "provider",
      databaseName: CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName,
      schemaVersion: CLUTCHPACKS_REVIEW_DATABASES.provider.schemaVersion,
      providerId: ids.providerId,
      providerKey: CLUTCHPACKS_REVIEW_DATABASES.provider.providerKey,
    }),
    stages: Object.freeze([
      "verify_local_postgres_16",
      "inventory_exact_targets",
      ...(mode === "rebuild"
        ? [
            "backup_existing_targets",
            "verify_backup_proofs",
            "drop_exact_targets",
          ]
        : []),
      "create_bounded_owner_and_app_roles",
      "create_exact_databases",
      "migrate_central",
      "migrate_provider",
      "initialize_provider_identity",
      "verify_role_isolation",
      "bootstrap_current_admin",
      "register_clutchpacks",
      "verify_exact_readiness",
    ]),
  });
}

export function safeClutchpacksProvisionFailure(error) {
  return Object.freeze({
    ok: false,
    operation: "provision_clutchpacks_review_databases",
    code: error instanceof ClutchpacksReviewProvisionError
      ? error.code
      : "UNEXPECTED_LOCAL_PROVISION_FAILURE",
  });
}
