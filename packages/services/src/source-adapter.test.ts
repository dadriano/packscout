import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ConnectionPermitCoordinator } from "./connection-permit-coordinator.ts";
import {
  SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
  SourceAdapterContractError,
  captureAndTerminalizeSourceAdapterRequest,
  completeSourceAdapterConnectionTest,
  completeSourceAdapterPageRead,
  completeSourceAdapterRequestFailure,
  completeSourceAdapterSourceTest,
  consumeSourceAdapterRequestLease,
  createConnectionTestOperation,
  createPageReadOperation,
  createSourceTestOperation,
  sourceAdapterInterpretationContextOf,
  sourceAdapterOperationScopeOf,
  type SourceAdapter,
  type SourceAdapterOperation,
  type SourceAdapterRequestTerminalizationInput,
  type UnboundSourceAdapterRequestResult,
  type PageReadOperation,
} from "./source-adapter.ts";
import {
  SourceRequestLeaseError,
  SourceRequestLeaseAuthority,
  type ConnectionTestRequestPins,
  type PageReadRequestPins,
  type SourceTestRequestPins,
} from "./source-request-lease.ts";

const commonPins = {
  organizationId: "organization-1",
  sourceTypeKey: "fixture-source-v1",
  adapterVersion: "fixture-adapter-v1",
  singletonFencingEpoch: 7,
  connectionProfileId: "profile-1",
  connectionProfileRevisionId: "profile-revision-1",
  connectionHealthGeneration: 3,
} as const;

const bounds = Object.freeze({
  pageLimit: 250,
  maximumResponseBytes: 2_097_152,
  timeoutMilliseconds: 10_000,
});
let fixtureRequestIdentitySequence = 0;

function nextFixtureRequestIdentity(kind: string) {
  fixtureRequestIdentitySequence += 1;
  return {
    requestAttemptId:
      `request-attempt-${kind}-${fixtureRequestIdentitySequence}`,
    requestLeaseId: `request-lease-${kind}-${fixtureRequestIdentitySequence}`,
  } as const;
}

const requestLeaseAuthorityByOperation = new WeakMap<
  SourceAdapterOperation,
  SourceRequestLeaseAuthority
>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function successfulRequestFixture() {
  const protectedRawResponse = new TextEncoder().encode("{}");
  return {
    ok: true as const,
    value: {
      captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
      protectedRawResponse,
      protectedRawResponseSha256: sha256(protectedRawResponse),
    },
    measurements: {
      durationMilliseconds: 1,
      responseBytes: protectedRawResponse.byteLength,
    },
    diagnostics: [],
  };
}

const connectionPins: ConnectionTestRequestPins = {
  ...commonPins,
  requestAttemptId: "request-attempt-connection-1",
  requestLeaseId: "request-lease-connection-1",
  operationKind: "connection_test",
  connectionTestJobId: "connection-job-1",
  jobClaimLeaseId: "job-lease-1",
  recoveryEpisodeId: null,
};

const sourcePins: SourceTestRequestPins = {
  ...commonPins,
  requestAttemptId: "request-attempt-source-1",
  requestLeaseId: "request-lease-source-1",
  operationKind: "source_test",
  provider: "courtyard",
  sourceInstanceId: "source-1",
  sourceRevisionId: "source-revision-1",
  normalizedContractVersion: "packscout.provider-observation.v1",
  identityNamespaceKey: "dataforrest-courtyard-records-v1",
  sourceTestJobId: "source-job-1",
  jobClaimLeaseId: "job-lease-1",
};

const requestedCheckpoint = {
  sourceInstanceId: "source-1",
  sourceRevisionId: "source-revision-1",
  sourceTypeKey: "fixture-source-v1",
  adapterVersion: "fixture-adapter-v1",
  checkpointCodecKey: "fixture-codec-v1",
  checkpointGeneration: 1,
  value: null,
} as const;

const pagePins: PageReadRequestPins = {
  ...commonPins,
  requestAttemptId: "request-attempt-page-1",
  requestLeaseId: "request-lease-page-1",
  operationKind: "page_read",
  provider: "courtyard",
  sourceInstanceId: "source-1",
  sourceRevisionId: "source-revision-1",
  normalizedContractVersion: "packscout.provider-observation.v1",
  identityNamespaceKey: "dataforrest-courtyard-records-v1",
  importRunId: "run-1",
  runClaimLeaseId: "run-lease-1",
  pageAttemptId: "page-1",
  pageNumber: 1,
  pageLimit: 250,
  checkpointGeneration: 1,
  requestedCheckpointFingerprint: null,
};

function leaseAuthority(): Readonly<{
  coordinator: ConnectionPermitCoordinator;
  authority: SourceRequestLeaseAuthority;
}> {
  const coordinator = new ConnectionPermitCoordinator();
  coordinator.configureProfile({
    organizationId: commonPins.organizationId,
    connectionProfileId: commonPins.connectionProfileId,
    approvedAggregateRequestCap: 2,
  });
  return {
    coordinator,
    authority: new SourceRequestLeaseAuthority(coordinator),
  };
}

