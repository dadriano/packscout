import {
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  parsedHttpsUrl,
  type ApprovedPublicCatalogConfigurationV1,
  type ApprovedPublicPlatformConfiguration,
  type PublicCategory,
  type PublicCollectible,
  type PublicCollectibleDisplay,
  type PublicPackAvailability,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";
import type {
  CanonicalCatalogAssetProjectionContent,
  CanonicalEvInputProjectionContent,
  CanonicalPackProjectionContent,
} from "./catalog-projection-contracts.ts";
import type { CanonicalEstimatedEvProjectionContent } from "./estimated-ev-projection-contracts.ts";
import { publicConfidenceLimitationsFromPipeline } from "./public-confidence-projection.ts";
import { configuredPublicRepackLink } from "./public-repack-link.ts";
import type {
  CatalogCanonicalRevisionSnapshot,
  GovernedPublicRepackIdentity,
} from "./catalog-release-types.ts";

export class CatalogProjectionAssemblyError extends Error {
  constructor(readonly reason: "PUBLIC_IDENTITY_MAPPING_MISSING" | "CANONICAL_PROJECTION_INVALID") {
    super(reason);
    this.name = "CatalogProjectionAssemblyError";
  }
}

interface ProjectionResult {
  readonly vendors: readonly PublicVendor[];
  readonly categories: readonly PublicCategory[];
  readonly collectibles: readonly PublicCollectible[];
  readonly repacks: readonly PublicRepackDetail[];
  readonly repackChases: readonly PublicRepackChase[];
  readonly dataAsOf: Date;
}

type PublicAvailabilityPackContent = Omit<
  CanonicalPackProjectionContent,
  "availability"
> & Readonly<{ availability: PublicPackAvailability }>;

type PublicAvailabilityAssetContent = Omit<
  CanonicalCatalogAssetProjectionContent,
  "availability"
> & Readonly<{ availability: PublicPackAvailability }>;

const key = (platformKey: string, externalId: string) =>
  `${platformKey}\u0000${externalId}`;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Canonical revisions persisted before the availability rename still hold
// active/disabled; translate them at read time and keep rejecting values
// outside both vocabularies.
const normalizeLegacyAvailability = (value: unknown): unknown =>
  value === "active" ? "available" : value === "disabled" ? "unavailable" : value;

function packContent(value: unknown): PublicAvailabilityPackContent {
  const availability = isObject(value)
    ? normalizeLegacyAvailability(value.availability)
    : undefined;
  if (!isObject(value) || value.schemaVersion !== "catalog-projection-v1" ||
      value.entityType !== "pack" || typeof value.name !== "string" ||
      !["available", "unavailable", "unknown", "sold_out"].includes(
        String(availability),
      )) {
    throw new CatalogProjectionAssemblyError("CANONICAL_PROJECTION_INVALID");
  }
  return { ...value, availability } as unknown as PublicAvailabilityPackContent;
}

function assetContent(value: unknown): PublicAvailabilityAssetContent {
  const availability = isObject(value)
    ? normalizeLegacyAvailability(value.availability)
    : undefined;
  if (!isObject(value) || value.schemaVersion !== "catalog-projection-v1" ||
      value.entityType !== "catalog_asset" ||
      !["available", "unavailable", "unknown", "sold_out"].includes(
        String(availability),
      )) {
    throw new CatalogProjectionAssemblyError("CANONICAL_PROJECTION_INVALID");
  }
  return { ...value, availability } as unknown as PublicAvailabilityAssetContent;
}

function evInputContent(value: unknown): CanonicalEvInputProjectionContent {
  if (!isObject(value) || value.schemaVersion !== "catalog-projection-v1" ||
      value.entityType !== "ev_input") {
    throw new CatalogProjectionAssemblyError("CANONICAL_PROJECTION_INVALID");
  }
  return value as unknown as CanonicalEvInputProjectionContent;
}

function estimatedContent(value: unknown): CanonicalEstimatedEvProjectionContent {
  if (!isObject(value) ||
      value.schemaVersion !== "packscout-estimated-ev-projection-v1" ||
      (value.status !== "estimated" && value.status !== "unavailable")) {
    throw new CatalogProjectionAssemblyError("CANONICAL_PROJECTION_INVALID");
  }
  return value as unknown as CanonicalEstimatedEvProjectionContent;
}

function safeMinor(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new CatalogProjectionAssemblyError("CANONICAL_PROJECTION_INVALID");
  }
  return date.toISOString();
}

