import { hostname } from "node:os";
import {
  hasProviderSourceSupervisorSettings,
  ProviderSourceSupervisorConfigurationError,
  readProviderSourceSupervisorConfiguration,
  readProviderSourceSupervisorSharedConfiguration,
  type ProviderSourceSupervisorConfiguration,
  type ProviderSourceSupervisorSharedConfiguration,
} from "./source-supervisor-runtime-config.ts";

export {
  ProviderSourceSupervisorConfigurationError,
  readProviderSourceSupervisorConfiguration,
  type ProviderSourceSupervisorConfiguration,
} from "./source-supervisor-runtime-config.ts";

const organizationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  | "MESSAGE_OUTBOX_ATTEMPTS_INVALID"
  | "MESSAGE_OUTBOX_BACKOFF_BASE_INVALID"
  | "MESSAGE_OUTBOX_BACKOFF_CAP_INVALID"
  | "MESSAGE_OUTBOX_BATCH_SIZE_INVALID"
  | "MESSAGE_OUTBOX_LEASE_INVALID"
  | "MESSAGE_OUTBOX_PER_RECIPIENT_INVALID"
  | "MESSAGE_OUTBOX_POLL_INVALID"
  | "MESSAGE_OUTBOX_RETENTION_DAYS_INVALID"
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
  | "SOURCE_CONNECTION_KEY_INVALID"
  | "SOURCE_CONNECTION_KEY_VERSION_INVALID"
  | "SOURCE_DISK_RESERVE_GIB_INVALID"
  | "SOURCE_DATABASE_VOLUME_PATH_INVALID"
  | "WELCOME_DISPATCH_BATCH_SIZE_INVALID"
  | "WELCOME_DISPATCH_LEASE_INVALID"
  | "WELCOME_DISPATCH_POLL_INVALID"
  | "WORKER_HOST_INVALID"
  | "WORKER_ID_INVALID"
  | "WORKER_VERSION_INVALID";

export class ProviderWorkerConfigurationError extends Error {
  constructor(readonly code: ProviderWorkerConfigurationErrorCode) {
    super("Provider worker configuration is invalid.");
    this.name = "ProviderWorkerConfigurationError";
  }
}

