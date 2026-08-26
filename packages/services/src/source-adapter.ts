import { createHash } from "node:crypto";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  providerSourceRequestBoundsSchema,
  sourceAdapterFailureSchema,
  sourceAdapterMeasurementsSchema,
  sourceAdapterSafeDiagnosticSchema,
  type ProviderSourceRequestBounds,
  type LaunchProviderKey,
  type OpaqueCursorEnvelope,
  type RecordIdScopeDeclaration,
  type SourceAdapterFailure,
  type SourceAdapterManifestV1,
  type SourceAdapterMeasurements,
  type SourceAdapterSafeDiagnostic,
} from "@packscout/contracts";
import {
  SourceAdapterContractError,
  canonicalizeBounds,
  canonicalizeCursor,
  canonicalizeConfiguration,
  canonicalizeJsonValue,
  canonicalizeRecordIdScopes,
  createSourceAdapterCaptureInvocationCapability,
  hasExactKeys,
  isDeepFrozenJsonValue,
  isRecord,
  type SourceAdapterContractErrorCode,
} from "./source-adapter-contract-primitives.ts";
import { completeNormalizedProviderObservationPage } from
  "./source-adapter-completed-page-capability.ts";
import { takeProtectedRawResponse } from
  "./source-adapter-request-buffer.ts";
import { canonicalizeProtectedNativeEvidence } from
  "./trusted-protected-native-evidence.ts";
import {
  SourceRequestLease,
  SourceRequestLeaseAuthority,
  sourceRequestOperationPinsEqual,
  type SourceRequestInvocation,
  type SourceRequestOperationPins,
} from "./source-request-lease.ts";
import {
  canonicalizeSourceAdapterResultValue,
  createSourceAdapterOperationResultCapability,
} from "./source-adapter-operation-result-capability.ts";
import {
  CAPTURED_SOURCE_PAGE_VERSION,
  type CapturedSourcePageV1,
  type SourceAdapterPageInterpretationResult,
} from "./source-adapter-page-contract.ts";

export {
  CAPTURED_SOURCE_PAGE_VERSION,
  type CapturedSourcePageV1,
  type InterpretedNormalizedProviderObservationPage,
  type InterpretedSourcePageV1,
  type SourceAdapterPageInterpretationResult,
} from "./source-adapter-page-contract.ts";

export { providerSourceSuccessfulCaptureOutcomeHash } from
  "./provider-source-successful-capture-outcome.ts";

export { SourceAdapterContractError };
export type { SourceAdapterContractErrorCode };

const connectionOperationKeys = [
  "abortSignal",
  "adapterVersion",
  "bounds",
  "connectionConfiguration",
  "connectionProfileId",
  "connectionProfileRevisionId",
  "correlation",
  "operationKind",
  "organizationId",
  "requestLease",
  "sourceTypeKey",
] as const;

const sourceOperationKeys = [
  ...connectionOperationKeys,
  "identityNamespaceKey",
  "normalizedContractVersion",
  "provider",
  "recordIdScopes",
  "sourceConfiguration",
  "sourceInstanceId",
  "sourceRevisionId",
] as const;

const correlationKeysByOperation = Object.freeze({
  connection_test: [
    "connectionHealthGeneration",
    "connectionTestJobId",
    "jobClaimLeaseId",
    "recoveryEpisodeId",
    "singletonFencingEpoch",
  ],
  source_test: [
    "connectionHealthGeneration",
    "jobClaimLeaseId",
    "singletonFencingEpoch",
    "sourceTestJobId",
  ],
  page_read: [
    "cursorGeneration",
    "connectionHealthGeneration",
    "importRunId",
    "pageAttemptId",
    "pageNumber",
    "pageLimit",
    "requestedCursor",
    "requestedCursorFingerprint",
    "runClaimLeaseId",
    "singletonFencingEpoch",
  ],
} as const);

