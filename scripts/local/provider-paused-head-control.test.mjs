import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const databaseModule = await tsImport("@packscout/database", import.meta.url);
const { pausedHeadReviewSchema, pausedHeadDigest: digest, pausedHeadIds, pausedHeadAction } = await tsImport("./provider-paused-head-policy.mts", import.meta.url);

const { pausedHeadFixture: fixture } = await import("./provider-paused-head-test-fixture.mjs");

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
    requestedAt: f.now, expectedRuntimeGuard: { entry: "paused", providerId: f.pins.providerId, configVersionId: f.pins.configId,
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
