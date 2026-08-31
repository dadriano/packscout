import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS,
  providerPackContentSnapshotV1Schema,
  type ProviderPackContentSnapshotV1,
} from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import {
  ProviderCanonicalInputError,
  ProviderCanonicalWriteConflictError,
  normalizeMoneyDecimal,
  normalizeRateDecimal,
  type PromotionSequenceRange,
} from "./provider-canonical-contract.ts";
import { appendPromotionRange, createProviderCanonicalTransaction } from "./provider-canonical-repository.ts";

export interface ProviderPackContentSnapshotResult {
  readonly outcome: "applied" | "replayed" | "ignored_older";
  readonly snapshotId: string | null;
  readonly materialChange: boolean;
  readonly upsertedCount: number;
  readonly retiredCount: number;
  readonly promotionRange: PromotionSequenceRange | null;
}

interface LockedPack {
  readonly id: string;
  readonly lifecycle: string;
  readonly source_updated_at: Date;
}

function inputError(): never {
  throw new ProviderCanonicalInputError("The provider pack membership snapshot is invalid or has unresolved references.");
}

function membershipKey(collectibleId: string, instanceId: string | null): string {
  return JSON.stringify([collectibleId, instanceId]);
}

function normalizedSnapshot(value: unknown): ProviderPackContentSnapshotV1 {
  const parsed = providerPackContentSnapshotV1Schema.safeParse(value);
  if (!parsed.success) inputError();
  return {
    ...parsed.data,
    items: parsed.data.items.map((item) => ({
      ...item,
      probability: item.probability === null ? null : normalizeRateDecimal(item.probability),
      statedValueAmount: item.statedValueAmount === null ? null : normalizeMoneyDecimal(item.statedValueAmount),
      evidenceKinds: [...item.evidenceKinds].sort(),
    })).sort((left, right) => {
      const a = membershipKey(left.collectibleKey, left.collectibleInstanceKey);
      const b = membershipKey(right.collectibleKey, right.collectibleInstanceKey);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  };
}

/** Collection time is transport evidence; a redelivery cannot renew membership. */
export function providerPackContentSnapshotDigest(value: ProviderPackContentSnapshotV1): string {
  const snapshot = normalizedSnapshot(value);
  const semantic = Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "collectedAt"));
  return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}

function inert(outcome: "replayed" | "ignored_older", snapshotId: string | null): ProviderPackContentSnapshotResult {
  return { outcome, snapshotId, materialChange: false, upsertedCount: 0, retiredCount: 0, promotionRange: null };
}

/**
 * Caller supplies the existing fenced import/backfill transaction. One pack row
 * lock serializes its authoritative membership stream; all identity resolution,
 * retirements, replacements, receipt and promotion entries commit together.
 * This function never touches pack economics, EV evidence or an event cursor.
 */