function approvedImage(
  urls: readonly string[],
  origins: ReadonlySet<string>,
  alt: string,
) {
  const url = urls.find((candidate) => {
    const parsed = parsedHttpsUrl(candidate);
    return parsed !== null && origins.has(parsed.origin);
  });
  return url === undefined ? null : { url, alt };
}

function publicPrice(content: PublicAvailabilityPackContent) {
  const minor = safeMinor(content.priceValueMinor);
  const currency = typeof content.priceCurrency === "string" &&
      /^[A-Z]{3}$/.test(content.priceCurrency)
    ? content.priceCurrency
    : null;
  const displayMoney = minor === null || currency === null
    ? null : { minorUnits: minor, currency };
  return {
    displayMoney,
    usdComparison: minor !== null && currency === "USD"
      ? { status: "available" as const, value: { minorUnits: minor, currency: "USD" as const } }
      : {
          status: "unavailable" as const,
          value: null,
          reason: minor === null ? "PRICE_UNAVAILABLE" as const : "CURRENCY_UNSUPPORTED" as const,
        },
  };
}

function evMetrics(grossMinor: number, priceMinor: number) {
  if (priceMinor === 0) return null;
  const grossReturnBasisPoints = Math.round(grossMinor * 10_000 / priceMinor);
  if (!Number.isSafeInteger(grossReturnBasisPoints)) return null;
  return {
    grossEv: { minorUnits: grossMinor, currency: "USD" as const },
    grossReturnBasisPoints,
    evDollars: { minorUnits: grossMinor - priceMinor, currency: "USD" as const },
    evPercentBasisPoints: grossReturnBasisPoints - 10_000,
  };
}

function vendorReportedEv(
  content: PublicAvailabilityPackContent,
  sourceUpdatedAt: Date,
) {
  const gross = safeMinor(content.providerReportedEvValueMinor);
  const currency = typeof content.providerReportedEvCurrency === "string" &&
      /^[A-Z0-9]{2,12}$/.test(content.providerReportedEvCurrency)
    ? content.providerReportedEvCurrency : null;
  const price = safeMinor(content.priceValueMinor);
  const metrics = gross !== null && currency === "USD" &&
      content.priceCurrency === "USD" && price !== null
    ? evMetrics(gross, price) : null;
  if (metrics !== null) {
    return {
      status: "available" as const,
      displayMoney: { minorUnits: gross!, currency: "USD" },
      metrics,
      observedAt: iso(sourceUpdatedAt),
    };
  }
  const displayMoney = gross !== null && currency !== null
    ? { minorUnits: gross, currency } : null;
  return {
    status: "unavailable" as const,
    displayMoney,
    metrics: null,
    observedAt: gross === null ? null : iso(sourceUpdatedAt),
    reason: gross === null ? "NOT_REPORTED" as const
      : price === null ? "PRICE_UNAVAILABLE" as const
      : "CURRENCY_UNSUPPORTED" as const,
  };
}

