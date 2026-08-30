import { z } from "zod";
import { dataforrestCourtyardDistributedV2SourceAdapterManifest as nextManifest,
  dataforrestCourtyardDistributedSourceAdapterManifest as previousManifest, dataforrestEventsJsonNodeBudget,
  opaqueCursorEnvelopeSchema } from "@packscout/contracts";
import { providerMixedCursorFingerprint, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { launchSourceMapperDescriptors } from "@packscout/services";
import { handoffDigest, handoffId } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { readCollectorHandoffCheckpoint, retainedCollectorCheckpoint } from "./collector-crypt-checkpoint-handoff-state.mts";

export const courtyardHandoff = Object.freeze({ organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
  providerId: "eeba923b-3d0f-53bc-9006-d84fab651824", operationId: "26c70381-925a-5228-87be-4e6b862fa508",
  providerKey: "courtyard", port: 55433, databaseName: "packscout_courtyard",
  previousConfigId: "a1544542-735e-5df2-932e-0dde904da1f6", runId: "b3195b00-b91f-5c9a-a6ce-9ad57492c818",
  failureCode: "PROVIDER_DATAFORREST_RESPONSE_TOO_LARGE", finishedAt: "2026-08-30T15:07:54.584Z",
  cursorHash: "d5c77ce52e20f2dab229d9a255924c1fc9133960e4a09e3a10629f6d0ce305c1",
  previousAdapter: previousManifest.adapterVersion, nextAdapter: nextManifest.adapterVersion,
  action: "provider.local_courtyard_response_budget_handoff", reason: "Courtyard immutable response-budget checkpoint handoff; failure predates pause" });
export class CourtyardHandoffError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CourtyardHandoffError"; }
}
export function refuseCourtyardHandoff(code: string): never { throw new CourtyardHandoffError(code); }
export const courtyardHandoffId = (operationId: string, label: string) => handoffId(operationId, `courtyard-response-budget/${label}`);

export function assertCourtyardProfileContinuity() {
  const old = previousManifest.supportedProviders.find((entry) => entry.provider === "courtyard");
  const next = nextManifest.supportedProviders.find((entry) => entry.provider === "courtyard");
  const mapper = launchSourceMapperDescriptors.find((entry) => entry.provider === "courtyard");
  if (!old || !next || !mapper || handoffDigest(old) !== handoffDigest(next) ||
    mapper.mapperKey !== "courtyard-provider-observation" || mapper.mapperVersion !== "1" ||
    mapper.identityNamespaceKey !== next.identityNamespaceKey ||
    previousManifest.sourceTypeKey !== nextManifest.sourceTypeKey || previousManifest.cursorCodecKey !== nextManifest.cursorCodecKey ||
    previousManifest.normalizedContractVersion !== nextManifest.normalizedContractVersion ||
    dataforrestEventsJsonNodeBudget(previousManifest.adapterVersion) !== 480000 ||
    dataforrestEventsJsonNodeBudget(nextManifest.adapterVersion) !== 640000 ||
    handoffDigest(previousManifest.requestBounds) !== handoffDigest({ ...nextManifest.requestBounds, maximumResponseBytes: previousManifest.requestBounds.maximumResponseBytes }) ||
    nextManifest.requestBounds.pageLimit !== 100 || previousManifest.requestBounds.maximumResponseBytes !== 8388608 || nextManifest.requestBounds.maximumResponseBytes !== 33554432) {
    refuseCourtyardHandoff("COURTYARD_PROFILE_CONTINUITY_CHANGED");
  }
  return mapper;
}

export function reEnvelopeCourtyardCursor(input: Readonly<{ cursor: unknown; cursorHash: string | null;
  providerId: string; nextConfigId: string; expectedHash?: string }>) {
  assertCourtyardProfileContinuity();
  const parsed = opaqueCursorEnvelopeSchema.safeParse(input.cursor);
  if (input.providerId !== courtyardHandoff.providerId || !parsed.success || parsed.data.value === null || parsed.data.sourceInstanceId !== input.providerId ||
    parsed.data.sourceRevisionId !== courtyardHandoff.previousConfigId || parsed.data.adapterVersion !== courtyardHandoff.previousAdapter ||
    parsed.data.sourceTypeKey !== previousManifest.sourceTypeKey || parsed.data.cursorCodecKey !== previousManifest.cursorCodecKey ||
    parsed.data.cursorGeneration !== 1 || input.cursorHash !== (input.expectedHash ?? courtyardHandoff.cursorHash) ||
    providerMixedCursorFingerprint(parsed.data) !== input.cursorHash || input.nextConfigId === courtyardHandoff.previousConfigId) {
    refuseCourtyardHandoff("COURTYARD_CHECKPOINT_CURSOR_CHANGED");
  }
  const cursor = { ...parsed.data, sourceRevisionId: input.nextConfigId, adapterVersion: courtyardHandoff.nextAdapter };
  return { cursor, cursorHash: providerMixedCursorFingerprint(cursor)!, opaqueValueHash: handoffDigest(cursor.value) };
}