export async function applyProviderPackContentSnapshot(
  transaction: ProviderTransactionClient,
  value: ProviderPackContentSnapshotV1,
): Promise<ProviderPackContentSnapshotResult> {
  const snapshot = normalizedSnapshot(value);
  const identity = await transaction.database_identity.findUnique({
    where: { singleton_key: true }, select: { provider_id: true, database_role: true },
  });
  if (identity?.database_role !== "provider" || identity.provider_id !== snapshot.providerId) inputError();
  const [pack] = await transaction.$queryRaw<LockedPack[]>(Prisma.sql`
    select id, lifecycle, source_updated_at from packs
    where pack_key = ${snapshot.packKey} for update
  `);
  if (!pack || pack.lifecycle !== "active") inputError();
  const latest = await transaction.pack_content_snapshots.findFirst({
    where: { pack_id: pack.id }, orderBy: { effective_at: "desc" },
  });
  const effectiveAt = new Date(snapshot.effectiveAt);
  const digest = providerPackContentSnapshotDigest(snapshot);
  if (latest) {
    if (effectiveAt.getTime() < latest.effective_at.getTime()) return inert("ignored_older", latest.id);
    if (effectiveAt.getTime() === latest.effective_at.getTime()) {
      if (digest !== latest.snapshot_digest) throw new ProviderCanonicalWriteConflictError();
      return inert("replayed", latest.id);
    }
    if (latest.source_key !== snapshot.sourceKey) throw new ProviderCanonicalWriteConflictError();
  }
  // A saved catalog cannot overwrite knowledge in a newer canonical pack.
  if (effectiveAt.getTime() < pack.source_updated_at.getTime()) return inert("ignored_older", latest?.id ?? null);

  const [collectibles, instances, active] = await Promise.all([
    transaction.collectibles.findMany({
      where: { collectible_key: { in: snapshot.items.map((item) => item.collectibleKey) } },
      select: { id: true, collectible_key: true, lifecycle: true },
    }),
    transaction.collectible_instances.findMany({
      where: { instance_key: { in: snapshot.items.flatMap((item) => item.collectibleInstanceKey === null ? [] : [item.collectibleInstanceKey]) } },
      select: { id: true, instance_key: true, collectible_id: true, lifecycle: true },
    }),
    transaction.pack_contents.findMany({
      where: { pack_id: pack.id, lifecycle: "active" }, orderBy: { id: "asc" },
      take: MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS + 1,
    }),
  ]);
  if (active.length > MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS) inputError();
  const cardsByKey = new Map(collectibles.map((row) => [row.collectible_key, row]));
  const instancesByKey = new Map(instances.map((row) => [row.instance_key, row]));
  const resolved = snapshot.items.map((item) => {
    const card = cardsByKey.get(item.collectibleKey);
    const instance = item.collectibleInstanceKey === null ? null : instancesByKey.get(item.collectibleInstanceKey);
    const removed = item.status === "removed" || item.availableQuantity === "0";
    if (!card || (!removed && card.lifecycle !== "active") ||
      (item.collectibleInstanceKey !== null && (!instance || instance.collectible_id !== card.id || (!removed && instance.lifecycle !== "active")))) inputError();
    return { item, cardId: card.id, instanceId: instance?.id ?? null, removed };
  });
  const activeByKey = new Map(active.map((row) => [membershipKey(row.collectible_id, row.collectible_instance_id), row]));
  if (activeByKey.size !== active.length) throw new ProviderCanonicalWriteConflictError();
  const incoming = new Set(resolved.filter((row) => !row.removed).map((row) => membershipKey(row.cardId, row.instanceId)));
  const explicitRemovals = new Set(resolved.filter((row) => row.removed).map((row) => membershipKey(row.cardId, row.instanceId)));
  const retainedKeys = snapshot.completeness === "complete" ? incoming : new Set([
    ...[...activeByKey.keys()].filter((key) => !explicitRemovals.has(key)), ...incoming,
  ]);
  if (retainedKeys.size > MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS) inputError();
  const receipt = await transaction.pack_content_snapshots.create({ data: {
    id: randomUUID(), pack_id: pack.id, source_key: snapshot.sourceKey,
    effective_at: effectiveAt, effective_at_basis: snapshot.effectiveAtBasis,
    collected_at: new Date(snapshot.collectedAt), snapshot_digest: digest,
    completeness: snapshot.completeness, normalized_snapshot: snapshot as Prisma.InputJsonObject,
  } });
  const canonical = createProviderCanonicalTransaction(transaction);
  let firstSequence: bigint | null = null;
  let upsertedCount = 0;
  let retiredCount = 0;
  for (const row of active) {
    const key = membershipKey(row.collectible_id, row.collectible_instance_id);
    if (!explicitRemovals.has(key) && (snapshot.completeness !== "complete" || incoming.has(key))) continue;
    const result = await canonical.retirePackContent({ id: row.id, expectedRowVersion: row.row_version, retiredAt: effectiveAt });
    if (result.materialChange) {
      firstSequence ??= result.promotionSequence;
      retiredCount += 1;
    }
  }
  for (const row of resolved) {
    if (row.removed) continue;
    const prior = activeByKey.get(membershipKey(row.cardId, row.instanceId));
    const result = await canonical.upsertPackContent({
      packId: pack.id, collectibleId: row.cardId, collectibleInstanceId: row.instanceId,
      sourceSnapshotId: receipt.id,
      totalQuantity: row.item.totalQuantity === null ? null : BigInt(row.item.totalQuantity),
      availableQuantity: row.item.availableQuantity === null ? null : BigInt(row.item.availableQuantity),
      contentRole: row.item.contentRole, probability: row.item.probability,
      statedValueAmount: row.item.statedValueAmount, statedValueCurrency: row.item.statedValueCurrency,
      evidenceKinds: row.item.evidenceKinds, matchConfidenceBasisPoints: row.item.matchConfidenceBasisPoints,
      observedAt: effectiveAt, displayOrder: row.item.displayOrder, expectedRowVersion: prior?.row_version ?? 0n,
    });
    if (result.materialChange) {
      firstSequence ??= result.promotionSequence;
      upsertedCount += 1;
    }
  }
  const range = await appendPromotionRange(transaction, [{
    entityType: "pack_content_snapshot", entityId: receipt.id, entityVersion: 1n, operation: "upsert",
  }]);
  return {
    outcome: "applied", snapshotId: receipt.id, materialChange: true, upsertedCount, retiredCount,
    promotionRange: { first: firstSequence ?? range.first, last: range.last },
  };
}
