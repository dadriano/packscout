import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const plan = await tsImport("./collector-reconciliation-retry-plan.mts", import.meta.url);
const control = await tsImport("./collector-reconciliation-retry-control.mts", import.meta.url);
const cli = await tsImport("./retry-collector-reconciliation-checkpoint.mts", import.meta.url);
const { providerMixedPageCanonicalBytes, providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
const { backfillDigest, transientBackfillCodes } = await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
const p = plan.collectorRepair, id = plan.collectorRepairId;
const operatorId = "22222222-2222-4222-8222-222222222222";
const cursor = { sourceInstanceId: p.providerId, sourceRevisionId: p.configId, sourceTypeKey: "dataforrest-events-v1",
  adapterVersion: "dataforrest-collector-crypt-distributed-adapter-v1", cursorCodecKey: "dataforrest-cursor-v1",
  cursorGeneration: 1, value: "private-synthetic-reconciliation-checkpoint" };
const requested = { ...cursor, value: "private-previous-checkpoint" };
const authority = { digest: "a".repeat(64), operatorId, configNumber: 3n,
  route: { configVersionId: p.configId, target: { providerId: p.providerId, providerKey: p.providerKey } } };
function fixtureHash(t) {
  const original = crypto.createHash, exact = providerMixedPageCanonicalBytes(cursor);
  t.mock.method(crypto, "createHash", (...args) => {
    const hash = original(...args), chunks = [], update = hash.update.bind(hash), digest = hash.digest.bind(hash);
    hash.update = (value, ...rest) => { chunks.push(Buffer.from(value)); update(value, ...rest); return hash; };
    hash.digest = (...args) => args[0] === "hex" && Buffer.concat(chunks).equals(exact) ? p.cursorHash : digest(...args);
    return hash;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function checkpoint() {
  const requestedCursorHash = providerMixedCursorFingerprint(requested);
  const pages = Array.from({ length: 387 }, (_, index) => ({ id: id(`page/${index}`), page_number: index + 1,
    requested_cursor_hash: index ? backfillDigest(`page${index - 1}`) : requestedCursorHash,
    next_cursor_hash: index === 386 ? p.cursorHash : backfillDigest(`page${index}`), continuation: "more",
    record_count: 1000, accepted_count: 1000, duplicate_count: 0, quarantined_count: 0, material_change_count: 1000,
    response_digest: "b".repeat(64), committed_at: new Date("2026-08-30T12:22:31.817Z") }));
  return { providerId: p.providerId, providerKey: p.providerKey, databaseRole: "provider", schemaVersion: "distributed-provider-v1",
    runtimeState: "error", generation: "24", runtimeRowVersion: "19000", cachedConfigId: p.configId, cachedConfigNumber: "3",
    cursor, cursorHash: p.cursorHash, requestedCursor: requested, requestedCursorHash,
    activeRunCount: 0, runCount: 11, actionableCommandCount: 0, otherActiveTransactionCount: 0,
    otherOwnedWorkerLeaseCount: 0, oldProcessAlive: false, databaseNow: "2026-08-30T19:00:00.000Z",
    lease: { owner: null, fence: "9", expiresAt: null }, ledgerSequence: "4649573", runHistoryHash: "c".repeat(64), pages, quarantineCount: 0,
    run: { id: p.parentRunId, state: "failed", configId: p.configId, configNumber: "3", fence: "9", pageCount: 387,
      accepted: 387000, duplicates: 0, quarantines: 0, materialChanges: 387000, reachedHead: false,
      finishedAt: p.finishedAt, failureCode: p.failureCode, finalCursor: cursor, finalCursorHash: p.cursorHash },
    lastPage: { id: pages[386].id, number: 387, cursor, cursorHash: p.cursorHash, continuation: "more" } };
}
test("review binds immutable terminal history and preserves unknown original cause and nontransient policy", (t) => {
  fixtureHash(t); const snapshot = checkpoint(), before = structuredClone(snapshot);
  const receipt = plan.makeCollectorRepairReceipt(authority, snapshot);
  assert.equal(receipt.runId, id("run")); assert.equal(receipt.originalExceptionKnown, false);
  assert.equal(receipt.automaticFailureClassification, "nontransient"); assert.equal(receipt.sourceCheckPerformedByUtility, false);
  assert.equal(transientBackfillCodes.has(p.failureCode), false);
  assert.equal(JSON.stringify(receipt).includes(cursor.value), false); assert.deepEqual(snapshot, before);
  for (const change of [{ runHistoryHash: "d".repeat(64) }, { ledgerSequence: "4649574" }, { runCount: 12 }])
    assert.notEqual(receipt.checkpointDigest, backfillDigest(plan.retainedCollectorRepair({ ...snapshot, ...change })));
});
test("only exact provider/config/full checkpoint/page chain/counters and operator state can be retried", (t) => {
  fixtureHash(t); const s = checkpoint();
  for (const change of [{ providerId: operatorId }, { providerKey: "courtyard" }, { runtimeState: "paused" },
    { runtimeState: "stopped" }, { generation: "25" }, { cachedConfigId: operatorId }, { cachedConfigNumber: "4" },
    { cursor: requested }, { cursorHash: "e".repeat(64) }, { requestedCursor: cursor, requestedCursorHash: p.cursorHash },
    { quarantineCount: 1 }, { activeRunCount: 1 }, { actionableCommandCount: 1 }, { otherActiveTransactionCount: 1 },
    { otherOwnedWorkerLeaseCount: 1 }, { oldProcessAlive: true }, { pages: s.pages.slice(1) },
    { pages: s.pages.map((page, i) => i === 5 ? { ...page, requested_cursor_hash: "e".repeat(64) } : page) },
    ...[{ state: "running" }, { failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT" }, { fence: "10" },
      { finishedAt: null }, { pageCount: 388 }, { accepted: 387001 }, { quarantines: 1 }, { duplicates: 1 },
      { reachedHead: true }, { finalCursor: requested }].map((run) => ({ run: { ...s.run, ...run } }))])
    assert.throws(() => plan.assertCollectorRepairCheckpoint({ snapshot: { ...s, ...change } }));
});
test("foreign/live leases refuse; only exact receipt-owned expired or live utility fences are admitted", (t) => {
  fixtureHash(t); const s = checkpoint();
  const expired = { owner: p.owner, fence: "10", expiresAt: s.databaseNow };
  const live = { ...expired, expiresAt: "2026-08-30T19:01:00Z" };
  assert.throws(() => plan.assertCollectorRepairCheckpoint({ snapshot: { ...s, lease: expired } }));
  assert.doesNotThrow(() => plan.assertCollectorRepairCheckpoint({ snapshot: { ...s, lease: expired }, receiptExists: true }));
  assert.doesNotThrow(() => plan.assertCollectorRepairCheckpoint({ snapshot: { ...s, lease: live }, receiptExists: true,
    utilityLease: { owner: p.owner, fence: "10" } }));
  for (const lease of [live, { ...expired, owner: "foreign" }, { ...expired, fence: "9" }, { ...expired, owner: null }])
    assert.throws(() => plan.assertCollectorRepairCheckpoint({ snapshot: { ...s, lease }, receiptExists: true }));
});
test("changed authority, membership, provider and profile cannot reuse a receipt", (t) => {
  fixtureHash(t); const receipt = plan.makeCollectorRepairReceipt(authority, checkpoint());
  control.assertCollectorRepairAuthority(receipt, authority);
  for (const change of [{ digest: "d".repeat(64) }, { operatorId: p.providerId }, { configNumber: 4n },
    { route: { ...authority.route, configVersionId: operatorId } },
    { route: { ...authority.route, target: { ...authority.route.target, providerKey: "phygitals" } } }])
    assert.throws(() => control.assertCollectorRepairAuthority(receipt, { ...authority, ...change }));
});
function queueFixture(receipt) {
  const saved = new Map(); let child = null, resumeCalls = 0, queueCalls = 0, failQueue = false;
  const database = { control_commands: { findUnique: async ({ where }) => saved.get(where.id) ?? null },
    provider_runs: { findUnique: async ({ where }) => where.id === p.parentRunId ? { final_cursor: cursor } : child } };
  const commands = {
    submitRuntimeCommand: async (input) => { resumeCalls++; saved.set(input.commandId, { command_type: "resume", state: "completed",
      expected_generation: input.expectedGeneration, requested_by_operator_id: input.requestedByOperatorId,
      correlation_id: input.correlationId, reason: null, idempotency_key: input.idempotencyKey });
    return { outcome: "accepted", state: "idle", generation: 25n }; },
    requestRunNow: async (input) => { queueCalls++; if (failQueue) throw new Error("synthetic_crash_after_resume");
      assert.equal(input.requireNoActiveRun, true); assert.equal(input.expectedCursorFingerprint, p.cursorHash);
      assert.equal(input.expectedGeneration, 25n); assert.equal(input.expectedConfigVersionNumber, 3n);
      assert.deepEqual(input.expectedImportLease, { owner: p.owner, fence: 10n });
      child = { id: input.runId, control_command_id: input.commandId, config_version_id: input.expectedConfigVersionId,
        config_version_number: 3n, requested_cursor_hash: p.cursorHash, requested_cursor: cursor, trigger: "manual",
        requested_by_operator_id: operatorId, recovery_of_run_id: null, idempotency_key: `command/${input.commandId}` };
      saved.set(input.commandId, { id: input.commandId, command_type: "run", resulting_run_id: input.runId,
        expected_generation: 25n, requested_by_operator_id: input.operatorId, correlation_id: input.correlationId,
        idempotency_key: input.idempotencyKey, state: "accepted" });
      return { kind: "created", run: { id: input.runId, requestedCursorHash: p.cursorHash } }; },
  };
  return { database, commands, saved, get child() { return child; }, get resumeCalls() { return resumeCalls; },
    get queueCalls() { return queueCalls; }, set failQueue(value) { failQueue = value; }, receipt,
    utilityLease: { owner: p.owner, fence: 10n } };
}
test("normal resume/queue is exact-once and resume-before-queue crash reuses the same child", async (t) => {
  fixtureHash(t); const receipt = plan.makeCollectorRepairReceipt(authority, checkpoint()), fixture = queueFixture(receipt);
  const phases = [], input = { ...fixture, assertPinned: async (resumed) => { phases.push(resumed); } };
  fixture.failQueue = true;
  await assert.rejects(control.queueCollectorRepair(input), /synthetic_crash/);
  fixture.failQueue = false;
  assert.equal((await control.queueCollectorRepair(input)).phase, "queued");
  assert.equal((await control.queueCollectorRepair(input)).phase, "already_queued");
  assert.equal(fixture.resumeCalls, 1); assert.equal(fixture.queueCalls, 2);
  assert.deepEqual(phases, [false, true, true, true]);
  fixture.child.requested_cursor = requested;
  await assert.rejects(control.findCollectorRepairQueuedRun(fixture.database, receipt), /QUEUED_RUN_CHANGED/);
});
test("guard drift between resume and queue never issues Run now", async (t) => {
  fixtureHash(t); const receipt = plan.makeCollectorRepairReceipt(authority, checkpoint()), fixture = queueFixture(receipt);
  await assert.rejects(control.queueCollectorRepair({ ...fixture, assertPinned: async (resumed) => {
    if (resumed) throw new Error("synthetic_operator_pause");
  } }), /operator_pause/);
  assert.equal(fixture.resumeCalls, 1); assert.equal(fixture.queueCalls, 0);
});
test("CLI refuses unreviewed execute and argument echoes", () => {
  assert.equal(cli.parseCollectorRepairArguments(["--check-only"]).execute, false);
  assert.equal(cli.parseCollectorRepairArguments(["--execute", "--review-digest", "a".repeat(64)]).execute, true);
  for (const args of [[], ["--execute"], ["--execute", "--review-digest", "secret-token"], ["--reset"], ["--check-only", "secret-token"]])
    assert.throws(() => cli.parseCollectorRepairArguments(args), (error) => !error.message.includes("secret-token"));
});
