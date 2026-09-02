export type ProviderActivityRelayProcessMode = "daemon" | "once";

export type ProviderActivityRelayProcessConfigurationErrorCode =
  | "PROVIDER_ACTIVITY_RELAY_AUTHORITY_CONFLICT"
  | "PROVIDER_ACTIVITY_RELAY_BOUNDS_INVALID"
  | "PROVIDER_ACTIVITY_RELAY_CENTRAL_DATABASE_INVALID"
  | "PROVIDER_ACTIVITY_RELAY_ENVIRONMENT_INVALID"
  | "PROVIDER_ACTIVITY_RELAY_PROVIDER_CREDENTIAL_INVALID"
  | "PROVIDER_ACTIVITY_RELAY_PROVIDER_DESTINATION_INVALID"
  | "PROVIDER_ACTIVITY_RELAY_RUN_MODE_INVALID";

export class ProviderActivityRelayProcessConfigurationError extends Error {
  constructor(
    readonly code: ProviderActivityRelayProcessConfigurationErrorCode,
  ) {
    super("Provider activity relay process configuration is invalid.");
    this.name = "ProviderActivityRelayProcessConfigurationError";
  }
}

export interface ProviderActivityRelayProcessConfiguration {
  readonly mode: ProviderActivityRelayProcessMode;
  readonly centralDatabaseUrl: string;
  readonly providerCredentialKey: Readonly<{
    version: number;
    bytes: Uint8Array;
  }>;
  readonly providerDestinations: Readonly<{
    allowedHosts: readonly string[];
    allowedPorts: readonly number[];
    allowedSslModes: readonly (
      "disable" | "require" | "verify-ca" | "verify-full"
    )[];
  }>;
  readonly gateway: Readonly<{
    connectionLimitPerProvider: number;
    maximumCachedProviders: number;
    idleLifetimeMs: number;
    connectionTimeoutMs: number;
    operationTimeoutMs: number;
    closeTimeoutMs: number;
  }>;
  readonly relay: Readonly<{
    pollMilliseconds: number;
    batchSize: number;
    maximumProvidersPerCycle: number;
    maximumConcurrentProviders: number;
    baseBackoffMilliseconds: number;
    maximumBackoffMilliseconds: number;
  }>;
}

/** Capabilities that are never needed by this central-to-provider relay. */
const CROSS_AUTHORITY_KEYS = [
  "PACKSCOUT_DATABASE_URL",
  "PACKSCOUT_PROVIDER_DATABASE_URL",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_ID",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_KEY",
  "PACKSCOUT_PROMOTION_RELAY_PROVIDER_DATABASE_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_KEY_ID",
  "PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_BASE_URL",
  "PACKSCOUT_PROMOTION_PROVIDER_BOOTSTRAP_TOKEN_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_KEY_ID",
  "PACKSCOUT_PROMOTION_MANIFEST_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_MANIFEST_AUTHORITY_VERSION",
  "PACKSCOUT_PROMOTION_MANIFEST_PROOF_BASE_URL",
  "PACKSCOUT_PROMOTION_MANIFEST_PROOF_TOKEN_BASE64",
  "PACKSCOUT_CONVEX_PUBLICATION_BASE_URL",
  "PACKSCOUT_CONVEX_PUBLICATION_KEY_ID",
  "PACKSCOUT_CONVEX_PUBLICATION_SECRET_BASE64",
  "PACKSCOUT_CATALOG_DEPLOYMENT_KEY",
  "PACKSCOUT_CATALOG_PLATFORM_KEY",
  "PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS",
  "PACKSCOUT_CATALOG_PROVIDER_KEY_ID",
  "PACKSCOUT_CATALOG_PROVIDER_SECRET_BASE64",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_KEY_ID",
  "PACKSCOUT_CATALOG_MANIFEST_PUBLISH_SECRET_BASE64",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_KEY_ID",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64",
  "PACKSCOUT_PROMOTION_CONTINUATION_GENERATION",
  "PACKSCOUT_DISTRIBUTED_PROMOTION_MANUAL_COMMAND_ATTESTATION",
  "PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL",
  "PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64",
  "PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_OVERRIDE_ACCESS_TOKEN",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
] as const;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

function fail(
  code: ProviderActivityRelayProcessConfigurationErrorCode,
): never {
  throw new ProviderActivityRelayProcessConfigurationError(code);
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(resolved)) {
    return fail("PROVIDER_ACTIVITY_RELAY_BOUNDS_INVALID");
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fail("PROVIDER_ACTIVITY_RELAY_BOUNDS_INVALID");
  }
  return parsed;
}

function centralDatabaseUrl(value: string | undefined): string {
  if (!value || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
    return fail("PROVIDER_ACTIVITY_RELAY_CENTRAL_DATABASE_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol)
      || !parsed.hostname || parsed.pathname.length < 2 || parsed.hash
    ) throw new Error("invalid");
    return parsed.toString();
  } catch {
    return fail("PROVIDER_ACTIVITY_RELAY_CENTRAL_DATABASE_INVALID");
  }
}

