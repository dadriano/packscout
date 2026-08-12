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
  type PseudonymousActorInput,
  type PullCandidate,
  type SaleCandidate,
} from "../../provider-adapter.ts";

export const PHYGITALS_PLATFORM_KEY = "phygitals" as const;
export const PHYGITALS_MAPPER_VERSION = "phygitals-v1" as const;
export const PHYGITALS_USDC_MINT_ADDRESS =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const;

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

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  const normalized = text(value);
  return normalized && normalized.length <= 512 ? normalized : null;
}

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boundedText(value: unknown, maximum = 4_000): string | null {
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

function images(...values: unknown[]): readonly string[] {
  const flattened = values.flatMap((value): unknown[] => {
    if (Array.isArray(value)) return value;
    const record = object(value);
    return record ? Object.values(record) : [value];
  });
  return Object.freeze([
    ...new Set(flattened.map((value) => {
      const record = object(value);
      return text(record?.url) ?? text(record?.uri) ?? text(value);
    }).filter((value): value is string => value !== null)),
  ]);
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
  value: unknown,
): PseudonymousActorInput | null {
  const sourceIdentifier = identifier(value);
  return sourceIdentifier
    ? { role, namespace: "phygitals_account", sourceIdentifier }
    : null;
}

function actors(...values: (PseudonymousActorInput | null)[]) {
  return Object.freeze(values.filter((value): value is PseudonymousActorInput => value !== null));
}

function rarityDistribution(data: Record<string, unknown>, drawCount: number | null) {
  const distribution = Array.isArray(data.rarity_distribution) ? data.rarity_distribution : [];
  const buckets = distribution.flatMap((value, index): ProbabilityBucketInput[] => {
    const rarity = object(value);
    if (!rarity) return [];
    const weight = finite(rarity.weight);
    return [{
      bucketId: identifier(rarity.id) ?? `rarity-${index + 1}`,
      evidenceKind: "probability_bucket",
      label: text(rarity.name),
      probability: weight === null ? null : weight / 100,
      lowerValue: finite(rarity.lower),
      upperValue: finite(rarity.upper),
    }];
  });
  const coverage = buckets.reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0);
  const distributionComplete =
    buckets.length > 0 &&
    Math.abs(coverage - 1) <= 0.000001 &&
    buckets.every((bucket) =>
      bucket.probability !== null && bucket.probability >= 0 &&
      bucket.lowerValue !== null && bucket.lowerValue >= 0 &&
      bucket.upperValue !== null && bucket.upperValue >= bucket.lowerValue,
    );
  return {
    buckets: Object.freeze(buckets),
    coverage,
    complete: distributionComplete && drawCount !== null,
    distributionComplete,
  };
}

function chaseAssets(
  source: ProviderSourceIdentity,
  packExternalId: string,
  data: Record<string, unknown>,
): readonly CatalogAssetCandidate[] {
  const values = Array.isArray(data.chase)
    ? data.chase
    : Array.isArray(data.chase_cards)
      ? data.chase_cards
      : [];
  const seen = new Set<string>();
  return Object.freeze(values.flatMap((value, index): CatalogAssetCandidate[] => {
    const chase = object(value);
    const id = identifier(chase?.id);
    if (!id) return [];
    const externalId = `chase:${packExternalId}:${id}`;
    if (seen.has(externalId)) return [];
    seen.add(externalId);
    const fmv = finite(chase?.fmv);
    return [{
      candidateKind: "catalog_asset",
      source,
      externalId,
      assetType: "chase_collectible",
      relatedPackExternalId: packExternalId,
      parentExternalId: null,
      name: text(chase?.name) ?? `Chase collectible ${index + 1}`,
      category: null,
      availability: "unknown",
      sourceStatus: "top_chase_evidence",
      estimatedValue: fmv !== null && fmv >= 0 ? { amount: fmv, currency: "USD" } : null,
      valueSource: fmv === null ? null : "provider_fmv",
      imageUrls: images(chase?.image),
      relationships: [{
        entityKind: "pack",
        platform: PHYGITALS_PLATFORM_KEY,
        externalId: packExternalId,
        relationship: "subject",
      }],
      dataQualityEvidence: [{ code: "CHASE_LIST_NOT_COMPLETE_INVENTORY", severity: "info" }],
    }];
  }));
}

