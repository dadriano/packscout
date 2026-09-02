import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
const databaseModule = await tsImport("@packscout/database", import.meta.url);
const { residentFixture, pins: originalPins } = await import("./provider-resident-test-fixture.mjs");
const { createPausedHeadAdoption } = await tsImport("./provider-paused-head-control.mts", import.meta.url);
const { pausedHeadReviewSchema, pausedHeadDigest: digest, pausedHeadIds, pausedHeadAction } = await tsImport("./provider-paused-head-policy.mts", import.meta.url);

export async function pausedHeadFixture() {
  const f = residentFixture(), previousOperationId = originalPins.operationId;
  const pins = { ...originalPins, operationId: "3a333333-3333-4333-8333-333333333335" };
  Object.assign(f.runtime, { operating_state: "paused", state_generation: 32n, row_version: 130n, state_reason: "Operator hold", updated_at: f.now });
  Object.assign(f.lease, { lease_fence: 481n, heartbeat_at: null });
  Object.assign(f.parent, { row_version: 5n });
  Object.assign(f.last, { provider_run_id: f.parent.id, record_count: 0, accepted_count: 0, duplicate_count: 0,
    quarantined_count: 0, material_change_count: 0, committed_at: f.now, requested_cursor_hash: f.hash, response_digest: "e".repeat(64) });
  const pause = { id: "4a333333-3333-4333-8333-333333333335", idempotency_key: "synthetic-pause",
    command_type: "pause", state: "completed", expected_generation: 31n, requested_by_operator_id: pins.operatorId,
    correlation_id: "5a333333-3333-4333-8333-333333333335", reason: "Operator hold", requested_at: f.now,
    completed_at: f.now, target_run_id: null, target_quarantine_id: null, resulting_run_id: null, row_version: 3n,
    result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED", generation: "32" } };
  f.commands.push(pause);
  const old = { id: "6a333333-3333-4333-8333-333333333335", sequence: 1n, correlation_id: previousOperationId,
    actor_operator_id: pins.operatorId, action: "local.provider_continuous.operation", target_id: pins.initialRunId,
    target_type: "provider_run", outcome: "success", details: { pins: originalPins, authorityDigest: "c".repeat(64) }, occurred_at: f.now };
  const reconciliation = { id: "7a333333-3333-4333-8333-333333333335", sequence: 2n,
    action: "provider.run.head_reconciliation", target_id: pins.initialRunId, target_type: "provider_run", outcome: "success",
    details: { schemaVersion: 1, headPageId: f.last.id, configVersionId: pins.configId, checkpointHash: f.hash,
      leaseFence: f.parent.worker_fence.toString(), batchNumber: 27, phase: "complete", packAfterId: null,
      collectibleAfterId: null, packScanDone: true, collectibleScanDone: true, quarantineAfterId: null, quarantineAfterAt: null } };
  f.audits.push(old, reconciliation);
  const commands = f.commands, audits = f.audits, runtime = f.runtime, db = f.database;
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" && "in" in value ? value.in.includes(row[key]) : row[key] === value);
  db.control_commands = {
    findUnique: async ({ where }) => commands.find(row => matches(row, where)) ?? null,
    findMany: async ({ where }) => commands.filter(row => matches(row, where)),
    count: async ({ where }) => commands.filter(row => matches(row, where)).length,
    create: async ({ data }) => { f.writes.push("command"); const row = { ...structuredClone(data), state: "pending", row_version: 1n,
      target_run_id: null, target_quarantine_id: null, resulting_run_id: null, reason: null }; commands.push(row); return row; },
    update: async ({ where, data }) => { const row = commands.find(row => row.id === where.id); const { row_version, ...rest } = data;
      Object.assign(row, rest); if (row_version) row.row_version += row_version.increment; return row; },
  };
  db.provider_runtime.update = async ({ data }) => { f.writes.push("runtime"); const { row_version, ...rest } = data;
    Object.assign(runtime, rest); if (row_version) runtime.row_version += row_version.increment; return runtime; };
  db.provider_runs.findUniqueOrThrow = async ({ where }) => f.runs.get(where.id);
  db.provider_runs.findMany = async ({ where = {} }) => [...f.runs.values()].filter(row => matches(row, where));
  db.provider_runs.count = async ({ where }) => [...f.runs.values()].filter(row => matches(row, where)).length;
  db.provider_run_pages.findMany = async () => [f.last];
  db.promotion_ledger = { findUniqueOrThrow: async () => ({ last_sequence: 90n }) };
  db.quarantine_records = { count: async () => 2 };
  db.provider_worker_states.count = async () => 0;
  const filterAudit = where => audits.filter(row => matches(row, where));
  db.local_audit_events.findMany = async ({ where, take }) => filterAudit(where).slice(0, take);
  db.local_audit_events.findFirst = async ({ where }) => filterAudit(where).at(-1) ?? null;
  db.provider_activity_outbox = { create: async () => { f.writes.push("activity"); } };
  db.provider_state_events = { create: async () => { f.writes.push("state-event"); } };
  const query = db.$queryRaw;
  db.$queryRaw = async sql => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
    return text.includes("pg_stat_activity") ? [{ active: 0 }] : query(sql);
  };
  let beforeTransaction = null;
  db.$transaction = async (fn, options) => {
    assert.equal(options.isolationLevel, "Serializable");
    if (beforeTransaction) { const hook = beforeTransaction; beforeTransaction = null; hook(); }
    const before = structuredClone({ runtime, lease: f.lease, commands, audits, writeCount: f.writes.length });
    try { return await fn(db); } catch (error) {
      Object.assign(runtime, before.runtime); Object.assign(f.lease, before.lease);
      commands.splice(0, commands.length, ...before.commands); audits.splice(0, audits.length, ...before.audits);
      f.writes.length = before.writeCount; throw error;
    }
  };
  const provider = { host: "provider.example.test", port: 5432, databaseName: "packscout_clutchpacks", sslMode: "verify-full" };
  Object.assign(f.authority, { route: { organizationId: pins.organizationId, configVersionId: pins.configId,
    target: { providerId: pins.providerId, providerKey: pins.providerKey, databaseName: provider.databaseName }, node: provider } });
  const head = await databaseModule.readProviderRunHeadProof(db, pins.initialRunId);
  const review = pausedHeadReviewSchema.parse({ version: 1, authorization: "operator_requested_paused_head_resume", pins,
    previousOperationId, previousOperationReceiptDigest: digest(old), sourceCommit: "a".repeat(40),
    migrationProofPath: "/synthetic/migration.json", migrationProofDigest: "b".repeat(64),
    central: { ...provider, host: "central.example.test", databaseName: "packscout" }, provider, authorityDigest: f.authority.digest,
    configNumber: "4", pauseCommandId: pause.id, pauseCommandDigest: digest(pause), generation: "32", runtimeRowVersion: "130",
    importFence: "481", checkpointHash: f.hash, parentDigest: digest(f.parent), headProofDigest: digest(head) });
  return { ...f, pins, pause, old, reconciliation, review, control: createPausedHeadAdoption(review),
    onNextTransaction(hook) { beforeTransaction = hook; } };
}
