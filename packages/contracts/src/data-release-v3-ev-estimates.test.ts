import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPackScoutPublicEvConfidenceV3,
  buildPackScoutPublicEvDelayedV3,
  buildPackScoutPublicEvExpiredV3,
  buildPackScoutPublicEvMetricsV3,
  buildPackScoutPublicEvNegativeV3,
  buildPackScoutPublicEvNeutralV3,
  buildPackScoutPublicEvSoldOutHistoricalV3,
  buildPackScoutPublicEvUnavailableV3,
  buildPackScoutPublicEvUnknownTimeV3,
  buildPackScoutPublicEvZeroV3,
  buildVendorReportedEvAvailableV3,
  buildVendorReportedEvUnavailableV3,
  DATA_RELEASE_V3_EXPIRES_AT,
  DATA_RELEASE_V3_OBSERVED_AT,
} from "./__fixtures__/data-release-v3.fixture.ts";
import {
  containsProtectedEvPublicationKeyV3,
  DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1,
  packScoutPublicEvV3IsPresentableAt,
  packScoutPublicEvV3Schema,
  publicBuybackSummaryV3Schema,
  publicEvEstimatesV3Schema,
  safeParsePackScoutPublicEvV3,
  vendorReportedEvV3Schema,
  type PackScoutPublicEvV3,
} from "./index.ts";

function currentEstimate(): Extract<PackScoutPublicEvV3, { status: "current" }> {
  const estimate = buildPackScoutPublicEvNegativeV3();
  if (estimate.status !== "current") {
    throw new Error("The golden negative estimate must be current.");
  }
  return structuredClone(estimate);
}

test("the golden current estimate keeps the exact approved four-metric semantics", () => {
  const estimate = packScoutPublicEvV3Schema.parse(
    buildPackScoutPublicEvNegativeV3(),
  );
  assert.equal(estimate.status, "current");
  if (estimate.status !== "current") return;
  assert.deepEqual(estimate.metrics.grossEvMoney, {
    minorUnits: 8_500,
    currency: "USD",
  });
  assert.equal(estimate.metrics.grossReturnBasisPoints, 8_500);
  assert.deepEqual(estimate.metrics.evDollars, {
    minorUnits: -1_500,
    currency: "USD",
  });
  assert.equal(estimate.metrics.evPercentBasisPoints, -1_500);
  assert.equal(estimate.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
  assert.equal(
    estimate.confidencePolicyVersion,
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  );
  assert.equal(estimate.confidence.scoreBasisPoints, 10_000);
  assert.equal(estimate.confidence.band, "high");
  assert.equal(estimate.expiresAt, DATA_RELEASE_V3_EXPIRES_AT);
  assert.equal(estimate.sourceAge.state, "fresh_within_15_minutes");
});

test("positive estimates fail closed while neutral and valid-zero remain available", () => {
  const positive = currentEstimate();
  positive.metrics = buildPackScoutPublicEvMetricsV3(12_000);
  assert.equal(packScoutPublicEvV3Schema.safeParse(positive).success, false);

  const independentlyPositiveDollars = currentEstimate();
  independentlyPositiveDollars.metrics.evDollars.minorUnits = 1;
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(independentlyPositiveDollars).success,
    false,
  );

  const neutral = buildPackScoutPublicEvNeutralV3();
  assert.equal(neutral.status, "current");
  if (neutral.status === "current") {
    assert.equal(neutral.metrics.evDollars.minorUnits, 0);
    assert.equal(neutral.metrics.evPercentBasisPoints, 0);
  }
  const zero = buildPackScoutPublicEvZeroV3();
  assert.equal(zero.status, "current");
  if (zero.status === "current") {
    assert.equal(zero.metrics.grossEvMoney.minorUnits, 0);
    assert.equal(zero.metrics.evDollars.minorUnits, -10_000);
  }
  const unavailable = buildPackScoutPublicEvUnavailableV3();
  assert.equal(unavailable.status, "unavailable");
  if (unavailable.status === "unavailable") {
    assert.equal(unavailable.metrics, null);
    assert.equal(unavailable.confidence, null);
    assert.equal(unavailable.reason, "BUYBACK_UNAVAILABLE");
  }
});

