import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  CategoryWriteInput,
  CollectibleInstanceWriteInput,
  CollectibleNameAliasWriteInput,
  CollectibleWriteInput,
  MarketEventWriteInput,
  PackContentWriteInput,
  PackWriteInput,
  ProviderAccountWriteInput,
  PullItemWriteInput,
  PullWriteInput,
  RetireCanonicalEntityInput,
} from "./provider-canonical-contract.ts";
import type { ProviderCanonicalTransaction } from "./provider-canonical-repository.ts";
import type { ProviderTransactionClient } from "./provider-database.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";
import type { ProviderMixedCatalogEntityType } from "./provider-mixed-page-shape.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONNEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export class ProviderMixedCandidateError extends TypeError {
  readonly code = "NORMALIZED_CANDIDATE_INVALID";

  constructor(readonly fieldPath: string) {
    super("The normalized provider candidate is invalid.");
    this.name = "ProviderMixedCandidateError";
  }
}

function candidateError(path: string): never {
  throw new ProviderMixedCandidateError(path);
}

function stringValue(object: CanonicalJsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") candidateError(key);
  return value;
}

function nullableString(object: CanonicalJsonObject, key: string): string | null {
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== "string") candidateError(key);
  return value;
}

function uuidValue(object: CanonicalJsonObject, key: string): string {
  const value = stringValue(object, key);
  if (!UUID_PATTERN.test(value)) candidateError(key);
  return value;
}

function nullableUuid(object: CanonicalJsonObject, key: string): string | null {
  const value = nullableString(object, key);
  if (value !== null && !UUID_PATTERN.test(value)) candidateError(key);
  return value;
}

function integerValue(object: CanonicalJsonObject, key: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value)) candidateError(key);
  return value as number;
}

function nullableInteger(object: CanonicalJsonObject, key: string): number | null {
  const value = object[key];
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) candidateError(key);
  return value as number;
}

function bigintValue(object: CanonicalJsonObject, key: string): bigint {
  const value = object[key];
  if (typeof value !== "string" || !NONNEGATIVE_INTEGER_PATTERN.test(value)) candidateError(key);
  return BigInt(value);
}

function nullableBigint(object: CanonicalJsonObject, key: string): bigint | null {
  if (object[key] === null) return null;
  return bigintValue(object, key);
}

function expectedVersion(object: CanonicalJsonObject): bigint | undefined {
  const value = object.expectedRowVersion;
  if (value === undefined || value === null) return undefined;
  return bigintValue(object, "expectedRowVersion");
}

function dateValue(object: CanonicalJsonObject, key: string): Date {
  const value = stringValue(object, key);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) candidateError(key);
  return date;
}

function nullableDate(object: CanonicalJsonObject, key: string): Date | null {
  if (object[key] === null) return null;
  return dateValue(object, key);
}

function jsonObject(object: CanonicalJsonObject, key: string): CanonicalJsonObject {
  const value = object[key];
  if (value === null || Array.isArray(value) || typeof value !== "object") candidateError(key);
  return value as CanonicalJsonObject;
}

function nullableJsonObject(object: CanonicalJsonObject, key: string): CanonicalJsonObject | null {
  if (object[key] === null) return null;
  return jsonObject(object, key);
}

function stringArray(object: CanonicalJsonObject, key: string): readonly string[] {
  const value = object[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) candidateError(key);
  return value as readonly string[];
}

function enumValue<T extends string>(
  object: CanonicalJsonObject,
  key: string,
  values: readonly T[],
): T {
  const value = stringValue(object, key);
  if (!values.includes(value as T)) candidateError(key);
  return value as T;
}

async function resolveCategoryId(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonObject,
  key: string,
): Promise<string | null> {
  const categoryKey = nullableString(value, key);
  if (categoryKey === null) return null;
  const row = await transaction.categories.findUnique({
    where: { category_key: categoryKey }, select: { id: true, lifecycle: true },
  });
  if (row?.lifecycle !== "active") candidateError(key);
  return row.id;
}

