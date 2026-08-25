import { createHash } from "node:crypto";
import {
  launchRecordIdScopeDeclarations,
  type VersionedNormalizedProviderObservationPage,
  type OpaqueCursorEnvelope,
  type SourceAdapterManifestV1,
} from "@packscout/contracts";
import { ConnectionPermitCoordinator } from
  "./connection-permit-coordinator.ts";
import {
  SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
  captureAndTerminalizeSourceAdapterRequest,
  completeSourceAdapterPageRead,
  createPageReadOperation,
  interpretSourceAdapterPage,
  sourceAdapterInterpretationContextOf,
  type CapturedSourcePageV1,
  type ConnectionTestInterpretationContext,
  type ConnectionTestValue,
  type PageReadInterpretationContext,
  type SourceAdapter,
  type SourceAdapterCaptureInvocation,
  type SourceAdapterInterpretationResult,
  type SourceAdapterOperation,
  type SourceAdapterOperationResult,
  type SourceAdapterPageInterpretationResult,
  type SourceAdapterRequestTerminalizationInput,
  type SourceTestInterpretationContext,
  type SourceTestValue,
  type SuccessfulSourceAdapterRequest,
  type UnboundSourceAdapterRequestResult,
} from "./source-adapter.ts";
import {
  SourceRequestLeaseAuthority,
  type PageReadRequestPins,
  type SourceRequestLease,
} from "./source-request-lease.ts";

export interface AuthenticPageOperationFixture {
  readonly manifest: SourceAdapterManifestV1;
  readonly pins: PageReadRequestPins;
  readonly requestedCursor: OpaqueCursorEnvelope;
  readonly connectionConfiguration?: Readonly<Record<string, unknown>>;
  readonly sourceConfiguration?: Readonly<Record<string, unknown>>;
}

export interface StaticCapturedPageFixture {
  readonly rawResponse: Uint8Array;
  readonly protectedNativeEvidence: CapturedSourcePageV1["protectedNativeEvidence"];
  readonly normalizedPage: VersionedNormalizedProviderObservationPage;
}

export class StaticCapturedPageSourceAdapter implements SourceAdapter {
  constructor(
    readonly manifest: SourceAdapterManifestV1,
    private readonly fixture: StaticCapturedPageFixture,
  ) {}

  validateConnectionConfiguration(configuration: unknown) {
    return typeof configuration === "object" && configuration !== null
      ? { ok: true as const, value: configuration as Record<string, unknown> }
      : {
          ok: false as const,
          failure: {
            disposition: "connection_action_required" as const,
            code: "profile_configuration_invalid" as const,
          },
        };
  }

  validateSourceConfiguration(_provider: PageReadRequestPins["provider"], configuration: unknown) {
    return typeof configuration === "object" && configuration !== null
      ? { ok: true as const, value: configuration as Record<string, unknown> }
      : {
          ok: false as const,
          failure: {
            disposition: "source_action_required" as const,
            code: "invalid_source_configuration" as const,
          },
        };
  }

  async captureUnboundRequest(
    operation: SourceAdapterOperation,
    invocation: SourceAdapterCaptureInvocation,
  ): Promise<UnboundSourceAdapterRequestResult> {
    invocation.consume(operation);
    const protectedRawResponse = new Uint8Array(this.fixture.rawResponse);
    return {
      ok: true,
      value: {
        captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
        protectedRawResponse,
        protectedRawResponseSha256: createHash("sha256")
          .update(protectedRawResponse)
          .digest("hex"),
      },
      measurements: {
        durationMilliseconds:
          this.fixture.normalizedPage.measurements.durationMilliseconds,
        responseBytes: protectedRawResponse.byteLength,
      },
      diagnostics: [],
    };
  }

