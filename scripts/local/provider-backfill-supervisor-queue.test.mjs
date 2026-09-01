import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { queueBackfillRetry } = await tsImport("./provider-backfill-supervisor-queue.mts", import.meta.url);
const { backfillId } = await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
const pins = { organizationId: "337fdac5-d49d-4565-a5cb-af8d9333b601", providerId: "337fdac5-d49d-4565-a5cb-af8d9333b602",
  providerKey: "phygitals", configId: "337fdac5-d49d-4565-a5cb-af8d9333b603",
  initialRunId: "337fdac5-d49d-4565-a5cb-af8d9333b604", operationId: "337fdac5-d49d-4565-a5cb-af8d9333b605",
  operatorId: "337fdac5-d49d-4565-a5cb-af8d9333b606" };
const intent = { pins, authorityDigest: "a".repeat(64), parentRunId: pins.initialRunId,
  runId: backfillId(pins.operationId, `run/${pins.initialRunId}`), configNumber: "4", generation: "2",
  checkpointHash: "b".repeat(64), failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT", retryNumber: 1,
  consecutiveNoProgress: 1, notBefore: "2026-08-30T05:00:05.000Z", createdAt: "2026-08-30T05:00:00.000Z", kind: "transient_retry" };

function fixture() {
  const stored = new Map(); const history = []; let run = null; let failQueue = false;
  const parent = { id: intent.parentRunId, records_per_request: 100,
    request_settings_revision_id: "337fdac5-d49d-4565-a5cb-af8d9333b607" };
  const database = {
    control_commands: { findUnique: async ({ where }) => stored.get(where.id) ?? null },
    provider_runs: { findUnique: async ({ where }) => where.id === parent.id ? parent : run },
  };
  const commands = {
    async submitRuntimeCommand(input) {
      history.push("resume"); stored.set(input.commandId, { command_type: "resume", state: "completed",
        expected_generation: input.expectedGeneration, requested_by_operator_id: input.requestedByOperatorId,
        correlation_id: input.correlationId, reason: input.reason, idempotency_key: input.idempotencyKey });
      return { outcome: "accepted", state: "idle", generation: 3n };
    },
    async requestRunNow(input) {
      history.push("queue");
      assert.equal(input.expectedCursorFingerprint, intent.checkpointHash);
      assert.equal(input.requestSettingsRecoveryParentRunId, intent.parentRunId);
      assert.equal(input.requireNoActiveRun, true); assert.equal(input.expectedGeneration, 3n);
      if (failQueue) throw new Error("test interruption after resume");
      run = { id: input.runId, control_command_id: input.commandId, requested_cursor_hash: intent.checkpointHash,
        records_per_request: parent.records_per_request, request_settings_revision_id: parent.request_settings_revision_id,
        request_settings_parent_run_id: parent.id,
        config_version_id: pins.configId, config_version_number: 4n, state: "queued" };
      stored.set(input.commandId, { command_type: "run", state: "accepted", resulting_run_id: input.runId,
        expected_generation: 3n, requested_by_operator_id: pins.operatorId, correlation_id: pins.operationId,
        idempotency_key: input.idempotencyKey });
      return { kind: "created", run: { id: run.id, requestedCursorHash: run.requested_cursor_hash } };
    },
  };
  const invoke = (assertPinned = async resumed => { history.push(resumed ? "pin-idle" : "pin-error"); }) =>
    queueBackfillRetry({ database, intent, commands, assertPinned });
  return { database, commands, stored, history, invoke, parent, getRun: () => run, failQueue: value => { failQueue = value; } };
}

test("terminal source failure resumes and queues exactly once using original generation and checkpoint", async () => {
  const f = fixture(); assert.equal(await f.invoke(), intent.runId);
  assert.deepEqual(f.history, ["pin-error", "resume", "pin-idle", "queue"]);
  assert.equal(await f.invoke(), intent.runId);
  assert.deepEqual(f.history, ["pin-error", "resume", "pin-idle", "queue"]);
});

test("crash after resume is recognized without another runtime transition or cursor reset", async () => {
  const f = fixture(); f.failQueue(true);
  await assert.rejects(f.invoke(), /test interruption/);
  f.failQueue(false); await f.invoke();
  assert.equal(f.history.filter(e => e === "resume").length, 1);
  assert.equal(f.history.filter(e => e === "queue").length, 2);
});

test("running/terminal exact retry remains idempotently recognized after cursor advancement", async () => {
  const f = fixture(); await f.invoke();
  for (const state of ["running", "failed", "succeeded"]) {
    f.getRun().state = state;
    assert.equal(await f.invoke(async () => { assert.fail("Must not revalidate the old runtime cursor for an already queued run."); }), intent.runId);
  }
});

test("operator pause or generation/cursor drift between resume and queue prevents the queue", async () => {
  const f = fixture();
  await assert.rejects(f.invoke(async resumed => { if (resumed) throw new Error("pinned runtime changed"); }), /pinned runtime changed/);
  assert.equal(f.history.includes("queue"), false);
});

test("forged resume provenance and wrong queued checkpoint fail without another command", async () => {
  const f = fixture(); f.failQueue(true); await assert.rejects(f.invoke());
  const resume = f.stored.get(backfillId(pins.operationId, `resume/${pins.initialRunId}`));
  resume.expected_generation = 1n;
  await assert.rejects(f.invoke(), /RESUME_RECEIPT_CONFLICT/);
  const g = fixture(); await g.invoke(); g.getRun().requested_cursor_hash = "f".repeat(64);
  await assert.rejects(g.invoke(), /QUEUED_RUN_CONFLICT/);
  assert.equal(g.history.filter(e => e === "queue").length, 1);
});

test("a retry keeps the parent's request pin and refuses forged or unknown pin lineage", async () => {
  const f = fixture(); await f.invoke();
  assert.equal(f.getRun().records_per_request, 100);
  f.getRun().records_per_request = 1000;
  await assert.rejects(f.invoke(), /QUEUED_RUN_CONFLICT/);
  const g = fixture(); await g.invoke(); g.getRun().request_settings_parent_run_id = pins.operatorId;
  await assert.rejects(g.invoke(), /QUEUED_RUN_CONFLICT/);
  const h = fixture(); await h.invoke(); h.parent.request_settings_revision_id = null;
  await assert.rejects(h.invoke(), /QUEUED_RUN_CONFLICT/);
});
