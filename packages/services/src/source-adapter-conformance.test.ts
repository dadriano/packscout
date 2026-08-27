import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestIdentityNamespaceByProvider,
  dataforrestEventsV1SourceAdapterManifest,
  launchRecordIdScopeDeclarations,
} from "@packscout/contracts";
import { dataforestEventsV1EvidenceFixture } from "@packscout/contracts/test-fixtures/dataforrest-events-v1";
import { ConnectionPermitCoordinator } from "./connection-permit-coordinator.ts";
import { DataforrestEventsSourceAdapter } from "./dataforrest-events-source-adapter.ts";
import {
  AlternateBookmarkSourceAdapter,
  alternateBookmarkSourceManifest as alternateManifest,
  defaultAlternateBookmarkWrapper as alternateWrapper,
} from "./alternate-bookmark-source-adapter.test-support.ts";
import {
  SourceAdapterContractError,
  captureAndTerminalizeSourceAdapterRequest,
  completeSourceAdapterPageRead,
  createConnectionTestOperation,
  createPageReadOperation,
  createSourceTestOperation,
  interpretSourceAdapterConnectionTest,
  interpretSourceAdapterPage,
  interpretSourceAdapterSourceTest,
  sourceAdapterInterpretationContextOf,
  type SourceAdapter,
  type SourceAdapterOperation,
  type SourceAdapterRequestTerminalizationInput,
} from "./source-adapter.ts";
import { assertSourceAdapterConformance } from "./source-adapter-conformance.test-support.ts";
import {
  SourceRequestLeaseAuthority,
  SourceRequestLeaseError,
  type ConnectionTestRequestPins,
  type PageReadRequestPins,
  type SourceTestRequestPins,
} from "./source-request-lease.ts";

interface OperationBuilderInput {
  readonly sourceTypeKey: string;
  readonly adapterVersion: string;
  readonly cursorCodecKey: string;
  readonly connectionConfiguration: Readonly<Record<string, unknown>>;
  readonly sourceConfiguration: Readonly<Record<string, unknown>>;
}

