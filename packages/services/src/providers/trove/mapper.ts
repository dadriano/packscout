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

export const TROVE_PLATFORM_KEY = "trove" as const;
export const TROVE_MAPPER_VERSION = "trove-v1" as const;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function identity(value: unknown): string | null {
  const normalized = text(value) ?? (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null);
  return normalized && normalized.length <= 512 ? normalized : null;
}

function safeText(value: unknown): string | null {
  const normalized = text(value);
  return normalized
    ? [...normalized]
        .map((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code <= 31 || code === 127 ? " " : character;
        })
        .join("")
        .replace(/\s{2,}/g, " ")
        .slice(0, 4_000)
    : null;
}

function images(values: unknown[]) {
  return Object.freeze([...new Set(values.map(text).filter((value): value is string => value !== null))]);
}

function invalid(source: ProviderSourceIdentity, reasonCode: string, fieldPath: string): ProviderRecordMappingOutcome {
  return { status: "invalid", source, failure: { reasonCode, fieldPath } };
}

function mapped(source: ProviderSourceIdentity, candidates: readonly ProviderAdapterCandidate[]): ProviderRecordMappingOutcome {
  return { status: "mapped", source, candidates: Object.freeze([...candidates]) };
}

function tiers(data: Record<string, unknown>) {
  const semantics = text(data.tier_range_semantics);
  const values = Array.isArray(data.tiers) ? data.tiers : [];
  const active = values.filter((value) => object(value)?.active === true);
  const buckets = active.flatMap((value, index): ProbabilityBucketInput[] => {
    const tier = object(value);
    if (!tier) return [];
    return [{
      bucketId: identity(tier.id) ?? `tier-${index + 1}`,
      evidenceKind: "probability_bucket",
      label: text(tier.name),
      probability: finite(tier.probability),
      lowerValue: finite(tier.value_min),
      upperValue: finite(tier.value_max),
    }];
  });
  const coverage = buckets.reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0);
  const complete =
    semantics === "exclusive_min" &&
    buckets.length > 0 &&
    Math.abs(coverage - 1) <= 0.000001 &&
    buckets.every((bucket) =>
      bucket.probability !== null && bucket.probability >= 0 &&
      bucket.lowerValue !== null && bucket.lowerValue >= 0 &&
      bucket.upperValue !== null && bucket.upperValue >= bucket.lowerValue,
    );
  return { buckets: Object.freeze(buckets), coverage, complete };
}

function grailAssets(
  envelope: CatalogEnvelopeV1,
  source: ProviderSourceIdentity,
  data: Record<string, unknown>,
) {
  const grails = Array.isArray(data.grails) ? data.grails : [];
  return Object.freeze(grails.flatMap((value, index): CatalogAssetCandidate[] => {
    const grail = object(value);
    const id = identity(grail?.id);
    if (!id) return [];
    const estimatedValue = finite(grail?.estimated_value);
    const imageValues = Array.isArray(grail?.images) ? grail.images : [];
    return [{
      candidateKind: "catalog_asset",
      source,
      externalId: `grail:${id}`,
      assetType: "grail",
      relatedPackExternalId: envelope.external_id,
      parentExternalId: null,
      name: text(grail?.name) ?? `Grail ${index + 1}`,
      category: null,
      availability: "unknown",
      sourceStatus: "grail_evidence",
      estimatedValue:
        estimatedValue !== null && estimatedValue >= 0
          ? { amount: estimatedValue, currency: "USD" }
          : null,
      valueSource: estimatedValue === null ? null : "provider_estimated_value",
      imageUrls: images([grail?.image_uri, ...imageValues]),
      relationships: [{
        entityKind: "pack",
        platform: TROVE_PLATFORM_KEY,
        externalId: envelope.external_id,
        relationship: "subject",
      }],
      dataQualityEvidence: [{ code: "GRAIL_LIST_NOT_COMPLETE_INVENTORY", severity: "info" }],
    }];
  }));
}

