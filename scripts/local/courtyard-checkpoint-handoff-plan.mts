import { z } from "zod";
import { dataforrestCourtyardDistributedSourceAdapterManifest as nextManifest,
  dataforrestLaunchDistributedSourceAdapterManifest as previousManifest, opaqueCursorEnvelopeSchema } from "@packscout/contracts";
import { providerMixedCursorFingerprint, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { launchSourceMapperDescriptors } from "@packscout/services";
import { handoffDigest, handoffId } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { readCollectorHandoffCheckpoint, retainedCollectorCheckpoint } from "./collector-crypt-checkpoint-handoff-state.mts";

export const courtyardHandoff = Object.freeze({ organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
  providerKey: "courtyard", port: 55433, databaseName: "packscout_courtyard",
  previousConfigId: "2b986eb0-3faf-50bc-a29b-56aaf60c75c0", runId: "714393a7-2610-49a4-89e6-34f00eb01e65",
  failureCode: "PROVIDER_DATAFORREST_INVALID_RESPONSE", finishedAt: "2026-08-30T03:41:16.245Z",
  cursorHash: "07efb85b6f5553ee3d933c750947aa66847859764eda5b90b7af2720e49558a6",
  previousAdapter: previousManifest.adapterVersion, nextAdapter: nextManifest.adapterVersion,
  action: "provider.local_courtyard_checkpoint_handoff", reason: "Courtyard native-card checkpoint handoff; failure predates pause" });
export class CourtyardHandoffError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CourtyardHandoffError"; }
}
export function refuseCourtyardHandoff(code: string): never { throw new CourtyardHandoffError(code); }
export const courtyardHandoffId = (operationId: string, label: string) => handoffId(operationId, `courtyard/${label}`);

export function assertCourtyardProfileContinuity() {
  const old = previousManifest.supportedProviders.find((entry) => entry.provider === "courtyard");
  const next = nextManifest.supportedProviders.find((entry) => entry.provider === "courtyard");
  const mapper = launchSourceMapperDescriptors.find((entry) => entry.provider === "courtyard");
  if (!old || !next || !mapper || handoffDigest(old) !== handoffDigest(next) ||
    mapper.mapperKey !== "courtyard-provider-observation" || mapper.mapperVersion !== "1" ||
    mapper.identityNamespaceKey !== next.identityNamespaceKey ||
    previousManifest.sourceTypeKey !== nextManifest.sourceTypeKey || previousManifest.cursorCodecKey !== nextManifest.cursorCodecKey ||
    handoffDigest(previousManifest.requestBounds) !== handoffDigest(nextManifest.requestBounds) ||
    nextManifest.requestBounds.pageLimit !== 100 || nextManifest.requestBounds.maximumResponseBytes !== 8388608) {
    refuseCourtyardHandoff("COURTYARD_PROFILE_CONTINUITY_CHANGED");
  }
  return mapper;
}

export function reEnvelopeCourtyardCursor(input: Readonly<{ cursor: unknown; cursorHash: string | null;
  providerId: string; nextConfigId: string; expectedHash?: string }>) {
  assertCourtyardProfileContinuity();
  const parsed = opaqueCursorEnvelopeSchema.safeParse(input.cursor);
  if (!parsed.success || parsed.data.value === null || parsed.data.sourceInstanceId !== input.providerId ||
    parsed.data.sourceRevisionId !== courtyardHandoff.previousConfigId || parsed.data.adapterVersion !== courtyardHandoff.previousAdapter ||
    parsed.data.sourceTypeKey !== previousManifest.sourceTypeKey || parsed.data.cursorCodecKey !== previousManifest.cursorCodecKey ||
    parsed.data.cursorGeneration !== 1 || input.cursorHash !== (input.expectedHash ?? courtyardHandoff.cursorHash) ||
    providerMixedCursorFingerprint(parsed.data) !== input.cursorHash || input.nextConfigId === courtyardHandoff.previousConfigId) {
    refuseCourtyardHandoff("COURTYARD_CHECKPOINT_CURSOR_CHANGED");
  }
  const cursor = { ...parsed.data, sourceRevisionId: input.nextConfigId, adapterVersion: courtyardHandoff.nextAdapter };
  return { cursor, cursorHash: providerMixedCursorFingerprint(cursor)!, opaqueValueHash: handoffDigest(cursor.value) };
}

/** Reuses the existing provider-neutral projection only; no Collector mutation/policy is invoked. */
export async function readCourtyardHandoffCheckpoint(database: ProviderPrismaClient | ProviderTransactionClient) {
  const [snapshot, history, quarantineCount] = await Promise.all([
    readCollectorHandoffCheckpoint(database, { oldProcessAlive: false, runId: courtyardHandoff.runId }),
    database.provider_runs.findMany({ orderBy: { id: "asc" }, select: { id: true, state: true,
      config_version_id: true, config_version_number: true, worker_fence: true, page_count: true,
      accepted_count: true, duplicate_count: true, quarantined_count: true, material_change_count: true,
      requested_cursor_hash: true, final_cursor_hash: true, failure_code: true, reached_source_head: true,
      requested_at: true, started_at: true, finished_at: true, recovery_of_run_id: true } }),
    database.quarantine_records.count(),
  ]);
  return { ...snapshot, runHistoryHash: handoffDigest(history), quarantineCount };
}
export type CourtyardCheckpoint = Awaited<ReturnType<typeof readCourtyardHandoffCheckpoint>>;
export const retainedCourtyardCheckpoint = (snapshot: CourtyardCheckpoint) => ({
  ...retainedCollectorCheckpoint(snapshot), generation: "2", runHistoryHash: snapshot.runHistoryHash,
  runCount: snapshot.runCount, quarantineCount: snapshot.quarantineCount,
});