async function resolvePackId(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonObject,
  key: string,
): Promise<string | null> {
  const packKey = nullableString(value, key);
  if (packKey === null) return null;
  const row = await transaction.packs.findUnique({
    where: { pack_key: packKey }, select: { id: true, lifecycle: true },
  });
  if (row?.lifecycle !== "active") candidateError(key);
  return row.id;
}

async function resolveFactPackId(
  transaction: ProviderTransactionClient,
  packKey: string | null,
): Promise<string | null> {
  if (packKey === null) return null;
  return (await transaction.packs.findUnique({
    where: { pack_key: packKey }, select: { id: true },
  }))?.id ?? null;
}

async function resolveCollectibleId(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonObject,
  key: string,
): Promise<string | null> {
  const collectibleKey = nullableString(value, key);
  if (collectibleKey === null) return null;
  const row = await transaction.collectibles.findUnique({
    where: { collectible_key: collectibleKey }, select: { id: true, lifecycle: true },
  });
  if (row?.lifecycle !== "active") candidateError(key);
  return row.id;
}

async function resolveFactCollectibleId(
  transaction: ProviderTransactionClient,
  collectibleKey: string | null,
): Promise<string | null> {
  if (collectibleKey === null) return null;
  return (await transaction.collectibles.findUnique({
    where: { collectible_key: collectibleKey }, select: { id: true },
  }))?.id ?? null;
}

async function resolveInstanceId(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonObject,
  key: string,
): Promise<string | null> {
  const instanceKey = nullableString(value, key);
  if (instanceKey === null) return null;
  const row = await transaction.collectible_instances.findUnique({
    where: { instance_key: instanceKey }, select: { id: true, lifecycle: true },
  });
  if (row?.lifecycle !== "active") candidateError(key);
  return row.id;
}

async function resolveAccountId(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonObject,
  key: string,
): Promise<string | null> {
  const accountKey = nullableString(value, key);
  if (accountKey === null) return null;
  const row = await transaction.provider_accounts.findUnique({
    where: { account_key: accountKey }, select: { id: true, lifecycle: true },
  });
  if (row?.lifecycle !== "active") candidateError(key);
  return row.id;
}

function categoryCandidate(
  value: CanonicalJsonObject,
  parentCategoryId: string | null,
): CategoryWriteInput {
  return {
    categoryKey: stringValue(value, "categoryKey"),
    parentCategoryId,
    displayName: stringValue(value, "displayName"),
    expectedRowVersion: expectedVersion(value),
  };
}

function packCandidate(value: CanonicalJsonObject, categoryId: string | null): PackWriteInput {
  return {
    packKey: stringValue(value, "packKey"), categoryId,
    familyKey: nullableString(value, "familyKey"), displayName: stringValue(value, "displayName"),
    description: nullableString(value, "description"),
    packFormat: enumValue(value, "packFormat", ["repack", "gacha"]),
    availability: enumValue(value, "availability", ["available", "sold_out", "unavailable"]),
    contentEvidence: enumValue(value, "contentEvidence", ["complete", "partial", "unknown"]),
    totalInventory: nullableBigint(value, "totalInventory"),
    remainingInventory: nullableBigint(value, "remainingInventory"),
    priceAmount: nullableString(value, "priceAmount"), priceCurrency: nullableString(value, "priceCurrency"),
    priceUsdAmount: nullableString(value, "priceUsdAmount"),
    priceUnavailableReason: nullableString(value, "priceUnavailableReason"),
    buybackRate: nullableString(value, "buybackRate"),
    buybackSourceKind: nullableString(value, "buybackSourceKind"),
    vendorEvAmount: nullableString(value, "vendorEvAmount"),
    vendorEvCurrency: nullableString(value, "vendorEvCurrency"),
    vendorEvObservedAt: nullableDate(value, "vendorEvObservedAt"),
    vendorEvUnavailableReason: nullableString(value, "vendorEvUnavailableReason"),
    packscoutEvAmount: nullableString(value, "packscoutEvAmount"),
    packscoutEvCurrency: nullableString(value, "packscoutEvCurrency"),
    packscoutEvModelVersion: stringValue(value, "packscoutEvModelVersion"),
    packscoutEvConfidencePolicyVersion: stringValue(value, "packscoutEvConfidencePolicyVersion"),
    packscoutEvConfidence: nullableJsonObject(value, "packscoutEvConfidence"),
    packscoutEvDataAsOf: nullableDate(value, "packscoutEvDataAsOf"),
    packscoutEvCalculatedAt: nullableDate(value, "packscoutEvCalculatedAt"),
    packscoutEvUnavailableReason: nullableString(value, "packscoutEvUnavailableReason"),
    primaryImageUrl: nullableString(value, "primaryImageUrl"),
    primaryImageAlt: nullableString(value, "primaryImageAlt"), listingUrl: nullableString(value, "listingUrl"),
    attributes: jsonObject(value, "attributes"), sourceUpdatedAt: dateValue(value, "sourceUpdatedAt"),
    expectedRowVersion: expectedVersion(value),
  };
}

