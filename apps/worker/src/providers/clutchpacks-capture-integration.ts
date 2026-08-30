import { createHash, createHmac } from "node:crypto";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  dataforrestEventRecordV1Schema,
  normalizeDataforrestEventRecordForAdapter,
  type DataforrestEventRecordV1,
  type ProviderFeedPageV1,
} from "@packscout/contracts";
import {
  createProviderObservationMapperRegistryFromManifest,
  type CanonicalCatalogAssetCandidate,
  type CanonicalObservationPackCandidate,
  type CanonicalProviderCandidate,
} from "@packscout/services";
import {
  ProviderCaptureSourceError,
  type ProviderCaptureTranslation,
  type ProviderMixedPageRecordDraft,
} from "../provider-capture-source-contract.ts";
import {
  categoryDrafts,
  collectibleDraft,
  marketEventDraft,
  packDraft,
  pullDraft,
} from "../provider-observation-mixed-page-drafts.ts";

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
): CanonicalProviderCandidate {
  const parsed = dataforrestEventRecordV1Schema.safeParse(value);
  if (!parsed.success) invalidRecord();
  const observation = normalizeDataforrestEventRecordForAdapter(
    parsed.data,
    CLUTCHPACKS_PROVIDER_KEY,
    protectedEvidenceRef(parsed.data),
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
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
    ...packs.map((candidate) => packDraft(candidate)),
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