function operationBuilders(input: OperationBuilderInput) {
  const coordinator = new ConnectionPermitCoordinator();
  const providerId = "provider-conformance";
  coordinator.configureRequestPermitLane({
    organizationId: "organization-conformance",
    connectionProfileId: "profile-conformance",
    scope: "connection_test",
    providerId: null,
    approvedRequestCap: 2,
  });
  coordinator.configureRequestPermitLane({
    organizationId: "organization-conformance",
    connectionProfileId: "profile-conformance",
    scope: "platform",
    providerId,
    approvedRequestCap: 2,
  });
  const authority = new SourceRequestLeaseAuthority(coordinator);
  const commonPins = {
    organizationId: "organization-conformance",
    sourceTypeKey: input.sourceTypeKey,
    adapterVersion: input.adapterVersion,
    singletonFencingEpoch: 1,
    connectionProfileId: "profile-conformance",
    connectionProfileRevisionId: "profile-revision-conformance",
    connectionHealthGeneration: 1,
  } as const;
  const commonOperation = {
    organizationId: commonPins.organizationId,
    sourceTypeKey: commonPins.sourceTypeKey,
    adapterVersion: commonPins.adapterVersion,
    connectionProfileId: commonPins.connectionProfileId,
    connectionProfileRevisionId: commonPins.connectionProfileRevisionId,
    connectionConfiguration: input.connectionConfiguration,
    bounds: {
      pageLimit: 250,
      maximumResponseBytes: 2_097_152,
      timeoutMilliseconds: 10_000,
    },
  } as const;
  const sourcePins = {
    provider: "courtyard" as const,
    providerId,
    sourceInstanceId: "source-conformance",
    sourceRevisionId: "source-revision-conformance",
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: dataforrestIdentityNamespaceByProvider.courtyard,
  } as const;
  let requestIdentitySequence = 0;
  const nextRequestIdentity = (kind: string) => {
    requestIdentitySequence += 1;
    return {
      requestAttemptId:
        `request-attempt-${kind}-${requestIdentitySequence}`,
      requestLeaseId: `request-lease-${kind}-${requestIdentitySequence}`,
    } as const;
  };

  return {
    requestLeaseAuthority: authority,
    async buildConnectionOperation() {
      const pins: ConnectionTestRequestPins = {
        ...commonPins,
        ...nextRequestIdentity("connection"),
        operationKind: "connection_test",
        connectionTestJobId: "connection-test-conformance",
        jobClaimLeaseId: "job-lease-conformance",
        recoveryEpisodeId: null,
      };
      const requestLease = await authority.admit({ pins, guard: () => true });
      return createConnectionTestOperation({
        ...commonOperation,
        operationKind: "connection_test",
        requestLease,
        correlation: {
          singletonFencingEpoch: 1,
          connectionHealthGeneration: 1,
          connectionTestJobId: pins.connectionTestJobId,
          jobClaimLeaseId: pins.jobClaimLeaseId,
          recoveryEpisodeId: null,
        },
      });
    },
    async buildSourceOperation() {
      const pins: SourceTestRequestPins = {
        ...commonPins,
        ...sourcePins,
        ...nextRequestIdentity("source"),
        operationKind: "source_test",
        sourceTestJobId: "source-test-conformance",
        jobClaimLeaseId: "job-lease-conformance",
      };
      const requestLease = await authority.admit({ pins, guard: () => true });
      return createSourceTestOperation({
        ...commonOperation,
        ...sourcePins,
        operationKind: "source_test",
        sourceConfiguration: input.sourceConfiguration,
        recordIdScopes: launchRecordIdScopeDeclarations,
        requestLease,
        correlation: {
          singletonFencingEpoch: 1,
          connectionHealthGeneration: 1,
          sourceTestJobId: pins.sourceTestJobId,
          jobClaimLeaseId: pins.jobClaimLeaseId,
        },
      });
    },
    async buildPageOperation(cursorValue: string | null = null) {
      const requestedCursor = {
        sourceInstanceId: sourcePins.sourceInstanceId,
        sourceRevisionId: sourcePins.sourceRevisionId,
        sourceTypeKey: input.sourceTypeKey,
        adapterVersion: input.adapterVersion,
        cursorCodecKey: input.cursorCodecKey,
        cursorGeneration: 1,
        value: cursorValue,
      } as const;
      const pins: PageReadRequestPins = {
        ...commonPins,
        ...sourcePins,
        ...nextRequestIdentity("page"),
        operationKind: "page_read",
        importRunId: "run-conformance",
        runClaimLeaseId: "run-lease-conformance",
        pageAttemptId: `page-conformance-${cursorValue ?? "initial"}`,
        pageNumber: 1,
        pageLimit: 250,
        cursorGeneration: 1,
        requestedCursorFingerprint: cursorValue === null
          ? null
          : createHash("sha256").update(cursorValue).digest("hex"),
      };
      const requestLease = await authority.admit({
        pins,
        requestedCursor,
        guard: () => true,
      });
      return createPageReadOperation({
        ...commonOperation,
        ...sourcePins,
        operationKind: "page_read",
        sourceConfiguration: input.sourceConfiguration,
        recordIdScopes: launchRecordIdScopeDeclarations,
        requestLease,
        correlation: {
          singletonFencingEpoch: 1,
          connectionHealthGeneration: 1,
          importRunId: pins.importRunId,
          runClaimLeaseId: pins.runClaimLeaseId,
          pageAttemptId: pins.pageAttemptId,
          pageNumber: pins.pageNumber,
          cursorGeneration: 1,
          requestedCursorFingerprint: pins.requestedCursorFingerprint,
          requestedCursor,
          pageLimit: 250,
        },
      });
    },
  };
}

function alternateOperationBuilders() {
  return operationBuilders({
    sourceTypeKey: alternateManifest.sourceTypeKey,
    adapterVersion: alternateManifest.adapterVersion,
    cursorCodecKey: alternateManifest.cursorCodecKey,
    connectionConfiguration: { channel: "fixture" },
    sourceConfiguration: { partition: "courtyard" },
  });
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

function captureRequest(
  requestLeaseAuthority: SourceRequestLeaseAuthority,
  adapter: SourceAdapter,
  operation: SourceAdapterOperation,
) {
  return captureAndTerminalizeSourceAdapterRequest(
    requestLeaseAuthority,
    adapter,
    operation,
    acknowledgeTerminalization,
  );
}

function nestedObjectKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(nestedObjectKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...nestedObjectKeys(nested),
  ]);
}

