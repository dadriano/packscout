import { createHash } from "node:crypto";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestCollectorCryptDistributedSourceAdapterManifest as nextManifest,
  dataforrestLaunchDistributedSourceAdapterManifest as previousManifest,
  opaqueCursorEnvelopeSchema,
  type OpaqueCursorEnvelope,
} from "@packscout/contracts";
import { providerMixedCursorFingerprint } from "@packscout/database";
import { launchSourceMapperDescriptors } from "@packscout/services";

export const collectorHandoff = Object.freeze({
  providerId: "c9f60d4e-e4c1-58c2-a24c-e545cab7a0e5",
  organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
  providerKey: "collector_crypt",
  databaseName: "packscout_collector_crypt",
  port: 55_434,
  endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
  previousAdapter: previousManifest.adapterVersion,
  nextAdapter: nextManifest.adapterVersion,
  reason: "Collector Crypt immutable 1000-record checkpoint handoff",
  action: "provider.local_collector_checkpoint_handoff",
});

export class CollectorCheckpointHandoffError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CollectorCheckpointHandoffError";
  }
}
export function refuseHandoff(code: string): never {
  throw new CollectorCheckpointHandoffError(code);
}

export function handoffDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function handoffId(operationId: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) {
    refuseHandoff("HANDOFF_OPERATION_ID_INVALID");
  }
  const hash = createHash("sha256").update(`collector-handoff/${operationId}/${label}`).digest();
  hash[6] = (hash[6]! & 15) | 80;
  hash[8] = (hash[8]! & 63) | 128;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** This reviewed exception changes request page size, never native interpretation. */
export function assertCollectorHandoffCompatibility(): void {
  const oldDeclaration = previousManifest.supportedProviders.find((entry) => entry.provider === collectorHandoff.providerKey);
  const nextDeclaration = nextManifest.supportedProviders.find((entry) => entry.provider === collectorHandoff.providerKey);
  const mapper = launchSourceMapperDescriptors.find((entry) => entry.provider === collectorHandoff.providerKey);
  if (!oldDeclaration || !nextDeclaration || !mapper ||
    handoffDigest(oldDeclaration) !== handoffDigest(nextDeclaration) ||
    mapper.identityNamespaceKey !== nextDeclaration.identityNamespaceKey ||
    mapper.mapperKey !== "collector-crypt-provider-observation" || mapper.mapperVersion !== "1" ||
    previousManifest.sourceTypeKey !== nextManifest.sourceTypeKey ||
    previousManifest.cursorCodecKey !== nextManifest.cursorCodecKey ||
    previousManifest.normalizedContractVersion !== nextManifest.normalizedContractVersion ||
    nextManifest.normalizedContractVersion !== mapper.normalizedContractVersion ||
    previousManifest.requestBounds.pageLimit !== 100 || nextManifest.requestBounds.pageLimit !== 1_000 ||
    previousManifest.requestBounds.maximumResponseBytes !== 8 * 1_024 * 1_024 ||
    nextManifest.requestBounds.maximumResponseBytes !== previousManifest.requestBounds.maximumResponseBytes ||
    nextManifest.requestBounds.timeoutMilliseconds !== previousManifest.requestBounds.timeoutMilliseconds) {
    refuseHandoff("HANDOFF_SOURCE_COMPATIBILITY_CHANGED");
  }
}

export function reEnvelopeCollectorCursor(input: Readonly<{
  cursor: unknown; cursorHash: string | null; previousConfigId: string; nextConfigId: string;
}>): Readonly<{ cursor: OpaqueCursorEnvelope; cursorHash: string; opaqueValueHash: string }> {
  assertCollectorHandoffCompatibility();
  const parsed = opaqueCursorEnvelopeSchema.safeParse(input.cursor);
  if (!parsed.success || parsed.data.value === null ||
    parsed.data.sourceInstanceId !== collectorHandoff.providerId ||
    parsed.data.sourceRevisionId !== input.previousConfigId ||
    parsed.data.adapterVersion !== previousManifest.adapterVersion ||
    parsed.data.sourceTypeKey !== previousManifest.sourceTypeKey ||
    parsed.data.cursorCodecKey !== previousManifest.cursorCodecKey || parsed.data.cursorGeneration !== 1 ||
    providerMixedCursorFingerprint(parsed.data) !== input.cursorHash ||
    input.previousConfigId === input.nextConfigId) refuseHandoff("HANDOFF_CURSOR_INVALID");
  const cursor = opaqueCursorEnvelopeSchema.parse({ ...parsed.data,
    sourceRevisionId: input.nextConfigId, adapterVersion: nextManifest.adapterVersion });
  return { cursor, cursorHash: providerMixedCursorFingerprint(cursor)!,
    opaqueValueHash: handoffDigest(parsed.data.value) };
}

