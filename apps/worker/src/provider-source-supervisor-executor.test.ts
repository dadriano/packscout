import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestIdentityNamespaceByProvider,
  providerSourceLaunchBounds,
  launchRecordIdScopeDeclarations,
} from "@packscout/contracts";
import {
  ProviderSourceRequestRepository,
  ProviderSourceTestResultRepository,
  type ClaimedConnectionTestWork,
  type ClaimedPageReadWork,
  type ClaimedSourceTestWork,
} from "@packscout/database";
import {
  AesGcmSourceConnectionConfigurationCipher,
  ConnectionPermitCoordinator,
  ControlPlaneRetryExhaustedError,
  ControlPlaneTransactionError,
  DataforrestEventsSourceAdapter,
  RuntimeControlPlaneFence,
  RuntimeLocallyFencedError,
  SourceSupervisorStaleWorkError,
  SourceAdapterRegistry,
  SourceRequestLeaseError,
  SourceRequestLeaseAuthority,
  type UnboundSourceAdapterRequestResult,
  type SourceAdapterCaptureInvocation,
  type SourceAdapter,
  type SourceAdapterOperation,
  type SourceSupervisorExecutionContext,
} from "@packscout/services";
import {
  AlternateBookmarkSourceAdapter,
  alternateBookmarkSourceManifest,
} from "@packscout/services/test-support/alternate-bookmark-source-adapter";
import { ProviderSourceSupervisorWorkExecutor } from
  "./provider-source-supervisor-executor.ts";

const actorKey = new Uint8Array(32).fill(31);
const cipher = new AesGcmSourceConnectionConfigurationCipher({
  primaryVersion: 1,
  keys: new Map([[1, actorKey]]),
});

const epoch = {
  epochId: "65000000-0000-4000-8000-000000000001",
  epochNumber: 7,
  ownerKey: "executor-test-owner",
  leaseToken: "65000000-0000-4000-8000-000000000002",
  leaseExpiresAt: new Date("2026-08-21T12:00:30.000Z"),
};

function encryptedConfiguration() {
  return cipher.encrypt(JSON.stringify({ channel: "fixture" }), {
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    connectionRevisionId: "connection-revision-1",
  });
}

function encryptedDataforrestConfiguration() {
  return cipher.encrypt(JSON.stringify({
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken: "executor-fixture-token",
  }), {
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    connectionRevisionId: "connection-revision-1",
  });
}

function connectionWork(): ClaimedConnectionTestWork {
  return {
    id: "connection-test-1",
    kind: "connection_test",
    queuedAt: new Date("2026-08-21T12:00:00.000Z"),
    organizationId: "organization-1",
    sourceTypeKey: alternateBookmarkSourceManifest.sourceTypeKey,
    sourceAdapterVersion: alternateBookmarkSourceManifest.adapterVersion,
    connectionProfileId: "profile-1",
    connectionRevisionId: "connection-revision-1",
    connectionHealthGeneration: 3n,
    platformRequestLimit: 2,
    connectionConfiguration: encryptedConfiguration(),
    claimOwner: "executor-test-owner",
    claimToken: "65000000-0000-4000-8000-000000000003",
    claimLeaseId: "65000000-0000-4000-8000-000000000004",
    claimExpiresAt: new Date("2026-08-21T12:00:30.000Z"),
    recoveryEpisodeId: null,
  };
}

function sourceWork(recordsPerRequest = 500): ClaimedSourceTestWork {
  const persistedScopes = JSON.parse(JSON.stringify(
    launchRecordIdScopeDeclarations.map(({ recordIdScopeKey }) =>
      recordIdScopeKey
    ),
  )) as string[];
  return {
    ...connectionWork(),
    id: "source-test-1",
    kind: "source_test",
    providerId: "provider-1",
    provider: "courtyard",
    sourceInstanceId: "source-1",
    sourceRevisionId: "source-revision-1",
    recordsPerRequest,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: "courtyard-v1",
    mapperVersion: "v1",
    identityNamespaceKey: dataforrestIdentityNamespaceByProvider.courtyard,
    cursorCodecVersion: alternateBookmarkSourceManifest.cursorCodecKey,
    sourceConfiguration: { partition: "courtyard" },
    recordIdScopes: persistedScopes,
  };
}