function providerCredentialKey(value: string | undefined): Uint8Array {
  if (!value || !BASE64_PATTERN.test(value)) {
    return fail("PROVIDER_ACTIVITY_RELAY_PROVIDER_CREDENTIAL_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.byteLength !== 32) {
    return fail("PROVIDER_ACTIVITY_RELAY_PROVIDER_CREDENTIAL_INVALID");
  }
  return new Uint8Array(decoded);
}

function allowedHosts(
  value: string | undefined,
  production: boolean,
): readonly string[] {
  const resolved = value ?? (production ? "" : "127.0.0.1");
  const entries = resolved.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (
    entries.length < 1 || entries.length > 64
    || new Set(entries).size !== entries.length
    || entries.some((host) => !HOST_PATTERN.test(host))
  ) return fail("PROVIDER_ACTIVITY_RELAY_PROVIDER_DESTINATION_INVALID");
  return Object.freeze(entries);
}

function allowedPorts(
  value: string | undefined,
  production: boolean,
): readonly number[] {
  const resolved = value ?? (production ? "5432" : "55432,55433,55434,55435");
  const entries = resolved.split(",").map((entry) => Number(entry));
  if (
    entries.length < 1 || entries.length > 16
    || entries.some((port) =>
      !Number.isInteger(port) || port < 1 || port > 65_535)
    || new Set(entries).size !== entries.length
    || (production && (entries.length !== 1 || entries[0] !== 5_432))
  ) return fail("PROVIDER_ACTIVITY_RELAY_PROVIDER_DESTINATION_INVALID");
  return Object.freeze(entries);
}

function allowedSslModes(
  value: string | undefined,
  production: boolean,
): ProviderActivityRelayProcessConfiguration["providerDestinations"]["allowedSslModes"] {
  const resolved = value ?? (production ? "verify-full" : "disable");
  const allowed = new Set(["disable", "require", "verify-ca", "verify-full"]);
  const entries = resolved.split(",").map((entry) => entry.trim());
  if (
    entries.length < 1 || entries.length > 4
    || entries.some((mode) => !allowed.has(mode))
    || new Set(entries).size !== entries.length
    || (production && (entries.length !== 1 || entries[0] !== "verify-full"))
  ) return fail("PROVIDER_ACTIVITY_RELAY_PROVIDER_DESTINATION_INVALID");
  return Object.freeze(entries) as
    ProviderActivityRelayProcessConfiguration["providerDestinations"]["allowedSslModes"];
}

export function readProviderActivityRelayProcessConfiguration(
  environment: NodeJS.ProcessEnv,
): ProviderActivityRelayProcessConfiguration {
  if (CROSS_AUTHORITY_KEYS.some((key) => environment[key] !== undefined)) {
    fail("PROVIDER_ACTIVITY_RELAY_AUTHORITY_CONFLICT");
  }
  if (
    environment.NODE_ENV !== "production"
    && environment.NODE_ENV !== "development"
    && environment.NODE_ENV !== "test"
  ) fail("PROVIDER_ACTIVITY_RELAY_ENVIRONMENT_INVALID");
  const production = environment.NODE_ENV === "production";
  const mode = environment.PACKSCOUT_PROMOTION_RELAY_RUN_MODE ?? "daemon";
  if (mode !== "daemon" && mode !== "once") {
    fail("PROVIDER_ACTIVITY_RELAY_RUN_MODE_INVALID");
  }
  const maximumConcurrentProviders = integer(
    environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONCURRENCY,
    8,
    1,
    32,
  );
  const maximumCachedProviders = integer(
    environment.PACKSCOUT_PROMOTION_RELAY_MAXIMUM_CACHED_PROVIDERS,
    Math.max(16, maximumConcurrentProviders),
    maximumConcurrentProviders,
    128,
  );
  const baseBackoffMilliseconds = integer(
    environment.PACKSCOUT_PROMOTION_RELAY_BASE_BACKOFF_MS,
    1_000,
    100,
    60_000,
  );
  const maximumBackoffMilliseconds = integer(
    environment.PACKSCOUT_PROMOTION_RELAY_MAXIMUM_BACKOFF_MS,
    60_000,
    baseBackoffMilliseconds,
    3_600_000,
  );
  const keyVersion = integer(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION,
    1,
    1,
    2_147_483_647,
  );
  return Object.freeze({
    mode,
    centralDatabaseUrl: centralDatabaseUrl(
      environment.PACKSCOUT_CENTRAL_DATABASE_URL,
    ),
    providerCredentialKey: Object.freeze({
      version: keyVersion,
      bytes: providerCredentialKey(
        environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
      ),
    }),
    providerDestinations: Object.freeze({
      allowedHosts: allowedHosts(
        environment.PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS,
        production,
      ),
      allowedPorts: allowedPorts(
        environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_ALLOWED_PORTS,
        production,
      ),
      allowedSslModes: allowedSslModes(
        environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_ALLOWED_SSL_MODES,
        production,
      ),
    }),
    gateway: Object.freeze({
      connectionLimitPerProvider: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONNECTION_LIMIT,
        1,
        1,
        4,
      ),
      maximumCachedProviders,
      idleLifetimeMs: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_IDLE_LIFETIME_MS,
        60_000,
        1_000,
        3_600_000,
      ),
      connectionTimeoutMs: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_CONNECTION_TIMEOUT_MS,
        10_000,
        100,
        60_000,
      ),
      operationTimeoutMs: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_OPERATION_TIMEOUT_MS,
        15_000,
        100,
        60_000,
      ),
      closeTimeoutMs: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_PROVIDER_CLOSE_TIMEOUT_MS,
        5_000,
        100,
        60_000,
      ),
    }),
    relay: Object.freeze({
      pollMilliseconds: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_POLL_MS,
        1_000,
        100,
        60_000,
      ),
      batchSize: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_BATCH_SIZE,
        25,
        1,
        100,
      ),
      maximumProvidersPerCycle: integer(
        environment.PACKSCOUT_PROMOTION_RELAY_MAXIMUM_PROVIDERS_PER_CYCLE,
        250,
        1,
        1_000,
      ),
      maximumConcurrentProviders,
      baseBackoffMilliseconds,
      maximumBackoffMilliseconds,
    }),
  });
}
