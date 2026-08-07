import type {
  CatalogEnvelopeV1,
  ProviderFeedPageV1,
  PullEnvelopeV1,
} from "@packscout/contracts";
import {
  sourceIdentityForEnvelope,
  type CatalogAssetCandidate,
  type CanonicalPackCandidate,
  type EvInputCandidate,
  type ProbabilityBucketInput,
  type ProviderAdapterCandidate,
  type ProviderMappingAdapter,
  type ProviderRecordMappingOutcome,
  type ProviderSourceIdentity,
  type PullCandidate,
} from "../../provider-adapter.ts";

export const GAMESTOP_PLATFORM_KEY = "gamestop" as const;
export const GAMESTOP_MAPPER_VERSION = "gamestop-v1" as const;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  const normalized = text(value);
  return normalized && normalized.length <= 512 ? normalized : null;
}

function images(...values: unknown[]): readonly string[] {
  const flattened = values.flatMap((value): unknown[] => {
    const record = object(value);
    return record ? Object.values(record) : [value];
  });
  return Object.freeze([
    ...new Set(flattened.map(text).filter((value): value is string => value !== null)),
  ]);
}

function invalid(
  source: ProviderSourceIdentity,
  reasonCode: string,
  fieldPath: string,
): ProviderRecordMappingOutcome {
  return { status: "invalid", source, failure: { reasonCode, fieldPath } };
}

function mapped(
  source: ProviderSourceIdentity,
  candidates: readonly ProviderAdapterCandidate[],
): ProviderRecordMappingOutcome {
  return { status: "mapped", source, candidates: Object.freeze([...candidates]) };
}

function tierDistribution(level: Record<string, unknown>) {
  const tiers = Array.isArray(level.tiers) ? level.tiers : [];
  const buckets = tiers.flatMap((value, index): ProbabilityBucketInput[] => {
    const tier = object(value);
    if (!tier) return [];
    return [{
      bucketId: `tier-${index + 1}`,
      evidenceKind: "probability_bucket",
      label: `Tier ${index + 1}`,
      probability: finite(tier.probability),
      lowerValue: finite(tier.startRange),
      upperValue: finite(tier.endRange),
    }];
  });
  const coverage = buckets.reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0);
  const complete =
    buckets.length > 0 &&
    Math.abs(coverage - 1) <= 0.000001 &&
    buckets.every((bucket) =>
      bucket.probability !== null && bucket.probability >= 0 &&
      bucket.lowerValue !== null && bucket.lowerValue >= 0 &&
      bucket.upperValue !== null && bucket.upperValue >= bucket.lowerValue,
    );
  return { buckets: Object.freeze(buckets), coverage, complete };
}

function chaseAssets(
  envelope: CatalogEnvelopeV1,
  source: ProviderSourceIdentity,
  levelId: string,
  level: Record<string, unknown>,
): readonly CatalogAssetCandidate[] {
  const values = Array.isArray(level.chaseCards) ? level.chaseCards : [];
  const seen = new Set<string>();
  return Object.freeze(values.flatMap((value, index): CatalogAssetCandidate[] => {
    const chase = object(value);
    const chaseId = identifier(chase?.collectibleId) ?? identifier(chase?.certIdentifier);
    if (!chaseId) return [];
    const externalId = `chase:${levelId}:${chaseId}`;
    if (seen.has(externalId)) return [];
    seen.add(externalId);
    const estimatedValue = finite(chase?.estimatedValue);
    return [{
      candidateKind: "catalog_asset",
      source,
      externalId,
      assetType: "chase_card",
      relatedPackExternalId: levelId,
      parentExternalId: envelope.external_id,
      name: text(chase?.title) ?? `Chase card ${index + 1}`,
      category: text(chase?.certIssuer),
      availability: "unknown",
      sourceStatus: "top_chase_evidence",
      estimatedValue:
        estimatedValue !== null && estimatedValue >= 0
          ? { amount: estimatedValue, currency: "USD" }
          : null,
      valueSource: estimatedValue === null ? null : "provider_estimated_value",
      imageUrls: images(chase?.frontImage, chase?.backImage),
      relationships: [{
        entityKind: "pack",
        platform: GAMESTOP_PLATFORM_KEY,
        externalId: levelId,
        relationship: "subject",
      }],
      dataQualityEvidence: [{ code: "CHASE_LIST_NOT_COMPLETE_INVENTORY", severity: "info" }],
    }];
  }));
}

