import { createHash, createHmac } from "node:crypto";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  dataforrestEventRecordV1Schema,
  normalizeDataforrestEventRecordForAdapter,
  type DataforrestEventRecordV1,
  type ProviderFeedPageV1,
} from "@packscout/contracts";
import {
  createProviderObservationMapperRegistryFromManifest,
  type CanonicalCatalogAssetCandidate,
  type CanonicalMarketEventCandidate,
  type CanonicalObservationPackCandidate,
  type CanonicalProviderCandidate,
  type CanonicalPullCandidate,
  type ProviderObservationMoney,
} from "@packscout/services";
import type { CanonicalJsonObject } from "@packscout/database";
import {
  ProviderCaptureSourceError,
  type ProviderCaptureTranslation,
  type ProviderMixedPageRecordDraft,
} from "../provider-capture-source-contract.ts";

const CLUTCHPACKS_PROVIDER_KEY = "clutchpacks" as const;
const TRANSIENT_MAPPING_ORGANIZATION_ID =
  "00000000-0000-4000-8000-000000000000";
const mapperRegistry = createProviderObservationMapperRegistryFromManifest();
const mapperDescriptor = (() => {
  const descriptor = mapperRegistry.descriptors().find(
    ({ provider }) => provider === CLUTCHPACKS_PROVIDER_KEY,
  );
  if (descriptor === undefined) {
    throw new Error("ClutchPacks provider observation mapper is unavailable.");
  }
  return descriptor;
})();

type NativeObject = Readonly<Record<string, unknown>>;

interface CardEvidence {
  readonly cardId: string;
  readonly effectiveAt: string;
  readonly collectedAt: string;
  readonly asset: Readonly<Record<string, string>>;
}

function invalidRecord(): never {
  throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_RECORD_INVALID");
}

function nativeObject(value: unknown): NativeObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as NativeObject
    : null;
}

function nativeArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalidRecord();
  return value;
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function requiredNonBlank(value: unknown): string {
  return nonBlank(value) ?? invalidRecord();
}

function copyText(
  source: NativeObject,
  sourceField: string,
  target: Record<string, string>,
  targetField = sourceField,
): void {
  const value = nonBlank(source[sourceField]);
  if (value !== null) target[targetField] = value;
}

function canonicalDigest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`packscout.${domain}.v1\u0000`)
    .update(JSON.stringify(value))
    .digest("hex");
}

function protectedEvidenceRef(record: DataforrestEventRecordV1): string {
  return `capture:${canonicalDigest(
    "capture-evidence",
    [record.stream, record.record_id],
  )}`;
}

function mapDataforrestRecord(
  value: unknown,
  providerId: string,
  adapterVersion:
    | typeof DATAFORREST_EVENTS_V1_ADAPTER_VERSION
    | typeof DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION =
      DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
): CanonicalProviderCandidate {
  const parsed = dataforrestEventRecordV1Schema.safeParse(value);
  if (!parsed.success) invalidRecord();
  const observation = normalizeDataforrestEventRecordForAdapter(
    parsed.data,
    CLUTCHPACKS_PROVIDER_KEY,
    protectedEvidenceRef(parsed.data),
    adapterVersion,
  );
  const outcome = mapperRegistry.map({
    organizationId: TRANSIENT_MAPPING_ORGANIZATION_ID,
    providerId,
    provider: CLUTCHPACKS_PROVIDER_KEY,
    mapperKey: mapperDescriptor.mapperKey,
    mapperVersion: mapperDescriptor.mapperVersion,
    normalizedContractVersion: mapperDescriptor.normalizedContractVersion,
    identityNamespaceKey: mapperDescriptor.identityNamespaceKey,
    observation,
  });
  if (outcome.status !== "mapped") invalidRecord();
  return outcome.candidate;
}

