import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildSyntheticDataReleaseV2 } from "./__fixtures__/data-release-v2.fixture.ts";
import {
  MAX_PROVIDER_RELEASE_RECEIPT_BYTES,
  MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  canonicalJson,
  canonicalJsonByteCount,
  classifyProviderReleaseError,
  containsProtectedProviderReleasePublicationField,
  providerCatalogReleaseBatchByteCount,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseArtifactCleanupReceiptSchema,
  providerReleaseBatchReceiptSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseCleanupRequestSchema,
  providerReleaseCompletionReceiptSchema,
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseErrorEnvelopeSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseNonceCleanupReceiptSchema,
  providerReleasePublicationRequestDigest,
  providerReleaseReceiptDigest,
  providerReleaseReuseReceiptSchema,
  providerReleaseSignedReceiptEnvelopeSchema,
  providerReleaseStartReceiptSchema,
  providerReleaseStartRequestSchema,
  providerReleaseStatusNotFoundReceiptSchema,
  providerReleaseStatusRequestSchema,
  parseProviderReleasePublicationJson,
  productionPublicationPathSchema,
  productionPublicationRequestSigningValue,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
} from "./index.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RELEASE_A = "10000000-0000-5000-8000-000000000001";
const RELEASE_B = "10000000-0000-5000-8000-000000000002";
const SERVER_TIME = "2026-08-15T00:00:00.000Z";

test("provider receipts reserve exactly 384 KiB of canonical UTF-8 JSON", () => {
  assert.equal(MAX_PROVIDER_RELEASE_RECEIPT_BYTES, 384 * 1_024);
  const exactLimit = "é".repeat(
    (MAX_PROVIDER_RELEASE_RECEIPT_BYTES - 2) / 2,
  );

  assert.equal(
    canonicalJsonByteCount(exactLimit),
    MAX_PROVIDER_RELEASE_RECEIPT_BYTES,
  );
  assert.equal(
    canonicalJsonByteCount(`${exactLimit}x`),
    MAX_PROVIDER_RELEASE_RECEIPT_BYTES + 1,
  );
});

function epoch(publicChangeSequence = "10") {
  return {
    configurationKey: "catalog.v1",
    revision: Number(publicChangeSequence),
    publicChangeSequence,
    configurationHash: HASH_A,
  };
}

function proof(
  publicProviderReleaseId = RELEASE_A,
  sharedConfigurationEpoch = epoch(),
): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: "alpha",
    sharedConfigurationEpoch,
    dataAsOf: "2026-08-14T23:58:00.000Z",
    publicProviderReleaseId,
    providerReleaseFingerprint: HASH_A,
    contentHash: HASH_B,
    publicAssetOrigins: [],
    governingHashes: {
      providerConfigurationHash: HASH_A,
      sharedCategoriesHash: HASH_A,
      identityMappingsHash: HASH_A,
      originSetHash: HASH_A,
      confidencePolicyHash: HASH_A,
    },
    entityHashes: {
      vendors: HASH_B,
      categories: HASH_B,
      collectibles: HASH_B,
      repacks: HASH_B,
      repack_chases: HASH_B,
      search_shards: HASH_B,
    },
    counts: {
      vendors: 1,
      categories: 0,
      collectibles: 0,
      repacks: 0,
      repackChases: 0,
      searchShards: 0,
    },
    searchAlgorithmVersion: "repack_search_v2",
    providerSearchIndexHash: HASH_A,
    batchCount: 1,
    batchChainHash: HASH_B,
  };
}

function checkpoint(settledSequence = "20") {
  return {
    settledSequence,
    settledAt: SERVER_TIME,
  };
}

function observation(sourceHeadSequence = "20") {
  return {
    sourceHeadSequence,
    lastSuccessfulObservationAt: "2026-08-14T23:59:00.000Z",
    staleAt: "2026-08-15T00:14:00.000Z",
    freshness: "fresh" as const,
  };
}

function emptyHead(): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey: "alpha",
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  };
}

