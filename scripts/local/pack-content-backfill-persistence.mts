import {
  applyProviderPackContentSnapshot, lockProviderWorkerLease, providerWorkerLeaseIsLive,
  providerWorkerLeaseDatabaseNow, setProviderImportLeaseContext,
  providerPackContentSnapshotDigest,
  providerMixedCursorFingerprint,
  type ProviderPrismaClient, type ProviderTransactionClient, type ProviderWorkerLease,
} from "@packscout/database";
import { canonicalJson } from "@packscout/contracts";
import {
  PACK_CONTENT_BACKFILL_ACTION, PACK_CONTENT_BACKFILL_PACK_ACTION, PACK_CONTENT_BACKFILL_START_ACTION,
  packContentBackfillManifestSchema, packContentBackfillReceiptSchema, packContentBackfillDigest,
  packContentBackfillChangesDigest, type PackContentBackfillManifest,
} from "./pack-content-backfill-contract.mts";

const options = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 30000 };
function refuse(): never { throw new Error("PACK_CONTENT_BACKFILL_STATE_CHANGED"); }

export async function readPackContentBackfillBoundary(db: ProviderPrismaClient | ProviderTransactionClient) {
  const [identity, runtime, head, ledger, work, commands] = await Promise.all([
    db.database_identity.findUnique({ where: { singleton_key: true } }),
    db.provider_runtime.findUnique({ where: { singleton_key: true } }),
    db.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
    db.promotion_ledger.findUnique({ where: { singleton_key: true } }),
    db.provider_runs.count({ where: { state: { in: ["running", "queued"] } } }),
    db.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
  ]);
  if (!identity || !runtime || !head?.finished_at || head.state !== "succeeded" || !head.reached_source_head || !ledger || work || commands ||
    identity.database_role !== "provider" || runtime.operating_state !== "idle" ||
    runtime.central_provider_id !== identity.provider_id || runtime.provider_key !== identity.provider_key ||
    !runtime.source_cursor || !head.final_cursor ||
    runtime.source_cursor_hash !== providerMixedCursorFingerprint(JSON.parse(canonicalJson(runtime.source_cursor))) ||
    head.final_cursor_hash !== providerMixedCursorFingerprint(JSON.parse(canonicalJson(head.final_cursor))) ||
    packContentBackfillDigest(runtime.source_cursor) !== packContentBackfillDigest(head.final_cursor) ||
    runtime.cached_config_version_id !== head.config_version_id ||
    runtime.cached_config_version_number !== head.config_version_number) refuse();
  return { providerId: identity.provider_id, configVersionId: head.config_version_id,
    configVersionNumber: head.config_version_number.toString(), sourceHeadRunId: head.id,
    sourceHeadFinishedAt: head.finished_at.toISOString(), sourceCheckpointHash: packContentBackfillDigest(runtime.source_cursor),
    sourceGeneration: runtime.state_generation.toString(), basePromotionSequence: ledger.last_sequence.toString() };
}

export function assertPackContentBackfillBoundary(manifest: PackContentBackfillManifest,
  boundary: Awaited<ReturnType<typeof readPackContentBackfillBoundary>>) {
  for (const key of ["providerId", "configVersionId", "configVersionNumber", "sourceHeadRunId",
    "sourceHeadFinishedAt", "sourceCheckpointHash", "sourceGeneration"] as const) {
    if (manifest[key] !== boundary[key]) refuse();
  }
}

async function pinnedTransaction(tx: ProviderTransactionClient, manifest: PackContentBackfillManifest, lease: ProviderWorkerLease) {
  const lock = await lockProviderWorkerLease(tx, "import");
  if (!providerWorkerLeaseIsLive(lock, lease)) refuse();
  await setProviderImportLeaseContext(tx, lease);
  await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
  const boundary = await readPackContentBackfillBoundary(tx);
  assertPackContentBackfillBoundary(manifest, boundary);
  return { now: providerWorkerLeaseDatabaseNow(lock), sequence: BigInt(boundary.basePromotionSequence) };
}

