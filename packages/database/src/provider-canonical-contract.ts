export type ExactDecimalString = string & {
  readonly __exactDecimalString: unique symbol;
};

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export type ProviderEntityLifecycle = "active" | "retired";
export type ProviderAvailability = "available" | "sold_out" | "unavailable";
export type ProviderEvidenceState = "complete" | "partial" | "unknown";
export type ProviderPackFormat = "repack" | "gacha";
export type ProviderCollectibleType =
  | "card"
  | "watch"
  | "art"
  | "coin"
  | "sealed_product"
  | "memorabilia"
  | "other";
export type ProviderContentRole =
  | "top_chase"
  | "featured_chase"
  | "possible_outcome"
  | "other";
export type ProviderMarketEventType =
  | "sale"
  | "buyback"
  | "mint"
  | "burn"
  | "transfer"
  | "list"
  | "unlist"
  | "swap"
  | "ship"
  | "other";

export type ProviderCanonicalEntityType =
  | "category"
  | "pack"
  | "collectible"
  | "collectible_name_alias"
  | "collectible_instance"
  | "pack_content"
  | "pack_content_snapshot"
  | "provider_account"
  | "pull"
  | "pull_item"
  | "market_event";

export interface CanonicalWriteResult {
  readonly id: string;
  readonly rowVersion: bigint;
  readonly materialChange: boolean;
  readonly promotionSequence: bigint | null;
}

export interface PromotionSequenceRange {
  readonly first: bigint;
  readonly last: bigint;
}

export interface CanonicalFactWriteResult {
  readonly id: string;
  readonly replayed: boolean;
  readonly promotionRange: PromotionSequenceRange | null;
}

export interface PullWriteResult extends CanonicalFactWriteResult {
  readonly itemIds: readonly string[];
}

export interface FactReferenceReconciliationResult {
  readonly pullPackCount: number;
  readonly pullItemCollectibleCount: number;
  readonly marketEventPackCount: number;
  readonly marketEventCollectibleCount: number;
  readonly materialChangeCount: number;
  readonly promotionRange: PromotionSequenceRange | null;
  readonly nextScanCursor: ProviderFactReferenceScanCursor | null;
}

export interface ProviderFactReferenceTargets {
  readonly packKeys: readonly string[];
  readonly collectibleKeys: readonly string[];
}

export interface ProviderFactReferenceScanCursor {
  readonly packs: Readonly<{ afterKey: string | null; done: boolean }>;
  readonly collectibles: Readonly<{ afterKey: string | null; done: boolean }>;
}

export interface ProviderFactReferenceScan {
  readonly targets?: ProviderFactReferenceTargets;
  readonly after?: ProviderFactReferenceScanCursor;
}

export interface MutableWriteControl {
  readonly expectedRowVersion?: bigint;
}

export interface CategoryWriteInput extends MutableWriteControl {
  readonly categoryKey: string;
  readonly parentCategoryId: string | null;
  readonly displayName: string;
}

export interface PackWriteInput extends MutableWriteControl {
  readonly packKey: string;
  readonly categoryId: string | null;
  readonly familyKey: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly packFormat: ProviderPackFormat;
  readonly availability: ProviderAvailability;
  readonly contentEvidence: ProviderEvidenceState;
  readonly totalInventory: bigint | null;
  readonly remainingInventory: bigint | null;
  readonly priceAmount: string | null;
  readonly priceCurrency: string | null;
  readonly priceUsdAmount: string | null;
  readonly priceUnavailableReason: string | null;
  readonly buybackRate: string | null;
  readonly buybackSourceKind: string | null;
  readonly vendorEvAmount: string | null;
  readonly vendorEvCurrency: string | null;
  readonly vendorEvObservedAt: Date | null;
  readonly vendorEvUnavailableReason: string | null;
  readonly packscoutEvAmount: string | null;
  readonly packscoutEvCurrency: string | null;
  readonly packscoutEvModelVersion: string;
  readonly packscoutEvConfidencePolicyVersion: string;
  readonly packscoutEvConfidence: CanonicalJsonObject | null;
  readonly packscoutEvDataAsOf: Date | null;
  readonly packscoutEvCalculatedAt: Date | null;
  readonly packscoutEvUnavailableReason: string | null;
  readonly primaryImageUrl: string | null;
  readonly primaryImageAlt: string | null;
  readonly listingUrl: string | null;
  readonly attributes: CanonicalJsonObject;
  readonly sourceUpdatedAt: Date;
}

export interface CollectibleWriteInput extends MutableWriteControl {
  readonly collectibleKey: string;
  readonly categoryId: string | null;
  readonly collectibleType: ProviderCollectibleType;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly year: number | null;
  readonly brand: string | null;
  readonly setOrSeries: string | null;
  readonly cardNumber: string | null;
  readonly referenceNumber: string | null;
  readonly subject: string | null;
  readonly grade: string | null;
  readonly grader: string | null;
  readonly primaryImageUrl: string | null;
  readonly primaryImageAlt: string | null;
  readonly valuationAmount: string | null;
  readonly valuationCurrency: string | null;
  readonly valuationUsdAmount: string | null;
  readonly valuationUnavailableReason: string | null;
  readonly valuationType: string | null;
  readonly valuationObservedAt: Date | null;
  readonly dataAsOf: Date;
  readonly attributes: CanonicalJsonObject;
}

