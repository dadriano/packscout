import { hostname } from "node:os";
import type { ProviderRuntimeEnvironment } from "@packscout/services";

const organizationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const workerHostPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const workerVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const canonicalBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ProviderWorkerConfigurationErrorCode =
  | "ACTOR_KEY_INVALID"
  | "CREDENTIAL_KEY_INVALID"
  | "CREDENTIAL_KEY_VERSION_INVALID"
  | "DATABASE_POOL_MAX_INVALID"
  | "DATABASE_URL_INVALID"
  | "ESTIMATED_EV_STABLECOINS_INVALID"
  | "HEARTBEAT_INTERVAL_INVALID"
  | "IMPORT_RUN_LEASE_INVALID"
  | "MAXIMUM_CLAIMS_INVALID"
  | "NODE_ENV_INVALID"
  | "POLL_INTERVAL_INVALID"
  | "PUBLIC_ORGANIZATION_ID_INVALID"
  | "PRESENCE_RETENTION_DAYS_INVALID"
  | "PRESENCE_STALE_INVALID"
  | "RETENTION_BATCH_SIZE_INVALID"
  | "RETENTION_DISCOVERY_LIMIT_INVALID"
  | "RETENTION_MAX_BATCHES_INVALID"
  | "RUN_HEARTBEAT_STALE_INVALID"
  | "SCHEDULE_CLAIM_LEASE_INVALID"
  | "WORKER_HOST_INVALID"
  | "WORKER_ID_INVALID"
  | "WORKER_VERSION_INVALID";

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
  readonly heartbeatIntervalMilliseconds: number;
  readonly importRunLeaseMilliseconds: number;
  readonly maximumClaimsPerCycle: number;
  readonly pollIntervalMilliseconds: number;
  readonly publicOrganizationId: string;
  readonly presenceRetentionDays: number;
  readonly presenceStaleAfterMilliseconds: number;
  readonly retentionBatchSize: number;
  readonly retentionMaximumBatchesPerCycle: number;
  readonly retentionOrganizationDiscoveryLimit: number;
  readonly runHeartbeatStaleAfterMilliseconds: number;
  readonly scheduleClaimLeaseMilliseconds: number;
  readonly workerHost: string;
  readonly workerId: string;
  readonly workerVersion: string;
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

function publicOrganizationIdFor(value: string | undefined): string {
  if (!value || !organizationIdPattern.test(value)) {
    throw new ProviderWorkerConfigurationError(
      "PUBLIC_ORGANIZATION_ID_INVALID",
    );
  }
  return value.toLowerCase();
/**
 * Bounded host descriptor for the presence record. An operator-supplied value
 * is validated strictly; the derived hostname is sanitized because it is an
 * environment fact rather than configuration.
 */
function workerHostFor(value: string | undefined): string {
  if (value !== undefined) {
    if (!workerHostPattern.test(value)) {
      throw new ProviderWorkerConfigurationError("WORKER_HOST_INVALID");
    }
    return value;
  }
  const sanitized = hostname()
    .replaceAll(/[^A-Za-z0-9._:-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128);
  return sanitized.length > 0 ? sanitized : "unknown-host";
}

function workerVersionFor(value: string | undefined): string {
  const resolved = value ?? "0.0.0-local";
  if (!workerVersionPattern.test(resolved)) {
    throw new ProviderWorkerConfigurationError("WORKER_VERSION_INVALID");
  }
  return resolved;
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
  const heartbeatIntervalMilliseconds = boundedInteger(
    environment.PACKSCOUT_WORKER_HEARTBEAT_MS,
    15_000,
    1_000,
    300_000,
    "HEARTBEAT_INTERVAL_INVALID",
  );
  const presenceStaleAfterMilliseconds = boundedInteger(
    environment.PACKSCOUT_WORKER_PRESENCE_STALE_MS,
    60_000,
    1_001,
    86_400_000,
    "PRESENCE_STALE_INVALID",
  );
  // Consumers classify an instance as presumed dead from heartbeat age, so the
  // threshold has to leave room for at least one missed beat.
  if (presenceStaleAfterMilliseconds <= heartbeatIntervalMilliseconds) {
    throw new ProviderWorkerConfigurationError("PRESENCE_STALE_INVALID");
  }
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
    heartbeatIntervalMilliseconds,
    importRunLeaseMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_IMPORT_RUN_LEASE_MS,
      120_000,
      30_000,
      900_000,
      "IMPORT_RUN_LEASE_INVALID",
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
    presenceRetentionDays: boundedInteger(
      environment.PACKSCOUT_WORKER_PRESENCE_RETENTION_DAYS,
      14,
      1,
      3_650,
      "PRESENCE_RETENTION_DAYS_INVALID",
    ),
    presenceStaleAfterMilliseconds,
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
    runHeartbeatStaleAfterMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_RUN_HEARTBEAT_STALE_MS,
      300_000,
      1_000,
      86_400_000,
      "RUN_HEARTBEAT_STALE_INVALID",
    ),
    scheduleClaimLeaseMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_SCHEDULE_CLAIM_LEASE_MS,
      30_000,
      1_000,
      300_000,
      "SCHEDULE_CLAIM_LEASE_INVALID",
    ),
    workerHost: workerHostFor(environment.PACKSCOUT_WORKER_HOST),
    workerId: workerIdFor(environment.PACKSCOUT_WORKER_ID, fallbackWorkerId),
    workerVersion: workerVersionFor(environment.PACKSCOUT_WORKER_VERSION),
  });
}
