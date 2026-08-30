import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./courtyard-checkpoint-handoff-plan.mts", import.meta.url);
const { handoffDigest } = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("../../packages/database/src/index.ts", import.meta.url);
const { dataforrestLaunchDistributedSourceAdapterManifest: previousManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest: nextManifest } =
  await tsImport("../../packages/contracts/src/index.ts", import.meta.url);
const providerId = "11111111-1111-4111-8111-111111111111";
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
    runtimeState: "error", generation: "2", runtimeRowVersion: "100", cachedConfigId: p.previousConfigId,
    cachedConfigNumber: "1", cursor, cursorHash, activeRunCount: 0, runCount: 74, actionableCommandCount: 0,
    otherActiveTransactionCount: 0, otherOwnedWorkerLeaseCount: 0, oldProcessAlive: false,
    databaseNow: "2026-08-30T05:00:01.000Z", lease: { owner: null, fence: "74", expiresAt: null },
    ledgerSequence: "807129", runHistoryHash: "a".repeat(64), quarantineCount: 171,
    run: { id: p.runId, state: "failed", configId: p.previousConfigId, configNumber: "1", fence: "74",
      pageCount: 8073, accepted: 807129, duplicates: 0, quarantines: 171, materialChanges: 807129,
      reachedHead: false, finishedAt: p.finishedAt, failureCode: p.failureCode,
      finalCursor: cursor, finalCursorHash: cursorHash },
    lastPage: { id: operationId, number: 8073, cursor, cursorHash, continuation: "more" } };
}
const expectedHash = checkpoint().cursorHash;
const assertCheckpoint = (snapshot, extra = {}) => plan.assertCourtyardCheckpoint({
  snapshot, providerId, nextConfigId, phase: "terminal", expectedHash, ...extra });
const paused = () => ({ ...checkpoint(), runtimeState: "paused", generation: "3" });
const migrate = (s, extra = {}) => plan.reEnvelopeCourtyardCursor({
  cursor: s.run.finalCursor, cursorHash: s.run.finalCursorHash, providerId, nextConfigId, expectedHash, ...extra });

test("Courtyard profile keeps exact identity, scopes, mapper and 100-record/8-MiB request bounds", () => {
  const mapper = plan.assertCourtyardProfileContinuity();
  assert.equal(mapper.mapperKey, "courtyard-provider-observation");
  assert.equal(mapper.mapperVersion, "1");
  assert.deepEqual(nextManifest.supportedProviders,
    previousManifest.supportedProviders.filter((entry) => entry.provider === "courtyard"));
  assert.deepEqual(nextManifest.requestBounds, previousManifest.requestBounds);
  assert.equal(nextManifest.requestBounds.pageLimit, 100);
  assert.equal(nextManifest.requestBounds.maximumResponseBytes, 8_388_608);
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
  const prepared = { ...stopped, cachedConfigId: nextConfigId, cachedConfigNumber: "2",
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
    { schemaVersion: "legacy" }, { runtimeState: "running" }, { runtimeState: "paused" }, { generation: "3" },
    { cachedConfigId: nextConfigId }, { cachedConfigNumber: "2" }, { runCount: 73 }, { runCount: 75 },
    { activeRunCount: 1 }, { actionableCommandCount: 1 }, { otherActiveTransactionCount: 1 },
    { otherOwnedWorkerLeaseCount: 1 }, { cursorHash: "0".repeat(64) }, { cursor: null },
    { lease: { owner: null, fence: "75", expiresAt: null } }]) {
    assert.throws(() => assertCheckpoint({ ...checkpoint(), ...change }), plan.CourtyardHandoffError);
  }
  const s = paused(); const migrated = migrate(s);
  for (const change of [{ cachedConfigNumber: "1" }, { cachedConfigNumber: "3" },
    { cursor: s.cursor }, { cursorHash: s.cursorHash }]) {
    assert.throws(() => assertCheckpoint({ ...s, cachedConfigId: nextConfigId, cachedConfigNumber: "2",
      cursor: migrated.cursor, cursorHash: migrated.cursorHash, ...change }, { phase: "paused" }), plan.CourtyardHandoffError);
  }
});

