import { z } from "zod";
import { opaqueCursorEnvelopeSchema, dataforrestCourtyardDistributedSourceAdapterManifest as manifest } from "@packscout/contracts";
import { providerMixedCursorFingerprint, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { handoffDigest } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { readCollectorHandoffCheckpoint, retainedCollectorCheckpoint } from "./collector-crypt-checkpoint-handoff-state.mts";
import { courtyardHandoffId } from "./courtyard-checkpoint-handoff-plan.mts";
import type { CourtyardAuthority } from "./courtyard-checkpoint-handoff-central.mts";

export const courtyardParserRetry = Object.freeze({ operationId: "0d6782e0-40b5-4755-8f2c-0611ce48c15c",
  handoffOperationId: "1dd59a1b-79c2-4b18-a881-edafe7b897dd", configId: "a1544542-735e-5df2-932e-0dde904da1f6",
  runId: "183ba6ef-125e-5dc0-b5d6-05aff4074f7f", failureCode: "PROVIDER_DATAFORREST_INVALID_RESPONSE",
  finishedAt: "2026-08-30T06:27:50.656Z", cursorHash: "d0946bb1bec84952f25f79785df0eeef27227a3aa304b6d75d15080c6ef044d1",
  action: "provider.local_courtyard_parser_repair_retry", owner: "local:courtyard:parser-repair:0d6782e0-40b5-4755-8f2c-0611ce48c15c" });
export const parserRetryId = (label: string) => courtyardHandoffId(courtyardParserRetry.operationId, `parser-repair/${label}`);
export class CourtyardParserRetryError extends Error {
  constructor(readonly code: "PARSER_RETRY_ARGUMENTS_INVALID" | "PARSER_RETRY_AUTHORITY_CHANGED" | "PARSER_RETRY_CHECKPOINT_CHANGED" |
    "PARSER_RETRY_RECEIPT_CHANGED" | "PARSER_RETRY_REVIEW_STALE" | "PARSER_RETRY_LEASE_UNAVAILABLE" | "PARSER_RETRY_RESUME_REFUSED" |
    "PARSER_RETRY_QUEUE_REFUSED" | "PARSER_RETRY_QUEUED_RUN_CHANGED" | "PARSER_RETRY_OPERATION_FAILED") { super(code); this.name = "CourtyardParserRetryError"; }
}
export function refuseParserRetry(code: CourtyardParserRetryError["code"]): never { throw new CourtyardParserRetryError(code); }
export function assertParserRetryAuthority(authority: CourtyardAuthority) {
  if (!authority.active || authority.nextConfigId !== courtyardParserRetry.configId || authority.next?.version_number !== 2n ||
    authority.next.adapter_key !== manifest.adapterVersion) refuseParserRetry("PARSER_RETRY_AUTHORITY_CHANGED");
}
export async function readParserRetryCheckpoint(database: ProviderPrismaClient | ProviderTransactionClient) {
  const [snapshot, runs, pages, quarantineCount, requested] = await Promise.all([
    readCollectorHandoffCheckpoint(database, { oldProcessAlive: false, runId: courtyardParserRetry.runId }),
    database.provider_runs.findMany({ orderBy: { id: "asc" }, select: { id: true, state: true, config_version_id: true,
      config_version_number: true, worker_fence: true, page_count: true, accepted_count: true, duplicate_count: true,
      quarantined_count: true, material_change_count: true, requested_cursor_hash: true, final_cursor_hash: true,
      failure_code: true, reached_source_head: true, requested_at: true, started_at: true, finished_at: true, recovery_of_run_id: true } }),
    database.provider_run_pages.findMany({ where: { provider_run_id: courtyardParserRetry.runId }, orderBy: { page_number: "asc" },
      select: { id: true, page_number: true, requested_cursor_hash: true, next_cursor_hash: true, continuation: true,
        response_digest: true, record_count: true, accepted_count: true, duplicate_count: true, quarantined_count: true,
        material_change_count: true, committed_at: true } }),
    database.quarantine_records.count(),
    database.provider_runs.findUniqueOrThrow({ where: { id: courtyardParserRetry.runId }, select: { requested_cursor: true, requested_cursor_hash: true } }),
  ]);
  return { ...snapshot, runHistoryHash: handoffDigest(runs), pages, quarantineCount, requestedCursor: requested.requested_cursor,
    requestedCursorHash: requested.requested_cursor_hash };
}
export type ParserRetryCheckpoint = Awaited<ReturnType<typeof readParserRetryCheckpoint>>;
export const parserRetryRetained = (s: ParserRetryCheckpoint) => ({ ...retainedCollectorCheckpoint(s), generation: "6",
  runHistoryHash: s.runHistoryHash, pageHistoryHash: handoffDigest(s.pages), runCount: s.runCount,
  quarantineCount: s.quarantineCount, requestedCursorHash: s.requestedCursorHash });

export function assertParserRetryCheckpoint(input: Readonly<{ snapshot: ParserRetryCheckpoint; providerId: string;
  resumed?: boolean; receiptExists?: boolean; utilityLease?: { owner: string; fence: string } }>) {
  const s = input.snapshot; const p = courtyardParserRetry;
  const validCursor = (value: unknown, hash: string | null) => {
    const parsed = opaqueCursorEnvelopeSchema.safeParse(value);
    return parsed.success && parsed.data.value !== null && parsed.data.sourceInstanceId === input.providerId &&
      parsed.data.sourceRevisionId === p.configId && parsed.data.sourceTypeKey === manifest.sourceTypeKey &&
      parsed.data.adapterVersion === manifest.adapterVersion && parsed.data.cursorCodecKey === manifest.cursorCodecKey &&
      parsed.data.cursorGeneration === 1 && providerMixedCursorFingerprint(parsed.data) === hash;
  };
  const unowned = s.lease.owner === null && s.lease.expiresAt === null;
  const expiredOwn = input.receiptExists && s.lease.owner === p.owner && s.lease.expiresAt !== null &&
    Date.parse(s.lease.expiresAt) <= Date.parse(s.databaseNow) && BigInt(s.lease.fence) > 76n;
  const allowedLease = input.utilityLease ? s.lease.owner === input.utilityLease.owner && s.lease.fence === input.utilityLease.fence &&
    s.lease.expiresAt !== null && Date.parse(s.lease.expiresAt) > Date.parse(s.databaseNow) : unowned || expiredOwn;
  const pagesValid = s.pages.length === 18 && s.pages.every((page, index) => page.page_number === index + 1 &&
    page.continuation === "more" && page.requested_cursor_hash === (index ? s.pages[index - 1]!.next_cursor_hash : s.requestedCursorHash) &&
    page.next_cursor_hash !== null) && s.pages[17]?.next_cursor_hash === p.cursorHash &&
    s.pages.reduce((sum, page) => sum + page.record_count, 0) === 1800 &&
    s.pages.reduce((sum, page) => sum + page.accepted_count, 0) === 1496 &&
    s.pages.reduce((sum, page) => sum + page.quarantined_count, 0) === 304 && s.pages.every((page) => page.duplicate_count === 0);
  if (s.providerId !== input.providerId || s.providerKey !== "courtyard" || s.databaseRole !== "provider" ||
    s.schemaVersion !== "distributed-provider-v1" || s.runtimeState !== (input.resumed ? "idle" : "error") || s.generation !== (input.resumed ? "7" : "6") ||
    s.cachedConfigId !== p.configId || s.cachedConfigNumber !== "2" || s.runCount !== 75 || s.quarantineCount !== 475 ||
    s.activeRunCount !== 0 || s.actionableCommandCount !== 0 || s.otherActiveTransactionCount !== 0 || s.otherOwnedWorkerLeaseCount !== 0 ||
    !allowedLease || (!input.receiptExists && s.lease.fence !== "76") || s.cursorHash !== p.cursorHash ||
    !validCursor(s.cursor, s.cursorHash) || !validCursor(s.requestedCursor, s.requestedCursorHash) || s.requestedCursorHash === p.cursorHash ||
    s.run.id !== p.runId || s.run.configId !== p.configId || s.run.configNumber !== "2" || s.run.fence !== "76" || s.run.state !== "failed" ||
    s.run.failureCode !== p.failureCode || s.run.finishedAt !== p.finishedAt || s.run.reachedHead || s.run.pageCount !== 18 ||
    s.run.accepted !== 1496 || s.run.duplicates !== 0 || s.run.quarantines !== 304 || s.run.finalCursorHash !== p.cursorHash ||
    handoffDigest(s.run.finalCursor) !== handoffDigest(s.cursor) || !s.lastPage || s.lastPage.number !== 18 || s.lastPage.continuation !== "more" ||
    s.lastPage.cursorHash !== p.cursorHash || handoffDigest(s.lastPage.cursor) !== handoffDigest(s.cursor) || !pagesValid) {
    refuseParserRetry("PARSER_RETRY_CHECKPOINT_CHANGED");
  }
}
export const parserRetryReceiptSchema = z.object({ kind: z.literal("operator_reviewed_courtyard_parser_repair"),
  operationId: z.literal(courtyardParserRetry.operationId), providerId: z.string().uuid(), operatorId: z.string().uuid(),
  configId: z.literal(courtyardParserRetry.configId), parentRunId: z.literal(courtyardParserRetry.runId), runId: z.string().uuid(),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  entryRowVersion: z.string().regex(/^[1-9][0-9]*$/u), checkpointHash: z.literal(courtyardParserRetry.cursorHash),
  failureCode: z.literal(courtyardParserRetry.failureCode), failureAt: z.literal(courtyardParserRetry.finishedAt),
  repair: z.literal("native_arrays_use_existing_480000_aggregate_node_budget"), sourceCheckPerformedByUtility: z.literal(false),
  genericFailureClassification: z.literal("nontransient"),
}).strict();
export type ParserRetryReceipt = z.infer<typeof parserRetryReceiptSchema>;
export function parserRetryReceipt(authority: CourtyardAuthority, snapshot: ParserRetryCheckpoint): ParserRetryReceipt {
  assertParserRetryAuthority(authority);
  assertParserRetryCheckpoint({ snapshot, providerId: authority.provider.id });
  return parserRetryReceiptSchema.parse({ kind: "operator_reviewed_courtyard_parser_repair", operationId: courtyardParserRetry.operationId,
    providerId: authority.provider.id, operatorId: authority.operatorId, configId: courtyardParserRetry.configId,
    parentRunId: courtyardParserRetry.runId, runId: parserRetryId("run"), authorityDigest: authority.authorityDigest,
    checkpointDigest: handoffDigest(parserRetryRetained(snapshot)), entryRowVersion: snapshot.runtimeRowVersion, checkpointHash: courtyardParserRetry.cursorHash,
    failureCode: courtyardParserRetry.failureCode, failureAt: courtyardParserRetry.finishedAt,
    repair: "native_arrays_use_existing_480000_aggregate_node_budget", sourceCheckPerformedByUtility: false, genericFailureClassification: "nontransient" });
}
