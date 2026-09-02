import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { failedHeadFixture as fixture } from "./provider-failed-head-test-fixture.mjs";
const database = await tsImport("@packscout/database", import.meta.url);
const { failedHeadAction: action, failedHeadAuditPins, failedHeadDigest: digest, failedHeadReviewSchema } =
  await tsImport("./provider-failed-head-policy.mts", import.meta.url);
const inspect = f => f.control.inspect(f.database, f.authority);
const apply = (f, receipt, authority = async () => f.authority, notAfter) =>
  f.control.apply(f.database, receipt, authority, async () => {}, () => {}, notAfter);
function resumeInput(f, held) {
  const r = f.review;
  return { commandId: f.ids.resume, commandType: "resume", expectedGeneration: 35n,
    targetRunId: null, targetQuarantineId: null, idempotencyKey: f.ids.resumeKey, requestedByOperatorId: f.pins.operatorId,
    correlationId: f.pins.operationId, reason: null, requestedAt: f.now,
    expectedRuntimeGuard: { entry: "failed_zero_commit_from_head", providerId: f.pins.providerId, configVersionId: f.pins.configId,
      configVersionNumber: 4n, runtimeRowVersion: 133n, checkpointHash: r.checkpointHash, checkpoint: structuredClone(f.cursor),
      latestRunId: f.parent.id, latestRunDigest: r.parentDigest, expectedImportLease: held,
      parentCommandDigest: r.parentCommandDigest, failureCode: r.failureCode, finishedAt: r.finishedAt, priorHeadRunId: r.priorHeadRunId,
      priorHeadRunDigest: r.priorHeadRunDigest, priorHeadProofDigest: r.priorHeadProofDigest,
      provenance: failedHeadAuditPins(r), adoptionResumeId: r.provenance.adoptionResume.id,
      adoptionResumeDigest: r.provenance.adoptionResume.digest } };
}
async function acquire(f) {
  const result = await new database.PrismaProviderWorkerLeaseRepository(f.database).acquire({ role: "import",
    owner: f.ids.owner, leaseMilliseconds: 120_000 });
  assert.equal(result.kind, "acquired"); return { owner: result.lease.owner, fence: result.lease.fence };
}
test("zero-commit failed head inspection is read-only; one audited independent child preserves all old evidence", async () => {
  const f = await fixture(), parent = structuredClone(f.parent), prior = structuredClone(f.prior),
    oldAudits = structuredClone(f.audits), cursor = structuredClone(f.runtime.source_cursor);
  const { receipt } = await inspect(f);
  assert.deepEqual(f.writes, []); assert.equal(JSON.stringify(receipt).includes(f.cursor.value), false);
  assert.equal((await apply(f, receipt)).phase, "queued");
  assert.equal(f.runtime.operating_state, "idle"); assert.equal(f.runtime.state_generation, 36n); assert.equal(f.runtime.row_version, 134n);
  assert.deepEqual(f.parent, parent); assert.deepEqual(f.prior, prior); assert.deepEqual(f.runtime.source_cursor, cursor);
  assert.deepEqual(f.audits.slice(0, oldAudits.length), oldAudits); assert.equal(f.lease.lease_owner, null);
  const child = f.runs.get(f.ids.run); assert.equal(child.state, "queued"); assert.equal(child.recovery_of_run_id, null);
  assert.deepEqual(child.requested_cursor, cursor); assert.equal(child.page_count, 0); assert.equal(child.worker_fence, 0n);
  assert.equal(f.commands.filter(row => row.id === f.ids.resume).length, 1); assert.equal(f.runs.size, 3);
  const writes = f.writes.length; assert.equal((await apply(f, receipt)).phase, "already_queued"); assert.equal(f.writes.length, writes);
});
test("committed or altered failed parent, unproven head, foreign authority and live work refuse without writes", async () => {
  const mutations = [f => { f.parent.page_count = 1; }, f => { f.parent.accepted_count = 1; },
    f => { f.parent.duplicate_count = 1; }, f => { f.parent.quarantined_count = 1; },
    f => { f.parent.catalog_record_count = 1; }, f => { f.parent.pull_record_count = 1; },
    f => { f.parent.market_event_record_count = 1; }, f => { f.parent.material_change_count = 1; },
    f => { f.parent.requested_cursor = { ...f.cursor, value: "other" }; }, f => { f.parent.final_cursor = { ...f.cursor, value: "other" }; },
    f => { f.parent.failure_code = "OTHER"; }, f => { f.parent.state = "incomplete"; }, f => { f.parent.reached_source_head = true; },
    f => { f.prior.final_cursor = { ...f.cursor, value: "other" }; }, f => { f.reconciliation.details.phase = "facts"; },
    f => { f.adopted.details.receiptDigest = "f".repeat(64); }, f => { f.cycleRow.details.runId = f.pins.operatorId; },
    f => { f.operation.details.authorityDigest = "f".repeat(64); }, f => { f.authority.route.node.host = "foreign.test"; },
    f => { f.runtime.operating_state = "paused"; }, f => { f.runtime.state_generation++; }, f => { f.runtime.row_version++; },
    f => { f.lease.lease_owner = "foreign"; f.lease.lease_expires_at = new Date(f.now.getTime() + 60_000); },
    f => { f.database.provider_run_pages.findMany = async () => [f.last, { ...f.last, provider_run_id: f.parent.id }]; }];
  for (const mutate of mutations) { const f = await fixture(); mutate(f); await assert.rejects(inspect(f)); assert.deepEqual(f.writes, []); }
});
test("receipt, Resume and queued-child crash gaps replay one operation without a duplicate child", async () => {
  for (const step of ["receipt", "resume", "queued"]) {
    const f = await fixture(), { receipt } = await inspect(f); let reads = 0;
    await assert.rejects(apply(f, receipt, async () => {
      if (++reads === ({ receipt: 2, resume: 3, queued: 4 })[step]) throw new Error("synthetic crash"); return f.authority;
    }), /synthetic crash/);
    assert.equal(f.lease.lease_owner, null);
    assert.equal((await apply(f, receipt)).phase, "queued");
    assert.equal(f.commands.filter(row => row.id === f.ids.resume).length, 1);
    assert.equal(f.commands.filter(row => row.id === f.ids.command).length, 1); assert.equal(f.runs.size, 3);
  }
});
test("failed claim audit rolls back the normal fenced acquisition before retry", async () => {
  const f = await fixture(), { receipt } = await inspect(f), create = f.database.local_audit_events.create;
  let fail = true;
  f.database.local_audit_events.create = async input => {
    if (fail && input.data.action === `${action}.lease_claimed`) { fail = false; throw new Error("claim failure"); }
    return create(input);
  };
  await assert.rejects(apply(f, receipt), /claim failure/);
  assert.equal(f.lease.lease_fence, 484n); assert.equal(f.lease.lease_owner, null); assert.equal(f.runtime.operating_state, "error");
  assert.equal((await apply(f, receipt)).phase, "queued"); assert.equal(f.lease.lease_fence, 485n);
});
test("public failed Resume rejects changed immutable evidence atomically after preflight", async () => {
  for (const mutate of [f => { f.parent.accepted_count++; }, f => { f.prior.row_version++; },
    f => { f.adoption.details.historyDigest = "f".repeat(64); }, f => { f.runtime.source_cursor = { ...f.cursor, value: "changed" }; },
    f => { f.runtime.operating_state = "paused"; }, f => { f.lease.lease_expires_at = new Date(f.now.getTime() - 1); },
    f => { f.database.provider_run_pages.count = async () => 1; }]) {
    const f = await fixture(); await inspect(f); const held = await acquire(f), input = resumeInput(f, held), count = f.writes.length;
    f.onNextTransaction(() => mutate(f));
    const result = await new database.PrismaProviderCommandRepository(f.database).submit(input);
    assert.equal(result.outcome, "conflict"); assert.equal(result.code, "RUNTIME_RESUME_GUARD_CONFLICT");
    assert.equal(f.writes.length, count); assert.equal(f.commands.some(row => row.id === f.ids.resume), false);
  }
});
test("public failed Resume replay binds identical provenance under a new held lease", async () => {
  const f = await fixture(), held = await acquire(f), input = resumeInput(f, held), repo = new database.PrismaProviderCommandRepository(f.database);
  assert.equal((await repo.submit(input)).outcome, "accepted");
  const leases = new database.PrismaProviderWorkerLeaseRepository(f.database); await leases.release({ role: "import", ...held });
  input.expectedRuntimeGuard.expectedImportLease = await acquire(f);
  const count = f.writes.length; assert.equal((await repo.submit(input)).outcome, "deduplicated"); assert.equal(f.writes.length, count);
  input.expectedRuntimeGuard.priorHeadProofDigest = "e".repeat(64);
  assert.equal((await repo.submit(input)).outcome, "conflict"); assert.equal(f.writes.length, count);
});
function queueInput(f, held, notAfter) {
  return { providerId: f.pins.providerId, operatorId: f.pins.operatorId, expectedConfigVersionId: f.pins.configId,
    expectedConfigVersionNumber: 4n, expectedGeneration: 36n, idempotencyKey: f.ids.runKey, commandId: f.ids.command,
    runId: f.ids.run, correlationId: f.pins.operationId, expectedCursorFingerprint: f.hash, requireNoActiveRun: true,
    expectedImportLease: held, notAfter };
}
test("fenced Run-now refuses expired, short, invalid or aged deadline and lease budgets before writes", async () => {
  for (const remaining of [-1, 0, 14999, NaN]) {
    const f = await fixture(), held = await acquire(f);
    await new database.PrismaProviderCommandRepository(f.database).submit(resumeInput(f, held));
    const count = f.writes.length;
    const result = await new database.PrismaAdminProviderRuntimeRepository(f.database).requestRunNow(
      queueInput(f, held, new Date(f.now.getTime() + remaining)));
    assert.equal(result.kind, "runtime_unavailable"); assert.equal(f.writes.length, count); assert.equal(f.runs.size, 2);
  }
  for (const expired of ["lease", "clock"]) {
    const f = await fixture(), held = await acquire(f);
    await new database.PrismaProviderCommandRepository(f.database).submit(resumeInput(f, held));
    const count = f.writes.length, query = f.database.$queryRaw;
    if (expired === "lease") f.lease.lease_expires_at = new Date(f.now.getTime() + 14999);
    else { let reads = 0; f.database.$queryRaw = async sql => {
      const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
      if (text.includes("select clock_timestamp() as now") && ++reads === 2) return [{ now: new Date(f.now.getTime() + 16000) }];
      return query(sql);
    }; }
    const result = await new database.PrismaAdminProviderRuntimeRepository(f.database).requestRunNow(
      queueInput(f, held, new Date(f.now.getTime() + 30000)));
    assert.equal(result.kind, "runtime_unavailable"); assert.equal(f.writes.length, count);
  }
});
test("later operator pause and foreign queued child cannot be overwritten or adopted on retry", async () => {
  const f = await fixture(), { receipt } = await inspect(f); let reads = 0;
  await assert.rejects(apply(f, receipt, async () => { if (++reads === 3) {
    f.runtime.operating_state = "paused"; f.runtime.state_generation++; f.runtime.row_version++;
  } return f.authority; }));
  await assert.rejects(apply(f, receipt)); assert.equal(f.runtime.operating_state, "paused"); assert.equal(f.runs.size, 2);
  const other = await fixture(), approved = await inspect(other); await apply(other, approved.receipt);
  other.runs.get(other.ids.run).requested_by_operator_id = other.pins.providerId;
  await assert.rejects(inspect(other), /QUEUE_DRIFT/);
});
test("new operation cannot reuse old operation, head parent or foreign receipt", async () => {
  const f = await fixture(); assert.equal(failedHeadReviewSchema.safeParse({ ...f.review,
    pins: { ...f.pins, operationId: f.review.priorOperationId } }).success, false);
  f.audits.push({ correlation_id: f.pins.operationId, action: "local.provider_continuous.operation" });
  await assert.rejects(inspect(f), /OPERATION_REUSED/); assert.deepEqual(f.writes, []);
  assert.notEqual(digest(f.review), digest({ ...f.review, sourceCommit: "c".repeat(40) }));
});
test("positive counters cannot be approved by merely rehashing a zero-commit review", async () => {
  const f = await fixture(); f.parent.quarantined_count = 1; f.review.parentDigest = digest(f.parent);
  await assert.rejects(inspect(f), /PARENT_OR_HEAD_DRIFT/); assert.deepEqual(f.writes, []);
  const held = await acquire(f), input = resumeInput(f, held), writes = f.writes.length;
  assert.equal((await new database.PrismaProviderCommandRepository(f.database).submit(input)).code, "RUNTIME_RESUME_GUARD_CONFLICT");
  assert.equal(f.writes.length, writes);
});
test("queue deadline accepts the full boundary and an expired replay cannot create a second child", async () => {
  const f = await fixture(), held = await acquire(f);
  await new database.PrismaProviderCommandRepository(f.database).submit(resumeInput(f, held));
  const repo = new database.PrismaAdminProviderRuntimeRepository(f.database);
  const input = queueInput(f, held, new Date(f.now.getTime() + 15000));
  assert.equal((await repo.requestRunNow(input)).kind, "created");
  const writes = f.writes.length; input.notAfter = new Date(f.now.getTime() - 1);
  assert.equal((await repo.requestRunNow(input)).kind, "deduplicated"); assert.equal(f.writes.length, writes); assert.equal(f.runs.size, 3);
});
test("public failed Resume refuses substituted provenance action even with matching new row digest", async () => {
  const f = await fixture(), held = await acquire(f), input = resumeInput(f, held);
  f.adoption.action = "synthetic.unrelated.evidence";
  input.expectedRuntimeGuard.provenance[0] = { sequence: f.adoption.sequence.toString(),
    action: f.adoption.action, digest: digest(f.adoption) };
  const writes = f.writes.length;
  assert.equal((await new database.PrismaProviderCommandRepository(f.database).submit(input)).code, "RUNTIME_RESUME_GUARD_CONFLICT");
  assert.equal(f.writes.length, writes); assert.equal(f.runtime.operating_state, "error");
});
