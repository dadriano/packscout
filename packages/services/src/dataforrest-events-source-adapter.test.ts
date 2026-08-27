import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestIdentityNamespaceByProvider,
  dataforrestEventsPageV1Schema,
  dataforrestEventsV1LegacySourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifest,
  launchRecordIdScopeDeclarations,
  sourceAdapterFailureSchema,
  type LaunchProviderKey,
  type ProviderSourceRequestBounds,
  type SourceAdapterManifestV1,
} from "@packscout/contracts";
import { dataforestEventsV1EvidenceFixture } from "@packscout/contracts/test-fixtures/dataforrest-events-v1";
import { ConnectionPermitCoordinator } from "./connection-permit-coordinator.ts";
import { DataforrestEventsSourceAdapter } from "./dataforrest-events-source-adapter.ts";
import { isBoundedDataforrestEventsPageV1 } from "./dataforrest-events-page-interpreter.ts";
import { isDeepFrozenJsonValue } from "./source-adapter-contract-primitives.ts";
import { isTrustedProtectedNativeEvidence } from "./trusted-protected-native-evidence.ts";
import type { PinnedProviderHttpClient } from "./pinned-provider-http-client.ts";
import {
  SourceAdapterCaptureInvocation,
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
  type ConnectionTestOperation,
  type PageReadOperation,
  type SourceAdapterRequestTerminalizationInput,
  type SourceTestOperation,
} from "./source-adapter.ts";
import {
  SourceRequestLeaseAuthority,
  SourceRequestLeaseError,
  type ConnectionTestRequestPins,
  type PageReadRequestPins,
  type SourceTestRequestPins,
} from "./source-request-lease.ts";
import { createProviderObservationMapperRegistryFromManifest } from "./providers/provider-mapper-manifest.ts";
import { mapperInput } from "./providers/provider-observation-mapper.test-support.ts";

const bounds = Object.freeze({
  pageLimit: 250,
  maximumResponseBytes: 2_097_152,
  timeoutMilliseconds: 10_000,
});
const connectionConfiguration = Object.freeze({
  endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
  bearerToken: "fixture-secret-never-returned",
});

interface TestRuntime {
  readonly coordinator: ConnectionPermitCoordinator;
  readonly authority: SourceRequestLeaseAuthority;
}

const requestLeaseAuthorityByOperation = new WeakMap<
  ConnectionTestOperation | SourceTestOperation | PageReadOperation,
  SourceRequestLeaseAuthority
>();

function runtime(cap = 2): TestRuntime {
  const coordinator = new ConnectionPermitCoordinator();
  coordinator.configureRequestPermitLane({
    organizationId: "organization-1",
    connectionProfileId: "profile-1",
    scope: "connection_test",
    providerId: null,
    approvedRequestCap: cap,
  });
  for (const provider of Object.keys(
    dataforrestIdentityNamespaceByProvider,
  ) as LaunchProviderKey[]) {
    coordinator.configureRequestPermitLane({
      organizationId: "organization-1",
      connectionProfileId: "profile-1",
      scope: "platform",
      providerId: `provider-${provider}`,
      approvedRequestCap: cap,
    });
  }
  return {
    coordinator,
    authority: new SourceRequestLeaseAuthority(coordinator),
  };
}

const commonPins = {
  organizationId: "organization-1",
  sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  singletonFencingEpoch: 7,
  connectionProfileId: "profile-1",
  connectionProfileRevisionId: "profile-revision-1",
  connectionHealthGeneration: 3,
} as const;
const commonOperationFields = {
  organizationId: commonPins.organizationId,
  sourceTypeKey: commonPins.sourceTypeKey,
  adapterVersion: commonPins.adapterVersion,
  connectionProfileId: commonPins.connectionProfileId,
  connectionProfileRevisionId: commonPins.connectionProfileRevisionId,
} as const;

let requestIdentitySequence = 0;

function nextRequestIdentity(kind: string) {
  requestIdentitySequence += 1;
  return {
    requestAttemptId: `request-attempt-${kind}-${requestIdentitySequence}`,
    requestLeaseId: `request-lease-${kind}-${requestIdentitySequence}`,
  } as const;
}

function cursor(
  provider: LaunchProviderKey,
  value: string | null,
  adapterVersion: string = DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
) {
  return {
      sourceInstanceId: `source-${provider}`,
      sourceRevisionId: `source-revision-${provider}`,
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    adapterVersion,
    cursorCodecKey: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    cursorGeneration: 1,
    value,
  } as const;
}

function cursorFingerprint(value: string | null): string | null {
  return value === null
    ? null
    : createHash("sha256").update(value).digest("hex");
}

async function connectionOperation(
  testRuntime: TestRuntime,
): Promise<ConnectionTestOperation> {
  const requestIdentity = nextRequestIdentity("connection");
  const pins: ConnectionTestRequestPins = {
    ...commonPins,
    ...requestIdentity,
    operationKind: "connection_test",
    connectionTestJobId: "connection-test-1",
    jobClaimLeaseId: "job-lease-1",
    recoveryEpisodeId: null,
  };
  const requestLease = await testRuntime.authority.admit({
    pins,
    guard: () => true,
  });
  const operation = createConnectionTestOperation({
    ...commonOperationFields,
    operationKind: "connection_test",
    connectionConfiguration,
    requestLease,
    bounds,
    correlation: {
      singletonFencingEpoch: commonPins.singletonFencingEpoch,
      connectionHealthGeneration: commonPins.connectionHealthGeneration,
      connectionTestJobId: pins.connectionTestJobId,
      jobClaimLeaseId: pins.jobClaimLeaseId,
      recoveryEpisodeId: null,
    },
  });
  requestLeaseAuthorityByOperation.set(operation, testRuntime.authority);
  return operation;
}

async function sourceOperation(
  testRuntime: TestRuntime,
  provider: LaunchProviderKey,
): Promise<SourceTestOperation> {
  const requestIdentity = nextRequestIdentity(`source-${provider}`);
  const pins: SourceTestRequestPins = {
    ...commonPins,
    ...requestIdentity,
    operationKind: "source_test",
    provider,
    providerId: `provider-${provider}`,
    sourceInstanceId: `source-${provider}`,
    sourceRevisionId: `source-revision-${provider}`,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: dataforrestIdentityNamespaceByProvider[provider],
    sourceTestJobId: `source-test-${provider}`,
    jobClaimLeaseId: `job-lease-${provider}`,
  };
  const requestLease = await testRuntime.authority.admit({
    pins,
    guard: () => true,
  });
  const operation = createSourceTestOperation({
    ...commonOperationFields,
    operationKind: "source_test",
    provider,
    providerId: pins.providerId,
    sourceInstanceId: pins.sourceInstanceId,
    sourceRevisionId: pins.sourceRevisionId,
    normalizedContractVersion: pins.normalizedContractVersion,
    identityNamespaceKey: pins.identityNamespaceKey,
    recordIdScopes: launchRecordIdScopeDeclarations,
    connectionConfiguration,
    sourceConfiguration: { platform: provider },
    requestLease,
    bounds,
    correlation: {
      singletonFencingEpoch: commonPins.singletonFencingEpoch,
      connectionHealthGeneration: commonPins.connectionHealthGeneration,
      sourceTestJobId: pins.sourceTestJobId,
      jobClaimLeaseId: pins.jobClaimLeaseId,
    },
  });
  requestLeaseAuthorityByOperation.set(operation, testRuntime.authority);
  return operation;
}