export interface CollectibleNameAliasWriteInput extends MutableWriteControl {
  readonly collectibleId: string;
  readonly displayName: string;
  readonly normalizedName: string;
}

export interface CollectibleInstanceWriteInput extends MutableWriteControl {
  readonly collectibleId: string;
  readonly instanceKey: string;
  readonly certifier: string | null;
  readonly certificationNumber: string | null;
  readonly attributes: CanonicalJsonObject;
}

export interface PackContentWriteInput extends MutableWriteControl {
  /** Omission invalidates prior proof; only the snapshot reconciler supplies it. */
  readonly sourceSnapshotId?: string | null;
  readonly packId: string;
  readonly collectibleId: string;
  readonly collectibleInstanceId: string | null;
  readonly totalQuantity: bigint | null;
  readonly availableQuantity: bigint | null;
  readonly contentRole: ProviderContentRole;
  readonly probability: string | null;
  readonly statedValueAmount: string | null;
  readonly statedValueCurrency: string | null;
  readonly evidenceKinds: readonly string[];
  readonly matchConfidenceBasisPoints: number;
  readonly observedAt: Date;
  readonly displayOrder: number;
}

export interface ProviderAccountWriteInput extends MutableWriteControl {
  readonly accountKey: string;
  readonly displayName: string | null;
  readonly attributes: CanonicalJsonObject;
}

export interface PullItemWriteInput {
  readonly collectibleKey: string | null;
  readonly collectibleId: string | null;
  readonly collectibleInstanceId: string | null;
  readonly quantity: bigint;
  readonly statedValueAmount: string | null;
  readonly statedValueCurrency: string | null;
}

export interface PullWriteInput {
  readonly pullKey: string;
  readonly factDigest: string;
  readonly packKey: string | null;
  readonly packId: string | null;
  readonly providerAccountId: string | null;
  readonly occurredAt: Date;
  readonly paidAmount: string | null;
  readonly paidCurrency: string | null;
  readonly items: readonly PullItemWriteInput[];
}

export interface MarketEventWriteInput {
  readonly eventKey: string;
  readonly factDigest: string;
  readonly eventGroupId: string | null;
  readonly eventType: ProviderMarketEventType;
  readonly packKey: string | null;
  readonly packId: string | null;
  readonly collectibleKey: string | null;
  readonly collectibleId: string | null;
  readonly collectibleInstanceId: string | null;
  readonly fromProviderAccountId: string | null;
  readonly toProviderAccountId: string | null;
  readonly quantity: bigint | null;
  readonly occurredAt: Date;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly details: CanonicalJsonObject;
}

export interface RetireCanonicalEntityInput {
  readonly id: string;
  readonly expectedRowVersion?: bigint;
  readonly retiredAt?: Date;
}

export class ProviderCanonicalInputError extends TypeError {
  readonly code = "CANONICAL_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ProviderCanonicalInputError";
  }
}

export class ProviderCanonicalWriteConflictError extends Error {
  readonly code = "CANONICAL_WRITE_CONFLICT";

  constructor() {
    super("The provider canonical entity changed before this write committed.");
    this.name = "ProviderCanonicalWriteConflictError";
  }
}

export class ProviderCanonicalRetiredError extends Error {
  readonly code = "CANONICAL_ENTITY_RETIRED";

  constructor() {
    super("The provider canonical entity is retired and cannot be changed.");
    this.name = "ProviderCanonicalRetiredError";
  }
}

export class ProviderCanonicalImmutableFactConflictError extends Error {
  readonly code = "IMMUTABLE_FACT_CONFLICT";
  readonly factType: "pull" | "market_event";
  readonly stableKey: string;

  constructor(input: {
    readonly factType: "pull" | "market_event";
    readonly stableKey: string;
  }) {
    super(`The ${input.factType} stable key already identifies different immutable content.`);
    this.name = "ProviderCanonicalImmutableFactConflictError";
    this.factType = input.factType;
    this.stableKey = input.stableKey;
  }
}

const DECIMAL_PATTERN = /^[0-9]+(?:\.([0-9]+))?$/;
const CURRENCY_PATTERN = /^(?:[A-Z0-9]{2,12}|0x[0-9A-Fa-f]{40})$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ACCOUNT_KEY_PATTERN = /^[0-9a-f]{64}$/;
const EVIDENCE_KINDS = new Set([
  "historical_pull_inference",
  "name_only",
  "packscout_resolved",
  "vendor_featured_chase",
  "vendor_inventory",
  "vendor_odds",
]);
const JSON_BYTE_LIMIT = 65_536;

