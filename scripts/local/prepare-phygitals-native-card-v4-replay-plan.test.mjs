import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  PhygitalsCardV4ReplayError,
  assertPhygitalsV4ReplaySnapshot,
  executeGuardedPhygitalsV4Replay,
  phygitalsV4ReplayPins: pins,
  probePhygitalsV4CardMapping,
  validatePhygitalsV4MappingAdmission,
} = await tsImport("./prepare-phygitals-native-card-v4-replay-plan.mts", import.meta.url);

function snapshot() {
  return {
    providerId: pins.providerId, providerKey: "phygitals",
    databaseRole: "provider", schemaVersion: "distributed-provider-v1",
    runtimeState: "idle", generation: "4", cachedConfigId: pins.previousConfigId, cachedConfigNumber: "3",
    cursorHash: pins.cursorHash, cursorPresent: true, cursorFingerprintMatches: true,
    activeRunCount: 0, actionableCommandCount: 0, runCount: 2, commandCount: 2,
    canonicalCount: 741, canonicalIdentityDigest: pins.canonicalIdentityDigest, promotionChangeCount: 741, pageCount: 284,
    quarantineCount: 15_092, exactHistoricalQuarantineCount: 15_092,
    run: {
      id: pins.stoppedRunId, state: "incomplete", configId: pins.previousConfigId,
      configNumber: "3", workerFence: "3", commandId: pins.stoppedCommandId, pageCount: 151,
      catalogCount: 15_100, pullCount: 0, marketCount: 0, acceptedCount: 741,
      duplicateCount: 12_567, quarantinedCount: 1_792, materialChangeCount: 741,
      finalCursorHash: pins.cursorHash, reachedHead: false,
      failureCode: "SOURCE_RECORD_MAPPING_INVALID", finishedAt: pins.stoppedAt,
    },
  };
}

test("Phygitals replay accepts only its exact stopped retained-canonical checkpoint or prepared origin", () => {
  assert.equal(assertPhygitalsV4ReplaySnapshot(snapshot()), "previous");
  assert.equal(assertPhygitalsV4ReplaySnapshot({ ...snapshot(),
    cachedConfigId: pins.configId, cachedConfigNumber: "4", cursorHash: null, cursorPresent: false }), "prepared");
  for (const change of [
    { providerId: "wrong" }, { providerKey: "collector_crypt" },
    { databaseRole: "central" }, { schemaVersion: "unexpected" },
    { runtimeState: "running" }, { generation: "3" }, { cachedConfigId: "wrong" },
    { cursorHash: "0".repeat(64) }, { cursorPresent: false }, { cursorFingerprintMatches: false },
    { cachedConfigNumber: "1" }, { canonicalIdentityDigest: "0".repeat(64) },
    { activeRunCount: 1 }, { actionableCommandCount: 1 }, { runCount: 3 }, { commandCount: 3 },
    { canonicalCount: 742 }, { promotionChangeCount: 742 }, { pageCount: 134 },
    { quarantineCount: 13_299 }, { exactHistoricalQuarantineCount: 13_299 },
    { cachedConfigId: pins.configId }, { run: null },
  ]) assert.throws(() => assertPhygitalsV4ReplaySnapshot({ ...snapshot(), ...change }), PhygitalsCardV4ReplayError);
});

test("replay refuses edited history, a different cursor, or a completed run", () => {
  for (const change of [
    { id: "different-run" }, { configId: pins.configId }, { configNumber: "4" }, { workerFence: "4" },
    { commandId: "different-command" }, { state: "complete" }, { pageCount: 134 },
    { catalogCount: 13_301 }, { pullCount: 1 }, { marketCount: 1 }, { acceptedCount: 1 },
    { duplicateCount: 1 }, { quarantinedCount: 0 }, { materialChangeCount: 1 },
    { finalCursorHash: "0".repeat(64) }, { reachedHead: true },
    { failureCode: null }, { finishedAt: "2026-08-30T01:08:37Z" },
  ]) assert.throws(() => assertPhygitalsV4ReplaySnapshot({ ...snapshot(), run: {
    ...snapshot().run, ...change,
  } }), PhygitalsCardV4ReplayError);
});

function page() {
  return { next_cursor: "bounded-probe-cursor", poll_after_seconds: 0,
    records: Array.from({ length: 100 }, (_, index) => ({
      platform: "phygitals", stream: "catalog", entity: "card",
      record_id: `envelope-${index}`, occurred_at: "2026-08-30T01:00:00Z",
      collected_at: "2026-08-30T01:00:01Z", first_seen_at: "2026-08-30T01:00:00Z",
      available: true, data: { [index < 29 ? "chase" : "asset"]: {
        id: `nested-${index}`, name: `Card ${index}`, image: "https://example.test/card.png",
        fmv: 300, altFmv: 300, price: null, currency: null,
        owner: "private-owner", address: "private-address", metadata: { private: true },
      } },
    })),
  };
}

