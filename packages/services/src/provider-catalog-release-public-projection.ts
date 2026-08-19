import {
  buildPublicCollectibleSearchText,
  canonicalJson,
  normalizePublicSearchText,
  parsedHttpsUrl,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  type ApprovedPublicCatalogConfigurationV1,
  type ApprovedPublicPlatformConfiguration,
  type PublicCategory,
  type PublicCollectible,
  type PublicCollectibleDisplay,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";
import type {
  CanonicalCatalogAssetProjectionContent,
  CanonicalEvInputReadinessReason,
  CanonicalEvInputProjectionContent,
  CanonicalPackProjectionContent,
} from "./catalog-projection-contracts.ts";
import { EV_INPUT_COVERAGE_TOLERANCE } from "./catalog-projection-contracts.ts";
import { calculatePackScoutEstimatedEv } from "./estimated-ev-calculator.ts";
import {
  estimatedEvCalculationFingerprint,
  type CanonicalEstimatedEvProjectionContent,
  type EstimatedEvInputManifest,
} from "./estimated-ev-projection-contracts.ts";
import { publicConfidenceLimitationsFromPipeline } from "./public-confidence-projection.ts";
import type {
  ProviderCatalogCanonicalRevisionSnapshot,
  ProviderGovernedPublicRepackIdentity,
} from "./provider-catalog-release-types.ts";

export type ProviderCatalogProjectionBlockReason =
  | "PUBLIC_IDENTITY_MAPPING_MISSING"
  | "CANONICAL_PROJECTION_INVALID"
  | "PUBLIC_REFERENCE_INVALID"
  | "PUBLIC_ORIGIN_UNAPPROVED"
  | "EXACT_VALUE_INVALID"
  | "PUBLIC_CONTRACT_INVALID";

export class ProviderCatalogProjectionAssemblyError extends Error {
  constructor(readonly reason: ProviderCatalogProjectionBlockReason) {
    super(reason);
    this.name = "ProviderCatalogProjectionAssemblyError";
  }
}

export interface ProviderCatalogPublicProjection {
  readonly vendors: readonly PublicVendor[];
  readonly categories: readonly PublicCategory[];
  readonly collectibles: readonly PublicCollectible[];
  readonly repacks: readonly PublicRepackDetail[];
  readonly repackChases: readonly PublicRepackChase[];
  readonly dataAsOf: Date;
}

type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

const PIPELINE_LIMITATIONS = new Set([
  "incomplete_inventory",
  "midpoint_value_ranges",
  "provider_supplied_probabilities",
  "verified_usd_stablecoin_at_parity",
]);

const ESTIMATED_EV_UNAVAILABLE_REASONS = new Set([
  "missing_pack_price",
  "invalid_pack_price",
  "unsupported_currency",
  "missing_probability_buckets",
  "missing_probability",
  "invalid_probability",
  "incomplete_probability_coverage",
  "incomplete_inventory",
  "missing_value_bound",
  "open_ended_value_range",
  "invalid_value_bound",
  "invalid_value_range",
  "ambiguous_unit_basis",
  "invalid_draw_count",
  "missing_source_evidence",
  "missing_source_time",
  "invalid_source_time",
  "calculation_overflow",
]);

const EV_INPUT_READINESS_REASON_ORDER:
  readonly CanonicalEvInputReadinessReason[] = [
    "missing_probability_buckets",
    "missing_probability",
    "invalid_probability",
    "incomplete_probability_coverage",
    "missing_value_bound",
    "invalid_value_bound",
    "invalid_value_range",
    "invalid_currency",
    "missing_unit_basis",
    "invalid_draw_count",
    "incomplete_inventory",
    "declared_coverage_mismatch",
  ];

const key = (platformKey: string, externalId: string) =>
  `${platformKey}\u0000${externalId}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function compareProviderCatalogCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: ProviderCatalogProjectionBlockReason = "CANONICAL_PROJECTION_INVALID",
): never {
  throw new ProviderCatalogProjectionAssemblyError(reason);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value);
}

function isNullableNonNegativeSafeInteger(
  value: unknown,
): value is number | null {
  return value === null ||
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function packContent(value: unknown): CanonicalPackProjectionContent {
  if (
    !isObject(value) ||
    value.schemaVersion !== "catalog-projection-v1" ||
    value.entityType !== "pack" ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    !isNullableString(value.category) ||
    !isNullableString(value.description) ||
    !["active", "disabled", "sold_out", "unknown"].includes(String(value.availability)) ||
    !isNullableNonNegativeSafeInteger(value.priceValueMinor) ||
    !isNullableString(value.priceCurrency) ||
    !isNullableNonNegativeSafeInteger(value.providerReportedEvValueMinor) ||
    !isNullableString(value.providerReportedEvCurrency) ||
    !isNullableFiniteNumber(value.buybackPercent) ||
    !isStringArray(value.imageUrls)
  ) invalid();
  return value as unknown as CanonicalPackProjectionContent;
}

function assetContent(value: unknown): CanonicalCatalogAssetProjectionContent {
  if (
    !isObject(value) ||
    value.schemaVersion !== "catalog-projection-v1" ||
    value.entityType !== "catalog_asset" ||
    !isNullableString(value.relatedPackExternalId) ||
    !isNullableString(value.name) ||
    !isNullableString(value.category) ||
    !["active", "disabled", "sold_out", "unknown"].includes(String(value.availability)) ||
    !isNullableNonNegativeSafeInteger(value.providerValueMinor) ||
    !isNullableString(value.providerValueCurrency) ||
    !isNullableString(value.valueSource) ||
    !isStringArray(value.imageUrls)
  ) invalid();
  return value as unknown as CanonicalCatalogAssetProjectionContent;
}

function evInputContent(value: unknown): CanonicalEvInputProjectionContent {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "entityType",
      "packExternalId",
      "currency",
      "unitBasis",
      "drawCount",
      "evidenceCompleteness",
      "coverage",
      "probabilityBuckets",
      "topChases",
      "readiness",
      "dataQualityEvidence",
    ]) ||
    value.schemaVersion !== "catalog-projection-v1" ||
    value.entityType !== "ev_input" ||
    typeof value.packExternalId !== "string" ||
    value.packExternalId.length === 0 ||
    value.packExternalId.length > 256 ||
    (value.currency !== null &&
      (typeof value.currency !== "string" ||
        !/^[A-Z0-9]{2,12}$/u.test(value.currency))) ||
    ![null, "per_draw", "per_pack"].includes(value.unitBasis as null | string) ||
    !(value.drawCount === null ||
      typeof value.drawCount === "number" &&
      Number.isSafeInteger(value.drawCount) && value.drawCount > 0) ||
    !["complete", "partial", "unknown"].includes(String(value.evidenceCompleteness)) ||
    !isObject(value.coverage) ||
    !hasExactKeys(value.coverage, [
      "declaredCoverage",
      "calculatedCoverage",
      "tolerance",
      "probabilityBucketCount",
      "topChaseCount",
    ]) ||
    !isNullableFiniteNumber(value.coverage.declaredCoverage) ||
    typeof value.coverage.calculatedCoverage !== "number" ||
    !Number.isFinite(value.coverage.calculatedCoverage) ||
    value.coverage.tolerance !== EV_INPUT_COVERAGE_TOLERANCE ||
    typeof value.coverage.probabilityBucketCount !== "number" ||
    !Number.isSafeInteger(value.coverage.probabilityBucketCount) ||
    value.coverage.probabilityBucketCount < 0 ||
    typeof value.coverage.topChaseCount !== "number" ||
    !Number.isSafeInteger(value.coverage.topChaseCount) ||
    value.coverage.topChaseCount < 0 ||
    !Array.isArray(value.probabilityBuckets) ||
    !Array.isArray(value.topChases) ||
    !isObject(value.readiness) ||
    !hasExactKeys(value.readiness, ["status", "reasons"]) ||
    !["ready", "unavailable"].includes(String(value.readiness.status)) ||
    !Array.isArray(value.readiness.reasons) ||
    !Array.isArray(value.dataQualityEvidence)
  ) invalid();
  if (
    value.coverage.declaredCoverage !== null &&
      (value.coverage.declaredCoverage < 0 ||
        value.coverage.declaredCoverage > 1) ||
    value.coverage.calculatedCoverage < 0 ||
    value.coverage.calculatedCoverage > 1
  ) invalid("EXACT_VALUE_INVALID");

  for (const evidence of value.dataQualityEvidence) {
    if (
      !isObject(evidence) ||
      !hasExactKeys(evidence, ["code", "severity", "fieldPath"]) ||
      typeof evidence.code !== "string" ||
      evidence.code.length === 0 ||
      evidence.code.length > 128 ||
      !["info", "warning"].includes(String(evidence.severity)) ||
      !isNullableString(evidence.fieldPath)
    ) invalid();
  }

  const bucketIds = new Set<string>();
  for (const bucket of [...value.probabilityBuckets, ...value.topChases]) {
    if (
      !isObject(bucket) ||
      !hasExactKeys(bucket, [
        "bucketId",
        "label",
        "probability",
        "lowerValueMinor",
        "upperValueMinor",
      ]) ||
      typeof bucket.bucketId !== "string" ||
      bucket.bucketId.length === 0 ||
      bucket.bucketId.length > 256 ||
      !isNullableString(bucket.label) ||
      !isNullableFiniteNumber(bucket.probability) ||
      !isNullableNonNegativeSafeInteger(bucket.lowerValueMinor) ||
      !isNullableNonNegativeSafeInteger(bucket.upperValueMinor) ||
      bucketIds.has(bucket.bucketId)
    ) invalid();
    if (
      bucket.probability !== null &&
      (bucket.probability < 0 || bucket.probability > 1)
    ) invalid("EXACT_VALUE_INVALID");
    bucketIds.add(bucket.bucketId);
  }

  if (
    value.coverage.probabilityBucketCount !== value.probabilityBuckets.length ||
    value.coverage.topChaseCount !== value.topChases.length
  ) invalid();
  const calculatedCoverage = Number(
    value.probabilityBuckets.reduce(
      (total, bucket) =>
        total + ((bucket as Record<string, unknown>).probability as number | null ?? 0),
      0,
    ).toFixed(12),
  );
  if (calculatedCoverage !== value.coverage.calculatedCoverage) invalid();

  const reasons = value.readiness.reasons;
  if (
    !reasons.every(
      (reason) => typeof reason === "string" &&
        EV_INPUT_READINESS_REASON_ORDER.includes(
          reason as CanonicalEvInputReadinessReason,
        ),
    ) ||
    new Set(reasons).size !== reasons.length ||
    reasons.some((reason, index) =>
      EV_INPUT_READINESS_REASON_ORDER.indexOf(
        reason as CanonicalEvInputReadinessReason,
      ) <= (index === 0
        ? -1
        : EV_INPUT_READINESS_REASON_ORDER.indexOf(
            reasons[index - 1] as CanonicalEvInputReadinessReason,
          ))) ||
    value.readiness.status !== (reasons.length === 0 ? "ready" : "unavailable")
  ) invalid();
  const reasonSet = new Set(reasons);
  const requireReason = (
    reason: CanonicalEvInputReadinessReason,
    required: boolean,
  ): void => {
    if (reasonSet.has(reason) !== required) invalid();
  };
  requireReason(
    "missing_probability_buckets",
    value.probabilityBuckets.length === 0,
  );
  requireReason(
    "incomplete_probability_coverage",
    Math.abs(calculatedCoverage - 1) > EV_INPUT_COVERAGE_TOLERANCE,
  );
  requireReason(
    "declared_coverage_mismatch",
    value.coverage.declaredCoverage !== null &&
      Math.abs(value.coverage.declaredCoverage - calculatedCoverage) >
        EV_INPUT_COVERAGE_TOLERANCE,
  );
  requireReason("invalid_currency", value.currency === null);
  requireReason("missing_unit_basis", value.unitBasis === null);
  requireReason("invalid_draw_count", value.drawCount === null);
  requireReason("incomplete_inventory", value.evidenceCompleteness !== "complete");
  const probabilityBuckets = value.probabilityBuckets as Array<{
    probability: number | null;
    lowerValueMinor: number | null;
    upperValueMinor: number | null;
  }>;
  const hasNullProbability = probabilityBuckets.some(
    ({ probability }) => probability === null,
  );
  if (
    hasNullProbability !==
      (reasonSet.has("missing_probability") ||
        reasonSet.has("invalid_probability")) ||
    !hasNullProbability &&
      (reasonSet.has("missing_probability") ||
        reasonSet.has("invalid_probability"))
  ) invalid();
  const hasNullBound = probabilityBuckets.some(
    ({ lowerValueMinor, upperValueMinor }) =>
      lowerValueMinor === null || upperValueMinor === null,
  );
  if (
    hasNullBound && value.currency !== null &&
      !reasonSet.has("missing_value_bound") &&
      !reasonSet.has("invalid_value_bound") ||
    !hasNullBound &&
      (reasonSet.has("missing_value_bound") ||
        reasonSet.has("invalid_value_bound"))
  ) invalid();
  requireReason(
    "invalid_value_range",
    probabilityBuckets.some(({ lowerValueMinor, upperValueMinor }) =>
      lowerValueMinor !== null && upperValueMinor !== null &&
      lowerValueMinor > upperValueMinor),
  );
  return value as unknown as CanonicalEvInputProjectionContent;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareProviderCatalogCodeUnits);
  const canonicalExpected = [...expected].sort(compareProviderCatalogCodeUnits);
  return actual.length === canonicalExpected.length &&
    actual.every((entry, index) => entry === canonicalExpected[index]);
}

function nullableToken(value: unknown, maximumLength = 256): value is string | null {
  return value === null || typeof value === "string" &&
    value.length > 0 && value.length <= maximumLength && value.trim() === value;
}

function estimatedInputManifest(value: unknown): EstimatedEvInputManifest {
  const manifestKeys = [
    "packRevisionId",
    "evInputRevisionId",
    "packPriceValueMinor",
    "packPriceCurrency",
    "distributionCurrency",
    "unitBasis",
    "drawCount",
    "declaredCoverage",
    "evidenceCompleteness",
    "buckets",
    "sourceAt",
    "verifiedUsdStablecoins",
  ] as const;
  if (
    !isObject(value) ||
    !hasExactKeys(value, manifestKeys) ||
    !nullableToken(value.packRevisionId) ||
    !nullableToken(value.evInputRevisionId) ||
    !isNullableNonNegativeSafeInteger(value.packPriceValueMinor) ||
    !nullableToken(value.packPriceCurrency, 12) ||
    !nullableToken(value.distributionCurrency, 12) ||
    ![null, "per_draw", "per_pack"].includes(value.unitBasis as null | string) ||
    !isNullableNonNegativeSafeInteger(value.drawCount) ||
    !isNullableFiniteNumber(value.declaredCoverage) ||
    !["complete", "partial", "unknown"].includes(
      String(value.evidenceCompleteness),
    ) ||
    !Array.isArray(value.buckets) ||
    value.buckets.length > 100_000 ||
    !Array.isArray(value.verifiedUsdStablecoins) ||
    !value.verifiedUsdStablecoins.every(
      (currency) => nullableToken(currency, 12) && currency !== null,
    ) ||
    new Set(value.verifiedUsdStablecoins).size !==
      value.verifiedUsdStablecoins.length ||
    !isNullableString(value.sourceAt)
  ) invalid();
  if (value.sourceAt !== null) canonicalTimestamp(value.sourceAt);
  const bucketIds = new Set<string>();
  for (const candidate of value.buckets) {
    if (
      !isObject(candidate) ||
      !hasExactKeys(candidate, [
        "bucketId",
        "probability",
        "lowerValueMinor",
        "upperValueMinor",
        "sourceRevisionId",
      ]) ||
      !nullableToken(candidate.bucketId) ||
      candidate.bucketId === null ||
      bucketIds.has(candidate.bucketId) ||
      !isNullableFiniteNumber(candidate.probability) ||
      !isNullableNonNegativeSafeInteger(candidate.lowerValueMinor) ||
      !isNullableNonNegativeSafeInteger(candidate.upperValueMinor) ||
      !nullableToken(candidate.sourceRevisionId) ||
      candidate.sourceRevisionId === null
    ) invalid();
    bucketIds.add(candidate.bucketId);
  }
  return value as unknown as EstimatedEvInputManifest;
}

function estimatedContent(
  value: unknown,
  verifiedUsdStablecoins: readonly string[],
): CanonicalEstimatedEvProjectionContent {
  const estimatedValuesAreValid = isObject(value) && value.status === "estimated" &&
    typeof value.grossValueMinor === "number" &&
    Number.isSafeInteger(value.grossValueMinor) &&
    value.grossValueMinor >= 0 &&
    typeof value.evPercent === "number" &&
    Number.isFinite(value.evPercent) &&
    value.currency === "USD" &&
    typeof value.sourceAt === "string" &&
    Array.isArray(value.reasonCodes) && value.reasonCodes.length === 0;
  const unavailableValuesAreValid = isObject(value) &&
    value.status === "unavailable" &&
    value.grossValueMinor === null &&
    value.evPercent === null &&
    value.currency === null &&
    Array.isArray(value.reasonCodes) && value.reasonCodes.length > 0;
  if (
    !isObject(value) ||
    value.schemaVersion !== "packscout-estimated-ev-projection-v1" ||
    value.label !== "PackScout Estimated EV" ||
    typeof value.calculationFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.calculationFingerprint) ||
    (value.status !== "estimated" && value.status !== "unavailable") ||
    !isNullableNonNegativeSafeInteger(value.grossValueMinor) ||
    !isNullableFiniteNumber(value.evPercent) ||
    (value.currency !== "USD" && value.currency !== null) ||
    value.method !== "probability_bucket_midpoint" ||
    value.methodVersion !== "packscout-estimated-ev-v1" ||
    typeof value.coveragePercent !== "number" ||
    !Number.isFinite(value.coveragePercent) ||
    value.coveragePercent < 0 ||
    value.coveragePercent > 100 ||
    typeof value.inputCount !== "number" ||
    !Number.isSafeInteger(value.inputCount) ||
    value.inputCount < 0 ||
    !isNullableString(value.sourceAt) ||
    typeof value.calculatedAt !== "string" ||
    !isObject(value.evidence) ||
    !Array.isArray(value.evidence.limitations) ||
    !value.evidence.limitations.every(
      (limitation) => typeof limitation === "string" && PIPELINE_LIMITATIONS.has(limitation),
    ) ||
    !Array.isArray(value.reasonCodes) ||
    !value.reasonCodes.every(
      (reason) => typeof reason === "string" &&
        ESTIMATED_EV_UNAVAILABLE_REASONS.has(reason),
    ) ||
    (!estimatedValuesAreValid && !unavailableValuesAreValid)
  ) invalid();
  canonicalTimestamp(value.calculatedAt);
  if (value.sourceAt !== null) canonicalTimestamp(value.sourceAt);
  const manifest = estimatedInputManifest(value.inputManifest);
  if (
    canonicalJson(manifest.verifiedUsdStablecoins) !==
      canonicalJson(verifiedUsdStablecoins) ||
    estimatedEvCalculationFingerprint(manifest) !==
      value.calculationFingerprint
  ) invalid();
  const recalculated = calculatePackScoutEstimatedEv({
    packPrice: manifest.packRevisionId === null
      ? null
      : {
          valueMinor: manifest.packPriceValueMinor,
          currency: manifest.packPriceCurrency,
          sourceRevisionId: manifest.packRevisionId,
        },
    distributionCurrency: manifest.distributionCurrency,
    unitBasis: manifest.unitBasis,
    drawCount: manifest.drawCount,
    declaredCoverage: manifest.declaredCoverage,
    evidenceCompleteness: manifest.evidenceCompleteness,
    buckets: manifest.buckets,
    sourceAt: manifest.sourceAt,
    calculatedAt: value.calculatedAt,
    currencyPolicy: {
      verifiedUsdStablecoins,
    },
  });
  const persistedResult = {
    method: value.method,
    methodVersion: value.methodVersion,
    coveragePercent: value.coveragePercent,
    inputCount: value.inputCount,
    sourceAt: value.sourceAt,
    calculatedAt: value.calculatedAt,
    evidence: value.evidence,
    status: value.status,
    grossValueMinor: value.grossValueMinor,
    evPercent: value.evPercent,
    currency: value.currency,
    reasonCodes: value.reasonCodes,
  };
  if (canonicalJson(persistedResult) !== canonicalJson(recalculated)) invalid();
  return value as unknown as CanonicalEstimatedEvProjectionContent;
}

function assertEstimateDependencies(input: Readonly<{
  packRevision: ProviderCatalogCanonicalRevisionSnapshot;
  pack: CanonicalPackProjectionContent;
  evInputEntry: Readonly<{
    revision: ProviderCatalogCanonicalRevisionSnapshot;
    content: CanonicalEvInputProjectionContent;
  }> | null;
  estimate: CanonicalEstimatedEvProjectionContent;
  verifiedUsdStablecoins: readonly string[];
}>): void {
  const manifest = input.estimate.inputManifest;
  const evInput = input.evInputEntry?.content ?? null;
  const expected = {
    packRevisionId: input.packRevision.revisionId,
    evInputRevisionId: input.evInputEntry?.revision.revisionId ?? null,
    packPriceValueMinor: input.pack.priceValueMinor,
    packPriceCurrency: input.pack.priceCurrency,
    distributionCurrency: evInput?.currency ?? null,
    unitBasis: evInput?.unitBasis ?? null,
    drawCount: evInput?.drawCount ?? null,
    declaredCoverage: evInput?.coverage.declaredCoverage ?? null,
    evidenceCompleteness: evInput?.evidenceCompleteness ?? "unknown",
    buckets: evInput?.probabilityBuckets.map((bucket) => ({
      bucketId: bucket.bucketId,
      probability: bucket.probability,
      lowerValueMinor: bucket.lowerValueMinor,
      upperValueMinor: bucket.upperValueMinor,
      sourceRevisionId: input.evInputEntry!.revision.revisionId,
    })) ?? [],
    sourceAt: new Date(Math.max(
      input.packRevision.sourceUpdatedAt.getTime(),
      input.evInputEntry?.revision.sourceUpdatedAt.getTime() ??
        Number.NEGATIVE_INFINITY,
    )).toISOString(),
    verifiedUsdStablecoins: input.verifiedUsdStablecoins,
  };
  const actual = {
    packRevisionId: manifest.packRevisionId,
    evInputRevisionId: manifest.evInputRevisionId,
    packPriceValueMinor: manifest.packPriceValueMinor,
    packPriceCurrency: manifest.packPriceCurrency,
    distributionCurrency: manifest.distributionCurrency,
    unitBasis: manifest.unitBasis,
    drawCount: manifest.drawCount,
    declaredCoverage: manifest.declaredCoverage,
    evidenceCompleteness: manifest.evidenceCompleteness,
    buckets: manifest.buckets,
    sourceAt: manifest.sourceAt,
    verifiedUsdStablecoins: manifest.verifiedUsdStablecoins,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) invalid();
}

function safeMinor(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid();
  return new Date(value.getTime());
}

function iso(value: Date): string {
  return finiteDate(value).toISOString();
}

function canonicalTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return value;
}

function approvedImage(
  urls: readonly string[],
  origins: ReadonlySet<string>,
  alt: string,
) {
  for (const candidate of urls) {
    const parsed = parsedHttpsUrl(candidate);
    if (parsed === null || !origins.has(parsed.origin)) {
      invalid("PUBLIC_ORIGIN_UNAPPROVED");
    }
  }
  const url = urls[0];
  return url === undefined ? null : { url, alt };
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 400) {
    invalid("EXACT_VALUE_INVALID");
  }
  return 10n ** BigInt(exponent);
}

/** Converts the canonical JavaScript decimal rendering into an exact rational. */
export function providerCatalogNumberAsRational(value: number): Rational {
  if (!Number.isFinite(value)) invalid("EXACT_VALUE_INVALID");
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(text);
  if (match === null) invalid("EXACT_VALUE_INVALID");
  const negative = match[1] === "-";
  const integral = match[2]!;
  const fractional = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) invalid("EXACT_VALUE_INVALID");
  let numerator = BigInt(`${integral}${fractional}`);
  let denominator = powerOfTen(fractional.length);
  if (exponent >= 0) numerator *= powerOfTen(exponent);
  else denominator *= powerOfTen(-exponent);
  return {
    numerator: negative ? -numerator : numerator,
    denominator,
  };
}

function roundedNonNegativeRationalToSafeInteger(
  rational: Rational,
  multiplier: bigint,
): number {
  if (rational.numerator < 0n || rational.denominator <= 0n || multiplier < 0n) {
    invalid("EXACT_VALUE_INVALID");
  }
  const scaled = rational.numerator * multiplier;
  const quotient = scaled / rational.denominator;
  const remainder = scaled % rational.denominator;
  const rounded = remainder * 2n >= rational.denominator ? quotient + 1n : quotient;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) invalid("EXACT_VALUE_INVALID");
  return Number(rounded);
}

function exactBasisPoints(value: number, scale: bigint): number {
  return roundedNonNegativeRationalToSafeInteger(
    providerCatalogNumberAsRational(value),
    scale,
  );
}

function isUsdComparableCurrency(
  currency: string | null,
  verifiedUsdStablecoins: readonly string[],
): boolean {
  return currency === "USD" ||
    currency !== null && verifiedUsdStablecoins.includes(currency);
}

function publicPrice(
  content: CanonicalPackProjectionContent,
  verifiedUsdStablecoins: readonly string[],
) {
  const minor = safeMinor(content.priceValueMinor);
  const currency = typeof content.priceCurrency === "string" &&
      /^[A-Z]{3}$/u.test(content.priceCurrency)
    ? content.priceCurrency
    : null;
  const displayMoney = minor === null || currency === null
    ? null : { minorUnits: minor, currency };
  return {
    displayMoney,
    usdComparison: minor !== null &&
        isUsdComparableCurrency(content.priceCurrency, verifiedUsdStablecoins)
      ? {
          status: "available" as const,
          value: { minorUnits: minor, currency: "USD" as const },
        }
      : {
          status: "unavailable" as const,
          value: null,
          reason: minor === null
            ? "PRICE_UNAVAILABLE" as const
            : "CURRENCY_UNSUPPORTED" as const,
        },
  };
}

function exactEvMetrics(grossMinor: number, priceMinor: number) {
  if (priceMinor === 0) return null;
  const grossReturn = (BigInt(grossMinor) * 10_000n + BigInt(priceMinor) / 2n) /
    BigInt(priceMinor);
  const dollars = BigInt(grossMinor) - BigInt(priceMinor);
  const percent = grossReturn - 10_000n;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  if (
    grossReturn > maximum ||
    dollars > maximum ||
    dollars < minimum ||
    percent > maximum ||
    percent < minimum
  ) invalid("EXACT_VALUE_INVALID");
  return {
    grossEv: { minorUnits: grossMinor, currency: "USD" as const },
    grossReturnBasisPoints: Number(grossReturn),
    evDollars: { minorUnits: Number(dollars), currency: "USD" as const },
    evPercentBasisPoints: Number(percent),
  };
}

function vendorReportedEv(
  content: CanonicalPackProjectionContent,
  sourceUpdatedAt: Date,
  verifiedUsdStablecoins: readonly string[],
) {
  const gross = safeMinor(content.providerReportedEvValueMinor);
  const currency = typeof content.providerReportedEvCurrency === "string" &&
      /^[A-Z0-9]{2,12}$/u.test(content.providerReportedEvCurrency)
    ? content.providerReportedEvCurrency
    : null;
  const price = safeMinor(content.priceValueMinor);
  const comparable = gross !== null &&
    isUsdComparableCurrency(currency, verifiedUsdStablecoins) &&
    isUsdComparableCurrency(
      content.priceCurrency,
      verifiedUsdStablecoins,
    ) && price !== null;
  const metrics = comparable ? exactEvMetrics(gross, price) : null;
  if (metrics !== null && currency !== null) {
    return {
      status: "available" as const,
      displayMoney: {
        minorUnits: metrics.grossEv.minorUnits,
        currency,
      },
      metrics,
      observedAt: iso(sourceUpdatedAt),
    };
  }
  const displayMoney = gross !== null && currency !== null
    ? { minorUnits: gross, currency }
    : null;
  return {
    status: "unavailable" as const,
    displayMoney,
    metrics: null,
    observedAt: gross === null ? null : iso(sourceUpdatedAt),
    reason: gross === null
      ? "NOT_REPORTED" as const
      : price === null || price === 0
        ? "PRICE_UNAVAILABLE" as const
        : "CURRENCY_UNSUPPORTED" as const,
  };
}

function confidence(input: {
  policy: ApprovedPublicCatalogConfigurationV1["confidencePolicy"];
  evInput: CanonicalEvInputProjectionContent | null;
  estimate: CanonicalEstimatedEvProjectionContent;
}) {
  const completeness = input.evInput?.evidenceCompleteness ?? "unknown";
  const base = completeness === "complete"
    ? input.policy.completeScoreBasisPoints
    : completeness === "partial"
      ? input.policy.partialScoreBasisPoints
      : input.policy.unknownScoreBasisPoints;
  const limitationCodes = [
    ...publicConfidenceLimitationsFromPipeline(input.estimate.evidence.limitations),
    ...(input.estimate.coveragePercent < 100
      ? ["partial_probability_coverage" as const]
      : []),
  ].sort(compareProviderCatalogCodeUnits);
  const scoreBasisPoints = Math.max(
    0,
    base - limitationCodes.length * input.policy.limitationPenaltyBasisPoints,
  );
  return {
    scoreBasisPoints,
    band: scoreBasisPoints < 5_000
      ? "low" as const
      : scoreBasisPoints < 8_000
        ? "medium" as const
        : "high" as const,
    limitationCodes,
  };
}

function packScoutEv(input: {
  estimate: CanonicalEstimatedEvProjectionContent | null;
  evInput: CanonicalEvInputProjectionContent | null;
  pack: CanonicalPackProjectionContent;
  policy: ApprovedPublicCatalogConfigurationV1["confidencePolicy"];
  verifiedUsdStablecoins: readonly string[];
}) {
  const estimate = input.estimate;
  const price = safeMinor(input.pack.priceValueMinor);
  const gross = estimate === null ? null : safeMinor(estimate.grossValueMinor);
  if (
    estimate?.status === "estimated" &&
    gross !== null &&
    price !== null &&
    isUsdComparableCurrency(
      input.pack.priceCurrency,
      input.verifiedUsdStablecoins,
    )
  ) {
    const metrics = exactEvMetrics(gross, price);
    if (metrics !== null) {
      return {
        status: "available" as const,
        metrics,
        confidence: confidence({
          policy: input.policy,
          evInput: input.evInput,
          estimate,
        }),
        modelVersion: estimate.methodVersion,
        confidencePolicyVersion: input.policy.version,
        dataAsOf: canonicalTimestamp(estimate.sourceAt ?? estimate.calculatedAt),
        calculatedAt: canonicalTimestamp(estimate.calculatedAt),
      };
    }
  }
  const currencyUnsupported = input.pack.priceValueMinor !== null &&
      !isUsdComparableCurrency(
        input.pack.priceCurrency,
        input.verifiedUsdStablecoins,
      ) ||
    estimate?.reasonCodes.includes("unsupported_currency") === true;
  return {
    status: "unavailable" as const,
    metrics: null,
    confidence: null,
    modelVersion: estimate?.methodVersion ?? "packscout-estimated-ev-v1",
    confidencePolicyVersion: input.policy.version,
    dataAsOf: estimate?.sourceAt === null || estimate?.sourceAt === undefined
      ? null
      : canonicalTimestamp(estimate.sourceAt),
    calculatedAt: estimate === null
      ? null
      : canonicalTimestamp(estimate.calculatedAt),
    reason: currencyUnsupported
      ? "CURRENCY_UNSUPPORTED" as const
      : price === null || price === 0
        ? "PRICE_UNAVAILABLE" as const
        : "ESTIMATE_INPUT_INCOMPLETE" as const,
  };
}

function categoryIdsFor(
  platform: ApprovedPublicPlatformConfiguration,
  sourceCategory: string | null,
): readonly string[] {
  return platform.categoryMappings.find(({ sourceValue }) => sourceValue === sourceCategory)
    ?.publicCategoryIds ?? platform.defaultPublicCategoryIds;
}

function collectibleDisplay(value: PublicCollectible): PublicCollectibleDisplay {
  return {
    publicCollectibleId: value.publicCollectibleId,
    name: value.name,
    collectibleType: value.collectibleType,
    publicCategoryIds: value.publicCategoryIds,
    primaryImage: value.primaryImage,
    valuation: value.valuation,
  };
}

function relevantCategoryClosure(
  categories: readonly PublicCategory[],
  referencedIds: ReadonlySet<string>,
): readonly PublicCategory[] {
  const categoryById = new Map(categories.map((category) => [
    category.publicCategoryId,
    category,
  ]));
  if (categoryById.size !== categories.length) invalid("PUBLIC_REFERENCE_INVALID");
  const included = new Set<string>();
  const categoryKeys = new Set<string>();
  for (const referencedId of referencedIds) {
    const category = categoryById.get(referencedId);
    if (category === undefined) invalid("PUBLIC_REFERENCE_INVALID");
    for (const [pathIndex, pathId] of category.pathPublicCategoryIds.entries()) {
      const pathCategory = categoryById.get(pathId);
      if (
        pathCategory === undefined ||
        pathCategory.depth !== pathIndex ||
        pathCategory.pathPublicCategoryIds.length !== pathIndex + 1 ||
        pathCategory.pathPublicCategoryIds.some(
          (candidate, index) =>
            candidate !== category.pathPublicCategoryIds[index],
        )
      ) invalid("PUBLIC_REFERENCE_INVALID");
      included.add(pathId);
    }
  }
  const result = categories.filter(({ publicCategoryId }) => included.has(publicCategoryId))
    .sort((left, right) => left.depth - right.depth ||
      compareProviderCatalogCodeUnits(left.publicCategoryId, right.publicCategoryId));
  for (const category of result) {
    if (categoryKeys.has(category.categoryKey)) invalid("PUBLIC_REFERENCE_INVALID");
    categoryKeys.add(category.categoryKey);
  }
  return result;
}

function validatePublicProjection(
  projection: ProviderCatalogPublicProjection,
): ProviderCatalogPublicProjection {
  try {
    return {
      vendors: projection.vendors.map((record) => publicVendorSchema.parse(record)),
      categories: projection.categories.map((record) => publicCategorySchema.parse(record)),
      collectibles: projection.collectibles.map((record) => publicCollectibleSchema.parse(record)),
      repacks: projection.repacks.map((record) => publicRepackDetailSchema.parse(record)),
      repackChases: projection.repackChases.map((record) => publicRepackChaseSchema.parse(record)),
      dataAsOf: finiteDate(projection.dataAsOf),
    };
  } catch (error) {
    if (error instanceof ProviderCatalogProjectionAssemblyError) throw error;
    invalid("PUBLIC_CONTRACT_INVALID");
  }
}

export function projectProviderCatalogRelease(input: {
  configuration: ApprovedPublicCatalogConfigurationV1;
  platformKey: string;
  revisions: readonly ProviderCatalogCanonicalRevisionSnapshot[];
  repackIdentities: readonly ProviderGovernedPublicRepackIdentity[];
}): ProviderCatalogPublicProjection {
  const platform = input.configuration.platforms.find(
    (candidate) => candidate.platformKey === input.platformKey,
  );
  if (platform === undefined || input.configuration.platforms.length !== 1) {
    invalid("PUBLIC_REFERENCE_INVALID");
  }
  const relevant = [...input.revisions];
  if (relevant.some(({ platformKey }) => platformKey !== input.platformKey)) {
    invalid("CANONICAL_PROJECTION_INVALID");
  }
  const origins = new Set(input.configuration.publicAssetOrigins);
  const identities = new Map(input.repackIdentities.map((identity) => [
    key(identity.platformKey, identity.packExternalId),
    identity,
  ]));
  if (identities.size !== input.repackIdentities.length ||
      input.repackIdentities.some(({ platformKey }) => platformKey !== input.platformKey)) {
    invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
  }
  const configuredRepackIdentities = new Map(input.configuration.repacks.map((identity) => [
    key(identity.platformKey, identity.packExternalId),
    identity,
  ]));
  const collectibleMappings = new Map(input.configuration.collectibles.map((mapping) => [
    key(mapping.platformKey, mapping.externalId),
    mapping,
  ]));
  const categoryById = new Map(input.configuration.categories.map((category) => [
    category.publicCategoryId,
    category,
  ]));

  const packs: ProviderCatalogCanonicalRevisionSnapshot[] = [];
  const assets: ProviderCatalogCanonicalRevisionSnapshot[] = [];
  const evInputs: ProviderCatalogCanonicalRevisionSnapshot[] = [];
  const estimates = new Map<string, Readonly<{
    revision: ProviderCatalogCanonicalRevisionSnapshot;
    content: CanonicalEstimatedEvProjectionContent;
  }>>();
  let maximumRelevantTime: number | null = null;
  const markContributingRevision = (
    revision: ProviderCatalogCanonicalRevisionSnapshot,
  ): void => {
    const time = revision.sourceUpdatedAt.getTime();
    if (maximumRelevantTime === null || time > maximumRelevantTime) {
      maximumRelevantTime = time;
    }
  };
  const seenRevisions = new Set<string>();
  for (const revision of relevant) {
    const revisionKey = `${revision.recordKind}\u0000${revision.externalId}`;
    if (seenRevisions.has(revisionKey)) invalid();
    seenRevisions.add(revisionKey);
    finiteDate(revision.sourceUpdatedAt);
    finiteDate(revision.sourceCollectedAt);
    finiteDate(revision.acceptedAt);
    if (revision.recordKind === "pack") {
      packContent(revision.content);
      packs.push(revision);
    } else if (revision.recordKind === "catalog_asset") {
      assetContent(revision.content);
      assets.push(revision);
    } else if (revision.recordKind === "ev_input") {
      evInputContent(revision.content);
      evInputs.push(revision);
    } else if (revision.recordKind === "estimated_ev") {
      const content = estimatedContent(
        revision.content,
        input.configuration.verifiedUsdStablecoins,
      );
      if (Date.parse(content.calculatedAt) > revision.acceptedAt.getTime()) {
        invalid();
      }
      estimates.set(
        key(revision.platformKey, revision.externalId),
        {
          revision,
          content,
        },
      );
    }
  }
  packs.sort((left, right) => compareProviderCatalogCodeUnits(left.externalId, right.externalId));
  assets.sort((left, right) => compareProviderCatalogCodeUnits(left.externalId, right.externalId));
  evInputs.sort((left, right) => compareProviderCatalogCodeUnits(left.externalId, right.externalId));

  const evInputByPack = new Map<string, Readonly<{
    revision: ProviderCatalogCanonicalRevisionSnapshot;
    content: CanonicalEvInputProjectionContent;
  }>>();
  for (const revision of evInputs) {
    const content = evInputContent(revision.content);
    const inputKey = key(revision.platformKey, content.packExternalId);
    if (evInputByPack.has(inputKey)) invalid();
    evInputByPack.set(inputKey, { revision, content });
  }

  const packByExternalId = new Map(packs.map((revision) => [
    revision.externalId,
    packContent(revision.content),
  ]));
  for (const { content } of evInputByPack.values()) {
    if (!packByExternalId.has(content.packExternalId)) {
      invalid("PUBLIC_REFERENCE_INVALID");
    }
  }
  for (const { revision } of estimates.values()) {
    if (!packByExternalId.has(revision.externalId)) {
      invalid("PUBLIC_REFERENCE_INVALID");
    }
  }

  const collectibles: PublicCollectible[] = [];
  const collectibleByAsset = new Map<string, PublicCollectible>();
  const assetsByPack = new Map<string, ProviderCatalogCanonicalRevisionSnapshot[]>();
  for (const revision of assets) {
    const content = assetContent(revision.content);
    if (content.availability === "disabled" || content.relatedPackExternalId === null) continue;
    const relatedPack = packByExternalId.get(content.relatedPackExternalId);
    if (relatedPack === undefined || !configuredRepackIdentities.has(
      key(revision.platformKey, content.relatedPackExternalId),
    )) invalid("PUBLIC_REFERENCE_INVALID");
    if (
      relatedPack.availability === "disabled" ||
      relatedPack.availability === "unknown"
    ) continue;
    const related = assetsByPack.get(content.relatedPackExternalId) ?? [];
    related.push(revision);
    assetsByPack.set(content.relatedPackExternalId, related);
    const mapping = collectibleMappings.get(key(revision.platformKey, revision.externalId));
    if (mapping === undefined || content.name === null || content.name.trim().length === 0) {
      invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
    }
    const valuationMinor = safeMinor(content.providerValueMinor);
    const currency = content.providerValueCurrency;
    const valuation = valuationMinor === null || currency === null
      ? null
      : {
          displayMoney: /^[A-Z]{3}$/u.test(currency)
            ? { minorUnits: valuationMinor, currency }
            : null,
          usdComparison: currency === "USD"
            ? {
                status: "available" as const,
                value: { minorUnits: valuationMinor, currency: "USD" as const },
              }
            : {
                status: "unavailable" as const,
                value: null,
                reason: "CURRENCY_UNSUPPORTED" as const,
              },
          valuationType: content.valueSource === "last_sale"
            ? "last_sale" as const
            : "vendor_reported" as const,
          observedAt: iso(revision.sourceUpdatedAt),
        };
    const normalizedAliases = mapping.aliases
      .map(normalizePublicSearchText)
      .sort(compareProviderCatalogCodeUnits);
    const collectible: PublicCollectible = {
      publicCollectibleId: mapping.publicCollectibleId,
      name: content.name.trim(),
      normalizedName: normalizePublicSearchText(content.name),
      aliases: mapping.aliases,
      normalizedAliases,
      collectibleType: mapping.collectibleType,
      publicCategoryIds: mapping.publicCategoryIds,
      year: mapping.year,
      brand: mapping.brand,
      setOrSeries: mapping.setOrSeries,
      cardNumber: mapping.cardNumber,
      referenceNumber: mapping.referenceNumber,
      subject: mapping.subject,
      grade: mapping.grade,
      grader: mapping.grader,
      primaryImage: approvedImage(content.imageUrls, origins, content.name),
      valuation,
      searchText: "",
      dataAsOf: iso(revision.sourceUpdatedAt),
    };
    collectible.searchText = buildPublicCollectibleSearchText(collectible);
    collectibles.push(collectible);
    markContributingRevision(revision);
    collectibleByAsset.set(key(revision.platformKey, revision.externalId), collectible);
  }
  collectibles.sort((left, right) => compareProviderCatalogCodeUnits(
    left.publicCollectibleId,
    right.publicCollectibleId,
  ));
  if (new Set(collectibles.map(({ publicCollectibleId }) => publicCollectibleId)).size !==
      collectibles.length) {
    invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
  }

  const repacks: PublicRepackDetail[] = [];
  const repackChases: PublicRepackChase[] = [];
  for (const revision of packs) {
    const content = packContent(revision.content);
    if (content.availability === "disabled" || content.availability === "unknown") continue;
    const identity = identities.get(key(revision.platformKey, revision.externalId));
    const configuredIdentity = configuredRepackIdentities.get(
      key(revision.platformKey, revision.externalId),
    );
    if (
      identity === undefined ||
      configuredIdentity === undefined ||
      identity.publicRepackId !== configuredIdentity.publicRepackId
    ) invalid("PUBLIC_IDENTITY_MAPPING_MISSING");

    const relatedAssets = assetsByPack.get(revision.externalId) ?? [];
    const evInputEntry = evInputByPack.get(
      key(revision.platformKey, revision.externalId),
    ) ?? null;
    const evInput = evInputEntry?.content ?? null;
    const estimateEntry = estimates.get(
      key(revision.platformKey, revision.externalId),
    ) ?? null;
    if (estimateEntry !== null) {
      assertEstimateDependencies({
        packRevision: revision,
        pack: content,
        evInputEntry,
        estimate: estimateEntry.content,
        verifiedUsdStablecoins:
          input.configuration.verifiedUsdStablecoins,
      });
    }
    const probabilityByBucket = new Map(
      evInput?.probabilityBuckets.map((bucket) => [bucket.bucketId, bucket.probability]) ?? [],
    );
    const chaseCandidates = relatedAssets.map((asset) => {
      const collectible = collectibleByAsset.get(key(asset.platformKey, asset.externalId));
      if (collectible === undefined) invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
      const comparison = collectible.valuation?.usdComparison;
      return {
        asset,
        collectible,
        value: comparison?.status === "available" ? comparison.value.minorUnits : null,
      };
    }).sort((left, right) => {
      if (left.value === null && right.value !== null) return 1;
      if (left.value !== null && right.value === null) return -1;
      if (left.value !== null && right.value !== null && left.value !== right.value) {
        return left.value > right.value ? -1 : 1;
      }
      return compareProviderCatalogCodeUnits(
        left.collectible.publicCollectibleId,
        right.collectible.publicCollectibleId,
      );
    });
    const chases = chaseCandidates.map(
      ({ asset, collectible }, displayOrder): PublicRepackChase => {
        const mapping = collectibleMappings.get(key(asset.platformKey, asset.externalId));
        if (mapping === undefined) invalid("PUBLIC_IDENTITY_MAPPING_MISSING");
        if (
          mapping.probabilityBucketId !== null &&
          !probabilityByBucket.has(mapping.probabilityBucketId)
        ) invalid("PUBLIC_REFERENCE_INVALID");
        const probability = mapping.probabilityBucketId === null
          ? null
          : probabilityByBucket.get(mapping.probabilityBucketId) ?? null;
        const probabilityBasisPoints = probability === null
          ? null
          : exactBasisPoints(probability, 10_000n);
        if (probabilityBasisPoints !== null && probabilityBasisPoints > 10_000) {
          invalid("EXACT_VALUE_INVALID");
        }
        const evidenceKinds = [...new Set([
          ...mapping.chaseEvidenceKinds,
          ...(probabilityBasisPoints === null ? [] : ["vendor_odds" as const]),
        ])].sort(compareProviderCatalogCodeUnits);
        const scoreBasisPoints = mapping.matchConfidenceBasisPoints;
        return {
          publicRepackId: identity.publicRepackId,
          publicCollectibleId: collectible.publicCollectibleId,
          role: displayOrder === 0 ? "top_chase" : "possible_outcome",
          evidenceKinds,
          probabilityBasisPoints,
          collectible: collectibleDisplay(collectible),
          matchConfidence: {
            scoreBasisPoints,
            band: scoreBasisPoints < 5_000
              ? "low"
              : scoreBasisPoints < 8_000
                ? "medium"
                : "high",
          },
          observedAt: iso(asset.sourceUpdatedAt),
          displayOrder,
        };
      },
    );
    repackChases.push(...chases);
    const categoryIds = [...categoryIdsFor(platform, content.category)]
      .sort(compareProviderCatalogCodeUnits);
    if (categoryIds.some((categoryId) => !categoryById.has(categoryId))) {
      invalid("PUBLIC_REFERENCE_INVALID");
    }
    const collectibleTypes = [...new Set(
      chases.map(({ collectible }) => collectible.collectibleType),
    )].sort(compareProviderCatalogCodeUnits);
    const categoryBranches = categoryIds.filter((candidate) =>
      !categoryIds.some((other) => other !== candidate &&
        categoryById.get(other)?.pathPublicCategoryIds.includes(candidate) === true))
      .length;
    const contentMode = categoryBranches > 1 || collectibleTypes.length > 1
      ? "mixed" as const
      : categoryBranches === 1 || collectibleTypes.length === 1
        ? "focused" as const
        : "unknown" as const;
    const price = publicPrice(
      content,
      input.configuration.verifiedUsdStablecoins,
    );
    if (content.buybackPercent !== null &&
        (content.buybackPercent < 0 || content.buybackPercent > 100)) {
      invalid("EXACT_VALUE_INVALID");
    }
    const buybackBasisPoints = content.buybackPercent === null
      ? null
      : exactBasisPoints(content.buybackPercent, 100n);
    if (buybackBasisPoints !== null && buybackBasisPoints > 10_000) {
      invalid("EXACT_VALUE_INVALID");
    }
    const promo = platform.vendor.publicPromo ?? undefined;
    const packScout = packScoutEv({
      estimate: estimateEntry?.content ?? null,
      evInput,
      pack: content,
      policy: input.configuration.confidencePolicy,
      verifiedUsdStablecoins:
        input.configuration.verifiedUsdStablecoins,
    });
    const probabilityCoverageBasisPoints = evInput === null
      ? null
      : exactBasisPoints(evInput.coverage.calculatedCoverage, 10_000n);
    if (
      probabilityCoverageBasisPoints !== null &&
      probabilityCoverageBasisPoints > 10_000
    ) invalid("EXACT_VALUE_INVALID");
    repacks.push({
      publicRepackId: identity.publicRepackId,
      publicVendorId: platform.vendor.publicVendorId,
      vendorKey: platform.vendor.vendorKey,
      vendorDisplayName: platform.vendor.displayName,
      vendorLogoUrl: platform.vendor.logoUrl,
      name: content.name.trim(),
      format: platform.format,
      contentMode,
      categories: categoryIds.map((publicCategoryId) => ({
        publicCategoryId,
        label: categoryById.get(publicCategoryId)!.name,
      })),
      collectibleTypes,
      availability: content.availability,
      price,
      buyback: buybackBasisPoints !== null && buybackBasisPoints <= 10_000
        ? {
            status: "available",
            value: {
              basisPoints: buybackBasisPoints,
              sourceKind: "vendor_reported",
            },
          }
        : {
            status: "unavailable",
            value: null,
            reason: "BUYBACK_UNAVAILABLE",
          },
      primaryImage: approvedImage(
        content.imageUrls,
        new Set(platform.vendor.imageOrigins),
        content.name,
      ),
      evEstimates: {
        vendorReported: vendorReportedEv(
          content,
          revision.sourceUpdatedAt,
          input.configuration.verifiedUsdStablecoins,
        ),
        packScout,
      },
      topChase: chases[0] ?? null,
      contentSummary: {
        knownCollectibleCount: chases.length,
        chaseCount: chases.length,
        categoryCount: categoryIds.length,
        collectibleTypeCount: collectibleTypes.length,
        evidenceCompleteness: evInput?.evidenceCompleteness ?? "unknown",
        probabilityCoverageBasisPoints,
      },
      actionAvailability: { promo: promo !== undefined, repackLink: false },
      sourceUpdatedAt: iso(revision.sourceUpdatedAt),
      description: content.description?.trim() || null,
      actions: promo === undefined ? {} : { promo },
    });
    markContributingRevision(revision);
    if (evInputEntry !== null) {
      markContributingRevision(evInputEntry.revision);
    }
    if (estimateEntry !== null) {
      markContributingRevision(estimateEntry.revision);
    }
  }
  repacks.sort((left, right) => compareProviderCatalogCodeUnits(
    left.publicRepackId,
    right.publicRepackId,
  ));
  repackChases.sort((left, right) =>
    compareProviderCatalogCodeUnits(left.publicRepackId, right.publicRepackId) ||
    left.displayOrder - right.displayOrder ||
    compareProviderCatalogCodeUnits(
      left.publicCollectibleId,
      right.publicCollectibleId,
    ));

  const referencedCategoryIds = new Set<string>();
  for (const collectible of collectibles) {
    for (const categoryId of collectible.publicCategoryIds) referencedCategoryIds.add(categoryId);
  }
  for (const repack of repacks) {
    for (const category of repack.categories) {
      referencedCategoryIds.add(category.publicCategoryId);
    }
  }
  const categories = relevantCategoryClosure(
    input.configuration.categories,
    referencedCategoryIds,
  );
  return validatePublicProjection({
    vendors: [platform.vendor],
    categories,
    collectibles,
    repacks,
    repackChases,
    dataAsOf: maximumRelevantTime === null
      ? new Date(0)
      : new Date(maximumRelevantTime),
  });
}
