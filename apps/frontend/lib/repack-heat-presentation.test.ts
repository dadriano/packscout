import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicRepackHeat } from "@packscout/contracts";
import {
  presentRepackHeatBadge,
  presentRepackHeatDetails,
  REPACK_HEAT_INTERPRETATION,
  type RepackHeatBadgeInput,
  type RepackHeatSignalState,
} from "./repack-heat-presentation";

const simulatedHotHeat: PublicRepackHeat = {
  status: "current",
  signal: {
    publicRepackId: "00000000-0000-5000-8000-000000000301",
    state: "hot",
    scoreBasisPoints: 8_500,
    provenance: {
      kind: "simulated",
      aggregationVersion: "packscout_repack_heat_v1",
      scenarioVersion: "packscout_heat_sim_v1",
    },
    sourceCoverage: "complete",
    currentWindow: {
      startedAt: "2026-08-13T12:00:00Z",
      endedAt: "2026-08-13T12:05:00Z",
      pullCount: 20,
    },
    baselineWindow: {
      startedAt: "2026-08-13T11:50:00Z",
      endedAt: "2026-08-13T11:55:00Z",
      pullCount: 10,
    },
    sampleRequirements: {
      minimumCurrentPullCount: 5,
      minimumBaselinePullCount: 20,
    },
    components: {
      activity: {
        status: "available",
        currentPullCount: 20,
        baselinePullCount: 10,
        relativeRateDeltaBasisPoints: 10_000,
      },
      observedReturn: {
        status: "available",
        currentReturnBasisPoints: 9_500,
        baselineReturnBasisPoints: 9_000,
        rateDeltaBasisPoints: 500,
      },
      largeHitFrequency: {
        status: "available",
        currentHitCount: 2,
        baselineHitCount: 1,
        currentRateBasisPoints: 1_000,
        baselineRateBasisPoints: 500,
        rateDeltaBasisPoints: 500,
        thresholdMultipleBasisPoints: 20_000,
      },
      chaseAvailability: {
        status: "available",
        currentAvailableChaseCount: 3,
        baselineAvailableChaseCount: 2,
        change: "restocked",
      },
      poolComposition: {
        status: "available",
        addedOutcomeCount: 3,
        removedOutcomeCount: 1,
        changeMagnitudeBasisPoints: 2_500,
        changed: true,
      },
    },
    drivers: [
      { code: "activity", contributionBasisPoints: 2_800 },
      { code: "chase_availability", contributionBasisPoints: 500 },
      { code: "large_hit_frequency", contributionBasisPoints: 500 },
      { code: "observed_return", contributionBasisPoints: -300 },
      { code: "pool_composition", contributionBasisPoints: 0 },
    ],
    signalConfidence: { scoreBasisPoints: 9_000, band: "high" },
    limitationCodes: ["simulated_data"],
    heatPolicyVersion: "packscout_heat_policy_v1",
    calculatedAt: "2026-08-13T12:06:00Z",
    expiresAt: "2026-08-13T12:16:00Z",
  },
};

function current(
  state: RepackHeatSignalState,
  kind: "observed" | "simulated" = "observed",
): RepackHeatBadgeInput {
  return {
    status: "current",
    signal: {
      state,
      scoreBasisPoints: state === "insufficient_data" ? null : 7_200,
      provenance: { kind },
    },
  };
}

test("presents every current heat state with text instead of color alone", () => {
  assert.deepEqual(
    (["hot", "warm", "normal", "cold", "insufficient_data"] as const).map(
      (state) => {
        const presentation = presentRepackHeatBadge(current(state));
        return [presentation.state, presentation.label];
      },
    ),
    [
      ["hot", "Hot"],
      ["warm", "Warm"],
      ["normal", "Normal"],
      ["cold", "Cold"],
      ["insufficient_data", "Not enough data"],
    ],
  );
});

test("labels simulated heat visibly and never describes it as EV or profit", () => {
  const presentation = presentRepackHeatBadge(current("hot", "simulated"));

  assert.equal(presentation.supportingLabel, "Simulated");
  assert.equal(presentation.simulated, true);
  assert.match(presentation.accessibleLabel, /^Simulated heat: Hot\./);
  assert.match(presentation.accessibleLabel, /not profit or \+EV/i);
  assert.equal(
    REPACK_HEAT_INTERPRETATION,
    "Recent activity versus this repack’s own baseline; not profit or +EV.",
  );
});

test("explains insufficient samples without treating them as missing", () => {
  const presentation = presentRepackHeatBadge(current("insufficient_data"));

  assert.equal(presentation.state, "insufficient_data");
  assert.equal(presentation.label, "Not enough data");
  assert.match(presentation.accessibleLabel, /minimum pull count/i);
  assert.doesNotMatch(presentation.accessibleLabel, /unavailable/i);
});

test("keeps expired and unpublished heat unavailable rather than normal or cold", () => {
  const expired = presentRepackHeatBadge({
    status: "expired",
    signal: null,
    lastCalculatedAt: "2026-08-13T12:00:00Z",
    expiredAt: "2026-08-13T12:10:00Z",
  });
  const unpublished = presentRepackHeatBadge({
    status: "unavailable",
    signal: null,
    reason: "NOT_PUBLISHED",
  });

  assert.deepEqual(
    [expired.state, expired.label, expired.supportingLabel],
    ["unavailable", "Heat unavailable", "Expired"],
  );
  assert.deepEqual(
    [unpublished.state, unpublished.label, unpublished.supportingLabel],
    ["unavailable", "Heat unavailable", "Awaiting signal"],
  );
});

