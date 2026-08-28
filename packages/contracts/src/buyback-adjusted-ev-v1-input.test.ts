import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPackScoutBuybackEvGoldenInputV1,
  buildPackScoutBuybackEvStablecoinEvidenceV1,
  buildPackScoutBuybackEvUsdEvidenceV1,
  PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
} from "./__fixtures__/buyback-adjusted-ev-v1.fixture.ts";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_ACCUMULATOR_BITS,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  canonicalizePackScoutBuybackEvInternalReasonsV1,
  isPackScoutBuybackEvProbabilityCoverageCompleteV1,
  packScoutBuybackEvConfidenceInputV1Schema,
  packScoutBuybackEvEvidenceOutcomeV1Schema,
  packScoutBuybackEvInputV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
} from "./index.ts";

function firstOutcome() {
  return buildPackScoutBuybackEvGoldenInputV1().outcomes[0]!;
}

function unavailableEvidence(
  internalReasons: readonly (
    | "MISSING_BUYBACK"
    | "MISSING_PRODUCT_IDENTITY"
    | "UNKNOWN_BUYBACK_ELIGIBILITY"
  )[],
) {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  return {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion:
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "unavailable",
    product: {
      state: "known",
      reference: golden.product,
    },
    evaluatedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
    dataAsOf: {
      state: "known",
      observedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
    },
    observation: golden.observation,
    internalReasons,
    publicPrimaryReason:
      packScoutBuybackEvPublicReasonForInternalReasonsV1(internalReasons),
  };
}

test("golden input freezes exact versions, uniform buyback, and the one-draw pack basis", () => {
  const input = packScoutBuybackEvInputV1Schema.parse(
    buildPackScoutBuybackEvGoldenInputV1(),
  );

  assert.equal(input.schemaVersion, "packscout_buyback_ev_v1");
  assert.equal(input.methodVersion, "packscout-buyback-adjusted-ev-v1");
  assert.equal(
    input.confidencePolicyVersion,
    "packscout-buyback-adjusted-ev-confidence-v1",
  );
  assert.deepEqual(input.packPrice.canonicalUsdCents, {
    numerator: 10_000,
    denominator: 1,
  });
  assert.equal(input.uniformBuybackRate?.terms.rateBasisPoints, 8_500);
  assert.deepEqual(input.unitBasis, { kind: "per_pack", drawCount: 1 });
  assert.deepEqual(input.outcomes[0]?.probability, {
    numerator: 1,
    denominator: 1,
  });
});

test("payout vocabulary represents uniform, outcome rate, exact payout, and explicit ineligibility once", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  const base = firstOutcome();
  const outcomes = [
    {
      ...base,
      outcomeKey: "a-ineligible",
      probability: { numerator: 1, denominator: 4 },
      buyback: { eligibility: "ineligible", payout: null },
    },
    {
      ...base,
      outcomeKey: "b-outcome-rate",
      probability: { numerator: 1, denominator: 4 },
      buyback: {
        eligibility: "eligible",
        payout: {
          kind: "outcome_specific_rate",
          terms: {
            rateBasisPoints: 9_000,
            percentageFeeBasisPoints: 500,
            fixedFee: buildPackScoutBuybackEvUsdEvidenceV1(100),
            floor: buildPackScoutBuybackEvUsdEvidenceV1(5_000),
            cap: buildPackScoutBuybackEvUsdEvidenceV1(8_000),
          },
        },
      },
    },
    {
      ...base,
      outcomeKey: "c-fixed-offer",
      probability: { numerator: 1, denominator: 4 },
      buyback: {
        eligibility: "eligible",
        payout: {
          kind: "exact_final_payout",
          evidenceKind: "fixed_guaranteed_offer",
          amount: buildPackScoutBuybackEvUsdEvidenceV1(7_500),
        },
      },
    },
    {
      ...base,
      outcomeKey: "d-uniform",
      probability: { numerator: 1, denominator: 4 },
    },
  ];

  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      unitBasis: { kind: "per_draw", drawCount: 3 },
      outcomes,
    }).success,
    true,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      unitBasis: { kind: "per_pack", drawCount: 2 },
      outcomes,
    }).success,
    false,
    "per-pack semantics always use one multiplier",
  );

  const exactWithRateFields = {
    ...outcomes[2],
    buyback: {
      ...outcomes[2]!.buyback,
      payout: {
        ...(outcomes[2]!.buyback as { payout: object }).payout,
        rateBasisPoints: 8_500,
      },
    },
  };
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [exactWithRateFields],
      uniformBuybackRate: null,
    }).success,
    false,
    "exact final payouts cannot be adjusted twice",
  );
});

