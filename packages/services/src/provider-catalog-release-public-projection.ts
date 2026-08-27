import {
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  parsedHttpsUrl,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  type ApprovedPublicCatalogConfigurationV1,
  type ApprovedPublicPlatformConfiguration,
  type PublicCategory,
  type PublicCollectible,
  type PublicCollectibleDisplay,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";
import type {
  CanonicalEvInputProjectionContent,
} from "./catalog-projection-contracts.ts";
import type {
  CanonicalEstimatedEvProjectionContent,
} from "./estimated-ev-projection-contracts.ts";
import { publicConfidenceLimitationsFromPipeline } from "./public-confidence-projection.ts";
import { configuredPublicRepackLink } from "./public-repack-link.ts";
import {
  ProviderCatalogProjectionAssemblyError,
  assertProviderCatalogEstimateDependencies as assertEstimateDependencies,
  canonicalProviderCatalogTimestamp as canonicalTimestamp,
  compareProviderCatalogCodeUnits,
  finiteProviderCatalogDate as finiteDate,
  invalidProviderCatalogProjection as invalid,
  providerCatalogAssetContent as assetContent,
  providerCatalogEstimatedContent as estimatedContent,
  providerCatalogEvInputContent as evInputContent,
  providerCatalogIso as iso,
  providerCatalogPackContent as packContent,
  trustedProviderCatalogPackAvailability as trustedPackAvailability,
  type PublicAvailabilityPackContent,
} from "./provider-catalog-release-public-projection-validation.ts";
import type {
  ProviderCatalogAssetPackAssociationSnapshot,
  ProviderCatalogCanonicalRevisionSnapshot,
  ProviderGovernedPublicRepackIdentity,
} from "./provider-catalog-release-types.ts";

export {
  ProviderCatalogProjectionAssemblyError,
  compareProviderCatalogCodeUnits,
};
export type {
  ProviderCatalogProjectionBlockReason,
} from "./provider-catalog-release-public-projection-validation.ts";

export interface ProviderCatalogPublicProjection {
  readonly vendors: readonly PublicVendor[];
  readonly categories: readonly PublicCategory[];
  readonly collectibles: readonly PublicCollectible[];
  readonly repacks: readonly PublicRepackDetail[];
  readonly repackChases: readonly PublicRepackChase[];
  readonly dataAsOf: Date;
}

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

const key = (platformKey: string, externalId: string) =>
  `${platformKey}\u0000${externalId}`;

function safeMinor(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function approvedImage(
  urls: readonly string[],
  origins: ReadonlySet<string>,
  alt: string,
) {
  for (const candidate of urls) {
    const parsed = parsedHttpsUrl(candidate);
    if (parsed === null || !origins.has(parsed.origin)) {
      invalid("PUBLIC_ORIGIN_UNAPPROVED");
    }
  }
  const url = urls[0];
  return url === undefined ? null : { url, alt };
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 400) {
    invalid("EXACT_VALUE_INVALID");
  }
  return 10n ** BigInt(exponent);
}

/** Converts the canonical JavaScript decimal rendering into an exact rational. */
export function providerCatalogNumberAsRational(value: number): Rational {
  if (!Number.isFinite(value)) invalid("EXACT_VALUE_INVALID");
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(text);
  if (match === null) invalid("EXACT_VALUE_INVALID");
  const negative = match[1] === "-";
  const integral = match[2]!;
  const fractional = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) invalid("EXACT_VALUE_INVALID");
  let numerator = BigInt(`${integral}${fractional}`);
  let denominator = powerOfTen(fractional.length);
  if (exponent >= 0) numerator *= powerOfTen(exponent);
  else denominator *= powerOfTen(-exponent);
  return {
    numerator: negative ? -numerator : numerator,
    denominator,
  };
}