function normalizeDecimal(input: string, integerDigits: number, field: string): ExactDecimalString {
  if (typeof input !== "string") {
    throw new ProviderCanonicalInputError(`${field} must be an exact decimal string.`);
  }
  const match = DECIMAL_PATTERN.exec(input);
  if (!match) {
    throw new ProviderCanonicalInputError(`${field} must be a non-negative base-10 decimal string.`);
  }
  const [integerPart = "0", fractionPart = ""] = input.split(".");
  const normalizedInteger = integerPart.replace(/^0+(?=[0-9])/, "");
  const normalizedFraction = fractionPart.replace(/0+$/, "");
  if (normalizedInteger.length > integerDigits || fractionPart.length > 18) {
    throw new ProviderCanonicalInputError(`${field} exceeds its exact decimal bounds.`);
  }
  return (normalizedFraction.length > 0
    ? `${normalizedInteger}.${normalizedFraction}`
    : normalizedInteger) as ExactDecimalString;
}

export function normalizeMoneyDecimal(input: string, field = "amount"): ExactDecimalString {
  return normalizeDecimal(input, 20, field);
}

export function normalizeRateDecimal(input: string, field = "rate"): ExactDecimalString {
  const normalized = normalizeDecimal(input, 2, field);
  const [integerPart = "0", fractionPart = ""] = normalized.split(".");
  if (Number(integerPart) > 1 || (integerPart === "1" && /[1-9]/.test(fractionPart))) {
    throw new ProviderCanonicalInputError(`${field} must be between 0 and 1.`);
  }
  return normalized;
}

export function requireCurrency(input: string, field = "currency"): string {
  if (!CURRENCY_PATTERN.test(input)) {
    throw new ProviderCanonicalInputError(`${field} is not a supported exact currency code.`);
  }
  return input;
}

export function requireDigest(input: string, field = "factDigest"): string {
  if (!DIGEST_PATTERN.test(input)) {
    throw new ProviderCanonicalInputError(`${field} must be a lowercase SHA-256 digest.`);
  }
  return input;
}

export function requireAccountKey(input: string): string {
  if (!ACCOUNT_KEY_PATTERN.test(input)) {
    throw new ProviderCanonicalInputError(
      "accountKey must be a provider-scoped lowercase HMAC-SHA256 digest.",
    );
  }
  return input;
}

export function requireNonEmptyText(input: string, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ProviderCanonicalInputError(`${field} must not be empty.`);
  }
  return input.trim();
}

export function requireDate(input: Date, field: string): Date {
  if (!(input instanceof Date) || !Number.isFinite(input.getTime())) {
    throw new ProviderCanonicalInputError(`${field} must be a valid instant.`);
  }
  return input;
}

function canonicalizeJsonValue(value: CanonicalJsonValue, field: string): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProviderCanonicalInputError(`${field} contains a non-finite number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeJsonValue(item, `${field}[${index}]`));
  }
  if (typeof value !== "object") {
    throw new ProviderCanonicalInputError(`${field} contains an unsupported JSON value.`);
  }
  const object = value as CanonicalJsonObject;
  const result: Record<string, CanonicalJsonValue> = {};
  for (const key of Object.keys(object).sort()) {
    const item = object[key];
    if (item === undefined) {
      throw new ProviderCanonicalInputError(`${field}.${key} must not be undefined.`);
    }
    result[key] = canonicalizeJsonValue(item, `${field}.${key}`);
  }
  return result;
}

export function normalizeJsonObject(
  input: CanonicalJsonObject,
  field: string,
): CanonicalJsonObject {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new ProviderCanonicalInputError(`${field} must be a JSON object.`);
  }
  const normalized = canonicalizeJsonValue(input, field) as CanonicalJsonObject;
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > JSON_BYTE_LIMIT) {
    throw new ProviderCanonicalInputError(`${field} exceeds the canonical JSON byte limit.`);
  }
  return normalized;
}

export function normalizeEvidenceKinds(input: readonly string[]): readonly string[] {
  const result = [...new Set(input)].sort();
  if (result.length < 1 || result.length > 6 || result.some((kind) => !EVIDENCE_KINDS.has(kind))) {
    throw new ProviderCanonicalInputError("evidenceKinds contains an unsupported or unbounded value.");
  }
  return result;
}

export function confidenceBand(basisPoints: number): "low" | "medium" | "high" {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new ProviderCanonicalInputError(
      "matchConfidenceBasisPoints must be an integer between 0 and 10000.",
    );
  }
  if (basisPoints < 5_000) return "low";
  if (basisPoints < 8_000) return "medium";
  return "high";
}

export function requirePairedValues(
  left: unknown,
  right: unknown,
  field: string,
): void {
  if ((left === null) !== (right === null)) {
    throw new ProviderCanonicalInputError(`${field} value and companion must both be present or absent.`);
  }
}
