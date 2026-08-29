import type {
  SourceAdapterRequestTerminalizationInput,
  SourceAdapterRequestTerminalizer,
} from "@packscout/services";

export interface ProviderSourceRequestAuditRecorder {
  record(input: Readonly<{
    runId: string;
    workerId: string;
    workerFence: bigint;
    requestAttemptId: string;
    requestLeaseId: string;
    pageNumber: number;
    outcome: "success" | "failure";
    resultCode: string;
    durationMilliseconds: number;
    responseBytes: number;
  }>): Promise<Readonly<{
    kind: "recorded" | "lease_lost" | "run_not_running";
  }>>;
}

function terminalizationResultCode(
  input: SourceAdapterRequestTerminalizationInput,
): string {
  return input.outcome.ok
    ? "SOURCE_REQUEST_SUCCEEDED"
    : `SOURCE_REQUEST_${input.outcome.failure.code.toUpperCase()}`;
}

/**
 * Adapts the generic source request protocol to one provider-local, fenced
 * audit transaction. A receipt is returned only after durable persistence.
 */
export function createProviderDataforrestRequestTerminalizer(input: Readonly<{
  audit: ProviderSourceRequestAuditRecorder;
  workerId: string;
}>): SourceAdapterRequestTerminalizer {
  return async (attempt) => {
    if (attempt.operationScope.operationKind !== "page_read") {
      throw new Error("Provider source request scope is invalid.");
    }
    const recorded = await input.audit.record({
      runId: attempt.operationScope.importRunId,
      workerId: input.workerId,
      workerFence: BigInt(attempt.operationScope.singletonFencingEpoch),
      requestAttemptId: attempt.requestAttemptId,
      requestLeaseId: attempt.requestLeaseId,
      pageNumber: attempt.operationScope.pageNumber,
      outcome: attempt.outcome.ok ? "success" : "failure",
      resultCode: terminalizationResultCode(attempt),
      durationMilliseconds: attempt.outcome.measurements.durationMilliseconds,
      responseBytes: attempt.outcome.measurements.responseBytes,
    });
    if (recorded.kind !== "recorded") {
      throw new Error("Provider source request authority was lost.");
    }
    return Object.freeze({
      requestAttemptId: attempt.requestAttemptId,
      requestLeaseId: attempt.requestLeaseId,
      operationScope: attempt.operationScope,
    });
  };
}
