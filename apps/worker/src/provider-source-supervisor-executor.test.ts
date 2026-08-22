import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestIdentityNamespaceByProvider,
  launchRecordIdScopeDeclarations,
} from "@packscout/contracts";
import {
  ProviderSourceRequestRepository,
  ProviderSourceTestResultRepository,
  type ClaimedConnectionTestWork,
  type ClaimedSourceTestWork,
} from "@packscout/database";
import {
  AesGcmSourceConnectionConfigurationCipher,
  ConnectionPermitCoordinator,
  ControlPlaneRetryExhaustedError,
  ControlPlaneTransactionError,
  RuntimeControlPlaneFence,
  RuntimeLocallyFencedError,
  SourceSupervisorStaleWorkError,
  SourceAdapterRegistry,
  SourceRequestLeaseAuthority,
  type SourceAdapterCaptureInvocation,
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
    profileRequestLimit: 2,
    connectionConfiguration: encryptedConfiguration(),
    claimOwner: "executor-test-owner",
    claimToken: "65000000-0000-4000-8000-000000000003",
    claimLeaseId: "65000000-0000-4000-8000-000000000004",
    claimExpiresAt: new Date("2026-08-21T12:00:30.000Z"),
    recoveryEpisodeId: null,
  };
}

function sourceWork(): ClaimedSourceTestWork {
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
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: "courtyard-v1",
    mapperVersion: "v1",
    identityNamespaceKey: dataforrestIdentityNamespaceByProvider.courtyard,
    checkpointCodecVersion: alternateBookmarkSourceManifest.checkpointCodecKey,
    sourceConfiguration: { partition: "courtyard" },
    recordIdScopes: persistedScopes,
  };
}

class RecordingAdapter extends AlternateBookmarkSourceAdapter {
  throwOnCapture = false;
  constructor(private readonly events: string[]) {
    super();
  }

  override async captureUnboundRequest(
    operation: SourceAdapterOperation,
    invocation: SourceAdapterCaptureInvocation,
  ) {
    this.events.push("capture");
    if (this.throwOnCapture) throw new Error("unknown capture state");
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

function fixture(overrides: Readonly<{
  begin?: () => Promise<string>;
  terminalize?: () => Promise<void>;
  capacityChanged?: () => Promise<void>;
  recordDiagnostic?: () => Promise<void>;
  resolveMapper?: () => void;
}> = {}): ExecutorFixture {
  const events: string[] = [];
  const adapter = new RecordingAdapter(events);
  const coordinator = new ConnectionPermitCoordinator();
  coordinator.configureProfile({
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    approvedAggregateRequestCap: 2,
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
    sourceAdapters: new SourceAdapterRegistry([adapter]),
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
});

test("JSONB roundtrip preserves the canonical record-scope sequence", async () => {
  const subject = fixture();
  const result = await subject.executor.execute(sourceWork(), subject.context);
  assert.deepEqual(result, { kind: "test_terminal" });
  assert.equal(subject.adapter.captureCount, 1);
  assert.ok(subject.events.includes("source-test-result"));
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
  subject.releaseRetained();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
});

test("the exact adapter manifest is the admission cap authority", () => {
  const subject = fixture();
  assert.equal(subject.executor.registeredProfileRequestLimit(connectionWork()), 2);
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
  subject.releaseRetained();
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
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
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
});

test("unknown capture failure drains process capacity only after admission stops", async () => {
  const subject = fixture();
  subject.adapter.throwOnCapture = true;
  await assert.rejects(
    subject.executor.execute(connectionWork(), subject.context),
    RuntimeLocallyFencedError,
  );
  assert.equal(subject.coordinator.snapshot().activeExecutionSlots, 0);
  assert.equal(subject.coordinator.snapshot().profiles[0]?.activeRequestPermits, 0);
});
