import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_FORMULAS_V1,
  PACKSCOUT_BUYBACK_EV_PAYOUT_ORDER_V1,
  PACKSCOUT_BUYBACK_EV_PROBABILITY_TOLERANCE_DENOMINATOR,
  packScoutBuybackEvProtectedCalculationResultV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
  type PackScoutBuybackEvOutcomeV1,
  type PackScoutBuybackEvProtectedCalculationResultV1,
  type PackScoutBuybackEvRateTermsV1,
} from "@packscout/contracts";
import {
  calculatePackScoutBuybackAdjustedEvV1,
  PackScoutBuybackAdjustedEvConfigurationError,
} from "./buyback-adjusted-ev-calculator.ts";
import {
  BUYBACK_EV_TEST_CALCULATED_AT,
  BUYBACK_EV_TEST_OBSERVED_AT,
  buildBuybackEvInput,
  buildOutcome,
  buildRateTerms,
  buildStablecoinEvidence,
  buildUsdEvidence,
} from "./buyback-adjusted-ev-calculator.test-support.ts";

const MAX_CANONICAL_USD_CENTS = 1_000_000_000_000;

/** Calculates and proves the result parses through the contract unchanged. */
function calculate(
  input: unknown,
  calculatedAt: string = BUYBACK_EV_TEST_CALCULATED_AT,
): PackScoutBuybackEvProtectedCalculationResultV1 {
  const result = calculatePackScoutBuybackAdjustedEvV1({ input, calculatedAt });
  const reparsed =
    packScoutBuybackEvProtectedCalculationResultV1Schema.parse(result);
  assert.deepEqual(
    reparsed,
    result,
    "every calculator result must parse through the contract schema unchanged",
  );
  return result;
}

function expectAvailable(result: PackScoutBuybackEvProtectedCalculationResultV1) {
  if (result.status !== "available") {
    assert.fail(
      `Expected an available result, got: ${JSON.stringify(result.internalReasons)}`,
    );
  }
  return result;
}

function expectUnavailable(
  result: PackScoutBuybackEvProtectedCalculationResultV1,
) {
  if (result.status !== "unavailable") {
    assert.fail("Expected an unavailable result, got an available one.");
  }
  return result;
}

function outcomeSpecificOutcome(input: {
  readonly outcomeKey: string;
  readonly probability: { numerator: number; denominator: number };
  readonly valueMinorUnits: number;
  readonly terms: PackScoutBuybackEvRateTermsV1;
}): PackScoutBuybackEvOutcomeV1 {
  return buildOutcome({
    outcomeKey: input.outcomeKey,
    probability: input.probability,
    statedValue: { kind: "exact", amount: buildUsdEvidence(input.valueMinorUnits) },
    buyback: {
      eligibility: "eligible",
      payout: { kind: "outcome_specific_rate", terms: input.terms },
    },
  });
}

test("the golden $100 pack at a documented uniform 85% buyback is exactly $85 gross, 85%, -$15, and -15%", () => {
  const result = calculate(buildBuybackEvInput(), BUYBACK_EV_TEST_OBSERVED_AT);
  assert.deepEqual(result, {
    schemaVersion: "packscout_buyback_ev_v1",
    methodVersion: "packscout-buyback-adjusted-ev-v1",
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
    visibility: "protected_internal",
    status: "available",
    grossEvMoney: { minorUnits: 8_500, currency: "USD" },
    grossReturnBasisPoints: 8_500,
    evDollars: { minorUnits: -1_500, currency: "USD" },
    evPercentBasisPoints: -1_500,
    calculatedAt: BUYBACK_EV_TEST_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: BUYBACK_EV_TEST_OBSERVED_AT },
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
    confidenceInput: {
      schemaVersion: "packscout_buyback_ev_v1",
      methodVersion: "packscout-buyback-adjusted-ev-v1",
      confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
      visibility: "protected_internal",
      oddsSource: "current_remaining_inventory",
      usedClosedRangeMidpoint: false,
      oldestEssentialObservedAt: BUYBACK_EV_TEST_OBSERVED_AT,
      calculatedAt: BUYBACK_EV_TEST_OBSERVED_AT,
      availabilityGate: { status: "passed" },
    },
  });
});

