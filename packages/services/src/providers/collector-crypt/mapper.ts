import type {
  CatalogEnvelopeV1,
  ProviderFeedPageV1,
  PullEnvelopeV1,
  SaleEnvelopeV1,
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
  type PseudonymousActorInput,
  type SaleCandidate,
} from "../../provider-adapter.ts";

export const COLLECTOR_CRYPT_PLATFORM_KEY = "collector_crypt" as const;
export const COLLECTOR_CRYPT_MAPPER_VERSION = "collector-crypt-v1" as const;

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
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    typeof value === "string" &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringArray(values: unknown[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map(text).filter((value): value is string => value !== null))],
  );
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

function sourceForCatalog(envelope: CatalogEnvelopeV1, recordIndex: number) {
  return sourceIdentityForEnvelope({ recordKind: "catalog", recordIndex, envelope });
}

function sourceForPull(envelope: PullEnvelopeV1, recordIndex: number) {
  return sourceIdentityForEnvelope({ recordKind: "pull", recordIndex, envelope });
}

function sourceForSale(envelope: SaleEnvelopeV1, recordIndex: number) {
  return sourceIdentityForEnvelope({ recordKind: "sale", recordIndex, envelope });
}

function actor(
  role: PseudonymousActorInput["role"],
  value: unknown,
): PseudonymousActorInput | null {
  const sourceIdentifier = text(value);
  return sourceIdentifier
    ? { role, namespace: "collector_crypt_account", sourceIdentifier }
    : null;
}

