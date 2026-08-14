import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT,
  REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL,
  REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
  REPACK_HEAT_MAXIMUM_OBSERVATIONS,
  REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS,
  REPACK_HEAT_MAXIMUM_WINDOW_MILLISECONDS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_MINIMUM_WINDOW_MILLISECONDS,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_SCENARIO_VERSION,
  deriveRepackHeatV1Policy,
  parseRepackHeatTimestampMillis,
  publicRepackHeatSignalSchema,
  type PublicRepackHeatSignal,
  type RepackHeatComponentUnavailableReason,
  type RepackHeatPolicyVersion,
  type RepackHeatProvenance,
} from "@packscout/contracts";

export {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_SCENARIO_VERSION,
} from "@packscout/contracts";

const MAX_OBSERVED_BASIS_POINTS = 10_000_000;
const MAX_AVAILABLE_CHASE_COUNT = 10_000;

type UnavailableReason = RepackHeatComponentUnavailableReason;

type UnavailableComponent = Readonly<{
  status: "unavailable";
  reason: UnavailableReason;
}>;

export interface RepackHeatCalculationWindow {
  readonly startAt: string;
  readonly endAt: string;
}

export type RepackHeatObservation =
  | {
      readonly kind: "pull";
      readonly publicRepackId: string;
      readonly occurredAt: string;
      /** Observed gross return divided by pack price. This is not modeled EV. */
      readonly realizedReturnBasisPoints: number | null;
      readonly valueMultipleBasisPoints: number | null;
    }
  | {
      readonly kind: "catalog_snapshot";
      readonly publicRepackId: string;
      readonly occurredAt: string;
      /** Stable tie-breaker for snapshots with the same occurredAt value. */
      readonly sequence: number;
      readonly availableChaseCount: number;
      /** Ephemeral stable outcome keys; callers must not publish them. */
      readonly outcomeKeys: readonly string[];
    };

export interface RepackHeatCalculationInput {
  readonly publicRepackIds: readonly string[];
  readonly observations: readonly RepackHeatObservation[];
  readonly currentWindow: RepackHeatCalculationWindow;
  readonly baselineWindow: RepackHeatCalculationWindow;
  readonly provenance: RepackHeatProvenance;
  readonly heatPolicyVersion: RepackHeatPolicyVersion;
  readonly sourceCoverageComplete: boolean;
  readonly calculatedAt: string;
  readonly expiresAt: string;
}

type ActivityComponent = PublicRepackHeatSignal["components"]["activity"];
type ObservedReturnComponent =
  PublicRepackHeatSignal["components"]["observedReturn"];
type LargeHitFrequencyComponent =
  PublicRepackHeatSignal["components"]["largeHitFrequency"];
type ChaseAvailabilityComponent =
  PublicRepackHeatSignal["components"]["chaseAvailability"];
type PoolCompositionComponent =
  PublicRepackHeatSignal["components"]["poolComposition"];
export type CalculatedRepackHeatSignal = PublicRepackHeatSignal;

interface CatalogSnapshot {
  availableChaseCount: number;
  outcomeKeys: readonly string[];
}

interface Sample {
  pulls: number;
  returns: number[];
  multiples: number[];
  catalog: CatalogSnapshot | null;
  catalogAt: number;
  catalogSequence: number;
  catalogRevisions: Set<string>;
}

function emptySample(): Sample {
  return {
    pulls: 0,
    returns: [],
    multiples: [],
    catalog: null,
    catalogAt: -1,
    catalogSequence: -1,
    catalogRevisions: new Set(),
  };
}

function timestamp(value: string, field: string): number {
  const parsed = parseRepackHeatTimestampMillis(value);
  if (parsed === null) {
    throw new RangeError(`${field} must be a canonical UTC timestamp.`);
  }
  return parsed;
}

function timeWindow(value: RepackHeatCalculationWindow, field: string) {
  const start = timestamp(value.startAt, `${field}.startAt`);
  const end = timestamp(value.endAt, `${field}.endAt`);
  const duration = end - start;
  if (
    duration < REPACK_HEAT_MINIMUM_WINDOW_MILLISECONDS ||
    duration > REPACK_HEAT_MAXIMUM_WINDOW_MILLISECONDS
  ) {
    throw new RangeError(`${field} has an invalid duration.`);
  }
  return { start, end, duration };
}

