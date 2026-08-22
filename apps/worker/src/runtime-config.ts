import {
  ProviderSourceSupervisorConfigurationError,
  readProviderSourceSupervisorConfiguration,
  type ProviderSourceSupervisorConfiguration,
} from "./source-supervisor-runtime-config.ts";

export {
  ProviderSourceSupervisorConfigurationError,
  readProviderSourceSupervisorConfiguration,
  type ProviderSourceSupervisorConfiguration,
} from "./source-supervisor-runtime-config.ts";

const organizationIdPattern =
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
  | "MAXIMUM_CLAIMS_INVALID"
  | "NODE_ENV_INVALID"
  | "POLL_INTERVAL_INVALID"
  | "PUBLIC_ORGANIZATION_ID_INVALID"
  | "RETENTION_BATCH_SIZE_INVALID"
  | "RETENTION_DISCOVERY_LIMIT_INVALID"
  | "RETENTION_MAX_BATCHES_INVALID"
  | "SOURCE_CONNECTION_KEY_INVALID"
  | "SOURCE_CONNECTION_KEY_VERSION_INVALID"
  | "SOURCE_DATABASE_VOLUME_PATH_INVALID"
  | "WORKER_ID_INVALID";

export class ProviderWorkerConfigurationError extends Error {
  constructor(readonly code: ProviderWorkerConfigurationErrorCode) {
    super("Provider worker configuration is invalid.");
    this.name = "ProviderWorkerConfigurationError";
  }
}

export interface ProviderWorkerConfiguration
  extends ProviderSourceSupervisorConfiguration {
  readonly credentialKey: Uint8Array;
  readonly credentialKeyVersion: number;
  readonly databasePoolMaximum: number;
  readonly estimatedEvVerifiedUsdStablecoins: readonly string[];
  readonly maximumClaimsPerCycle: number;
  readonly pollIntervalMilliseconds: number;
  readonly publicOrganizationId: string;
  readonly retentionBatchSize: number;
  readonly retentionMaximumBatchesPerCycle: number;
  readonly retentionOrganizationDiscoveryLimit: number;
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

function publicOrganizationIdFor(value: string | undefined): string {
  if (!value || !organizationIdPattern.test(value)) {
    throw new ProviderWorkerConfigurationError(
      "PUBLIC_ORGANIZATION_ID_INVALID",
    );
  }
  return value.toLowerCase();
}

function verifiedUsdStablecoinsFor(
  value: string | undefined,
): readonly string[] {
  if (value === undefined || value === "") return Object.freeze([]);
  if (
    value.length > 512 ||
    !/^[A-Z0-9]{2,12}(,[A-Z0-9]{2,12})*$/.test(value)
  ) {
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

export function readProviderWorkerConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ProviderWorkerConfiguration {
  let sourceSupervisor: ProviderSourceSupervisorConfiguration;
  try {
    sourceSupervisor = readProviderSourceSupervisorConfiguration(
      environment,
      fallbackWorkerId,
    );
  } catch (error) {
    if (error instanceof ProviderSourceSupervisorConfigurationError) {
      throw new ProviderWorkerConfigurationError(error.code);
    }
    throw error;
  }
  return Object.freeze({
    ...sourceSupervisor,
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
    estimatedEvVerifiedUsdStablecoins: verifiedUsdStablecoinsFor(
      environment.PACKSCOUT_ESTIMATED_EV_VERIFIED_USD_STABLECOINS,
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
    publicOrganizationId: publicOrganizationIdFor(
      environment.PACKSCOUT_PUBLIC_ORGANIZATION_ID,
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
  });
}