function collectibleCandidate(
  value: CanonicalJsonObject,
  categoryId: string | null,
): CollectibleWriteInput {
  return {
    collectibleKey: stringValue(value, "collectibleKey"), categoryId,
    collectibleType: enumValue(value, "collectibleType", ["card", "watch", "art", "coin", "sealed_product", "memorabilia", "other"]),
    displayName: stringValue(value, "displayName"), normalizedName: stringValue(value, "normalizedName"),
    year: nullableInteger(value, "year"), brand: nullableString(value, "brand"),
    setOrSeries: nullableString(value, "setOrSeries"), cardNumber: nullableString(value, "cardNumber"),
    referenceNumber: nullableString(value, "referenceNumber"), subject: nullableString(value, "subject"),
    grade: nullableString(value, "grade"), grader: nullableString(value, "grader"),
    primaryImageUrl: nullableString(value, "primaryImageUrl"), primaryImageAlt: nullableString(value, "primaryImageAlt"),
    valuationAmount: nullableString(value, "valuationAmount"), valuationCurrency: nullableString(value, "valuationCurrency"),
    valuationUsdAmount: nullableString(value, "valuationUsdAmount"),
    valuationUnavailableReason: nullableString(value, "valuationUnavailableReason"),
    valuationType: nullableString(value, "valuationType"), valuationObservedAt: nullableDate(value, "valuationObservedAt"),
    dataAsOf: dateValue(value, "dataAsOf"), attributes: jsonObject(value, "attributes"),
    expectedRowVersion: expectedVersion(value),
  };
}

function packContentCandidate(input: {
  readonly value: CanonicalJsonObject;
  readonly packId: string;
  readonly collectibleId: string;
  readonly collectibleInstanceId: string | null;
}): PackContentWriteInput {
  const value = input.value;
  return {
    packId: input.packId, collectibleId: input.collectibleId,
    collectibleInstanceId: input.collectibleInstanceId,
    totalQuantity: nullableBigint(value, "totalQuantity"), availableQuantity: nullableBigint(value, "availableQuantity"),
    contentRole: enumValue(value, "contentRole", ["top_chase", "featured_chase", "possible_outcome", "other"]),
    probability: nullableString(value, "probability"), statedValueAmount: nullableString(value, "statedValueAmount"),
    statedValueCurrency: nullableString(value, "statedValueCurrency"), evidenceKinds: stringArray(value, "evidenceKinds"),
    matchConfidenceBasisPoints: integerValue(value, "matchConfidenceBasisPoints"),
    observedAt: dateValue(value, "observedAt"), displayOrder: integerValue(value, "displayOrder"),
    expectedRowVersion: expectedVersion(value),
  };
}

function retireCandidate(value: CanonicalJsonObject): RetireCanonicalEntityInput {
  return {
    id: uuidValue(value, "id"), expectedRowVersion: expectedVersion(value),
    retiredAt: value.retiredAt === undefined || value.retiredAt === null ? undefined : dateValue(value, "retiredAt"),
  };
}