function safePackNativeData(data: NativeObject): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of [
    "name",
    "description",
    "image_url",
    "average_value",
    "sold_out",
  ]) {
    const value = data[field];
    if (value !== undefined) result[field] = value;
  }
  const category = nativeObject(data.category);
  if (category !== null && category.name !== undefined) {
    result.category = { name: category.name };
  }
  const series = nativeObject(data.series);
  if (series !== null && series.description !== undefined) {
    result.series = { description: series.description };
  }
  const price = nativeObject(data.price);
  const currency = nativeObject(price?.currency);
  if (price !== null && currency !== null) {
    result.price = {
      price_amount: price.price_amount,
      currency: {
        code: currency.code,
        decimals: currency.decimals,
      },
    };
  }
  if (Array.isArray(data.price_bucket_odds)) {
    result.price_bucket_odds = data.price_bucket_odds.map((candidate) => {
      const bucket = nativeObject(candidate) ?? invalidRecord();
      return {
        bucket_id: bucket.bucket_id,
        name: bucket.name,
        drawable_count: bucket.drawable_count,
        min_price: bucket.min_price,
        max_price: bucket.max_price,
      };
    });
  }
  return result;
}

function assetFromSeriesCard(value: unknown): Readonly<Record<string, string>> {
  const card = nativeObject(value) ?? invalidRecord();
  const asset: Record<string, string> = {};
  copyText(card, "title", asset);
  copyText(card, "front_image_url", asset);
  copyText(card, "current_price", asset, "formatted_current_price");
  return asset;
}

function assetFromPullCard(value: unknown): Readonly<Record<string, string>> {
  const card = nativeObject(value) ?? invalidRecord();
  const asset: Record<string, string> = {};
  for (const field of [
    "title",
    "description",
    "front_image_url",
    "front_image_medium_url",
    "front_image_thumbnail_url",
  ]) copyText(card, field, asset);
  copyText(card, "formatted_price", asset, "formatted_current_price");
  return asset;
}

function assetFromSaleCard(value: unknown): Readonly<Record<string, string>> {
  const card = nativeObject(value) ?? invalidRecord();
  const asset: Record<string, string> = {};
  for (const field of [
    "title",
    "subtype",
    "front_image_url",
    "front_image_medium_url",
    "front_image_thumbnail_url",
  ]) copyText(card, field, asset);
  return asset;
}

function addCardEvidence(
  destination: CardEvidence[],
  input: {
    readonly cardId: unknown;
    readonly effectiveAt: string;
    readonly collectedAt: string;
    readonly asset: Readonly<Record<string, string>>;
  },
): void {
  const cardId = requiredNonBlank(input.cardId);
  if (nonBlank(input.asset.title) === null) invalidRecord();
  destination.push({ ...input, cardId });
}

function collectCardEvidence(page: ProviderFeedPageV1): readonly CardEvidence[] {
  const evidence: CardEvidence[] = [];
  for (const envelope of page.catalog) {
    const data = nativeObject(envelope.data) ?? invalidRecord();
    for (const candidate of nativeArray(data.series_hits)) {
      const card = nativeObject(candidate) ?? invalidRecord();
      addCardEvidence(evidence, {
        cardId: card.id,
        effectiveAt: envelope.updated_at,
        collectedAt: envelope.collected_at,
        asset: assetFromSeriesCard(card),
      });
    }
    for (const bucketCandidate of nativeArray(data.price_bucket_odds)) {
      const bucket = nativeObject(bucketCandidate) ?? invalidRecord();
      for (const field of ["preview_cards", "pool_cards"] as const) {
        for (const candidate of nativeArray(bucket[field])) {
          const card = nativeObject(candidate) ?? invalidRecord();
          addCardEvidence(evidence, {
            cardId: card.id,
            effectiveAt: envelope.updated_at,
            collectedAt: envelope.collected_at,
            asset: assetFromSeriesCard(card),
          });
        }
      }
    }
  }
  for (const envelope of page.pulls) {
    const data = nativeObject(envelope.data) ?? invalidRecord();
    const card = nativeObject(data.card) ?? invalidRecord();
    addCardEvidence(evidence, {
      cardId: card.id,
      effectiveAt: envelope.occurred_at,
      collectedAt: envelope.collected_at,
      asset: assetFromPullCard(card),
    });
  }
  for (const envelope of page.trades) {
    const data = nativeObject(envelope.data) ?? invalidRecord();
    const card = nativeObject(data.card) ?? invalidRecord();
    addCardEvidence(evidence, {
      cardId: card.card_id,
      effectiveAt: envelope.occurred_at,
      collectedAt: envelope.collected_at,
      asset: assetFromSaleCard(card),
    });
  }
  return evidence;
}