test("a payout-weighted EV above the pack price is a positive opportunity", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        outcomes: [
          buildOutcome({
            statedValue: { kind: "exact", amount: buildUsdEvidence(20_000) },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(result.grossEvMoney, { minorUnits: 17_000, currency: "USD" });
  assert.equal(result.grossReturnBasisPoints, 17_000);
  assert.deepEqual(result.evDollars, { minorUnits: 7_000, currency: "USD" });
  assert.equal(result.evPercentBasisPoints, 7_000);
  assert.deepEqual(result.protectedEvidence.underlyingOutcomeEvMoney, {
    minorUnits: 20_000,
    currency: "USD",
  });
});

test("a gross EV exactly at the pack price is neutral, not zero", () => {
  const result = expectAvailable(
    calculate(buildBuybackEvInput({ packPrice: buildUsdEvidence(8_500) })),
  );
  assert.deepEqual(result.grossEvMoney, { minorUnits: 8_500, currency: "USD" });
  assert.equal(result.grossReturnBasisPoints, 10_000);
  assert.deepEqual(result.evDollars, { minorUnits: 0, currency: "USD" });
  assert.equal(result.evPercentBasisPoints, 0);
});

test("explicitly ineligible outcomes produce an available zero gross EV, never an unavailable one", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        uniformBuybackRate: null,
        outcomes: [
          buildOutcome({ buyback: { eligibility: "ineligible", payout: null } }),
        ],
      }),
    ),
  );
  assert.deepEqual(result.grossEvMoney, { minorUnits: 0, currency: "USD" });
  assert.equal(result.grossReturnBasisPoints, 0);
  assert.deepEqual(result.evDollars, { minorUnits: -10_000, currency: "USD" });
  assert.equal(result.evPercentBasisPoints, -10_000);
  assert.deepEqual(
    result.protectedEvidence.underlyingOutcomeEvMoney,
    { minorUnits: 10_000, currency: "USD" },
    "ineligibility zeroes the payout, not the protected stated value",
  );
});

test("a documented 0% uniform buyback stays available with zero gross EV instead of becoming missing buyback", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 0 }),
        },
      }),
    ),
  );
  assert.deepEqual(result.grossEvMoney, { minorUnits: 0, currency: "USD" });
  assert.equal(result.evPercentBasisPoints, -10_000);
});