async function pullItem(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonValue,
  index: number,
): Promise<PullItemWriteInput> {
  if (value === null || Array.isArray(value) || typeof value !== "object") candidateError(`items[${index}]`);
  const object = value as CanonicalJsonObject;
  const collectibleKey = nullableString(object, "collectibleKey");
  const collectibleInstanceKey = nullableString(
    object,
    "collectibleInstanceKey",
  );
  const collectibleId = await resolveFactCollectibleId(transaction, collectibleKey);
  if (collectibleInstanceKey !== null && collectibleId === null) {
    candidateError(`items[${index}].collectibleInstanceKey`);
  }
  return {
    collectibleKey,
    collectibleId,
    collectibleInstanceId: collectibleInstanceKey === null
      ? null
      : await resolveInstanceId(transaction, object, "collectibleInstanceKey"),
    quantity: bigintValue(object, "quantity"), statedValueAmount: nullableString(object, "statedValueAmount"),
    statedValueCurrency: nullableString(object, "statedValueCurrency"),
  };
}

async function pullCandidate(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonObject,
): Promise<PullWriteInput> {
  if (!Array.isArray(value.items)) candidateError("items");
  const packKey = nullableString(value, "packKey");
  const items: PullItemWriteInput[] = [];
  for (const [index, item] of value.items.entries()) {
    items.push(await pullItem(transaction, item, index));
  }
  return {
    pullKey: stringValue(value, "pullKey"), factDigest: stringValue(value, "factDigest"),
    packKey, packId: await resolveFactPackId(transaction, packKey),
    providerAccountId: await resolveAccountId(transaction, value, "providerAccountKey"),
    occurredAt: dateValue(value, "occurredAt"), paidAmount: nullableString(value, "paidAmount"),
    paidCurrency: nullableString(value, "paidCurrency"),
    items,
  };
}

async function marketEventCandidate(
  transaction: ProviderTransactionClient,
  value: CanonicalJsonObject,
): Promise<MarketEventWriteInput> {
  const packKey = nullableString(value, "packKey");
  const collectibleKey = nullableString(value, "collectibleKey");
  const collectibleInstanceKey = nullableString(
    value,
    "collectibleInstanceKey",
  );
  const collectibleId = await resolveFactCollectibleId(transaction, collectibleKey);
  if (collectibleInstanceKey !== null && collectibleId === null) {
    candidateError("collectibleInstanceKey");
  }
  return {
    eventKey: stringValue(value, "eventKey"), factDigest: stringValue(value, "factDigest"),
    eventGroupId: nullableUuid(value, "eventGroupId"),
    eventType: enumValue(value, "eventType", ["sale", "buyback", "mint", "burn", "transfer", "list", "unlist", "swap", "ship", "other"]),
    packKey, packId: await resolveFactPackId(transaction, packKey),
    collectibleKey, collectibleId,
    collectibleInstanceId: collectibleInstanceKey === null
      ? null
      : await resolveInstanceId(transaction, value, "collectibleInstanceKey"),
    fromProviderAccountId: await resolveAccountId(transaction, value, "fromProviderAccountKey"),
    toProviderAccountId: await resolveAccountId(transaction, value, "toProviderAccountKey"),
    quantity: nullableBigint(value, "quantity"), occurredAt: dateValue(value, "occurredAt"),
    amount: nullableString(value, "amount"), currency: nullableString(value, "currency"),
    details: jsonObject(value, "details"),
  };
}

export interface ProviderMixedRecordWriteOutcome {
  readonly duplicate: boolean;
  readonly materialChange: boolean;
}

