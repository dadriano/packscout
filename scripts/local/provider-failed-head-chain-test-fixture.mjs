import { tsImport } from "tsx/esm/api";
import { failedHeadFixture } from "./provider-failed-head-test-fixture.mjs";
const { failedHeadReviewSchema, failedHeadDigest: digest, failedHeadIds, failedHeadAction: action } =
  await tsImport("./provider-failed-head-policy.mts", import.meta.url);
const { createFailedHeadContinuation } = await tsImport("./provider-failed-head-control.mts", import.meta.url);
export async function failedHeadChainFixture() {
  const f = await failedHeadFixture(), root = f.parent;
  root.requested_at = new Date(f.now.getTime() - 3); root.started_at = root.requested_at;
  root.finished_at = new Date(f.now.getTime() - 2);
  f.review.parentDigest = digest(root); f.review.finishedAt = root.finished_at.toISOString();
  const previousReview = structuredClone(f.review), previousIds = f.ids;
  const prior = await f.control.inspect(f.database, f.authority);
  await f.control.apply(f.database, prior.receipt, async () => f.authority, async () => {});
  const leaf = f.runs.get(previousIds.run), command = f.commands.find(row => row.id === previousIds.command);
  Object.assign(command, { state: "completed", completed_at: f.now, row_version: command.row_version + 1n,
    result: { outcome: "accepted", code: "RUN_STARTED", generation: "37" } });
  Object.assign(leaf, { state: "failed", started_at: f.now, finished_at: f.now, worker_fence: 486n,
    final_cursor: structuredClone(f.cursor), final_cursor_hash: f.hash, failure_code: "DATABASE_TRANSACTION_INVALID", row_version: 3n });
  Object.assign(f.runtime, { operating_state: "error", state_generation: 38n, row_version: 136n });
  Object.assign(f.lease, { lease_fence: 486n });
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
