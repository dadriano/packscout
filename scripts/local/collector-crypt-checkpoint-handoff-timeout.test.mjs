import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const timeout = await tsImport("./collector-crypt-checkpoint-handoff-timeout.mts", import.meta.url);
const plan = await tsImport("./collector-crypt-checkpoint-handoff-plan.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
const { dataforrestLaunchDistributedSourceAdapterManifest: manifest } = await tsImport("@packscout/contracts", import.meta.url);
const operationId = "8639cd08-f89e-4127-ab6a-82c0b61373c2";
const nextConfigId = plan.handoffId(operationId, "config");
const pins = timeout.collectorTimeoutFailurePins;
const cursor = { sourceInstanceId: plan.collectorHandoff.providerId, sourceRevisionId: pins.configId,
  sourceTypeKey: manifest.sourceTypeKey, adapterVersion: plan.collectorHandoff.previousAdapter,
  cursorCodecKey: manifest.cursorCodecKey, cursorGeneration: 1, value: "protected-saved-progress" };
const cursorHash = providerMixedCursorFingerprint(cursor);
function checkpoint() {
  return { providerId: plan.collectorHandoff.providerId, providerKey: "collector_crypt", databaseRole: "provider",
    schemaVersion: "distributed-provider-v1", runtimeState: "error", generation: "2", runtimeRowVersion: "40000",
    cachedConfigId: pins.configId, cachedConfigNumber: "2", cursor, cursorHash, activeRunCount: 0, runCount: 1, otherOwnedWorkerLeaseCount: 0,
    actionableCommandCount: 0, otherActiveTransactionCount: 0, oldProcessAlive: false,
    databaseNow: "2026-08-30T05:26:21.000Z", lease: { owner: null, fence: "1", expiresAt: null },
    ledgerSequence: "1854600", run: { id: pins.runId, state: "failed", configId: pins.configId, configNumber: "2",
      fence: "1", pageCount: 9273, accepted: 927300, duplicates: 0, quarantines: 0, materialChanges: 927300,
      reachedHead: false, finishedAt: pins.finishedAt, failureCode: pins.failureCode, finalCursor: cursor, finalCursorHash: cursorHash },
    lastPage: { id: operationId, number: 9273, cursor, cursorHash, continuation: "more" } };
}
const authority = { authorityDigest: "a".repeat(64), operatorId: "c06ed5d6-d6d7-4d74-8847-e458f7f62201",
  previous: { id: pins.configId }, nextConfigId };

test("Collector exact terminal timeout has a distinct receipt and never passes the clean-pause policy", () => {
  const snapshot = checkpoint();
  assert.throws(() => plan.assertCollectorHandoffDrained({ snapshot: { ...snapshot, runtimeState: "paused", generation: "3" },
    previousConfigId: pins.configId, nextConfigId, expectedGeneration: "3" }));
  const receipt = timeout.collectorTimeoutReceipt({ authority, snapshot, operationId });
  assert.equal(receipt.kind, "terminal_timeout");
  assert.equal(receipt.failureCode, pins.failureCode);
  assert.equal(receipt.generation, "2");
  assert.equal(JSON.stringify(receipt).includes(cursor.value), false);
  assert.equal(Object.hasOwn(receipt, "oldWorkerPid"), false);
  assert.equal(timeout.assertCollectorTimeoutHandoffDrained({ snapshot: { ...snapshot, runtimeState: "paused", generation: "3" },
    previousConfigId: pins.configId, nextConfigId, expectedGeneration: "3" }), "previous");
});

test("Collector timeout entry refuses wrong failures, source head, drift and any live or foreign lease", () => {
  for (const change of [{ providerKey: "phygitals" }, { runtimeState: "paused" }, { generation: "3" },
    { cachedConfigId: operationId }, { cursorHash: "b".repeat(64) }, { activeRunCount: 1 },
    { actionableCommandCount: 1 }, { otherActiveTransactionCount: 1 }, { runCount: 2 }, { otherOwnedWorkerLeaseCount: 1 },
    { lease: { owner: "other", fence: "2", expiresAt: "2026-08-30T00:00:00Z" } },
    ...["SOURCE_INVALID_RESPONSE", "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING", null].map((failureCode) => ({ run: { ...checkpoint().run, failureCode } })),
    ...[{ id: operationId }, { fence: "2" }, { reachedHead: true }, { state: "incomplete" }, { pageCount: 9274 },
      { accepted: 927301 }, { quarantines: 1 }, { duplicates: 1 }, { finishedAt: "2026-08-30T04:24:24.000Z" }].map((run) => ({ run: { ...checkpoint().run, ...run } }))]) {
    assert.throws(() => timeout.collectorTimeoutReceipt({ authority, snapshot: { ...checkpoint(), ...change }, operationId }));
  }
});

test("Collector timeout provenance requires pause AFTER failure, exact receipt and checkpoint retention", async () => {
  const snapshot = checkpoint();
  const receipt = timeout.collectorTimeoutReceipt({ authority, snapshot, operationId });
  const command = { command_type: "pause", state: "completed", expected_generation: 2n,
    requested_by_operator_id: authority.operatorId, correlation_id: operationId, reason: timeout.collectorTimeoutPauseReason,
    idempotency_key: `collector-handoff/${operationId}/terminal-timeout-pause`,
    completed_at: new Date("2026-08-30T05:27:00Z") };
  const db = { control_commands: { findUnique: async () => command } };
  const paused = { ...snapshot, runtimeState: "paused", generation: "3", runtimeRowVersion: "40001" };
  await timeout.assertCollectorTimeoutProvenance(db, receipt, paused);
  command.completed_at = new Date("2026-08-30T04:24:00Z");
  await assert.rejects(timeout.assertCollectorTimeoutProvenance(db, receipt, paused));
  command.completed_at = new Date("2026-08-30T05:27:00Z");
  await assert.rejects(timeout.assertCollectorTimeoutProvenance(db, receipt, { ...paused, ledgerSequence: "1854601" }));
  await assert.rejects(timeout.assertCollectorTimeoutProvenance(db, receipt, { ...paused, run: { ...paused.run, materialChanges: 1 } }));
});

function persistenceFixture({ failFirstCommand = false } = {}) {
  const s = checkpoint(); const audits = []; const commands = new Map(); const calls = [];
  const runtime = { central_provider_id: s.providerId, provider_key: s.providerKey, operating_state: "error", state_generation: 2n,
    row_version: 40000n, cached_config_version_id: pins.configId, cached_config_version_number: 2n,
    source_cursor: cursor, source_cursor_hash: cursorHash };
  const lease = { worker_role: "import", lease_owner: null, lease_fence: 1n, lease_expires_at: null,
    row_version: 1n, heartbeat_at: null, database_now: new Date(s.databaseNow) };
  const run = { id: pins.runId, state: "failed", config_version_id: pins.configId, config_version_number: 2n, worker_fence: 1n,
    page_count: 9273, accepted_count: 927300, duplicate_count: 0, quarantined_count: 0, material_change_count: 927300,
    reached_source_head: false, finished_at: new Date(pins.finishedAt), failure_code: pins.failureCode,
    final_cursor: cursor, final_cursor_hash: cursorHash };
  const database = {
    $transaction: async (action) => action(database),
    $queryRaw: async (query) => {
      const text = Array.isArray(query) ? query.join("") : query.sql;
      if (text.includes("pg_stat_activity")) return [{ now: new Date(s.databaseNow), active: 0 }];
      calls.push(text.includes("provider_worker_states") ? "lock-lease" : text.includes("provider_runs") ? "lock-run" : "lock-runtime");
      return [lease];
    },
    database_identity: { findUniqueOrThrow: async () => ({ provider_id: s.providerId, provider_key: s.providerKey,
      database_role: "provider", schema_version: "distributed-provider-v1" }) },
    provider_runtime: { findUniqueOrThrow: async () => runtime },
    provider_worker_states: { findUniqueOrThrow: async () => lease, count: async () => 0 },
    provider_runs: { findUnique: async () => run, count: async (input) => input ? 0 : 1 },
    control_commands: { findUnique: async ({ where }) => commands.get(where.id) ?? null, count: async () => 0 },
    promotion_ledger: { findUniqueOrThrow: async () => ({ last_sequence: 1854600n }) },
    provider_run_pages: { findFirst: async () => ({ id: operationId, page_number: 9273, next_cursor: cursor,
      next_cursor_hash: cursorHash, continuation: "more" }) },
    local_audit_events: { findMany: async () => audits,
      create: async ({ data }) => { calls.push("receipt"); audits.push(data); return data; } },
  };
  let failed = false;
  const repository = { submitRuntimeCommand: async (input) => {
    calls.push("pause-command");
    if (failFirstCommand && !failed) { failed = true; throw new Error("interrupted-before-pause"); }
    commands.set(input.commandId, { state: "completed" }); runtime.operating_state = "paused"; runtime.state_generation = 3n;
    return { commandId: input.commandId, outcome: "accepted", state: "paused", generation: 3n };
  } };
  return { database, runtime, lease, run, audits, calls, repository };
}

test("Collector terminal timeout receipt survives interruption before pause and post-command output loss", async () => {
  const receipt = timeout.collectorTimeoutReceipt({ authority, snapshot: checkpoint(), operationId });
  const h = persistenceFixture({ failFirstCommand: true });
  await assert.rejects(timeout.submitCollectorTimeoutPause(h.database, receipt, authority, h.repository), /interrupted/u);
  assert.equal(h.audits.length, 1); assert.equal(h.runtime.operating_state, "error");
  assert.equal((await timeout.submitCollectorTimeoutPause(h.database, receipt, authority, h.repository)).outcome, "terminal_timeout_paused");
  assert.equal((await timeout.submitCollectorTimeoutPause(h.database, receipt, authority, h.repository)).outcome, "terminal_timeout_paused");
  assert.equal(h.audits.length, 1);
  assert.deepEqual(h.calls.slice(0, 3), ["lock-lease", "lock-run", "lock-runtime"]);
  assert.equal(h.run.failure_code, pins.failureCode); assert.equal(h.run.final_cursor_hash, cursorHash);
});

test("Collector locked timeout entry rejects lease, row-version and ledger drift before receipt/command writes", async () => {
  const receipt = timeout.collectorTimeoutReceipt({ authority, snapshot: checkpoint(), operationId });
  for (const mutate of [(h) => { h.lease.lease_owner = "foreign"; },
    (h) => { h.runtime.row_version = 40001n; }, (h) => { h.run.material_change_count++; }]) {
    const h = persistenceFixture(); mutate(h);
    await assert.rejects(timeout.submitCollectorTimeoutPause(h.database, receipt, authority, h.repository));
    assert.equal(h.audits.length, 0); assert.equal(h.calls.includes("pause-command"), false);
  }
});
