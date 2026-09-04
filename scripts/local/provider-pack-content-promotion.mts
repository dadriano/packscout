import type { Client } from "pg";
import type { PublicCollectible, PublicRepackDetailV3 } from "@packscout/contracts";
import {
  projectProvisionalProviderPackContentsV3,
  type DistributedProviderPackContentRow,
} from "@packscout/services";
import { validateProviderContentCatalog, type ProviderContentProofCatalog } from "./provider-pack-content-proof.mts";

export type { ProviderContentProofCatalog } from "./provider-pack-content-proof.mts";

/** The caller supplies its existing repeatable, read-only provider transaction. */
export async function readProviderPackContents(client: Client, packIds: readonly string[]): Promise<ProviderContentProofCatalog> {
  const memberships = await client.query(`select pc.id, pc.row_version::text as "rowVersion",
    pc.pack_id as "packId", pc.collectible_id as "collectibleId", pc.collectible_instance_id as "collectibleInstanceId",
    pc.total_quantity::text as "totalQuantity", pc.available_quantity::text as "availableQuantity",
    pc.content_role as "contentRole", pc.probability::text, pc.stated_value_amount::text as "statedValueAmount",
    pc.stated_value_currency as "statedValueCurrency", pc.evidence_kinds as "evidenceKinds",
    pc.match_confidence_basis_points as "matchConfidenceBasisPoints", pc.match_confidence_band as "matchConfidenceBand",
    pc.observed_at as "observedAt", pc.display_order as "displayOrder", pc.source_snapshot_id as "sourceSnapshotId"
    from pack_contents pc
    where pc.lifecycle='active' and pc.pack_id=any($1::uuid[]) order by pc.id limit 50001`, [packIds]);
  if (memberships.rows.length > 50000 || memberships.rows.some(row => row.sourceSnapshotId === null)) {
    throw new Error("PROVIDER_CONTENT_SNAPSHOT_INVALID");
  }
  const content = memberships.rows.map(row => ({
    ...row, rowVersion: BigInt(row.rowVersion),
    totalQuantity: row.totalQuantity === null ? null : BigInt(row.totalQuantity),
    availableQuantity: row.availableQuantity === null ? null : BigInt(row.availableQuantity),
  })) as (DistributedProviderPackContentRow & { sourceSnapshotId: string | null })[];
  const ids = [...new Set(content.map(row => row.collectibleId))];
  const cards = await client.query(`select c.id, c.row_version::text as "rowVersion", c.collectible_key as "collectibleKey",
    c.collectible_type as "collectibleType", c.display_name as "displayName", c.year,c.brand,c.set_or_series as "setOrSeries",
    c.card_number as "cardNumber",c.reference_number as "referenceNumber",c.subject,c.grade,c.grader,
    c.primary_image_url as "primaryImageUrl",c.primary_image_alt as "primaryImageAlt",
    c.valuation_amount::text as "valuationAmount",c.valuation_currency as "valuationCurrency",
    c.valuation_usd_amount::text as "valuationUsdAmount",c.valuation_unavailable_reason as "valuationUnavailableReason",
    c.valuation_type as "valuationType",c.valuation_observed_at as "valuationObservedAt",c.data_as_of as "dataAsOf",
    coalesce((select array_agg(a.display_name order by a.display_name) from collectible_name_aliases a where a.collectible_id=c.id and a.lifecycle='active'), '{}') as aliases
    from collectibles c where c.lifecycle='active' and c.id=any($1::uuid[]) order by c.id`, [ids]);
  const instanceIds = [...new Set(content.flatMap(row => row.collectibleInstanceId === null ? [] : [row.collectibleInstanceId]))];
  const instances = await client.query(`select id,row_version::text as "rowVersion",collectible_id as "collectibleId",
    instance_key as "instanceKey",certifier,certification_number as "certificationNumber"
    from collectible_instances where lifecycle='active' and id=any($1::uuid[]) order by id`, [instanceIds]);
  const snapshotIds = [...new Set(content.flatMap(row => row.sourceSnapshotId === null ? [] : [row.sourceSnapshotId]))];
  const snapshots = await client.query(`with latest as (
    select distinct on (pack_id) id from pack_content_snapshots
    where pack_id=any($1::uuid[]) order by pack_id,effective_at desc
  ) select id,pack_id as "packId",source_key as "sourceKey",effective_at as "effectiveAt",
    effective_at_basis as "effectiveAtBasis",collected_at as "collectedAt",snapshot_digest as "snapshotDigest",
    completeness,normalized_snapshot as "normalizedSnapshot",created_at as "createdAt"
    from pack_content_snapshots where id=any($2::uuid[]) or id in (select id from latest) order by id`, [packIds, snapshotIds]);
  return {
    memberships: content,
    collectibles: cards.rows.map(row => ({ ...row, rowVersion: BigInt(row.rowVersion),
      valuationUnavailableReason: row.valuationUnavailableReason === "source_unavailable" ? "VALUATION_UNAVAILABLE" : row.valuationUnavailableReason,
    })),
    instances: instances.rows.map(row => ({ ...row, rowVersion: BigInt(row.rowVersion) })),
    snapshots: snapshots.rows,
  };
}

