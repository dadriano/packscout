import type {
  CatalogEnvelopeV1,
  PullEnvelopeV1,
  SaleEnvelopeV1,
} from "@packscout/contracts";
import type {
  CatalogAssetCandidate,
  CanonicalPackCandidate,
  EvInputCandidate,
  ProbabilityBucketInput,
  ProviderMappingAdapter,
  ProviderMappingPageInput,
  ProviderRecordMappingOutcome,
  PullCandidate,
  SaleCandidate,
} from "../../provider-adapter.ts";
import { PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO } from "../../estimated-ev-calculator.ts";
import {
  actorInput,
  asArray,
  asObject,
  compact,
  invalidOutcome,
  optionalObject,
  optionalString,
  parseDecimal,
  relationship,
  requiredString,
  sourceFor,
  stringId,
  warning,
  type JsonObject,
  ProviderMappingFieldError,
} from "../provider-mapping-utils.ts";

export const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks";
export const CLUTCHPACKS_MAPPING_KEY = "clutchpacks-canonical-v1";
export const CLUTCHPACKS_SOURCE_SHA256 =
  "6f7f76a26e21233e62f07e56b58b45ab9b17ce083e1db915704c5237d1b76fba";

export const CLUTCHPACKS_USD_UNIT_CONTRACT = Object.freeze({
  currency: "USD",
  fields: Object.freeze([
    "catalog.data.price.price_amount",
    "catalog.data.average_value",
    "catalog.data.price_bucket_odds.*.min_price",
    "catalog.data.price_bucket_odds.*.max_price",
    "pulls.data.formatted_collectible_price",
  ]),
  format: "major-unit decimal strings, optional $ prefix and comma separators",
  sourceSha256: CLUTCHPACKS_SOURCE_SHA256,
});

function canonicalDescription(value: unknown): string | null {
  const description = optionalString(value);
  if (description === null) return null;
  const sanitized = [...description]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return sanitized.length > 0 && sanitized.length <= 10_000
    ? sanitized
    : null;
}

function cardExternalId(card: JsonObject | null): string | null {
  const sourceId = card ? stringId(card.id) ?? stringId(card.card_id) : null;
  return sourceId === null ? null : `card:${sourceId}`;
}

function cardImages(card: JsonObject): readonly string[] {
  return [
    optionalString(card.front_image_url),
    optionalString(card.front_image_medium_url),
    optionalString(card.front_image_thumbnail_url),
  ].filter((value): value is string => value !== null);
}

function supportingAsset(
  envelope: CatalogEnvelopeV1,
  source: ReturnType<typeof sourceFor>,
  value: unknown,
): CatalogAssetCandidate | null {
  const card = optionalObject(value);
  if (card === null) return null;
  const externalId = cardExternalId(card);
  if (externalId === null) return null;
  const estimatedValue = parseDecimal(card.current_price);
  return {
    candidateKind: "catalog_asset",
    source,
    externalId,
    assetType: optionalString(card.type) ?? "card",
    relatedPackExternalId: envelope.external_id,
    parentExternalId: null,
    name: optionalString(card.title) ?? optionalString(card.name),
    category: optionalString(card.subtype) ?? optionalString(card.type),
    availability: "active",
    sourceStatus: null,
    estimatedValue:
      estimatedValue === null
        ? null
        : { amount: estimatedValue, currency: "USD" },
    valueSource: estimatedValue === null ? null : "clutchpacks_current_price",
    imageUrls: cardImages(card),
    relationships: relationship(
      envelope.platform,
      "pack",
      envelope.external_id,
      "parent",
    ),
    dataQualityEvidence: [],
  };
}

