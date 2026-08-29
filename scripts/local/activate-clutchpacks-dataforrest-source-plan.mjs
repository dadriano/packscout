const DATAFORREST_TOKEN_KEY = "PACKSCOUT_DATA_API_TOKEN";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const EXPECTED_DATABASES = Object.freeze({
  central: Object.freeze({
    databaseName: "packscout",
    hostname: "127.0.0.1",
    port: "55431",
    username: "packscout_control_app",
  }),
  provider: Object.freeze({
    databaseName: "packscout_clutchpacks",
    hostname: "127.0.0.1",
    port: "55432",
    username: "packscout_clutchpacks_app",
  }),
});

export class ClutchpacksDataforrestActivationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ClutchpacksDataforrestActivationError";
    this.code = code;
  }
}

function refuse(code) {
  throw new ClutchpacksDataforrestActivationError(code);
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

function exactLocalDatabaseUrl(rawValue, expected) {
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
    parsed.hostname !== expected.hostname ||
    parsed.port !== expected.port ||
    databaseName !== expected.databaseName ||
    username !== expected.username ||
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
 * Takes the live token from the process environment and immediately removes
 * that environment entry. Repository .env content is deliberately not read by
 * this function, so a checked-in or persisted token cannot unlock activation.
 */
export function takeClutchpacksDataforrestToken(environment) {
  const candidate = environment[DATAFORREST_TOKEN_KEY];
  delete environment[DATAFORREST_TOKEN_KEY];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate !== candidate.trim() ||
    Buffer.byteLength(candidate, "utf8") > 4_096 ||
    [...candidate].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    refuse("DATAFORREST_TOKEN_REQUIRED");
  }
  return candidate;
}

/**
 * Removes a process-only token immediately when one was supplied. The narrow
 * local adapter-profile upgrade can instead reuse the exact active encrypted
 * source credential, so absence is distinct from malformed token input.
 */
export function takeOptionalClutchpacksDataforrestToken(environment) {
  return Object.hasOwn(environment, DATAFORREST_TOKEN_KEY)
    ? takeClutchpacksDataforrestToken(environment)
    : null;
}

export function assertNoClutchpacksActivationArguments(argumentsList) {
  if (argumentsList.length !== 0) refuse("ACTIVATION_ARGUMENTS_FORBIDDEN");
}

export function assertDataforrestTokenAbsentFromFileEnvironment(environment) {
  if (Object.hasOwn(environment, DATAFORREST_TOKEN_KEY)) {
    refuse("DATAFORREST_TOKEN_FILE_FORBIDDEN");
  }
}

export function readClutchpacksDataforrestActivationEnvironment(input) {
  if (input.processEnvironment.NODE_ENV !== "development") {
    refuse("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED");
  }
  const fileEnvironment = input.fileEnvironment;
  assertDataforrestTokenAbsentFromFileEnvironment(fileEnvironment);
  const providerId = required(fileEnvironment, "PACKSCOUT_PROVIDER_ID", 64);
  if (
    !UUID_PATTERN.test(providerId) ||
    required(fileEnvironment, "PACKSCOUT_PROVIDER_KEY", 53) !== "clutchpacks"
  ) {
    refuse("ACTIVATION_PROVIDER_IDENTITY_INVALID");
  }
  const keyring = credentialKey(fileEnvironment);
  return Object.freeze({
    centralDatabaseUrl: exactLocalDatabaseUrl(
      required(fileEnvironment, "PACKSCOUT_CENTRAL_DATABASE_URL", 2_048),
      EXPECTED_DATABASES.central,
    ),
    providerDatabaseUrl: exactLocalDatabaseUrl(
      required(fileEnvironment, "PACKSCOUT_PROVIDER_DATABASE_URL", 2_048),
      EXPECTED_DATABASES.provider,
    ),
    providerId,
    providerKey: "clutchpacks",
    credentialKey: keyring.bytes,
    credentialKeyVersion: keyring.version,
  });
}

export function clutchpacksDataforrestConfiguration() {
  return Object.freeze({ platform: "clutchpacks" });
}

export function safeClutchpacksDataforrestActivationError(error) {
  return error instanceof ClutchpacksDataforrestActivationError
    ? error
    : new ClutchpacksDataforrestActivationError(
        "CLUTCHPACKS_DATAFORREST_ACTIVATION_FAILED",
      );
}

export function safeClutchpacksDataforrestSnapshotError(error) {
  return error instanceof ClutchpacksDataforrestActivationError
    ? error
    : new ClutchpacksDataforrestActivationError(
        "ACTIVATION_SNAPSHOT_READ_FAILED",
      );
}
