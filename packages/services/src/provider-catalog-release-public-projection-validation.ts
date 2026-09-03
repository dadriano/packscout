import {
  PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
  canonicalJson,
  projectCanonicalPackAvailabilityV1,
  type ApprovedPublicPlatformConfiguration,
  type CanonicalPackAvailabilityInputV1,
  type PublicPackAvailability,
} from "@packscout/contracts";
import {
  EV_INPUT_COVERAGE_TOLERANCE,
  type CanonicalCatalogAssetProjectionContent,
  type CanonicalEvInputReadinessReason,
  type CanonicalEvInputProjectionContent,
  type CanonicalPackProjectionContent,
} from "./catalog-projection-contracts.ts";
import { calculatePackScoutEstimatedEv } from "./estimated-ev-calculator.ts";
import {
  estimatedEvCalculationFingerprint,
  type CanonicalEstimatedEvProjectionContent,
  type EstimatedEvInputManifest,
} from "./estimated-ev-projection-contracts.ts";
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

export type PublicAvailabilityPackContent = Omit<
  CanonicalPackProjectionContent,
  "availability"
> & Pick<
  CanonicalPackAvailabilityInputV1,
  "availability" | "availabilityProvenance"
> & Readonly<{ evInputStatus: "ready" | "unavailable" }>;

export type PublicAvailabilityAssetContent = Omit<
  CanonicalCatalogAssetProjectionContent,
  "availability"
> & Readonly<{ availability: PublicPackAvailability }>;

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function compareProviderCatalogCodeUnits(
  left: string,
  right: string,
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function invalidProviderCatalogProjection(
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

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareProviderCatalogCodeUnits);
  const canonicalExpected = [...expected].sort(compareProviderCatalogCodeUnits);
  return actual.length === canonicalExpected.length &&
    actual.every((entry, index) => entry === canonicalExpected[index]);
}

export function finiteProviderCatalogDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalidProviderCatalogProjection();
  }
  return new Date(value.getTime());
}

export function providerCatalogIso(value: Date): string {
  return finiteProviderCatalogDate(value).toISOString();
}

export function canonicalProviderCatalogTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalidProviderCatalogProjection();
  }
  return value;
}

export function providerCatalogPackContent(
  value: unknown,
): PublicAvailabilityPackContent {
  if (
    !isObject(value) ||
    value.schemaVersion !== "catalog-projection-v1" ||
    value.entityType !== "pack" ||
    !["ready", "unavailable"].includes(String(value.evInputStatus)) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    !isNullableString(value.category) ||
    !isNullableString(value.description) ||
    !["available", "unavailable", "unknown", "sold_out"].includes(
      String(value.availability),
    ) ||
    !isObject(value.availabilityProvenance) ||
    (value.availability === "sold_out"
      ? !hasExactKeys(value.availabilityProvenance, ["kind", "authority"]) ||
        value.availabilityProvenance.kind !==
          "explicit_authoritative_sold_out" ||
        value.availabilityProvenance.authority !==
          "provider_explicit_sold_out"
      : !hasExactKeys(value.availabilityProvenance, [
          "kind",
          "observedAvailability",
        ]) ||
        value.availabilityProvenance.kind !==
          "canonical_provider_observation" ||
        value.availabilityProvenance.observedAvailability !==
          value.availability) ||
    !isNullableNonNegativeSafeInteger(value.priceValueMinor) ||
    !isNullableString(value.priceCurrency) ||
    !isNullableNonNegativeSafeInteger(value.providerReportedEvValueMinor) ||
    !isNullableString(value.providerReportedEvCurrency) ||
    !isNullableFiniteNumber(value.buybackPercent) ||
    !isStringArray(value.imageUrls)
  ) invalidProviderCatalogProjection();
  return value as unknown as PublicAvailabilityPackContent;
}

export function trustedProviderCatalogPackAvailability(input: Readonly<{
  content: PublicAvailabilityPackContent;
  identity: ProviderGovernedPublicRepackIdentity;
  platform: ApprovedPublicPlatformConfiguration;
  sourceUpdatedAt: Date;
}>): PublicPackAvailability {
  try {
    return projectCanonicalPackAvailabilityV1({
      schemaVersion: PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
      publicRepackId: input.identity.publicRepackId,
      publicVendorId: input.platform.vendor.publicVendorId,
      vendorKey: input.platform.vendor.vendorKey,
      availability: input.content.availability,
      availabilityProvenance: input.content.availabilityProvenance,
      sourceUpdatedAt: providerCatalogIso(input.sourceUpdatedAt),
    }).availability;
  } catch {
    return invalidProviderCatalogProjection("CANONICAL_PROJECTION_INVALID");
  }
}

export function providerCatalogAssetContent(
  value: unknown,
): PublicAvailabilityAssetContent {
  if (
    !isObject(value) ||
    value.schemaVersion !== "catalog-projection-v1" ||
    value.entityType !== "catalog_asset" ||
    value.relatedPackExternalId !== null ||
    !isNullableString(value.name) ||
    !isNullableString(value.category) ||
    !["available", "unavailable", "unknown", "sold_out"].includes(
      String(value.availability),
    ) ||
    !isNullableNonNegativeSafeInteger(value.providerValueMinor) ||
    !isNullableString(value.providerValueCurrency) ||
    !isNullableString(value.valueSource) ||
    !isStringArray(value.imageUrls)
  ) invalidProviderCatalogProjection();
  return value as unknown as PublicAvailabilityAssetContent;
}

