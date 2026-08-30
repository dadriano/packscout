import { sourceAdapterFailureCodes } from "@packscout/contracts";
import { ProviderCaptureSourceError } from "./provider-capture-source-contract.ts";
import { ProviderDataforrestSourceError } from "./provider-dataforrest-mixed-page-source.ts";

export type ProviderManualImportStage =
  | "run_preparation"
  | "lease_renewal"
  | "source_read"
  | "page_validation"
  | "page_commit"
  | "fact_reference_reconciliation"
  | "quarantine_reconciliation"
  | "run_finish"
  | "execution";

export interface ProviderManualImportFailureDiagnostic {
  readonly failureCode: string;
  readonly failureClass: "source" | "database" | "configuration" | "worker";
  readonly failureSummary: string;
}

const sourceCodes = new Set([
  ...sourceAdapterFailureCodes.map((code) => `PROVIDER_DATAFORREST_${code.toUpperCase()}`),
  ...[
    "ABORTED", "AUTHORITY_INVALID", "AUTHORITY_UNAVAILABLE", "CURSOR_INVALID",
    "PAGE_INVALID", "RESPONSE_INVALID", "TERMINALIZATION_FAILED", "TRANSLATION_INVALID",
  ].map((code) => `PROVIDER_DATAFORREST_${code}`),
  ...[
    "ABORTED", "CONFIGURATION_INVALID", "FILE_INVALID", "FILE_UNAVAILABLE",
    "HASH_MISMATCH", "RECORD_INVALID", "ROOT_INVALID", "SOURCE_CHECKPOINT_INVALID",
  ].map((code) => `PROVIDER_CAPTURE_${code}`),
  "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
]);
const stages = new Set<ProviderManualImportStage>([
  "run_preparation", "lease_renewal", "source_read", "page_validation", "page_commit",
  "fact_reference_reconciliation", "quarantine_reconciliation", "run_finish", "execution",
]);

// Read only own data properties. Do not serialize errors or inspect messages,
// SQL text, connection metadata, causes, or provider payloads; even a getter
// must not become a new failure or a disclosure path while diagnosing one.
function ownDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property !== undefined && "value" in property ? property.value : undefined;
  } catch {
    return undefined;
  }
}

function isTypedSourceFailure(error: unknown): boolean {
  try {
    return error instanceof ProviderCaptureSourceError
      || error instanceof ProviderDataforrestSourceError;
  } catch {
    return false;
  }
}

function databaseCategory(error: unknown): string | null {
  const code = ownDataProperty(error, "code");
  const sqlState = code === "P2010"
    ? ownDataProperty(ownDataProperty(error, "meta"), "code")
    : code;
  switch (sqlState) {
    case "40001": return "SERIALIZATION_CONFLICT";
    case "40P01": return "DEADLOCK";
    case "57014": return "QUERY_CANCELLED";
    case "55P03": return "LOCK_UNAVAILABLE";
    case "23502":
    case "23503":
    case "23505":
    case "23514": return "CONSTRAINT_VIOLATION";
  }
  switch (code) {
    case "P1001":
    case "P1002":
    case "P1017": return "CONNECTION_UNAVAILABLE";
    case "P2002":
    case "P2003":
    case "P2011":
    case "P2014": return "CONSTRAINT_VIOLATION";
    case "P2024": return "POOL_TIMEOUT";
    // P2028 covers multiple invalid/closed-transaction conditions, not just
    // timeouts. P2034 does not distinguish serialization from deadlock.
    case "P2028": return "TRANSACTION_INVALID";
    case "P2034": return "TRANSACTION_CONFLICT";
    case "P2010": return "QUERY_FAILED";
    default: return null;
  }
}

function summary(stage: ProviderManualImportStage, category: string): string {
  const safeStage = stages.has(stage) ? stage : "execution";
  return `Provider import stopped; stage=${safeStage}; category=${category}.`;
}

/** Stable diagnostics only; classification never grants automatic retry. */
export function classifyProviderManualImportFailure(
  error: unknown,
  stage: ProviderManualImportStage,
): ProviderManualImportFailureDiagnostic {
  const code = ownDataProperty(error, "code");
  if (isTypedSourceFailure(error)
    && typeof code === "string" && sourceCodes.has(code)) {
    return { failureCode: code, failureClass: "source", failureSummary: summary(stage, "source") };
  }
  const database = databaseCategory(error);
  if (database !== null) {
    return {
      failureCode: `PROVIDER_IMPORT_DATABASE_${database}`,
      failureClass: "database",
      failureSummary: summary(stage, database.toLowerCase()),
    };
  }
  return {
    failureCode: "PROVIDER_IMPORT_EXECUTION_FAILED",
    failureClass: "worker",
    failureSummary: summary(stage, "unclassified_execution_failure"),
  };
}

/** Internal terminal decisions are worker/configuration failures, not source errors. */
export function providerManualImportTerminalDiagnostic(
  failureCode: string,
  stage: ProviderManualImportStage = "execution",
): ProviderManualImportFailureDiagnostic {
  const configuration = failureCode === "PROVIDER_CONFIGURATION_UNAVAILABLE"
    || failureCode === "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE";
  return {
    failureCode,
    failureClass: configuration ? "configuration" : "worker",
    failureSummary: summary(stage, configuration ? "configuration" : "terminal_decision"),
  };
}
