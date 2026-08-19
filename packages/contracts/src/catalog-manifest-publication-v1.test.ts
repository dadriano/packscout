import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildActiveCatalogManifestStateFixtureV1,
  buildEmptyActiveCatalogManifestStateV1,
  buildGlobalCatalogManifestFixtureV1,
  buildGlobalCatalogObservationFixtureV1,
  buildGlobalCatalogProviderSelectionsFixtureV1,
} from "./__fixtures__/global-catalog-manifest-v1.fixture.ts";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES,
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  activeCatalogManifestStateV1Schema,
  buildGlobalCatalogAggregateObservationV1,
  buildGlobalCatalogManifestSourceWatermarkV1,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActiveStateRequestSchema,
  catalogManifestActivationReceiptSchema,
  catalogManifestAuthKeyRolesSchema,
  catalogManifestAuthorizedClearRequestSchema,
  catalogManifestBlockReceiptSchema,
  catalogManifestBlockRequestSchema,
  catalogManifestClearReceiptSchema,
  catalogManifestErrorEnvelopeSchema,
  catalogManifestKeyHasRole,
  catalogManifestPublicationCanonicalByteCount,
  catalogManifestPublicationRequestDigest,
  catalogManifestReceiptDigest,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRefreshReceiptSchema,
  catalogManifestRollbackReceiptSchema,
  catalogManifestRollbackToManifestRequestSchema,
  catalogManifestSignedReceiptEnvelopeSchema,
  catalogManifestStatusNotFoundReceiptSchema,
  catalogManifestStatusRequestSchema,
  classifyCatalogManifestError,
  dataReleaseMetadataFromGlobalCatalogManifestV1,
  globalCatalogAggregateObservationV1Schema,
  parseCatalogManifestAuthKeyRolesJson,
  parseCatalogManifestPublicationJson,
  productionPublicationPathSchema,
  productionPublicationRequestSigningValue,
  type ActiveCatalogManifestStateCoreV1,
  type GlobalCatalogManifestPointerV1,
} from "./index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SERVER_TIME = "2026-08-15T00:05:00.000Z";

function pointer(
  manifest: Awaited<ReturnType<typeof buildGlobalCatalogManifestFixtureV1>>,
): GlobalCatalogManifestPointerV1 {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    createdAt: "2026-08-15T00:04:00.000Z",
    completedAt: SERVER_TIME,
  };
}

function identity(
  manifest: Awaited<ReturnType<typeof buildGlobalCatalogManifestFixtureV1>>,
) {
  return {
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    sharedConfigurationEpoch: manifest.sharedConfigurationEpoch,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
  };
}

test("manifest operations participate in the authenticated path allowlist", () => {
  for (const path of Object.values(PRODUCTION_CATALOG_MANIFEST_PATHS)) {
    assert.equal(productionPublicationPathSchema.safeParse(path).success, true);
  }
  assert.equal(productionPublicationPathSchema.safeParse(
    "/internal/catalog-manifest/v1/unknown",
  ).success, false);
  assert.equal(productionPublicationRequestSigningValue({
    method: "post",
    path: PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest,
    bodyDigest: HASH_A,
    timestamp: "1786813200000",
    nonce: "nonce0000000000000001",
  }), `v1\nPOST\n/internal/catalog-manifest/v1/activate-manifest\n${HASH_A}\n1786813200000\nnonce0000000000000001`);
});

test("aggregate observation is derived from canonical signed provider selections", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const selections = structuredClone(
    buildGlobalCatalogProviderSelectionsFixtureV1(manifest),
  );
  selections[0]!.latestAffectedSettledSequence = "21";
  selections[0]!.latestAffectedSourceHeadSequence = "22";
  selections[1]!.settledSourceFreshness = "delayed";
  const observation = buildGlobalCatalogAggregateObservationV1({
    observationSequence: 7,
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections: selections,
  });

  assert.equal(observation.freshness, "delayed");
  assert.equal(observation.delayedProviderCount, 2);
  assert.equal(observation.dataAsOf, "2026-08-15T00:00:00.000Z");
  assert.equal(
    observation.lastSuccessfulObservationAt,
    "2026-08-15T00:02:00.000Z",
  );
  assert.equal(observation.staleAt, "2026-08-15T00:12:00.000Z");
  assert.equal(
    observation.sourceWatermark,
    buildGlobalCatalogManifestSourceWatermarkV1(
      manifest.publicReleaseId,
      7,
    ),
  );

  assert.equal(globalCatalogAggregateObservationV1Schema.safeParse({
    ...observation,
    delayedProviderCount: 1,
  }).success, false);
  assert.equal(globalCatalogAggregateObservationV1Schema.safeParse({
    ...observation,
    sourceWatermark: `${observation.sourceWatermark}:forged`,
  }).success, false);

  const noncanonical = structuredClone(observation);
  noncanonical.providerSelections.reverse();
  assert.equal(
    globalCatalogAggregateObservationV1Schema.safeParse(noncanonical).success,
    false,
  );
});

