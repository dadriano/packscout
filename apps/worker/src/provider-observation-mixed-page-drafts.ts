import { createHash } from "node:crypto";
import type { ProviderPackEvEvidenceV1 } from "@packscout/contracts";
import type { CanonicalJsonObject } from "@packscout/database";
import type {
  CanonicalCatalogAssetCandidate,
  CanonicalMarketEventCandidate,
  CanonicalObservationPackCandidate,
  CanonicalPullCandidate,
  ProviderObservationMoney,
} from "@packscout/services";
import {
  ProviderCaptureSourceError,
  type ProviderMixedPageRecordDraft,
} from "./provider-capture-source-contract.ts";

function invalidRecord(): never {
  throw new ProviderCaptureSourceError("PROVIDER_CAPTURE_RECORD_INVALID");
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function canonicalDigest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`packscout.${domain}.v1\u0000`)
    .update(JSON.stringify(value))
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

function categoryName(value: string | null): string | null {
  return value === null ? null : nonBlank(value);
}

function normalizedName(value: string): string {
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
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

export function categoryDrafts(
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
      if (current === undefined || name.localeCompare(current) < 0) {
        names.set(key, name);
      }
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

export function packDraft(
  candidate: CanonicalObservationPackCandidate,
  evidence?: Readonly<{ evInputEvidence: ProviderPackEvEvidenceV1 }>,
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
      attributes: evidence === undefined ? {} : {
        evInputEvidence: evidence.evInputEvidence,
      },
      sourceUpdatedAt: candidate.effectiveAt,
      expectedRowVersion: null,
    },
  };
}

export function collectibleDraft(
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
      valuationObservedAt: valuation.amount === null
        ? null
        : candidate.effectiveAt,
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

export function pullDraft(input: {
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

export function marketEventDraft(input: {
  readonly candidate: CanonicalMarketEventCandidate;
  readonly fromAccountKey: string | null;
  readonly toAccountKey: string | null;
  readonly providerId: string;
}): ProviderMixedPageRecordDraft {
  const cardRecordId = relationshipRecordId(input.candidate, "card");
  const hasMoney = input.candidate.amount !== null
    && input.candidate.currency !== null;
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
