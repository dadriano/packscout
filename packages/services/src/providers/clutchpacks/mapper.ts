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
  actorInput,
  information,
  invalidOutcome,
  mappedOutcome,
  nonNegativeNumber,
  optionalObject,
  optionalSingleLineString,
  optionalString,
  sourceForRecord,
  uniqueActors,
  uniqueStrings,
  warning,
  type JsonObject,
} from "../provider-mapping-utils.ts";

export const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks" as const;
export const CLUTCHPACKS_MAPPER_VERSION = "clutchpacks-v2" as const;

function relationship(
  entityKind: ProviderRelationshipKey["entityKind"],
  externalId: string | null,
  kind: ProviderRelationshipKey["relationship"],
): ProviderRelationshipKey[] {
  return externalId === null
    ? []
    : [{
        entityKind,
        platform: CLUTCHPACKS_PLATFORM_KEY,
        externalId,
        relationship: kind,
      }];
}

/**
 * ClutchPacks display-money fields are major-unit USD strings. Accept only
 * unambiguous decimal or US-formatted values; do not truncate malformed text.
 */
function formattedUsdAmount(value: unknown): number | null {
  if (typeof value === "number") return nonNegativeNumber(value);
  const input = optionalString(value);
  if (
    input === null ||
    !/^\$?(?:(?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))(?:\.\d+)?$/.test(
      input,
    )
  ) {
    return null;
  }
  const amount = Number(input.replace("$", "").replaceAll(",", ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function catalogAvailability(
  record: CatalogRecordV2,
  soldOut = false,
): CanonicalPackCandidate["availability"] {
  if (record.available === true) return "active";
  if (record.available === false) return soldOut ? "sold_out" : "disabled";
  return soldOut ? "sold_out" : record.entity === "card" ? "unknown" : "active";
}

function catalogSourceStatus(record: CatalogRecordV2): string | null {
  return record.available === true
    ? "available"
    : record.available === false
      ? "unavailable"
      : null;
}

function mapCard(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const asset = optionalObject(record.data.asset);
  if (asset === null) {
    return invalidOutcome(
      source,
      "CLUTCHPACKS_CARD_ASSET_MISSING",
      "data.asset",
    );
  }
  const name = optionalString(asset.title) ?? optionalString(asset.name);
  const value = formattedUsdAmount(asset.formatted_current_price);
  const quality: ProviderDataQualityEvidence[] = [
    ...(name === null
      ? [warning("CLUTCHPACKS_CARD_NAME_UNAVAILABLE", "data.asset.title")]
      : []),
    ...(value === null
      ? [warning(
          "CLUTCHPACKS_CARD_VALUE_UNAVAILABLE",
          "data.asset.formatted_current_price",
        )]
      : []),
  ];
  const candidate: CatalogAssetCandidate = {
    candidateKind: "catalog_asset",
    source,
    // The normalized envelope identity is authoritative. Nested card, pool,
    // reveal, hall-of-fame, and owner identifiers are context only.
    externalId: record.record_id,
    assetType: optionalString(asset.type) ?? "collectible",
    relatedPackExternalId: null,
    parentExternalId: null,
    name,
    category: optionalString(asset.subtype) ?? optionalString(asset.type),
    availability: catalogAvailability(record),
    sourceStatus: catalogSourceStatus(record),
    estimatedValue:
      value === null ? null : { amount: value, currency: "USD" },
    valueSource:
      value === null ? null : "clutchpacks_formatted_current_price",
    imageUrls: uniqueStrings([
      asset.front_image_url,
      asset.front_image_medium_url,
      asset.front_image_thumbnail_url,
      asset.back_image_url,
      asset.back_image_medium_url,
      asset.back_image_thumbnail_url,
    ]),
    relationships: [],
    dataQualityEvidence: quality,
  };
  return mappedOutcome(source, [candidate]);
}

interface CatalogEvidence {
  readonly buckets: readonly ProbabilityBucketInput[];
  readonly coverage: number | null;
  readonly completeness: EvInputCandidate["evidenceCompleteness"];
  readonly quality: readonly ProviderDataQualityEvidence[];
}

function catalogEvidence(data: JsonObject): CatalogEvidence {
  const rawBuckets = Array.isArray(data.price_bucket_odds)
    ? data.price_bucket_odds
    : [];
  const probabilityBuckets: ProbabilityBucketInput[] = [];
  const topChases: ProbabilityBucketInput[] = [];
  const quality: ProviderDataQualityEvidence[] = [];
  let coverage = 0;

  rawBuckets.forEach((value, index) => {
    const bucket = optionalObject(value);
    const path = `data.price_bucket_odds[${index}]`;
    const bucketId = optionalString(bucket?.bucket_id);
    const percentage = nonNegativeNumber(bucket?.live_pool_percentage);
    const lowerValue = formattedUsdAmount(bucket?.min_price);
    const upperValue = formattedUsdAmount(bucket?.max_price);
    if (
      bucket === null ||
      bucketId === null ||
      percentage === null ||
      percentage > 100 ||
      lowerValue === null ||
      upperValue === null ||
      upperValue < lowerValue
    ) {
      quality.push(warning("CLUTCHPACKS_EV_BUCKET_INCOMPLETE", path));
      return;
    }
    const probability = percentage / 100;
    coverage += probability;
    probabilityBuckets.push({
      bucketId: `price-bucket:${bucketId}`,
      evidenceKind: "probability_bucket",
      label: optionalString(bucket.name),
      probability,
      lowerValue,
      upperValue,
    });
    if (bucket.has_more === true) {
      quality.push(
        information(
          "CLUTCHPACKS_POOL_PREVIEW_PARTIAL",
          `${path}.preview_cards`,
        ),
      );
    }
  });

  const seenChases = new Set<string>();
  const rawHits = Array.isArray(data.series_hits) ? data.series_hits : [];
  rawHits.forEach((value, index) => {
    const hit = optionalObject(value);
    const id = optionalString(hit?.id);
    const currentPrice = formattedUsdAmount(hit?.current_price);
    if (id === null || currentPrice === null || seenChases.has(id)) {
      quality.push(
        warning(
          "CLUTCHPACKS_TOP_CHASE_VALUE_UNAVAILABLE",
          `data.series_hits[${index}].current_price`,
        ),
      );
      return;
    }
    seenChases.add(id);
    topChases.push({
      bucketId: `top-chase:${id}`,
      evidenceKind: "top_chase",
      label: optionalString(hit?.title),
      probability: null,
      lowerValue: currentPrice,
      upperValue: currentPrice,
    });
  });

  const declaredFloor = formattedUsdAmount(data.floor);
  if (declaredFloor === null) {
    quality.push(warning("CLUTCHPACKS_FLOOR_UNAVAILABLE", "data.floor"));
  } else {
    const observedFloor = probabilityBuckets.reduce<number | null>(
      (minimum, bucket) =>
        bucket.lowerValue === null
          ? minimum
          : minimum === null
            ? bucket.lowerValue
            : Math.min(minimum, bucket.lowerValue),
      null,
    );
    if (observedFloor !== null && observedFloor !== declaredFloor) {
      quality.push(
        warning("CLUTCHPACKS_FLOOR_BUCKET_MISMATCH", "data.floor"),
      );
    }
  }

  const chaserCeiling = formattedUsdAmount(data.chaser_ceiling);
  if (chaserCeiling === null) {
    quality.push(
      warning(
        "CLUTCHPACKS_CHASER_CEILING_UNAVAILABLE",
        "data.chaser_ceiling",
      ),
    );
  } else {
    topChases.push({
      bucketId: "top-chase:provider-chaser-ceiling",
      evidenceKind: "top_chase",
      label: "Provider chaser ceiling",
      probability: null,
      lowerValue: chaserCeiling,
      upperValue: chaserCeiling,
    });
  }

  const normalizedCoverage = Number(coverage.toFixed(12));
  const coverageComplete = Math.abs(normalizedCoverage - 1) <= 0.000001;
  const allBucketsUsable =
    rawBuckets.length > 0 && probabilityBuckets.length === rawBuckets.length;
  if (probabilityBuckets.length > 0 && !coverageComplete) {
    quality.push(
      warning(
        "CLUTCHPACKS_EV_COVERAGE_INCOMPLETE",
        "data.price_bucket_odds",
      ),
    );
  }
  return {
    buckets: Object.freeze([...probabilityBuckets, ...topChases]),
    coverage: probabilityBuckets.length === 0 ? null : normalizedCoverage,
    completeness:
      allBucketsUsable && coverageComplete
        ? "complete"
        : probabilityBuckets.length > 0
          ? "partial"
          : "unknown",
    quality: Object.freeze(quality),
  };
}

function mapPack(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const data = record.data;
  const name = optionalString(data.name);
  if (name === null) {
    return invalidOutcome(
      source,
      "CLUTCHPACKS_PACK_NAME_MISSING",
      "data.name",
    );
  }
  const priceRecord = optionalObject(data.price);
  const rawCurrency = optionalString(optionalObject(priceRecord?.currency)?.code);
  const currency = rawCurrency?.toUpperCase() ?? null;
  const priceAmount = formattedUsdAmount(priceRecord?.price_amount);
  const supportedCurrency = currency === "USD";
  const providerEvAmount = formattedUsdAmount(data.average_value);
  const evidence = catalogEvidence(data);
  const soldOut = data.sold_out === true;
  const packQuality: ProviderDataQualityEvidence[] = [
    ...(priceAmount === null
      ? [warning(
          "CLUTCHPACKS_PACK_PRICE_UNAVAILABLE",
          "data.price.price_amount",
        )]
      : []),
    ...(!supportedCurrency
      ? [warning(
          "CLUTCHPACKS_PACK_CURRENCY_UNSUPPORTED",
          "data.price.currency.code",
        )]
      : []),
    ...(providerEvAmount === null
      ? [warning(
          "CLUTCHPACKS_REPORTED_EV_UNAVAILABLE",
          "data.average_value",
        )]
      : []),
  ];
  const category = optionalObject(data.category);
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    // The V2 envelope identity supersedes data.collection_id.
    externalId: record.record_id,
    parentExternalId: null,
    name,
    description: optionalSingleLineString(data.description),
    category:
      optionalString(category?.slug) ?? optionalString(category?.name),
    availability: catalogAvailability(record, soldOut),
    sourceStatus:
      catalogSourceStatus(record) ?? (soldOut ? "sold_out" : "available"),
    price:
      priceAmount === null || !supportedCurrency
        ? null
        : { amount: priceAmount, currency: "USD" },
    imageUrls: uniqueStrings([
      data.image_url,
      data.image_medium_url,
      data.image_thumbnail_url,
    ]),
    providerReportedEv:
      providerEvAmount === null || !supportedCurrency
        ? null
        : { amount: providerEvAmount, currency: "USD" },
    buybackPercent: null,
    drawCount: 1,
    relationships: [],
    dataQualityEvidence: packQuality,
  };
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${record.record_id}:price-buckets`,
    packExternalId: record.record_id,
    currency: supportedCurrency ? "USD" : null,
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: evidence.coverage,
    evidenceCompleteness: evidence.completeness,
    buckets: evidence.buckets,
    relationships: relationship("pack", record.record_id, "subject"),
    dataQualityEvidence: evidence.quality,
  };
  return mappedOutcome(source, [pack, evInput]);
}

function mapCatalog(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  return record.entity === "card"
    ? mapCard(record, source)
    : mapPack(record, source);
}

function mapPull(
  record: PullRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const activity = optionalObject(record.data.activity);
  const feed = optionalObject(record.data.feed);
  const feedCard = optionalObject(feed?.card);
  const feedUser = optionalObject(feed?.user);
  // Activity formatted_amount is mint transaction money, not collectible FMV.
  const value = formattedUsdAmount(feedCard?.formatted_price);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: record.pack_id,
    assetExternalId: record.card_id,
    occurredAt: source.sourceTimestamp,
    value: value === null ? null : { amount: value, currency: "USD" },
    valueSource:
      value === null ? null : "clutchpacks_formatted_collectible_price",
    buybackStatus: null,
    buybackRefund: null,
    pseudonymizationInputs: uniqueActors([
      actorInput(
        "owner",
        "clutchpacks_user",
        optionalString(feedUser?.id) ?? feedUser?.username,
      ),
      actorInput("from", "clutchpacks_account", activity?.from),
      actorInput("to", "clutchpacks_account", activity?.to),
    ]),
    relationships: [
      ...relationship("pack", record.pack_id, "subject"),
      ...relationship("catalog_asset", record.card_id, "asset"),
    ],
    dataQualityEvidence: [
      ...(record.card_id === null
        ? [warning("CLUTCHPACKS_PULL_CARD_UNAVAILABLE", "card_id")]
        : []),
      ...(value === null
        ? [warning(
            "CLUTCHPACKS_PULL_VALUE_UNAVAILABLE",
            "data.feed.card.formatted_price",
          )]
        : []),
    ],
  };
  return mappedOutcome(source, [candidate]);
}

function tradeMoney(record: TradeRecordV2): TradeCandidate["amount"] {
  const currency = optionalString(record.currency)?.toUpperCase() ?? null;
  if (
    record.amount === null ||
    !Number.isFinite(record.amount) ||
    record.amount < 0 ||
    (currency !== "USD" && currency !== "USDC")
  ) {
    return null;
  }
  return { amount: record.amount, currency };
}

function mapTrade(
  record: TradeRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const amount = tradeMoney(record);
  const candidate: TradeCandidate = {
    candidateKind: "trade",
    source,
    eventType: record.event_type,
    transactionKey: record.tx_hash,
    assetExternalId: record.card_id,
    packExternalId: null,
    occurredAt: source.sourceTimestamp,
    amount,
    paymentMethod:
      optionalString(record.payment_method)?.toLowerCase() ?? null,
    pseudonymizationInputs: uniqueActors([
      actorInput("from", "clutchpacks_account", record.data.from),
      actorInput("to", "clutchpacks_account", record.data.to),
    ]),
    relationships: relationship("catalog_asset", record.card_id, "asset"),
    dataQualityEvidence:
      amount === null
        ? [warning("CLUTCHPACKS_TRADE_MONEY_UNAVAILABLE", "amount")]
        : [],
  };
  return mappedOutcome(source, [candidate]);
}

export class ClutchpacksMappingAdapter implements ProviderMappingAdapter {
  readonly key = CLUTCHPACKS_MAPPER_VERSION;
  readonly platformKey = CLUTCHPACKS_PLATFORM_KEY;

  mapRecord(
    input: Parameters<ProviderMappingAdapter["mapRecord"]>[0],
  ): ProviderRecordMappingOutcome {
    if (
      input.configuration.platform !== this.platformKey ||
      input.record.platform !== this.platformKey
    ) {
      throw new Error("ClutchPacks mapper received a different platform.");
    }
    const source = sourceForRecord(input.record, input.recordIndex);
    return input.record.stream === "catalog"
      ? mapCatalog(input.record, source)
      : input.record.stream === "pulls"
        ? mapPull(input.record, source)
        : mapTrade(input.record, source);
  }
}
