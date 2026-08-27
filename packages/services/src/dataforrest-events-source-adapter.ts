import { createHash } from "node:crypto";
import {
  dataforrestEventsConnectionConfigurationV1Schema,
  dataforrestOpaqueCursorV1Schema,
  dataforrestEventsSourceConfigurationV1Schema,
  dataforrestEventsV1SourceAdapterManifest,
  sourceAdapterFailureSchema,
  type LaunchProviderKey,
  type SourceAdapterFailure,
  type SourceAdapterSafeDiagnostic,
  type SourceAdapterManifestV1,
} from "@packscout/contracts";
import {
  HardenedProviderRequestError,
  captureHardenedProviderResponse,
  type HardenedProviderRequestDependencies,
} from "./hardened-provider-request.ts";
import {
  interpretDataforrestConnectionTest,
  interpretDataforrestPage,
  interpretDataforrestSourceTest,
} from "./dataforrest-events-page-interpreter.ts";
import {
  ProviderEndpointPolicyError,
  validateProviderEndpoint,
} from "./provider-endpoint-policy.ts";
import {
  SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
  SourceAdapterCaptureInvocation,
  SourceAdapterContractError,
  assertSourceAdapterOperation,
  type ConnectionTestInterpretationContext,
  type ConnectionTestValue,
  type PageReadInterpretationContext,
  type SourceAdapter,
  type SourceAdapterConfigurationValidation,
  type SourceAdapterInterpretationResult,
  type SourceAdapterOperation,
  type SourceAdapterPageInterpretationResult,
  type UnboundSourceAdapterRequestResult,
  type SourceTestInterpretationContext,
  type SourceTestValue,
  type SuccessfulSourceAdapterRequest,
} from "./source-adapter.ts";
import { SourceRequestLease } from "./source-request-lease.ts";

interface ValidatedCaptureOperation {
  readonly endpoint: URL;
  readonly endpointHost: string;
  readonly bearerToken: string;
  readonly platform: LaunchProviderKey | null;
}

type OperationValidation =
  | Readonly<{ ok: true; value: ValidatedCaptureOperation }>
  | Readonly<{ ok: false; failure: SourceAdapterFailure }>;

function stableFailure(
  disposition: SourceAdapterFailure["disposition"],
  code: SourceAdapterFailure["code"],
  safeStatus?: number,
): SourceAdapterFailure {
  return Object.freeze(sourceAdapterFailureSchema.parse({
    disposition,
    code,
    ...(safeStatus === undefined ? {} : { safeStatus }),
  }));
}

function failedRequest(
  failure: SourceAdapterFailure,
  durationMilliseconds = 0,
  responseBytes = 0,
  code: string = failure.code,
): UnboundSourceAdapterRequestResult {
  return Object.freeze({
    ok: false,
    failure,
    measurements: Object.freeze({ durationMilliseconds, responseBytes }),
    diagnostics: Object.freeze([Object.freeze({
      severity: failure.disposition === "retryable" ? "warning" : "critical",
      phase: "request_capture",
      code,
    }) satisfies SourceAdapterSafeDiagnostic]),
  });
}

function operationLostOwnership(): UnboundSourceAdapterRequestResult {
  return failedRequest(stableFailure("cancelled", "lost_ownership"));
}

function recordsScopesMatch(operation: Exclude<
  SourceAdapterOperation,
  Readonly<{ operationKind: "connection_test" }>
>, manifest: SourceAdapterManifestV1): boolean {
  const declaration = manifest
    .supportedProviders.find(({ provider }) => provider === operation.provider);
  if (declaration === undefined) return false;
  const actual = [...operation.recordIdScopes].sort((left, right) =>
    left.recordIdScopeKey.localeCompare(right.recordIdScopeKey)
  );
  const expected = [...declaration.recordIdScopes].sort((left, right) =>
    left.recordIdScopeKey.localeCompare(right.recordIdScopeKey)
  );
  return actual.length === expected.length && actual.every((scope, index) => {
    const candidate = expected[index];
    return candidate !== undefined &&
      scope.recordIdScopeKey === candidate.recordIdScopeKey &&
      scope.sourceKind === candidate.sourceKind &&
      scope.catalogEntity === candidate.catalogEntity &&
      scope.canonicalKind === candidate.canonicalKind;
  });
}

