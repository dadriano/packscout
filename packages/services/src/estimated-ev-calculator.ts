export const PACKSCOUT_ESTIMATED_EV_METHOD =
  "probability_bucket_midpoint" as const;
export const PACKSCOUT_ESTIMATED_EV_METHOD_VERSION =
  "packscout-estimated-ev-v1" as const;
export const PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO = 0.000_001;
export const PACKSCOUT_ESTIMATED_EV_ROUNDING = Object.freeze({
  grossValue: "aggregate_half_up_to_minor_unit",
  evPercent: "half_up_to_0_01_percent",
  coveragePercent: "half_up_to_0_000001_percent",
} as const);

export type PackScoutEstimatedEvUnitBasis = "per_draw" | "per_pack";
export type PackScoutEstimatedEvCurrencyTreatment =
  | "missing"
  | "unsupported"
  | "usd"
  | "verified_usd_stablecoin";
export type PackScoutEstimatedEvLimitation =
  | "midpoint_value_ranges"
  | "provider_supplied_probabilities"
  | "verified_usd_stablecoin_at_parity";

export const PACKSCOUT_ESTIMATED_EV_UNAVAILABLE_REASON_ORDER = [
  "missing_pack_price",
  "invalid_pack_price",
  "unsupported_currency",
  "missing_probability_buckets",
  "missing_probability",
  "invalid_probability",
  "incomplete_probability_coverage",
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
] as const;

export type PackScoutEstimatedEvUnavailableReason =
  (typeof PACKSCOUT_ESTIMATED_EV_UNAVAILABLE_REASON_ORDER)[number];

export interface PackScoutEstimatedEvPackPriceInput {
  readonly valueMinor?: number | null;
  readonly currency?: string | null;
  readonly sourceRevisionId?: string | null;
}

export interface PackScoutEstimatedEvBucketInput {
  readonly probability?: number | null;
  readonly lowerValueMinor?: number | null;
  readonly upperValueMinor?: number | null;
  readonly sourceRevisionId?: string | null;
}

export interface PackScoutEstimatedEvCurrencyPolicy {
  /** Exact, normalized currency identifiers explicitly verified as USD-stable. */
  readonly verifiedUsdStablecoins: readonly string[];
}

export interface CalculatePackScoutEstimatedEvInput {
  readonly packPrice?: PackScoutEstimatedEvPackPriceInput | null;
  readonly distributionCurrency?: string | null;
  readonly unitBasis?: string | null;
  readonly drawCount?: number | null;
  readonly buckets?: readonly PackScoutEstimatedEvBucketInput[];
  readonly sourceAt?: string | null;
  /** Caller-supplied clock value keeps the calculation pure and reproducible. */
  readonly calculatedAt: string;
  readonly currencyPolicy: PackScoutEstimatedEvCurrencyPolicy;
}

export interface PackScoutEstimatedEvIncludedBucketEvidence {
  readonly probability: number;
  readonly midpointValueMinor: number;
  readonly sourceRevisionId: string;
}

export interface PackScoutEstimatedEvEvidence {
  readonly formula: "sum(probability * midpoint_value_minor) * draw_multiplier";
  readonly unitBasis: PackScoutEstimatedEvUnitBasis | null;
  readonly declaredDrawCount: number | null;
  readonly appliedDrawMultiplier: number | null;
  readonly probabilityCoverageRatio: number;
  readonly probabilityToleranceRatio: number;
  readonly includedBucketCount: number;
  readonly includedBuckets: readonly PackScoutEstimatedEvIncludedBucketEvidence[];
  readonly sourceRevisionIds: readonly string[];
  readonly priceCurrency: string | null;
  readonly distributionCurrency: string | null;
  readonly priceCurrencyTreatment: PackScoutEstimatedEvCurrencyTreatment;
  readonly distributionCurrencyTreatment: PackScoutEstimatedEvCurrencyTreatment;
  readonly currencyPolicy: "usd_and_explicit_verified_usd_stablecoins_v1";
  readonly rounding: typeof PACKSCOUT_ESTIMATED_EV_ROUNDING;
  readonly limitations: readonly PackScoutEstimatedEvLimitation[];
}

interface PackScoutEstimatedEvResultBase {
  readonly method: typeof PACKSCOUT_ESTIMATED_EV_METHOD;
  readonly methodVersion: typeof PACKSCOUT_ESTIMATED_EV_METHOD_VERSION;
  readonly coveragePercent: number;
  readonly inputCount: number;
  readonly sourceAt: string | null;
  readonly calculatedAt: string;
  readonly evidence: PackScoutEstimatedEvEvidence;
}

