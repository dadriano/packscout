import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  packScoutBuybackEvConfidenceEvaluationV1Schema,
  packScoutBuybackEvConfidenceInputV1Schema,
  type PackScoutBuybackEvConfidenceEvaluationV1,
  type PackScoutBuybackEvConfidenceInputV1,
} from "@packscout/contracts";
import {
  evaluatePackScoutBuybackEvConfidenceV1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_CONDITION_EXPLANATIONS_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_EXPLANATIONS_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_START_SCORE_BASIS_POINTS,
  PACKSCOUT_BUYBACK_EV_SOURCE_AGE_DELAYED_MAX_MILLISECONDS,
  PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS,
  PACKSCOUT_BUYBACK_EV_SOURCE_AGE_NO_PENALTY_MAX_MILLISECONDS,
} from "./buyback-adjusted-ev-confidence.ts";

const OBSERVED_AT = "2026-08-19T18:00:00.000Z";
const OBSERVED_AT_MILLISECONDS = Date.parse(OBSERVED_AT);
const EXPIRES_AT = "2026-08-19T19:00:00.000Z";

function confidenceInput(
  overrides: Partial<PackScoutBuybackEvConfidenceInputV1> = {},
): PackScoutBuybackEvConfidenceInputV1 {
  return {
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    oddsSource: "current_remaining_inventory",
    usedClosedRangeMidpoint: false,
    oldestEssentialObservedAt: OBSERVED_AT,
    calculatedAt: OBSERVED_AT,
    availabilityGate: { status: "passed" },
    ...overrides,
  };
}

function calculatedAtAfter(ageMilliseconds: number): string {
  return new Date(OBSERVED_AT_MILLISECONDS + ageMilliseconds).toISOString();
}

/** Every evaluation must round-trip through the strict task-003 output contract. */
function evaluate(
  input: PackScoutBuybackEvConfidenceInputV1,
): PackScoutBuybackEvConfidenceEvaluationV1 {
  return packScoutBuybackEvConfidenceEvaluationV1Schema.parse(
    evaluatePackScoutBuybackEvConfidenceV1(input),
  );
}

function expectAvailable(
  evaluation: PackScoutBuybackEvConfidenceEvaluationV1,
): Extract<PackScoutBuybackEvConfidenceEvaluationV1, { status: "available" }> {
  if (evaluation.status !== "available") {
    throw new Error("Expected an available PackScout EV confidence evaluation.");
  }
  return evaluation;
}

function expectUnavailable(
  evaluation: PackScoutBuybackEvConfidenceEvaluationV1,
): Extract<PackScoutBuybackEvConfidenceEvaluationV1, { status: "unavailable" }> {
  if (evaluation.status !== "unavailable") {
    throw new Error(
      "Expected an unavailable PackScout EV confidence evaluation.",
    );
  }
  return evaluation;
}

function rejects(candidate: unknown): void {
  assert.throws(() =>
    evaluatePackScoutBuybackEvConfidenceV1(
      candidate as PackScoutBuybackEvConfidenceInputV1,
    ),
  );
}

test("the exported policy constants match Confidence Policy V1 exactly", () => {
  assert.equal(PACKSCOUT_BUYBACK_EV_CONFIDENCE_START_SCORE_BASIS_POINTS, 10_000);
  assert.equal(PACKSCOUT_BUYBACK_EV_SOURCE_AGE_NO_PENALTY_MAX_MILLISECONDS, 900_000);
  assert.equal(PACKSCOUT_BUYBACK_EV_SOURCE_AGE_DELAYED_MAX_MILLISECONDS, 1_800_000);
  assert.equal(PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS, 3_600_000);
});