interface PackReceipt { index: number; manifestDigest: string; snapshotId: string; snapshotDigest: string;
  firstSequence: string; lastSequence: string; }
export async function packReceipts(tx: ProviderTransactionClient, manifest: PackContentBackfillManifest) {
  const rows = await tx.local_audit_events.findMany({ where: {
    correlation_id: manifest.operationId, action: PACK_CONTENT_BACKFILL_PACK_ACTION,
  }, orderBy: { sequence: "asc" }, take: 101 });
  const digest = packContentBackfillDigest(manifest);
  let previous = BigInt(manifest.basePromotionSequence);
  const receipts: PackReceipt[] = [];
  for (const [index, row] of rows.entries()) {
    const value = row.details as unknown as PackReceipt;
    if (row.outcome !== "success" || row.actor_operator_id !== manifest.operatorId ||
      value.index !== index || value.manifestDigest !== digest ||
      value.snapshotDigest !== providerPackContentSnapshotDigest(manifest.snapshots[index]!) ||
      !/^[1-9][0-9]*$/u.test(value.firstSequence) || !/^[1-9][0-9]*$/u.test(value.lastSequence) ||
      BigInt(value.firstSequence) !== previous + 1n || BigInt(value.lastSequence) < BigInt(value.firstSequence)) refuse();
    previous = BigInt(value.lastSequence); receipts.push(value);
  }
  if (receipts.length > manifest.snapshots.length) refuse();
  return { receipts, sequence: previous };
}