async function connectionFixture() {
  const { authority, coordinator } = leaseAuthority();
  const pins = {
    ...connectionPins,
    ...nextFixtureRequestIdentity("connection"),
  } satisfies ConnectionTestRequestPins;
  const requestLease = await authority.admit({
    pins,
    guard: () => true,
  });
  const operation = createConnectionTestOperation({
    organizationId: commonPins.organizationId,
    sourceTypeKey: commonPins.sourceTypeKey,
    adapterVersion: commonPins.adapterVersion,
    connectionProfileId: commonPins.connectionProfileId,
    connectionProfileRevisionId: commonPins.connectionProfileRevisionId,
    connectionConfiguration: Object.freeze({ protectedCredential: "fixture" }),
    requestLease,
    bounds,
    operationKind: "connection_test",
    correlation: {
      singletonFencingEpoch: commonPins.singletonFencingEpoch,
      connectionHealthGeneration: commonPins.connectionHealthGeneration,
      connectionTestJobId: pins.connectionTestJobId,
      jobClaimLeaseId: pins.jobClaimLeaseId,
      recoveryEpisodeId: pins.recoveryEpisodeId,
    },
  });
  requestLeaseAuthorityByOperation.set(operation, authority);
  return { coordinator, operation, requestLease } as const;
}

async function connectionOperationForAuthority(
  authority: SourceRequestLeaseAuthority,
  suffix: string,
) {
  const pins: ConnectionTestRequestPins = {
    ...commonPins,
    requestAttemptId: `request-attempt-${suffix}`,
    requestLeaseId: `request-lease-${suffix}`,
    operationKind: "connection_test",
    connectionTestJobId: `connection-job-${suffix}`,
    jobClaimLeaseId: `job-lease-${suffix}`,
    recoveryEpisodeId: null,
  };
  const requestLease = await authority.admit({ pins, guard: () => true });
  const operation = createConnectionTestOperation({
    organizationId: commonPins.organizationId,
    sourceTypeKey: commonPins.sourceTypeKey,
    adapterVersion: commonPins.adapterVersion,
    connectionProfileId: commonPins.connectionProfileId,
    connectionProfileRevisionId: commonPins.connectionProfileRevisionId,
    connectionConfiguration: Object.freeze({ protectedCredential: "fixture" }),
    requestLease,
    bounds,
    operationKind: "connection_test",
    correlation: {
      singletonFencingEpoch: commonPins.singletonFencingEpoch,
      connectionHealthGeneration: commonPins.connectionHealthGeneration,
      connectionTestJobId: pins.connectionTestJobId,
      jobClaimLeaseId: pins.jobClaimLeaseId,
      recoveryEpisodeId: null,
    },
  });
  requestLeaseAuthorityByOperation.set(operation, authority);
  return operation;
}

async function sourceFixture() {
  const { authority, coordinator } = leaseAuthority();
  const pins = {
    ...sourcePins,
    ...nextFixtureRequestIdentity("source"),
  } satisfies SourceTestRequestPins;
  const requestLease = await authority.admit({
    pins,
    guard: () => true,
  });
  const operation = createSourceTestOperation({
    organizationId: commonPins.organizationId,
    sourceTypeKey: commonPins.sourceTypeKey,
    adapterVersion: commonPins.adapterVersion,
    connectionProfileId: commonPins.connectionProfileId,
    connectionProfileRevisionId: commonPins.connectionProfileRevisionId,
    connectionConfiguration: Object.freeze({ protectedCredential: "fixture" }),
    requestLease,
    bounds,
    operationKind: "source_test",
    provider: pins.provider,
    sourceInstanceId: pins.sourceInstanceId,
    sourceRevisionId: pins.sourceRevisionId,
    normalizedContractVersion: pins.normalizedContractVersion,
    identityNamespaceKey: pins.identityNamespaceKey,
    recordIdScopes: [],
    sourceConfiguration: Object.freeze({ filter: "fixture" }),
    correlation: {
      singletonFencingEpoch: commonPins.singletonFencingEpoch,
      connectionHealthGeneration: commonPins.connectionHealthGeneration,
      sourceTestJobId: pins.sourceTestJobId,
      jobClaimLeaseId: pins.jobClaimLeaseId,
    },
  });
  requestLeaseAuthorityByOperation.set(operation, authority);
  return { coordinator, operation, requestLease } as const;
}