function actors(...values: (PseudonymousActorInput | null)[]) {
  const seen = new Set<string>();
  return Object.freeze(
    values.filter((value): value is PseudonymousActorInput => {
      if (!value) return false;
      const key = `${value.role}:${value.namespace}:${value.sourceIdentifier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

function cardCatalog(
  envelope: CatalogEnvelopeV1,
  source: ProviderSourceIdentity,
  data: Record<string, unknown>,
): ProviderRecordMappingOutcome {
  const externalId = envelope.external_id;
  const itemName = text(data.itemName);
  if (!itemName) return invalid(source, "COLLECTOR_CRYPT_CARD_NAME_MISSING", "data.itemName");
  const insuredValue = finite(data.insuredValue);
  const sourceStatus = text(data.status) ?? text(data.nftStatus);
  const candidate: CatalogAssetCandidate = {
    candidateKind: "catalog_asset",
    source,
    externalId,
    assetType: text(data.type) ?? "collectible",
    relatedPackExternalId: null,
    parentExternalId: null,
    name: itemName,
    category: text(data.category),
    availability:
      text(data.nftStatus)?.toLowerCase() === "valid" ? "active" : "unknown",
    sourceStatus,
    estimatedValue:
      insuredValue !== null && insuredValue >= 0
        ? { amount: insuredValue, currency: "USD" }
        : null,
    valueSource: insuredValue === null ? null : "provider_insured_value",
    imageUrls: stringArray([data.frontImage, data.backImage]),
    relationships: [],
    dataQualityEvidence:
      data.insuredValue !== null && data.insuredValue !== undefined && insuredValue === null
        ? [{ code: "COLLECTOR_CRYPT_INSURED_VALUE_INVALID", severity: "warning", fieldPath: "data.insuredValue" }]
        : [],
  };
  return mapped(source, [candidate]);
}

function probabilityBuckets(
  data: Record<string, unknown>,
): { buckets: readonly ProbabilityBucketInput[]; coverage: number; complete: boolean } {
  const ranges = object(data.tierRanges);
  const weights = object(data.weightMultipliers);
  if (!ranges || !weights) return { buckets: [], coverage: 0, complete: false };
  const tierNames = [...new Set([...Object.keys(ranges), ...Object.keys(weights)])].sort();
  const buckets = tierNames.map((tier): ProbabilityBucketInput => {
    const range = object(ranges[tier]);
    return {
      bucketId: tier,
      evidenceKind: "probability_bucket",
      label: tier,
      probability: finite(weights[tier]),
      lowerValue: finite(range?.start),
      upperValue: finite(range?.end),
    };
  });
  const coverage = buckets.reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0);
  return {
    buckets: Object.freeze(buckets),
    coverage,
    complete:
      buckets.length > 0 &&
      Math.abs(coverage - 1) <= 0.000001 &&
      buckets.every(
        (bucket) =>
          bucket.probability !== null &&
          bucket.probability >= 0 &&
          bucket.lowerValue !== null &&
          bucket.upperValue !== null &&
          bucket.lowerValue >= 0 &&
          bucket.upperValue >= bucket.lowerValue,
      ),
  };
}

function gachaCatalog(
  envelope: CatalogEnvelopeV1,
  source: ProviderSourceIdentity,
  data: Record<string, unknown>,
): ProviderRecordMappingOutcome {
  const name = text(data.name) ?? text(data.shortName);
  const price = finite(object(data.price)?.amount);
  if (!name) return invalid(source, "COLLECTOR_CRYPT_GACHA_NAME_MISSING", "data.name");
  if (price === null || price <= 0) {
    return invalid(source, "COLLECTOR_CRYPT_GACHA_PRICE_INVALID", "data.price.amount");
  }
  const archived = data.archived === true;
  const isPublic = data.public !== false;
  const providerEv = finite(data.targetEV) ?? finite(data.maxEV);
  const buybackPercent = finite(object(data.instantBuyback)?.percentageOfValue);
  const drawCount = finite(data.contains);
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    externalId: envelope.external_id,
    parentExternalId: null,
    name,
    description: null,
    category: text(data.menuCategory),
    availability: archived || !isPublic ? "disabled" : "active",
    sourceStatus: archived ? "archived" : isPublic ? "public" : "private",
    price: { amount: price, currency: "USD" },
    imageUrls: stringArray([data.image, data.thumbnailUrl]),
    providerReportedEv:
      providerEv !== null && providerEv >= 0
        ? { amount: providerEv, currency: "USD" }
        : null,
    buybackPercent:
      buybackPercent !== null && buybackPercent >= 0 && buybackPercent <= 100
        ? buybackPercent
        : null,
    drawCount: drawCount !== null && Number.isInteger(drawCount) && drawCount > 0
      ? drawCount
      : null,
    relationships: [],
    dataQualityEvidence: [],
  };
  const distribution = probabilityBuckets(data);
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${envelope.external_id}:tiers`,
    packExternalId: envelope.external_id,
    currency: "USD",
    unitBasis: "per_pack",
    drawCount: pack.drawCount ?? 1,
    declaredCoverage: distribution.coverage,
    evidenceCompleteness: distribution.complete ? "complete" : "partial",
    buckets: distribution.buckets,
    relationships: [
      {
        entityKind: "pack",
        platform: COLLECTOR_CRYPT_PLATFORM_KEY,
        externalId: envelope.external_id,
        relationship: "subject",
      },
    ],
    dataQualityEvidence: distribution.complete
      ? []
      : [{ code: "COLLECTOR_CRYPT_DISTRIBUTION_INCOMPLETE", severity: "warning", fieldPath: "data.weightMultipliers" }],
  };
  const topNfts = Array.isArray(data.topNfts) ? data.topNfts : [];
  const assets = topNfts.flatMap((value, index): CatalogAssetCandidate[] => {
    const top = object(value);
    const id = text(top?.id) ?? text(top?.nft_address);
    if (!id) return [];
    const amount = finite(top?.insured_value);
    return [{
      candidateKind: "catalog_asset",
      source,
      externalId: `top:${id}`,
      assetType: "top_nft",
      relatedPackExternalId: envelope.external_id,
      parentExternalId: null,
      name: text(top?.name) ?? `Top item ${index + 1}`,
      category: text(top?.rarity),
      availability: "unknown",
      sourceStatus: "top_nft_evidence",
      estimatedValue: amount !== null && amount >= 0 ? { amount, currency: "USD" } : null,
      valueSource: amount === null ? null : "provider_insured_value",
      imageUrls: stringArray([top?.image]),
      relationships: [{
        entityKind: "pack",
        platform: COLLECTOR_CRYPT_PLATFORM_KEY,
        externalId: envelope.external_id,
        relationship: "subject",
      }],
      dataQualityEvidence: [{ code: "TOP_LIST_NOT_COMPLETE_INVENTORY", severity: "info" }],
    }];
  });
  return mapped(source, [pack, evInput, ...assets]);
}

function mapCatalog(envelope: CatalogEnvelopeV1, recordIndex: number) {
  const source = sourceForCatalog(envelope, recordIndex);
  const data = object(envelope.data);
  if (!data) return invalid(source, "COLLECTOR_CRYPT_CATALOG_DATA_INVALID", "data");
  if (envelope.external_id.startsWith("card:")) return cardCatalog(envelope, source, data);
  if (envelope.external_id.startsWith("gacha:")) return gachaCatalog(envelope, source, data);
  return invalid(source, "COLLECTOR_CRYPT_CATALOG_KIND_UNKNOWN", "external_id");
}

function mapPull(envelope: PullEnvelopeV1, recordIndex: number) {
  const source = sourceForPull(envelope, recordIndex);
  const data = object(envelope.data);
  if (!data) return invalid(source, "COLLECTOR_CRYPT_PULL_DATA_INVALID", "data");
  const nft = object(data.nft);
  const assetId = text(nft?.id) ?? text(nft?.nft_address);
  const winner = object(data.winner);
  const winnerActor = actor("actor", winner?.id ?? winner?.wallet ?? data.winner);
  const value = finite(data.insuredValue);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: envelope.pack_external_id,
    assetExternalId: assetId ? `card:${assetId}` : null,
    occurredAt: envelope.occurred_at,
    value: value !== null && value >= 0 ? { amount: value, currency: "USD" } : null,
    valueSource: value === null ? null : "provider_insured_value",
    pseudonymizationInputs: actors(winnerActor),
    relationships: [
      ...(envelope.pack_external_id ? [{
        entityKind: "pack" as const,
        platform: COLLECTOR_CRYPT_PLATFORM_KEY,
        externalId: envelope.pack_external_id,
        relationship: "subject" as const,
      }] : []),
      ...(assetId ? [{
        entityKind: "catalog_asset" as const,
        platform: COLLECTOR_CRYPT_PLATFORM_KEY,
        externalId: `card:${assetId}`,
        relationship: "asset" as const,
      }] : []),
    ],
    dataQualityEvidence: [],
  };
  return mapped(source, [candidate]);
}

function mapSale(envelope: SaleEnvelopeV1, recordIndex: number) {
  const source = sourceForSale(envelope, recordIndex);
  const data = object(envelope.data);
  if (!data) return invalid(source, "COLLECTOR_CRYPT_SALE_DATA_INVALID", "data");
  const from = object(data.from);
  const to = object(data.to);
  const currency = text(envelope.currency);
  const candidate: SaleCandidate = {
    candidateKind: "sale",
    source,
    eventType: envelope.event_type,
    transactionKey: envelope.tx_hash ?? envelope.external_id,
    assetExternalId: text(data.cardId) ? `card:${text(data.cardId)}` : null,
    packExternalId: null,
    occurredAt: envelope.occurred_at,
    amount:
      envelope.amount !== null && currency
        ? { amount: envelope.amount, currency }
        : null,
    pseudonymizationInputs: actors(
      actor("from", from?.id ?? from?.wallet),
      actor("to", to?.id ?? to?.wallet),
    ),
    relationships: [],
    dataQualityEvidence: [],
  };
  return mapped(source, [candidate]);
}

export class CollectorCryptMappingAdapter implements ProviderMappingAdapter {
  readonly key = COLLECTOR_CRYPT_MAPPER_VERSION;
  readonly platformKey = COLLECTOR_CRYPT_PLATFORM_KEY;

  mapPage(input: {
    configuration: { platform: string };
    page: ProviderFeedPageV1;
    recordIndexes: Readonly<{
      catalog: readonly number[];
      pulls: readonly number[];
      sales: readonly number[];
    }>;
  }) {
    if (input.configuration.platform !== this.platformKey) {
      throw new Error("Collector Crypt mapper received a different platform.");
    }
    return {
      outcomes: Object.freeze([
        ...input.recordIndexes.catalog.map((index) => mapCatalog(input.page.catalog[index]!, index)),
        ...input.recordIndexes.pulls.map((index) => mapPull(input.page.pulls[index]!, index)),
        ...input.recordIndexes.sales.map((index) => mapSale(input.page.sales[index]!, index)),
      ]),
    };
  }
}
