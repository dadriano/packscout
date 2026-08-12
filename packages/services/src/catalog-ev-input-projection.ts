import {
  CanonicalProjectionValidationError,
  normalizeCanonicalIdentity,
  normalizeCanonicalMoney,
  normalizeOptionalText,
} from "./canonical-projection-validation.ts";
import {
  CATALOG_PROJECTION_VERSION,
  EV_INPUT_COVERAGE_TOLERANCE,
  type CanonicalDataQualityEvidence,
  type CanonicalEvInputProjectionContent,
  type CanonicalEvInputReadinessReason,
} from "./catalog-projection-contracts.ts";
import type { EvInputCandidate, ProbabilityBucketInput } from "./provider-adapter.ts";

const readinessReasonOrder: readonly CanonicalEvInputReadinessReason[] = [
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

export class EvInputProjectionValidationError extends Error {
  constructor(
    readonly code: "DUPLICATE_BUCKET_ID" | "INVALID_EVIDENCE_KIND",
    readonly fieldPath: string,
  ) {
    super("EV input evidence failed canonical validation.");
    this.name = "EvInputProjectionValidationError";
  }
}

function normalizedCurrency(
  value: string | null,
  reasons: Set<CanonicalEvInputReadinessReason>,
): string | null {
  if (value === null) {
    reasons.add("invalid_currency");
    return null;
  }
  try {
    return normalizeCanonicalMoney(
      { amount: 0, currency: value },
      "candidates.evInput.currency",
    )?.currency ?? null;
  } catch (error) {
    if (!(error instanceof CanonicalProjectionValidationError)) throw error;
    reasons.add("invalid_currency");
    return null;
  }
}

function normalizedBound(
  value: number | null,
  currency: string | null,
  affectsReadiness: boolean,
  reasons: Set<CanonicalEvInputReadinessReason>,
): number | null {
  if (value === null) {
    if (affectsReadiness) reasons.add("missing_value_bound");
    return null;
  }
  if (currency === null) return null;
  try {
    return normalizeCanonicalMoney(
      { amount: value, currency },
      "candidates.evInput.buckets.value",
    )?.amountMinor ?? null;
  } catch (error) {
    if (!(error instanceof CanonicalProjectionValidationError)) throw error;
    if (affectsReadiness) reasons.add("invalid_value_bound");
    return null;
  }
}

function normalizedBucket(
  bucket: ProbabilityBucketInput,
  currency: string | null,
  reasons: Set<CanonicalEvInputReadinessReason>,
) {
  if (
    bucket.evidenceKind !== "probability_bucket" &&
    bucket.evidenceKind !== "top_chase"
  ) {
    throw new EvInputProjectionValidationError(
      "INVALID_EVIDENCE_KIND",
      "candidates.evInput.buckets.evidenceKind",
    );
  }
  const affectsReadiness = bucket.evidenceKind === "probability_bucket";
  let probability = bucket.probability;
  if (probability === null) {
    if (affectsReadiness) reasons.add("missing_probability");
  } else if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    if (affectsReadiness) reasons.add("invalid_probability");
    probability = null;
  }
  const lowerValueMinor = normalizedBound(
    bucket.lowerValue,
    currency,
    affectsReadiness,
    reasons,
  );
  const upperValueMinor = normalizedBound(
    bucket.upperValue,
    currency,
    affectsReadiness,
    reasons,
  );
  if (
    affectsReadiness &&
    lowerValueMinor !== null &&
    upperValueMinor !== null &&
    lowerValueMinor > upperValueMinor
  ) {
    reasons.add("invalid_value_range");
  }
  return {
    bucketId: normalizeCanonicalIdentity(
      bucket.bucketId,
      "candidates.evInput.buckets.bucketId",
    ),
    evidenceKind: bucket.evidenceKind,
    label: normalizeOptionalText(bucket.label, "candidates.evInput.buckets.label", 500),
    probability,
    lowerValueMinor,
    upperValueMinor,
  };
}