async function pageOperation(
  testRuntime: TestRuntime,
  provider: LaunchProviderKey,
  value: string | null,
  pageBounds: ProviderSourceRequestBounds = bounds,
  adapterIdentity: Readonly<{
    adapterVersion: string;
    normalizedContractVersion: string;
  }> = {
    adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
  },
): Promise<PageReadOperation> {
  const requestedCursor = cursor(
    provider,
    value,
    adapterIdentity.adapterVersion,
  );
  const requestIdentity = nextRequestIdentity(`page-${provider}`);
  const pins: PageReadRequestPins = {
    ...commonPins,
    adapterVersion: adapterIdentity.adapterVersion,
    ...requestIdentity,
    operationKind: "page_read",
    provider,
    providerId: `provider-${provider}`,
    sourceInstanceId: requestedCursor.sourceInstanceId,
    sourceRevisionId: requestedCursor.sourceRevisionId,
    normalizedContractVersion: adapterIdentity.normalizedContractVersion,
    identityNamespaceKey: dataforrestIdentityNamespaceByProvider[provider],
    importRunId: `run-${provider}`,
    runClaimLeaseId: `run-lease-${provider}`,
    pageAttemptId: `page-${provider}-${value ?? "initial"}`,
    pageNumber: 1,
    pageLimit: pageBounds.pageLimit,
    cursorGeneration: 1,
    requestedCursorFingerprint: cursorFingerprint(value),
  };
  const requestLease = await testRuntime.authority.admit({
    pins,
    requestedCursor,
    guard: () => true,
  });
  const operation = createPageReadOperation({
    ...commonOperationFields,
    adapterVersion: adapterIdentity.adapterVersion,
    operationKind: "page_read",
    provider,
    providerId: pins.providerId,
    sourceInstanceId: pins.sourceInstanceId,
    sourceRevisionId: pins.sourceRevisionId,
    normalizedContractVersion: pins.normalizedContractVersion,
    identityNamespaceKey: pins.identityNamespaceKey,
    recordIdScopes: launchRecordIdScopeDeclarations,
    connectionConfiguration,
    sourceConfiguration: { platform: provider },
    requestLease,
    bounds: pageBounds,
    correlation: {
      singletonFencingEpoch: commonPins.singletonFencingEpoch,
      connectionHealthGeneration: commonPins.connectionHealthGeneration,
      importRunId: pins.importRunId,
      runClaimLeaseId: pins.runClaimLeaseId,
      pageAttemptId: pins.pageAttemptId,
      pageNumber: pins.pageNumber,
      cursorGeneration: pins.cursorGeneration,
      requestedCursorFingerprint: pins.requestedCursorFingerprint,
      requestedCursor,
      pageLimit: pins.pageLimit,
    },
  });
  requestLeaseAuthorityByOperation.set(operation, testRuntime.authority);
  return operation;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonNodeCount(root: unknown): number {
  const pending: unknown[] = [root];
  let count = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    count += 1;
    if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }
  return count;
}

function adapterWithClient(
  httpClient: PinnedProviderHttpClient,
  manifest: SourceAdapterManifestV1 =
    dataforrestEventsV1SourceAdapterManifest,
) {
  return new DataforrestEventsSourceAdapter({
    httpClient,
    resolveHost: async () => ["198.204.245.26"],
  }, manifest);
}

test("copy-free V1 envelope validation stays in parity with canonical schema bounds", () => {
  const envelope = (overrides: Record<string, unknown> = {}) => ({
    records: [{ native: { nested: [null, true, 1, "value"] } }],
    next_cursor: "page-next",
    poll_after_seconds: 60,
    ...overrides,
  });
  const sixtyFiveFields = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`field_${index}`, null]),
  );
  const cases = [
    { label: "valid", value: envelope(), expected: true },
    {
      label: "missing wrapper key",
      value: { records: [], next_cursor: "page-next" },
      expected: false,
    },
    {
      label: "extra wrapper key",
      value: envelope({ extra: null }),
      expected: false,
    },
    {
      label: "exact cursor bound",
      value: envelope({ next_cursor: "é".repeat(8_192) }),
      expected: true,
    },
    {
      label: "oversized cursor",
      value: envelope({ next_cursor: `${"é".repeat(8_192)}a` }),
      expected: false,
    },
    {
      label: "blank cursor",
      value: envelope({ next_cursor: " \t " }),
      expected: false,
    },
    {
      label: "invalid poll value",
      value: envelope({ poll_after_seconds: 1 }),
      expected: false,
    },
    {
      label: "record count bound",
      value: envelope({
        records: Array.from({ length: 5_001 }, () => ({})),
      }),
      expected: false,
    },
    {
      label: "record field count bound",
      value: envelope({ records: [sixtyFiveFields] }),
      expected: false,
    },
    {
      label: "record key bound",
      value: envelope({ records: [{ ["x".repeat(129)]: null }] }),
      expected: false,
    },
    {
      label: "non-JSON record value",
      value: envelope({ records: [{ native: undefined }] }),
      expected: false,
    },
    {
      label: "non-finite record value",
      value: envelope({ records: [{ native: Number.POSITIVE_INFINITY }] }),
      expected: false,
    },
  ] as const;
  for (const { label, value, expected } of cases) {
    assert.equal(
      dataforrestEventsPageV1Schema.safeParse(value).success,
      expected,
      `canonical schema: ${label}`,
    );
    assert.equal(
      isBoundedDataforrestEventsPageV1(value, 5_000),
      expected,
      `copy-free validator: ${label}`,
    );
  }

  const operationBounded = envelope({ records: [{}, {}] });
  assert.equal(dataforrestEventsPageV1Schema.safeParse(operationBounded).success, true);
  assert.equal(isBoundedDataforrestEventsPageV1(operationBounded, 1), false);
});

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
  adapter: DataforrestEventsSourceAdapter,
  operation: ConnectionTestOperation | SourceTestOperation | PageReadOperation,
) {
  const requestLeaseAuthority = requestLeaseAuthorityByOperation.get(operation);
  if (requestLeaseAuthority === undefined) {
    throw new Error("test_fixture.missing_request_lease_authority");
  }
  return captureAndTerminalizeSourceAdapterRequest(
    requestLeaseAuthority,
    adapter,
    operation,
    acknowledgeTerminalization,
  );
}

async function successfulCapture(
  adapter: DataforrestEventsSourceAdapter,
  operation: ConnectionTestOperation | SourceTestOperation | PageReadOperation,
) {
  const captured = await captureRequest(adapter, operation);
  if (!captured.ok) assert.fail(`capture failed: ${captured.failure.code}`);
  return captured;
}

async function completedPage(
  adapter: DataforrestEventsSourceAdapter,
  operation: PageReadOperation,
) {
  const captured = await successfulCapture(adapter, operation);
  const context = sourceAdapterInterpretationContextOf(operation);
  const interpreted = await interpretSourceAdapterPage(
    adapter,
    operation,
    captured,
  );
  return completeSourceAdapterPageRead(
    operation,
    context,
    captured,
    interpreted,
  );
}

test("fixed DataForrest interpretation seals native evidence for zero-copy completion", async () => {
  const adapter = adapterWithClient(async () =>
    jsonResponse(dataforestEventsV1EvidenceFixture.courtyard.initial)
  );
  const operation = await pageOperation(runtime(), "courtyard", null);
  const captured = await successfulCapture(adapter, operation);
  const context = sourceAdapterInterpretationContextOf(operation);
  const interpreted = await interpretSourceAdapterPage(
    adapter,
    operation,
    captured,
  );
  assert.equal(interpreted.ok, true);
  if (!interpreted.ok) assert.fail("DataForrest page interpretation failed.");
  const evidence = interpreted.value.protectedNativeEvidence;
  assert.equal(isTrustedProtectedNativeEvidence(evidence), true);
  assert.equal(isDeepFrozenJsonValue(evidence), true);

  const completed = completeSourceAdapterPageRead(
    operation,
    context,
    captured,
    interpreted,
  );
  assert.equal(completed.ok, true);
  if (!completed.ok) assert.fail("DataForrest page completion failed.");
  assert.strictEqual(completed.value.protectedNativeEvidence, evidence);
  operation.requestLease.close();
});

