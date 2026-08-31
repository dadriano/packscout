import { isDeepStrictEqual } from "node:util";
import { opaqueCursorEnvelopeSchema } from "@packscout/contracts";
import { providerMixedPageDigest, type ProviderQueryClient } from "@packscout/database";
import { assertBackfillPins } from "./provider-backfill-supervisor-policy.mts";
import { assertLocalBackfillDestination, type BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import { continuationDigest as digest, continuationIds, refuseContinuation as refuse,
  type ContinuationReview, type ContinuationReceipt } from "./provider-operator-continuation-policy.mts";

export function assertContinuationAuthority(review: ContinuationReview, authority: BackfillAuthority, expected?: string) {
  const { pins } = review, route = authority.route;
  assertLocalBackfillDestination(pins.providerKey, route);
  if (route.organizationId !== pins.organizationId || route.configVersionId !== pins.configId ||
    route.target.providerId !== pins.providerId || route.target.providerKey !== pins.providerKey ||
    authority.integration.providerKey !== pins.providerKey || authority.integration.manifest.adapterVersion !== authority.cachedConfiguration.adapterKey ||
    (expected !== undefined && authority.digest !== expected)) refuse("CONTINUATION_AUTHORITY_DRIFT");
}
export async function readContinuationSnapshot(database: ProviderQueryClient, review: ContinuationReview, authority: BackfillAuthority) {
  const parentId = review.pins.initialRunId, childId = continuationIds(review).run;
  const [snapshot, runtime, parent, last, pages, runs, ledger, quarantines, otherLeases, [clock]] = await Promise.all([
    readBackfillSnapshot(database, review.pins, authority, parentId),
    database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    database.provider_runs.findUniqueOrThrow({ where: { id: parentId } }),
    database.provider_run_pages.findUnique({ where: { provider_run_id_page_number: {
      provider_run_id: parentId, page_number: review.expectedPageCount } }, select: { next_cursor: true } }),
    database.provider_run_pages.findMany({ where: { provider_run_id: parentId }, orderBy: { page_number: "asc" },
      take: review.expectedPageCount + 1, select: { id: true, page_number: true, requested_cursor_hash: true,
        next_cursor_hash: true, continuation: true, response_digest: true, record_count: true,
        catalog_record_count: true, pull_record_count: true, market_event_record_count: true,
        accepted_count: true, duplicate_count: true, quarantined_count: true, material_change_count: true, committed_at: true } }),
    database.provider_runs.findMany({ where: { id: { not: childId } }, orderBy: { id: "asc" }, take: 1025 }),
    database.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }),
    database.quarantine_records.count(),
    database.provider_worker_states.count({ where: { worker_role: { not: "import" }, OR: [
      { lease_owner: { not: null } }, { lease_expires_at: { not: null } }] } }),
    database.$queryRaw<Array<{ active: number }>>`select count(*)::integer as active from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid() and (state='active' or xact_start is not null)`,
  ]);
  if (runs.length > 1024 || !clock) refuse("CONTINUATION_HISTORY_BOUND_EXCEEDED");
  return { snapshot, runtime, parent, lastCursor: last?.next_cursor, pages, runs, ledger, quarantines, otherLeases, externalActive: clock.active };
}
export type ContinuationSnapshot = Awaited<ReturnType<typeof readContinuationSnapshot>>;
export function continuationHistory(s: ContinuationSnapshot) {
  return digest({ parent: s.parent, pages: s.pages, runs: s.runs, quarantines: s.quarantines });
}
export function assertContinuationParent(s: ContinuationSnapshot, review: ContinuationReview, authority: BackfillAuthority) {
  const { parent, pages } = s, manifest = authority.integration.manifest;
  const cursor = opaqueCursorEnvelopeSchema.safeParse(parent.final_cursor);
  const validFinal = cursor.success && typeof cursor.data.value === "string" && cursor.data.value.length > 0
    && cursor.data.sourceInstanceId === review.pins.providerId && cursor.data.sourceRevisionId === review.pins.configId
    && cursor.data.sourceTypeKey === manifest.sourceTypeKey && cursor.data.adapterVersion === manifest.adapterVersion
    && cursor.data.cursorCodecKey === manifest.cursorCodecKey && cursor.data.cursorGeneration === 1
    && providerMixedPageDigest(parent.final_cursor) === review.expectedCheckpointHash;
  const columns = ["catalog_record_count", "pull_record_count", "market_event_record_count", "accepted_count",
    "duplicate_count", "quarantined_count", "material_change_count"] as const;
  const chain = pages.length === review.expectedPageCount && pages.every((page, i) => page.page_number === i + 1
    && page.continuation === "more" && page.requested_cursor_hash === (i ? pages[i - 1]!.next_cursor_hash : parent.requested_cursor_hash)
    && typeof page.next_cursor_hash === "string" && /^[a-f0-9]{64}$/u.test(page.next_cursor_hash)
    && page.record_count === page.accepted_count + page.duplicate_count + page.quarantined_count)
    && pages.at(-1)?.next_cursor_hash === review.expectedCheckpointHash;
  if (parent.id !== review.pins.initialRunId || parent.config_version_id !== review.pins.configId ||
    parent.config_version_number !== authority.configNumber || parent.state !== "failed" || parent.reached_source_head ||
    parent.failure_code !== review.expectedFailureCode || parent.finished_at?.toISOString() !== review.expectedFinishedAt ||
    parent.page_count !== review.expectedPageCount || parent.final_cursor_hash !== review.expectedCheckpointHash ||
    !validFinal || !isDeepStrictEqual(parent.final_cursor, s.lastCursor) || !chain ||
    (parent.requested_cursor === null ? parent.requested_cursor_hash !== null
      : providerMixedPageDigest(parent.requested_cursor) !== parent.requested_cursor_hash) ||
    parent.requested_cursor_hash === review.expectedCheckpointHash ||
    columns.some(column => pages.reduce((sum, page) => sum + page[column], 0) !== parent[column])) {
    refuse("CONTINUATION_PARENT_CHECKPOINT_DRIFT");
  }
}
export function assertContinuationBoundary(s: ContinuationSnapshot, review: ContinuationReview, authority: BackfillAuthority,
  options: { receipt?: ContinuationReceipt; resumed?: boolean; lease?: { owner: string; fence: bigint }; releasedFence?: bigint } = {}) {
  assertContinuationAuthority(review, authority, options.receipt?.authorityDigest);
  assertContinuationParent(s, review, authority);
  assertBackfillPins(s.snapshot, review.pins, authority.configNumber);
  const { snapshot: v } = s, lease = options.lease;
  const releasedFence = options.releasedFence ?? BigInt(review.expectedImportFence);
  // Only the reviewed operation's expired ownership can survive a process crash.
  // One extra fence covers acquisition followed by a crash before claim audit.
  const expiredOwn = options.receipt && v.lease.owner === continuationIds(review).owner && v.lease.expiresAt !== null
    && v.lease.expiresAt <= v.now && (v.lease.fence === releasedFence || v.lease.fence === releasedFence + 1n);
  const leaseValid = lease ? v.lease.owner === lease.owner && v.lease.fence === lease.fence && v.lease.expiresAt !== null
    && v.lease.expiresAt > v.now : v.lease.owner === null && v.lease.expiresAt === null
    && v.lease.fence === releasedFence || !lease && expiredOwn;
  if (!leaseValid || v.state !== (options.resumed ? "idle" : "error") ||
    v.generation !== BigInt(review.expectedGeneration) + (options.resumed ? 1n : 0n) ||
    v.activeRunIds.length || v.actionableCommands.length || s.otherLeases || s.externalActive ||
    v.checkpointHash !== review.expectedCheckpointHash || !isDeepStrictEqual(s.runtime.source_cursor, s.parent.final_cursor) ||
    (options.receipt && (continuationHistory(s) !== options.receipt.historyDigest ||
      s.runtime.row_version !== BigInt(options.receipt.entryRowVersion) + (options.resumed ? 1n : 0n) ||
      s.ledger.last_sequence.toString() !== options.receipt.ledgerSequence))) refuse("CONTINUATION_RUNTIME_OR_LEASE_DRIFT");
}
