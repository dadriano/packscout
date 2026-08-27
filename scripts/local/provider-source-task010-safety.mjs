import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import dotenv from "dotenv";

export const TASK010_SAFETY_VERSION =
  "packscout.provider-source-task010-safety.v1";
export const TASK010_LOCAL_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THIS_TARGET_IS_LOCAL_AND_EMPTY";
export const TASK010_SOURCE_EXECUTION_SLOTS = "1";
export const TASK010_BOOTSTRAP_ACTION = "provider_source.task010.bootstrap";
export const TASK010_PAGE_RECORD_COUNT_SQL = `
  coalesce((record_counts_json->>'catalog')::bigint, 0) +
  coalesce((record_counts_json->>'pulls')::bigint, 0) +
  coalesce((record_counts_json->>'trades')::bigint, 0) +
  coalesce((record_counts_json->>'adapterInvalid')::bigint, 0)
`;
export const TASK010_REQUIRED_MIGRATION = Object.freeze({
  name: "20260826010000_provider_source_records_per_request",
  checksum: "c80c4ebdb52d950dc8a1972f056339f436394ce33280ed30ba0d5cb5b5f1a5cf",
  tableCount: 84,
});

export const TASK010_PROVIDER_IDENTITIES = Object.freeze([
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a101",
    platformKey: "courtyard",
    displayName: "Courtyard",
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a102",
    platformKey: "collector_crypt",
    displayName: "Collector Crypt",
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a103",
    platformKey: "phygitals",
    displayName: "Phygitals",
  }),
  Object.freeze({
    id: "9c2ef352-161a-4e5f-9d7d-6ff46755a104",
    platformKey: "clutchpacks",
    displayName: "ClutchPacks",
  }),
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DATABASE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/u;
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const TASK010_ENVIRONMENT_FILE = ".env.task010.local";

export class Task010SafetyError extends Error {
  constructor(code) {
    super("Provider source Task 010 safety check failed.");
    this.name = "Task010SafetyError";
    this.code = code;
  }
}

function required(environment, name, maximumBytes = 4_096) {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\r\n]/u.test(value)
  ) {
    throw new Task010SafetyError(`${name}_INVALID`);
  }
  return value;
}

function uuid(environment, name) {
  const value = required(environment, name).toLowerCase();
  if (!UUID_PATTERN.test(value)) {
    throw new Task010SafetyError(`${name}_INVALID`);
  }
  return value;
}

function canonicalBase64Key(environment, name) {
  const value = required(environment, name).trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Task010SafetyError(`${name}_INVALID`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength !== 32 ||
    decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
  ) {
    throw new Task010SafetyError(`${name}_INVALID`);
  }
  return value;
}

function localHost(hostname) {
  if (LOOPBACK_NAMES.has(hostname)) return true;
  const family = isIP(hostname);
  if (family === 4) return hostname.startsWith("127.");
  return (
    family === 6 &&
    (hostname === "::1" || hostname.toLowerCase().startsWith("::ffff:127."))
  );
}

export function assertNoTask010Arguments(argumentsList) {
  if (argumentsList.length !== 0) {
    throw new Task010SafetyError("COMMAND_ARGUMENTS_FORBIDDEN");
  }
}

export async function loadTask010EnvironmentFile(workspaceRoot) {
  const requestedPath = path.join(workspaceRoot, TASK010_ENVIRONMENT_FILE);
  let metadata;
  let canonicalRoot;
  let canonicalPath;
  try {
    metadata = await lstat(requestedPath);
    canonicalRoot = await realpath(workspaceRoot);
    canonicalPath = await realpath(requestedPath);
  } catch {
    throw new Task010SafetyError("TASK010_ENVIRONMENT_FILE_UNAVAILABLE");
  }
  const exactCanonicalPath = path.join(canonicalRoot, TASK010_ENVIRONMENT_FILE);
  const currentUserId =
    typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    canonicalPath !== exactCanonicalPath ||
    (currentUserId !== null && metadata.uid !== currentUserId) ||
    (metadata.mode & 0o077) !== 0 ||
    (metadata.mode & 0o400) === 0
  ) {
    throw new Task010SafetyError("TASK010_ENVIRONMENT_FILE_UNSAFE");
  }
  let contents;
  try {
    contents = await readFile(canonicalPath, "utf8");
  } catch {
    throw new Task010SafetyError("TASK010_ENVIRONMENT_FILE_UNAVAILABLE");
  }
  return Object.freeze(dotenv.parse(contents));
}