function validateCaptureOperation(
  operation: SourceAdapterOperation,
  manifest: SourceAdapterManifestV1,
): OperationValidation {
  if (
    operation.sourceTypeKey !== manifest.sourceTypeKey ||
    operation.adapterVersion !== manifest.adapterVersion
  ) {
    return { ok: false, failure: stableFailure("cancelled", "lost_ownership") };
  }
  const manifestBounds = manifest.requestBounds;
  if (
    operation.bounds.maximumResponseBytes >
      manifestBounds.maximumResponseBytes ||
    operation.bounds.timeoutMilliseconds > manifestBounds.timeoutMilliseconds
  ) {
    return {
      ok: false,
      failure: stableFailure(
        "connection_action_required",
        "profile_configuration_invalid",
      ),
    };
  }
  const connection = dataforrestEventsConnectionConfigurationV1Schema.safeParse(
    operation.connectionConfiguration,
  );
  if (!connection.success) {
    const endpointInvalid = connection.error.issues.some(
      ({ path }) => path[0] === "endpoint",
    );
    return {
      ok: false,
      failure: stableFailure(
        "connection_action_required",
        endpointInvalid ? "endpoint_invalid" : "profile_configuration_invalid",
      ),
    };
  }
  let endpointPolicy: ReturnType<typeof validateProviderEndpoint>;
  try {
    endpointPolicy = validateProviderEndpoint(
      connection.data.endpoint,
      "production",
    );
  } catch (error) {
    if (error instanceof ProviderEndpointPolicyError) {
      return {
        ok: false,
        failure: stableFailure(
          "connection_action_required",
          "endpoint_invalid",
        ),
      };
    }
    return {
      ok: false,
      failure: stableFailure(
        "connection_action_required",
        "profile_configuration_invalid",
      ),
    };
  }
  if (operation.operationKind === "connection_test") {
    if (operation.bounds.pageLimit > manifestBounds.pageLimit) {
      return {
        ok: false,
        failure: stableFailure(
          "connection_action_required",
          "profile_configuration_invalid",
        ),
      };
    }
    return {
      ok: true,
      value: {
        endpoint: new URL(endpointPolicy.endpoint),
        endpointHost: endpointPolicy.endpointHost,
        bearerToken: connection.data.bearerToken,
        platform: null,
      },
    };
  }

  const source = dataforrestEventsSourceConfigurationV1Schema.safeParse(
    operation.sourceConfiguration,
  );
  const declaration = manifest
    .supportedProviders.find(({ provider }) => provider === operation.provider);
  if (
    !source.success ||
    source.data.platform !== operation.provider ||
    declaration === undefined ||
    operation.normalizedContractVersion !==
      manifest.normalizedContractVersion ||
    operation.identityNamespaceKey !== declaration.identityNamespaceKey ||
    !recordsScopesMatch(operation, manifest)
  ) {
    return {
      ok: false,
      failure: stableFailure(
        "source_action_required",
        declaration === undefined
          ? "unsupported_provider"
          : "invalid_source_configuration",
      ),
    };
  }
  if (operation.bounds.pageLimit > manifestBounds.pageLimit) {
    return {
      ok: false,
      failure: stableFailure(
        "source_action_required",
        "invalid_source_configuration",
      ),
    };
  }
  if (operation.operationKind === "page_read") {
    const cursor = operation.correlation.requestedCursor;
    if (
      operation.correlation.pageLimit !== operation.bounds.pageLimit ||
      cursor.sourceInstanceId !== operation.sourceInstanceId ||
      cursor.sourceRevisionId !== operation.sourceRevisionId ||
      cursor.sourceTypeKey !== operation.sourceTypeKey ||
      cursor.adapterVersion !== operation.adapterVersion ||
      cursor.cursorCodecKey !==
        manifest.cursorCodecKey ||
      cursor.cursorGeneration !==
        operation.correlation.cursorGeneration ||
      (cursor.value !== null &&
        !dataforrestOpaqueCursorV1Schema.safeParse(cursor.value).success)
    ) {
      return {
        ok: false,
        failure: stableFailure("source_action_required", "invalid_cursor"),
      };
    }
  }
  return {
    ok: true,
    value: {
      endpoint: new URL(endpointPolicy.endpoint),
      endpointHost: endpointPolicy.endpointHost,
      bearerToken: connection.data.bearerToken,
      platform: source.data.platform,
    },
  };
}