export function providerCatalogEvInputContent(
  value: unknown,
): CanonicalEvInputProjectionContent {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "entityType",
      "packExternalId",
      "currency",
      "unitBasis",
      "drawCount",
      "buybackPercent",
      "inventory",
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
    !(value.buybackPercent === null ||
      typeof value.buybackPercent === "number" &&
      Number.isFinite(value.buybackPercent) &&
      value.buybackPercent >= 0 && value.buybackPercent <= 100) ||
    !(value.inventory === null || isObject(value.inventory) &&
      hasExactKeys(value.inventory, ["totalQuantity", "bucketQuantities"]) &&
      typeof value.inventory.totalQuantity === "number" &&
      Number.isSafeInteger(value.inventory.totalQuantity) &&
      value.inventory.totalQuantity > 0 &&
      Array.isArray(value.inventory.bucketQuantities)) ||
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
  ) invalidProviderCatalogProjection();
  if (isObject(value.inventory)) {
    const quantityIds = new Set<string>();
    let totalQuantity = 0;
    for (const candidate of value.inventory.bucketQuantities as unknown[]) {
      if (
        !isObject(candidate) ||
        !hasExactKeys(candidate, ["bucketId", "quantity"]) ||
        typeof candidate.bucketId !== "string" ||
        candidate.bucketId.length === 0 ||
        candidate.bucketId.length > 256 ||
        quantityIds.has(candidate.bucketId) ||
        typeof candidate.quantity !== "number" ||
        !Number.isSafeInteger(candidate.quantity) ||
        candidate.quantity <= 0
      ) invalidProviderCatalogProjection();
      quantityIds.add(candidate.bucketId);
      totalQuantity += candidate.quantity;
    }
    if (
      !Number.isSafeInteger(totalQuantity) ||
      totalQuantity !== value.inventory.totalQuantity
    ) invalidProviderCatalogProjection();
  }
  if (
    value.coverage.declaredCoverage !== null &&
      (value.coverage.declaredCoverage < 0 ||
        value.coverage.declaredCoverage > 1) ||
    value.coverage.calculatedCoverage < 0 ||
    value.coverage.calculatedCoverage > 1
  ) invalidProviderCatalogProjection("EXACT_VALUE_INVALID");

  for (const evidence of value.dataQualityEvidence) {
    if (
      !isObject(evidence) ||
      !hasExactKeys(evidence, ["code", "severity", "fieldPath"]) ||
      typeof evidence.code !== "string" ||
      evidence.code.length === 0 ||
      evidence.code.length > 128 ||
      !["info", "warning"].includes(String(evidence.severity)) ||
      !isNullableString(evidence.fieldPath)
    ) invalidProviderCatalogProjection();
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
    ) invalidProviderCatalogProjection();
    if (
      bucket.probability !== null &&
      (bucket.probability < 0 || bucket.probability > 1)
    ) invalidProviderCatalogProjection("EXACT_VALUE_INVALID");
    bucketIds.add(bucket.bucketId);
  }

  if (
    value.coverage.probabilityBucketCount !== value.probabilityBuckets.length ||
    value.coverage.topChaseCount !== value.topChases.length
  ) invalidProviderCatalogProjection();
  const calculatedCoverage = Number(
    value.probabilityBuckets.reduce(
      (total, bucket) =>
        total + ((bucket as Record<string, unknown>).probability as number | null ?? 0),
      0,
    ).toFixed(12),
  );
  if (calculatedCoverage !== value.coverage.calculatedCoverage) {
    invalidProviderCatalogProjection();
  }

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
  ) invalidProviderCatalogProjection();
  const reasonSet = new Set(reasons);
  const requireReason = (
    reason: CanonicalEvInputReadinessReason,
    required: boolean,
  ): void => {
    if (reasonSet.has(reason) !== required) invalidProviderCatalogProjection();
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
  ) invalidProviderCatalogProjection();
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
  ) invalidProviderCatalogProjection();
  requireReason(
    "invalid_value_range",
    probabilityBuckets.some(({ lowerValueMinor, upperValueMinor }) =>
      lowerValueMinor !== null && upperValueMinor !== null &&
      lowerValueMinor > upperValueMinor),
  );
  return value as unknown as CanonicalEvInputProjectionContent;
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
  ) invalidProviderCatalogProjection();
  if (value.sourceAt !== null) canonicalProviderCatalogTimestamp(value.sourceAt);
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
    ) invalidProviderCatalogProjection();
    bucketIds.add(candidate.bucketId);
  }
  return value as unknown as EstimatedEvInputManifest;
}

export function providerCatalogEstimatedContent(
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
      (limitation) => typeof limitation === "string" &&
        PIPELINE_LIMITATIONS.has(limitation),
    ) ||
    !Array.isArray(value.reasonCodes) ||
    !value.reasonCodes.every(
      (reason) => typeof reason === "string" &&
        ESTIMATED_EV_UNAVAILABLE_REASONS.has(reason),
    ) ||
    (!estimatedValuesAreValid && !unavailableValuesAreValid)
  ) invalidProviderCatalogProjection();
  canonicalProviderCatalogTimestamp(value.calculatedAt);
  if (value.sourceAt !== null) canonicalProviderCatalogTimestamp(value.sourceAt);
  const manifest = estimatedInputManifest(value.inputManifest);
  if (
    canonicalJson(manifest.verifiedUsdStablecoins) !==
      canonicalJson(verifiedUsdStablecoins) ||
    estimatedEvCalculationFingerprint(manifest) !==
      value.calculationFingerprint
  ) invalidProviderCatalogProjection();
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
  if (canonicalJson(persistedResult) !== canonicalJson(recalculated)) {
    invalidProviderCatalogProjection();
  }
  return value as unknown as CanonicalEstimatedEvProjectionContent;
}

export function assertProviderCatalogEstimateDependencies(input: Readonly<{
  packRevision: ProviderCatalogCanonicalRevisionSnapshot;
  pack: PublicAvailabilityPackContent;
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
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    invalidProviderCatalogProjection();
  }
}