test("Courtyard rejects changed terminal provenance, counters, source head and durable last page", () => {
  for (const change of [{ id: operationId }, { configId: nextConfigId }, { configNumber: "2" },
    { state: "running" }, { state: "incomplete" }, { failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT" },
    { finishedAt: null }, { finishedAt: "2026-08-30T03:41:17.245Z" }, { fence: "75" }, { pageCount: 8074 },
    { accepted: 807130 }, { duplicates: 1 }, { quarantines: 170 }, { reachedHead: true },
    { finalCursorHash: "0".repeat(64) }, { finalCursor: null }]) {
    const s = checkpoint();
    assert.throws(() => assertCheckpoint({ ...s, run: { ...s.run, ...change } }), plan.CourtyardHandoffError);
  }
  const s = checkpoint();
  for (const lastPage of [null, { ...s.lastPage, number: 8072 }, { ...s.lastPage, continuation: "head" },
    { ...s.lastPage, cursorHash: "0".repeat(64) }, { ...s.lastPage, cursor: { ...s.cursor, value: "changed" } }]) {
    assert.throws(() => assertCheckpoint({ ...s, lastPage }), plan.CourtyardHandoffError);
  }
});

test("Courtyard utility lease admits only the exact live owner/fence or explicitly reclaimed expired owner", () => {
  const s = paused(); const owner = `local:courtyard:handoff:${operationId}`;
  const utilityLease = { owner, fence: "75" };
  const live = { ...utilityLease, expiresAt: "2026-08-30T05:01:00.000Z" };
  assert.equal(assertCheckpoint({ ...s, lease: live }, { phase: "paused", utilityLease }), "previous");
  for (const lease of [{ ...live, owner: "other-operation" }, { ...live, fence: "76" },
    { ...live, expiresAt: s.databaseNow }, { ...live, expiresAt: null }, { ...live, expiresAt: "invalid" }]) {
    assert.throws(() => assertCheckpoint({ ...s, lease }, { phase: "paused", utilityLease }), plan.CourtyardHandoffError);
  }
  const expired = { ...live, expiresAt: s.databaseNow };
  assert.throws(() => assertCheckpoint({ ...s, lease: expired }, { phase: "paused" }), plan.CourtyardHandoffError);
  assert.equal(assertCheckpoint({ ...s, lease: expired }, { phase: "paused", reclaimableOwner: owner }), "previous");
  for (const lease of [live, { ...expired, owner: "foreign-owner" }, { ...expired, expiresAt: null },
    { owner: null, fence: "75", expiresAt: s.databaseNow }]) {
    assert.throws(() => assertCheckpoint({ ...s, lease }, { phase: "paused", reclaimableOwner: owner }), plan.CourtyardHandoffError);
  }
});

test("Courtyard retained receipt detects all prior-history, quarantine and canonical-ledger drift without raw cursors", () => {
  const s = checkpoint(); const retained = plan.retainedCourtyardCheckpoint(s); const digest = handoffDigest(retained);
  assert.equal(JSON.stringify(retained).includes(privateCursor), false);
  assert.equal(retained.runHistoryHash, s.runHistoryHash);
  assert.equal(retained.runCount, 74);
  assert.equal(retained.quarantineCount, 171);
  for (const change of [{ runHistoryHash: "b".repeat(64) }, { runCount: 75 }, { quarantineCount: 172 },
    { ledgerSequence: "807130" }, { lastPage: { ...s.lastPage, id: nextConfigId } },
    { run: { ...s.run, materialChanges: 807128 } }, { run: { ...s.run, pageCount: 8074 } },
    { run: { ...s.run, failureCode: "changed" } }, { run: { ...s.run, finishedAt: null } }]) {
    assert.notEqual(handoffDigest(plan.retainedCourtyardCheckpoint({ ...s, ...change })), digest);
  }
});

test("Courtyard canary proof is exact, count-only, bounded and never a raw-response or completion capability", () => {
  const proof = { checkKind: "courtyard_untrusted_parser_mapper_inspection", adapterKey: p.nextAdapter,
    providerId, nextConfigId, savedCursorHash: p.cursorHash, opaqueValueHash: handoffDigest(privateCursor),
    status: 200, recordCount: 100, adapterInvalid: 0, mapperQuarantined: 0, collectibleValidated: 80,
    canonicalMissingDisplayNameRejected: 20, canonicalQuarantineClass: "missing_display_name",
    responseBytes: 8_388_608, durationMilliseconds: 0, checkedAt: "2026-08-30T05:00:00.000Z" };
  assert.equal(plan.courtyardCanarySchema.safeParse(proof).success, true);
  assert.equal(JSON.stringify(proof).includes(privateCursor), false);
  for (const change of [{ adapterKey: p.previousAdapter }, { status: 201 }, { recordCount: 101 },
    { adapterInvalid: 1 }, { mapperQuarantined: 1 }, { collectibleValidated: 0 }, { collectibleValidated: 101 },
    { collectibleValidated: 79, canonicalMissingDisplayNameRejected: 21 }, { canonicalMissingDisplayNameRejected: 19 },
    { collectibleValidated: 81 }, { canonicalMissingDisplayNameRejected: 1.5 }, { canonicalMissingDisplayNameRejected: -1 },
    { canonicalQuarantineClass: "arbitrary_canonical_error" },
    { responseBytes: 8_388_609 }, { responseBytes: 0 }, { durationMilliseconds: -1 },
    { durationMilliseconds: Number.POSITIVE_INFINITY }, { savedCursorHash: expectedHash },
    { protectedRawResponse: privateCursor }, { nextCursor: privateCursor }]) {
    assert.equal(plan.courtyardCanarySchema.safeParse({ ...proof, ...change }).success, false);
  }
});