test("DataForrest and an alternate wrapper satisfy one transport-neutral adapter harness", async () => {
  const dataforrestBuilders = operationBuilders({
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    cursorCodecKey: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    connectionConfiguration: {
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerToken: "conformance-secret",
    },
    sourceConfiguration: { platform: "courtyard" },
  });
  const dataforrest = new DataforrestEventsSourceAdapter({
    resolveHost: async () => ["198.204.245.26"],
    httpClient: async () => new Response(JSON.stringify(
      dataforestEventsV1EvidenceFixture.courtyard.initial,
    )),
  }, dataforrestEventsV1SourceAdapterManifest);
  const dataforrestResult = await assertSourceAdapterConformance({
    adapter: dataforrest,
    provider: "courtyard",
    validConnectionConfiguration: {
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerToken: "conformance-secret",
    },
    validSourceConfiguration: { platform: "courtyard" },
    expectedCursorValue:
      dataforestEventsV1EvidenceFixture.courtyard.initial.next_cursor,
    ...dataforrestBuilders,
  });

  const alternateBuilders = alternateOperationBuilders();
  const alternateResult = await assertSourceAdapterConformance({
    adapter: new AlternateBookmarkSourceAdapter(),
    provider: "courtyard",
    validConnectionConfiguration: { channel: "fixture" },
    validSourceConfiguration: { partition: "courtyard" },
    expectedCursorValue: alternateWrapper.continuation.bookmark,
    ...alternateBuilders,
  });
  assert.equal(dataforrestResult.page.ok, true);
  assert.equal(alternateResult.page.ok, true);
  if (dataforrestResult.page.ok && alternateResult.page.ok) {
    for (const normalizedPage of [
      dataforrestResult.page.value.normalizedPage,
      alternateResult.page.value.normalizedPage,
    ]) {
      const keys = nestedObjectKeys(normalizedPage);
      assert.equal(keys.includes("next_cursor"), false);
      assert.equal(keys.includes("poll_after_seconds"), false);
      assert.equal(keys.includes("bookmark"), false);
      assert.equal(keys.includes("signal"), false);
      assert.equal(normalizedPage.provider, "courtyard");
    }
    assert.equal(
      alternateResult.page.value.normalizedPage.nextCursor.value,
      "alternate-bookmark-001",
    );
    assert.deepEqual(
      alternateResult.page.value.normalizedPage.continuation,
      { kind: "poll_after", minimumDelaySeconds: 60 },
    );
  }
});

test("alternate adapter rejects malformed wrapper and cursor grammar with stable diagnostics", async () => {
  const protectedMarker = "alternate-secret-must-not-cross";
  const malformedPayloads = [
    { ...alternateWrapper, protectedMarker },
    {
      ...alternateWrapper,
      continuation: {
        ...alternateWrapper.continuation,
        bookmark: "wrong-bookmark",
      },
    },
    {
      ...alternateWrapper,
      continuation: {
        ...alternateWrapper.continuation,
        signal: "advance",
      },
    },
    {
      ...alternateWrapper,
      continuation: {
        ...alternateWrapper.continuation,
        delaySeconds: 30,
      },
    },
  ];
  for (const payload of malformedPayloads) {
    const adapter = new AlternateBookmarkSourceAdapter(payload);

    const connectionBuilders = alternateOperationBuilders();
    const connection = await connectionBuilders.buildConnectionOperation();
    const connectionRequest = await captureRequest(
      connectionBuilders.requestLeaseAuthority,
      adapter,
      connection,
    );
    assert.equal(connectionRequest.ok, true);
    if (!connectionRequest.ok) assert.fail("alternate capture failed");
    const connectionResult = await interpretSourceAdapterConnectionTest(
      adapter,
      connection,
      connectionRequest,
    );
    assert.equal(connectionResult.ok, false);
    if (!connectionResult.ok) {
      assert.deepEqual(connectionResult.failure, {
        disposition: "connection_action_required",
        code: "profile_configuration_invalid",
      });
    }
    assert.equal(
      JSON.stringify(connectionResult.diagnostics).includes(protectedMarker),
      false,
    );
    connection.requestLease.close();

    const sourceBuilders = alternateOperationBuilders();
    const source = await sourceBuilders.buildSourceOperation();
    const sourceRequest = await captureRequest(
      sourceBuilders.requestLeaseAuthority,
      adapter,
      source,
    );
    assert.equal(sourceRequest.ok, true);
    if (!sourceRequest.ok) assert.fail("alternate capture failed");
    const sourceResult = await interpretSourceAdapterSourceTest(
      adapter,
      source,
      sourceRequest,
    );
    assert.equal(sourceResult.ok, false);
    if (!sourceResult.ok) {
      assert.deepEqual(sourceResult.failure, {
        disposition: "source_action_required",
        code: "invalid_response",
      });
    }
    assert.equal(
      JSON.stringify(sourceResult.diagnostics).includes(protectedMarker),
      false,
    );
    source.requestLease.close();

    const builders = alternateOperationBuilders();
    const page = await builders.buildPageOperation();
    const request = await captureRequest(
      builders.requestLeaseAuthority,
      adapter,
      page,
    );
    assert.equal(request.ok, true);
    if (!request.ok) assert.fail("alternate capture failed");
    const result = await interpretSourceAdapterPage(
      adapter,
      page,
      request,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.failure, {
        disposition: "source_action_required",
        code: "invalid_response",
      });
    }
    assert.equal(JSON.stringify(result.diagnostics).includes(protectedMarker), false);
    page.requestLease.close();
  }

  const adapter = new AlternateBookmarkSourceAdapter();
  const builders = alternateOperationBuilders();
  const page = await builders.buildPageOperation("foreign-cursor");
  const request = await captureRequest(
    builders.requestLeaseAuthority,
    adapter,
    page,
  );
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("alternate capture failed");
  const result = await interpretSourceAdapterPage(
    adapter,
    page,
    request,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.code, "invalid_cursor");
  page.requestLease.close();
});