test("provider selection sequence and active epoch bounds fail closed", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const selections = structuredClone(
    buildGlobalCatalogProviderSelectionsFixtureV1(manifest),
  );
  selections[0]!.latestAffectedSettledSequence = "19";
  assert.throws(() => buildGlobalCatalogAggregateObservationV1({
    observationSequence: 1,
    publicReleaseId: manifest.publicReleaseId,
    providerReferenceSetHash: manifest.providerReferenceSetHash,
    providerSelections: selections,
  }));

  const state = buildActiveCatalogManifestStateFixtureV1(manifest);
  const epochAfterSelection = structuredClone(state);
  if (epochAfterSelection.activeManifest !== null) {
    epochAfterSelection.activeManifest.sharedConfigurationEpoch = {
      ...epochAfterSelection.activeManifest.sharedConfigurationEpoch,
      publicChangeSequence: "30",
    };
  }
  assert.equal(
    activeCatalogManifestStateV1Schema.safeParse(epochAfterSelection).success,
    false,
  );
});

test("activate binds an exact predecessor, immutable manifest, and selection proof", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const observation = buildGlobalCatalogObservationFixtureV1(manifest);
  const request = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:activate:1",
    idempotencyKey: "manifest:activate:1",
    manifest,
    observation,
    expectedActiveState: buildEmptyActiveCatalogManifestStateV1(),
  };
  assert.equal(catalogManifestActivateRequestSchema.safeParse(request).success, true);

  const wrongSelection = structuredClone(request);
  wrongSelection.observation.providerSelections[0]!.publicProviderReleaseId =
    manifest.providerReferences[1]!.publicProviderReleaseId;
  assert.equal(
    catalogManifestActivateRequestSchema.safeParse(wrongSelection).success,
    false,
  );

  const stale = structuredClone(request);
  stale.expectedActiveState = buildActiveCatalogManifestStateFixtureV1(
    manifest,
    observation,
  );
  assert.equal(catalogManifestActivateRequestSchema.safeParse(stale).success, false);

  assert.equal(catalogManifestActivateRequestSchema.safeParse({
    ...request,
    raw_payload: { secret: "never" },
  }).success, false);
});

test("refresh advances observation only and rollback distinguishes target from clear", async () => {
  const activeManifest = await buildGlobalCatalogManifestFixtureV1();
  const targetManifest = await buildGlobalCatalogManifestFixtureV1("mock");
  const expectedActiveState = buildActiveCatalogManifestStateFixtureV1(
    activeManifest,
  );
  const refreshedObservation = buildGlobalCatalogObservationFixtureV1(
    activeManifest,
    2,
  );
  const refresh = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:refresh:2",
    idempotencyKey: "manifest:refresh:2",
    manifest: identity(activeManifest),
    observation: refreshedObservation,
    expectedActiveState,
  };
  assert.equal(
    catalogManifestRefreshActiveStateRequestSchema.safeParse(refresh).success,
    true,
  );
  assert.equal(catalogManifestRefreshActiveStateRequestSchema.safeParse({
    ...refresh,
    observation: expectedActiveState.observation,
  }).success, false);
  const incompleteCas = structuredClone(refresh) as unknown as Record<
    string,
    unknown
  >;
  incompleteCas.expectedActiveState = {
    generation: expectedActiveState.generation,
    activeManifest: expectedActiveState.activeManifest,
  };
  assert.equal(
    catalogManifestRefreshActiveStateRequestSchema.safeParse(incompleteCas)
      .success,
    false,
  );

  const rollback = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:rollback:2",
    idempotencyKey: "manifest:rollback:2",
    rollbackKind: "manifest" as const,
    targetManifest: identity(targetManifest),
    observation: buildGlobalCatalogObservationFixtureV1(targetManifest, 2),
    expectedActiveState,
  };
  assert.equal(
    catalogManifestRollbackToManifestRequestSchema.safeParse(rollback).success,
    true,
  );
  assert.equal(catalogManifestRollbackToManifestRequestSchema.safeParse({
    ...rollback,
    targetManifest: identity(activeManifest),
  }).success, false);

  const clear = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:clear:2",
    idempotencyKey: "manifest:clear:2",
    rollbackKind: "clear" as const,
    clearAuthorization: "clear_catalog_manifest_v1" as const,
    expectedActiveState,
  };
  assert.equal(
    catalogManifestAuthorizedClearRequestSchema.safeParse(clear).success,
    true,
  );
  assert.equal(catalogManifestAuthorizedClearRequestSchema.safeParse({
    ...clear,
    clearAuthorization: null,
  }).success, false);
});

