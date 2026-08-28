import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPackScoutBuybackEvGoldenCalculationResultV1,
  buildPackScoutBuybackEvGoldenProtectedResultV1,
  PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT,
} from "./__fixtures__/buyback-adjusted-ev-v1.fixture.ts";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  isStrictlyCodeUnitSortedUnique,
  packScoutBuybackEvConfidenceEvaluationV1Schema,
  packScoutBuybackEvMetricsAreConsistentV1,
  packScoutBuybackEvProtectedCalculationResultV1Schema,
  packScoutBuybackEvProtectedResultV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
  type PackScoutBuybackEvProtectedResultV1,
} from "./index.ts";

const OBSERVED_AT = PACKSCOUT_BUYBACK_EV_GOLDEN_OBSERVED_AT;
const EXPIRES_AT = "2026-08-19T19:00:00.000Z";

function goldenAvailable() {
  const result = buildPackScoutBuybackEvGoldenProtectedResultV1();
  if (result.status !== "available") {
    throw new Error("The PackScout EV golden result must remain available.");
  }
  return structuredClone(result);
}

function unavailableResult(
  internalReasons: readonly PackScoutBuybackEvInternalReasonCodeV1[],
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const golden = goldenAvailable();
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
    confidence: null,
    calculatedAt: OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: OBSERVED_AT },
    freshness: {
      state: "current",
      sourceAgeMilliseconds: 0,
      expiresAt: EXPIRES_AT,
    },
    provenance: golden.provenance,
    protectedEvidence: null,
    internalReasons,
    publicPrimaryReason:
      packScoutBuybackEvPublicReasonForInternalReasonsV1(internalReasons),
    ...overrides,
  };
}

test("the golden result is exactly $85 gross, 85%, -$15 EV, and -15% at high confidence", () => {
  const result = packScoutBuybackEvProtectedResultV1Schema.parse(
    goldenAvailable(),
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;

  assert.deepEqual(result.grossEvMoney, { minorUnits: 8_500, currency: "USD" });
  assert.equal(result.grossReturnBasisPoints, 8_500);
  assert.deepEqual(result.evDollars, { minorUnits: -1_500, currency: "USD" });
  assert.equal(result.evPercentBasisPoints, -1_500);
  assert.equal(result.confidence.scoreBasisPoints, 10_000);
  assert.equal(result.confidence.band, "high");
  assert.deepEqual(result.confidence.limitationCodes, []);
  assert.equal(result.freshness.expiresAt, EXPIRES_AT);
});

test("tampered four-metric arithmetic fails validation", () => {
  const tampering: readonly Partial<PackScoutBuybackEvProtectedResultV1>[] = [
    { grossEvMoney: { minorUnits: 8_501, currency: "USD" } },
    { grossReturnBasisPoints: 8_501 },
    { evDollars: { minorUnits: 1_500, currency: "USD" } },
    { evPercentBasisPoints: 1_500 },
  ];
  for (const tampered of tampering) {
    assert.equal(
      packScoutBuybackEvProtectedResultV1Schema.safeParse({
        ...goldenAvailable(),
        ...tampered,
      }).success,
      false,
    );
  }
});

test("basis points derive from rounded money with deterministic half-up rounding", () => {
  assert.equal(
    packScoutBuybackEvMetricsAreConsistentV1({
      grossEvMinorUnits: 1,
      grossReturnBasisPoints: 1,
      evDollarsMinorUnits: -19_999,
      evPercentBasisPoints: -9_999,
      packPriceMinorUnits: 20_000,
    }),
    true,
    "an exact half basis point rounds up",
  );
  assert.equal(
    packScoutBuybackEvMetricsAreConsistentV1({
      grossEvMinorUnits: 1,
      grossReturnBasisPoints: 0,
      evDollarsMinorUnits: -19_999,
      evPercentBasisPoints: -10_000,
      packPriceMinorUnits: 20_000,
    }),
    false,
  );
  assert.equal(
    packScoutBuybackEvMetricsAreConsistentV1({
      grossEvMinorUnits: 1_000_000_000_000,
      grossReturnBasisPoints: 10_000_000_000_000_000,
      evDollarsMinorUnits: 999_999_999_999,
      evPercentBasisPoints: 10_000_000_000_000_000 - 10_000,
      packPriceMinorUnits: 1,
    }),
    true,
    "exact bigint arithmetic holds for extreme magnitudes",
  );
  assert.equal(
    packScoutBuybackEvMetricsAreConsistentV1({
      grossEvMinorUnits: 8_500,
      grossReturnBasisPoints: 8_500,
      evDollarsMinorUnits: -1_500,
      evPercentBasisPoints: -1_500,
      packPriceMinorUnits: 0,
    }),
    false,
    "a non-positive pack price never has consistent metrics",
  );
});

test("unsafe metric magnitudes fail closed at the result boundary", () => {
  const golden = goldenAvailable();
  golden.grossEvMoney.minorUnits = 1_000_000_000_000;
  golden.protectedEvidence.packPriceMoney.minorUnits = 1;
  golden.evDollars.minorUnits = 999_999_999_999;
  golden.grossReturnBasisPoints = 10_000_000_000_000_000;
  golden.evPercentBasisPoints = 10_000_000_000_000_000 - 10_000;
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(golden).success,
    false,
    "basis points beyond safe integers are rejected even when arithmetic matches",
  );
});

