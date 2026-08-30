import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./courtyard-response-budget-handoff-plan.mts", import.meta.url);
const { handoffDigest } = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("../../packages/database/src/index.ts", import.meta.url);
const { dataforrestCourtyardDistributedSourceAdapterManifest: previousManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest: nextManifest } =
  await tsImport("../../packages/contracts/src/index.ts", import.meta.url);
const providerId = "eeba923b-3d0f-53bc-9006-d84fab651824";
const nextConfigId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const privateCursor = "synthetic-protected-opaque-value-never-in-proof";
const p = plan.courtyardHandoff;

function checkpoint() {
  const cursor = { sourceInstanceId: providerId, sourceRevisionId: p.previousConfigId,
    sourceTypeKey: previousManifest.sourceTypeKey, adapterVersion: previousManifest.adapterVersion,
    cursorCodecKey: previousManifest.cursorCodecKey, cursorGeneration: 1, value: privateCursor };
  const cursorHash = providerMixedCursorFingerprint(cursor);
  return { providerId, providerKey: "courtyard", databaseRole: "provider", schemaVersion: "distributed-provider-v1",
    runtimeState: "error", generation: "21", runtimeRowVersion: "100", cachedConfigId: p.previousConfigId,
    cachedConfigNumber: "2", cursor, cursorHash, activeRunCount: 0, runCount: 82, actionableCommandCount: 0,
    otherActiveTransactionCount: 0, otherOwnedWorkerLeaseCount: 0, oldProcessAlive: false,
    databaseNow: "2026-08-30T05:00:01.000Z", lease: { owner: null, fence: "82", expiresAt: null },
    ledgerSequence: "230045", runHistoryHash: "a".repeat(64), pageHistoryHash: "d".repeat(64), quarantineHistoryHash: "e".repeat(64), pageHistoryCount: 17310, quarantineCount: 684,
    run: { id: p.runId, state: "failed", configId: p.previousConfigId, configNumber: "2", fence: "82",
      pageCount: 2302, accepted: 230045, duplicates: 0, quarantines: 155, materialChanges: 230045,
      reachedHead: false, finishedAt: p.finishedAt, failureCode: p.failureCode,
      finalCursor: cursor, finalCursorHash: cursorHash },
    lastPage: { id: operationId, number: 2302, cursor, cursorHash, continuation: "more" } };
}
const expectedHash = checkpoint().cursorHash;
const assertCheckpoint = (snapshot, extra = {}) => plan.assertCourtyardCheckpoint({
  snapshot, providerId, nextConfigId, phase: "terminal", expectedHash, ...extra });
const paused = () => ({ ...checkpoint(), runtimeState: "paused", generation: "22" });
const migrate = (s, extra = {}) => plan.reEnvelopeCourtyardCursor({
  cursor: s.run.finalCursor, cursorHash: s.run.finalCursorHash, providerId, nextConfigId, expectedHash, ...extra });

test("Courtyard profile keeps exact identity, scopes, mapper and 100-record/new32-MiB request bounds", () => {
  const mapper = plan.assertCourtyardProfileContinuity();
  assert.equal(mapper.mapperKey, "courtyard-provider-observation");
  assert.equal(mapper.mapperVersion, "1");
  assert.deepEqual(nextManifest.supportedProviders,
    previousManifest.supportedProviders.filter((entry) => entry.provider === "courtyard"));
  assert.deepEqual({ ...nextManifest.requestBounds, maximumResponseBytes: previousManifest.requestBounds.maximumResponseBytes }, previousManifest.requestBounds);
  assert.equal(nextManifest.requestBounds.pageLimit, 100);
  assert.equal(nextManifest.requestBounds.maximumResponseBytes, 33_554_432);
  assert.equal(plan.courtyardHandoffId(operationId, "receipt"), plan.courtyardHandoffId(operationId, "receipt"));
  assert.notEqual(plan.courtyardHandoffId(operationId, "receipt"), plan.courtyardHandoffId(operationId, "pause"));
});

