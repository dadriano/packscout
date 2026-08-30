import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("../../packages/database/src/index.ts", import.meta.url);
const { dataforrestLaunchDistributedSourceAdapterManifest: manifest } =
  await tsImport("../../packages/contracts/src/index.ts", import.meta.url);
const previousConfigId = "11111111-1111-4111-8111-111111111111";
const nextConfigId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const secretCursor = "protected-opaque-value-do-not-log";

function checkpoint() {
  const cursor = { sourceInstanceId: plan.collectorHandoff.providerId,
    sourceRevisionId: previousConfigId, sourceTypeKey: manifest.sourceTypeKey,
    adapterVersion: manifest.adapterVersion, cursorCodecKey: manifest.cursorCodecKey,
    cursorGeneration: 1, value: secretCursor };
  const cursorHash = providerMixedCursorFingerprint(cursor);
  return { providerId: plan.collectorHandoff.providerId, providerKey: "collector_crypt",
    databaseRole: "provider", schemaVersion: "distributed-provider-v1", runtimeState: "paused",
    generation: "2", runtimeRowVersion: "100", cachedConfigId: previousConfigId,
    cachedConfigNumber: "2", cursor, cursorHash, activeRunCount: 0, actionableCommandCount: 0,
    otherActiveTransactionCount: 0, oldProcessAlive: false, databaseNow: "2026-08-30T05:00:01.000Z",
    lease: { owner: null, fence: "1", expiresAt: null }, ledgerSequence: "1900",
    run: { id: operationId, state: "incomplete", configId: previousConfigId, configNumber: "2",
      fence: "1", pageCount: 10, accepted: 1000, duplicates: 0, quarantines: 0, materialChanges: 1000,
      reachedHead: false, finishedAt: "2026-08-30T05:00:00.000Z", failureCode: "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE",
      finalCursor: cursor, finalCursorHash: cursorHash },
    lastPage: { id: nextConfigId, number: 10, cursor, cursorHash, continuation: "more" } };
}
const assertDrained = (snapshot, extras = {}) => plan.assertCollectorHandoffDrained({
  snapshot, previousConfigId, nextConfigId, expectedGeneration: "2", ...extras });

test("Collector interruption recovery admits only its exact expired utility lease with preserved checkpoint", () => {
  const owner = `local:collector:handoff:${operationId}`;
  const snapshot = checkpoint();
  snapshot.lease = { owner, fence: "2", expiresAt: "2026-08-30T05:00:00.000Z" };
  assert.throws(() => assertDrained(snapshot));
  assert.equal(assertDrained(snapshot, { reclaimableUtilityOwner: owner }), "previous");
  const migrated = plan.reEnvelopeCollectorCursor({ cursor: snapshot.cursor, cursorHash: snapshot.cursorHash, previousConfigId, nextConfigId });
  assert.equal(assertDrained({ ...snapshot, cachedConfigId: nextConfigId, cachedConfigNumber: "3",
    cursor: migrated.cursor, cursorHash: migrated.cursorHash }, { reclaimableUtilityOwner: owner }), "prepared");
  for (const lease of [{ ...snapshot.lease, owner: "local:other-operation" },
    { ...snapshot.lease, expiresAt: "2026-08-30T05:01:00.000Z" }]) {
    assert.throws(() => assertDrained({ ...snapshot, lease }, { reclaimableUtilityOwner: owner }));
  }
});

test("Collector paused handoff accepts both natural drain terminals and preserves opaque progress", () => {
  for (const state of ["incomplete", "failed"]) {
    const snapshot = checkpoint();
    snapshot.run.state = state;
    snapshot.run.failureCode = state === "incomplete" ? "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE" : "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING";
    assert.equal(assertDrained(snapshot), "previous");
    const migrated = plan.reEnvelopeCollectorCursor({ cursor: snapshot.cursor,
      cursorHash: snapshot.cursorHash, previousConfigId, nextConfigId });
    assert.deepEqual(migrated.cursor, { ...snapshot.cursor, sourceRevisionId: nextConfigId,
      adapterVersion: plan.collectorHandoff.nextAdapter });
    assert.equal(migrated.cursor.value, secretCursor);
    assert.notEqual(migrated.cursorHash, snapshot.cursorHash);
    assert.equal(assertDrained({ ...snapshot, cachedConfigId: nextConfigId, cachedConfigNumber: "3",
      cursor: migrated.cursor, cursorHash: migrated.cursorHash }), "prepared");
  }
});

