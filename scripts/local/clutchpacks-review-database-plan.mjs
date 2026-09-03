import os from "node:os";
import path from "node:path";

export const CLUTCHPACKS_REVIEW_CLUSTER_ROOT = path.join(
  os.homedir(),
  "Library/Application Support/PackScout/postgres-review",
);
const SYSTEM_ACCOUNT_CLUSTER_ROOT = path.join(
  os.userInfo().homedir,
  "Library/Application Support/PackScout/postgres-review",
);
export const CLUTCHPACKS_REVIEW_CLUSTER_MARKER =
  ".packscout-local-pg16-cluster.json";
export const CLUTCHPACKS_REVIEW_CLUSTER_MARKER_FORMAT =
  "packscout-local-pg16-cluster-v1";

export const CLUTCHPACKS_REVIEW_DATABASES = Object.freeze({
  central: Object.freeze({
    appRoleName: "packscout_control_app",
    clusterAdminRoleName: "packscout_control_cluster_admin",
    clusterKey: "control",
    dataDirectory: path.join(CLUTCHPACKS_REVIEW_CLUSTER_ROOT, "control"),
    databaseName: "packscout",
    migrationName: "20260829000000_distributed_central_baseline",
    ownerRoleName: "packscout_control_owner",
    port: 55_431,
    schemaVersion: "distributed-central-v1",
  }),
  provider: Object.freeze({
    appRoleName: "packscout_clutchpacks_app",
    adapterKey: "local-capture-clutchpacks-v1",
    clusterAdminRoleName: "packscout_clutchpacks_cluster_admin",
    clusterKey: "clutchpacks",
    dataDirectory: path.join(CLUTCHPACKS_REVIEW_CLUSTER_ROOT, "clutchpacks"),
    databaseName: "packscout_clutchpacks",
    migrationName: "20260829000000_distributed_provider_baseline",
    ownerRoleName: "packscout_clutchpacks_owner",
    port: 55_432,
    providerKey: "clutchpacks",
    schemaVersion: "distributed-provider-v1",
  }),
});

export const CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS = Object.freeze({
  action: "PACKSCOUT_LOCAL_REVIEW_CLUSTER_ACTION",
  target: "PACKSCOUT_LOCAL_REVIEW_CLUSTER_TARGET",
  centralClusterAdminPassword:
    "PACKSCOUT_LOCAL_CONTROL_CLUSTER_ADMIN_PASSWORD",
  providerClusterAdminPassword:
    "PACKSCOUT_LOCAL_CLUTCHPACKS_CLUSTER_ADMIN_PASSWORD",
  centralAppPassword: "PACKSCOUT_LOCAL_CONTROL_APP_PASSWORD",
  providerAppPassword: "PACKSCOUT_LOCAL_CLUTCHPACKS_APP_PASSWORD",
  organizationSlug: "PACKSCOUT_LOCAL_ORGANIZATION_SLUG",
  organizationName: "PACKSCOUT_LOCAL_ORGANIZATION_NAME",
  adminEmail: "PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_EMAIL",
  adminDisplayName: "PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  adminPassword: "PACKSCOUT_LOCAL_BOOTSTRAP_ADMIN_PASSWORD",
  credentialKey: "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
  credentialKeyVersion: "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
});

