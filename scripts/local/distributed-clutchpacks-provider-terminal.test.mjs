import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  REPACK_SEARCH_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
  providerReleaseReceiptDigest,
  providerReleaseTerminalReceiptSha256,
} = await tsImport("@packscout/contracts", import.meta.url);
const {
  parseProviderPromotionOperation,
  prepareProviderPromotion,
  providerPromotionStatusRequest,
  validateProviderPromotionReceipt,
} = await tsImport("@packscout/services", import.meta.url);
const { resolveLocalClutchpacksProviderTerminal } = await tsImport(
  "./distributed-clutchpacks-provider-terminal.mts", import.meta.url,
);

const epoch = {
  configurationKey: "local-clutchpacks-distributed-v1", revision: 2,
  publicChangeSequence: "2", configurationHash: "a".repeat(64),
};
const proof = {
  platformKey: "clutchpacks", sharedConfigurationEpoch: epoch,
  dataAsOf: "2026-08-29T21:00:00.000Z",
  publicProviderReleaseId: "10000000-0000-5000-8000-000000000001",
  providerReleaseFingerprint: "b".repeat(64), contentHash: "c".repeat(64),
  publicAssetOrigins: ["https://cdn.example.test"],
  governingHashes: Object.fromEntries([
    "providerConfigurationHash", "sharedCategoriesHash", "identityMappingsHash",
    "originSetHash", "confidencePolicyHash",
  ].map((key) => [key, "d".repeat(64)])),
  entityHashes: Object.fromEntries([
    "vendors", "categories", "collectibles", "repacks", "repack_chases", "search_shards",
  ].map((key) => [key, "e".repeat(64)])),
  counts: { vendors: 1, categories: 0, collectibles: 0, repacks: 0, repackChases: 0, searchShards: 0 },
  searchAlgorithmVersion: REPACK_SEARCH_VERSION,
  providerSearchIndexHash: "f".repeat(64), batchCount: 1, batchChainHash: "a".repeat(64),
};
const emptyHead = {
  platformKey: "clutchpacks", publicProviderReleaseId: null,
  sharedConfigurationEpoch: null,
  providerCheckpoint: { settledSequence: "0", settledAt: null },
  observation: null, terminalReceiptSha256: null,
};
function plan(sequence, release = proof) {
  const at = sequence === 5 ? "2026-08-29T21:30:00.000Z" : "2026-08-29T22:00:00.000Z";
  return {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish", ...release,
    providerCheckpoint: { settledSequence: String(sequence), settledAt: at },
    sourceWatermark: buildProviderCatalogSourceWatermarkV1("clutchpacks", String(sequence)),
    observation: { sourceHeadSequence: String(sequence), lastSuccessfulObservationAt: at,
      staleAt: "2026-08-29T23:00:00.000Z", freshness: "fresh" },
    // Receipt recovery never republishes batches. This fixture isolates the
    // signed terminal request/receipt contract from public catalog contents.
    batches: [],
  };
}
function expectedHead(head) {
  return {
    platformKey: head.platformKey, publicProviderReleaseId: head.release.publicProviderReleaseId,
    sharedConfigurationEpoch: head.release.sharedConfigurationEpoch,
    providerCheckpoint: head.providerCheckpoint, observation: head.observation,
    terminalReceiptSha256: head.terminalReceiptSha256,
  };
}
function prepare(value, predecessor) {
  return prepareProviderPromotion({
    plan: value, expectedCompletedHead: predecessor, checkpointSha256: "b".repeat(64),
  });
}
async function completed(operation) {
  const request = parseProviderPromotionOperation(operation);
  const head = {
    platformKey: "clutchpacks", release: request.release,
    providerCheckpoint: request.providerCheckpoint, observation: request.observation,
  };
  const body = {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationKind: operation.operationKind, operationId: request.operationId,
    idempotencyKey: request.idempotencyKey, platformKey: "clutchpacks",
    publicProviderReleaseId: request.release.publicProviderReleaseId,
    sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
    providerCheckpoint: request.providerCheckpoint, terminalState: "complete",
    result: operation.operationKind === "confirmReuse" ? "reused" : "completed",
    serverTime: "2026-08-29T22:00:01.000Z", requestDigest: operation.requestSha256,
    details: { release: request.release, providerCheckpoint: request.providerCheckpoint,
      sourceWatermark: request.sourceWatermark, observation: request.observation,
      expectedCompletedHead: request.expectedCompletedHead, completedHead: head },
  };
  const receipt = { ...body, receiptDigest: await providerReleaseReceiptDigest(body) };
  const observed = { receipt, canonicalReceiptBody: canonicalJson(receipt),
    receiptSha256: await providerReleaseTerminalReceiptSha256(receipt) };
  validateProviderPromotionReceipt({ operation, ...observed });
  return { observed, head: { ...head, terminalReceiptSha256: observed.receiptSha256 } };
}
function manifestFor(head, operation, { delayed = false } = {}) {
  return {
    activeManifest: { sharedConfigurationEpoch: head.release.sharedConfigurationEpoch },
    observation: { providerSelections: [{
      platformKey: "clutchpacks", publicProviderReleaseId: head.release.publicProviderReleaseId,
      terminalOperationKind: operation.operationKind, terminalOperationId: operation.operationId,
      terminalReceiptSha256: head.terminalReceiptSha256,
      selectedProviderCheckpoint: head.providerCheckpoint,
      latestAffectedSourceHeadSequence: head.observation.sourceHeadSequence,
      lastSuccessfulObservationAt: head.observation.lastSuccessfulObservationAt,
      staleAt: head.observation.staleAt, settledSourceFreshness: delayed ? "delayed" : "fresh",
    }] },
  };
}
async function fixture() {
  const originalPlan = plan(5);
  const originalOperation = prepare(originalPlan, emptyHead).operations.at(-1);
  const original = await completed(originalOperation);
  const nextPlan = plan(6);
  const prepared = prepare({ ...nextPlan, classification: "reuse",
    reuseProof: { state: "complete", ...proof } }, expectedHead(original.head));
  assert.equal(prepared.operations.length, 1, "reuse issues no start, batch, or finalize writes");
  const operation = prepared.operations[0];
  const next = await completed(operation);
  return { originalPlan, originalOperation, original, nextPlan, prepared, operation, next };
}