test("the sixteen enumerable penalty combinations score exactly per Confidence Policy V1", () => {
  const combinations = [
    // Verified current-pool odds, exact values.
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: false, ageMilliseconds: 0, scoreBasisPoints: 10_000, band: "high", limitationCodes: [] },
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: false, ageMilliseconds: 900_000, scoreBasisPoints: 10_000, band: "high", limitationCodes: [] },
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: false, ageMilliseconds: 1_800_000, scoreBasisPoints: 9_000, band: "high", limitationCodes: ["source_age_over_15_through_30_minutes"] },
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: false, ageMilliseconds: 3_600_000, scoreBasisPoints: 7_500, band: "medium", limitationCodes: ["source_age_over_30_through_60_minutes"] },
    // Verified current-pool odds, at least one closed-range midpoint.
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: true, ageMilliseconds: 0, scoreBasisPoints: 8_000, band: "high", limitationCodes: ["closed_range_midpoint"] },
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: true, ageMilliseconds: 900_000, scoreBasisPoints: 8_000, band: "high", limitationCodes: ["closed_range_midpoint"] },
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: true, ageMilliseconds: 1_800_000, scoreBasisPoints: 7_000, band: "medium", limitationCodes: ["closed_range_midpoint", "source_age_over_15_through_30_minutes"] },
    { oddsSource: "current_remaining_inventory", usedClosedRangeMidpoint: true, ageMilliseconds: 3_600_000, scoreBasisPoints: 5_500, band: "medium", limitationCodes: ["closed_range_midpoint", "source_age_over_30_through_60_minutes"] },
    // Platform-published odds fallback, exact values.
    { oddsSource: "platform_published", usedClosedRangeMidpoint: false, ageMilliseconds: 0, scoreBasisPoints: 8_500, band: "high", limitationCodes: ["platform_published_odds"] },
    { oddsSource: "platform_published", usedClosedRangeMidpoint: false, ageMilliseconds: 900_000, scoreBasisPoints: 8_500, band: "high", limitationCodes: ["platform_published_odds"] },
    { oddsSource: "platform_published", usedClosedRangeMidpoint: false, ageMilliseconds: 1_800_000, scoreBasisPoints: 7_500, band: "medium", limitationCodes: ["platform_published_odds", "source_age_over_15_through_30_minutes"] },
    { oddsSource: "platform_published", usedClosedRangeMidpoint: false, ageMilliseconds: 3_600_000, scoreBasisPoints: 6_000, band: "medium", limitationCodes: ["platform_published_odds", "source_age_over_30_through_60_minutes"] },
    // Platform-published odds fallback with a closed-range midpoint.
    { oddsSource: "platform_published", usedClosedRangeMidpoint: true, ageMilliseconds: 0, scoreBasisPoints: 6_500, band: "medium", limitationCodes: ["closed_range_midpoint", "platform_published_odds"] },
    { oddsSource: "platform_published", usedClosedRangeMidpoint: true, ageMilliseconds: 900_000, scoreBasisPoints: 6_500, band: "medium", limitationCodes: ["closed_range_midpoint", "platform_published_odds"] },
    { oddsSource: "platform_published", usedClosedRangeMidpoint: true, ageMilliseconds: 1_800_000, scoreBasisPoints: 5_500, band: "medium", limitationCodes: ["closed_range_midpoint", "platform_published_odds", "source_age_over_15_through_30_minutes"] },
    { oddsSource: "platform_published", usedClosedRangeMidpoint: true, ageMilliseconds: 3_600_000, scoreBasisPoints: 4_000, band: "low", limitationCodes: ["closed_range_midpoint", "platform_published_odds", "source_age_over_30_through_60_minutes"] },
  ] as const;
  assert.equal(combinations.length, 16);

  for (const combination of combinations) {
    const evaluation = expectAvailable(
      evaluate(
        confidenceInput({
          oddsSource: combination.oddsSource,
          usedClosedRangeMidpoint: combination.usedClosedRangeMidpoint,
          calculatedAt: calculatedAtAfter(combination.ageMilliseconds),
        }),
      ),
    );
    const label = `${combination.oddsSource}/${String(combination.usedClosedRangeMidpoint)}/${combination.ageMilliseconds}`;
    assert.equal(
      evaluation.confidence.policyVersion,
      "packscout-buyback-adjusted-ev-confidence-v1",
      label,
    );
    assert.equal(
      evaluation.confidence.scoreBasisPoints,
      combination.scoreBasisPoints,
      label,
    );
    assert.equal(evaluation.confidence.band, combination.band, label);
    assert.deepEqual(
      evaluation.confidence.limitationCodes,
      [...combination.limitationCodes],
      label,
    );
    assert.equal(
      evaluation.freshness.sourceAgeMilliseconds,
      combination.ageMilliseconds,
      label,
    );
    assert.equal(evaluation.freshness.expiresAt, EXPIRES_AT, label);
    assert.deepEqual(
      evaluation.dataAsOf,
      { state: "known", observedAt: OBSERVED_AT },
      label,
    );
  }
});

