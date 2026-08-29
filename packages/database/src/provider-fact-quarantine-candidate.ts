import { createHash } from "node:crypto";
import {
  normalizeJsonObject,
  normalizeMoneyDecimal,
  requireAccountKey,
  requireCurrency,
  requireDigest,
  requireNonEmptyText,
  requirePairedValues,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  type ProviderMarketEventType,
} from "./provider-canonical-contract.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const MAXIMUM_DATABASE_BIGINT = 9_223_372_036_854_775_807n;
const MARKET_EVENT_TYPES = new Set<ProviderMarketEventType>([
  "sale",
  "buyback",
  "mint",
  "burn",
  "transfer",
  "list",
  "unlist",
  "swap",
  "ship",
  "other",
]);

export type ProviderFactQuarantineRecordKind = "pull" | "market_event";

export interface ValidatedProviderFactQuarantineCandidate {
  readonly entityKey: string;
  readonly claimedDigest: string;
  readonly recomputedDigest: string;
}

function invalid(field: string): never {
  throw new TypeError(`The retained provider fact candidate is invalid at ${field}.`);
}

function requiredString(
  candidate: CanonicalJsonObject,
  field: string,
): string {
  const value = candidate[field];
  if (typeof value !== "string") return invalid(field);
  return value;
}

function requiredText(
  candidate: CanonicalJsonObject,
  field: string,
): string {
  const value = requiredString(candidate, field);
  if (requireNonEmptyText(value, field) !== value) return invalid(field);
  return value;
}

function nullableText(
  candidate: CanonicalJsonObject,
  field: string,
): string | null {
  const value = candidate[field];
  if (value === null) return null;
  if (typeof value !== "string" || requireNonEmptyText(value, field) !== value) {
    return invalid(field);
  }
  return value;
}

function nullableAccountKey(
  candidate: CanonicalJsonObject,
  field: string,
): string | null {
  const value = nullableText(candidate, field);
  return value === null ? null : requireAccountKey(value);
}

function nullableUuid(
  candidate: CanonicalJsonObject,
  field: string,
): string | null {
  const value = candidate[field];
  if (value === null) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalid(field);
  return value;
}

function instant(candidate: CanonicalJsonObject, field: string): string {
  const value = requiredString(candidate, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return invalid(field);
  }
  return value;
}

function nullableMoney(
  candidate: CanonicalJsonObject,
  amountField: string,
  currencyField: string,
): readonly [string | null, string | null] {
  const amount = candidate[amountField];
  const currency = candidate[currencyField];
  if (amount !== null && typeof amount !== "string") return invalid(amountField);
  if (currency !== null && typeof currency !== "string") return invalid(currencyField);
  requirePairedValues(amount, currency, amountField);
  if (amount !== null) normalizeMoneyDecimal(amount, amountField);
  if (currency !== null) requireCurrency(currency, currencyField);
  return [amount as string | null, currency as string | null];
}

function positiveIntegerString(
  candidate: CanonicalJsonObject,
  field: string,
): string {
  const value = requiredString(candidate, field);
  if (
    !POSITIVE_INTEGER_PATTERN.test(value)
    || BigInt(value) > MAXIMUM_DATABASE_BIGINT
  ) return invalid(field);
  return value;
}

function nullablePositiveIntegerString(
  candidate: CanonicalJsonObject,
  field: string,
): string | null {
  return candidate[field] === null ? null : positiveIntegerString(candidate, field);
}

