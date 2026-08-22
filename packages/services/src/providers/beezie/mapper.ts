import type {
  CatalogEnvelopeV1,
  PullEnvelopeV1,
  TradeEnvelopeV1,
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
  MarketEventCandidate,
} from "../../provider-adapter.ts";
import { PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO } from "../../estimated-ev-calculator.ts";
import {
  actorInput,
  asArray,
  asObject,
  compact,
  invalidOutcome,
  optionalFiniteNumber,
  optionalObject,
  optionalString,
  parseDecimal,
  relationship,
  requiredFiniteNumber,
  requiredString,
  sourceFor,
  stringId,
  warning,
  type JsonObject,
  ProviderMappingFieldError,
} from "../provider-mapping-utils.ts";

export const BEEZIE_PLATFORM_KEY = "beezie";
export const BEEZIE_MAPPING_KEY = "beezie-canonical-v1";
export const BEEZIE_SOURCE_SHA256 =
  "92cfae82960d0b829d5405f2ecb63a34cfb9ca679e412981d50d069a91a7d21e";

/** `priceUsdc`, pull `swapValue`, and grail `swapValue` are micro-USDC. */
export const BEEZIE_USDC_UNIT_CONTRACT = Object.freeze({
  currency: "USDC",
  divisor: 1_000_000,
  fields: Object.freeze([
    "catalog.data.priceUsdc",
    "catalog.data.grails.*.*.swapValue",
    "pulls.data.swapValue",
  ]),
  sourceSha256: BEEZIE_SOURCE_SHA256,
});

const oddsTiers = ["base", "low", "medium", "high", "grails"] as const;
const rangeFields = {
  base: ["fromBase", "toBase"],
  low: ["fromLow", "toLow"],
  medium: ["fromMedium", "toMedium"],
  high: ["fromHigh", "toHigh"],
  grails: ["fromGrails", "toGrails"],
} as const;

function microUsdc(value: unknown, fieldPath: string): number {
  const amount = requiredFiniteNumber(value, fieldPath);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new ProviderMappingFieldError("INVALID_MICRO_USDC", fieldPath);
  }
  return amount / BEEZIE_USDC_UNIT_CONTRACT.divisor;
}

function normalizedAvailability(data: JsonObject) {
  const sourceStatus = optionalString(data.status);
  if (data.isVisible === false) return "unavailable" as const;
  if (sourceStatus?.toLowerCase() === "active") return "available" as const;
  if (sourceStatus?.toLowerCase() === "sold_out") return "sold_out" as const;
  if (sourceStatus?.toLowerCase() === "disabled") return "unavailable" as const;
  return "unknown" as const;
}

function buybackPercent(data: JsonObject): number | null {
  const fees = optionalObject(data.swapFees);
  const percentages = fees ? asArray(fees.percentages) : [];
  if (percentages.length === 0) return null;
  const totalFee = percentages.reduce<number | null>((sum, value) => {
    const percentage = optionalFiniteNumber(value);
    return sum === null ||
      percentage === null ||
      percentage < 0 ||
      percentage > 100
      ? null
      : sum + percentage;
  }, 0);
  return totalFee !== null && totalFee <= 100 ? 100 - totalFee : null;
}

function catalogEvidence(data: JsonObject): {
  buckets: readonly ProbabilityBucketInput[];
  coverage: number | null;
  completeness: EvInputCandidate["evidenceCompleteness"];
  quality: EvInputCandidate["dataQualityEvidence"];
} {
  const odds = optionalObject(data.odds);
  const ranges = optionalObject(data.priceRanges);
  const quality = [];
  const buckets: ProbabilityBucketInput[] = [];
  let coverage = 0;

  for (const tier of oddsTiers) {
    const probabilityPercent = odds ? parseDecimal(odds[tier]) : null;
    const [lowerField, upperField] = rangeFields[tier];
    const lowerValue = ranges ? optionalFiniteNumber(ranges[lowerField]) : null;
    const upperValue = ranges ? optionalFiniteNumber(ranges[upperField]) : null;
    if (
      probabilityPercent === null ||
      probabilityPercent < 0 ||
      probabilityPercent > 100 ||
      lowerValue === null ||
      upperValue === null ||
      lowerValue < 0 ||
      upperValue < lowerValue
    ) {
      quality.push(warning("BEEZIE_EV_BUCKET_INCOMPLETE", `data.odds.${tier}`));
      continue;
    }
    const probability = probabilityPercent / 100;
    coverage += probability;
    buckets.push({
      bucketId: `tier:${tier}`,
      evidenceKind: "probability_bucket",
      label: tier,
      probability,
      lowerValue,
      upperValue,
    });
  }

  const allComplete = buckets.length === oddsTiers.length;
  const coverageComplete =
    Math.abs(coverage - 1) <=
    PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO;
  if (allComplete && !coverageComplete) {
    quality.push(warning("BEEZIE_EV_COVERAGE_INCOMPLETE", "data.odds"));
  }
  return {
    buckets,
    coverage: buckets.length === 0 ? null : coverage,
    completeness:
      allComplete && coverageComplete
        ? "complete"
        : buckets.length > 0
          ? "partial"
          : "unknown",
    quality,
  };
}