function roundedNonNegativeRationalToSafeInteger(
  rational: Rational,
  multiplier: bigint,
): number {
  if (rational.numerator < 0n || rational.denominator <= 0n || multiplier < 0n) {
    invalid("EXACT_VALUE_INVALID");
  }
  const scaled = rational.numerator * multiplier;
  const quotient = scaled / rational.denominator;
  const remainder = scaled % rational.denominator;
  const rounded = remainder * 2n >= rational.denominator ? quotient + 1n : quotient;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) invalid("EXACT_VALUE_INVALID");
  return Number(rounded);
}

function exactBasisPoints(value: number, scale: bigint): number {
  return roundedNonNegativeRationalToSafeInteger(
    providerCatalogNumberAsRational(value),
    scale,
  );
}

function isUsdComparableCurrency(
  currency: string | null,
  verifiedUsdStablecoins: readonly string[],
): boolean {
  return currency === "USD" ||
    currency !== null && verifiedUsdStablecoins.includes(currency);
}

function publicPrice(
  content: PublicAvailabilityPackContent,
  verifiedUsdStablecoins: readonly string[],
) {
  const minor = safeMinor(content.priceValueMinor);
  const currency = typeof content.priceCurrency === "string" &&
      /^[A-Z]{3}$/u.test(content.priceCurrency)
    ? content.priceCurrency
    : null;
  const displayMoney = minor === null || currency === null
    ? null : { minorUnits: minor, currency };
  return {
    displayMoney,
    usdComparison: minor !== null &&
        isUsdComparableCurrency(content.priceCurrency, verifiedUsdStablecoins)
      ? {
          status: "available" as const,
          value: { minorUnits: minor, currency: "USD" as const },
        }
      : {
          status: "unavailable" as const,
          value: null,
          reason: minor === null
            ? "PRICE_UNAVAILABLE" as const
            : "CURRENCY_UNSUPPORTED" as const,
        },
  };
}

function exactEvMetrics(grossMinor: number, priceMinor: number) {
  if (priceMinor === 0) return null;
  const grossReturn = (BigInt(grossMinor) * 10_000n + BigInt(priceMinor) / 2n) /
    BigInt(priceMinor);
  const dollars = BigInt(grossMinor) - BigInt(priceMinor);
  const percent = grossReturn - 10_000n;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  if (
    grossReturn > maximum ||
    dollars > maximum ||
    dollars < minimum ||
    percent > maximum ||
    percent < minimum
  ) invalid("EXACT_VALUE_INVALID");
  return {
    grossEv: { minorUnits: grossMinor, currency: "USD" as const },
    grossReturnBasisPoints: Number(grossReturn),
    evDollars: { minorUnits: Number(dollars), currency: "USD" as const },
    evPercentBasisPoints: Number(percent),
  };
}

function vendorReportedEv(
  content: PublicAvailabilityPackContent,
  sourceUpdatedAt: Date,
  verifiedUsdStablecoins: readonly string[],
) {
  const gross = safeMinor(content.providerReportedEvValueMinor);
  const currency = typeof content.providerReportedEvCurrency === "string" &&
      /^[A-Z0-9]{2,12}$/u.test(content.providerReportedEvCurrency)
    ? content.providerReportedEvCurrency
    : null;
  const price = safeMinor(content.priceValueMinor);
  const comparable = gross !== null &&
    isUsdComparableCurrency(currency, verifiedUsdStablecoins) &&
    isUsdComparableCurrency(
      content.priceCurrency,
      verifiedUsdStablecoins,
    ) && price !== null;
  const metrics = comparable ? exactEvMetrics(gross, price) : null;
  if (metrics !== null && currency !== null) {
    return {
      status: "available" as const,
      displayMoney: {
        minorUnits: metrics.grossEv.minorUnits,
        currency,
      },
      metrics,
      observedAt: iso(sourceUpdatedAt),
    };
  }
  const displayMoney = gross !== null && currency !== null
    ? { minorUnits: gross, currency }
    : null;
  return {
    status: "unavailable" as const,
    displayMoney,
    metrics: null,
    observedAt: gross === null ? null : iso(sourceUpdatedAt),
    reason: gross === null
      ? "NOT_REPORTED" as const
      : price === null || price === 0
        ? "PRICE_UNAVAILABLE" as const
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
    ...(input.estimate.coveragePercent < 100
      ? ["partial_probability_coverage" as const]
      : []),
  ].sort(compareProviderCatalogCodeUnits);
  const scoreBasisPoints = Math.max(
    0,
    base - limitationCodes.length * input.policy.limitationPenaltyBasisPoints,
  );
  return {
    scoreBasisPoints,
    band: scoreBasisPoints < 5_000
      ? "low" as const
      : scoreBasisPoints < 8_000
        ? "medium" as const
        : "high" as const,
    limitationCodes,
  };
}