test("Collector refuses wrong provider, stale generation, live work and changed immutable checkpoint", () => {
  for (const change of [
    { providerId: previousConfigId }, { providerKey: "courtyard" }, { databaseRole: "central" },
    { runtimeState: "idle" }, { generation: "3" }, { activeRunCount: 1 },
    { actionableCommandCount: 1 }, { otherActiveTransactionCount: 1 }, { oldProcessAlive: true },
    { cachedConfigId: operationId }, { cachedConfigNumber: "4" }, { cursorHash: "0".repeat(64) },
    { lease: { owner: "worker", fence: "1", expiresAt: "2026-08-30T06:00:00Z" } },
  ]) assert.throws(() => assertDrained({ ...checkpoint(), ...change }), plan.CollectorCheckpointHandoffError);
  for (const change of [{ state: "running" }, { reachedHead: true }, { pageCount: 11 },
    { finalCursorHash: "0".repeat(64) }, { configId: nextConfigId }, { finishedAt: null },
    { failureCode: "SOURCE_INVALID_RESPONSE" }, { failureCode: "PROVIDER_IMPORT_LEASE_EXPIRED" }]) {
    const snapshot = checkpoint();
    assert.throws(() => assertDrained({ ...snapshot, run: { ...snapshot.run, ...change } }),
      plan.CollectorCheckpointHandoffError);
  }
});

test("Collector only accepts its exact acquired utility lease, and safe evidence contains no cursor", () => {
  const snapshot = checkpoint();
  snapshot.lease = { owner: "local:collector-handoff", fence: "2", expiresAt: "2026-08-30T06:00:00Z" };
  assert.equal(assertDrained(snapshot, { utilityLease: { owner: snapshot.lease.owner, fence: "2" } }), "previous");
  assert.throws(() => assertDrained(snapshot, { utilityLease: { owner: snapshot.lease.owner, fence: "3" } }));
  assert.throws(() => assertDrained({ ...snapshot, lease: { ...snapshot.lease, expiresAt: snapshot.databaseNow } },
    { utilityLease: { owner: snapshot.lease.owner, fence: "2" } }));
  assert.equal(JSON.stringify(plan.checkpointEvidence(snapshot)).includes(secretCursor), false);
  assert.equal(plan.handoffId(operationId, "config"), plan.handoffId(operationId, "config"));
  assert.notEqual(plan.handoffId(operationId, "config"), plan.handoffId(operationId, "audit"));
});

test("Collector cursor re-envelope rejects every crossed scope and changed codec", () => {
  const s = checkpoint();
  for (const change of [{ sourceInstanceId: previousConfigId }, { sourceRevisionId: nextConfigId },
    { adapterVersion: plan.collectorHandoff.nextAdapter }, { cursorGeneration: 2 },
    { cursorCodecKey: "wrong" }, { sourceTypeKey: "wrong" }, { value: null }]) {
    const cursor = { ...s.cursor, ...change };
    assert.throws(() => plan.reEnvelopeCollectorCursor({ cursor,
      cursorHash: providerMixedCursorFingerprint(cursor), previousConfigId, nextConfigId }));
  }
});

test("Collector saga activates central last and safely resumes interrupted staging", async () => {
  for (const initiallyPrepared of [false, true]) {
    const calls = []; let prepared = initiallyPrepared;
    await plan.executeCollectorHandoffPreparation({
      readAndAssert: async () => { calls.push("guard"); return prepared ? "prepared" : "previous"; },
      stageInactiveCentral: async () => { calls.push("stage-inactive"); },
      prepareLocalAtomically: async () => { calls.push("local-atomic"); prepared = true; },
      activateCentralLast: async () => { assert.equal(prepared, true); calls.push("activate-last"); },
    });
    assert.deepEqual(calls, initiallyPrepared
      ? ["guard", "stage-inactive", "guard", "activate-last"]
      : ["guard", "stage-inactive", "local-atomic", "guard", "activate-last"]);
  }
});

test("Collector saga never activates or resumes after guard/staging/local failure", async () => {
  for (const failureAt of ["guard", "stage", "local"]) {
    const calls = [];
    const step = async (name) => { calls.push(name); if (name === failureAt) throw new Error("fixture"); };
    await assert.rejects(plan.executeCollectorHandoffPreparation({
      readAndAssert: async () => { await step("guard"); return "previous"; },
      stageInactiveCentral: () => step("stage"), prepareLocalAtomically: () => step("local"),
      activateCentralLast: () => step("activate"),
    }));
    assert.equal(calls.includes("activate"), false);
  }
});
