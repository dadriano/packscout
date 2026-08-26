import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  normalizedProviderObservationPageSchema,
  providerIdentityNamespaceByLaunchProvider,
  type ProviderSourcePageCommitPins,
} from "@packscout/contracts";
import { OpaqueCursorGuard } from "./opaque-cursor-guard.ts";
import {
  ProviderSourcePageImportError,
  ProviderSourcePageImportService,
  type ProviderSourceAtomicPagePersistenceInput,
} from "./provider-source-page-import-service.ts";
import { ProviderSourcePagePlanner } from "./provider-source-page-planner.ts";
import {
  StaticCapturedPageSourceAdapter,
  completeAuthenticPageReadForTest,
} from "./source-adapter-page-result.test-support.ts";
import { createProviderObservationMapperRegistryFromManifest } from "./providers/provider-mapper-manifest.ts";
import {
  descriptorFor,
  packObservation,
} from "./providers/provider-observation-mapper.test-support.ts";

const fingerprintKey = new Uint8Array(32).fill(7);

async function fixture(continuation: "continue" | "poll_after" = "continue") {
  const descriptor = descriptorFor("courtyard");
  const requestedCursor = {
    sourceInstanceId: "source-courtyard",
    sourceRevisionId: "revision-courtyard",
    sourceTypeKey: "dataforrest-events-v1",
    adapterVersion: "dataforrest-events-v1",
    cursorCodecKey: "dataforrest-events-cursor-v1",
    cursorGeneration: 1,
    value: continuation === "continue" ? "cursor-a" : null,
  } as const;
  const nextCursor = {
    ...requestedCursor,
    value: continuation === "continue" ? "cursor-b" : null,
  };
  const guard = new OpaqueCursorGuard(fingerprintKey);
  const requestedCursorFingerprint = requestedCursor.value === null
    ? null
    : guard.fingerprint(requestedCursor);
  const pins: ProviderSourcePageCommitPins = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    providerId: "00000000-0000-4000-8000-000000000002",
    provider: "courtyard",
    sourceInstanceId: requestedCursor.sourceInstanceId,
    sourceRevisionId: requestedCursor.sourceRevisionId,
    sourceTypeKey: requestedCursor.sourceTypeKey,
    sourceAdapterVersion: requestedCursor.adapterVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    identityNamespaceKey:
      providerIdentityNamespaceByLaunchProvider.courtyard,
    connectionProfileId: "00000000-0000-4000-8000-000000000003",
    connectionRevisionId: "00000000-0000-4000-8000-000000000004",
    connectionHealthGeneration: 3n,
    requestAttemptId: "00000000-0000-4000-8000-000000000005",
    requestLeaseId: "00000000-0000-4000-8000-000000000006",
    supervisorEpochId: "00000000-0000-4000-8000-000000000007",
    singletonFencingEpoch: 7,
    supervisorOwnerKey: "worker-one",
    supervisorLeaseToken: "00000000-0000-4000-8000-000000000008",
    runId: "00000000-0000-4000-8000-000000000009",
    runTrigger: "manual",
    runLeaseOwner: "worker-one",
    runLeaseToken: "00000000-0000-4000-8000-000000000010",
    runClaimLeaseId: "00000000-0000-4000-8000-000000000010",
    pageId: "00000000-0000-4000-8000-000000000011",
    pageNumber: 1,
    cursorCodecVersion: requestedCursor.cursorCodecKey,
    cursorGeneration: 1n,
    requestedCursor,
    requestedCursorFingerprint,
  };
  const raw = new TextEncoder().encode("sanitized-page");
  const page = normalizedProviderObservationPageSchema.parse({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider: "courtyard",
    outcomes: [
      { status: "valid", recordIndex: 0, observation: packObservation() },
    ],
    nextCursor,
    continuation: continuation === "continue"
      ? { kind: "continue" }
      : { kind: "poll_after", minimumDelaySeconds: 60 },
    measurements: {
      durationMilliseconds: 9,
      responseBytes: raw.byteLength,
      recordCount: 1,
    },
    diagnostics: [],
  });
  const protectedNativeEvidence = Object.freeze([
    Object.freeze({
      reference: "evidence:pack-1",
      value: Object.freeze({ kind: "sanitized" }),
    }),
  ]);
  const adapterResult = await completeAuthenticPageReadForTest(
    {
      manifest: dataforrestEventsV1SourceAdapterManifest,
      pins: {
        operationKind: "page_read",
        requestAttemptId: pins.requestAttemptId,
        requestLeaseId: pins.requestLeaseId,
        organizationId: pins.organizationId,
        sourceTypeKey: pins.sourceTypeKey,
        adapterVersion: pins.sourceAdapterVersion,
        singletonFencingEpoch: pins.singletonFencingEpoch,
        connectionProfileId: pins.connectionProfileId,
        connectionProfileRevisionId: pins.connectionRevisionId,
        connectionHealthGeneration: Number(pins.connectionHealthGeneration),
        provider: pins.provider,
        sourceInstanceId: pins.sourceInstanceId,
        sourceRevisionId: pins.sourceRevisionId,
        normalizedContractVersion: pins.normalizedContractVersion,
        identityNamespaceKey: pins.identityNamespaceKey,
        importRunId: pins.runId,
        runClaimLeaseId: pins.runClaimLeaseId,
        pageAttemptId: pins.pageId,
        pageNumber: pins.pageNumber,
        pageLimit: 250,
        cursorGeneration: Number(pins.cursorGeneration),
        requestedCursorFingerprint: pins.requestedCursorFingerprint,
      },
      requestedCursor,
    },
    new StaticCapturedPageSourceAdapter(
      dataforrestEventsV1SourceAdapterManifest,
      { rawResponse: raw, protectedNativeEvidence, normalizedPage: page },
    ),
  );
  return { pins, adapterResult, guard, page };
}

