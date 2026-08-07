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

export const COURTYARD_PLATFORM_KEY = "courtyard" as const;
export const COURTYARD_MAPPER_VERSION = "courtyard-v1" as const;

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

function boundedText(value: unknown, maximumLength: number): string | null {
  const normalized = text(value);
  return normalized
    ? [...normalized]
        .map((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code <= 31 || code === 127 ? " " : character;
        })
        .join("")
        .replace(/\s{2,}/g, " ")
        .slice(0, maximumLength)
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

function images(values: unknown[]) {
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

function actor(
  role: PseudonymousActorInput["role"],
  sourceIdentifier: unknown,
): PseudonymousActorInput | null {
  const value = text(sourceIdentifier);
  return value
    ? { role, namespace: "courtyard_account", sourceIdentifier: value }
    : null;
}

function actorList(...values: (PseudonymousActorInput | null)[]) {
  return Object.freeze(values.filter((value): value is PseudonymousActorInput => value !== null));
}

function latestPriceEvidence(data: Record<string, unknown>) {
  const histories = Array.isArray(data.priceHistory) ? data.priceHistory : [];
  const candidates = histories.flatMap((history) => {
    const row = object(history);
    const sales = Array.isArray(row?.sales) ? row.sales : [];
    return sales.flatMap((sale) => {
      const value = object(sale);
      const amount = finite(value?.price);
      const date = text(value?.date);
      return amount !== null && amount >= 0 && date
        ? [{ amount, date, name: text(row?.title), grade: text(row?.grade), grader: text(row?.grader) }]
        : [];
    });
  });
  return candidates.sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
}

function priceCatalog(
  envelope: CatalogEnvelopeV1,
  source: ProviderSourceIdentity,
  data: Record<string, unknown>,
) {
  const assetId = text(data.assetId);
  if (!assetId) return invalid(source, "COURTYARD_PRICE_ASSET_ID_MISSING", "data.assetId");
  const evidence = latestPriceEvidence(data);
  const candidate: CatalogAssetCandidate = {
    candidateKind: "catalog_asset",
    source,
    externalId: envelope.external_id,
    assetType: "price_record",
    relatedPackExternalId: null,
    parentExternalId: null,
    name: evidence?.name ?? assetId,
    category:
      evidence?.grader && evidence.grade
        ? `${evidence.grader} ${evidence.grade}`
        : evidence?.grader ?? null,
    availability: "unknown",
    sourceStatus: "price_history",
    estimatedValue: evidence ? { amount: evidence.amount, currency: "USD" } : null,
    valueSource: evidence ? "latest_provider_sale" : null,
    imageUrls: [],
    relationships: [],
    dataQualityEvidence: evidence
      ? []
      : [{ code: "COURTYARD_PRICE_HISTORY_EMPTY", severity: "warning", fieldPath: "data.priceHistory" }],
  };
  return mapped(source, [candidate]);
}

function odds(data: Record<string, unknown>) {
  const oddsRecord = object(data.odds);
  const values = Array.isArray(oddsRecord?.buckets) ? oddsRecord.buckets : [];
  const buckets = values.flatMap((value, index): ProbabilityBucketInput[] => {
    const bucket = object(value);
    if (!bucket) return [];
    return [{
      bucketId: text(bucket.tier) ?? `bucket-${index + 1}`,
      evidenceKind: "probability_bucket",
      label: text(bucket.tier),
      probability:
        finite(bucket.oddsPercent) === null ? null : finite(bucket.oddsPercent)! / 100,
      lowerValue: finite(bucket.minValueUsd),
      upperValue: finite(bucket.maxValueUsd),
    }];
  });
  const coverage = buckets.reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0);
  const complete =
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
    );
  return { buckets: Object.freeze(buckets), coverage, complete };
}

function inventoryAssets(
  envelope: CatalogEnvelopeV1,
  source: ProviderSourceIdentity,
  data: Record<string, unknown>,
): readonly CatalogAssetCandidate[] {
  const inventory = Array.isArray(data.inventory) ? data.inventory : [];
  const seen = new Set<string>();
  return Object.freeze(inventory.flatMap((value, index): CatalogAssetCandidate[] => {
    const item = object(value);
    const id = text(item?.collectibleId);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const valueUsd = finite(item?.fmvEstimateUsd);
    return [{
      candidateKind: "catalog_asset",
      source,
      externalId: `inventory:${id}`,
      assetType: "inventory_item",
      relatedPackExternalId: envelope.external_id,
      parentExternalId: null,
      name: text(item?.title) ?? `Inventory item ${index + 1}`,
      category: text(item?.tier),
      availability: "active",
      sourceStatus: "inventory_evidence",
      estimatedValue:
        valueUsd !== null && valueUsd >= 0 ? { amount: valueUsd, currency: "USD" } : null,
      valueSource: valueUsd === null ? null : "provider_fmv_estimate",
      imageUrls: images([item?.imageUrl, item?.slabFront, item?.croppedImage]),
      relationships: [{
        entityKind: "pack",
        platform: COURTYARD_PLATFORM_KEY,
        externalId: envelope.external_id,
        relationship: "subject",
      }],
      dataQualityEvidence: [{ code: "INVENTORY_SAMPLE_NOT_PROVEN_COMPLETE", severity: "info" }],
    }];
  }));
}