function evidenceRank(left: CardEvidence, right: CardEvidence): number {
  const time = right.effectiveAt.localeCompare(left.effectiveAt);
  if (time !== 0) return time;
  const richness = Object.keys(right.asset).length - Object.keys(left.asset).length;
  if (richness !== 0) return richness;
  return canonicalDigest("card-evidence", left.asset).localeCompare(
    canonicalDigest("card-evidence", right.asset),
  );
}

function mergeCardEvidence(evidence: readonly CardEvidence[]): {
  readonly cardId: string;
  readonly effectiveAt: string;
  readonly collectedAt: string;
  readonly firstSeenAt: string;
  readonly asset: Readonly<Record<string, string>>;
} {
  const ranked = [...evidence].sort(evidenceRank);
  const first = ranked[0] ?? invalidRecord();
  const asset: Record<string, string> = {};
  for (const field of [
    "title",
    "description",
    "subtype",
    "formatted_current_price",
    "front_image_url",
    "front_image_medium_url",
    "front_image_thumbnail_url",
    "back_image_url",
    "back_image_medium_url",
    "back_image_thumbnail_url",
  ]) {
    const value = ranked.map((candidate) => candidate.asset[field]).find(
      (candidate): candidate is string => candidate !== undefined,
    );
    if (value !== undefined) asset[field] = value;
  }
  return {
    cardId: first.cardId,
    effectiveAt: ranked.map(({ effectiveAt }) => effectiveAt).sort().at(-1)
      ?? invalidRecord(),
    collectedAt: ranked.map(({ collectedAt }) => collectedAt).sort().at(-1)
      ?? invalidRecord(),
    firstSeenAt: ranked.map(({ effectiveAt }) => effectiveAt).sort()[0]
      ?? invalidRecord(),
    asset,
  };
}

function mappedPacks(
  page: ProviderFeedPageV1,
  providerId: string,
): readonly CanonicalObservationPackCandidate[] {
  return [...page.catalog]
    .sort((left, right) => left.external_id.localeCompare(right.external_id))
    .map((envelope) => {
      const data = nativeObject(envelope.data) ?? invalidRecord();
      const soldOut = data.sold_out;
      const candidate = mapDataforrestRecord({
        platform: CLUTCHPACKS_PROVIDER_KEY,
        stream: "catalog",
        entity: "pack",
        record_id: envelope.external_id,
        occurred_at: envelope.updated_at,
        collected_at: envelope.collected_at,
        first_seen_at: envelope.updated_at,
        available: typeof soldOut === "boolean" ? !soldOut : null,
        data: safePackNativeData(data),
      }, providerId);
      if (candidate.candidateKind !== "pack") invalidRecord();
      return candidate;
    });
}