function mapCatalog(envelope: CatalogEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "catalog", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "GAMESTOP_CATALOG_DATA_INVALID", "data");
  const categoryName = text(data.displayName) ?? text(data.label) ?? text(data.name);
  if (!categoryName) return invalid(source, "GAMESTOP_CATEGORY_NAME_MISSING", "data.displayName");
  const levels = Array.isArray(data.levels) ? data.levels : [];
  if (levels.length === 0) return invalid(source, "GAMESTOP_LEVELS_MISSING", "data.levels");

  const parent: CatalogAssetCandidate = {
    candidateKind: "catalog_asset",
    source,
    externalId: envelope.external_id,
    assetType: "pack_category",
    relatedPackExternalId: null,
    parentExternalId: null,
    name: categoryName,
    category: text(data.name),
    availability: text(data.availability) === "SOLD_OUT" ? "sold_out" : "active",
    sourceStatus: text(data.availability),
    estimatedValue: null,
    valueSource: null,
    imageUrls: images(data.image),
    relationships: [],
    dataQualityEvidence: [],
  };

  const candidates: ProviderAdapterCandidate[] = [parent];
  for (const [levelIndex, value] of levels.entries()) {
    const level = object(value);
    const levelId = identifier(level?.levelId);
    const name = text(level?.name);
    const price = finite(level?.price);
    if (!level || !levelId || !name || price === null || price <= 0) {
      return invalid(source, "GAMESTOP_LEVEL_INVALID", `data.levels[${levelIndex}]`);
    }
    const sourceStatus = text(level.availability);
    const pack: CanonicalPackCandidate = {
      candidateKind: "pack",
      source,
      externalId: levelId,
      parentExternalId: envelope.external_id,
      name: `${categoryName} — ${name}`,
      description: text(data.description),
      category: text(data.name),
      availability:
        sourceStatus === "SOLD_OUT"
          ? "sold_out"
          : sourceStatus === "AVAILABLE" || sourceStatus === "LOW_STOCK"
            ? "active"
            : "unknown",
      sourceStatus,
      price: { amount: price, currency: "USD" },
      imageUrls: images(data.image),
      providerReportedEv: null,
      buybackPercent: null,
      drawCount: 1,
      relationships: [{
        entityKind: "catalog_asset",
        platform: GAMESTOP_PLATFORM_KEY,
        externalId: envelope.external_id,
        relationship: "parent",
      }],
      dataQualityEvidence: sourceStatus === "LOW_STOCK"
        ? [{ code: "GAMESTOP_LOW_STOCK", severity: "info" }]
        : [],
    };
    const distribution = tierDistribution(level);
    const evInput: EvInputCandidate = {
      candidateKind: "ev_input",
      source,
      externalId: `${levelId}:tiers`,
      packExternalId: levelId,
      currency: "USD",
      unitBasis: "per_pack",
      drawCount: 1,
      declaredCoverage: distribution.coverage,
      evidenceCompleteness: distribution.complete ? "complete" : "partial",
      buckets: distribution.buckets,
      relationships: [{
        entityKind: "pack",
        platform: GAMESTOP_PLATFORM_KEY,
        externalId: levelId,
        relationship: "subject",
      }],
      dataQualityEvidence: distribution.complete
        ? []
        : [{ code: "GAMESTOP_TIER_DISTRIBUTION_INCOMPLETE", severity: "warning", fieldPath: `data.levels[${levelIndex}].tiers` }],
    };
    candidates.push(pack, evInput, ...chaseAssets(envelope, source, levelId, level));
  }
  return mapped(source, candidates);
}