export function readTask010Environment(environment, options = {}) {
  if (environment.NODE_ENV === "production") {
    throw new Task010SafetyError("PRODUCTION_ENVIRONMENT_FORBIDDEN");
  }
  if (
    required(environment, "PACKSCOUT_TASK010_LOCAL_ACK") !==
    TASK010_LOCAL_ACKNOWLEDGEMENT
  ) {
    throw new Task010SafetyError("LOCAL_ACKNOWLEDGEMENT_INVALID");
  }

  const expectedDatabaseName = required(
    environment,
    "PACKSCOUT_TASK010_DATABASE_NAME",
    63,
  );
  if (
    !DATABASE_PATTERN.test(expectedDatabaseName) ||
    ["postgres", "template0", "template1"].includes(expectedDatabaseName)
  ) {
    throw new Task010SafetyError("DATABASE_NAME_INVALID");
  }

  const databaseUrl = required(environment, "PACKSCOUT_DATABASE_URL", 2_048);
  if (/^REPLACE_/iu.test(databaseUrl)) {
    throw new Task010SafetyError("DATABASE_URL_PLACEHOLDER");
  }
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Task010SafetyError("DATABASE_URL_INVALID");
  }
  const urlDatabaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !localHost(parsed.hostname) ||
    urlDatabaseName !== expectedDatabaseName ||
    parsed.hash ||
    parsed.search
  ) {
    throw new Task010SafetyError("DATABASE_TARGET_NOT_EXACT_LOCAL");
  }

  const keyVersionValue = required(
    environment,
    "PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION",
    10,
  );
  if (!/^[1-9][0-9]*$/u.test(keyVersionValue)) {
    throw new Task010SafetyError("SOURCE_CONNECTION_KEY_VERSION_INVALID");
  }
  const sourceConnectionKeyVersion = Number(keyVersionValue);
  if (
    !Number.isSafeInteger(sourceConnectionKeyVersion) ||
    sourceConnectionKeyVersion > 2_147_483_647
  ) {
    throw new Task010SafetyError("SOURCE_CONNECTION_KEY_VERSION_INVALID");
  }

  const databaseVolumePath = required(
    environment,
    "PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH",
  );
  if (/^REPLACE_/iu.test(databaseVolumePath)) {
    throw new Task010SafetyError("DATABASE_VOLUME_PATH_PLACEHOLDER");
  }

  const result = {
    databaseUrl,
    expectedDatabaseName,
    expectedDatabaseIdentity:
      environment.PACKSCOUT_TASK010_DATABASE_IDENTITY || null,
    databaseVolumePath,
    organizationId: uuid(environment, "PACKSCOUT_TASK010_ORGANIZATION_ID"),
    organizationSlug: required(
      environment,
      "PACKSCOUT_TASK010_ORGANIZATION_SLUG",
      63,
    ),
    organizationName: required(
      environment,
      "PACKSCOUT_TASK010_ORGANIZATION_NAME",
      120,
    ),
    administratorId: uuid(environment, "PACKSCOUT_TASK010_ADMIN_ID"),
    administratorEmail: required(
      environment,
      "PACKSCOUT_TASK010_ADMIN_EMAIL",
      320,
    )
      .trim()
      .toLocaleLowerCase("en-US"),
    administratorDisplayName: required(
      environment,
      "PACKSCOUT_TASK010_ADMIN_DISPLAY_NAME",
      120,
    ),
    sessionSecret: required(environment, "PACKSCOUT_SESSION_HASHING_SECRET"),
    actorKeyBase64: canonicalBase64Key(
      environment,
      "PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64",
    ),
    sourceConnectionKeyBase64: canonicalBase64Key(
      environment,
      "PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64",
    ),
    sourceConnectionKeyVersion,
  };
  if (!SLUG_PATTERN.test(result.organizationSlug)) {
    throw new Task010SafetyError("ORGANIZATION_SLUG_INVALID");
  }
  if (
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(result.administratorEmail) ||
    result.administratorEmail.startsWith("replace_")
  ) {
    throw new Task010SafetyError("ADMIN_EMAIL_INVALID");
  }
  if (Buffer.byteLength(result.sessionSecret, "utf8") < 32) {
    throw new Task010SafetyError("SESSION_SECRET_INVALID");
  }
  if (options.requireAdministratorPassword) {
    const administratorPassword = required(
      environment,
      "PACKSCOUT_TASK010_ADMIN_PASSWORD",
    );
    if (
      Buffer.byteLength(administratorPassword, "utf8") < 12 ||
      /^REPLACE_/iu.test(administratorPassword)
    ) {
      throw new Task010SafetyError("ADMIN_PASSWORD_INVALID");
    }
    return Object.freeze({ ...result, administratorPassword });
  }
  return Object.freeze(result);
}