test("an interrupted checkpoint reuse recovers its exact signed terminal operation", async () => {
  const f = await fixture();
  const requests = [];
  const actual = await resolveLocalClutchpacksProviderTerminal({
    head: f.next.head, plan: f.nextPlan,
    manifestState: manifestFor(f.original.head, f.originalOperation, { delayed: true }),
    client: { async status(request) { requests.push(request); return f.next.observed; } },
  });
  assert.deepEqual(requests, [providerPromotionStatusRequest(f.operation)]);
  assert.deepEqual(actual, { terminalOperationKind: "confirmReuse",
    terminalOperationId: f.operation.operationId,
    terminalReceiptSha256: f.next.observed.receiptSha256 });
});

test("a completed manifest replay preserves the recorded operation kind and ID without another request", async () => {
  const f = await fixture();
  const selectedOperation = { operationKind: "confirmReuse", operationId: "recorded-reuse-operation" };
  const actual = await resolveLocalClutchpacksProviderTerminal({
    head: f.next.head, plan: f.nextPlan,
    manifestState: manifestFor(f.next.head, selectedOperation),
    client: { async status() { assert.fail("matching signed selection needs no receipt query"); } },
  });
  assert.equal(actual.terminalOperationKind, "confirmReuse");
  assert.equal(actual.terminalOperationId, "recorded-reuse-operation");
});

test("an interrupted first publication recovers the exact finalize receipt from genesis", async () => {
  const f = await fixture();
  const actual = await resolveLocalClutchpacksProviderTerminal({
    head: f.original.head, plan: f.originalPlan, manifestState: { activeManifest: null },
    client: { async status(request) {
      assert.deepEqual(request, providerPromotionStatusRequest(f.originalOperation));
      return f.original.observed;
    } },
  });
  assert.equal(actual.terminalOperationKind, "finalize");
  assert.equal(actual.terminalReceiptSha256, f.original.head.terminalReceiptSha256);
});

test("receipt recovery refuses wrong requests, mismatched terminal hashes, and concurrent predecessor changes", async () => {
  const f = await fixture();
  const input = { head: f.next.head, plan: f.nextPlan,
    manifestState: manifestFor(f.original.head, f.originalOperation) };
  await assert.rejects(resolveLocalClutchpacksProviderTerminal({ ...input,
    client: { async status() { return f.original.observed; } },
  }), (error) => error.code === "PROVIDER_RECEIPT_INVALID");
  await assert.rejects(resolveLocalClutchpacksProviderTerminal({ ...input,
    head: { ...f.next.head, terminalReceiptSha256: "c".repeat(64) },
    client: { async status() { return f.next.observed; } },
  }), (error) => error.code === "LOCAL_CONVEX_PROVIDER_TERMINAL_NOT_OBSERVED");
  const changedManifest = structuredClone(input.manifestState);
  changedManifest.observation.providerSelections[0].lastSuccessfulObservationAt = "2026-08-29T21:29:00.000Z";
  await assert.rejects(resolveLocalClutchpacksProviderTerminal({ ...input,
    manifestState: changedManifest,
    client: { async status() { return f.next.observed; } },
  }), (error) => error.code === "PROVIDER_RECEIPT_INVALID");
});

test("unrelated or nonadvancing signed manifest scope refuses before a receipt query", async () => {
  const f = await fixture();
  for (const mutate of [
    (value) => { value.observation.providerSelections[0].platformKey = "courtyard"; },
    (value) => { value.activeManifest.sharedConfigurationEpoch.configurationKey = "production"; },
    (value) => { value.observation.providerSelections[0].selectedProviderCheckpoint = f.next.head.providerCheckpoint; },
  ]) {
    const manifestState = structuredClone(manifestFor(f.original.head, f.originalOperation));
    mutate(manifestState);
    await assert.rejects(resolveLocalClutchpacksProviderTerminal({
      head: f.next.head, plan: f.nextPlan, manifestState,
      client: { async status() { assert.fail("unproved predecessor must not be queried"); } },
    }), (error) => error.code === "LOCAL_CONVEX_PROVIDER_TERMINAL_NOT_OBSERVED");
  }
});