function mappedCards(
  page: ProviderFeedPageV1,
  providerId: string,
): readonly CanonicalCatalogAssetCandidate[] {
  const byCard = new Map<string, CardEvidence[]>();
  for (const evidence of collectCardEvidence(page)) {
    const group = byCard.get(evidence.cardId) ?? [];
    group.push(evidence);
    byCard.set(evidence.cardId, group);
  }
  return [...byCard.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      const card = mergeCardEvidence(group);
      const candidate = mapDataforrestRecord({
        platform: CLUTCHPACKS_PROVIDER_KEY,
        stream: "catalog",
        entity: "card",
        record_id: card.cardId,
        occurred_at: card.effectiveAt,
        collected_at: card.collectedAt,
        first_seen_at: card.firstSeenAt,
        available: null,
        data: { asset: card.asset },
      }, providerId);
      if (candidate.candidateKind !== "catalog_asset") invalidRecord();
      return candidate;
    });
}

function actorAccountKey(
  actorHmacKey: Uint8Array,
  providerId: string,
  rawActor: unknown,
): string | null {
  const actor = nonBlank(rawActor);
  if (actor === null) return null;
  return createHmac("sha256", actorHmacKey)
    .update("packscout.provider-actor.v1\u0000")
    .update(providerId)
    .update("\u0000")
    .update(actor)
    .digest("hex");
}

function collectibleKey(providerRecordId: string): string {
  return `card:${providerRecordId}`;
}

function packKey(providerRecordId: string): string {
  return `pack:${providerRecordId}`;
}

function providerFactKey(
  factKind: "pull" | "event",
  providerId: string,
  providerRecordId: string,
): string {
  return `${factKind}:${canonicalDigest(
    `provider-${factKind}-identity`,
    [providerId, providerRecordId],
  )}`;
}

function sourceRecordKey(
  providerId: string,
  record: DataforrestEventRecordV1,
): string {
  const sourceScope = record.stream === "catalog"
    ? `catalog:${record.entity}`
    : record.stream;
  return `source:${canonicalDigest(
    "provider-source-record-identity",
    [providerId, sourceScope, record.record_id],
  )}`;
}

function sourceRecordKind(
  record: DataforrestEventRecordV1,
): ProviderMixedPageRecordDraft["kind"] {
  return record.stream === "catalog"
    ? "catalog"
    : record.stream === "pulls"
      ? "pull"
      : "market_event";
}

function sourceMappingQuarantine(input: {
  readonly providerId: string;
  readonly record: DataforrestEventRecordV1;
}): ProviderMixedPageRecordDraft {
  return {
    kind: sourceRecordKind(input.record),
    disposition: "quarantine",
    candidate: {},
    sourceRecordKey: sourceRecordKey(input.providerId, input.record),
    reasonCode: "SOURCE_RECORD_MAPPING_INVALID",
    fieldPath: null,
    sanitizedSummary:
      "The validated source record could not be mapped; no retry artifact is retained.",
  };
}

function categoryName(value: string | null): string | null {
  return value === null ? null : nonBlank(value);
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function categoryKey(value: string | null): string | null {
  const name = categoryName(value);
  return name === null
    ? null
    : `category:${canonicalDigest("provider-category", normalizedName(name))}`;
}

function exactDecimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) invalidRecord();
  const direct = value.toString();
  if (!direct.includes("e") && !direct.includes("E")) return direct;
  return value.toFixed(18).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/u, "$1");
}

function money(value: ProviderObservationMoney | null): {
  readonly amount: string | null;
  readonly currency: string | null;
  readonly usdAmount: string | null;
} {
  if (value === null) return { amount: null, currency: null, usdAmount: null };
  const currency = value.currency.toUpperCase();
  const amount = exactDecimal(value.amount);
  return { amount, currency, usdAmount: currency === "USD" ? amount : null };
}

function categoryDrafts(
  packs: readonly CanonicalObservationPackCandidate[],
  cards: readonly CanonicalCatalogAssetCandidate[],
): readonly ProviderMixedPageRecordDraft[] {
  const names = new Map<string, string>();
  for (const value of [
    ...packs.map(({ category }) => category),
    ...cards.map(({ category }) => category),
  ]) {
    const name = categoryName(value);
    const key = categoryKey(name);
    if (name !== null && key !== null) {
      const current = names.get(key);
      if (current === undefined || name.localeCompare(current) < 0) names.set(key, name);
    }
  }
  return [...names.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, displayName]) => ({
      kind: "catalog",
      operation: "upsert",
      entityType: "category",
      candidate: {
        categoryKey: key,
        parentCategoryKey: null,
        displayName,
        expectedRowVersion: null,
      },
    }));
}