test("page interpretation rejects malformed UTF-8 instead of accepting replacement text", async () => {
  const encoder = new TextEncoder();
  const prefix = encoder.encode('{"records":[],"next_cursor":"');
  const suffix = encoder.encode('","poll_after_seconds":60}');
  const malformed = new Uint8Array(prefix.length + 2 + suffix.length);
  malformed.set(prefix);
  malformed.set([0xc3, 0x28], prefix.length);
  malformed.set(suffix, prefix.length + 2);
  const adapter = adapterWithClient(async () =>
    new Response(malformed, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  const operation = await pageOperation(runtime(), "courtyard", null);
  const captured = await successfulCapture(adapter, operation);
  const interpreted = await interpretSourceAdapterPage(
    adapter,
    operation,
    captured,
  );
  assert.equal(interpreted.ok, false);
  if (!interpreted.ok) {
    assert.deepEqual(interpreted.failure, {
      disposition: "source_action_required",
      code: "invalid_response",
    });
  }
  operation.requestLease.close();
});

test("request shapes are operation-specific and preserve an opaque cursor exactly", async () => {
  const requests: Array<Readonly<{ url: URL; init: RequestInit }>> = [];
  const adapter = adapterWithClient(async (url, init) => {
    requests.push({ url: new URL(url), init });
    return jsonResponse(dataforestEventsV1EvidenceFixture.courtyard.initial);
  });
  const testRuntime = runtime();
  const connection = await connectionOperation(testRuntime);
  await successfulCapture(adapter, connection);
  connection.requestLease.close();
  const source = await sourceOperation(testRuntime, "courtyard");
  await successfulCapture(adapter, source);
  source.requestLease.close();
  const initial = await pageOperation(testRuntime, "courtyard", null);
  await successfulCapture(adapter, initial);
  initial.requestLease.close();
  const opaqueCursor = "opaque +/=%?& cursor\tsegment";
  const continuation = await pageOperation(
    testRuntime,
    "courtyard",
    opaqueCursor,
  );
  await successfulCapture(adapter, continuation);
  continuation.requestLease.close();
  assert.equal(requests.length, 4);
  assert.deepEqual([...requests[0]!.url.searchParams.keys()], ["limit"]);
  assert.equal(requests[0]!.url.searchParams.get("limit"), "250");
  assert.deepEqual([...requests[1]!.url.searchParams.keys()], [
    "platform",
    "limit",
  ]);
  assert.deepEqual([...requests[2]!.url.searchParams.keys()], [
    "platform",
    "limit",
  ]);
  assert.deepEqual([...requests[3]!.url.searchParams.keys()], [
    "platform",
    "limit",
    "cursor",
  ]);
  assert.equal(requests[3]!.url.searchParams.get("cursor"), opaqueCursor);
  for (const { init } of requests) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    const headers = new Headers(init.headers);
    assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization"]);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("authorization"), "Bearer fixture-secret-never-returned");
  }
});

test("a legacy adapter instance refuses the current v3 interpretation pin", async () => {
  const httpClient = async () =>
    jsonResponse(dataforestEventsV1EvidenceFixture.collector_crypt.initial);
  const v1 = adapterWithClient(
    httpClient,
    dataforrestEventsV1LegacySourceAdapterManifest,
  );
  const testRuntime = runtime();
  const operation = await pageOperation(
    testRuntime,
    "collector_crypt",
    null,
    bounds,
    {
      adapterVersion: DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    },
  );
  const captured = await successfulCapture(v1, operation);
  const interpreted = await v1.interpretPage(
    {
      ...sourceAdapterInterpretationContextOf(operation),
      adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    },
    captured,
  );
  assert.equal(interpreted.ok, false);
  if (!interpreted.ok) {
    assert.equal(interpreted.failure.code, "invalid_source_configuration");
    assert.equal(interpreted.diagnostics[0]?.code, "adapter_pin_mismatch");
  }
  operation.requestLease.close();
});

test("all four filters normalize initial, continuation, replay, empty, and poll-after pages independently", async () => {
  const mappers = createProviderObservationMapperRegistryFromManifest();
  for (const provider of [
    "courtyard",
    "collector_crypt",
    "phygitals",
    "clutchpacks",
  ] as const) {
    const pages = dataforestEventsV1EvidenceFixture[provider];
    const initialAdapter = adapterWithClient(async () =>
      jsonResponse(pages.initial)
    );
    const initialRuntime = runtime();
    const initial = await pageOperation(initialRuntime, provider, null);
    const first = await completedPage(initialAdapter, initial);
    assert.equal(first.ok, true);
    if (!first.ok) continue;
    assert.equal(first.value.normalizedPage.provider, provider);
    assert.equal(first.value.normalizedPage.outcomes.length, 4);
    assert.equal(first.value.protectedNativeEvidence.length, 5);
    assert.equal(
      first.value.protectedNativeEvidence.some(({ reference }) =>
        reference.endsWith(":transaction")
      ),
      true,
    );
    assert.deepEqual(first.value.normalizedPage.continuation, { kind: "continue" });
    if (provider === "collector_crypt") {
      const packOutcome = first.value.normalizedPage.outcomes[0];
      assert.equal(packOutcome?.status, "valid");
      if (packOutcome?.status !== "valid") {
        assert.fail("expected a valid Collector Crypt pack observation");
      }
      assert.equal(packOutcome.observation.kind, "catalog");
      if (packOutcome.observation.kind !== "catalog") {
        assert.fail("expected a Collector Crypt catalog observation");
      }
      assert.equal(packOutcome.observation.entity, "pack");
      assert.deepEqual(packOutcome.observation.providerFacts.displayName, {
        state: "present",
        value: "Collector Crypt Fixture Pack",
      });
      assert.equal(
        JSON.stringify(packOutcome.observation.providerFacts).includes(
          "ignored_native_field",
        ),
        false,
      );
      const mapped = mappers.map(
        mapperInput("collector_crypt", packOutcome.observation),
      );
      assert.equal(mapped.status, "mapped");
      if (mapped.status !== "mapped") {
        assert.fail("expected an accepted Collector Crypt pack candidate");
      }
      assert.equal(mapped.candidate.candidateKind, "pack");
      assert.equal(
        mapped.candidate.candidateKind === "pack"
          ? mapped.candidate.displayName
          : null,
        "Collector Crypt Fixture Pack",
      );
    }

    const cursor = first.value.normalizedPage.nextCursor.value;
    initial.requestLease.close();
    const resumedRequests: URL[] = [];
    const resumedAdapter = adapterWithClient(async (url) => {
      resumedRequests.push(new URL(url));
      const requestedCursor = url.searchParams.get("cursor");
      if (requestedCursor === cursor) return jsonResponse(pages.continuation);
      if (requestedCursor === pages.continuation.next_cursor) {
        return jsonResponse(pages.reachedHead);
      }
      return jsonResponse(null, 400);
    });
    const resumedRuntime = runtime();
    const restart = await pageOperation(resumedRuntime, provider, cursor);
    const restarted = await completedPage(resumedAdapter, restart);
    assert.equal(restarted.ok, true);
    if (restarted.ok) {
      assert.equal(restarted.value.normalizedPage.outcomes.length, 2);
      assert.equal(resumedRequests[0]?.searchParams.get("cursor"), cursor);
    }
    restart.requestLease.close();
    const replay = await pageOperation(resumedRuntime, provider, cursor);
    const replayed = await completedPage(resumedAdapter, replay);
    assert.equal(replayed.ok, true);
    if (restarted.ok && replayed.ok) {
      assert.deepEqual(
        replayed.value.normalizedPage.outcomes,
        restarted.value.normalizedPage.outcomes,
      );
    }
    replay.requestLease.close();

    const headCursor = restarted.ok
      ? restarted.value.normalizedPage.nextCursor.value
      : null;
    const atHead = await pageOperation(resumedRuntime, provider, headCursor);
    const empty = await completedPage(resumedAdapter, atHead);
    assert.equal(empty.ok, true);
    if (empty.ok) {
      assert.equal(empty.value.normalizedPage.outcomes.length, 0);
      assert.deepEqual(empty.value.normalizedPage.continuation, {
        kind: "poll_after",
        minimumDelaySeconds: 60,
      });
      assert.equal(empty.value.normalizedPage.nextCursor.value, headCursor);
    }
    atHead.requestLease.close();
  }
});

test("record-local defects remain ordered while wrapper and continuation defects are fatal", async () => {
  const valid = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0];
  const validTrade =
    dataforestEventsV1EvidenceFixture.courtyard.initial.records[3];
  const { entity: _entity, ...missingEntity } = valid;
  void _entity;
  const mixedPage = {
    records: [
      valid,
      { ...valid, record_id: "" },
      { ...valid, stream: "unknown" },
      { ...valid, platform: "phygitals" },
      { ...valid, occurred_at: "not-a-timestamp" },
      missingEntity,
      { ...validTrade, currency: "usd" },
    ],
    next_cursor: "mixed-cursor-next",
    poll_after_seconds: 0,
  };
  const fatalPages = [
    { ...mixedPage, records: [], has_more: true },
    { catalog: [], pulls: [], trades: [], next_cursor: "legacy" },
    { ...mixedPage, records: [], poll_after_seconds: 1 },
  ];
  const responses = [mixedPage, ...fatalPages];
  const adapter = adapterWithClient(async () => jsonResponse(responses.shift()));
  const testRuntime = runtime();
  const mixedOperation = await pageOperation(testRuntime, "courtyard", null);
  const mixed = await completedPage(adapter, mixedOperation);
  assert.equal(mixed.ok, true);
  if (mixed.ok) {
    assert.deepEqual(
      mixed.value.normalizedPage.outcomes.map((outcome) =>
        outcome.status === "valid" ? "valid" : outcome.reasonCode
      ),
      [
        "valid",
        "missing_identity",
        "unknown_stream",
        "platform_mismatch",
        "invalid_timestamp",
        "missing_required_fields",
        "invalid_field_values",
      ],
    );
    const unnormalizableTrade = mixed.value.normalizedPage.outcomes[6];
    assert.equal(unnormalizableTrade?.status, "invalid");
    if (unnormalizableTrade?.status === "invalid") {
      assert.deepEqual(unnormalizableTrade.fieldPaths, ["currency"]);
    }
    assert.equal(mixed.value.protectedNativeEvidence.length, 7);
  }
  mixedOperation.requestLease.close();

  responses.unshift(mixedPage);
  const sourceTest = await sourceOperation(testRuntime, "courtyard");
  const sourceCapture = await successfulCapture(adapter, sourceTest);
  const sourceInterpretation = await interpretSourceAdapterSourceTest(
    adapter,
    sourceTest,
    sourceCapture,
  );
  assert.equal(sourceInterpretation.ok, false);
  if (!sourceInterpretation.ok) {
    assert.equal(sourceInterpretation.failure.code, "invalid_response");
  }
  assert.equal(sourceInterpretation.recordCount, 7);
  assert.deepEqual(
    sourceInterpretation.diagnostics.map(({ code }) => code),
    ["source_records_invalid"],
  );
  sourceTest.requestLease.close();

  for (const [index] of fatalPages.entries()) {
    const operation = await pageOperation(testRuntime, "courtyard", null);
    const captured = await successfulCapture(adapter, operation);
    const interpreted = await interpretSourceAdapterPage(
      adapter,
      operation,
      captured,
    );
    assert.equal(interpreted.ok, false, `fatal page ${index}`);
    if (!interpreted.ok) {
      assert.equal(interpreted.failure.code, "invalid_response");
      assert.equal(interpreted.failure.disposition, "source_action_required");
    }
    operation.requestLease.close();
  }

  const stalledAdapter = adapterWithClient(async () => jsonResponse({
    records: [],
    next_cursor: "same-cursor",
    poll_after_seconds: 0,
  }));
  const stalled = await pageOperation(testRuntime, "courtyard", "same-cursor");
  const captured = await successfulCapture(stalledAdapter, stalled);
  const interpreted = await interpretSourceAdapterPage(
    stalledAdapter,
    stalled,
    captured,
  );
  assert.equal(interpreted.ok, false);
  if (!interpreted.ok) assert.equal(interpreted.failure.code, "invalid_cursor");
  stalled.requestLease.close();

  const boundedAdapter = adapterWithClient(async () => jsonResponse({
    records: [valid, valid],
    next_cursor: "bounded-next",
    poll_after_seconds: 0,
  }));
  const bounded = await pageOperation(testRuntime, "courtyard", null, {
    ...bounds,
    pageLimit: 1,
  });
  const boundedCapture = await successfulCapture(boundedAdapter, bounded);
  const boundedResult = await interpretSourceAdapterPage(
    boundedAdapter,
    bounded,
    boundedCapture,
  );
  assert.equal(boundedResult.ok, false);
  if (!boundedResult.ok) assert.equal(boundedResult.failure.code, "invalid_response");
  bounded.requestLease.close();

  const invalidUtfAdapter = adapterWithClient(async () =>
    new Response(new Uint8Array([0xc3, 0x28]))
  );
  const invalidUtf = await pageOperation(testRuntime, "courtyard", null);
  const invalidUtfCapture = await successfulCapture(invalidUtfAdapter, invalidUtf);
  const invalidUtfResult = await interpretSourceAdapterPage(
    invalidUtfAdapter,
    invalidUtf,
    invalidUtfCapture,
  );
  assert.equal(invalidUtfResult.ok, false);
  if (!invalidUtfResult.ok) {
    assert.equal(invalidUtfResult.failure.code, "invalid_response");
  }
  invalidUtf.requestLease.close();
});

