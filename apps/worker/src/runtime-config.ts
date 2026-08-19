import type { ProviderRuntimeEnvironment } from "@packscout/services";

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ProviderWorkerConfigurationErrorCode =
  | "ACTOR_KEY_INVALID"
  | "CREDENTIAL_KEY_INVALID"
  | "CREDENTIAL_KEY_VERSION_INVALID"
  | "DATABASE_POOL_MAX_INVALID"
  | "DATABASE_URL_INVALID"
  | "ESTIMATED_EV_STABLECOINS_INVALID"
  | "IMPORT_MAX_PAGES_INVALID"
  | "IMPORT_MAX_DURATION_INVALID"
  | "IMPORT_MIN_FREE_BYTES_INVALID"
  | "IMPORT_PAGE_BUDGET_INVALID"
  | "MAXIMUM_CLAIMS_INVALID"
  | "NODE_ENV_INVALID"
  | "ONE_SHOT_TARGET_INVALID"
  | "POLL_INTERVAL_INVALID"
  | "RETENTION_BATCH_SIZE_INVALID"
  | "RETENTION_DISCOVERY_LIMIT_INVALID"
  | "RETENTION_MAX_BATCHES_INVALID"
  | "WORKER_MODE_INVALID"
  | "WORKER_ID_INVALID";

export class ProviderWorkerConfigurationError extends Error {
  constructor(readonly code: ProviderWorkerConfigurationErrorCode) {
    super("Provider worker configuration is invalid.");
    this.name = "ProviderWorkerConfigurationError";
  }
}

export interface ProviderWorkerConfiguration {
  readonly actorPseudonymKey: Uint8Array;
  readonly credentialKey: Uint8Array;
  readonly credentialKeyVersion: number;
  readonly databasePoolMaximum: number;
  readonly databaseUrl: string;
  readonly environment: ProviderRuntimeEnvironment;
  readonly estimatedEvVerifiedUsdStablecoins: readonly string[];
  readonly importMaximumPages: number;
  readonly importMaximumRunDurationMilliseconds: number;
  readonly importMinimumFreeBytes: number;
  readonly importPageBudgetPerClaim: number;
  readonly maximumClaimsPerCycle: number;
  readonly executionMode: "continuous" | "one-shot";
  readonly oneShotTarget: {
    readonly organizationId: string;
    readonly runId: string;
  } | null;
  readonly pollIntervalMilliseconds: number;
  readonly retentionBatchSize: number;
  readonly retentionMaximumBatchesPerCycle: number;
  readonly retentionOrganizationDiscoveryLimit: number;
  readonly workerId: string;
}

function environmentFor(value: string | undefined): ProviderRuntimeEnvironment {
  if (value === undefined || value === "development" || value === "local") {
    return "local";
  }
  if (value === "production" || value === "test") return value;
  throw new ProviderWorkerConfigurationError("NODE_ENV_INVALID");
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: ProviderWorkerConfigurationErrorCode,
): number {
  const resolved = value === undefined ? String(fallback) : value;
  if (!/^[1-9][0-9]*$/.test(resolved)) {
    throw new ProviderWorkerConfigurationError(code);
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProviderWorkerConfigurationError(code);
  }
  return parsed;
}

function boundedNonnegativeInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
  code: ProviderWorkerConfigurationErrorCode,
): number {
  const resolved = value === undefined ? String(fallback) : value;
  if (!/^(?:0|[1-9][0-9]*)$/.test(resolved)) {
    throw new ProviderWorkerConfigurationError(code);
  }
  const parsed = Number(resolved);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new ProviderWorkerConfigurationError(code);
  }
  return parsed;
}

function databaseUrlFor(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/.test(value)) {
    throw new ProviderWorkerConfigurationError("DATABASE_URL_INVALID");
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      parsed.hostname.length === 0
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new ProviderWorkerConfigurationError("DATABASE_URL_INVALID");
  }
  return value;
}

function keyFor(
  value: string | undefined,
  code: "ACTOR_KEY_INVALID" | "CREDENTIAL_KEY_INVALID",
): Uint8Array {
  if (!value || !canonicalBase64Pattern.test(value)) {
    throw new ProviderWorkerConfigurationError(code);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new ProviderWorkerConfigurationError(code);
  }
  return new Uint8Array(decoded);
}

function workerIdFor(value: string | undefined, fallback: string): string {
  const resolved = value ?? fallback;
  if (!workerIdPattern.test(resolved)) {
    throw new ProviderWorkerConfigurationError("WORKER_ID_INVALID");
  }
  return resolved;
}

function verifiedUsdStablecoinsFor(
  value: string | undefined,
): readonly string[] {
  if (value === undefined || value === "") return Object.freeze([]);
  if (value.length > 512 || !/^[A-Z0-9]{2,12}(,[A-Z0-9]{2,12})*$/.test(value)) {
    throw new ProviderWorkerConfigurationError(
      "ESTIMATED_EV_STABLECOINS_INVALID",
    );
  }
  const currencies = value.split(",");
  if (
    currencies.includes("USD") ||
    new Set(currencies).size !== currencies.length ||
    currencies.length > 32
  ) {
    throw new ProviderWorkerConfigurationError(
      "ESTIMATED_EV_STABLECOINS_INVALID",
    );
  }
  return Object.freeze([...currencies].sort());
}

