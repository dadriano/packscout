import type {
  CatalogRecordV2,
  PullRecordV2,
  TradeRecordV2,
} from "@packscout/contracts";
import type {
  CatalogAssetCandidate,
  CanonicalPackCandidate,
  EvInputCandidate,
  ProbabilityBucketInput,
  ProviderDataQualityEvidence,
  ProviderMappingAdapter,
  ProviderRecordMappingOutcome,
  ProviderRelationshipKey,
  ProviderSourceIdentity,
  PullCandidate,
  TradeCandidate,
} from "../../provider-adapter.ts";
import {
  information,
  invalidOutcome,
  mappedOutcome,
  nonNegativeNumber,
  optionalObject,
  optionalSingleLineString,
  optionalString,
  sourceForRecord,
  uniqueStrings,
  warning,
  type JsonObject,
} from "../provider-mapping-utils.ts";

export const PHYGITALS_PLATFORM_KEY = "phygitals" as const;
export const PHYGITALS_MAPPER_VERSION = "phygitals-v2" as const;

function relationship(
  entityKind: ProviderRelationshipKey["entityKind"],
  externalId: string | null,
  kind: ProviderRelationshipKey["relationship"],
): ProviderRelationshipKey[] {
  return externalId === null
    ? []
    : [{
        entityKind,
        platform: PHYGITALS_PLATFORM_KEY,
        externalId,
        relationship: kind,
      }];
}

function optionalIdentifier(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : optionalString(value);
}

function imageReference(value: unknown): string | null {
  const direct = optionalString(value);
  if (direct !== null) return direct;
  const object = optionalObject(value);
  return optionalString(object?.url) ??
    optionalString(object?.uri) ??
    optionalString(object?.imageUrl);
}

function imageReferences(values: readonly unknown[]): readonly string[] {
  return uniqueStrings(
    values
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map(imageReference),
  );
}

function packAvailability(record: CatalogRecordV2) {
  if (record.available === true) return "active" as const;
  if (record.available === false) return "disabled" as const;
  if (record.data.enable === false) return "disabled" as const;
  if (record.data.in_stock === true) return "active" as const;
  if (record.data.in_stock === false && record.data.enable === true) {
    return "sold_out" as const;
  }
  return "unknown" as const;
}

function packSourceStatus(record: CatalogRecordV2): string | null {
  if (record.available === true) return "available";
  if (record.available === false) return "unavailable";
  if (record.data.enable === false) return "disabled";
  if (record.data.in_stock === true) return "in_stock";
  if (record.data.in_stock === false) return "out_of_stock";
  return null;
}

function rarityDistribution(data: JsonObject): {
  readonly buckets: readonly ProbabilityBucketInput[];
  readonly coverage: number;
  readonly complete: boolean;
} {
  const values = Array.isArray(data.rarity_distribution)
    ? data.rarity_distribution
    : [];
  const buckets = values.flatMap((value, index): ProbabilityBucketInput[] => {
    const rarity = optionalObject(value);
    if (rarity === null) return [];
    const weight = nonNegativeNumber(rarity.weight);
    return [{
      bucketId: optionalIdentifier(rarity.id) ?? `rarity-${index + 1}`,
      evidenceKind: "probability_bucket",
      label: optionalString(rarity.name),
      probability: weight === null ? null : weight / 100,
      lowerValue: nonNegativeNumber(rarity.lower),
      upperValue: nonNegativeNumber(rarity.upper),
    }];
  });
  const coverage = Number(
    buckets
      .reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0)
      .toFixed(12),
  );
  const complete =
    buckets.length > 0 &&
    Math.abs(coverage - 1) <= 0.000001 &&
    buckets.every(
      ({ probability, lowerValue, upperValue }) =>
        probability !== null &&
        probability <= 1 &&
        lowerValue !== null &&
        upperValue !== null &&
        upperValue >= lowerValue,
    );
  return { buckets: Object.freeze(buckets), coverage, complete };
}

