import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildV3DelayedProviderHealth,
  buildV3HealthyProviderHealth,
} from "./packscout-ev-fixtures.test-support";
import { presentProviderHealthV3 } from "./provider-health-presentation";

test("healthy provider evidence stays eligible with a semantic observation time", () => {
  const presentation = presentProviderHealthV3(
    buildV3HealthyProviderHealth(),
  );

  assert.equal(presentation.state, "healthy");
  assert.equal(presentation.statusLabel, "Provider feed healthy");
  assert.equal(presentation.rankingEligible, true);
  assert.equal(presentation.rankingLabel, "Eligible for Top Opportunities.");
  assert.match(presentation.observedLabel ?? "", /^Provider health observed /);
});

test("provider delay excludes ranking without hiding or relabeling EV", () => {
  const presentation = presentProviderHealthV3(
    buildV3DelayedProviderHealth(),
  );

  assert.equal(presentation.state, "delayed");
  assert.equal(presentation.rankingEligible, false);
  assert.equal(
    presentation.rankingLabel,
    "Provider feed delayed; excluded from Top Opportunities.",
  );
  assert.doesNotMatch(
    presentation.accessibleLabel,
    /PROVIDER_OBSERVATION_STALE/,
  );
});

test("missing provider health has bounded unavailable copy and no invented time", () => {
  const presentation = presentProviderHealthV3({
    state: "unavailable",
    observedAt: null,
    rankingEligible: false,
    rankingIneligibilityReason: "PROVIDER_HEALTH_UNAVAILABLE",
  });

  assert.equal(presentation.statusLabel, "Provider feed unavailable");
  assert.equal(
    presentation.rankingLabel,
    "Provider feed unavailable; excluded from Top Opportunities.",
  );
  assert.equal(presentation.observedAt, null);
  assert.equal(presentation.observedLabel, null);
  assert.doesNotMatch(presentation.accessibleLabel, /PROVIDER_HEALTH_UNAVAILABLE/);
});
