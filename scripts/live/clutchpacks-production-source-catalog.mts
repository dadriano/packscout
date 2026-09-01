import type { ProviderTransactionClient } from "@packscout/database";
import { readClutchpacksContentCatalog } from "../local/distributed-clutchpacks-content-snapshot.mts";
import { loadPackContentBackfillReadiness } from "../local/pack-content-backfill-readiness.mts";
import { assertDistributedClutchpacksStableSnapshot, type DistributedClutchpacksPackRow,
  type DistributedClutchpacksSnapshotFacts } from "../local/distributed-clutchpacks-publication-plan.mts";
import { refuseSource, sourceDigest, type ClutchpacksProductionSourceOptions, type ProductionSourceAuthority } from "./clutchpacks-production-source-policy.mts";
import type { ProductionSourceState } from "./clutchpacks-production-source-state.mts";

const LIMIT = { categories: 5_000, packs: 5_000, collectibles: 20_000, aliases: 50_000 } as const;
function requireText(value: string | null): string {
  if (!value || !value.trim() || /[\r\n\0]/u.test(value)) refuseSource("PRODUCTION_SOURCE_CATALOG_FIELD_INVALID");
  return value;
}
function validateUrl(value: string | null, origins?: readonly string[]) {
  if (value === null) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || origins && !origins.includes(url.origin)) throw new Error();
  } catch { refuseSource("PRODUCTION_SOURCE_CATALOG_URL_INVALID"); }
}

