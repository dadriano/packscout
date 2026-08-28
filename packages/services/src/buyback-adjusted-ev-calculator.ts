import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_FORMULAS_V1,
  PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1,
  PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  canonicalizePackScoutBuybackEvInternalReasonsV1,
  packScoutBuybackEvInputV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  parsePackScoutBuybackEvTimestampMillisV1,
  type PackScoutBuybackEvInputV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
  type PackScoutBuybackEvMoneyEvidenceV1,
  type PackScoutBuybackEvOutcomeV1,
  type PackScoutBuybackEvProtectedCalculationResultV1,
  type PackScoutBuybackEvProtectedProvenanceV1,
  type PackScoutBuybackEvRateTermsV1,
} from "@packscout/contracts";

/**
 * PackScout buyback-adjusted EV calculator (task `buyback-adjusted-ev/002`).
 *
 * Pure and deterministic: no network, persistence, publication, logging,
 * provider branching, or wall clock. The caller supplies the calculation
 * clock as a canonical UTC millisecond timestamp, and byte-equivalent input
 * plus an identical clock always produce a byte-equivalent result.
 *
 * Method (approved formulas, exact rational arithmetic end to end):
 * - Underlying Outcome EV = sum(probability x supported stated value) x draw
 *   multiplier, kept as protected calculation evidence.
 * - Gross EV = sum(probability x final guaranteed buyback payout) x draw
 *   multiplier. An explicitly ineligible outcome contributes a zero payout
 *   while retaining its probability; probability mass is never renormalized.
 * - Exact outcome-specific terms take priority over the documented product
 *   uniform rate; an exact final payout is used as-is and never adjusted
 *   again; rate-based payouts apply the contract payout order
 *   rated_offer -> percentage_fee -> fixed_fee -> zero_clamp -> floor -> cap
 *   to the representative stated value (the arithmetic midpoint of the two
 *   canonical rational bounds for a closed range).
 * - Aggregates round exactly once, half-up, to USD cents. Gross EV %, EV $,
 *   and EV % derive from the rounded Gross EV and the positive pack price
 *   with half-up basis-point rounding, so
 *   `packScoutBuybackEvMetricsAreConsistentV1` always holds for available
 *   results.
 *
 * Unavailable behavior. The strict input contract already rejects most bad
 * evidence, so the calculator's own unavailable paths are:
 * - `MISSING_SOURCE_TIME` when the supplied calculation clock precedes the
 *   observation: an observation later than the calculation clock has no
 *   usable source time, so `dataAsOf` becomes `unknown_source_time` while
 *   parsed provenance is retained.
 * - `ARITHMETIC_OVERFLOW` when exact weighting exceeds the accumulator work
 *   ceiling ({@link PACKSCOUT_BUYBACK_ADJUSTED_EV_MAX_ACCUMULATOR_BITS}) or
 *   a rounded aggregate exceeds the canonical USD bound or a derived basis
 *   point value leaves the safe integer range.
 * - Defense-in-depth for unparsed input: the calculator accepts `unknown`,
 *   safe-parses the strict contract schema first, and maps a schema
 *   rejection to deterministic internal reasons (see
 *   {@link packScoutBuybackAdjustedEvReasonForSchemaIssueV1}). An
 *   unparseable input has no trustworthy provenance or source time, so every
 *   schema rejection also carries `MISSING_PROVENANCE` and
 *   `MISSING_SOURCE_TIME` with a null provenance and an unknown data-as-of.
 *
 * Vendor-reported EV cannot enter the calculation by construction: the
 * strict input schema rejects unknown keys and carries no vendor EV field.
 */

/**
 * Exact-arithmetic work ceiling for reduced accumulator terms, matching the
 * contract's probability-accumulator ceiling. Exceeding it during weighting
 * fails closed as `ARITHMETIC_OVERFLOW` instead of degrading precision.
 */
export const PACKSCOUT_BUYBACK_ADJUSTED_EV_MAX_ACCUMULATOR_BITS =
  4_096 as const;

