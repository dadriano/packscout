import type { ProviderManualImportExecutionResult } from
  "./provider-manual-import-executor.ts";
import type { ProviderManualImportLaneOutcome } from
  "./provider-manual-import-lane-supervisor.ts";

export type ProviderManualImportProcessResult =
  | ProviderManualImportExecutionResult
  | readonly ProviderManualImportLaneOutcome[];

function exhaustiveResult(result: never): never {
  throw new TypeError(`Unhandled provider import result: ${String(result)}`);
}

function executionRequiresFailureExit(
  result: ProviderManualImportExecutionResult,
): boolean {
  switch (result.kind) {
    case "idle":
    case "completed":
      return false;
    case "contended":
    case "progress":
    case "blocked":
    case "failed":
      return true;
    default:
      return exhaustiveResult(result);
  }
}

/** Pure process-status projection; it never rewrites provider lane outcomes. */
export function providerManualImportProcessExitCode(
  result: ProviderManualImportProcessResult,
): 0 | 1 {
  if (Array.isArray(result)) {
    const outcomes = result as readonly ProviderManualImportLaneOutcome[];
    return outcomes.some((outcome) =>
      outcome.status === "rejected"
      || executionRequiresFailureExit(outcome.result)
    )
      ? 1
      : 0;
  }
  return executionRequiresFailureExit(
    result as ProviderManualImportExecutionResult,
  )
    ? 1
    : 0;
}