test("valid zero gross EV and neutral EV stay distinct from unavailable", () => {
  const zeroPayout = goldenAvailable();
  zeroPayout.grossEvMoney.minorUnits = 0;
  zeroPayout.grossReturnBasisPoints = 0;
  zeroPayout.evDollars.minorUnits = -10_000;
  zeroPayout.evPercentBasisPoints = -10_000;
  const zeroParsed =
    packScoutBuybackEvProtectedResultV1Schema.parse(zeroPayout);
  assert.equal(zeroParsed.status, "available");

  const neutral = goldenAvailable();
  neutral.grossEvMoney.minorUnits = 10_000;
  neutral.grossReturnBasisPoints = 10_000;
  neutral.evDollars.minorUnits = 0;
  neutral.evPercentBasisPoints = 0;
  const neutralParsed = packScoutBuybackEvProtectedResultV1Schema.parse(neutral);
  assert.equal(neutralParsed.status, "available");

  const unavailable = packScoutBuybackEvProtectedResultV1Schema.parse(
    unavailableResult(["MISSING_BUYBACK"]),
  );
  assert.equal(unavailable.status, "unavailable");
  if (unavailable.status !== "unavailable") return;
  assert.equal(unavailable.grossEvMoney, null);
  assert.equal(unavailable.confidence, null);
  assert.equal(unavailable.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
});

test("confidence scores, bands, and limitation order validate against the exact policy", () => {
  assert.deepEqual(
    { ...PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1 },
    {
      platformPublishedOdds: 1_500,
      closedRangeMidpoint: 2_000,
      sourceAgeOver15Through30Minutes: 1_000,
      sourceAgeOver30Through60Minutes: 2_500,
    },
  );

  const publishedOdds = goldenAvailable();
  publishedOdds.provenance.oddsSource = "platform_published";
  publishedOdds.confidence = {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 8_500,
    band: "high",
    limitationCodes: ["platform_published_odds"],
  };
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(publishedOdds).success,
    true,
  );

  const scoreMismatch = goldenAvailable();
  scoreMismatch.confidence.scoreBasisPoints = 9_999;
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(scoreMismatch).success,
    false,
  );

  const bandMismatch = structuredClone(publishedOdds);
  bandMismatch.confidence.band = "medium";
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(bandMismatch).success,
    false,
  );

  const evidenceMismatch = goldenAvailable();
  evidenceMismatch.confidence = structuredClone(publishedOdds.confidence);
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(evidenceMismatch)
      .success,
    false,
    "limitations must match the evidence recorded in provenance",
  );

  const unorderedCodes = structuredClone(publishedOdds);
  unorderedCodes.provenance.usedClosedRangeMidpoint = true;
  unorderedCodes.confidence = {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 6_500,
    band: "medium",
    limitationCodes: ["platform_published_odds", "closed_range_midpoint"],
  };
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(unorderedCodes).success,
    false,
    "limitation codes must stay in canonical order without duplicates",
  );
});