test("status, block, and active-state requests expose exact bounded identities", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const block = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:block:1",
    idempotencyKey: "manifest:block:1",
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    blockSequence: "20",
    reason: "MANIFEST_CONTENT_INVALID" as const,
  };
  assert.equal(catalogManifestBlockRequestSchema.safeParse(block).success, true);
  assert.equal(catalogManifestBlockRequestSchema.safeParse({
    ...block,
    reason: "free form",
  }).success, false);

  const requestDigest = await catalogManifestPublicationRequestDigest(block);
  const status = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    target: {
      operationKind: "block" as const,
      operationId: block.operationId,
      idempotencyKey: block.idempotencyKey,
      publicReleaseId: block.publicReleaseId,
      manifestFingerprint: block.manifestFingerprint,
      requestDigest,
    },
  };
  assert.equal(catalogManifestStatusRequestSchema.safeParse(status).success, true);
  assert.equal(catalogManifestStatusRequestSchema.safeParse({
    ...status,
    target: { ...status.target, publicReleaseId: null },
  }).success, false);
  assert.equal(catalogManifestActiveStateRequestSchema.safeParse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:active-state:1",
  }).success, true);
});

test("canonical request bytes and digests bind the exact operation", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const request = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:activate:canonical",
    idempotencyKey: "manifest:activate:canonical",
    manifest,
    observation: buildGlobalCatalogObservationFixtureV1(manifest),
    expectedActiveState: buildEmptyActiveCatalogManifestStateV1(),
  };
  const body = canonicalJson(request);
  const expectedDigest = createHash("sha256").update(body).digest("hex");
  assert.equal(
    await catalogManifestPublicationRequestDigest(request),
    expectedDigest,
  );
  assert.equal(
    catalogManifestPublicationCanonicalByteCount(request),
    new TextEncoder().encode(body).byteLength,
  );
  assert.deepEqual(
    parseCatalogManifestPublicationJson(
      body,
      catalogManifestActivateRequestSchema,
    ),
    request,
  );
  assert.equal(parseCatalogManifestPublicationJson(
    `${body}\n`,
    catalogManifestActivateRequestSchema,
  ), null);
  assert.equal(parseCatalogManifestPublicationJson(
    " ".repeat(MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES + 1),
    catalogManifestActivateRequestSchema,
  ), null);
  assert.notEqual(
    await catalogManifestPublicationRequestDigest(request),
    await catalogManifestPublicationRequestDigest({
      ...request,
      operationId: "manifest:activate:other",
    }),
  );
});

test("key role configuration is bounded, canonical, and explicit", () => {
  const roles = {
    "admin.v1": ["clear", "publish", "rollback"],
    "publisher.v1": ["publish"],
  } as const;
  const body = canonicalJson(roles);
  const parsed = parseCatalogManifestAuthKeyRolesJson(body);
  assert.deepEqual(parsed, roles);
  assert.equal(
    catalogManifestKeyHasRole(parsed!, "admin.v1", "clear"),
    true,
  );
  assert.equal(
    catalogManifestKeyHasRole(parsed!, "publisher.v1", "rollback"),
    false,
  );
  assert.equal(parseCatalogManifestAuthKeyRolesJson(`${body}\n`), null);
  assert.equal(catalogManifestAuthKeyRolesSchema.safeParse({
    "publisher.v1": ["rollback", "publish"],
  }).success, false);
  assert.equal(catalogManifestAuthKeyRolesSchema.safeParse(
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
      `key-${String(index).padStart(2, "0")}.v1`,
      ["publish"],
    ])),
  ).success, false);
});