function catalogEvidence(
  envelope: CatalogEnvelopeV1,
  source: ReturnType<typeof sourceFor>,
  data: JsonObject,
): {
  assets: readonly CatalogAssetCandidate[];
  buckets: readonly ProbabilityBucketInput[];
  completeness: EvInputCandidate["evidenceCompleteness"];
  coverage: number | null;
  quality: EvInputCandidate["dataQualityEvidence"];
} {
  const rawBuckets = asArray(data.price_bucket_odds);
  const probabilityBuckets: ProbabilityBucketInput[] = [];
  const topChases: ProbabilityBucketInput[] = [];
  const quality = [];
  const assets = new Map<string, CatalogAssetCandidate>();
  let coverage = 0;

  rawBuckets.forEach((raw, index) => {
    const bucket = optionalObject(raw);
    const path = `data.price_bucket_odds[${index}]`;
    if (bucket === null) {
      quality.push(warning("CLUTCHPACKS_EV_BUCKET_INVALID", path));
      return;
    }
    const bucketId = stringId(bucket.bucket_id);
    const percentage = parseDecimal(bucket.live_pool_percentage);
    const lowerValue = parseDecimal(bucket.min_price);
    const upperValue = parseDecimal(bucket.max_price);
    if (
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
        warning("CLUTCHPACKS_POOL_PREVIEW_PARTIAL", `${path}.preview_cards`),
      );
    }
    for (const card of [
      ...asArray(bucket.preview_cards),
      ...asArray(bucket.pool_cards),
    ]) {
      const candidate = supportingAsset(envelope, source, card);
      if (candidate !== null && !assets.has(candidate.externalId)) {
        assets.set(candidate.externalId, candidate);
      }
    }
  });

  asArray(data.series_hits).forEach((raw, index) => {
    const candidate = supportingAsset(envelope, source, raw);
    if (candidate !== null && !assets.has(candidate.externalId)) {
      assets.set(candidate.externalId, candidate);
    }
    const hit = optionalObject(raw);
    const externalId = cardExternalId(hit);
    const value = hit ? parseDecimal(hit.current_price) : null;
    if (externalId === null || value === null) {
      quality.push(
        warning(
          "CLUTCHPACKS_TOP_CHASE_VALUE_UNAVAILABLE",
          `data.series_hits[${index}].current_price`,
        ),
      );
      return;
    }
    topChases.push({
      bucketId: `top-chase:${externalId}`,
      evidenceKind: "top_chase",
      label: hit ? optionalString(hit.title) : null,
      probability: null,
      lowerValue: value,
      upperValue: value,
    });
  });

  const declaredFloor = parseDecimal(data.floor);
  const declaredChaserCeiling = parseDecimal(data.chaser_ceiling);
  if (declaredFloor === null) {
    quality.push(
      warning("CLUTCHPACKS_FLOOR_UNAVAILABLE", "data.floor"),
    );
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
  if (declaredChaserCeiling === null) {
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
      lowerValue: declaredChaserCeiling,
      upperValue: declaredChaserCeiling,
    });
  }

  const coverageComplete =
    Math.abs(coverage - 1) <=
    PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO;
  const allBucketsUsable =
    rawBuckets.length > 0 && probabilityBuckets.length === rawBuckets.length;
  if (allBucketsUsable && !coverageComplete) {
    quality.push(
      warning("CLUTCHPACKS_EV_COVERAGE_INCOMPLETE", "data.price_bucket_odds"),
    );
  }
  return {
    assets: [...assets.values()].sort((left, right) =>
      left.externalId.localeCompare(right.externalId),
    ),
    buckets: [...probabilityBuckets, ...topChases],
    completeness:
      allBucketsUsable && coverageComplete
        ? "complete"
        : probabilityBuckets.length > 0
          ? "partial"
          : "unknown",
    coverage: probabilityBuckets.length === 0 ? null : coverage,
    quality,
  };
}

