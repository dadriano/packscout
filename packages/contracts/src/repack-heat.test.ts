import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_SCENARIO_VERSION,
  parseRepackHeatTimestampMillis,
  publicRepackHeatSchema,
  publicRepackHeatSignalSchema,
  unavailableRepackHeat,
  type PublicRepackHeatSignal,
} from "./repack-heat.ts";

const PUBLIC_REPACK_ID = "50000000-0000-5000-8000-000000000001";

function availableComponents(): PublicRepackHeatSignal["components"] {
  return {
    activity: {
      status: "available",
      currentPullCount: 80,
      baselinePullCount: 2_000,
      relativeRateDeltaBasisPoints: 28_400,
    },
    observedReturn: {
      status: "available",
      currentReturnBasisPoints: 9_000,
      baselineReturnBasisPoints: 8_500,
      rateDeltaBasisPoints: 500,
    },
    largeHitFrequency: {
      status: "available",
      currentHitCount: 2,
      baselineHitCount: 20,
      currentRateBasisPoints: 250,
      baselineRateBasisPoints: 100,
      rateDeltaBasisPoints: 150,
      thresholdMultipleBasisPoints:
        REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
    },
    chaseAvailability: {
      status: "available",
      currentAvailableChaseCount: 3,
      baselineAvailableChaseCount: 2,
      change: "restocked",
    },
    poolComposition: {
      status: "available",
      addedOutcomeCount: 1,
      removedOutcomeCount: 0,
      changeMagnitudeBasisPoints: 500,
      changed: true,
    },
  };
}

function simulatedSignal(): PublicRepackHeatSignal {
  return {
    publicRepackId: PUBLIC_REPACK_ID,
    state: "hot",
    scoreBasisPoints: 8_505,
    provenance: {
      kind: "simulated",
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
      scenarioVersion: REPACK_HEAT_SCENARIO_VERSION,
    },
    sourceCoverage: "complete",
    currentWindow: {
      startedAt: "2026-08-13T00:00:00.000Z",
      endedAt: "2026-08-13T00:15:00.000Z",
      pullCount: 80,
    },
    baselineWindow: {
      startedAt: "2026-08-12T00:00:00.000Z",
      endedAt: "2026-08-13T00:00:00.000Z",
      pullCount: 2_000,
    },
    sampleRequirements: {
      minimumCurrentPullCount: REPACK_HEAT_MINIMUM_CURRENT_PULLS,
      minimumBaselinePullCount: REPACK_HEAT_MINIMUM_BASELINE_PULLS,
    },
    components: availableComponents(),
    drivers: [
      { code: "activity", contributionBasisPoints: 2_800 },
      { code: "chase_availability", contributionBasisPoints: 500 },
      { code: "large_hit_frequency", contributionBasisPoints: 105 },
      { code: "observed_return", contributionBasisPoints: 90 },
      { code: "pool_composition", contributionBasisPoints: 10 },
    ],
    signalConfidence: { scoreBasisPoints: 10_000, band: "high" },
    limitationCodes: ["simulated_data"],
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    calculatedAt: "2026-08-13T00:16:00.000Z",
    expiresAt: "2026-08-13T00:31:00.000Z",
  };
}

test("heat accepts exact v1 policy output over normalized unequal windows", () => {
  const signal = simulatedSignal();
  assert.equal(
    Date.parse(signal.baselineWindow.endedAt) -
      Date.parse(signal.baselineWindow.startedAt),
    24 * 60 * 60 * 1_000,
  );
  assert.equal(
    Date.parse(signal.currentWindow.endedAt) -
      Date.parse(signal.currentWindow.startedAt),
    15 * 60 * 1_000,
  );
  assert.equal(publicRepackHeatSignalSchema.safeParse(signal).success, true);
  assert.equal(
    publicRepackHeatSchema.safeParse({ status: "current", signal }).success,
    true,
  );
});

