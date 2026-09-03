import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const contracts = await tsImport("@packscout/contracts", import.meta.url);
const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const census = await tsImport("./dataforrest-catalog-bridge-source-census.mts", import.meta.url);
const proofModule = await tsImport("./dataforrest-catalog-bridge-source-census-proof.mts", import.meta.url);
const inspection = await tsImport("./dataforrest-catalog-bridge-source-inspection.mts", import.meta.url);
const capture = await tsImport("./capture-dataforrest-catalog-bridge-source-census.mts", import.meta.url);

const definition = plan.catalogBridgeProvider("collector_crypt");
const operationId = "90000000-0000-4000-8000-000000000001";
const commit = "a".repeat(40);
const hash = value => createHash("sha256").update(value).digest("hex");

function authority(token = "private-source-token") {
  return { organizationId: definition.organizationId, providerId: definition.providerId,
    providerKey: definition.providerKey, configVersionId: definition.currentConfigId,
    configVersionNumber: BigInt(definition.currentConfigNumber),
    adapterKey: definition.currentEventManifest.adapterVersion,
    sourceTypeKey: definition.currentEventManifest.sourceTypeKey,
    sourceAdapterVersion: definition.currentEventManifest.adapterVersion,
    sourceCredentialVersionId: "70000000-0000-4000-8000-000000000001",
    sourceCredentialVersionNumber: 1n, expiresAt: null,
    connectionConfiguration: { endpoint: contracts.DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerToken: token },
    sourceConfiguration: { platform: definition.providerKey } };
}

function outcome(entity, providerRecordId) {
  return { status: "valid", recordIndex: 0,
    observation: { kind: "catalog", entity,
      providerRecordIdentity: { recordIdScopeKey: entity === "card"
        ? "catalog-card-v1" : "catalog-pack-v1", providerRecordId } } };
}

function inspectedPage(outcomes, nextCursor, continuation = "poll_after") {
  const bodyBytes = 1000;
  return { inspection: { kind: "untrusted_inspection", ok: true,
    recordCount: outcomes.length, outcomes,
    continuation: continuation === "poll_after"
      ? { kind: "poll_after", minimumDelaySeconds: 60 } : { kind: "continue" } },
  checkedAt: "2026-09-01T01:00:00.000Z", status: 200,
  responseBytes: bodyBytes, durationMilliseconds: 1,
  responseSha256: hash(`response:${nextCursor}`), nextCursor,
  nextCursorHash: hash(nextCursor) };
}

function syntheticProof(overrides = {}) {
  const counts = definition.documentedCatalogFloor;
  const sourceRecordCount = counts.card + counts.pack;
  const pageCount = Math.ceil(sourceRecordCount / definition.catalogManifest.requestBounds.pageLimit);
  const pass = (passNumber, startedAt, completedAt) => ({ passNumber, startedAt, completedAt,
    pageCount, sourceRequestCount: pageCount, sourceRecordCount,
    rawCardObservationCount: counts.card, rawPackObservationCount: counts.pack,
    distinctCardIdentityCount: counts.card, distinctPackIdentityCount: counts.pack,
    identityMultisetDigest: hash("identities"), traversalChainDigest: hash("traversal"),
    finalCursorHash: hash("head"), maximumResponseBytes: 1000,
    totalResponseBytes: pageCount * 1000 });
  return proofModule.catalogBridgeSourceCensusSchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_source_census_v1",
    authorization: "operator_requested_read_only_catalog_source_census",
    operationId,
    providerKey: definition.providerKey, capturedAt: "2026-09-01T00:04:00.000Z",
    executor: { checkout: "/private/approved/collector-census", commit,
      runnerModuleSha256: hash("runner"), censusModuleSha256: hash("census"),
      inspectionModuleSha256: hash("inspection") },
    source: { providerId: definition.providerId, configId: definition.currentConfigId,
      configNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      catalogAdapterVersion: definition.catalogAdapterVersion,
      sourceCredentialDigest: inspection.catalogBridgeSourceCredentialDigest(authority()),
      pageLimit: definition.catalogManifest.requestBounds.pageLimit,
      requestTimeoutMilliseconds: definition.catalogManifest.requestBounds.timeoutMilliseconds,
      maximumResponseBytes: definition.catalogManifest.requestBounds.maximumResponseBytes },
    passes: [pass(1, "2026-09-01T00:00:00.000Z", "2026-09-01T00:02:00.000Z"),
      pass(2, "2026-09-01T00:02:01.000Z", "2026-09-01T00:04:00.000Z")],
    agreement: { sourceRecordCount, cardCount: counts.card, packCount: counts.pack,
      pageCount, identityMultisetDigest: hash("identities"),
      traversalChainDigest: hash("traversal"), finalCursorHash: hash("head") },
    databaseWritesPerformed: false, sourceRequestsPerformed: true,
    rawResponsesPersisted: false, rawCursorsPersisted: false,
    sourceRecordIdsPersisted: false, ...overrides,
  });
}