function predecessor(
  publicProviderReleaseId = RELEASE_A,
  settledSequence = "10",
  sharedConfigurationEpoch = epoch(),
): ProviderReleaseExpectedCompletedHeadV1 {
  return {
    platformKey: "alpha",
    publicProviderReleaseId,
    sharedConfigurationEpoch,
    providerCheckpoint: checkpoint(settledSequence),
    observation: observation(settledSequence),
    terminalReceiptSha256: HASH_A,
  };
}

function releaseContext(
  release = proof(),
  expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1 = emptyHead(),
) {
  return {
    release,
    providerCheckpoint: checkpoint(),
    sourceWatermark: "provider-catalog:alpha:20",
    observation: observation(),
    expectedCompletedHead,
  };
}

function startRequest(
  release = proof(),
  expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1 = emptyHead(),
) {
  return {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "provider:start:alpha:20",
    idempotencyKey: "provider:start:alpha:20",
    ...releaseContext(release, expectedCompletedHead),
  };
}

function receiptBase() {
  return {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "provider:start:alpha:20",
    idempotencyKey: "provider:start:alpha:20",
    platformKey: "alpha",
    publicProviderReleaseId: RELEASE_A,
    sharedConfigurationEpoch: epoch(),
    providerCheckpoint: checkpoint(),
    serverTime: SERVER_TIME,
    requestDigest: HASH_A,
    receiptDigest: HASH_B,
  };
}

test("provider release paths participate in the existing signed-path allowlist", () => {
  for (const path of Object.values(PRODUCTION_PROVIDER_RELEASE_PATHS)) {
    assert.equal(productionPublicationPathSchema.safeParse(path).success, true);
  }
  assert.equal(productionPublicationPathSchema.safeParse(
    "/internal/provider-release/v1/unknown",
  ).success, false);
  assert.equal(productionPublicationRequestSigningValue({
    method: "post",
    path: PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
    bodyDigest: HASH_A,
    timestamp: "1786813200000",
    nonce: "nonce0000000000000001",
  }), `v1\nPOST\n/internal/provider-release/v1/finalize\n${HASH_A}\n1786813200000\nnonce0000000000000001`);
});

test("provider release request digests hash exact canonical request bytes", async () => {
  const request = startRequest();
  const expected = createHash("sha256")
    .update(canonicalJson(request))
    .digest("hex");
  assert.equal(await providerReleasePublicationRequestDigest(request), expected);
});

test("provider release request digest binds operation identity", async () => {
  const request = startRequest();
  assert.notEqual(
    await providerReleasePublicationRequestDigest(request),
    await providerReleasePublicationRequestDigest({
      ...request,
      operationId: "provider:start:alpha:other",
    }),
  );
});

test("start binds immutable proof, checkpoint, epoch, observation, and predecessor", () => {
  assert.equal(providerReleaseStartRequestSchema.safeParse(startRequest()).success, true);

  const epochAfterCheckpoint = startRequest(proof(RELEASE_A, epoch("21")));
  assert.equal(
    providerReleaseStartRequestSchema.safeParse(epochAfterCheckpoint).success,
    false,
  );
  assert.equal(providerReleaseStartRequestSchema.safeParse({
    ...startRequest(),
    observation: observation("19"),
  }).success, false);
  assert.equal(providerReleaseStartRequestSchema.safeParse({
    ...startRequest(),
    release: {
      ...proof(),
      dataAsOf: "2026-08-15T00:00:00.001Z",
    },
  }).success, false);
  assert.equal(providerReleaseStartRequestSchema.safeParse({
    ...startRequest(),
    sourceWatermark: "provider-catalog:other:20",
  }).success, false);
  assert.equal(providerReleaseStartRequestSchema.safeParse({
    ...startRequest(),
    rawPayload: { secret: "never" },
  }).success, false);
});

