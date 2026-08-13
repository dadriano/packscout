import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_SCENARIO_VERSION,
  calculateRepackHeat,
  type RepackHeatCalculationInput,
  type RepackHeatObservation,
} from "./repack-heat-calculator.ts";

const repackId = "40000000-0000-5000-8000-000000000001";
const hour = 60 * 60 * 1_000;
const day = 24 * hour;
const epoch = Date.parse("2026-08-13T12:00:00.000Z");
const iso = (value: number) => new Date(value).toISOString();

function pull(
  occurredAt: number,
  overrides: Partial<Extract<RepackHeatObservation, { kind: "pull" }>> = {},
): RepackHeatObservation {
  return {
    kind: "pull",
    publicRepackId: repackId,
    occurredAt: iso(occurredAt),
    realizedReturnBasisPoints: 10_000,
    valueMultipleBasisPoints: 10_000,
    ...overrides,
  };
}

function pulls(
  count: number,
  start: number,
  duration: number,
  overrides: Partial<Extract<RepackHeatObservation, { kind: "pull" }>> = {},
): RepackHeatObservation[] {
  return Array.from({ length: count }, (_, index) =>
    pull(start + Math.floor(((index + 0.5) * duration) / count), overrides),
  );
}

function catalog(
  occurredAt: number,
  availableChaseCount = 3,
  outcomeKeys: readonly string[] = ["a", "b", "c"],
  sequence = 0,
): RepackHeatObservation {
  return {
    kind: "catalog_snapshot",
    publicRepackId: repackId,
    occurredAt: iso(occurredAt),
    sequence,
    availableChaseCount,
    outcomeKeys,
  };
}

function input(observations: readonly RepackHeatObservation[]): RepackHeatCalculationInput {
  return {
    publicRepackIds: [repackId],
    observations,
    baselineWindow: { startAt: iso(epoch - day - hour), endAt: iso(epoch - hour) },
    currentWindow: { startAt: iso(epoch - hour), endAt: iso(epoch) },
    provenance: {
      kind: "simulated",
      aggregationVersion: REPACK_HEAT_AGGREGATION_VERSION,
      scenarioVersion: REPACK_HEAT_SCENARIO_VERSION,
    },
    heatPolicyVersion: REPACK_HEAT_POLICY_VERSION,
    sourceCoverageComplete: true,
    calculatedAt: iso(epoch),
    expiresAt: iso(epoch + hour),
  };
}

function completeObservations(currentCount: number, baselineCount = 480) {
  return [
    ...pulls(baselineCount, epoch - day - hour, day),
    catalog(epoch - hour - 1, 3, ["a", "b", "c"]),
    ...pulls(currentCount, epoch - hour, hour),
    catalog(epoch - 1, 3, ["a", "b", "c"]),
  ];
}

test("normalizes activity and exposes every evidence component", () => {
  const [signal] = calculateRepackHeat(input(completeObservations(40)));
  assert.deepEqual(signal?.components.activity, {
    status: "available",
    currentPullCount: 40,
    baselinePullCount: 480,
    relativeRateDeltaBasisPoints: 10_000,
  });
  assert.equal(signal?.components.observedReturn.status, "available");
  assert.equal(signal?.components.largeHitFrequency.status, "available");
  assert.deepEqual(signal?.components.chaseAvailability, {
    status: "available",
    currentAvailableChaseCount: 3,
    baselineAvailableChaseCount: 3,
    change: "unchanged",
  });
  assert.deepEqual(signal?.components.poolComposition, {
    status: "available",
    addedOutcomeCount: 0,
    removedOutcomeCount: 0,
    changeMagnitudeBasisPoints: 0,
    changed: false,
  });
  assert.deepEqual(signal?.limitationCodes, ["simulated_data"]);
  assert.deepEqual(signal?.drivers, [
    { code: "activity", contributionBasisPoints: 1_400 },
    { code: "chase_availability", contributionBasisPoints: 0 },
    { code: "large_hit_frequency", contributionBasisPoints: 0 },
    { code: "observed_return", contributionBasisPoints: 0 },
    { code: "pool_composition", contributionBasisPoints: 0 },
  ]);
  assert.equal(signal?.scoreBasisPoints, 6_400);
  assert.deepEqual(signal?.signalConfidence, {
    scoreBasisPoints: 10_000,
    band: "high",
  });
});