test("delayed evidence applies the exact freshness penalty at each boundary", () => {
  const delayed = goldenAvailable();
  delayed.calculatedAt = "2026-08-19T18:20:00.000Z";
  delayed.freshness = {
    state: "current",
    sourceAgeMilliseconds: 20 * 60_000,
    expiresAt: EXPIRES_AT,
  };
  delayed.confidence = {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 9_000,
    band: "high",
    limitationCodes: ["source_age_over_15_through_30_minutes"],
  };
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(delayed).success,
    true,
  );

  const combined = goldenAvailable();
  combined.calculatedAt = "2026-08-19T18:45:00.000Z";
  combined.provenance.oddsSource = "platform_published";
  combined.provenance.usedClosedRangeMidpoint = true;
  combined.freshness = {
    state: "current",
    sourceAgeMilliseconds: 45 * 60_000,
    expiresAt: EXPIRES_AT,
  };
  combined.confidence = {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 4_000,
    band: "low",
    limitationCodes: [
      "closed_range_midpoint",
      "platform_published_odds",
      "source_age_over_30_through_60_minutes",
    ],
  };
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(combined).success,
    true,
    "penalties are additive and the combined low band validates",
  );

  const conflictingAges = structuredClone(delayed);
  conflictingAges.confidence = {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 6_500,
    band: "medium",
    limitationCodes: [
      "source_age_over_15_through_30_minutes",
      "source_age_over_30_through_60_minutes",
    ],
  };
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(conflictingAges)
      .success,
    false,
    "the two freshness penalties are mutually exclusive",
  );
});

test("an available result cannot outlive its 60-minute deadline or misstate it", () => {
  const staleAvailable = goldenAvailable();
  staleAvailable.calculatedAt = "2026-08-19T19:00:00.001Z";
  staleAvailable.freshness = {
    state: "current",
    sourceAgeMilliseconds: 60 * 60_000 + 1,
    expiresAt: EXPIRES_AT,
  };
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(staleAvailable).success,
    false,
    "evidence older than 60 minutes can never be available",
  );

  const wrongDeadline = goldenAvailable();
  wrongDeadline.freshness.expiresAt = "2026-08-19T19:00:00.001Z";
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(wrongDeadline).success,
    false,
    "the deadline is exactly 60 minutes after the oldest essential observation",
  );

  const wrongAge = goldenAvailable();
  wrongAge.freshness.sourceAgeMilliseconds = 1;
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(wrongAge).success,
    false,
  );

  const exactDeadline = goldenAvailable();
  exactDeadline.calculatedAt = EXPIRES_AT;
  exactDeadline.freshness.sourceAgeMilliseconds = 60 * 60_000;
  exactDeadline.confidence = {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 7_500,
    band: "medium",
    limitationCodes: ["source_age_over_30_through_60_minutes"],
  };
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(exactDeadline).success,
    true,
    "evidence at exactly 60 minutes remains available with the 30-through-60 penalty",
  );
});