/** Separate resumable catalog checkpoint; no provider run, event cursor or EV is written. */
export async function applyPackContentBackfill(input: {
  database: ProviderPrismaClient; manifest: PackContentBackfillManifest; lease: ProviderWorkerLease;
  revalidateAuthority(): Promise<void>;
}) {
  const manifest = packContentBackfillManifestSchema.parse(input.manifest);
  const manifestDigest = packContentBackfillDigest(manifest);
  await input.revalidateAuthority();
  const completed = await input.database.$transaction(async tx => {
    const current = await pinnedTransaction(tx, manifest, input.lease);
    const rows = await tx.local_audit_events.findMany({ where: { correlation_id: manifest.operationId,
      action: PACK_CONTENT_BACKFILL_ACTION }, take: 2 });
    if (rows.length > 1) refuse();
    if (rows[0]) {
      const receipt = packContentBackfillReceiptSchema.parse(rows[0].details);
      if (rows[0].outcome !== "success" || rows[0].actor_operator_id !== manifest.operatorId || rows[0].target_id !== manifest.providerId ||
        receipt.operationId !== manifest.operationId || receipt.manifestDigest !== manifestDigest || BigInt(receipt.lastPromotionSequence) !== current.sequence) refuse();
      return receipt;
    }
    const prior = await tx.local_audit_events.findMany({ where: { correlation_id: manifest.operationId,
      action: PACK_CONTENT_BACKFILL_START_ACTION }, take: 2 });
    if (prior.length > 1 || (prior[0] && (prior[0].outcome !== "success" || prior[0].actor_operator_id !== manifest.operatorId ||
      prior[0].target_id !== manifest.providerId || packContentBackfillDigest(prior[0].details) !== packContentBackfillDigest({ manifestDigest })))) refuse();
    const progress = await packReceipts(tx, manifest);
    if (progress.sequence !== current.sequence) refuse();
    if (!prior[0]) {
      if (current.sequence !== BigInt(manifest.basePromotionSequence)) refuse();
      await tx.local_audit_events.create({ data: { correlation_id: manifest.operationId,
        actor_operator_id: manifest.operatorId, action: PACK_CONTENT_BACKFILL_START_ACTION,
        target_type: "provider", target_id: manifest.providerId, outcome: "success",
        details: { manifestDigest }, occurred_at: current.now } });
    }
    return null;
  }, options);
  if (completed) return { replayed: true, receipt: completed };

  for (let index = 0; index < manifest.snapshots.length; index += 1) {
    await input.revalidateAuthority();
    await input.database.$transaction(async tx => {
      const current = await pinnedTransaction(tx, manifest, input.lease);
      const progress = await packReceipts(tx, manifest);
      if (current.sequence !== progress.sequence) refuse();
      if (index < progress.receipts.length) return;
      if (index !== progress.receipts.length) refuse();
      const snapshot = manifest.snapshots[index]!;
      const result = await applyProviderPackContentSnapshot(tx, snapshot);
      if (result.outcome !== "applied" || !result.snapshotId || !result.promotionRange ||
        result.promotionRange.first !== current.sequence + 1n) refuse();
      const details: PackReceipt = { index, manifestDigest, snapshotId: result.snapshotId,
        snapshotDigest: providerPackContentSnapshotDigest(snapshot),
        firstSequence: result.promotionRange.first.toString(), lastSequence: result.promotionRange.last.toString() };
      await tx.local_audit_events.create({ data: { correlation_id: manifest.operationId,
        actor_operator_id: manifest.operatorId, action: PACK_CONTENT_BACKFILL_PACK_ACTION,
        target_type: "pack_content_snapshot", target_id: result.snapshotId, outcome: "success",
        details: { ...details }, occurred_at: current.now } });
    }, options);
  }
  await input.revalidateAuthority();
  const receipt = await input.database.$transaction(async tx => {
    const current = await pinnedTransaction(tx, manifest, input.lease);
    const progress = await packReceipts(tx, manifest);
    if (progress.receipts.length !== manifest.snapshots.length || progress.sequence !== current.sequence) refuse();
    const changes = await tx.promotion_changes.findMany({ where: { sequence: {
      gt: BigInt(manifest.basePromotionSequence), lte: current.sequence,
    } }, orderBy: { sequence: "asc" }, take: 10201 });
    if (changes.length > 10200 || BigInt(changes.length) !== current.sequence - BigInt(manifest.basePromotionSequence) ||
      changes.some(row => !["pack_content", "pack_content_snapshot"].includes(row.entity_type))) refuse();
    const value = packContentBackfillReceiptSchema.parse({
      schemaVersion: "provider_pack_content_backfill_v1", operationId: manifest.operationId,
      organizationId: manifest.organizationId, providerId: manifest.providerId, operatorId: manifest.operatorId,
      configVersionId: manifest.configVersionId, configVersionNumber: manifest.configVersionNumber,
      sourceHeadRunId: manifest.sourceHeadRunId, sourceHeadFinishedAt: manifest.sourceHeadFinishedAt,
      sourceCheckpointHash: manifest.sourceCheckpointHash, sourceGeneration: manifest.sourceGeneration,
      basePromotionSequence: manifest.basePromotionSequence, manifestDigest,
      importLeaseFence: input.lease.fence.toString(), firstPromotionSequence: (BigInt(manifest.basePromotionSequence) + 1n).toString(),
      lastPromotionSequence: current.sequence.toString(), promotionChangesDigest: packContentBackfillChangesDigest(changes),
      snapshots: progress.receipts.map((row, index) => ({ id: row.snapshotId,
        packKey: manifest.snapshots[index]!.packKey, digest: row.snapshotDigest })), completedAt: new Date().toISOString(),
    });
    await tx.local_audit_events.create({ data: { correlation_id: manifest.operationId,
      actor_operator_id: manifest.operatorId, action: PACK_CONTENT_BACKFILL_ACTION,
      target_type: "provider", target_id: manifest.providerId, outcome: "success", details: value,
      occurred_at: new Date(value.completedAt) } });
    return value;
  }, options);
  return { replayed: false, receipt };
}
