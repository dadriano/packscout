import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS,
  PACKSCOUT_BUYBACK_EV_MAX_DRAW_COUNT,
  PACKSCOUT_BUYBACK_EV_MAX_OUTCOMES,
  PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR,
  PACKSCOUT_BUYBACK_EV_MAX_SOURCE_PRECISION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  canonicalizePackScoutBuybackEvInternalReasonsV1,
  isPackScoutBuybackEvProbabilityCoverageCompleteV1,
  packScoutBuybackEvEvidenceOutcomeV1Schema,
  packScoutBuybackEvInputV1Schema,
  packScoutBuybackEvOutcomeKeyV1Schema,
  packScoutBuybackEvProductKeyV1Schema,
  packScoutBuybackEvProviderKeyV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  packScoutBuybackEvSha256V1Schema,
  packScoutBuybackEvSourceRevisionV1Schema,
  type PackScoutBuybackEvEvidenceOutcomeV1,
  type PackScoutBuybackEvInputV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
  type PackScoutBuybackEvMoneyEvidenceV1,
  type PackScoutBuybackEvOutcomeV1,
  type PackScoutBuybackEvProbabilityV1,
  type PackScoutBuybackEvRateTermsV1,
} from "@packscout/contracts";

/**
 * Shared normalization semantics for buyback-adjusted PackScout EV evidence.
 *
 * Provider modules interpret their own sanitized source revisions into the
 * provider-neutral claim vocabulary below. This module applies one common
 * rulebook — money normalization, current-pool odds priority, value-range
 * handling, buyback payout vocabulary, bucket homogeneity, draw semantics, and
 * observation coherence — and returns either a complete
 * `PackScoutBuybackEvInputV1` or canonical unavailable evidence. It never
 * branches on provider identity.
 */

// ---------------------------------------------------------------------------
// Capability matrix vocabulary
// ---------------------------------------------------------------------------

export const PACKSCOUT_BUYBACK_EV_CAPABILITY_KEYS_V1 = Object.freeze([
  "packPrice",
  "priceCurrency",
  "unitBasis",
  "drawCount",
  "productIdentity",
  "sourceRevision",
  "observationTime",
  "exactStatedValues",
  "closedRangeStatedValues",
  "finalPayoutValues",
  "uniformBuybackRate",
  "outcomeSpecificBuybackRates",
  "fixedGuaranteedOffers",
  "buybackEligibility",
  "mandatoryFees",
  "payoutCaps",
  "payoutFloors",
] as const);

export type PackScoutBuybackEvCapabilityKeyV1 =
  (typeof PACKSCOUT_BUYBACK_EV_CAPABILITY_KEYS_V1)[number];

export type PackScoutBuybackEvCapabilitySupportV1 =
  | "supported"
  | "unsupported";

export type PackScoutBuybackEvOddsCapabilityV1 =
  | "complete_current_remaining_inventory"
  | "complete_platform_published"
  | "unavailable";

export type PackScoutBuybackEvSourceValueBasisV1 =
  | "stated_collectible_value"
  | "final_guaranteed_payout";

export interface PackScoutBuybackEvProviderCapabilityProfileV1 {
  readonly providerKey: string;
  readonly capabilities: Readonly<
    Record<PackScoutBuybackEvCapabilityKeyV1, PackScoutBuybackEvCapabilitySupportV1>
  >;
  readonly oddsClassification: PackScoutBuybackEvOddsCapabilityV1;
  readonly sourceValueBasis: PackScoutBuybackEvSourceValueBasisV1;
}

// ---------------------------------------------------------------------------
// Sanitized claim vocabulary (provider-neutral evidence draft)
// ---------------------------------------------------------------------------

export interface PackScoutBuybackEvMoneyClaimV1 {
  readonly minorUnits: number;
  readonly currency: string;
  readonly precision: number;
}

export type PackScoutBuybackEvStatedValueClaimV1 =
  | { readonly kind: "exact"; readonly amount: PackScoutBuybackEvMoneyClaimV1 }
  | {
      readonly kind: "closed_range";
      readonly lower: PackScoutBuybackEvMoneyClaimV1;
      readonly upper: PackScoutBuybackEvMoneyClaimV1;
    }
  | { readonly kind: "open_ended_range" }
  | { readonly kind: "missing" };

export interface PackScoutBuybackEvRateTermsClaimV1 {
  readonly rateBasisPoints: number;
  readonly percentageFeeBasisPoints: number;
  readonly fixedFee: PackScoutBuybackEvMoneyClaimV1 | null;
  readonly floor: PackScoutBuybackEvMoneyClaimV1 | null;
  readonly cap: PackScoutBuybackEvMoneyClaimV1 | null;
}

export type PackScoutBuybackEvUniformRateClaimV1 =
  | { readonly kind: "none_documented" }
  | {
      readonly kind: "documented";
      readonly scope: "every_eligible_outcome" | "undocumented_scope";
      readonly terms: PackScoutBuybackEvRateTermsClaimV1;
    }
  | { readonly kind: "conditional_terms" }
  | { readonly kind: "unsupported_terms" };

export type PackScoutBuybackEvOutcomeBuybackClaimV1 =
  | { readonly kind: "unknown_eligibility" }
  | { readonly kind: "explicitly_ineligible" }
  | { readonly kind: "defer_to_product_terms" }
  | {
      readonly kind: "outcome_specific_rate";
      readonly terms: PackScoutBuybackEvRateTermsClaimV1;
    }
  | {
      readonly kind: "fixed_guaranteed_offer";
      readonly amount: PackScoutBuybackEvMoneyClaimV1;
    }
  | {
      readonly kind: "documented_final_payout";
      readonly amount: PackScoutBuybackEvMoneyClaimV1;
    }
  | { readonly kind: "reflected_in_value" }
  | { readonly kind: "conditional_terms" };

