import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { resumeCourtyardHandoff, readCourtyardReceipt, assertCourtyardPauseProvenance } = await tsImport("./courtyard-checkpoint-handoff-control.mts", import.meta.url);
const { courtyardHandoff: pins, courtyardHandoffId: id, retainedCourtyardCheckpoint } = await tsImport("./courtyard-checkpoint-handoff-plan.mts", import.meta.url);
const { handoffDigest } = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const operationId = "1dd59a1b-79c2-4b18-a881-edafe7b897dd";
const receipt = { kind: "courtyard_terminal_native_profile", operationId, providerId: "1ec7bb50-a263-4b17-82b5-c56fdfb93d1c",
  operatorId: "072d6d2f-1b3b-4363-8a91-422985cad740", nextConfigId: id(operationId, "config"), authorityDigest: "a".repeat(64),
  checkpointDigest: "b".repeat(64), entryRowVersion: "32000", failureCode: pins.failureCode, finishedAt: pins.finishedAt, previousCursorHash: pins.cursorHash };
const cursorHash = "c".repeat(64);
function harness({ failQueue = false } = {}) {
  const rows = new Map(); const runs = new Map(); const calls = [];
  const database = { control_commands: { findUnique: async ({ where }) => rows.get(where.id) ?? null }, provider_runs: { findUnique: async ({ where }) => runs.get(where.id) ?? null } };
  let fail = failQueue;
  const commands = { submitRuntimeCommand: async (input) => {
    calls.push("resume"); assert.equal(input.expectedGeneration, 3n);
    rows.set(input.commandId, { state: "completed", command_type: input.commandType, expected_generation: input.expectedGeneration,
      requested_by_operator_id: input.requestedByOperatorId, correlation_id: input.correlationId, idempotency_key: input.idempotencyKey });
    return { outcome: "accepted", state: "idle", generation: 4n };
  }, requestRunNow: async (input) => {
    calls.push("queue"); assert.equal(input.expectedCursorFingerprint, cursorHash); assert.equal(input.requireNoActiveRun, true);
    assert.equal(input.expectedGeneration, 4n); assert.equal(input.expectedConfigVersionNumber, 2n); assert.equal(input.expectedConfigVersionId, receipt.nextConfigId);
    if (fail) { fail = false; throw new Error("interrupted"); }
    rows.set(input.commandId, { command_type: "run", resulting_run_id: input.runId, expected_generation: input.expectedGeneration,
      requested_by_operator_id: input.operatorId, correlation_id: input.correlationId, idempotency_key: input.idempotencyKey });
    runs.set(input.runId, { id: input.runId, control_command_id: input.commandId, config_version_id: receipt.nextConfigId,
      config_version_number: 2n, requested_cursor_hash: cursorHash }); return { kind: "created", run: { id: input.runId } };
  } };
  return { rows, runs, calls, input: { database, receipt, cursorHash, commands, assertPrepared: async (resumed) => { calls.push(resumed ? "guard-idle" : "guard-paused"); } } };
}
test("Courtyard resume and exact atomic queue are once-only after output loss and worker start", async () => {
  const h = harness(); assert.equal((await resumeCourtyardHandoff(h.input)).phase, "queued");
  for (const state of ["queued", "running", "succeeded", "failed"]) {
    h.runs.get(id(operationId, "run")).state = state;
    assert.equal((await resumeCourtyardHandoff(h.input)).phase, "already_queued");
  }
  assert.deepEqual(h.calls, ["guard-paused", "resume", "queue"]); assert.equal(h.runs.size, 1);
});
test("Courtyard interruption after resume retries only original queue without extra resume", async () => {
  const h = harness({ failQueue: true }); await assert.rejects(resumeCourtyardHandoff(h.input), /interrupted/u);
  assert.equal((await resumeCourtyardHandoff(h.input)).phase, "queued");
  assert.deepEqual(h.calls, ["guard-paused", "resume", "queue", "guard-idle", "queue"]);
});
test("Courtyard operator generation drift or queue/config/cursor mismatch cannot write downstream", async () => {
  const h = harness(); await assert.rejects(resumeCourtyardHandoff({ ...h.input, assertPrepared: async () => { throw new Error("operator pause"); } }));
  assert.equal(h.calls.length, 0); await resumeCourtyardHandoff(h.input);
  const run = h.runs.get(id(operationId, "run")); const command = h.rows.get(id(operationId, "run-command"));
  for (const [row, key, value] of [[run, "requested_cursor_hash", "d".repeat(64)], [run, "config_version_number", 1n],
    [run, "config_version_id", operationId], [command, "expected_generation", 5n], [command, "requested_by_operator_id", operationId]]) {
    const old = row[key]; row[key] = value; await assert.rejects(resumeCourtyardHandoff(h.input), /COURTYARD_QUEUED_RUN_CHANGED/u); row[key] = old;
  }
  assert.deepEqual(h.calls, ["guard-paused", "resume", "queue"]);
});
test("Courtyard pause receipt is unique and explicitly proves failure BEFORE pause plus retained-history digest", async () => {
  const snapshot = { generation: "3", runHistoryHash: "a".repeat(64), runCount: 74, quarantineCount: 171, ledgerSequence: "807129",
    run: { id: pins.runId, fence: "74", pageCount: 8073, accepted: 807129, duplicates: 0, quarantines: 171,
      materialChanges: 807129, state: "failed", failureCode: pins.failureCode, finishedAt: pins.finishedAt, finalCursorHash: pins.cursorHash },
    lastPage: { id: operationId } };
  const currentReceipt = { ...receipt, checkpointDigest: handoffDigest(retainedCourtyardCheckpoint(snapshot)) };
  const audit = { target_id: pins.runId, outcome: "success", details: currentReceipt };
  const command = { command_type: "pause", state: "completed", expected_generation: 2n, reason: pins.reason,
    requested_by_operator_id: receipt.operatorId, correlation_id: operationId, idempotency_key: `courtyard-handoff/${operationId}/pause`, completed_at: new Date("2026-08-30T06:00:00Z") };
  const database = { local_audit_events: { findMany: async () => [audit] }, control_commands: { findUnique: async () => command } };
  assert.deepEqual(await readCourtyardReceipt(database, operationId), currentReceipt);
  await assertCourtyardPauseProvenance(database, currentReceipt, snapshot);
  for (const change of [{ generation: "4" }, { runHistoryHash: "c".repeat(64) }, { quarantineCount: 172 }, { ledgerSequence: "807130" }])
    await assert.rejects(assertCourtyardPauseProvenance(database, currentReceipt, { ...snapshot, ...change }));
  command.completed_at = new Date("2026-08-30T03:40:00Z"); await assert.rejects(assertCourtyardPauseProvenance(database, currentReceipt, snapshot));
  database.local_audit_events.findMany = async () => [audit, audit]; await assert.rejects(readCourtyardReceipt(database, operationId));
  assert.equal(JSON.stringify(currentReceipt).includes("value"), false);
});