function confidence(input: {
  policy: ApprovedPublicCatalogConfigurationV1["confidencePolicy"];
  evInput: CanonicalEvInputProjectionContent | null;
  estimate: CanonicalEstimatedEvProjectionContent;
}) {
  const completeness = input.evInput?.evidenceCompleteness ?? "unknown";
  const base = completeness === "complete"
    ? input.policy.completeScoreBasisPoints
    : completeness === "partial"
      ? input.policy.partialScoreBasisPoints
      : input.policy.unknownScoreBasisPoints;
  const limitationCodes = [
    ...publicConfidenceLimitationsFromPipeline(input.estimate.evidence.limitations),
    ...(input.estimate.coveragePercent < 100 ? ["partial_probability_coverage" as const] : []),
  ].sort();
  const scoreBasisPoints = Math.max(
    0,
    base - limitationCodes.length * input.policy.limitationPenaltyBasisPoints,
  );
  return {
    scoreBasisPoints,
    band: scoreBasisPoints < 5_000 ? "low" as const
      : scoreBasisPoints < 8_000 ? "medium" as const : "high" as const,
    limitationCodes,
  };
}

function packScoutEv(input: {
  estimate: CanonicalEstimatedEvProjectionContent | null;
  evInput: CanonicalEvInputProjectionContent | null;
  pack: PublicAvailabilityPackContent;
  policy: ApprovedPublicCatalogConfigurationV1["confidencePolicy"];
}) {
  const estimate = input.estimate;
  const price = safeMinor(input.pack.priceValueMinor);
  if (estimate?.status === "estimated" && estimate.grossValueMinor !== null &&
      price !== null && input.pack.priceCurrency === "USD") {
    const metrics = evMetrics(estimate.grossValueMinor, price);
    if (metrics !== null) return {
      status: "available" as const,
      metrics,
      confidence: confidence({ policy: input.policy, evInput: input.evInput, estimate }),
      modelVersion: estimate.methodVersion,
      confidencePolicyVersion: input.policy.version,
      dataAsOf: estimate.sourceAt ?? estimate.calculatedAt,
      calculatedAt: estimate.calculatedAt,
    };
  }
  const currencyUnsupported = input.pack.priceValueMinor !== null &&
    input.pack.priceCurrency !== "USD" ||
    estimate?.reasonCodes.includes("unsupported_currency") === true;
  return {
    status: "unavailable" as const,
    metrics: null,
    confidence: null,
    modelVersion: estimate?.methodVersion ?? "packscout-estimated-ev-v1",
    confidencePolicyVersion: input.policy.version,
    dataAsOf: estimate?.sourceAt ?? null,
    calculatedAt: estimate?.calculatedAt ?? null,
    reason: currencyUnsupported ? "CURRENCY_UNSUPPORTED" as const
      : price === null ? "PRICE_UNAVAILABLE" as const
      : "ESTIMATE_INPUT_INCOMPLETE" as const,
  };
}

function categoryIdsFor(
  platform: ApprovedPublicPlatformConfiguration,
  sourceCategory: string | null,
): readonly string[] {
  return platform.categoryMappings.find(({ sourceValue }) => sourceValue === sourceCategory)
    ?.publicCategoryIds ?? platform.defaultPublicCategoryIds;
}

function collectibleDisplay(value: PublicCollectible): PublicCollectibleDisplay {
  return {
    publicCollectibleId: value.publicCollectibleId,
    name: value.name,
    collectibleType: value.collectibleType,
    publicCategoryIds: value.publicCategoryIds,
    primaryImage: value.primaryImage,
    valuation: value.valuation,
  };
}

