import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, providerPackContentSnapshotV1Schema } from "@packscout/contracts";

const uuid = z.uuid();
const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.iso.datetime({ offset: true });
export const PACK_CONTENT_BACKFILL_ACTION = "local.pack_content_backfill.completed";
export const PACK_CONTENT_BACKFILL_PACK_ACTION = "local.pack_content_backfill.pack";
export const PACK_CONTENT_BACKFILL_START_ACTION = "local.pack_content_backfill.started";
export const MAX_PACK_CONTENT_BACKFILL_BYTES = 2 * 1024 * 1024;

const pins = {
  operationId: uuid, organizationId: uuid, providerId: uuid, operatorId: uuid,
  configVersionId: uuid, configVersionNumber: decimal,
  sourceHeadRunId: uuid, sourceHeadFinishedAt: timestamp,
  sourceCheckpointHash: hash, sourceGeneration: decimal, basePromotionSequence: decimal,
};

export const packContentBackfillManifestSchema = z.object({
  schemaVersion: z.literal("provider_pack_content_backfill_manifest_v1"),
  ...pins,
  capturedAt: timestamp,
  snapshots: z.array(providerPackContentSnapshotV1Schema).min(1).max(100),
  responseHashes: z.array(z.object({ packKey: z.string().min(1).max(512), sha256: hash }).strict()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const issue = () => ctx.addIssue({ code: "custom", message: "pack_content_backfill.invalid_scope" });
  const keys = value.snapshots.map(row => row.packKey);
  if (new Set(keys).size !== keys.length || value.snapshots.some(row => row.providerId !== value.providerId ||
    Date.parse(row.collectedAt) > Date.parse(value.capturedAt))) issue();
  if (value.snapshots.reduce((count, row) => count + row.items.length, 0) > 5000) issue();
  if (value.responseHashes.length !== keys.length || new Set(value.responseHashes.map(row => row.packKey)).size !== keys.length ||
    value.responseHashes.some(row => !keys.includes(row.packKey))) issue();
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PACK_CONTENT_BACKFILL_BYTES) issue();
});

export const packContentBackfillReceiptSchema = z.object({
  schemaVersion: z.literal("provider_pack_content_backfill_v1"),
  ...pins,
  manifestDigest: hash,
  importLeaseFence: decimal,
  firstPromotionSequence: decimal,
  lastPromotionSequence: decimal,
  promotionChangesDigest: hash,
  snapshots: z.array(z.object({ id: uuid, packKey: z.string().min(1).max(512), digest: hash }).strict()).min(1).max(100),
  completedAt: timestamp,
}).strict().superRefine((value, ctx) => {
  if (BigInt(value.firstPromotionSequence) !== BigInt(value.basePromotionSequence) + 1n ||
    BigInt(value.lastPromotionSequence) < BigInt(value.firstPromotionSequence) ||
    Date.parse(value.completedAt) < Date.parse(value.sourceHeadFinishedAt) ||
    new Set(value.snapshots.map(row => row.id)).size !== value.snapshots.length ||
    new Set(value.snapshots.map(row => row.packKey)).size !== value.snapshots.length) {
    ctx.addIssue({ code: "custom", message: "pack_content_backfill.invalid_receipt" });
  }
});

export type PackContentBackfillManifest = z.infer<typeof packContentBackfillManifestSchema>;
export type PackContentBackfillReceipt = z.infer<typeof packContentBackfillReceiptSchema>;
export function packContentBackfillDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface BackfillPromotionChange {
  sequence: bigint; entity_type: string; entity_id: string; entity_version: bigint;
  operation: string; changed_at: Date;
}
export function packContentBackfillChangesDigest(rows: readonly BackfillPromotionChange[]): string {
  return packContentBackfillDigest(rows.map(row => ({
    sequence: row.sequence.toString(), entityType: row.entity_type, entityId: row.entity_id,
    entityVersion: row.entity_version.toString(), operation: row.operation, changedAt: row.changed_at.toISOString(),
  })));
}
