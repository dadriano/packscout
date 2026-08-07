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

export const STADIUM_VAULT_PLATFORM_KEY = "stadium_vault" as const;
export const STADIUM_VAULT_MAPPER_VERSION = "stadium-vault-v1" as const;

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

function safeText(value: unknown, maximum = 4_000): string | null {
  const normalized = text(value);
  return normalized
    ? [...normalized]
        .map((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code <= 31 || code === 127 ? " " : character;
        })
        .join("")
        .replace(/\s{2,}/g, " ")
        .slice(0, maximum)
    : null;
}

function imageList(values: unknown[]) {
  return Object.freeze(
    [...new Set(values.map(text).filter((value): value is string => value !== null))],
  );
}

function invalid(source: ProviderSourceIdentity, reasonCode: string, fieldPath: string): ProviderRecordMappingOutcome {
  return { status: "invalid", source, failure: { reasonCode, fieldPath } };
}

function mapped(source: ProviderSourceIdentity, candidates: readonly ProviderAdapterCandidate[]): ProviderRecordMappingOutcome {
  return { status: "mapped", source, candidates: Object.freeze([...candidates]) };
}

function distribution(data: Record<string, unknown>) {
  const effective = Array.isArray(data.effectiveOddsTiers) ? data.effectiveOddsTiers : [];
  const selected = effective.length > 0
    ? effective
    : data.effectiveAlternativeOddsKey === null && Array.isArray(data.oddsTiers)
      ? data.oddsTiers
      : [];
  const evidenceSource = effective.length > 0 ? "effective" : selected.length > 0 ? "base" : "missing";
  const buckets = selected.flatMap((value, index): ProbabilityBucketInput[] => {
    const tier = object(value);
    if (!tier) return [];
    const percent = finite(tier.percent);
    return [{
      bucketId: `${evidenceSource}-${index + 1}`,
      evidenceKind: "probability_bucket",
      label: text(tier.name) ?? `Tier ${index + 1}`,
      probability: percent === null ? null : percent / 100,
      lowerValue: finite(tier.minUsd),
      upperValue: finite(tier.maxUsd),
    }];
  });
  const coverage = buckets.reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0);
  const complete =
    evidenceSource !== "missing" &&
    buckets.length > 0 &&
    Math.abs(coverage - 1) <= 0.000001 &&
    buckets.every((bucket) =>
      bucket.probability !== null && bucket.probability >= 0 &&
      bucket.lowerValue !== null && bucket.lowerValue >= 0 &&
      bucket.upperValue !== null && bucket.upperValue >= bucket.lowerValue,
    );
  return { buckets: Object.freeze(buckets), coverage, complete, evidenceSource };
}