function mapCatalog(envelope: CatalogEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "catalog", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "TROVE_CATALOG_DATA_INVALID", "data");
  const name = text(data.name);
  const price = finite(data.price);
  const drawCount = finite(data.cards_per_pack);
  if (!name) return invalid(source, "TROVE_PACK_NAME_MISSING", "data.name");
  if (price === null || price <= 0) return invalid(source, "TROVE_PACK_PRICE_INVALID", "data.price");
  if (drawCount === null || !Number.isInteger(drawCount) || drawCount <= 0) {
    return invalid(source, "TROVE_DRAW_COUNT_INVALID", "data.cards_per_pack");
  }
  const availability = text(data.availability);
  const status = text(data.definition_status);
  const categoryIds = Array.isArray(data.category_ids) ? data.category_ids : [];
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    externalId: envelope.external_id,
    parentExternalId: identity(data.pack_group_id),
    name,
    description: safeText(data.description),
    category: text(data.collectible_type) ?? identity(categoryIds[0]),
    availability:
      availability === "in_stock" && status === "active"
        ? "available"
        : availability === "sold_out"
          ? "sold_out"
          : "unavailable",
    sourceStatus: availability ?? status,
    price: { amount: price, currency: "USD" },
    imageUrls: images([data.image_uri]),
    providerReportedEv: null,
    buybackPercent: null,
    drawCount,
    relationships: identity(data.pack_group_id) ? [{
      entityKind: "catalog_asset",
      platform: TROVE_PLATFORM_KEY,
      externalId: `group:${identity(data.pack_group_id)}`,
      relationship: "parent",
    }] : [],
    dataQualityEvidence: [],
  };
  const distribution = tiers(data);
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${envelope.external_id}:tiers:v${identity(data.version) ?? "unknown"}`,
    packExternalId: envelope.external_id,
    currency: "USD",
    unitBasis: "per_draw",
    drawCount,
    declaredCoverage: distribution.coverage,
    evidenceCompleteness: distribution.complete ? "complete" : "partial",
    buckets: distribution.buckets,
    relationships: [{
      entityKind: "pack",
      platform: TROVE_PLATFORM_KEY,
      externalId: envelope.external_id,
      relationship: "subject",
    }],
    dataQualityEvidence: distribution.complete
      ? []
      : [{ code: "TROVE_TIER_DISTRIBUTION_INCOMPLETE", severity: "warning", fieldPath: "data.tiers" }],
  };
  return mapped(source, [pack, evInput, ...grailAssets(envelope, source, data)]);
}

function mapPull(envelope: PullEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "pull", recordIndex, envelope });
  const data = object(envelope.data);
  const collectible = object(data?.collectible);
  if (!data || !collectible) return invalid(source, "TROVE_PULL_COLLECTIBLE_MISSING", "data.collectible");
  const assetId = identity(collectible.id);
  const value = finite(collectible.estimated_value);
  const puller = object(data.puller);
  const pullerId = identity(puller?.id);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: envelope.pack_external_id,
    assetExternalId: assetId,
    occurredAt: envelope.occurred_at,
    value: value !== null && value >= 0 ? { amount: value, currency: "USD" } : null,
    valueSource: value === null ? null : "provider_estimated_value",
    pseudonymizationInputs: pullerId
      ? [{ role: "actor", namespace: "trove_account", sourceIdentifier: pullerId }]
      : [],
    relationships: envelope.pack_external_id ? [{
      entityKind: "pack",
      platform: TROVE_PLATFORM_KEY,
      externalId: envelope.pack_external_id,
      relationship: "subject",
    }] : [],
    dataQualityEvidence: [],
  };
  return mapped(source, [candidate]);
}

export class TroveMappingAdapter implements ProviderMappingAdapter {
  readonly key = TROVE_MAPPER_VERSION;
  readonly platformKey = TROVE_PLATFORM_KEY;

  mapPage(input: {
    configuration: { platform: string };
    page: ProviderFeedPageV1;
    recordIndexes: Readonly<{ catalog: readonly number[]; pulls: readonly number[]; trades: readonly number[] }>;
  }) {
    if (input.configuration.platform !== this.platformKey) throw new Error("Trove mapper platform mismatch.");
    return {
      outcomes: Object.freeze([
        ...input.recordIndexes.catalog.map((index) => mapCatalog(input.page.catalog[index]!, index)),
        ...input.recordIndexes.pulls.map((index) => mapPull(input.page.pulls[index]!, index)),
        ...input.recordIndexes.trades.map((index) => {
          const envelope = input.page.trades[index]!;
          const source = sourceIdentityForEnvelope({ recordKind: "trade", recordIndex: index, envelope });
          return invalid(source, "TROVE_TRADE_UNSUPPORTED", "trades");
        }),
      ]),
    };
  }
}