test("unavailable results keep reasons canonical and consistent with their evidence", () => {
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(
      unavailableResult(["STALE_EVIDENCE", "MISSING_BUYBACK"]),
    ).success,
    false,
    "internal reasons must stay in canonical order",
  );
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(
      unavailableResult(["MISSING_BUYBACK"], {
        publicPrimaryReason: "SOURCE_EVIDENCE_UNAVAILABLE",
      }),
    ).success,
    false,
    "the public reason is derived, never chosen",
  );
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(
      unavailableResult(["MISSING_PROVENANCE", "MISSING_BUYBACK"]),
    ).success,
    false,
    "provenance cannot be present when its absence is a reason",
  );
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(
      unavailableResult(["MISSING_PROVENANCE", "MISSING_BUYBACK"], {
        provenance: null,
      }),
    ).success,
    true,
  );

  const stale = unavailableResult(["STALE_EVIDENCE"], {
    calculatedAt: "2026-08-19T19:00:00.001Z",
    freshness: {
      state: "expired",
      sourceAgeMilliseconds: 60 * 60_000 + 1,
      expiresAt: EXPIRES_AT,
      reason: "STALE_EVIDENCE",
    },
  });
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(stale).success,
    true,
  );
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(
      unavailableResult(["MISSING_BUYBACK"], {
        calculatedAt: "2026-08-19T19:00:00.001Z",
        freshness: {
          state: "expired",
          sourceAgeMilliseconds: 60 * 60_000 + 1,
          expiresAt: EXPIRES_AT,
          reason: "STALE_EVIDENCE",
        },
      }),
    ).success,
    false,
    "evidence past the deadline must record the stale reason",
  );

  const unknownTime = unavailableResult(["MISSING_SOURCE_TIME"], {
    dataAsOf: { state: "unknown_source_time", observedAt: null },
    freshness: {
      state: "unknown_source_time",
      sourceAgeMilliseconds: null,
      expiresAt: null,
      reason: "MISSING_SOURCE_TIME",
    },
  });
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(unknownTime).success,
    true,
  );
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(
      unavailableResult(["MISSING_SOURCE_TIME", "STALE_EVIDENCE"], {
        dataAsOf: { state: "unknown_source_time", observedAt: null },
        freshness: {
          state: "unknown_source_time",
          sourceAgeMilliseconds: null,
          expiresAt: null,
          reason: "MISSING_SOURCE_TIME",
        },
      }),
    ).success,
    false,
    "staleness is unknowable without a source observation time",
  );
});

test("confidence evaluations validate available, expired, and unknown-time states", () => {
  const shared = {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  };
  assert.equal(
    packScoutBuybackEvConfidenceEvaluationV1Schema.safeParse({
      ...shared,
      status: "available",
      confidence: {
        policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        scoreBasisPoints: 9_000,
        band: "high",
        limitationCodes: ["source_age_over_15_through_30_minutes"],
      },
      calculatedAt: "2026-08-19T18:20:00.000Z",
      dataAsOf: { state: "known", observedAt: OBSERVED_AT },
      freshness: {
        state: "current",
        sourceAgeMilliseconds: 20 * 60_000,
        expiresAt: EXPIRES_AT,
      },
    }).success,
    true,
  );
  assert.equal(
    packScoutBuybackEvConfidenceEvaluationV1Schema.safeParse({
      ...shared,
      status: "unavailable",
      confidence: null,
      calculatedAt: "2026-08-19T19:00:00.001Z",
      dataAsOf: { state: "known", observedAt: OBSERVED_AT },
      freshness: {
        state: "expired",
        sourceAgeMilliseconds: 60 * 60_000 + 1,
        expiresAt: EXPIRES_AT,
        reason: "STALE_EVIDENCE",
      },
    }).success,
    true,
    "expiry omits confidence instead of keeping a low score",
  );
  assert.equal(
    packScoutBuybackEvConfidenceEvaluationV1Schema.safeParse({
      ...shared,
      status: "unavailable",
      confidence: null,
      calculatedAt: OBSERVED_AT,
      dataAsOf: { state: "known", observedAt: OBSERVED_AT },
      freshness: {
        state: "unknown_source_time",
        sourceAgeMilliseconds: null,
        expiresAt: null,
        reason: "MISSING_SOURCE_TIME",
      },
    }).success,
    false,
    "a known observation time cannot pair with unknown freshness",
  );
  assert.equal(
    packScoutBuybackEvConfidenceEvaluationV1Schema.safeParse({
      ...shared,
      status: "available",
      confidence: {
        policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        scoreBasisPoints: 10_000,
        band: "high",
        limitationCodes: [],
      },
      calculatedAt: "2026-08-19T18:20:00.000Z",
      dataAsOf: { state: "known", observedAt: OBSERVED_AT },
      freshness: {
        state: "current",
        sourceAgeMilliseconds: 20 * 60_000,
        expiresAt: EXPIRES_AT,
      },
    }).success,
    false,
    "delayed evidence must carry its freshness limitation",
  );
});