function packScoutEv(input: {
  estimate: CanonicalEstimatedEvProjectionContent | null;
  evInput: CanonicalEvInputProjectionContent | null;
  pack: PublicAvailabilityPackContent;
  policy: ApprovedPublicCatalogConfigurationV1["confidencePolicy"];
  verifiedUsdStablecoins: readonly string[];
}) {
  const estimate = input.estimate;
  const price = safeMinor(input.pack.priceValueMinor);
  const gross = estimate === null ? null : safeMinor(estimate.grossValueMinor);
  if (
    estimate?.status === "estimated" &&
    gross !== null &&
    price !== null &&
    isUsdComparableCurrency(
      input.pack.priceCurrency,
      input.verifiedUsdStablecoins,
    )
  ) {
    const metrics = exactEvMetrics(gross, price);
    if (metrics !== null) {
      return {
        status: "available" as const,
        metrics,
        confidence: confidence({
          policy: input.policy,
          evInput: input.evInput,
          estimate,
        }),
        modelVersion: estimate.methodVersion,
        confidencePolicyVersion: input.policy.version,
        dataAsOf: canonicalTimestamp(estimate.sourceAt ?? estimate.calculatedAt),
        calculatedAt: canonicalTimestamp(estimate.calculatedAt),
      };
    }
  }
  const currencyUnsupported = input.pack.priceValueMinor !== null &&
      !isUsdComparableCurrency(
        input.pack.priceCurrency,
        input.verifiedUsdStablecoins,
      ) ||
    estimate?.reasonCodes.includes("unsupported_currency") === true;
  return {
    status: "unavailable" as const,
    metrics: null,
    confidence: null,
    modelVersion: estimate?.methodVersion ?? "packscout-estimated-ev-v1",
    confidencePolicyVersion: input.policy.version,
    dataAsOf: estimate?.sourceAt === null || estimate?.sourceAt === undefined
      ? null
      : canonicalTimestamp(estimate.sourceAt),
    calculatedAt: estimate === null
      ? null
      : canonicalTimestamp(estimate.calculatedAt),
    reason: currencyUnsupported
      ? "CURRENCY_UNSUPPORTED" as const
      : price === null || price === 0
        ? "PRICE_UNAVAILABLE" as const
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

function relevantCategoryClosure(
  categories: readonly PublicCategory[],
  referencedIds: ReadonlySet<string>,
): readonly PublicCategory[] {
  const categoryById = new Map(categories.map((category) => [
    category.publicCategoryId,
    category,
  ]));
  if (categoryById.size !== categories.length) invalid("PUBLIC_REFERENCE_INVALID");
  const included = new Set<string>();
  const categoryKeys = new Set<string>();
  for (const referencedId of referencedIds) {
    const category = categoryById.get(referencedId);
    if (category === undefined) invalid("PUBLIC_REFERENCE_INVALID");
    for (const [pathIndex, pathId] of category.pathPublicCategoryIds.entries()) {
      const pathCategory = categoryById.get(pathId);
      if (
        pathCategory === undefined ||
        pathCategory.depth !== pathIndex ||
        pathCategory.pathPublicCategoryIds.length !== pathIndex + 1 ||
        pathCategory.pathPublicCategoryIds.some(
          (candidate, index) =>
            candidate !== category.pathPublicCategoryIds[index],
        )
      ) invalid("PUBLIC_REFERENCE_INVALID");
      included.add(pathId);
    }
  }
  const result = categories.filter(({ publicCategoryId }) => included.has(publicCategoryId))
    .sort((left, right) => left.depth - right.depth ||
      compareProviderCatalogCodeUnits(left.publicCategoryId, right.publicCategoryId));
  for (const category of result) {
    if (categoryKeys.has(category.categoryKey)) invalid("PUBLIC_REFERENCE_INVALID");
    categoryKeys.add(category.categoryKey);
  }
  return result;
}

function validatePublicProjection(
  projection: ProviderCatalogPublicProjection,
): ProviderCatalogPublicProjection {
  try {
    return {
      vendors: projection.vendors.map((record) => publicVendorSchema.parse(record)),
      categories: projection.categories.map((record) => publicCategorySchema.parse(record)),
      collectibles: projection.collectibles.map((record) => publicCollectibleSchema.parse(record)),
      repacks: projection.repacks.map((record) => publicRepackDetailSchema.parse(record)),
      repackChases: projection.repackChases.map((record) => publicRepackChaseSchema.parse(record)),
      dataAsOf: finiteDate(projection.dataAsOf),
    };
  } catch (error) {
    if (error instanceof ProviderCatalogProjectionAssemblyError) throw error;
    invalid("PUBLIC_CONTRACT_INVALID");
  }
}

export function projectProviderCatalogRelease(input: {
  configuration: ApprovedPublicCatalogConfigurationV1;
  platformKey: string;
  revisions: readonly ProviderCatalogCanonicalRevisionSnapshot[];
  assetPackAssociations: readonly ProviderCatalogAssetPackAssociationSnapshot[];
  repackIdentities: readonly ProviderGovernedPublicRepackIdentity[];
}): ProviderCatalogPublicProjection {
  const platform = input.configuration.platforms.find(
    (candidate) => candidate.platformKey === input.platformKey,
  );
  if (platform === undefined || input.configuration.platforms.length !== 1) {
    invalid("PUBLIC_REFERENCE_INVALID");
  }
  const relevant = [...input.revisions];
  if (relevant.some(({ platformKey }) => platformKey !== input.platformKey)) {
    invalid("CANONICAL_PROJECTION_INVALID");
  }
  const origins = new Set(input.configuration.publicAssetOrigins);
  const identities = new Map(input.repackIdentities.map((identity) => [
    key(identity.platformKey, identity.packExternalId),
    identity,
  ]));
  if (identities.size !== input.repackIdentities.length ||
      input.repackIdentities.some(({ platformKey }) => platformKey !== input.platformKey)) {
    invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
  }
  const configuredRepackIdentities = new Map(input.configuration.repacks.map((identity) => [
    key(identity.platformKey, identity.packExternalId),
    identity,
  ]));
  const collectibleMappings = new Map(input.configuration.collectibles.map((mapping) => [
    key(mapping.platformKey, mapping.externalId),
    mapping,
  ]));
  const categoryById = new Map(input.configuration.categories.map((category) => [
    category.publicCategoryId,
    category,
  ]));

  const packs: ProviderCatalogCanonicalRevisionSnapshot[] = [];
  const assets: ProviderCatalogCanonicalRevisionSnapshot[] = [];
  const evInputs: ProviderCatalogCanonicalRevisionSnapshot[] = [];
  const estimates = new Map<string, Readonly<{
    revision: ProviderCatalogCanonicalRevisionSnapshot;
    content: CanonicalEstimatedEvProjectionContent;
  }>>();
  let maximumRelevantTime: number | null = null;
  const markContributingRevision = (
    revision: ProviderCatalogCanonicalRevisionSnapshot,
  ): void => {
    const time = revision.sourceUpdatedAt.getTime();
    if (maximumRelevantTime === null || time > maximumRelevantTime) {
      maximumRelevantTime = time;
    }
  };
  const markContributingAssociation = (
    association: ProviderCatalogAssetPackAssociationSnapshot,
  ): void => {
    const time = finiteDate(association.associatedAt).getTime();
    if (maximumRelevantTime === null || time > maximumRelevantTime) {
      maximumRelevantTime = time;
    }
  };
  const seenRevisions = new Set<string>();
  for (const revision of relevant) {
    const revisionKey = `${revision.recordKind}\u0000${revision.externalId}`;
    if (seenRevisions.has(revisionKey)) invalid();
    seenRevisions.add(revisionKey);
    finiteDate(revision.sourceUpdatedAt);
    finiteDate(revision.sourceCollectedAt);
    finiteDate(revision.acceptedAt);
    if (revision.recordKind === "pack") {
      packContent(revision.content);
      packs.push(revision);
    } else if (revision.recordKind === "catalog_asset") {
      assetContent(revision.content);
      assets.push(revision);
    } else if (revision.recordKind === "ev_input") {
      evInputContent(revision.content);
      evInputs.push(revision);
    } else if (revision.recordKind === "estimated_ev") {
      const content = estimatedContent(
        revision.content,
        input.configuration.verifiedUsdStablecoins,
      );
      if (Date.parse(content.calculatedAt) > revision.acceptedAt.getTime()) {
        invalid();
      }
      estimates.set(
        key(revision.platformKey, revision.externalId),
        {
          revision,
          content,
        },
      );
    }
  }
  packs.sort((left, right) => compareProviderCatalogCodeUnits(left.externalId, right.externalId));
  assets.sort((left, right) => compareProviderCatalogCodeUnits(left.externalId, right.externalId));
  evInputs.sort((left, right) => compareProviderCatalogCodeUnits(left.externalId, right.externalId));

  const evInputByPack = new Map<string, Readonly<{
    revision: ProviderCatalogCanonicalRevisionSnapshot;
    content: CanonicalEvInputProjectionContent;
  }>>();
  for (const revision of evInputs) {
    const content = evInputContent(revision.content);
    const inputKey = key(revision.platformKey, content.packExternalId);
    if (evInputByPack.has(inputKey)) invalid();
    evInputByPack.set(inputKey, { revision, content });
  }

  const packByExternalId = new Map(packs.map((revision) => [
    revision.externalId,
    packContent(revision.content),
  ]));
  for (const { content } of evInputByPack.values()) {
    if (!packByExternalId.has(content.packExternalId)) {
      invalid("PUBLIC_REFERENCE_INVALID");
    }
  }
  for (const { revision } of estimates.values()) {
    if (!packByExternalId.has(revision.externalId)) {
      invalid("PUBLIC_REFERENCE_INVALID");
    }
  }

  const packIdsByAsset = new Map<string, Set<string>>();
  const associationSourceIds = new Set<string>();
  const firstAssociationByPair = new Map<
    string,
    ProviderCatalogAssetPackAssociationSnapshot
  >();
  for (const association of input.assetPackAssociations) {
    if (
      association.platformKey !== input.platformKey ||
      association.sourceEntityId.length === 0 ||
      association.assetExternalId.length === 0 ||
      association.packExternalId.length === 0 ||
      association.publicChangeSequence <= 0n ||
      associationSourceIds.has(association.sourceEntityId)
    ) invalid("CANONICAL_PROJECTION_INVALID");
    associationSourceIds.add(association.sourceEntityId);
    if (
      !packByExternalId.has(association.packExternalId) ||
      !configuredRepackIdentities.has(
        key(association.platformKey, association.packExternalId),
      )
    ) invalid("PUBLIC_REFERENCE_INVALID");
    finiteDate(association.associatedAt);
    const pairKey = key(association.assetExternalId, association.packExternalId);
    const current = firstAssociationByPair.get(pairKey);
    if (
      current === undefined ||
      association.publicChangeSequence < current.publicChangeSequence ||
      association.publicChangeSequence === current.publicChangeSequence &&
        (association.associatedAt.getTime() < current.associatedAt.getTime() ||
          association.associatedAt.getTime() === current.associatedAt.getTime() &&
          compareProviderCatalogCodeUnits(
            association.sourceEntityId,
            current.sourceEntityId,
          ) < 0)
    ) {
      firstAssociationByPair.set(pairKey, association);
    }
  }
  for (const association of firstAssociationByPair.values()) {
    const packIds = packIdsByAsset.get(association.assetExternalId) ??
      new Set<string>();
    packIds.add(association.packExternalId);
    packIdsByAsset.set(association.assetExternalId, packIds);
    markContributingAssociation(association);
  }

  const collectibles: PublicCollectible[] = [];
  const collectibleByAsset = new Map<string, PublicCollectible>();
  const assetsByPack = new Map<string, ProviderCatalogCanonicalRevisionSnapshot[]>();
  const associatedAssetIds = new Set<string>();
  for (const revision of assets) {
    const content = assetContent(revision.content);
    const relatedPackIds = packIdsByAsset.get(revision.externalId);
    if (relatedPackIds === undefined) continue;
    associatedAssetIds.add(revision.externalId);
    for (const packExternalId of [...relatedPackIds].sort(
      compareProviderCatalogCodeUnits,
    )) {
      const related = assetsByPack.get(packExternalId) ?? [];
      related.push(revision);
      assetsByPack.set(packExternalId, related);
    }
    const mapping = collectibleMappings.get(key(revision.platformKey, revision.externalId));
    if (mapping === undefined || content.name === null || content.name.trim().length === 0) {
      invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
    }
    const valuationMinor = safeMinor(content.providerValueMinor);
    const currency = content.providerValueCurrency;
    const valuation = valuationMinor === null || currency === null
      ? null
      : {
          displayMoney: /^[A-Z]{3}$/u.test(currency)
            ? { minorUnits: valuationMinor, currency }
            : null,
          usdComparison: currency === "USD"
            ? {
                status: "available" as const,
                value: { minorUnits: valuationMinor, currency: "USD" as const },
              }
            : {
                status: "unavailable" as const,
                value: null,
                reason: "CURRENCY_UNSUPPORTED" as const,
              },
          valuationType: content.valueSource === "last_sale"
            ? "last_sale" as const
            : "vendor_reported" as const,
          observedAt: iso(revision.sourceUpdatedAt),
        };
    const normalizedAliases = mapping.aliases
      .map(normalizePublicSearchText)
      .sort(compareProviderCatalogCodeUnits);
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
    markContributingRevision(revision);
    collectibleByAsset.set(key(revision.platformKey, revision.externalId), collectible);
  }
  if (associatedAssetIds.size !== packIdsByAsset.size) {
    invalid("PUBLIC_REFERENCE_INVALID");
  }
  collectibles.sort((left, right) => compareProviderCatalogCodeUnits(
    left.publicCollectibleId,
    right.publicCollectibleId,
  ));
  if (new Set(collectibles.map(({ publicCollectibleId }) => publicCollectibleId)).size !==
      collectibles.length) {
    invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
  }

  const repacks: PublicRepackDetail[] = [];
  const repackChases: PublicRepackChase[] = [];
  for (const revision of packs) {
    const content = packContent(revision.content);
    const identity = identities.get(key(revision.platformKey, revision.externalId));
    const configuredIdentity = configuredRepackIdentities.get(
      key(revision.platformKey, revision.externalId),
    );
    if (
      identity === undefined ||
      configuredIdentity === undefined ||
      identity.publicRepackId !== configuredIdentity.publicRepackId
    ) invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
    const availability = trustedPackAvailability({
      content,
      identity,
      platform,
      sourceUpdatedAt: revision.sourceUpdatedAt,
    });

    const relatedAssets = assetsByPack.get(revision.externalId) ?? [];
    const evInputEntry = content.evInputStatus === "ready"
      ? evInputByPack.get(key(revision.platformKey, revision.externalId)) ?? null
      : null;
    const evInput = evInputEntry?.content ?? null;
    const estimateEntry = content.evInputStatus === "ready"
      ? estimates.get(key(revision.platformKey, revision.externalId)) ?? null
      : null;
    if (estimateEntry !== null) {
      assertEstimateDependencies({
        packRevision: revision,
        pack: content,
        evInputEntry,
        estimate: estimateEntry.content,
        verifiedUsdStablecoins:
          input.configuration.verifiedUsdStablecoins,
      });
    }
    const probabilityByBucket = new Map(
      evInput?.probabilityBuckets.map((bucket) => [bucket.bucketId, bucket.probability]) ?? [],
    );
    const chaseCandidates = relatedAssets.map((asset) => {
      const collectible = collectibleByAsset.get(key(asset.platformKey, asset.externalId));
      if (collectible === undefined) invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
      const comparison = collectible.valuation?.usdComparison;
      return {
        asset,
        collectible,
        value: comparison?.status === "available" ? comparison.value.minorUnits : null,
      };
    }).sort((left, right) => {
      if (left.value === null && right.value !== null) return 1;
      if (left.value !== null && right.value === null) return -1;
      if (left.value !== null && right.value !== null && left.value !== right.value) {
        return left.value > right.value ? -1 : 1;
      }
      return compareProviderCatalogCodeUnits(
        left.collectible.publicCollectibleId,
        right.collectible.publicCollectibleId,
      );
    });
    const chases = chaseCandidates.map(
      ({ asset, collectible }, displayOrder): PublicRepackChase => {
        const mapping = collectibleMappings.get(key(asset.platformKey, asset.externalId));
        if (mapping === undefined) invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
        if (
          mapping.probabilityBucketId !== null &&
          !probabilityByBucket.has(mapping.probabilityBucketId)
        ) invalid("PUBLIC_REFERENCE_INVALID");
        const probability = mapping.probabilityBucketId === null
          ? null
          : probabilityByBucket.get(mapping.probabilityBucketId) ?? null;
        const probabilityBasisPoints = probability === null
          ? null
          : exactBasisPoints(probability, 10_000n);
        if (probabilityBasisPoints !== null && probabilityBasisPoints > 10_000) {
          invalid("EXACT_VALUE_INVALID");
        }
        const evidenceKinds = [...new Set([
          ...mapping.chaseEvidenceKinds,
          ...(probabilityBasisPoints === null ? [] : ["vendor_odds" as const]),
        ])].sort(compareProviderCatalogCodeUnits);
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
            band: scoreBasisPoints < 5_000
              ? "low"
              : scoreBasisPoints < 8_000
                ? "medium"
                : "high",
          },
          observedAt: iso(asset.sourceUpdatedAt),
          displayOrder,
        };
      },
    );
    repackChases.push(...chases);
    const categoryIds = [...new Set([
      ...categoryIdsFor(platform, content.category),
      ...chases.flatMap(({ collectible }) => collectible.publicCategoryIds),
    ])].sort(compareProviderCatalogCodeUnits);
    if (categoryIds.some((categoryId) => !categoryById.has(categoryId))) {
      invalid("PUBLIC_REFERENCE_INVALID");
    }
    const collectibleTypes = [...new Set(
      chases.map(({ collectible }) => collectible.collectibleType),
    )].sort(compareProviderCatalogCodeUnits);
    const categoryBranches = categoryIds.filter((candidate) =>
      !categoryIds.some((other) => other !== candidate &&
        categoryById.get(other)?.pathPublicCategoryIds.includes(candidate) === true))
      .length;
    const contentMode = categoryBranches > 1 || collectibleTypes.length > 1
      ? "mixed" as const
      : categoryBranches === 1 || collectibleTypes.length === 1
        ? "focused" as const
        : "unknown" as const;
    const price = publicPrice(
      content,
      input.configuration.verifiedUsdStablecoins,
    );
    if (content.buybackPercent !== null &&
        (content.buybackPercent < 0 || content.buybackPercent > 100)) {
      invalid("EXACT_VALUE_INVALID");
    }
    const buybackBasisPoints = content.buybackPercent === null
      ? null
      : exactBasisPoints(content.buybackPercent, 100n);
    if (buybackBasisPoints !== null && buybackBasisPoints > 10_000) {
      invalid("EXACT_VALUE_INVALID");
    }
    const promo = availability === "available"
      ? platform.vendor.publicPromo ?? undefined
      : undefined;
    const repackLink = configuredPublicRepackLink({
      identity: configuredIdentity,
      platform,
      available: availability === "available",
    }) ?? undefined;
    const packScout = packScoutEv({
      estimate: estimateEntry?.content ?? null,
      evInput,
      pack: content,
      policy: input.configuration.confidencePolicy,
      verifiedUsdStablecoins:
        input.configuration.verifiedUsdStablecoins,
    });
    const probabilityCoverageBasisPoints = evInput === null
      ? null
      : exactBasisPoints(evInput.coverage.calculatedCoverage, 10_000n);
    if (
      probabilityCoverageBasisPoints !== null &&
      probabilityCoverageBasisPoints > 10_000
    ) invalid("EXACT_VALUE_INVALID");
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
      availability,
      price,
      buyback: buybackBasisPoints !== null && buybackBasisPoints <= 10_000
        ? {
            status: "available",
            value: {
              basisPoints: buybackBasisPoints,
              sourceKind: "vendor_reported",
            },
          }
        : {
            status: "unavailable",
            value: null,
            reason: "BUYBACK_UNAVAILABLE",
          },
      primaryImage: approvedImage(
        content.imageUrls,
        new Set(platform.vendor.imageOrigins),
        content.name,
      ),
      evEstimates: {
        vendorReported: vendorReportedEv(
          content,
          revision.sourceUpdatedAt,
          input.configuration.verifiedUsdStablecoins,
        ),
        packScout,
      },
      topChase: chases[0] ?? null,
      contentSummary: {
        knownCollectibleCount: chases.length,
        chaseCount: chases.length,
        categoryCount: categoryIds.length,
        collectibleTypeCount: collectibleTypes.length,
        evidenceCompleteness: evInput?.evidenceCompleteness ?? "unknown",
        probabilityCoverageBasisPoints,
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
    markContributingRevision(revision);
    if (evInputEntry !== null) {
      markContributingRevision(evInputEntry.revision);
    }
    if (estimateEntry !== null) {
      markContributingRevision(estimateEntry.revision);
    }
  }
  repacks.sort((left, right) => compareProviderCatalogCodeUnits(
    left.publicRepackId,
    right.publicRepackId,
  ));
  repackChases.sort((left, right) =>
    compareProviderCatalogCodeUnits(left.publicRepackId, right.publicRepackId) ||
    left.displayOrder - right.displayOrder ||
    compareProviderCatalogCodeUnits(
      left.publicCollectibleId,
      right.publicCollectibleId,
    ));

  const referencedCategoryIds = new Set<string>();
  for (const collectible of collectibles) {
    for (const categoryId of collectible.publicCategoryIds) referencedCategoryIds.add(categoryId);
  }
  for (const repack of repacks) {
    for (const category of repack.categories) {
      referencedCategoryIds.add(category.publicCategoryId);
    }
  }
  const categories = relevantCategoryClosure(
    input.configuration.categories,
    referencedCategoryIds,
  );
  return validatePublicProjection({
    vendors: [platform.vendor],
    categories,
    collectibles,
    repacks,
    repackChases,
    dataAsOf: maximumRelevantTime === null
      ? new Date(0)
      : new Date(maximumRelevantTime),
  });
}
