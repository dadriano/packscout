import type { ProviderTransactionClient } from "@packscout/database";
import { PACK_CONTENT_BACKFILL_ACTION, PACK_CONTENT_BACKFILL_START_ACTION,
  packContentBackfillDigest, packContentBackfillReceiptSchema,
  type PackContentBackfillManifest } from "./pack-content-backfill-contract.mts";
import { assertPackContentBackfillBoundary, packReceipts, readPackContentBackfillBoundary } from "./pack-content-backfill-persistence.mts";

function refuse(): never { throw new Error("PACK_CONTENT_BACKFILL_STATE_CHANGED"); }

/** Read-only preflight is shared by check-only and the locked lease claim. */
export async function readPackContentBackfillProgress(tx: ProviderTransactionClient, manifest: PackContentBackfillManifest) {
  const boundary = await readPackContentBackfillBoundary(tx);
  assertPackContentBackfillBoundary(manifest, boundary);
  const progress = await packReceipts(tx, manifest);
  if (progress.sequence !== BigInt(boundary.basePromotionSequence)) refuse();
  const [started, completed, packs, clock] = await Promise.all([
    tx.local_audit_events.findMany({ where: { correlation_id: manifest.operationId, action: PACK_CONTENT_BACKFILL_START_ACTION }, take: 2 }),
    tx.local_audit_events.findMany({ where: { correlation_id: manifest.operationId, action: PACK_CONTENT_BACKFILL_ACTION }, take: 2 }),
    tx.packs.findMany({ where: { pack_key: { in: manifest.snapshots.map(row => row.packKey) }, lifecycle: "active" },
      select: { pack_key: true, source_updated_at: true, content_snapshots: {
        orderBy: { effective_at: "desc" }, take: 1,
        select: { id: true, source_key: true, effective_at: true, snapshot_digest: true },
      } }, take: 101 }),
    tx.$queryRaw<readonly { now: Date }[]>`select clock_timestamp() as now`,
  ]);
  const now = clock[0]?.now.getTime();
  if (now === undefined || !Number.isFinite(now) || Date.parse(manifest.capturedAt) > now ||
      started.length > 1 || completed.length > 1 || packs.length !== manifest.snapshots.length) refuse();
  const digest = packContentBackfillDigest(manifest);
  for (const row of [...started, ...completed]) {
    if (row.outcome !== "success" || row.actor_operator_id !== manifest.operatorId ||
        row.target_type !== "provider" || row.target_id !== manifest.providerId) refuse();
  }
  if (started[0] && packContentBackfillDigest(started[0].details) !== packContentBackfillDigest({ manifestDigest: digest })) refuse();
  if (!started[0] && (progress.receipts.length > 0 || completed.length > 0)) refuse();
  if (completed[0]) {
    const receipt = packContentBackfillReceiptSchema.parse(completed[0].details);
    if (receipt.operationId !== manifest.operationId || receipt.manifestDigest !== digest ||
        BigInt(receipt.lastPromotionSequence) !== progress.sequence || progress.receipts.length !== manifest.snapshots.length) refuse();
  }
  const byKey = new Map(packs.map(row => [row.pack_key, row]));
  for (const [index, snapshot] of manifest.snapshots.entries()) {
    const pack = byKey.get(snapshot.packKey);
    if (!pack || pack.source_updated_at.getTime() > Date.parse(snapshot.effectiveAt)) refuse();
    const latest = pack.content_snapshots[0];
    const receipt = progress.receipts[index];
    if (receipt) {
      if (!latest || latest.id !== receipt.snapshotId || latest.snapshot_digest !== receipt.snapshotDigest ||
          latest.source_key !== snapshot.sourceKey || latest.effective_at.toISOString() !== snapshot.effectiveAt) refuse();
    } else if (latest && (latest.source_key !== snapshot.sourceKey || latest.effective_at.getTime() >= Date.parse(snapshot.effectiveAt))) refuse();
  }
  return progress;
}
