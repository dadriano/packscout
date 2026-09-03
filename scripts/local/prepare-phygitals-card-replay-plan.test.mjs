import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  PhygitalsCardReplayError,
  assertPhygitalsReplaySnapshot,
  executeGuardedPhygitalsReplay,
  phygitalsReplayPins: pins,
  probePhygitalsCardMapping,
  validatePhygitalsMappingAdmission,
} = await tsImport("./prepare-phygitals-card-replay-plan.mts", import.meta.url);

function snapshot() {
  return {
    providerId: pins.providerId, providerKey: "phygitals",
    databaseRole: "provider", schemaVersion: "distributed-provider-v1",
    runtimeState: "idle", generation: "2", cachedConfigId: pins.previousConfigId, cachedConfigNumber: "2",
    cursorHash: pins.cursorHash, cursorPresent: true, cursorFingerprintMatches: true,
    activeRunCount: 0, actionableCommandCount: 0, runCount: 1, commandCount: 1,
    canonicalCount: 0, promotionChangeCount: 0, pageCount: 133,
    quarantineCount: 13_300, exactHistoricalQuarantineCount: 13_300,
    run: {
      id: pins.stoppedRunId, state: "incomplete", configId: pins.previousConfigId,
      configNumber: "2", commandId: pins.stoppedCommandId, pageCount: 133,
      catalogCount: 13_300, pullCount: 0, marketCount: 0, acceptedCount: 0,
      duplicateCount: 0, quarantinedCount: 13_300, materialChangeCount: 0,
      finalCursorHash: pins.cursorHash, reachedHead: false,
      failureCode: "SOURCE_RECORD_MAPPING_INVALID", finishedAt: pins.stoppedAt,
    },
  };
}

test("Phygitals replay accepts only its exact stopped zero-canonical checkpoint or prepared origin", () => {
  assert.equal(assertPhygitalsReplaySnapshot(snapshot()), "previous");
  assert.equal(assertPhygitalsReplaySnapshot({ ...snapshot(),
    cachedConfigId: pins.configId, cachedConfigNumber: "3", cursorHash: null, cursorPresent: false }), "prepared");
  for (const change of [
    { providerId: "wrong" }, { providerKey: "collector_crypt" },
    { databaseRole: "central" }, { schemaVersion: "unexpected" },
    { runtimeState: "running" }, { generation: "3" }, { cachedConfigId: "wrong" },
    { cursorHash: "0".repeat(64) }, { cursorPresent: false }, { cursorFingerprintMatches: false },
    { cachedConfigNumber: "1" },
    { activeRunCount: 1 }, { actionableCommandCount: 1 }, { runCount: 2 }, { commandCount: 2 },
    { canonicalCount: 1 }, { promotionChangeCount: 1 }, { pageCount: 134 },
    { quarantineCount: 13_299 }, { exactHistoricalQuarantineCount: 13_299 },
    { cachedConfigId: pins.configId }, { run: null },
  ]) assert.throws(() => assertPhygitalsReplaySnapshot({ ...snapshot(), ...change }), PhygitalsCardReplayError);
});

test("replay refuses edited history, a different cursor, or a completed run", () => {
  for (const change of [
    { id: "different-run" }, { configId: pins.configId }, { configNumber: "3" },
    { commandId: "different-command" }, { state: "complete" }, { pageCount: 134 },
    { catalogCount: 13_301 }, { pullCount: 1 }, { marketCount: 1 }, { acceptedCount: 1 },
    { duplicateCount: 1 }, { quarantinedCount: 0 }, { materialChangeCount: 1 },
    { finalCursorHash: "0".repeat(64) }, { reachedHead: true },
    { failureCode: null }, { finishedAt: "2026-08-30T01:08:37Z" },
  ]) assert.throws(() => assertPhygitalsReplaySnapshot({ ...snapshot(), run: {
    ...snapshot().run, ...change,
  } }), PhygitalsCardReplayError);
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
  const proof = validatePhygitalsMappingAdmission(page());
  assert.equal(proof.recordCount, 100);
  assert.equal(proof.collectibleCount, 100);
  assert.equal(proof.quarantineCount, 0);
  assert.equal(proof.chaseCount, 29);
  assert.equal(proof.assetCount, 71);
  assert.equal(proof.adapterVersion, "dataforrest-phygitals-distributed-adapter-v1");
  assert.equal(proof.mapperKey, "phygitals-provider-observation");
  assert.equal(JSON.stringify(proof).includes("private-owner"), false);
  assert.equal(JSON.stringify(proof).includes("nested-"), false);
});

test("no replay admission succeeds with a crossed provider, ambiguous wrapper, or malformed name", () => {
  for (const change of [
    { platform: "courtyard" },
    { data: { chase: { name: "One" }, asset: { name: "Two" } } },
    { data: { chase: { name: 42 } } },
    { data: { name: "Do not guess" } },
  ]) {
    const candidate = page();
    candidate.records[0] = { ...candidate.records[0], ...change };
    assert.throws(() => validatePhygitalsMappingAdmission(candidate), PhygitalsCardReplayError);
  }
  assert.throws(() => validatePhygitalsMappingAdmission({ ...page(), records: [] }), PhygitalsCardReplayError);
});

test("non-200 valid-looking probe responses are rejected and protected bytes are zeroed", async () => {
  for (const status of [202, 206, 301, 401, 403, 429, 500]) {
    const protectedBody = new TextEncoder().encode(JSON.stringify(page()));
    await assert.rejects(() => probePhygitalsCardMapping("fixture-token", async () => ({
      status, protectedBody, responseBytes: protectedBody.byteLength, durationMilliseconds: 1,
    })), (error) => error instanceof PhygitalsCardReplayError &&
      error.code === "PHYGITALS_MAPPING_PROBE_STATUS_INVALID");
    assert.equal(protectedBody.every((byte) => byte === 0), true);
  }
});

test("invalid checkpoint has zero downstream activation or cursor synchronization mutations", async () => {
  for (const change of [{ runCount: 2 }, { canonicalCount: 1 }, { cursorHash: "0".repeat(64) }]) {
    let mutations = 0;
    await assert.rejects(() => executeGuardedPhygitalsReplay({
      readCheckpoint: async () => ({ ...snapshot(), ...change }),
      activate: async () => { mutations += 1; },
      synchronize: async () => { mutations += 1; },
    }), PhygitalsCardReplayError);
    assert.equal(mutations, 0);
  }
});

test("guarded replay resumes after central activation but preserves all old history", async () => {
  let state = snapshot();
  let activated = false;
  await assert.rejects(() => executeGuardedPhygitalsReplay({
    readCheckpoint: async () => state,
    activate: async () => { activated = true; },
    synchronize: async () => { throw new Error("simulated interruption"); },
  }));
  assert.equal(activated, true);
  assert.deepEqual(state, snapshot());
  const after = await executeGuardedPhygitalsReplay({
    readCheckpoint: async () => state,
    activate: async () => { assert.equal(activated, true); },
    synchronize: async () => { state = { ...state,
      cachedConfigId: pins.configId, cachedConfigNumber: "3", cursorHash: null, cursorPresent: false }; },
  });
  assert.equal(assertPhygitalsReplaySnapshot(after), "prepared");
  assert.deepEqual(after.run, snapshot().run);
  assert.equal(after.quarantineCount, 13_300);
});
