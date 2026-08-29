import { createHash } from "node:crypto";
import {
  PACKSCOUT_PUBLIC_IDENTITY_NAMESPACE,
  packscoutPublicIdentityUuid,
  provisionalCollectiblePublicId,
  provisionalCollectiblePublicIdentityName,
} from "@packscout/contracts";

export const PUBLIC_IDENTITY_NAMESPACE = PACKSCOUT_PUBLIC_IDENTITY_NAMESPACE;

export type GlobalCollectibleType =
  | "card"
  | "watch"
  | "art"
  | "coin"
  | "sealed_product"
  | "memorabilia"
  | "other";

export interface GlobalCollectiblePublicIdentity {
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
  readonly valuationUnavailableReason:
    | "VALUATION_UNAVAILABLE"
    | "CURRENCY_UNSUPPORTED"
    | null;
  readonly valuationType:
    | "market_estimate"
    | "vendor_reported"
    | "last_sale"
    | "appraisal"
    | null;
  readonly valuationObservedAt: Date | null;
  readonly dataAsOf: Date;
}

export interface DeterministicCollectibleEvidence {
  readonly providerId: string;
  readonly localCollectibleId: string;
  readonly localEntityVersion: bigint;
  readonly globalCollectibleId: string;
  readonly collectibleType: GlobalCollectibleType;
  readonly confidenceBasisPoints: number;
}

export interface CorrelateProviderCollectibleRequest {
  readonly providerId: string;
  readonly localCollectibleId: string;
  readonly localEntityVersion: bigint;
  readonly collectibleType: GlobalCollectibleType;
  readonly publicIdentity: GlobalCollectiblePublicIdentity;
  readonly deterministicEvidence: readonly DeterministicCollectibleEvidence[];
  readonly ruleVersion: string;
  readonly providerChangeSequence: bigint;
  readonly observedAt?: Date;
}

export type CorrelationRejectionCode =
  | "PROVIDER_NOT_FOUND"
  | "STALE_LOCAL_VERSION"
  | "MISSING_PROVISIONAL"
  | "GLOBAL_TARGET_NOT_FOUND"
  | "GLOBAL_TARGET_RETIRED"
  | "GLOBAL_TARGET_NOT_CANONICAL"
  | "GLOBAL_TYPE_INCOMPATIBLE"
  | "CROSS_PROVIDER_EVIDENCE"
  | "DETERMINISTIC_OUTCOME_CONFLICT"
  | "SOURCE_REPLAY_CONFLICT";

export type CorrelationSuccessOutcome =
  | "linked"
  | "provisional_created"
  | "suggested"
  | "unchanged";

export interface CorrelationSuccessResult {
  readonly outcome: CorrelationSuccessOutcome;
  readonly currentGlobalCollectibleId: string;
  readonly confirmedProviderSequence: bigint;
  readonly catalogEventSequence: bigint;
}

export interface CorrelationRejectedResult {
  readonly outcome: "rejected";
  readonly currentGlobalCollectibleId: string | null;
  readonly confirmedProviderSequence: null;
  readonly catalogEventSequence: bigint;
  readonly failureCode: CorrelationRejectionCode;
}

export type CorrelationResult =
  | CorrelationSuccessResult
  | CorrelationRejectedResult;

export interface NormalizedCollectibleIdentity {
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
  readonly valuationUnavailableReason:
    | "VALUATION_UNAVAILABLE"
    | "CURRENCY_UNSUPPORTED"
    | null;
  readonly valuationType:
    | "market_estimate"
    | "vendor_reported"
    | "last_sale"
    | "appraisal"
    | null;
  readonly valuationObservedAt: Date | null;
  readonly dataAsOf: Date;
}

export interface NormalizedCorrelationRequest {
  readonly providerId: string;
  readonly localCollectibleId: string;
  readonly localEntityVersion: bigint;
  readonly collectibleType: GlobalCollectibleType;
  readonly publicIdentity: NormalizedCollectibleIdentity;
  readonly deterministicEvidence: readonly DeterministicCollectibleEvidence[];
  readonly ruleVersion: string;
  readonly providerChangeSequence: bigint;
  readonly observedAt: Date;
}