test("provider publication JSON rejects protected fields and oversized bodies", () => {
  const request = startRequest();
  assert.equal(
    parseProviderReleasePublicationJson(
      canonicalJson(request),
      providerReleaseStartRequestSchema,
    )?.release.publicProviderReleaseId,
    RELEASE_A,
  );
  assert.equal(parseProviderReleasePublicationJson(
    ` ${canonicalJson(request)}`,
    providerReleaseStartRequestSchema,
  ), null);
  const reversedKeyOrder = JSON.stringify(
    Object.fromEntries(Object.entries(request).reverse()),
  );
  assert.notEqual(reversedKeyOrder, canonicalJson(request));
  assert.equal(parseProviderReleasePublicationJson(
    reversedKeyOrder,
    providerReleaseStartRequestSchema,
  ), null);
  assert.equal(
    containsProtectedProviderReleasePublicationField({
      publicProviderReleaseId: RELEASE_A,
    }),
    false,
  );
  assert.equal(
    containsProtectedProviderReleasePublicationField({ raw_payload: "no" }),
    true,
  );
  assert.equal(parseProviderReleasePublicationJson(
    JSON.stringify({ ...request, raw_payload: "no" }),
    providerReleaseStartRequestSchema,
  ), null);
  assert.equal(parseProviderReleasePublicationJson(
    ` ${" ".repeat(128 * 1_024)}${canonicalJson(request)}`,
    providerReleaseStartRequestSchema,
  ), null);
});

test("new publication always advances checkpoint and advances a changed epoch", () => {
  const prior = predecessor(RELEASE_A, "15", epoch("10"));
  assert.equal(providerReleaseFinalizeRequestSchema.safeParse({
    ...startRequest(proof(RELEASE_B, epoch("10")), prior),
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
  }).success, true);
  assert.equal(providerReleaseFinalizeRequestSchema.safeParse({
    ...startRequest(proof(RELEASE_B, epoch("16")), prior),
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
  }).success, true);
  assert.equal(providerReleaseFinalizeRequestSchema.safeParse({
    ...startRequest(proof(RELEASE_B, epoch("9")), prior),
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
  }).success, false);
  assert.equal(providerReleaseFinalizeRequestSchema.safeParse({
    ...startRequest(proof(RELEASE_A, epoch("16")), prior),
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
  }).success, false);
  assert.equal(providerReleaseFinalizeRequestSchema.safeParse({
    ...startRequest(proof(RELEASE_B), prior),
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
    providerCheckpoint: checkpoint("15"),
    sourceWatermark: "provider-catalog:alpha:15",
    observation: observation("15"),
  }).success, false);
});

test("reuse preserves immutable release and epoch while checkpoint advances", () => {
  const prior = predecessor(RELEASE_A, "15", epoch());
  const request = {
    ...startRequest(proof(RELEASE_A, epoch()), prior),
    operationId: "provider:reuse:alpha:20",
    idempotencyKey: "provider:reuse:alpha:20",
  };
  assert.equal(providerReleaseConfirmReuseRequestSchema.safeParse(request).success, true);
  assert.equal(providerReleaseConfirmReuseRequestSchema.safeParse({
    ...request,
    release: proof(RELEASE_B, epoch()),
  }).success, false);
  assert.equal(providerReleaseConfirmReuseRequestSchema.safeParse({
    ...request,
    release: proof(RELEASE_A, epoch("16")),
  }).success, false);
  assert.equal(providerReleaseConfirmReuseRequestSchema.safeParse({
    ...request,
    providerCheckpoint: checkpoint("15"),
    sourceWatermark: "provider-catalog:alpha:15",
    observation: observation("15"),
  }).success, false);
});

test("nonempty predecessor requires an exact checkpoint observation", () => {
  const invalidPredecessor = {
    ...predecessor(RELEASE_A, "15"),
    observation: observation("14"),
  } as unknown as ProviderReleaseExpectedCompletedHeadV1;
  const request = startRequest(proof(RELEASE_B), invalidPredecessor);
  assert.equal(providerReleaseStartRequestSchema.safeParse(request).success, false);
  const futureEpoch = {
    ...predecessor(RELEASE_A, "15"),
    sharedConfigurationEpoch: epoch("16"),
  } as unknown as ProviderReleaseExpectedCompletedHeadV1;
  assert.equal(providerReleaseStartRequestSchema.safeParse(
    startRequest(proof(RELEASE_B), futureEpoch),
  ).success, false);
  const futureObservation = {
    ...predecessor(RELEASE_A, "15"),
    observation: {
      ...observation("15"),
      lastSuccessfulObservationAt: "2026-08-15T00:00:00.001Z",
      staleAt: "2026-08-15T00:15:00.001Z",
    },
  } as unknown as ProviderReleaseExpectedCompletedHeadV1;
  assert.equal(providerReleaseStartRequestSchema.safeParse(
    startRequest(proof(RELEASE_B), futureObservation),
  ).success, false);
});

