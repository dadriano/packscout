export type PromotionJobLivenessProcessMode = "daemon" | "once";

export type PromotionJobLivenessProcessConfigurationErrorCode =
  | "PROMOTION_JOB_LIVENESS_AUTHORITY_CONFLICT"
  | "PROMOTION_JOB_LIVENESS_BOUNDS_INVALID"
  | "PROMOTION_JOB_LIVENESS_CENTRAL_DATABASE_INVALID"
  | "PROMOTION_JOB_LIVENESS_ENVIRONMENT_INVALID"
  | "PROMOTION_JOB_LIVENESS_PROVIDER_CREDENTIAL_INVALID"
  | "PROMOTION_JOB_LIVENESS_PROVIDER_DESTINATION_INVALID"
  | "PROMOTION_JOB_LIVENESS_RUN_MODE_INVALID"
  | "PROMOTION_JOB_LIVENESS_SYSTEM_SINK_INVALID";

export class PromotionJobLivenessProcessConfigurationError extends Error {
  constructor(
    readonly code: PromotionJobLivenessProcessConfigurationErrorCode,
  ) {
    super("Promotion job liveness process configuration is invalid.");
    this.name = "PromotionJobLivenessProcessConfigurationError";
  }
}

export interface PromotionJobLivenessProcessConfiguration {
  readonly mode: PromotionJobLivenessProcessMode;
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
    operationTimeoutMs: number;
    closeTimeoutMs: number;
  }>;
  readonly evaluator: Readonly<{
    providerConcurrency: number;
    rosterPageSize: number;
    maximumProviders: number;
    deliveryLimit: number;
  }>;
  readonly systemSink: Readonly<{
    url: string;
    bearerToken: Uint8Array;
    timeoutMs: number;
  }>;
}

const CROSS_AUTHORITY_KEYS = [
  "PACKSCOUT_DATABASE_URL",
  "PACKSCOUT_PROMOTION_EVALUATOR_WATCHDOG_DATABASE_URL",
  "PACKSCOUT_PROVIDER_DATABASE_URL",
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
  "PACKSCOUT_CATALOG_PROVIDER_CREDENTIALS",
  "PACKSCOUT_CATALOG_MANIFEST_CLEAR_SECRET_BASE64",
] as const;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

function fail(
  code: PromotionJobLivenessProcessConfigurationErrorCode,
): never {
  throw new PromotionJobLivenessProcessConfigurationError(code);
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? String(fallback);
  if (!/^[1-9][0-9]*$/u.test(resolved)) {
    return fail("PROMOTION_JOB_LIVENESS_BOUNDS_INVALID");
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fail("PROMOTION_JOB_LIVENESS_BOUNDS_INVALID");
  }
  return parsed;
}

function databaseUrl(value: string | undefined): string {
  if (!value || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
    return fail("PROMOTION_JOB_LIVENESS_CENTRAL_DATABASE_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname || parsed.pathname.length < 2 || parsed.hash
    ) throw new Error("invalid");
    return parsed.toString();
  } catch {
    return fail("PROMOTION_JOB_LIVENESS_CENTRAL_DATABASE_INVALID");
  }
}

function base64Bytes(
  value: string | undefined,
  minimum: number,
  maximum: number,
  failureCode:
    | "PROMOTION_JOB_LIVENESS_PROVIDER_CREDENTIAL_INVALID"
    | "PROMOTION_JOB_LIVENESS_SYSTEM_SINK_INVALID",
): Uint8Array {
  if (!value || !BASE64_PATTERN.test(value)) return fail(failureCode);
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value || decoded.byteLength < minimum ||
    decoded.byteLength > maximum
  ) return fail(failureCode);
  return new Uint8Array(decoded);
}

function hosts(value: string | undefined, production: boolean): readonly string[] {
  const resolved = value ?? (production ? "" : "127.0.0.1");
  const entries = resolved.split(",").map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    entries.length < 1 || entries.length > 64 ||
    new Set(entries).size !== entries.length ||
    entries.some((host) => !HOST_PATTERN.test(host))
  ) return fail("PROMOTION_JOB_LIVENESS_PROVIDER_DESTINATION_INVALID");
  return Object.freeze(entries);
}

function ports(
  value: string | undefined,
  production: boolean,
): readonly number[] {
  const resolved = value ?? (production ? "5432" : "55432,55433,55434,55435");
  const entries = resolved.split(",").map((item) => Number(item));
  if (
    entries.length < 1 || entries.length > 16 ||
    entries.some((port) =>
      !Number.isInteger(port) || port < 1 || port > 65_535) ||
    new Set(entries).size !== entries.length ||
    (production && (entries.length !== 1 || entries[0] !== 5_432))
  ) return fail("PROMOTION_JOB_LIVENESS_PROVIDER_DESTINATION_INVALID");
  return Object.freeze(entries);
}