function packCatalog(
  envelope: CatalogEnvelopeV1,
  source: ProviderSourceIdentity,
  data: Record<string, unknown>,
) {
  const title = text(data.title);
  const sale = object(data.saleDetails);
  const price = finite(sale?.salePriceUsd);
  if (!title) return invalid(source, "COURTYARD_PACK_TITLE_MISSING", "data.title");
  if (price === null || price <= 0) {
    return invalid(source, "COURTYARD_PACK_PRICE_INVALID", "data.saleDetails.salePriceUsd");
  }
  const status = text(data.status);
  const outOfStock = data.outOfStock === true;
  const closed = sale?.closed === true;
  const providerEv = finite(sale?.expectedValueUsd);
  const buybackRatio = finite(data.buybackRatio);
  const category = object(data.category);
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    externalId: envelope.external_id,
    parentExternalId: null,
    name: title,
    description: boundedText(data.description, 4_000),
    category: text(category?.title) ?? text(category?.id),
    availability:
      outOfStock || closed
        ? "sold_out"
        : status?.toUpperCase() === "ACTIVE"
          ? "active"
          : "disabled",
    sourceStatus: status,
    price: { amount: price, currency: "USD" },
    imageUrls: images([
      data.sealedPackImage,
      data.sealedPackThumbnail,
      data.vendingMachineImage,
      data.vendingMachineThumbnail,
      data.socialSharingImage,
    ]),
    providerReportedEv:
      providerEv !== null && providerEv >= 0
        ? { amount: providerEv, currency: "USD" }
        : null,
    buybackPercent:
      buybackRatio !== null && buybackRatio >= 0 && buybackRatio <= 1
        ? buybackRatio * 100
        : null,
    drawCount: 1,
    relationships: [],
    dataQualityEvidence: [],
  };
  const distribution = odds(data);
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${envelope.external_id}:odds`,
    packExternalId: envelope.external_id,
    currency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: distribution.coverage,
    evidenceCompleteness: distribution.complete ? "complete" : "partial",
    buckets: distribution.buckets,
    relationships: [{
      entityKind: "pack",
      platform: COURTYARD_PLATFORM_KEY,
      externalId: envelope.external_id,
      relationship: "subject",
    }],
    dataQualityEvidence: distribution.complete
      ? []
      : [{ code: "COURTYARD_ODDS_INCOMPLETE", severity: "warning", fieldPath: "data.odds.buckets" }],
  };
  return mapped(source, [pack, evInput, ...inventoryAssets(envelope, source, data)]);
}

function mapCatalog(envelope: CatalogEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "catalog", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "COURTYARD_CATALOG_DATA_INVALID", "data");
  return envelope.external_id.startsWith("price:")
    ? priceCatalog(envelope, source, data)
    : packCatalog(envelope, source, data);
}

function mapPull(envelope: PullEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "pull", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "COURTYARD_PULL_DATA_INVALID", "data");
  const pulledBy = object(data.pulled_by);
  const value = finite(data.fmv_estimate_usd);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: envelope.pack_external_id,
    assetExternalId: text(data.proof_of_integrity) ?? envelope.external_id,
    occurredAt: envelope.occurred_at,
    value: value !== null && value >= 0 ? { amount: value, currency: "USD" } : null,
    valueSource: value === null ? null : "provider_fmv_estimate",
    pseudonymizationInputs: actorList(actor("actor", pulledBy?.user_id)),
    relationships: [
      ...(envelope.pack_external_id ? [{
        entityKind: "pack" as const,
        platform: COURTYARD_PLATFORM_KEY,
        externalId: envelope.pack_external_id,
        relationship: "subject" as const,
      }] : []),
    ],
    dataQualityEvidence: [],
  };
  return mapped(source, [candidate]);
}

function mapSale(envelope: SaleEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "sale", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "COURTYARD_SALE_DATA_INVALID", "data");
  const currency = text(envelope.currency);
  const safeCurrency = currency && /^[A-Za-z0-9]{2,12}$/.test(currency) ? currency : null;
  const candidate: SaleCandidate = {
    candidateKind: "sale",
    source,
    eventType: envelope.event_type,
    transactionKey: envelope.tx_hash ?? envelope.external_id,
    assetExternalId: text(data.assetID),
    packExternalId: null,
    occurredAt: envelope.occurred_at,
    amount:
      envelope.amount !== null && safeCurrency
        ? { amount: envelope.amount, currency: safeCurrency }
        : null,
    pseudonymizationInputs: actorList(
      actor("from", data.from),
      actor("to", data.to),
    ),
    relationships: [],
    dataQualityEvidence:
      currency && !safeCurrency
        ? [{ code: "COURTYARD_SALE_CURRENCY_UNVERIFIED", severity: "warning", fieldPath: "currency" }]
        : [],
  };
  return mapped(source, [candidate]);
}

export class CourtyardMappingAdapter implements ProviderMappingAdapter {
  readonly key = COURTYARD_MAPPER_VERSION;
  readonly platformKey = COURTYARD_PLATFORM_KEY;

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
      throw new Error("Courtyard mapper received a different platform.");
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
