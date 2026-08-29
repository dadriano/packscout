import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_RELEASE_V3_OBSERVED_AT,
  DATA_RELEASE_V3_SOLD_OUT_AT,
  buildPackScoutPublicEvConfidenceV3,
  buildPackScoutPublicEvExpiredV3,
  buildPackScoutPublicEvMetricsV3,
  buildPackScoutPublicEvNegativeV3,
  buildPackScoutPublicEvSoldOutHistoricalV3,
  buildPackScoutPublicEvUnavailableV3,
  buildPackScoutPublicEvUnknownTimeV3,
} from "./__fixtures__/data-release-v3.fixture.ts";
import { packScoutPublicEvV3Schema } from "./data-release-v3-ev-estimates.ts";
import {
  PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
  packScoutPublicEvPresentationV1Schema,
  publicProviderHealthV1Schema,
  publicProviderHealthSummaryV1Schema,
  safeEvaluatePackScoutPublicConfidenceV1,
  safePresentPackScoutPublicEvV3,
  type PackScoutPublicEvPresentationV1,
} from "./public-ev-presentation-v1.ts";

const MINUTE_MILLISECONDS = 60_000;

function evaluationAt(sourceAgeMilliseconds: number): string {
  return new Date(
    Date.parse(DATA_RELEASE_V3_OBSERVED_AT) + sourceAgeMilliseconds,
  ).toISOString();
}

function presentationAt(
  sourceAgeMilliseconds: number,
  raw: unknown = buildPackScoutPublicEvNegativeV3(),
): PackScoutPublicEvPresentationV1 {
  const result = safePresentPackScoutPublicEvV3(
    raw,
    evaluationAt(sourceAgeMilliseconds),
  );
  assert.equal(result.success, true);
  return result.presentation;
}

test("public confidence follows the approved boundary table without expiring EV", () => {
  const examples = [
    {
      label: "15m",
      sourceAgeMilliseconds: 15 * MINUTE_MILLISECONDS,
      status: "current",
      scoreBasisPoints: 10_000,
      ageState: "fresh_within_15_minutes",
      ageLimitation: null,
    },
    {
      label: "30m",
      sourceAgeMilliseconds: 30 * MINUTE_MILLISECONDS,
      status: "current",
      scoreBasisPoints: 9_000,
      ageState: "delayed_over_15_through_30_minutes",
      ageLimitation: "source_age_over_15_through_30_minutes",
    },
    {
      label: "60m",
      sourceAgeMilliseconds: 60 * MINUTE_MILLISECONDS,
      status: "current",
      scoreBasisPoints: 7_500,
      ageState: "delayed_over_30_through_60_minutes",
      ageLimitation: "source_age_over_30_through_60_minutes",
    },
    {
      label: "60m+1ms",
      sourceAgeMilliseconds: 60 * MINUTE_MILLISECONDS + 1,
      status: "last_known",
      scoreBasisPoints: 7_500,
      ageState: "last_known_over_60_minutes",
      ageLimitation: "source_age_over_60_minutes",
    },
    {
      label: "2h",
      sourceAgeMilliseconds: 2 * 60 * MINUTE_MILLISECONDS,
      status: "last_known",
      scoreBasisPoints: 7_200,
      ageState: "last_known_over_60_minutes",
      ageLimitation: "source_age_over_60_minutes",
    },
    {
      label: "25h",
      sourceAgeMilliseconds: 25 * 60 * MINUTE_MILLISECONDS,
      status: "last_known",
      scoreBasisPoints: 3_750,
      ageState: "last_known_over_60_minutes",
      ageLimitation: "source_age_over_60_minutes",
    },
    {
      label: "49h",
      sourceAgeMilliseconds: 49 * 60 * MINUTE_MILLISECONDS,
      status: "last_known",
      scoreBasisPoints: 2_500,
      ageState: "last_known_over_60_minutes",
      ageLimitation: "source_age_over_60_minutes",
    },
    {
      label: "7d",
      sourceAgeMilliseconds: 7 * 24 * 60 * MINUTE_MILLISECONDS,
      status: "last_known",
      scoreBasisPoints: 942,
      ageState: "last_known_over_60_minutes",
      ageLimitation: "source_age_over_60_minutes",
    },
  ] as const;

  const raw = buildPackScoutPublicEvNegativeV3();
  let previousScore = 10_000;
  for (const example of examples) {
    const presentation = presentationAt(example.sourceAgeMilliseconds, raw);
    assert.equal(presentation.status, example.status, example.label);
    assert.deepEqual(presentation.metrics, raw.metrics, example.label);
    assert.equal(
      presentation.publicFreshnessPolicyVersion,
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
      example.label,
    );
    assert.equal(
      presentation.confidenceEvaluatedAt,
      evaluationAt(example.sourceAgeMilliseconds),
      example.label,
    );
    assert.equal(
      presentation.sourceAge.milliseconds,
      example.sourceAgeMilliseconds,
      example.label,
    );
    assert.equal(presentation.sourceAge.state, example.ageState, example.label);
    assert.equal(
      presentation.confidence.scoreBasisPoints,
      example.scoreBasisPoints,
      example.label,
    );
    assert.equal(
      presentation.confidence.limitationCodes.find((code) =>
        code.startsWith("source_age_"),
      ) ?? null,
      example.ageLimitation,
      example.label,
    );
    assert.ok(
      presentation.confidence.scoreBasisPoints <= previousScore,
      `${example.label} must not increase confidence`,
    );
    previousScore = presentation.confidence.scoreBasisPoints;
  }
});