test("raw capture, lease cancellation, mismatch, and reuse fail closed without extra upstream calls", async () => {
  let requestCount = 0;
  const adapter = adapterWithClient(async () => {
    requestCount += 1;
    return jsonResponse(dataforestEventsV1EvidenceFixture.courtyard.initial);
  });
  const testRuntime = runtime();

  const direct = await pageOperation(testRuntime, "courtyard", null);
  assert.throws(
    () => new SourceAdapterCaptureInvocation(Symbol("forged"), direct),
    (error) =>
      error instanceof SourceAdapterContractError &&
      error.code === "invalid_request_capture",
  );
  for (const forgedInvocation of [
    undefined,
    Object.freeze({ consume: () => undefined }),
  ]) {
    const directResult = await adapter.captureUnboundRequest(
      direct,
      forgedInvocation as never,
    );
    assert.equal(directResult.ok, false);
    if (!directResult.ok) {
      assert.deepEqual(directResult.failure, {
        disposition: "cancelled",
        code: "lost_ownership",
      });
    }
  }
  assert.equal(direct.requestLease.state, "available");
  assert.equal(direct.requestLease.requestPermitHeld, true);
  assert.equal(requestCount, 0);
  direct.requestLease.close();

  await assert.rejects(
    captureAndTerminalizeSourceAdapterRequest(
      testRuntime.authority,
      adapter,
      { operationKind: "page_read" } as PageReadOperation,
      acknowledgeTerminalization,
    ),
    (error) =>
      error instanceof SourceAdapterContractError &&
      error.code === "invalid_operation_shape",
  );
  assert.equal(requestCount, 0);

  const cancelled = await pageOperation(testRuntime, "courtyard", null);
  adapter.cancelRequest(cancelled.requestLease);
  await assert.rejects(
    captureRequest(adapter, cancelled),
    (error) =>
      error instanceof SourceRequestLeaseError && error.code === "cancelled",
  );
  assert.equal(requestCount, 0);

  const once = await pageOperation(testRuntime, "courtyard", null);
  await successfulCapture(adapter, once);
  await assert.rejects(
    captureRequest(adapter, once),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "already_consumed",
  );
  assert.equal(requestCount, 1);
  once.requestLease.close();

  const mismatch = await pageOperation(testRuntime, "courtyard", null);
  const { abortSignal: _abortSignal, ...mismatchInput } = mismatch;
  void _abortSignal;
  const mismatchedOperations = [
    createPageReadOperation({
      ...mismatchInput,
      sourceRevisionId: "wrong-revision",
      correlation: {
        ...mismatch.correlation,
        requestedCursor: {
          ...mismatch.correlation.requestedCursor,
          sourceRevisionId: "wrong-revision",
        },
      },
    }),
    createPageReadOperation({
      ...mismatchInput,
      connectionProfileRevisionId: "wrong-profile-revision",
    }),
    createPageReadOperation({
      ...mismatchInput,
      correlation: {
        ...mismatch.correlation,
        singletonFencingEpoch: 8,
      },
    }),
    createPageReadOperation({
      ...mismatchInput,
      correlation: {
        ...mismatch.correlation,
        connectionHealthGeneration: 4,
      },
    }),
    createPageReadOperation({
      ...mismatchInput,
      correlation: {
        ...mismatch.correlation,
        cursorGeneration: 2,
        requestedCursor: {
          ...mismatch.correlation.requestedCursor,
          cursorGeneration: 2,
        },
      },
    }),
  ];
  for (const mismatchedOperation of mismatchedOperations) {
    await assert.rejects(
      captureAndTerminalizeSourceAdapterRequest(
        testRuntime.authority,
        adapter,
        mismatchedOperation,
        acknowledgeTerminalization,
      ),
      (error) =>
        error instanceof SourceRequestLeaseError &&
        error.code === "pin_mismatch",
    );
  }
  assert.equal(requestCount, 1);
  mismatch.requestLease.close();

  const staleRuntime = runtime();
  const stalePins: ConnectionTestRequestPins = {
    ...commonPins,
    ...nextRequestIdentity("stale-connection"),
    operationKind: "connection_test",
    connectionTestJobId: "stale-job",
    jobClaimLeaseId: "stale-lease",
    recoveryEpisodeId: null,
  };
  await assert.rejects(
    staleRuntime.authority.admit({ pins: stalePins, guard: () => false }),
    (error) =>
      error instanceof SourceRequestLeaseError &&
      error.code === "lost_ownership",
  );
  assert.equal(requestCount, 1);
});