function sslModes(
  value: string | undefined,
  production: boolean,
): PromotionJobLivenessProcessConfiguration["providerDestinations"]["allowedSslModes"] {
  const resolved = value ?? (production ? "verify-full" : "disable");
  const allowed = new Set(["disable", "require", "verify-ca", "verify-full"]);
  const entries = resolved.split(",").map((item) => item.trim());
  if (
    entries.length < 1 || entries.length > 4 ||
    entries.some((mode) => !allowed.has(mode)) ||
    new Set(entries).size !== entries.length ||
    (production && (entries.length !== 1 || entries[0] !== "verify-full"))
  ) return fail("PROMOTION_JOB_LIVENESS_PROVIDER_DESTINATION_INVALID");
  return Object.freeze(entries) as
    PromotionJobLivenessProcessConfiguration["providerDestinations"]["allowedSslModes"];
}

function webhookUrl(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n\0]/u.test(value)) {
    return fail("PROMOTION_JOB_LIVENESS_SYSTEM_SINK_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || !parsed.hostname || parsed.username ||
      parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    ) throw new Error("invalid");
    return parsed.toString();
  } catch {
    return fail("PROMOTION_JOB_LIVENESS_SYSTEM_SINK_INVALID");
  }
}

export function readPromotionJobLivenessProcessConfiguration(
  environment: NodeJS.ProcessEnv,
): PromotionJobLivenessProcessConfiguration {
  if (CROSS_AUTHORITY_KEYS.some((key) => environment[key] !== undefined)) {
    fail("PROMOTION_JOB_LIVENESS_AUTHORITY_CONFLICT");
  }
  if (
    environment.NODE_ENV !== "production"
    && environment.NODE_ENV !== "development"
    && environment.NODE_ENV !== "test"
  ) fail("PROMOTION_JOB_LIVENESS_ENVIRONMENT_INVALID");
  const production = environment.NODE_ENV === "production";
  const mode = environment.PACKSCOUT_PROMOTION_LIVENESS_RUN_MODE ?? "daemon";
  if (mode !== "daemon" && mode !== "once") {
    fail("PROMOTION_JOB_LIVENESS_RUN_MODE_INVALID");
  }
  const providerConcurrency = integer(
    environment.PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_CONCURRENCY,
    8,
    1,
    32,
  );
  const maximumProviders = integer(
    environment.PACKSCOUT_PROMOTION_LIVENESS_MAXIMUM_PROVIDERS,
    4_096,
    1,
    100_000,
  );
  const rosterPageSize = integer(
    environment.PACKSCOUT_PROMOTION_LIVENESS_ROSTER_PAGE_SIZE,
    250,
    1,
    500,
  );
  if (rosterPageSize > maximumProviders) {
    fail("PROMOTION_JOB_LIVENESS_BOUNDS_INVALID");
  }
  const keyVersion = integer(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION,
    1,
    1,
    2_147_483_647,
  );
  return Object.freeze({
    mode,
    centralDatabaseUrl: databaseUrl(
      environment.PACKSCOUT_CENTRAL_DATABASE_URL,
    ),
    providerCredentialKey: Object.freeze({
      version: keyVersion,
      bytes: base64Bytes(
        environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
        32,
        32,
        "PROMOTION_JOB_LIVENESS_PROVIDER_CREDENTIAL_INVALID",
      ),
    }),
    providerDestinations: Object.freeze({
      allowedHosts: hosts(
        environment.PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS,
        production,
      ),
      allowedPorts: ports(
        environment.PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_ALLOWED_PORTS,
        production,
      ),
      allowedSslModes: sslModes(
        environment.PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_ALLOWED_SSL_MODES,
        production,
      ),
    }),
    gateway: Object.freeze({
      connectionLimitPerProvider: integer(
        environment.PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_CONNECTION_LIMIT,
        1,
        1,
        4,
      ),
      maximumCachedProviders: integer(
        environment.PACKSCOUT_PROMOTION_LIVENESS_MAXIMUM_CACHED_PROVIDERS,
        Math.max(16, providerConcurrency),
        providerConcurrency,
        128,
      ),
      operationTimeoutMs: integer(
        environment.PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_TIMEOUT_MS,
        15_000,
        100,
        60_000,
      ),
      closeTimeoutMs: integer(
        environment.PACKSCOUT_PROMOTION_LIVENESS_PROVIDER_CLOSE_TIMEOUT_MS,
        5_000,
        100,
        60_000,
      ),
    }),
    evaluator: Object.freeze({
      providerConcurrency,
      rosterPageSize,
      maximumProviders,
      deliveryLimit: integer(
        environment.PACKSCOUT_PROMOTION_LIVENESS_DELIVERY_LIMIT,
        50,
        1,
        100,
      ),
    }),
    systemSink: Object.freeze({
      url: webhookUrl(
        environment.PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_URL,
      ),
      bearerToken: base64Bytes(
        environment.PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TOKEN_BASE64,
        32,
        128,
        "PROMOTION_JOB_LIVENESS_SYSTEM_SINK_INVALID",
      ),
      timeoutMs: integer(
        environment.PACKSCOUT_PROMOTION_SYSTEM_CONDITION_WEBHOOK_TIMEOUT_MS,
        10_000,
        100,
        60_000,
      ),
    }),
  });
}