/** Full canonical rows, including non-membership cards. Bounds refuse overflow; they never truncate a publication. */
export async function readProductionSourceCatalog(tx: ProviderTransactionClient, input: ClutchpacksProductionSourceOptions,
  authority: ProductionSourceAuthority, state: ProductionSourceState) {
  const [categories, packs, collectibles, aliases, counts, promotionAggregate] = await Promise.all([
    tx.categories.findMany({ orderBy: { id: "asc" }, take: LIMIT.categories + 1 }),
    tx.packs.findMany({ where: { lifecycle: "active" }, orderBy: [{ pack_key: "asc" }, { id: "asc" }], take: LIMIT.packs + 1 }),
    tx.collectibles.findMany({ where: { lifecycle: "active" }, orderBy: { id: "asc" }, take: LIMIT.collectibles + 1 }),
    tx.collectible_name_aliases.findMany({ where: { lifecycle: "active", collectible: { lifecycle: "active" } }, orderBy: { id: "asc" }, take: LIMIT.aliases + 1 }),
    Promise.all([tx.categories.count(), tx.packs.count({ where: { lifecycle: "active" } }),
      tx.collectibles.count({ where: { lifecycle: "active" } }),
      tx.collectible_name_aliases.count({ where: { lifecycle: "active", collectible: { lifecycle: "active" } } }),
      tx.pack_contents.count({ where: { lifecycle: "active" } })]),
    tx.promotion_changes.aggregate({ _count: { _all: true }, _min: { sequence: true }, _max: { sequence: true, changed_at: true } }),
  ]);
  const rows = [categories, packs, collectibles, aliases];
  if (rows.some((entries, index) => entries.length > Object.values(LIMIT)[index]! || entries.length !== counts[index]) || !packs.length) {
    refuseSource("PRODUCTION_SOURCE_CATALOG_BOUND_OR_COUNT");
  }
  const categoryIds = new Set(categories.map(row => row.id)), cardIds = new Set(collectibles.map(row => row.id));
  if (categories.some(row => row.parent_category_id !== null && !categoryIds.has(row.parent_category_id)) ||
    [...packs, ...collectibles].some(row => row.category_id !== null && !categoryIds.has(row.category_id)) ||
    aliases.some(row => !cardIds.has(row.collectible_id))) refuseSource("PRODUCTION_SOURCE_CATEGORY_OR_ALIAS_REFERENCE_INVALID");
  for (const row of [...categories, ...packs, ...collectibles, ...aliases]) requireText(row.display_name);
  for (const row of [...packs, ...collectibles]) validateUrl(row.primary_image_url, input.approvedPublicAssetOrigins);
  for (const row of packs) validateUrl(row.listing_url);
  const mappedPacks: DistributedClutchpacksPackRow[] = packs.map(pack => ({
    id: pack.id, rowVersion: pack.row_version, packKey: pack.pack_key, displayName: pack.display_name,
    description: pack.description, packFormat: pack.pack_format, availability: pack.availability, contentEvidence: pack.content_evidence,
    priceAmount: requireText(pack.price_amount?.toString() ?? null), priceCurrency: requireText(pack.price_currency),
    priceUsdAmount: requireText(pack.price_usd_amount?.toString() ?? null), buybackRate: pack.buyback_rate?.toString() ?? null,
    buybackSourceKind: pack.buyback_source_kind, vendorEvAmount: pack.vendor_ev_amount?.toString() ?? null,
    vendorEvCurrency: pack.vendor_ev_currency, vendorEvObservedAt: pack.vendor_ev_observed_at,
    packscoutEvModelVersion: pack.packscout_ev_model_version, packscoutEvConfidencePolicyVersion: pack.packscout_ev_confidence_policy_version,
    packscoutEvDataAsOf: pack.packscout_ev_data_as_of, packscoutEvCalculatedAt: pack.packscout_ev_calculated_at,
    primaryImageUrl: requireText(pack.primary_image_url), primaryImageAlt: pack.primary_image_alt, listingUrl: pack.listing_url,
    sourceUpdatedAt: pack.source_updated_at,
    ...(typeof pack.attributes === "object" && pack.attributes !== null && !Array.isArray(pack.attributes) && Object.hasOwn(pack.attributes, "evInputEvidence")
      ? { evInputEvidence: pack.attributes.evInputEvidence } : {}),
  }));
  const p = input.scope, provider = authority.provider, config = provider.active_config_version!;
  const [contentCatalog, readiness] = await Promise.all([
    readClutchpacksContentCatalog(tx, packs.map(pack => pack.id)),
    loadPackContentBackfillReadiness(tx, { organizationId: p.organizationId, providerId: p.providerId,
      configVersionId: p.configVersionId, configVersionNumber: p.configVersionNumber,
      sourceHeadRunId: state.run.id, sourceHeadFinishedAt: state.run.finished_at!, sourceCheckpointHash: input.expected.checkpointHash,
      sourceGeneration: state.runtime.state_generation, importLeaseFence: state.lease.lease_fence, promotionSequence: state.ledger.last_sequence }),
  ]);
  const maximumPackSourceUpdatedAt = packs.reduce((latest, pack) => pack.source_updated_at > latest ? pack.source_updated_at : latest, packs[0]!.source_updated_at);
  const facts: DistributedClutchpacksSnapshotFacts = {
    organizationId: p.organizationId, providerId: p.providerId, providerKey: p.providerKey, providerDisplayName: provider.display_name,
    providerLifecycle: provider.lifecycle, activeConfigVersionId: p.configVersionId, activeConfigVersionNumber: p.configVersionNumber,
    activeConfigCreatedAt: config.created_at, staleAfterSeconds: config.stale_after_seconds,
    providerIdentityId: p.providerId, providerIdentityKey: p.providerKey, runtimeProviderId: state.runtime.central_provider_id,
    runtimeProviderKey: state.runtime.provider_key, runtimeState: state.runtime.operating_state,
    runtimeConfigVersionId: state.runtime.cached_config_version_id, runtimeConfigVersionNumber: state.runtime.cached_config_version_number,
    runningRunCount: 0, queuedRunCount: 0, activeImportLeaseCount: 0,
    latestSourceHeadRunId: state.run.id, latestSourceHeadConfigVersionId: state.run.config_version_id,
    latestSourceHeadConfigVersionNumber: state.run.config_version_number, latestSourceHeadFinishedAt: state.run.finished_at!,
    catalogSettledAt: readiness.settledAt, catalogBackfillProofDigest: readiness.digest,
    approvedPublicAssetOrigins: input.approvedPublicAssetOrigins, contentCatalog,
    promotionSequence: state.ledger.last_sequence, promotionChangeCount: BigInt(promotionAggregate._count._all),
    minimumPromotionSequence: promotionAggregate._min.sequence, maximumPromotionSequence: promotionAggregate._max.sequence,
    maximumPromotionChangedAt: promotionAggregate._max.changed_at, activePackCount: counts[1]!, activeCollectibleCount: counts[2]!,
    activePackContentCount: counts[4]!, maximumPackSourceUpdatedAt, packs: mappedPacks,
  };
  // Reuse retained evidence validation; do not export the local helper's manufactured public epoch/checkpoint.
  assertDistributedClutchpacksStableSnapshot(facts);
  const canonicalCatalog = { categories, packs, collectibles, aliases };
  return { facts, canonicalCatalog, catalogDigest: sourceDigest({ facts, canonicalCatalog }) };
}
export type ClutchpacksProductionSourceCatalog = Awaited<ReturnType<typeof readProductionSourceCatalog>>;