test("status, redirect, TLS, and network failures are stable and redact protected values", async () => {
  const cases = [
    { status: 401, code: "authentication_failed" },
    { status: 403, code: "authorization_failed" },
    { status: 408, code: "request_timeout" },
    { status: 429, code: "rate_limited" },
    { status: 503, code: "server_failure" },
    { status: 302, code: "destination_rejected" },
  ] as const;
  for (const { status, code } of cases) {
    const adapter = adapterWithClient(async () => jsonResponse(null, status));
    const operation = await pageOperation(
      runtime(),
      "courtyard",
      "protected-cursor-never-returned",
    );
    const result = await captureRequest(adapter, operation);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.code, code);
      assert.equal(sourceAdapterFailureSchema.safeParse(result.failure).success, true);
    }
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("fixture-secret-never-returned"), false);
    assert.equal(serialized.includes("protected-cursor-never-returned"), false);
    assert.equal(serialized.includes(DATAFORREST_EVENTS_V1_ENDPOINT), false);
    operation.requestLease.close();
  }

  const protectedMessage =
    "TLS failure fixture-secret-never-returned protected-cursor-never-returned";
  const tlsAdapter = adapterWithClient(async () => {
    const error = new Error(protectedMessage) as NodeJS.ErrnoException;
    error.code = "ERR_TLS_CERT_ALTNAME_INVALID";
    throw error;
  });
  const tlsOperation = await pageOperation(
    runtime(),
    "courtyard",
    "protected-cursor-never-returned",
  );
  const tlsResult = await captureRequest(tlsAdapter, tlsOperation);
  assert.equal(tlsResult.ok, false);
  if (!tlsResult.ok) assert.equal(tlsResult.failure.code, "tls_failed");
  assert.equal(JSON.stringify(tlsResult).includes(protectedMessage), false);
  tlsOperation.requestLease.close();
});

test("fixed endpoint 404, 405, and 410 failures block the connection for every operation", async () => {
  for (const status of [404, 405, 410]) {
    const adapter = adapterWithClient(async () => jsonResponse(null, status));
    const operations = [
      await connectionOperation(runtime()),
      await sourceOperation(runtime(), "courtyard"),
      await pageOperation(runtime(), "courtyard", null),
    ];
    for (const operation of operations) {
      const result = await captureRequest(adapter, operation);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.deepEqual(result.failure, {
          disposition: "connection_action_required",
          code: "endpoint_invalid",
          safeStatus: status,
        });
      }
      operation.requestLease.close();
    }
  }
});

test("deep sub-2MiB JSON fails as one sanitized operation-appropriate result", async () => {
  const protectedMarker = "deep-provider-secret-must-not-cross";
  let nested: unknown = { protectedMarker };
  for (let depth = 0; depth < 256; depth += 1) nested = { nested };
  const record = {
    ...dataforestEventsV1EvidenceFixture.courtyard.initial.records[0],
    data: nested,
  };
  const deepPage = {
    records: [record],
    next_cursor: "deep-page-next",
    poll_after_seconds: 60,
  };
  const rawPage = JSON.stringify(deepPage);
  assert.equal(new TextEncoder().encode(rawPage).byteLength < 2_097_152, true);
  const adapter = adapterWithClient(async () => new Response(rawPage));
  const testRuntime = runtime();

  const connection = await connectionOperation(testRuntime);
  const connectionRequest = await successfulCapture(adapter, connection);
  const connectionResult = await interpretSourceAdapterConnectionTest(
    adapter,
    connection,
    connectionRequest,
  );
  assert.equal(connectionResult.ok, false);
  if (!connectionResult.ok) {
    assert.equal(connectionResult.failure.code, "profile_configuration_invalid");
  }
  assert.equal(JSON.stringify(connectionResult).includes(protectedMarker), false);
  connection.requestLease.close();

  const source = await sourceOperation(testRuntime, "courtyard");
  const sourceRequest = await successfulCapture(adapter, source);
  const sourceResult = await interpretSourceAdapterSourceTest(
    adapter,
    source,
    sourceRequest,
  );
  assert.equal(sourceResult.ok, false);
  if (!sourceResult.ok) assert.equal(sourceResult.failure.code, "invalid_response");
  assert.equal(JSON.stringify(sourceResult).includes(protectedMarker), false);
  source.requestLease.close();

  const page = await pageOperation(testRuntime, "courtyard", null);
  const pageRequest = await successfulCapture(adapter, page);
  const pageResult = await interpretSourceAdapterPage(
    adapter,
    page,
    pageRequest,
  );
  assert.equal(pageResult.ok, false);
  if (!pageResult.ok) assert.equal(pageResult.failure.code, "invalid_response");
  assert.equal(JSON.stringify(pageResult).includes(protectedMarker), false);
  page.requestLease.close();
});

test("adversarial structural limits reject before materializing the provider tree", async () => {
  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const currentBounds = dataforrestEventsV1SourceAdapterManifest.requestBounds;
  const placeholder = "packscout-raw-json-placeholder";
  const rawPageWithData = (rawData: string) =>
    JSON.stringify({
      records: [{ ...base, data: placeholder }],
      next_cursor: "adversarial-page-next",
      poll_after_seconds: 0,
    }).replace(JSON.stringify(placeholder), rawData);
  const adversarialPages = [
    rawPageWithData(`{"nested":${"[".repeat(100_000)}0${"]".repeat(100_000)}}`),
    rawPageWithData(`{"native_facts":[${"0,".repeat(5_000)}0]}`),
    JSON.stringify({
      records: Array.from({ length: 500 }, (_, recordIndex) => ({
        ...base,
        record_id: `node-limit-card-${recordIndex}`,
        data: {
          provider_label: `Node limit card ${recordIndex}`,
          native_facts: Array.from({ length: 950 }, () => ({})),
        },
      })),
      next_cursor: "node-limit-page-next",
      poll_after_seconds: 0,
    }),
  ];
  for (const [index, rawPage] of adversarialPages.entries()) {
    assert.equal(
      Buffer.byteLength(rawPage, "utf8") < currentBounds.maximumResponseBytes,
      true,
    );
    const adapter = adapterWithClient(async () => new Response(rawPage));
    const operation = await pageOperation(
      runtime(),
      "courtyard",
      null,
      currentBounds,
    );
    const capture = await successfulCapture(adapter, operation);
    const result = await interpretSourceAdapterPage(adapter, operation, capture);
    assert.equal(result.ok, false, `adversarial page ${index}`);
    if (!result.ok) {
      assert.deepEqual(result.failure, {
        disposition: "source_action_required",
        code: "invalid_response",
      });
    }
    operation.requestLease.close();
  }
});

test("sanitized 4,730,013-byte page covers the observed Phygitals node shape", async () => {
  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const records = Array.from({ length: 250 }, (_, recordIndex) => ({
    ...base,
    platform: "phygitals" as const,
    record_id: `data-rich-card-${recordIndex}`,
    data: {
      ...base.data,
      native_facts: Array.from(
        { length: recordIndex === 0 ? 929 : 718 },
        () => ({}),
      ),
      sanitized_padding: "",
    },
  }));
  const page = {
    records,
    next_cursor: "data-rich-next",
    poll_after_seconds: 0,
  };
  const targetBytes = 4_730_013;
  const unpaddedBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
  const paddingBytes = targetBytes - unpaddedBytes;
  assert.equal(paddingBytes > 0, true);
  const paddingPerRecord = Math.floor(paddingBytes / records.length);
  const extraPaddingRecords = paddingBytes % records.length;
  records.forEach((record, index) => {
    record.data.sanitized_padding = "x".repeat(
      paddingPerRecord + (index < extraPaddingRecords ? 1 : 0),
    );
  });
  const rawPage = JSON.stringify(page);
  assert.equal(Buffer.byteLength(rawPage, "utf8"), targetBytes);
  assert.equal(jsonNodeCount(JSON.parse(rawPage)), 183_215);
  const currentBounds = dataforrestEventsV1SourceAdapterManifest.requestBounds;
  const adapter = adapterWithClient(
    async () => new Response(rawPage),
    dataforrestEventsV1SourceAdapterManifest,
  );
  const operation = await pageOperation(
    runtime(),
    "phygitals",
    null,
    currentBounds,
    {
      adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    },
  );
  const capture = await successfulCapture(adapter, operation);
  assert.equal(capture.measurements.responseBytes, targetBytes);
  const result = await interpretSourceAdapterPage(adapter, operation, capture);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.normalizedPage.outcomes.length, 250);
  }
  operation.requestLease.close();
});