test("batch requests enforce provider-native byte and index limits", () => {
  const vendor = buildSyntheticDataReleaseV2().vendors[0]!;
  const records = [vendor];
  const request = {
    ...startRequest(),
    operationId: "provider:batch:alpha:0",
    idempotencyKey: "provider:batch:alpha:0",
    batch: {
      batchIndex: 0,
      kind: "vendors" as const,
      batchHash: HASH_A,
      byteCount: providerCatalogReleaseBatchByteCount(records),
      records,
    },
  };
  assert.equal(providerReleaseApplyBatchRequestSchema.safeParse(request).success, true);
  assert.equal(providerReleaseApplyBatchRequestSchema.safeParse({
    ...request,
    batch: { ...request.batch, batchIndex: 1 },
  }).success, false);
  assert.equal(providerReleaseApplyBatchRequestSchema.safeParse({
    ...request,
    batch: { ...request.batch, byteCount: request.batch.byteCount + 1 },
  }).success, false);
});

test("status lookup binds exact target operation identity and request digest", () => {
  const target = {
    operationKind: "finalize" as const,
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
    platformKey: "alpha",
    publicProviderReleaseId: RELEASE_A,
    requestDigest: HASH_A,
  };
  assert.equal(providerReleaseStatusRequestSchema.safeParse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    target,
  }).success, true);
  assert.equal(providerReleaseStatusRequestSchema.safeParse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    target: { ...target, publicProviderReleaseId: null },
  }).success, false);
  assert.equal(providerReleaseStatusNotFoundReceiptSchema.safeParse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    target,
    terminalState: "not_found",
    result: "not_found",
    serverTime: SERVER_TIME,
    requestDigest: HASH_B,
    details: {},
    receiptDigest: null,
  }).success, false);
});

test("block sequence is lossless and reasons are from a fixed bounded vocabulary", () => {
  const request = {
    ...startRequest(),
    operationId: "provider:block:alpha:20",
    idempotencyKey: "provider:block:alpha:20",
    blockSequence: "9223372036854775807",
    reason: "PUBLICATION_INTEGRITY_INVALID",
  };
  assert.equal(providerReleaseBlockRequestSchema.safeParse(request).success, true);
  assert.equal(providerReleaseBlockRequestSchema.safeParse({
    ...request,
    blockSequence: "9223372036854775808",
  }).success, false);
  assert.equal(providerReleaseBlockRequestSchema.safeParse({
    ...request,
    reason: "ARBITRARY_OPERATOR_TEXT",
  }).success, false);
});

test("cleanup has distinct safe scopes and a provider-native document bound", () => {
  const base = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: "provider:cleanup:alpha",
    idempotencyKey: "provider:cleanup:alpha",
    platformKey: "alpha",
    expectedCompletedHead: emptyHead(),
    maximumDocuments: MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS,
  };
  assert.equal(providerReleaseCleanupRequestSchema.safeParse({
    ...base,
    cleanupKind: "expired_provider_artifacts",
  }).success, true);
  assert.equal(providerReleaseCleanupRequestSchema.safeParse({
    ...base,
    cleanupKind: "expired_auth_nonces",
  }).success, true);
  assert.equal(providerReleaseCleanupRequestSchema.safeParse({
    ...base,
    cleanupKind: "complete_releases",
  }).success, false);
  assert.equal(providerReleaseCleanupRequestSchema.safeParse({
    ...base,
    cleanupKind: "expired_provider_artifacts",
    maximumDocuments: MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS + 1,
  }).success, false);
});

