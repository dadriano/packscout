import { ProviderSourceSupervisorConfigurationError } from
  "./source-supervisor-runtime-config.ts";

/**
 * Produces the complete fatal startup event without copying arbitrary error
 * fields into logs. Only configuration codes owned by this process are safe
 * to expose; every other failure is represented by one stable code.
 */
export function sourceSupervisorFatalEvent(
  error: unknown,
): Readonly<{
  level: "error";
  event: "provider_source_supervisor_fatal";
  failureCode: string;
}> {
  return Object.freeze({
    level: "error",
    event: "provider_source_supervisor_fatal",
    failureCode: error instanceof ProviderSourceSupervisorConfigurationError
      ? error.code
      : "PROVIDER_SOURCE_SUPERVISOR_FATAL",
  });
}