test("sanitized 5,672,975-byte page covers the second observed Phygitals node shape", async () => {
  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const records = Array.from({ length: 250 }, (_, recordIndex) => ({
    ...base,
    platform: "phygitals" as const,
    record_id: `second-data-rich-card-${recordIndex}`,
    data: {
      ...base.data,
      native_facts: Array.from(
        { length: recordIndex === 0 ? 1_005 : 845 },
        () => ({}),
      ),
      sanitized_padding: "",
    },
  }));
  const page = {
    records,
    next_cursor: "second-data-rich-next",
    poll_after_seconds: 0,
  };
  const targetBytes = 5_672_975;
  const unpaddedBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
  const paddingBytes = targetBytes - unpaddedBytes;
  assert.equal(paddingBytes > 0, true);
  const paddingPerRecord = Math.floor(paddingBytes / records.length);
  const extraPaddingRecords = paddingBytes % records.length;
  records.forEach((record, index) => {
    record.data.sanitized_padding = "x".repeat(
      paddingPerRecord + (index < extraPaddingRecords ? 1 : 0),
    );
  });
  const rawPage = JSON.stringify(page);
  assert.equal(Buffer.byteLength(rawPage, "utf8"), targetBytes);
  assert.equal(jsonNodeCount(JSON.parse(rawPage)), 214_914);
  const currentBounds = dataforrestEventsV1SourceAdapterManifest.requestBounds;
  const adapter = adapterWithClient(
    async () => new Response(rawPage),
    dataforrestEventsV1SourceAdapterManifest,
  );
  const operation = await pageOperation(
    runtime(),
    "phygitals",
    null,
    currentBounds,
    {
      adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    },
  );
  const capture = await successfulCapture(adapter, operation);
  assert.equal(capture.measurements.responseBytes, targetBytes);
  const result = await interpretSourceAdapterPage(adapter, operation, capture);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.normalizedPage.outcomes.length, 250);
  }
  operation.requestLease.close();
});

test("the 480,000-node boundary is accepted and one additional node is rejected", async () => {
  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const page = (additionalFirstRecordNodes: number) => ({
    records: Array.from({ length: 500 }, (_, recordIndex) => ({
      ...base,
      record_id: `node-boundary-card-${recordIndex}`,
      data: {
        ...base.data,
        native_facts: Array.from(
          {
            length: 945 +
              (recordIndex === 0 ? additionalFirstRecordNodes : 0),
          },
          () => ({}),
        ),
      },
    })),
    next_cursor: "node-boundary-next",
    poll_after_seconds: 0,
  });
  const acceptedPage = page(996);
  const rejectedPage = page(997);
  assert.equal(jsonNodeCount(acceptedPage), 480_000);
  assert.equal(jsonNodeCount(rejectedPage), 480_001);
  assert.equal(isBoundedDataforrestEventsPageV1(acceptedPage, 500), true);
  assert.equal(isBoundedDataforrestEventsPageV1(rejectedPage, 500), false);

  for (const [candidate, expected] of [
    [acceptedPage, true],
    [rejectedPage, false],
  ] as const) {
    const rawPage = JSON.stringify(candidate);
    assert.equal(
      Buffer.byteLength(rawPage, "utf8") < bounds.maximumResponseBytes,
      true,
    );
    const adapter = adapterWithClient(async () => new Response(rawPage));
    const operation = await pageOperation(
      runtime(),
      "courtyard",
      null,
      dataforrestEventsV1SourceAdapterManifest.requestBounds,
    );
    const capture = await successfulCapture(adapter, operation);
    const result = await interpretSourceAdapterPage(adapter, operation, capture);
    assert.equal(result.ok, expected);
    if (result.ok) {
      assert.equal(result.value.normalizedPage.outcomes.length, 500);
    } else {
      assert.deepEqual(result.failure, {
        disposition: "source_action_required",
        code: "invalid_response",
      });
    }
    operation.requestLease.close();
  }
});

test("the DataForrest events adapter captures valid pages above 4 MiB and rejects pages above 8 MiB", async () => {
  const formerMaximumResponseBytes = 4 * 1024 * 1024;
  const currentBounds = dataforrestEventsV1SourceAdapterManifest.requestBounds;
  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const page = (paddingLength: number) => JSON.stringify({
    records: Array.from({ length: 250 }, (_, recordIndex) => ({
      ...base,
      record_id: `large-card-${recordIndex}`,
      data: {
        ...base.data,
        native_payload: "x".repeat(paddingLength),
      },
    })),
    next_cursor: "large-page-next",
    poll_after_seconds: 0,
  });
  const acceptedRawPage = page(18_000);
  const acceptedBytes = Buffer.byteLength(acceptedRawPage, "utf8");
  assert.equal(acceptedBytes > formerMaximumResponseBytes, true);
  assert.equal(acceptedBytes <= currentBounds.maximumResponseBytes, true);

  const adapter = adapterWithClient(
    async () => new Response(acceptedRawPage),
    dataforrestEventsV1SourceAdapterManifest,
  );
  const adapterIdentity = {
    adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
  } as const;
  const acceptedOperation = await pageOperation(
    runtime(),
    "courtyard",
    null,
    currentBounds,
    adapterIdentity,
  );
  const capture = await successfulCapture(adapter, acceptedOperation);
  assert.equal(capture.measurements.responseBytes, acceptedBytes);
  const interpreted = await interpretSourceAdapterPage(
    adapter,
    acceptedOperation,
    capture,
  );
  assert.equal(interpreted.ok, true);
  if (interpreted.ok) {
    assert.equal(interpreted.value.normalizedPage.outcomes.length, 250);
  }
  acceptedOperation.requestLease.close();

  const rejectedRawPage = page(34_000);
  assert.equal(
    Buffer.byteLength(rejectedRawPage, "utf8") >
      currentBounds.maximumResponseBytes,
    true,
  );
  const rejectedAdapter = adapterWithClient(
    async () => new Response(rejectedRawPage),
    dataforrestEventsV1SourceAdapterManifest,
  );
  const rejectedOperation = await pageOperation(
    runtime(),
    "courtyard",
    null,
    currentBounds,
    adapterIdentity,
  );
  const rejected = await captureRequest(rejectedAdapter, rejectedOperation);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.deepEqual(rejected.failure, {
      disposition: "retryable",
      code: "response_too_large",
    });
    assert.equal(rejected.diagnostics[0]?.code, "response_too_large");
  }
  rejectedOperation.requestLease.close();
});

test("reserved JSON keys are rejected before provider evidence can be silently rewritten", async () => {
  const protectedMarker = "reserved-json-provider-secret-must-not-cross";
  for (const reservedKey of ["__proto__", "constructor", "prototype"]) {
    const data = JSON.parse(
      `{"provider_label":"fixture","${reservedKey}":{"marker":"${protectedMarker}"}}`,
    ) as Record<string, unknown>;
    assert.equal(Object.hasOwn(data, reservedKey), true);
    const rawPage = JSON.stringify({
      records: [{
        ...dataforestEventsV1EvidenceFixture.courtyard.initial.records[0],
        data,
      }],
      next_cursor: "reserved-key-next",
      poll_after_seconds: 60,
    });
    const adapter = adapterWithClient(async () => new Response(rawPage));
    const page = await pageOperation(runtime(), "courtyard", null);
    const request = await successfulCapture(adapter, page);
    const result = await interpretSourceAdapterPage(adapter, page, request);
    assert.equal(result.ok, false, reservedKey);
    if (!result.ok) {
      assert.deepEqual(result.failure, {
        disposition: "source_action_required",
        code: "invalid_response",
      });
    }
    assert.equal(JSON.stringify(result).includes(protectedMarker), false);
    page.requestLease.close();
  }

  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const placeholder = "packscout-escaped-reserved-placeholder";
  const escapedRawPage = JSON.stringify({
    records: [{ ...base, data: placeholder }],
    next_cursor: "escaped-reserved-key-next",
    poll_after_seconds: 0,
  }).replace(
    JSON.stringify(placeholder),
    `{"provider_label":"fixture","\\u005f\\u005fproto__":{"marker":"${protectedMarker}"}}`,
  );
  const escapedAdapter = adapterWithClient(
    async () => new Response(escapedRawPage),
  );
  const escapedOperation = await pageOperation(runtime(), "courtyard", null);
  const escapedCapture = await successfulCapture(
    escapedAdapter,
    escapedOperation,
  );
  const escapedResult = await interpretSourceAdapterPage(
    escapedAdapter,
    escapedOperation,
    escapedCapture,
  );
  assert.equal(escapedResult.ok, false);
  assert.equal(JSON.stringify(escapedResult).includes(protectedMarker), false);
  escapedOperation.requestLease.close();
});