test("census CLI requires an exact Collector capture contract", () => {
  const args = ["--capture", "--operation-id", operationId,
    "--provider-key", "collector_crypt", "--executor-checkout",
    "/private/approved/collector-census", "--executor-commit", commit,
    "--output", "/private/evidence/source-census.json"];
  assert.deepEqual(capture.parseCatalogBridgeSourceCensusCaptureArguments(args), {
    operationId, providerKey: "collector_crypt",
    executorCheckout: "/private/approved/collector-census",
    executorCommit: commit, outputPath: "/private/evidence/source-census.json" });
  for (const invalid of [args.slice(1), [...args, "--output", "/private/other.json"],
    args.map(value => value === "collector_crypt" ? "courtyard" : value),
    args.map(value => value === operationId ? "not-a-uuid" : value),
    args.map(value => value === commit ? "A".repeat(40) : value),
    args.map(value => value === "/private/evidence/source-census.json" ? "relative.json" : value)]) {
    assert.throws(() => capture.parseCatalogBridgeSourceCensusCaptureArguments(invalid),
      { code: "CATALOG_BRIDGE_SOURCE_CENSUS_ARGUMENTS_INVALID" });
  }
});

test("source inspection sends the exact catalog filter, validates V2 packs and zeroes bytes", async () => {
  const privateCursor = "private-next-cursor";
  const token = "private-token-never-persist";
  const body = new TextEncoder().encode(JSON.stringify({ records: [
    { stream: "catalog", entity: "card", platform: definition.providerKey,
      record_id: "private-card-id", occurred_at: "2026-09-01T00:00:00Z",
      collected_at: "2026-09-01T00:00:01Z", first_seen_at: "2026-09-01T00:00:00Z",
      available: true, data: { asset: { title: "Card" } } },
    { stream: "catalog", entity: "pack", platform: definition.providerKey,
      record_id: "private-pack-id", occurred_at: "2026-09-01T00:00:00Z",
      collected_at: "2026-09-01T00:00:01Z", first_seen_at: "2026-09-01T00:00:00Z",
      data: { name: "Pack" } },
  ], next_cursor: privateCursor, poll_after_seconds: 60 }));
  let request;
  let protectedBody;
  const page = await inspection.inspectCatalogBridgeSourcePage({ authority: authority(token),
    manifest: definition.catalogManifest, stream: "catalog", cursor: null,
    signal: new AbortController().signal, now: () => new Date("2026-09-01T00:00:02Z"),
    captureResponse: async input => { request = input; protectedBody = body.slice();
      return { status: 200, protectedBody, responseBytes: protectedBody.byteLength,
        durationMilliseconds: 5 }; } });
  assert.equal(request.url.searchParams.get("platform"), definition.providerKey);
  assert.equal(request.url.searchParams.get("stream"), "catalog");
  assert.equal(request.url.searchParams.get("limit"), "100");
  assert.equal(request.url.searchParams.has("cursor"), false);
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.equal(page.inspection.outcomes.every(value => value.status === "valid"), true);
  assert.equal(page.nextCursor, privateCursor);
  assert.equal(JSON.stringify(page).includes(privateCursor), false);
  assert.equal(JSON.stringify(page).includes("private-card-id"), false);
  assert.equal(JSON.stringify(page).includes("private-pack-id"), false);
  assert.equal(protectedBody.every(byte => byte === 0), true);
});