function boundedInteger(
  value: number,
  field: string,
  maximum = MAX_OBSERVED_BASIS_POINTS,
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${field} must be a bounded nonnegative integer.`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mean(values: readonly number[]): number {
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

function unavailable(reason: UnavailableReason): UnavailableComponent {
  return { status: "unavailable", reason };
}

function sampleReason(current: Sample, baseline: Sample): UnavailableReason | null {
  if (current.pulls < REPACK_HEAT_MINIMUM_CURRENT_PULLS) {
    return "CURRENT_SAMPLE_INSUFFICIENT";
  }
  if (baseline.pulls < REPACK_HEAT_MINIMUM_BASELINE_PULLS) {
    return "BASELINE_SAMPLE_INSUFFICIENT";
  }
  return null;
}

function activityComponent(
  current: Sample,
  baseline: Sample,
  currentDuration: number,
  baselineDuration: number,
): ActivityComponent {
  const reason = sampleReason(current, baseline);
  if (reason !== null) return unavailable(reason);
  const relativeRateDeltaBasisPoints = Math.round(
    ((current.pulls * baselineDuration) /
        (baseline.pulls * currentDuration) -
      1) *
      10_000,
  );
  if (!Number.isSafeInteger(relativeRateDeltaBasisPoints)) {
    throw new RangeError("Heat activity delta is outside bounded limits.");
  }
  return {
    status: "available",
    currentPullCount: current.pulls,
    baselinePullCount: baseline.pulls,
    relativeRateDeltaBasisPoints,
  };
}

function observedReturnComponent(
  current: Sample,
  baseline: Sample,
): ObservedReturnComponent {
  const reason = sampleReason(current, baseline);
  if (reason !== null) return unavailable(reason);
  if (
    current.returns.length !== current.pulls ||
    baseline.returns.length !== baseline.pulls
  ) {
    return unavailable("EVIDENCE_INCOMPLETE");
  }
  const currentReturnBasisPoints = mean(current.returns);
  const baselineReturnBasisPoints = mean(baseline.returns);
  return {
    status: "available",
    currentReturnBasisPoints,
    baselineReturnBasisPoints,
    rateDeltaBasisPoints: currentReturnBasisPoints - baselineReturnBasisPoints,
  };
}

function largeHitComponent(
  current: Sample,
  baseline: Sample,
): LargeHitFrequencyComponent {
  const reason = sampleReason(current, baseline);
  if (reason !== null) return unavailable(reason);
  if (
    current.multiples.length !== current.pulls ||
    baseline.multiples.length !== baseline.pulls
  ) {
    return unavailable("EVIDENCE_INCOMPLETE");
  }
  const currentHitCount = current.multiples.filter(
    (value) => value >= REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  ).length;
  const baselineHitCount = baseline.multiples.filter(
    (value) => value >= REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  ).length;
  const currentRateBasisPoints = Math.round(
    (currentHitCount * 10_000) / current.pulls,
  );
  const baselineRateBasisPoints = Math.round(
    (baselineHitCount * 10_000) / baseline.pulls,
  );
  return {
    status: "available",
    currentHitCount,
    baselineHitCount,
    currentRateBasisPoints,
    baselineRateBasisPoints,
    rateDeltaBasisPoints: currentRateBasisPoints - baselineRateBasisPoints,
    thresholdMultipleBasisPoints:
      REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  };
}

function chaseComponent(
  current: Sample,
  baseline: Sample,
): ChaseAvailabilityComponent {
  if (baseline.catalog === null) return unavailable("BASELINE_UNAVAILABLE");
  if (current.catalog === null) return unavailable("EVIDENCE_INCOMPLETE");
  const difference =
    current.catalog.availableChaseCount - baseline.catalog.availableChaseCount;
  return {
    status: "available",
    currentAvailableChaseCount: current.catalog.availableChaseCount,
    baselineAvailableChaseCount: baseline.catalog.availableChaseCount,
    change: difference > 0
      ? "restocked"
      : difference < 0
        ? "depleted"
        : "unchanged",
  };
}

function poolComponent(
  current: Sample,
  baseline: Sample,
): PoolCompositionComponent {
  if (baseline.catalog === null) return unavailable("BASELINE_UNAVAILABLE");
  if (current.catalog === null) return unavailable("EVIDENCE_INCOMPLETE");
  const currentKeys = new Set(current.catalog.outcomeKeys);
  const baselineKeys = new Set(baseline.catalog.outcomeKeys);
  const addedOutcomeCount = [...currentKeys].filter(
    (key) => !baselineKeys.has(key),
  ).length;
  const removedOutcomeCount = [...baselineKeys].filter(
    (key) => !currentKeys.has(key),
  ).length;
  return {
    status: "available",
    addedOutcomeCount,
    removedOutcomeCount,
    changeMagnitudeBasisPoints: clamp(
      Math.round(
        ((addedOutcomeCount + removedOutcomeCount) * 10_000) /
          Math.max(1, baselineKeys.size),
      ),
      0,
      10_000,
    ),
    changed: addedOutcomeCount + removedOutcomeCount > 0,
  };
}

export function calculateRepackHeat(
  input: RepackHeatCalculationInput,
): readonly CalculatedRepackHeatSignal[] {
  if (
    input.publicRepackIds.length === 0 ||
    input.publicRepackIds.length > MAX_PUBLIC_REPACKS_PER_RELEASE ||
    input.observations.length > REPACK_HEAT_MAXIMUM_OBSERVATIONS
  ) {
    throw new RangeError("Heat calculation input is outside bounded limits.");
  }
  const publicRepackIds = [...input.publicRepackIds].sort();
  if (
    publicRepackIds.some(
      (id, index) =>
        id.trim() === "" ||
        id.length > 128 ||
        id === publicRepackIds[index - 1],
    )
  ) {
    throw new RangeError("Heat repack identities must be unique and bounded.");
  }
  const currentWindow = timeWindow(input.currentWindow, "currentWindow");
  const baselineWindow = timeWindow(input.baselineWindow, "baselineWindow");
  const calculatedAt = timestamp(input.calculatedAt, "calculatedAt");
  const expiresAt = timestamp(input.expiresAt, "expiresAt");
  if (
    baselineWindow.end > currentWindow.start ||
    calculatedAt < currentWindow.end ||
    calculatedAt - currentWindow.end >
      REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS ||
    expiresAt <= calculatedAt ||
    expiresAt - calculatedAt > REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS
  ) {
    throw new RangeError("Heat windows and lifecycle timestamps are invalid.");
  }
  if (
    input.heatPolicyVersion !== REPACK_HEAT_POLICY_VERSION ||
    input.provenance.aggregationVersion !== REPACK_HEAT_AGGREGATION_VERSION ||
    (input.provenance.kind === "simulated" &&
      input.provenance.scenarioVersion !== REPACK_HEAT_SCENARIO_VERSION)
  ) {
    throw new RangeError("Heat policy and provenance versions are unsupported.");
  }

  const known = new Set(publicRepackIds);
  const currentById = new Map(
    publicRepackIds.map((id) => [id, emptySample()]),
  );
  const baselineById = new Map(
    publicRepackIds.map((id) => [id, emptySample()]),
  );
  const encoder = new TextEncoder();
  let catalogOutcomeKeyCount = 0;
  let catalogOutcomeByteCount = 0;

  for (const [index, observation] of input.observations.entries()) {
    if (!known.has(observation.publicRepackId)) {
      throw new RangeError(`observations[${index}] has an unknown repack.`);
    }
    const occurredAt = timestamp(
      observation.occurredAt,
      `observations[${index}].occurredAt`,
    );
    const inCurrent =
      occurredAt >= currentWindow.start && occurredAt < currentWindow.end;
    const inBaseline =
      occurredAt >= baselineWindow.start && occurredAt < baselineWindow.end;
    if (!inCurrent && !inBaseline) {
      throw new RangeError(`observations[${index}] is outside both windows.`);
    }
    const sample = (inCurrent ? currentById : baselineById).get(
      observation.publicRepackId,
    )!;
    if (observation.kind === "pull") {
      if (observation.realizedReturnBasisPoints !== null) {
        boundedInteger(
          observation.realizedReturnBasisPoints,
          `observations[${index}].realizedReturnBasisPoints`,
        );
        sample.returns.push(observation.realizedReturnBasisPoints);
      }
      if (observation.valueMultipleBasisPoints !== null) {
        boundedInteger(
          observation.valueMultipleBasisPoints,
          `observations[${index}].valueMultipleBasisPoints`,
        );
        sample.multiples.push(observation.valueMultipleBasisPoints);
      }
      sample.pulls += 1;
      continue;
    }

    boundedInteger(
      observation.sequence,
      `observations[${index}].sequence`,
      REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE,
    );
    boundedInteger(
      observation.availableChaseCount,
      `observations[${index}].availableChaseCount`,
      MAX_AVAILABLE_CHASE_COUNT,
    );
    if (
      observation.outcomeKeys.length >
      REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT
    ) {
      throw new RangeError(`observations[${index}].outcomeKeys is invalid.`);
    }
    catalogOutcomeKeyCount += observation.outcomeKeys.length;
    if (
      catalogOutcomeKeyCount > REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL
    ) {
      throw new RangeError("Catalog outcome key budget exceeded.");
    }
    for (const key of observation.outcomeKeys) {
      if (key.trim() === "" || key.length > 128) {
        throw new RangeError(`observations[${index}].outcomeKeys is invalid.`);
      }
      catalogOutcomeByteCount += encoder.encode(key).byteLength;
      if (
        catalogOutcomeByteCount >
        REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL
      ) {
        throw new RangeError("Catalog outcome byte budget exceeded.");
      }
    }
    const outcomeKeys = [...observation.outcomeKeys].sort();
    if (
      outcomeKeys.some((key, keyIndex) => key === outcomeKeys[keyIndex - 1])
    ) {
      throw new RangeError(`observations[${index}].outcomeKeys is invalid.`);
    }
    const revisionKey = `${occurredAt}:${observation.sequence}`;
    if (sample.catalogRevisions.has(revisionKey)) {
      throw new RangeError(
        `observations[${index}] duplicates a catalog snapshot revision.`,
      );
    }
    sample.catalogRevisions.add(revisionKey);
    if (
      occurredAt > sample.catalogAt ||
      (occurredAt === sample.catalogAt &&
        observation.sequence > sample.catalogSequence)
    ) {
      sample.catalog = {
        availableChaseCount: observation.availableChaseCount,
        outcomeKeys,
      };
      sample.catalogAt = occurredAt;
      sample.catalogSequence = observation.sequence;
    }
  }

  return publicRepackIds.map((publicRepackId) => {
    const current = currentById.get(publicRepackId)!;
    const baseline = baselineById.get(publicRepackId)!;
    const components = {
      activity: activityComponent(
        current,
        baseline,
        currentWindow.duration,
        baselineWindow.duration,
      ),
      observedReturn: observedReturnComponent(current, baseline),
      largeHitFrequency: largeHitComponent(current, baseline),
      chaseAvailability: chaseComponent(current, baseline),
      poolComposition: poolComponent(current, baseline),
    };
    const sourceCoverage = input.sourceCoverageComplete
      ? "complete" as const
      : "partial" as const;
    const policy = deriveRepackHeatV1Policy({
      currentPullCount: current.pulls,
      baselinePullCount: baseline.pulls,
      components,
      sourceCoverage,
      provenanceKind: input.provenance.kind,
    });
    return publicRepackHeatSignalSchema.parse({
      publicRepackId,
      state: policy.state,
      scoreBasisPoints: policy.scoreBasisPoints,
      signalConfidence: policy.signalConfidence,
      provenance: input.provenance,
      sourceCoverage,
      currentWindow: {
        startedAt: input.currentWindow.startAt,
        endedAt: input.currentWindow.endAt,
        pullCount: current.pulls,
      },
      baselineWindow: {
        startedAt: input.baselineWindow.startAt,
        endedAt: input.baselineWindow.endAt,
        pullCount: baseline.pulls,
      },
      sampleRequirements: {
        minimumCurrentPullCount: REPACK_HEAT_MINIMUM_CURRENT_PULLS,
        minimumBaselinePullCount: REPACK_HEAT_MINIMUM_BASELINE_PULLS,
      },
      components,
      drivers: policy.drivers,
      limitationCodes: policy.limitationCodes,
      heatPolicyVersion: input.heatPolicyVersion,
      calculatedAt: input.calculatedAt,
      expiresAt: input.expiresAt,
    });
  });
}