test("exact outcome-specific terms override the documented uniform rate per outcome", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        outcomes: [
          outcomeSpecificOutcome({
            outcomeKey: "a-specific",
            probability: { numerator: 1, denominator: 2 },
            valueMinorUnits: 10_000,
            terms: buildRateTerms({ rateBasisPoints: 9_000 }),
          }),
          buildOutcome({
            outcomeKey: "b-uniform",
            probability: { numerator: 1, denominator: 2 },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(
    result.grossEvMoney,
    { minorUnits: 8_750, currency: "USD" },
    "one half at 90% plus one half at the uniform 85% of $100",
  );
});

test("an exact final payout is used as-is and never rate-adjusted again", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        outcomes: [
          buildOutcome({
            outcomeKey: "a-fixed-offer",
            probability: { numerator: 1, denominator: 2 },
            buyback: {
              eligibility: "eligible",
              payout: {
                kind: "exact_final_payout",
                evidenceKind: "fixed_guaranteed_offer",
                amount: buildUsdEvidence(7_500),
              },
            },
          }),
          buildOutcome({
            outcomeKey: "b-uniform",
            probability: { numerator: 1, denominator: 2 },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(
    result.grossEvMoney,
    { minorUnits: 8_000, currency: "USD" },
    "one half at the exact $75 offer plus one half at the uniform 85% of $100",
  );
});

test("rate payouts apply rated offer, percentage fee, fixed fee, zero clamp, floor, and cap in exactly that order", () => {
  const stageCases: ReadonlyArray<{
    readonly name: string;
    readonly terms: PackScoutBuybackEvRateTermsV1;
    readonly expectedGrossMinorUnits: number;
  }> = [
    {
      name: "rated offer alone",
      terms: buildRateTerms({ rateBasisPoints: 9_000 }),
      expectedGrossMinorUnits: 9_000,
    },
    {
      name: "percentage fee applies to the rated offer",
      terms: buildRateTerms({
        rateBasisPoints: 9_000,
        percentageFeeBasisPoints: 500,
      }),
      expectedGrossMinorUnits: 8_550,
    },
    {
      name: "fixed fee subtracts after the percentage fee",
      terms: buildRateTerms({
        rateBasisPoints: 9_000,
        percentageFeeBasisPoints: 500,
        fixedFee: buildUsdEvidence(100),
      }),
      expectedGrossMinorUnits: 8_450,
    },
    {
      name: "fixed fee applies after the rate, not to the stated value",
      terms: buildRateTerms({
        rateBasisPoints: 5_000,
        fixedFee: buildUsdEvidence(100),
      }),
      expectedGrossMinorUnits: 4_900,
    },
    {
      name: "a fee-exceeded payout clamps to zero",
      terms: buildRateTerms({
        rateBasisPoints: 9_000,
        fixedFee: buildUsdEvidence(10_000),
      }),
      expectedGrossMinorUnits: 0,
    },
    {
      name: "the floor lifts a zero-clamped payout after the clamp",
      terms: buildRateTerms({
        rateBasisPoints: 9_000,
        fixedFee: buildUsdEvidence(10_000),
        floor: buildUsdEvidence(500),
      }),
      expectedGrossMinorUnits: 500,
    },
    {
      name: "the cap bounds the payout last",
      terms: buildRateTerms({
        rateBasisPoints: 9_000,
        percentageFeeBasisPoints: 500,
        fixedFee: buildUsdEvidence(100),
        floor: buildUsdEvidence(500),
        cap: buildUsdEvidence(8_000),
      }),
      expectedGrossMinorUnits: 8_000,
    },
    {
      name: "the floor lifts a small rated payout inside the cap",
      terms: buildRateTerms({
        rateBasisPoints: 100,
        floor: buildUsdEvidence(500),
        cap: buildUsdEvidence(8_000),
      }),
      expectedGrossMinorUnits: 500,
    },
  ];
  for (const stageCase of stageCases) {
    const result = expectAvailable(
      calculate(
        buildBuybackEvInput({
          uniformBuybackRate: null,
          outcomes: [
            outcomeSpecificOutcome({
              outcomeKey: "base-outcome",
              probability: { numerator: 1, denominator: 1 },
              valueMinorUnits: 10_000,
              terms: stageCase.terms,
            }),
          ],
        }),
      ),
    );
    assert.deepEqual(
      result.grossEvMoney,
      { minorUnits: stageCase.expectedGrossMinorUnits, currency: "USD" },
      stageCase.name,
    );
  }
});

test("a uniform rate is shorthand for identical outcome terms and runs the same payout pipeline", () => {
  const terms = buildRateTerms({
    rateBasisPoints: 9_000,
    percentageFeeBasisPoints: 500,
    fixedFee: buildUsdEvidence(100),
  });
  const uniform = expectAvailable(
    calculate(
      buildBuybackEvInput({
        uniformBuybackRate: { scope: "every_eligible_outcome", terms },
      }),
    ),
  );
  const outcomeSpecific = expectAvailable(
    calculate(
      buildBuybackEvInput({
        uniformBuybackRate: null,
        outcomes: [
          outcomeSpecificOutcome({
            outcomeKey: "base-outcome",
            probability: { numerator: 1, denominator: 1 },
            valueMinorUnits: 10_000,
            terms,
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(uniform.grossEvMoney, { minorUnits: 8_450, currency: "USD" });
  assert.deepEqual(uniform.grossEvMoney, outcomeSpecific.grossEvMoney);
});

test("per-draw semantics multiply by the draw count while per-pack always uses one", () => {
  const perDraw = expectAvailable(
    calculate(
      buildBuybackEvInput({ unitBasis: { kind: "per_draw", drawCount: 3 } }),
    ),
  );
  assert.equal(perDraw.protectedEvidence.drawMultiplier, 3);
  assert.deepEqual(perDraw.grossEvMoney, { minorUnits: 25_500, currency: "USD" });
  assert.deepEqual(perDraw.protectedEvidence.underlyingOutcomeEvMoney, {
    minorUnits: 30_000,
    currency: "USD",
  });
  assert.equal(perDraw.evPercentBasisPoints, 15_500);

  const perPack = expectAvailable(calculate(buildBuybackEvInput()));
  assert.equal(perPack.protectedEvidence.drawMultiplier, 1);
  assert.deepEqual(perPack.grossEvMoney, { minorUnits: 8_500, currency: "USD" });
});

test("an ineligible outcome contributes zero payout without surrendering its probability mass", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        outcomes: [
          buildOutcome({
            outcomeKey: "a-eligible",
            probability: { numerator: 1, denominator: 2 },
          }),
          buildOutcome({
            outcomeKey: "b-ineligible",
            probability: { numerator: 1, denominator: 2 },
            buyback: { eligibility: "ineligible", payout: null },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(
    result.grossEvMoney,
    { minorUnits: 4_250, currency: "USD" },
    "half the uniform payout, never renormalized to the full 8500",
  );
  assert.deepEqual(result.protectedEvidence.underlyingOutcomeEvMoney, {
    minorUnits: 10_000,
    currency: "USD",
  });
});

test("a closed range weighs its exact arithmetic midpoint and flags the limitation without pre-rounding", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 5_000 }),
        },
        outcomes: [
          buildOutcome({
            statedValue: {
              kind: "closed_range",
              lower: buildUsdEvidence(9_998),
              upper: buildUsdEvidence(9_999),
            },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(
    result.grossEvMoney,
    { minorUnits: 4_999, currency: "USD" },
    "50% of the exact 9998.5 midpoint rounds once to 4999; a pre-rounded midpoint would give 5000",
  );
  assert.deepEqual(result.protectedEvidence.underlyingOutcomeEvMoney, {
    minorUnits: 9_999,
    currency: "USD",
  });
  assert.equal(result.provenance.usedClosedRangeMidpoint, true);
  assert.equal(result.confidenceInput.usedClosedRangeMidpoint, true);
});

test("accepted probability mass within one part per million is never renormalized to 100%", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 10_000 }),
        },
        outcomes: [
          buildOutcome({
            probability: { numerator: 999_999, denominator: 1_000_000 },
            statedValue: {
              kind: "exact",
              amount: buildUsdEvidence(1_000_000),
            },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(
    result.grossEvMoney,
    { minorUnits: 999_999, currency: "USD" },
    "renormalizing the 999999/1000000 mass would fabricate 1000000",
  );
  assert.equal(result.protectedEvidence.probabilityWasRenormalized, false);
});

test("aggregates round half-up exactly once at the USD cent boundary", () => {
  const roundingCases: ReadonlyArray<{
    readonly rateBasisPoints: number;
    readonly valueMinorUnits: number;
    readonly expectedGrossMinorUnits: number;
  }> = [
    { rateBasisPoints: 2_500, valueMinorUnits: 10_001, expectedGrossMinorUnits: 2_500 },
    { rateBasisPoints: 2_500, valueMinorUnits: 10_002, expectedGrossMinorUnits: 2_501 },
    { rateBasisPoints: 2_500, valueMinorUnits: 10_003, expectedGrossMinorUnits: 2_501 },
    { rateBasisPoints: 10_000, valueMinorUnits: 10_001, expectedGrossMinorUnits: 10_001 },
  ];
  for (const roundingCase of roundingCases) {
    const result = expectAvailable(
      calculate(
        buildBuybackEvInput({
          uniformBuybackRate: {
            scope: "every_eligible_outcome",
            terms: buildRateTerms({
              rateBasisPoints: roundingCase.rateBasisPoints,
            }),
          },
          outcomes: [
            buildOutcome({
              statedValue: {
                kind: "exact",
                amount: buildUsdEvidence(roundingCase.valueMinorUnits),
              },
            }),
          ],
        }),
      ),
    );
    assert.deepEqual(result.grossEvMoney, {
      minorUnits: roundingCase.expectedGrossMinorUnits,
      currency: "USD",
    });
  }

  const halfCentAggregate = expectAvailable(
    calculate(
      buildBuybackEvInput({
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 10_000 }),
        },
        outcomes: [
          buildOutcome({
            outcomeKey: "a-half",
            probability: { numerator: 1, denominator: 2 },
            statedValue: { kind: "exact", amount: buildUsdEvidence(10_001) },
          }),
          buildOutcome({
            outcomeKey: "b-zero",
            probability: { numerator: 1, denominator: 2 },
            statedValue: { kind: "exact", amount: buildUsdEvidence(0) },
            buyback: { eligibility: "ineligible", payout: null },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(
    halfCentAggregate.grossEvMoney,
    { minorUnits: 5_001, currency: "USD" },
    "the 5000.5 cent aggregate rounds half-up exactly once",
  );
  assert.deepEqual(halfCentAggregate.protectedEvidence.underlyingOutcomeEvMoney, {
    minorUnits: 5_001,
    currency: "USD",
  });
});

test("values at the canonical USD bound stay exact", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        packPrice: buildUsdEvidence(MAX_CANONICAL_USD_CENTS),
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 10_000 }),
        },
        outcomes: [
          buildOutcome({
            statedValue: {
              kind: "exact",
              amount: buildUsdEvidence(MAX_CANONICAL_USD_CENTS),
            },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(result.grossEvMoney, {
    minorUnits: MAX_CANONICAL_USD_CENTS,
    currency: "USD",
  });
  assert.equal(result.grossReturnBasisPoints, 10_000);
  assert.deepEqual(result.evDollars, { minorUnits: 0, currency: "USD" });
  assert.equal(result.evPercentBasisPoints, 0);
});

test("approved stablecoin evidence weighs through its exact canonical USD cents", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        packPrice: buildStablecoinEvidence({
          sourceMinorUnits: 100_000_000,
          canonicalUsdCents: { numerator: 10_000, denominator: 1 },
        }),
        outcomes: [
          buildOutcome({
            statedValue: {
              kind: "exact",
              amount: buildStablecoinEvidence({
                sourceMinorUnits: 100_000_000,
                canonicalUsdCents: { numerator: 10_000, denominator: 1 },
              }),
            },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(result.grossEvMoney, { minorUnits: 8_500, currency: "USD" });
  assert.equal(result.grossReturnBasisPoints, 8_500);
});

test("platform-published odds flow into provenance and the confidence input unchanged", () => {
  const result = expectAvailable(
    calculate(
      buildBuybackEvInput({
        oddsEvidence: {
          sourceKind: "platform_published",
          poolKind: "finite",
          currentPoolEvidence: "unavailable",
          probabilityCoverage: "complete",
        },
      }),
    ),
  );
  assert.equal(result.provenance.oddsSource, "platform_published");
  assert.equal(result.confidenceInput.oddsSource, "platform_published");
});

test("data-as-of stays the oldest essential observation while calculated-at is the supplied clock", () => {
  const result = expectAvailable(
    calculate(buildBuybackEvInput(), BUYBACK_EV_TEST_CALCULATED_AT),
  );
  assert.deepEqual(result.dataAsOf, {
    state: "known",
    observedAt: BUYBACK_EV_TEST_OBSERVED_AT,
  });
  assert.equal(result.calculatedAt, BUYBACK_EV_TEST_CALCULATED_AT);
  assert.equal(
    result.confidenceInput.oldestEssentialObservedAt,
    BUYBACK_EV_TEST_OBSERVED_AT,
  );
  assert.equal(result.confidenceInput.calculatedAt, BUYBACK_EV_TEST_CALCULATED_AT);
});

test("byte-equivalent input and clock produce byte-equivalent results", () => {
  const input = buildBuybackEvInput();
  const first = calculate(input);
  const second = calculate(input);
  const cloned = calculate(structuredClone(input));
  assert.deepEqual(first, second);
  assert.deepEqual(first, cloned);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first), JSON.stringify(cloned));
});

test("weighted aggregates beyond the canonical USD bound fail closed as arithmetic overflow", () => {
  const grossAndUnderlyingOverflow = expectUnavailable(
    calculate(
      buildBuybackEvInput({
        unitBasis: { kind: "per_draw", drawCount: 100 },
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 10_000 }),
        },
        outcomes: [
          buildOutcome({
            statedValue: {
              kind: "exact",
              amount: buildUsdEvidence(MAX_CANONICAL_USD_CENTS),
            },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(grossAndUnderlyingOverflow.internalReasons, [
    "ARITHMETIC_OVERFLOW",
  ]);
  assert.equal(
    grossAndUnderlyingOverflow.publicPrimaryReason,
    "CALCULATION_UNAVAILABLE",
  );
  assert.notEqual(grossAndUnderlyingOverflow.provenance, null);
  assert.deepEqual(grossAndUnderlyingOverflow.dataAsOf, {
    state: "known",
    observedAt: BUYBACK_EV_TEST_OBSERVED_AT,
  });
  assert.deepEqual(
    grossAndUnderlyingOverflow.confidenceInput.availabilityGate,
    { status: "failed", internalReasons: ["ARITHMETIC_OVERFLOW"] },
  );

  const underlyingOnlyOverflow = expectUnavailable(
    calculate(
      buildBuybackEvInput({
        unitBasis: { kind: "per_draw", drawCount: 100 },
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 100 }),
        },
        outcomes: [
          buildOutcome({
            statedValue: {
              kind: "exact",
              amount: buildUsdEvidence(MAX_CANONICAL_USD_CENTS),
            },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(underlyingOnlyOverflow.internalReasons, [
    "ARITHMETIC_OVERFLOW",
  ]);
});

test("basis points beyond the safe integer range fail closed as arithmetic overflow", () => {
  const result = expectUnavailable(
    calculate(
      buildBuybackEvInput({
        packPrice: buildUsdEvidence(1),
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({ rateBasisPoints: 10_000 }),
        },
        outcomes: [
          buildOutcome({
            statedValue: {
              kind: "exact",
              amount: buildUsdEvidence(MAX_CANONICAL_USD_CENTS),
            },
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(result.internalReasons, ["ARITHMETIC_OVERFLOW"]);
  assert.equal(result.publicPrimaryReason, "CALCULATION_UNAVAILABLE");
});

test("a calculation clock before the observation has no usable source time and fails closed", () => {
  const result = expectUnavailable(
    calculate(buildBuybackEvInput(), "2026-08-19T17:59:59.999Z"),
  );
  assert.deepEqual(result.internalReasons, ["MISSING_SOURCE_TIME"]);
  assert.equal(result.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
  assert.deepEqual(result.dataAsOf, {
    state: "unknown_source_time",
    observedAt: null,
  });
  assert.notEqual(result.provenance, null);
  assert.equal(result.confidenceInput.oldestEssentialObservedAt, null);
  assert.equal(
    result.confidenceInput.oddsSource,
    "current_remaining_inventory",
  );
});

test("a non-canonical calculation clock is a configuration error, never a fabricated result", () => {
  for (const badClock of [
    "2026-08-19T18:00:00Z",
    "2026-08-19T18:00:00.000+00:00",
    "2026-08-19 18:00:00.000Z",
    "not-a-time",
    "",
  ]) {
    assert.throws(
      () =>
        calculatePackScoutBuybackAdjustedEvV1({
          input: buildBuybackEvInput(),
          calculatedAt: badClock,
        }),
      (error: unknown) =>
        error instanceof PackScoutBuybackAdjustedEvConfigurationError &&
        error.code === "INVALID_CALCULATED_AT",
      badClock,
    );
  }
});

test("unparseable input fails closed with untrusted provenance and unknown source time", () => {
  for (const badInput of [null, undefined, "evidence", 42, []]) {
    const result = expectUnavailable(calculate(badInput));
    assert.deepEqual(result.internalReasons, [
      "MISSING_PROVENANCE",
      "MISSING_SOURCE_TIME",
    ]);
    assert.equal(result.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
    assert.equal(result.provenance, null);
    assert.deepEqual(result.dataAsOf, {
      state: "unknown_source_time",
      observedAt: null,
    });
    assert.equal(result.confidenceInput.oddsSource, null);
    assert.equal(result.confidenceInput.usedClosedRangeMidpoint, false);
    assert.deepEqual(result.confidenceInput.availabilityGate, {
      status: "failed",
      internalReasons: ["MISSING_PROVENANCE", "MISSING_SOURCE_TIME"],
    });
  }
});

test("each strict-schema rejection maps to its documented deterministic reasons in canonical order", () => {
  const golden = buildBuybackEvInput();
  const baseOutcome = buildOutcome();
  const rejectionCases: ReadonlyArray<{
    readonly name: string;
    readonly input: unknown;
    readonly expectedReasons: readonly PackScoutBuybackEvInternalReasonCodeV1[];
  }> = [
    {
      name: "missing buyback evidence",
      input: {
        ...golden,
        uniformBuybackRate: null,
        outcomes: [{ ...baseOutcome, buyback: undefined }],
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "MISSING_BUYBACK",
      ],
    },
    {
      name: "a uniform-rate reference without documented uniform terms",
      input: { ...golden, uniformBuybackRate: null },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "MISSING_BUYBACK",
      ],
    },
    {
      name: "unknown buyback eligibility",
      input: {
        ...golden,
        outcomes: [
          { ...baseOutcome, buyback: { eligibility: "unknown", payout: null } },
        ],
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "UNKNOWN_BUYBACK_ELIGIBILITY",
      ],
    },
    {
      name: "contradictory payout bounds with a floor above the cap",
      input: {
        ...golden,
        uniformBuybackRate: {
          scope: "every_eligible_outcome",
          terms: buildRateTerms({
            floor: buildUsdEvidence(9_000),
            cap: buildUsdEvidence(8_000),
          }),
        },
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "INVALID_BUYBACK_TERMS",
      ],
    },
    {
      name: "an unsupported source currency",
      input: {
        ...golden,
        packPrice: {
          ...golden.packPrice,
          sourceAmount: { ...golden.packPrice.sourceAmount, currency: "EUR" },
        },
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "UNSUPPORTED_CURRENCY",
      ],
    },
    {
      name: "an unsupported money precision",
      input: {
        ...golden,
        packPrice: {
          ...golden.packPrice,
          sourceAmount: { ...golden.packPrice.sourceAmount, precision: 7 },
        },
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "UNSUPPORTED_CURRENCY",
        "UNSUPPORTED_MONEY_PRECISION",
      ],
    },
    {
      name: "a non-positive pack price",
      input: { ...golden, packPrice: buildUsdEvidence(0) },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "INVALID_PRICE",
      ],
    },
    {
      name: "an invalid draw count",
      input: { ...golden, unitBasis: { kind: "per_draw", drawCount: 0 } },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "AMBIGUOUS_DRAW_SEMANTICS",
      ],
    },
    {
      name: "incomplete probability coverage",
      input: {
        ...golden,
        outcomes: [
          { ...baseOutcome, probability: { numerator: 1, denominator: 2 } },
        ],
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "INCOMPLETE_PROBABILITIES",
      ],
    },
    {
      name: "an open-ended value range",
      input: {
        ...golden,
        outcomes: [
          {
            ...baseOutcome,
            statedValue: {
              kind: "closed_range",
              lower: buildUsdEvidence(9_000),
              upper: null,
            },
          },
        ],
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "INCOMPLETE_VALUES",
      ],
    },
    {
      name: "an inverted value range",
      input: {
        ...golden,
        outcomes: [
          {
            ...baseOutcome,
            statedValue: {
              kind: "closed_range",
              lower: buildUsdEvidence(11_000),
              upper: buildUsdEvidence(9_000),
            },
          },
        ],
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "INVALID_VALUE_RANGE",
      ],
    },
    {
      name: "an unverified heterogeneous aggregate bucket",
      input: {
        ...golden,
        outcomes: [
          {
            ...baseOutcome,
            representation: {
              kind: "homogeneous_bucket",
              memberCount: { state: "known", value: 10 },
              eligibilityHomogeneity: "mixed",
              payoutFunctionHomogeneity: "verified_same",
              homogeneityEvidenceSha256: "a".repeat(64),
            },
          },
        ],
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "HETEROGENEOUS_OUTCOME_BUCKET",
      ],
    },
    {
      name: "a material odds conflict beyond the approved tolerance",
      input: {
        ...golden,
        oddsEvidence: {
          ...golden.oddsEvidence,
          publishedOddsComparison: {
            status: "within_tolerance",
            maximumAbsoluteDifferencePartsPerMillion: 5_000,
            documentedRoundingPrecisionPartsPerMillion: 100,
          },
        },
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "ODDS_CONFLICT",
      ],
    },
    {
      name: "stablecoin parity that is not effective at the observation",
      input: {
        ...golden,
        packPrice: buildStablecoinEvidence({
          sourceMinorUnits: 100_000_000,
          canonicalUsdCents: { numerator: 10_000, denominator: 1 },
          effectiveAt: "2026-08-17T00:00:00.000Z",
          expiresAt: "2026-08-18T00:00:00.000Z",
        }),
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "EXPIRED_PARITY_APPROVAL",
      ],
    },
    {
      name: "missing product identity",
      input: { ...golden, product: undefined },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_PRODUCT_IDENTITY",
        "MISSING_SOURCE_TIME",
      ],
    },
    {
      name: "a non-canonical outcome ordering",
      input: {
        ...golden,
        outcomes: [
          {
            ...baseOutcome,
            outcomeKey: "b-outcome",
            probability: { numerator: 1, denominator: 2 },
          },
          {
            ...baseOutcome,
            outcomeKey: "a-outcome",
            probability: { numerator: 1, denominator: 2 },
          },
        ],
      },
      expectedReasons: [
        "MISSING_PROVENANCE",
        "MISSING_SOURCE_TIME",
        "NON_ATOMIC_OBSERVATION",
      ],
    },
    {
      name: "a non-canonical observation timestamp",
      input: {
        ...golden,
        observation: {
          ...golden.observation,
          observedAt: "2026-08-19T11:00:00.000-07:00",
        },
      },
      expectedReasons: ["MISSING_PROVENANCE", "MISSING_SOURCE_TIME"],
    },
  ];

  for (const rejectionCase of rejectionCases) {
    const result = expectUnavailable(calculate(rejectionCase.input));
    assert.deepEqual(
      result.internalReasons,
      rejectionCase.expectedReasons,
      rejectionCase.name,
    );
    assert.equal(
      result.publicPrimaryReason,
      packScoutBuybackEvPublicReasonForInternalReasonsV1(
        rejectionCase.expectedReasons,
      ),
      rejectionCase.name,
    );
    assert.equal(result.provenance, null, rejectionCase.name);
    assert.deepEqual(
      result.dataAsOf,
      { state: "unknown_source_time", observedAt: null },
      rejectionCase.name,
    );
    assert.deepEqual(
      result.confidenceInput.availabilityGate,
      {
        status: "failed",
        internalReasons: [...rejectionCase.expectedReasons],
      },
      rejectionCase.name,
    );
  }
});

test("multiple defects report every applicable reason once in canonical order", () => {
  const golden = buildBuybackEvInput();
  const baseOutcome = buildOutcome();
  const result = expectUnavailable(
    calculate({
      ...golden,
      packPrice: buildUsdEvidence(0),
      unitBasis: { kind: "per_draw", drawCount: 0 },
      outcomes: [
        {
          ...baseOutcome,
          outcomeKey: "b-outcome",
          probability: { numerator: 1, denominator: 2 },
        },
        {
          ...baseOutcome,
          outcomeKey: "a-outcome",
          probability: { numerator: 1, denominator: 2 },
        },
      ],
    }),
  );
  assert.deepEqual(result.internalReasons, [
    "MISSING_PROVENANCE",
    "MISSING_SOURCE_TIME",
    "NON_ATOMIC_OBSERVATION",
    "INVALID_PRICE",
    "AMBIGUOUS_DRAW_SEMANTICS",
  ]);
  assert.equal(result.publicPrimaryReason, "SOURCE_EVIDENCE_UNAVAILABLE");
});

test("vendor-reported EV can never enter the calculation or its result", () => {
  const smuggled = expectUnavailable(
    calculate({
      ...buildBuybackEvInput(),
      vendorReportedEv: { minorUnits: 12_000, currency: "USD" },
    }),
  );
  assert.deepEqual(smuggled.internalReasons, [
    "MISSING_PROVENANCE",
    "MISSING_SOURCE_TIME",
  ]);

  const golden = calculate(buildBuybackEvInput());
  assert.equal(
    JSON.stringify(golden).toLowerCase().includes("vendor"),
    false,
    "no vendor-supplied value survives into any calculator output",
  );
});