function mapCatalog(envelope: CatalogEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "catalog", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "STADIUM_VAULT_CATALOG_DATA_INVALID", "data");
  const name = text(data.fullTitle) ?? text(data.title) ?? text(data.shortTitle);
  const price = finite(data.priceUsd);
  if (!name) return invalid(source, "STADIUM_VAULT_PACK_TITLE_MISSING", "data.title");
  if (price === null || price <= 0) return invalid(source, "STADIUM_VAULT_PACK_PRICE_INVALID", "data.priceUsd");
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    externalId: envelope.external_id,
    parentExternalId: null,
    name,
    description: safeText(data.description),
    category: text(data.category),
    availability: data.isSoldOut === true ? "sold_out" : data.isEnabled === true ? "active" : "disabled",
    sourceStatus: data.isSoldOut === true ? "sold_out" : data.isEnabled === true ? "enabled" : "disabled",
    price: { amount: price, currency: "USD" },
    imageUrls: imageList([data.imageUrl, data.bgImageUrl]),
    providerReportedEv: null,
    buybackPercent: null,
    drawCount: 1,
    relationships: [],
    dataQualityEvidence: [],
  };
  const odds = distribution(data);
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${envelope.external_id}:odds`,
    packExternalId: envelope.external_id,
    currency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: odds.coverage,
    evidenceCompleteness: odds.complete ? "complete" : "partial",
    buckets: odds.buckets,
    relationships: [{
      entityKind: "pack",
      platform: STADIUM_VAULT_PLATFORM_KEY,
      externalId: envelope.external_id,
      relationship: "subject",
    }],
    dataQualityEvidence: odds.complete
      ? [{ code: `STADIUM_VAULT_${odds.evidenceSource.toUpperCase()}_ODDS_USED`, severity: "info" }]
      : [{ code: "STADIUM_VAULT_ODDS_INCOMPLETE", severity: "warning", fieldPath: "data.effectiveOddsTiers" }],
  };
  const topPulls = Array.isArray(data.topPossiblePulls) ? data.topPossiblePulls : [];
  const assets = topPulls.flatMap((value, index): CatalogAssetCandidate[] => {
    const item = object(value);
    const id = text(item?.id);
    if (!id) return [];
    const valueUsd = finite(item?.valueUsd);
    return [{
      candidateKind: "catalog_asset",
      source,
      externalId: `top:${id}`,
      assetType: "top_possible_pull",
      relatedPackExternalId: envelope.external_id,
      parentExternalId: null,
      name: text(item?.subject) ?? text(item?.title) ?? `Top pull ${index + 1}`,
      category: text(item?.category),
      availability: "unknown",
      sourceStatus: "top_pull_evidence",
      estimatedValue: valueUsd !== null && valueUsd >= 0 ? { amount: valueUsd, currency: "USD" } : null,
      valueSource: valueUsd === null ? null : "provider_value",
      imageUrls: imageList([item?.frontImage, item?.backImage, item?.imageUrl]),
      relationships: [{
        entityKind: "pack",
        platform: STADIUM_VAULT_PLATFORM_KEY,
        externalId: envelope.external_id,
        relationship: "subject",
      }],
      dataQualityEvidence: [{ code: "TOP_LIST_NOT_COMPLETE_INVENTORY", severity: "info" }],
    }];
  });
  return mapped(source, [pack, evInput, ...assets]);
}

function mapPull(envelope: PullEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "pull", recordIndex, envelope });
  const data = object(envelope.data);
  const card = object(data?.card);
  if (!data || !card) return invalid(source, "STADIUM_VAULT_PULL_CARD_MISSING", "data.card");
  const valueUsd = finite(card.valueUsd);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: envelope.pack_external_id,
    assetExternalId: text(card.id),
    occurredAt: envelope.occurred_at,
    value: valueUsd !== null && valueUsd >= 0 ? { amount: valueUsd, currency: "USD" } : null,
    valueSource: valueUsd === null ? null : "provider_value",
    pseudonymizationInputs: [],
    relationships: envelope.pack_external_id ? [{
      entityKind: "pack",
      platform: STADIUM_VAULT_PLATFORM_KEY,
      externalId: envelope.pack_external_id,
      relationship: "subject",
    }] : [],
    dataQualityEvidence: [],
  };
  return mapped(source, [candidate]);
}

export class StadiumVaultMappingAdapter implements ProviderMappingAdapter {
  readonly key = STADIUM_VAULT_MAPPER_VERSION;
  readonly platformKey = STADIUM_VAULT_PLATFORM_KEY;

  mapPage(input: {
    configuration: { platform: string };
    page: ProviderFeedPageV1;
    recordIndexes: Readonly<{ catalog: readonly number[]; pulls: readonly number[]; sales: readonly number[] }>;
  }) {
    if (input.configuration.platform !== this.platformKey) throw new Error("Stadium Vault mapper platform mismatch.");
    return {
      outcomes: Object.freeze([
        ...input.recordIndexes.catalog.map((index) => mapCatalog(input.page.catalog[index]!, index)),
        ...input.recordIndexes.pulls.map((index) => mapPull(input.page.pulls[index]!, index)),
        ...input.recordIndexes.sales.map((index) => {
          const envelope = input.page.sales[index]!;
          const source = sourceIdentityForEnvelope({ recordKind: "sale", recordIndex: index, envelope });
          return invalid(source, "STADIUM_VAULT_SALE_UNSUPPORTED", "sales");
        }),
      ]),
    };
  }
}