test("bounded replay admission exercises both actual wrappers through the production mapper", () => {
  const proof = validatePhygitalsV4MappingAdmission(page());
  assert.equal(proof.recordCount, 100);
  assert.equal(proof.collectibleCount, 100);
  assert.equal(proof.quarantineCount, 0);
  assert.equal(proof.chaseCount, 29);
  assert.equal(proof.assetCount, 71);
  assert.equal(proof.adapterVersion, "dataforrest-phygitals-distributed-adapter-v2");
  assert.equal(proof.mapperKey, "phygitals-provider-observation");
  assert.equal(JSON.stringify(proof).includes("private-owner"), false);
  assert.equal(JSON.stringify(proof).includes("nested-"), false);
});

test("no replay admission succeeds with a crossed provider, ambiguous original wrappers, or malformed name", () => {
  for (const change of [
    { platform: "courtyard" },
    { data: { chase: { name: "One" }, asset: { name: "Two" } } },
    { data: { chase: { name: 42 } } },
    { data: { name: "Do not guess" } },
  ]) {
    const candidate = page();
    candidate.records[0] = { ...candidate.records[0], ...change };
    assert.throws(() => validatePhygitalsV4MappingAdmission(candidate), PhygitalsCardV4ReplayError);
  }
  assert.throws(() => validatePhygitalsV4MappingAdmission({ ...page(), records: [] }), PhygitalsCardV4ReplayError);
});

test("four-wrapper admission deterministically prefers inventory labels and never borrows another image", () => {
  const candidate = page();
  candidate.records = candidate.records.map((record, index) => ({ ...record, data:
    index < 25 ? { chase: { name: "Chase" } } :
    index < 50 ? { asset: { name: "Asset" }, nft: { name: "Different ignored NFT" } } :
    index < 75 ? { inventory: { title: "Inventory" }, nft: { name: "Different NFT", image: "https://example.test/not-selected.png" } } :
      { nft: { name: "NFT", image: "https://example.test/selected.png" } },
  }));
  const proof = validatePhygitalsV4MappingAdmission(candidate);
  assert.equal(proof.recordCount, 100);
  assert.equal(proof.quarantineCount, 0);
  assert.deepEqual([proof.chaseCount, proof.assetCount, proof.inventoryCount, proof.nftCount], [25, 25, 25, 25]);
});

test("non-200 valid-looking probe responses are rejected and protected bytes are zeroed", async () => {
  for (const status of [202, 206, 301, 401, 403, 429, 500]) {
    const protectedBody = new TextEncoder().encode(JSON.stringify(page()));
    await assert.rejects(() => probePhygitalsV4CardMapping("fixture-token", null, async () => ({
      status, protectedBody, responseBytes: protectedBody.byteLength, durationMilliseconds: 1,
    })), (error) => error instanceof PhygitalsCardV4ReplayError &&
      error.code === "PHYGITALS_MAPPING_PROBE_STATUS_INVALID");
    assert.equal(protectedBody.every((byte) => byte === 0), true);
  }
});

test("invalid checkpoint has zero downstream activation or cursor synchronization mutations", async () => {
  for (const change of [{ runCount: 3 }, { canonicalCount: 742 }, { cursorHash: "0".repeat(64) }]) {
    let mutations = 0;
    await assert.rejects(() => executeGuardedPhygitalsV4Replay({
      readCheckpoint: async () => ({ ...snapshot(), ...change }),
      activate: async () => { mutations += 1; },
      synchronize: async () => { mutations += 1; },
    }), PhygitalsCardV4ReplayError);
    assert.equal(mutations, 0);
  }
});

test("guarded replay resumes after central activation but preserves all old history", async () => {
  let state = snapshot();
  let activated = false;
  await assert.rejects(() => executeGuardedPhygitalsV4Replay({
    readCheckpoint: async () => state,
    activate: async () => { activated = true; },
    synchronize: async () => { throw new Error("simulated interruption"); },
  }));
  assert.equal(activated, true);
  assert.deepEqual(state, snapshot());
  const after = await executeGuardedPhygitalsV4Replay({
    readCheckpoint: async () => state,
    activate: async () => { assert.equal(activated, true); },
    synchronize: async () => { state = { ...state,
      cachedConfigId: pins.configId, cachedConfigNumber: "4", cursorHash: null, cursorPresent: false }; },
  });
  assert.equal(assertPhygitalsV4ReplaySnapshot(after), "prepared");
  assert.deepEqual(after.run, snapshot().run);
  assert.equal(after.quarantineCount, 15_092);
});
