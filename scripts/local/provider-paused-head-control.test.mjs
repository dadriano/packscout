import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const databaseModule = await tsImport("@packscout/database", import.meta.url);
const { residentFixture, pins: originalPins } = await import("./provider-resident-test-fixture.mjs");
const { createPausedHeadAdoption } = await tsImport("./provider-paused-head-control.mts", import.meta.url);
const { pausedHeadReviewSchema, pausedHeadDigest: digest, pausedHeadIds, pausedHeadAction } = await tsImport("./provider-paused-head-policy.mts", import.meta.url);

async function fixture() {
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
async function inspect(f) { return f.database.$transaction(tx => f.control.inspect(tx, f.authority), { isolationLevel: "Serializable" }); }
async function apply(f, receipt, readAuthority = async () => f.authority) {
  return f.control.apply(f.database, receipt, readAuthority, async () => {});
}

test("paused successful head check is read-only; adoption resumes once without queueing or editing history", async () => {
  const f = await fixture(), parent = structuredClone(f.parent), old = structuredClone(f.old), checkpoint = structuredClone(f.runtime.source_cursor);
  const { receipt } = await inspect(f);
  assert.deepEqual(f.writes, []); assert.equal(JSON.stringify(receipt).includes(f.cursor.value), false);
  assert.equal((await apply(f, receipt)).phase, "adopted");
  assert.equal(f.runtime.operating_state, "idle"); assert.equal(f.runtime.state_generation, 33n); assert.equal(f.runtime.row_version, 131n);
  assert.deepEqual(f.runtime.source_cursor, checkpoint); assert.deepEqual(f.parent, parent); assert.deepEqual(f.old, old);
  assert.equal(f.runs.size, 1); assert.equal(f.commands.filter(x => x.command_type === "run").length, 0);
  assert.equal(f.commands.filter(x => x.command_type === "resume").length, 1); assert.equal(f.lease.lease_owner, null);
  const writes = f.writes.length;
  assert.equal((await apply(f, receipt)).phase, "already_adopted"); assert.equal(f.writes.length, writes);
  assert.equal(f.audits.filter(x => x.action === pausedHeadAction).length, 1);
});
test("receipt-before-resume and resume-before-completion crashes preserve a resumable single operation", async () => {
  for (const at of [2, 3]) {
    const f = await fixture(), { receipt } = await inspect(f); let reads = 0;
    await assert.rejects(apply(f, receipt, async () => { if (++reads === at) throw new Error("synthetic crash"); return f.authority; }), /synthetic crash/);
    assert.equal(f.runtime.state_generation, at === 2 ? 32n : 33n); assert.equal(f.lease.lease_owner, null);
    assert.equal((await apply(f, receipt)).phase, "adopted");
    assert.equal(f.commands.filter(x => x.command_type === "resume").length, 1); assert.equal(f.runs.size, 1);
  }
});
test("adoption drains a timed-out transaction callback before returning or starting later phases", async () => {
  const f = await fixture(), { receipt } = await inspect(f);
  let unblock, callbackFinished = false, settled = false;
  const blocked = new Promise(resolve => { unblock = resolve; });
  f.database.$queryRaw = async () => { await blocked; callbackFinished = true; throw new Error("synthetic callback canceled"); };
  f.database.$transaction = async callback => {
    void callback(f.database).catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    throw new Error("synthetic transaction deadline");
  };
  const operation = apply(f, receipt).finally(() => { settled = true; });
  const rejection = assert.rejects(operation, /synthetic transaction deadline/);
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(callbackFinished, false); assert.deepEqual(f.writes, []);
  unblock(); await rejection;
  assert.equal(callbackFinished, true); assert.equal(settled, true); assert.deepEqual(f.writes, []);
});
test("claim audit failure rolls back normal lease acquisition and permits exact safe retry", async () => {
  const f = await fixture(), { receipt } = await inspect(f), create = f.database.local_audit_events.create;
  let failOnce = true;
  f.database.local_audit_events.create = async input => {
    if (failOnce && input.data.action === `${pausedHeadAction}.lease_claimed`) {
      failOnce = false; throw new Error("synthetic claim audit failure");
    }
    return create(input);
  };
  await assert.rejects(apply(f, receipt), /synthetic claim audit failure/);
  assert.equal(f.lease.lease_fence, 481n); assert.equal(f.lease.lease_owner, null); assert.equal(f.runtime.operating_state, "paused");
  assert.equal(f.audits.filter(row => row.action === `${pausedHeadAction}.lease_claimed`).length, 0);
  assert.equal(f.commands.filter(row => row.command_type === "resume").length, 0);
  assert.equal((await apply(f, receipt)).phase, "adopted"); assert.equal(f.lease.lease_fence, 482n);
  assert.equal(f.audits.filter(row => row.action === `${pausedHeadAction}.lease_claimed`).length, 1);
  assert.equal(f.commands.filter(row => row.command_type === "resume").length, 1);
});
test("each pause, head, identity, authority, generation, full cursor and lease drift refuses before adoption writes", async () => {
  const changes = [f => { f.pause.state = "accepted"; }, f => { f.pause.result.generation = "31"; },
    f => { f.runtime.row_version++; }, f => { f.runtime.state_generation++; }, f => { f.runtime.cached_config_version_id = f.pins.operatorId; },
    f => { f.authority.route.node.host = "other.example.test"; }, f => { f.authority.digest = "f".repeat(64); },
    f => { f.runtime.source_cursor = { ...f.cursor, value: "changed" }; }, f => { f.parent.state = "incomplete"; },
    f => { f.reconciliation.details.phase = "facts"; }, f => { f.parent.reached_source_head = false; },
    f => { f.old.details.pins = { ...f.old.details.pins, providerId: f.pins.operatorId }; },
    f => { f.lease.lease_owner = "foreign"; f.lease.lease_expires_at = new Date(f.now.getTime() + 30_000); },
    f => { f.runs.set(f.pins.operatorId, { ...f.parent, id: f.pins.operatorId, requested_at: new Date(f.now.getTime() + 1) }); },
    f => { f.audits.push({ correlation_id: f.pins.operationId, action: "local.provider_continuous.operation" }); }];
  for (const change of changes) {
    const f = await fixture(); change(f); await assert.rejects(inspect(f)); assert.deepEqual(f.writes, []);
  }
});
function guardedResumeInput(f, lease) {
  const ids = pausedHeadIds(f.review);
  return { commandId: ids.resume, commandType: "resume", expectedGeneration: 32n, targetRunId: null, targetQuarantineId: null,
    idempotencyKey: ids.resumeKey, requestedByOperatorId: f.pins.operatorId, correlationId: f.pins.operationId, reason: null,
    requestedAt: f.now, expectedRuntimeGuard: { providerId: f.pins.providerId, configVersionId: f.pins.configId,
      configVersionNumber: 4n, runtimeRowVersion: 130n, checkpointHash: f.hash, checkpoint: structuredClone(f.runtime.source_cursor),
      pauseCommandId: f.pause.id, pauseCommandDigest: f.review.pauseCommandDigest, latestRunId: f.parent.id,
      latestRunDigest: f.review.parentDigest, expectedImportLease: { owner: lease.owner, fence: lease.fence } } };
}
test("public Resume repository atomically rejects drift after the successful caller preflight", async () => {
  const changes = [f => { f.lease.lease_expires_at = new Date(f.now.getTime() - 1); },
    f => { f.lease.lease_expires_at = new Date(f.now.getTime() + 14999); }, f => { f.lease.lease_fence++; },
    f => { f.lease.lease_owner = "foreign"; }, f => { f.runtime.source_cursor = { ...f.cursor, value: "raced-full-cursor" }; },
    f => { f.runtime.row_version++; }, f => { f.runtime.state_generation++; },
    f => { f.runtime.cached_config_version_id = f.pins.operatorId; }, f => { f.pause.state = "accepted"; },
    f => { f.parent.row_version++; }, f => { f.runs.set(f.pins.operatorId, { ...f.parent, id: f.pins.operatorId,
      requested_at: new Date(f.now.getTime() + 1) }); }];
  for (const change of changes) {
    const f = await fixture(); await inspect(f);
    const acquired = await new databaseModule.PrismaProviderWorkerLeaseRepository(f.database).acquire({ role: "import",
      owner: pausedHeadIds(f.review).owner, leaseMilliseconds: 120000 });
    assert.equal(acquired.kind, "acquired");
    const input = guardedResumeInput(f, acquired.lease), writeCount = f.writes.length;
    f.onNextTransaction(() => change(f));
    const result = await new databaseModule.PrismaProviderCommandRepository(f.database).submit(input);
    assert.equal(result.code, "RUNTIME_RESUME_GUARD_CONFLICT"); assert.equal(result.outcome, "conflict");
    assert.equal(f.runtime.operating_state, "paused"); assert.equal(f.writes.length, writeCount);
    assert.equal(f.commands.filter(x => x.command_type === "resume").length, 0);
  }
});
test("public Resume deadline admission rejects expired, invalid or insufficient budgets and refreshes DB time", async () => {
  for (const remaining of [-1, 0, 14999, NaN]) {
    const f = await fixture(), acquired = await new databaseModule.PrismaProviderWorkerLeaseRepository(f.database).acquire({
      role: "import", owner: pausedHeadIds(f.review).owner, leaseMilliseconds: 120000 });
    const input = guardedResumeInput(f, acquired.lease), writes = f.writes.length;
    input.expectedRuntimeGuard.notAfter = new Date(f.now.getTime() + remaining);
    assert.equal((await new databaseModule.PrismaProviderCommandRepository(f.database).submit(input)).code, "RUNTIME_RESUME_GUARD_CONFLICT");
    assert.equal(f.writes.length, writes); assert.equal(f.runtime.operating_state, "paused");
  }
  const f = await fixture(), acquired = await new databaseModule.PrismaProviderWorkerLeaseRepository(f.database).acquire({
    role: "import", owner: pausedHeadIds(f.review).owner, leaseMilliseconds: 120000 });
  const input = guardedResumeInput(f, acquired.lease), writes = f.writes.length, query = f.database.$queryRaw;
  input.expectedRuntimeGuard.notAfter = new Date(f.now.getTime() + 30000);
  f.database.$queryRaw = async sql => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
    return text.includes("select clock_timestamp() as now") ? [{ now: new Date(f.now.getTime() + 16000) }] : query(sql);
  };
  assert.equal((await new databaseModule.PrismaProviderCommandRepository(f.database).submit(input)).code, "RUNTIME_RESUME_GUARD_CONFLICT");
  assert.equal(f.writes.length, writes); assert.equal(f.runtime.operating_state, "paused");
});
test("public guarded Resume replays only exact audit-bound state under a freshly held lease", async () => {
  const f = await fixture(), leases = new databaseModule.PrismaProviderWorkerLeaseRepository(f.database);
  const first = await leases.acquire({ role: "import", owner: pausedHeadIds(f.review).owner, leaseMilliseconds: 120000 });
  const commands = new databaseModule.PrismaProviderCommandRepository(f.database), input = guardedResumeInput(f, first.lease);
  assert.equal((await commands.submit(input)).outcome, "accepted");
  assert.equal(await leases.release({ role: "import", owner: first.lease.owner, fence: first.lease.fence }), true);
  const next = await leases.acquire({ role: "import", owner: pausedHeadIds(f.review).owner, leaseMilliseconds: 120000 });
  input.expectedRuntimeGuard.expectedImportLease = { owner: next.lease.owner, fence: next.lease.fence };
  const writes = f.writes.length;
  assert.equal((await commands.submit(input)).outcome, "deduplicated"); assert.equal(f.writes.length, writes);
  f.audits.find(row => row.action === "provider.runtime.resume_guard").details.guardDigest = "f".repeat(64);
  assert.equal((await commands.submit(input)).code, "RUNTIME_RESUME_GUARD_CONFLICT"); assert.equal(f.writes.length, writes);
});
test("later operator pause after Resume cannot be overwritten by completion or a retry", async () => {
  const f = await fixture(), { receipt } = await inspect(f); let reads = 0;
  await assert.rejects(apply(f, receipt, async () => {
    if (++reads === 3) { f.runtime.operating_state = "paused"; f.runtime.state_generation++; f.runtime.row_version++; }
    return f.authority;
  }), /RUNTIME_OR_HISTORY_DRIFT/);
  assert.equal(f.runtime.operating_state, "paused"); assert.equal(f.runtime.state_generation, 34n);
  await assert.rejects(apply(f, receipt), /RUNTIME_OR_HISTORY_DRIFT/);
  assert.equal(f.commands.filter(x => x.command_type === "resume").length, 1); assert.equal(f.runs.size, 1);
});
test("new operation cannot reuse the historical operation or accept a mismatched completion receipt", async () => {
  const f = await fixture(); assert.equal(pausedHeadReviewSchema.safeParse({ ...f.review,
    pins: { ...f.pins, operationId: f.review.previousOperationId } }).success, false);
  const { receipt } = await inspect(f); await apply(f, receipt);
  f.audits.find(x => x.action === `${pausedHeadAction}.completed`).details.receiptDigest = "a".repeat(64);
  await assert.rejects(inspect(f), /COMPLETION_DRIFT/);
  assert.notEqual(pausedHeadIds(f.review).resume, f.review.pauseCommandId);
});