test("two complete origin traversals produce the same exact identity evidence", async () => {
  let passNumber = 0;
  let requestCount = 0;
  const total = definition.documentedCatalogFloor.card + definition.documentedCatalogFloor.pack;
  const readPage = async (_authority, cursor) => {
    if (cursor === null) passNumber += 1;
    requestCount += 1;
    const pageNumber = cursor === null ? 1 : Number(cursor.split(":" ).at(-1));
    const start = (pageNumber - 1) * definition.catalogManifest.requestBounds.pageLimit;
    const end = Math.min(total, start + definition.catalogManifest.requestBounds.pageLimit);
    const outcomes = [];
    for (let index = start; index < end; index += 1) {
      const entity = index < definition.documentedCatalogFloor.card ? "card" : "pack";
      outcomes.push(outcome(entity, `${entity}-${index}`));
    }
    const reachedHead = end === total;
    const nextCursor = reachedHead ? "private-head-cursor" : `private-page:${pageNumber + 1}`;
    return inspectedPage(outcomes, nextCursor, reachedHead ? "poll_after" : "continue");
  };
  const times = ["2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z",
    "2026-09-01T01:00:01Z", "2026-09-01T02:00:00Z"];
  const proof = await capture.performCatalogBridgeSourceCensus({
    args: { operationId, providerKey: "collector_crypt",
      executorCheckout: "/private/approved/collector-census",
      executorCommit: commit, outputPath: "/private/evidence/source-census.json" },
    executor: { runnerModuleSha256: hash("runner"), censusModuleSha256: hash("census"),
      inspectionModuleSha256: hash("inspection") },
    resolveAuthority: async () => authority(), readPage,
    signal: new AbortController().signal, now: () => new Date(times.shift()) });
  assert.equal(passNumber, 2);
  assert.equal(proof.operationId, operationId);
  assert.equal(requestCount, proof.agreement.pageCount * 2);
  assert.equal(proof.agreement.cardCount, definition.documentedCatalogFloor.card);
  assert.equal(proof.agreement.packCount, definition.documentedCatalogFloor.pack);
  assert.equal(proof.passes[0].identityMultisetDigest, proof.passes[1].identityMultisetDigest);
  assert.equal(proof.passes[0].traversalChainDigest, proof.passes[1].traversalChainDigest);
  const serialized = JSON.stringify(proof);
  for (const privateValue of ["private-source-token", "private-head-cursor", "card-1", "pack-191400"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  let resolves = 0;
  const driftTimes = ["2026-09-01T03:00:00Z", "2026-09-01T04:00:00Z"];
  await assert.rejects(capture.performCatalogBridgeSourceCensus({
    args: { operationId, providerKey: "collector_crypt",
      executorCheckout: "/private/approved/collector-census",
      executorCommit: commit, outputPath: "/private/evidence/source-census.json" },
    executor: { runnerModuleSha256: hash("runner"), censusModuleSha256: hash("census"),
      inspectionModuleSha256: hash("inspection") },
    resolveAuthority: async () => authority(++resolves === 1 ? "first-token" : "changed-token"),
    readPage, signal: new AbortController().signal,
    now: () => new Date(driftTimes.shift()) }),
  { code: "CATALOG_BRIDGE_SOURCE_CENSUS_AUTHORITY_CHANGED" });
});

test("census refuses invalid records, duplicate identities and cursor stalls", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(census.captureCatalogBridgeSourceCensusPass({ passNumber: 1,
    authority: authority(), signal,
    readPage: async () => ({ ...inspectedPage([], "head"), inspection: {
      kind: "untrusted_inspection", ok: true, recordCount: 1,
      outcomes: [{ status: "invalid", recordIndex: 0 }],
      continuation: { kind: "poll_after", minimumDelaySeconds: 60 } } }) }),
  { code: "CATALOG_BRIDGE_SOURCE_CENSUS_PAGE_INVALID" });
  await assert.rejects(census.captureCatalogBridgeSourceCensusPass({ passNumber: 1,
    authority: authority(), signal,
    readPage: async () => inspectedPage([outcome("card", "duplicate"),
      outcome("card", "duplicate")], "head") }),
  { code: "CATALOG_BRIDGE_SOURCE_CENSUS_IDENTITY_INVALID" });
  let reads = 0;
  await assert.rejects(census.captureCatalogBridgeSourceCensusPass({ passNumber: 1,
    authority: authority(), signal,
    readPage: async () => { reads += 1; return inspectedPage([outcome("card", `card-${reads}`)],
      "same-cursor", "continue"); } }),
  { code: "CATALOG_BRIDGE_SOURCE_CENSUS_CURSOR_INVALID" });
});

test("proof schema and private reader reject pass disagreement, tampering and unsafe modes", async () => {
  const proof = syntheticProof();
  const drift = structuredClone(proof);
  drift.passes[1].identityMultisetDigest = hash("different");
  assert.equal(proofModule.catalogBridgeSourceCensusSchema.safeParse(drift).success, false);

  const temporaryBase = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporaryBase, "packscout-source-census-"));
  const file = path.join(root, "census.json");
  const bytes = proofModule.catalogBridgeSourceCensusBytes(proof);
  try {
    await chmod(root, 0o700);
    await writeFile(file, bytes, { mode: 0o600 });
    const expected = proofModule.catalogBridgeSourceCensusFileSha256(proof);
    const read = await census.readCatalogBridgeSourceCensus(file, expected);
    assert.equal(census.catalogBridgeSourceCensusDigest(read.proof), plan.catalogBridgeDigest(proof));
    await assert.rejects(census.readCatalogBridgeSourceCensus(file, hash("tampered")),
      { code: "CATALOG_BRIDGE_SOURCE_CENSUS_FILE_DIGEST_MISMATCH" });
    await chmod(file, 0o644);
    await assert.rejects(census.readCatalogBridgeSourceCensus(file, expected),
      { code: "CATALOG_BRIDGE_SOURCE_CENSUS_FILE_UNSAFE" });
  } finally {
    bytes.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
