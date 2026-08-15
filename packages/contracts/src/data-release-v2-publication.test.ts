import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalJson,
  classifyProductionDataReleaseError,
  productionAuthKeyIdSchema,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  productionReceiptSchema,
  productionSignedReceiptEnvelopeSchema,
  productionStartRequestSchema,
  recomputeProductionBatchHash,
  sha256CanonicalJson,
} from "./data-release-v2.ts";

test("canonical hashes are recursively ordered and independently reproducible", async () => {
  const value = { z: [{ b: true, a: 1 }], a: "value" };
  const domain = "packscout.contract-test.v1";
  const serialized = canonicalJson({ domain, value });
  assert.equal(
    await sha256CanonicalJson(domain, value),
    createHash("sha256").update(serialized).digest("hex"),
  );
  assert.equal(serialized, '{"domain":"packscout.contract-test.v1","value":{"a":"value","z":[{"a":1,"b":true}]}}');
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /non-finite/);
});

test("runtime-neutral publication schemas cover requests and signed terminal receipts", () => {
  const hash = "a".repeat(64);
  const publicationId = "50000000-0000-4000-8000-000000000001";
  const request = productionStartRequestSchema.parse({
    schemaVersion: "data_release_v2",
    operationId: `start:${publicationId}`,
    idempotencyKey: `start:${publicationId}`,
    publicationId,
    expectedPredecessorPublicReleaseId: null,
    manifest: {
      publicReleaseId: publicationId,
      sourceWatermark: "public-change:1",
      observationSequence: 1,
      manifestFingerprint: hash,
      contentHash: hash,
      publicConfigRevision: 1,
      publicConfigHash: hash,
      originSetHash: hash,
      searchAlgorithmVersion: "repack_search_v2",
      repackSearchIndexHash: hash,
      confidencePolicyVersion: "confidence-v1",
      createdAt: "2026-08-15T00:00:00.000Z",
      dataAsOf: "2026-08-15T00:00:00.000Z",
      lastSuccessfulObservationAt: "2026-08-15T00:00:00.000Z",
      staleAt: "2026-08-15T00:15:00.000Z",
      freshness: "fresh",
      delayedVendorCount: 0,
      counts: { vendors: 0, categories: 0, collectibles: 0, repacks: 0, repackChases: 0, searchShards: 0 },
      batchCount: 0,
      batchChainHash: hash,
      publicAssetOrigins: [],
    },
  });
  assert.equal(request.manifest.observationSequence, 1);
  const envelope = productionSignedReceiptEnvelopeSchema.parse({
    ok: true,
    receipt: {
      schemaVersion: "data_release_v2",
      operationId: "missing-operation",
      publicationId: null,
      terminalState: "not_found",
      result: "not_found",
      serverTime: "2026-08-15T00:00:00.000Z",
      requestDigest: hash,
      details: {},
      receiptDigest: null,
    },
    responseAuth: {
      signatureVersion: "v1",
      keyId: "publisher.v1",
      receiptDigest: hash,
      signature: hash,
    },
  });
  assert.equal(envelope.receipt.terminalState, "not_found");
  assert.equal(classifyProductionDataReleaseError("PUBLICATION_AUTH_STALE"), "bounded_retry");
  assert.equal(classifyProductionDataReleaseError("PUBLICATION_INTERNAL_ERROR"), "bounded_retry");
  assert.equal(classifyProductionDataReleaseError("PUBLICATION_RECONCILIATION_FAILED"), "terminal");
  assert.equal(productionReceiptSchema.safeParse({
    schemaVersion: "data_release_v2",
    operationId: "arbitrary",
    operationKind: "start",
    publicationId,
    terminalState: "complete",
    result: "anything",
    serverTime: "2026-08-15T00:00:00.000Z",
    requestDigest: hash,
    details: {},
    receiptDigest: hash,
  }).success, false);
});

test("publication signing values are canonical across runtimes", () => {
  const digest = "a".repeat(64);
  assert.equal(productionPublicationRequestSigningValue({
    method: "post",
    path: "/internal/data-release/v2/start",
    bodyDigest: digest,
    timestamp: "1786813200000",
    nonce: "nonce0000000000000001",
  }), `v1\nPOST\n/internal/data-release/v2/start\n${digest}\n1786813200000\nnonce0000000000000001`);
  assert.equal(
    productionPublicationReceiptSigningValue(digest),
    `v1\nreceipt\n${digest}`,
  );
  assert.equal(productionAuthKeyIdSchema.safeParse("publisher.v1").success, true);
  assert.equal(
    productionAuthKeyIdSchema.safeParse(`${"a".repeat(61)}.v1`).success,
    false,
  );
});

test("batch hashes ignore transport envelope fields", async () => {
  const records = [{ publicVendorId: "vendor-1", name: "Vendor One" }];
  const expected = await recomputeProductionBatchHash({ kind: "vendors", records });
  const request = {
    kind: "vendors",
    records,
    operationId: "apply:release:0",
    batchIndex: 0,
    batchHash: "a".repeat(64),
  } as const;
  const fromRequest = await recomputeProductionBatchHash(request);

  assert.equal(fromRequest, expected);
});
