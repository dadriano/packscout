import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { resumeCourtyardHandoff, readCourtyardReceipt, assertCourtyardPauseProvenance, courtyardQueueLeaseOwner } = await tsImport("./courtyard-response-budget-handoff-control.mts", import.meta.url);
const { courtyardHandoff: pins, courtyardHandoffId: id, retainedCourtyardCheckpoint } = await tsImport("./courtyard-response-budget-handoff-plan.mts", import.meta.url);
const { handoffDigest } = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
const operationId = "26c70381-925a-5228-87be-4e6b862fa508";
const receipt = { kind: "courtyard_terminal_response_budget", operationId, providerId: "eeba923b-3d0f-53bc-9006-d84fab651824",
  operatorId: "072d6d2f-1b3b-4363-8a91-422985cad740", nextConfigId: id(operationId, "config"), authorityDigest: "a".repeat(64),
  checkpointDigest: "b".repeat(64), entryRowVersion: "32000", failureCode: pins.failureCode, finishedAt: pins.finishedAt, previousCursorHash: pins.cursorHash };
const cursor = { sourceInstanceId: pins.providerId, sourceRevisionId: receipt.nextConfigId,
  sourceTypeKey: "dataforrest-events-v1", adapterVersion: pins.nextAdapter,
  cursorCodecKey: "dataforrest-cursor-v1", cursorGeneration: 1, value: "private-test-opaque-checkpoint" };