function grailCandidates(
  envelope: CatalogEnvelopeV1,
  source: ReturnType<typeof sourceFor>,
  data: JsonObject,
): {
  assets: readonly CatalogAssetCandidate[];
  topChases: readonly ProbabilityBucketInput[];
} {
  const groups = optionalObject(data.grails);
  if (groups === null) return { assets: [], topChases: [] };
  const assets = new Map<string, CatalogAssetCandidate>();
  const topChases = new Map<string, ProbabilityBucketInput>();
  for (const [tier, values] of Object.entries(groups).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const raw of asArray(values)) {
      const entry = optionalObject(raw);
      if (entry === null) continue;
      const tokenId = stringId(entry.tokenId);
      if (tokenId === null) continue;
      const item = optionalObject(entry.item);
      const metadata = item ? optionalObject(item.metadata) : null;
      const category = item ? optionalObject(item.category) : null;
      const name = metadata ? optionalString(metadata.name) : null;
      const image = metadata ? optionalString(metadata.image) : null;
      const valueRaw = optionalFiniteNumber(entry.swapValue);
      const value =
        valueRaw !== null && Number.isSafeInteger(valueRaw) && valueRaw >= 0
          ? valueRaw / BEEZIE_USDC_UNIT_CONTRACT.divisor
          : null;
      const externalId = `token:${tokenId}`;
      if (!assets.has(externalId)) {
        assets.set(externalId, {
          candidateKind: "catalog_asset",
          source,
          externalId,
          assetType: tier,
          relatedPackExternalId: envelope.external_id,
          parentExternalId: null,
          name,
          category: category ? optionalString(category.name) : null,
          availability: "available",
          sourceStatus: null,
          estimatedValue:
            value === null ? null : { amount: value, currency: "USDC" },
          valueSource: value === null ? null : "beezie_swap_value",
          imageUrls: image === null ? [] : [image],
          relationships: relationship(
            envelope.platform,
            "pack",
            envelope.external_id,
            "parent",
          ),
          dataQualityEvidence: [],
        });
      }
      if (value !== null) {
        topChases.set(`${tier}:${tokenId}`, {
          bucketId: `top-chase:${tier}:${tokenId}`,
          evidenceKind: "top_chase",
          label: name ?? `${tier} token ${tokenId}`,
          probability: null,
          lowerValue: value,
          upperValue: value,
        });
      }
    }
  }
  return {
    assets: [...assets.values()].sort((a, b) =>
      a.externalId.localeCompare(b.externalId),
    ),
    topChases: [...topChases.values()].sort((a, b) =>
      a.bucketId.localeCompare(b.bucketId),
    ),
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
    const price = microUsdc(data.priceUsdc, "data.priceUsdc");
    const reportedEv = optionalFiniteNumber(data.averageValue);
    const category = optionalString(data.clawTag);
    const sourceStatus = optionalString(data.status);
    const evidence = catalogEvidence(data);
    const grails = grailCandidates(envelope, source, data);
    const derivedBuybackPercent = buybackPercent(data);
    const pack: CanonicalPackCandidate = {
      candidateKind: "pack",
      source,
      externalId: envelope.external_id,
      parentExternalId: null,
      name,
      description: optionalString(data.description),
      category,
      availability: normalizedAvailability(data),
      sourceStatus,
      price: { amount: price, currency: "USDC" },
      imageUrls: [],
      providerReportedEv:
        reportedEv === null || reportedEv < 0
          ? null
          : { amount: reportedEv, currency: "USDC" },
      buybackPercent: derivedBuybackPercent,
      drawCount: 1,
      relationships: [],
      dataQualityEvidence: [
        ...(data.isVisible === false
          ? [warning("BEEZIE_MACHINE_NOT_VISIBLE", "data.isVisible")]
          : []),
        ...(derivedBuybackPercent === null
          ? []
          : [
              {
                code: "BEEZIE_BUYBACK_DERIVED_FROM_SWAP_FEES",
                severity: "info" as const,
                fieldPath: "data.swapFees.percentages",
              },
            ]),
      ],
    };
    const evInput: EvInputCandidate = {
      candidateKind: "ev_input",
      source,
      externalId: `ev:${envelope.external_id}`,
      packExternalId: envelope.external_id,
      currency: "USDC",
      unitBasis: "per_pack",
      drawCount: 1,
      declaredCoverage: evidence.coverage,
      evidenceCompleteness: evidence.completeness,
      buckets: [...evidence.buckets, ...grails.topChases],
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
      candidates: [pack, ...grails.assets, evInput],
    };
  } catch (error) {
    return invalidOutcome(source, error);
  }
}