export class GlobalCatalogInputError extends TypeError {
  readonly code = "GLOBAL_CATALOG_INPUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "GlobalCatalogInputError";
  }
}

export class GlobalCatalogConflictError extends Error {
  readonly code: "ALIAS_CONFLICT" | "ALIAS_CYCLE" | "CATALOG_WRITE_CONFLICT";

  constructor(
    code: GlobalCatalogConflictError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GlobalCatalogConflictError";
    this.code = code;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^(?:[A-Z0-9]{2,12}|0x[0-9A-Fa-f]{40})$/;
const DECIMAL_PATTERN = /^[0-9]+(?:\.([0-9]+))?$/;
const COLLECTIBLE_TYPES = new Set<GlobalCollectibleType>([
  "card",
  "watch",
  "art",
  "coin",
  "sealed_product",
  "memorabilia",
  "other",
]);
const VALUATION_UNAVAILABLE_REASONS = new Set([
  "VALUATION_UNAVAILABLE",
  "CURRENCY_UNSUPPORTED",
]);
const VALUATION_TYPES = new Set([
  "market_estimate",
  "vendor_reported",
  "last_sale",
  "appraisal",
]);
const MAX_EVIDENCE = 8;

export function requireCatalogUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new GlobalCatalogInputError(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function publicIdentityUuid(name: string): string {
  return packscoutPublicIdentityUuid(name);
}

export function provisionalCollectibleName(input: {
  readonly providerId: string;
  readonly localCollectibleId: string;
}): string {
  return provisionalCollectiblePublicIdentityName({
    providerId: requireCatalogUuid(input.providerId, "providerId"),
    localCollectibleId: requireCatalogUuid(
      input.localCollectibleId,
      "localCollectibleId",
    ),
  });
}

export function provisionalCollectibleId(input: {
  readonly providerId: string;
  readonly localCollectibleId: string;
}): string {
  return provisionalCollectiblePublicId({
    providerId: requireCatalogUuid(input.providerId, "providerId"),
    localCollectibleId: requireCatalogUuid(
      input.localCollectibleId,
      "localCollectibleId",
    ),
  });
}

function requireText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new GlobalCatalogInputError(`${field} must be text.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new GlobalCatalogInputError(`${field} is outside its text bounds.`);
  }
  return normalized;
}

function nullableText(
  value: string | null,
  field: string,
  maximumLength: number,
): string | null {
  return value === null ? null : requireText(value, field, maximumLength);
}

function normalizeDecimal(value: string | null, field: string): string | null {
  if (value === null) return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (!match || (match[1]?.length ?? 0) > 18) {
    throw new GlobalCatalogInputError(`${field} must be a bounded exact decimal.`);
  }
  const [integer = "0", fraction = ""] = value.split(".");
  const normalizedInteger = integer.replace(/^0+(?=[0-9])/, "");
  if (normalizedInteger.length > 20) {
    throw new GlobalCatalogInputError(`${field} exceeds its exact decimal bounds.`);
  }
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction.length > 0
    ? `${normalizedInteger}.${normalizedFraction}`
    : normalizedInteger;
}

function requireDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new GlobalCatalogInputError(`${field} must be a valid date.`);
  }
  return new Date(value.getTime());
}

export function normalizeGlobalCollectiblePublicIdentity(
  identity: GlobalCollectiblePublicIdentity,
): NormalizedCollectibleIdentity {
  const primaryImageUrl = identity.primaryImageUrl === null
    ? null
    : requireText(identity.primaryImageUrl, "primaryImageUrl", 2_048);
  if (primaryImageUrl !== null) {
    let parsed: URL;
    try {
      parsed = new URL(primaryImageUrl);
    } catch {
      throw new GlobalCatalogInputError("primaryImageUrl must be an HTTPS URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new GlobalCatalogInputError("primaryImageUrl must be an HTTPS URL.");
    }
    if (parsed.username !== "" || parsed.password !== "" || parsed.hostname === "") {
      throw new GlobalCatalogInputError("primaryImageUrl must not contain credentials.");
    }
  }
  const valuationAmount = normalizeDecimal(identity.valuationAmount, "valuationAmount");
  const valuationCurrency = identity.valuationCurrency;
  if ((valuationAmount === null) !== (valuationCurrency === null)) {
    throw new GlobalCatalogInputError("valuationAmount and valuationCurrency must be paired.");
  }
  if (valuationCurrency !== null && !CURRENCY_PATTERN.test(valuationCurrency)) {
    throw new GlobalCatalogInputError("valuationCurrency is invalid.");
  }
  if ((identity.primaryImageAlt === null) !== (primaryImageUrl === null)) {
    throw new GlobalCatalogInputError("primaryImageUrl and primaryImageAlt must be paired.");
  }
  if ((identity.valuationType === null) !== (identity.valuationObservedAt === null)) {
    throw new GlobalCatalogInputError("valuationType and valuationObservedAt must be paired.");
  }
  if (identity.valuationUnavailableReason !== null
      && !VALUATION_UNAVAILABLE_REASONS.has(identity.valuationUnavailableReason)) {
    throw new GlobalCatalogInputError("valuationUnavailableReason is invalid.");
  }
  if (identity.valuationType !== null && !VALUATION_TYPES.has(identity.valuationType)) {
    throw new GlobalCatalogInputError("valuationType is invalid.");
  }
  if (identity.year !== null && (
    !Number.isInteger(identity.year)
    || identity.year < 1_000
    || identity.year > 9_999
  )) {
    throw new GlobalCatalogInputError("year must be a four-digit integer or null.");
  }
  return {
    displayName: requireText(identity.displayName, "displayName", 240),
    normalizedName: requireText(identity.normalizedName, "normalizedName", 240),
    year: identity.year,
    brand: nullableText(identity.brand, "brand", 120),
    setOrSeries: nullableText(identity.setOrSeries, "setOrSeries", 200),
    cardNumber: nullableText(identity.cardNumber, "cardNumber", 100),
    referenceNumber: nullableText(identity.referenceNumber, "referenceNumber", 100),
    subject: nullableText(identity.subject, "subject", 200),
    grade: nullableText(identity.grade, "grade", 100),
    grader: nullableText(identity.grader, "grader", 100),
    primaryImageUrl,
    primaryImageAlt: nullableText(identity.primaryImageAlt, "primaryImageAlt", 200),
    valuationAmount,
    valuationCurrency,
    valuationUsdAmount: normalizeDecimal(identity.valuationUsdAmount, "valuationUsdAmount"),
    valuationUnavailableReason: identity.valuationUnavailableReason,
    valuationType: identity.valuationType,
    valuationObservedAt: identity.valuationObservedAt === null
      ? null
      : requireDate(identity.valuationObservedAt, "valuationObservedAt"),
    dataAsOf: requireDate(identity.dataAsOf, "dataAsOf"),
  };
}

function requirePositiveBigInt(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new GlobalCatalogInputError(`${field} must be a positive bigint.`);
  }
  return value;
}

function normalizeEvidence(
  request: CorrelateProviderCollectibleRequest,
): readonly DeterministicCollectibleEvidence[] {
  if (!Array.isArray(request.deterministicEvidence)
      || request.deterministicEvidence.length > MAX_EVIDENCE) {
    throw new GlobalCatalogInputError("deterministicEvidence exceeds its item bound.");
  }
  return request.deterministicEvidence.map((candidate) => {
    if (!COLLECTIBLE_TYPES.has(candidate.collectibleType)) {
      throw new GlobalCatalogInputError("Evidence collectible type is invalid.");
    }
    if (!Number.isInteger(candidate.confidenceBasisPoints)
        || candidate.confidenceBasisPoints < 0
        || candidate.confidenceBasisPoints > 10_000) {
      throw new GlobalCatalogInputError("Evidence confidence is invalid.");
    }
    return {
      providerId: requireCatalogUuid(candidate.providerId, "evidence.providerId"),
      localCollectibleId: requireCatalogUuid(
        candidate.localCollectibleId,
        "evidence.localCollectibleId",
      ),
      localEntityVersion: requirePositiveBigInt(
        candidate.localEntityVersion,
        "evidence.localEntityVersion",
      ),
      globalCollectibleId: requireCatalogUuid(
        candidate.globalCollectibleId,
        "evidence.globalCollectibleId",
      ),
      collectibleType: candidate.collectibleType,
      confidenceBasisPoints: candidate.confidenceBasisPoints,
    };
  }).sort((left, right) => (
    left.globalCollectibleId.localeCompare(right.globalCollectibleId)
    || left.providerId.localeCompare(right.providerId)
    || left.localCollectibleId.localeCompare(right.localCollectibleId)
    || (left.localEntityVersion < right.localEntityVersion ? -1 : (
      left.localEntityVersion > right.localEntityVersion ? 1 : 0
    ))
    || left.collectibleType.localeCompare(right.collectibleType)
    || left.confidenceBasisPoints - right.confidenceBasisPoints
  )).map((candidate) => ({
    ...candidate,
    providerId: candidate.providerId,
    localCollectibleId: candidate.localCollectibleId,
    localEntityVersion: candidate.localEntityVersion,
  }));
}

export function normalizeCorrelationRequest(
  request: CorrelateProviderCollectibleRequest,
): NormalizedCorrelationRequest {
  const providerId = requireCatalogUuid(request.providerId, "providerId");
  const localCollectibleId = requireCatalogUuid(
    request.localCollectibleId,
    "localCollectibleId",
  );
  const localEntityVersion = requirePositiveBigInt(
    request.localEntityVersion,
    "localEntityVersion",
  );
  if (!COLLECTIBLE_TYPES.has(request.collectibleType)) {
    throw new GlobalCatalogInputError("collectibleType is invalid.");
  }
  return {
    providerId,
    localCollectibleId,
    localEntityVersion,
    collectibleType: request.collectibleType,
    publicIdentity: normalizeGlobalCollectiblePublicIdentity(request.publicIdentity),
    deterministicEvidence: normalizeEvidence(request),
    ruleVersion: requireText(request.ruleVersion, "ruleVersion", 64),
    providerChangeSequence: requirePositiveBigInt(
      request.providerChangeSequence,
      "providerChangeSequence",
    ),
    observedAt: requireDate(request.observedAt ?? new Date(), "observedAt"),
  };
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function correlationRequestDigest(request: NormalizedCorrelationRequest): string {
  const replayIdentity = Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== "observedAt"),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(replayIdentity)))
    .digest("hex");
}

export function confidenceDecimal(basisPoints: number): string {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new GlobalCatalogInputError("Confidence basis points are invalid.");
  }
  const whole = Math.floor(basisPoints / 10_000);
  const fraction = String(basisPoints % 10_000).padStart(4, "0");
  return `${whole}.${fraction}`;
}

export interface AliasResolution {
  readonly canonicalCollectibleId: string;
  readonly path: readonly string[];
}

export function resolveAliasChain(
  collectibleId: string,
  aliases: ReadonlyMap<string, string>,
): AliasResolution {
  let current = requireCatalogUuid(collectibleId, "collectibleId");
  const path: string[] = [];
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) {
      throw new GlobalCatalogConflictError(
        "ALIAS_CYCLE",
        "Collectible alias resolution encountered a cycle.",
      );
    }
    visited.add(current);
    path.push(current);
    const next = aliases.get(current);
    if (next === undefined) {
      return { canonicalCollectibleId: current, path };
    }
    current = requireCatalogUuid(next, "alias target");
    if (path.length > 64) {
      throw new GlobalCatalogConflictError(
        "ALIAS_CYCLE",
        "Collectible alias resolution exceeded its maximum depth.",
      );
    }
  }
}