test("completed normalized page is planned once and handed to one atomic repository", async () => {
  const { pins, adapterResult, guard } = await fixture();
  assert.equal(adapterResult.ok, true);
  if (!adapterResult.ok) assert.fail("Captured page fixture unavailable.");
  const capturedResponse = adapterResult.value.requestCapture.protectedRawResponse;
  const committed: ProviderSourceAtomicPagePersistenceInput[] = [];
  const service = new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner(
      createProviderObservationMapperRegistryFromManifest(),
    ),
    guard,
    {
      async commitPage(input) {
        committed.push(input);
        return {
          kind: "committed",
          pageId: input.pins.pageId,
          cursorFingerprint: input.nextCursorFingerprint,
          continuation: input.plan.normalizedPage.continuation,
          counts: {
            inserted: 1,
            revised: 0,
            duplicate: 0,
            quarantined: 0,
            warnings: 0,
            unresolvedRelationships: 0,
            canonicalRevisions: 1,
            evRequests: 0,
          },
        };
      },
    },
  );
  const result = await service.importPage({
    pins,
    adapterResult,
    committedAt: new Date("2026-08-21T12:00:00.000Z"),
  });

  assert.equal(result.kind, "committed");
  assert.equal(committed.length, 1);
  assert.equal(committed[0]?.plan.outcomes.length, 1);
  assert.strictEqual(
    committed[0]?.plan.normalizedPage,
    adapterResult.ok ? adapterResult.value.normalizedPage : undefined,
  );
  assert.equal(committed[0]?.protectedRawResponseSha256.length, 64);
  assert.strictEqual(committed[0]?.protectedRawResponse, capturedResponse);
  assert.equal(
    committed[0]?.nextCursorFingerprint,
    guard.fingerprint(adapterResult.ok
      ? adapterResult.value.normalizedPage.nextCursor
      : pins.requestedCursor),
  );
});

test("poll-after may preserve the null cursor without inventing a fingerprint", async () => {
  const { pins, adapterResult, guard } = await fixture("poll_after");
  let persisted: ProviderSourceAtomicPagePersistenceInput | undefined;
  const service = new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner(
      createProviderObservationMapperRegistryFromManifest(),
    ),
    guard,
    {
      async commitPage(input) {
        persisted = input;
        return {
          kind: "committed",
          pageId: input.pins.pageId,
          cursorFingerprint: input.nextCursorFingerprint,
          continuation: input.plan.normalizedPage.continuation,
          counts: {
            inserted: 1,
            revised: 0,
            duplicate: 0,
            quarantined: 0,
            warnings: 0,
            unresolvedRelationships: 0,
            canonicalRevisions: 1,
            evRequests: 0,
          },
        };
      },
    },
  );
  await service.importPage({
    pins,
    adapterResult,
    committedAt: new Date("2026-08-21T12:00:00.000Z"),
  });
  assert.equal(persisted?.nextCursorFingerprint, null);
});