test("receipts reject contradictory release identities and completion state", () => {
  const validStartReceipt = {
    ...receiptBase(),
    operationKind: "start",
    terminalState: "staging",
    result: "created",
    details: {
      ...releaseContext(),
      acceptedBatchCount: 0,
    },
  };
  assert.equal(providerReleaseStartReceiptSchema.safeParse(validStartReceipt).success, true);
  assert.equal(providerReleaseStartReceiptSchema.safeParse({
    ...validStartReceipt,
    platformKey: "beta",
  }).success, false);
  assert.equal(providerReleaseStartReceiptSchema.safeParse({
    ...validStartReceipt,
    details: {
      ...validStartReceipt.details,
      release: {
        ...validStartReceipt.details.release,
        dataAsOf: "2026-08-14T23:59:00.001Z",
      },
    },
  }).success, false);

  const cleanup = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationKind: "cleanup",
    operationId: "provider:cleanup:alpha",
    idempotencyKey: "provider:cleanup:alpha",
    platformKey: "alpha",
    publicProviderReleaseId: null,
    terminalState: "complete",
    result: "cleaned",
    serverTime: SERVER_TIME,
    requestDigest: HASH_A,
    receiptDigest: HASH_B,
    details: {
      cleanupKind: "expired_provider_artifacts",
      expectedCompletedHead: emptyHead(),
      deletedDocumentCount: 2,
      maximumDocuments: 100,
      hasMore: false,
      deletedStagingDocumentCount: 1,
      deletedFailedDocumentCount: 1,
    },
  };
  assert.equal(providerReleaseArtifactCleanupReceiptSchema.safeParse(cleanup).success, true);
  assert.equal(providerReleaseArtifactCleanupReceiptSchema.safeParse({
    ...cleanup,
    terminalState: "continuation_required",
  }).success, false);
  assert.equal(providerReleaseArtifactCleanupReceiptSchema.safeParse({
    ...cleanup,
    details: { ...cleanup.details, deletedDocumentCount: 1 },
  }).success, false);
  assert.equal(providerReleaseArtifactCleanupReceiptSchema.safeParse({
    ...cleanup,
    details: {
      ...cleanup.details,
      deletedDocumentCount: 100,
      maximumDocuments: 1,
      deletedStagingDocumentCount: 100,
      deletedFailedDocumentCount: 0,
    },
  }).success, false);

  const nonceCleanup = {
    ...cleanup,
    details: {
      cleanupKind: "expired_auth_nonces",
      expectedCompletedHead: emptyHead(),
      deletedDocumentCount: 1,
      maximumDocuments: 1,
      hasMore: false,
      deletedNonceCount: 1,
    },
  };
  assert.equal(
    providerReleaseNonceCleanupReceiptSchema.safeParse(nonceCleanup).success,
    true,
  );
  assert.equal(providerReleaseNonceCleanupReceiptSchema.safeParse({
    ...nonceCleanup,
    details: {
      ...nonceCleanup.details,
      deletedDocumentCount: 100,
      deletedNonceCount: 100,
    },
  }).success, false);
});

test("staging receipts enforce advancing release transitions", () => {
  const prior = predecessor(RELEASE_A, "15", epoch());
  const nextRelease = proof(RELEASE_B, epoch());
  const context = releaseContext(nextRelease, prior);
  const startReceipt = {
    ...receiptBase(),
    publicProviderReleaseId: RELEASE_B,
    operationKind: "start",
    terminalState: "staging",
    result: "created",
    details: {
      ...context,
      acceptedBatchCount: 0,
    },
  };
  assert.equal(
    providerReleaseStartReceiptSchema.safeParse(startReceipt).success,
    true,
  );
  assert.equal(providerReleaseStartReceiptSchema.safeParse({
    ...startReceipt,
    publicProviderReleaseId: RELEASE_A,
    details: {
      ...startReceipt.details,
      release: proof(RELEASE_A, epoch()),
    },
  }).success, false);

  const batchReceipt = {
    ...receiptBase(),
    operationKind: "applyBatch",
    operationId: "provider:batch:alpha:20",
    idempotencyKey: "provider:batch:alpha:20",
    publicProviderReleaseId: RELEASE_B,
    terminalState: "staging",
    result: "accepted",
    details: {
      ...context,
      batchIndex: 0,
      kind: "vendors",
      batchHash: HASH_A,
      recordCount: 1,
      byteCount: 1,
      acceptedBatchCount: 1,
      acceptedCounts: nextRelease.counts,
      acceptedEntityHashes: nextRelease.entityHashes,
      acceptedBatchChainHash: HASH_B,
    },
  };
  assert.equal(
    providerReleaseBatchReceiptSchema.safeParse(batchReceipt).success,
    true,
  );
  assert.equal(providerReleaseBatchReceiptSchema.safeParse({
    ...batchReceipt,
    details: {
      ...batchReceipt.details,
      expectedCompletedHead: predecessor(RELEASE_A, "15", epoch("11")),
    },
  }).success, false);
});