test("static penalties are derived from raw V1 limitations at every age band", () => {
  const combinations = [
    { limitations: [], fresh: 10_000, delayed: 9_000, at60: 7_500, at25h: 3_750 },
    {
      limitations: ["platform_published_odds"],
      fresh: 8_500,
      delayed: 7_500,
      at60: 6_000,
      at25h: 3_000,
    },
    {
      limitations: ["closed_range_midpoint"],
      fresh: 8_000,
      delayed: 7_000,
      at60: 5_500,
      at25h: 2_750,
    },
    {
      limitations: ["closed_range_midpoint", "platform_published_odds"],
      fresh: 6_500,
      delayed: 5_500,
      at60: 4_000,
      at25h: 2_000,
    },
  ] as const;

  for (const example of combinations) {
    const raw = packScoutPublicEvV3Schema.parse({
      ...buildPackScoutPublicEvNegativeV3(),
      confidence: buildPackScoutPublicEvConfidenceV3(example.limitations),
    });
    const cases = [
      [15 * MINUTE_MILLISECONDS, example.fresh],
      [30 * MINUTE_MILLISECONDS, example.delayed],
      [60 * MINUTE_MILLISECONDS, example.at60],
      [25 * 60 * MINUTE_MILLISECONDS, example.at25h],
    ] as const;
    for (const [age, score] of cases) {
      const presentation = presentationAt(age, raw);
      assert.notEqual(presentation.status, "unavailable");
      if (presentation.status === "unavailable") continue;
      assert.equal(presentation.confidence.scoreBasisPoints, score);
      assert.deepEqual(
        presentation.confidence.limitationCodes.filter(
          (code) => !code.startsWith("source_age_"),
        ),
        example.limitations,
      );
    }
  }
});

test("a rounded zero remains a calculable last-known estimate", () => {
  const raw = packScoutPublicEvV3Schema.parse({
    ...buildPackScoutPublicEvNegativeV3(),
    confidence: buildPackScoutPublicEvConfidenceV3([
      "closed_range_midpoint",
      "platform_published_odds",
    ]),
  });
  const result = safePresentPackScoutPublicEvV3(
    raw,
    "9999-12-31T23:59:59.999Z",
  );
  assert.equal(result.success, true);
  assert.equal(result.presentation.status, "last_known");
  assert.equal(result.presentation.confidence.scoreBasisPoints, 0);
  assert.equal(result.presentation.confidence.band, "low");
  assert.deepEqual(result.presentation.metrics, raw.metrics);
});

test("sold-out confidence freezes at soldOutAt", () => {
  const raw = buildPackScoutPublicEvSoldOutHistoricalV3();
  const first = safePresentPackScoutPublicEvV3(
    raw,
    "2026-08-20T18:00:00.000Z",
  );
  const later = safePresentPackScoutPublicEvV3(
    raw,
    "2027-08-20T18:00:00.000Z",
  );
  assert.equal(first.success, true);
  assert.equal(later.success, true);
  if (!first.success || !later.success) throw new Error("unexpected failure");
  assert.deepEqual(first.presentation, later.presentation);
  assert.equal(first.presentation.status, "historical");
  assert.equal(first.presentation.confidenceEvaluatedAt, DATA_RELEASE_V3_SOLD_OUT_AT);
  assert.equal(first.presentation.sourceAge.milliseconds, 30 * MINUTE_MILLISECONDS);
  assert.equal(first.presentation.confidence.scoreBasisPoints, 9_000);
  assert.deepEqual(first.presentation.confidence.limitationCodes, [
    "source_age_over_15_through_30_minutes",
  ]);
});