function packCandidates(
  source: ProviderSourceIdentity,
  data: Record<string, unknown>,
  fallbackExternalId: string | null,
): readonly ProviderAdapterCandidate[] | null {
  const externalId = identifier(data.id) ?? identifier(data.slug) ?? fallbackExternalId;
  const name = text(data.name);
  const price = finite(data.mint_price);
  if (!externalId || !name || price === null || price <= 0) return null;
  const parentExternalId = identifier(data.variant_of);
  const rawDrawCount = finite(data.pulls_per_voucher);
  const drawCount =
    rawDrawCount !== null && Number.isInteger(rawDrawCount) && rawDrawCount > 0
      ? rawDrawCount
      : null;
  const enabled = data.enable === true;
  const inStock = data.in_stock === true;
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const providerEv = finite(data.ev);
  const buybackRatio = finite(data.buyback_percent);
  const pack: CanonicalPackCandidate = {
    candidateKind: "pack",
    source,
    externalId,
    parentExternalId,
    name,
    description: boundedText(data.description),
    category: text(data.category) ?? text(categories[0]),
    availability: !enabled ? "disabled" : inStock ? "active" : "sold_out",
    sourceStatus: !enabled ? "disabled" : inStock ? "in_stock" : "out_of_stock",
    price: { amount: price, currency: "USD" },
    imageUrls: images(data.claw_image_url),
    providerReportedEv:
      providerEv !== null && providerEv >= 0
        ? { amount: providerEv, currency: "USD" }
        : null,
    buybackPercent:
      buybackRatio !== null && buybackRatio >= 0 && buybackRatio <= 1
        ? buybackRatio * 100
        : null,
    drawCount,
    relationships: parentExternalId ? [{
      entityKind: "pack",
      platform: PHYGITALS_PLATFORM_KEY,
      externalId: parentExternalId,
      relationship: "parent",
    }] : [],
    dataQualityEvidence: drawCount === null
      ? [{ code: "PHYGITALS_DRAW_SEMANTICS_UNAVAILABLE", severity: "warning", fieldPath: "data.pulls_per_voucher" }]
      : [],
  };
  const distribution = rarityDistribution(data, drawCount);
  const evInput: EvInputCandidate = {
    candidateKind: "ev_input",
    source,
    externalId: `${externalId}:rarity`,
    packExternalId: externalId,
    currency: "USD",
    unitBasis: drawCount === null ? null : "per_draw",
    drawCount,
    declaredCoverage: distribution.coverage,
    evidenceCompleteness: distribution.complete ? "complete" : "partial",
    buckets: distribution.buckets,
    relationships: [{
      entityKind: "pack",
      platform: PHYGITALS_PLATFORM_KEY,
      externalId,
      relationship: "subject",
    }],
    dataQualityEvidence: [
      ...(distribution.distributionComplete ? [] : [{
        code: "PHYGITALS_RARITY_DISTRIBUTION_INCOMPLETE",
        severity: "warning" as const,
        fieldPath: "data.rarity_distribution",
      }]),
      ...(drawCount === null ? [{
        code: "PHYGITALS_DRAW_SEMANTICS_UNAVAILABLE",
        severity: "warning" as const,
        fieldPath: "data.pulls_per_voucher",
      }] : []),
    ],
  };
  return Object.freeze([pack, evInput, ...chaseAssets(source, externalId, data)]);
}