export interface CalculatePackScoutBuybackAdjustedEvV1Request {
  /**
   * Expected to be a `PackScoutBuybackEvInputV1`. Accepted as `unknown` for
   * defense-in-depth; the strict contract schema is safe-parsed first.
   */
  readonly input: unknown;
  /**
   * Caller-supplied canonical UTC millisecond timestamp
   * (`YYYY-MM-DDTHH:mm:ss.sssZ`). Keeps the calculation pure and
   * reproducible; a non-canonical clock is a caller configuration error.
   */
  readonly calculatedAt: string;
}

export class PackScoutBuybackAdjustedEvConfigurationError extends Error {
  readonly code = "INVALID_CALCULATED_AT";

  constructor() {
    super(
      "PackScout buyback-adjusted EV requires a canonical UTC millisecond calculation timestamp.",
    );
    this.name = "PackScoutBuybackAdjustedEvConfigurationError";
  }
}

/** Signals that exact weighting exceeded the deterministic work ceiling. */
class ExactArithmeticOverflowError extends Error {
  constructor() {
    super("PackScout buyback-adjusted EV exact arithmetic overflowed.");
    this.name = "ExactArithmeticOverflowError";
  }
}

/** Exact rational with a strictly positive denominator; sign on numerator. */
interface ExactRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const ZERO_RATIONAL: ExactRational = { numerator: 0n, denominator: 1n };
const BASIS_POINT_SCALE = 10_000n;
const MAX_CANONICAL_USD_CENTS = BigInt(
  PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS,
);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

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

function magnitudeBitLength(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  return magnitude === 0n ? 0 : magnitude.toString(2).length;
}

function exactRational(numerator: bigint, denominator: bigint): ExactRational {
  const divisor = greatestCommonDivisor(numerator, denominator);
  const reduced: ExactRational =
    divisor === 0n
      ? { numerator: 0n, denominator: 1n }
      : { numerator: numerator / divisor, denominator: denominator / divisor };
  if (
    magnitudeBitLength(reduced.numerator) >
      PACKSCOUT_BUYBACK_ADJUSTED_EV_MAX_ACCUMULATOR_BITS ||
    magnitudeBitLength(reduced.denominator) >
      PACKSCOUT_BUYBACK_ADJUSTED_EV_MAX_ACCUMULATOR_BITS
  ) {
    throw new ExactArithmeticOverflowError();
  }
  return reduced;
}