test("presents detailed simulated heat as a timing index with windows and components", () => {
  const presentation = presentRepackHeatDetails(simulatedHotHeat);

  assert.equal(presentation.availability, "current");
  if (presentation.availability !== "current") return;
  assert.equal(presentation.badge.label, "Hot");
  assert.equal(presentation.provenanceLabel, "Simulated data");
  assert.equal(presentation.indexLabel, "85 / 100");
  assert.match(presentation.indexAccessibleLabel, /index, not a percentage, probability, or EV/i);
  assert.equal(presentation.confidenceLabel, "High · 90%");
  assert.equal(presentation.currentWindow.pullCountLabel, "20 pulls");
  assert.equal(presentation.baselineWindow.pullCountLabel, "10 pulls");
  assert.equal(presentation.sampleRequirementLabel, "Minimum samples: 5 recent · 20 baseline");
  assert.match(presentation.driverExplanation, /neutral 50-point baseline/i);
  assert.match(presentation.driverExplanation, /not EV, profitability, or recommendations/i);
  assert.deepEqual(
    presentation.drivers.map(({ code, value, context }) => [code, value, context]),
    [
      ["activity", "+28 index points", "Raises Heat index"],
      ["chase_availability", "+5 index points", "Raises Heat index"],
      ["large_hit_frequency", "+5 index points", "Raises Heat index"],
      ["observed_return", "-3 index points", "Lowers Heat index"],
      ["pool_composition", "No Heat-index contribution", "Neutral contribution"],
    ],
  );
  assert.deepEqual(
    presentation.components.map(({ id, value }) => [id, value]),
    [
      ["activity", "+100% rate"],
      ["observedReturn", "+5 pts"],
      ["largeHitFrequency", "+5 pts"],
      ["chaseAvailability", "Restocked"],
      ["poolComposition", "25% changed"],
    ],
  );
  assert.deepEqual(presentation.limitations, [
    "Values are generated by the deterministic data-stream simulator.",
  ]);
});

test("keeps heat, heat confidence, EV, and profit meanings distinct", () => {
  const presentation = presentRepackHeatDetails(simulatedHotHeat);

  assert.equal(presentation.availability, "current");
  if (presentation.availability !== "current") return;
  assert.match(presentation.badge.accessibleLabel, /not profit or \+EV/i);
  assert.match(presentation.indexAccessibleLabel, /Heat index/i);
  assert.match(presentation.confidenceAccessibleLabel, /Heat signal confidence/i);
  assert.doesNotMatch(presentation.confidenceAccessibleLabel, /EV confidence|chase-match/i);
});

test("does not round the partial-coverage confidence cap into the high band", () => {
  if (
    simulatedHotHeat.status !== "current" ||
    simulatedHotHeat.signal.state === "insufficient_data"
  ) {
    throw new Error("Expected the hot heat fixture to carry confidence.");
  }
  const partial: PublicRepackHeat = {
    ...simulatedHotHeat,
    signal: {
      ...simulatedHotHeat.signal,
      signalConfidence: {
        scoreBasisPoints: 7_999,
        band: "medium" as const,
      },
    },
  };
  const presentation = presentRepackHeatDetails(partial);

  assert.equal(presentation.availability, "current");
  if (presentation.availability !== "current") return;
  assert.equal(presentation.confidenceLabel, "Medium · 79.99%");
  assert.match(presentation.confidenceAccessibleLabel, /79\.99%/);
  assert.doesNotMatch(presentation.confidenceLabel, /80%/);
});

test("distinguishes an unavailable driver from a neutral zero contribution", () => {
  const withUnavailablePool = {
    ...simulatedHotHeat,
    signal: {
      ...simulatedHotHeat.signal,
      components: {
        ...simulatedHotHeat.signal.components,
        poolComposition: {
          status: "unavailable" as const,
          reason: "EVIDENCE_INCOMPLETE" as const,
        },
      },
    },
  } as PublicRepackHeat;
  const presentation = presentRepackHeatDetails(withUnavailablePool);

  assert.equal(presentation.availability, "current");
  if (presentation.availability !== "current") return;
  const poolDriver = presentation.drivers.find(
    ({ code }) => code === "pool_composition",
  );
  assert.equal(poolDriver?.value, "Unavailable");
  assert.equal(poolDriver?.context, "Component unavailable");
  assert.match(poolDriver?.accessibleLabel ?? "", /component is unavailable/i);
});

test("uses bounded public messages for expired and release-mismatched heat", () => {
  const expired = presentRepackHeatDetails({
    status: "expired",
    signal: null,
    lastCalculatedAt: "2026-08-13T12:00:00Z",
    expiredAt: "2026-08-13T12:10:00Z",
  });
  const mismatch = presentRepackHeatDetails({
    status: "unavailable",
    signal: null,
    reason: "RELEASE_MISMATCH",
  });

  assert.equal(expired.availability, "expired");
  assert.match(expired.availability === "expired" ? expired.message : "", /not shown as normal or cold/i);
  assert.equal(
    expired.availability === "expired" ? expired.expiredLabel : "",
    "Expired Aug 13, 12:10 PM UTC",
  );
  assert.equal(mismatch.availability, "unavailable");
  assert.match(mismatch.availability === "unavailable" ? mismatch.message : "", /matched to this data release/i);
});