function buildRequestUrl(
  operation: SourceAdapterOperation,
  validated: ValidatedCaptureOperation,
): URL {
  const requestUrl = new URL(validated.endpoint.toString());
  if (operation.operationKind === "connection_test") {
    requestUrl.searchParams.append("limit", String(operation.bounds.pageLimit));
    return requestUrl;
  }
  requestUrl.searchParams.append("platform", validated.platform!);
  requestUrl.searchParams.append("limit", String(operation.bounds.pageLimit));
  if (
    operation.operationKind === "page_read" &&
    operation.correlation.requestedCursor.value !== null
  ) {
    requestUrl.searchParams.append(
      "cursor",
      operation.correlation.requestedCursor.value,
    );
  }
  return requestUrl;
}

function mapHttpStatus(
  operation: SourceAdapterOperation,
  status: number,
): SourceAdapterFailure {
  if (status === 404 || status === 405 || status === 410) {
    return stableFailure(
      "connection_action_required",
      "endpoint_invalid",
      status,
    );
  }
  if (status === 401) {
    return stableFailure(
      "connection_action_required",
      "authentication_failed",
      status,
    );
  }
  if (status === 403) {
    return stableFailure(
      "connection_action_required",
      "authorization_failed",
      status,
    );
  }
  if (status === 408) {
    return stableFailure("retryable", "request_timeout", status);
  }
  if (status === 429) {
    return stableFailure("retryable", "rate_limited", status);
  }
  if (status >= 500) {
    return stableFailure("retryable", "server_failure", status);
  }
  if (
    operation.operationKind !== "connection_test" &&
    (status === 400 || status === 422)
  ) {
    const hasCursor = operation.operationKind === "page_read" &&
      operation.correlation.requestedCursor.value !== null;
    return stableFailure(
      "source_action_required",
      hasCursor ? "invalid_cursor" : "invalid_source_configuration",
      status,
    );
  }
  return operation.operationKind === "connection_test"
    ? stableFailure("connection_action_required", "endpoint_invalid", status)
    : stableFailure("source_action_required", "invalid_response", status);
}

function mapTransportFailure(
  operation: SourceAdapterOperation,
  error: HardenedProviderRequestError,
): SourceAdapterFailure {
  switch (error.code) {
    case "cancelled":
      return stableFailure("cancelled", "cancelled");
    case "request_timeout":
      return stableFailure("retryable", "request_timeout");
    case "network_error":
    case "destination_resolution_failed":
      return stableFailure("retryable", "network_interruption");
    case "tls_failed":
      return stableFailure("connection_action_required", "tls_failed");
    case "destination_not_allowed":
    case "redirect_rejected":
      return stableFailure(
        "connection_action_required",
        "destination_rejected",
        error.safeStatus,
      );
    case "invalid_configuration":
      return stableFailure("connection_action_required", "endpoint_invalid");
    case "response_too_large":
      return operation.operationKind === "connection_test"
        ? stableFailure(
            "connection_action_required",
            "profile_configuration_invalid",
          )
        : operation.operationKind === "page_read"
          ? stableFailure("retryable", "response_too_large")
          : stableFailure("source_action_required", "invalid_response");
    case "http_status":
      return mapHttpStatus(operation, error.safeStatus ?? 500);
  }
}

export class DataforrestEventsSourceAdapter implements SourceAdapter {
  readonly manifest: SourceAdapterManifestV1;
  readonly #requestDependencies: HardenedProviderRequestDependencies;

  constructor(
    requestDependencies: HardenedProviderRequestDependencies = {},
    manifest: SourceAdapterManifestV1 =
      dataforrestEventsV1SourceAdapterManifest,
  ) {
    this.#requestDependencies = requestDependencies;
    this.manifest = manifest;
  }

  validateConnectionConfiguration(
    configuration: unknown,
  ): SourceAdapterConfigurationValidation {
    const parsed = dataforrestEventsConnectionConfigurationV1Schema.safeParse(
      configuration,
    );
    if (!parsed.success) {
      return {
        ok: false,
        failure: stableFailure(
          "connection_action_required",
          parsed.error.issues.some(({ path }) => path[0] === "endpoint")
            ? "endpoint_invalid"
            : "profile_configuration_invalid",
        ),
      };
    }
    return { ok: true, value: Object.freeze({ ...parsed.data }) };
  }