function pageWork(
  recordsPerRequest = 500,
  retryAttempt = 0,
): ClaimedPageReadWork {
  return {
    ...sourceWork(recordsPerRequest),
    id: "page-run-1",
    kind: "page_read",
    runId: "page-run-1",
    runTrigger: "scheduled",
    runStartedAt: new Date("2026-08-21T12:00:00.000Z"),
    committedPages: 0,
    committedRecords: 0,
    retryAttempt,
    pageNumber: 1,
    cursorGeneration: 1n,
    requestedCursorValue: null,
    requestedCursorFingerprint: null,
    sourceIntervalSeconds: 60,
  };
}

function dataforrestPageWork(retryAttempt: number): ClaimedPageReadWork {
  return {
    ...pageWork(),
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    connectionConfiguration: encryptedDataforrestConfiguration(),
    sourceConfiguration: { platform: "courtyard" },
    cursorCodecVersion: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    requestedCursorValue: "opaque-retry-cursor",
    requestedCursorFingerprint: "a".repeat(64),
    retryAttempt,
  };
}

class RecordingAdapter extends AlternateBookmarkSourceAdapter {
  throwOnCapture = false;
  failRequest = false;
  readonly capturedOperations: SourceAdapterOperation[] = [];
  readonly pageLimits: number[] = [];
  constructor(private readonly events: string[], payload?: unknown) {
    super(payload);
  }

  override async captureUnboundRequest(
    operation: SourceAdapterOperation,
    invocation: SourceAdapterCaptureInvocation,
  ) {
    this.events.push("capture");
    this.capturedOperations.push(operation);
    if (operation.operationKind === "page_read") {
      this.pageLimits.push(operation.correlation.pageLimit);
    }
    if (this.throwOnCapture) throw new Error("unknown capture state");
    if (this.failRequest) {
      invocation.consume(operation);
      this.captureCount += 1;
      return {
        ok: false,
        failure: { disposition: "retryable", code: "request_timeout" },
        measurements: { durationMilliseconds: 10_000, responseBytes: 0 },
        diagnostics: [],
      } satisfies UnboundSourceAdapterRequestResult;
    }
    return super.captureUnboundRequest(operation, invocation);
  }
}

interface ExecutorFixture {
  readonly adapter: RecordingAdapter;
  readonly context: SourceSupervisorExecutionContext;
  readonly coordinator: ConnectionPermitCoordinator;
  readonly events: string[];
  readonly executor: ProviderSourceSupervisorWorkExecutor;
  releaseRetained(): void;
}

function activeRequestPermitCount(
  coordinator: ConnectionPermitCoordinator,
): number {
  return coordinator.snapshot().requestPermitLanes.reduce(
    (total, lane) => total + lane.activeRequestPermits,
    0,
  );
}