test("heat v1 rejects policy, score, confidence, limitation, and driver drift", () => {
  const mutations: unknown[] = [
    {
      ...simulatedSignal(),
      sampleRequirements: {
        minimumCurrentPullCount: 6,
        minimumBaselinePullCount: REPACK_HEAT_MINIMUM_BASELINE_PULLS,
      },
    },
    {
      ...simulatedSignal(),
      heatPolicyVersion: "packscout_heat_policy_v2",
    },
    {
      ...simulatedSignal(),
      provenance: {
        kind: "simulated",
        aggregationVersion: "packscout_repack_heat_v2",
        scenarioVersion: REPACK_HEAT_SCENARIO_VERSION,
      },
    },
    {
      ...simulatedSignal(),
      provenance: {
        kind: "simulated",
        aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
        scenarioVersion: "operator_email_example_com",
      },
    },
    { ...simulatedSignal(), scoreBasisPoints: 8_504 },
    { ...simulatedSignal(), state: "warm" },
    {
      ...simulatedSignal(),
      signalConfidence: { scoreBasisPoints: 9_999, band: "high" },
    },
    { ...simulatedSignal(), limitationCodes: [] },
    {
      ...simulatedSignal(),
      drivers: simulatedSignal().drivers.map((driver, index) =>
        index === 0
          ? { ...driver, contributionBasisPoints: 2_799 }
          : driver,
      ),
    },
    {
      ...simulatedSignal(),
      drivers: [...simulatedSignal().drivers].reverse(),
    },
    {
      ...simulatedSignal(),
      components: {
        ...simulatedSignal().components,
        largeHitFrequency: {
          ...simulatedSignal().components.largeHitFrequency,
          thresholdMultipleBasisPoints: 50_000,
        },
      },
    },
  ];
  for (const mutation of mutations) {
    assert.equal(publicRepackHeatSignalSchema.safeParse(mutation).success, false);
  }
});

test("heat timestamps require canonical millisecond UTC and bounded lifecycle", () => {
  assert.equal(
    parseRepackHeatTimestampMillis("2026-08-13T00:16:00.000Z"),
    Date.parse("2026-08-13T00:16:00.000Z"),
  );
  assert.equal(
    parseRepackHeatTimestampMillis("2026-08-13T00:16:00Z"),
    null,
  );
  assert.equal(
    parseRepackHeatTimestampMillis("2026-08-12T17:16:00.000-07:00"),
    null,
  );
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...simulatedSignal(),
      calculatedAt: "2026-08-13T00:16:00Z",
    }).success,
    false,
  );
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...simulatedSignal(),
      calculatedAt: "2026-08-13T00:31:00.001Z",
      expiresAt: "2026-08-13T00:46:00.001Z",
    }).success,
    false,
  );
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...simulatedSignal(),
      expiresAt: "2026-08-13T01:16:00.001Z",
    }).success,
    false,
  );
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...simulatedSignal(),
      currentWindow: {
        ...simulatedSignal().currentWindow,
        endedAt: "2026-08-13T00:00:59.999Z",
      },
    }).success,
    false,
  );
});

test("heat component math remains bound to published windows and counts", () => {
  const signal = simulatedSignal();
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...signal,
      components: {
        ...signal.components,
        activity: {
          ...signal.components.activity,
          relativeRateDeltaBasisPoints: 28_399,
        },
      },
    }).success,
    false,
  );
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...signal,
      components: {
        ...signal.components,
        largeHitFrequency: {
          ...signal.components.largeHitFrequency,
          currentRateBasisPoints: 249,
          rateDeltaBasisPoints: 149,
        },
      },
    }).success,
    false,
  );
  for (const reason of [
    "EVIDENCE_INCOMPLETE",
    "METRIC_UNSUPPORTED",
    "BASELINE_UNAVAILABLE",
  ] as const) {
    assert.equal(
      publicRepackHeatSignalSchema.safeParse({
        ...signal,
        components: {
          ...signal.components,
          activity: { status: "unavailable", reason },
        },
        drivers: signal.drivers.map((driver) =>
          driver.code === "activity"
            ? { ...driver, contributionBasisPoints: 0 }
            : driver,
        ),
        scoreBasisPoints: 5_705,
      }).success,
      false,
    );
  }
});

