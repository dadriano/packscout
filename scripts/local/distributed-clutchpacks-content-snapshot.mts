import { canonicalJson, providerPackContentSnapshotV1Schema } from "@packscout/contracts";
import {
  normalizeMoneyDecimal,
  normalizeRateDecimal,
  providerPackContentSnapshotDigest,
  type ProviderTransactionClient,
} from "@packscout/database";
import type {
  DistributedProviderCollectibleInstanceRow,
  DistributedProviderCollectibleRow,
  DistributedProviderPackContentRow,
} from "@packscout/services";

export interface DistributedClutchpacksMembershipSnapshot {
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
export interface DistributedClutchpacksContentCatalog {
  readonly memberships: readonly (DistributedProviderPackContentRow & { readonly sourceSnapshotId: string | null })[];
  readonly collectibles: readonly DistributedProviderCollectibleRow[];
  readonly instances: readonly DistributedProviderCollectibleInstanceRow[];
  readonly snapshots: readonly DistributedClutchpacksMembershipSnapshot[];
  readonly aliasRows: readonly { readonly id: string; readonly rowVersion: bigint; readonly collectibleId: string; readonly displayName: string }[];
}

function refuse(): never { throw new Error("CLUTCHPACKS_MEMBERSHIP_PROOF_INVALID"); }
const itemKey = (collectibleKey: string, instanceKey: string | null) => JSON.stringify([collectibleKey, instanceKey]);

/** Provider source provenance maps deliberately onto the public valuation vocabulary. */
export function clutchpacksPublicValuationFields(input: {
  readonly valuationType: string | null;
  readonly valuationUnavailableReason: string | null;
}): { valuationType: string | null; valuationUnavailableReason: string | null } {
  return {
    valuationType: input.valuationType === "clutchpacks_formatted_current_price" ? "vendor_reported" : input.valuationType,
    valuationUnavailableReason: input.valuationUnavailableReason === "source_unavailable" ? "VALUATION_UNAVAILABLE" : input.valuationUnavailableReason,
  };
}

/** Verifies the retained body, exact membership source and latest snapshot semantics. */
export function validateClutchpacksContentCatalog(input: {
  readonly providerId: string;
  readonly settledAt: Date;
  readonly packs: readonly { readonly id: string; readonly packKey: string }[];
  readonly catalog: DistributedClutchpacksContentCatalog;
}): ReadonlyMap<string, "complete" | "partial"> {
  const packById = new Map(input.packs.map((pack) => [pack.id, pack]));
  const cards = new Map(input.catalog.collectibles.map((row) => [row.id, row]));
  const instances = new Map(input.catalog.instances.map((row) => [row.id, row]));
  const snapshots = new Map<string, { row: DistributedClutchpacksMembershipSnapshot; body: ReturnType<typeof providerPackContentSnapshotV1Schema.parse> }>();
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

export function stableClutchpacksContentCatalog(catalog: DistributedClutchpacksContentCatalog): unknown {
  const normalize = (value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
    return value;
  };
  return normalize(catalog);
}

export async function readClutchpacksContentCatalog(
  transaction: ProviderTransactionClient,
  packIds: readonly string[],
): Promise<DistributedClutchpacksContentCatalog> {
  const [memberships, latest] = await Promise.all([
    transaction.pack_contents.findMany({ where: { lifecycle: "active" }, orderBy: { id: "asc" }, take: 5_001 }),
    transaction.packs.findMany({ where: { id: { in: [...packIds] } }, select: {
      id: true, content_snapshots: { orderBy: { effective_at: "desc" }, take: 1 },
    } }),
  ]);
  if (memberships.length > 5_000 || memberships.some((row) => !packIds.includes(row.pack_id))) return refuse();
  const [cards, instances, snapshots] = await Promise.all([
    transaction.collectibles.findMany({ where: { id: { in: memberships.map(({ collectible_id }) => collectible_id) }, lifecycle: "active" },
      orderBy: { id: "asc" }, include: { aliases: { where: { lifecycle: "active" }, orderBy: { id: "asc" } } } }),
    transaction.collectible_instances.findMany({ where: { id: { in: memberships.flatMap(({ collectible_instance_id }) => collectible_instance_id === null ? [] : [collectible_instance_id]) }, lifecycle: "active" }, orderBy: { id: "asc" } }),
    transaction.pack_content_snapshots.findMany({ where: { id: { in: [...new Set([
      ...memberships.flatMap(({ source_snapshot_id }) => source_snapshot_id === null ? [] : [source_snapshot_id]),
      ...latest.flatMap(({ content_snapshots }) => content_snapshots.map(({ id }) => id)),
    ])] } }, orderBy: { id: "asc" } }),
  ]);
  return {
    memberships: memberships.map((row) => ({
      id: row.id, rowVersion: row.row_version, packId: row.pack_id, collectibleId: row.collectible_id,
      collectibleInstanceId: row.collectible_instance_id, sourceSnapshotId: row.source_snapshot_id,
      totalQuantity: row.total_quantity, availableQuantity: row.available_quantity, contentRole: row.content_role,
      probability: row.probability?.toString() ?? null, statedValueAmount: row.stated_value_amount?.toString() ?? null,
      statedValueCurrency: row.stated_value_currency, evidenceKinds: row.evidence_kinds,
      matchConfidenceBasisPoints: row.match_confidence_basis_points, matchConfidenceBand: row.match_confidence_band,
      observedAt: row.observed_at, displayOrder: row.display_order,
    })),
    collectibles: cards.map((row) => ({
      id: row.id, rowVersion: row.row_version, collectibleKey: row.collectible_key, collectibleType: row.collectible_type,
      displayName: row.display_name, aliases: row.aliases.map(({ display_name }) => display_name),
      year: row.year, brand: row.brand, setOrSeries: row.set_or_series, cardNumber: row.card_number,
      referenceNumber: row.reference_number, subject: row.subject, grade: row.grade, grader: row.grader,
      primaryImageUrl: row.primary_image_url, primaryImageAlt: row.primary_image_alt,
      valuationAmount: row.valuation_amount?.toString() ?? null, valuationCurrency: row.valuation_currency,
      valuationUsdAmount: row.valuation_usd_amount?.toString() ?? null,
      ...clutchpacksPublicValuationFields({ valuationType: row.valuation_type, valuationUnavailableReason: row.valuation_unavailable_reason }),
      valuationObservedAt: row.valuation_observed_at, dataAsOf: row.data_as_of,
    })),
    instances: instances.map((row) => ({ id: row.id, rowVersion: row.row_version, collectibleId: row.collectible_id,
      instanceKey: row.instance_key, certifier: row.certifier, certificationNumber: row.certification_number })),
    snapshots: snapshots.map((row) => ({ id: row.id, packId: row.pack_id, sourceKey: row.source_key,
      effectiveAt: row.effective_at,
      effectiveAtBasis: row.effective_at_basis, collectedAt: row.collected_at, snapshotDigest: row.snapshot_digest,
      completeness: row.completeness, normalizedSnapshot: row.normalized_snapshot, createdAt: row.created_at })),
    aliasRows: cards.flatMap(({ aliases }) => aliases.map((row) => ({ id: row.id, rowVersion: row.row_version,
      collectibleId: row.collectible_id, displayName: row.display_name }))),
  };
}