function fixture(overrides: Readonly<{
  begin?: () => Promise<string>;
  terminalize?: () => Promise<void>;
  capacityChanged?: () => Promise<void>;
  recordDiagnostic?: () => Promise<void>;
  resolveMapper?: () => void;
  importPage?: () => Promise<never>;
  adapterPayload?: unknown;
  sourceAdapter?: SourceAdapter;
}> = {}): ExecutorFixture {
  const events: string[] = [];
  const adapter = new RecordingAdapter(events, overrides.adapterPayload);
  const coordinator = new ConnectionPermitCoordinator();
  coordinator.configureRequestPermitLane({
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    scope: "connection_test",
    providerId: null,
    approvedRequestCap: 1,
  });
  coordinator.configureRequestPermitLane({
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    scope: "platform",
    providerId: "provider-1",
    approvedRequestCap: 1,
  });
  let retained: (() => void) | undefined;
  const requestRepository = {
    async begin() {
      events.push("begin");
      return overrides.begin?.() ?? "request-attempt-1";
    },
    async terminalize() {
      events.push("terminalize");
      await overrides.terminalize?.();
      return {
        blockingEpisodeId: null,
        blockingEpisodeOpened: false,
        resultingHealthGeneration: 3n,
      };
    },
  } as unknown as ProviderSourceRequestRepository;
  const testResults = {
    async completeConnectionTest() {
      events.push("connection-test-result");
      return {
        resultId: "result-1",
        resultingHealthGeneration: 3n,
        episodeClosed: false,
      };
    },
    async completeSourceTest() {
      events.push("source-test-result");
      return { resultId: "result-1" };
    },
  } as unknown as ProviderSourceTestResultRepository;
  const runtimeFence = new RuntimeControlPlaneFence();
  const context: SourceSupervisorExecutionContext = {
    epoch,
    requestLeases: new SourceRequestLeaseAuthority(coordinator),
    runtimeFence,
    signal: runtimeFence.signal,
    async capacityChanged() {
      events.push("capacity");
      await overrides.capacityChanged?.();
    },
    async admissionWaiting() {},
    async admissionGranted() {},
    retainExecutionSlot(release) {
      assert.equal(retained, undefined);
      retained = release;
    },
    async recordDiagnostic() {
      events.push("request-start-diagnostic");
      await overrides.recordDiagnostic?.();
    },
  };
  const executor = new ProviderSourceSupervisorWorkExecutor({
    sourceAdapters: new SourceAdapterRegistry([
      overrides.sourceAdapter ?? adapter,
    ]),
    mappers: {
      resolve() {
        overrides.resolveMapper?.();
        return {} as never;
      },
    },
    connectionCipher: cipher,
    requests: requestRepository,
    testResults,
    pageImports: {
      async importPage() {
        if (overrides.importPage) return await overrides.importPage();
        throw new Error("page import is outside this fixture");
      },
    } as never,
    classifyControlPlaneFailure(error) {
      return error instanceof ControlPlaneTransactionError
        ? error.code
        : "invariant";
    },
    ids: {
      id: (() => {
        let sequence = 0;
        return () => `generated-id-${++sequence}`;
      })(),
    },
  });
  return {
    adapter,
    context,
    coordinator,
    events,
    executor,
    releaseRetained() {
      retained?.();
      retained = undefined;
    },
  };
}

test("a bounded page persistence timeout preserves the cursor and exact request pin for retry", async () => {
  const execution = fixture({
    async importPage() {
      throw new ControlPlaneTransactionError("timeout");
    },
  });

  const result = await execution.executor.execute(
    pageWork(137),
    execution.context,
  );

  assert.deepEqual(result, {
    kind: "retryable",
    safeCode: "PAGE_PERSISTENCE_TIMEOUT",
  });
  assert.deepEqual(execution.adapter.pageLimits, [137]);
  assert.deepEqual(execution.coordinator.snapshot(), {
    maximumExecutionSlots: 4,
    activeExecutionSlots: 1,
    queuedOperations: 0,
    requestPermitLanes: [{
      organizationId: "organization-1",
      connectionProfileId: "profile-1",
      scope: "connection_test",
      providerId: null,
      approvedRequestCap: 1,
      activeRequestPermits: 0,
      queuedOperations: 0,
    }, {
      organizationId: "organization-1",
      connectionProfileId: "profile-1",
      scope: "platform",
      providerId: "provider-1",
      approvedRequestCap: 1,
      activeRequestPermits: 0,
      queuedOperations: 0,
    }],
  });

  execution.releaseRetained();
  assert.equal(execution.coordinator.snapshot().activeExecutionSlots, 0);

  const retry = await execution.executor.execute(
    pageWork(137, 1),
    execution.context,
  );
  assert.deepEqual(retry, {
    kind: "retryable",
    safeCode: "PAGE_PERSISTENCE_TIMEOUT",
  });
  assert.deepEqual(execution.adapter.pageLimits, [137, 137]);
  execution.releaseRetained();
  assert.equal(execution.coordinator.snapshot().activeExecutionSlots, 0);
});