export type PackScoutBuybackEvRepresentationClaimV1 =
  | { readonly kind: "atomic_outcome" }
  | {
      readonly kind: "aggregate_bucket";
      readonly memberCount: number | null;
      readonly eligibilityHomogeneity: "verified_same" | "unverified" | "mixed";
      readonly payoutFunctionHomogeneity:
        | "verified_same"
        | "unverified"
        | "mixed";
      readonly homogeneityEvidenceSha256: string | null;
    };

export interface PackScoutBuybackEvOutcomeClaimV1 {
  readonly outcomeKey: string;
  readonly representation: PackScoutBuybackEvRepresentationClaimV1;
  readonly valueBasis: PackScoutBuybackEvSourceValueBasisV1;
  readonly statedValue: PackScoutBuybackEvStatedValueClaimV1;
  readonly buyback: PackScoutBuybackEvOutcomeBuybackClaimV1;
}

export interface PackScoutBuybackEvRationalClaimV1 {
  readonly numerator: number;
  readonly denominator: number;
}

export interface PackScoutBuybackEvCurrentPoolClaimV1 {
  readonly completeness: "complete" | "partial";
  readonly snapshotAtomicity: "atomic" | "assembled_without_proof";
  readonly countsStability: "stable" | "changed_during_collection";
  readonly remainingUnits: readonly {
    readonly outcomeKey: string;
    readonly units: number;
  }[];
}

export interface PackScoutBuybackEvPublishedOddsClaimV1 {
  readonly entries: readonly {
    readonly outcomeKey: string;
    readonly probability: PackScoutBuybackEvRationalClaimV1;
  }[];
  readonly documentedRoundingPrecisionPartsPerMillion: number;
  readonly revisionAgreement:
    | "same_source_revision"
    | "different_or_unproven_revision";
}

export type PackScoutBuybackEvOddsClaimV1 =
  | {
      readonly poolKind: "finite";
      readonly currentPool: PackScoutBuybackEvCurrentPoolClaimV1 | null;
      readonly published: PackScoutBuybackEvPublishedOddsClaimV1 | null;
    }
  | {
      readonly poolKind: "non_finite";
      readonly published: PackScoutBuybackEvPublishedOddsClaimV1 | null;
    }
  | { readonly poolKind: "unknown" };

export type PackScoutBuybackEvObservationClaimV1 = {
  readonly providerKey: string;
  readonly sourceRevisionId: string | null;
  readonly sourceManifestSha256: string | null;
  readonly observedAt: string | null;
  readonly coherence:
    | { readonly kind: "provider_revision" }
    | {
        readonly kind: "guarded_collection";
        readonly collectionGuardSha256: string;
      }
    | { readonly kind: "timestamp_coincidence" };
} | null;

export type PackScoutBuybackEvUnitBasisClaimV1 =
  | { readonly kind: "per_pack" }
  | { readonly kind: "per_draw"; readonly drawCount: number }
  | { readonly kind: "ambiguous" };

export interface PackScoutBuybackEvEvidenceDraftV1 {
  readonly observation: PackScoutBuybackEvObservationClaimV1;
  readonly product: {
    readonly productKey: string;
    readonly productRevisionId: string;
  } | null;
  readonly packPrice: PackScoutBuybackEvMoneyClaimV1 | null;
  readonly unitBasis: PackScoutBuybackEvUnitBasisClaimV1;
  readonly odds: PackScoutBuybackEvOddsClaimV1;
  readonly uniformBuybackRate: PackScoutBuybackEvUniformRateClaimV1;
  readonly outcomes: readonly PackScoutBuybackEvOutcomeClaimV1[];
}

export interface PackScoutBuybackEvStablecoinParityApprovalClaimV1 {
  readonly currency: string;
  readonly parityNumerator: 1;
  readonly parityDenominator: 1;
  readonly effectiveAt: string;
  readonly expiresAt: string;
  readonly configurationRevision: string;
}

export interface PackScoutBuybackEvEvidenceContextV1 {
  readonly evaluatedAt: string;
  readonly stablecoinParityApprovals: readonly PackScoutBuybackEvStablecoinParityApprovalClaimV1[];
}

// ---------------------------------------------------------------------------
// Deterministic parsing helpers shared by provider modules
// ---------------------------------------------------------------------------

const DECIMAL_TEXT_PATTERN = /^(-?)(\d{1,15})(?:\.(\d{1,15}))?$/u;
const CURRENCY_CODE_PATTERN = /^[A-Z0-9]{2,12}$/u;

/** Bound and lowercase a sanitized source identifier, or reject it. */
export function packScoutBuybackEvSanitizedIdentifierV1(
  value: string | null | undefined,
  maxLength = 100,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

/** Build a bounded outcome key from a source label, or use the fallback. */
export function packScoutBuybackEvOutcomeKeyFromLabelV1(
  label: string | null | undefined,
  fallback: string,
): string {
  const slug = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 120);
  const candidate = slug.length > 0 ? slug : fallback;
  return packScoutBuybackEvOutcomeKeyV1Schema.safeParse(candidate).success
    ? candidate
    : fallback;
}