const cursorHash = providerMixedCursorFingerprint(cursor);
function harness({ failQueue = false, queueGap = null } = {}) {
  const rows = new Map(); const runs = new Map(); const calls = [];
  const lease = { lease_owner: null, lease_fence: 83n, live: false };
  const database = { control_commands: { findUnique: async ({ where }) => rows.get(where.id) ?? null },
    provider_runs: { findUnique: async ({ where }) => runs.get(where.id) ?? null },
    provider_worker_states: { findUnique: async () => lease } };
  const leases = { acquire: async (input) => {
    calls.push("acquire"); assert.equal(input.owner, courtyardQueueLeaseOwner(operationId)); assert.equal(input.leaseMilliseconds, 120000);
    lease.lease_owner = input.owner; lease.lease_fence += 1n; lease.live = true;
    return { kind: "acquired", lease: { owner: input.owner, fence: lease.lease_fence, role: "import" } };
  }, release: async (input) => {
    calls.push("release");
    if (lease.lease_owner !== input.owner || lease.lease_fence !== input.fence) return false;
    lease.lease_owner = null; lease.live = false; return true;
  } };
  let fail = failQueue;
  const commands = { submitRuntimeCommand: async (input) => {
    calls.push("resume"); assert.equal(input.expectedGeneration, 22n);
    rows.set(input.commandId, { state: "completed", command_type: input.commandType, expected_generation: input.expectedGeneration,
      requested_by_operator_id: input.requestedByOperatorId, correlation_id: input.correlationId, idempotency_key: input.idempotencyKey });
    return { outcome: "accepted", state: "idle", generation: 23n };
  }, requestRunNow: async (input) => {
    calls.push("queue"); assert.equal(input.expectedCursorFingerprint, cursorHash); assert.equal(input.requireNoActiveRun, true);
    assert.deepEqual(input.expectedImportLease, { owner: courtyardQueueLeaseOwner(operationId), fence: lease.lease_fence });
    assert.equal(input.expectedGeneration, 23n); assert.equal(input.expectedConfigVersionNumber, 3n); assert.equal(input.expectedConfigVersionId, receipt.nextConfigId);
    if (fail) { fail = false; throw new Error("interrupted"); }
    // Deterministic post-preflight gap: production requestRunNow checks these pins in its own SQL-clock transaction.
    if (queueGap === "expired") lease.live = false;
    if (queueGap === "foreign") lease.lease_owner = "foreign-importer";
    if (!lease.live || lease.lease_owner !== input.expectedImportLease.owner || lease.lease_fence !== input.expectedImportLease.fence) return { kind: "runtime_unavailable" };
    rows.set(input.commandId, { state: "accepted", command_type: "run", resulting_run_id: input.runId, expected_generation: input.expectedGeneration,
      requested_by_operator_id: input.operatorId, correlation_id: input.correlationId, idempotency_key: input.idempotencyKey });
    runs.set(input.runId, { id: input.runId, control_command_id: input.commandId, config_version_id: receipt.nextConfigId,
      idempotency_key: `command/${input.commandId}`, trigger: "manual", recovery_of_run_id: null,
      requested_by_operator_id: receipt.operatorId, requested_cursor: cursor,
      config_version_number: 3n, requested_cursor_hash: cursorHash }); return { kind: "created", run: { id: input.runId } };
  } };
  return { rows, runs, calls, lease, input: { database, receipt, cursorHash, commands, leases,
    assertPrepared: async (resumed, expected) => {
      calls.push((resumed ? "guard-idle" : "guard-paused") + (expected ? "-owned" : ""));
      if (expected) assert.deepEqual(expected, { owner: lease.lease_owner, fence: lease.lease_fence });
    } } };
}
test("Courtyard resume and exact atomic queue are once-only after output loss and worker start", async () => {
  const h = harness(); assert.equal((await resumeCourtyardHandoff(h.input)).phase, "queued");
  for (const state of ["queued", "running", "succeeded", "failed"]) {
    h.runs.get(id(operationId, "run")).state = state;
    assert.equal((await resumeCourtyardHandoff(h.input)).phase, "already_queued");
  }
  assert.deepEqual(h.calls, ["guard-paused", "acquire", "guard-paused-owned", "resume", "guard-idle-owned", "queue", "release"]); assert.equal(h.runs.size, 1);
});
test("Courtyard interruption after resume retries only original queue without extra resume", async () => {
  const h = harness({ failQueue: true }); await assert.rejects(resumeCourtyardHandoff(h.input), /interrupted/u);
  assert.equal((await resumeCourtyardHandoff(h.input)).phase, "queued");
  assert.deepEqual(h.calls, ["guard-paused", "acquire", "guard-paused-owned", "resume", "guard-idle-owned", "queue", "release",
    "guard-idle", "acquire", "guard-idle-owned", "guard-idle-owned", "queue", "release"]);
});
test("Courtyard operator generation drift or queue/config/cursor mismatch cannot write downstream", async () => {
  const h = harness(); await assert.rejects(resumeCourtyardHandoff({ ...h.input, assertPrepared: async () => { throw new Error("operator pause"); } }));
  assert.equal(h.calls.length, 0); await resumeCourtyardHandoff(h.input);
  const run = h.runs.get(id(operationId, "run")); const command = h.rows.get(id(operationId, "run-command"));
  for (const [row, key, value] of [[run, "requested_cursor_hash", "d".repeat(64)], [run, "config_version_number", 1n],
    [run, "config_version_id", operationId], [run, "requested_cursor", { ...cursor, value: "tampered-only-opaque" }],
    [run, "requested_cursor", null], [run, "requested_cursor", { unrecognized: "private-marker" }],
    [run, "requested_by_operator_id", operationId], [run, "trigger", "recovery"], [run, "recovery_of_run_id", pins.runId],
    [run, "idempotency_key", "foreign"], [command, "state", "rejected"],
    [command, "expected_generation", 5n], [command, "requested_by_operator_id", operationId]]) {
    const old = row[key]; row[key] = value; await assert.rejects(resumeCourtyardHandoff(h.input), /COURTYARD_QUEUED_RUN_CHANGED/u); row[key] = old;
  }
  assert.deepEqual(h.calls, ["guard-paused", "acquire", "guard-paused-owned", "resume", "guard-idle-owned", "queue", "release"]);
});