function factDigest(domain: string, body: CanonicalJsonObject): string {
  return createHash("sha256")
    .update(`packscout.${domain}.v1\u0000`, "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
}

function pullCandidate(
  candidate: CanonicalJsonObject,
): ValidatedProviderFactQuarantineCandidate {
  const entityKey = requiredText(candidate, "pullKey");
  const claimedDigest = requireDigest(requiredString(candidate, "factDigest"));
  const packKey = nullableText(candidate, "packKey");
  const providerAccountKey = nullableAccountKey(candidate, "providerAccountKey");
  const occurredAt = instant(candidate, "occurredAt");
  const [paidAmount, paidCurrency] = nullableMoney(
    candidate,
    "paidAmount",
    "paidCurrency",
  );
  if (!Array.isArray(candidate.items) || candidate.items.length === 0) {
    return invalid("items");
  }
  let hasCollectibleRelationship = false;
  const items = candidate.items.map((value, index): CanonicalJsonObject => {
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      return invalid(`items[${index}]`);
    }
    const item = value as CanonicalJsonObject;
    const collectibleKey = nullableText(item, "collectibleKey");
    const collectibleInstanceKey = nullableText(
      item,
      "collectibleInstanceKey",
    );
    if (collectibleInstanceKey !== null && collectibleKey === null) {
      return invalid(`items[${index}].collectibleInstanceKey`);
    }
    if (collectibleKey !== null) hasCollectibleRelationship = true;
    const quantity = positiveIntegerString(item, "quantity");
    const [statedValueAmount, statedValueCurrency] = nullableMoney(
      item,
      "statedValueAmount",
      "statedValueCurrency",
    );

    // This property order is the v1 fact-digest contract. JSONB property order
    // is deliberately ignored and never hashed directly.
    return {
      collectibleKey,
      collectibleInstanceKey,
      quantity,
      statedValueAmount,
      statedValueCurrency,
    };
  });
  if (packKey === null && !hasCollectibleRelationship) {
    return invalid("relationships");
  }
  const body: CanonicalJsonObject = {
    pullKey: entityKey,
    packKey,
    providerAccountKey,
    occurredAt,
    paidAmount,
    paidCurrency,
    items,
  };
  return {
    entityKey,
    claimedDigest,
    recomputedDigest: factDigest("provider-pull-fact", body),
  };
}

function marketEventCandidate(
  candidate: CanonicalJsonObject,
): ValidatedProviderFactQuarantineCandidate {
  const entityKey = requiredText(candidate, "eventKey");
  const claimedDigest = requireDigest(requiredString(candidate, "factDigest"));
  const eventGroupId = nullableUuid(candidate, "eventGroupId");
  const eventType = requiredString(candidate, "eventType") as ProviderMarketEventType;
  if (!MARKET_EVENT_TYPES.has(eventType)) return invalid("eventType");
  const packKey = nullableText(candidate, "packKey");
  const collectibleKey = nullableText(candidate, "collectibleKey");
  const collectibleInstanceKey = nullableText(
    candidate,
    "collectibleInstanceKey",
  );
  if (packKey === null && collectibleKey === null) return invalid("relationships");
  if (collectibleInstanceKey !== null && collectibleKey === null) {
    return invalid("collectibleInstanceKey");
  }
  const fromProviderAccountKey = nullableAccountKey(
    candidate,
    "fromProviderAccountKey",
  );
  const toProviderAccountKey = nullableAccountKey(
    candidate,
    "toProviderAccountKey",
  );
  const quantity = nullablePositiveIntegerString(candidate, "quantity");
  const occurredAt = instant(candidate, "occurredAt");
  const [amount, currency] = nullableMoney(candidate, "amount", "currency");
  const detailsValue = candidate.details;
  if (
    detailsValue === null
    || Array.isArray(detailsValue)
    || typeof detailsValue !== "object"
  ) return invalid("details");
  const details = normalizeJsonObject(
    detailsValue as CanonicalJsonObject,
    "details",
  );

  // This property order is the v1 fact-digest contract. JSONB property order
  // is deliberately ignored and never hashed directly.
  const body: CanonicalJsonObject = {
    eventKey: entityKey,
    eventGroupId,
    eventType,
    packKey,
    collectibleKey,
    collectibleInstanceKey,
    fromProviderAccountKey,
    toProviderAccountKey,
    quantity,
    occurredAt,
    amount,
    currency,
    details,
  };
  return {
    entityKey,
    claimedDigest,
    recomputedDigest: factDigest("provider-market-event-fact", body),
  };
}

export function validateProviderFactQuarantineCandidate(input: {
  readonly recordKind: ProviderFactQuarantineRecordKind;
  readonly candidate: CanonicalJsonValue;
}): ValidatedProviderFactQuarantineCandidate {
  if (
    input.candidate === null
    || Array.isArray(input.candidate)
    || typeof input.candidate !== "object"
  ) return invalid("candidate");
  const candidate = input.candidate as CanonicalJsonObject;
  return input.recordKind === "pull"
    ? pullCandidate(candidate)
    : marketEventCandidate(candidate);
}