function packDraft(
  candidate: CanonicalObservationPackCandidate,
): ProviderMixedPageRecordDraft {
  const price = money(candidate.price);
  const vendorEv = money(candidate.providerReportedEv);
  const primaryImageUrl = candidate.imageReferences[0] ?? null;
  return {
    kind: "catalog",
    operation: "upsert",
    entityType: "pack",
    candidate: {
      packKey: packKey(candidate.identity.providerRecordId),
      categoryKey: categoryKey(candidate.category),
      familyKey: null,
      displayName: candidate.displayName,
      description: candidate.description,
      packFormat: "repack",
      availability: candidate.availability === "available"
        ? "available"
        : candidate.availability === "sold_out"
          ? "sold_out"
          : "unavailable",
      contentEvidence: "unknown",
      totalInventory: null,
      remainingInventory: null,
      priceAmount: price.amount,
      priceCurrency: price.currency,
      priceUsdAmount: price.usdAmount,
      priceUnavailableReason: price.amount === null ? "source_unavailable" : null,
      buybackRate: candidate.buybackPercent === null
        ? null
        : exactDecimal(candidate.buybackPercent / 100),
      buybackSourceKind: candidate.buybackPercent === null
        ? null
        : "provider_statement",
      vendorEvAmount: vendorEv.amount,
      vendorEvCurrency: vendorEv.currency,
      vendorEvObservedAt: vendorEv.amount === null ? null : candidate.effectiveAt,
      vendorEvUnavailableReason: vendorEv.amount === null
        ? "source_unavailable"
        : null,
      packscoutEvAmount: null,
      packscoutEvCurrency: null,
      packscoutEvModelVersion: "not_calculated",
      packscoutEvConfidencePolicyVersion: "not_calculated",
      packscoutEvConfidence: null,
      packscoutEvDataAsOf: null,
      packscoutEvCalculatedAt: null,
      packscoutEvUnavailableReason: "not_calculated",
      primaryImageUrl,
      primaryImageAlt: primaryImageUrl === null ? null : candidate.displayName,
      listingUrl: null,
      attributes: {},
      sourceUpdatedAt: candidate.effectiveAt,
      expectedRowVersion: null,
    },
  };
}

function collectibleDraft(
  candidate: CanonicalCatalogAssetCandidate,
): ProviderMixedPageRecordDraft {
  const displayName = nonBlank(candidate.displayName) ?? invalidRecord();
  const valuation = money(candidate.estimatedValue);
  const primaryImageUrl = candidate.imageReferences[0] ?? null;
  return {
    kind: "catalog",
    operation: "upsert",
    entityType: "collectible",
    candidate: {
      collectibleKey: collectibleKey(candidate.identity.providerRecordId),
      categoryKey: categoryKey(candidate.category),
      collectibleType: "card",
      displayName,
      normalizedName: normalizedName(displayName),
      year: null,
      brand: null,
      setOrSeries: null,
      cardNumber: null,
      referenceNumber: null,
      subject: null,
      grade: null,
      grader: null,
      primaryImageUrl,
      primaryImageAlt: primaryImageUrl === null ? null : displayName,
      valuationAmount: valuation.amount,
      valuationCurrency: valuation.currency,
      valuationUsdAmount: valuation.usdAmount,
      valuationUnavailableReason: valuation.amount === null
        ? "source_unavailable"
        : null,
      valuationType: valuation.amount === null ? null : candidate.valueSource,
      valuationObservedAt: valuation.amount === null ? null : candidate.effectiveAt,
      dataAsOf: candidate.effectiveAt,
      attributes: {},
      expectedRowVersion: null,
    },
  };
}