test("DataForrest retries an oversized cursor with the exact durable request pin", async () => {
  const urls: URL[] = [];
  const bounds: Array<Readonly<{
    pageLimit: number;
    maximumResponseBytes: number;
    timeoutMilliseconds: number;
  }>> = [];
  class ExecutorDataforrestAdapter extends DataforrestEventsSourceAdapter {
    override async captureUnboundRequest(
      operation: SourceAdapterOperation,
      invocation: SourceAdapterCaptureInvocation,
    ) {
      bounds.push(operation.bounds);
      return await super.captureUnboundRequest(operation, invocation);
    }
  }
  const adapter = new ExecutorDataforrestAdapter({
    resolveHost: async () => ["198.204.245.26"],
    httpClient: async (url) => {
      urls.push(new URL(url));
      return new Response(null, {
        status: 200,
        headers: { "content-length": "8388609" },
      });
    },
  }, dataforrestEventsV1SourceAdapterManifest);
  const execution = fixture({ sourceAdapter: adapter });

  const initial = await execution.executor.execute(
    dataforrestPageWork(0),
    execution.context,
  );
  assert.deepEqual(initial, {
    kind: "retryable",
    safeCode: "RESPONSE_TOO_LARGE",
  });
  execution.releaseRetained();

  const retry = await execution.executor.execute(
    dataforrestPageWork(1),
    execution.context,
  );
  assert.deepEqual(retry, {
    kind: "retryable",
    safeCode: "RESPONSE_TOO_LARGE",
  });
  execution.releaseRetained();

  assert.deepEqual(
    urls.map((url) => ({
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.get("limit"),
      platform: url.searchParams.get("platform"),
    })),
    [{
      cursor: "opaque-retry-cursor",
      limit: "500",
      platform: "courtyard",
    }, {
      cursor: "opaque-retry-cursor",
      limit: "500",
      platform: "courtyard",
    }],
  );
  assert.deepEqual(bounds, [{
    pageLimit: 500,
    maximumResponseBytes: 8_388_608,
    timeoutMilliseconds: 10_000,
  }, {
    pageLimit: 500,
    maximumResponseBytes: 8_388_608,
    timeoutMilliseconds: 10_000,
  }]);
  assert.equal(execution.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(execution.coordinator), 0);
});

test("an uncertain page commit connection loss fences local execution", async () => {
  const execution = fixture({
    async importPage() {
      throw new ControlPlaneTransactionError("connection");
    },
  });

  await assert.rejects(
    execution.executor.execute(pageWork(), execution.context),
    (error: unknown) => error instanceof RuntimeLocallyFencedError,
  );

  execution.releaseRetained();
  assert.equal(execution.coordinator.snapshot().activeExecutionSlots, 0);
});

test("production executor begins and terminalizes once before publishing a test result", async () => {
  const subject = fixture();
  const result = await subject.executor.execute(connectionWork(), subject.context);
  assert.deepEqual(result, { kind: "test_terminal" });
  assert.equal(subject.adapter.captureCount, 1);
  assert.ok(subject.events.indexOf("begin") < subject.events.indexOf("capture"));
  assert.ok(
    subject.events.indexOf("terminalize") <
      subject.events.indexOf("request-start-diagnostic"),
  );
  assert.ok(
    subject.events.indexOf("request-start-diagnostic") <
      subject.events.indexOf("connection-test-result"),
  );
  subject.releaseRetained();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
});