function resolvePullLevel(page: ProviderFeedPageV1, data: Record<string, unknown>) {
  const categoryId = identifier(data.categoryId);
  const assetsSlug = text(data.assetsSlug);
  const levelName = text(data.levelDisplayName);
  const levelPrice = finite(data.levelPrice);
  if (!categoryId || !assetsSlug || !levelName || levelPrice === null) return null;
  const matches = page.catalog.flatMap((catalog) => {
    if (catalog.external_id !== categoryId) return [];
    const catalogData = object(catalog.data);
    const levels = Array.isArray(catalogData?.levels) ? catalogData.levels : [];
    return levels.flatMap((value) => {
      const level = object(value);
      return level &&
        text(level.assetsSlug) === assetsSlug &&
        text(level.name) === levelName &&
        finite(level.price) === levelPrice
        ? [identifier(level.levelId)]
        : [];
    }).filter((value): value is string => value !== null);
  });
  return matches.length === 1 ? matches[0]! : null;
}

function mapPull(
  envelope: PullEnvelopeV1,
  recordIndex: number,
  page: ProviderFeedPageV1,
) {
  const source = sourceIdentityForEnvelope({ recordKind: "pull", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "GAMESTOP_PULL_DATA_INVALID", "data");
  const assetExternalId = identifier(data.collectibleId) ?? text(data.assetsSlug);
  const packExternalId = resolvePullLevel(page, data);
  const value = finite(data.estimatedValue);
  const categoryId = identifier(data.categoryId);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId,
    assetExternalId,
    occurredAt: envelope.occurred_at,
    value: value !== null && value >= 0 ? { amount: value, currency: "USD" } : null,
    valueSource: value === null ? null : "provider_estimated_value",
    pseudonymizationInputs: [],
    relationships: [
      ...(packExternalId ? [{
        entityKind: "pack" as const,
        platform: GAMESTOP_PLATFORM_KEY,
        externalId: packExternalId,
        relationship: "subject" as const,
      }] : categoryId ? [{
        entityKind: "catalog_asset" as const,
        platform: GAMESTOP_PLATFORM_KEY,
        externalId: categoryId,
        relationship: "source" as const,
      }] : []),
    ],
    dataQualityEvidence: [
      ...(packExternalId ? [] : [{ code: "GAMESTOP_PULL_LEVEL_UNRESOLVED", severity: "warning" as const, fieldPath: "data.levelDisplayName" }]),
      ...(text(data.grade) || finite(data.grade) !== null ? [{ code: "GAMESTOP_PULL_GRADE_PRESENT", severity: "info" as const }] : []),
      ...(images(data.frontImage, data.backImage).length > 0 ? [{ code: "GAMESTOP_PULL_IMAGES_PRESENT", severity: "info" as const }] : []),
    ],
  };
  return mapped(source, [candidate]);
}

export class GameStopMappingAdapter implements ProviderMappingAdapter {
  readonly key = GAMESTOP_MAPPER_VERSION;
  readonly platformKey = GAMESTOP_PLATFORM_KEY;

  mapPage(input: {
    configuration: { platform: string };
    page: ProviderFeedPageV1;
    recordIndexes: Readonly<{ catalog: readonly number[]; pulls: readonly number[]; sales: readonly number[] }>;
  }) {
    if (input.configuration.platform !== this.platformKey) {
      throw new Error("GameStop mapper platform mismatch.");
    }
    return {
      outcomes: Object.freeze([
        ...input.recordIndexes.catalog.map((index) => mapCatalog(input.page.catalog[index]!, index)),
        ...input.recordIndexes.pulls.map((index) => mapPull(input.page.pulls[index]!, index, input.page)),
        ...input.recordIndexes.sales.map((index) => {
          const envelope = input.page.sales[index]!;
          const source = sourceIdentityForEnvelope({ recordKind: "sale", recordIndex: index, envelope });
          return invalid(source, "GAMESTOP_SALE_UNSUPPORTED", "sales");
        }),
      ]),
    };
  }
}