function mapCatalog(envelope: CatalogEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "catalog", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "PHYGITALS_CATALOG_DATA_INVALID", "data");
  const root = packCandidates(source, data, envelope.external_id);
  if (!root) return invalid(source, "PHYGITALS_PACK_INVALID", "data");
  const candidates: ProviderAdapterCandidate[] = [...root];
  const variants = Array.isArray(data.variants) ? data.variants : [];
  for (const [index, value] of variants.entries()) {
    const variant = object(value);
    const mappedVariant = variant ? packCandidates(source, variant, null) : null;
    if (!mappedVariant) return invalid(source, "PHYGITALS_VARIANT_INVALID", `data.variants[${index}]`);
    candidates.push(...mappedVariant);
  }
  return mapped(source, candidates);
}

function mapPull(envelope: PullEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "pull", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "PHYGITALS_PULL_DATA_INVALID", "data");
  const transaction = object(data.transaction);
  const assetExternalId = identifier(data.id) ?? text(data.card_slug);
  const value = finite(data.value);
  const candidate: PullCandidate = {
    candidateKind: "pull",
    source,
    packExternalId: envelope.pack_external_id,
    assetExternalId,
    occurredAt: envelope.occurred_at,
    value: value !== null && value >= 0 ? { amount: value, currency: "USD" } : null,
    valueSource: value === null ? null : "provider_value",
    pseudonymizationInputs: actors(
      actor("from", transaction?.from),
      actor("to", transaction?.to),
    ),
    relationships: [
      ...(envelope.pack_external_id ? [{
        entityKind: "pack" as const,
        platform: PHYGITALS_PLATFORM_KEY,
        externalId: envelope.pack_external_id,
        relationship: "subject" as const,
      }] : []),
    ],
    dataQualityEvidence: envelope.pack_external_id
      ? []
      : [{ code: "PHYGITALS_PULL_PACK_UNRESOLVED", severity: "warning" }],
  };
  return mapped(source, [candidate]);
}

function mapSale(envelope: SaleEnvelopeV1, recordIndex: number) {
  const source = sourceIdentityForEnvelope({ recordKind: "sale", recordIndex, envelope });
  const data = object(envelope.data);
  if (!data) return invalid(source, "PHYGITALS_SALE_DATA_INVALID", "data");
  const nft = object(data.nft);
  const transactionKey = text(envelope.tx_hash) ?? text(data.txid);
  if (!transactionKey) return invalid(source, "PHYGITALS_TRANSACTION_ID_MISSING", "tx_hash");
  const verifiedUsdc = envelope.currency === PHYGITALS_USDC_MINT_ADDRESS;
  const amount = finite(envelope.amount);
  const packExternalId = identifier(data.clawId);
  const candidate: SaleCandidate = {
    candidateKind: "sale",
    source,
    eventType: envelope.event_type,
    transactionKey,
    assetExternalId:
      identifier(nft?.address) ??
      identifier(data.universalNFTDataAddress) ??
      identifier(data.ebayListingId),
    packExternalId,
    occurredAt: envelope.occurred_at,
    amount:
      verifiedUsdc && amount !== null && amount >= 0
        ? { amount, currency: "USDC" }
        : null,
    pseudonymizationInputs: actors(
      actor("from", data.from),
      actor("to", data.to),
      actor("owner", nft?.owner),
    ),
    relationships: packExternalId ? [{
      entityKind: "pack",
      platform: PHYGITALS_PLATFORM_KEY,
      externalId: packExternalId,
      relationship: "subject",
    }] : [],
    dataQualityEvidence: verifiedUsdc
      ? []
      : [{ code: "PHYGITALS_SALE_CURRENCY_UNVERIFIED", severity: "warning", fieldPath: "currency" }],
  };
  return mapped(source, [candidate]);
}

export class PhygitalsMappingAdapter implements ProviderMappingAdapter {
  readonly key = PHYGITALS_MAPPER_VERSION;
  readonly platformKey = PHYGITALS_PLATFORM_KEY;

  mapPage(input: {
    configuration: { platform: string };
    page: ProviderFeedPageV1;
    recordIndexes: Readonly<{ catalog: readonly number[]; pulls: readonly number[]; sales: readonly number[] }>;
  }) {
    if (input.configuration.platform !== this.platformKey) {
      throw new Error("Phygitals mapper platform mismatch.");
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