function mapCatalog(
  envelope: CatalogEnvelopeV1,
  recordIndex: number,
): ProviderRecordMappingOutcome {
  const source = sourceFor("catalog", recordIndex, envelope);
  try {
    const data = asObject(envelope.data, "data");
    const name = requiredString(data.name, "data.name");
    const priceRecord = asObject(data.price, "data.price");
    const price = parseDecimal(priceRecord.price_amount);
    if (price === null) {
      throw new ProviderMappingFieldError(
        "INVALID_MONEY_FORMAT",
        "data.price.price_amount",
      );
    }
    const currencyRecord = asObject(priceRecord.currency, "data.price.currency");
    const currency = requiredString(
      currencyRecord.code,
      "data.price.currency.code",
    ).toUpperCase();
    const averageValue = parseDecimal(data.average_value);
    const category = optionalObject(data.category);
    const evidence = catalogEvidence(envelope, source, data);
    const sourceDescription = optionalString(data.description);
    const description = canonicalDescription(data.description);
    const imageUrls = [
      optionalString(data.image_url),
      optionalString(data.image_medium_url),
      optionalString(data.image_thumbnail_url),
    ].filter((value): value is string => value !== null);
    const pack: CanonicalPackCandidate = {
      candidateKind: "pack",
      source,
      externalId: envelope.external_id,
      parentExternalId: null,
      name,
      description,
      category: category
        ? optionalString(category.slug) ?? optionalString(category.name)
        : null,
      availability: data.sold_out === true ? "sold_out" : "active",
      sourceStatus: data.sold_out === true ? "sold_out" : "available",
      price: { amount: price, currency },
      imageUrls,
      providerReportedEv:
        averageValue === null ? null : { amount: averageValue, currency },
      buybackPercent: null,
      drawCount: 1,
      relationships: [],
      dataQualityEvidence: [
        ...(averageValue === null
          ? [
              warning(
                "CLUTCHPACKS_REPORTED_EV_UNAVAILABLE",
                "data.average_value",
              ),
            ]
          : []),
        ...(sourceDescription !== null && description === null
          ? [
              warning(
                "CLUTCHPACKS_DESCRIPTION_OMITTED_TOO_LONG",
                "data.description",
              ),
            ]
          : []),
      ],
    };
    const evInput: EvInputCandidate = {
      candidateKind: "ev_input",
      source,
      externalId: `ev:${envelope.external_id}`,
      packExternalId: envelope.external_id,
      currency,
      unitBasis: "per_pack",
      drawCount: 1,
      declaredCoverage: evidence.coverage,
      evidenceCompleteness: evidence.completeness,
      buckets: evidence.buckets,
      relationships: relationship(
        envelope.platform,
        "pack",
        envelope.external_id,
        "source",
      ),
      dataQualityEvidence: evidence.quality,
    };
    return {
      status: "mapped",
      source,
      candidates: [pack, ...evidence.assets, evInput],
    };
  } catch (error) {
    return invalidOutcome(source, error);
  }
}

function pullActor(data: JsonObject) {
  const user = optionalObject(data.user);
  if (user === null) return null;
  const id = optionalString(user.id);
  if (id !== null) return actorInput("owner", "clutchpacks:user-id", id);
  return actorInput("owner", "clutchpacks:anonymous-user", user.username);
}

function mapPull(
  envelope: PullEnvelopeV1,
  recordIndex: number,
): ProviderRecordMappingOutcome {
  const source = sourceFor("pull", recordIndex, envelope);
  try {
    const data = asObject(envelope.data, "data");
    const card = asObject(data.card, "data.card");
    const assetExternalId = cardExternalId(card);
    if (assetExternalId === null) {
      requiredString(card.id ?? card.card_id, "data.card.id");
    }
    const value = parseDecimal(data.formatted_collectible_price);
    const candidate: PullCandidate = {
      candidateKind: "pull",
      source,
      packExternalId: envelope.pack_external_id,
      assetExternalId,
      occurredAt: envelope.occurred_at,
      value: value === null ? null : { amount: value, currency: "USD" },
      valueSource:
        value === null ? null : "clutchpacks_formatted_collectible_price",
      pseudonymizationInputs: compact([pullActor(data)]),
      relationships: [
        ...relationship(
          envelope.platform,
          "pack",
          envelope.pack_external_id,
          "subject",
        ),
        ...relationship(
          envelope.platform,
          "catalog_asset",
          assetExternalId,
          "asset",
        ),
      ],
      dataQualityEvidence: [
        ...(envelope.pack_external_id === null
          ? [warning("CLUTCHPACKS_PULL_PACK_UNAVAILABLE", "pack_external_id")]
          : []),
        ...(value === null
          ? [
              warning(
                "CLUTCHPACKS_PULL_VALUE_UNAVAILABLE",
                "data.formatted_collectible_price",
              ),
            ]
          : []),
      ],
    };
    return { status: "mapped", source, candidates: [candidate] };
  } catch (error) {
    return invalidOutcome(source, error);
  }
}