test("a delayed current estimate carries the exact freshness limitation and state", () => {
  const delayed = buildPackScoutPublicEvDelayedV3();
  assert.equal(delayed.status, "current");
  if (delayed.status !== "current") return;
  assert.equal(delayed.sourceAge.state, "delayed_over_15_through_30_minutes");
  assert.equal(delayed.confidence.scoreBasisPoints, 9_000);
  assert.deepEqual(delayed.confidence.limitationCodes, [
    "source_age_over_15_through_30_minutes",
  ]);

  const missingLimitation = structuredClone(delayed);
  missingLimitation.confidence = buildPackScoutPublicEvConfidenceV3();
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(missingLimitation).success,
    false,
    "delayed evidence must carry its freshness limitation",
  );

  const wrongAgeState = structuredClone(delayed);
  wrongAgeState.sourceAge = {
    milliseconds: 20 * 60_000,
    state: "fresh_within_15_minutes",
  };
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(wrongAgeState).success,
    false,
  );
});

test("expiry timing is exactly 60 minutes after the oldest essential observation", () => {
  const wrongDeadline = currentEstimate();
  wrongDeadline.expiresAt = "2026-08-19T19:00:00.001Z";
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(wrongDeadline).success,
    false,
  );

  const wrongAge = currentEstimate();
  wrongAge.sourceAge = { milliseconds: 1, state: "fresh_within_15_minutes" };
  assert.equal(packScoutPublicEvV3Schema.safeParse(wrongAge).success, false);

  const pastWindow = currentEstimate();
  pastWindow.calculatedAt = "2026-08-19T19:00:00.001Z";
  pastWindow.sourceAge = {
    milliseconds: 60 * 60_000,
    state: "delayed_over_30_through_60_minutes",
  };
  assert.equal(packScoutPublicEvV3Schema.safeParse(pastWindow).success, false);

  const exactDeadline = currentEstimate();
  exactDeadline.calculatedAt = DATA_RELEASE_V3_EXPIRES_AT;
  exactDeadline.sourceAge = {
    milliseconds: 60 * 60_000,
    state: "delayed_over_30_through_60_minutes",
  };
  exactDeadline.confidence = buildPackScoutPublicEvConfidenceV3([
    "source_age_over_30_through_60_minutes",
  ]);
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(exactDeadline).success,
    true,
    "evidence at exactly 60 minutes is still a valid current estimate",
  );
});

test("a current estimate is valid through its deadline and rejected only after it", () => {
  const atDeadline = safeParsePackScoutPublicEvV3(
    buildPackScoutPublicEvNegativeV3(),
    DATA_RELEASE_V3_EXPIRES_AT,
  );
  assert.equal(atDeadline.success, true);

  const pastDeadline = safeParsePackScoutPublicEvV3(
    buildPackScoutPublicEvNegativeV3(),
    "2026-08-19T19:00:00.001Z",
  );
  assert.deepEqual(pastDeadline, {
    success: false,
    reason: "current_past_deadline",
  });

  const invalidReference = safeParsePackScoutPublicEvV3(
    buildPackScoutPublicEvNegativeV3(),
    "not-a-timestamp",
  );
  assert.deepEqual(invalidReference, {
    success: false,
    reason: "reference_time_invalid",
  });

  assert.equal(
    packScoutPublicEvV3IsPresentableAt(
      buildPackScoutPublicEvSoldOutHistoricalV3(),
      "2030-01-01T00:00:00.000Z",
    ),
    true,
    "a sold-out historical estimate never expires into live-unavailable",
  );
  assert.equal(
    packScoutPublicEvV3IsPresentableAt(
      buildPackScoutPublicEvUnavailableV3(),
      "2030-01-01T00:00:00.000Z",
    ),
    true,
  );
});

test("only the exact buyback-adjusted method and confidence-policy versions validate", () => {
  const wrongMethod = { ...currentEstimate(), methodVersion: "packscout-ev-v2" };
  assert.equal(packScoutPublicEvV3Schema.safeParse(wrongMethod).success, false);

  const wrongPolicy = {
    ...currentEstimate(),
    confidencePolicyVersion: "confidence-v1",
  };
  assert.equal(packScoutPublicEvV3Schema.safeParse(wrongPolicy).success, false);

  const wrongNestedPolicy = currentEstimate();
  wrongNestedPolicy.confidence = {
    ...wrongNestedPolicy.confidence,
    policyVersion:
      "confidence-v1" as typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  };
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(wrongNestedPolicy).success,
    false,
  );
});