test("page import rejects non-lossless cursor text before planning or persistence", async () => {
  const { pins, adapterResult, guard } = await fixture();
  let plannerCalls = 0;
  let persistenceCalls = 0;
  const productionMappers = createProviderObservationMapperRegistryFromManifest();
  const service = new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner({
      resolve(input) {
        plannerCalls += 1;
        return productionMappers.resolve(input);
      },
    }),
    guard,
    {
      async commitPage() {
        persistenceCalls += 1;
        throw new Error("must not commit");
      },
    },
  );

  for (const value of [
    "cursor\u0000value",
    "cursor-\ud800-value",
    "cursor-\udfff-value",
  ]) {
    await assert.rejects(
      service.importPage({
        pins: {
          ...pins,
          requestedCursor: { ...pins.requestedCursor, value },
        },
        adapterResult,
        committedAt: new Date("2026-08-21T12:00:00.000Z"),
      }),
      (error) =>
        error instanceof ProviderSourcePageImportError &&
        error.code === "cursor_mismatch",
    );
  }
  assert.equal(plannerCalls, 0);
  assert.equal(persistenceCalls, 0);
});

test("a structurally matching but unregistered result fails before planner or persistence", async () => {
  const { pins, adapterResult, guard } = await fixture();
  let plannerCalls = 0;
  let persistenceCalls = 0;
  const productionMappers = createProviderObservationMapperRegistryFromManifest();
  const service = new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner({
      resolve(input) {
        plannerCalls += 1;
        return productionMappers.resolve(input);
      },
    }),
    guard,
    {
      async commitPage() {
        persistenceCalls += 1;
        throw new Error("must not commit");
      },
    },
  );
  const forged = structuredClone(adapterResult) as typeof adapterResult;
  await assert.rejects(
    service.importPage({
      pins,
      adapterResult: forged,
      committedAt: new Date("2026-08-21T12:00:00.000Z"),
    }),
    /captured_page_invalid/u,
  );
  assert.equal(plannerCalls, 0);
  assert.equal(persistenceCalls, 0);
});

test("an authentic result isolates and deeply freezes normalized identity and projection inputs", async () => {
  const { adapterResult, page } = await fixture();
  assert.equal(adapterResult.ok, true);
  if (!adapterResult.ok) assert.fail("Captured page fixture unavailable.");
  const outcome = adapterResult.value.normalizedPage.outcomes[0];
  if (!outcome || outcome.status !== "valid") {
    assert.fail("Normalized observation fixture unavailable.");
  }
  assert.equal(Object.isFrozen(adapterResult.value.normalizedPage), true);
  assert.equal(Object.isFrozen(adapterResult.value.normalizedPage.outcomes), true);
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.observation), true);
  assert.equal(
    Object.isFrozen(outcome.observation.providerRecordIdentity),
    true,
  );
  assert.throws(() => {
    (
      outcome.observation.providerRecordIdentity as unknown as {
        providerRecordId: string;
      }
    ).providerRecordId = "mutated-after-completion";
  }, TypeError);
  assert.equal(
    outcome.observation.providerRecordIdentity.providerRecordId,
    "pack-1",
  );
  const adapterOwnedOutcome = page.outcomes[0];
  if (!adapterOwnedOutcome || adapterOwnedOutcome.status !== "valid") {
    assert.fail("Adapter-owned observation fixture unavailable.");
  }
  (
    adapterOwnedOutcome.observation.providerRecordIdentity as {
      providerRecordId: string;
    }
  ).providerRecordId = "adapter-mutated-after-completion";
  assert.equal(
    outcome.observation.providerRecordIdentity.providerRecordId,
    "pack-1",
  );
});

test("scope mismatches fail before planning or persistence", async () => {
  const { pins, adapterResult, guard } = await fixture();
  let calls = 0;
  const service = new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner(
      createProviderObservationMapperRegistryFromManifest(),
    ),
    guard,
    {
      async commitPage() {
        calls += 1;
        throw new Error("must not commit");
      },
    },
  );
  await assert.rejects(
    service.importPage({
      pins: { ...pins, sourceInstanceId: "other-source" },
      adapterResult,
      committedAt: new Date("2026-08-21T12:00:00.000Z"),
    }),
    /operation_scope_mismatch/u,
  );
  assert.equal(calls, 0);
});

test("a captured page cannot be replayed against a different run page turn", async () => {
  const { pins, adapterResult, guard } = await fixture();
  let calls = 0;
  const service = new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner(
      createProviderObservationMapperRegistryFromManifest(),
    ),
    guard,
    {
      async commitPage() {
        calls += 1;
        throw new Error("must not commit");
      },
    },
  );

  await assert.rejects(
    service.importPage({
      pins: { ...pins, pageNumber: 2 },
      adapterResult,
      committedAt: new Date("2026-08-21T12:00:00.000Z"),
    }),
    /operation_scope_mismatch/u,
  );
  assert.equal(calls, 0);
});
