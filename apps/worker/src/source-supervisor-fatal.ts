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

export function providerSourceSupervisorFatalRecord(error: unknown) {
  const configurationFailureCode =
    error instanceof ProviderSourceSupervisorConfigurationError &&
      configurationFailureCodes.has(error.code)
      ? error.code
      : null;
  return Object.freeze({
    level: "error" as const,
    event: "provider_source_supervisor_fatal" as const,
    failureCode:
      configurationFailureCode ?? "PROVIDER_SOURCE_SUPERVISOR_FATAL",
  });
}
