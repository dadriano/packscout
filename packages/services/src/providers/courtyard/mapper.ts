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

export const COURTYARD_PLATFORM_KEY = "courtyard" as const;
export const COURTYARD_MAPPER_VERSION = "courtyard-v2" as const;

// Provider-confirmed Polygon USDC reference observed in the V2 feed.
const COURTYARD_USDC_TOKEN_REFERENCE =
  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

function relationship(
  entityKind: ProviderRelationshipKey["entityKind"],
  externalId: string | null,
  kind: ProviderRelationshipKey["relationship"],
): ProviderRelationshipKey[] {
  return externalId === null
    ? []
    : [{
        entityKind,
        platform: COURTYARD_PLATFORM_KEY,
        externalId,
        relationship: kind,
      }];
}

interface LatestPriceEvidence {
  readonly amount: number;
  readonly occurredAt: number;
  readonly title: string | null;
}

/** One-pass selection avoids allocating or sorting large provider price histories. */
function latestPriceEvidence(prices: JsonObject | null): LatestPriceEvidence | null {
  const histories = Array.isArray(prices?.priceHistory)
    ? prices.priceHistory
    : [];
  let latest: LatestPriceEvidence | null = null;
  for (const value of histories) {
    const history = optionalObject(value);
    const sales = Array.isArray(history?.sales) ? history.sales : [];
    for (const saleValue of sales) {
      const sale = optionalObject(saleValue);
      const amount = nonNegativeNumber(sale?.price);
      const date = optionalString(sale?.date);
      const occurredAt = date === null ? Number.NaN : Date.parse(date);
      if (
        amount !== null &&
        Number.isFinite(occurredAt) &&
        (latest === null || occurredAt > latest.occurredAt)
      ) {
        latest = {
          amount,
          occurredAt,
          title: optionalString(history?.title),
        };
      }
    }
  }
  return latest;
}

function cardAvailability(asset: JsonObject | null, reveal: JsonObject | null) {
  if (reveal?.burned === true) return "disabled" as const;
  if (optionalString(asset?.visibility)?.toLowerCase() === "public") {
    return "active" as const;
  }
  if (reveal?.burned === false) return "active" as const;
  return "unknown" as const;
}

function mapCard(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const asset = optionalObject(record.data.asset);
  const prices = optionalObject(record.data.prices);
  const reveal = optionalObject(record.data.reveal);
  const latestPrice = latestPriceEvidence(prices);
  const name =
    optionalString(asset?.title) ??
    optionalString(reveal?.title) ??
    latestPrice?.title ??
    null;
  const assetValue = nonNegativeNumber(asset?.estimatedValueUsd);
  const revealValue = nonNegativeNumber(reveal?.fmv_estimate_usd);
  const estimatedValue = assetValue ?? revealValue ?? latestPrice?.amount ?? null;
  const valueSource = assetValue !== null
    ? optionalString(asset?.estimatedValueSource) ?? "provider_estimated_value"
    : revealValue !== null
      ? "provider_fmv_estimate"
      : latestPrice !== null
        ? "latest_provider_sale"
        : null;
  const quality: ProviderDataQualityEvidence[] = [
    ...(name === null
      ? [warning("COURTYARD_CARD_NAME_UNAVAILABLE", "data")]
      : []),
    ...(estimatedValue === null
      ? [information("COURTYARD_CARD_VALUE_UNAVAILABLE", "data")]
      : []),
  ];
  const sourceStatus = reveal?.burned === true
    ? "burned"
    : optionalString(asset?.visibility);
  const candidate: CatalogAssetCandidate = {
    candidateKind: "catalog_asset",
    source,
    externalId: record.record_id,
    assetType: "collectible",
    relatedPackExternalId: null,
    parentExternalId: null,
    name,
    category:
      optionalString(asset?.collection) ?? optionalString(reveal?.collection),
    availability: cardAvailability(asset, reveal),
    sourceStatus,
    estimatedValue:
      estimatedValue === null
        ? null
        : { amount: estimatedValue, currency: "USD" },
    valueSource,
    imageUrls: uniqueStrings([
      asset?.imageUrl,
      reveal?.cropped_image,
      reveal?.image,
      ...(Array.isArray(reveal?.asset_pictures)
        ? reveal.asset_pictures
        : []),
    ]),
    relationships: [],
    dataQualityEvidence: quality,
  };
  return mappedOutcome(source, [candidate]);
}