export interface CollectorHandoffCheckpoint {
  readonly providerId: string;
  readonly providerKey: string;
  readonly databaseRole: string;
  readonly schemaVersion: string;
  readonly runtimeState: string;
  readonly generation: string;
  readonly runtimeRowVersion: string;
  readonly cachedConfigId: string | null;
  readonly cachedConfigNumber: string | null;
  readonly cursor: unknown;
  readonly cursorHash: string | null;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly otherActiveTransactionCount: number;
  readonly oldProcessAlive: boolean;
  readonly databaseNow: string;
  readonly lease: Readonly<{ owner: string | null; fence: string; expiresAt: string | null }>;
  readonly ledgerSequence: string;
  readonly run: Readonly<{
    id: string; state: string; configId: string; configNumber: string; fence: string;
    pageCount: number; accepted: number; duplicates: number; quarantines: number;
    materialChanges: number; reachedHead: boolean; finishedAt: string | null; failureCode: string | null;
    finalCursor: unknown; finalCursorHash: string | null;
  }>;
  readonly lastPage: Readonly<{ id: string; number: number; cursor: unknown; cursorHash: string | null; continuation: string }> | null;
}

export function checkpointEvidence(snapshot: CollectorHandoffCheckpoint) {
  return { providerId: snapshot.providerId, providerKey: snapshot.providerKey,
    generation: snapshot.generation, runtimeRowVersion: snapshot.runtimeRowVersion,
    configId: snapshot.cachedConfigId, cursorHash: snapshot.cursorHash,
    leaseFence: snapshot.lease.fence, runId: snapshot.run.id, runFence: snapshot.run.fence,
    pageCount: snapshot.run.pageCount, accepted: snapshot.run.accepted,
    duplicates: snapshot.run.duplicates, quarantines: snapshot.run.quarantines,
    materialChanges: snapshot.run.materialChanges, ledgerSequence: snapshot.ledgerSequence,
    lastPageId: snapshot.lastPage?.id ?? null };
}

export function assertCollectorHandoffDrained(input: Readonly<{
  snapshot: CollectorHandoffCheckpoint; previousConfigId: string; nextConfigId: string;
  expectedGeneration: string; utilityLease?: Readonly<{ owner: string; fence: string }>;
  reclaimableUtilityOwner?: string;
}>): "previous" | "prepared" {
  const s = input.snapshot;
  const migrated = reEnvelopeCollectorCursor({ cursor: s.run.finalCursor,
    cursorHash: s.run.finalCursorHash, previousConfigId: input.previousConfigId, nextConfigId: input.nextConfigId });
  const previous = s.cachedConfigId === input.previousConfigId && s.cachedConfigNumber === "2";
  const prepared = s.cachedConfigId === input.nextConfigId && s.cachedConfigNumber === "3";
  const leaseAllowed = input.utilityLease
    ? s.lease.owner === input.utilityLease.owner && s.lease.fence === input.utilityLease.fence &&
      s.lease.expiresAt !== null && Date.parse(s.lease.expiresAt) > Date.parse(s.databaseNow)
    : (s.lease.owner === null && s.lease.expiresAt === null) ||
      (input.reclaimableUtilityOwner !== undefined && s.lease.owner === input.reclaimableUtilityOwner &&
        s.lease.expiresAt !== null && Date.parse(s.lease.expiresAt) <= Date.parse(s.databaseNow));
  const pauseTerminal = (s.run.state === "incomplete" && s.run.failureCode === "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE") ||
    (s.run.state === "failed" && s.run.failureCode === "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING");
  if (s.providerId !== collectorHandoff.providerId || s.providerKey !== collectorHandoff.providerKey ||
    s.databaseRole !== "provider" || s.schemaVersion !== "distributed-provider-v1" ||
    s.runtimeState !== "paused" || s.generation !== input.expectedGeneration ||
    (!previous && !prepared) || s.activeRunCount !== 0 || s.actionableCommandCount !== 0 ||
    s.otherActiveTransactionCount !== 0 || s.oldProcessAlive || !leaseAllowed ||
    !pauseTerminal || s.run.finishedAt === null || s.run.reachedHead ||
    s.run.configId !== input.previousConfigId || s.run.configNumber !== "2" || s.run.pageCount < 1 ||
    s.lastPage === null || s.lastPage.number !== s.run.pageCount || s.lastPage.continuation !== "more" ||
    s.lastPage.cursorHash !== s.run.finalCursorHash ||
    handoffDigest(s.lastPage.cursor) !== handoffDigest(s.run.finalCursor) ||
    s.cursorHash !== (previous ? s.run.finalCursorHash : migrated.cursorHash) ||
    handoffDigest(s.cursor) !== handoffDigest(previous ? s.run.finalCursor : migrated.cursor)) {
    refuseHandoff("HANDOFF_CHECKPOINT_NOT_DRAINED");
  }
  return previous ? "previous" : "prepared";
}

/** Order is security-relevant: central activation is LAST, preventing sync-reset races. */
export async function executeCollectorHandoffPreparation(input: Readonly<{
  readAndAssert: () => Promise<"previous" | "prepared">;
  stageInactiveCentral: () => Promise<void>;
  prepareLocalAtomically: () => Promise<void>;
  activateCentralLast: () => Promise<void>;
}>): Promise<void> {
  const phase = await input.readAndAssert();
  await input.stageInactiveCentral();
  if (phase === "previous") await input.prepareLocalAtomically();
  if (await input.readAndAssert() !== "prepared") refuseHandoff("HANDOFF_PREPARATION_NOT_DURABLE");
  await input.activateCentralLast();
}