test("existing DataReleaseMetadata is derived without adding manifest fields", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const state = buildActiveCatalogManifestStateFixtureV1(manifest);
  const metadata = dataReleaseMetadataFromGlobalCatalogManifestV1(
    manifest,
    state,
  );

  assert.deepEqual(Object.keys(metadata).sort(), [
    "categoryCount", "collectibleCount", "completedAt", "confidencePolicyVersion",
    "contentHash", "createdAt", "dataAsOf", "dataSource", "delayedVendorCount",
    "freshness", "lastSuccessfulObservationAt", "manifestFingerprint",
    "originSetHash", "publicConfigHash", "publicConfigRevision", "publicReleaseId",
    "repackChaseCount", "repackCount", "repackSearchIndexHash", "schemaVersion",
    "searchAlgorithmVersion", "sourceWatermark", "staleAt", "vendorCount",
  ].sort());
  assert.equal(metadata.publicReleaseId, manifest.publicReleaseId);
  assert.equal(metadata.vendorCount, 2);
  assert.equal(metadata.delayedVendorCount, 0);
  assert.equal(metadata.dataSource, "canonical");
  assert.throws(() => dataReleaseMetadataFromGlobalCatalogManifestV1(
    manifest,
    buildEmptyActiveCatalogManifestStateV1(),
  ));
});