function probabilityBuckets(data: JsonObject): {
  readonly buckets: readonly ProbabilityBucketInput[];
  readonly coverage: number;
  readonly complete: boolean;
} {
  const odds = optionalObject(data.odds);
  const values = Array.isArray(odds?.buckets) ? odds.buckets : [];
  const buckets = values.flatMap((value, index): ProbabilityBucketInput[] => {
    const bucket = optionalObject(value);
    if (bucket === null) return [];
    const oddsPercent = nonNegativeNumber(bucket.oddsPercent);
    return [{
      bucketId: optionalString(bucket.tier) ?? `bucket-${index + 1}`,
      evidenceKind: "probability_bucket",
      label: optionalString(bucket.tier),
      probability: oddsPercent === null ? null : oddsPercent / 100,
      lowerValue: nonNegativeNumber(bucket.minValueUsd),
      upperValue: nonNegativeNumber(bucket.maxValueUsd),
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
  const name = optionalString(data.title);
  if (name === null) {
    return invalidOutcome(
      source,
      "COURTYARD_PACK_TITLE_MISSING",
      "data.title",
    );
  }
  const sale = optionalObject(data.saleDetails);
  const price = nonNegativeNumber(sale?.salePriceUsd);
  if (price === null || price <= 0) {
    return invalidOutcome(
      source,
      "COURTYARD_PACK_PRICE_INVALID",
      "data.saleDetails.salePriceUsd",
    );
  }
  const providerEv = nonNegativeNumber(sale?.expectedValueUsd);
  const buybackRatio = nonNegativeNumber(data.buybackRatio);
  const distribution = probabilityBuckets(data);
  const category = optionalObject(data.category);
  const outOfStock = data.outOfStock === true;
  const closed = sale?.closed === true;
  const status = optionalString(data.status);
  const fallbackAvailability =
    outOfStock || closed
      ? "sold_out"
      : status?.toUpperCase() === "ACTIVE"
        ? "active"
        : "disabled";
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    externalId: record.record_id,
    parentExternalId: null,
    name,
    description: optionalSingleLineString(data.description),
    category:
      optionalString(category?.title) ?? optionalString(category?.id),
    availability:
      record.available === true
        ? "active"
        : record.available === false
          ? outOfStock || closed
            ? "sold_out"
            : "disabled"
          : fallbackAvailability,
    sourceStatus: status,
    price: { amount: price, currency: "USD" },
    imageUrls: uniqueStrings([
      data.sealedPackImage,
      data.sealedPackThumbnail,
      data.vendingMachineImage,
      data.vendingMachineThumbnail,
      data.socialSharingImage,
    ]),
    providerReportedEv:
      providerEv === null
        ? null
        : { amount: providerEv, currency: "USD" },
    buybackPercent:
      buybackRatio !== null && buybackRatio <= 1
        ? buybackRatio * 100
        : null,
    drawCount: 1,
    relationships: [],
    dataQualityEvidence: [
      ...(providerEv === null
        ? [warning(
            "COURTYARD_PROVIDER_EV_INVALID",
            "data.saleDetails.expectedValueUsd",
          )]
        : []),
      ...(buybackRatio !== null && buybackRatio > 1
        ? [warning("COURTYARD_BUYBACK_RATIO_INVALID", "data.buybackRatio")]
        : []),
    ],
  };
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${record.record_id}:odds`,
    packExternalId: record.record_id,
    currency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: distribution.coverage,
    evidenceCompleteness: distribution.complete ? "complete" : "partial",
    buckets: distribution.buckets,
    relationships: relationship("pack", record.record_id, "subject"),
    dataQualityEvidence: distribution.complete
      ? []
      : [warning("COURTYARD_ODDS_UNAVAILABLE", "data.odds.buckets")],
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
  const value = nonNegativeNumber(record.data.fmv_estimate_usd);
  const pulledBy = optionalObject(record.data.pulled_by);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: record.pack_id,
    assetExternalId: record.card_id,
    occurredAt: source.sourceTimestamp,
    value: value === null ? null : { amount: value, currency: "USD" },
    valueSource: value === null ? null : "provider_fmv_estimate",
    buybackStatus: null,
    buybackRefund: null,
    pseudonymizationInputs: uniqueActors([
      actorInput("actor", "courtyard_account", pulledBy?.user_id),
    ]),
    relationships: [
      ...relationship("pack", record.pack_id, "subject"),
      ...relationship("catalog_asset", record.card_id, "asset"),
    ],
    dataQualityEvidence: value === null
      ? [warning(
          "COURTYARD_PULL_VALUE_UNAVAILABLE",
          "data.fmv_estimate_usd",
        )]
      : [],
  };
  return mappedOutcome(source, [candidate]);
}

interface CourtyardTradeMoney {
  readonly amount: TradeCandidate["amount"];
  readonly paymentMethod: string | null;
  readonly quality: readonly ProviderDataQualityEvidence[];
}

function courtyardTradeMoney(record: TradeRecordV2): CourtyardTradeMoney {
  const rawCurrency = optionalString(record.currency);
  const explicitMethod =
    optionalString(record.payment_method)?.toLowerCase() ?? null;
  if (record.amount === null && rawCurrency === null) {
    return { amount: null, paymentMethod: explicitMethod, quality: [] };
  }
  if (
    record.amount === null ||
    record.amount < 0 ||
    !Number.isFinite(record.amount) ||
    rawCurrency === null
  ) {
    return {
      amount: null,
      paymentMethod: explicitMethod,
      quality: [warning("COURTYARD_TRADE_MONEY_INCOMPLETE", "currency")],
    };
  }
  const reference = rawCurrency.toLowerCase();
  if (reference === COURTYARD_USDC_TOKEN_REFERENCE || reference === "usdc") {
    return {
      amount: { amount: record.amount, currency: "USDC" },
      paymentMethod: explicitMethod,
      quality: [],
    };
  }
  if (reference === "usd") {
    return {
      amount: { amount: record.amount, currency: "USD" },
      paymentMethod: explicitMethod,
      quality: [],
    };
  }
  if (reference === "stripe" || reference === "partial_payment") {
    return {
      // The provider confirmed Courtyard settles in USDC; these raw values
      // describe collection method, not a different settlement currency.
      amount: { amount: record.amount, currency: "USDC" },
      paymentMethod: explicitMethod ?? reference,
      quality: [],
    };
  }
  return {
    amount: null,
    paymentMethod: explicitMethod,
    quality: [warning("COURTYARD_TRADE_CURRENCY_UNSUPPORTED", "currency")],
  };
}

function mapTrade(
  record: TradeRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const money = courtyardTradeMoney(record);
  const candidate: TradeCandidate = {
    candidateKind: "trade",
    source,
    eventType: record.event_type,
    transactionKey: record.tx_hash,
    assetExternalId: record.card_id,
    packExternalId: null,
    occurredAt: source.sourceTimestamp,
    amount: money.amount,
    paymentMethod: money.paymentMethod,
    pseudonymizationInputs: uniqueActors([
      actorInput("from", "courtyard_account", record.data.from),
      actorInput("to", "courtyard_account", record.data.to),
    ]),
    relationships: relationship("catalog_asset", record.card_id, "asset"),
    dataQualityEvidence: money.quality,
  };
  return mappedOutcome(source, [candidate]);
}

export class CourtyardMappingAdapter implements ProviderMappingAdapter {
  readonly key = COURTYARD_MAPPER_VERSION;
  readonly platformKey = COURTYARD_PLATFORM_KEY;

  mapRecord(
    input: Parameters<ProviderMappingAdapter["mapRecord"]>[0],
  ): ProviderRecordMappingOutcome {
    if (
      input.configuration.platform !== this.platformKey ||
      input.record.platform !== this.platformKey
    ) {
      throw new Error("Courtyard mapper received a different platform.");
    }
    const source = sourceForRecord(input.record, input.recordIndex);
    return input.record.stream === "catalog"
      ? mapCatalog(input.record, source)
      : input.record.stream === "pulls"
        ? mapPull(input.record, source)
        : mapTrade(input.record, source);
  }
}
