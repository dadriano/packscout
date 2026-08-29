import type { CanonicalJsonObject } from "./provider-canonical-contract.ts";

export type ProviderMixedCatalogEntityType =
  | "category"
  | "pack"
  | "collectible"
  | "collectible_name_alias"
  | "collectible_instance"
  | "pack_content"
  | "provider_account";

const UPSERT_FIELDS: Readonly<Record<ProviderMixedCatalogEntityType, readonly string[]>> = {
  category: ["categoryKey", "parentCategoryKey", "displayName", "expectedRowVersion"],
  pack: [
    "packKey", "categoryKey", "familyKey", "displayName", "description", "packFormat",
    "availability", "contentEvidence", "totalInventory", "remainingInventory",
    "priceAmount", "priceCurrency", "priceUsdAmount", "priceUnavailableReason",
    "buybackRate", "buybackSourceKind", "vendorEvAmount", "vendorEvCurrency",
    "vendorEvObservedAt", "vendorEvUnavailableReason", "packscoutEvAmount",
    "packscoutEvCurrency", "packscoutEvModelVersion",
    "packscoutEvConfidencePolicyVersion", "packscoutEvConfidence",
    "packscoutEvDataAsOf", "packscoutEvCalculatedAt",
    "packscoutEvUnavailableReason", "primaryImageUrl", "primaryImageAlt", "listingUrl",
    "attributes", "sourceUpdatedAt", "expectedRowVersion",
  ],
  collectible: [
    "collectibleKey", "categoryKey", "collectibleType", "displayName", "normalizedName",
    "year", "brand", "setOrSeries", "cardNumber", "referenceNumber", "subject", "grade",
    "grader", "primaryImageUrl", "primaryImageAlt", "valuationAmount",
    "valuationCurrency", "valuationUsdAmount", "valuationUnavailableReason", "valuationType",
    "valuationObservedAt", "dataAsOf", "attributes", "expectedRowVersion",
  ],
  collectible_name_alias: [
    "collectibleKey", "displayName", "normalizedName", "expectedRowVersion",
  ],
  collectible_instance: [
    "collectibleKey", "instanceKey", "certifier", "certificationNumber", "attributes",
    "expectedRowVersion",
  ],
  pack_content: [
    "packKey", "collectibleKey", "collectibleInstanceKey", "totalQuantity",
    "availableQuantity", "contentRole", "probability", "statedValueAmount",
    "statedValueCurrency", "evidenceKinds", "matchConfidenceBasisPoints", "observedAt",
    "displayOrder", "expectedRowVersion",
  ],
  provider_account: ["accountKey", "displayName", "attributes", "expectedRowVersion"],
};

const RETIRE_FIELDS = ["id", "expectedRowVersion", "retiredAt"] as const;
const PULL_FIELDS = [
  "pullKey", "factDigest", "packKey", "providerAccountKey", "occurredAt", "paidAmount",
  "paidCurrency", "items",
] as const;
const PULL_ITEM_FIELDS = [
  "collectibleKey", "collectibleInstanceKey", "quantity", "statedValueAmount",
  "statedValueCurrency",
] as const;
const MARKET_EVENT_FIELDS = [
  "eventKey", "factDigest", "eventGroupId", "eventType", "packKey", "collectibleKey",
  "collectibleInstanceKey", "fromProviderAccountKey", "toProviderAccountKey", "quantity",
  "occurredAt", "amount", "currency", "details",
] as const;

export class ProviderMixedPageShapeError extends TypeError {
  readonly code = "MIXED_PAGE_UNKNOWN_FIELD";

  constructor(path: string) {
    super(`The provider mixed page contains an unknown field at ${path}.`);
    this.name = "ProviderMixedPageShapeError";
  }
}

export function requirePlainObject(value: unknown, path: string): CanonicalJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${path} must be a JSON object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain JSON object.`);
  }
  return value as CanonicalJsonObject;
}

export function rejectUnknownFields(
  value: CanonicalJsonObject,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new ProviderMixedPageShapeError(`${path}.${unknown}`);
}

function requireEntityType(value: unknown): ProviderMixedCatalogEntityType {
  if (typeof value !== "string" || !(value in UPSERT_FIELDS)) {
    throw new TypeError("records[].entityType is unsupported.");
  }
  return value as ProviderMixedCatalogEntityType;
}

export function assertRecordShape(value: CanonicalJsonObject, index: number): void {
  const path = `records[${index}]`;
  const kind = value.kind;
  if (kind === "catalog") {
    rejectUnknownFields(
      value,
      ["position", "providerId", "kind", "operation", "entityType", "candidate"],
      path,
    );
    const entityType = requireEntityType(value.entityType);
    if (value.operation !== "upsert" && value.operation !== "retire") {
      throw new TypeError(`${path}.operation is unsupported.`);
    }
    const candidate = requirePlainObject(value.candidate, `${path}.candidate`);
    rejectUnknownFields(
      candidate,
      value.operation === "upsert" ? UPSERT_FIELDS[entityType] : RETIRE_FIELDS,
      `${path}.candidate`,
    );
    return;
  }
  if (kind === "pull") {
    rejectUnknownFields(value, ["position", "providerId", "kind", "candidate"], path);
    const candidate = requirePlainObject(value.candidate, `${path}.candidate`);
    rejectUnknownFields(candidate, PULL_FIELDS, `${path}.candidate`);
    if (Array.isArray(candidate.items)) {
      candidate.items.forEach((item, itemIndex) => {
        const itemObject = requirePlainObject(item, `${path}.candidate.items[${itemIndex}]`);
        rejectUnknownFields(
          itemObject,
          PULL_ITEM_FIELDS,
          `${path}.candidate.items[${itemIndex}]`,
        );
      });
    }
    return;
  }
  if (kind === "market_event") {
    rejectUnknownFields(value, ["position", "providerId", "kind", "candidate"], path);
    const candidate = requirePlainObject(value.candidate, `${path}.candidate`);
    rejectUnknownFields(candidate, MARKET_EVENT_FIELDS, `${path}.candidate`);
    return;
  }
  throw new TypeError(`${path}.kind is unsupported.`);
}