test("impossible confidence pairs are rejected", () => {
  const scoreMismatch = currentEstimate();
  scoreMismatch.confidence = {
    ...scoreMismatch.confidence,
    scoreBasisPoints: 9_999,
  };
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(scoreMismatch).success,
    false,
  );

  const bandMismatch = currentEstimate();
  bandMismatch.confidence = { ...bandMismatch.confidence, band: "low" };
  assert.equal(packScoutPublicEvV3Schema.safeParse(bandMismatch).success, false);

  const conflictingFreshness = buildPackScoutPublicEvDelayedV3();
  if (conflictingFreshness.status !== "current") throw new Error("unexpected");
  const tampered = structuredClone(conflictingFreshness);
  tampered.confidence = {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints: 6_500,
    band: "medium",
    limitationCodes: [
      "source_age_over_15_through_30_minutes",
      "source_age_over_30_through_60_minutes",
    ],
  };
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(tampered).success,
    false,
    "the two freshness penalties are mutually exclusive",
  );
});

test("nullability is exact in every state", () => {
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...currentEstimate(),
      metrics: null,
    }).success,
    false,
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...currentEstimate(),
      confidence: null,
    }).success,
    false,
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...buildPackScoutPublicEvUnavailableV3(),
      metrics: buildPackScoutPublicEvMetricsV3(8_500),
    }).success,
    false,
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...buildPackScoutPublicEvUnavailableV3(),
      confidence: buildPackScoutPublicEvConfidenceV3(),
    }).success,
    false,
  );
  const withoutReason: Record<string, unknown> = {
    ...buildPackScoutPublicEvUnavailableV3(),
  };
  delete withoutReason["reason"];
  assert.equal(packScoutPublicEvV3Schema.safeParse(withoutReason).success, false);
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...buildPackScoutPublicEvUnavailableV3(),
      reason: ["BUYBACK_UNAVAILABLE", "ODDS_UNAVAILABLE"],
    }).success,
    false,
    "exactly one bounded public reason is allowed",
  );
});

test("unavailable timing states stay honest", () => {
  const expired = buildPackScoutPublicEvExpiredV3();
  assert.equal(expired.status, "unavailable");
  if (expired.status === "unavailable") {
    assert.equal(expired.reason, "SOURCE_DATA_STALE");
  }

  const unknownTime = buildPackScoutPublicEvUnknownTimeV3();
  assert.equal(unknownTime.status, "unavailable");
  if (unknownTime.status === "unavailable") {
    assert.equal(unknownTime.dataAsOf.state, "unknown_source_time");
  }

  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...buildPackScoutPublicEvUnknownTimeV3(),
      reason: "SOURCE_DATA_STALE",
    }).success,
    false,
    "staleness is unknowable without a source observation time",
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...buildPackScoutPublicEvUnknownTimeV3(),
      reason: "PRICE_UNAVAILABLE",
    }).success,
    false,
    "unknown source time maps to the source-evidence reason",
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...buildPackScoutPublicEvUnavailableV3(),
      reason: "SOURCE_DATA_STALE",
    }).success,
    false,
    "the stale reason requires evidence past the 60-minute window",
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...buildPackScoutPublicEvUnavailableV3(),
      calculatedAt: "2026-08-19T17:59:59.999Z",
    }).success,
    false,
    "a calculation cannot precede its evidence",
  );
});

test("sold-out historical estimates freeze and never re-enter the live lifecycle", () => {
  const historical = buildPackScoutPublicEvSoldOutHistoricalV3();
  assert.equal(historical.status, "sold_out_historical");
  if (historical.status !== "sold_out_historical") return;
  assert.equal(historical.expiresAt, null);
  assert.equal(historical.soldOutAt, "2026-08-19T18:30:00.000Z");
  assert.equal(historical.confidence.scoreBasisPoints, 10_000);

  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...historical,
      soldOutAt: "2026-08-19T19:00:00.001Z",
    }).success,
    false,
    "the estimate must have been current at the recorded sellout",
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...historical,
      soldOutAt: "2026-08-19T17:59:59.999Z",
    }).success,
    false,
    "a sellout cannot precede the frozen calculation",
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...historical,
      expiresAt: DATA_RELEASE_V3_EXPIRES_AT,
    }).success,
    false,
    "a historical estimate carries no live expiry deadline",
  );
  assert.equal(
    packScoutPublicEvV3Schema.safeParse({
      ...currentEstimate(),
      soldOutAt: DATA_RELEASE_V3_OBSERVED_AT,
    }).success,
    false,
    "a current estimate cannot carry sellout history",
  );
});