test("duplicate members retain JSON last-write semantics within the parser-work bound", async () => {
  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const placeholder = "packscout-duplicate-member-placeholder";
  const rawPageWithData = (rawData: string) =>
    JSON.stringify({
      records: [{ ...base, data: placeholder }],
      next_cursor: "duplicate-member-next",
      poll_after_seconds: 0,
    }).replace(JSON.stringify(placeholder), rawData);

  const acceptedRawPage = rawPageWithData(
    '{"provider_label":"first","provider_label":"second"}',
  );
  const acceptedAdapter = adapterWithClient(
    async () => new Response(acceptedRawPage),
  );
  const acceptedOperation = await pageOperation(runtime(), "courtyard", null);
  const acceptedCapture = await successfulCapture(
    acceptedAdapter,
    acceptedOperation,
  );
  const accepted = await interpretSourceAdapterPage(
    acceptedAdapter,
    acceptedOperation,
    acceptedCapture,
  );
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    const evidence = accepted.value.protectedNativeEvidence[0] as unknown as {
      readonly value: Readonly<{
        data: Readonly<{ provider_label: string }>;
      }>;
    };
    assert.equal(evidence.value.data.provider_label, "second");
  }
  acceptedOperation.requestLease.close();

  const repeatedMembers = Array.from({ length: 257 }, (_, index) =>
    `"provider_label":"duplicate-${index}"`
  ).join(",");
  const rejectedRawPage = rawPageWithData(`{${repeatedMembers}}`);
  const rejectedAdapter = adapterWithClient(
    async () => new Response(rejectedRawPage),
  );
  const rejectedOperation = await pageOperation(runtime(), "courtyard", null);
  const rejectedCapture = await successfulCapture(
    rejectedAdapter,
    rejectedOperation,
  );
  const rejected = await interpretSourceAdapterPage(
    rejectedAdapter,
    rejectedOperation,
    rejectedCapture,
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.failure.code, "invalid_response");
  rejectedOperation.requestLease.close();
});

test("finite long numbers and astral UTF-8 split at the parser chunk retain JSON parity", async () => {
  const base = dataforestEventsV1EvidenceFixture.courtyard.initial.records[0]!;
  const placeholder = "packscout-parser-parity-placeholder";
  const rawPageWithData = (rawData: string, nextCursor: string) =>
    JSON.stringify({
      records: [{ ...base, data: placeholder }],
      next_cursor: nextCursor,
      poll_after_seconds: 0,
    }).replace(JSON.stringify(placeholder), rawData);

  const finiteNumberRawPage = rawPageWithData(
    `{"provider_label":"fixture","native_number":${"1".repeat(65)}}`,
    "finite-number-next",
  );
  const finiteNumberAdapter = adapterWithClient(
    async () => new Response(finiteNumberRawPage),
  );
  const finiteNumberOperation = await pageOperation(
    runtime(),
    "courtyard",
    null,
  );
  const finiteNumberCapture = await successfulCapture(
    finiteNumberAdapter,
    finiteNumberOperation,
  );
  const finiteNumberResult = await interpretSourceAdapterPage(
    finiteNumberAdapter,
    finiteNumberOperation,
    finiteNumberCapture,
  );
  assert.equal(finiteNumberResult.ok, true);
  if (finiteNumberResult.ok) {
    const evidence = finiteNumberResult.value.protectedNativeEvidence[0] as unknown as {
      readonly value: Readonly<{
        data: Readonly<{ native_number: number }>;
      }>;
    };
    assert.equal(Number.isFinite(evidence.value.data.native_number), true);
  }
  finiteNumberOperation.requestLease.close();

  const astralTemplate = rawPageWithData(
    `{"provider_label":"fixture","native_text":"${placeholder}"}`,
    "astral-next",
  );
  const encodedPlaceholder = JSON.stringify(placeholder);
  const placeholderIndex = astralTemplate.indexOf(encodedPlaceholder);
  assert.notEqual(placeholderIndex, -1);
  const prefixBytes = Buffer.byteLength(
    astralTemplate.slice(0, placeholderIndex),
    "utf8",
  );
  const emojiStartOffset = 64 * 1024 - 1;
  const paddingLength = emojiStartOffset - prefixBytes - 1;
  assert.ok(paddingLength > 0);
  const nativeText = `${"x".repeat(paddingLength)}🙂`;
  const astralRawPage = astralTemplate.replace(
    encodedPlaceholder,
    JSON.stringify(nativeText),
  );
  const emojiIndex = astralRawPage.indexOf("🙂");
  assert.equal(
    Buffer.byteLength(astralRawPage.slice(0, emojiIndex), "utf8"),
    emojiStartOffset,
  );
  const astralAdapter = adapterWithClient(
    async () => new Response(astralRawPage),
  );
  const astralOperation = await pageOperation(runtime(), "courtyard", null);
  const astralCapture = await successfulCapture(astralAdapter, astralOperation);
  const astralResult = await interpretSourceAdapterPage(
    astralAdapter,
    astralOperation,
    astralCapture,
  );
  assert.equal(astralResult.ok, true);
  if (astralResult.ok) {
    const evidence = astralResult.value.protectedNativeEvidence[0] as unknown as {
      readonly value: Readonly<{
        data: Readonly<{ native_text: string }>;
      }>;
    };
    assert.equal(evidence.value.data.native_text, nativeText);
  }
  astralOperation.requestLease.close();
});

test("DataForrest request and returned cursors enforce the shared 16 KiB UTF-8 cap", async () => {
  const exactCursor = "é".repeat(8_192);
  const oversizedCursor = `${exactCursor}a`;
  let requestCount = 0;
  const adapter = adapterWithClient(async (url) => {
    requestCount += 1;
    assert.equal(url.searchParams.get("cursor"), exactCursor);
    return jsonResponse(dataforestEventsV1EvidenceFixture.courtyard.reachedHead);
  });
  const exact = await pageOperation(runtime(), "courtyard", exactCursor);
  await successfulCapture(adapter, exact);
  assert.equal(requestCount, 1);
  exact.requestLease.close();

  await assert.rejects(
    pageOperation(runtime(), "courtyard", oversizedCursor),
    (error) =>
      error instanceof SourceRequestLeaseError && error.code === "invalid_pins",
  );
  assert.equal(requestCount, 1);

  const whitespace = await pageOperation(runtime(), "courtyard", " \t ");
  const whitespaceResult = await captureRequest(adapter, whitespace);
  assert.equal(whitespaceResult.ok, false);
  if (!whitespaceResult.ok) {
    assert.deepEqual(whitespaceResult.failure, {
      disposition: "source_action_required",
      code: "invalid_cursor",
    });
  }
  assert.equal(requestCount, 1);
  whitespace.requestLease.close();

  const oversizedResponseAdapter = adapterWithClient(async () => jsonResponse({
    records: [],
    next_cursor: oversizedCursor,
    poll_after_seconds: 60,
  }));
  const responseOperation = await pageOperation(runtime(), "courtyard", null);
  const responseRequest = await successfulCapture(
    oversizedResponseAdapter,
    responseOperation,
  );
  const responseResult = await interpretSourceAdapterPage(
    oversizedResponseAdapter,
    responseOperation,
    responseRequest,
  );
  assert.equal(responseResult.ok, false);
  if (!responseResult.ok) {
    assert.deepEqual(responseResult.failure, {
      disposition: "source_action_required",
      code: "invalid_response",
    });
  }
  responseOperation.requestLease.close();
});

