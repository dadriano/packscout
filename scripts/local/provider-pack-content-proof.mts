import { canonicalJson, providerPackContentSnapshotV1Schema } from "@packscout/contracts";
import { normalizeMoneyDecimal, normalizeRateDecimal, providerPackContentSnapshotDigest } from "@packscout/database";
import type { DistributedProviderCollectibleInstanceRow, DistributedProviderCollectibleRow,
  DistributedProviderPackContentRow } from "@packscout/services";

export interface ProviderMembershipSnapshot {
  readonly id: string;
  readonly packId: string;
  readonly sourceKey: string;
  readonly effectiveAt: Date;
  readonly effectiveAtBasis: string;
  readonly collectedAt: Date;
  readonly snapshotDigest: string;
  readonly completeness: string;
  readonly normalizedSnapshot: unknown;
  readonly createdAt: Date;
}
export interface ProviderContentProofCatalog {
  readonly memberships: readonly (DistributedProviderPackContentRow & { readonly sourceSnapshotId: string | null })[];
  readonly collectibles: readonly DistributedProviderCollectibleRow[];
  readonly instances: readonly DistributedProviderCollectibleInstanceRow[];
  readonly snapshots: readonly ProviderMembershipSnapshot[];
}

function refuse(): never { throw new Error("PROVIDER_CONTENT_SNAPSHOT_INVALID"); }
const itemKey = (collectibleKey: string, instanceKey: string | null) => JSON.stringify([collectibleKey, instanceKey]);

/** Verifies the retained body, exact membership source and latest snapshot semantics. */
export function validateProviderContentCatalog(input: {
  readonly providerId: string;
  readonly settledAt: Date;
  readonly packs: readonly { readonly id: string; readonly packKey: string }[];
  readonly catalog: ProviderContentProofCatalog;
}): ReadonlyMap<string, "complete" | "partial"> {
  const packById = new Map(input.packs.map((pack) => [pack.id, pack]));
  const cards = new Map(input.catalog.collectibles.map((row) => [row.id, row]));
  const instances = new Map(input.catalog.instances.map((row) => [row.id, row]));
  const snapshots = new Map<string, { row: ProviderMembershipSnapshot; body: ReturnType<typeof providerPackContentSnapshotV1Schema.parse> }>();
  const latest = new Map<string, string>();
  const ceiling = input.settledAt.getTime();
  for (const row of input.catalog.snapshots) {
    // Adapter and mapper versions have one source of truth: the validated,
    // digest-bound normalized body. There are no parallel version columns.
    const body = providerPackContentSnapshotV1Schema.parse(row.normalizedSnapshot);
    if (snapshots.has(row.id) || body.providerId !== input.providerId || body.packKey !== packById.get(row.packId)?.packKey ||
        body.sourceKey !== row.sourceKey ||
        body.effectiveAt !== row.effectiveAt.toISOString() || body.effectiveAtBasis !== row.effectiveAtBasis ||
        body.collectedAt !== row.collectedAt.toISOString() || body.completeness !== row.completeness ||
        providerPackContentSnapshotDigest(body) !== row.snapshotDigest || row.collectedAt.getTime() > ceiling || row.createdAt.getTime() > ceiling) return refuse();
    snapshots.set(row.id, { row, body });
    const previousId = latest.get(row.packId);
    const previous = previousId === undefined ? undefined : snapshots.get(previousId);
    if (previous !== undefined && previous.row.effectiveAt.getTime() === row.effectiveAt.getTime()) return refuse();
    if (previous === undefined || previous.row.effectiveAt < row.effectiveAt) latest.set(row.packId, row.id);
  }
  const membershipsByPack = new Map<string, Map<string, typeof input.catalog.memberships[number]>>();
  for (const row of input.catalog.memberships) {
    const source = row.sourceSnapshotId === null ? undefined : snapshots.get(row.sourceSnapshotId);
    const card = cards.get(row.collectibleId);
    const instance = row.collectibleInstanceId === null ? null : instances.get(row.collectibleInstanceId);
    if (source === undefined || source.row.packId !== row.packId || card === undefined || instance === undefined ||
        (instance !== null && instance.collectibleId !== row.collectibleId) || row.observedAt.toISOString() !== source.body.effectiveAt) return refuse();
    const key = itemKey(card.collectibleKey, instance?.instanceKey ?? null);
    const item = source.body.items.find((item) => itemKey(item.collectibleKey, item.collectibleInstanceKey) === key);
    if (item === undefined || item.status !== "present" || item.availableQuantity === "0") return refuse();
    const normalized = {
      totalQuantity: item.totalQuantity, availableQuantity: item.availableQuantity, contentRole: item.contentRole,
      probability: item.probability === null ? null : normalizeRateDecimal(item.probability),
      statedValueAmount: item.statedValueAmount === null ? null : normalizeMoneyDecimal(item.statedValueAmount),
      statedValueCurrency: item.statedValueCurrency, evidenceKinds: [...item.evidenceKinds].sort(),
      matchConfidenceBasisPoints: item.matchConfidenceBasisPoints, displayOrder: item.displayOrder,
    };
    const projected = {
      totalQuantity: row.totalQuantity?.toString() ?? null, availableQuantity: row.availableQuantity?.toString() ?? null,
      contentRole: row.contentRole, probability: row.probability === null ? null : normalizeRateDecimal(row.probability),
      statedValueAmount: row.statedValueAmount === null ? null : normalizeMoneyDecimal(row.statedValueAmount),
      statedValueCurrency: row.statedValueCurrency, evidenceKinds: [...row.evidenceKinds].sort(),
      matchConfidenceBasisPoints: row.matchConfidenceBasisPoints, displayOrder: row.displayOrder,
    };
    if (canonicalJson(normalized) !== canonicalJson(projected)) return refuse();
    const map = membershipsByPack.get(row.packId) ?? new Map();
    if (map.has(key)) return refuse();
    map.set(key, row); membershipsByPack.set(row.packId, map);
  }
  const evidence = new Map<string, "complete" | "partial">();
  for (const [packId, snapshotId] of latest) {
    const { body } = snapshots.get(snapshotId)!;
    const active = membershipsByPack.get(packId) ?? new Map();
    const present = new Set<string>();
    for (const item of body.items) {
      const key = itemKey(item.collectibleKey, item.collectibleInstanceKey);
      const membership = active.get(key);
      if (item.status === "removed" || item.availableQuantity === "0") {
        if (membership !== undefined) return refuse();
      } else {
        present.add(key);
        if (membership?.sourceSnapshotId !== snapshotId) return refuse();
      }
    }
    if (body.completeness === "complete" && [...active.keys()].some((key) => !present.has(key))) return refuse();
    evidence.set(packId, body.completeness);
  }
  return evidence;
}