function mapPack(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const data = record.data;
  const name = optionalString(data.name);
  if (name === null) {
    return invalidOutcome(source, "PHYGITALS_PACK_NAME_MISSING", "data.name");
  }
  const price = nonNegativeNumber(data.mint_price);
  if (price === null || price <= 0) {
    return invalidOutcome(
      source,
      "PHYGITALS_PACK_PRICE_INVALID",
      "data.mint_price",
    );
  }

  const providerEv = nonNegativeNumber(data.ev);
  const buybackRatio = nonNegativeNumber(data.buyback_percent);
  const rawDrawCount = nonNegativeNumber(data.pulls_per_voucher);
  const drawCount =
    rawDrawCount !== null &&
    Number.isSafeInteger(rawDrawCount) &&
    rawDrawCount > 0
      ? rawDrawCount
      : null;
  const parentExternalId = optionalIdentifier(data.variant_of);
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const distribution = rarityDistribution(data);
  const packQuality: ProviderDataQualityEvidence[] = [
    ...(providerEv === null
      ? [warning("PHYGITALS_PROVIDER_EV_UNAVAILABLE", "data.ev")]
      : []),
    ...(buybackRatio !== null && buybackRatio > 1
      ? [warning(
          "PHYGITALS_BUYBACK_RATIO_INVALID",
          "data.buyback_percent",
        )]
      : []),
    ...(drawCount === null
      ? [warning(
          "PHYGITALS_DRAW_SEMANTICS_UNAVAILABLE",
          "data.pulls_per_voucher",
        )]
      : []),
  ];
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    // V2 envelope identities are authoritative over nested provider IDs.
    externalId: record.record_id,
    parentExternalId,
    name,
    description: optionalSingleLineString(data.description),
    category: optionalString(data.category) ?? optionalString(categories[0]),
    availability: packAvailability(record),
    sourceStatus: packSourceStatus(record),
    price: { amount: price, currency: "USD" },
    imageUrls: imageReferences([data.claw_image_url]),
    providerReportedEv:
      providerEv === null
        ? null
        : { amount: providerEv, currency: "USD" },
    buybackPercent:
      buybackRatio !== null && buybackRatio <= 1
        ? buybackRatio * 100
        : null,
    drawCount,
    relationships: relationship("pack", parentExternalId, "parent"),
    dataQualityEvidence: packQuality,
  };
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${record.record_id}:rarity`,
    packExternalId: record.record_id,
    currency: "USD",
    unitBasis: drawCount === null ? null : "per_draw",
    drawCount,
    declaredCoverage: distribution.coverage,
    evidenceCompleteness:
      distribution.complete && drawCount !== null ? "complete" : "partial",
    buckets: distribution.buckets,
    relationships: relationship("pack", record.record_id, "subject"),
    dataQualityEvidence: [
      ...(distribution.complete
        ? []
        : [warning(
            "PHYGITALS_RARITY_DISTRIBUTION_INCOMPLETE",
            "data.rarity_distribution",
          )]),
      ...(drawCount === null
        ? [warning(
            "PHYGITALS_DRAW_SEMANTICS_UNAVAILABLE",
            "data.pulls_per_voucher",
          )]
        : []),
    ],
  };
  return mappedOutcome(source, [pack, evInput]);
}

function assetAvailability(asset: JsonObject) {
  if (asset.burned === true) return "disabled" as const;
  if (asset.is_available === true) return "active" as const;
  if (asset.is_available === false) return "disabled" as const;
  if (asset.in_stock === true) return "active" as const;
  if (asset.in_stock === false) return "sold_out" as const;
  const status = optionalString(asset.status)?.toLowerCase();
  if (status === "active" || status === "valid") return "active" as const;
  if (status === "burned" || status === "disabled") {
    return "disabled" as const;
  }
  return "unknown" as const;
}

function assetValue(asset: JsonObject): {
  readonly amount: number | null;
  readonly source: string | null;
} {
  const altFmv = nonNegativeNumber(asset.altFmv);
  if (altFmv !== null) {
    return {
      amount: altFmv,
      source: optionalString(asset.altFmvSource) ?? "provider_alt_fmv",
    };
  }
  const lastSale = nonNegativeNumber(asset.lastSale);
  return lastSale === null
    ? { amount: null, source: null }
    : { amount: lastSale, source: "provider_last_sale" };
}

function chaseValue(chase: JsonObject): {
  readonly amount: number | null;
  readonly source: string | null;
} {
  const fmv = nonNegativeNumber(chase.fmv);
  return fmv === null
    ? { amount: null, source: null }
    : { amount: fmv, source: "provider_fmv" };
}

function mapCard(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const asset = optionalObject(record.data.asset);
  const chase = optionalObject(record.data.chase);
  if ((asset === null) === (chase === null)) {
    return invalidOutcome(
      source,
      "PHYGITALS_CARD_BRANCH_INVALID",
      "data",
    );
  }

  const evidence = asset ?? chase!;
  const providerData = optionalObject(evidence.data);
  const details = optionalObject(evidence.details);
  const metadata = optionalObject(evidence.metadata);
  const value = chase === null ? assetValue(evidence) : chaseValue(evidence);
  const name =
    optionalString(evidence.name) ??
    optionalString(evidence.title) ??
    optionalString(metadata?.name) ??
    optionalString(providerData?.title) ??
    optionalString(details?.title);
  const properties = optionalObject(evidence.properties);
  const candidate: CatalogAssetCandidate = {
    candidateKind: "catalog_asset",
    source,
    externalId: record.record_id,
    assetType:
      chase === null
        ? optionalString(evidence.type) ?? "collectible"
        : "chase_collectible",
    relatedPackExternalId: null,
    parentExternalId: null,
    name,
    category:
      optionalString(evidence.category) ??
      optionalString(properties?.category) ??
      optionalString(providerData?.category) ??
      optionalString(details?.categoryPath),
    availability: chase === null ? assetAvailability(evidence) : "unknown",
    sourceStatus:
      chase === null
        ? optionalString(evidence.status) ??
          optionalString(evidence.internal_status)
        : "top_chase_evidence",
    estimatedValue:
      value.amount === null
        ? null
        : { amount: value.amount, currency: "USD" },
    valueSource: value.source,
    imageUrls: imageReferences([
      evidence.image,
      evidence.back_image,
      providerData?.image,
      details?.image,
      properties?.files,
    ]),
    relationships: [],
    dataQualityEvidence: [
      ...(name === null
        ? [warning("PHYGITALS_CARD_NAME_UNAVAILABLE", "data")]
        : []),
      ...(value.amount === null
        ? [information("PHYGITALS_CARD_VALUE_UNAVAILABLE", "data")]
        : []),
      ...(chase === null
        ? []
        : [information(
            "PHYGITALS_CHASE_NOT_COMPLETE_INVENTORY",
            "data.chase",
          )]),
    ],
  };
  return mappedOutcome(source, [candidate]);
}

function mapCatalog(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  return record.entity === "pack"
    ? mapPack(record, source)
    : mapCard(record, source);
}

function mapPull(
  record: PullRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: record.pack_id,
    assetExternalId: record.card_id,
    occurredAt: source.sourceTimestamp,
    value: null,
    valueSource: null,
    buybackStatus: null,
    buybackRefund: null,
    pseudonymizationInputs: [],
    relationships: [
      ...relationship("pack", record.pack_id, "subject"),
      ...relationship("catalog_asset", record.card_id, "asset"),
    ],
    dataQualityEvidence: [
      warning("PHYGITALS_PULL_PAYLOAD_UNCONFIRMED", "data"),
      warning("PHYGITALS_PULL_OUTCOME_VALUE_UNAVAILABLE", "data"),
      ...(record.card_id === null
        ? [warning("PHYGITALS_PULL_CARD_UNAVAILABLE", "card_id")]
        : []),
    ],
  };
  return mappedOutcome(source, [candidate]);
}

function tradeMoney(record: TradeRecordV2): {
  readonly amount: TradeCandidate["amount"];
  readonly quality: readonly ProviderDataQualityEvidence[];
} {
  const currency = optionalString(record.currency)?.toUpperCase() ?? null;
  if (record.amount === null && currency === null) {
    return { amount: null, quality: [] };
  }
  if (
    record.amount === null ||
    !Number.isFinite(record.amount) ||
    record.amount < 0 ||
    (currency !== "USD" && currency !== "USDC")
  ) {
    return {
      amount: null,
      quality: [warning("PHYGITALS_TRADE_MONEY_UNAVAILABLE", "currency")],
    };
  }
  return { amount: { amount: record.amount, currency }, quality: [] };
}

function mapTrade(
  record: TradeRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const money = tradeMoney(record);
  const candidate: TradeCandidate = {
    candidateKind: "trade",
    source,
    eventType: record.event_type,
    transactionKey: record.tx_hash,
    assetExternalId: record.card_id,
    packExternalId: null,
    occurredAt: source.sourceTimestamp,
    amount: money.amount,
    paymentMethod: optionalString(record.payment_method),
    pseudonymizationInputs: [],
    relationships: relationship("catalog_asset", record.card_id, "asset"),
    dataQualityEvidence: [
      warning("PHYGITALS_TRADE_PAYLOAD_UNCONFIRMED", "data"),
      ...money.quality,
    ],
  };
  return mappedOutcome(source, [candidate]);
}

export class PhygitalsMappingAdapter implements ProviderMappingAdapter {
  readonly key = PHYGITALS_MAPPER_VERSION;
  readonly platformKey = PHYGITALS_PLATFORM_KEY;

  mapRecord(
    input: Parameters<ProviderMappingAdapter["mapRecord"]>[0],
  ): ProviderRecordMappingOutcome {
    if (
      input.configuration.platform !== this.platformKey ||
      input.record.platform !== this.platformKey
    ) {
      throw new Error("Phygitals mapper received a different platform.");
    }
    const source = sourceForRecord(input.record, input.recordIndex);
    return input.record.stream === "catalog"
      ? mapCatalog(input.record, source)
      : input.record.stream === "pulls"
        ? mapPull(input.record, source)
        : mapTrade(input.record, source);
  }
}
