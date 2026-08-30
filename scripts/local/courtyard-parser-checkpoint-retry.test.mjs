import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const plan = await tsImport("./courtyard-parser-checkpoint-retry-plan.mts", import.meta.url);
const control = await tsImport("./courtyard-parser-checkpoint-retry-control.mts", import.meta.url);
const { parseCourtyardParserRetryArguments } = await tsImport("./retry-courtyard-parser-checkpoint.mts", import.meta.url);
const { providerMixedPageCanonicalBytes, providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
const { handoffDigest } = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const p = plan.courtyardParserRetry; const providerId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";
const cursor = { sourceInstanceId: providerId, sourceRevisionId: p.configId, sourceTypeKey: "dataforrest-events-v1",
  adapterVersion: "dataforrest-courtyard-distributed-adapter-v1", cursorCodecKey: "dataforrest-cursor-v1", cursorGeneration: 1,
  value: "private-synthetic-parser-checkpoint" };
const requested = { ...cursor, value: "private-previous-progress" };
const authority = { active: true, provider: { id: providerId }, nextConfigId: p.configId,
  next: { version_number: 2n, adapter_key: cursor.adapterVersion }, operatorId, authorityDigest: "a".repeat(64) };
function fixtureHash(t) {
  const original = crypto.createHash; const exact = providerMixedPageCanonicalBytes(cursor);
  t.mock.method(crypto, "createHash", (...args) => {
    const hash = original(...args); const chunks = []; const update = hash.update.bind(hash); const digest = hash.digest.bind(hash);
    hash.update = (value, ...rest) => { chunks.push(Buffer.from(value)); update(value, ...rest); return hash; };
    hash.digest = (...args) => args[0] === "hex" && Buffer.concat(chunks).equals(exact) ? p.cursorHash : digest(...args);
    return hash;
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function checkpoint() {
  const requestedCursorHash = providerMixedCursorFingerprint(requested);
  const pages = Array.from({ length: 18 }, (_, index) => ({ id: plan.parserRetryId(`page/${index}`), page_number: index + 1,
    requested_cursor_hash: index ? handoffDigest(`page${index - 1}`) : requestedCursorHash,
    next_cursor_hash: index === 17 ? p.cursorHash : handoffDigest(`page${index}`), continuation: "more", record_count: 100,
    accepted_count: index === 17 ? 85 : 83, quarantined_count: index === 17 ? 15 : 17, duplicate_count: 0,
    material_change_count: index === 17 ? 85 : 83, response_digest: "a".repeat(64), committed_at: new Date("2026-08-30T06:27:45Z") }));
  return { providerId, providerKey: "courtyard", databaseRole: "provider", schemaVersion: "distributed-provider-v1",
    runtimeState: "error", generation: "6", runtimeRowVersion: "14000", cachedConfigId: p.configId, cachedConfigNumber: "2",
    cursor, cursorHash: p.cursorHash, requestedCursor: requested, requestedCursorHash, activeRunCount: 0, runCount: 75,
    actionableCommandCount: 0, otherActiveTransactionCount: 0, otherOwnedWorkerLeaseCount: 0, oldProcessAlive: false,
    databaseNow: "2026-08-30T07:00:00.000Z", lease: { owner: null, fence: "76", expiresAt: null }, ledgerSequence: "1702272",
    runHistoryHash: "b".repeat(64), pages, quarantineCount: 475,
    run: { id: p.runId, state: "failed", configId: p.configId, configNumber: "2", fence: "76", pageCount: 18,
      accepted: 1496, duplicates: 0, quarantines: 304, materialChanges: 1496, reachedHead: false,
      finishedAt: p.finishedAt, failureCode: p.failureCode, finalCursor: cursor, finalCursorHash: p.cursorHash },
    lastPage: { id: pages[17].id, number: 18, cursor, cursorHash: p.cursorHash, continuation: "more" } };
}
test("one-time parser repair receipt pins exact checkpoint/history and explicitly stays nontransient without source claims", (t) => {
  fixtureHash(t); const snapshot = checkpoint(); const before = structuredClone(snapshot);
  const receipt = plan.parserRetryReceipt(authority, snapshot);
  assert.equal(receipt.genericFailureClassification, "nontransient"); assert.equal(receipt.sourceCheckPerformedByUtility, false);
  assert.equal(receipt.configId, p.configId); assert.equal(receipt.checkpointHash, p.cursorHash); assert.equal(receipt.runId, plan.parserRetryId("run"));
  assert.equal(JSON.stringify(receipt).includes(cursor.value), false); assert.deepEqual(snapshot, before);
  assert.notEqual(receipt.checkpointDigest, handoffDigest(plan.parserRetryRetained({ ...snapshot, runHistoryHash: "c".repeat(64) })));
  assert.notEqual(receipt.checkpointDigest, handoffDigest(plan.parserRetryRetained({ ...snapshot, ledgerSequence: "1702273" })));
});
test("parser repair rejects config/provider/failure/cursor/page-chain/history-count/operatorpause/active-work drift", (t) => {
  fixtureHash(t); const s = checkpoint();
  for (const change of [{ providerId: operatorId }, { providerKey: "phygitals" }, { runtimeState: "paused" }, { generation: "8" },
    { cachedConfigId: operatorId }, { cachedConfigNumber: "3" }, { cursorHash: "c".repeat(64) }, { cursor: requested },
    { requestedCursor: cursor, requestedCursorHash: p.cursorHash }, { runCount: 76 }, { quarantineCount: 476 },
    { activeRunCount: 1 }, { actionableCommandCount: 1 }, { otherActiveTransactionCount: 1 }, { otherOwnedWorkerLeaseCount: 1 },
    { pages: s.pages.slice(1) }, { pages: s.pages.map((page, i) => i === 2 ? { ...page, requested_cursor_hash: "c".repeat(64) } : page) },
    ...[{ state: "incomplete" }, { failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT" }, { fence: "77" }, { finishedAt: null },
      { pageCount: 19 }, { accepted: 1497 }, { quarantines: 305 }, { duplicates: 1 }, { reachedHead: true }].map((run) => ({ run: { ...s.run, ...run } }))]) {
    assert.throws(() => plan.assertParserRetryCheckpoint({ snapshot: { ...s, ...change }, providerId }));
  }
  for (const change of [{ active: false }, { nextConfigId: operatorId }, { next: { ...authority.next, version_number: 3n } }])
    assert.throws(() => plan.assertParserRetryAuthority({ ...authority, ...change }));
});
test("only cleared original lease or exact receipt-owned expired/live-fenced claim can pass retry guards", (t) => {
  fixtureHash(t); const s = checkpoint();
  const expired = { owner: p.owner, fence: "77", expiresAt: s.databaseNow };
  const live = { ...expired, expiresAt: "2026-08-30T07:01:00Z" };
  assert.throws(() => plan.assertParserRetryCheckpoint({ snapshot: { ...s, lease: expired }, providerId }));
  assert.doesNotThrow(() => plan.assertParserRetryCheckpoint({ snapshot: { ...s, lease: expired }, providerId, receiptExists: true }));
  assert.doesNotThrow(() => plan.assertParserRetryCheckpoint({ snapshot: { ...s, lease: live }, providerId, receiptExists: true,
    utilityLease: { owner: p.owner, fence: "77" } }));
  for (const lease of [live, { ...expired, owner: "foreign" }, { ...expired, fence: "76" }, { ...expired, expiresAt: null }])
    assert.throws(() => plan.assertParserRetryCheckpoint({ snapshot: { ...s, lease }, providerId, receiptExists: true }));
  assert.throws(() => plan.assertParserRetryCheckpoint({ snapshot: { ...s, lease: expired }, providerId, receiptExists: true,
    utilityLease: { owner: p.owner, fence: "77" } }));
  assert.doesNotThrow(() => plan.assertParserRetryCheckpoint({ snapshot: { ...s, runtimeState: "idle", generation: "7" }, providerId,
    receiptExists: true, resumed: true }));
});
function queueHarness({ failQueue = false } = {}) {
  const commands = new Map(); const runs = new Map(); const calls = [];
  const receipt = { providerId, operatorId, runId: plan.parserRetryId("run") };
  const database = { control_commands: { findUnique: async ({ where }) => commands.get(where.id) ?? null },
    provider_runs: { findUnique: async ({ where }) => runs.get(where.id) ?? null } };
  let fail = failQueue;
  const repository = { submitRuntimeCommand: async (input) => {
    calls.push("resume"); assert.equal(input.expectedGeneration, 6n);
    commands.set(input.commandId, { id: input.commandId, command_type: "resume", state: "completed", expected_generation: 6n,
      requested_by_operator_id: input.requestedByOperatorId, correlation_id: input.correlationId, reason: input.reason, idempotency_key: input.idempotencyKey });
    return { outcome: "accepted", state: "idle", generation: 7n };
  }, requestRunNow: async (input) => {
    calls.push("queue"); assert.equal(input.expectedGeneration, 7n); assert.equal(input.expectedConfigVersionId, p.configId);
    assert.equal(input.expectedConfigVersionNumber, 2n); assert.equal(input.expectedCursorFingerprint, p.cursorHash); assert.equal(input.requireNoActiveRun, true);
    if (fail) { fail = false; throw new Error("interrupted"); }
    const run = { id: input.runId, control_command_id: input.commandId, config_version_id: p.configId,
      config_version_number: 2n, requested_cursor_hash: p.cursorHash };
    runs.set(input.runId, run); commands.set(input.commandId, { id: input.commandId, command_type: "run", state: "accepted",
      resulting_run_id: input.runId, expected_generation: 7n, requested_by_operator_id: input.operatorId,
      correlation_id: input.correlationId, idempotency_key: input.idempotencyKey });
    return { kind: "created", run: { id: input.runId, requestedCursorHash: p.cursorHash } };
  } };
  return { commands, runs, calls, input: { database, receipt, commands: repository,
    assertPinned: async (resumed) => { calls.push(resumed ? "guard-idle" : "guard-error"); } } };
}
test("same-config parser retry queues once and recognizes its exact running/terminal run before checkpoint guards", async () => {
  const h = queueHarness(); assert.equal((await control.queueParserRetry(h.input)).phase, "queued");
  for (const state of ["queued", "running", "succeeded", "failed"]) {
    h.runs.get(plan.parserRetryId("run")).state = state; assert.equal((await control.queueParserRetry(h.input)).phase, "already_queued");
  }
  assert.deepEqual(h.calls, ["guard-error", "resume", "guard-idle", "queue"]);
});
test("resume-before-queue interruption reuses generation7 without extra resume and refuses operator drift", async () => {
  const h = queueHarness({ failQueue: true }); await assert.rejects(control.queueParserRetry(h.input), /interrupted/u);
  assert.equal((await control.queueParserRetry(h.input)).phase, "queued");
  assert.deepEqual(h.calls, ["guard-error", "resume", "guard-idle", "queue", "guard-idle", "guard-idle", "queue"]);
  const other = queueHarness(); await assert.rejects(control.queueParserRetry({ ...other.input, assertPinned: async () => { throw new Error("operator pause"); } }));
  assert.equal(other.calls.length, 0);
  h.runs.get(plan.parserRetryId("run")).requested_cursor_hash = "f".repeat(64);
  await assert.rejects(control.queueParserRetry(h.input), /PARSER_RETRY_QUEUED_RUN_CHANGED/u);
});
test("retry CLI allows only check-only or reviewed execute for reserved operation and refuses overrides", () => {
  assert.equal(parseCourtyardParserRetryArguments(["--check-only"]).execute, false);
  assert.equal(parseCourtyardParserRetryArguments(["--execute", "--review-digest", "a".repeat(64)]).execute, true);
  for (const args of [[], ["--execute"], ["--check-only", "--provider", "collector_crypt"],
    ["--check-only", "--operation-id", operatorId], ["--execute", "--token", "private-token"]])
    assert.throws(() => parseCourtyardParserRetryArguments(args), (error) => !error.message.includes("private-token"));
});