test("terminal receipts prove exact state transitions and signed digests", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const target = await buildGlobalCatalogManifestFixtureV1("mock");
  const empty = buildEmptyActiveCatalogManifestStateV1();
  const observation = buildGlobalCatalogObservationFixtureV1(manifest);
  const activeCore: ActiveCatalogManifestStateCoreV1 = {
    generation: 1,
    activeManifest: pointer(manifest),
    previousManifest: null,
    observation,
  };
  const base = {
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:activate:1",
    idempotencyKey: "manifest:activate:1",
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    serverTime: SERVER_TIME,
    requestDigest: HASH_A,
    receiptDigest: HASH_B,
  };
  const activation = catalogManifestActivationReceiptSchema.parse({
    ...base,
    operationKind: "activateManifest",
    terminalState: "complete",
    result: "activated",
    details: { expectedActiveState: empty, activeState: activeCore },
  });

  const activeState = buildActiveCatalogManifestStateFixtureV1(manifest);
  assert.equal(catalogManifestActiveStateReceiptSchema.safeParse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "manifest:active-state:1",
    operationKind: "activeState",
    terminalState: "observed",
    result: "active_state",
    serverTime: SERVER_TIME,
    requestDigest: HASH_A,
    receiptDigest: HASH_B,
    details: { activeState },
  }).success, true);

  const refreshedObservation = buildGlobalCatalogObservationFixtureV1(
    manifest,
    2,
  );
  const refresh = catalogManifestRefreshReceiptSchema.parse({
    ...base,
    operationId: "manifest:refresh:2",
    idempotencyKey: "manifest:refresh:2",
    operationKind: "refreshActiveState",
    terminalState: "complete",
    result: "refreshed",
    details: {
      expectedActiveState: activeState,
      activeState: {
        generation: 2,
        activeManifest: activeState.activeManifest,
        previousManifest: null,
        observation: refreshedObservation,
      },
    },
  });
  assert.equal(refresh.details.activeState.generation, 2);

  const targetObservation = buildGlobalCatalogObservationFixtureV1(target, 2);
  assert.equal(catalogManifestRollbackReceiptSchema.safeParse({
    ...base,
    operationId: "manifest:rollback:2",
    idempotencyKey: "manifest:rollback:2",
    publicReleaseId: target.publicReleaseId,
    manifestFingerprint: target.manifestFingerprint,
    operationKind: "rollback",
    rollbackKind: "manifest",
    terminalState: "complete",
    result: "rolled_back",
    details: {
      expectedActiveState: activeState,
      activeState: {
        generation: 2,
        activeManifest: pointer(target),
        previousManifest: activeState.activeManifest,
        observation: targetObservation,
      },
      outgoingManifestBlocked: false,
    },
  }).success, true);
  assert.equal(catalogManifestRollbackReceiptSchema.safeParse({
    ...base,
    operationId: "manifest:rollback:blocked",
    idempotencyKey: "manifest:rollback:blocked",
    publicReleaseId: target.publicReleaseId,
    manifestFingerprint: target.manifestFingerprint,
    operationKind: "rollback",
    rollbackKind: "manifest",
    terminalState: "complete",
    result: "rolled_back",
    details: {
      expectedActiveState: activeState,
      activeState: {
        generation: 2,
        activeManifest: pointer(target),
        previousManifest: null,
        observation: targetObservation,
      },
      outgoingManifestBlocked: true,
    },
  }).success, true);

  assert.equal(catalogManifestClearReceiptSchema.safeParse({
    ...base,
    operationId: "manifest:clear:2",
    idempotencyKey: "manifest:clear:2",
    operationKind: "rollback",
    rollbackKind: "clear",
    publicReleaseId: null,
    manifestFingerprint: null,
    terminalState: "cleared",
    result: "cleared",
    details: {
      expectedActiveState: activeState,
      activeState: {
        generation: 2,
        activeManifest: null,
        previousManifest: null,
        observation: null,
      },
    },
  }).success, true);
  assert.equal(catalogManifestBlockReceiptSchema.safeParse({
    ...base,
    operationKind: "block",
    terminalState: "blocked",
    result: "blocked",
    details: {
      blockSequence: "20",
      reason: "MANIFEST_CONTENT_INVALID",
    },
  }).success, true);

  const envelope = {
    ok: true,
    receipt: activation,
    responseAuth: {
      signatureVersion: "v1",
      keyId: "publisher.v1",
      receiptDigest: HASH_B,
      signature: HASH_C,
    },
  };
  assert.equal(
    catalogManifestSignedReceiptEnvelopeSchema.safeParse(envelope).success,
    true,
  );
  assert.equal(catalogManifestSignedReceiptEnvelopeSchema.safeParse({
    ...envelope,
    responseAuth: { ...envelope.responseAuth, receiptDigest: HASH_C },
  }).success, false);
  assert.equal(
    await catalogManifestReceiptDigest({ ...activation, receiptDigest: HASH_A }),
    await catalogManifestReceiptDigest({ ...activation, receiptDigest: HASH_C }),
  );
});

test("status not-found receipts and errors remain exact and classifiable", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const target = {
    operationKind: "activateManifest" as const,
    operationId: "manifest:missing",
    idempotencyKey: "manifest:missing",
    publicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    requestDigest: HASH_A,
  };
  assert.equal(catalogManifestStatusNotFoundReceiptSchema.safeParse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    target,
    terminalState: "not_found",
    result: "not_found",
    serverTime: SERVER_TIME,
    requestDigest: HASH_A,
    details: {},
    receiptDigest: null,
  }).success, true);
  assert.equal(catalogManifestStatusNotFoundReceiptSchema.safeParse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    target,
    terminalState: "not_found",
    result: "not_found",
    serverTime: SERVER_TIME,
    requestDigest: HASH_B,
    details: {},
    receiptDigest: null,
  }).success, false);

  assert.equal(catalogManifestErrorEnvelopeSchema.safeParse({
    error: "refresh is stale",
    code: "CATALOG_MANIFEST_REFRESH_STALE",
  }).success, true);
  assert.equal(classifyCatalogManifestError(
    "CATALOG_MANIFEST_AUTH_INVALID",
  ), "authentication");
  assert.equal(classifyCatalogManifestError(
    "CATALOG_MANIFEST_AUTH_STALE",
  ), "bounded_retry");
  assert.equal(classifyCatalogManifestError(
    "CATALOG_MANIFEST_ROLLBACK_UNSAFE",
  ), "terminal");
  assert.equal(catalogManifestErrorEnvelopeSchema.safeParse({
    error: "bad",
    code: "PUBLICATION_INTERNAL_ERROR",
  }).success, false);
});