export function projectProviderPackContents(input: {
  providerId: string; platformKey: string; readAt: string; publicAssetOrigins: readonly string[];
  packs: readonly { id: string; pack_key: string; row_version: string }[];
  repacks: readonly PublicRepackDetailV3[]; identity(name: string): string; contents: ProviderContentProofCatalog;
}) {
  const evidence = validateProviderContentCatalog({ providerId: input.providerId, settledAt: new Date(input.readAt),
    packs: input.packs.map(row => ({ id: row.id, packKey: row.pack_key })), catalog: input.contents });
  const byPublicId = new Map(input.repacks.map(row => [row.publicRepackId, row]));
  const allPacks = input.packs.flatMap(row => {
    const detail = byPublicId.get(input.identity(`repack:${input.platformKey}:${row.pack_key}`));
    return detail === undefined ? [] : [{ id: row.id, rowVersion: BigInt(row.row_version), packKey: row.pack_key, detail,
      evidenceCompleteness: evidence.get(row.id) ?? "unknown" as const }];
  });
  if (allPacks.length === 0) {
    return { repacks: input.repacks, collectibles: [], repackChases: [] };
  }
  const packIds = new Set(allPacks.map(row => row.id));
  const memberships = input.contents.memberships.filter(row => packIds.has(row.packId));
  const memberPackIds = new Set(memberships.map(row => row.packId));
  const packs = allPacks.filter(row => memberPackIds.has(row.id) || evidence.has(row.id));
  if (packs.length === 0) return { repacks: input.repacks, collectibles: [], repackChases: [] };
  const cardIds = new Set(memberships.map(row => row.collectibleId));
  const instanceIds = new Set(memberships.map(row => row.collectibleInstanceId));
  const projected = projectProvisionalProviderPackContentsV3({ identityPolicy: "provider_provisional_v1",
    providerId: input.providerId, platformKey: input.platformKey, snapshotAt: new Date(input.readAt),
    publicAssetOrigins: input.publicAssetOrigins, packs, memberships,
    collectibles: input.contents.collectibles.filter(row => cardIds.has(row.id)),
    instances: input.contents.instances.filter(row => instanceIds.has(row.id)),
  });
  const byId = new Map(projected.repacks.map(row => [row.publicRepackId, row]));
  return { ...projected, repacks: input.repacks.map(row => byId.get(row.publicRepackId) ?? row) };
}

/** Re-promotion replaces the same canonical identity, preserving unrelated cards. */
export function mergePromotedCollectibles(carried: readonly PublicCollectible[], promoted: readonly PublicCollectible[]) {
  const rows = new Map(carried.map(row => [row.publicCollectibleId, row]));
  for (const row of promoted) rows.set(row.publicCollectibleId, row);
  return [...rows.values()];
}