export function task010DatabaseIdentity(input) {
  const canonical = [
    TASK010_SAFETY_VERSION,
    input.databaseName,
    input.databaseOid,
    input.systemIdentifier,
    input.serverAddress,
    input.serverPort,
  ].join("\0");
  return `task010-db:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function assertTask010DatabaseIdentity(identity, expected) {
  if (identity.databaseName !== expected.expectedDatabaseName) {
    throw new Task010SafetyError("DATABASE_IDENTITY_NAME_MISMATCH");
  }
  if (!localHost(identity.serverAddress)) {
    throw new Task010SafetyError("DATABASE_SERVER_NOT_LOOPBACK");
  }
  const fingerprint = task010DatabaseIdentity(identity);
  if (
    expected.expectedDatabaseIdentity !== null &&
    fingerprint !== expected.expectedDatabaseIdentity
  ) {
    throw new Task010SafetyError("DATABASE_IDENTITY_FINGERPRINT_MISMATCH");
  }
  return fingerprint;
}

export function assertTask010MigratedSchema(migration) {
  if (
    migration?.migrationName !== TASK010_REQUIRED_MIGRATION.name ||
    migration.checksum !== TASK010_REQUIRED_MIGRATION.checksum ||
    migration.finishedAt === null ||
    migration.rolledBackAt !== null ||
    migration.tableCount !== TASK010_REQUIRED_MIGRATION.tableCount
  ) {
    throw new Task010SafetyError("SCHEMA_NOT_READY");
  }
}

export function assertTask010BootstrapSnapshot(snapshot, expected) {
  if (snapshot.markerCount !== 1) {
    throw new Task010SafetyError("BOOTSTRAP_MARKER_INVALID");
  }
  if (
    snapshot.markerMetadata?.version !== TASK010_SAFETY_VERSION ||
    snapshot.markerMetadata.databaseIdentity !== expected.databaseIdentity ||
    snapshot.markerMetadata.migrationName !== TASK010_REQUIRED_MIGRATION.name ||
    snapshot.markerMetadata.migrationChecksum !==
      TASK010_REQUIRED_MIGRATION.checksum ||
    snapshot.markerMetadata.capacityArtifactVersion !==
      "provider-source-capacity-measurement-v1" ||
    snapshot.markerMetadata.capacityDecision !== "approved" ||
    (expected.capacityReceipt &&
      (snapshot.markerMetadata.capacityVolumePath !==
        expected.capacityReceipt.volumePath ||
        snapshot.markerMetadata.capacityDatabaseDataDirectory !==
          expected.capacityReceipt.databaseDataDirectory ||
        snapshot.markerMetadata.capacityVolumeDevice !==
          expected.capacityReceipt.volumeDevice))
  ) {
    throw new Task010SafetyError("BOOTSTRAP_RECEIPT_INVALID");
  }
  if (
    snapshot.organizations.length !== 1 ||
    snapshot.organizations[0]?.id !== expected.organizationId ||
    snapshot.organizations[0]?.slug !== expected.organizationSlug
  ) {
    throw new Task010SafetyError("BOOTSTRAP_ORGANIZATION_INVALID");
  }
  if (
    snapshot.administrators.length !== 1 ||
    snapshot.administrators[0]?.id !== expected.administratorId ||
    snapshot.administrators[0]?.organizationId !== expected.organizationId ||
    snapshot.administrators[0]?.email !== expected.administratorEmail ||
    snapshot.administrators[0]?.role !== "admin" ||
    snapshot.administrators[0]?.state !== "active"
  ) {
    throw new Task010SafetyError("BOOTSTRAP_ADMINISTRATOR_INVALID");
  }
  if (snapshot.providers.length !== TASK010_PROVIDER_IDENTITIES.length) {
    throw new Task010SafetyError("BOOTSTRAP_PROVIDER_COUNT_INVALID");
  }
  for (const definition of TASK010_PROVIDER_IDENTITIES) {
    const provider = snapshot.providers.find(({ id }) => id === definition.id);
    if (
      provider?.organizationId !== expected.organizationId ||
      provider.platformKey !== definition.platformKey ||
      provider.displayName !== definition.displayName ||
      provider.state !== "active" ||
      provider.activeRevisionId !== null ||
      provider.nextRunAt !== null
    ) {
      throw new Task010SafetyError("BOOTSTRAP_PROVIDER_IDENTITY_INVALID");
    }
  }
}

export function assertEvidenceTokenAbsent(environment) {
  if (environment.PACKSCOUT_DATA_API_TOKEN !== undefined) {
    throw new Task010SafetyError("PLAINTEXT_EVIDENCE_TOKEN_PRESENT");
  }
}

export function assertBootstrapPasswordAbsent(environment) {
  if (environment.PACKSCOUT_TASK010_ADMIN_PASSWORD !== undefined) {
    throw new Task010SafetyError("BOOTSTRAP_PASSWORD_PRESENT");
  }
}

export function task010MigrationInvocation(input) {
  if (!input.npmExecPath || !input.nodeExecPath) {
    throw new Task010SafetyError("NPM_EXEC_PATH_INVALID");
  }
  const inheritedNames = [
    "HOME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "npm_config_cache",
  ];
  const environment = Object.fromEntries(
    inheritedNames.flatMap((name) =>
      input.environment[name] === undefined
        ? []
        : [[name, input.environment[name]]],
    ),
  );
  environment.PACKSCOUT_DATABASE_URL = input.databaseUrl;
  return Object.freeze({
    executable: input.nodeExecPath,
    arguments: Object.freeze([
      input.npmExecPath,
      "run",
      "db:prisma:migrate:deploy",
    ]),
    environment: Object.freeze(environment),
  });
}

export function task010ConfigurationCapacityDecision() {
  return Object.freeze({
    admitted: false,
    state: "blocked",
    safeCode: "TASK010_CONFIGURATION_PHASE",
  });
}

export function sanitizedTask010WorkerEnvironment(environment) {
  const names = [
    "NODE_ENV",
    "PACKSCOUT_DATABASE_URL",
    "PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64",
    "PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64",
    "PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION",
    "PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH",
    "PACKSCOUT_WORKER_ID",
  ];
  const sanitized = Object.fromEntries(
    names.flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );
  // The sole production v1 admits the evidenced 8 MiB response boundary. The
  // dedicated Task 010 runner owns the one-slot safety bound and cannot inherit
  // a wider value from the ignored environment file or the ambient process.
  sanitized.PACKSCOUT_SOURCE_EXECUTION_SLOTS =
    TASK010_SOURCE_EXECUTION_SLOTS;
  return Object.freeze(sanitized);
}

export function assertTask010VolumeBinding(input) {
  const prefix = input.configuredPath.endsWith(input.separator)
    ? input.configuredPath
    : `${input.configuredPath}${input.separator}`;
  if (
    input.configuredDevice !== input.dataDirectoryDevice ||
    (input.dataDirectoryPath !== input.configuredPath &&
      !input.dataDirectoryPath.startsWith(prefix))
  ) {
    throw new Task010SafetyError("CAPACITY_VOLUME_NOT_DATABASE_BACKING");
  }
}

export function assertTask010BackfillTopologySnapshot(snapshot) {
  if (
    snapshot.profileCount !== 1 ||
    snapshot.activeProfileCount !== 1 ||
    snapshot.sourceCount !== 4 ||
    snapshot.readySourceCount !== 4 ||
    snapshot.providerRoots.length !== TASK010_PROVIDER_IDENTITIES.length ||
    TASK010_PROVIDER_IDENTITIES.some((definition) => {
      const provider = snapshot.providerRoots.find(
        ({ id }) => id === definition.id,
      );
      return (
        provider?.platformKey !== definition.platformKey ||
        provider.displayName !== definition.displayName ||
        provider.state !== "active" ||
        provider.activeRevisionId !== null ||
        provider.nextRunAt !== null
      );
    }) ||
    snapshot.sources.some(
      (source) =>
        !["paused", "active"].includes(source.state) ||
        source.activeRevisionId === null ||
        source.connectionProfileMatches !== true,
    )
  ) {
    throw new Task010SafetyError("BACKFILL_TOPOLOGY_NOT_READY");
  }
}

export function assessTask010ProviderReconciliation(input) {
  const failures = [];
  if (!input.reachedHead) failures.push("provider_head_not_reached");
  if (input.sourceState !== "active") failures.push("source_not_active");
  if (input.pageRecordCount !== input.dispositionCount) {
    failures.push("page_record_disposition_mismatch");
  }
  if (input.quarantinedDispositionCount !== input.quarantineCount) {
    failures.push("quarantine_disposition_mismatch");
  }
  if (input.openQuarantineCount !== 0) failures.push("open_quarantine");
  if (input.launchBlockingQuarantineCount !== 0) {
    failures.push("launch_blocking_quarantine");
  }
  if (input.unresolvedRelationshipCount !== 0) {
    failures.push("unresolved_relationship");
  }
  if (input.failedEvCount !== 0 || input.pendingEvCount !== 0) {
    failures.push("ev_not_terminal");
  }
  if (input.nonterminalRequestAttemptCount !== 0) {
    failures.push("nonterminal_request_attempt");
  }
  if (input.missingResponseByteEvidenceCount !== 0) {
    failures.push("missing_response_byte_evidence");
  }
  if (input.availabilityCount !== input.canonicalPackCount) {
    failures.push("availability_reconciliation_mismatch");
  }
  if (input.evCalculationMismatchCount !== 0) {
    failures.push("ev_calculation_reconciliation_mismatch");
  }
  return Object.freeze({
    status: failures.length === 0 ? "PASS" : "BLOCKED",
    failures: Object.freeze(failures),
  });
}

export function task010PageRecordCount(recordCounts) {
  const keys = ["catalog", "pulls", "trades", "adapterInvalid"];
  let total = 0;
  for (const key of keys) {
    const value = recordCounts[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Task010SafetyError("PAGE_RECORD_COUNT_INVALID");
    }
    total += value;
  }
  if (!Number.isSafeInteger(total)) {
    throw new Task010SafetyError("PAGE_RECORD_COUNT_INVALID");
  }
  return total;
}

export function safeTask010Failure(error) {
  return Object.freeze({
    version: TASK010_SAFETY_VERSION,
    ok: false,
    code:
      error instanceof Task010SafetyError
        ? error.code
        : "TASK010_OPERATION_FAILED",
  });
}