function scaledIntegerFromDecimalText(
  value: string,
  precision: number,
): number | null {
  const normalized = value.trim().replace(/^\$/u, "").replaceAll(",", "");
  const match = DECIMAL_TEXT_PATTERN.exec(normalized);
  if (match === null) return null;
  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > precision) return null;
  const scaled =
    BigInt(whole) * 10n ** BigInt(precision) +
    BigInt(fraction.padEnd(precision, "0") || "0");
  const signed = sign === "-" ? -scaled : scaled;
  const numeric = Number(signed);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/** Parse a provider decimal string (optional `$`/commas) at a precision. */
export function packScoutBuybackEvMoneyClaimFromDecimalTextV1(
  value: string | null | undefined,
  currency: string,
  precision: number,
): PackScoutBuybackEvMoneyClaimV1 | null {
  if (typeof value !== "string") return null;
  const minorUnits = scaledIntegerFromDecimalText(value, precision);
  return minorUnits === null ? null : { minorUnits, currency, precision };
}

/** Convert a provider-reported major-unit number without rounding. */
export function packScoutBuybackEvMoneyClaimFromNumberV1(
  value: number | null | undefined,
  currency: string,
  precision: number,
): PackScoutBuybackEvMoneyClaimV1 | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return packScoutBuybackEvMoneyClaimFromDecimalTextV1(
    String(value),
    currency,
    precision,
  );
}

/** Wrap a provider-reported minor-unit integer amount. */
export function packScoutBuybackEvMoneyClaimFromMinorUnitsV1(
  value: number | null | undefined,
  currency: string,
  precision: number,
): PackScoutBuybackEvMoneyClaimV1 | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return { minorUnits: value, currency, precision };
}

function reducedRational(
  numerator: bigint,
  denominator: bigint,
): PackScoutBuybackEvRationalClaimV1 | null {
  if (denominator <= 0n || numerator < 0n) return null;
  let left = numerator;
  let right = denominator;
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  const divisor = left === 0n ? 1n : left;
  const reducedNumerator = Number(numerator / divisor);
  const reducedDenominator = Number(denominator / divisor);
  return Number.isSafeInteger(reducedNumerator) &&
      Number.isSafeInteger(reducedDenominator)
    ? { numerator: reducedNumerator, denominator: reducedDenominator }
    : null;
}

/** Parse `"25.00"`-style percent text into a reduced probability rational. */
export function packScoutBuybackEvProbabilityFromPercentTextV1(
  value: string | null | undefined,
): PackScoutBuybackEvRationalClaimV1 | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_TEXT_PATTERN.exec(value.trim());
  if (match === null || match[1] === "-") return null;
  const [, , whole, fraction = ""] = match;
  return reducedRational(
    BigInt(whole + fraction),
    10n ** BigInt(fraction.length) * 100n,
  );
}

/** Parse a percent number (for example `25` or `0.13`) into a probability. */
export function packScoutBuybackEvProbabilityFromPercentNumberV1(
  value: number | null | undefined,
): PackScoutBuybackEvRationalClaimV1 | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return packScoutBuybackEvProbabilityFromPercentTextV1(String(value));
}

/** Parse a ratio number (for example `0.25`) into a probability rational. */
export function packScoutBuybackEvProbabilityFromRatioNumberV1(
  value: number | null | undefined,
): PackScoutBuybackEvRationalClaimV1 | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const match = DECIMAL_TEXT_PATTERN.exec(String(value));
  if (match === null || match[1] === "-") return null;
  const [, , whole, fraction = ""] = match;
  return reducedRational(
    BigInt(whole + fraction),
    10n ** BigInt(fraction.length),
  );
}

/** Convert a documented ratio (for example `0.85`) to exact basis points. */
export function packScoutBuybackEvBasisPointsFromRatioNumberV1(
  value: number | null | undefined,
): number | null {
  const rational = packScoutBuybackEvProbabilityFromRatioNumberV1(value);
  if (rational === null) return null;
  const scaled = rational.numerator * 10_000;
  return scaled % rational.denominator === 0
    ? scaled / rational.denominator
    : null;
}

/** Convert a documented percent (text or number) to exact basis points. */
export function packScoutBuybackEvBasisPointsFromPercentV1(
  value: string | number | null | undefined,
): number | null {
  const rational =
    typeof value === "number"
      ? packScoutBuybackEvProbabilityFromPercentNumberV1(value)
      : packScoutBuybackEvProbabilityFromPercentTextV1(value);
  if (rational === null) return null;
  const scaled = rational.numerator * 10_000;
  return scaled % rational.denominator === 0
    ? scaled / rational.denominator
    : null;
}