export function assertSourceAdapterOperation(
  operation: SourceAdapterOperation,
): void {
  if (!isRecord(operation)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const operationKind = operation.operationKind;
  if (
    operationKind !== "connection_test" &&
    operationKind !== "source_test" &&
    operationKind !== "page_read"
  ) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const expectedOperationKeys = operationKind === "connection_test"
    ? connectionOperationKeys
    : sourceOperationKeys;
  if (
    !hasExactKeys(operation, expectedOperationKeys) ||
    !hasExactKeys(
      operation.correlation,
      correlationKeysByOperation[operationKind],
    ) ||
    !hasExactKeys(operation.bounds, [
      "maximumResponseBytes",
      "pageLimit",
      "timeoutMilliseconds",
    ]) ||
    !providerSourceRequestBoundsSchema.safeParse(operation.bounds).success ||
    !isRecord(operation.connectionConfiguration) ||
    !(operation.requestLease instanceof SourceRequestLease)
  ) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  if (operationKind !== "connection_test") {
    if (
      !isRecord(operation.sourceConfiguration) ||
      !Array.isArray(operation.recordIdScopes)
    ) {
      throw new SourceAdapterContractError("invalid_operation_shape");
    }
  }
  if (operation.abortSignal !== operation.requestLease.signal) {
    throw new SourceAdapterContractError("abort_signal_mismatch");
  }
  if (
    !Object.isFrozen(operation) ||
    !isDeepFrozenJsonValue(operation.bounds) ||
    !isDeepFrozenJsonValue(operation.correlation) ||
    !isDeepFrozenJsonValue(operation.connectionConfiguration)
  ) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  if (
    operationKind !== "connection_test" &&
    (!isDeepFrozenJsonValue(operation.sourceConfiguration) ||
      !isDeepFrozenJsonValue(operation.recordIdScopes) ||
      (operationKind === "page_read" &&
        !isDeepFrozenJsonValue(operation.correlation.requestedCursor)))
  ) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
}

export type ImmutableSourceAdapterConfiguration = Readonly<
  Record<string, unknown>
>;

export interface ConnectionOperationBase {
  readonly organizationId: string;
  readonly sourceTypeKey: string;
  readonly adapterVersion: string;
  readonly connectionProfileId: string;
  readonly connectionProfileRevisionId: string;
  readonly connectionConfiguration: ImmutableSourceAdapterConfiguration;
  readonly requestLease: SourceRequestLease;
  readonly bounds: ProviderSourceRequestBounds;
  readonly abortSignal: AbortSignal;
}

export interface SourceOperationBase extends ConnectionOperationBase {
  readonly provider: LaunchProviderKey;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly normalizedContractVersion: string;
  readonly identityNamespaceKey: string;
  readonly recordIdScopes: readonly RecordIdScopeDeclaration[];
  readonly sourceConfiguration: ImmutableSourceAdapterConfiguration;
}

export interface ConnectionTestOperation extends ConnectionOperationBase {
  readonly operationKind: "connection_test";
  readonly correlation: Readonly<{
    singletonFencingEpoch: number;
    connectionHealthGeneration: number;
    connectionTestJobId: string;
    jobClaimLeaseId: string;
    recoveryEpisodeId: string | null;
  }>;
}

export interface SourceTestOperation extends SourceOperationBase {
  readonly operationKind: "source_test";
  readonly correlation: Readonly<{
    singletonFencingEpoch: number;
    connectionHealthGeneration: number;
    sourceTestJobId: string;
    jobClaimLeaseId: string;
  }>;
}

export interface PageReadOperation extends SourceOperationBase {
  readonly operationKind: "page_read";
  readonly correlation: Readonly<{
    singletonFencingEpoch: number;
    connectionHealthGeneration: number;
    importRunId: string;
    runClaimLeaseId: string;
    pageAttemptId: string;
    pageNumber: number;
    cursorGeneration: number;
    requestedCursorFingerprint: string | null;
    requestedCursor: OpaqueCursorEnvelope;
    pageLimit: number;
  }>;
}

export type SourceAdapterOperation =
  | ConnectionTestOperation
  | SourceTestOperation
  | PageReadOperation;

const captureInvocationCapability =
  createSourceAdapterCaptureInvocationCapability<SourceAdapterOperation>();
export const SourceAdapterCaptureInvocation =
  captureInvocationCapability.CaptureInvocation;
export type SourceAdapterCaptureInvocation = InstanceType<
  typeof SourceAdapterCaptureInvocation
>;

function issueSourceAdapterCaptureInvocation(
  operation: SourceAdapterOperation,
): SourceAdapterCaptureInvocation {
  return captureInvocationCapability.issue(operation);
}

export type ConnectionTestOperationInput = Omit<
  ConnectionTestOperation,
  "abortSignal"
>;
export type SourceTestOperationInput = Omit<SourceTestOperation, "abortSignal">;
export type PageReadOperationInput = Omit<PageReadOperation, "abortSignal">;

function assertConstructionInput(
  input: unknown,
  operationKind: SourceAdapterOperation["operationKind"],
): asserts input is Record<string, unknown> {
  const operationKeys = operationKind === "connection_test"
    ? connectionOperationKeys
    : sourceOperationKeys;
  if (
    !hasExactKeys(
      input,
      operationKeys.filter((key) => key !== "abortSignal"),
    ) ||
    input.operationKind !== operationKind ||
    !hasExactKeys(input.correlation, correlationKeysByOperation[operationKind])
  ) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
}

export function createConnectionTestOperation(
  input: ConnectionTestOperationInput,
): ConnectionTestOperation {
  assertConstructionInput(input, "connection_test");
  if (!(input.requestLease instanceof SourceRequestLease)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const operation = Object.freeze({
    ...input,
    bounds: canonicalizeBounds(input.bounds),
    connectionConfiguration: canonicalizeConfiguration(
      input.connectionConfiguration,
    ),
    correlation: canonicalizeJsonValue(
      input.correlation,
      new Set(),
    ) as ConnectionTestOperation["correlation"],
    abortSignal: input.requestLease.signal,
  });
  assertSourceAdapterOperation(operation);
  return operation;
}

export function createSourceTestOperation(
  input: SourceTestOperationInput,
): SourceTestOperation {
  assertConstructionInput(input, "source_test");
  if (!(input.requestLease instanceof SourceRequestLease)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const operation = Object.freeze({
    ...input,
    bounds: canonicalizeBounds(input.bounds),
    connectionConfiguration: canonicalizeConfiguration(
      input.connectionConfiguration,
    ),
    recordIdScopes: canonicalizeRecordIdScopes(input.recordIdScopes),
    sourceConfiguration: canonicalizeConfiguration(input.sourceConfiguration),
    correlation: canonicalizeJsonValue(
      input.correlation,
      new Set(),
    ) as SourceTestOperation["correlation"],
    abortSignal: input.requestLease.signal,
  });
  assertSourceAdapterOperation(operation);
  return operation;
}

export function createPageReadOperation(
  input: PageReadOperationInput,
): PageReadOperation {
  assertConstructionInput(input, "page_read");
  if (!(input.requestLease instanceof SourceRequestLease)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const correlation = canonicalizeJsonValue(
    {
      ...input.correlation,
      requestedCursor: canonicalizeCursor(
        input.correlation.requestedCursor,
      ),
    },
    new Set(),
  ) as PageReadOperation["correlation"];
  const operation = Object.freeze({
    ...input,
    bounds: canonicalizeBounds(input.bounds),
    connectionConfiguration: canonicalizeConfiguration(
      input.connectionConfiguration,
    ),
    recordIdScopes: canonicalizeRecordIdScopes(input.recordIdScopes),
    sourceConfiguration: canonicalizeConfiguration(input.sourceConfiguration),
    correlation,
    abortSignal: input.requestLease.signal,
  });
  assertSourceAdapterOperation(operation);
  return operation;
}

export type SourceAdapterOperationScope = SourceRequestOperationPins;

interface SourceAdapterInterpretationConnectionContext {
  readonly organizationId: string;
  readonly sourceTypeKey: string;
  readonly adapterVersion: string;
  readonly connectionProfileId: string;
  readonly connectionProfileRevisionId: string;
  readonly bounds: ProviderSourceRequestBounds;
}

export interface ConnectionTestInterpretationContext
  extends SourceAdapterInterpretationConnectionContext {
  readonly operationKind: "connection_test";
}

interface SourceAdapterInterpretationSourceContext
  extends SourceAdapterInterpretationConnectionContext {
  readonly provider: LaunchProviderKey;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly normalizedContractVersion: string;
  readonly identityNamespaceKey: string;
  readonly recordIdScopes: readonly RecordIdScopeDeclaration[];
  readonly sourceConfiguration: ImmutableSourceAdapterConfiguration;
}

export interface SourceTestInterpretationContext
  extends SourceAdapterInterpretationSourceContext {
  readonly operationKind: "source_test";
}

export interface PageReadInterpretationContext
  extends SourceAdapterInterpretationSourceContext {
  readonly operationKind: "page_read";
  readonly requestedCursor: OpaqueCursorEnvelope;
  readonly pageLimit: number;
  readonly pageNumber: number;
}

export type SourceAdapterInterpretationContext =
  | ConnectionTestInterpretationContext
  | SourceTestInterpretationContext
  | PageReadInterpretationContext;

export function sourceAdapterOperationScopeOf(
  operation: SourceAdapterOperation,
): SourceAdapterOperationScope {
  assertSourceAdapterOperation(operation);
  const common = {
    operationKind: operation.operationKind,
    requestAttemptId: operation.requestLease.pins.requestAttemptId,
    requestLeaseId: operation.requestLease.pins.requestLeaseId,
    organizationId: operation.organizationId,
    sourceTypeKey: operation.sourceTypeKey,
    adapterVersion: operation.adapterVersion,
    singletonFencingEpoch: operation.correlation.singletonFencingEpoch,
    connectionProfileId: operation.connectionProfileId,
    connectionProfileRevisionId: operation.connectionProfileRevisionId,
    connectionHealthGeneration: operation.correlation.connectionHealthGeneration,
  } as const;
  if (operation.operationKind === "connection_test") {
    return {
      ...common,
      operationKind: "connection_test",
      connectionTestJobId: operation.correlation.connectionTestJobId,
      jobClaimLeaseId: operation.correlation.jobClaimLeaseId,
      recoveryEpisodeId: operation.correlation.recoveryEpisodeId,
    };
  }
  const source = {
    ...common,
    provider: operation.provider,
    sourceInstanceId: operation.sourceInstanceId,
    sourceRevisionId: operation.sourceRevisionId,
    normalizedContractVersion: operation.normalizedContractVersion,
    identityNamespaceKey: operation.identityNamespaceKey,
  } as const;
  if (operation.operationKind === "source_test") {
    return {
      ...source,
      operationKind: "source_test",
      sourceTestJobId: operation.correlation.sourceTestJobId,
      jobClaimLeaseId: operation.correlation.jobClaimLeaseId,
    };
  }
  return {
    ...source,
    operationKind: "page_read",
    importRunId: operation.correlation.importRunId,
    runClaimLeaseId: operation.correlation.runClaimLeaseId,
    pageAttemptId: operation.correlation.pageAttemptId,
    pageNumber: operation.correlation.pageNumber,
    pageLimit: operation.correlation.pageLimit,
    cursorGeneration: operation.correlation.cursorGeneration,
    requestedCursorFingerprint:
      operation.correlation.requestedCursorFingerprint,
  };
}

export function sourceAdapterInterpretationContextOf(
  operation: ConnectionTestOperation,
): ConnectionTestInterpretationContext;
export function sourceAdapterInterpretationContextOf(
  operation: SourceTestOperation,
): SourceTestInterpretationContext;
export function sourceAdapterInterpretationContextOf(
  operation: PageReadOperation,
): PageReadInterpretationContext;
export function sourceAdapterInterpretationContextOf(
  operation: SourceAdapterOperation,
): SourceAdapterInterpretationContext {
  assertSourceAdapterOperation(operation);
  const connection = {
    organizationId: operation.organizationId,
    sourceTypeKey: operation.sourceTypeKey,
    adapterVersion: operation.adapterVersion,
    connectionProfileId: operation.connectionProfileId,
    connectionProfileRevisionId: operation.connectionProfileRevisionId,
    bounds: operation.bounds,
  } as const;
  if (operation.operationKind === "connection_test") {
    return Object.freeze({
      ...connection,
      operationKind: "connection_test",
    });
  }
  const source = {
    ...connection,
    provider: operation.provider,
    sourceInstanceId: operation.sourceInstanceId,
    sourceRevisionId: operation.sourceRevisionId,
    normalizedContractVersion: operation.normalizedContractVersion,
    identityNamespaceKey: operation.identityNamespaceKey,
    recordIdScopes: operation.recordIdScopes,
    sourceConfiguration: operation.sourceConfiguration,
  } as const;
  if (operation.operationKind === "source_test") {
    return Object.freeze({ ...source, operationKind: "source_test" });
  }
  return Object.freeze({
    ...source,
    operationKind: "page_read",
    requestedCursor: operation.correlation.requestedCursor,
    pageLimit: operation.correlation.pageLimit,
    pageNumber: operation.correlation.pageNumber,
  });
}

function assertInterpretationContextMatchesOperation(
  operation: SourceAdapterOperation,
  context: SourceAdapterInterpretationContext,
): void {
  const expected = operation.operationKind === "connection_test"
    ? sourceAdapterInterpretationContextOf(operation)
    : operation.operationKind === "source_test"
      ? sourceAdapterInterpretationContextOf(operation)
      : sourceAdapterInterpretationContextOf(operation);
  if (
    !hasExactKeys(context, Object.keys(expected)) ||
    !isDeepFrozenJsonValue(context) ||
    JSON.stringify(context) !== JSON.stringify(expected)
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
}

function assertOperationKind<TKind extends SourceAdapterOperation["operationKind"]>(
  operation: SourceAdapterOperation,
  operationKind: TKind,
): asserts operation is Extract<SourceAdapterOperation, { operationKind: TKind }> {
  assertSourceAdapterOperation(operation);
  if (operation.operationKind !== operationKind) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
}

/**
 * Consumes the one-use lease against the complete adapter operation. Page
 * reads bind the private opaque envelope as well as the browser-safe pins.
 */
export function consumeSourceAdapterRequestLease(
  operation: SourceAdapterOperation,
): SourceRequestInvocation {
  const scope = sourceAdapterOperationScopeOf(operation);
  return operation.operationKind === "page_read"
    ? operation.requestLease.consume(
        scope,
        operation.correlation.requestedCursor,
      )
    : operation.requestLease.consume(scope);
}

export interface ScopedSourceAdapterDiagnostic {
  readonly operationScope: SourceAdapterOperationScope;
  readonly diagnostic: SourceAdapterSafeDiagnostic;
}

export const SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION =
  "packscout.source-adapter-request-capture.v1" as const;

export interface SourceAdapterRequestCaptureV1 {
  readonly captureVersion: typeof SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION;
  /** Exact bounded response bytes; generic orchestration stores but never decodes them. */
  readonly protectedRawResponse: Uint8Array;
  readonly protectedRawResponseSha256: string;
}

/** Measurements available without parsing or validating a provider response. */
export interface SourceAdapterRequestMeasurements {
  readonly durationMilliseconds: number;
  readonly responseBytes: number;
}

/**
 * The request boundary returns after exactly one bounded capture or one stable
 * transport failure. Generic orchestration terminalizes this result before it
 * releases the request permit or invokes an interpretation method.
 */
export type UnboundSourceAdapterRequestResult =
  | Readonly<{
      ok: true;
      value: SourceAdapterRequestCaptureV1;
      measurements: SourceAdapterRequestMeasurements;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      failure: SourceAdapterFailure;
      measurements: SourceAdapterRequestMeasurements;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>;

declare const terminalizedSourceAdapterRequestBrand: unique symbol;
type TerminalizedSourceAdapterRequestBrand = Readonly<{
  [terminalizedSourceAdapterRequestBrand]: true;
}>;

/**
 * A request result that the generic runtime has bound to one exact consumed
 * lease and one successful durable terminalization. Adapter output alone can
 * never satisfy this type or the corresponding runtime check.
 */
export type SourceAdapterRequestResult =
  | (Extract<UnboundSourceAdapterRequestResult, Readonly<{ ok: true }>> &
    TerminalizedSourceAdapterRequestBrand)
  | (Extract<UnboundSourceAdapterRequestResult, Readonly<{ ok: false }>> &
    TerminalizedSourceAdapterRequestBrand);

export type SuccessfulSourceAdapterRequest = Extract<
  SourceAdapterRequestResult,
  Readonly<{ ok: true }>
>;

export type FailedSourceAdapterRequest = Extract<
  SourceAdapterRequestResult,
  Readonly<{ ok: false }>
>;

export type SourceAdapterRequestTerminalizationOutcome =
  | Readonly<{
      ok: true;
      protectedRawResponseSha256: string;
      measurements: SourceAdapterRequestMeasurements;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      failure: SourceAdapterFailure;
      measurements: SourceAdapterRequestMeasurements;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>;

export interface SourceAdapterRequestTerminalizationInput {
  readonly requestAttemptId: string;
  readonly requestLeaseId: string;
  readonly operationScope: SourceAdapterOperationScope;
  readonly outcome: SourceAdapterRequestTerminalizationOutcome;
}

/**
 * Source-neutral acknowledgement returned only after the caller's durable
 * request-attempt transaction (and any blocking episode transition) commits.
 */
export interface DurableSourceAdapterTerminalizationReceipt {
  readonly requestAttemptId: string;
  readonly requestLeaseId: string;
  readonly operationScope: SourceAdapterOperationScope;
}

export type SourceAdapterRequestTerminalizer = (
  input: SourceAdapterRequestTerminalizationInput,
) => Promise<DurableSourceAdapterTerminalizationReceipt>;

interface TerminalizedSourceAdapterRequestBinding {
  readonly operation: SourceAdapterOperation;
}

const terminalizedSourceAdapterRequestBindings = new WeakMap<
  object,
  TerminalizedSourceAdapterRequestBinding
>();

/** Adapter-owned interpretation output after request-attempt terminalization. */
export type SourceAdapterInterpretationResult<TValue> =
  | Readonly<{
      ok: true;
      value: TValue;
      recordCount: number;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      failure: SourceAdapterFailure;
      recordCount: number;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>;

/** Internal validated output before generic orchestration attaches correlation. */
type SourceAdapterRawOperationResult<TValue> =
  | Readonly<{
      ok: true;
      value: TValue;
      measurements: SourceAdapterMeasurements;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      failure: SourceAdapterFailure;
      measurements: SourceAdapterMeasurements;
      diagnostics: readonly SourceAdapterSafeDiagnostic[];
    }>;

function canonicalizeDiagnostics(
  diagnostics: readonly SourceAdapterSafeDiagnostic[],
): SourceAdapterSafeDiagnostic[] {
  try {
    return Object.freeze(
      diagnostics.map((diagnostic) =>
        Object.freeze(sourceAdapterSafeDiagnosticSchema.parse(diagnostic))
      ),
    ) as unknown as SourceAdapterSafeDiagnostic[];
  } catch {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
}

function canonicalizeFailure(failure: SourceAdapterFailure): SourceAdapterFailure {
  try {
    return Object.freeze(sourceAdapterFailureSchema.parse(failure));
  } catch {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
}

function canonicalizeRequestDiagnostics(
  diagnostics: readonly SourceAdapterSafeDiagnostic[],
): readonly SourceAdapterSafeDiagnostic[] {
  try {
    if (!Array.isArray(diagnostics)) {
      throw new TypeError("diagnostics must be an array");
    }
    return Object.freeze(diagnostics.map((diagnostic) => {
      const parsed = sourceAdapterSafeDiagnosticSchema.parse(diagnostic);
      return Object.freeze({
        ...parsed,
        ...(parsed.counters === undefined
          ? {}
          : { counters: Object.freeze({ ...parsed.counters }) }),
      });
    }));
  } catch {
    throw new SourceAdapterContractError("invalid_request_capture");
  }
}

function canonicalizeRequestFailure(
  failure: SourceAdapterFailure,
): SourceAdapterFailure {
  try {
    return Object.freeze(sourceAdapterFailureSchema.parse(failure));
  } catch {
    throw new SourceAdapterContractError("invalid_request_capture");
  }
}

function canonicalizeRequestMeasurements(
  operation: SourceAdapterOperation,
  measurements: SourceAdapterRequestMeasurements,
): SourceAdapterRequestMeasurements {
  if (
    !hasExactKeys(measurements, [
      "durationMilliseconds",
      "responseBytes",
    ])
  ) {
    throw new SourceAdapterContractError("invalid_request_capture");
  }
  try {
    const parsed = sourceAdapterMeasurementsSchema.parse({
      ...measurements,
      recordCount: 0,
    });
    if (parsed.responseBytes > operation.bounds.maximumResponseBytes) {
      throw new SourceAdapterContractError("invalid_request_capture");
    }
    return Object.freeze({
      durationMilliseconds: parsed.durationMilliseconds,
      responseBytes: parsed.responseBytes,
    });
  } catch (error) {
    if (error instanceof SourceAdapterContractError) throw error;
    throw new SourceAdapterContractError("invalid_request_capture");
  }
}

function canonicalizeUnboundSourceAdapterRequest(
  operation: SourceAdapterOperation,
  request: UnboundSourceAdapterRequestResult,
): UnboundSourceAdapterRequestResult {
  try {
    if (!isRecord(request)) {
      throw new SourceAdapterContractError("invalid_request_capture");
    }
    if (request.ok === true) {
      if (
        !hasExactKeys(request, ["diagnostics", "measurements", "ok", "value"]) ||
        !hasExactKeys(request.value, [
          "captureVersion",
          "protectedRawResponse",
          "protectedRawResponseSha256",
        ]) ||
        request.value.captureVersion !== SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION ||
        !(request.value.protectedRawResponse instanceof Uint8Array) ||
        !/^[a-f0-9]{64}$/u.test(request.value.protectedRawResponseSha256)
      ) {
        throw new SourceAdapterContractError("invalid_request_capture");
      }
      const protectedRawResponseSha256 = createHash("sha256")
        .update(request.value.protectedRawResponse)
        .digest("hex");
      const measurements = canonicalizeRequestMeasurements(
        operation,
        request.measurements,
      );
      if (
        protectedRawResponseSha256 !==
          request.value.protectedRawResponseSha256 ||
        measurements.responseBytes !==
          request.value.protectedRawResponse.byteLength
      ) {
        throw new SourceAdapterContractError("invalid_request_capture");
      }
      const protectedRawResponse = takeProtectedRawResponse(
        request.value.protectedRawResponse,
      );
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
          protectedRawResponse,
          protectedRawResponseSha256,
        }),
        measurements,
        diagnostics: canonicalizeRequestDiagnostics(request.diagnostics),
      });
    }
    if (
      request.ok !== false ||
      !hasExactKeys(request, [
        "diagnostics",
        "failure",
        "measurements",
        "ok",
      ])
    ) {
      throw new SourceAdapterContractError("invalid_request_capture");
    }
    return Object.freeze({
      ok: false,
      failure: canonicalizeRequestFailure(request.failure),
      measurements: canonicalizeRequestMeasurements(
        operation,
        request.measurements,
      ),
      diagnostics: canonicalizeRequestDiagnostics(request.diagnostics),
    });
  } catch (error) {
    if (error instanceof SourceAdapterContractError) throw error;
    throw new SourceAdapterContractError("invalid_request_capture");
  }
}

function terminalizationOutcomeOf(
  request: UnboundSourceAdapterRequestResult,
): SourceAdapterRequestTerminalizationOutcome {
  return request.ok
    ? Object.freeze({
        ok: true,
        protectedRawResponseSha256:
          request.value.protectedRawResponseSha256,
        measurements: request.measurements,
        diagnostics: request.diagnostics,
      })
    : Object.freeze({
        ok: false,
        failure: request.failure,
        measurements: request.measurements,
        diagnostics: request.diagnostics,
      });
}

function assertDurableTerminalizationReceipt(
  operation: SourceAdapterOperation,
  receipt: DurableSourceAdapterTerminalizationReceipt,
): void {
  const pins = operation.requestLease.pins;
  try {
    if (
      !hasExactKeys(receipt, [
        "operationScope",
        "requestAttemptId",
        "requestLeaseId",
      ]) ||
      receipt.requestAttemptId !== pins.requestAttemptId ||
      receipt.requestLeaseId !== pins.requestLeaseId ||
      !sourceRequestOperationPinsEqual(
        receipt.operationScope,
        sourceAdapterOperationScopeOf(operation),
      )
    ) {
      throw new SourceAdapterContractError("invalid_terminalization_receipt");
    }
  } catch (error) {
    if (error instanceof SourceAdapterContractError) throw error;
    throw new SourceAdapterContractError("invalid_terminalization_receipt");
  }
}

/**
 * Generic request owner: consumes the exact operation lease, captures once,
 * waits for durable request-attempt terminalization, binds the result to that
 * operation, and only then releases the profile request permit.
 */
export async function captureAndTerminalizeSourceAdapterRequest(
  requestLeaseAuthority: SourceRequestLeaseAuthority,
  adapter: SourceAdapter,
  operation: SourceAdapterOperation,
  terminalize: SourceAdapterRequestTerminalizer,
): Promise<SourceAdapterRequestResult> {
  assertSourceAdapterOperation(operation);
  if (
    !(requestLeaseAuthority instanceof SourceRequestLeaseAuthority) ||
    typeof terminalize !== "function"
  ) {
    throw new SourceAdapterContractError("invalid_terminalization_receipt");
  }
  consumeSourceAdapterRequestLease(operation);
  const request = canonicalizeUnboundSourceAdapterRequest(
    operation,
    await adapter.captureUnboundRequest(
      operation,
      issueSourceAdapterCaptureInvocation(operation),
    ),
  );
  const operationScope = Object.freeze(sourceAdapterOperationScopeOf(operation));
  const terminalizationInput = Object.freeze({
    requestAttemptId: operation.requestLease.pins.requestAttemptId,
    requestLeaseId: operation.requestLease.pins.requestLeaseId,
    operationScope,
    outcome: terminalizationOutcomeOf(request),
  });
  const durableReceipt = await terminalize(terminalizationInput);
  assertDurableTerminalizationReceipt(operation, durableReceipt);
  const boundRequest = request as SourceAdapterRequestResult;
  terminalizedSourceAdapterRequestBindings.set(boundRequest, { operation });
  try {
    requestLeaseAuthority.releaseTerminalizedRequestPermit(
      operation.requestLease,
      Object.freeze({
        requestAttemptId: durableReceipt.requestAttemptId,
        requestLeaseId: durableReceipt.requestLeaseId,
      }),
    );
    if (operation.requestLease.requestPermitHeld) {
      throw new SourceAdapterContractError("invalid_terminalization_receipt");
    }
  } catch (error) {
    terminalizedSourceAdapterRequestBindings.delete(boundRequest);
    throw error;
  }
  return boundRequest;
}

function assertRequestTerminalizedForOperation(
  operation: SourceAdapterOperation,
  request: SourceAdapterRequestResult,
): void {
  const binding = isRecord(request)
    ? terminalizedSourceAdapterRequestBindings.get(request)
    : undefined;
  if (
    binding === undefined ||
    binding.operation !== operation ||
    operation.requestLease.requestPermitHeld
  ) {
    throw new SourceAdapterContractError("invalid_request_capture");
  }
}

function completeValidatedSourceAdapterInterpretation<TValue>(
  request: SuccessfulSourceAdapterRequest,
  interpretation: SourceAdapterInterpretationResult<TValue>,
): SourceAdapterRawOperationResult<TValue> {
  const measurements = Object.freeze(sourceAdapterMeasurementsSchema.parse({
    ...request.measurements,
    recordCount: interpretation.recordCount,
  }));
  const diagnostics = canonicalizeDiagnostics([
    ...request.diagnostics,
    ...interpretation.diagnostics,
  ]);
  return interpretation.ok
    ? Object.freeze({
        ok: true,
        value: canonicalizeSourceAdapterResultValue(interpretation.value),
        measurements,
        diagnostics,
      })
    : Object.freeze({
        ok: false,
        failure: canonicalizeFailure(interpretation.failure),
        measurements,
        diagnostics,
      });
}

/** Runtime-owned output whose safe correlation cannot be supplied by an adapter. */
export type SourceAdapterOperationResult<TValue> =
  | Readonly<{
      ok: true;
      operationScope: SourceAdapterOperationScope;
      value: TValue;
      measurements: SourceAdapterMeasurements;
      diagnostics: readonly ScopedSourceAdapterDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      operationScope: SourceAdapterOperationScope;
      failure: SourceAdapterFailure;
      measurements: SourceAdapterMeasurements;
      diagnostics: readonly ScopedSourceAdapterDiagnostic[];
    }>;

const scopedSourceAdapterOperationResults =
  createSourceAdapterOperationResultCapability();

/**
 * Proves that a completed result came from this module's operation-bound
 * capture/interpretation boundary. The registration is replay-safe and cannot
 * be reconstructed with a structural object or exported brand.
 */
export function assertScopedSourceAdapterOperationResult<TValue>(
  result: unknown,
): asserts result is SourceAdapterOperationResult<TValue> {
  if (
    !isRecord(result) ||
    !scopedSourceAdapterOperationResults.has(result)
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
}

function scopeSourceAdapterOperationResult<TValue>(
  operation: SourceAdapterOperation,
  result: SourceAdapterRawOperationResult<TValue>,
): SourceAdapterOperationResult<TValue> {
  const operationScope = Object.freeze(sourceAdapterOperationScopeOf(operation));
  if (!sourceAdapterMeasurementsSchema.safeParse(result.measurements).success) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  const measurements = result.measurements;
  const diagnostics = Object.freeze(
    result.diagnostics.map((diagnostic) => {
      if (!sourceAdapterSafeDiagnosticSchema.safeParse(diagnostic).success) {
        throw new SourceAdapterContractError("invalid_interpretation_shape");
      }
      return Object.freeze({
        operationScope,
        diagnostic,
      });
    }),
  );
  const scopedResult: SourceAdapterOperationResult<TValue> = result.ok
    ? Object.freeze({
        ok: true,
        operationScope,
        value: result.value,
        measurements,
        diagnostics,
      })
    : Object.freeze({
        ok: false,
        operationScope,
        failure: canonicalizeFailure(result.failure),
        measurements,
        diagnostics,
      });
  return scopedSourceAdapterOperationResults.register(scopedResult);
}

export interface ConnectionTestValue {
  readonly status: "reachable";
}

export interface SourceTestValue {
  readonly status: "readable";
  readonly provider: LaunchProviderKey;
}

function assertSuccessfulRequestCapture(
  operation: SourceAdapterOperation,
  request: SuccessfulSourceAdapterRequest,
): void {
  if (
    !hasExactKeys(request, ["diagnostics", "measurements", "ok", "value"]) ||
    request.ok !== true ||
    !hasExactKeys(request.measurements, [
      "durationMilliseconds",
      "responseBytes",
    ]) ||
    !hasExactKeys(request.value, [
      "captureVersion",
      "protectedRawResponse",
      "protectedRawResponseSha256",
    ]) ||
    request.value.captureVersion !== SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION ||
    !(request.value.protectedRawResponse instanceof Uint8Array) ||
    !/^[a-f0-9]{64}$/u.test(request.value.protectedRawResponseSha256) ||
    createHash("sha256")
        .update(request.value.protectedRawResponse)
        .digest("hex") !== request.value.protectedRawResponseSha256 ||
    !sourceAdapterMeasurementsSchema.safeParse({
      ...request.measurements,
      recordCount: 0,
    }).success ||
    request.measurements.responseBytes !==
      request.value.protectedRawResponse.byteLength ||
    request.measurements.responseBytes > operation.bounds.maximumResponseBytes
  ) {
    throw new SourceAdapterContractError("invalid_request_capture");
  }
}

function assertSourceAdapterInterpretationResult(
  interpretation: SourceAdapterInterpretationResult<unknown>,
): void {
  const keys = interpretation.ok
    ? ["diagnostics", "ok", "recordCount", "value"]
    : ["diagnostics", "failure", "ok", "recordCount"];
  if (
    !hasExactKeys(interpretation, keys) ||
    !sourceAdapterMeasurementsSchema.safeParse({
      durationMilliseconds: 0,
      responseBytes: 0,
      recordCount: interpretation.recordCount,
    }).success
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  canonicalizeDiagnostics(interpretation.diagnostics);
  if (!interpretation.ok) canonicalizeFailure(interpretation.failure);
}

export function completeSourceAdapterRequestFailure(
  operation: SourceAdapterOperation,
  request: FailedSourceAdapterRequest,
): SourceAdapterOperationResult<never> {
  assertSourceAdapterOperation(operation);
  assertRequestTerminalizedForOperation(operation, request);
  if (
    !hasExactKeys(request, [
      "diagnostics",
      "failure",
      "measurements",
      "ok",
    ]) ||
    request.ok !== false ||
    !hasExactKeys(request.measurements, [
      "durationMilliseconds",
      "responseBytes",
    ]) ||
    request.measurements.responseBytes > operation.bounds.maximumResponseBytes
  ) {
    throw new SourceAdapterContractError("invalid_request_capture");
  }
  const diagnostics = canonicalizeDiagnostics(request.diagnostics);
  let measurements: SourceAdapterMeasurements;
  try {
    measurements = Object.freeze(sourceAdapterMeasurementsSchema.parse({
      ...request.measurements,
      recordCount: 0,
    }));
  } catch {
    throw new SourceAdapterContractError("invalid_request_capture");
  }
  return scopeSourceAdapterOperationResult(operation, Object.freeze({
    ok: false,
    failure: canonicalizeFailure(request.failure),
    measurements,
    diagnostics,
  }));
}

export function completeSourceAdapterConnectionTest(
  operation: ConnectionTestOperation,
  context: ConnectionTestInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
  interpretation: SourceAdapterInterpretationResult<ConnectionTestValue>,
): SourceAdapterOperationResult<ConnectionTestValue> {
  assertOperationKind(operation, "connection_test");
  assertInterpretationContextMatchesOperation(operation, context);
  assertRequestTerminalizedForOperation(operation, request);
  assertSuccessfulRequestCapture(operation, request);
  assertSourceAdapterInterpretationResult(interpretation);
  if (
    interpretation.recordCount !== 0 ||
    (interpretation.ok &&
      (!hasExactKeys(interpretation.value, ["status"]) ||
        interpretation.value.status !== "reachable"))
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  return scopeSourceAdapterOperationResult(
    operation,
    completeValidatedSourceAdapterInterpretation(request, interpretation),
  );
}

export function completeSourceAdapterSourceTest(
  operation: SourceTestOperation,
  context: SourceTestInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
  interpretation: SourceAdapterInterpretationResult<SourceTestValue>,
): SourceAdapterOperationResult<SourceTestValue> {
  assertOperationKind(operation, "source_test");
  assertInterpretationContextMatchesOperation(operation, context);
  assertRequestTerminalizedForOperation(operation, request);
  assertSuccessfulRequestCapture(operation, request);
  assertSourceAdapterInterpretationResult(interpretation);
  if (
    interpretation.ok &&
    (!hasExactKeys(interpretation.value, ["provider", "status"]) ||
      interpretation.value.status !== "readable" ||
      interpretation.value.provider !== operation.provider)
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  return scopeSourceAdapterOperationResult(
    operation,
    completeValidatedSourceAdapterInterpretation(request, interpretation),
  );
}

function completeValidatedSourceAdapterPageInterpretation(
  operation: PageReadOperation,
  request: SuccessfulSourceAdapterRequest,
  interpretation: SourceAdapterPageInterpretationResult,
): SourceAdapterRawOperationResult<CapturedSourcePageV1> {
  assertSuccessfulRequestCapture(operation, request);
  const interpretationKeys = interpretation.ok
    ? ["diagnostics", "ok", "value"]
    : ["diagnostics", "failure", "ok"];
  if (!hasExactKeys(interpretation, interpretationKeys)) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  if (!interpretation.ok) {
    return completeValidatedSourceAdapterInterpretation(request, {
      ok: false,
      failure: interpretation.failure,
      recordCount: 0,
      diagnostics: interpretation.diagnostics,
    });
  }
  if (
    !hasExactKeys(interpretation.value, [
      "normalizedPage",
      "protectedNativeEvidence",
    ]) ||
    !hasExactKeys(interpretation.value.normalizedPage, [
      "continuation",
      "nextCursor",
      "normalizedContractVersion",
      "outcomes",
      "provider",
    ])
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }

  const recordCount = interpretation.value.normalizedPage.outcomes.length;
  const diagnostics = canonicalizeDiagnostics([
    ...request.diagnostics,
    ...interpretation.diagnostics,
  ]);
  const draftMeasurements = sourceAdapterMeasurementsSchema.parse({
    ...request.measurements,
    recordCount,
  });
  if (
    operation.normalizedContractVersion !==
      PROVIDER_OBSERVATION_CONTRACT_VERSION
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  const normalizedPage = completeNormalizedProviderObservationPage({
    ...interpretation.value.normalizedPage,
    measurements: draftMeasurements,
    diagnostics,
  });
  const measurements = normalizedPage.measurements;
  const canonicalPageDiagnostics = normalizedPage.diagnostics;
  const requestedCursor = operation.correlation.requestedCursor;
  const nextCursor = normalizedPage.nextCursor;
  if (
    normalizedPage.provider !== operation.provider ||
    normalizedPage.normalizedContractVersion !==
      operation.normalizedContractVersion ||
    nextCursor.sourceInstanceId !== operation.sourceInstanceId ||
    nextCursor.sourceRevisionId !== operation.sourceRevisionId ||
    nextCursor.sourceTypeKey !== operation.sourceTypeKey ||
    nextCursor.adapterVersion !== operation.adapterVersion ||
    nextCursor.cursorCodecKey !==
      requestedCursor.cursorCodecKey ||
    nextCursor.cursorGeneration !==
      operation.correlation.cursorGeneration
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  const protectedNativeEvidence = canonicalizeProtectedNativeEvidence(
    interpretation.value.protectedNativeEvidence,
  );
  const evidenceReferences = protectedNativeEvidence.map(
    ({ reference }) => reference,
  );
  const outcomeReferences = normalizedPage.outcomes.flatMap((outcome) => {
    if (outcome.status === "invalid") {
      return [outcome.protectedNativeEvidenceRef];
    }
    const references = [outcome.observation.protectedNativeEvidenceRef];
    if (
      outcome.observation.kind === "trade" &&
      outcome.observation.protectedTransactionEvidenceRef !== null
    ) {
      references.push(
        outcome.observation.protectedTransactionEvidenceRef,
      );
    }
    return references;
  });
  // First-pass evidence is a closed set: every outcome reference resolves
  // exactly once, reference reuse is forbidden, and unreferenced evidence is
  // rejected instead of being carried into persistence as unattached payload.
  if (
    new Set(evidenceReferences).size !== evidenceReferences.length ||
    new Set(outcomeReferences).size !== outcomeReferences.length ||
    evidenceReferences.length !== outcomeReferences.length ||
    evidenceReferences.some(
      (reference) => !outcomeReferences.includes(reference),
    )
  ) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  const value = Object.freeze({
    captureVersion: CAPTURED_SOURCE_PAGE_VERSION,
    requestCapture: request.value,
    protectedNativeEvidence,
    normalizedPage,
  });
  return Object.freeze({
    ok: true,
    value,
    measurements,
    diagnostics: canonicalPageDiagnostics,
  });
}

export function completeSourceAdapterPageRead(
  operation: PageReadOperation,
  context: PageReadInterpretationContext,
  request: SuccessfulSourceAdapterRequest,
  interpretation: SourceAdapterPageInterpretationResult,
): SourceAdapterOperationResult<CapturedSourcePageV1> {
  assertOperationKind(operation, "page_read");
  assertInterpretationContextMatchesOperation(operation, context);
  assertRequestTerminalizedForOperation(operation, request);
  return scopeSourceAdapterOperationResult(
    operation,
    completeValidatedSourceAdapterPageInterpretation(
      operation,
      request,
      interpretation,
    ),
  );
}

export type SourceAdapterConfigurationValidation =
  | Readonly<{ ok: true; value: ImmutableSourceAdapterConfiguration }>
  | Readonly<{ ok: false; failure: SourceAdapterFailure }>;

export interface SourceAdapter {
  readonly manifest: SourceAdapterManifestV1;
  validateConnectionConfiguration(
    configuration: unknown,
  ): SourceAdapterConfigurationValidation;
  validateSourceConfiguration(
    provider: LaunchProviderKey,
    configuration: unknown,
  ): SourceAdapterConfigurationValidation;
  /** @internal Called only by captureAndTerminalizeSourceAdapterRequest. */
  captureUnboundRequest(
    operation: SourceAdapterOperation,
    invocation: SourceAdapterCaptureInvocation,
  ): Promise<UnboundSourceAdapterRequestResult>;
  interpretConnectionTest(
    context: ConnectionTestInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<ConnectionTestValue>>;
  interpretSourceTest(
    context: SourceTestInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<SourceTestValue>>;
  interpretPage(
    context: PageReadInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterPageInterpretationResult>;
  cancelRequest(lease: SourceRequestLease): void;
}

export async function interpretSourceAdapterConnectionTest(
  adapter: SourceAdapter,
  operation: ConnectionTestOperation,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterInterpretationResult<ConnectionTestValue>> {
  assertOperationKind(operation, "connection_test");
  assertRequestTerminalizedForOperation(operation, request);
  assertSuccessfulRequestCapture(operation, request);
  return adapter.interpretConnectionTest(
    sourceAdapterInterpretationContextOf(operation),
    request,
  );
}

export async function interpretSourceAdapterSourceTest(
  adapter: SourceAdapter,
  operation: SourceTestOperation,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterInterpretationResult<SourceTestValue>> {
  assertOperationKind(operation, "source_test");
  assertRequestTerminalizedForOperation(operation, request);
  assertSuccessfulRequestCapture(operation, request);
  return adapter.interpretSourceTest(
    sourceAdapterInterpretationContextOf(operation),
    request,
  );
}

export async function interpretSourceAdapterPage(
  adapter: SourceAdapter,
  operation: PageReadOperation,
  request: SuccessfulSourceAdapterRequest,
): Promise<SourceAdapterPageInterpretationResult> {
  assertOperationKind(operation, "page_read");
  assertRequestTerminalizedForOperation(operation, request);
  assertSuccessfulRequestCapture(operation, request);
  return adapter.interpretPage(
    sourceAdapterInterpretationContextOf(operation),
    request,
  );
}