test("a captured connection interpretation failure publishes its test result", async () => {
  const subject = fixture();
  subject.adapter.interpretConnectionTest = async () => ({
    ok: false,
    failure: {
      disposition: "connection_action_required",
      code: "profile_configuration_invalid",
    },
    recordCount: 0,
    diagnostics: [],
  });

  const result = await subject.executor.execute(connectionWork(), subject.context);

  assert.deepEqual(result, { kind: "test_terminal" });
  assert.ok(subject.events.includes("terminalize"));
  assert.ok(subject.events.includes("connection-test-result"));
  subject.releaseRetained();
});

test("JSONB roundtrip preserves the canonical record-scope sequence", async () => {
  const subject = fixture();
  const result = await subject.executor.execute(sourceWork(137), subject.context);
  assert.deepEqual(result, { kind: "test_terminal" });
  assert.equal(subject.adapter.captureCount, 1);
  assert.equal(subject.adapter.capturedOperations[0]?.bounds.pageLimit, 137);
  assert.ok(subject.events.includes("source-test-result"));
  subject.releaseRetained();
});

test("a failed source request publishes one terminal test result", async () => {
  const subject = fixture();
  subject.adapter.failRequest = true;

  const result = await subject.executor.execute(sourceWork(), subject.context);

  assert.deepEqual(result, { kind: "test_terminal" });
  assert.equal(subject.events.filter((event) => event === "terminalize").length, 1);
  assert.equal(
    subject.events.filter((event) => event === "source-test-result").length,
    1,
  );
  subject.releaseRetained();
});

test("a failed source interpretation publishes one terminal test result", async () => {
  const subject = fixture({ adapterPayload: null });

  const result = await subject.executor.execute(sourceWork(), subject.context);

  assert.deepEqual(result, { kind: "test_terminal" });
  assert.equal(subject.events.filter((event) => event === "terminalize").length, 1);
  assert.equal(
    subject.events.filter((event) => event === "source-test-result").length,
    1,
  );
  subject.releaseRetained();
});

test("profile-only connection tests do not inherit a source request-size pin", async () => {
  const subject = fixture();
  await subject.executor.execute(connectionWork(), subject.context);
  const operation = subject.adapter.capturedOperations[0];
  assert.ok(operation);
  assert.equal(operation.operationKind, "connection_test");
  assert.equal(
    operation.bounds.pageLimit,
    Math.min(
      providerSourceLaunchBounds.pageTargetRecords,
      alternateBookmarkSourceManifest.requestBounds.pageLimit,
    ),
  );
  assert.equal("recordsPerRequest" in operation, false);
  subject.releaseRetained();
});

test("an unresolved mapper pin retains its slot through durable finalization", async () => {
  const subject = fixture({
    resolveMapper() {
      throw new Error("mapper pin is not registered");
    },
  });
  const result = await subject.executor.execute(sourceWork(), subject.context);
  assert.deepEqual(result, {
    kind: "source_action_required",
    safeCode: "MAPPER_REGISTRATION_INCOMPATIBLE",
  });
  assert.equal(subject.adapter.captureCount, 0);
  assert.ok(!subject.events.includes("begin"));
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 1);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
  subject.releaseRetained();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
});

test("corrupted encrypted configuration opens the shared boundary with zero upstream calls", async () => {
  const subject = fixture();
  const work = connectionWork();
  const ciphertext = Uint8Array.from(work.connectionConfiguration.ciphertext);
  ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
  const result = await subject.executor.execute({
    ...work,
    connectionConfiguration: {
      ...work.connectionConfiguration,
      ciphertext,
    },
  }, subject.context);

  assert.deepEqual(result, {
    kind: "connection_action_required",
    safeCode: "PROFILE_CONFIGURATION_INVALID",
  });
  assert.equal(subject.adapter.captureCount, 0);
  assert.ok(subject.events.includes("begin"));
  assert.ok(subject.events.includes("terminalize"));
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 1);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
  subject.releaseRetained();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
});

