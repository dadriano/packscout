import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_FORMULAS_V1,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1,
  PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  packScoutBuybackEvInputV1Schema,
  packScoutBuybackEvProtectedCalculationResultV1Schema,
  packScoutBuybackEvProtectedResultV1Schema,
  type PackScoutBuybackEvInputV1,
  type PackScoutBuybackEvMoneyEvidenceV1,
  type PackScoutBuybackEvProtectedCalculationResultV1,
  type PackScoutBuybackEvProtectedResultV1,
} from "../buyback-adjusted-ev-v1.ts";

export const PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT =
  "2026-08-19T18:00:00.000Z" as const;

export function buildPackScoutBuybackEvUsdEvidenceV1(
  minorUnits: number,
): PackScoutBuybackEvMoneyEvidenceV1 {
  return {
    sourceAmount: { minorUnits, currency: "USD", precision: 2 },
    canonicalUsdCents: { numerator: minorUnits, denominator: 1 },
    normalization: { kind: "usd_direct" },
  };
}

export function buildPackScoutBuybackEvStablecoinEvidenceV1(input: {
  readonly sourceMinorUnits: number;
  readonly canonicalUsdCents: number;
  readonly currency?: string;
  readonly effectiveAt?: string;
  readonly expiresAt?: string;
}): PackScoutBuybackEvMoneyEvidenceV1 {
  const currency = input.currency ?? "USDC";
  return {
    sourceAmount: {
      minorUnits: input.sourceMinorUnits,
      currency,
      precision: 6,
    },
    canonicalUsdCents: {
      numerator: input.canonicalUsdCents,
      denominator: 1,
    },
    normalization: {
      kind: "usd_equivalent_stablecoin",
      parity: {
        currency,
        parityNumerator: 1,
        parityDenominator: 1,
        effectiveAt: input.effectiveAt ?? "2026-08-19T00:00:00.000Z",
        expiresAt: input.expiresAt ?? "2026-08-20T00:00:00.000Z",
        configurationRevision: "stablecoin-parity-2026-08-19",
      },
    },
  };
}

export function buildPackScoutBuybackEvGoldenInputV1(): PackScoutBuybackEvInputV1 {
  return packScoutBuybackEvInputV1Schema.parse({
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion:
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
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
      observedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
    },
    packPrice: buildPackScoutBuybackEvUsdEvidenceV1(10_000),
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
      terms: {
        rateBasisPoints: 8_500,
        percentageFeeBasisPoints: 0,
        fixedFee: buildPackScoutBuybackEvUsdEvidenceV1(0),
        floor: null,
        cap: null,
      },
    },
    outcomes: [
      {
        outcomeKey: "base-outcome",
        representation: { kind: "atomic_outcome" },
        probability: { numerator: 1, denominator: 1 },
        statedValue: {
          kind: "exact",
          amount: buildPackScoutBuybackEvUsdEvidenceV1(10_000),
        },
        buyback: {
          eligibility: "eligible",
          payout: { kind: "product_uniform_rate" },
        },
      },
    ],
  });
}

export function buildPackScoutBuybackEvGoldenProtectedResultV1(): PackScoutBuybackEvProtectedResultV1 {
  return packScoutBuybackEvProtectedResultV1Schema.parse({
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion:
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "available",
    grossEvMoney: { minorUnits: 8_500, currency: "USD" },
    grossReturnBasisPoints: 8_500,
    evDollars: { minorUnits: -1_500, currency: "USD" },
    evPercentBasisPoints: -1_500,
    confidence: {
      policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      scoreBasisPoints: 10_000,
      band: "high",
      limitationCodes: [],
    },
    calculatedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
    dataAsOf: {
      state: "known",
      observedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
    },
    freshness: {
      state: "current",
      sourceAgeMilliseconds: 0,
      expiresAt: "2026-08-19T19:00:00.000Z",
    },
    provenance: {
      providerKey: "courtyard",
      productKey: "courtyard-ironman-repack",
      productRevisionId: "product-revision-42",
      sourceRevisionId: "catalog-revision-100",
      sourceManifestSha256: "1".repeat(64),
      observationCoherence: "provider_revision",
      oddsSource: "current_remaining_inventory",
      usedClosedRangeMidpoint: false,
    },
    protectedEvidence: {
      packPriceMoney: { minorUnits: 10_000, currency: "USD" },
      underlyingOutcomeEvMoney: { minorUnits: 10_000, currency: "USD" },
      drawMultiplier: 1,
      acceptedProbabilityCoverage: "within_one_part_per_million",
      probabilityToleranceDenominator:
        PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
      probabilityWasRenormalized: false,
      payoutFormula: PACKSCOUT_BUYBACK_EV_FORMULAS_V1.grossEv,
      payoutOrder: [...PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1],
    },
  });
}

export function buildPackScoutBuybackEvGoldenCalculationResultV1(): PackScoutBuybackEvProtectedCalculationResultV1 {
  const finalized = buildPackScoutBuybackEvGoldenProtectedResultV1();
  if (finalized.status !== "available") {
    throw new Error("The PackScout EV golden result must remain available.");
  }
  return packScoutBuybackEvProtectedCalculationResultV1Schema.parse({
    schemaVersion: finalized.schemaVersion,
    methodVersion: finalized.methodVersion,
    confidencePolicyVersion: finalized.confidencePolicyVersion,
    visibility: finalized.visibility,
    status: finalized.status,
    grossEvMoney: finalized.grossEvMoney,
    grossReturnBasisPoints: finalized.grossReturnBasisPoints,
    evDollars: finalized.evDollars,
    evPercentBasisPoints: finalized.evPercentBasisPoints,
    calculatedAt: finalized.calculatedAt,
    dataAsOf: finalized.dataAsOf,
    provenance: finalized.provenance,
    protectedEvidence: finalized.protectedEvidence,
    confidenceInput: {
      schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion:
        PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
      oddsSource: "current_remaining_inventory",
      usedClosedRangeMidpoint: false,
      oldestEssentialObservedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
      calculatedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
      availabilityGate: { status: "passed" },
    },
  });
}