export interface PackScoutEstimatedEvEstimatedResult
  extends PackScoutEstimatedEvResultBase {
  readonly status: "estimated";
  readonly grossValueMinor: number;
  readonly evPercent: number;
  readonly currency: "USD";
  readonly reasonCodes: readonly [];
}

export interface PackScoutEstimatedEvUnavailableResult
  extends PackScoutEstimatedEvResultBase {
  readonly status: "unavailable";
  readonly grossValueMinor: null;
  readonly evPercent: null;
  readonly currency: null;
  readonly reasonCodes: readonly PackScoutEstimatedEvUnavailableReason[];
}

export type PackScoutEstimatedEvResult =
  | PackScoutEstimatedEvEstimatedResult
  | PackScoutEstimatedEvUnavailableResult;

export class PackScoutEstimatedEvConfigurationError extends Error {
  readonly code = "INVALID_CALCULATED_AT";

  constructor() {
    super("PackScout Estimated EV requires a valid calculation timestamp.");
    this.name = "PackScoutEstimatedEvConfigurationError";
  }
}

interface ValidatedBucket {
  readonly probability: number;
  readonly probabilityFactor: Rational;
  readonly midpointValueMinor: number;
  readonly midpointValueFactor: Rational;
  readonly sourceRevisionId: string;
}

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const ZERO_RATIONAL: Rational = { numerator: 0n, denominator: 1n };
const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);

const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    instantPattern.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isPositiveMinorValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeMinorValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveDrawCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function currencyTreatment(
  currency: string | null | undefined,
  verifiedStablecoins: ReadonlySet<string>,
): PackScoutEstimatedEvCurrencyTreatment {
  if (!currency) return "missing";
  if (currency === "USD") return "usd";
  return verifiedStablecoins.has(currency)
    ? "verified_usd_stablecoin"
    : "unsupported";
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let currentLeft = left < 0n ? -left : left;
  let currentRight = right < 0n ? -right : right;
  while (currentRight !== 0n) {
    const remainder = currentLeft % currentRight;
    currentLeft = currentRight;
    currentRight = remainder;
  }
  return currentLeft;
}

