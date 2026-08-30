import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { pauseReceipt, readPauseReceipt, assertCollectorPauseProvenance, resumeCollectorHandoff } =
  await tsImport("./collector-crypt-checkpoint-handoff-receipts.mts", import.meta.url);
const { handoffId, collectorHandoff: pins } = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const operationId = "721049d1-eb7c-4f5d-b7e5-bf12eaa76189";
const previousConfigId = "4abb1a00-570d-4c44-a75a-f3543fe5aa91";
const operatorId = "41a10ccc-3678-4e1f-b18f-65e356a7fd6a";
const runId = "fe6ea7ea-dce6-42ba-bba6-e493921f96b9";
const receipt = { operationId, authorityDigest: "a".repeat(64), runId, runFence: "7", generation: "4",
  owner: "local:collector:original", oldWorkerPid: 12345, processIdentityAttestedByOperator: true,
  operatorId, previousConfigId, nextConfigId: handoffId(operationId, "config") };
const snapshot = { providerId: pins.providerId, providerKey: pins.providerKey, runtimeState: "running",
  generation: "4", cachedConfigId: previousConfigId, cachedConfigNumber: "2", activeRunCount: 1,
  oldProcessAlive: true, databaseNow: "2026-08-30T00:00:00Z", lease: { owner: receipt.owner, fence: "7", expiresAt: "2026-08-30T00:01:00Z" },
  run: { id: runId, state: "running", reachedHead: false, configId: previousConfigId, configNumber: "2", fence: "7" } };
const authority = { previous: { id: previousConfigId }, nextConfigId: receipt.nextConfigId,
  authorityDigest: receipt.authorityDigest, operatorId };

test("Collector pause intent freezes the actual run/owner/fence/generation and refuses stale authority", () => {
  const build = (changes = {}) => pauseReceipt({ authority, snapshot: { ...snapshot, ...changes },
    operationId, oldWorkerPid: 12345, expectedOwner: receipt.owner });
  assert.deepEqual(build(), receipt);
  for (const change of [{ providerKey: "phygitals" }, { providerId: operatorId }, { runtimeState: "idle" },
    { oldProcessAlive: false }, { activeRunCount: 2 }, { cachedConfigId: operatorId },
    { lease: { ...snapshot.lease, fence: "8" } }, { lease: { ...snapshot.lease, owner: "other" } },
    { lease: { ...snapshot.lease, expiresAt: "2026-08-29T23:59:00Z" } }]) assert.throws(() => build(change), /HANDOFF_PAUSE_TARGET_CHANGED/u);
});

test("Collector pause receipt and exact completed command prove approved terminal provenance", async () => {
  const row = { target_id: runId, outcome: "success", details: receipt };
  assert.deepEqual(await readPauseReceipt({ local_audit_events: { findMany: async () => [row] } }, operationId), receipt);
  await assert.rejects(readPauseReceipt({ local_audit_events: { findMany: async () => [row, row] } }, operationId));
  const command = { command_type: "pause", state: "completed", expected_generation: 4n, reason: pins.reason,
    requested_by_operator_id: operatorId, correlation_id: operationId, idempotency_key: `collector-handoff/${operationId}/pause`,
    completed_at: new Date("2026-08-30T00:00:00Z") };
  const terminal = { ...snapshot, generation: "5", run: { ...snapshot.run, finishedAt: "2026-08-30T00:00:01Z" } };
  const db = { control_commands: { findUnique: async () => command } };
  await assertCollectorPauseProvenance(db, receipt, terminal);
  for (const change of [{ generation: "6" }, { run: { ...terminal.run, id: operatorId } },
    { run: { ...terminal.run, fence: "8" } }, { run: { ...terminal.run, finishedAt: "2026-08-29T23:59:00Z" } }]) {
    await assert.rejects(assertCollectorPauseProvenance(db, receipt, { ...terminal, ...change }), /HANDOFF_PAUSE_PROVENANCE_INVALID/u);
  }
});

function harness(_t, { failQueue = false } = {}) {
  const commands = new Map(); const runs = new Map(); const calls = [];
  const database = { control_commands: { findUnique: async ({ where }) => commands.get(where.id) ?? null },
    provider_runs: { findUnique: async ({ where }) => runs.get(where.id) ?? null } };
  const submitRuntimeCommand = async (input) => {
    calls.push("resume"); commands.set(input.commandId, { command_type: input.commandType, state: "completed",
      expected_generation: input.expectedGeneration, requested_by_operator_id: input.requestedByOperatorId,
      idempotency_key: input.idempotencyKey, correlation_id: input.correlationId });
    return { outcome: "accepted", state: "idle", generation: 6n };
  };
  let shouldFail = failQueue;
  const requestRunNow = async (input) => {
    calls.push("queue");
    if (shouldFail) { shouldFail = false; throw new Error("synthetic interruption"); }
    commands.set(input.commandId, { command_type: "run", resulting_run_id: input.runId,
      expected_generation: input.expectedGeneration, requested_by_operator_id: input.operatorId,
      idempotency_key: input.idempotencyKey, correlation_id: input.correlationId });
    runs.set(input.runId, { id: input.runId, control_command_id: input.commandId, config_version_id: input.expectedConfigVersionId,
      config_version_number: input.expectedConfigVersionNumber, requested_cursor_hash: "b".repeat(64), state: "queued" });
    return { kind: "created", run: { id: input.runId } };
  };
  return { database, commands, runs, calls, input: { database, receipt, cursorHash: "b".repeat(64), commands: { submitRuntimeCommand, requestRunNow },
    assertPrepared: async (resumed) => { calls.push(resumed ? "guard-idle" : "guard-paused"); } } };
}

test("Collector resume queues once; output loss and running/terminal retries cannot resume or queue again", async (t) => {
  const h = harness(t);
  assert.equal((await resumeCollectorHandoff(h.input)).outcome, "queued");
  for (const state of ["queued", "running", "succeeded"]) {
    h.runs.get(handoffId(operationId, "run")).state = state;
    assert.equal((await resumeCollectorHandoff(h.input)).outcome, "already_queued");
  }
  assert.deepEqual(h.calls, ["guard-paused", "resume", "queue"]);
  assert.equal(h.commands.size, 2); assert.equal(h.runs.size, 1);
});

test("Collector crash after resume recovers queue with original generation and no second resume", async (t) => {
  const h = harness(t, { failQueue: true });
  await assert.rejects(resumeCollectorHandoff(h.input), /synthetic interruption/u);
  assert.equal((await resumeCollectorHandoff(h.input)).outcome, "queued");
  assert.deepEqual(h.calls, ["guard-paused", "resume", "queue", "guard-idle", "queue"]);
  assert.equal(h.commands.get(handoffId(operationId, "run-command")).expected_generation, 6n);
});

test("Collector stale resume and changed queued lineage fail without downstream writes", async (t) => {
  const h = harness(t);
  await assert.rejects(resumeCollectorHandoff({ ...h.input, assertPrepared: async () => { throw new Error("stale"); } }));
  assert.equal(h.calls.length, 0);
  await resumeCollectorHandoff(h.input);
  h.runs.get(handoffId(operationId, "run")).requested_cursor_hash = "c".repeat(64);
  const before = h.calls.length;
  await assert.rejects(resumeCollectorHandoff(h.input), /HANDOFF_QUEUED_RUN_CHANGED/u);
  assert.equal(h.calls.length, before);
});