function relationshipRecordId(
  candidate: CanonicalPullCandidate | CanonicalMarketEventCandidate,
  relationship: "pack" | "card",
): string | null {
  return candidate.relationships.find(
    (value) => value.relationship === relationship,
  )?.targetProviderRecordId ?? null;
}

function pullDraft(input: {
  readonly candidate: CanonicalPullCandidate;
  readonly accountKey: string | null;
  readonly providerId: string;
}): ProviderMixedPageRecordDraft {
  const packRecordId = relationshipRecordId(input.candidate, "pack");
  const cardRecordId = relationshipRecordId(input.candidate, "card");
  const value = money(input.candidate.value);
  const body: CanonicalJsonObject = {
    pullKey: providerFactKey(
      "pull",
      input.providerId,
      input.candidate.identity.providerRecordId,
    ),
    packKey: packRecordId === null ? null : packKey(packRecordId),
    providerAccountKey: input.accountKey,
    occurredAt: input.candidate.effectiveAt,
    paidAmount: null,
    paidCurrency: null,
    items: [{
      collectibleKey: cardRecordId === null
        ? null
        : collectibleKey(cardRecordId),
      collectibleInstanceKey: null,
      quantity: "1",
      statedValueAmount: value.amount,
      statedValueCurrency: value.currency,
    }],
  };
  return {
    kind: "pull",
    candidate: {
      ...body,
      factDigest: canonicalDigest("provider-pull-fact", body),
    },
  };
}

function normalizedEventType(value: string):
  | "sale"
  | "buyback"
  | "mint"
  | "burn"
  | "transfer"
  | "list"
  | "unlist"
  | "swap"
  | "ship"
  | "other" {
  const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  const aliases: Readonly<Record<string, string>> = {
    minted: "mint",
    shipped: "ship",
    listed: "list",
    unlisted: "unlist",
    sold: "sale",
  };
  const canonical = aliases[normalized] ?? normalized;
  return [
    "sale",
    "buyback",
    "mint",
    "burn",
    "transfer",
    "list",
    "unlist",
    "swap",
    "ship",
  ].includes(canonical)
    ? canonical as Exclude<ReturnType<typeof normalizedEventType>, "other">
    : "other";
}

function marketEventDraft(input: {
  readonly candidate: CanonicalMarketEventCandidate;
  readonly fromAccountKey: string | null;
  readonly toAccountKey: string | null;
  readonly providerId: string;
}): ProviderMixedPageRecordDraft {
  const cardRecordId = relationshipRecordId(input.candidate, "card");
  const hasMoney = input.candidate.amount !== null && input.candidate.currency !== null;
  const body: CanonicalJsonObject = {
    eventKey: providerFactKey(
      "event",
      input.providerId,
      input.candidate.identity.providerRecordId,
    ),
    eventGroupId: null,
    eventType: normalizedEventType(input.candidate.eventType),
    packKey: null,
    collectibleKey: cardRecordId === null ? null : collectibleKey(cardRecordId),
    collectibleInstanceKey: null,
    fromProviderAccountKey: input.fromAccountKey,
    toProviderAccountKey: input.toAccountKey,
    quantity: null,
    occurredAt: input.candidate.effectiveAt,
    amount: hasMoney ? exactDecimal(input.candidate.amount as number) : null,
    currency: hasMoney
      ? (input.candidate.currency as string).toUpperCase()
      : null,
    details: {},
  };
  return {
    kind: "market_event",
    candidate: {
      ...body,
      factDigest: canonicalDigest("provider-market-event-fact", body),
    },
  };
}

