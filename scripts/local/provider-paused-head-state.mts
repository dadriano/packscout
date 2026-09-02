import { isDeepStrictEqual } from "node:util";
import { providerMixedPageDigest, readProviderRunHeadProof, type ProviderQueryClient } from "@packscout/database";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { assertBackfillPins, backfillPinsSchema } from "./provider-backfill-supervisor-policy.mts";
import { readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import { pausedHeadDigest as digest, pausedHeadIds, refusePausedHead as refuse,
  type PausedHeadReview, type PausedHeadReceipt } from "./provider-paused-head-policy.mts";

export function assertPausedHeadAuthority(review: Pick<PausedHeadReview, "pins" | "authorityDigest" | "configNumber" | "provider">, authority: BackfillAuthority) {
  const r = authority.route, p = review.pins;
  if (authority.digest !== review.authorityDigest || r.organizationId !== p.organizationId || r.configVersionId !== p.configId ||
    r.target.providerId !== p.providerId || r.target.providerKey !== p.providerKey ||
    authority.configNumber.toString() !== review.configNumber || authority.integration.providerKey !== p.providerKey ||
    r.node.host !== review.provider.host || r.node.port !== review.provider.port || r.node.sslMode !== review.provider.sslMode ||
    r.target.databaseName !== review.provider.databaseName) refuse("PAUSED_HEAD_AUTHORITY_DRIFT");
}
export async function readPausedHeadSnapshot(db: ProviderQueryClient, review: PausedHeadReview, authority: BackfillAuthority) {
  const id = review.pins.initialRunId;
  const [snapshot, runtime, parent, latest, head, pause, previous, runs, pages, ledger, quarantines, otherLeases, [activity]] = await Promise.all([
    readBackfillSnapshot(db, review.pins, authority, id), db.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    db.provider_runs.findUniqueOrThrow({ where: { id } }),
    db.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }], select: { id: true } }),
    readProviderRunHeadProof(db, id), db.control_commands.findUnique({ where: { id: review.pauseCommandId } }),
    db.local_audit_events.findMany({ where: { correlation_id: review.previousOperationId }, orderBy: { sequence: "asc" }, take: 1025 }),
    db.provider_runs.findMany({ orderBy: { id: "asc" }, take: 1025 }),
    db.provider_run_pages.findMany({ orderBy: [{ provider_run_id: "asc" }, { page_number: "asc" }], take: 50_001,
      select: { id: true, provider_run_id: true, page_number: true, requested_cursor_hash: true, next_cursor_hash: true,
        continuation: true, response_digest: true, record_count: true, accepted_count: true, duplicate_count: true,
        quarantined_count: true, material_change_count: true, committed_at: true } }),
    db.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }), db.quarantine_records.count(),
    db.provider_worker_states.count({ where: { worker_role: { not: "import" }, OR: [
      { lease_owner: { not: null } }, { lease_expires_at: { not: null } }] } }),
    db.$queryRaw<Array<{ active: number }>>`select count(*)::integer as active from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid() and (state='active' or xact_start is not null)`,
  ]);
  if (runs.length > 1024 || previous.length > 1024 || pages.length > 50_000 || !activity) refuse("PAUSED_HEAD_HISTORY_BOUND");
  return { snapshot, runtime, parent, latest, head, pause, previous, runs, pages, ledger, quarantines, otherLeases, externalActive: activity.active };
}
export type PausedHeadSnapshot = Awaited<ReturnType<typeof readPausedHeadSnapshot>>;
export function pausedHeadHistory(s: PausedHeadSnapshot) {
  const { operating_state: _state, state_reason: _reason, state_generation: _generation,
    row_version: _version, updated_at: _updated, ...preservedRuntime } = s.runtime;
  return digest({ parent: s.parent, runs: s.runs, pages: s.pages, previous: s.previous, head: s.head,
    ledger: s.ledger, quarantines: s.quarantines, preservedRuntime });
}
export function assertPausedHeadBoundary(s: PausedHeadSnapshot, review: PausedHeadReview, authority: BackfillAuthority,
  options: { resumed?: boolean; receipt?: PausedHeadReceipt; held?: { owner: string; fence: bigint }; releasedFence?: bigint } = {}) {
  assertPausedHeadAuthority(review, authority); assertBackfillPins(s.snapshot, review.pins, authority.configNumber);
  const p = review.pins, v = s.snapshot, h = s.head, pause = s.pause, resumed = options.resumed ?? false;
  const previous = s.previous.filter(row => row.action === "local.provider_continuous.operation");
  const oldDetails = previous[0]?.details as { pins?: unknown; authorityDigest?: unknown } | undefined;
  const oldPins = backfillPinsSchema.safeParse(oldDetails?.pins);
  const pauseResult = pause?.result as { outcome?: unknown; generation?: unknown } | null;
  if (previous.length !== 1 || !oldPins.success || oldPins.data.operationId !== review.previousOperationId ||
    oldPins.data.providerId !== p.providerId || oldPins.data.providerKey !== p.providerKey || oldPins.data.configId !== p.configId ||
    oldPins.data.organizationId !== p.organizationId || oldPins.data.operatorId !== p.operatorId ||
    previous[0]!.target_id !== oldPins.data.initialRunId || previous[0]!.actor_operator_id !== p.operatorId ||
    previous[0]!.outcome !== "success" || digest(previous[0]) !== review.previousOperationReceiptDigest ||
    typeof oldDetails?.authorityDigest !== "string" || !/^[a-f0-9]{64}$/u.test(oldDetails.authorityDigest)) refuse("PAUSED_HEAD_PREVIOUS_OPERATION_DRIFT");
  if (!pause || pause.command_type !== "pause" || pause.state !== "completed" || !pause.completed_at ||
    pause.requested_by_operator_id !== p.operatorId || pause.expected_generation + 1n !== BigInt(review.generation) ||
    pauseResult?.outcome !== "accepted" || pauseResult.generation !== review.generation ||
    digest(pause) !== review.pauseCommandDigest) refuse("PAUSED_HEAD_PAUSE_PROVENANCE_DRIFT");
  if (s.latest?.id !== p.initialRunId || s.parent.id !== p.initialRunId || s.parent.state !== "succeeded" ||
    !s.parent.reached_source_head || s.parent.failure_code !== null || !s.parent.finished_at ||
    digest(s.parent) !== review.parentDigest || !h || !h.reconciliationComplete || h.runId !== p.initialRunId ||
    h.configVersionId !== p.configId || h.configVersionNumber !== authority.configNumber ||
    h.checkpointHash !== review.checkpointHash || digest(h) !== review.headProofDigest ||
    s.parent.final_cursor_hash !== review.checkpointHash || providerMixedPageDigest(s.parent.final_cursor) !== review.checkpointHash ||
    !isDeepStrictEqual(s.runtime.source_cursor, s.parent.final_cursor)) refuse("PAUSED_HEAD_PARENT_DRIFT");
  const baseFence = options.releasedFence ?? BigInt(review.importFence), held = options.held;
  const expiredOwn = options.receipt && v.lease.owner === pausedHeadIds(review).owner && v.lease.expiresAt !== null &&
    v.lease.expiresAt <= v.now && v.lease.fence === baseFence;
  const leaseValid = held ? v.lease.owner === held.owner && v.lease.fence === held.fence &&
    v.lease.expiresAt !== null && v.lease.expiresAt > v.now :
    v.lease.owner === null && v.lease.expiresAt === null && v.lease.fence === baseFence || !held && expiredOwn;
  if (!leaseValid || v.state !== (resumed ? "idle" : "paused") || v.generation !== BigInt(review.generation) + (resumed ? 1n : 0n) ||
    s.runtime.row_version !== BigInt(review.runtimeRowVersion) + (resumed ? 1n : 0n) ||
    v.checkpointHash !== review.checkpointHash || v.activeRunIds.length || v.actionableCommands.length ||
    s.otherLeases || s.externalActive || (options.receipt && pausedHeadHistory(s) !== options.receipt.historyDigest)) {
    refuse("PAUSED_HEAD_RUNTIME_OR_HISTORY_DRIFT");
  }
}