test("freshness boundaries are inclusive to the exact millisecond", () => {
  const at15 = expectAvailable(
    evaluate(confidenceInput({ calculatedAt: calculatedAtAfter(900_000) })),
  );
  assert.equal(at15.confidence.scoreBasisPoints, 10_000);
  assert.deepEqual(at15.confidence.limitationCodes, []);

  const past15 = expectAvailable(
    evaluate(confidenceInput({ calculatedAt: calculatedAtAfter(900_001) })),
  );
  assert.equal(past15.confidence.scoreBasisPoints, 9_000);
  assert.deepEqual(past15.confidence.limitationCodes, [
    "source_age_over_15_through_30_minutes",
  ]);

  const at30 = expectAvailable(
    evaluate(confidenceInput({ calculatedAt: calculatedAtAfter(1_800_000) })),
  );
  assert.equal(at30.confidence.scoreBasisPoints, 9_000);
  assert.deepEqual(at30.confidence.limitationCodes, [
    "source_age_over_15_through_30_minutes",
  ]);

  const past30 = expectAvailable(
    evaluate(confidenceInput({ calculatedAt: calculatedAtAfter(1_800_001) })),
  );
  assert.equal(past30.confidence.scoreBasisPoints, 7_500);
  assert.deepEqual(past30.confidence.limitationCodes, [
    "source_age_over_30_through_60_minutes",
  ]);

  const at60 = expectAvailable(
    evaluate(confidenceInput({ calculatedAt: calculatedAtAfter(3_600_000) })),
  );
  assert.equal(at60.confidence.scoreBasisPoints, 7_500);
  assert.deepEqual(at60.confidence.limitationCodes, [
    "source_age_over_30_through_60_minutes",
  ]);
  assert.equal(at60.freshness.state, "current");
  assert.equal(at60.freshness.sourceAgeMilliseconds, 3_600_000);

  const past60 = expectUnavailable(
    evaluate(confidenceInput({ calculatedAt: calculatedAtAfter(3_600_001) })),
  );
  assert.equal(past60.freshness.state, "expired");
  assert.equal(past60.confidence, null);
});

test("evidence older than sixty minutes expires instead of retaining a low score", () => {
  const justExpired = expectUnavailable(
    evaluate(confidenceInput({ calculatedAt: calculatedAtAfter(3_600_001) })),
  );
  assert.equal(justExpired.confidence, null);
  assert.deepEqual(justExpired.dataAsOf, {
    state: "known",
    observedAt: OBSERVED_AT,
  });
  assert.deepEqual(justExpired.freshness, {
    state: "expired",
    sourceAgeMilliseconds: 3_600_001,
    expiresAt: EXPIRES_AT,
    reason: "STALE_EVIDENCE",
  });

  const longExpired = expectUnavailable(
    evaluate(
      confidenceInput({ calculatedAt: calculatedAtAfter(2 * 3_600_000) }),
    ),
  );
  assert.equal(longExpired.confidence, null);
  assert.equal(longExpired.freshness.state, "expired");
  assert.equal(longExpired.freshness.sourceAgeMilliseconds, 7_200_000);
  assert.equal(longExpired.freshness.expiresAt, EXPIRES_AT);
});

