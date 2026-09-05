import type { ProviderTransactionClient } from "@packscout/database";
import type { ProviderContentProofCatalog } from "./provider-pack-content-proof.mts";

export interface DistributedClutchpacksContentCatalog extends ProviderContentProofCatalog {
  readonly aliasRows: readonly { readonly id: string; readonly rowVersion: bigint; readonly collectibleId: string; readonly displayName: string }[];
}
function refuse(): never { throw new Error("CLUTCHPACKS_MEMBERSHIP_PROOF_INVALID"); }

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