test("Courtyard cursor handoff changes only revision and adapter, retaining exact opaque progress", () => {
  const s = checkpoint(); const before = structuredClone(s); const migrated = migrate(s);
  assert.deepEqual(migrated.cursor, { ...s.cursor, sourceRevisionId: nextConfigId, adapterVersion: nextManifest.adapterVersion });
  assert.equal(migrated.cursor.value, privateCursor);
  assert.notEqual(migrated.cursorHash, s.cursorHash);
  assert.equal(migrated.cursorHash, providerMixedCursorFingerprint(migrated.cursor));
  assert.equal(migrated.opaqueValueHash, handoffDigest(privateCursor));
  assert.deepEqual(s, before);
  // Only synthetic tests override the live protected fingerprint; production defaults stay hard-pinned.
  assert.throws(() => migrate(s, { expectedHash: undefined }), plan.CourtyardHandoffError);
  assert.throws(() => migrate(s, { nextConfigId: p.previousConfigId }), plan.CourtyardHandoffError);
  assert.throws(() => migrate(s, { cursorHash: "0".repeat(64) }), plan.CourtyardHandoffError);
  for (const change of [{ sourceInstanceId: nextConfigId }, { sourceRevisionId: nextConfigId },
    { sourceTypeKey: "wrong-source" }, { adapterVersion: nextManifest.adapterVersion },
    { cursorCodecKey: "wrong-codec" }, { cursorGeneration: 2 }, { value: null }, { value: "different-opaque" }]) {
    const cursor = { ...s.cursor, ...change };
    assert.throws(() => migrate(s, { cursor, cursorHash: providerMixedCursorFingerprint(cursor) }), plan.CourtyardHandoffError);
  }
});

test("Courtyard admits only the exact terminal, paused and locally prepared checkpoint phases", () => {
  const terminal = checkpoint(); const stopped = paused(); const migrated = migrate(stopped);
  const prepared = { ...stopped, cachedConfigId: nextConfigId, cachedConfigNumber: "3",
    cursor: migrated.cursor, cursorHash: migrated.cursorHash };
  assert.equal(assertCheckpoint(terminal), "previous");
  assert.equal(assertCheckpoint(stopped, { phase: "paused" }), "previous");
  assert.equal(assertCheckpoint(prepared, { phase: "paused" }), "prepared");
  assert.throws(() => assertCheckpoint(prepared), plan.CourtyardHandoffError);
  assert.throws(() => assertCheckpoint(stopped), plan.CourtyardHandoffError);
  assert.throws(() => assertCheckpoint(terminal, { phase: "paused" }), plan.CourtyardHandoffError);
  assert.deepEqual(plan.retainedCourtyardCheckpoint(terminal), plan.retainedCourtyardCheckpoint(stopped));
  assert.deepEqual(plan.retainedCourtyardCheckpoint(terminal), plan.retainedCourtyardCheckpoint(prepared));
});

test("Courtyard rejects crossed provider, runtime, config, history count and active-work guards", () => {
  for (const change of [{ providerId: nextConfigId }, { providerKey: "collector_crypt" }, { databaseRole: "central" },
    { schemaVersion: "legacy" }, { runtimeState: "running" }, { runtimeState: "paused" }, { generation: "22" },
    { cachedConfigId: nextConfigId }, { cachedConfigNumber: "3" }, { runCount: 0 }, { runCount: 50_001 },
    { activeRunCount: 1 }, { actionableCommandCount: 1 }, { otherActiveTransactionCount: 1 },
    { otherOwnedWorkerLeaseCount: 1 }, { cursorHash: "0".repeat(64) }, { cursor: null },
    { lease: { owner: null, fence: "83", expiresAt: null } }]) {
    assert.throws(() => assertCheckpoint({ ...checkpoint(), ...change }), plan.CourtyardHandoffError);
  }
  const s = paused(); const migrated = migrate(s);
  for (const change of [{ cachedConfigNumber: "2" }, { cachedConfigNumber: "4" },
    { cursor: s.cursor }, { cursorHash: s.cursorHash }]) {
    assert.throws(() => assertCheckpoint({ ...s, cachedConfigId: nextConfigId, cachedConfigNumber: "3",
      cursor: migrated.cursor, cursorHash: migrated.cursorHash, ...change }, { phase: "paused" }), plan.CourtyardHandoffError);
  }
});

