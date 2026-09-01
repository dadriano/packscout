import {
  approvedPublicCatalogConfigurationV1Schema, publicRepackDetailSchema,
  type ApprovedPublicCatalogConfigurationV1,
} from "@packscout/contracts";
import {
  DataReleaseV3ReleaseAssembler, configuredPublicRepackLink,
  createPackScoutBuybackEvPromotionEligibilityV1, normalizeClutchpacksPromotionEvEvidenceV1,
  projectApprovedProviderPackContentsV1,
} from "@packscout/services";
import {
  buybackV2, decimalTextToScaledInteger, money, vendorEvV2, v3Product,
  type DistributedClutchpacksSnapshotFacts,
} from "../local/distributed-clutchpacks-publication-plan.mts";
import { validateClutchpacksContentCatalog } from "../local/distributed-clutchpacks-content-snapshot.mts";
import { clutchpacksCategoryConfiguration, uuidV5 } from "../local/generate-clutchpacks-v3-public-catalog-candidate.mts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface ClutchpacksProductionSnapshot { readonly facts: DistributedClutchpacksSnapshotFacts }
function refuse(): never { throw new Error("CLUTCHPACKS_PRODUCTION_CATALOG_INVALID"); }
/** Source prefixes are canonical provider keys, not an entity-matching heuristic. */
function externalId(key: string, prefix: "pack" | "card"): string {
  if (!key.startsWith(`${prefix}:`)) return refuse();
  const value = key.slice(prefix.length + 1);
  if (!UUID.test(value)) return refuse();
  return value;
}
export interface ClutchpacksProductionCategoryEvidence {
  readonly packs: ReadonlyMap<string, string | null>;
  readonly collectibles: ReadonlyMap<string, string | null>;
}

/** Verify every retained mapping against the recovered namespace before deriving successors. */
export function verifyClutchpacksProductionIdentityNamespace(
  baseline: ApprovedPublicCatalogConfigurationV1, namespaceUuid: string,
): void {
  if (!UUID.test(namespaceUuid) || baseline.platforms.length !== 1 ||
    baseline.platforms[0]!.platformKey !== "clutchpacks" || baseline.platforms[0]!.vendor.publicVendorId !==
      uuidV5(namespaceUuid, "vendor\0clutchpacks")) return refuse();
  for (const row of baseline.repacks) {
    if (row.platformKey !== "clutchpacks" || row.publicRepackId !==
      uuidV5(namespaceUuid, `repack\0clutchpacks\0${row.packExternalId}`)) return refuse();
  }
  for (const row of baseline.collectibles) {
    if (row.platformKey !== "clutchpacks" || row.publicCollectibleId !==
      uuidV5(namespaceUuid, `collectible\0clutchpacks\0${row.externalId}`)) return refuse();
  }
  for (const row of baseline.categories) {
    if (row.publicCategoryId !== uuidV5(namespaceUuid, `category\0${row.categoryKey}`)) return refuse();
  }
}