function withoutKind(bucket: ReturnType<typeof normalizedBucket>) {
  return {
    bucketId: bucket.bucketId,
    label: bucket.label,
    probability: bucket.probability,
    lowerValueMinor: bucket.lowerValueMinor,
    upperValueMinor: bucket.upperValueMinor,
  };
}

export function projectEvInputContent(
  candidate: EvInputCandidate,
  dataQualityEvidence: readonly CanonicalDataQualityEvidence[],
): CanonicalEvInputProjectionContent {
  const reasons = new Set<CanonicalEvInputReadinessReason>();
  const currency = normalizedCurrency(candidate.currency, reasons);
  const buckets = candidate.buckets
    .map((bucket) => normalizedBucket(bucket, currency, reasons))
    .sort((left, right) => left.bucketId.localeCompare(right.bucketId));
  if (new Set(buckets.map((bucket) => bucket.bucketId)).size !== buckets.length) {
    throw new EvInputProjectionValidationError(
      "DUPLICATE_BUCKET_ID",
      "candidates.evInput.buckets",
    );
  }
  const probabilityBuckets = buckets.filter(
    (bucket) => bucket.evidenceKind === "probability_bucket",
  );
  const topChases = buckets.filter((bucket) => bucket.evidenceKind === "top_chase");
  if (probabilityBuckets.length === 0) reasons.add("missing_probability_buckets");
  const calculatedCoverage = Number(
    probabilityBuckets
      .reduce((total, bucket) => total + (bucket.probability ?? 0), 0)
      .toFixed(12),
  );
  if (Math.abs(calculatedCoverage - 1) > EV_INPUT_COVERAGE_TOLERANCE) {
    reasons.add("incomplete_probability_coverage");
  }
  const declaredCoverage =
    typeof candidate.declaredCoverage === "number" &&
    Number.isFinite(candidate.declaredCoverage) &&
    candidate.declaredCoverage >= 0 &&
    candidate.declaredCoverage <= 1
      ? candidate.declaredCoverage
      : null;
  if (
    candidate.declaredCoverage !== null &&
    (declaredCoverage === null ||
      Math.abs(declaredCoverage - calculatedCoverage) > EV_INPUT_COVERAGE_TOLERANCE)
  ) {
    reasons.add("declared_coverage_mismatch");
  }
  const unitBasis =
    candidate.unitBasis === "per_draw" || candidate.unitBasis === "per_pack"
      ? candidate.unitBasis
      : null;
  if (unitBasis === null) reasons.add("missing_unit_basis");
  const drawCount =
    Number.isSafeInteger(candidate.drawCount) && (candidate.drawCount ?? 0) > 0
      ? candidate.drawCount
      : null;
  if (drawCount === null) reasons.add("invalid_draw_count");
  const evidenceCompleteness =
    candidate.evidenceCompleteness === "complete" ||
    candidate.evidenceCompleteness === "partial" ||
    candidate.evidenceCompleteness === "unknown"
      ? candidate.evidenceCompleteness
      : "unknown";
  if (evidenceCompleteness !== "complete") reasons.add("incomplete_inventory");
  const orderedReasons = readinessReasonOrder.filter((reason) => reasons.has(reason));
  return {
    schemaVersion: CATALOG_PROJECTION_VERSION,
    entityType: "ev_input",
    packExternalId: normalizeCanonicalIdentity(
      candidate.packExternalId,
      "candidates.evInput.packExternalId",
    ),
    currency,
    unitBasis,
    drawCount,
    evidenceCompleteness,
    coverage: {
      declaredCoverage,
      calculatedCoverage,
      tolerance: EV_INPUT_COVERAGE_TOLERANCE,
      probabilityBucketCount: probabilityBuckets.length,
      topChaseCount: topChases.length,
    },
    probabilityBuckets: probabilityBuckets.map(withoutKind),
    topChases: topChases.map(withoutKind),
    readiness: {
      status: orderedReasons.length === 0 ? "ready" : "unavailable",
      reasons: orderedReasons,
    },
    dataQualityEvidence,
  };
}