function mapSale(
  envelope: SaleEnvelopeV1,
  recordIndex: number,
): ProviderRecordMappingOutcome {
  const source = sourceFor("sale", recordIndex, envelope);
  try {
    const data = asObject(envelope.data, "data");
    const card = optionalObject(data.card);
    const booster = optionalObject(data.booster);
    const assetExternalId = cardExternalId(card);
    const packExternalId = booster
      ? stringId(booster.collection_id) ?? stringId(booster.id)
      : null;
    const amount =
      envelope.amount === null || envelope.currency === null
        ? null
        : { amount: envelope.amount, currency: envelope.currency };
    const candidate: SaleCandidate = {
      candidateKind: "sale",
      source,
      eventType: envelope.event_type,
      transactionKey: envelope.tx_hash,
      assetExternalId,
      packExternalId,
      occurredAt: envelope.occurred_at,
      amount,
      pseudonymizationInputs: compact([
        actorInput("from", "clutchpacks:account", data.from),
        actorInput("to", "clutchpacks:account", data.to),
      ]),
      relationships: [
        ...relationship(
          envelope.platform,
          "catalog_asset",
          assetExternalId,
          "asset",
        ),
        ...relationship(
          envelope.platform,
          "pack",
          packExternalId,
          "subject",
        ),
      ],
      dataQualityEvidence: [
        ...(amount === null
          ? [warning("CLUTCHPACKS_SALE_AMOUNT_UNAVAILABLE", "amount")]
          : []),
      ],
    };
    return { status: "mapped", source, candidates: [candidate] };
  } catch (error) {
    return invalidOutcome(source, error);
  }
}

function assertedIndexes(
  kind: "catalog" | "pull" | "sale",
  expectedLength: number,
  values: readonly number[],
): readonly number[] {
  if (
    values.length !== expectedLength ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error(`Invalid ${kind} record index mapping.`);
  }
  return values;
}

export class ClutchpacksProviderMappingAdapter
  implements ProviderMappingAdapter
{
  readonly key = CLUTCHPACKS_MAPPING_KEY;
  readonly platformKey = CLUTCHPACKS_PLATFORM_KEY;

  mapPage(input: ProviderMappingPageInput) {
    if (
      input.configuration.adapterKey !== this.key ||
      input.configuration.platform !== this.platformKey
    ) {
      throw new Error(
        "Clutchpacks mapper configuration does not match its manifest.",
      );
    }
    const catalogIndexes = assertedIndexes(
      "catalog",
      input.page.catalog.length,
      input.recordIndexes.catalog,
    );
    const pullIndexes = assertedIndexes(
      "pull",
      input.page.pulls.length,
      input.recordIndexes.pulls,
    );
    const saleIndexes = assertedIndexes(
      "sale",
      input.page.sales.length,
      input.recordIndexes.sales,
    );
    return {
      outcomes: [
        ...input.page.catalog.map((record, index) =>
          mapCatalog(record, catalogIndexes[index]!),
        ),
        ...input.page.pulls.map((record, index) =>
          mapPull(record, pullIndexes[index]!),
        ),
        ...input.page.sales.map((record, index) =>
          mapSale(record, saleIndexes[index]!),
        ),
      ],
    };
  }
}

export const clutchpacksProviderMappingAdapter =
  new ClutchpacksProviderMappingAdapter();