function rational(numerator: bigint, denominator: bigint): Rational {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

function rationalFromNumber(value: number): Rational {
  const [coefficient = "0", exponentText = "0"] = value
    .toString()
    .toLowerCase()
    .split("e");
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const exponent = Number.parseInt(exponentText, 10);
  const digits = BigInt(`${whole}${fraction}`);
  const decimalPlaces = fraction.length - exponent;
  return decimalPlaces >= 0
    ? rational(digits, 10n ** BigInt(decimalPlaces))
    : rational(digits * 10n ** BigInt(-decimalPlaces), 1n);
}

function addRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator +
      right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

function multiplyRationalByInteger(value: Rational, factor: bigint): Rational {
  return rational(value.numerator * factor, value.denominator);
}

function roundRationalHalfUp(value: Rational): bigint {
  const quotient = value.numerator / value.denominator;
  const remainder = value.numerator % value.denominator;
  return remainder * 2n >= value.denominator ? quotient + 1n : quotient;
}

function roundedRationalNumber(
  value: Rational,
  decimalPlaces: number,
): number | null {
  const scale = 10n ** BigInt(decimalPlaces);
  const scaled = roundRationalHalfUp(
    multiplyRationalByInteger(value, scale),
  );
  if (scaled > maximumSafeInteger) return null;
  return Number(scaled) / Number(scale);
}

function coverageIsComplete(coverage: Rational): boolean {
  const difference =
    coverage.numerator >= coverage.denominator
      ? coverage.numerator - coverage.denominator
      : coverage.denominator - coverage.numerator;
  return (
    difference * 1_000_000n <=
    coverage.denominator
  );
}

function stableUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function orderedReasons(
  reasons: ReadonlySet<PackScoutEstimatedEvUnavailableReason>,
): readonly PackScoutEstimatedEvUnavailableReason[] {
  return Object.freeze(
    PACKSCOUT_ESTIMATED_EV_UNAVAILABLE_REASON_ORDER.filter((reason) =>
      reasons.has(reason),
    ),
  );
}

function unavailableResult(
  common: PackScoutEstimatedEvResultBase,
  reasons: ReadonlySet<PackScoutEstimatedEvUnavailableReason>,
): PackScoutEstimatedEvUnavailableResult {
  return {
    ...common,
    status: "unavailable",
    grossValueMinor: null,
    evPercent: null,
    currency: null,
    reasonCodes: orderedReasons(reasons),
  };
}

export function calculatePackScoutEstimatedEv(
  input: CalculatePackScoutEstimatedEvInput,
): PackScoutEstimatedEvResult {
  if (!isInstant(input.calculatedAt)) {
    throw new PackScoutEstimatedEvConfigurationError();
  }

  const reasons = new Set<PackScoutEstimatedEvUnavailableReason>();
  const buckets = input.buckets ?? [];
  const packPriceMinor = input.packPrice?.valueMinor;
  if (packPriceMinor === null || packPriceMinor === undefined) {
    reasons.add("missing_pack_price");
  } else if (!isPositiveMinorValue(packPriceMinor)) {
    reasons.add("invalid_pack_price");
  }

  const verifiedStablecoins = new Set(
    input.currencyPolicy.verifiedUsdStablecoins.filter(
      (currency) => currency.length > 0 && currency === currency.trim(),
    ),
  );
  const priceCurrencyTreatment = currencyTreatment(
    input.packPrice?.currency,
    verifiedStablecoins,
  );
  const distributionCurrencyTreatment = currencyTreatment(
    input.distributionCurrency,
    verifiedStablecoins,
  );
  if (
    (input.packPrice !== null &&
      input.packPrice !== undefined &&
      !["usd", "verified_usd_stablecoin"].includes(priceCurrencyTreatment)) ||
    !["usd", "verified_usd_stablecoin"].includes(
      distributionCurrencyTreatment,
    )
  ) {
    reasons.add("unsupported_currency");
  }

  const unitBasis =
    input.unitBasis === "per_draw" || input.unitBasis === "per_pack"
      ? input.unitBasis
      : null;
  if (!unitBasis) reasons.add("ambiguous_unit_basis");
  const drawCount = isPositiveDrawCount(input.drawCount) ? input.drawCount : null;
  if (!drawCount) reasons.add("invalid_draw_count");
  if (buckets.length === 0) reasons.add("missing_probability_buckets");

  let probabilityCoverage = ZERO_RATIONAL;
  let allProbabilitiesValid = buckets.length > 0;
  const includedBuckets: ValidatedBucket[] = [];
  const sourceRevisionIds: string[] = [];
  const priceRevisionId = input.packPrice?.sourceRevisionId;
  if (
    input.packPrice !== null &&
    input.packPrice !== undefined &&
    typeof priceRevisionId === "string" &&
    priceRevisionId.trim().length > 0
  ) {
    sourceRevisionIds.push(priceRevisionId);
  } else if (input.packPrice !== null && input.packPrice !== undefined) {
    reasons.add("missing_source_evidence");
  }

  for (const bucket of buckets) {
    const probability = bucket.probability;
    const lower = bucket.lowerValueMinor;
    const upper = bucket.upperValueMinor;
    const revisionId = bucket.sourceRevisionId;
    let bucketValid = true;
    let probabilityFactor: Rational | null = null;

    if (probability === null || probability === undefined) {
      reasons.add("missing_probability");
      allProbabilitiesValid = false;
      bucketValid = false;
    } else if (
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      reasons.add("invalid_probability");
      allProbabilitiesValid = false;
      bucketValid = false;
    } else {
      probabilityFactor = rationalFromNumber(probability);
      probabilityCoverage = addRational(
        probabilityCoverage,
        probabilityFactor,
      );
    }

    if (lower === undefined || upper === undefined) {
      reasons.add("missing_value_bound");
      bucketValid = false;
    } else if (lower === null || upper === null) {
      reasons.add("open_ended_value_range");
      bucketValid = false;
    } else if (
      !isNonNegativeMinorValue(lower) ||
      !isNonNegativeMinorValue(upper)
    ) {
      reasons.add("invalid_value_bound");
      bucketValid = false;
    } else if (lower > upper) {
      reasons.add("invalid_value_range");
      bucketValid = false;
    }

    if (typeof revisionId === "string" && revisionId.trim().length > 0) {
      sourceRevisionIds.push(revisionId);
    } else {
      reasons.add("missing_source_evidence");
      bucketValid = false;
    }

    if (
      bucketValid &&
      typeof probability === "number" &&
      typeof lower === "number" &&
      typeof upper === "number" &&
      typeof revisionId === "string" &&
      probabilityFactor
    ) {
      const midpointValueFactor = rational(
        BigInt(lower) + BigInt(upper),
        2n,
      );
      includedBuckets.push({
        probability,
        probabilityFactor,
        midpointValueMinor: lower / 2 + upper / 2,
        midpointValueFactor,
        sourceRevisionId: revisionId,
      });
    }
  }

  if (
    allProbabilitiesValid &&
    !coverageIsComplete(probabilityCoverage)
  ) {
    reasons.add("incomplete_probability_coverage");
  }

  const sourceAt = isInstant(input.sourceAt) ? input.sourceAt : null;
  if (input.sourceAt === null || input.sourceAt === undefined || input.sourceAt === "") {
    reasons.add("missing_source_time");
  } else if (!sourceAt) {
    reasons.add("invalid_source_time");
  }

  const limitations: PackScoutEstimatedEvLimitation[] = [
    "midpoint_value_ranges",
    "provider_supplied_probabilities",
  ];
  if (
    priceCurrencyTreatment === "verified_usd_stablecoin" ||
    distributionCurrencyTreatment === "verified_usd_stablecoin"
  ) {
    limitations.push("verified_usd_stablecoin_at_parity");
  }

  const coveragePercent = roundedRationalNumber(
    multiplyRationalByInteger(probabilityCoverage, 100n),
    6,
  );
  const probabilityCoverageRatio = roundedRationalNumber(
    probabilityCoverage,
    12,
  );
  if (coveragePercent === null || probabilityCoverageRatio === null) {
    reasons.add("calculation_overflow");
  }
  const evidenceBase = {
    formula: "sum(probability * midpoint_value_minor) * draw_multiplier",
    unitBasis,
    declaredDrawCount: drawCount,
    appliedDrawMultiplier: null,
    probabilityCoverageRatio: probabilityCoverageRatio ?? 0,
    probabilityToleranceRatio:
      PACKSCOUT_ESTIMATED_EV_PROBABILITY_TOLERANCE_RATIO,
    includedBucketCount: includedBuckets.length,
    includedBuckets: Object.freeze(
      includedBuckets.map(
        ({ probability, midpointValueMinor, sourceRevisionId }) => ({
          probability,
          midpointValueMinor,
          sourceRevisionId,
        }),
      ),
    ),
    sourceRevisionIds: stableUnique(sourceRevisionIds),
    priceCurrency: input.packPrice?.currency ?? null,
    distributionCurrency: input.distributionCurrency ?? null,
    priceCurrencyTreatment,
    distributionCurrencyTreatment,
    currencyPolicy: "usd_and_explicit_verified_usd_stablecoins_v1",
    rounding: PACKSCOUT_ESTIMATED_EV_ROUNDING,
    limitations: Object.freeze(limitations),
  } satisfies PackScoutEstimatedEvEvidence;
  const common = {
    method: PACKSCOUT_ESTIMATED_EV_METHOD,
    methodVersion: PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
    coveragePercent: coveragePercent ?? 0,
    inputCount: buckets.length,
    sourceAt,
    calculatedAt: input.calculatedAt,
    evidence: evidenceBase,
  } satisfies PackScoutEstimatedEvResultBase;

  if (reasons.size > 0 || !unitBasis || !drawCount || !packPriceMinor) {
    return unavailableResult(common, reasons);
  }

  const perBasisValue = includedBuckets.reduce<Rational>(
    (total, bucket) =>
      addRational(
        total,
        multiplyRational(
          bucket.probabilityFactor,
          bucket.midpointValueFactor,
        ),
      ),
    ZERO_RATIONAL,
  );
  const drawMultiplier = unitBasis === "per_draw" ? drawCount : 1;
  const grossValue = roundRationalHalfUp(
    multiplyRationalByInteger(perBasisValue, BigInt(drawMultiplier)),
  );
  const grossValueMinor =
    grossValue <= maximumSafeInteger ? Number(grossValue) : null;
  const evPercent =
    grossValueMinor === null
      ? null
      : roundedRationalNumber(
          rational(BigInt(grossValueMinor) * 100n, BigInt(packPriceMinor)),
          2,
        );
  if (
    grossValueMinor === null ||
    grossValueMinor < 0 ||
    evPercent === null
  ) {
    reasons.add("calculation_overflow");
    return unavailableResult(common, reasons);
  }

  return {
    ...common,
    status: "estimated",
    grossValueMinor,
    evPercent,
    currency: "USD",
    reasonCodes: [],
    evidence: { ...evidenceBase, appliedDrawMultiplier: drawMultiplier },
  };
}
