import path from "node:path";
import { providerSourceLaunchBounds } from "@packscout/contracts";

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export type ProviderSourceSupervisorEnvironment =
  | "local"
  | "production"
  | "test";

export type ProviderSourceSupervisorConfigurationErrorCode =
  | "ACTOR_KEY_INVALID"
  | "DATABASE_URL_INVALID"
  | "NODE_ENV_INVALID"
  | "SOURCE_CONNECTION_KEY_INVALID"
  | "SOURCE_CONNECTION_KEY_VERSION_INVALID"
  | "SOURCE_DISK_RESERVE_GIB_INVALID"
  | "SOURCE_DATABASE_VOLUME_PATH_INVALID"
  | "SOURCE_EXECUTION_SLOTS_INVALID"
  | "WORKER_ID_INVALID";

export class ProviderSourceSupervisorConfigurationError extends Error {
  constructor(readonly code: ProviderSourceSupervisorConfigurationErrorCode) {
    super("Provider source supervisor configuration is invalid.");
    this.name = "ProviderSourceSupervisorConfigurationError";
  }
}

/** Settings the supervisor shares with the combined provider worker. */
export interface ProviderSourceSupervisorSharedConfiguration {
  readonly actorPseudonymKey: Uint8Array;
  readonly databaseUrl: string;
  readonly environment: ProviderSourceSupervisorEnvironment;
  readonly workerId: string;
}

export interface ProviderSourceSupervisorConfiguration
  extends ProviderSourceSupervisorSharedConfiguration {
  readonly sourceConnectionConfigurationKey: Uint8Array;
  readonly sourceConnectionConfigurationKeyVersion: number;
  readonly sourceDatabaseVolumePath: string;
  readonly sourceDiskReserveBytes?: number;
  readonly executionSlots?: number;
}

const BYTES_PER_GIBIBYTE = 1_073_741_824;

function sourceDiskReserveBytesFor(
  value: string | undefined,
  environment: ProviderSourceSupervisorEnvironment,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    environment !== "local" ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_DISK_RESERVE_GIB_INVALID",
    );
  }
  const gibibytes = Number(value);
  const bytes = gibibytes * BYTES_PER_GIBIBYTE;
  if (!Number.isSafeInteger(bytes)) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_DISK_RESERVE_GIB_INVALID",
    );
  }
  return bytes;
}

function sourceExecutionSlotsFor(
  value: string | undefined,
  environment: ProviderSourceSupervisorEnvironment,
): number {
  if (value === undefined || value === "") {
    return providerSourceLaunchBounds.genericExecutionSlots;
  }
  if (
    environment !== "local" ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_EXECUTION_SLOTS_INVALID",
    );
  }
  const executionSlots = Number(value);
  if (
    !Number.isSafeInteger(executionSlots) ||
    executionSlots > providerSourceLaunchBounds.genericExecutionSlots
  ) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_EXECUTION_SLOTS_INVALID",
    );
  }
  return executionSlots;
}

function databaseVolumePathFor(value: string | undefined): string {
  if (
    !value || value !== value.trim() || value.length > 4_096 ||
    !path.isAbsolute(value)
  ) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_DATABASE_VOLUME_PATH_INVALID",
    );
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_DATABASE_VOLUME_PATH_INVALID",
    );
  }
  return resolved;
}

function environmentFor(
  value: string | undefined,
): ProviderSourceSupervisorEnvironment {
  if (value === undefined || value === "development" || value === "local") {
    return "local";
  }
  if (value === "production" || value === "test") return value;
  throw new ProviderSourceSupervisorConfigurationError("NODE_ENV_INVALID");
}

function databaseUrlFor(value: string | undefined): string {
  if (!value || value.length > 2_048 || /[\r\n]/u.test(value)) {
    throw new ProviderSourceSupervisorConfigurationError(
      "DATABASE_URL_INVALID",
    );
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
      || parsed.hostname.length === 0
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new ProviderSourceSupervisorConfigurationError(
      "DATABASE_URL_INVALID",
    );
  }
  return value;
}

