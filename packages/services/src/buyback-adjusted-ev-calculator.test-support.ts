import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  type PackScoutBuybackEvInputV1,
  type PackScoutBuybackEvMoneyEvidenceV1,
  type PackScoutBuybackEvOutcomeV1,
  type PackScoutBuybackEvRateTermsV1,
} from "@packscout/contracts";

/**
 * Deterministic input builders for the buyback-adjusted EV calculator tests.
 * The golden defaults mirror the contract fixture: a $100.00 pack, one
 * certain $100.00 outcome, and a documented uniform 85% buyback, observed at
 * a fixed timestamp. No wall clock is ever consulted.
 */

export const BUYBACK_EV_TEST_OBSERVED_AT = "2026-08-19T18:00:00.000Z" as const;
export const BUYBACK_EV_TEST_CALCULATED_AT =
  "2026-08-19T18:05:00.000Z" as const;

export function buildUsdEvidence(
  minorUnits: number,
): PackScoutBuybackEvMoneyEvidenceV1 {
  return {
    sourceAmount: { minorUnits, currency: "USD", precision: 2 },
    canonicalUsdCents: { numerator: minorUnits, denominator: 1 },
    normalization: { kind: "usd_direct" },
  };
}

export function buildStablecoinEvidence(input: {
  readonly sourceMinorUnits: number;
  readonly canonicalUsdCents: { numerator: number; denominator: number };
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
}): PackScoutBuybackEvMoneyEvidenceV1 {
  return {
    sourceAmount: {
      minorUnits: input.sourceMinorUnits,
      currency: "USDC",
      precision: 6,
    },
    canonicalUsdCents: input.canonicalUsdCents,
    normalization: {
      kind: "usd_equivalent_stablecoin",
      parity: {
        currency: "USDC",
        parityNumerator: 1,
        parityDenominator: 1,
        effectiveAt: input.effectiveAt ?? "2026-08-19T00:00:00.000Z",
        expiresAt: input.expiresAt ?? "2026-08-20T00:00:00.000Z",
        configurationRevision: "stablecoin-parity-2026-08-19",
      },
    },
  };
}

export function buildRateTerms(
  overrides: Partial<PackScoutBuybackEvRateTermsV1> = {},
): PackScoutBuybackEvRateTermsV1 {
  return {
    rateBasisPoints: 8_500,
    percentageFeeBasisPoints: 0,
    fixedFee: buildUsdEvidence(0),
    floor: null,
    cap: null,
    ...overrides,
  };
}

export function buildOutcome(
  overrides: Partial<PackScoutBuybackEvOutcomeV1> = {},
): PackScoutBuybackEvOutcomeV1 {
  return {
    outcomeKey: "base-outcome",
    representation: { kind: "atomic_outcome" },
    probability: { numerator: 1, denominator: 1 },
    statedValue: { kind: "exact", amount: buildUsdEvidence(10_000) },
    buyback: {
      eligibility: "eligible",
      payout: { kind: "product_uniform_rate" },
    },
    ...overrides,
  };
}

export function buildBuybackEvInput(
  overrides: Partial<PackScoutBuybackEvInputV1> = {},
): PackScoutBuybackEvInputV1 {
  return {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    product: {
      productKey: "courtyard-ironman-repack",
      productRevisionId: "product-revision-42",
    },
    observation: {
      coherenceKind: "provider_revision",
      providerKey: "courtyard",
      sourceRevisionId: "catalog-revision-100",
      sourceManifestSha256: "1".repeat(64),
      observedAt: BUYBACK_EV_TEST_OBSERVED_AT,
    },
    packPrice: buildUsdEvidence(10_000),
    unitBasis: { kind: "per_pack", drawCount: 1 },
    oddsEvidence: {
      sourceKind: "current_remaining_inventory",
      poolKind: "finite",
      currentPoolCompleteness: "complete",
      probabilityCoverage: "complete",
      publishedOddsComparison: { status: "not_available" },
    },
    uniformBuybackRate: {
      scope: "every_eligible_outcome",
      terms: buildRateTerms(),
    },
    outcomes: [buildOutcome()],
    ...overrides,
  };
}