export function translateClutchpacksCapture(input: {
  readonly page: ProviderFeedPageV1;
  readonly providerId: string;
  readonly actorHmacKey: Uint8Array;
}): ProviderCaptureTranslation {
  if (input.actorHmacKey.byteLength < 32) {
    throw new ProviderCaptureSourceError(
      "PROVIDER_CAPTURE_CONFIGURATION_INVALID",
    );
  }
  const packs = mappedPacks(input.page, input.providerId);
  const cards = mappedCards(input.page, input.providerId);
  const accountKeys = new Set<string>();
  const pulls = [...input.page.pulls]
    .sort((left, right) => left.external_id.localeCompare(right.external_id))
    .map((envelope) => {
      const data = nativeObject(envelope.data) ?? invalidRecord();
      const card = nativeObject(data.card) ?? invalidRecord();
      const user = nativeObject(data.user);
      const accountKey = actorAccountKey(
        input.actorHmacKey,
        input.providerId,
        user?.id,
      );
      if (accountKey !== null) accountKeys.add(accountKey);
      const candidate = mapDataforrestRecord({
        platform: CLUTCHPACKS_PROVIDER_KEY,
        stream: "pulls",
        record_id: envelope.external_id,
        occurred_at: envelope.occurred_at,
        collected_at: envelope.collected_at,
        pack_id: envelope.pack_external_id,
        card_id: requiredNonBlank(card.id),
        data: nonBlank(data.name) === null ? {} : { provider_label: data.name },
      }, input.providerId);
      if (candidate.candidateKind !== "pull") invalidRecord();
      return pullDraft({ candidate, accountKey, providerId: input.providerId });
    });
  const events = [...input.page.trades]
    .sort((left, right) => left.external_id.localeCompare(right.external_id))
    .map((envelope) => {
      const data = nativeObject(envelope.data) ?? invalidRecord();
      const card = nativeObject(data.card) ?? invalidRecord();
      const fromAccountKey = actorAccountKey(
        input.actorHmacKey,
        input.providerId,
        data.from,
      );
      const toAccountKey = actorAccountKey(
        input.actorHmacKey,
        input.providerId,
        data.to,
      );
      if (fromAccountKey !== null) accountKeys.add(fromAccountKey);
      if (toAccountKey !== null) accountKeys.add(toAccountKey);
      const candidate = mapDataforrestRecord({
        platform: CLUTCHPACKS_PROVIDER_KEY,
        stream: "trades",
        record_id: envelope.external_id,
        occurred_at: envelope.occurred_at,
        collected_at: envelope.collected_at,
        card_id: requiredNonBlank(card.card_id),
        event_type: envelope.event_type,
        amount: envelope.amount,
        currency: envelope.currency,
        payment_method: null,
        tx_hash: null,
        data: nonBlank(card.title) === null
          ? {}
          : { provider_label: card.title },
      }, input.providerId);
      if (candidate.candidateKind !== "market_event") invalidRecord();
      return marketEventDraft({
        candidate,
        fromAccountKey,
        toAccountKey,
        providerId: input.providerId,
      });
    });
  const categories = categoryDrafts(packs, cards);
  const providerAccounts: readonly ProviderMixedPageRecordDraft[] =
    [...accountKeys].sort().map((accountKey) => ({
      kind: "catalog",
      operation: "upsert",
      entityType: "provider_account",
      candidate: {
        accountKey,
        displayName: null,
        attributes: {},
        expectedRowVersion: null,
      },
    }));
  const records = Object.freeze([
    ...categories,
    ...packs.map(packDraft),
    ...cards.map(collectibleDraft),
    ...providerAccounts,
    ...pulls,
    ...events,
  ]);
  return Object.freeze({
    records,
    counts: Object.freeze({
      categories: categories.length,
      packs: packs.length,
      collectibles: cards.length,
      providerAccounts: providerAccounts.length,
      pulls: pulls.length,
      pullsWithoutPackKey: pulls.filter(
        ({ candidate }) => candidate.packKey === null,
      ).length,
      marketEvents: events.length,
      packContents: 0,
    }),
  });
}