function canonicalKeyFor(
  value: string | undefined,
  code: "ACTOR_KEY_INVALID" | "SOURCE_CONNECTION_KEY_INVALID",
): Uint8Array {
  const normalized = value?.trim();
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    throw new ProviderSourceSupervisorConfigurationError(
      code,
    );
  }
  const decoded = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/u, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/u, "");
  if (decoded.byteLength !== 32 || canonicalDecoded !== canonicalInput) {
    throw new ProviderSourceSupervisorConfigurationError(
      code,
    );
  }
  return new Uint8Array(decoded);
}

function sourceConnectionKeyVersionFor(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_CONNECTION_KEY_VERSION_INVALID",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new ProviderSourceSupervisorConfigurationError(
      "SOURCE_CONNECTION_KEY_VERSION_INVALID",
    );
  }
  return parsed;
}

function workerIdFor(value: string | undefined, fallback: string): string {
  const resolved = value ?? fallback;
  if (!workerIdPattern.test(resolved)) {
    throw new ProviderSourceSupervisorConfigurationError("WORKER_ID_INVALID");
  }
  return resolved;
}

const supervisorOnlyVariables = [
  "PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64",
  "PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION",
  "PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH",
  "PACKSCOUT_SOURCE_DISK_RESERVE_GIB",
  "PACKSCOUT_SOURCE_EXECUTION_SLOTS",
] as const;

/**
 * True when any supervisor-only setting is present. The combined worker uses
 * this to tell a deliberately absent supervisor lane (none set) apart from a
 * partial misconfiguration (some set), which must still fail startup.
 */
export function hasProviderSourceSupervisorSettings(
  environment: NodeJS.ProcessEnv,
): boolean {
  return supervisorOnlyVariables.some(
    (name) => (environment[name] ?? "").trim().length > 0,
  );
}

/** Reads the settings shared with the combined provider worker. */
export function readProviderSourceSupervisorSharedConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ProviderSourceSupervisorSharedConfiguration {
  return Object.freeze({
    actorPseudonymKey: canonicalKeyFor(
      environment.PACKSCOUT_PROVIDER_ACTOR_KEY_BASE64,
      "ACTOR_KEY_INVALID",
    ),
    databaseUrl: databaseUrlFor(environment.PACKSCOUT_DATABASE_URL),
    environment: environmentFor(environment.NODE_ENV),
    workerId: workerIdFor(environment.PACKSCOUT_WORKER_ID, fallbackWorkerId),
  });
}

/** Reads exactly the settings owned by the source-supervisor process. */
export function readProviderSourceSupervisorConfiguration(
  environment: NodeJS.ProcessEnv,
  fallbackWorkerId: string,
): ProviderSourceSupervisorConfiguration {
  const shared = readProviderSourceSupervisorSharedConfiguration(
    environment,
    fallbackWorkerId,
  );
  const sourceDiskReserveBytes = sourceDiskReserveBytesFor(
    environment.PACKSCOUT_SOURCE_DISK_RESERVE_GIB,
    shared.environment,
  );
  const executionSlots = sourceExecutionSlotsFor(
    environment.PACKSCOUT_SOURCE_EXECUTION_SLOTS,
    shared.environment,
  );
  return Object.freeze({
    ...shared,
    executionSlots,
    sourceConnectionConfigurationKey: canonicalKeyFor(
      environment.PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64,
      "SOURCE_CONNECTION_KEY_INVALID",
    ),
    sourceConnectionConfigurationKeyVersion: sourceConnectionKeyVersionFor(
      environment.PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION,
    ),
    sourceDatabaseVolumePath: databaseVolumePathFor(
      environment.PACKSCOUT_SOURCE_DATABASE_VOLUME_PATH,
    ),
    ...(sourceDiskReserveBytes === undefined
      ? {}
      : { sourceDiskReserveBytes }),
  });
}