export interface ProviderWorkerConfiguration
  extends ProviderSourceSupervisorSharedConfiguration {
  readonly credentialKey: Uint8Array;
  readonly credentialKeyVersion: number;
  readonly databasePoolMaximum: number;
  readonly estimatedEvVerifiedUsdStablecoins: readonly string[];
  readonly heartbeatIntervalMilliseconds: number;
  readonly importRunLeaseMilliseconds: number;
  readonly maximumClaimsPerCycle: number;
  readonly messageOutboxBackoffBaseMilliseconds: number;
  readonly messageOutboxBackoffCapMilliseconds: number;
  readonly messageOutboxBatchSize: number;
  readonly messageOutboxLeaseMilliseconds: number;
  readonly messageOutboxMaximumAttempts: number;
  readonly messageOutboxPerRecipientLimit: number;
  readonly messageOutboxPollMilliseconds: number;
  readonly messageOutboxRetentionDays: number;
  readonly pollIntervalMilliseconds: number;
  readonly publicOrganizationId: string;
  readonly presenceRetentionDays: number;
  readonly presenceStaleAfterMilliseconds: number;
  readonly retentionBatchSize: number;
  readonly retentionMaximumBatchesPerCycle: number;
  readonly retentionOrganizationDiscoveryLimit: number;
  readonly runHeartbeatStaleAfterMilliseconds: number;
  readonly scheduleClaimLeaseMilliseconds: number;
  /**
   * Undefined when none of the supervisor-only settings are set, which is the
   * supported way to run the combined worker without the source-supervisor
   * lane. A partially set group still fails configuration.
   */
  readonly sourceSupervisor?: ProviderSourceSupervisorConfiguration;
  readonly welcomeDispatchBatchSize: number;
  readonly welcomeDispatchLeaseMilliseconds: number;
  readonly welcomeDispatchPollMilliseconds: number;
  readonly workerHost: string;
  readonly workerVersion: string;
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
  let shared: ProviderSourceSupervisorSharedConfiguration;
  let sourceSupervisor: ProviderSourceSupervisorConfiguration | undefined;
  try {
    shared = readProviderSourceSupervisorSharedConfiguration(
      environment,
      fallbackWorkerId,
    );
    sourceSupervisor = hasProviderSourceSupervisorSettings(environment)
      ? readProviderSourceSupervisorConfiguration(environment, fallbackWorkerId)
      : undefined;
  } catch (error) {
    if (error instanceof ProviderSourceSupervisorConfigurationError) {
      throw new ProviderWorkerConfigurationError(error.code);
    }
    throw error;
  }
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
  const messageOutboxBackoffBaseMilliseconds = boundedInteger(
    environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_BASE_MS,
    30_000,
    100,
    3_600_000,
    "MESSAGE_OUTBOX_BACKOFF_BASE_INVALID",
  );
  const messageOutboxBackoffCapMilliseconds = boundedInteger(
    environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_BACKOFF_CAP_MS,
    3_600_000,
    100,
    86_400_000,
    "MESSAGE_OUTBOX_BACKOFF_CAP_INVALID",
  );
  // A cap below the base would make the "exponential" schedule shrink.
  if (messageOutboxBackoffCapMilliseconds < messageOutboxBackoffBaseMilliseconds) {
    throw new ProviderWorkerConfigurationError(
      "MESSAGE_OUTBOX_BACKOFF_CAP_INVALID",
    );
  }
  return Object.freeze({
    ...shared,
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
    messageOutboxBackoffBaseMilliseconds,
    messageOutboxBackoffCapMilliseconds,
    messageOutboxBatchSize: boundedInteger(
      environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_BATCH_SIZE,
      25,
      1,
      100,
      "MESSAGE_OUTBOX_BATCH_SIZE_INVALID",
    ),
    messageOutboxLeaseMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_LEASE_MS,
      60_000,
      1_000,
      900_000,
      "MESSAGE_OUTBOX_LEASE_INVALID",
    ),
    messageOutboxMaximumAttempts: boundedInteger(
      environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_MAX_ATTEMPTS,
      6,
      1,
      20,
      "MESSAGE_OUTBOX_ATTEMPTS_INVALID",
    ),
    messageOutboxPerRecipientLimit: boundedInteger(
      environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_PER_RECIPIENT_LIMIT,
      5,
      1,
      100,
      "MESSAGE_OUTBOX_PER_RECIPIENT_INVALID",
    ),
    messageOutboxPollMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_POLL_MS,
      5_000,
      100,
      300_000,
      "MESSAGE_OUTBOX_POLL_INVALID",
    ),
    messageOutboxRetentionDays: boundedInteger(
      environment.PACKSCOUT_WORKER_MESSAGE_OUTBOX_RETENTION_DAYS,
      90,
      1,
      3_650,
      "MESSAGE_OUTBOX_RETENTION_DAYS_INVALID",
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
    sourceSupervisor,
    // Welcome dispatch (messaging/007): batch bound mirrors the directory's
    // claim bound, and the lease its claim-expiry bounds, so a configured
    // value the worker accepts is never refused upstream.
    welcomeDispatchBatchSize: boundedInteger(
      environment.PACKSCOUT_WORKER_WELCOME_DISPATCH_BATCH_SIZE,
      10,
      1,
      20,
      "WELCOME_DISPATCH_BATCH_SIZE_INVALID",
    ),
    welcomeDispatchLeaseMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_WELCOME_DISPATCH_LEASE_MS,
      300_000,
      1_000,
      900_000,
      "WELCOME_DISPATCH_LEASE_INVALID",
    ),
    welcomeDispatchPollMilliseconds: boundedInteger(
      environment.PACKSCOUT_WORKER_WELCOME_DISPATCH_POLL_MS,
      60_000,
      100,
      300_000,
      "WELCOME_DISPATCH_POLL_INVALID",
    ),
    workerHost: workerHostFor(environment.PACKSCOUT_WORKER_HOST),
    workerVersion: workerVersionFor(environment.PACKSCOUT_WORKER_VERSION),
  });
}