test("buyback summaries stay honest and bounded", () => {
  assert.equal(
    publicBuybackSummaryV3Schema.safeParse({
      kind: "uniform_rate",
      rateBasisPoints: 8_500,
    }).success,
    true,
  );
  for (const kind of [
    "varies_by_outcome",
    "fixed_or_final_payout",
    "not_documented",
    "unavailable",
  ] as const) {
    assert.equal(publicBuybackSummaryV3Schema.safeParse({ kind }).success, true);
    assert.equal(
      publicBuybackSummaryV3Schema.safeParse({ kind, rateBasisPoints: 8_500 })
        .success,
      false,
      `a numeric rate is dishonest for ${kind}`,
    );
  }
  assert.equal(
    publicBuybackSummaryV3Schema.safeParse({ kind: "uniform_rate" }).success,
    false,
    "a uniform rate requires its basis points",
  );
  assert.equal(
    publicBuybackSummaryV3Schema.safeParse({
      kind: "uniform_rate",
      rateBasisPoints: 10_001,
    }).success,
    false,
  );
  assert.equal(
    publicBuybackSummaryV3Schema.safeParse({
      kind: "varies_by_outcome",
      averageRateBasisPoints: 7_000,
    }).success,
    false,
    "a synthetic average buyback percentage is unrepresentable",
  );
  assert.equal(
    publicBuybackSummaryV3Schema.safeParse({
      kind: "varies_by_outcome",
      outcomes: [{ rateBasisPoints: 9_000 }],
    }).success,
    false,
    "per-outcome terms are unrepresentable",
  );
});

test("vendor-reported EV stays structurally independent of the PackScout estimate", () => {
  const independent = publicEvEstimatesV3Schema.parse({
    packScout: buildPackScoutPublicEvUnavailableV3(),
    vendorReported: buildVendorReportedEvAvailableV3(),
  });
  assert.equal(independent.packScout.status, "unavailable");
  assert.equal(independent.vendorReported.status, "available");

  assert.equal(
    vendorReportedEvV3Schema.safeParse({
      ...buildVendorReportedEvAvailableV3(),
      usdComparison: {
        status: "available",
        value: { minorUnits: 9_999, currency: "USD" },
      },
    }).success,
    false,
    "a USD source must equal its normalized comparison",
  );
  assert.equal(
    vendorReportedEvV3Schema.safeParse({
      ...buildVendorReportedEvUnavailableV3(),
      sourceMoney: { minorUnits: 8_500, currency: "USD" },
    }).success,
    false,
  );
  for (const couplingKey of [
    "fallbackFromPackScout",
    "substitutedFrom",
    "averagedWith",
  ]) {
    assert.equal(
      publicEvEstimatesV3Schema.safeParse({
        packScout: buildPackScoutPublicEvNegativeV3(),
        vendorReported: {
          ...buildVendorReportedEvAvailableV3(),
          [couplingKey]: "packScout",
        },
      }).success,
      false,
      `${couplingKey} must be rejected as an unknown coupling field`,
    );
  }
});

