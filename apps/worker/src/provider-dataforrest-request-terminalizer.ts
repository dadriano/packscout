import type {
  SourceAdapterRequestTerminalizationInput,
  SourceAdapterRequestTerminalizer,
} from "@packscout/services";
import {
  providerSourceResponseLimitDiagnosticSchema,
  type ProviderSourceResponseLimitDiagnostic,
} from "@packscout/contracts";

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
    responseLimitDiagnostic?: ProviderSourceResponseLimitDiagnostic;
  }>): Promise<Readonly<{
    kind: "recorded" | "lease_lost" | "run_not_running" | "request_settings_mismatch" | "request_limit_exceeded";
  }>>;
}

function responseLimitDiagnostic(attempt: SourceAdapterRequestTerminalizationInput):
ProviderSourceResponseLimitDiagnostic | undefined {
  const diagnostics = attempt.outcome.diagnostics.filter(({ code }) =>
    code === "response_too_large_declared_content_length" || code === "response_too_large_streamed_body");
  if (diagnostics.length === 0) return undefined;
  const diagnostic = diagnostics[0]!;
  if (diagnostics.length !== 1 || attempt.outcome.ok || attempt.outcome.failure.code !== "response_too_large" ||
    diagnostic.phase !== "request_capture" || !diagnostic.counters ||
    Object.keys(diagnostic.counters).some((key) => !["maximum_response_bytes", "reported_response_bytes"].includes(key))) {
    throw new TypeError("Source response limit diagnostic is invalid.");
  }
  const parsed = providerSourceResponseLimitDiagnosticSchema.safeParse({
    trigger: diagnostic.code === "response_too_large_declared_content_length" ? "declared_content_length" : "streamed_body",
    maximumResponseBytes: diagnostic.counters.maximum_response_bytes,
    ...(diagnostic.counters.reported_response_bytes === undefined ? {} : {
      reportedResponseBytes: diagnostic.counters.reported_response_bytes,
    }),
  });
  if (!parsed.success) throw new TypeError("Source response limit diagnostic is invalid.");
  return parsed.data;
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
    const limitDiagnostic = responseLimitDiagnostic(attempt);
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
      ...(limitDiagnostic === undefined ? {} : { responseLimitDiagnostic: limitDiagnostic }),
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