/** Canonicalize an ISO-8601 timestamp to the contract millisecond format. */
export function packScoutBuybackEvCanonicalTimestampV1(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

// ---------------------------------------------------------------------------
// Shared finalization
// ---------------------------------------------------------------------------

type InternalReason = PackScoutBuybackEvInternalReasonCodeV1;
type MoneyRole = "price" | "value" | "terms";

const MONEY_ROLE_INVALID_REASON: Readonly<Record<MoneyRole, InternalReason>> =
  Object.freeze({
    price: "INVALID_PRICE",
    value: "INVALID_VALUE_RANGE",
    terms: "INVALID_BUYBACK_TERMS",
  });

const ZERO_USD_CLAIM: PackScoutBuybackEvMoneyClaimV1 = Object.freeze({
  minorUnits: 0,
  currency: "USD",
  precision: 2,
});

interface Normalizer {
  readonly reasons: Set<InternalReason>;
  readonly context: PackScoutBuybackEvEvidenceContextV1;
  readonly observedAtMillis: number | null;
}

function addReason(normalizer: Normalizer, reason: InternalReason): void {
  normalizer.reasons.add(reason);
}

function compareCanonicalCents(
  left: PackScoutBuybackEvRationalClaimV1,
  right: PackScoutBuybackEvRationalClaimV1,
): number {
  const leftScaled = BigInt(left.numerator) * BigInt(right.denominator);
  const rightScaled = BigInt(right.numerator) * BigInt(left.denominator);
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function normalizeMoneyClaim(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvMoneyClaimV1,
  role: MoneyRole,
): PackScoutBuybackEvMoneyEvidenceV1 | null {
  if (!Number.isSafeInteger(claim.minorUnits) || claim.minorUnits < 0) {
    addReason(normalizer, MONEY_ROLE_INVALID_REASON[role]);
    return null;
  }
  if (
    !Number.isInteger(claim.precision) ||
    claim.precision < 0 ||
    claim.precision > PACKSCOUT_BUYBACK_EV_MAX_SOURCE_PRECISION
  ) {
    addReason(normalizer, "UNSUPPORTED_MONEY_PRECISION");
    return null;
  }
  if (!CURRENCY_CODE_PATTERN.test(claim.currency)) {
    addReason(normalizer, "UNSUPPORTED_CURRENCY");
    return null;
  }
  let normalization: PackScoutBuybackEvMoneyEvidenceV1["normalization"];
  if (claim.currency === "USD") {
    if (claim.precision !== 2) {
      addReason(normalizer, "UNSUPPORTED_MONEY_PRECISION");
      return null;
    }
    normalization = { kind: "usd_direct" };
  } else {
    const approvals = normalizer.context.stablecoinParityApprovals.filter(
      (approval) => approval.currency === claim.currency,
    );
    if (approvals.length === 0) {
      addReason(normalizer, "UNSUPPORTED_CURRENCY");
      return null;
    }
    const effective =
      normalizer.observedAtMillis === null
        ? null
        : approvals.find(
            (approval) =>
              Date.parse(approval.effectiveAt) <= normalizer.observedAtMillis! &&
              normalizer.observedAtMillis! < Date.parse(approval.expiresAt),
          ) ?? null;
    if (normalizer.observedAtMillis !== null && effective === null) {
      addReason(normalizer, "EXPIRED_PARITY_APPROVAL");
      return null;
    }
    const approval = effective ?? approvals[0]!;
    normalization = {
      kind: "usd_equivalent_stablecoin",
      parity: {
        currency: approval.currency,
        parityNumerator: 1,
        parityDenominator: 1,
        effectiveAt: approval.effectiveAt,
        expiresAt: approval.expiresAt,
        configurationRevision: approval.configurationRevision,
      },
    };
  }
  const canonical = reducedRational(
    BigInt(claim.minorUnits) * 100n,
    10n ** BigInt(claim.precision),
  );
  if (
    canonical === null ||
    canonical.numerator > PACKSCOUT_BUYBACK_EV_MAX_CANONICAL_USD_CENTS ||
    canonical.denominator > PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR
  ) {
    addReason(normalizer, "ARITHMETIC_OVERFLOW");
    return null;
  }
  return {
    sourceAmount: {
      minorUnits: claim.minorUnits,
      currency: claim.currency,
      precision: claim.precision,
    },
    canonicalUsdCents: canonical,
    normalization,
  };
}

function normalizeRateTerms(
  normalizer: Normalizer,
  terms: PackScoutBuybackEvRateTermsClaimV1,
): PackScoutBuybackEvRateTermsV1 | null {
  const rateValid =
    Number.isInteger(terms.rateBasisPoints) &&
    terms.rateBasisPoints >= 0 &&
    terms.rateBasisPoints <= 10_000;
  const feeValid =
    Number.isInteger(terms.percentageFeeBasisPoints) &&
    terms.percentageFeeBasisPoints >= 0 &&
    terms.percentageFeeBasisPoints <= 10_000;
  if (!rateValid || !feeValid) {
    addReason(normalizer, "INVALID_BUYBACK_TERMS");
    return null;
  }
  const fixedFee = normalizeMoneyClaim(
    normalizer,
    terms.fixedFee ?? ZERO_USD_CLAIM,
    "terms",
  );
  const floor =
    terms.floor === null
      ? null
      : normalizeMoneyClaim(normalizer, terms.floor, "terms");
  const cap =
    terms.cap === null
      ? null
      : normalizeMoneyClaim(normalizer, terms.cap, "terms");
  if (
    fixedFee === null ||
    (terms.floor !== null && floor === null) ||
    (terms.cap !== null && cap === null)
  ) {
    return null;
  }
  if (
    floor !== null &&
    cap !== null &&
    compareCanonicalCents(floor.canonicalUsdCents, cap.canonicalUsdCents) > 0
  ) {
    addReason(normalizer, "INVALID_BUYBACK_TERMS");
    return null;
  }
  return {
    rateBasisPoints: terms.rateBasisPoints,
    percentageFeeBasisPoints: terms.percentageFeeBasisPoints,
    fixedFee,
    floor,
    cap,
  };
}

function normalizeStatedValue(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvStatedValueClaimV1,
): PackScoutBuybackEvOutcomeV1["statedValue"] | null {
  if (claim.kind === "missing") {
    addReason(normalizer, "INCOMPLETE_VALUES");
    return null;
  }
  if (claim.kind === "open_ended_range") {
    addReason(normalizer, "INVALID_VALUE_RANGE");
    return null;
  }
  if (claim.kind === "exact") {
    const amount = normalizeMoneyClaim(normalizer, claim.amount, "value");
    return amount === null ? null : { kind: "exact", amount };
  }
  if (claim.lower.currency !== claim.upper.currency) {
    addReason(normalizer, "MIXED_CURRENCY_BASIS");
    return null;
  }
  const lower = normalizeMoneyClaim(normalizer, claim.lower, "value");
  const upper = normalizeMoneyClaim(normalizer, claim.upper, "value");
  if (lower === null || upper === null) return null;
  const comparison = compareCanonicalCents(
    lower.canonicalUsdCents,
    upper.canonicalUsdCents,
  );
  if (comparison > 0) {
    addReason(normalizer, "INVALID_VALUE_RANGE");
    return null;
  }
  return comparison === 0
    ? { kind: "exact", amount: lower }
    : { kind: "closed_range", lower, upper };
}

function normalizeRepresentation(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvRepresentationClaimV1,
): PackScoutBuybackEvOutcomeV1["representation"] | null {
  if (claim.kind === "atomic_outcome") return { kind: "atomic_outcome" };
  if (
    claim.eligibilityHomogeneity !== "verified_same" ||
    claim.payoutFunctionHomogeneity !== "verified_same" ||
    claim.homogeneityEvidenceSha256 === null ||
    !packScoutBuybackEvSha256V1Schema.safeParse(
      claim.homogeneityEvidenceSha256,
    ).success
  ) {
    addReason(normalizer, "HETEROGENEOUS_OUTCOME_BUCKET");
    return null;
  }
  const memberCountKnown =
    claim.memberCount !== null &&
    Number.isInteger(claim.memberCount) &&
    claim.memberCount >= 1 &&
    claim.memberCount <= 100_000;
  return {
    kind: "homogeneous_bucket",
    memberCount: memberCountKnown
      ? { state: "known", value: claim.memberCount! }
      : { state: "not_published", value: null },
    eligibilityHomogeneity: "verified_same",
    payoutFunctionHomogeneity: "verified_same",
    homogeneityEvidenceSha256: claim.homogeneityEvidenceSha256,
  };
}

interface UniformRateResolution {
  readonly usable: boolean;
  readonly terms: PackScoutBuybackEvRateTermsV1 | null;
}

function resolveUniformRate(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvUniformRateClaimV1,
  deferringOutcomes: number,
): UniformRateResolution {
  if (deferringOutcomes === 0) return { usable: false, terms: null };
  switch (claim.kind) {
    case "none_documented":
      addReason(normalizer, "MISSING_BUYBACK");
      return { usable: false, terms: null };
    case "conditional_terms":
      addReason(normalizer, "CONDITIONAL_BUYBACK_TERMS");
      return { usable: false, terms: null };
    case "unsupported_terms":
      addReason(normalizer, "INVALID_BUYBACK_TERMS");
      return { usable: false, terms: null };
    case "documented": {
      if (claim.scope !== "every_eligible_outcome") {
        addReason(normalizer, "INVALID_BUYBACK_TERMS");
        return { usable: false, terms: null };
      }
      const terms = normalizeRateTerms(normalizer, claim.terms);
      return { usable: terms !== null, terms };
    }
  }
}

function normalizeOutcomeBuyback(
  normalizer: Normalizer,
  outcome: PackScoutBuybackEvOutcomeClaimV1,
  statedValue: PackScoutBuybackEvOutcomeV1["statedValue"] | null,
  uniform: UniformRateResolution,
): PackScoutBuybackEvOutcomeV1["buyback"] | null {
  const claim = outcome.buyback;
  if (outcome.valueBasis === "final_guaranteed_payout") {
    if (claim.kind !== "reflected_in_value") {
      addReason(normalizer, "INVALID_BUYBACK_TERMS");
      return null;
    }
    if (statedValue === null) return null;
    if (statedValue.kind !== "exact") {
      addReason(normalizer, "INVALID_BUYBACK_TERMS");
      return null;
    }
    return {
      eligibility: "eligible",
      payout: {
        kind: "exact_final_payout",
        evidenceKind: "documented_final_payout",
        amount: statedValue.amount,
      },
    };
  }
  switch (claim.kind) {
    case "reflected_in_value":
      addReason(normalizer, "INVALID_BUYBACK_TERMS");
      return null;
    case "unknown_eligibility":
      addReason(normalizer, "UNKNOWN_BUYBACK_ELIGIBILITY");
      return null;
    case "conditional_terms":
      addReason(normalizer, "CONDITIONAL_BUYBACK_TERMS");
      return null;
    case "explicitly_ineligible":
      return { eligibility: "ineligible", payout: null };
    case "defer_to_product_terms":
      return uniform.usable
        ? {
            eligibility: "eligible",
            payout: { kind: "product_uniform_rate" },
          }
        : null;
    case "outcome_specific_rate": {
      const terms = normalizeRateTerms(normalizer, claim.terms);
      return terms === null
        ? null
        : {
            eligibility: "eligible",
            payout: { kind: "outcome_specific_rate", terms },
          };
    }
    case "fixed_guaranteed_offer": {
      const amount = normalizeMoneyClaim(normalizer, claim.amount, "terms");
      return amount === null
        ? null
        : {
            eligibility: "eligible",
            payout: {
              kind: "exact_final_payout",
              evidenceKind: "fixed_guaranteed_offer",
              amount,
            },
          };
    }
    case "documented_final_payout": {
      const amount = normalizeMoneyClaim(normalizer, claim.amount, "terms");
      return amount === null
        ? null
        : {
            eligibility: "eligible",
            payout: {
              kind: "exact_final_payout",
              evidenceKind: "documented_final_payout",
              amount,
            },
          };
    }
  }
}

function validProbabilityEntries(
  entries: readonly {
    readonly outcomeKey: string;
    readonly probability: PackScoutBuybackEvRationalClaimV1;
  }[],
): Map<string, PackScoutBuybackEvProbabilityV1> | null {
  const byKey = new Map<string, PackScoutBuybackEvProbabilityV1>();
  for (const entry of entries) {
    const { numerator, denominator } = entry.probability;
    if (
      !Number.isSafeInteger(numerator) ||
      !Number.isSafeInteger(denominator) ||
      numerator < 0 ||
      denominator <= 0 ||
      denominator > PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR ||
      numerator > denominator ||
      byKey.has(entry.outcomeKey)
    ) {
      return null;
    }
    const reduced = reducedRational(BigInt(numerator), BigInt(denominator));
    if (reduced === null) return null;
    byKey.set(entry.outcomeKey, reduced);
  }
  return byKey;
}

function sameKeySet(
  keys: readonly string[],
  probabilities: ReadonlyMap<string, PackScoutBuybackEvProbabilityV1>,
): boolean {
  return (
    probabilities.size === keys.length &&
    keys.every((key) => probabilities.has(key))
  );
}

function ceilPartsPerMillionDifference(
  left: PackScoutBuybackEvProbabilityV1,
  right: PackScoutBuybackEvProbabilityV1,
): number {
  const numerator =
    BigInt(left.numerator) * BigInt(right.denominator) -
    BigInt(right.numerator) * BigInt(left.denominator);
  const absolute = numerator < 0n ? -numerator : numerator;
  const denominator = BigInt(left.denominator) * BigInt(right.denominator);
  const scaled = absolute * 1_000_000n;
  return Number((scaled + denominator - 1n) / denominator);
}

interface OddsResolution {
  readonly probabilities: ReadonlyMap<string, PackScoutBuybackEvProbabilityV1>;
  readonly evidence: PackScoutBuybackEvInputV1["oddsEvidence"];
}

function resolvePublishedOdds(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvPublishedOddsClaimV1 | null,
  outcomeKeys: readonly string[],
  poolKind: "finite" | "non_finite",
): OddsResolution | null {
  if (claim === null) {
    addReason(normalizer, "INCOMPLETE_PROBABILITIES");
    return null;
  }
  const probabilities = validProbabilityEntries(claim.entries);
  if (
    probabilities === null ||
    !sameKeySet(outcomeKeys, probabilities) ||
    !isPackScoutBuybackEvProbabilityCoverageCompleteV1([
      ...probabilities.values(),
    ])
  ) {
    addReason(normalizer, "INCOMPLETE_PROBABILITIES");
    return null;
  }
  return {
    probabilities,
    evidence: {
      sourceKind: "platform_published",
      poolKind,
      currentPoolEvidence:
        poolKind === "finite" ? "unavailable" : "not_applicable",
      probabilityCoverage: "complete",
    },
  };
}

function resolveOdds(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvOddsClaimV1,
  outcomeKeys: readonly string[],
): OddsResolution | null {
  if (claim.poolKind === "unknown") {
    addReason(normalizer, "INCOMPLETE_PROBABILITIES");
    return null;
  }
  if (claim.poolKind === "non_finite") {
    return resolvePublishedOdds(
      normalizer,
      claim.published,
      outcomeKeys,
      "non_finite",
    );
  }
  const pool = claim.currentPool;
  if (pool !== null) {
    if (
      pool.snapshotAtomicity !== "atomic" ||
      pool.countsStability !== "stable"
    ) {
      addReason(normalizer, "NON_ATOMIC_OBSERVATION");
      return null;
    }
    if (pool.completeness === "complete") {
      const unitsByKey = new Map<string, number>();
      for (const entry of pool.remainingUnits) {
        if (
          !Number.isSafeInteger(entry.units) ||
          entry.units < 0 ||
          unitsByKey.has(entry.outcomeKey)
        ) {
          addReason(normalizer, "INCOMPLETE_PROBABILITIES");
          return null;
        }
        unitsByKey.set(entry.outcomeKey, entry.units);
      }
      if (
        unitsByKey.size !== outcomeKeys.length ||
        !outcomeKeys.every((key) => unitsByKey.has(key))
      ) {
        addReason(normalizer, "INCOMPLETE_PROBABILITIES");
        return null;
      }
      const total = [...unitsByKey.values()].reduce(
        (sum, units) => sum + units,
        0,
      );
      if (total === 0) {
        addReason(normalizer, "INCOMPLETE_PROBABILITIES");
        return null;
      }
      if (
        !Number.isSafeInteger(total) ||
        total > PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_DENOMINATOR
      ) {
        addReason(normalizer, "ARITHMETIC_OVERFLOW");
        return null;
      }
      const probabilities = new Map<string, PackScoutBuybackEvProbabilityV1>();
      for (const key of outcomeKeys) {
        const reduced = reducedRational(
          BigInt(unitsByKey.get(key)!),
          BigInt(total),
        );
        if (reduced === null) {
          addReason(normalizer, "ARITHMETIC_OVERFLOW");
          return null;
        }
        probabilities.set(key, reduced);
      }
      let comparison: Extract<
        PackScoutBuybackEvInputV1["oddsEvidence"],
        { sourceKind: "current_remaining_inventory" }
      >["publishedOddsComparison"] = { status: "not_available" };
      if (
        claim.published !== null &&
        claim.published.revisionAgreement === "same_source_revision"
      ) {
        const published = validProbabilityEntries(claim.published.entries);
        if (published === null || !sameKeySet(outcomeKeys, published)) {
          addReason(normalizer, "ODDS_CONFLICT");
          return null;
        }
        const precision =
          claim.published.documentedRoundingPrecisionPartsPerMillion;
        const documentedPrecision =
          Number.isSafeInteger(precision) &&
          precision >= 0 &&
          precision <= 100_000
            ? precision
            : 0;
        const maximumDifference = outcomeKeys.reduce(
          (maximum, key) =>
            Math.max(
              maximum,
              ceilPartsPerMillionDifference(
                probabilities.get(key)!,
                published.get(key)!,
              ),
            ),
          0,
        );
        if (maximumDifference > Math.max(100, documentedPrecision)) {
          addReason(normalizer, "ODDS_CONFLICT");
          return null;
        }
        comparison = {
          status: "within_tolerance",
          maximumAbsoluteDifferencePartsPerMillion: maximumDifference,
          documentedRoundingPrecisionPartsPerMillion: documentedPrecision,
        };
      }
      return {
        probabilities,
        evidence: {
          sourceKind: "current_remaining_inventory",
          poolKind: "finite",
          currentPoolCompleteness: "complete",
          probabilityCoverage: "complete",
          publishedOddsComparison: comparison,
        },
      };
    }
  }
  return resolvePublishedOdds(
    normalizer,
    claim.published,
    outcomeKeys,
    "finite",
  );
}

function resolveUnitBasis(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvUnitBasisClaimV1,
): PackScoutBuybackEvInputV1["unitBasis"] | null {
  if (claim.kind === "ambiguous") {
    addReason(normalizer, "AMBIGUOUS_DRAW_SEMANTICS");
    return null;
  }
  if (claim.kind === "per_pack") return { kind: "per_pack", drawCount: 1 };
  if (
    !Number.isInteger(claim.drawCount) ||
    claim.drawCount < 1 ||
    claim.drawCount > PACKSCOUT_BUYBACK_EV_MAX_DRAW_COUNT
  ) {
    addReason(normalizer, "AMBIGUOUS_DRAW_SEMANTICS");
    return null;
  }
  return claim.drawCount === 1
    ? { kind: "per_pack", drawCount: 1 }
    : { kind: "per_draw", drawCount: claim.drawCount };
}

interface ObservationResolution {
  readonly observation: PackScoutBuybackEvInputV1["observation"] | null;
  readonly observedAt: string | null;
}

function resolveObservation(
  normalizer: Normalizer,
  claim: PackScoutBuybackEvObservationClaimV1,
): ObservationResolution {
  if (claim === null) {
    addReason(normalizer, "MISSING_PROVENANCE");
    addReason(normalizer, "MISSING_SOURCE_TIME");
    return { observation: null, observedAt: null };
  }
  const observedAt = packScoutBuybackEvCanonicalTimestampV1(claim.observedAt);
  if (observedAt === null) addReason(normalizer, "MISSING_SOURCE_TIME");
  const providerKeyValid = packScoutBuybackEvProviderKeyV1Schema.safeParse(
    claim.providerKey,
  ).success;
  const revisionValid =
    claim.sourceRevisionId !== null &&
    packScoutBuybackEvSourceRevisionV1Schema.safeParse(claim.sourceRevisionId)
      .success;
  const manifestValid =
    claim.sourceManifestSha256 === null ||
    packScoutBuybackEvSha256V1Schema.safeParse(claim.sourceManifestSha256)
      .success;
  const guardValid =
    claim.coherence.kind !== "guarded_collection" ||
    packScoutBuybackEvSha256V1Schema.safeParse(
      claim.coherence.collectionGuardSha256,
    ).success;
  if (claim.coherence.kind === "timestamp_coincidence") {
    addReason(normalizer, "NON_ATOMIC_OBSERVATION");
    addReason(normalizer, "MISSING_PROVENANCE");
    return { observation: null, observedAt };
  }
  if (
    !providerKeyValid ||
    !revisionValid ||
    !manifestValid ||
    !guardValid ||
    observedAt === null
  ) {
    addReason(normalizer, "MISSING_PROVENANCE");
    return { observation: null, observedAt };
  }
  const base = {
    providerKey: claim.providerKey,
    sourceRevisionId: claim.sourceRevisionId!,
    sourceManifestSha256: claim.sourceManifestSha256,
    observedAt,
  };
  return {
    observation:
      claim.coherence.kind === "provider_revision"
        ? { coherenceKind: "provider_revision", ...base }
        : {
            coherenceKind: "guarded_collection",
            ...base,
            collectionGuardSha256: claim.coherence.collectionGuardSha256,
          },
    observedAt,
  };
}

function buildUnavailableOutcome(
  normalizer: Normalizer,
  draft: PackScoutBuybackEvEvidenceDraftV1,
  observation: ObservationResolution,
  productValid: boolean,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const internalReasons = canonicalizePackScoutBuybackEvInternalReasonsV1([
    ...normalizer.reasons,
  ]);
  return packScoutBuybackEvEvidenceOutcomeV1Schema.parse({
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "unavailable",
    product: productValid
      ? { state: "known", reference: draft.product! }
      : { state: "unknown", reference: null },
    evaluatedAt: normalizer.context.evaluatedAt,
    dataAsOf:
      observation.observedAt === null
        ? { state: "unknown_source_time", observedAt: null }
        : { state: "known", observedAt: observation.observedAt },
    observation: observation.observation,
    internalReasons: [...internalReasons],
    publicPrimaryReason:
      packScoutBuybackEvPublicReasonForInternalReasonsV1(internalReasons),
  });
}

/**
 * Apply the shared evidence rulebook to one provider-neutral draft and return
 * either a complete calculator input or canonical unavailable evidence.
 */
export function finalizePackScoutBuybackEvEvidenceV1(
  draft: PackScoutBuybackEvEvidenceDraftV1,
  context: PackScoutBuybackEvEvidenceContextV1,
): PackScoutBuybackEvEvidenceOutcomeV1 {
  const evaluatedAt = packScoutBuybackEvCanonicalTimestampV1(
    context.evaluatedAt,
  );
  if (evaluatedAt === null || evaluatedAt !== context.evaluatedAt) {
    throw new TypeError(
      "PackScout EV evidence context requires a canonical evaluatedAt timestamp.",
    );
  }
  const preliminary: Normalizer = {
    reasons: new Set<InternalReason>(),
    context,
    observedAtMillis: null,
  };
  const observation = resolveObservation(preliminary, draft.observation);
  const normalizer: Normalizer = {
    reasons: preliminary.reasons,
    context,
    observedAtMillis:
      observation.observedAt === null
        ? null
        : Date.parse(observation.observedAt),
  };

  const productValid =
    draft.product !== null &&
    packScoutBuybackEvProductKeyV1Schema.safeParse(draft.product.productKey)
      .success &&
    packScoutBuybackEvSourceRevisionV1Schema.safeParse(
      draft.product.productRevisionId,
    ).success;
  if (!productValid) addReason(normalizer, "MISSING_PRODUCT_IDENTITY");

  const packPrice =
    draft.packPrice === null
      ? (addReason(normalizer, "INVALID_PRICE"), null)
      : normalizeMoneyClaim(normalizer, draft.packPrice, "price");
  if (
    packPrice !== null &&
    (packPrice.canonicalUsdCents.denominator !== 1 ||
      packPrice.canonicalUsdCents.numerator === 0)
  ) {
    addReason(normalizer, "INVALID_PRICE");
  }

  const unitBasis = resolveUnitBasis(normalizer, draft.unitBasis);

  if (draft.outcomes.length === 0) {
    addReason(normalizer, "INCOMPLETE_PROBABILITIES");
    addReason(normalizer, "INCOMPLETE_VALUES");
    return buildUnavailableOutcome(normalizer, draft, observation, productValid);
  }
  if (draft.outcomes.length > PACKSCOUT_BUYBACK_EV_MAX_OUTCOMES) {
    addReason(normalizer, "ARITHMETIC_OVERFLOW");
    return buildUnavailableOutcome(normalizer, draft, observation, productValid);
  }

  const sortedOutcomes = [...draft.outcomes].sort((left, right) =>
    left.outcomeKey < right.outcomeKey
      ? -1
      : left.outcomeKey > right.outcomeKey
        ? 1
        : 0,
  );
  const outcomeKeys = sortedOutcomes.map(({ outcomeKey }) => outcomeKey);
  const keysCoherent = outcomeKeys.every(
    (key, index) =>
      packScoutBuybackEvOutcomeKeyV1Schema.safeParse(key).success &&
      (index === 0 || outcomeKeys[index - 1]! !== key),
  );
  if (!keysCoherent) {
    addReason(normalizer, "HETEROGENEOUS_OUTCOME_BUCKET");
    return buildUnavailableOutcome(normalizer, draft, observation, productValid);
  }

  const deferringOutcomes = sortedOutcomes.filter(
    (outcome) =>
      outcome.valueBasis === "stated_collectible_value" &&
      outcome.buyback.kind === "defer_to_product_terms",
  ).length;
  const uniform = resolveUniformRate(
    normalizer,
    draft.uniformBuybackRate,
    deferringOutcomes,
  );

  const odds = resolveOdds(normalizer, draft.odds, outcomeKeys);

  const outcomes: PackScoutBuybackEvOutcomeV1[] = [];
  for (const claim of sortedOutcomes) {
    const representation = normalizeRepresentation(
      normalizer,
      claim.representation,
    );
    const statedValue = normalizeStatedValue(normalizer, claim.statedValue);
    const buyback = normalizeOutcomeBuyback(
      normalizer,
      claim,
      statedValue,
      uniform,
    );
    const probability = odds?.probabilities.get(claim.outcomeKey) ?? null;
    if (
      representation !== null &&
      statedValue !== null &&
      buyback !== null &&
      probability !== null
    ) {
      outcomes.push({
        outcomeKey: claim.outcomeKey,
        representation,
        probability,
        statedValue,
        buyback,
      });
    }
  }

  if (normalizer.reasons.size > 0) {
    return buildUnavailableOutcome(normalizer, draft, observation, productValid);
  }
  if (
    observation.observation === null ||
    packPrice === null ||
    unitBasis === null ||
    odds === null ||
    outcomes.length !== sortedOutcomes.length
  ) {
    // Every failure branch above records at least one reason; reaching this
    // point without one is a draft-construction invariant violation.
    throw new TypeError(
      "PackScout EV evidence normalization reached an incoherent state.",
    );
  }

  const usesUniformRate = outcomes.some(
    (outcome) =>
      outcome.buyback.eligibility === "eligible" &&
      outcome.buyback.payout.kind === "product_uniform_rate",
  );
  return packScoutBuybackEvEvidenceOutcomeV1Schema.parse({
    status: "complete",
    input: packScoutBuybackEvInputV1Schema.parse({
      schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
      product: draft.product!,
      observation: observation.observation,
      packPrice,
      unitBasis,
      oddsEvidence: odds.evidence,
      uniformBuybackRate:
        usesUniformRate && uniform.terms !== null
          ? { scope: "every_eligible_outcome", terms: uniform.terms }
          : null,
      outcomes,
    }),
  });
}
