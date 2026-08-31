import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import { pausedHeadFixture } from "./provider-paused-head-test-fixture.mjs";
const { failedHeadReviewSchema, failedHeadDigest: digest, failedHeadIds } = await tsImport("./provider-failed-head-policy.mts", import.meta.url);
const { createFailedHeadContinuation } = await tsImport("./provider-failed-head-control.mts", import.meta.url);
const { makeContinuousCycle } = await tsImport("./provider-continuous-policy.mts", import.meta.url);
const { readBackfillSnapshot } = await tsImport("./provider-backfill-supervisor-state.mts", import.meta.url);
const { readProviderRunHeadProof } = await tsImport("@packscout/database", import.meta.url);
export async function failedHeadFixture() {
  const f = await pausedHeadFixture(), db = f.database;
  const createAudit = db.local_audit_events.create;
  db.local_audit_events.create = async ({ data }) => createAudit({ data: { id: `8a333333-3333-4333-8333-${String(f.audits.length).padStart(12, "0")}`, ...data } });
  const initial = await f.control.inspect(db, f.authority);
  await f.control.apply(db, initial.receipt, async () => f.authority, async () => {});
  const opPins = f.pins;
  const operation = await db.local_audit_events.create({ data: { correlation_id: opPins.operationId, actor_operator_id: opPins.operatorId,
    action: "local.provider_continuous.operation", target_type: "provider_run", target_id: opPins.initialRunId,
    outcome: "success", details: { pins: opPins, authorityDigest: f.authority.digest }, occurred_at: f.now } });
  const snapshot = await readBackfillSnapshot(db, opPins, f.authority, opPins.initialRunId);
  const cycle = makeContinuousCycle({ snapshot, authorityDigest: f.authority.digest, scheduleSeconds: 300 }, opPins);
  const cycleRow = await db.local_audit_events.create({ data: { correlation_id: opPins.operationId, actor_operator_id: opPins.operatorId,
    action: "local.provider_continuous.cycle", target_type: "provider_run", target_id: opPins.initialRunId,
    outcome: "success", details: cycle, occurred_at: f.now } });
  const prior = f.parent, failed = { ...structuredClone(prior), id: cycle.runId, reached_source_head: false, state: "failed",
    page_count: 0, catalog_record_count: 0, pull_record_count: 0, market_event_record_count: 0, accepted_count: 0,
    duplicate_count: 0, quarantined_count: 0, material_change_count: 0, row_version: 3n, worker_fence: 484n,
    control_command_id: cycle.commandId, requested_by_operator_id: opPins.operatorId, started_at: f.now,
    requested_at: new Date(f.now.getTime() - 1), finished_at: f.now,
    failure_code: "DATABASE_TRANSACTION_INVALID" };
  f.runs.set(failed.id, failed);
  f.commands.push({ id: cycle.commandId, command_type: "run", state: "completed", expected_generation: 33n,
    requested_by_operator_id: opPins.operatorId, idempotency_key: `continuous/${opPins.operationId}/${prior.id}/run`,
    correlation_id: opPins.operationId, resulting_run_id: failed.id, completed_at: f.now,
    result: { outcome: "accepted", code: "RUN_STARTED", generation: "34" } });
  Object.assign(f.runtime, { operating_state: "error", state_generation: 35n, row_version: 133n });
  Object.assign(f.lease, { lease_fence: 484n });
  const matching = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object") {
      if ("in" in value) return value.in.includes(row[key]);
      if ("not" in value) return row[key] !== value.not;
    }
    return row[key] === value;
  });
  db.control_commands.findFirst = async ({ where }) => f.commands.find(row => matching(row, where)) ?? null;
  db.provider_runs.findMany = async ({ where = {} }) => [...f.runs.values()].filter(row => matching(row, where));
  db.provider_runs.create = async ({ data }) => {
    f.writes.push("run"); const row = { ...structuredClone(data), recovery_of_run_id: null, started_at: null, finished_at: null,
      failure_code: null, final_cursor: null, final_cursor_hash: null, reached_source_head: false, page_count: 0,
      accepted_count: 0, duplicate_count: 0, quarantined_count: 0, material_change_count: 0, catalog_record_count: 0,
      pull_record_count: 0, market_event_record_count: 0, row_version: 1n };
    f.runs.set(row.id, row); return row;
  };
  db.provider_run_pages.findMany = async ({ where = {} }) => [f.last].filter(row => matching(row, where));
  db.provider_run_pages.count = async ({ where }) => [f.last].filter(row => matching(row, where)).length;
  const query = db.$queryRaw;
  db.$queryRaw = async sql => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
    if (text.includes("where state in ('queued', 'running')")) return [...f.runs.values()].filter(row => ["queued", "running"].includes(row.state));
    return query(sql);
  };
  const transaction = db.$transaction;
  db.$transaction = async (fn, options) => {
    const runs = structuredClone([...f.runs.entries()]);
    try { return await transaction(fn, options); } catch (error) { f.runs.clear(); for (const [id, row] of runs) f.runs.set(id, row); throw error; }
  };
  const evidence = row => ({ sequence: row.sequence.toString(), digest: digest(row) });
  const adoption = f.audits.find(row => row.action === "provider.paused_head.adoption");
  const adopted = f.audits.find(row => row.action === "provider.paused_head.adoption.completed");
  const resume = f.commands.find(row => row.command_type === "resume");
  const review = failedHeadReviewSchema.parse({ version: 1, authorization: "operator_requested_zero_commit_head_continuation",
    pins: { ...opPins, operationId: "9a333333-3333-4333-8333-333333333335", initialRunId: failed.id },
    sourceCommit: f.review.sourceCommit, central: f.review.central, provider: f.review.provider,
    migrationProofPath: f.review.migrationProofPath, migrationProofDigest: f.review.migrationProofDigest,
    authorityDigest: f.authority.digest, priorOperationId: opPins.operationId, priorHeadRunId: prior.id,
    priorHeadRunDigest: digest(prior), priorHeadProofDigest: digest(await readProviderRunHeadProof(db, prior.id)),
    provenance: { adoption: evidence(adoption), adoptionCompleted: evidence(adopted), operation: evidence(operation),
      cycle: evidence(cycleRow), adoptionResume: { id: resume.id, digest: digest(resume) } }, configNumber: "4", generation: "35", runtimeRowVersion: "133",
    importFence: "484", checkpointHash: f.hash, parentDigest: digest(failed), parentCommandDigest: digest(f.commands.find(row => row.id === cycle.commandId)), failureCode: failed.failure_code,
    finishedAt: failed.finished_at.toISOString() });
  f.writes.length = 0;
  assert.equal(f.lease.lease_owner, null);
  return { ...f, pins: review.pins, review, parent: failed, prior, adoption, adopted, operation, cycleRow,
    control: createFailedHeadContinuation(review), ids: failedHeadIds(review) };
}