test("calculation results bind their confidence input to the calculation evidence", () => {
  const golden = packScoutBuybackEvProtectedCalculationResultV1Schema.parse(
    buildPackScoutBuybackEvGoldenCalculationResultV1(),
  );
  assert.equal(golden.status, "available");

  const oddsMismatch = structuredClone(
    buildPackScoutBuybackEvGoldenCalculationResultV1(),
  );
  if (oddsMismatch.status !== "available") throw new Error("unexpected");
  oddsMismatch.confidenceInput.oddsSource = "platform_published";
  assert.equal(
    packScoutBuybackEvProtectedCalculationResultV1Schema.safeParse(oddsMismatch)
      .success,
    false,
  );

  const clockMismatch = structuredClone(
    buildPackScoutBuybackEvGoldenCalculationResultV1(),
  );
  if (clockMismatch.status !== "available") throw new Error("unexpected");
  clockMismatch.confidenceInput.calculatedAt = "2026-08-19T18:00:00.001Z";
  assert.equal(
    packScoutBuybackEvProtectedCalculationResultV1Schema.safeParse(
      clockMismatch,
    ).success,
    false,
  );

  const failedGateOnAvailable = structuredClone(
    buildPackScoutBuybackEvGoldenCalculationResultV1(),
  );
  if (failedGateOnAvailable.status !== "available") throw new Error("unexpected");
  failedGateOnAvailable.confidenceInput.availabilityGate = {
    status: "failed",
    internalReasons: ["MISSING_BUYBACK"],
  };
  assert.equal(
    packScoutBuybackEvProtectedCalculationResultV1Schema.safeParse(
      failedGateOnAvailable,
    ).success,
    false,
  );

  const golden2 = buildPackScoutBuybackEvGoldenCalculationResultV1();
  if (golden2.status !== "available") throw new Error("unexpected");
  const unavailable = {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "unavailable",
    grossEvMoney: null,
    grossReturnBasisPoints: null,
    evDollars: null,
    evPercentBasisPoints: null,
    calculatedAt: OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: OBSERVED_AT },
    provenance: golden2.provenance,
    protectedEvidence: null,
    confidenceInput: {
      schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
      oddsSource: null,
      usedClosedRangeMidpoint: false,
      oldestEssentialObservedAt: null,
      calculatedAt: OBSERVED_AT,
      availabilityGate: {
        status: "failed",
        internalReasons: ["MISSING_BUYBACK"],
      },
    },
    internalReasons: ["MISSING_BUYBACK"],
    publicPrimaryReason: "BUYBACK_UNAVAILABLE",
  };
  assert.equal(
    packScoutBuybackEvProtectedCalculationResultV1Schema.safeParse(unavailable)
      .success,
    true,
  );
  assert.equal(
    packScoutBuybackEvProtectedCalculationResultV1Schema.safeParse({
      ...unavailable,
      internalReasons: ["UNKNOWN_BUYBACK_ELIGIBILITY"],
      publicPrimaryReason: "BUYBACK_UNAVAILABLE",
    }).success,
    false,
    "the failed gate and result reasons must match exactly",
  );
});

test("result boundaries reject unknown fields and name every protected field", () => {
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse({
      ...goldenAvailable(),
      rawProviderPayload: {},
    }).success,
    false,
  );
  const withNestedUnknown = goldenAvailable();
  (withNestedUnknown.provenance as Record<string, unknown>)["sourcePayload"] =
    "leak";
  assert.equal(
    packScoutBuybackEvProtectedResultV1Schema.safeParse(withNestedUnknown)
      .success,
    false,
  );

  assert.equal(
    Object.isFrozen(PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1),
    true,
  );
  assert.equal(
    isStrictlyCodeUnitSortedUnique(PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1),
    true,
  );
  for (const fieldName of [
    "internalReasons",
    "protectedEvidence",
    "provenance",
    "visibility",
  ]) {
    assert.equal(
      PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1.includes(
        fieldName as (typeof PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1)[number],
      ),
      true,
    );
  }
  assert.equal(
    isStrictlyCodeUnitSortedUnique(
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
    ),
    true,
  );
});