function addExact(left: ExactRational, right: ExactRational): ExactRational {
  return exactRational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtractExact(
  left: ExactRational,
  right: ExactRational,
): ExactRational {
  return exactRational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiplyExact(
  left: ExactRational,
  right: ExactRational,
): ExactRational {
  return exactRational(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

function compareExact(left: ExactRational, right: ExactRational): number {
  const leftScaled = left.numerator * right.denominator;
  const rightScaled = right.numerator * left.denominator;
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

/** Rounds a non-negative exact rational half-up to an integer. */
function roundNonNegativeHalfUp(value: ExactRational): bigint {
  return (value.numerator * 2n + value.denominator) / (value.denominator * 2n);
}

function canonicalCents(
  evidence: PackScoutBuybackEvMoneyEvidenceV1,
): ExactRational {
  return exactRational(
    BigInt(evidence.canonicalUsdCents.numerator),
    BigInt(evidence.canonicalUsdCents.denominator),
  );
}

/**
 * The representative supported stated value: the exact canonical value, or
 * the arithmetic midpoint of the two canonical rational bounds for a
 * complete closed range.
 */
function representativeStatedValue(
  statedValue: PackScoutBuybackEvOutcomeV1["statedValue"],
): ExactRational {
  if (statedValue.kind === "exact") {
    return canonicalCents(statedValue.amount);
  }
  return multiplyExact(
    addExact(
      canonicalCents(statedValue.lower),
      canonicalCents(statedValue.upper),
    ),
    exactRational(1n, 2n),
  );
}

/**
 * Applies the contract payout order to a rate basis:
 * rated_offer -> percentage_fee -> fixed_fee -> zero_clamp -> floor -> cap.
 */
function ratedGuaranteedPayout(
  representativeValue: ExactRational,
  terms: PackScoutBuybackEvRateTermsV1,
): ExactRational {
  const ratedOffer = multiplyExact(
    representativeValue,
    exactRational(BigInt(terms.rateBasisPoints), BASIS_POINT_SCALE),
  );
  const afterPercentageFee = multiplyExact(
    ratedOffer,
    exactRational(
      BASIS_POINT_SCALE - BigInt(terms.percentageFeeBasisPoints),
      BASIS_POINT_SCALE,
    ),
  );
  const afterFixedFee = subtractExact(
    afterPercentageFee,
    canonicalCents(terms.fixedFee),
  );
  const zeroClamped =
    afterFixedFee.numerator < 0n ? ZERO_RATIONAL : afterFixedFee;
  const floored =
    terms.floor === null
      ? zeroClamped
      : compareExact(zeroClamped, canonicalCents(terms.floor)) < 0
        ? canonicalCents(terms.floor)
        : zeroClamped;
  return terms.cap === null
    ? floored
    : compareExact(floored, canonicalCents(terms.cap)) > 0
      ? canonicalCents(terms.cap)
      : floored;
}

function finalGuaranteedPayout(
  outcome: PackScoutBuybackEvOutcomeV1,
  representativeValue: ExactRational,
  uniformTerms: PackScoutBuybackEvRateTermsV1 | null,
): ExactRational {
  if (outcome.buyback.eligibility === "ineligible") {
    return ZERO_RATIONAL;
  }
  const payout = outcome.buyback.payout;
  if (payout.kind === "exact_final_payout") {
    // A source value already expressed as the final buyback payout is used
    // as-is and never rate- or fee-adjusted again.
    return canonicalCents(payout.amount);
  }
  if (payout.kind === "outcome_specific_rate") {
    return ratedGuaranteedPayout(representativeValue, payout.terms);
  }
  if (uniformTerms === null) {
    // Unreachable: the strict input contract rejects a product-uniform-rate
    // reference without documented uniform terms.
    throw new Error(
      "PackScout buyback-adjusted EV requires documented uniform terms for a uniform-rate outcome.",
    );
  }
  return ratedGuaranteedPayout(representativeValue, uniformTerms);
}

interface SchemaIssueView {
  readonly message: string;
  readonly path: ReadonlyArray<PropertyKey>;
}

const REASON_BY_CONTRACT_MESSAGE: ReadonlyMap<
  string,
  PackScoutBuybackEvInternalReasonCodeV1
> = new Map([
  ["packscout_buyback_ev.pack_price_not_positive_usd_cents", "INVALID_PRICE"],
  ["packscout_buyback_ev.parity_window_invalid", "EXPIRED_PARITY_APPROVAL"],
  [
    "packscout_buyback_ev.parity_not_effective_at_observation",
    "EXPIRED_PARITY_APPROVAL",
  ],
  [
    "packscout_buyback_ev.currency_normalization_mismatch",
    "UNSUPPORTED_CURRENCY",
  ],
  ["packscout_buyback_ev.usd_direct_invalid", "UNSUPPORTED_CURRENCY"],
  ["packscout_buyback_ev.stablecoin_parity_mismatch", "UNSUPPORTED_CURRENCY"],
  ["packscout_buyback_ev.rational_not_reduced", "UNSUPPORTED_CURRENCY"],
  [
    "packscout_buyback_ev.probability_coverage_incomplete",
    "INCOMPLETE_PROBABILITIES",
  ],
  ["packscout_buyback_ev.probability_above_one", "INCOMPLETE_PROBABILITIES"],
  ["packscout_buyback_ev.probability_not_reduced", "INCOMPLETE_PROBABILITIES"],
  ["packscout_buyback_ev.value_range_not_increasing", "INVALID_VALUE_RANGE"],
  ["packscout_buyback_ev.floor_above_cap", "INVALID_BUYBACK_TERMS"],
  ["packscout_buyback_ev.uniform_rate_missing", "MISSING_BUYBACK"],
  ["packscout_buyback_ev.uniform_rate_unused", "INVALID_BUYBACK_TERMS"],
  ["packscout_buyback_ev.outcomes_not_canonical", "NON_ATOMIC_OBSERVATION"],
  ["packscout_buyback_ev.odds_comparison_outside_tolerance", "ODDS_CONFLICT"],
  ["packscout_buyback_ev.current_pool_priority_invalid", "ODDS_CONFLICT"],
  ["packscout_buyback_ev.timestamp_not_canonical", "MISSING_SOURCE_TIME"],
]);

/**
 * Deterministic mapping from one strict-schema rejection issue to an
 * internal unavailable reason. Rules apply in order:
 *
 * 1. An exact contract refinement message maps directly (see
 *    `REASON_BY_CONTRACT_MESSAGE`).
 * 2. A terminal path segment of `precision` maps to
 *    `UNSUPPORTED_MONEY_PRECISION`; `currency` maps to
 *    `UNSUPPORTED_CURRENCY`.
 * 3. The leading path segment routes structurally: `product` ->
 *    `MISSING_PRODUCT_IDENTITY`, `observation` -> `MISSING_PROVENANCE`,
 *    `packPrice` -> `INVALID_PRICE`, `unitBasis` ->
 *    `AMBIGUOUS_DRAW_SEMANTICS`, `oddsEvidence` ->
 *    `INCOMPLETE_PROBABILITIES`, `uniformBuybackRate` ->
 *    `INVALID_BUYBACK_TERMS`, `currencyEvidence` ->
 *    `EXPIRED_PARITY_APPROVAL`. Under `outcomes`, a `probability` segment
 *    maps to `INCOMPLETE_PROBABILITIES`, `representation` to
 *    `HETEROGENEOUS_OUTCOME_BUCKET`, `statedValue` to `INCOMPLETE_VALUES`,
 *    and `buyback` to `INVALID_BUYBACK_TERMS` under `payout`,
 *    `UNKNOWN_BUYBACK_ELIGIBILITY` under `eligibility`, or
 *    `MISSING_BUYBACK` otherwise; any other `outcomes` issue maps to
 *    `INCOMPLETE_VALUES`.
 * 4. Anything else (root shape, version literals, unrecognized keys) adds
 *    no specific reason; the base `MISSING_PROVENANCE` and
 *    `MISSING_SOURCE_TIME` reasons that accompany every schema rejection
 *    stand alone.
 */
export function packScoutBuybackAdjustedEvReasonForSchemaIssueV1(
  issue: SchemaIssueView,
): PackScoutBuybackEvInternalReasonCodeV1 | null {
  const messageMapped = REASON_BY_CONTRACT_MESSAGE.get(issue.message);
  if (messageMapped !== undefined) {
    return messageMapped;
  }
  const segments = issue.path.map((segment) => String(segment));
  const lastSegment = segments[segments.length - 1];
  if (lastSegment === "precision") {
    return "UNSUPPORTED_MONEY_PRECISION";
  }
  if (lastSegment === "currency") {
    return "UNSUPPORTED_CURRENCY";
  }
  switch (segments[0]) {
    case "product":
      return "MISSING_PRODUCT_IDENTITY";
    case "observation":
      return "MISSING_PROVENANCE";
    case "packPrice":
      return "INVALID_PRICE";
    case "unitBasis":
      return "AMBIGUOUS_DRAW_SEMANTICS";
    case "oddsEvidence":
      return "INCOMPLETE_PROBABILITIES";
    case "uniformBuybackRate":
      return "INVALID_BUYBACK_TERMS";
    case "currencyEvidence":
      return "EXPIRED_PARITY_APPROVAL";
    case "outcomes":
      if (segments.includes("probability")) {
        return "INCOMPLETE_PROBABILITIES";
      }
      if (segments.includes("representation")) {
        return "HETEROGENEOUS_OUTCOME_BUCKET";
      }
      if (segments.includes("statedValue")) {
        return "INCOMPLETE_VALUES";
      }
      if (segments.includes("buyback")) {
        if (segments.includes("payout")) {
          return "INVALID_BUYBACK_TERMS";
        }
        if (segments.includes("eligibility")) {
          return "UNKNOWN_BUYBACK_ELIGIBILITY";
        }
        return "MISSING_BUYBACK";
      }
      return "INCOMPLETE_VALUES";
    default:
      return null;
  }
}

type CalculationDataAsOf =
  | { readonly state: "known"; readonly observedAt: string }
  | { readonly state: "unknown_source_time"; readonly observedAt: null };

interface UnavailableConstruction {
  readonly calculatedAt: string;
  readonly reasons: readonly PackScoutBuybackEvInternalReasonCodeV1[];
  readonly dataAsOf: CalculationDataAsOf;
  readonly provenance: PackScoutBuybackEvProtectedProvenanceV1 | null;
  readonly oddsSource:
    | "current_remaining_inventory"
    | "platform_published"
    | null;
  readonly usedClosedRangeMidpoint: boolean;
  readonly oldestEssentialObservedAt: string | null;
}

function unavailableResult(
  construction: UnavailableConstruction,
): PackScoutBuybackEvProtectedCalculationResultV1 {
  const internalReasons = [
    ...canonicalizePackScoutBuybackEvInternalReasonsV1(construction.reasons),
  ];
  return {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "unavailable",
    grossEvMoney: null,
    grossReturnBasisPoints: null,
    evDollars: null,
    evPercentBasisPoints: null,
    calculatedAt: construction.calculatedAt,
    dataAsOf: construction.dataAsOf,
    provenance: construction.provenance,
    protectedEvidence: null,
    confidenceInput: {
      schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
      oddsSource: construction.oddsSource,
      usedClosedRangeMidpoint: construction.usedClosedRangeMidpoint,
      oldestEssentialObservedAt: construction.oldestEssentialObservedAt,
      calculatedAt: construction.calculatedAt,
      availabilityGate: {
        status: "failed",
        internalReasons: [...internalReasons],
      },
    },
    internalReasons,
    publicPrimaryReason:
      packScoutBuybackEvPublicReasonForInternalReasonsV1(internalReasons),
  };
}

function buildProvenance(
  input: PackScoutBuybackEvInputV1,
): PackScoutBuybackEvProtectedProvenanceV1 {
  return {
    providerKey: input.observation.providerKey,
    productKey: input.product.productKey,
    productRevisionId: input.product.productRevisionId,
    sourceRevisionId: input.observation.sourceRevisionId,
    sourceManifestSha256: input.observation.sourceManifestSha256,
    observationCoherence: input.observation.coherenceKind,
    oddsSource: input.oddsEvidence.sourceKind,
    usedClosedRangeMidpoint: input.outcomes.some(
      (outcome) => outcome.statedValue.kind === "closed_range",
    ),
  };
}

/**
 * Converts one complete canonical evidence snapshot into exact
 * buyback-adjusted metrics, or a constrained unavailable result. See the
 * module documentation for the full method and unavailable-mapping policy.
 *
 * @throws PackScoutBuybackAdjustedEvConfigurationError when the supplied
 * calculation clock is not a canonical UTC millisecond timestamp.
 */
export function calculatePackScoutBuybackAdjustedEvV1(
  request: CalculatePackScoutBuybackAdjustedEvV1Request,
): PackScoutBuybackEvProtectedCalculationResultV1 {
  const calculatedAtMillis = parsePackScoutBuybackEvTimestampMillisV1(
    request.calculatedAt,
  );
  if (calculatedAtMillis === null) {
    throw new PackScoutBuybackAdjustedEvConfigurationError();
  }

  const parsed = packScoutBuybackEvInputV1Schema.safeParse(request.input);
  if (!parsed.success) {
    return unavailableResult({
      calculatedAt: request.calculatedAt,
      reasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        ...parsed.error.issues.flatMap((issue) => {
          const reason = packScoutBuybackAdjustedEvReasonForSchemaIssueV1(issue);
          return reason === null ? [] : [reason];
        }),
      ],
      dataAsOf: { state: "unknown_source_time", observedAt: null },
      provenance: null,
      oddsSource: null,
      usedClosedRangeMidpoint: false,
      oldestEssentialObservedAt: null,
    });
  }

  const input = parsed.data;
  const provenance = buildProvenance(input);
  const observedAt = input.observation.observedAt;
  const observedAtMillis = parsePackScoutBuybackEvTimestampMillisV1(observedAt);
  if (observedAtMillis === null || calculatedAtMillis < observedAtMillis) {
    // An observation later than the calculation clock has no usable source
    // time; fail closed instead of calculating against an incoherent clock.
    return unavailableResult({
      calculatedAt: request.calculatedAt,
      reasons: ["MISSING_SOURCE_TIME"],
      dataAsOf: { state: "unknown_source_time", observedAt: null },
      provenance,
      oddsSource: provenance.oddsSource,
      usedClosedRangeMidpoint: provenance.usedClosedRangeMidpoint,
      oldestEssentialObservedAt: null,
    });
  }

  const drawMultiplier =
    input.unitBasis.kind === "per_draw" ? input.unitBasis.drawCount : 1;
  const uniformTerms =
    input.uniformBuybackRate === null ? null : input.uniformBuybackRate.terms;

  const arithmeticOverflow = (): PackScoutBuybackEvProtectedCalculationResultV1 =>
    unavailableResult({
      calculatedAt: request.calculatedAt,
      reasons: ["ARITHMETIC_OVERFLOW"],
      dataAsOf: { state: "known", observedAt },
      provenance,
      oddsSource: provenance.oddsSource,
      usedClosedRangeMidpoint: provenance.usedClosedRangeMidpoint,
      oldestEssentialObservedAt: observedAt,
    });

  let underlyingCents: bigint;
  let grossCents: bigint;
  try {
    let underlyingSum = ZERO_RATIONAL;
    let grossSum = ZERO_RATIONAL;
    for (const outcome of input.outcomes) {
      const probability = exactRational(
        BigInt(outcome.probability.numerator),
        BigInt(outcome.probability.denominator),
      );
      const representativeValue = representativeStatedValue(
        outcome.statedValue,
      );
      underlyingSum = addExact(
        underlyingSum,
        multiplyExact(probability, representativeValue),
      );
      grossSum = addExact(
        grossSum,
        multiplyExact(
          probability,
          finalGuaranteedPayout(outcome, representativeValue, uniformTerms),
        ),
      );
    }
    const multiplier = exactRational(BigInt(drawMultiplier), 1n);
    underlyingCents = roundNonNegativeHalfUp(
      multiplyExact(underlyingSum, multiplier),
    );
    grossCents = roundNonNegativeHalfUp(multiplyExact(grossSum, multiplier));
  } catch (error) {
    if (error instanceof ExactArithmeticOverflowError) {
      return arithmeticOverflow();
    }
    throw error;
  }

  // The strict input contract guarantees a positive integer USD cent price.
  const packPriceCents = BigInt(input.packPrice.canonicalUsdCents.numerator);
  const grossReturnBasisPoints =
    (grossCents * BASIS_POINT_SCALE * 2n + packPriceCents) /
    (packPriceCents * 2n);
  if (
    underlyingCents > MAX_CANONICAL_USD_CENTS ||
    grossCents > MAX_CANONICAL_USD_CENTS ||
    grossReturnBasisPoints > MAX_SAFE_INTEGER
  ) {
    return arithmeticOverflow();
  }

  return {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "available",
    grossEvMoney: { minorUnits: Number(grossCents), currency: "USD" },
    grossReturnBasisPoints: Number(grossReturnBasisPoints),
    evDollars: {
      minorUnits: Number(grossCents - packPriceCents),
      currency: "USD",
    },
    evPercentBasisPoints: Number(grossReturnBasisPoints - BASIS_POINT_SCALE),
    calculatedAt: request.calculatedAt,
    dataAsOf: { state: "known", observedAt },
    provenance,
    protectedEvidence: {
      packPriceMoney: { minorUnits: Number(packPriceCents), currency: "USD" },
      underlyingOutcomeEvMoney: {
        minorUnits: Number(underlyingCents),
        currency: "USD",
      },
      drawMultiplier,
      acceptedProbabilityCoverage: "within_one_part_per_million",
      probabilityToleranceDenominator:
        PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
      probabilityWasRenormalized: false,
      payoutFormula: PACKSCOUT_BUYBACK_EV_FORMULAS_V1.grossEv,
      payoutOrder: [...PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1],
    },
    confidenceInput: {
      schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
      oddsSource: provenance.oddsSource,
      usedClosedRangeMidpoint: provenance.usedClosedRangeMidpoint,
      oldestEssentialObservedAt: observedAt,
      calculatedAt: request.calculatedAt,
      availabilityGate: { status: "passed" },
    },
  };
}