test("uniform rates must be referenced and rate adjustments keep valid bounds", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  const exact = {
    ...firstOutcome(),
    buyback: {
      eligibility: "eligible",
      payout: {
        kind: "exact_final_payout",
        evidenceKind: "documented_final_payout",
        amount: buildPackScoutBuybackEvUsdEvidenceV1(8_500),
      },
    },
  };
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [exact],
    }).success,
    false,
    "unused product terms are contradictory evidence",
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [exact],
      uniformBuybackRate: null,
    }).success,
    true,
  );

  const badBounds = structuredClone(golden);
  badBounds.uniformBuybackRate!.terms.floor =
    buildPackScoutBuybackEvUsdEvidenceV1(9_000);
  badBounds.uniformBuybackRate!.terms.cap =
    buildPackScoutBuybackEvUsdEvidenceV1(8_000);
  assert.equal(packScoutBuybackEvInputV1Schema.safeParse(badBounds).success, false);
});

test("exact rational probabilities are reduced, complete within one ppm, and never normalized", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  const outcome = firstOutcome();
  const withinTolerance = {
    ...golden,
    outcomes: [
      {
        ...outcome,
        probability: { numerator: 999_999, denominator: 1_000_000 },
      },
    ],
  };
  const parsed = packScoutBuybackEvInputV1Schema.parse(withinTolerance);
  assert.deepEqual(parsed.outcomes[0]?.probability, {
    numerator: 999_999,
    denominator: 1_000_000,
  });

  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [
        {
          ...outcome,
          probability: { numerator: 999_998, denominator: 1_000_000 },
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [
        { ...outcome, probability: { numerator: 2, denominator: 2 } },
      ],
    }).success,
    false,
    "equivalent but unreduced probabilities are not canonical",
  );
});

test("probability aggregation has a hard exact-arithmetic work ceiling", () => {
  const primes: number[] = [];
  for (let candidate = 2; candidate < 5_000; candidate += 1) {
    if (primes.every((prime) => candidate % prime !== 0 || prime * prime > candidate)) {
      primes.push(candidate);
    }
  }
  assert.equal(PACKSCOUT_BUYBACK_EV_MAX_PROBABILITY_ACCUMULATOR_BITS, 4_096);
  assert.equal(
    isPackScoutBuybackEvProbabilityCoverageCompleteV1(
      primes.map((denominator) => ({ numerator: 1, denominator })),
    ),
    false,
  );
});

test("outcomes use strict code-unit ordering and bounded homogeneous-bucket proof", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  const base = firstOutcome();
  const first = {
    ...base,
    outcomeKey: "tier-10",
    probability: { numerator: 1, denominator: 2 },
    representation: {
      kind: "homogeneous_bucket",
      memberCount: { state: "not_published", value: null },
      eligibilityHomogeneity: "verified_same",
      payoutFunctionHomogeneity: "verified_same",
      homogeneityEvidenceSha256: "a".repeat(64),
    },
  };
  const second = {
    ...base,
    outcomeKey: "tier-2",
    probability: { numerator: 1, denominator: 2 },
  };
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [first, second],
    }).success,
    true,
    "code-unit order places tier-10 before tier-2",
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [second, first],
    }).success,
    false,
  );
  const missingHomogeneityProof = structuredClone(first) as unknown as {
    representation: { homogeneityEvidenceSha256?: string };
  };
  delete missingHomogeneityProof.representation.homogeneityEvidenceSha256;
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [missingHomogeneityProof],
    }).success,
    false,
  );
});

test("closed value ranges are increasing, complete, and cannot be open ended", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  const outcome = firstOutcome();
  const closed = {
    ...outcome,
    statedValue: {
      kind: "closed_range",
      lower: buildPackScoutBuybackEvUsdEvidenceV1(9_000),
      upper: buildPackScoutBuybackEvUsdEvidenceV1(11_000),
    },
  };
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({ ...golden, outcomes: [closed] })
      .success,
    true,
  );
  for (const upper of [9_000, 8_999]) {
    assert.equal(
      packScoutBuybackEvInputV1Schema.safeParse({
        ...golden,
        outcomes: [
          {
            ...closed,
            statedValue: {
              ...closed.statedValue,
              upper: buildPackScoutBuybackEvUsdEvidenceV1(upper),
            },
          },
        ],
      }).success,
      false,
    );
  }
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [
        {
          ...outcome,
          statedValue: {
            kind: "closed_range",
            lower: buildPackScoutBuybackEvUsdEvidenceV1(9_000),
            upper: null,
          },
        },
      ],
    }).success,
    false,
  );
});

test("USD and allowlisted stablecoin evidence normalize exactly at the observation", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  const stablecoin = buildPackScoutBuybackEvStablecoinEvidenceV1({
    sourceMinorUnits: 100_000_000,
    canonicalUsdCents: 10_000,
  });
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      packPrice: stablecoin,
    }).success,
    true,
  );

  const expired = buildPackScoutBuybackEvStablecoinEvidenceV1({
    sourceMinorUnits: 100_000_000,
    canonicalUsdCents: 10_000,
    expiresAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
  });
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({ ...golden, packPrice: expired })
      .success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      packPrice: {
        ...stablecoin,
        sourceAmount: { ...stablecoin.sourceAmount, precision: 7 },
      },
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      packPrice: {
        ...stablecoin,
        canonicalUsdCents: { numerator: 9_999, denominator: 1 },
      },
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      packPrice: {
        ...stablecoin,
        normalization: { kind: "live_fx", rate: 1 },
      },
    }).success,
    false,
  );
});