test("partial source coverage is exact and caps confidence below high", () => {
  const partial = {
    ...simulatedSignal(),
    sourceCoverage: "partial" as const,
    limitationCodes: ["partial_source_coverage", "simulated_data"] as const,
    signalConfidence: {
      scoreBasisPoints: 7_999,
      band: "medium" as const,
    },
  };
  assert.equal(publicRepackHeatSignalSchema.safeParse(partial).success, true);
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...partial,
      signalConfidence: { scoreBasisPoints: 10_000, band: "high" },
    }).success,
    false,
  );
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...partial,
      limitationCodes: ["simulated_data"],
    }).success,
    false,
  );
});

test("insufficient data has no score or confidence and names exact gates", () => {
  const unavailableComponent = {
    status: "unavailable" as const,
    reason: "CURRENT_SAMPLE_INSUFFICIENT" as const,
  };
  const signal = {
    ...simulatedSignal(),
    state: "insufficient_data" as const,
    scoreBasisPoints: null,
    signalConfidence: null,
    currentWindow: {
      ...simulatedSignal().currentWindow,
      pullCount: 4,
    },
    components: {
      ...simulatedSignal().components,
      activity: unavailableComponent,
      observedReturn: unavailableComponent,
      largeHitFrequency: unavailableComponent,
    },
    drivers: [
      { code: "activity" as const, contributionBasisPoints: 0 },
      { code: "chase_availability" as const, contributionBasisPoints: 500 },
      { code: "large_hit_frequency" as const, contributionBasisPoints: 0 },
      { code: "observed_return" as const, contributionBasisPoints: 0 },
      { code: "pool_composition" as const, contributionBasisPoints: 10 },
    ],
    limitationCodes: [
      "current_sample_below_minimum" as const,
      "simulated_data" as const,
    ],
  };
  assert.equal(publicRepackHeatSignalSchema.safeParse(signal).success, true);
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...signal,
      scoreBasisPoints: 4_000,
    }).success,
    false,
  );
});

test("heat rejects raw/provider fields and provenance ambiguity", () => {
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...simulatedSignal(),
      rawPulls: [{ amount: 1 }],
    }).success,
    false,
  );
  assert.equal(
    publicRepackHeatSignalSchema.safeParse({
      ...simulatedSignal(),
      components: {
        ...simulatedSignal().components,
        activity: {
          ...simulatedSignal().components.activity,
          providerPayload: { secret: true },
        },
      },
    }).success,
    false,
  );
  const observed = {
    ...simulatedSignal(),
    provenance: {
      kind: "observed" as const,
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
    },
    limitationCodes: [] as const,
  };
  assert.equal(publicRepackHeatSignalSchema.safeParse(observed).success, true);
});

test("expired and unavailable wrappers never retain a current signal", () => {
  assert.deepEqual(unavailableRepackHeat(), {
    status: "unavailable",
    signal: null,
    reason: "NOT_PUBLISHED",
  });
  assert.equal(
    publicRepackHeatSchema.safeParse({
      status: "expired",
      signal: null,
      lastCalculatedAt: "2026-08-13T00:16:00.000Z",
      expiredAt: "2026-08-13T00:31:00.000Z",
    }).success,
    true,
  );
  assert.equal(
    publicRepackHeatSchema.safeParse({
      status: "expired",
      signal: simulatedSignal(),
      lastCalculatedAt: "2026-08-13T00:16:00.000Z",
      expiredAt: "2026-08-13T00:31:00.000Z",
    }).success,
    false,
  );
  assert.equal(
    publicRepackHeatSchema.safeParse({
      status: "expired",
      signal: null,
      lastCalculatedAt: "2026-08-13T00:16:00.000Z",
      expiredAt: "2026-08-13T01:16:00.001Z",
    }).success,
    false,
  );
});