  validateSourceConfiguration(
    provider: LaunchProviderKey,
    configuration: unknown,
  ): SourceAdapterConfigurationValidation {
    const supported = this.manifest.supportedProviders.some(
      (declaration) => declaration.provider === provider,
    );
    const parsed = dataforrestEventsSourceConfigurationV1Schema.safeParse(
      configuration,
    );
    if (!supported || !parsed.success || parsed.data.platform !== provider) {
      return {
        ok: false,
        failure: stableFailure(
          "source_action_required",
          supported ? "invalid_source_configuration" : "unsupported_provider",
        ),
      };
    }
    return { ok: true, value: Object.freeze({ ...parsed.data }) };
  }

  async captureUnboundRequest(
    operation: SourceAdapterOperation,
    invocation: SourceAdapterCaptureInvocation,
  ): Promise<UnboundSourceAdapterRequestResult> {
    try {
      assertSourceAdapterOperation(operation);
      if (!(invocation instanceof SourceAdapterCaptureInvocation)) {
        return operationLostOwnership();
      }
      invocation.consume(operation);
    } catch (error) {
      if (error instanceof SourceAdapterContractError) {
        return operationLostOwnership();
      }
      throw error;
    }
    const validation = validateCaptureOperation(operation, this.manifest);
    if (!validation.ok) return failedRequest(validation.failure);
    try {
      const capture = await captureHardenedProviderResponse(
        {
          url: buildRequestUrl(operation, validation.value),
          allowedHosts: [validation.value.endpointHost],
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${validation.value.bearerToken}`,
          },
          timeoutMilliseconds: operation.bounds.timeoutMilliseconds,
          maximumResponseBytes: operation.bounds.maximumResponseBytes,
          signal: operation.abortSignal,
        },
        this.#requestDependencies,
      );
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
          protectedRawResponse: capture.protectedBody,
          protectedRawResponseSha256: createHash("sha256")
            .update(capture.protectedBody)
            .digest("hex"),
        }),
        measurements: Object.freeze({
          durationMilliseconds: capture.durationMilliseconds,
          responseBytes: capture.responseBytes,
        }),
        diagnostics: Object.freeze([Object.freeze({
          severity: "info",
          phase: "request_capture",
          code: "response_captured",
        })]),
      });
    } catch (error) {
      if (error instanceof HardenedProviderRequestError) {
        return failedRequest(
          mapTransportFailure(operation, error),
          error.durationMilliseconds,
          error.responseBytes,
          error.code,
        );
      }
      return failedRequest(
        stableFailure("retryable", "network_interruption"),
      );
    }
  }

  interpretConnectionTest(
    context: ConnectionTestInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<ConnectionTestValue>> {
    if (!this.#interpretationContextMatches(context)) {
      return Promise.resolve({
        ok: false,
        failure: stableFailure(
          "connection_action_required",
          "profile_configuration_invalid",
        ),
        recordCount: 0,
        diagnostics: [{
          severity: "critical",
          phase: "response_interpretation",
          code: "adapter_pin_mismatch",
        }],
      });
    }
    return interpretDataforrestConnectionTest(context, request);
  }

  interpretSourceTest(
    context: SourceTestInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<SourceTestValue>> {
    if (!this.#interpretationContextMatches(context)) {
      return Promise.resolve({
        ok: false,
        failure: stableFailure(
          "source_action_required",
          "invalid_source_configuration",
        ),
        recordCount: 0,
        diagnostics: [{
          severity: "critical",
          phase: "response_interpretation",
          code: "adapter_pin_mismatch",
        }],
      });
    }
    return interpretDataforrestSourceTest(context, request);
  }

  interpretPage(
    context: PageReadInterpretationContext,
    request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterPageInterpretationResult> {
    if (!this.#interpretationContextMatches(context)) {
      return Promise.resolve({
        ok: false,
        failure: stableFailure(
          "source_action_required",
          "invalid_source_configuration",
        ),
        diagnostics: [{
          severity: "critical",
          phase: "response_interpretation",
          code: "adapter_pin_mismatch",
        }],
      });
    }
    return interpretDataforrestPage(context, request);
  }

  #interpretationContextMatches(
    context:
      | ConnectionTestInterpretationContext
      | SourceTestInterpretationContext
      | PageReadInterpretationContext,
  ): boolean {
    return context.sourceTypeKey === this.manifest.sourceTypeKey &&
      context.adapterVersion === this.manifest.adapterVersion;
  }

  cancelRequest(lease: SourceRequestLease): void {
    lease.cancel();
  }
}
