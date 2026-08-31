import assert from "node:assert/strict";
import test from "node:test";
import { DATA_RELEASE_V3_OBSERVED_AT } from "./__fixtures__/data-release-v3.fixture.ts";
import { PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION } from "./data-release-v3-last-known-ev.ts";
import { publicEvPresentationResponseContextV1Schema, publicProviderHealthV1Schema, publicProviderHealthSummaryV1Schema } from "./public-ev-presentation-v1.ts";
const MINUTE_MILLISECONDS = 60_000;
function evaluationAt(age: number): string { return new Date(Date.parse(DATA_RELEASE_V3_OBSERVED_AT) + age).toISOString(); }
test("response confidence context names only the retained linear policy", () => {
  assert.equal(publicEvPresentationResponseContextV1Schema.safeParse({ publicFreshnessPolicyVersion: PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION, confidenceEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT }).success, true);
  assert.equal(publicEvPresentationResponseContextV1Schema.safeParse({ publicFreshnessPolicyVersion: "packscout-public-ev-confidence-decay-v1", confidenceEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT }).success, false);
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