async function pageFixture(overrides: Readonly<{
  connectionConfiguration?: Readonly<Record<string, unknown>>;
  sourceConfiguration?: Readonly<Record<string, unknown>>;
  recordIdScopes?: readonly Readonly<{
    recordIdScopeKey: "trade-v1";
    sourceKind: "trade";
    catalogEntity: null;
    canonicalKind: "market_event";
  }>[];
}> = {}) {
  const { authority, coordinator } = leaseAuthority();
  const pins = {
    ...pagePins,
    ...nextFixtureRequestIdentity("page"),
  } satisfies PageReadRequestPins;
  const requestLease = await authority.admit({
    pins,
    requestedCheckpoint,
    guard: () => true,
  });
  const operation = createPageReadOperation({
    organizationId: commonPins.organizationId,
    sourceTypeKey: commonPins.sourceTypeKey,
    adapterVersion: commonPins.adapterVersion,
    connectionProfileId: commonPins.connectionProfileId,
    connectionProfileRevisionId: commonPins.connectionProfileRevisionId,
    connectionConfiguration: overrides.connectionConfiguration ??
      Object.freeze({ protectedCredential: "fixture" }),
    requestLease,
    bounds,
    operationKind: "page_read",
    provider: pins.provider,
    sourceInstanceId: pins.sourceInstanceId,
    sourceRevisionId: pins.sourceRevisionId,
    normalizedContractVersion: pins.normalizedContractVersion,
    identityNamespaceKey: pins.identityNamespaceKey,
    recordIdScopes: overrides.recordIdScopes ?? [],
    sourceConfiguration: overrides.sourceConfiguration ??
      Object.freeze({ filter: "fixture" }),
    correlation: {
      singletonFencingEpoch: commonPins.singletonFencingEpoch,
      connectionHealthGeneration: commonPins.connectionHealthGeneration,
      importRunId: pins.importRunId,
      runClaimLeaseId: pins.runClaimLeaseId,
      pageAttemptId: pins.pageAttemptId,
      pageNumber: pins.pageNumber,
      checkpointGeneration: pins.checkpointGeneration,
      requestedCheckpointFingerprint: pins.requestedCheckpointFingerprint,
      requestedCheckpoint,
      pageLimit: pins.pageLimit,
    },
  });
  requestLeaseAuthorityByOperation.set(operation, authority);
  return { coordinator, operation, requestLease } as const;
}