/** Finite metadata-only history projection; callers hold a read snapshot or the import→run→runtime lock order. */
export async function readCourtyardHandoffCheckpoint(database: ProviderPrismaClient | ProviderTransactionClient) {
  const [snapshot, history, pages, quarantines] = await Promise.all([
    readCollectorHandoffCheckpoint(database, { oldProcessAlive: false, runId: courtyardHandoff.runId }),
    database.provider_runs.findMany({ take: 50001, orderBy: { id: "asc" }, select: { id: true, state: true,
      config_version_id: true, config_version_number: true, worker_fence: true, page_count: true,
      catalog_record_count: true, pull_record_count: true, market_event_record_count: true,
      accepted_count: true, duplicate_count: true, quarantined_count: true, material_change_count: true,
      requested_cursor_hash: true, final_cursor_hash: true, failure_code: true, reached_source_head: true,
      requested_at: true, started_at: true, finished_at: true, recovery_of_run_id: true, row_version: true } }),
    database.provider_run_pages.findMany({ take: 50001, orderBy: { id: "asc" }, select: { id: true,
      provider_run_id: true, page_number: true, contract_version: true, requested_cursor_hash: true,
      next_cursor_hash: true, continuation: true, response_digest: true, record_count: true, catalog_record_count: true,
      pull_record_count: true, market_event_record_count: true, accepted_count: true, duplicate_count: true,
      quarantined_count: true, material_change_count: true, committed_at: true } }),
    database.quarantine_records.findMany({ take: 50001, orderBy: { id: "asc" }, select: { id: true,
      provider_run_id: true, provider_run_page_id: true, record_index: true, record_kind: true, source_record_key: true,
      reason_code: true, field_path: true, state: true, retry_count: true, row_version: true,
      evidence_expired_at: true, resolved_at: true, updated_at: true } }),
  ]);
  if (history.length > 50000 || pages.length > 50000 || quarantines.length > 50000 || history.length !== snapshot.runCount) {
    refuseCourtyardHandoff("COURTYARD_HISTORY_BOUND_EXCEEDED");
  }
  return { ...snapshot, runHistoryHash: handoffDigest(history), pageHistoryHash: handoffDigest(pages),
    pageHistoryCount: pages.length, quarantineHistoryHash: handoffDigest(quarantines), quarantineCount: quarantines.length };
}
export type CourtyardCheckpoint = Awaited<ReturnType<typeof readCourtyardHandoffCheckpoint>>;
export const retainedCourtyardCheckpoint = (snapshot: CourtyardCheckpoint) => ({
  ...retainedCollectorCheckpoint(snapshot), generation: "21", runHistoryHash: snapshot.runHistoryHash,
  pageHistoryHash: snapshot.pageHistoryHash, pageHistoryCount: snapshot.pageHistoryCount,
  quarantineHistoryHash: snapshot.quarantineHistoryHash, runCount: snapshot.runCount, quarantineCount: snapshot.quarantineCount,
});