test("DataForrest rejects cursor text that cannot be persisted losslessly", async () => {
  let upstreamCalls = 0;
  const uncalledAdapter = adapterWithClient(async () => {
    upstreamCalls += 1;
    throw new Error("invalid requested cursor reached the provider");
  });
  const invalidCursors = [
    "cursor\u0000value",
    "cursor-\ud800-value",
    "cursor-\udfff-value",
  ];

  for (const invalidCursor of invalidCursors) {
    await assert.rejects(
      async () => {
        const operation = await pageOperation(
          runtime(),
          "courtyard",
          invalidCursor,
        );
        try {
          await successfulCapture(uncalledAdapter, operation);
        } finally {
          operation.requestLease.close();
        }
      },
      (error) =>
        error instanceof SourceRequestLeaseError &&
        error.code === "invalid_pins",
    );
  }
  assert.equal(upstreamCalls, 0);

  for (const invalidCursor of invalidCursors) {
    const responseAdapter = adapterWithClient(async () => jsonResponse({
      records: [],
      next_cursor: invalidCursor,
      poll_after_seconds: 60,
    }));
    const operation = await pageOperation(runtime(), "courtyard", null);
    const request = await successfulCapture(responseAdapter, operation);
    const result = await interpretSourceAdapterPage(
      responseAdapter,
      operation,
      request,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.failure, {
        disposition: "source_action_required",
        code: "invalid_response",
      });
    }
    operation.requestLease.close();
  }

  const astralCursor = "cursor-🙂-value";
  const astralAdapter = adapterWithClient(async (url) => {
    assert.equal(url.searchParams.get("cursor"), astralCursor);
    return jsonResponse({
      records: [],
      next_cursor: astralCursor,
      poll_after_seconds: 60,
    });
  });
  const astralOperation = await pageOperation(
    runtime(),
    "courtyard",
    astralCursor,
  );
  const astralResult = await completedPage(astralAdapter, astralOperation);
  assert.equal(astralResult.ok, true);
  if (astralResult.ok) {
    assert.equal(
      astralResult.value.normalizedPage.nextCursor.value,
      astralCursor,
    );
  }
  astralOperation.requestLease.close();

  const escapedAstralRaw =
    '{"records":[],"next_cursor":"cursor-\\ud83d\\ude42-value","poll_after_seconds":60}';
  const escapedAstralAdapter = adapterWithClient(
    async () => new Response(escapedAstralRaw),
  );
  const escapedAstralOperation = await pageOperation(
    runtime(),
    "courtyard",
    null,
  );
  const escapedAstralResult = await completedPage(
    escapedAstralAdapter,
    escapedAstralOperation,
  );
  assert.equal(escapedAstralResult.ok, true);
  if (escapedAstralResult.ok) {
    assert.equal(
      escapedAstralResult.value.normalizedPage.nextCursor.value,
      "cursor-🙂-value",
    );
  }
  escapedAstralOperation.requestLease.close();
});

test("two platform reads overlap without sharing filters, cursors, or results", async () => {
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  let bothStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const adapter = adapterWithClient(async (url) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 2) bothStarted();
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    const platform = url.searchParams.get("platform") as LaunchProviderKey;
    return jsonResponse(dataforestEventsV1EvidenceFixture[platform].initial);
  });
  const testRuntime = runtime(2);
  const courtyard = await pageOperation(testRuntime, "courtyard", null);
  const phygitals = await pageOperation(testRuntime, "phygitals", null);
  const courtyardCapture = captureRequest(adapter, courtyard);
  const phygitalsCapture = captureRequest(adapter, phygitals);
  await ready;
  assert.equal(maximumActive, 2);
  for (const release of releases) release();
  const [courtyardRequest, phygitalsRequest] = await Promise.all([
    courtyardCapture,
    phygitalsCapture,
  ]);
  assert.equal(courtyardRequest.ok, true);
  assert.equal(phygitalsRequest.ok, true);
  if (courtyardRequest.ok && phygitalsRequest.ok) {
    const [courtyardPage, phygitalsPage] = await Promise.all([
      interpretSourceAdapterPage(
        adapter,
        courtyard,
        courtyardRequest,
      ),
      interpretSourceAdapterPage(
        adapter,
        phygitals,
        phygitalsRequest,
      ),
    ]);
    assert.equal(courtyardPage.ok, true);
    assert.equal(phygitalsPage.ok, true);
    if (courtyardPage.ok && phygitalsPage.ok) {
      assert.equal(courtyardPage.value.normalizedPage.provider, "courtyard");
      assert.equal(phygitalsPage.value.normalizedPage.provider, "phygitals");
      assert.notDeepEqual(
        courtyardPage.value.normalizedPage.outcomes,
        phygitalsPage.value.normalizedPage.outcomes,
      );
    }
  }
  courtyard.requestLease.close();
  phygitals.requestLease.close();
});

test("connection and source tests validate pages without inventing durable cursor state", async () => {
  const adapter = adapterWithClient(async () =>
    jsonResponse(dataforestEventsV1EvidenceFixture.courtyard.initial)
  );
  const testRuntime = runtime();
  const connection = await connectionOperation(testRuntime);
  const connectionCapture = await successfulCapture(adapter, connection);
  const connectionResult = await interpretSourceAdapterConnectionTest(
    adapter,
    connection,
    connectionCapture,
  );
  assert.equal(connectionResult.ok, true);
  assert.equal("nextCursor" in connectionResult, false);
  assert.equal(connectionResult.recordCount, 0);

  const source = await sourceOperation(testRuntime, "courtyard");
  const sourceCapture = await successfulCapture(adapter, source);
  const sourceResult = await interpretSourceAdapterSourceTest(
    adapter,
    source,
    sourceCapture,
  );
  assert.equal(sourceResult.ok, true);
  assert.equal("nextCursor" in sourceResult, false);
  assert.equal(sourceResult.recordCount, 4);
  connection.requestLease.close();
  source.requestLease.close();
});

test("malformed responses cannot be promoted across source and connection failure dispositions", async () => {
  const adapter = adapterWithClient(async () => jsonResponse({
    records: [],
    next_cursor: "cursor",
    poll_after_seconds: 60,
    has_more: false,
  }));
  const testRuntime = runtime();
  const connection = await connectionOperation(testRuntime);
  const connectionCapture = await successfulCapture(adapter, connection);
  const connectionResult = await interpretSourceAdapterConnectionTest(
    adapter,
    connection,
    connectionCapture,
  );
  assert.equal(connectionResult.ok, false);
  if (!connectionResult.ok) {
    assert.deepEqual(connectionResult.failure, {
      disposition: "connection_action_required",
      code: "profile_configuration_invalid",
    });
    assert.equal(
      sourceAdapterFailureSchema.safeParse({
        ...connectionResult.failure,
        disposition: "source_action_required",
      }).success,
      false,
    );
    assert.equal(
      sourceAdapterFailureSchema.safeParse({
        ...connectionResult.failure,
        disposition: "retryable",
      }).success,
      false,
    );
  }
  connection.requestLease.close();

  const page = await pageOperation(testRuntime, "courtyard", null);
  const pageCapture = await successfulCapture(adapter, page);
  const pageResult = await interpretSourceAdapterPage(
    adapter,
    page,
    pageCapture,
  );
  assert.equal(pageResult.ok, false);
  if (!pageResult.ok) {
    assert.deepEqual(pageResult.failure, {
      disposition: "source_action_required",
      code: "invalid_response",
    });
    assert.equal(
      sourceAdapterFailureSchema.safeParse({
        ...pageResult.failure,
        disposition: "connection_action_required",
      }).success,
      false,
    );
  }
  page.requestLease.close();
});

test("configuration validation is immutable and rejects filter or credential injection", () => {
  const adapter = new DataforrestEventsSourceAdapter();
  const connection = adapter.validateConnectionConfiguration(
    connectionConfiguration,
  );
  assert.equal(connection.ok, true);
  if (connection.ok) assert.equal(Object.isFrozen(connection.value), true);
  for (const bearerToken of [" token", "token\r\nInjected: true", "token\0"]) {
    assert.equal(adapter.validateConnectionConfiguration({
      ...connectionConfiguration,
      bearerToken,
    }).ok, false);
  }
  assert.equal(adapter.validateSourceConfiguration("courtyard", {
    platform: "phygitals",
  }).ok, false);
  assert.equal(adapter.validateConnectionConfiguration({
    ...connectionConfiguration,
    endpoint: "https://198.204.245.26.sslip.io.attacker.invalid/v1/events",
  }).ok, false);
  assert.equal(adapter.validateSourceConfiguration("courtyard", {
    platform: "courtyard",
    stream: "trades",
  }).ok, false);
});