test("completed-head receipts prove exact empty or complete private state", () => {
  const base = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationKind: "completedHead",
    operationId: "provider:head:alpha",
    platformKey: "alpha",
    terminalState: "observed",
    result: "completed_head",
    serverTime: SERVER_TIME,
    requestDigest: HASH_A,
    receiptDigest: HASH_B,
  };
  assert.equal(providerReleaseCompletedHeadReceiptSchema.safeParse({
    ...base,
    publicProviderReleaseId: null,
    details: {
      head: {
        platformKey: "alpha",
        release: null,
        providerCheckpoint: { settledSequence: "0", settledAt: null },
        observation: null,
        terminalReceiptSha256: null,
      },
    },
  }).success, true);
  assert.equal(providerReleaseCompletedHeadReceiptSchema.safeParse({
    ...base,
    publicProviderReleaseId: RELEASE_A,
    details: {
      head: {
        platformKey: "alpha",
        release: proof(),
        providerCheckpoint: checkpoint(),
        observation: observation(),
        terminalReceiptSha256: HASH_A,
      },
    },
  }).success, true);
  assert.equal(providerReleaseCompletedHeadReceiptSchema.safeParse({
    ...base,
    publicProviderReleaseId: RELEASE_B,
    details: {
      head: {
        platformKey: "alpha",
        release: proof(),
        providerCheckpoint: checkpoint(),
        observation: observation(),
        terminalReceiptSha256: HASH_A,
      },
    },
  }).success, false);
});

test("completion receipts bind exact predecessor, proof, and result head", () => {
  const context = releaseContext();
  const receipt = {
    ...receiptBase(),
    operationKind: "finalize",
    operationId: "provider:finalize:alpha:20",
    idempotencyKey: "provider:finalize:alpha:20",
    terminalState: "complete",
    result: "completed",
    details: {
      ...context,
      completedHead: {
        platformKey: "alpha",
        release: context.release,
        providerCheckpoint: context.providerCheckpoint,
        observation: context.observation,
      },
    },
  };
  assert.equal(providerReleaseCompletionReceiptSchema.safeParse(receipt).success, true);

  const advancingContext = releaseContext(
    proof(RELEASE_B),
    predecessor(RELEASE_A, "15"),
  );
  const advancingReceipt = {
    ...receipt,
    publicProviderReleaseId: RELEASE_B,
    details: {
      ...advancingContext,
      completedHead: {
        platformKey: "alpha",
        release: advancingContext.release,
        providerCheckpoint: advancingContext.providerCheckpoint,
        observation: advancingContext.observation,
      },
    },
  };
  assert.equal(
    providerReleaseCompletionReceiptSchema.safeParse(advancingReceipt).success,
    true,
  );
  const regressedContext = releaseContext(
    proof(RELEASE_B),
    predecessor(RELEASE_A, "20"),
  );
  assert.equal(providerReleaseCompletionReceiptSchema.safeParse({
    ...advancingReceipt,
    details: {
      ...regressedContext,
      completedHead: {
        platformKey: "alpha",
        release: regressedContext.release,
        providerCheckpoint: regressedContext.providerCheckpoint,
        observation: regressedContext.observation,
      },
    },
  }).success, false);
  assert.equal(providerReleaseCompletionReceiptSchema.safeParse({
    ...receipt,
    details: {
      ...receipt.details,
      completedHead: {
        ...receipt.details.completedHead,
        providerCheckpoint: checkpoint("19"),
      },
    },
  }).success, false);
  assert.equal(providerReleaseCompletionReceiptSchema.safeParse({
    ...receipt,
    details: {
      ...receipt.details,
      completedHead: {
        ...receipt.details.completedHead,
        release: proof(RELEASE_B),
      },
    },
  }).success, false);

  const envelope = {
    ok: true,
    receipt,
    responseAuth: {
      signatureVersion: "v1",
      keyId: "publisher.v1",
      receiptDigest: HASH_B,
      signature: HASH_A,
    },
  };
  assert.equal(providerReleaseSignedReceiptEnvelopeSchema.safeParse(envelope).success, true);
  assert.equal(providerReleaseSignedReceiptEnvelopeSchema.safeParse({
    ...envelope,
    responseAuth: { ...envelope.responseAuth, receiptDigest: HASH_A },
  }).success, false);
});