test("a missing essential observation time is unavailable with the unknown-source-time state", () => {
  const unknownTime = expectUnavailable(
    evaluate(
      confidenceInput({
        oddsSource: null,
        oldestEssentialObservedAt: null,
        availabilityGate: {
          status: "failed",
          internalReasons: ["MISSING_SOURCE_TIME"],
        },
      }),
    ),
  );
  assert.equal(unknownTime.confidence, null);
  assert.deepEqual(unknownTime.dataAsOf, {
    state: "unknown_source_time",
    observedAt: null,
  });
  assert.deepEqual(unknownTime.freshness, {
    state: "unknown_source_time",
    sourceAgeMilliseconds: null,
    expiresAt: null,
    reason: "MISSING_SOURCE_TIME",
  });
});

test("a failed availability gate never fabricates a confidence score", () => {
  const withoutEvidence = expectUnavailable(
    evaluate(
      confidenceInput({
        oddsSource: null,
        oldestEssentialObservedAt: null,
        availabilityGate: {
          status: "failed",
          internalReasons: ["MISSING_BUYBACK"],
        },
      }),
    ),
  );
  assert.equal(withoutEvidence.confidence, null);
  assert.equal(withoutEvidence.freshness.state, "unknown_source_time");

  const withStaleEvidence = expectUnavailable(
    evaluate(
      confidenceInput({
        calculatedAt: calculatedAtAfter(2 * 3_600_000),
        availabilityGate: {
          status: "failed",
          internalReasons: ["MISSING_BUYBACK"],
        },
      }),
    ),
  );
  assert.equal(withStaleEvidence.confidence, null);
  assert.equal(withStaleEvidence.freshness.state, "expired");

  // A failed gate whose known evidence is still current cannot be expressed
  // as a freshness-owned unavailable evaluation; it fails closed instead of
  // receiving a fabricated score or a misstated time state.
  rejects(
    confidenceInput({
      calculatedAt: calculatedAtAfter(300_000),
      availabilityGate: {
        status: "failed",
        internalReasons: ["MISSING_BUYBACK"],
      },
    }),
  );
});

test("the confidence input excludes EV, Heat, vendor EV, and chase-match evidence by construction", () => {
  for (const excludedField of [
    "grossEvMoney",
    "grossReturnBasisPoints",
    "evDollars",
    "evPercentBasisPoints",
    "evSign",
    "heatScore",
    "vendorReportedEv",
    "chaseMatchConfidence",
  ]) {
    assert.equal(
      packScoutBuybackEvConfidenceInputV1Schema.safeParse({
        ...confidenceInput(),
        [excludedField]: 1,
      }).success,
      false,
      `${excludedField} must not enter the confidence boundary`,
    );
  }

  const input = confidenceInput({
    oddsSource: "platform_published",
    usedClosedRangeMidpoint: true,
    calculatedAt: calculatedAtAfter(1_200_000),
  });
  assert.deepEqual(
    evaluate(input),
    evaluate(structuredClone(input)),
    "identical evidence always receives identical confidence",
  );
});

test("limitation codes stay canonical, deduplicated, and bounded", () => {
  const combined = expectAvailable(
    evaluate(
      confidenceInput({
        oddsSource: "platform_published",
        usedClosedRangeMidpoint: true,
        calculatedAt: calculatedAtAfter(45 * 60_000),
      }),
    ),
  );
  assert.deepEqual(combined.confidence.limitationCodes, [
    "closed_range_midpoint",
    "platform_published_odds",
    "source_age_over_30_through_60_minutes",
  ]);
  assert.equal(
    new Set(combined.confidence.limitationCodes).size,
    combined.confidence.limitationCodes.length,
  );
  const canonicalIndices = combined.confidence.limitationCodes.map((code) =>
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1.indexOf(code),
  );
  assert.equal(
    canonicalIndices.every(
      (index, position) =>
        index >= 0 && (position === 0 || canonicalIndices[position - 1]! < index),
    ),
    true,
  );
});