export function projectCatalogRelease(input: {
  configuration: ApprovedPublicCatalogConfigurationV1;
  activePlatformKeys: ReadonlySet<string>;
  revisions: readonly CatalogCanonicalRevisionSnapshot[];
  repackIdentities: readonly GovernedPublicRepackIdentity[];
}): ProjectionResult {
  const origins = new Set(input.configuration.publicAssetOrigins);
  const platforms = input.configuration.platforms
    .filter(({ platformKey }) => input.activePlatformKeys.has(platformKey));
  const platformByKey = new Map(platforms.map((platform) => [platform.platformKey, platform]));
  const identities = new Map(input.repackIdentities.map((identity) => [
    key(identity.platformKey, identity.packExternalId), identity,
  ]));
  const configuredRepackIdentities = new Map(input.configuration.repacks.map((identity) => [
    key(identity.platformKey, identity.packExternalId), identity,
  ]));
  const collectibleMappings = new Map(input.configuration.collectibles.map((mapping) => [
    key(mapping.platformKey, mapping.externalId), mapping,
  ]));
  const categories = [...input.configuration.categories];
  const categoryById = new Map(categories.map((category) => [category.publicCategoryId, category]));
  const relevant = input.revisions.filter(({ platformKey }) => platformByKey.has(platformKey));
  const packs = relevant.filter(({ recordKind }) => recordKind === "pack");
  const assets = relevant.filter(({ recordKind }) => recordKind === "catalog_asset");
  const evInputs = relevant.filter(({ recordKind }) => recordKind === "ev_input");
  const estimates = new Map(relevant.filter(({ recordKind }) => recordKind === "estimated_ev")
    .map((revision) => [key(revision.platformKey, revision.externalId), estimatedContent(revision.content)]));
  const evInputByPack = new Map(evInputs.map((revision) => {
    const content = evInputContent(revision.content);
    return [key(revision.platformKey, content.packExternalId), content] as const;
  }));

  const collectibles: PublicCollectible[] = [];
  const collectibleByAsset = new Map<string, PublicCollectible>();
  for (const revision of assets) {
    const content = assetContent(revision.content);
    if (content.relatedPackExternalId === null) continue;
    const mapping = collectibleMappings.get(key(revision.platformKey, revision.externalId));
    if (!mapping || content.name === null) {
      throw new CatalogProjectionAssemblyError("PUBLIC_IDENTITY_MAPPING_MISSING");
    }
    const valuationMinor = safeMinor(content.providerValueMinor);
    const currency = content.providerValueCurrency;
    const valuation = valuationMinor === null || currency === null ? null : {
      displayMoney: /^[A-Z]{3}$/.test(currency)
        ? { minorUnits: valuationMinor, currency } : null,
      usdComparison: currency === "USD"
        ? { status: "available" as const, value: { minorUnits: valuationMinor, currency: "USD" as const } }
        : { status: "unavailable" as const, value: null, reason: "CURRENCY_UNSUPPORTED" as const },
      valuationType: content.valueSource === "last_sale" ? "last_sale" as const : "vendor_reported" as const,
      observedAt: iso(revision.sourceUpdatedAt),
    };
    const normalizedAliases = mapping.aliases.map(normalizePublicSearchText).sort();
    const collectible: PublicCollectible = {
      publicCollectibleId: mapping.publicCollectibleId,
      name: content.name.trim(),
      normalizedName: normalizePublicSearchText(content.name),
      aliases: mapping.aliases,
      normalizedAliases,
      collectibleType: mapping.collectibleType,
      publicCategoryIds: mapping.publicCategoryIds,
      year: mapping.year,
      brand: mapping.brand,
      setOrSeries: mapping.setOrSeries,
      cardNumber: mapping.cardNumber,
      referenceNumber: mapping.referenceNumber,
      subject: mapping.subject,
      grade: mapping.grade,
      grader: mapping.grader,
      primaryImage: approvedImage(content.imageUrls, origins, content.name),
      valuation,
      searchText: "",
      dataAsOf: iso(revision.sourceUpdatedAt),
    };
    collectible.searchText = buildPublicCollectibleSearchText(collectible);
    collectibles.push(collectible);
    collectibleByAsset.set(key(revision.platformKey, revision.externalId), collectible);
  }
  collectibles.sort((left, right) => left.publicCollectibleId.localeCompare(right.publicCollectibleId));
  if (new Set(collectibles.map(({ publicCollectibleId }) => publicCollectibleId)).size !== collectibles.length) {
    throw new CatalogProjectionAssemblyError("PUBLIC_IDENTITY_MAPPING_MISSING");
  }

  const repacks: PublicRepackDetail[] = [];
  const repackChases: PublicRepackChase[] = [];
  for (const revision of packs) {
    const content = packContent(revision.content);
    const platform = platformByKey.get(revision.platformKey)!;
    const identity = identities.get(key(revision.platformKey, revision.externalId));
    const configuredIdentity = configuredRepackIdentities.get(
      key(revision.platformKey, revision.externalId),
    );
    if (!identity || !configuredIdentity ||
        identity.publicRepackId !== configuredIdentity.publicRepackId) {
      throw new CatalogProjectionAssemblyError("PUBLIC_IDENTITY_MAPPING_MISSING");
    }
    const relatedAssets = assets.filter((asset) => {
      if (asset.platformKey !== revision.platformKey) return false;
      const candidate = assetContent(asset.content);
      return candidate.relatedPackExternalId === revision.externalId;
    });
    const evInput = evInputByPack.get(key(revision.platformKey, revision.externalId)) ?? null;
    const probabilityByBucket = new Map(evInput?.probabilityBuckets.map((bucket) => [bucket.bucketId, bucket.probability]) ?? []);
    const chaseCandidates = relatedAssets.map((asset) => {
      const collectible = collectibleByAsset.get(key(asset.platformKey, asset.externalId));
      if (!collectible) throw new CatalogProjectionAssemblyError("PUBLIC_IDENTITY_MAPPING_MISSING");
      const comparison = collectible.valuation?.usdComparison;
      return {
        asset,
        collectible,
        value: comparison?.status === "available" ? comparison.value.minorUnits : null,
      };
    }).sort((left, right) =>
      (left.value === null ? 1 : 0) - (right.value === null ? 1 : 0) ||
      (right.value ?? 0) - (left.value ?? 0) ||
      left.collectible.publicCollectibleId.localeCompare(right.collectible.publicCollectibleId));
    const chases = chaseCandidates.map(({ asset, collectible }, displayOrder): PublicRepackChase => {
      const mapping = collectibleMappings.get(key(asset.platformKey, asset.externalId));
      if (!mapping) throw new CatalogProjectionAssemblyError("PUBLIC_IDENTITY_MAPPING_MISSING");
      const probability = mapping.probabilityBucketId === null
        ? null : probabilityByBucket.get(mapping.probabilityBucketId) ?? null;
      const probabilityBasisPoints = probability !== null && Number.isFinite(probability)
        ? Math.round(probability * 10_000) : null;
      const evidenceKinds = [...new Set([
        ...mapping.chaseEvidenceKinds,
        ...(probabilityBasisPoints === null ? [] : ["vendor_odds" as const]),
      ])].sort();
      const scoreBasisPoints = mapping.matchConfidenceBasisPoints;
      return {
        publicRepackId: identity.publicRepackId,
        publicCollectibleId: collectible.publicCollectibleId,
        role: displayOrder === 0 ? "top_chase" : "possible_outcome",
        evidenceKinds,
        probabilityBasisPoints,
        collectible: collectibleDisplay(collectible),
        matchConfidence: {
          scoreBasisPoints,
          band: scoreBasisPoints < 5_000 ? "low"
            : scoreBasisPoints < 8_000 ? "medium" : "high",
        },
        observedAt: iso(asset.sourceUpdatedAt),
        displayOrder,
      };
    });
    repackChases.push(...chases);
    const categoryIds = [...new Set([
      ...categoryIdsFor(platform, content.category),
      ...chases.flatMap(({ collectible }) => collectible.publicCategoryIds),
    ])].sort();
    if (categoryIds.some((categoryId) => !categoryById.has(categoryId))) {
      throw new CatalogProjectionAssemblyError("CANONICAL_PROJECTION_INVALID");
    }
    const collectibleTypes = [...new Set(chases.map(({ collectible }) => collectible.collectibleType))].sort();
    const categoryBranches = categoryIds.filter((candidate) =>
      !categoryIds.some((other) => other !== candidate && categoryById.get(other)?.pathPublicCategoryIds.includes(candidate))).length;
    const contentMode = categoryBranches > 1 || collectibleTypes.length > 1
      ? "mixed" as const : categoryBranches === 1 || collectibleTypes.length === 1
        ? "focused" as const : "unknown" as const;
    const price = publicPrice(content);
    const buybackBasisPoints = content.buybackPercent === null ? null
      : Math.round(content.buybackPercent * 100);
    const promo = content.availability === "available"
      ? platform.vendor.publicPromo ?? undefined
      : undefined;
    const repackLink = configuredPublicRepackLink({
      identity: configuredIdentity,
      platform,
      available: content.availability === "available",
    }) ?? undefined;
    const packScout = packScoutEv({
      estimate: estimates.get(key(revision.platformKey, revision.externalId)) ?? null,
      evInput,
      pack: content,
      policy: input.configuration.confidencePolicy,
    });
    repacks.push({
      publicRepackId: identity.publicRepackId,
      publicVendorId: platform.vendor.publicVendorId,
      vendorKey: platform.vendor.vendorKey,
      vendorDisplayName: platform.vendor.displayName,
      vendorLogoUrl: platform.vendor.logoUrl,
      name: content.name.trim(),
      format: platform.format,
      contentMode,
      categories: categoryIds.map((publicCategoryId) => ({
        publicCategoryId,
        label: categoryById.get(publicCategoryId)!.name,
      })),
      collectibleTypes,
      availability: content.availability,
      price,
      buyback: buybackBasisPoints !== null && buybackBasisPoints >= 0 && buybackBasisPoints <= 10_000
        ? { status: "available", value: { basisPoints: buybackBasisPoints, sourceKind: "vendor_reported" } }
        : { status: "unavailable", value: null, reason: "BUYBACK_UNAVAILABLE" },
      primaryImage: approvedImage(content.imageUrls, new Set(platform.vendor.imageOrigins), content.name),
      evEstimates: { vendorReported: vendorReportedEv(content, revision.sourceUpdatedAt), packScout },
      topChase: chases[0] ?? null,
      contentSummary: {
        knownCollectibleCount: chases.length,
        chaseCount: chases.length,
        categoryCount: categoryIds.length,
        collectibleTypeCount: collectibleTypes.length,
        evidenceCompleteness: evInput?.evidenceCompleteness ?? "unknown",
        probabilityCoverageBasisPoints: evInput === null ? null
          : Math.round(evInput.coverage.calculatedCoverage * 10_000),
      },
      actionAvailability: {
        promo: promo !== undefined,
        repackLink: repackLink !== undefined,
      },
      sourceUpdatedAt: iso(revision.sourceUpdatedAt),
      description: content.description?.trim() || null,
      actions: {
        ...(promo === undefined ? {} : { promo }),
        ...(repackLink === undefined ? {} : { repackLink }),
      },
    });
  }
  repacks.sort((left, right) => left.publicRepackId.localeCompare(right.publicRepackId));
  repackChases.sort((left, right) =>
    left.publicRepackId.localeCompare(right.publicRepackId) ||
    left.displayOrder - right.displayOrder ||
    left.publicCollectibleId.localeCompare(right.publicCollectibleId));
  const dates = relevant.map(({ sourceUpdatedAt }) => sourceUpdatedAt);
  return {
    vendors: platforms.map(({ vendor }) => vendor)
      .sort((left, right) => left.publicVendorId.localeCompare(right.publicVendorId)),
    categories,
    collectibles,
    repacks,
    repackChases,
    dataAsOf: dates.length === 0 ? new Date(0) : new Date(Math.max(...dates.map((date) => date.getTime()))),
  };
}
