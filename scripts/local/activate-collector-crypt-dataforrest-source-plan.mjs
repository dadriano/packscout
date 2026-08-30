const DATAFORREST_TOKEN_KEY = "PACKSCOUT_DATA_API_TOKEN";

const EXPECTED_CENTRAL_DATABASE = Object.freeze({
  databaseName: "packscout",
  hostname: "127.0.0.1",
  port: "55431",
  username: "packscout_control_app",
});

export class CollectorCryptDataforrestActivationError extends Error {
  constructor(code) {
    super(code);
    this.name = "CollectorCryptDataforrestActivationError";
    this.code = code;
  }
}

function refuse(code) {
  throw new CollectorCryptDataforrestActivationError(code);
}

function required(environment, key, maximumBytes = 4_096) {
  const value = environment[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\r\n\0]/u.test(value)
  ) {
    refuse("ACTIVATION_ENVIRONMENT_INVALID");
  }
  return value;
}

function exactLocalCentralDatabaseUrl(rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    refuse("ACTIVATION_DATABASE_TARGET_INVALID");
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const username = decodeURIComponent(parsed.username);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname !== EXPECTED_CENTRAL_DATABASE.hostname ||
    parsed.port !== EXPECTED_CENTRAL_DATABASE.port ||
    databaseName !== EXPECTED_CENTRAL_DATABASE.databaseName ||
    username !== EXPECTED_CENTRAL_DATABASE.username ||
    parsed.password.length === 0 ||
    parsed.hash.length !== 0 ||
    parsed.searchParams.size !== 0
  ) {
    refuse("ACTIVATION_DATABASE_TARGET_INVALID");
  }
  return rawValue;
}

function credentialKey(environment) {
  const encoded = required(
    environment,
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
    128,
  );
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength !== 32 ||
    bytes.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
  ) {
    refuse("ACTIVATION_CREDENTIAL_KEY_INVALID");
  }
  const rawVersion =
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION ?? "1";
  if (!/^[1-9][0-9]{0,9}$/u.test(rawVersion)) {
    refuse("ACTIVATION_CREDENTIAL_KEY_INVALID");
  }
  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || version > 2_147_483_647) {
    refuse("ACTIVATION_CREDENTIAL_KEY_INVALID");
  }
  return Object.freeze({ bytes: new Uint8Array(bytes), version });
}

/**
 * Collector Crypt activation may only reuse the already-authorized central
 * DataForrest authority. A process/file token would bypass that lineage, so
 * remove it before failing closed.
 */
export function assertCollectorCryptDataforrestTokenAbsent(environment) {
  if (Object.hasOwn(environment, DATAFORREST_TOKEN_KEY)) {
    environment[DATAFORREST_TOKEN_KEY] = "";
    delete environment[DATAFORREST_TOKEN_KEY];
    refuse("DATAFORREST_PROCESS_TOKEN_FORBIDDEN");
  }
}

export function assertNoCollectorCryptActivationArguments(argumentsList) {
  if (argumentsList.length !== 0) refuse("ACTIVATION_ARGUMENTS_FORBIDDEN");
}

export function readCollectorCryptDataforrestActivationEnvironment(input) {
  if (input.processEnvironment.NODE_ENV !== "development") {
    refuse("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED");
  }
  assertCollectorCryptDataforrestTokenAbsent(input.processEnvironment);
  assertCollectorCryptDataforrestTokenAbsent(input.fileEnvironment);
  const keyring = credentialKey(input.fileEnvironment);
  return Object.freeze({
    centralDatabaseUrl: exactLocalCentralDatabaseUrl(
      required(input.fileEnvironment, "PACKSCOUT_CENTRAL_DATABASE_URL", 2_048),
    ),
    credentialKey: keyring.bytes,
    credentialKeyVersion: keyring.version,
  });
}

export function collectorCryptDataforrestConfiguration() {
  return Object.freeze({ platform: "collector_crypt" });
}

export function safeCollectorCryptDataforrestActivationError(error) {
  return error instanceof CollectorCryptDataforrestActivationError
    ? error
    : new CollectorCryptDataforrestActivationError(
        "COLLECTOR_CRYPT_DATAFORREST_ACTIVATION_FAILED",
      );
}
