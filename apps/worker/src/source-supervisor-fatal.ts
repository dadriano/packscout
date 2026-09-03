import {
  ProviderSourceSupervisorConfigurationError,
  type ProviderSourceSupervisorConfigurationErrorCode,
} from "./source-supervisor-runtime-config.ts";

const configurationFailureCodes = new Set<
  ProviderSourceSupervisorConfigurationErrorCode
>([
  "ACTOR_KEY_INVALID",
  "DATABASE_URL_INVALID",
  "NODE_ENV_INVALID",
  "SOURCE_CONNECTION_KEY_INVALID",
  "SOURCE_CONNECTION_KEY_VERSION_INVALID",
  "SOURCE_DISK_RESERVE_GIB_INVALID",
  "SOURCE_DATABASE_VOLUME_PATH_INVALID",
  "SOURCE_EXECUTION_SLOTS_INVALID",
  "WORKER_ID_INVALID",
]);

export type ProviderSourceSupervisorLifecycleFailureCode =
  | "SUPERVISOR_DATABASE_CLOSE_FAILED"
  | "SUPERVISOR_DATABASE_CREATE_FAILED"
  | "SUPERVISOR_DATABASE_START_FAILED"
  | "SUPERVISOR_RUNTIME_CREATE_FAILED"
  | "SUPERVISOR_RUNTIME_START_FAILED"
  | "SUPERVISOR_RUNTIME_STOP_FAILED";

const lifecycleFailureCodes = new Set<
  ProviderSourceSupervisorLifecycleFailureCode
>([
  "SUPERVISOR_DATABASE_CLOSE_FAILED",
  "SUPERVISOR_DATABASE_CREATE_FAILED",
  "SUPERVISOR_DATABASE_START_FAILED",
  "SUPERVISOR_RUNTIME_CREATE_FAILED",
  "SUPERVISOR_RUNTIME_START_FAILED",
  "SUPERVISOR_RUNTIME_STOP_FAILED",
]);

/**
 * Carries only an allowlisted lifecycle stage across the process boundary.
 * The dependency error remains available as `cause` for in-process tests but
 * is never copied into the structured fatal record.
 */
export class ProviderSourceSupervisorLifecycleError extends Error {
  readonly code: ProviderSourceSupervisorLifecycleFailureCode;

  constructor(
    code: ProviderSourceSupervisorLifecycleFailureCode,
    cause: unknown,
  ) {
    super("Provider source supervisor lifecycle failed.", { cause });
    this.name = "ProviderSourceSupervisorLifecycleError";
    this.code = code;
  }
}

export function providerSourceSupervisorFatalRecord(error: unknown) {
  const configurationFailureCode =
    error instanceof ProviderSourceSupervisorConfigurationError &&
      configurationFailureCodes.has(error.code)
      ? error.code
      : null;
  const lifecycleFailureCode =
    error instanceof ProviderSourceSupervisorLifecycleError &&
      lifecycleFailureCodes.has(error.code)
      ? error.code
      : null;
  return Object.freeze({
    level: "error" as const,
    event: "provider_source_supervisor_fatal" as const,
    failureCode:
      configurationFailureCode ?? lifecycleFailureCode ??
        "PROVIDER_SOURCE_SUPERVISOR_FATAL",
  });
}