test("true unavailable reasons and null economics remain unavailable", () => {
  const rawEstimates = [
    buildPackScoutPublicEvUnavailableV3("BUYBACK_UNAVAILABLE"),
    buildPackScoutPublicEvUnavailableV3("CALCULATION_UNAVAILABLE"),
    buildPackScoutPublicEvExpiredV3(),
    buildPackScoutPublicEvUnknownTimeV3(),
  ];
  for (const raw of rawEstimates) {
    assert.equal(raw.status, "unavailable");
    const snapshot = structuredClone(raw);
    const result = safePresentPackScoutPublicEvV3(
      raw,
      "2026-08-20T18:00:00.000Z",
    );
    assert.equal(result.success, true);
    assert.equal(result.presentation.status, "unavailable");
    assert.equal(result.presentation.reason, raw.reason);
    assert.equal(result.presentation.metrics, null);
    assert.equal(result.presentation.confidence, null);
    assert.deepEqual(raw, snapshot, "presentation must not mutate stored V3");
  }
});

test("missing economics and positive public EV cannot become a presentation", () => {
  const raw = buildPackScoutPublicEvNegativeV3();
  assert.deepEqual(
    safePresentPackScoutPublicEvV3(
      { ...raw, metrics: null },
      DATA_RELEASE_V3_OBSERVED_AT,
    ),
    { success: false, reason: "schema_invalid" },
  );
  assert.deepEqual(
    safePresentPackScoutPublicEvV3(
      { ...raw, metrics: buildPackScoutPublicEvMetricsV3(12_000) },
      DATA_RELEASE_V3_OBSERVED_AT,
    ),
    { success: false, reason: "schema_invalid" },
  );
});

test("the pure confidence evaluator shares the exact presentation curve", () => {
  const result = safeEvaluatePackScoutPublicConfidenceV1(
    {
      staticPenaltyBasisPoints: 3_500,
      observedAt: DATA_RELEASE_V3_OBSERVED_AT,
    },
    evaluationAt(25 * 60 * MINUTE_MILLISECONDS),
  );
  assert.equal(result.success, true);
  assert.equal(result.evaluation.status, "last_known");
  assert.equal(result.evaluation.confidence.scoreBasisPoints, 2_000);
  assert.deepEqual(result.evaluation.confidence.limitationCodes, [
    "closed_range_midpoint",
    "platform_published_odds",
    "source_age_over_60_minutes",
  ]);
  assert.deepEqual(
    safeEvaluatePackScoutPublicConfidenceV1(
      { staticPenaltyBasisPoints: 1, observedAt: DATA_RELEASE_V3_OBSERVED_AT },
      DATA_RELEASE_V3_OBSERVED_AT,
    ),
    { success: false, reason: "schema_invalid" },
  );
  assert.deepEqual(
    safeEvaluatePackScoutPublicConfidenceV1(
      { staticPenaltyBasisPoints: 0, observedAt: DATA_RELEASE_V3_OBSERVED_AT },
      "2026-08-19T17:59:59.999Z",
    ),
    { success: false, reason: "evaluation_precedes_observation" },
  );
});

test("invalid clocks and impossible presentation combinations fail closed", () => {
  const raw = buildPackScoutPublicEvNegativeV3();
  assert.deepEqual(safePresentPackScoutPublicEvV3(raw, "not-a-clock"), {
    success: false,
    reason: "evaluation_time_invalid",
  });
  assert.deepEqual(
    safePresentPackScoutPublicEvV3(raw, "2026-08-19T17:59:59.999Z"),
    { success: false, reason: "evaluation_precedes_calculation" },
  );
  assert.deepEqual(
    safePresentPackScoutPublicEvV3(
      buildPackScoutPublicEvSoldOutHistoricalV3(),
      "2026-08-19T18:29:59.999Z",
    ),
    { success: false, reason: "evaluation_precedes_sellout" },
  );

  const current = presentationAt(60 * MINUTE_MILLISECONDS);
  assert.equal(
    packScoutPublicEvPresentationV1Schema.safeParse({
      ...current,
      status: "last_known",
    }).success,
    false,
  );
  if (current.status === "unavailable") throw new Error("unexpected");
  assert.equal(
    packScoutPublicEvPresentationV1Schema.safeParse({
      ...current,
      confidence: { ...current.confidence, scoreBasisPoints: 7_499 },
    }).success,
    false,
  );
  assert.equal(
    packScoutPublicEvPresentationV1Schema.safeParse({
      ...current,
      unexpected: true,
    }).success,
    false,
  );
  assert.equal(
    packScoutPublicEvPresentationV1Schema.safeParse({
      ...current,
      sourceAge: {
        ...current.sourceAge,
        milliseconds: Number.MAX_SAFE_INTEGER + 1,
      },
    }).success,
    false,
  );
});