export function buildClutchpacksProductionConfiguration(input: {
  readonly baseline: unknown; readonly namespaceUuid: string;
  readonly snapshot: ClutchpacksProductionSnapshot;
  readonly categoryEvidence: ClutchpacksProductionCategoryEvidence; readonly approvedAt: string;
}): ApprovedPublicCatalogConfigurationV1 {
  const baseline = approvedPublicCatalogConfigurationV1Schema.parse(input.baseline);
  verifyClutchpacksProductionIdentityNamespace(baseline, input.namespaceUuid);
  const { facts } = input.snapshot;
  const categories = clutchpacksCategoryConfiguration(input.namespaceUuid, [
    ...facts.packs.map(pack => ({ externalId: pack.packKey, content: {
      category: input.categoryEvidence.packs.has(pack.packKey) ? input.categoryEvidence.packs.get(pack.packKey) : refuse(),
    } })),
    ...facts.contentCatalog.collectibles.map(card => ({ externalId: card.collectibleKey, content: {
      category: input.categoryEvidence.collectibles.has(card.collectibleKey) ? input.categoryEvidence.collectibles.get(card.collectibleKey) : refuse(),
    } })),
  ]);
  const vendor = baseline.platforms[0]!.vendor;
  if (vendor.websiteUrl !== "https://clutchpacks.io/" || vendor.listingHosts.length !== 1 ||
    vendor.listingHosts[0] !== "clutchpacks.io" || facts.approvedPublicAssetOrigins.some(origin =>
      !baseline.publicAssetOrigins.includes(origin))) return refuse();
  return approvedPublicCatalogConfigurationV1Schema.parse({ ...baseline,
    configurationKey: "clutchpacks-neon-production-v1",
    revision: Number(facts.promotionSequence), approvedAt: input.approvedAt,
    staleAfterSeconds: facts.staleAfterSeconds,
    categories: categories.categories,
    platforms: [{ ...baseline.platforms[0], categoryMappings: categories.categoryMappings }],
    repacks: facts.packs.map(pack => {
      const id = externalId(pack.packKey, "pack");
      // Original catalog external IDs are raw provider UUIDs. This assertion
      // prevents accidentally switching the UUIDv5 name to the new storage key.
      const previous = baseline.repacks.find(row => row.packExternalId === id);
      const publicRepackId = uuidV5(input.namespaceUuid, `repack\0clutchpacks\0${id}`);
      if (previous !== undefined && previous.publicRepackId !== publicRepackId) return refuse();
      return { platformKey: "clutchpacks", packExternalId: pack.packKey, publicRepackId,
        listingUrl: `https://clutchpacks.io/checkout/${id}/` };
    }).sort((left, right) => left.packExternalId.localeCompare(right.packExternalId)),
    collectibles: facts.contentCatalog.collectibles.map(card => ({
      platformKey: "clutchpacks", externalId: card.collectibleKey,
      publicCollectibleId: uuidV5(input.namespaceUuid, `collectible\0clutchpacks\0${externalId(card.collectibleKey, "card")}`),
      aliases: [...card.aliases].sort(), collectibleType: card.collectibleType,
      publicCategoryIds: categories.publicCategoryIdsForSourceValue(input.categoryEvidence.collectibles.get(card.collectibleKey) ?? null),
      year: card.year, brand: card.brand, setOrSeries: card.setOrSeries, cardNumber: card.cardNumber,
      referenceNumber: card.referenceNumber, subject: card.subject, grade: card.grade, grader: card.grader,
      probabilityBucketId: null, matchConfidenceBasisPoints: 10_000, chaseEvidenceKinds: ["packscout_resolved"],
    })).sort((left, right) => left.externalId.localeCompare(right.externalId)),
  });
}

