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
  optionalString,
  sourceForRecord,
  uniqueActors,
  uniqueStrings,
  warning,
  type JsonObject,
} from "../provider-mapping-utils.ts";

export const COLLECTOR_CRYPT_PLATFORM_KEY = "collector_crypt" as const;
export const COLLECTOR_CRYPT_MAPPER_VERSION = "collector-crypt-v2" as const;

function relationship(
  entityKind: ProviderRelationshipKey["entityKind"],
  externalId: string | null,
  kind: ProviderRelationshipKey["relationship"],
): ProviderRelationshipKey[] {
  return externalId === null
    ? []
    : [{
        entityKind,
        platform: COLLECTOR_CRYPT_PLATFORM_KEY,
        externalId,
        relationship: kind,
      }];
}

function cardAvailability(asset: JsonObject) {
  const status = optionalString(asset.nftStatus)?.toLowerCase();
  return status === "valid"
    ? "active" as const
    : status === "burned"
      ? "disabled" as const
      : "unknown" as const;
}

function mapCard(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const asset = optionalObject(record.data.asset);
  if (asset === null) {
    return invalidOutcome(
      source,
      "COLLECTOR_CRYPT_CARD_ASSET_MISSING",
      "data.asset",
    );
  }
  const name = optionalString(asset.itemName);
  if (name === null) {
    return invalidOutcome(
      source,
      "COLLECTOR_CRYPT_CARD_NAME_MISSING",
      "data.asset.itemName",
    );
  }
  const insuredValue = nonNegativeNumber(asset.insuredValue);
  const quality =
    asset.insuredValue !== null &&
    asset.insuredValue !== undefined &&
    insuredValue === null
      ? [warning(
          "COLLECTOR_CRYPT_INSURED_VALUE_INVALID",
          "data.asset.insuredValue",
        )]
      : [];
  const candidate: CatalogAssetCandidate = {
    candidateKind: "catalog_asset",
    source,
    externalId: record.record_id,
    assetType: optionalString(asset.type) ?? "collectible",
    relatedPackExternalId: null,
    parentExternalId: null,
    name,
    category: optionalString(asset.category),
    availability: cardAvailability(asset),
    sourceStatus:
      optionalString(asset.nftStatus) ?? optionalString(asset.status),
    estimatedValue:
      insuredValue === null
        ? null
        : { amount: insuredValue, currency: "USD" },
    valueSource:
      insuredValue === null ? null : "provider_insured_value",
    imageUrls: uniqueStrings([asset.frontImage, asset.backImage]),
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
  const ranges = optionalObject(data.tierRanges);
  const weights = optionalObject(data.weightMultipliers);
  if (ranges === null || weights === null) {
    return { buckets: [], coverage: 0, complete: false };
  }
  const tiers = [...new Set([...Object.keys(ranges), ...Object.keys(weights)])]
    .sort();
  const buckets = tiers.map((tier): ProbabilityBucketInput => {
    const range = optionalObject(ranges[tier]);
    return {
      bucketId: tier,
      evidenceKind: "probability_bucket",
      label: tier,
      probability: nonNegativeNumber(weights[tier]),
      lowerValue: nonNegativeNumber(range?.start),
      upperValue: nonNegativeNumber(range?.end),
    };
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

function topChases(data: JsonObject): readonly ProbabilityBucketInput[] {
  const values = Array.isArray(data.topNfts) ? data.topNfts : [];
  const seen = new Set<string>();
  return Object.freeze(
    values.flatMap((value, index): ProbabilityBucketInput[] => {
      const chase = optionalObject(value);
      const id = optionalString(chase?.id) ?? optionalString(chase?.nft_address);
      if (id === null || seen.has(id)) return [];
      seen.add(id);
      const insuredValue = nonNegativeNumber(chase?.insured_value);
      return [{
        bucketId: `top:${id}`,
        evidenceKind: "top_chase",
        label: optionalString(chase?.name) ?? `Top item ${index + 1}`,
        probability: null,
        lowerValue: insuredValue,
        upperValue: insuredValue,
      }];
    }),
  );
}

function mapPack(
  record: CatalogRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const data = record.data;
  const name = optionalString(data.name) ?? optionalString(data.shortName);
  if (name === null) {
    return invalidOutcome(
      source,
      "COLLECTOR_CRYPT_PACK_NAME_MISSING",
      "data.name",
    );
  }
  const price = nonNegativeNumber(optionalObject(data.price)?.amount);
  if (price === null || price <= 0) {
    return invalidOutcome(
      source,
      "COLLECTOR_CRYPT_PACK_PRICE_INVALID",
      "data.price.amount",
    );
  }
  const providerEv = nonNegativeNumber(data.targetEV);
  const buybackPercent = nonNegativeNumber(
    optionalObject(data.instantBuyback)?.percentageOfValue,
  );
  const drawCountValue = nonNegativeNumber(data.contains);
  const drawCount =
    drawCountValue !== null &&
    Number.isSafeInteger(drawCountValue) &&
    drawCountValue > 0
      ? drawCountValue
      : null;
  const distribution = probabilityBuckets(data);
  const chases = topChases(data);
  const archived = data.archived === true;
  const isPublic = data.public !== false;
  const packQuality = [
    ...(providerEv === null
      ? [warning("COLLECTOR_CRYPT_PROVIDER_EV_INVALID", "data.targetEV")]
      : []),
    ...(buybackPercent !== null && buybackPercent > 100
      ? [warning(
          "COLLECTOR_CRYPT_BUYBACK_PERCENT_INVALID",
          "data.instantBuyback.percentageOfValue",
        )]
      : []),
    ...(drawCount === null
      ? [warning("COLLECTOR_CRYPT_DRAW_COUNT_INVALID", "data.contains")]
      : []),
  ];
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    externalId: record.record_id,
    parentExternalId: null,
    name,
    description: null,
    category: optionalString(data.menuCategory),
    availability: archived || !isPublic ? "disabled" : "active",
    sourceStatus: archived ? "archived" : isPublic ? "public" : "private",
    price: { amount: price, currency: "USD" },
    imageUrls: uniqueStrings([data.image, data.thumbnailUrl]),
    providerReportedEv:
      providerEv === null
        ? null
        : { amount: providerEv, currency: "USD" },
    buybackPercent:
      buybackPercent !== null && buybackPercent <= 100
        ? buybackPercent
        : null,
    drawCount,
    relationships: [],
    dataQualityEvidence: packQuality,
  };
  const evQuality = [
    ...(distribution.complete
      ? []
      : [warning(
          "COLLECTOR_CRYPT_DISTRIBUTION_INCOMPLETE",
          "data.weightMultipliers",
        )]),
    ...(chases.length > 0
      ? [information(
          "COLLECTOR_CRYPT_TOP_CHASES_NOT_COMPLETE_INVENTORY",
          "data.topNfts",
        )]
      : []),
  ];
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${record.record_id}:tiers`,
    packExternalId: record.record_id,
    currency: "USD",
    unitBasis: "per_pack",
    drawCount,
    declaredCoverage: distribution.coverage,
    evidenceCompleteness: distribution.complete ? "complete" : "partial",
    buckets: Object.freeze([...distribution.buckets, ...chases]),
    relationships: relationship("pack", record.record_id, "subject"),
    dataQualityEvidence: evQuality,
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
  const data = record.data;
  const value = nonNegativeNumber(data.send_nft_insured_value);
  const rawRefund = nonNegativeNumber(data.buyback_refund_amount);
  const refundProvided =
    data.buyback_refund_amount !== null &&
    data.buyback_refund_amount !== undefined;
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: record.pack_id,
    assetExternalId: record.card_id,
    occurredAt: source.sourceTimestamp,
    value: value === null ? null : { amount: value, currency: "USD" },
    valueSource: value === null ? null : "provider_insured_value",
    buybackStatus: optionalString(data.buyback_status),
    buybackRefund:
      rawRefund === null
        ? null
        : { amount: rawRefund / 1_000_000, currency: "USDC" },
    pseudonymizationInputs: uniqueActors([
      actorInput("actor", "collector_crypt_wallet", data.spin_wallet),
    ]),
    relationships: [
      ...relationship("pack", record.pack_id, "subject"),
      ...relationship("catalog_asset", record.card_id, "asset"),
    ],
    dataQualityEvidence: [
      ...(record.card_id === null
        ? [warning("COLLECTOR_CRYPT_PULL_CARD_UNAVAILABLE", "card_id")]
        : []),
      ...(value === null
        ? [warning(
            "COLLECTOR_CRYPT_PULL_VALUE_UNAVAILABLE",
            "data.send_nft_insured_value",
          )]
        : []),
      ...(refundProvided && rawRefund === null
        ? [warning(
            "COLLECTOR_CRYPT_BUYBACK_REFUND_INVALID",
            "data.buyback_refund_amount",
          )]
        : []),
    ],
  };
  return mappedOutcome(source, [candidate]);
}

function collectorCryptMoney(record: TradeRecordV2) {
  const currency = optionalString(record.currency)?.toUpperCase() ?? null;
  const amount = record.amount;
  if (
    amount === null ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    (currency !== "USD" && currency !== "USDC")
  ) {
    return null;
  }
  return { amount, currency };
}

function mapTrade(
  record: TradeRecordV2,
  source: ProviderSourceIdentity,
): ProviderRecordMappingOutcome {
  const data = record.data;
  const from = optionalObject(data.from);
  const to = optionalObject(data.to);
  const amount = collectorCryptMoney(record);
  const moneyIncomplete =
    (record.amount === null) !== (record.currency === null) ||
    (record.amount !== null && amount === null);
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
      actorInput("from", "collector_crypt_account", from?.id),
      actorInput("to", "collector_crypt_account", to?.id),
    ]),
    relationships: relationship("catalog_asset", record.card_id, "asset"),
    dataQualityEvidence: moneyIncomplete
      ? [warning("COLLECTOR_CRYPT_TRADE_MONEY_UNAVAILABLE", "currency")]
      : [],
  };
  return mappedOutcome(source, [candidate]);
}

export class CollectorCryptMappingAdapter implements ProviderMappingAdapter {
  readonly key = COLLECTOR_CRYPT_MAPPER_VERSION;
  readonly platformKey = COLLECTOR_CRYPT_PLATFORM_KEY;

  mapRecord(
    input: Parameters<ProviderMappingAdapter["mapRecord"]>[0],
  ): ProviderRecordMappingOutcome {
    if (
      input.configuration.platform !== this.platformKey ||
      input.record.platform !== this.platformKey
    ) {
      throw new Error("Collector Crypt mapper received a different platform.");
    }
    const source = sourceForRecord(input.record, input.recordIndex);
    return input.record.stream === "catalog"
      ? mapCatalog(input.record, source)
      : input.record.stream === "pulls"
        ? mapPull(input.record, source)
        : mapTrade(input.record, source);
  }
}