function executionFor(
  environment: NodeJS.ProcessEnv,
): Pick<ProviderWorkerConfiguration, "executionMode" | "oneShotTarget"> {
  const mode = environment.PACKSCOUT_WORKER_MODE ?? "continuous";
  const organizationId = environment.PACKSCOUT_WORKER_ONE_SHOT_ORGANIZATION_ID;
  const runId = environment.PACKSCOUT_WORKER_ONE_SHOT_RUN_ID;
  if (mode === "continuous") {
    if (organizationId !== undefined || runId !== undefined) {
      throw new ProviderWorkerConfigurationError("ONE_SHOT_TARGET_INVALID");
    }
    return { executionMode: mode, oneShotTarget: null };
  }
  if (mode !== "one-shot") {
    throw new ProviderWorkerConfigurationError("WORKER_MODE_INVALID");
  }
  if (
    !organizationId ||
    !runId ||
    !uuidPattern.test(organizationId) ||
    !uuidPattern.test(runId)
  ) {
    throw new ProviderWorkerConfigurationError("ONE_SHOT_TARGET_INVALID");
  }
  return {
    executionMode: mode,
    oneShotTarget: { organizationId, runId },
  };
}

export function readProviderWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ProviderWorkerConfiguration {
  const importMaximumPages = boundedInteger(
    environment.PACKSCOUT_WORKER_IMPORT_MAX_PAGES,
    50_000,
    1,
    100_000,
    "IMPORT_MAX_PAGES_INVALID",
  );
  return Object.freeze({
    actorPseudonymKey: keyFor(
      environment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
      "ACTOR_KEY_INVALID",
    ),
    credentialKey: keyFor(
      environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
      "CREDENTIAL_KEY_INVALID",
    ),
    credentialKeyVersion: boundedInteger(
      environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION,
      1,
      1,
      2_147_483_647,
      "CREDENTIAL_KEY_VERSION_INVALID",
    ),
    databasePoolMaximum: boundedInteger(
      environment.PACKSCOUT_WORKER_DATABASE_POOL_MAX,
      5,
      1,
      50,
      "DATABASE_POOL_MAX_INVALID",
    ),
    databaseUrl: databaseUrlFor(environment.PACKSCOUT_DATABASE_URL),
    environment: environmentFor(environment.NODE_ENV),
    estimatedEvVerifiedUsdStablecoins: verifiedUsdStablecoinsFor(
      environment.PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS,
    ),
    importMaximumPages,
    importMaximumRunDurationMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_IMPORT_MAX_RUN_MS,
      4 * 60 * 60_000,
      120_000,
      24 * 60 * 60_000,
      "IMPORT_MAX_DURATION_INVALID",
    ),
    importMinimumFreeBytes: boundedNonnegativeInteger(
      environment.PACKSCOUT_WORKER_IMPORT_MIN_FREE_BYTES,
      0,
      1024 * 1024 * 1024 * 1024,
      "IMPORT_MIN_FREE_BYTES_INVALID",
    ),
    importPageBudgetPerClaim: boundedInteger(
      environment.PACKSCOUT_WORKER_IMPORT_PAGE_BUDGET,
      importMaximumPages,
      1,
      importMaximumPages,
      "IMPORT_PAGE_BUDGET_INVALID",
    ),
    maximumClaimsPerCycle: boundedInteger(
      environment.PACKSCOUT_WORKER_MAX_CLAIMS_PER_CYCLE,
      25,
      1,
      100,
      "MAXIMUM_CLAIMS_INVALID",
    ),
    pollIntervalMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_POLL_MS,
      1_000,
      100,
      60_000,
      "POLL_INTERVAL_INVALID",
    ),
    retentionBatchSize: boundedInteger(
      environment.PACKSCOUT_WORKER_RETENTION_BATCH_SIZE,
      100,
      1,
      1_000,
      "RETENTION_BATCH_SIZE_INVALID",
    ),
    retentionMaximumBatchesPerCycle: boundedInteger(
      environment.PACKSCOUT_WORKER_RETENTION_MAX_BATCHES_PER_CYCLE,
      5,
      1,
      25,
      "RETENTION_MAX_BATCHES_INVALID",
    ),
    retentionOrganizationDiscoveryLimit: boundedInteger(
      environment.PACKSCOUT_WORKER_RETENTION_ORGANIZATION_DISCOVERY_LIMIT,
      25,
      1,
      100,
      "RETENTION_DISCOVERY_LIMIT_INVALID",
    ),
    ...executionFor(environment),
    workerId: workerIdFor(environment.PACKSCOUT_WORKER_ID, fallbackWorkerId),
  });
}