/** Build only from one fenced provider snapshot and explicit approved identities. */
export async function buildClutchpacksProductionPlan(input: {
  readonly snapshot: ClutchpacksProductionSnapshot;
  readonly configuration: ApprovedPublicCatalogConfigurationV1;
  readonly categoryEvidence: ClutchpacksProductionCategoryEvidence; readonly readAt: string;
}) {
  const { facts } = input.snapshot;
  const configuration = approvedPublicCatalogConfigurationV1Schema.parse(input.configuration);
  if (configuration.platforms.length !== 1 || configuration.platforms[0]!.platformKey !== "clutchpacks" ||
    !Number.isFinite(Date.parse(input.readAt)) || Date.parse(input.readAt) < facts.catalogSettledAt.getTime()) return refuse();
  const platform = configuration.platforms[0]!;
  const packs = [...facts.packs].sort((a, b) => a.packKey.localeCompare(b.packKey));
  const evidence = validateClutchpacksContentCatalog({ providerId: facts.providerId,
    settledAt: facts.catalogSettledAt, packs, catalog: facts.contentCatalog });
  const details = packs.map(pack => {
    const identity = configuration.repacks.find(row => row.packExternalId === pack.packKey);
    if (identity === undefined || identity.platformKey !== "clutchpacks") return refuse();
    const sourceCategory = input.categoryEvidence.packs.get(pack.packKey);
    if (sourceCategory === undefined) return refuse();
    const categoryIds = sourceCategory === null ? [] : platform.categoryMappings.find(row => row.sourceValue === sourceCategory)?.publicCategoryIds;
    if (categoryIds === undefined) return refuse();
    const categories = configuration.categories.filter(row => categoryIds.includes(row.publicCategoryId))
      .map(row => ({ publicCategoryId: row.publicCategoryId, label: row.name }));
    const repackLink = configuredPublicRepackLink({ identity, platform, available: pack.availability === "available" });
    return publicRepackDetailSchema.parse({
      publicRepackId: identity.publicRepackId, publicVendorId: platform.vendor.publicVendorId,
      vendorKey: "clutchpacks", vendorDisplayName: platform.vendor.displayName, vendorLogoUrl: platform.vendor.logoUrl,
      name: pack.displayName, format: pack.packFormat, contentMode: "unknown", categories, collectibleTypes: [],
      availability: pack.availability, price: money(pack), buyback: buybackV2(pack),
      primaryImage: { url: pack.primaryImageUrl, alt: pack.primaryImageAlt ?? pack.displayName },
      evEstimates: { vendorReported: vendorEvV2(pack), packScout: { status: "unavailable", metrics: null,
        confidence: null, modelVersion: pack.packscoutEvModelVersion, confidencePolicyVersion: pack.packscoutEvConfidencePolicyVersion,
        dataAsOf: null, calculatedAt: null, reason: "ESTIMATE_INPUT_INCOMPLETE" } },
      topChase: null, contentSummary: { knownCollectibleCount: 0, chaseCount: 0, categoryCount: categories.length,
        collectibleTypeCount: 0, evidenceCompleteness: "unknown", probabilityCoverageBasisPoints: null },
      actionAvailability: { promo: false, repackLink: repackLink !== null },
      sourceUpdatedAt: pack.sourceUpdatedAt.toISOString(), description: pack.description,
      actions: repackLink === null ? {} : { repackLink },
    });
  });
  const contents = projectApprovedProviderPackContentsV1({
    identityPolicy: "approved_public_catalog_v1", providerId: facts.providerId, platformKey: "clutchpacks",
    snapshotAt: facts.catalogSettledAt, publicAssetOrigins: configuration.publicAssetOrigins,
    collectibleMappings: configuration.collectibles,
    packs: packs.map((pack, index) => ({ id: pack.id, rowVersion: pack.rowVersion, packKey: pack.packKey,
      detail: details[index]!, evidenceCompleteness: evidence.get(pack.id) ?? "unknown" })),
    collectibles: facts.contentCatalog.collectibles, memberships: facts.contentCatalog.memberships,
    instances: facts.contentCatalog.instances,
  });
  const normalized = await Promise.all(packs.filter(pack => pack.evInputEvidence !== undefined).map(async pack => ({
    availability: pack.availability, platformKey: "clutchpacks", productKey: pack.packKey,
    evidence: await normalizeClutchpacksPromotionEvEvidenceV1({ organizationId: facts.organizationId, providerId: facts.providerId,
      packId: pack.id, packKey: pack.packKey, rowVersion: pack.rowVersion.toString(),
      priceUsdMinor: money(pack).usdComparison.value.minorUnits,
      buybackRateBasisPoints: pack.buybackRate === null ? null : decimalTextToScaledInteger(pack.buybackRate, 4),
      sourceUpdatedAt: pack.sourceUpdatedAt.toISOString(), snapshotAt: facts.latestSourceHeadFinishedAt.toISOString(),
      readAt: input.readAt, evidence: pack.evInputEvidence }),
  })));
  const eligibility = createPackScoutBuybackEvPromotionEligibilityV1({ organizationId: facts.organizationId,
    readAt: input.readAt, products: normalized.filter(row => row.availability !== "sold_out") });
  const plan = await new DataReleaseV3ReleaseAssembler({ async loadCatalogSnapshot({ readAt }) {
    if (readAt !== input.readAt) return refuse();
    return { organizationId: facts.organizationId,
      products: packs.map((pack, index) => v3Product(facts, platform.vendor, pack, contents.repacks[index]!)),
      categories: configuration.categories, collectibles: contents.collectibles, chases: contents.repackChases };
  } }, eligibility).assemble({ readAt: input.readAt });
  if (plan.classification !== "publish") throw new Error(`CLUTCHPACKS_PRODUCTION_PLAN_${plan.reason}`);
  return plan;
}
