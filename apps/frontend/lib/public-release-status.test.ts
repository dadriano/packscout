import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
  publicReadError,
} from "@packscout/contracts";
import {
  dataReleaseStatusFromPublicResult,
  dataReleaseStatusFromRelease,
} from "./public-release-status";
import {
  buildV3ProviderHealthSummary,
  buildV3ReleaseIdentity,
  FIXTURE_CURRENT_EVALUATED_AT,
} from "./packscout-ev-fixtures.test-support";

const release = {
  ...buildV3ReleaseIdentity(),
  dataAsOf: "2026-08-19T10:00:00.000Z",
  completedAt: "2026-08-19T10:04:00.000Z",
};
const providerHealthEvaluatedAt = "2026-08-19T10:15:00.000Z";

function publicResult(
  providerHealthSummary: ReturnType<typeof buildV3ProviderHealthSummary>,
) {
  return {
    ok: true as const,
    data: {
      release,
      publicFreshnessPolicyVersion:
        PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
      confidenceEvaluatedAt: FIXTURE_CURRENT_EVALUATED_AT,
      providerHealthEvaluatedAt,
      providerHealthSummary,
    },
  };
}

test("shell status uses release completion rather than source or health clocks", () => {
  assert.deepEqual(
    dataReleaseStatusFromPublicResult(publicReadError("RELEASE_UNAVAILABLE")),
    { state: "unavailable" },
  );
  assert.deepEqual(
    dataReleaseStatusFromRelease(release, providerHealthEvaluatedAt),
    {
      state: "available",
      updatedAt: release.completedAt,
      evaluatedAt: providerHealthEvaluatedAt,
    },
  );

  const healthy = dataReleaseStatusFromPublicResult(
    publicResult(buildV3ProviderHealthSummary("healthy")),
  );
  const delayed = dataReleaseStatusFromPublicResult(
    publicResult(buildV3ProviderHealthSummary("delayed")),
  );

  assert.deepEqual(healthy, delayed);
  assert.equal(
    "updatedAt" in delayed ? delayed.updatedAt : null,
    release.completedAt,
    "provider health must not replace the public record-set update clock",
  );
  assert.notEqual(
    "updatedAt" in delayed ? delayed.updatedAt : null,
    release.dataAsOf,
  );
});
