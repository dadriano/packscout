import { z } from "zod";
import { opaqueCursorEnvelopeSchema, dataforrestCollectorCryptDistributedSourceAdapterManifest as manifest } from "@packscout/contracts";
import { providerMixedCursorFingerprint, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { backfillDigest, backfillId } from "./provider-backfill-supervisor-policy.mts";
import { readCollectorHandoffCheckpoint, retainedCollectorCheckpoint } from "./collector-crypt-checkpoint-handoff-state.mts";

/** One reviewed terminal attempt, not a generic retry policy or a cursor reset. */
export const collectorRepair = Object.freeze({
  organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a", providerId: "c9f60d4e-e4c1-58c2-a24c-e545cab7a0e5",
  providerKey: "collector_crypt" as const, configId: "0d53bce0-fe5d-54bf-bd07-f47142690a8f",
  parentRunId: "4ac94632-3551-5b5a-a7d5-f2ab359bc681", operationId: "933729d5-79b3-4069-b9cb-2bc56568b97c",
  failureCode: "PROVIDER_IMPORT_EXECUTION_FAILED", finishedAt: "2026-08-30T12:23:20.073Z",
  cursorHash: "55c7e8ba0316f477cd64a0fb4b0777bc8d0cb27358ec9ccc884102a6f6cb64d2",
  action: "provider.local_collector_reconciliation_repair_retry",
  owner: "local:collector:reconciliation-repair:933729d5-79b3-4069-b9cb-2bc56568b97c",
});
export const collectorRepairId = (label: string) => backfillId(collectorRepair.operationId, `reconciliation-repair/${label}`);
export class CollectorRepairRetryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CollectorRepairRetryError"; }
}
export function refuseCollectorRepair(code: string): never { throw new CollectorRepairRetryError(code); }
export async function readCollectorRepairCheckpoint(database: ProviderPrismaClient | ProviderTransactionClient) {
  const p = collectorRepair;
  const [snapshot, runs, pages, quarantineCount, requested] = await Promise.all([
    readCollectorHandoffCheckpoint(database, { oldProcessAlive: false, runId: p.parentRunId }),
    database.provider_runs.findMany({ orderBy: { id: "asc" }, take: 1025, select: { id: true, state: true,
      config_version_id: true, config_version_number: true, worker_fence: true, page_count: true, accepted_count: true,
      duplicate_count: true, quarantined_count: true, material_change_count: true, requested_cursor_hash: true,
      final_cursor_hash: true, failure_code: true, reached_source_head: true, requested_at: true, started_at: true,
      finished_at: true, recovery_of_run_id: true } }),
    database.provider_run_pages.findMany({ where: { provider_run_id: p.parentRunId }, orderBy: { page_number: "asc" },
      take: 388, select: { id: true, page_number: true, requested_cursor_hash: true, next_cursor_hash: true,
        continuation: true, response_digest: true, record_count: true, accepted_count: true, duplicate_count: true,
        quarantined_count: true, material_change_count: true, committed_at: true } }),
    database.quarantine_records.count(),
    database.provider_runs.findUniqueOrThrow({ where: { id: p.parentRunId }, select: { requested_cursor: true, requested_cursor_hash: true } }),
  ]);
  if (runs.length > 1024 || runs.length !== snapshot.runCount) refuseCollectorRepair("COLLECTOR_REPAIR_HISTORY_BOUND_EXCEEDED");
  return { ...snapshot, runHistoryHash: backfillDigest(runs), pages, quarantineCount,
    requestedCursor: requested.requested_cursor, requestedCursorHash: requested.requested_cursor_hash };
}
export type CollectorRepairCheckpoint = Awaited<ReturnType<typeof readCollectorRepairCheckpoint>>;
export function retainedCollectorRepair(s: CollectorRepairCheckpoint) {
  return { ...retainedCollectorCheckpoint(s), generation: "24", runCount: s.runCount, runHistoryHash: s.runHistoryHash,
    pageHistoryHash: backfillDigest(s.pages), quarantineCount: s.quarantineCount, requestedCursorHash: s.requestedCursorHash };
}
export function assertCollectorRepairCheckpoint(input: Readonly<{ snapshot: CollectorRepairCheckpoint;
  resumed?: boolean; receiptExists?: boolean; utilityLease?: { owner: string; fence: string } }>) {
  const s = input.snapshot, p = collectorRepair;
  const cursorValid = (value: unknown, hash: string | null) => {
    const parsed = opaqueCursorEnvelopeSchema.safeParse(value);
    return parsed.success && parsed.data.value !== null && parsed.data.sourceInstanceId === p.providerId &&
      parsed.data.sourceRevisionId === p.configId && parsed.data.sourceTypeKey === manifest.sourceTypeKey &&
      parsed.data.adapterVersion === manifest.adapterVersion && parsed.data.cursorCodecKey === manifest.cursorCodecKey &&
      parsed.data.cursorGeneration === 1 && providerMixedCursorFingerprint(parsed.data) === hash;
  };
  const unowned = s.lease.owner === null && s.lease.expiresAt === null;
  const expiredOwn = input.receiptExists && s.lease.owner === p.owner && s.lease.expiresAt !== null &&
    Date.parse(s.lease.expiresAt) <= Date.parse(s.databaseNow) && BigInt(s.lease.fence) > 9n;
  const allowedLease = input.utilityLease ? s.lease.owner === input.utilityLease.owner &&
    s.lease.fence === input.utilityLease.fence && s.lease.expiresAt !== null &&
    Date.parse(s.lease.expiresAt) > Date.parse(s.databaseNow) : unowned || expiredOwn;
  const pagesValid = s.pages.length === 387 && s.pages.every((page, index) => page.page_number === index + 1 &&
    page.continuation === "more" && page.record_count === 1000 && page.accepted_count === 1000 &&
    page.duplicate_count === 0 && page.quarantined_count === 0 && page.next_cursor_hash !== null &&
    page.requested_cursor_hash === (index ? s.pages[index - 1]!.next_cursor_hash : s.requestedCursorHash)) &&
    s.pages[386]?.next_cursor_hash === p.cursorHash;
  if (s.providerId !== p.providerId || s.providerKey !== p.providerKey || s.databaseRole !== "provider" ||
    s.schemaVersion !== "distributed-provider-v1" || s.runtimeState !== (input.resumed ? "idle" : "error") ||
    s.generation !== (input.resumed ? "25" : "24") || s.cachedConfigId !== p.configId || s.cachedConfigNumber !== "3" ||
    s.quarantineCount !== 0 || s.activeRunCount !== 0 || s.actionableCommandCount !== 0 || s.oldProcessAlive ||
    s.otherActiveTransactionCount !== 0 || s.otherOwnedWorkerLeaseCount !== 0 || !allowedLease ||
    (!input.receiptExists && s.lease.fence !== "9") || s.cursorHash !== p.cursorHash || !cursorValid(s.cursor, s.cursorHash) ||
    !cursorValid(s.requestedCursor, s.requestedCursorHash) || s.requestedCursorHash === p.cursorHash ||
    s.run.id !== p.parentRunId || s.run.configId !== p.configId || s.run.configNumber !== "3" || s.run.fence !== "9" ||
    s.run.state !== "failed" || s.run.failureCode !== p.failureCode || s.run.finishedAt !== p.finishedAt || s.run.reachedHead ||
    s.run.pageCount !== 387 || s.run.accepted !== 387000 || s.run.duplicates !== 0 || s.run.quarantines !== 0 ||
    s.run.finalCursorHash !== p.cursorHash || backfillDigest(s.run.finalCursor) !== backfillDigest(s.cursor) ||
    s.lastPage?.number !== 387 || s.lastPage.continuation !== "more" || s.lastPage.cursorHash !== p.cursorHash ||
    backfillDigest(s.lastPage.cursor) !== backfillDigest(s.cursor) || !pagesValid) refuseCollectorRepair("COLLECTOR_REPAIR_CHECKPOINT_CHANGED");
}
export const collectorRepairReceiptSchema = z.object({
  kind: z.literal("operator_reviewed_collector_reconciliation_repair"), operationId: z.literal(collectorRepair.operationId),
  providerId: z.literal(collectorRepair.providerId), operatorId: z.string().uuid(), configId: z.literal(collectorRepair.configId),
  parentRunId: z.literal(collectorRepair.parentRunId), runId: z.string().uuid(),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  entryRowVersion: z.string().regex(/^[1-9][0-9]*$/u), checkpointHash: z.literal(collectorRepair.cursorHash),
  failureCode: z.literal(collectorRepair.failureCode), failureAt: z.literal(collectorRepair.finishedAt),
  repair: z.literal("catalog_driven_reference_reconciliation_and_safe_execution_diagnostics"),
  originalExceptionKnown: z.literal(false), automaticFailureClassification: z.literal("nontransient"),
  sourceCheckPerformedByUtility: z.literal(false),
}).strict();
export type CollectorRepairReceipt = z.infer<typeof collectorRepairReceiptSchema>;
export function makeCollectorRepairReceipt(authority: { digest: string; operatorId: string }, snapshot: CollectorRepairCheckpoint) {
  assertCollectorRepairCheckpoint({ snapshot });
  return collectorRepairReceiptSchema.parse({ kind: "operator_reviewed_collector_reconciliation_repair",
    operationId: collectorRepair.operationId, providerId: collectorRepair.providerId, operatorId: authority.operatorId,
    configId: collectorRepair.configId, parentRunId: collectorRepair.parentRunId, runId: collectorRepairId("run"),
    authorityDigest: authority.digest, checkpointDigest: backfillDigest(retainedCollectorRepair(snapshot)),
    entryRowVersion: snapshot.runtimeRowVersion, checkpointHash: collectorRepair.cursorHash,
    failureCode: collectorRepair.failureCode, failureAt: collectorRepair.finishedAt,
    repair: "catalog_driven_reference_reconciliation_and_safe_execution_diagnostics", originalExceptionKnown: false,
    automaticFailureClassification: "nontransient", sourceCheckPerformedByUtility: false });
}