test("provider health admits only the approved informational state and reason pairs", () => {
  assert.equal(
    publicProviderHealthV1Schema.safeParse({
      state: "healthy",
      observedAt: DATA_RELEASE_V3_OBSERVED_AT,
      statusReason: null,
    }).success,
    true,
  );
  assert.equal(
    publicProviderHealthV1Schema.safeParse({
      state: "delayed",
      observedAt: DATA_RELEASE_V3_OBSERVED_AT,
      statusReason: "PROVIDER_OBSERVATION_STALE",
    }).success,
    true,
  );
  assert.equal(
    publicProviderHealthV1Schema.safeParse({
      state: "unavailable",
      observedAt: null,
      statusReason: "PROVIDER_HEALTH_UNAVAILABLE",
    }).success,
    true,
  );

  const invalid = [
    {
      state: "healthy",
      observedAt: DATA_RELEASE_V3_OBSERVED_AT,
      statusReason: "PROVIDER_OBSERVATION_STALE",
    },
    {
      state: "delayed",
      observedAt: null,
      statusReason: "PROVIDER_BEHIND",
    },
    {
      state: "unavailable",
      observedAt: DATA_RELEASE_V3_OBSERVED_AT,
      statusReason: "PROVIDER_HEALTH_UNAVAILABLE",
    },
  ];
  for (const value of invalid) {
    assert.equal(publicProviderHealthV1Schema.safeParse(value).success, false);
  }
});

test("provider health summaries distinguish healthy, delayed, and unavailable", () => {
  const healthy = {
    state: "healthy",
    observedAt: DATA_RELEASE_V3_OBSERVED_AT,
    freshThrough: evaluationAt(60 * MINUTE_MILLISECONDS),
    totalProviderCount: 2,
    delayedProviderCount: 0,
    nextHealthEvaluationAt: evaluationAt(60 * MINUTE_MILLISECONDS),
  } as const;
  const delayed = {
    state: "delayed",
    observedAt: DATA_RELEASE_V3_OBSERVED_AT,
    freshThrough: evaluationAt(60 * MINUTE_MILLISECONDS),
    totalProviderCount: 2,
    delayedProviderCount: 1,
    nextHealthEvaluationAt: evaluationAt(60 * MINUTE_MILLISECONDS),
  } as const;
  const unavailable = {
    state: "unavailable",
    observedAt: null,
    freshThrough: null,
    totalProviderCount: 2,
    delayedProviderCount: 2,
    nextHealthEvaluationAt: null,
  } as const;
  for (const summary of [healthy, delayed, unavailable]) {
    assert.equal(publicProviderHealthSummaryV1Schema.safeParse(summary).success, true);
  }
  for (const summary of [
    { ...healthy, totalProviderCount: 0 },
    { ...healthy, delayedProviderCount: 1 },
    { ...delayed, delayedProviderCount: 0 },
    { ...delayed, delayedProviderCount: 3 },
    { ...delayed, nextHealthEvaluationAt: null },
    {
      ...delayed,
      observedAt: evaluationAt(60 * MINUTE_MILLISECONDS),
      freshThrough: DATA_RELEASE_V3_OBSERVED_AT,
    },
    { ...unavailable, observedAt: DATA_RELEASE_V3_OBSERVED_AT },
    { ...unavailable, delayedProviderCount: 1, nextHealthEvaluationAt: null },
  ]) {
    assert.equal(publicProviderHealthSummaryV1Schema.safeParse(summary).success, false);
  }
  assert.equal(
    publicProviderHealthSummaryV1Schema.safeParse({
      ...unavailable,
      delayedProviderCount: 1,
      nextHealthEvaluationAt: evaluationAt(60 * MINUTE_MILLISECONDS),
    }).success,
    true,
  );
});
