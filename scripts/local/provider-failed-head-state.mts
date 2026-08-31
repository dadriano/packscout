import { isDeepStrictEqual } from "node:util";
import { providerMixedPageDigest, readProviderRunHeadProof, type ProviderQueryClient } from "@packscout/database";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { assertBackfillPins, backfillPinsSchema } from "./provider-backfill-supervisor-policy.mts";
import { readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import { assertContinuousCycle, continuousCycleSchema } from "./provider-continuous-policy.mts";
import { pausedHeadIds, pausedHeadReceiptSchema } from "./provider-paused-head-policy.mts";
import { assertPausedHeadAuthority } from "./provider-paused-head-state.mts";
import { failedHeadAuditPins, failedHeadDigest as digest, failedHeadIds, refuseFailedHead as refuse,
  type FailedHeadReview, type FailedHeadReceipt } from "./provider-failed-head-policy.mts";
export const failedHeadZeroCounters = ["page_count", "catalog_record_count", "pull_record_count", "market_event_record_count",
  "accepted_count", "duplicate_count", "quarantined_count", "material_change_count"] as const;
export const assertFailedHeadAuthority = assertPausedHeadAuthority;
export async function readFailedHeadSnapshot(db: ProviderQueryClient, review: FailedHeadReview, authority: BackfillAuthority) {
  const id = review.pins.initialRunId, ids = failedHeadIds(review);
  const [snapshot, runtime, parent, prior, latest, head, provenance, adoptionResume, runs, pages,
    ledger, quarantines, otherLeases, [activity]] = await Promise.all([
    readBackfillSnapshot(db, review.pins, authority, id), db.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    db.provider_runs.findUniqueOrThrow({ where: { id } }), db.provider_runs.findUniqueOrThrow({ where: { id: review.priorHeadRunId } }),
    db.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }], select: { id: true } }),
    readProviderRunHeadProof(db, review.priorHeadRunId),
    db.local_audit_events.findMany({ where: { correlation_id: review.priorOperationId }, orderBy: { sequence: "asc" }, take: 1025 }),
    db.control_commands.findUnique({ where: { id: review.provenance.adoptionResume.id } }),
    db.provider_runs.findMany({ where: { id: { not: ids.run } }, orderBy: { id: "asc" }, take: 1025 }),
    db.provider_run_pages.findMany({ where: { provider_run_id: { not: ids.run } },
      orderBy: [{ provider_run_id: "asc" }, { page_number: "asc" }], take: 50_001,
      select: { id: true, provider_run_id: true, page_number: true, requested_cursor_hash: true, next_cursor_hash: true,
        continuation: true, response_digest: true, record_count: true, accepted_count: true, duplicate_count: true,
        quarantined_count: true, material_change_count: true, committed_at: true } }),
    db.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }), db.quarantine_records.count(),
    db.provider_worker_states.count({ where: { worker_role: { not: "import" }, OR: [
      { lease_owner: { not: null } }, { lease_expires_at: { not: null } }] } }),
    db.$queryRaw<Array<{ active: number }>>`select count(*)::integer as active from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid() and (state='active' or xact_start is not null)`,
  ]);
  const parentCommand = parent.control_command_id ? await db.control_commands.findUnique({ where: { id: parent.control_command_id } }) : null;
  if (runs.length > 1024 || provenance.length > 1024 || pages.length > 50_000 || !activity) refuse("FAILED_HEAD_HISTORY_BOUND");
  return { snapshot, runtime, parent, prior, latest, head, provenance, adoptionResume, parentCommand,
    runs, pages, ledger, quarantines, otherLeases, externalActive: activity.active };
}
export type FailedHeadSnapshot = Awaited<ReturnType<typeof readFailedHeadSnapshot>>;
export function failedHeadHistory(s: FailedHeadSnapshot) {
  const { operating_state: _state, state_reason: _reason, state_generation: _generation,
    row_version: _version, updated_at: _updated, ...preservedRuntime } = s.runtime;
  return digest({ runs: s.runs, pages: s.pages, provenance: s.provenance, adoptionResume: s.adoptionResume,
    parentCommand: s.parentCommand, head: s.head, ledger: s.ledger, quarantines: s.quarantines, preservedRuntime });
}
function assertProvenance(s: FailedHeadSnapshot, r: FailedHeadReview) {
  const pins = r.pins, rows = failedHeadAuditPins(r);
  for (const expected of rows) {
    const row = s.provenance.find(item => item.sequence.toString() === expected.sequence);
    if (!row || row.action !== expected.action || digest(row) !== expected.digest || row.outcome !== "success" ||
      row.actor_operator_id !== pins.operatorId || row.correlation_id !== r.priorOperationId ||
      row.target_type !== "provider_run" || row.target_id !== r.priorHeadRunId) refuse("FAILED_HEAD_PROVENANCE_DRIFT");
  }
  const adoption = pausedHeadReceiptSchema.safeParse(s.provenance.find(row => row.sequence.toString() === r.provenance.adoption.sequence)!.details);
  const op = s.provenance.find(row => row.sequence.toString() === r.provenance.operation.sequence)!.details as { pins?: unknown; authorityDigest?: string };
  const previousPins = backfillPinsSchema.safeParse(op.pins);
  const cycle = continuousCycleSchema.safeParse(s.provenance.find(row => row.sequence.toString() === r.provenance.cycle.sequence)!.details);
  if (!adoption.success || !previousPins.success || !cycle.success) refuse("FAILED_HEAD_PROVENANCE_DRIFT");
  const old = adoption.data.review, expectedPins = { ...pins, operationId: r.priorOperationId, initialRunId: r.priorHeadRunId };
  assertContinuousCycle(cycle.data, expectedPins, r.authorityDigest);
  const completed = s.provenance.find(row => row.sequence.toString() === r.provenance.adoptionCompleted.sequence)!;
  const resume = s.adoptionResume, command = s.parentCommand, c = cycle.data;
  const commandResult = command?.result as { outcome?: unknown; code?: unknown; generation?: unknown } | null;
  if (digest(old.pins) !== digest(expectedPins) || digest(previousPins.data) !== digest(expectedPins) ||
    old.authorityDigest !== r.authorityDigest || op.authorityDigest !== r.authorityDigest || old.configNumber !== r.configNumber ||
    old.checkpointHash !== r.checkpointHash || old.parentDigest !== r.priorHeadRunDigest || old.headProofDigest !== r.priorHeadProofDigest ||
    digest(completed.details) !== digest({ receiptDigest: digest(adoption.data), resumeCommandId: pausedHeadIds(old).resume }) ||
    !resume || resume.id !== pausedHeadIds(old).resume || resume.command_type !== "resume" || resume.state !== "completed" ||
    resume.correlation_id !== r.priorOperationId || resume.requested_by_operator_id !== pins.operatorId ||
    digest(resume) !== r.provenance.adoptionResume.digest || c.runId !== pins.initialRunId || c.parentRunId !== r.priorHeadRunId ||
    c.configNumber !== r.configNumber || c.checkpointHash !== r.checkpointHash || c.generation !== (BigInt(old.generation) + 1n).toString() ||
    !command || command.id !== c.commandId || command.command_type !== "run" || command.state !== "completed" || digest(command) !== r.parentCommandDigest ||
    command.expected_generation.toString() !== c.generation || !command.completed_at || commandResult?.outcome !== "accepted" ||
    commandResult.code !== "RUN_STARTED" || commandResult.generation !== (BigInt(c.generation) + 1n).toString() || command.requested_by_operator_id !== pins.operatorId ||
    command.correlation_id !== r.priorOperationId || command.idempotency_key !== `continuous/${r.priorOperationId}/${r.priorHeadRunId}/run` ||
    command.resulting_run_id !== pins.initialRunId || s.parent.control_command_id !== command.id || s.parent.trigger !== "manual" ||
    s.parent.requested_by_operator_id !== pins.operatorId || s.parent.recovery_of_run_id !== null) refuse("FAILED_HEAD_PROVENANCE_DRIFT");
}
export function assertFailedHeadBoundary(s: FailedHeadSnapshot, review: FailedHeadReview, authority: BackfillAuthority,
  options: { resumed?: boolean; queued?: boolean; receipt?: FailedHeadReceipt; held?: { owner: string; fence: bigint }; releasedFence?: bigint } = {}) {
  assertFailedHeadAuthority(review, authority); assertBackfillPins(s.snapshot, review.pins, authority.configNumber); assertProvenance(s, review);
  const p = s.parent, prior = s.prior, h = s.head, v = s.snapshot, resumed = options.resumed ?? false, queued = options.queued ?? false;
  if (p.id !== review.pins.initialRunId || p.state !== "failed" || p.reached_source_head || p.failure_code !== review.failureCode ||
    !p.finished_at || p.finished_at.toISOString() !== review.finishedAt || p.finished_at > v.now || digest(p) !== review.parentDigest ||
    failedHeadZeroCounters.some(column => p[column] !== 0) || s.pages.some(page => page.provider_run_id === p.id) ||
    p.config_version_id !== review.pins.configId || p.config_version_number !== BigInt(review.configNumber) ||
    p.requested_cursor_hash !== review.checkpointHash || p.final_cursor_hash !== review.checkpointHash ||
    !isDeepStrictEqual(p.requested_cursor, p.final_cursor) || !isDeepStrictEqual(s.runtime.source_cursor, p.final_cursor) ||
    providerMixedPageDigest(p.final_cursor) !== review.checkpointHash || prior.state !== "succeeded" || !prior.reached_source_head ||
    prior.failure_code !== null || !prior.finished_at || digest(prior) !== review.priorHeadRunDigest ||
    prior.config_version_id !== review.pins.configId || prior.config_version_number !== BigInt(review.configNumber) ||
    prior.final_cursor_hash !== review.checkpointHash || !isDeepStrictEqual(prior.final_cursor, p.final_cursor) ||
    !h || !h.reconciliationComplete || h.runId !== prior.id || h.configVersionId !== review.pins.configId ||
    h.configVersionNumber !== authority.configNumber || h.checkpointHash !== review.checkpointHash || digest(h) !== review.priorHeadProofDigest) {
    refuse("FAILED_HEAD_PARENT_OR_HEAD_DRIFT");
  }
  const baseFence = options.releasedFence ?? BigInt(review.importFence), held = options.held, childId = failedHeadIds(review).run;
  const expiredOwn = options.receipt && v.lease.owner === failedHeadIds(review).owner && v.lease.expiresAt !== null &&
    v.lease.expiresAt <= v.now && v.lease.fence === baseFence;
  const leaseValid = held ? v.lease.owner === held.owner && v.lease.fence === held.fence &&
    v.lease.expiresAt !== null && v.lease.expiresAt > v.now :
    v.lease.owner === null && v.lease.expiresAt === null && v.lease.fence === baseFence || !held && expiredOwn;
  if (!leaseValid || v.state !== (resumed ? "idle" : "error") ||
    v.generation !== BigInt(review.generation) + (resumed ? 1n : 0n) ||
    s.runtime.row_version !== BigInt(review.runtimeRowVersion) + (resumed ? 1n : 0n) ||
    v.checkpointHash !== review.checkpointHash || s.latest?.id !== (queued ? childId : p.id) ||
    digest(v.activeRunIds) !== digest(queued ? [childId] : []) ||
    digest(v.actionableCommands) !== digest(queued ? [{ id: failedHeadIds(review).command, runId: childId }] : []) ||
    s.otherLeases || s.externalActive || (options.receipt && failedHeadHistory(s) !== options.receipt.historyDigest)) {
    refuse("FAILED_HEAD_RUNTIME_OR_HISTORY_DRIFT");
  }
}