test("reuse receipts require one exact predecessor and a later checkpoint", () => {
  const context = releaseContext(
    proof(RELEASE_A, epoch()),
    predecessor(RELEASE_A, "15", epoch()),
  );
  const receipt = {
    ...receiptBase(),
    operationKind: "confirmReuse",
    operationId: "provider:reuse:alpha:20",
    idempotencyKey: "provider:reuse:alpha:20",
    terminalState: "complete",
    result: "reused",
    details: {
      ...context,
      completedHead: {
        platformKey: "alpha",
        release: context.release,
        providerCheckpoint: context.providerCheckpoint,
        observation: context.observation,
      },
    },
  };
  assert.equal(providerReleaseReuseReceiptSchema.safeParse(receipt).success, true);
  assert.equal(providerReleaseReuseReceiptSchema.safeParse({
    ...receipt,
    details: {
      ...receipt.details,
      expectedCompletedHead: emptyHead(),
    },
  }).success, false);

  const unchangedCheckpointContext = releaseContext(
    proof(RELEASE_A, epoch()),
    predecessor(RELEASE_A, "20", epoch()),
  );
  assert.equal(providerReleaseReuseReceiptSchema.safeParse({
    ...receipt,
    details: {
      ...unchangedCheckpointContext,
      completedHead: {
        platformKey: "alpha",
        release: unchangedCheckpointContext.release,
        providerCheckpoint: unchangedCheckpointContext.providerCheckpoint,
        observation: unchangedCheckpointContext.observation,
      },
    },
  }).success, false);

  const changedEpochContext = releaseContext(
    proof(RELEASE_A, epoch("11")),
    predecessor(RELEASE_A, "15", epoch()),
  );
  assert.equal(providerReleaseReuseReceiptSchema.safeParse({
    ...receipt,
    sharedConfigurationEpoch: epoch("11"),
    details: {
      ...changedEpochContext,
      completedHead: {
        platformKey: "alpha",
        release: changedEpochContext.release,
        providerCheckpoint: changedEpochContext.providerCheckpoint,
        observation: changedEpochContext.observation,
      },
    },
  }).success, false);
});

test("provider errors and receipt digests are strict and stable", async () => {
  assert.deepEqual(providerReleaseErrorEnvelopeSchema.parse({
    error: "provider release checkpoint regressed",
    code: "PROVIDER_RELEASE_CHECKPOINT_REGRESSED",
  }), {
    error: "provider release checkpoint regressed",
    code: "PROVIDER_RELEASE_CHECKPOINT_REGRESSED",
  });
  assert.equal(classifyProviderReleaseError("PROVIDER_RELEASE_AUTH_INVALID"), "authentication");
  assert.equal(classifyProviderReleaseError("PROVIDER_RELEASE_AUTH_STALE"), "bounded_retry");
  assert.equal(classifyProviderReleaseError("PROVIDER_RELEASE_HASH_MISMATCH"), "terminal");
  assert.equal(providerReleaseErrorEnvelopeSchema.safeParse({
    error: "bad",
    code: "PUBLICATION_INTERNAL_ERROR",
  }).success, false);
  assert.equal(
    await providerReleaseReceiptDigest({ result: "ok", receiptDigest: HASH_A }),
    await providerReleaseReceiptDigest({ receiptDigest: HASH_B, result: "ok" }),
  );
});