test("Courtyard rejects changed terminal provenance, counters, source head and durable last page", () => {
  for (const change of [{ id: operationId }, { configId: nextConfigId }, { configNumber: "3" },
    { state: "running" }, { state: "incomplete" }, { failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT" },
    { finishedAt: null }, { finishedAt: "2026-08-30T03:41:17.245Z" }, { fence: "83" }, { pageCount: 2303 },
    { accepted: 230046 }, { duplicates: 1 }, { quarantines: 154 }, { reachedHead: true },
    { finalCursorHash: "0".repeat(64) }, { finalCursor: null }]) {
    const s = checkpoint();
    assert.throws(() => assertCheckpoint({ ...s, run: { ...s.run, ...change } }), plan.CourtyardHandoffError);
  }
  const s = checkpoint();
  for (const lastPage of [null, { ...s.lastPage, number: 2301 }, { ...s.lastPage, continuation: "head" },
    { ...s.lastPage, cursorHash: "0".repeat(64) }, { ...s.lastPage, cursor: { ...s.cursor, value: "changed" } }]) {
    assert.throws(() => assertCheckpoint({ ...s, lastPage }), plan.CourtyardHandoffError);
  }
});

test("Courtyard utility lease admits only the exact live owner/fence or explicitly reclaimed expired owner", () => {
  const s = paused(); const owner = `local:courtyard:response-budget:${operationId}`;
  const utilityLease = { owner, fence: "83" };
  const live = { ...utilityLease, expiresAt: "2026-08-30T05:01:00.000Z" };
  assert.equal(assertCheckpoint({ ...s, lease: live }, { phase: "paused", utilityLease }), "previous");
  for (const lease of [{ ...live, owner: "other-operation" }, { ...live, fence: "84" },
    { ...live, expiresAt: s.databaseNow }, { ...live, expiresAt: null }, { ...live, expiresAt: "invalid" }]) {
    assert.throws(() => assertCheckpoint({ ...s, lease }, { phase: "paused", utilityLease }), plan.CourtyardHandoffError);
  }
  const expired = { ...live, expiresAt: s.databaseNow };
  assert.throws(() => assertCheckpoint({ ...s, lease: expired }, { phase: "paused" }), plan.CourtyardHandoffError);
  assert.equal(assertCheckpoint({ ...s, lease: expired }, { phase: "paused", reclaimableOwner: owner }), "previous");
  for (const lease of [live, { ...expired, owner: "foreign-owner" }, { ...expired, expiresAt: null },
    { owner: null, fence: "83", expiresAt: s.databaseNow }]) {
    assert.throws(() => assertCheckpoint({ ...s, lease }, { phase: "paused", reclaimableOwner: owner }), plan.CourtyardHandoffError);
  }
});

test("Courtyard retained receipt detects all prior-history, quarantine and canonical-ledger drift without raw cursors", () => {
  const s = checkpoint(); const retained = plan.retainedCourtyardCheckpoint(s); const digest = handoffDigest(retained);
  assert.equal(JSON.stringify(retained).includes(privateCursor), false);
  assert.equal(retained.runHistoryHash, s.runHistoryHash);
  assert.equal(retained.runCount, 82);
  assert.equal(retained.quarantineCount, 684);
  for (const change of [{ runHistoryHash: "b".repeat(64) }, { pageHistoryHash: "b".repeat(64) },
    { quarantineHistoryHash: "b".repeat(64) }, { pageHistoryCount: 17311 }, { runCount: 50_001 }, { quarantineCount: 685 },
    { ledgerSequence: "230046" }, { lastPage: { ...s.lastPage, id: nextConfigId } },
    { run: { ...s.run, materialChanges: 230044 } }, { run: { ...s.run, pageCount: 2303 } },
    { run: { ...s.run, failureCode: "changed" } }, { run: { ...s.run, finishedAt: null } }]) {
    assert.notEqual(handoffDigest(plan.retainedCourtyardCheckpoint({ ...s, ...change })), digest);
  }
});

test("Courtyard canary proof is exact, count-only, bounded and never a raw-response or completion capability", () => {
  const proof = { checkKind: "courtyard_response_budget_parser_mapper_inspection", adapterKey: p.nextAdapter,
    providerId, nextConfigId, savedCursorHash: p.cursorHash, opaqueValueHash: handoffDigest(privateCursor),
    status: 200, recordCount: 100, adapterInvalid: 0, mapperQuarantined: 0, collectibleValidated: 100,
    canonicalQuarantined: 0, requestedRecords: 100, maximumResponseBytes: 33554432, maximumJsonNodes: 640000,
    responseBytes: 33_554_432, durationMilliseconds: 0, checkedAt: "2026-08-30T05:00:00.000Z" };
  assert.equal(plan.courtyardCanarySchema.safeParse(proof).success, true);
  assert.equal(JSON.stringify(proof).includes(privateCursor), false);
  for (const change of [{ adapterKey: p.previousAdapter }, { status: 201 }, { recordCount: 101 },
    { adapterInvalid: 1 }, { mapperQuarantined: 1 }, { collectibleValidated: 0 }, { collectibleValidated: 101 },
    { collectibleValidated: 99 }, { canonicalQuarantined: 1 }, { requestedRecords: 101 },
    { maximumResponseBytes: 8388608 }, { maximumJsonNodes: 480000 },
    { responseBytes: 33_554_433 }, { responseBytes: 0 }, { durationMilliseconds: -1 },
    { durationMilliseconds: Number.POSITIVE_INFINITY }, { savedCursorHash: expectedHash },
    { protectedRawResponse: privateCursor }, { nextCursor: privateCursor }]) {
    assert.equal(plan.courtyardCanarySchema.safeParse({ ...proof, ...change }).success, false);
  }
});