function mapPull(
  envelope: PullEnvelopeV1,
  recordIndex: number,
): ProviderRecordMappingOutcome {
  const source = sourceFor("pull", recordIndex, envelope);
  try {
    const data = asObject(envelope.data, "data");
    const tokenId = stringId(data.tokenId);
    if (tokenId === null) requiredString(data.tokenId, "data.tokenId");
    const swapValue = optionalFiniteNumber(data.swapValue);
    const owner = actorInput("owner", "beezie:wallet", data.from);
    const candidate: PullCandidate = {
      candidateKind: "pull",
      source,
      packExternalId: envelope.pack_external_id,
      assetExternalId: tokenId === null ? null : `token:${tokenId}`,
      occurredAt: envelope.occurred_at,
      value:
        swapValue !== null && Number.isSafeInteger(swapValue) && swapValue >= 0
          ? {
              amount: swapValue / BEEZIE_USDC_UNIT_CONTRACT.divisor,
              currency: "USDC",
            }
          : null,
      valueSource: swapValue === null ? null : "beezie_swap_value",
      pseudonymizationInputs: compact([owner]),
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
          tokenId === null ? null : `token:${tokenId}`,
          "asset",
        ),
      ],
      dataQualityEvidence: [
        ...(envelope.pack_external_id === null
          ? [warning("BEEZIE_PULL_PACK_UNAVAILABLE", "pack_external_id")]
          : []),
        ...(swapValue === null
          ? [warning("BEEZIE_PULL_VALUE_UNAVAILABLE", "data.swapValue")]
          : []),
      ],
    };
    return { status: "mapped", source, candidates: [candidate] };
  } catch (error) {
    return invalidOutcome(source, error);
  }
}

function mapTrade(
  envelope: TradeEnvelopeV1,
  recordIndex: number,
): ProviderRecordMappingOutcome {
  const source = sourceFor("trade", recordIndex, envelope);
  try {
    const data = asObject(envelope.data, "data");
    const tokenId = stringId(data.tokenId);
    if (tokenId === null) requiredString(data.tokenId, "data.tokenId");
    const currency = envelope.currency;
    const candidate: MarketEventCandidate = {
      candidateKind: "market_event",
      source,
      eventType: envelope.event_type,
      transactionKey: envelope.tx_hash,
      assetExternalId: tokenId === null ? null : `token:${tokenId}`,
      packExternalId: null,
      occurredAt: envelope.occurred_at,
      amount:
        envelope.amount === null || currency === null
          ? null
          : { amount: envelope.amount, currency },
      pseudonymizationInputs: compact([
        actorInput("from", "beezie:wallet", data.from),
        actorInput("to", "beezie:wallet", data.to),
      ]),
      relationships: relationship(
        envelope.platform,
        "catalog_asset",
        tokenId === null ? null : `token:${tokenId}`,
        "asset",
      ),
      dataQualityEvidence: [
        ...(currency?.startsWith("0x")
          ? [warning("BEEZIE_TOKEN_CURRENCY_UNVERIFIED", "currency")]
          : []),
      ],
    };
    return { status: "mapped", source, candidates: [candidate] };
  } catch (error) {
    return invalidOutcome(source, error);
  }
}

function assertedIndexes(
  kind: "catalog" | "pull" | "trade",
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

export class BeezieProviderMappingAdapter implements ProviderMappingAdapter {
  readonly key = BEEZIE_MAPPING_KEY;
  readonly platformKey = BEEZIE_PLATFORM_KEY;

  mapPage(input: ProviderMappingPageInput) {
    if (
      input.configuration.adapterKey !== this.key ||
      input.configuration.platform !== this.platformKey
    ) {
      throw new Error("Beezie mapper configuration does not match its manifest.");
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
    const tradeIndexes = assertedIndexes(
      "trade",
      input.page.trades.length,
      input.recordIndexes.trades,
    );
    return {
      outcomes: [
        ...input.page.catalog.map((record, index) =>
          mapCatalog(record, catalogIndexes[index]!),
        ),
        ...input.page.pulls.map((record, index) =>
          mapPull(record, pullIndexes[index]!),
        ),
        ...input.page.trades.map((record, index) =>
          mapTrade(record, tradeIndexes[index]!),
        ),
      ],
    };
  }
}

export const beezieProviderMappingAdapter =
  new BeezieProviderMappingAdapter();