test("the expiry deadline is exactly sixty minutes after the oldest essential observation", () => {
  const observedAt = "2026-08-19T18:00:00.123Z";
  const fresh = expectAvailable(
    evaluate(
      confidenceInput({
        oldestEssentialObservedAt: observedAt,
        calculatedAt: observedAt,
      }),
    ),
  );
  assert.equal(fresh.freshness.expiresAt, "2026-08-19T19:00:00.123Z");

  const delayed = expectAvailable(
    evaluate(
      confidenceInput({
        oldestEssentialObservedAt: observedAt,
        calculatedAt: new Date(
          Date.parse(observedAt) + 20 * 60_000,
        ).toISOString(),
      }),
    ),
  );
  assert.equal(delayed.freshness.expiresAt, "2026-08-19T19:00:00.123Z");
  assert.equal(delayed.freshness.sourceAgeMilliseconds, 1_200_000);
});

test("unsupported versions and inconsistent time states fail closed", () => {
  rejects({
    ...confidenceInput(),
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v2",
  });
  rejects({
    ...confidenceInput(),
    methodVersion: "packscout-buyback-adjusted-ev-v2",
  });
  rejects({ ...confidenceInput(), schemaVersion: "packscout_buyback_ev_v2" });
  rejects({ ...confidenceInput(), visibility: "public" });
  rejects(
    confidenceInput({ calculatedAt: "2026-08-19T17:59:59.999Z" }),
    // The calculation can never precede the evidence it consumed.
  );
  rejects(confidenceInput({ oldestEssentialObservedAt: null }));
  rejects(confidenceInput({ oddsSource: null }));
  rejects(
    confidenceInput({
      oldestEssentialObservedAt: "2026-08-19T18:00:00Z",
      calculatedAt: "2026-08-19T18:00:00Z",
    }),
  );
  rejects({ ...confidenceInput(), unexpectedField: true });
});

test("public explanations stay bounded and never describe outcomes or provider payloads", () => {
  assert.equal(
    Object.isFrozen(PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_EXPLANATIONS_V1),
    true,
  );
  assert.equal(
    Object.isFrozen(PACKSCOUT_BUYBACK_EV_CONFIDENCE_CONDITION_EXPLANATIONS_V1),
    true,
  );
  assert.deepEqual(
    Object.keys(PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_EXPLANATIONS_V1).sort(),
    [...PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1],
    "every limitation code has exactly one approved explanation",
  );
  assert.deepEqual(
    Object.keys(PACKSCOUT_BUYBACK_EV_CONFIDENCE_CONDITION_EXPLANATIONS_V1).sort(),
    ["current", "evidence_gate_failed", "expired", "unknown_source_time"],
    "every freshness and unavailability condition has exactly one approved explanation",
  );

  const forbiddenWords = [
    "profit",
    "return",
    "guarantee",
    "payout",
    "payload",
    "provider",
  ];
  const entries = [
    ...Object.values(PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_EXPLANATIONS_V1),
    ...Object.values(PACKSCOUT_BUYBACK_EV_CONFIDENCE_CONDITION_EXPLANATIONS_V1),
  ];
  for (const entry of entries) {
    assert.equal(typeof entry, "string");
    assert.equal(entry.length > 0 && entry.length <= 200, true);
    for (const forbiddenWord of forbiddenWords) {
      assert.equal(
        entry.toLowerCase().includes(forbiddenWord),
        false,
        `approved copy must never contain "${forbiddenWord}": ${entry}`,
      );
    }
  }
});
