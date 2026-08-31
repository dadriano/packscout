import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { failedHeadChainFixture as fixture } from "./provider-failed-head-chain-test-fixture.mjs";
const { failedHeadReviewSchema, failedHeadDigest: digest } = await tsImport("./provider-failed-head-policy.mts", import.meta.url);
const { createFailedHeadContinuation } = await tsImport("./provider-failed-head-control.mts", import.meta.url);
const { failedHeadResumeGuard } = await tsImport("./provider-failed-head-guard.mts", import.meta.url);
const db = await tsImport("@packscout/database", import.meta.url);
const inspect = f => f.control.inspect(f.database, f.authority);
const apply = (f, receipt, authority = async () => f.authority) => f.control.apply(f.database, receipt, authority, async () => {});
async function input(f) {
  const claim = await new db.PrismaProviderWorkerLeaseRepository(f.database).acquire({ role: "import", owner: f.ids.owner, leaseMilliseconds: 120_000 });
  assert.equal(claim.kind, "acquired");
  return { commandId: f.ids.resume, commandType: "resume", expectedGeneration: 38n, targetRunId: null, targetQuarantineId: null,
    idempotencyKey: f.ids.resumeKey, requestedByOperatorId: f.pins.operatorId, correlationId: f.pins.operationId, reason: null, requestedAt: f.now,
    expectedRuntimeGuard: failedHeadResumeGuard(f.review, structuredClone(f.cursor), { owner: claim.lease.owner, fence: claim.lease.fence }) };
}
test("explicit depth-two read-only review queues one independent child without rewriting either failure or earlier receipts", async () => {
  const f = await fixture(), runs = structuredClone([...f.runs]), audits = structuredClone(f.audits), commands = structuredClone(f.commands);
  const { receipt } = await inspect(f); assert.deepEqual(f.writes, []);
  assert.equal(JSON.stringify(receipt).includes(f.cursor.value), false);
  assert.equal((await apply(f, receipt)).phase, "queued");
  assert.equal(f.runtime.state_generation, 39n); assert.equal(f.runtime.row_version, 137n); assert.equal(f.runtime.operating_state, "idle");
  for (const [id, row] of runs) assert.deepEqual(f.runs.get(id), row);
  assert.deepEqual(f.audits.slice(0, audits.length), audits); assert.deepEqual(f.commands.slice(0, commands.length), commands);
  const child = f.runs.get(f.ids.run); assert.equal(child.state, "queued"); assert.equal(child.recovery_of_run_id, null);
  assert.deepEqual(child.requested_cursor, f.cursor); assert.equal(f.lease.lease_owner, null); assert.equal(f.runs.size, 4);
  const count = f.writes.length; assert.equal((await apply(f, receipt)).phase, "already_queued"); assert.equal(f.writes.length, count);
});
test("v1 still refuses a continuation child and v2 cannot recursively admit a third failure or skip ancestry", async () => {
  const f = await fixture(), { previousReview: _old, chain: _chain, ...rest } = f.review;
  void _old; void _chain;
  const v1 = failedHeadReviewSchema.parse({ ...rest, version: 1, authorization: "operator_requested_zero_commit_head_continuation" });
  await assert.rejects(createFailedHeadContinuation(v1).inspect(f.database, f.authority), /PROVENANCE_DRIFT/);
  for (const patch of [{ previousReview: f.review }, { previousReview: { ...f.previousReview, version: 2 } },
    { pins: { ...f.pins, operationId: f.previousReview.pins.operationId } }, { pins: { ...f.pins, initialRunId: f.root.id } },
    { generation: "39" }, { runtimeRowVersion: "137" }, { chain: { ...f.review.chain, receipt: f.review.chain.completed } },
    { previousReview: { ...f.previousReview, authorityDigest: "e".repeat(64) } }]) {
    assert.equal(failedHeadReviewSchema.safeParse({ ...f.review, ...patch }).success, false);
  }
  assert.deepEqual(f.writes, []);
});
test("either failure gaining pages or any record disposition, cursor or head drift refuses even after review rehash", async () => {
  for (const ancestor of ["root", "parent"]) for (const column of ["page_count", "accepted_count", "duplicate_count", "quarantined_count",
    "catalog_record_count", "pull_record_count", "market_event_record_count", "material_change_count"]) {
    const f = await fixture(); f[ancestor][column]++;
    if (ancestor === "parent") f.review.parentDigest = digest(f.parent);
    else { f.review.previousReview.parentDigest = digest(f.root); }
    await assert.rejects(inspect(f)); assert.deepEqual(f.writes, []);
  }
  for (const mutate of [f => { f.root.final_cursor = { ...f.cursor, value: "changed" }; },
    f => { f.parent.requested_cursor = { ...f.cursor, value: "changed" }; },
    f => { f.database.provider_run_pages.count = async () => 1; }, f => { f.reconciliation.details.phase = "facts"; }]) {
    const f = await fixture(); mutate(f); await assert.rejects(inspect(f)); assert.deepEqual(f.writes, []);
  }
});
test("missing, foreign or forged continuation evidence cannot be approved by rehashing a row", async () => {
  for (const name of ["receipt", "completed", "leaseClaim", "resumeGuard", "requested"]) {
    for (const field of ["action", "actor_operator_id", "target_id", "outcome"]) {
      const f = await fixture(); f.chainRows[name][field] = "forged";
      f.review.chain[name].digest = digest(f.chainRows[name]);
      await assert.rejects(inspect(f)); assert.deepEqual(f.writes, []);
    }
  }
  for (const mutate of [f => { f.chainRows.completed.details.runId = f.root.id; },
    f => { f.chainRows.requested.details.resultCode = "RUN_ALREADY_ACTIVE"; },
    f => { f.chainRows.resumeGuard.details.guardDigest = "a".repeat(64); },
    f => { f.chainRows.leaseClaim.details.fence = "484"; }, f => { f.resume.result.generation = "999"; },
    f => { f.command.idempotency_key = "foreign"; }, f => { f.parent.worker_fence++; },
    f => { f.audits.push({ ...f.chainRows.receipt, sequence: 999n, correlation_id: f.pins.operatorId }); },
    f => { f.runs.set(f.pins.operatorId, { ...f.parent, id: f.pins.operatorId }); }]) {
    const f = await fixture(); mutate(f); await assert.rejects(inspect(f)); assert.deepEqual(f.writes, []);
  }
});
test("public chain Resume rechecks ancestor, edge, checkpoint and exclusive lease atomically after preflight", async () => {
  for (const mutate of [f => { f.root.accepted_count++; }, f => { f.root.row_version++; },
    f => { f.chainRows.receipt.details.review.failureCode = "OTHER"; }, f => { f.chainRows.completed.details.runId = f.root.id; },
    f => { f.resume.result.generation = "999"; }, f => { f.command.requested_by_operator_id = f.pins.providerId; },
    f => { f.runtime.operating_state = "paused"; }, f => { f.runtime.source_cursor = { ...f.cursor, value: "changed" }; },
    f => { f.lease.lease_expires_at = new Date(f.now.getTime() - 1); }, f => { f.database.provider_run_pages.count = async () => 1; }]) {
    const f = await fixture(); await inspect(f); const command = await input(f), count = f.writes.length;
    f.onNextTransaction(() => mutate(f));
    const result = await new db.PrismaProviderCommandRepository(f.database).submit(command);
    assert.equal(result.code, "RUNTIME_RESUME_GUARD_CONFLICT"); assert.equal(f.writes.length, count);
    assert.equal(f.commands.some(row => row.id === f.ids.resume), false);
  }
});
test("depth-two receipt, Resume and queue crash gaps preserve both failures and queue at most one child", async () => {
  for (const stage of ["receipt", "resume", "queued"]) {
    const f = await fixture(), { receipt } = await inspect(f); let reads = 0;
    await assert.rejects(apply(f, receipt, async () => {
      if (++reads === ({ receipt: 2, resume: 3, queued: 4 })[stage]) throw new Error("synthetic crash"); return f.authority;
    }), /synthetic crash/);
    assert.equal(f.lease.lease_owner, null); assert.equal((await apply(f, receipt)).phase, "queued");
    assert.equal(f.runs.size, 4); assert.equal(f.commands.filter(row => row.id === f.ids.command).length, 1);
  }
});
test("atomic claim rollback and public replay preserve exact ancestry without widening late holds", async () => {
  const f = await fixture(), { receipt } = await inspect(f), create = f.database.local_audit_events.create; let fail = true;
  f.database.local_audit_events.create = async args => {
    if (fail && args.data.correlation_id === f.pins.operationId && args.data.action.endsWith(".lease_claimed")) {
      fail = false; throw new Error("claim rollback");
    } return create(args);
  };
  await assert.rejects(apply(f, receipt), /claim rollback/); assert.equal(f.lease.lease_fence, 486n); assert.equal(f.lease.lease_owner, null);
  const command = await input(f), repo = new db.PrismaProviderCommandRepository(f.database);
  assert.equal((await repo.submit(command)).outcome, "accepted"); const writes = f.writes.length;
  assert.equal((await repo.submit(command)).outcome, "deduplicated"); assert.equal(f.writes.length, writes);
  command.expectedRuntimeGuard.chain.previous.reviewDigest = "e".repeat(64);
  assert.equal((await repo.submit(command)).code, "RUNTIME_RESUME_GUARD_CONFLICT"); assert.equal(f.writes.length, writes);
});
test("public chain guard refuses expired or short caller budgets and forged rehashed edge actions before writes", async () => {
  for (const remaining of [-1, 0, 14999, NaN]) {
    const f = await fixture(), command = await input(f);
    command.expectedRuntimeGuard.notAfter = new Date(f.now.getTime() + remaining);
    const count = f.writes.length;
    assert.equal((await new db.PrismaProviderCommandRepository(f.database).submit(command)).code, "RUNTIME_RESUME_GUARD_CONFLICT");
    assert.equal(f.writes.length, count); assert.equal(f.runtime.operating_state, "error");
  }
  const f = await fixture(), command = await input(f);
  f.chainRows.requested.action = "provider.unrelated";
  command.expectedRuntimeGuard.chain.requested.digest = digest(f.chainRows.requested);
  const count = f.writes.length;
  assert.equal((await new db.PrismaProviderCommandRepository(f.database).submit(command)).code, "RUNTIME_RESUME_GUARD_CONFLICT");
  assert.equal(f.writes.length, count);
});