function isContractError(
  error: unknown,
  code: SourceAdapterContractError["code"],
): boolean {
  return error instanceof SourceAdapterContractError && error.code === code;
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

function requestLeaseAuthorityOf(
  operation: SourceAdapterOperation,
): SourceRequestLeaseAuthority {
  const authority = requestLeaseAuthorityByOperation.get(operation);
  if (authority === undefined) {
    throw new Error("test_fixture.missing_request_lease_authority");
  }
  return authority;
}

async function bindRequest<TRequest extends UnboundSourceAdapterRequestResult>(
  operation: SourceAdapterOperation,
  request: TRequest,
) {
  const adapter = {
    captureUnboundRequest: () => Promise.resolve(request),
  } as unknown as SourceAdapter;
  return captureAndTerminalizeSourceAdapterRequest(
    requestLeaseAuthorityOf(operation),
    adapter,
    operation,
    acknowledgeTerminalization,
  );
}

test("connection-test operation scope contains no provider, source, run, or page correlation", async () => {
  const { operation, requestLease } = await connectionFixture();
  const scope = sourceAdapterOperationScopeOf(operation);
  assert.deepEqual(Object.keys(scope).sort(), [
    "adapterVersion",
    "connectionHealthGeneration",
    "connectionProfileId",
    "connectionProfileRevisionId",
    "connectionTestJobId",
    "jobClaimLeaseId",
    "operationKind",
    "organizationId",
    "recoveryEpisodeId",
    "requestAttemptId",
    "requestLeaseId",
    "singletonFencingEpoch",
    "sourceTypeKey",
  ].sort());
  assert.equal("provider" in scope, false);
  assert.equal("sourceInstanceId" in scope, false);
  assert.equal("mapperKey" in scope, false);
  requestLease.close();
});

test("page-read scope retains exact durable pins but no configuration or mapper metadata", async () => {
  const { operation, requestLease } = await pageFixture();
  const scope = sourceAdapterOperationScopeOf(operation);
  assert.equal(scope.operationKind, "page_read");
  assert.equal("sourceConfiguration" in scope, false);
  assert.equal("connectionConfiguration" in scope, false);
  assert.equal("requestLease" in scope, false);
  assert.equal("mapperKey" in scope, false);
  assert.equal(scope.normalizedContractVersion, "packscout.provider-observation.v1");
  assert.equal(scope.pageLimit, 250);
  requestLease.close();
});

test("generic orchestration attaches the only accepted result and diagnostic scope", async () => {
  const { operation, requestLease } = await connectionFixture();
  const bytes = new Uint8Array([123, 125]);
  const request = await bindRequest(operation, {
    ok: true,
    value: {
      captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
      protectedRawResponse: bytes,
      protectedRawResponseSha256: sha256(bytes),
    },
    measurements: { durationMilliseconds: 12, responseBytes: 2 },
    diagnostics: [],
  });
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("expected successful request capture");
  const adapterOwnedValue: { status: "reachable"; protectedMarker?: string } = {
    status: "reachable",
  };
  const result = completeSourceAdapterConnectionTest(
    operation,
    sourceAdapterInterpretationContextOf(operation),
    request,
    {
    ok: true,
    value: adapterOwnedValue,
    recordCount: 0,
    diagnostics: [{
      severity: "info",
      phase: "connection_probe",
      code: "connection_reachable",
    }],
    },
  );
  const expectedScope = sourceAdapterOperationScopeOf(operation);
  assert.deepEqual(result.operationScope, expectedScope);
  assert.deepEqual(result.diagnostics[0]?.operationScope, expectedScope);
  assert.equal("operationScope" in result.diagnostics[0]!.diagnostic, false);
  assert.equal(Object.isFrozen(result.operationScope), true);
  (adapterOwnedValue as { status: string }).status = "mutated";
  adapterOwnedValue.protectedMarker = "mutated-after-completion";
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected successful connection completion");
  assert.deepEqual(result.value, { status: "reachable" });
  assert.equal(Object.isFrozen(result.value), true);
  requestLease.close();
});

test("runtime operation validation rejects fabricated fields before lease consumption", async () => {
  const connection = await connectionFixture();
  const source = await sourceFixture();
  const page = await pageFixture();
  const invalidOperations = [
    { ...connection.operation, sourceInstanceId: "fabricated-source" },
    {
      ...source.operation,
      correlation: {
        ...source.operation.correlation,
        pageAttemptId: "fabricated-page",
      },
    },
    { ...page.operation, mapperKey: "fabricated-mapper" },
  ];
  for (const operation of invalidOperations) {
    assert.throws(
      () => sourceAdapterOperationScopeOf(operation as PageReadOperation),
      (error) => isContractError(error, "invalid_operation_shape"),
    );
  }
  assert.equal(connection.requestLease.state, "available");
  assert.equal(source.requestLease.state, "available");
  assert.equal(page.requestLease.state, "available");
  connection.requestLease.close();
  source.requestLease.close();
  page.requestLease.close();
});

test("the request lease signal is the single authoritative operation signal", async () => {
  const mismatched = await connectionFixture();
  assert.throws(
    () => consumeSourceAdapterRequestLease({
      ...mismatched.operation,
      abortSignal: new AbortController().signal,
    }),
    (error) => isContractError(error, "abort_signal_mismatch"),
  );
  assert.equal(mismatched.requestLease.state, "available");
  mismatched.requestLease.close();

  const matched = await connectionFixture();
  const invocation = consumeSourceAdapterRequestLease(matched.operation);
  assert.equal(invocation.signal, matched.requestLease.signal);
  assert.equal(invocation.signal, matched.operation.abortSignal);
  assert.equal(matched.requestLease.state, "consumed");
  assert.throws(
    () => matched.requestLease.close(),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_required",
  );
});

test("interpretation context is immutable and contains no lease, abort signal, credential, or correlation", async () => {
  const connection = await connectionFixture();
  const page = await pageFixture();
  const connectionContext = sourceAdapterInterpretationContextOf(
    connection.operation,
  );
  const pageContext = sourceAdapterInterpretationContextOf(page.operation);
  for (const context of [connectionContext, pageContext]) {
    assert.equal("requestLease" in context, false);
    assert.equal("abortSignal" in context, false);
    assert.equal("connectionConfiguration" in context, false);
    assert.equal("correlation" in context, false);
    assert.equal(Object.isFrozen(context), true);
  }
  assert.equal("sourceConfiguration" in connectionContext, false);
  assert.deepEqual(pageContext.requestedCheckpoint, requestedCheckpoint);
  assert.deepEqual(pageContext.sourceConfiguration, { filter: "fixture" });
  connection.requestLease.close();
  page.requestLease.close();
});

test("operation construction canonicalizes and deeply freezes pinned adapter inputs", async () => {
  const connectionConfiguration = {
    token: "protected",
    routing: { regions: ["west", "east"] },
  };
  const sourceConfiguration = {
    streams: ["catalog", "trade"],
    options: { enabled: true },
  };
  const recordIdScopes = [{
    recordIdScopeKey: "trade-v1" as const,
    sourceKind: "trade" as const,
    catalogEntity: null,
    canonicalKind: "market_event" as const,
  }];
  const fixture = await pageFixture({
    connectionConfiguration,
    sourceConfiguration,
    recordIdScopes,
  });

  connectionConfiguration.routing.regions[0] = "mutated";
  sourceConfiguration.options.enabled = false;
  recordIdScopes.splice(0, 1);

  assert.deepEqual(fixture.operation.connectionConfiguration, {
    routing: { regions: ["west", "east"] },
    token: "protected",
  });
  assert.deepEqual(fixture.operation.sourceConfiguration, {
    options: { enabled: true },
    streams: ["catalog", "trade"],
  });
  assert.equal(fixture.operation.recordIdScopes.length, 1);
  assert.equal(Object.isFrozen(fixture.operation), true);
  assert.equal(
    Object.isFrozen(
      (fixture.operation.connectionConfiguration.routing as {
        regions: unknown[];
      }).regions,
    ),
    true,
  );
  assert.equal(
    Object.isFrozen(fixture.operation.correlation.requestedCheckpoint),
    true,
  );
  assert.throws(
    () => sourceAdapterOperationScopeOf({ ...fixture.operation }),
    (error) => isContractError(error, "invalid_operation_shape"),
  );
  fixture.requestLease.close();
});

test("capture can terminalize before permit release and interpretation supplies record count afterward", async () => {
  const { coordinator, operation, requestLease } = await sourceFixture();
  const unboundRequest = {
    ok: true as const,
    value: {
      captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
      protectedRawResponse: new Uint8Array([123, 125]),
      protectedRawResponseSha256: sha256(new Uint8Array([123, 125])),
    },
    measurements: {
      durationMilliseconds: 12,
      responseBytes: 2,
    },
    diagnostics: [{
      severity: "info" as const,
      phase: "request_capture",
      code: "response_captured",
    }],
  };
  assert.equal("recordCount" in unboundRequest.measurements, false);
  assert.equal(requestLease.requestPermitHeld, true);
  const request = await captureAndTerminalizeSourceAdapterRequest(
    requestLeaseAuthorityOf(operation),
    {
      captureUnboundRequest: () => Promise.resolve(unboundRequest),
    } as unknown as SourceAdapter,
    operation,
    async (input) => {
      assert.equal(requestLease.requestPermitHeld, true);
      assert.equal(input.requestAttemptId, requestLease.pins.requestAttemptId);
      assert.equal(input.requestLeaseId, requestLease.pins.requestLeaseId);
      assert.equal(input.outcome.ok, true);
      assert.equal("protectedRawResponse" in input.outcome, false);
      if (input.outcome.ok) {
        assert.equal(
          input.outcome.protectedRawResponseSha256,
          unboundRequest.value.protectedRawResponseSha256,
        );
      }
      return acknowledgeTerminalization(input);
    },
  );
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("expected successful request capture");
  assert.equal(requestLease.requestPermitHeld, false);
  assert.equal(requestLease.executionSlotHeld, true);
  assert.equal(coordinator.snapshot().activeExecutionSlots, 1);

  const completed = completeSourceAdapterSourceTest(
    operation,
    sourceAdapterInterpretationContextOf(operation),
    request,
    {
    ok: true,
    value: { status: "readable" as const, provider: "courtyard" as const },
    recordCount: 4,
    diagnostics: [{
      severity: "info",
      phase: "page_interpretation",
      code: "page_valid",
      counters: { records: 4 },
    }],
    },
  );
  assert.deepEqual(completed.measurements, {
    durationMilliseconds: 12,
    responseBytes: 2,
    recordCount: 4,
  });
  assert.deepEqual(
    completed.diagnostics.map(({ diagnostic }) => diagnostic.phase),
    ["request_capture", "page_interpretation"],
  );
  requestLease.releaseExecutionSlot();
  requestLease.close();
});

test("a queued same-profile request cannot wake before durable terminalization succeeds", async () => {
  const coordinator = new ConnectionPermitCoordinator();
  coordinator.configureProfile({
    organizationId: commonPins.organizationId,
    connectionProfileId: commonPins.connectionProfileId,
    approvedAggregateRequestCap: 1,
  });
  const authority = new SourceRequestLeaseAuthority(coordinator);
  const first = await connectionOperationForAuthority(authority, "gate-a");
  let terminalizationStarted!: () => void;
  const terminalizationDidStart = new Promise<void>((resolve) => {
    terminalizationStarted = resolve;
  });
  let allowTerminalization!: () => void;
  const terminalizationCanFinish = new Promise<void>((resolve) => {
    allowTerminalization = resolve;
  });
  const foreignAuthority = new SourceRequestLeaseAuthority(coordinator);
  const adapter = {
    captureUnboundRequest: (adapterOperation: SourceAdapterOperation) => {
      assert.equal("releaseRequestPermit" in adapterOperation.requestLease, false);
      assert.throws(
        () =>
          foreignAuthority.releaseTerminalizedRequestPermit(
            adapterOperation.requestLease,
            {
              requestAttemptId:
                adapterOperation.requestLease.pins.requestAttemptId,
              requestLeaseId: adapterOperation.requestLease.pins.requestLeaseId,
            },
          ),
        (error) =>
          error instanceof SourceRequestLeaseError &&
          error.code === "terminalization_receipt_mismatch",
      );
      assert.equal(adapterOperation.requestLease.requestPermitHeld, true);
      return Promise.resolve(successfulRequestFixture());
    },
  } as unknown as SourceAdapter;
  const firstCapture = captureAndTerminalizeSourceAdapterRequest(
    authority,
    adapter,
    first,
    async (input) => {
      terminalizationStarted();
      await terminalizationCanFinish;
      return acknowledgeTerminalization(input);
    },
  );
  await terminalizationDidStart;

  let secondAdmitted = false;
  const secondAdmission = connectionOperationForAuthority(authority, "gate-b")
    .then((operation) => {
      secondAdmitted = true;
      return operation;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondAdmitted, false);
  assert.equal(first.requestLease.requestPermitHeld, true);
  assert.equal(coordinator.snapshot().profiles[0]?.activeRequestPermits, 1);
  assert.equal(coordinator.snapshot().queuedOperations, 1);

  allowTerminalization();
  const firstRequest = await firstCapture;
  assert.equal(firstRequest.ok, true);
  const second = await secondAdmission;
  assert.equal(secondAdmitted, true);
  assert.equal(second.requestLease.state, "available");
  assert.equal(first.requestLease.requestPermitHeld, false);
  second.requestLease.close();
  first.requestLease.releaseExecutionSlot();
  first.requestLease.close();
});

test("a mismatched durable receipt retains both request ownership resources", async () => {
  const { coordinator, operation, requestLease } = await connectionFixture();
  await assert.rejects(
    captureAndTerminalizeSourceAdapterRequest(
      requestLeaseAuthorityOf(operation),
      {
        captureUnboundRequest: () =>
          Promise.resolve(successfulRequestFixture()),
      } as unknown as SourceAdapter,
      operation,
      async (input) => ({
        requestAttemptId: input.requestAttemptId,
        requestLeaseId: "foreign-request-lease",
        operationScope: input.operationScope,
      }),
    ),
    (error) => isContractError(error, "invalid_terminalization_receipt"),
  );
  assert.equal(requestLease.state, "consumed");
  assert.equal(requestLease.requestPermitHeld, true);
  assert.equal(requestLease.executionSlotHeld, true);
  assert.equal(coordinator.snapshot().profiles[0]?.activeRequestPermits, 1);
  assert.throws(
    () => requestLease.releaseExecutionSlot(),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_required",
  );
  assert.throws(
    () => requestLease.close(),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "terminalization_required",
  );
});

test("a request-boundary failure completes without interpretation or a fabricated record count", async () => {
  const { operation, requestLease } = await connectionFixture();
  const request = await bindRequest(operation, {
    ok: false,
    failure: {
      disposition: "retryable",
      code: "request_timeout",
    },
    measurements: {
      durationMilliseconds: 10_000,
      responseBytes: 0,
    },
    diagnostics: [],
  });
  assert.equal(request.ok, false);
  if (request.ok) assert.fail("expected failed request capture");
  const completed = completeSourceAdapterRequestFailure(operation, request);
  assert.equal(completed.ok, false);
  assert.equal(completed.measurements.recordCount, 0);
  assert.equal(Object.isFrozen(completed), true);
  requestLease.close();
});

test("a failed capture cannot complete a different operation or consume its lease", async () => {
  const capturedFor = await connectionFixture();
  const foreign = await connectionFixture();
  const request = await bindRequest(capturedFor.operation, {
    ok: false,
    failure: { disposition: "retryable", code: "request_timeout" },
    measurements: { durationMilliseconds: 10_000, responseBytes: 0 },
    diagnostics: [],
  });
  assert.equal(request.ok, false);
  if (request.ok) assert.fail("expected failed request capture");
  assert.throws(
    () => completeSourceAdapterRequestFailure(foreign.operation, request),
    (error) => isContractError(error, "invalid_request_capture"),
  );
  assert.equal(foreign.requestLease.state, "available");
  assert.equal(
    completeSourceAdapterRequestFailure(capturedFor.operation, request).ok,
    false,
  );
  foreign.requestLease.close();
  capturedFor.requestLease.close();
});

test("page completion owns capture, record count, measurements, and diagnostics", async () => {
  const { operation, requestLease } = await pageFixture();
  const request = await bindRequest(operation, {
    ok: true as const,
    value: {
      captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
      protectedRawResponse: new Uint8Array([123, 125]),
      protectedRawResponseSha256: sha256(new Uint8Array([123, 125])),
    },
    measurements: {
      durationMilliseconds: 12,
      responseBytes: 2,
    },
    diagnostics: [{
      severity: "info" as const,
      phase: "request_capture",
      code: "response_captured",
    }],
  });
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("expected successful request capture");
  const interpretation = {
    ok: true as const,
    value: {
      protectedNativeEvidence: [{
        reference: "page_record:0",
        value: { id: null },
      }],
      normalizedPage: {
        normalizedContractVersion: "packscout.provider-observation.v1" as const,
        provider: "courtyard" as const,
        outcomes: [{
          status: "invalid" as const,
          recordIndex: 0,
          reasonCode: "missing_identity",
          fieldPaths: ["id"],
          protectedNativeEvidenceRef: "page_record:0",
        }],
        nextCheckpoint: requestedCheckpoint,
        continuation: {
          kind: "poll_after" as const,
          minimumDelaySeconds: 60,
        },
      },
    },
    diagnostics: [{
      severity: "warning" as const,
      phase: "page_interpretation",
      code: "record_invalid",
      counters: { records: 1 },
    }],
  };

  const completed = completeSourceAdapterPageRead(
    operation,
    sourceAdapterInterpretationContextOf(operation),
    request,
    interpretation,
  );
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.value.requestCapture, request.value);
  assert.equal(completed.measurements.recordCount, 1);
  assert.equal(
    completed.measurements,
    completed.value.normalizedPage.measurements,
  );
  assert.deepEqual(
    completed.diagnostics.map(({ diagnostic }) => diagnostic),
    completed.value.normalizedPage.diagnostics,
  );
  completed.diagnostics.forEach(({ diagnostic }, index) => {
    assert.equal(diagnostic, completed.value.normalizedPage.diagnostics[index]);
  });
  assert.deepEqual(
    completed.diagnostics.map(({ diagnostic }) => diagnostic.phase),
    ["request_capture", "page_interpretation"],
  );
  requestLease.close();
});

test("page completion rejects interpretation attempts to inject capture or count", async () => {
  const { operation, requestLease } = await pageFixture();
  const context = sourceAdapterInterpretationContextOf(operation);
  const request = await bindRequest(operation, {
    ok: true as const,
    value: {
      captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
      protectedRawResponse: new Uint8Array([123, 125]),
      protectedRawResponseSha256: sha256(new Uint8Array([123, 125])),
    },
    measurements: { durationMilliseconds: 1, responseBytes: 2 },
    diagnostics: [],
  });
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("expected successful request capture");
  const normalizedPage = {
    normalizedContractVersion: "packscout.provider-observation.v1" as const,
    provider: "courtyard" as const,
    outcomes: [],
    nextCheckpoint: requestedCheckpoint,
    continuation: {
      kind: "poll_after" as const,
      minimumDelaySeconds: 60,
    },
  };
  const invalidInterpretations = [
    {
      ok: true,
      value: {
        protectedNativeEvidence: [],
        normalizedPage,
        requestCapture: request.value,
      },
      diagnostics: [],
    },
    {
      ok: true,
      value: { protectedNativeEvidence: [], normalizedPage },
      recordCount: 999,
      diagnostics: [],
    },
    {
      ok: true,
      value: {
        protectedNativeEvidence: [],
        normalizedPage: { ...normalizedPage, measurements: {
          durationMilliseconds: 0,
          responseBytes: 0,
          recordCount: 999,
        } },
      },
      diagnostics: [],
    },
  ];
  for (const interpretation of invalidInterpretations) {
    assert.throws(
      () => completeSourceAdapterPageRead(
        operation,
        context,
        request,
        interpretation as never,
      ),
      (error) => isContractError(error, "invalid_interpretation_shape"),
    );
  }
  requestLease.close();
});

test("page completion rejects hash mismatch and non-bijective evidence", async () => {
  const { operation, requestLease } = await pageFixture();
  const context = sourceAdapterInterpretationContextOf(operation);
  const bytes = new TextEncoder().encode("{}");
  const request = await bindRequest(operation, {
    ok: true as const,
    value: {
      captureVersion: SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
      protectedRawResponse: bytes,
      protectedRawResponseSha256: sha256(bytes),
    },
    measurements: { durationMilliseconds: 1, responseBytes: bytes.byteLength },
    diagnostics: [],
  });
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("expected successful request capture");
  const outcome = {
    status: "invalid" as const,
    recordIndex: 0,
    reasonCode: "missing_identity",
    fieldPaths: ["record_id"],
    protectedNativeEvidenceRef: "page_record:0",
  };
  const base = {
    ok: true as const,
    value: {
      protectedNativeEvidence: [{
        reference: "page_record:0",
        value: { malformed: true },
      }],
      normalizedPage: {
        normalizedContractVersion: "packscout.provider-observation.v1" as const,
        provider: "courtyard" as const,
        outcomes: [outcome],
        nextCheckpoint: requestedCheckpoint,
        continuation: {
          kind: "poll_after" as const,
          minimumDelaySeconds: 60,
        },
      },
    },
    diagnostics: [],
  };
  assert.throws(
    () => completeSourceAdapterPageRead(
      operation,
      context,
      {
        ...request,
        value: { ...request.value, protectedRawResponseSha256: "a".repeat(64) },
      },
      base,
    ),
    (error) => isContractError(error, "invalid_request_capture"),
  );

  const invalidEvidence = [
    [],
    [
      ...base.value.protectedNativeEvidence,
      { reference: "page_record:0", value: { duplicate: true } },
    ],
    [
      ...base.value.protectedNativeEvidence,
      { reference: "page_record:1", value: { unreferenced: true } },
    ],
  ];
  for (const protectedNativeEvidence of invalidEvidence) {
    assert.throws(
      () => completeSourceAdapterPageRead(operation, context, request, {
        ...base,
        value: { ...base.value, protectedNativeEvidence },
      }),
      (error) => isContractError(error, "invalid_interpretation_shape"),
    );
  }
  requestLease.close();
});

test("operation-bound completion rejects protected test fields and foreign context", async () => {
  const connection = await connectionFixture();
  const source = await sourceFixture();
  const connectionRequest = await bindRequest(
    connection.operation,
    successfulRequestFixture(),
  );
  const sourceRequest = await bindRequest(
    source.operation,
    successfulRequestFixture(),
  );
  assert.equal(connectionRequest.ok, true);
  assert.equal(sourceRequest.ok, true);
  if (!connectionRequest.ok || !sourceRequest.ok) {
    assert.fail("expected successful request captures");
  }
  const invalidConnectionResults = [
    {
      ok: true,
      value: { status: "reachable", protectedCredential: "must-not-cross" },
      recordCount: 0,
      diagnostics: [],
    },
    {
      ok: false,
      failure: {
        disposition: "retryable",
        code: "request_timeout",
      },
      recordCount: 0,
      diagnostics: [],
      protectedRawResponse: "must-not-cross",
    },
  ];
  for (const interpretation of invalidConnectionResults) {
    assert.throws(
      () => completeSourceAdapterConnectionTest(
        connection.operation,
        sourceAdapterInterpretationContextOf(connection.operation),
        connectionRequest,
        interpretation as never,
      ),
      (error) => isContractError(error, "invalid_interpretation_shape"),
    );
  }

  assert.throws(
    () => completeSourceAdapterSourceTest(
      source.operation,
      sourceAdapterInterpretationContextOf(source.operation),
      sourceRequest,
      {
        ok: true,
        value: { status: "readable", provider: "phygitals" },
        recordCount: 1,
        diagnostics: [],
      },
    ),
    (error) => isContractError(error, "invalid_interpretation_shape"),
  );
  const sourceContext = sourceAdapterInterpretationContextOf(source.operation);
  assert.throws(
    () => completeSourceAdapterSourceTest(
      source.operation,
      Object.freeze({
        ...sourceContext,
        provider: "phygitals",
      }) as never,
      sourceRequest,
      {
        ok: true,
        value: { status: "readable", provider: "courtyard" },
        recordCount: 1,
        diagnostics: [],
      },
    ),
    (error) => isContractError(error, "invalid_interpretation_shape"),
  );
  connection.requestLease.close();
  source.requestLease.close();
});

test("page completion rejects a foreign provider or any foreign checkpoint binding", async () => {
  const fixture = await pageFixture();
  const context = sourceAdapterInterpretationContextOf(fixture.operation);
  const request = await bindRequest(
    fixture.operation,
    successfulRequestFixture(),
  );
  assert.equal(request.ok, true);
  if (!request.ok) assert.fail("expected successful request capture");
  const base = {
    ok: true as const,
    value: {
      protectedNativeEvidence: [],
      normalizedPage: {
        normalizedContractVersion: "packscout.provider-observation.v1" as const,
        provider: "courtyard" as const,
        outcomes: [],
        nextCheckpoint: requestedCheckpoint,
        continuation: {
          kind: "poll_after" as const,
          minimumDelaySeconds: 60,
        },
      },
    },
    diagnostics: [],
  };
  const foreignPages = [
    {
      ...base.value.normalizedPage,
      provider: "phygitals" as const,
    },
    ...[
      { sourceInstanceId: "foreign-source" },
      { sourceRevisionId: "foreign-revision" },
      { sourceTypeKey: "foreign-source-type" },
      { adapterVersion: "foreign-adapter" },
      { checkpointCodecKey: "foreign-codec" },
      { checkpointGeneration: 2 },
    ].map((checkpointOverride) => ({
      ...base.value.normalizedPage,
      nextCheckpoint: {
        ...requestedCheckpoint,
        ...checkpointOverride,
      },
    })),
  ];
  for (const normalizedPage of foreignPages) {
    assert.throws(
      () => completeSourceAdapterPageRead(
        fixture.operation,
        context,
        request,
        {
          ...base,
          value: { ...base.value, normalizedPage },
        } as never,
      ),
      (error) => isContractError(error, "invalid_interpretation_shape"),
    );
  }
  fixture.requestLease.close();
});