test("returns null score and confidence below exact sample gates", () => {
  const [signal] = calculateRepackHeat(input(completeObservations(4, 19)));
  assert.equal(signal?.state, "insufficient_data");
  assert.equal(signal?.scoreBasisPoints, null);
  assert.equal(signal?.signalConfidence, null);
  assert.deepEqual(signal?.limitationCodes, [
    "baseline_sample_below_minimum",
    "current_sample_below_minimum",
    "simulated_data",
  ]);
  assert.deepEqual(signal?.components.activity, {
    status: "unavailable",
    reason: "CURRENT_SAMPLE_INSUFFICIENT",
  });
});

test("applies policy thresholds without assigning an authoritative insufficient score", () => {
  const stateFor = (overrides: {
    current: number;
    currentReturn?: number;
    currentMultiple?: number;
    baselineReturn?: number;
    baselineMultiple?: number;
    currentChases?: number;
  }) => {
    const observations = [
      ...pulls(480, epoch - day - hour, day, {
        realizedReturnBasisPoints: overrides.baselineReturn ?? 10_000,
        valueMultipleBasisPoints: overrides.baselineMultiple ?? 10_000,
      }),
      catalog(epoch - hour - 1, 3),
      ...pulls(overrides.current, epoch - hour, hour, {
        realizedReturnBasisPoints: overrides.currentReturn ?? 10_000,
        valueMultipleBasisPoints: overrides.currentMultiple ?? 10_000,
      }),
      catalog(epoch - 1, overrides.currentChases ?? 3),
    ];
    return calculateRepackHeat(input(observations))[0]!;
  };
  assert.equal(
    stateFor({ current: 60, currentReturn: 15_000, currentMultiple: 30_000, currentChases: 4 }).state,
    "hot",
  );
  assert.equal(stateFor({ current: 42 }).state, "warm");
  assert.equal(stateFor({ current: 20 }).state, "normal");
  assert.equal(
    stateFor({ current: 20, currentReturn: 5_000, baselineMultiple: 30_000, currentChases: 2 }).state,
    "cold",
  );
});

test("keeps observed return and hit rate distinct from modeled EV", () => {
  const observations = [
    ...pulls(480, epoch - day - hour, day),
    catalog(epoch - hour - 1),
    ...pulls(20, epoch - hour, hour, {
      realizedReturnBasisPoints: 15_000,
      valueMultipleBasisPoints: 30_000,
    }),
    catalog(epoch - 1),
  ];
  const [signal] = calculateRepackHeat(input(observations));
  assert.deepEqual(signal?.components.observedReturn, {
    status: "available",
    currentReturnBasisPoints: 15_000,
    baselineReturnBasisPoints: 10_000,
    rateDeltaBasisPoints: 5_000,
  });
  assert.equal(
    signal?.components.largeHitFrequency.status === "available"
      ? signal.components.largeHitFrequency.rateDeltaBasisPoints
      : null,
    10_000,
  );
});

test("maps partial evidence to exhaustive unavailable reasons and limitations", () => {
  const partial = completeObservations(20).map((observation) =>
    observation.kind === "pull" && observation.occurredAt >= iso(epoch - hour)
      ? { ...observation, realizedReturnBasisPoints: null, valueMultipleBasisPoints: null }
      : observation,
  );
  const [signal] = calculateRepackHeat(
    input(partial).sourceCoverageComplete
      ? { ...input(partial), sourceCoverageComplete: false }
      : input(partial),
  );
  assert.deepEqual(signal?.components.observedReturn, {
    status: "unavailable",
    reason: "EVIDENCE_INCOMPLETE",
  });
  assert.deepEqual(signal?.components.largeHitFrequency, {
    status: "unavailable",
    reason: "EVIDENCE_INCOMPLETE",
  });
  assert.deepEqual(signal?.limitationCodes, [
    "large_hit_data_incomplete",
    "partial_source_coverage",
    "return_data_incomplete",
    "simulated_data",
  ]);
  assert.deepEqual(signal?.signalConfidence, {
    scoreBasisPoints: 7_999,
    band: "medium",
  });
  assert.equal(signal?.sourceCoverage, "partial");
});