test("runtime uses one request per lane beneath the exact adapter maximum", () => {
  const subject = fixture();
  assert.deepEqual(subject.executor.registeredRequestPermitLane(connectionWork()), {
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    scope: "connection_test",
    providerId: null,
    approvedRequestCap: 1,
  });
  assert.deepEqual(subject.executor.registeredRequestPermitLane(sourceWork()), {
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    scope: "platform",
    providerId: "provider-1",
    approvedRequestCap: 1,
  });
});

test("pre-call control-plane exhaustion makes zero calls and releases the pair", async () => {
  const subject = fixture({
    async begin() {
      throw new ControlPlaneTransactionError("connection");
    },
  });
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    ControlPlaneRetryExhaustedError,
  );
  assert.equal(subject.adapter.captureCount, 0);
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
});

test("a stale pre-call claim is typed without an upstream call or permit leak", async () => {
  const subject = fixture({
    async begin() {
      throw new ControlPlaneTransactionError("stale_fence");
    },
    async terminalize() {
      throw new ControlPlaneTransactionError("stale_fence");
    },
  });
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    SourceSupervisorStaleWorkError,
  );
  assert.equal(subject.adapter.captureCount, 0);
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
});

test("pre-call owner loss is promoted to a whole-runtime local fence", async () => {
  const subject = fixture({
    async begin() {
      throw new ControlPlaneTransactionError("lost_ownership");
    },
  });
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    RuntimeLocallyFencedError,
  );
  assert.equal(subject.adapter.captureCount, 0);
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
});

test("retrospective diagnostic failure retains a cleanup callback after terminalization", async () => {
  const subject = fixture({
    async recordDiagnostic() {
      throw new Error("diagnostic unavailable");
    },
  });
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    /diagnostic unavailable/u,
  );
  assert.equal(subject.adapter.captureCount, 1);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
  subject.releaseRetained();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
});

test("postterminal capacity publication failure retains exact slot cleanup", async () => {
  let publications = 0;
  const subject = fixture({
    async capacityChanged() {
      publications += 1;
      if (publications === 3) throw new Error("snapshot unavailable");
    },
  });
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    /snapshot unavailable/u,
  );
  assert.equal(subject.adapter.captureCount, 1);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
  subject.releaseRetained();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
});

test("owner fencing handles queued admission cancellation while capacity publication is pending", async () => {
  let capacityEntered!: () => void;
  let releaseCapacity!: () => void;
  const entered = new Promise<void>((resolve) => {
    capacityEntered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    releaseCapacity = resolve;
  });
  const subject = fixture({
    async capacityChanged() {
      capacityEntered();
      await held;
    },
  });
  const requestPermitLane = {
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    scope: "connection_test" as const,
    providerId: null,
  };
  const occupyingPermits = [
    await subject.coordinator.acquire({ requestPermitLane }),
  ];
  const execution = subject.executor.execute(connectionWork(), subject.context);

  await entered;
  subject.context.runtimeFence.fence();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseCapacity();

  await assert.rejects(
    execution,
    (error: unknown) => error instanceof SourceRequestLeaseError &&
      error.code === "cancelled",
  );
  assert.equal(subject.adapter.captureCount, 0);
  for (const permit of occupyingPermits) permit.releaseAll();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
});

test("terminalization exhaustion makes one call and drains after owner fencing", async () => {
  const subject = fixture({
    async terminalize() {
      throw new ControlPlaneTransactionError("connection");
    },
  });
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    ControlPlaneRetryExhaustedError,
  );
  assert.equal(subject.adapter.captureCount, 1);
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
});

test("unknown capture failure drains process capacity only after admission stops", async () => {
  const subject = fixture();
  subject.adapter.throwOnCapture = true;
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    RuntimeLocallyFencedError,
  );
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(activeRequestPermitCount(subject.coordinator), 0);
});