test("Courtyard queue passes an atomic live lease pin and expiry/foreign gaps cannot create a child", async () => {
  for (const queueGap of ["expired", "foreign"]) {
    const h = harness({ queueGap });
    await assert.rejects(resumeCourtyardHandoff(h.input), /COURTYARD_QUEUE_REFUSED_RESUME_RETAINED/u);
    assert.equal(h.runs.size, 0); assert.equal(h.rows.has(id(operationId, "run-command")), false);
    assert.equal(h.rows.get(id(operationId, "resume-command")).state, "completed");
    assert.equal(h.lease.lease_owner, queueGap === "foreign" ? "foreign-importer" : null);
    assert.equal(h.calls.at(-1), "release");
  }
});

test("Courtyard verified already-queued replay clears only its own fenced queue lease after output loss", async () => {
  const h = harness(); await resumeCourtyardHandoff(h.input); h.calls.length = 0;
  h.lease.lease_owner = courtyardQueueLeaseOwner(operationId); h.lease.lease_fence = 90n; h.lease.live = true;
  assert.equal((await resumeCourtyardHandoff(h.input)).phase, "already_queued");
  assert.deepEqual(h.calls, ["release"]); assert.equal(h.lease.lease_owner, null);
  h.calls.length = 0; h.lease.lease_owner = "foreign-importer";
  assert.equal((await resumeCourtyardHandoff(h.input)).phase, "already_queued");
  assert.deepEqual(h.calls, []); assert.equal(h.lease.lease_owner, "foreign-importer");
});
test("Courtyard pause receipt is unique and explicitly proves failure BEFORE pause plus retained-history digest", async () => {
  const snapshot = { generation: "22", runHistoryHash: "a".repeat(64), runCount: 82, quarantineCount: 684, ledgerSequence: "230045",
    run: { id: pins.runId, fence: "82", pageCount: 2302, accepted: 230045, duplicates: 0, quarantines: 155,
      materialChanges: 230045, state: "failed", failureCode: pins.failureCode, finishedAt: pins.finishedAt, finalCursorHash: pins.cursorHash },
    lastPage: { id: operationId } };
  const currentReceipt = { ...receipt, checkpointDigest: handoffDigest(retainedCourtyardCheckpoint(snapshot)) };
  const audit = { target_id: pins.runId, outcome: "success", details: currentReceipt };
  const command = { command_type: "pause", state: "completed", expected_generation: 21n, reason: pins.reason,
    requested_by_operator_id: receipt.operatorId, correlation_id: operationId, idempotency_key: `courtyard-response-budget-handoff/${operationId}/pause`, completed_at: new Date("2026-08-30T20:00:00Z") };
  const database = { local_audit_events: { findMany: async () => [audit] }, control_commands: { findUnique: async () => command } };
  assert.deepEqual(await readCourtyardReceipt(database, operationId), currentReceipt);
  await assertCourtyardPauseProvenance(database, currentReceipt, snapshot);
  // A prepared receipt is not permission to adopt a later altered/operator pause.
  for (const change of [{ reason: "unrelated operator pause" }, { expected_generation: 22n },
    { requested_by_operator_id: operationId }, { correlation_id: receipt.operatorId },
    { idempotency_key: "foreign-pause" }, { state: "rejected" }]) {
    const original = { ...command }; Object.assign(command, change);
    await assert.rejects(assertCourtyardPauseProvenance(database, currentReceipt, snapshot), /COURTYARD_PAUSE_PROVENANCE_INVALID/u);
    Object.assign(command, original);
  }
  for (const change of [{ generation: "23" }, { runHistoryHash: "c".repeat(64) }, { quarantineCount: 685 }, { ledgerSequence: "230046" }])
    await assert.rejects(assertCourtyardPauseProvenance(database, currentReceipt, { ...snapshot, ...change }));
  command.completed_at = new Date("2026-08-30T03:40:00Z"); await assert.rejects(assertCourtyardPauseProvenance(database, currentReceipt, snapshot));
  database.local_audit_events.findMany = async () => [audit, audit]; await assert.rejects(readCourtyardReceipt(database, operationId));
  assert.equal(JSON.stringify(currentReceipt).includes("value"), false);
});