export function assertCourtyardCheckpoint(input: Readonly<{ snapshot: CourtyardCheckpoint; providerId: string;
  nextConfigId: string; phase: "terminal" | "paused"; utilityLease?: { owner: string; fence: string };
  reclaimableOwner?: string; expectedHash?: string }>) {
  const s = input.snapshot; const p = courtyardHandoff;
  const migrated = reEnvelopeCourtyardCursor({ cursor: s.run.finalCursor, cursorHash: s.run.finalCursorHash,
    providerId: input.providerId, nextConfigId: input.nextConfigId, expectedHash: input.expectedHash });
  const previous = s.cachedConfigId === p.previousConfigId && s.cachedConfigNumber === "2";
  const prepared = s.cachedConfigId === input.nextConfigId && s.cachedConfigNumber === "3";
  const leaseAllowed = input.utilityLease
    ? s.lease.owner === input.utilityLease.owner && s.lease.fence === input.utilityLease.fence && s.lease.expiresAt !== null &&
      Date.parse(s.lease.expiresAt) > Date.parse(s.databaseNow)
    : (s.lease.owner === null && s.lease.expiresAt === null) || (input.reclaimableOwner !== undefined &&
      s.lease.owner === input.reclaimableOwner && s.lease.expiresAt !== null && Date.parse(s.lease.expiresAt) <= Date.parse(s.databaseNow));
  if (input.providerId !== p.providerId || s.providerId !== input.providerId || s.providerKey !== p.providerKey || s.databaseRole !== "provider" ||
    s.schemaVersion !== "distributed-provider-v1" || s.runtimeState !== (input.phase === "terminal" ? "error" : "paused") ||
    s.generation !== (input.phase === "terminal" ? "21" : "22") || (!previous && !prepared) ||
    (input.phase === "terminal" && (!previous || s.lease.fence !== "82")) ||
    s.quarantineCount !== 684 || s.pageHistoryCount !== 17310 || s.activeRunCount !== 0 || s.actionableCommandCount !== 0 || s.otherActiveTransactionCount !== 0 ||
    s.otherOwnedWorkerLeaseCount !== 0 || !leaseAllowed || !Number.isSafeInteger(s.runCount) || s.runCount < 1 || s.runCount > 50000 ||
    s.run.id !== p.runId || s.run.configId !== p.previousConfigId || s.run.configNumber !== "2" ||
    s.run.state !== "failed" || s.run.failureCode !== p.failureCode || s.run.finishedAt !== p.finishedAt ||
    s.run.fence !== "82" || s.run.pageCount !== 2302 || s.run.accepted !== 230045 || s.run.duplicates !== 0 ||
    s.run.quarantines !== 155 || s.run.reachedHead || !s.lastPage || s.lastPage.number !== 2302 || s.lastPage.continuation !== "more" ||
    s.lastPage.cursorHash !== s.run.finalCursorHash || handoffDigest(s.lastPage.cursor) !== handoffDigest(s.run.finalCursor) ||
    s.cursorHash !== (previous ? s.run.finalCursorHash : migrated.cursorHash) ||
    handoffDigest(s.cursor) !== handoffDigest(previous ? s.run.finalCursor : migrated.cursor)) {
    refuseCourtyardHandoff("COURTYARD_TERMINAL_CHECKPOINT_CHANGED");
  }
  return previous ? "previous" : "prepared";
}

export const courtyardReceiptSchema = z.object({ kind: z.literal("courtyard_terminal_response_budget"),
  operationId: z.string().uuid(), providerId: z.string().uuid(), operatorId: z.string().uuid(), nextConfigId: z.string().uuid(),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  entryRowVersion: z.string().regex(/^[1-9][0-9]*$/u), failureCode: z.literal(courtyardHandoff.failureCode),
  finishedAt: z.literal(courtyardHandoff.finishedAt), previousCursorHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type CourtyardReceipt = z.infer<typeof courtyardReceiptSchema>;
export const courtyardCanarySchema = z.object({ checkKind: z.literal("courtyard_response_budget_parser_mapper_inspection"),
  adapterKey: z.literal(courtyardHandoff.nextAdapter), providerId: z.string().uuid(), nextConfigId: z.string().uuid(),
  savedCursorHash: z.literal(courtyardHandoff.cursorHash), opaqueValueHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.literal(200), recordCount: z.literal(100), adapterInvalid: z.literal(0), mapperQuarantined: z.literal(0),
  collectibleValidated: z.literal(100), canonicalQuarantined: z.literal(0),
  requestedRecords: z.literal(100), maximumResponseBytes: z.literal(33554432), maximumJsonNodes: z.literal(640000),
  responseBytes: z.number().int().positive().max(33554432),
  durationMilliseconds: z.number().finite().nonnegative(), checkedAt: z.string().datetime(),
}).strict();
export type CourtyardCanaryProof = z.infer<typeof courtyardCanarySchema>;
