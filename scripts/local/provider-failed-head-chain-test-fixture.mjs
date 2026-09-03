import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
import { failedHeadFixture } from "./provider-failed-head-test-fixture.mjs";
const { failedHeadReviewSchema, failedHeadDigest: digest, failedHeadIds, failedHeadAction: action } =
  await tsImport("./provider-failed-head-policy.mts", import.meta.url);
const { createFailedHeadContinuation } = await tsImport("./provider-failed-head-control.mts", import.meta.url);
const { PrismaProviderRunRepository, PrismaProviderWorkerLeaseRepository } = await tsImport("@packscout/database", import.meta.url);
export async function failedHeadChainFixture() {
  const f = await failedHeadFixture(), root = f.parent;
  root.requested_at = new Date(f.now.getTime() - 3); root.started_at = root.requested_at;
  root.finished_at = new Date(f.now.getTime() - 2);
  f.review.parentDigest = digest(root); f.review.finishedAt = root.finished_at.toISOString();
  const previousReview = structuredClone(f.review), previousIds = f.ids;
  // Exercise the production queued-start and terminal lifecycle; do not invent terminal rows without their audits.
  f.database.provider_runs.findUnique = async ({ where }) => [...f.runs.values()].find(row =>
    Object.entries(where).every(([key, value]) => row[key] === value)) ?? null;
  f.database.provider_runs.update = async ({ where, data }) => {
    const row = f.runs.get(where.id), { row_version, ...rest } = data;
    Object.assign(row, structuredClone(rest)); if (row_version) row.row_version += row_version.increment;
    f.writes.push("run-update"); return row;
  };
  const originalQuery = f.database.$queryRaw;
  f.database.$queryRaw = async (sql, ...values) => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
    if (text.includes("set_config('packscout.import_lease_owner'")) return [];
    // Real database reads are snapshots, not references mutated by a subsequent update.
    if (text.includes("from provider_runtime")) return [structuredClone(f.runtime)];
    if (text.includes("from provider_runs where id")) return [structuredClone(f.runs.get(Array.isArray(sql) ? values[0] : sql.values[0]))].filter(Boolean);
    return originalQuery(sql);
  };
  const prior = await f.control.inspect(f.database, f.authority);
  await f.control.apply(f.database, prior.receipt, async () => f.authority, async () => {});
  const leaf = f.runs.get(previousIds.run), command = f.commands.find(row => row.id === previousIds.command);
  Object.assign(f.runtime, { consecutive_failures: 1, recovered_at: null });
  const workerId = "synthetic:chain-worker", leases = new PrismaProviderWorkerLeaseRepository(f.database);
  const acquired = await leases.acquire({ role: "import", owner: workerId, leaseMilliseconds: 120_000 });
  assert.equal(acquired.kind, "acquired"); assert.equal(acquired.lease.fence, 486n);
  const runs = new PrismaProviderRunRepository(f.database);
  assert.equal((await runs.start({ runId: leaf.id, idempotencyKey: leaf.idempotency_key,
    trigger: "manual", requestedByOperatorId: previousReview.pins.operatorId,
    configVersionId: previousReview.pins.configId, configVersionNumber: 4n,
    workerId, workerFence: acquired.lease.fence, correlationId: previousReview.pins.operationId,
    requestedAt: leaf.requested_at, controlCommandId: command.id })).kind, "started");
  assert.equal((await runs.finish({ runId: leaf.id, workerId, workerFence: acquired.lease.fence, state: "failed",
    failureCode: "DATABASE_TRANSACTION_INVALID", failureClass: "database", failureSummary: "Synthetic transaction failure",
    correlationId: "ba333333-3333-4333-8333-333333333335", finishedAt: f.now })).kind, "finished");
  assert.equal(await leases.release({ role: "import", owner: workerId, fence: acquired.lease.fence }), true);
  assert.equal(f.runtime.operating_state, "error"); assert.equal(f.runtime.state_generation, 38n);
  assert.equal(f.runtime.row_version, 136n);
  const edge = name => f.audits.find(row => row.correlation_id === previousReview.pins.operationId && row.action === name);
  const evidence = row => ({ sequence: row.sequence.toString(), digest: digest(row) });
  const resume = f.commands.find(row => row.id === previousIds.resume);
  const chainRows = { receipt: edge(action), completed: edge(`${action}.completed`), leaseClaim: edge(`${action}.lease_claimed`),
    resumeGuard: edge("provider.runtime.resume_guard"), requested: edge("provider.run.requested") };
  const review = failedHeadReviewSchema.parse({ ...previousReview, version: 2,
    authorization: "operator_requested_two_failure_head_continuation",
    pins: { ...previousReview.pins, initialRunId: leaf.id, operationId: "aa333333-3333-4333-8333-333333333335" },
    sourceCommit: "b".repeat(40), generation: "38", runtimeRowVersion: "136", importFence: "486",
    parentDigest: digest(leaf), parentCommandDigest: digest(command), failureCode: leaf.failure_code,
    finishedAt: leaf.finished_at.toISOString(), previousReview,
    chain: { ...Object.fromEntries(Object.entries(chainRows).map(([key, row]) => [key, evidence(row)])),
      resume: { id: resume.id, digest: digest(resume) } } });
  const observedNow = new Date(f.now.getTime() + 1), query = f.database.$queryRaw;
  f.database.$queryRaw = async sql => {
    const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
    return text.includes("select clock_timestamp() as now") ? [{ now: observedNow }] : query(sql);
  };
  f.writes.length = 0;
  return { ...f, now: observedNow, root, parent: leaf, command, resume, previousReview, previousIds, chainRows, review,
    pins: review.pins, ids: failedHeadIds(review), control: createFailedHeadContinuation(review) };
}