test("is deterministic, canonical by identity, and rejects unsafe inputs", () => {
  const valid = input(completeObservations(20));
  assert.deepEqual(calculateRepackHeat(valid), calculateRepackHeat(valid));
  const second = "40000000-0000-5000-8000-000000000002";
  assert.deepEqual(
    calculateRepackHeat({ ...valid, publicRepackIds: [second, repackId] }).map(
      ({ publicRepackId }) => publicRepackId,
    ),
    [repackId, second],
  );
  assert.throws(() => calculateRepackHeat({ ...valid, publicRepackIds: [repackId, repackId] }));
  assert.throws(() => calculateRepackHeat({ ...valid, observations: [pull(epoch + hour)] }));
  assert.throws(() =>
    calculateRepackHeat({
      ...valid,
      observations: [pull(epoch - hour / 2, { realizedReturnBasisPoints: NaN })],
    }),
  );
  assert.throws(() =>
    calculateRepackHeat({
      ...valid,
      calculatedAt: "2026-08-13T12:00:00Z",
    }),
  );
  assert.throws(() =>
    calculateRepackHeat({
      ...valid,
      currentWindow: {
        startAt: "2026-08-13T11:59:59.999Z",
        endAt: "2026-08-13T12:00:00.000Z",
      },
    }),
  );
});

test("equal-time catalog revisions are deterministic and exact ties fail closed", () => {
  const base = completeObservations(20).filter(
    (observation) =>
      observation.kind !== "catalog_snapshot" ||
      observation.occurredAt < iso(epoch - hour),
  );
  const lower = catalog(epoch - 1, 3, ["a", "b", "c"], 1);
  const higher = catalog(epoch - 1, 4, ["a", "b", "c", "d"], 2);
  const first = calculateRepackHeat(input([...base, lower, higher]));
  const reversed = calculateRepackHeat(input([...base, higher, lower]));
  assert.deepEqual(first, reversed);
  assert.deepEqual(first[0]?.components.chaseAvailability, {
    status: "available",
    currentAvailableChaseCount: 4,
    baselineAvailableChaseCount: 3,
    change: "restocked",
  });
  assert.equal(higher.kind, "catalog_snapshot");
  assert.equal(lower.kind, "catalog_snapshot");
  if (
    higher.kind !== "catalog_snapshot" ||
    lower.kind !== "catalog_snapshot"
  ) {
    throw new Error("Expected a catalog snapshot.");
  }
  assert.throws(() =>
    calculateRepackHeat(input([...base, lower, { ...higher, sequence: 1 }])),
  );
  assert.throws(() =>
    calculateRepackHeat(
      input([...base, higher, lower, { ...lower, availableChaseCount: 2 }]),
    ),
  );
});

test("catalog snapshots enforce cumulative key and byte budgets", () => {
  const tenThousandKeys = Array.from(
    { length: 10_000 },
    (_, index) => `outcome_${String(index).padStart(5, "0")}`,
  );
  const overKeyBudget = Array.from({ length: 11 }, (_, index) =>
    catalog(epoch - 30_000 + index, 3, tenThousandKeys, index)
  );
  assert.throws(() => calculateRepackHeat(input(overKeyBudget)), /key budget/u);

  const largeKeys = Array.from({ length: 10_000 }, (_, index) =>
    `${"x".repeat(92)}${String(index).padStart(8, "0")}`
  );
  const overByteBudget = Array.from({ length: 9 }, (_, index) =>
    catalog(epoch - 30_000 + index, 3, largeKeys, index)
  );
  assert.throws(() => calculateRepackHeat(input(overByteBudget)), /byte budget/u);
});

test("bounded extreme window ratios remain safe and policy-valid", () => {
  const minute = 60_000;
  const maximumBaseline = 366 * day;
  const currentStart = epoch - minute;
  const baselineEnd = currentStart;
  const baselineStart = baselineEnd - maximumBaseline;
  const observations = [
    ...pulls(20, baselineStart, maximumBaseline),
    catalog(baselineEnd - 1, 3, ["a"], 0),
    ...pulls(5, currentStart, minute),
    catalog(epoch - 1, 3, ["a"], 0),
  ];
  const [signal] = calculateRepackHeat({
    ...input(observations),
    baselineWindow: { startAt: iso(baselineStart), endAt: iso(baselineEnd) },
    currentWindow: { startAt: iso(currentStart), endAt: iso(epoch) },
  });
  assert.equal(signal?.components.activity.status, "available");
  assert.equal(
    signal?.components.activity.status === "available"
      ? Number.isSafeInteger(
          signal.components.activity.relativeRateDeltaBasisPoints,
        )
      : false,
    true,
  );
});