const ACTIONS = new Set(["inspect", "provision", "start", "stop"]);
const TARGETS = new Set(["all", "control", "clutchpacks"]);
const FORBIDDEN_REDIRECT_KEYS = Object.freeze([
  "PACKSCOUT_LOCAL_CLUTCHPACKS_DB_MODE",
  "PACKSCOUT_LOCAL_POSTGRES_ADMIN_URL",
  "PACKSCOUT_LOCAL_BACKUP_DIRECTORY",
  "PACKSCOUT_LOCAL_CLUTCHPACKS_REBUILD_CONFIRMATION",
  "PACKSCOUT_LOCAL_REVIEW_CLUSTER_ROOT",
  "PACKSCOUT_LOCAL_CONTROL_DATA_DIRECTORY",
  "PACKSCOUT_LOCAL_CLUTCHPACKS_DATA_DIRECTORY",
  "PACKSCOUT_LOCAL_CONTROL_PORT",
  "PACKSCOUT_LOCAL_CLUTCHPACKS_PORT",
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
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
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

function optionalBoundedPassword(environment, key, requiredForAction) {
  const candidate = environment[key];
  if (candidate === undefined && !requiredForAction) return null;
  const value = required(environment, key, 512);
  if (value.length < 20 || value.length > 256) {
    refuse("PROVISION_CREDENTIAL_INVALID");
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
    (environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.organizationSlug] ??
      "packscout-local-review").trim();
  const organizationName =
    (environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.organizationName] ??
      "PackScout Local Review").trim();
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

function selectedTargets(target) {
  if (target === "all") {
    return Object.freeze([
      CLUTCHPACKS_REVIEW_DATABASES.central,
      CLUTCHPACKS_REVIEW_DATABASES.provider,
    ]);
  }
  return Object.freeze([
    target === "control"
      ? CLUTCHPACKS_REVIEW_DATABASES.central
      : CLUTCHPACKS_REVIEW_DATABASES.provider,
  ]);
}

export function assertNoClutchpacksProvisionArguments(argumentsList) {
  if (argumentsList.length !== 0) refuse("ARGUMENTS_FORBIDDEN");
}

export function readClutchpacksProvisionEnvironment(environment) {
  if (environment.NODE_ENV !== "development") {
    refuse("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED");
  }
  if (
    CLUTCHPACKS_REVIEW_CLUSTER_ROOT !== SYSTEM_ACCOUNT_CLUSTER_ROOT ||
    (environment.HOME !== undefined &&
      environment.HOME !== os.userInfo().homedir)
  ) {
    refuse("CLUSTER_REDIRECT_FORBIDDEN");
  }
  for (const key of FORBIDDEN_REDIRECT_KEYS) {
    if (environment[key] !== undefined) refuse("CLUSTER_REDIRECT_FORBIDDEN");
  }
  const action =
    environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.action] ?? "inspect";
  const target =
    environment[CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.target] ?? "all";
  if (!ACTIONS.has(action) || !TARGETS.has(target)) {
    refuse("CLUSTER_ACTION_INVALID");
  }
  if (action === "provision" && target !== "all") {
    refuse("PROVISION_REQUIRES_BOTH_CLUSTERS");
  }
  if ((action === "start" || action === "stop") && target === "all") {
    refuse("CLUSTER_LIFECYCLE_TARGET_MUST_BE_INDIVIDUAL");
  }
  const selected = selectedTargets(target);
  if (action === "stop") return Object.freeze({ action, target, selected });

  const centralSelected = target === "all" || target === "control";
  const providerSelected = target === "all" || target === "clutchpacks";
  const centralAppPassword = optionalBoundedPassword(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.centralAppPassword,
    action !== "inspect" && centralSelected,
  );
  const providerAppPassword = optionalBoundedPassword(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerAppPassword,
    action !== "inspect" && providerSelected,
  );
  if (action !== "provision") {
    return Object.freeze({
      action,
      target,
      selected,
      centralAppPassword,
      providerAppPassword,
    });
  }

  const centralClusterAdminPassword = optionalBoundedPassword(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.centralClusterAdminPassword,
    true,
  );
  const providerClusterAdminPassword = optionalBoundedPassword(
    environment,
    CLUTCHPACKS_REVIEW_ENVIRONMENT_KEYS.providerClusterAdminPassword,
    true,
  );
  const credentials = [
    centralClusterAdminPassword,
    providerClusterAdminPassword,
    centralAppPassword,
    providerAppPassword,
  ];
  if (new Set(credentials).size !== credentials.length) {
    refuse("CLUSTER_CREDENTIALS_NOT_DISTINCT");
  }
  return Object.freeze({
    action,
    target,
    selected,
    centralClusterAdminPassword,
    providerClusterAdminPassword,
    centralAppPassword,
    providerAppPassword,
    bootstrap: bootstrapIdentity(environment),
    credentialKey: credentialKey(environment),
  });
}

export function buildClusterMarker(cluster, systemIdentifier, state) {
  if (
    !POSITIVE_DECIMAL_PATTERN.test(systemIdentifier) ||
    !["initialized", "provisioned"].includes(state)
  ) {
    refuse("CLUSTER_MARKER_INVALID");
  }
  return Object.freeze({
    format: CLUTCHPACKS_REVIEW_CLUSTER_MARKER_FORMAT,
    clusterKey: cluster.clusterKey,
    dataDirectory: cluster.dataDirectory,
    port: cluster.port,
    databaseName: cluster.databaseName,
    clusterAdminRoleName: cluster.clusterAdminRoleName,
    ownerRoleName: cluster.ownerRoleName,
    appRoleName: cluster.appRoleName,
    systemIdentifier,
    state,
  });
}

export function assertClusterMarker(marker, cluster) {
  const expectedKeys = [
    "appRoleName",
    "clusterAdminRoleName",
    "clusterKey",
    "dataDirectory",
    "databaseName",
    "format",
    "ownerRoleName",
    "port",
    "state",
    "systemIdentifier",
  ];
  if (
    typeof marker !== "object" ||
    marker === null ||
    Object.keys(marker).sort().join(",") !== expectedKeys.join(",") ||
    marker.format !== CLUTCHPACKS_REVIEW_CLUSTER_MARKER_FORMAT ||
    marker.clusterKey !== cluster.clusterKey ||
    marker.dataDirectory !== cluster.dataDirectory ||
    marker.port !== cluster.port ||
    marker.databaseName !== cluster.databaseName ||
    marker.clusterAdminRoleName !== cluster.clusterAdminRoleName ||
    marker.ownerRoleName !== cluster.ownerRoleName ||
    marker.appRoleName !== cluster.appRoleName ||
    !POSITIVE_DECIMAL_PATTERN.test(marker.systemIdentifier ?? "") ||
    !["initialized", "provisioned"].includes(marker.state)
  ) {
    refuse("CLUSTER_MARKER_INVALID");
  }
  return Object.freeze({ ...marker });
}

export function assertCreateClusterInventory(inventory) {
  if (
    !inventory.parentPrivate ||
    inventory.portOccupied ||
    !["absent", "empty"].includes(inventory.directoryState)
  ) {
    refuse("CLUSTER_CREATE_TARGET_UNSAFE");
  }
}

export function assertResumableClusterTopology(cluster, inventory) {
  const roleNames = inventory.roles.map((role) => role.rolname);
  const allowedRoleStates = [
    [cluster.clusterAdminRoleName],
    [cluster.clusterAdminRoleName, cluster.ownerRoleName].sort(),
    [
      cluster.appRoleName,
      cluster.clusterAdminRoleName,
      cluster.ownerRoleName,
    ].sort(),
  ];
  const databaseNames = inventory.databases.map((database) => database.datname);
  const allowedDatabaseStates = [
    ["postgres", "template0", "template1"],
    [cluster.databaseName, "postgres", "template0", "template1"].sort(),
  ];
  if (
    !allowedRoleStates.some((state) =>
      JSON.stringify(state) === JSON.stringify(roleNames)
    ) ||
    !allowedDatabaseStates.some((state) =>
      JSON.stringify(state) === JSON.stringify(databaseNames)
    )
  ) {
    refuse("FRESH_CLUSTER_TOPOLOGY_UNEXPECTED");
  }
  const adminRole = inventory.roles.find((role) =>
    role.rolname === cluster.clusterAdminRoleName
  );
  const ownerRole = inventory.roles.find((role) =>
    role.rolname === cluster.ownerRoleName
  );
  const appRole = inventory.roles.find((role) =>
    role.rolname === cluster.appRoleName
  );
  const restrictedRole = (role) =>
    role !== undefined && !role.rolsuper && !role.rolinherit &&
    !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication &&
    !role.rolbypassrls;
  if (
    adminRole === undefined || !adminRole.rolcanlogin || !adminRole.rolsuper ||
    (ownerRole !== undefined &&
      (!restrictedRole(ownerRole) || ownerRole.rolcanlogin)) ||
    (appRole !== undefined &&
      (!restrictedRole(appRole) || !appRole.rolcanlogin ||
        appRole.rolconnlimit !== 20)) ||
    (appRole !== undefined && ownerRole === undefined)
  ) {
    refuse("FRESH_CLUSTER_TOPOLOGY_UNEXPECTED");
  }
  const targetDatabase = inventory.databases.find((database) =>
    database.datname === cluster.databaseName
  );
  if (
    inventory.databases.some((database) =>
      database.datname !== cluster.databaseName &&
      database.owner_name !== cluster.clusterAdminRoleName
    ) ||
    (targetDatabase !== undefined &&
      (targetDatabase.owner_name !== cluster.ownerRoleName ||
        ownerRole === undefined || appRole === undefined))
  ) {
    refuse("FRESH_CLUSTER_TOPOLOGY_UNEXPECTED");
  }
  return Object.freeze({
    appRoleExists: appRole !== undefined,
    ownerRoleExists: ownerRole !== undefined,
    targetDatabaseExists: targetDatabase !== undefined,
  });
}

export function assertDistinctClusterProofs(central, provider) {
  if (
    central.clusterKey !== "control" ||
    provider.clusterKey !== "clutchpacks" ||
    central.dataDirectory === provider.dataDirectory ||
    central.port === provider.port ||
    central.systemIdentifier === provider.systemIdentifier ||
    central.databaseName !== CLUTCHPACKS_REVIEW_DATABASES.central.databaseName ||
    provider.databaseName !== CLUTCHPACKS_REVIEW_DATABASES.provider.databaseName
  ) {
    refuse("CLUSTER_ISOLATION_PROOF_FAILED");
  }
}

export function buildClutchpacksProvisionPlan(ids) {
  for (const [name, value] of Object.entries(ids)) {
    if (!UUID_PATTERN.test(value)) throw new TypeError(`${name} must be a UUID.`);
  }
  return Object.freeze({
    clusters: Object.freeze([
      Object.freeze({ ...CLUTCHPACKS_REVIEW_DATABASES.central }),
      Object.freeze({ ...CLUTCHPACKS_REVIEW_DATABASES.provider }),
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
      "verify_fixed_pg16_binaries",
      "verify_exact_private_cluster_layout",
      "verify_fixed_ports_free_or_owned_binding",
      "initialize_or_resume_control_cluster",
      "initialize_or_resume_clutchpacks_cluster",
      "record_distinct_system_identifiers",
      "derive_resumable_identity_ids",
      "start_control_cluster",
      "start_clutchpacks_cluster",
      "create_cluster_local_roles_and_databases",
      "migrate_central",
      "migrate_provider",
      "initialize_provider_identity",
      "grant_explicit_runtime_tables",
      "bootstrap_current_admin",
      "register_clutchpacks",
      "verify_cluster_and_role_isolation",
      "mark_clusters_provisioned",
    ]),
  });
}

export function safeClutchpacksProvisionFailure(error) {
  return Object.freeze({
    ok: false,
    operation: "manage_clutchpacks_review_clusters",
    code: error instanceof ClutchpacksReviewProvisionError
      ? error.code
      : "UNEXPECTED_LOCAL_CLUSTER_FAILURE",
  });
}