export function assertCourtyardCheckpoint(input: Readonly<{ snapshot: CourtyardCheckpoint; providerId: string;
  nextConfigId: string; phase: "terminal" | "paused"; utilityLease?: { owner: string; fence: string };
  reclaimableOwner?: string; expectedHash?: string }>) {
  const s = input.snapshot; const p = courtyardHandoff;
  const migrated = reEnvelopeCourtyardCursor({ cursor: s.run.finalCursor, cursorHash: s.run.finalCursorHash,
    providerId: input.providerId, nextConfigId: input.nextConfigId, expectedHash: input.expectedHash });
  const previous = s.cachedConfigId === p.previousConfigId && s.cachedConfigNumber === "1";
  const prepared = s.cachedConfigId === input.nextConfigId && s.cachedConfigNumber === "2";
  const leaseAllowed = input.utilityLease
    ? s.lease.owner === input.utilityLease.owner && s.lease.fence === input.utilityLease.fence && s.lease.expiresAt !== null &&
      Date.parse(s.lease.expiresAt) > Date.parse(s.databaseNow)
    : (s.lease.owner === null && s.lease.expiresAt === null) || (input.reclaimableOwner !== undefined &&
      s.lease.owner === input.reclaimableOwner && s.lease.expiresAt !== null && Date.parse(s.lease.expiresAt) <= Date.parse(s.databaseNow));
  if (s.providerId !== input.providerId || s.providerKey !== p.providerKey || s.databaseRole !== "provider" ||
    s.schemaVersion !== "distributed-provider-v1" || s.runtimeState !== (input.phase === "terminal" ? "error" : "paused") ||
    s.generation !== (input.phase === "terminal" ? "2" : "3") || (!previous && !prepared) ||
    (input.phase === "terminal" && (!previous || s.lease.fence !== "74")) ||
    s.activeRunCount !== 0 || s.actionableCommandCount !== 0 || s.otherActiveTransactionCount !== 0 ||
    s.otherOwnedWorkerLeaseCount !== 0 || !leaseAllowed || s.runCount !== 74 ||
    s.run.id !== p.runId || s.run.configId !== p.previousConfigId || s.run.configNumber !== "1" ||
    s.run.state !== "failed" || s.run.failureCode !== p.failureCode || s.run.finishedAt !== p.finishedAt ||
    s.run.fence !== "74" || s.run.pageCount !== 8073 || s.run.accepted !== 807129 || s.run.duplicates !== 0 ||
    s.run.quarantines !== 171 || s.run.reachedHead || !s.lastPage || s.lastPage.number !== 8073 || s.lastPage.continuation !== "more" ||
    s.lastPage.cursorHash !== s.run.finalCursorHash || handoffDigest(s.lastPage.cursor) !== handoffDigest(s.run.finalCursor) ||
    s.cursorHash !== (previous ? s.run.finalCursorHash : migrated.cursorHash) ||
    handoffDigest(s.cursor) !== handoffDigest(previous ? s.run.finalCursor : migrated.cursor)) {
    refuseCourtyardHandoff("COURTYARD_TERMINAL_CHECKPOINT_CHANGED");
  }
  return previous ? "previous" : "prepared";
}

export const courtyardReceiptSchema = z.object({ kind: z.literal("courtyard_terminal_native_profile"),
  operationId: z.string().uuid(), providerId: z.string().uuid(), operatorId: z.string().uuid(), nextConfigId: z.string().uuid(),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  entryRowVersion: z.string().regex(/^[1-9][0-9]*$/u), failureCode: z.literal(courtyardHandoff.failureCode),
  finishedAt: z.literal(courtyardHandoff.finishedAt), previousCursorHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type CourtyardReceipt = z.infer<typeof courtyardReceiptSchema>;
export const courtyardCanarySchema = z.object({ checkKind: z.literal("courtyard_untrusted_parser_mapper_inspection"),
  adapterKey: z.literal(courtyardHandoff.nextAdapter), providerId: z.string().uuid(), nextConfigId: z.string().uuid(),
  savedCursorHash: z.literal(courtyardHandoff.cursorHash), opaqueValueHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.literal(200), recordCount: z.literal(100), adapterInvalid: z.literal(0), mapperQuarantined: z.literal(0),
  collectibleValidated: z.number().int().min(80).max(100), canonicalMissingDisplayNameRejected: z.number().int().min(0).max(20),
  canonicalQuarantineClass: z.literal("missing_display_name"), responseBytes: z.number().int().positive().max(8388608),
  durationMilliseconds: z.number().finite().nonnegative(), checkedAt: z.string().datetime(),
}).strict().refine((proof) => proof.collectibleValidated + proof.canonicalMissingDisplayNameRejected === proof.recordCount);
export type CourtyardCanaryProof = z.infer<typeof courtyardCanarySchema>;