/**
 * Translates records already validated by the live DataForrest adapter without
 * rebuilding the legacy provider-feed envelope. Native record data is only
 * interpreted by the versioned DataForrest normalizer and ClutchPacks mapper;
 * live-only callers must not infer provider accounts from unapproved actor
 * fields in the protected native payload.
 */
export function translateClutchpacksDataforrestRecords(input: {
  readonly records: readonly DataforrestEventRecordV1[];
  readonly providerId: string;
  readonly adapterVersion?:
    typeof DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION;
}): ProviderCaptureTranslation {
  const packs: CanonicalObservationPackCandidate[] = [];
  const cards: CanonicalCatalogAssetCandidate[] = [];
  const pulls: CanonicalPullCandidate[] = [];
  const events: CanonicalMarketEventCandidate[] = [];
  const quarantines: ProviderMixedPageRecordDraft[] = [];

  const ordered = [...input.records].sort((left, right) => {
    const streamOrder = { catalog: 0, pulls: 1, trades: 2 } as const;
    const stream = streamOrder[left.stream] - streamOrder[right.stream];
    if (stream !== 0) return stream;
    if (left.stream === "catalog" && right.stream === "catalog") {
      const entity = (left.entity === "pack" ? 0 : 1) -
        (right.entity === "pack" ? 0 : 1);
      if (entity !== 0) return entity;
    }
    return left.record_id.localeCompare(right.record_id);
  });

  for (const record of ordered) {
    try {
      const candidate: CanonicalProviderCandidate = mapDataforrestRecord(
        record,
        input.providerId,
        input.adapterVersion,
      );
      if (record.stream === "catalog" && record.entity === "pack") {
        if (candidate.candidateKind !== "pack") invalidRecord();
        packDraft(candidate);
        packs.push(candidate);
        continue;
      }
      if (record.stream === "catalog" && record.entity === "card") {
        if (candidate.candidateKind !== "catalog_asset") invalidRecord();
        collectibleDraft(candidate);
        cards.push(candidate);
        continue;
      }
      if (record.stream === "pulls") {
        if (candidate.candidateKind !== "pull") invalidRecord();
        pullDraft({
          candidate,
          accountKey: null,
          providerId: input.providerId,
        });
        pulls.push(candidate);
        continue;
      }
      if (candidate.candidateKind !== "market_event") invalidRecord();
      marketEventDraft({
        candidate,
        fromAccountKey: null,
        toAccountKey: null,
        providerId: input.providerId,
      });
      events.push(candidate);
    } catch (error) {
      if (
        !(error instanceof ProviderCaptureSourceError)
        || error.code !== "PROVIDER_CAPTURE_RECORD_INVALID"
      ) {
        throw error;
      }
      quarantines.push(sourceMappingQuarantine({
        providerId: input.providerId,
        record,
      }));
    }
  }

  const categories = categoryDrafts(packs, cards);
  const pullRecords = pulls.map((candidate) => pullDraft({
    candidate,
    accountKey: null,
    providerId: input.providerId,
  }));
  const marketEvents = events.map((candidate) => marketEventDraft({
    candidate,
    fromAccountKey: null,
    toAccountKey: null,
    providerId: input.providerId,
  }));
  const records = Object.freeze([
    ...categories,
    ...packs.map(packDraft),
    ...cards.map(collectibleDraft),
    ...pullRecords,
    ...marketEvents,
    ...quarantines,
  ]);
  return Object.freeze({
    records,
    counts: Object.freeze({
      categories: categories.length,
      packs: packs.length,
      collectibles: cards.length,
      providerAccounts: 0,
      pulls: pullRecords.length,
      pullsWithoutPackKey: pullRecords.filter(
        ({ candidate }) => candidate.packKey === null,
      ).length,
      marketEvents: marketEvents.length,
      packContents: 0,
    }),
  });
}