test("protected, raw-like, and unknown fields are rejected at every nesting level", () => {
  const estimates = () => ({
    packScout: buildPackScoutPublicEvNegativeV3(),
    vendorReported: buildVendorReportedEvAvailableV3(),
  });

  const leaks: readonly ((value: {
    packScout: PackScoutPublicEvV3;
    vendorReported: ReturnType<typeof buildVendorReportedEvAvailableV3>;
  }) => unknown)[] = [
    (value) => ({ ...value, internalReasons: ["MISSING_BUYBACK"] }),
    (value) => ({ ...value, packScout: { ...value.packScout, provenance: {} } }),
    (value) => ({
      ...value,
      packScout: { ...value.packScout, protectedEvidence: {} },
    }),
    (value) => {
      const packScout = structuredClone(value.packScout);
      if (packScout.status !== "current") throw new Error("unexpected");
      return {
        ...value,
        packScout: {
          ...packScout,
          metrics: {
            ...packScout.metrics,
            underlyingOutcomeEvMoney: { minorUnits: 1, currency: "USD" },
          },
        },
      };
    },
    // The task-005 revision layer persists the same protected values under
    // different spellings; both must be caught anywhere in a payload.
    (value) => {
      const packScout = structuredClone(value.packScout);
      if (packScout.status !== "current") throw new Error("unexpected");
      return {
        ...value,
        packScout: {
          ...packScout,
          metrics: {
            ...packScout.metrics,
            underlyingOutcomeEvMinorUnits: 1,
          },
        },
      };
    },
    (value) => {
      const packScout = structuredClone(value.packScout);
      if (packScout.status !== "current") throw new Error("unexpected");
      return {
        ...value,
        packScout: {
          ...packScout,
          metrics: { ...packScout.metrics, drawMultiplier: 2 },
        },
      };
    },
    (value) => ({ ...value, drawMultiplier: 2 }),
    (value) => ({
      ...value,
      vendorReported: { ...value.vendorReported, rawProviderPayload: {} },
    }),
    (value) => ({
      ...value,
      packScout: {
        ...value.packScout,
        dataAsOf: {
          ...(value.packScout as { dataAsOf: object }).dataAsOf,
          sourceRevisionId: "leak",
        },
      },
    }),
  ];

  for (const applyLeak of leaks) {
    const leaked = applyLeak(estimates());
    assert.equal(
      publicEvEstimatesV3Schema.safeParse(leaked).success,
      false,
      "strict schemas reject the leaked key",
    );
    assert.equal(
      containsProtectedEvPublicationKeyV3(leaked),
      true,
      "the protected-key scan detects the leaked key",
    );
  }

  assert.equal(containsProtectedEvPublicationKeyV3(estimates()), false);
  for (const protectedPath of PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1) {
    for (const segment of protectedPath.split(".")) {
      assert.equal(
        DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS.has(
          segment.toLowerCase().replace(/[^a-z0-9]/gu, ""),
        ),
        true,
      );
    }
  }
  // The revision-layer spellings of the protected values are part of the
  // scan vocabulary; the public pack price spelling deliberately is not.
  assert.equal(
    DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS.has("underlyingoutcomeevminorunits"),
    true,
  );
  assert.equal(
    DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS.has("drawmultiplier"),
    true,
  );
  assert.equal(
    DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS.has("packpriceminorunits"),
    false,
  );
  assert.equal(
    containsProtectedEvPublicationKeyV3({
      metrics: { underlyingOutcomeEvMinorUnits: 10_000 },
    }),
    true,
  );
  assert.equal(
    containsProtectedEvPublicationKeyV3({ drawMultiplier: 1 }),
    true,
  );

  const guarded = safeParsePackScoutPublicEvV3(
    { ...buildPackScoutPublicEvNegativeV3(), provenance: {} },
    DATA_RELEASE_V3_OBSERVED_AT,
  );
  assert.deepEqual(guarded, {
    success: false,
    reason: "protected_field_present",
  });
});

test("the pre-buyback v2 PackScout shape cannot enter the v3 contract", () => {
  const preBuybackShape = {
    status: "available",
    metrics: {
      grossEv: { minorUnits: 12_000, currency: "USD" },
      grossReturnBasisPoints: 12_000,
      evDollars: { minorUnits: 2_000, currency: "USD" },
      evPercentBasisPoints: 2_000,
    },
    confidence: {
      scoreBasisPoints: 7_000,
      band: "medium",
      limitationCodes: ["partial_probability_coverage"],
    },
    modelVersion: "packscout-ev-v2",
    confidencePolicyVersion: "confidence-v1",
    dataAsOf: DATA_RELEASE_V3_OBSERVED_AT,
    calculatedAt: DATA_RELEASE_V3_OBSERVED_AT,
  };
  assert.equal(
    packScoutPublicEvV3Schema.safeParse(preBuybackShape).success,
    false,
    "no alias or fallback accepts the old EV interpretation",
  );
});