test("alternate adapter fails closed for cancelled, reused, and mismatched leases", async () => {
  const adapter = new AlternateBookmarkSourceAdapter();
  const builders = alternateOperationBuilders();

  const cancelled = await builders.buildPageOperation();
  adapter.cancelRequest(cancelled.requestLease);
  await assert.rejects(
    captureRequest(builders.requestLeaseAuthority, adapter, cancelled),
    (error) =>
      error instanceof SourceRequestLeaseError && error.code === "cancelled",
  );
  assert.equal(adapter.captureCount, 0);

  const once = await builders.buildPageOperation();
  const first = await captureRequest(
    builders.requestLeaseAuthority,
    adapter,
    once,
  );
  assert.equal(first.ok, true);
  await assert.rejects(
    captureRequest(builders.requestLeaseAuthority, adapter, once),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "already_consumed",
  );
  assert.equal(adapter.captureCount, 1);
  once.requestLease.close();

  const original = await builders.buildPageOperation();
  const { abortSignal: _abortSignal, ...operationInput } = original;
  void _abortSignal;
  const mismatched = createPageReadOperation({
    ...operationInput,
    sourceRevisionId: "foreign-revision",
    correlation: {
      ...original.correlation,
      requestedCursor: {
        ...original.correlation.requestedCursor,
        sourceRevisionId: "foreign-revision",
      },
    },
  });
  await assert.rejects(
    captureRequest(builders.requestLeaseAuthority, adapter, mismatched),
    (error) =>
      error instanceof SourceRequestLeaseError && error.code === "pin_mismatch",
  );
  assert.equal(adapter.captureCount, 1);
  original.requestLease.close();
});

test("generic conformance rejects an alternate adapter capture above operation bounds before terminalization", async () => {
  const adapter = new AlternateBookmarkSourceAdapter({
    ...alternateWrapper,
    padding: "x".repeat(alternateManifest.requestBounds.maximumResponseBytes),
  });
  const builders = alternateOperationBuilders();
  const page = await builders.buildPageOperation();
  let terminalizerCalled = false;
  await assert.rejects(
    captureAndTerminalizeSourceAdapterRequest(
      builders.requestLeaseAuthority,
      adapter,
      page,
      (input) => {
        terminalizerCalled = true;
        return acknowledgeTerminalization(input);
      },
    ),
    (error) =>
      error instanceof SourceAdapterContractError &&
      error.code === "invalid_request_capture",
  );
  assert.equal(adapter.captureCount, 1);
  assert.equal(terminalizerCalled, false);
  assert.equal(page.requestLease.state, "consumed");
  assert.equal(page.requestLease.requestPermitHeld, true);
  assert.equal(page.requestLease.executionSlotHeld, true);
  assert.throws(
    () => page.requestLease.releaseExecutionSlot(),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_required",
  );
});

test("alternate results cannot cross operation-bound completion", async () => {
  const adapter = new AlternateBookmarkSourceAdapter();
  const builders = alternateOperationBuilders();
  const page = await builders.buildPageOperation();
  const request = await captureRequest(
    builders.requestLeaseAuthority,
    adapter,
    page,
  );
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("alternate capture failed");
  const context = sourceAdapterInterpretationContextOf(page);
  const interpretation = await interpretSourceAdapterPage(
    adapter,
    page,
    request,
  );
  assert.equal(interpretation.ok, true);
  if (!interpretation.ok) assert.fail("alternate interpretation failed");
  assert.equal(
    completeSourceAdapterPageRead(page, context, request, interpretation).ok,
    true,
  );

  const adversarial = [
    {
      ...interpretation,
      protectedCredential: "must-not-cross",
    },
    {
      ...interpretation,
      value: {
        ...interpretation.value,
        normalizedPage: {
          ...interpretation.value.normalizedPage,
          provider: "phygitals",
        },
      },
    },
    {
      ...interpretation,
      value: {
        ...interpretation.value,
        normalizedPage: {
          ...interpretation.value.normalizedPage,
          nextCursor: {
            ...interpretation.value.normalizedPage.nextCursor,
            cursorCodecKey: "foreign-codec",
          },
        },
      },
    },
  ];
  for (const result of adversarial) {
    assert.throws(
      () => completeSourceAdapterPageRead(
        page,
        context,
        request,
        result as never,
      ),
      /source_adapter_contract\.invalid_interpretation_shape/u,
    );
  }
  page.requestLease.close();
});

test("generic conformance support contains no provider transport vocabulary", async () => {
  const source = await readFile(
    new URL("source-adapter-conformance.test-support.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    /dataforrest|next_cursor|poll_after_seconds|bookmark|has_more/iu.test(source),
    false,
  );
});