async function applyCatalog(
  transaction: ProviderTransactionClient,
  canonical: ProviderCanonicalTransaction,
  record: ProviderMixedPageRecord,
): Promise<ProviderMixedRecordWriteOutcome> {
  const type = record.entityType as ProviderMixedCatalogEntityType;
  if (record.operation === "retire") {
    const candidate = retireCandidate(record.candidate);
    const result = type === "category" ? await canonical.retireCategory(candidate)
      : type === "pack" ? await canonical.retirePack(candidate)
      : type === "collectible" ? await canonical.retireCollectible(candidate)
      : type === "collectible_name_alias" ? await canonical.retireCollectibleNameAlias(candidate)
      : type === "collectible_instance" ? await canonical.retireCollectibleInstance(candidate)
      : type === "pack_content" ? await canonical.retirePackContent(candidate)
      : await canonical.retireProviderAccount(candidate);
    return { duplicate: !result.materialChange, materialChange: result.materialChange };
  }
  const value = record.candidate;
  const categoryId = type === "pack" || type === "collectible"
    ? await resolveCategoryId(transaction, value, "categoryKey")
    : null;
  const collectibleId = type === "collectible_name_alias" || type === "collectible_instance"
    ? await resolveCollectibleId(transaction, value, "collectibleKey")
    : null;
  if (
    (type === "collectible_name_alias" || type === "collectible_instance")
    && collectibleId === null
  ) candidateError("collectibleKey");
  const packId = type === "pack_content"
    ? await resolvePackId(transaction, value, "packKey")
    : null;
  const contentCollectibleId = type === "pack_content"
    ? await resolveCollectibleId(transaction, value, "collectibleKey")
    : null;
  if (type === "pack_content" && packId === null) candidateError("packKey");
  if (type === "pack_content" && contentCollectibleId === null) candidateError("collectibleKey");
  const result = type === "category" ? await canonical.upsertCategory(categoryCandidate(
    value,
    await resolveCategoryId(transaction, value, "parentCategoryKey"),
  ))
    : type === "pack" ? await canonical.upsertPack(packCandidate(value, categoryId))
    : type === "collectible" ? await canonical.upsertCollectible(collectibleCandidate(value, categoryId))
    : type === "collectible_name_alias" ? await canonical.upsertCollectibleNameAlias({
      collectibleId: collectibleId as string, displayName: stringValue(value, "displayName"),
      normalizedName: stringValue(value, "normalizedName"), expectedRowVersion: expectedVersion(value),
    } satisfies CollectibleNameAliasWriteInput)
    : type === "collectible_instance" ? await canonical.upsertCollectibleInstance({
      collectibleId: collectibleId as string, instanceKey: stringValue(value, "instanceKey"),
      certifier: nullableString(value, "certifier"), certificationNumber: nullableString(value, "certificationNumber"),
      attributes: jsonObject(value, "attributes"), expectedRowVersion: expectedVersion(value),
    } satisfies CollectibleInstanceWriteInput)
    : type === "pack_content" ? await canonical.upsertPackContent(packContentCandidate({
      value,
      packId: packId as string,
      collectibleId: contentCollectibleId as string,
      collectibleInstanceId: await resolveInstanceId(transaction, value, "collectibleInstanceKey"),
    }))
    : await canonical.upsertProviderAccount({
      accountKey: stringValue(value, "accountKey"), displayName: nullableString(value, "displayName"),
      attributes: jsonObject(value, "attributes"), expectedRowVersion: expectedVersion(value),
    } satisfies ProviderAccountWriteInput);
  return { duplicate: !result.materialChange, materialChange: result.materialChange };
}

export async function applyProviderMixedPageRecord(
  transaction: ProviderTransactionClient,
  canonical: ProviderCanonicalTransaction,
  record: ProviderMixedPageRecord,
): Promise<ProviderMixedRecordWriteOutcome> {
  if (record.kind === "catalog") return applyCatalog(transaction, canonical, record);
  if (record.kind === "pull") {
    const result = await canonical.insertPull(await pullCandidate(transaction, record.candidate));
    return {
      duplicate: result.replayed && result.promotionRange === null,
      materialChange: result.promotionRange !== null,
    };
  }
  const result = await canonical.insertMarketEvent(
    await marketEventCandidate(transaction, record.candidate),
  );
  return {
    duplicate: result.replayed && result.promotionRange === null,
    materialChange: result.promotionRange !== null,
  };
}

export function providerMixedRecordEntityKey(record: ProviderMixedPageRecord): string | null {
  const keys = record.kind === "pull" ? ["pullKey"]
    : record.kind === "market_event" ? ["eventKey"]
    : record.operation === "retire" ? ["id"]
    : ["categoryKey", "packKey", "collectibleKey", "instanceKey", "accountKey"];
  for (const key of keys) {
    const value = record.candidate[key];
    if (typeof value === "string" && value.length <= 512) return value;
  }
  return null;
}
