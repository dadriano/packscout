import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
  publicReadError,
} from "@packscout/contracts";
import {
  dataReleaseStatusFromPublicResult,
  dataReleaseStatusFromProviderHealth,
} from "./public-release-status";
import { providerHealthRefreshDelayMilliseconds } from "./data-release-status.client";
import {
  buildV3ProviderHealthSummary,
  buildV3ReleaseIdentity,
  FIXTURE_CURRENT_EVALUATED_AT,
} from "./packscout-ev-fixtures.test-support";

const release = buildV3ReleaseIdentity();
const healthy = buildV3ProviderHealthSummary("healthy");
const delayed = buildV3ProviderHealthSummary("delayed");
const providerHealthEvaluatedAt = "2026-08-19T10:15:00.000Z";

test("shell status maps provider health without using immutable release age", () => {
  assert.deepEqual(
    dataReleaseStatusFromPublicResult(publicReadError("RELEASE_UNAVAILABLE")),
    { state: "unavailable" },
  );
  assert.deepEqual(
    dataReleaseStatusFromProviderHealth(healthy, providerHealthEvaluatedAt),
    {
      state: "fresh",
      updatedAt: healthy.observedAt,
      freshThrough: healthy.freshThrough,
      evaluatedAt: providerHealthEvaluatedAt,
      nextHealthEvaluationAt: healthy.nextHealthEvaluationAt,
      totalProviderCount: 1,
      delayedProviderCount: 0,
    },
  );
  assert.deepEqual(
    dataReleaseStatusFromProviderHealth(delayed, providerHealthEvaluatedAt),
    {
      state: "delayed",
      updatedAt: delayed.observedAt,
      freshThrough: delayed.freshThrough,
      evaluatedAt: providerHealthEvaluatedAt,
      nextHealthEvaluationAt: delayed.nextHealthEvaluationAt,
      totalProviderCount: 1,
      delayedProviderCount: 1,
    },
  );
  const fromDistinctServerClocks = dataReleaseStatusFromPublicResult({
      ok: true,
      data: {
        release,
        publicFreshnessPolicyVersion:
          PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
        confidenceEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
        providerHealthEvaluatedAt,
        providerHealthSummary: healthy,
      },
    });
  assert.deepEqual(
    fromDistinctServerClocks,
    dataReleaseStatusFromProviderHealth(healthy, providerHealthEvaluatedAt),
  );
  assert.equal(
    providerHealthRefreshDelayMilliseconds(fromDistinctServerClocks),
    45 * 60_000,
    "a later-page reload schedules from the fresh health clock, not pinned confidence",
  );
  assert.deepEqual(
    dataReleaseStatusFromProviderHealth(
      buildV3ProviderHealthSummary("unavailable"),
      FIXTURE_CURRENT_EVALUATED_AT,
    ),
    { state: "unavailable" },
  );
});