  async interpretConnectionTest(
    _context: ConnectionTestInterpretationContext,
    _request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<ConnectionTestValue>> {
    void _context;
    void _request;
    return { ok: true, value: { status: "reachable" }, recordCount: 0, diagnostics: [] };
  }

  async interpretSourceTest(
    context: SourceTestInterpretationContext,
    _request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterInterpretationResult<SourceTestValue>> {
    void _request;
    return {
      ok: true,
      value: { status: "readable", provider: context.provider },
      recordCount: this.fixture.normalizedPage.outcomes.length,
      diagnostics: [],
    };
  }

  async interpretPage(
    _context: PageReadInterpretationContext,
    _request: SuccessfulSourceAdapterRequest,
  ): Promise<SourceAdapterPageInterpretationResult> {
    void _context;
    void _request;
    const { diagnostics, measurements, ...normalizedPage } =
      this.fixture.normalizedPage;
    void measurements;
    return {
      ok: true,
      value: {
        protectedNativeEvidence: this.fixture.protectedNativeEvidence,
        normalizedPage,
      },
      diagnostics,
    };
  }

  cancelRequest(lease: SourceRequestLease): void {
    lease.cancel();
  }
}

function acknowledgeTerminalization(
  input: SourceAdapterRequestTerminalizationInput,
) {
  return Promise.resolve(Object.freeze({
    requestAttemptId: input.requestAttemptId,
    requestLeaseId: input.requestLeaseId,
    operationScope: input.operationScope,
  }));
}

/** Runs the real operation lease, capture, terminalization, interpretation and completion path. */
export async function completeAuthenticPageReadForTest(
  fixture: AuthenticPageOperationFixture,
  adapter: SourceAdapter,
): Promise<SourceAdapterOperationResult<CapturedSourcePageV1>> {
  const coordinator = new ConnectionPermitCoordinator();
  coordinator.configureProfile({
    organizationId: fixture.pins.organizationId,
    connectionProfileId: fixture.pins.connectionProfileId,
    approvedAggregateRequestCap: 1,
  });
  const authority = new SourceRequestLeaseAuthority(coordinator);
  const requestLease = await authority.admit({
    pins: fixture.pins,
    requestedCursor: fixture.requestedCursor,
    guard: () => true,
  });
  const supportedProvider = fixture.manifest.supportedProviders.find(
    ({ provider }) => provider === fixture.pins.provider,
  );
  if (!supportedProvider) throw new Error("test_fixture.provider_not_supported");
  const operation = createPageReadOperation({
    organizationId: fixture.pins.organizationId,
    sourceTypeKey: fixture.pins.sourceTypeKey,
    adapterVersion: fixture.pins.adapterVersion,
    connectionProfileId: fixture.pins.connectionProfileId,
    connectionProfileRevisionId: fixture.pins.connectionProfileRevisionId,
    connectionConfiguration: fixture.connectionConfiguration ?? {},
    requestLease,
    bounds: fixture.manifest.requestBounds,
    operationKind: "page_read",
    provider: fixture.pins.provider,
    sourceInstanceId: fixture.pins.sourceInstanceId,
    sourceRevisionId: fixture.pins.sourceRevisionId,
    normalizedContractVersion: fixture.pins.normalizedContractVersion,
    identityNamespaceKey: fixture.pins.identityNamespaceKey,
    recordIdScopes: supportedProvider.recordIdScopes.length > 0
      ? supportedProvider.recordIdScopes
      : launchRecordIdScopeDeclarations,
    sourceConfiguration: fixture.sourceConfiguration ?? {},
    correlation: {
      singletonFencingEpoch: fixture.pins.singletonFencingEpoch,
      connectionHealthGeneration: fixture.pins.connectionHealthGeneration,
      importRunId: fixture.pins.importRunId,
      runClaimLeaseId: fixture.pins.runClaimLeaseId,
      pageAttemptId: fixture.pins.pageAttemptId,
      pageNumber: fixture.pins.pageNumber,
      cursorGeneration: fixture.pins.cursorGeneration,
      requestedCursorFingerprint:
        fixture.pins.requestedCursorFingerprint,
      requestedCursor: fixture.requestedCursor,
      pageLimit: fixture.pins.pageLimit,
    },
  });
  try {
    const request = await captureAndTerminalizeSourceAdapterRequest(
      authority,
      adapter,
      operation,
      acknowledgeTerminalization,
    );
    if (!request.ok) throw new Error("test_fixture.capture_failed");
    const interpretation = await interpretSourceAdapterPage(
      adapter,
      operation,
      request,
    );
    return completeSourceAdapterPageRead(
      operation,
      sourceAdapterInterpretationContextOf(operation),
      request,
      interpretation,
    );
  } finally {
    requestLease.close();
  }
}