test("odds source priority and comparison tolerance are explicit", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      oddsEvidence: {
        sourceKind: "platform_published",
        poolKind: "finite",
        currentPoolEvidence: "unavailable",
        probabilityCoverage: "complete",
      },
    }).success,
    true,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      oddsEvidence: {
        sourceKind: "platform_published",
        poolKind: "finite",
        currentPoolEvidence: "not_applicable",
        probabilityCoverage: "complete",
      },
    }).success,
    false,
  );

  const comparison = {
    ...golden.oddsEvidence,
    publishedOddsComparison: {
      status: "within_tolerance",
      maximumAbsoluteDifferencePartsPerMillion: 101,
      documentedRoundingPrecisionPartsPerMillion: 0,
    },
  };
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      oddsEvidence: comparison,
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      oddsEvidence: {
        ...comparison,
        publishedOddsComparison: {
          ...comparison.publishedOddsComparison,
          documentedRoundingPrecisionPartsPerMillion: 200,
        },
      },
    }).success,
    true,
  );
});

test("product identity, atomic provenance, and UTC millisecond time are mandatory", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      product: {
        productKey: "courtyard-ironman-repack",
        productRevisionId: "product-revision-43",
      },
    }).success,
    true,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      product: undefined,
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      observation: {
        ...golden.observation,
        coherenceKind: "matching_timestamps",
      },
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      observation: {
        ...golden.observation,
        observedAt: "2026-08-19T11:00:00.000-07:00",
      },
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      observation: {
        coherenceKind: "guarded_collection",
        providerKey: "courtyard",
        sourceRevisionId: "catalog-revision-101",
        sourceManifestSha256: null,
        observedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
        collectionGuardSha256: "2".repeat(64),
      },
    }).success,
    true,
  );
});

test("normalization preserves complete input or canonical unavailable evidence", () => {
  const input = buildPackScoutBuybackEvGoldenInputV1();
  assert.equal(
    packScoutBuybackEvEvidenceOutcomeV1Schema.safeParse({
      status: "complete",
      input,
    }).success,
    true,
  );
  for (const reason of [
    "MISSING_BUYBACK",
    "UNKNOWN_BUYBACK_ELIGIBILITY",
  ] as const) {
    const unavailable = unavailableEvidence([reason]);
    assert.equal(
      packScoutBuybackEvEvidenceOutcomeV1Schema.safeParse(unavailable).success,
      true,
    );
    assert.equal(unavailable.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
  }

  const missingProduct = unavailableEvidence([
    "MISSING_PRODUCT_IDENTITY",
    "MISSING_BUYBACK",
  ]);
  assert.equal(
    packScoutBuybackEvEvidenceOutcomeV1Schema.safeParse({
      ...missingProduct,
      product: { state: "unknown", reference: null },
    }).success,
    true,
  );
  assert.equal(
    packScoutBuybackEvEvidenceOutcomeV1Schema.safeParse({
      ...unavailableEvidence(["MISSING_BUYBACK"]),
      publicPrimaryReason: "VALUE_UNAVAILABLE",
    }).success,
    false,
  );
  assert.deepEqual(
    canonicalizePackScoutBuybackEvInternalReasonsV1([
      "MISSING_BUYBACK",
      "MISSING_PRODUCT_IDENTITY",
      "MISSING_BUYBACK",
    ]),
    ["MISSING_PRODUCT_IDENTITY", "MISSING_BUYBACK"],
  );
});

test("confidence input is protected, versioned, coherent, and allows task 003 to expire stale evidence", () => {
  const base = {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion:
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    oddsSource: "platform_published",
    usedClosedRangeMidpoint: true,
    oldestEssentialObservedAt: PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
    calculatedAt: "2026-08-19T19:00:00.001Z",
    availabilityGate: { status: "passed" },
  };
  assert.equal(packScoutBuybackEvConfidenceInputV1Schema.safeParse(base).success, true);
  assert.equal(
    packScoutBuybackEvConfidenceInputV1Schema.safeParse({
      ...base,
      oddsSource: null,
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvConfidenceInputV1Schema.safeParse({
      ...base,
      calculatedAt: "2026-08-19T17:59:59.999Z",
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvConfidenceInputV1Schema.safeParse({
      ...base,
      modelVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    }).success,
    false,
    "aliases and unknown fields are rejected",
  );
});

test("unsafe numbers and unknown nested fields fail closed", () => {
  const golden = buildPackScoutBuybackEvGoldenInputV1();
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      packPrice: {
        ...golden.packPrice,
        sourceAmount: {
          ...golden.packPrice.sourceAmount,
          minorUnits: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    }).success,
    false,
  );
  assert.equal(
    packScoutBuybackEvInputV1Schema.safeParse({
      ...golden,
      outcomes: [
        {
          ...firstOutcome(),
          buyback: {
            ...firstOutcome().buyback,
            providerPayload: { secret: "must-not-cross" },
          },
        },
      ],
    }).success,
    false,
  );
});
