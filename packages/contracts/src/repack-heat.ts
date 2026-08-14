import { z } from "zod";
import {
  canonicalArraySchema,
  nonNegativeIntegerSchema,
  publicRepackIdSchema,
} from "./data-release-v2-values.ts";

export const REPACK_HEAT_AGGREGATION_VERSION =
  "packscout_repack_heat_v1" as const;
export const REPACK_HEAT_POLICY_VERSION = "packscout_heat_policy_v1" as const;
export const REPACK_HEAT_SCENARIO_VERSION = "packscout_heat_sim_v1" as const;
export const REPACK_HEAT_MINIMUM_CURRENT_PULLS = 5 as const;
export const REPACK_HEAT_MINIMUM_BASELINE_PULLS = 20 as const;
export const REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS = 20_000 as const;
export const REPACK_HEAT_PARTIAL_COVERAGE_CONFIDENCE_CAP_BASIS_POINTS =
  7_999 as const;
export const REPACK_HEAT_MINIMUM_WINDOW_MILLISECONDS = 60_000 as const;
export const REPACK_HEAT_MAXIMUM_WINDOW_MILLISECONDS =
  366 * 24 * 60 * 60 * 1_000;
export const REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS =
  15 * 60 * 1_000;
export const REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS = 60 * 60 * 1_000;
export const REPACK_HEAT_MAXIMUM_PUBLISH_LAG_MILLISECONDS = 5 * 60 * 1_000;
export const REPACK_HEAT_MAXIMUM_FUTURE_SKEW_MILLISECONDS = 60 * 1_000;
export const REPACK_HEAT_MAXIMUM_OBSERVATIONS = 100_000 as const;
export const REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT =
  10_000 as const;
export const REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_TOTAL = 100_000 as const;
export const REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_BYTES_TOTAL =
  8 * 1_024 * 1_024;
export const REPACK_HEAT_MAXIMUM_CATALOG_SEQUENCE = 2_147_483_647 as const;

const MAX_OBSERVED_BASIS_POINTS = 10_000_000;
const MAX_AVAILABLE_CHASE_COUNT = 10_000;
const safeIntegerSchema = z.number().int().safe();
const basisPointsSchema = z.number().int().min(0).max(10_000);

export function parseRepackHeatTimestampMillis(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

export const repackHeatTimestampSchema = z
  .string()
  .refine((value) => parseRepackHeatTimestampMillis(value) !== null, {
    message: "repack_heat.timestamp_not_canonical",
  });

export const repackHeatAggregationVersionSchema = z.literal(
  REPACK_HEAT_AGGREGATION_VERSION,
);
export const repackHeatPolicyVersionSchema = z.literal(
  REPACK_HEAT_POLICY_VERSION,
);
export const repackHeatScenarioVersionSchema = z.literal(
  REPACK_HEAT_SCENARIO_VERSION,
);

export const repackHeatStateSchema = z.enum([
  "hot",
  "warm",
  "normal",
  "cold",
  "insufficient_data",
]);

export const repackHeatComponentUnavailableReasonSchema = z.enum([
  "CURRENT_SAMPLE_INSUFFICIENT",
  "BASELINE_SAMPLE_INSUFFICIENT",
  "BASELINE_UNAVAILABLE",
  "EVIDENCE_INCOMPLETE",
  "METRIC_UNSUPPORTED",
]);

const unavailableComponentSchema = z
  .object({
    status: z.literal("unavailable"),
    reason: repackHeatComponentUnavailableReasonSchema,
  })
  .strict();

export const repackHeatActivityComponentSchema = z.union([
  z
    .object({
      status: z.literal("available"),
      currentPullCount: nonNegativeIntegerSchema.max(
        REPACK_HEAT_MAXIMUM_OBSERVATIONS,
      ),
      baselinePullCount: nonNegativeIntegerSchema.max(
        REPACK_HEAT_MAXIMUM_OBSERVATIONS,
      ),
      relativeRateDeltaBasisPoints: safeIntegerSchema,
    })
    .strict(),
  unavailableComponentSchema,
]);

export const repackHeatObservedReturnComponentSchema = z.union([
  z
    .object({
      status: z.literal("available"),
      currentReturnBasisPoints: nonNegativeIntegerSchema.max(
        MAX_OBSERVED_BASIS_POINTS,
      ),
      baselineReturnBasisPoints: nonNegativeIntegerSchema.max(
        MAX_OBSERVED_BASIS_POINTS,
      ),
      rateDeltaBasisPoints: safeIntegerSchema,
    })
    .strict()
    .refine(
      ({ currentReturnBasisPoints, baselineReturnBasisPoints, rateDeltaBasisPoints }) =>
        rateDeltaBasisPoints ===
          currentReturnBasisPoints - baselineReturnBasisPoints,
      {
        path: ["rateDeltaBasisPoints"],
        message: "repack_heat.observed_return_delta_mismatch",
      },
    ),
  unavailableComponentSchema,
]);

export const repackHeatLargeHitFrequencyComponentSchema = z.union([
  z
    .object({
      status: z.literal("available"),
      currentHitCount: nonNegativeIntegerSchema.max(
        REPACK_HEAT_MAXIMUM_OBSERVATIONS,
      ),
      baselineHitCount: nonNegativeIntegerSchema.max(
        REPACK_HEAT_MAXIMUM_OBSERVATIONS,
      ),
      currentRateBasisPoints: basisPointsSchema,
      baselineRateBasisPoints: basisPointsSchema,
      rateDeltaBasisPoints: safeIntegerSchema,
      thresholdMultipleBasisPoints: z.literal(
        REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
      ),
    })
    .strict()
    .refine(
      ({ currentRateBasisPoints, baselineRateBasisPoints, rateDeltaBasisPoints }) =>
        rateDeltaBasisPoints === currentRateBasisPoints - baselineRateBasisPoints,
      {
        path: ["rateDeltaBasisPoints"],
        message: "repack_heat.large_hit_delta_mismatch",
      },
    ),
  unavailableComponentSchema,
]);

export const repackHeatChaseAvailabilityComponentSchema = z.union([
  z
    .object({
      status: z.literal("available"),
      currentAvailableChaseCount: nonNegativeIntegerSchema.max(
        MAX_AVAILABLE_CHASE_COUNT,
      ),
      baselineAvailableChaseCount: nonNegativeIntegerSchema.max(
        MAX_AVAILABLE_CHASE_COUNT,
      ),
      change: z.enum(["restocked", "depleted", "unchanged"]),
    })
    .strict()
    .refine(
      ({ currentAvailableChaseCount, baselineAvailableChaseCount, change }) =>
        (change === "restocked" &&
          currentAvailableChaseCount > baselineAvailableChaseCount) ||
        (change === "depleted" &&
          currentAvailableChaseCount < baselineAvailableChaseCount) ||
        (change === "unchanged" &&
          currentAvailableChaseCount === baselineAvailableChaseCount),
      { path: ["change"], message: "repack_heat.chase_change_mismatch" },
    ),
  unavailableComponentSchema,
]);

export const repackHeatPoolCompositionComponentSchema = z.union([
  z
    .object({
      status: z.literal("available"),
      addedOutcomeCount: nonNegativeIntegerSchema.max(
        REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT,
      ),
      removedOutcomeCount: nonNegativeIntegerSchema.max(
        REPACK_HEAT_MAXIMUM_CATALOG_OUTCOME_KEYS_PER_SNAPSHOT,
      ),
      changeMagnitudeBasisPoints: basisPointsSchema,
      changed: z.boolean(),
    })
    .strict()
    .refine(
      ({ addedOutcomeCount, removedOutcomeCount, changeMagnitudeBasisPoints, changed }) =>
        changed ===
          (addedOutcomeCount > 0 ||
            removedOutcomeCount > 0 ||
            changeMagnitudeBasisPoints > 0),
      { path: ["changed"], message: "repack_heat.pool_change_mismatch" },
    ),
  unavailableComponentSchema,
]);

export const repackHeatComponentsSchema = z
  .object({
    activity: repackHeatActivityComponentSchema,
    observedReturn: repackHeatObservedReturnComponentSchema,
    largeHitFrequency: repackHeatLargeHitFrequencyComponentSchema,
    chaseAvailability: repackHeatChaseAvailabilityComponentSchema,
    poolComposition: repackHeatPoolCompositionComponentSchema,
  })
  .strict();

export const repackHeatProvenanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observed"),
      aggregationVersion: repackHeatAggregationVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("simulated"),
      aggregationVersion: repackHeatAggregationVersionSchema,
      scenarioVersion: repackHeatScenarioVersionSchema,
    })
    .strict(),
]);

export const repackHeatWindowSchema = z
  .object({
    startedAt: repackHeatTimestampSchema,
    endedAt: repackHeatTimestampSchema,
    pullCount: nonNegativeIntegerSchema.max(REPACK_HEAT_MAXIMUM_OBSERVATIONS),
  })
  .strict()
  .superRefine(({ startedAt, endedAt }, context) => {
    const duration = Date.parse(endedAt) - Date.parse(startedAt);
    if (
      duration < REPACK_HEAT_MINIMUM_WINDOW_MILLISECONDS ||
      duration > REPACK_HEAT_MAXIMUM_WINDOW_MILLISECONDS
    ) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "repack_heat.window_invalid",
      });
    }
  });

export const repackHeatSampleRequirementsSchema = z
  .object({
    minimumCurrentPullCount: z.literal(REPACK_HEAT_MINIMUM_CURRENT_PULLS),
    minimumBaselinePullCount: z.literal(REPACK_HEAT_MINIMUM_BASELINE_PULLS),
  })
  .strict();

export const repackHeatSignalConfidenceSchema = z
  .object({
    scoreBasisPoints: basisPointsSchema,
    band: z.enum(["low", "medium", "high"]),
  })
  .strict()
  .refine(
    ({ scoreBasisPoints, band }) =>
      (band === "low" && scoreBasisPoints <= 4_999) ||
      (band === "medium" &&
        scoreBasisPoints >= 5_000 &&
        scoreBasisPoints <= 7_999) ||
      (band === "high" && scoreBasisPoints >= 8_000),
    { path: ["band"], message: "repack_heat.confidence_band_mismatch" },
  );

export const repackHeatLimitationCodeSchema = z.enum([
  "current_sample_below_minimum",
  "baseline_sample_below_minimum",
  "partial_source_coverage",
  "return_data_incomplete",
  "large_hit_data_incomplete",
  "chase_inventory_incomplete",
  "pool_composition_incomplete",
  "simulated_data",
]);

export const REPACK_HEAT_DRIVER_CODES = Object.freeze([
  "activity",
  "chase_availability",
  "large_hit_frequency",
  "observed_return",
  "pool_composition",
] as const);

export const repackHeatDriverCodeSchema = z.enum(REPACK_HEAT_DRIVER_CODES);
export const repackHeatDriverSchema = z
  .object({
    code: repackHeatDriverCodeSchema,
    contributionBasisPoints: z.number().int().min(-2_800).max(2_800),
  })
  .strict();

export const repackHeatDriversSchema = z
  .array(repackHeatDriverSchema)
  .length(REPACK_HEAT_DRIVER_CODES.length)
  .refine(
    (drivers) =>
      drivers.every(
        ({ code }, index) => code === REPACK_HEAT_DRIVER_CODES[index],
      ),
    { message: "repack_heat.drivers_not_canonical" },
  );

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function unavailableForEvidence(
  component: { status: string; reason?: string },
): boolean {
  return component.status === "unavailable" &&
    (component.reason === "EVIDENCE_INCOMPLETE" ||
      component.reason === "METRIC_UNSUPPORTED");
}

function unavailableForCatalog(
  component: { status: string; reason?: string },
): boolean {
  return component.status === "unavailable" &&
    (component.reason === "BASELINE_UNAVAILABLE" ||
      component.reason === "EVIDENCE_INCOMPLETE" ||
      component.reason === "METRIC_UNSUPPORTED");
}

export interface RepackHeatV1PolicyInput {
  readonly currentPullCount: number;
  readonly baselinePullCount: number;
  readonly components: RepackHeatComponents;
  readonly sourceCoverage: "complete" | "partial";
  readonly provenanceKind: "observed" | "simulated";
}

export function deriveRepackHeatV1Policy(input: RepackHeatV1PolicyInput) {
  const activity = input.components.activity.status === "available"
    ? Math.round(
        2_800 *
          clamp(
            input.components.activity.relativeRateDeltaBasisPoints / 20_000,
            -1,
            1,
          ),
      )
    : 0;
  const chaseAvailability = input.components.chaseAvailability.status !==
      "available"
    ? 0
    : input.components.chaseAvailability.change === "restocked"
      ? 500
      : input.components.chaseAvailability.change === "depleted"
        ? -500
        : 0;
  const largeHitFrequency = input.components.largeHitFrequency.status ===
      "available"
    ? Math.round(
        700 *
          clamp(
            input.components.largeHitFrequency.rateDeltaBasisPoints / 1_000,
            -1,
            1,
          ),
      )
    : 0;
  const observedReturn = input.components.observedReturn.status === "available"
    ? Math.round(
        900 *
          clamp(
            input.components.observedReturn.rateDeltaBasisPoints / 5_000,
            -1,
            1,
          ),
      )
    : 0;
  const poolComposition = input.components.poolComposition.status === "available"
    ? Math.round(
        200 *
          (input.components.poolComposition.changeMagnitudeBasisPoints / 10_000),
      )
    : 0;
  const drivers = [
    { code: "activity" as const, contributionBasisPoints: activity },
    {
      code: "chase_availability" as const,
      contributionBasisPoints: chaseAvailability,
    },
    {
      code: "large_hit_frequency" as const,
      contributionBasisPoints: largeHitFrequency,
    },
    {
      code: "observed_return" as const,
      contributionBasisPoints: observedReturn,
    },
    {
      code: "pool_composition" as const,
      contributionBasisPoints: poolComposition,
    },
  ];

  const belowCurrent =
    input.currentPullCount < REPACK_HEAT_MINIMUM_CURRENT_PULLS;
  const belowBaseline =
    input.baselinePullCount < REPACK_HEAT_MINIMUM_BASELINE_PULLS;
  const limitationCodes = new Set<RepackHeatLimitationCode>();
  if (belowCurrent) limitationCodes.add("current_sample_below_minimum");
  if (belowBaseline) limitationCodes.add("baseline_sample_below_minimum");
  if (input.sourceCoverage === "partial") {
    limitationCodes.add("partial_source_coverage");
  }
  if (unavailableForEvidence(input.components.observedReturn)) {
    limitationCodes.add("return_data_incomplete");
  }
  if (unavailableForEvidence(input.components.largeHitFrequency)) {
    limitationCodes.add("large_hit_data_incomplete");
  }
  if (unavailableForCatalog(input.components.chaseAvailability)) {
    limitationCodes.add("chase_inventory_incomplete");
  }
  if (unavailableForCatalog(input.components.poolComposition)) {
    limitationCodes.add("pool_composition_incomplete");
  }
  if (input.provenanceKind === "simulated") {
    limitationCodes.add("simulated_data");
  }

  const enoughData = !belowCurrent && !belowBaseline;
  const scoreBasisPoints = enoughData
    ? clamp(
        5_000 +
          drivers.reduce(
            (sum, { contributionBasisPoints }) =>
              sum + contributionBasisPoints,
            0,
          ),
        0,
        10_000,
      )
    : null;
  const state = scoreBasisPoints === null
    ? "insufficient_data" as const
    : scoreBasisPoints >= 8_000
      ? "hot" as const
      : scoreBasisPoints >= 6_500
        ? "warm" as const
        : scoreBasisPoints >= 3_000
          ? "normal" as const
          : "cold" as const;

  const rawConfidence = Math.round(
    3_000 * Math.min(1, input.currentPullCount / 20) +
      3_000 * Math.min(1, input.baselinePullCount / 200) +
      (input.components.observedReturn.status === "available" ? 1_000 : 0) +
      (input.components.largeHitFrequency.status === "available" ? 1_000 : 0) +
      (input.components.chaseAvailability.status === "available" ? 1_000 : 0) +
      (input.components.poolComposition.status === "available" ? 1_000 : 0),
  );
  const confidenceScore = input.sourceCoverage === "partial"
    ? Math.min(
        rawConfidence,
        REPACK_HEAT_PARTIAL_COVERAGE_CONFIDENCE_CAP_BASIS_POINTS,
      )
    : rawConfidence;
  const signalConfidence = !enoughData
    ? null
    : {
        scoreBasisPoints: confidenceScore,
        band: confidenceScore >= 8_000
          ? "high" as const
          : confidenceScore >= 5_000
            ? "medium" as const
            : "low" as const,
      };

  return {
    drivers,
    limitationCodes: [...limitationCodes].sort() as RepackHeatLimitationCode[],
    state,
    scoreBasisPoints,
    signalConfidence,
  };
}

const repackHeatCommonShape = {
  publicRepackId: publicRepackIdSchema,
  provenance: repackHeatProvenanceSchema,
  sourceCoverage: z.enum(["complete", "partial"]),
  currentWindow: repackHeatWindowSchema,
  baselineWindow: repackHeatWindowSchema,
  sampleRequirements: repackHeatSampleRequirementsSchema,
  components: repackHeatComponentsSchema,
  drivers: repackHeatDriversSchema,
  limitationCodes: canonicalArraySchema(repackHeatLimitationCodeSchema, 16),
  heatPolicyVersion: repackHeatPolicyVersionSchema,
  calculatedAt: repackHeatTimestampSchema,
  expiresAt: repackHeatTimestampSchema,
} as const;

const scoredRepackHeatSignalSchema = z
  .object({
    ...repackHeatCommonShape,
    state: z.enum(["hot", "warm", "normal", "cold"]),
    scoreBasisPoints: basisPointsSchema,
    signalConfidence: repackHeatSignalConfidenceSchema,
  })
  .strict();

const insufficientRepackHeatSignalSchema = z
  .object({
    ...repackHeatCommonShape,
    state: z.literal("insufficient_data"),
    scoreBasisPoints: z.null(),
    signalConfidence: z.null(),
  })
  .strict();

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const publicRepackHeatSignalSchema = z
  .union([scoredRepackHeatSignalSchema, insufficientRepackHeatSignalSchema])
  .superRefine((signal, context) => {
    const baselineEnd = Date.parse(signal.baselineWindow.endedAt);
    const currentStart = Date.parse(signal.currentWindow.startedAt);
    const currentEnd = Date.parse(signal.currentWindow.endedAt);
    const calculatedAt = Date.parse(signal.calculatedAt);
    const expiresAt = Date.parse(signal.expiresAt);
    if (
      baselineEnd > currentStart ||
      currentEnd > calculatedAt ||
      calculatedAt - currentEnd >
        REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS ||
      calculatedAt >= expiresAt ||
      expiresAt - calculatedAt > REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS ||
      signal.currentWindow.pullCount + signal.baselineWindow.pullCount >
        REPACK_HEAT_MAXIMUM_OBSERVATIONS
    ) {
      context.addIssue({
        code: "custom",
        path: ["currentWindow"],
        message: "repack_heat.timeline_invalid",
      });
    }

    if (signal.components.activity.status === "available") {
      const currentDuration = currentEnd - Date.parse(signal.currentWindow.startedAt);
      const baselineDuration =
        baselineEnd - Date.parse(signal.baselineWindow.startedAt);
      const expectedRateDelta = Math.round(
        ((signal.currentWindow.pullCount * baselineDuration) /
            (signal.baselineWindow.pullCount * currentDuration) -
          1) *
          10_000,
      );
      if (
        signal.components.activity.currentPullCount !==
          signal.currentWindow.pullCount ||
        signal.components.activity.baselinePullCount !==
          signal.baselineWindow.pullCount ||
        signal.components.activity.baselinePullCount === 0 ||
        !Number.isSafeInteger(expectedRateDelta) ||
        signal.components.activity.relativeRateDeltaBasisPoints !==
          expectedRateDelta
      ) {
        context.addIssue({
          code: "custom",
          path: ["components", "activity"],
          message: "repack_heat.activity_count_mismatch",
        });
      }
    }

    if (
      signal.components.largeHitFrequency.status === "available" &&
      (signal.components.largeHitFrequency.currentHitCount >
        signal.currentWindow.pullCount ||
        signal.components.largeHitFrequency.baselineHitCount >
          signal.baselineWindow.pullCount ||
        signal.currentWindow.pullCount === 0 ||
        signal.baselineWindow.pullCount === 0 ||
        signal.components.largeHitFrequency.currentRateBasisPoints !==
          Math.round(
            (signal.components.largeHitFrequency.currentHitCount * 10_000) /
              signal.currentWindow.pullCount,
          ) ||
        signal.components.largeHitFrequency.baselineRateBasisPoints !==
          Math.round(
            (signal.components.largeHitFrequency.baselineHitCount * 10_000) /
              signal.baselineWindow.pullCount,
          ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["components", "largeHitFrequency"],
        message: "repack_heat.large_hit_count_invalid",
      });
    }

    const belowCurrent =
      signal.currentWindow.pullCount < REPACK_HEAT_MINIMUM_CURRENT_PULLS;
    const belowBaseline =
      signal.baselineWindow.pullCount < REPACK_HEAT_MINIMUM_BASELINE_PULLS;
    const expectedSampleReason = belowCurrent
      ? "CURRENT_SAMPLE_INSUFFICIENT"
      : belowBaseline
        ? "BASELINE_SAMPLE_INSUFFICIENT"
        : null;
    if (
      expectedSampleReason === null &&
      signal.components.activity.status !== "available"
    ) {
      context.addIssue({
        code: "custom",
        path: ["components", "activity"],
        message: "repack_heat.activity_required",
      });
    }
    for (const component of [
      signal.components.activity,
      signal.components.observedReturn,
      signal.components.largeHitFrequency,
    ]) {
      const hasSampleReason =
        component.status === "unavailable" &&
        (component.reason === "CURRENT_SAMPLE_INSUFFICIENT" ||
          component.reason === "BASELINE_SAMPLE_INSUFFICIENT");
      if (
        (expectedSampleReason !== null &&
          (component.status !== "unavailable" ||
            component.reason !== expectedSampleReason)) ||
        (expectedSampleReason === null && hasSampleReason)
      ) {
        context.addIssue({
          code: "custom",
          path: ["components"],
          message: "repack_heat.component_sample_mismatch",
        });
        break;
      }
    }

    const expected = deriveRepackHeatV1Policy({
      currentPullCount: signal.currentWindow.pullCount,
      baselinePullCount: signal.baselineWindow.pullCount,
      components: signal.components,
      sourceCoverage: signal.sourceCoverage,
      provenanceKind: signal.provenance.kind,
    });
    if (!sameCanonicalValue(signal.drivers, expected.drivers)) {
      context.addIssue({
        code: "custom",
        path: ["drivers"],
        message: "repack_heat.drivers_mismatch",
      });
    }
    if (!sameCanonicalValue(signal.limitationCodes, expected.limitationCodes)) {
      context.addIssue({
        code: "custom",
        path: ["limitationCodes"],
        message: "repack_heat.limitations_mismatch",
      });
    }
    if (
      signal.state !== expected.state ||
      signal.scoreBasisPoints !== expected.scoreBasisPoints
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "repack_heat.score_state_mismatch",
      });
    }
    if (!sameCanonicalValue(signal.signalConfidence, expected.signalConfidence)) {
      context.addIssue({
        code: "custom",
        path: ["signalConfidence"],
        message: "repack_heat.confidence_mismatch",
      });
    }
  });

export const publicRepackHeatSchema = z.union([
  z
    .object({
      status: z.literal("current"),
      signal: publicRepackHeatSignalSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("expired"),
      signal: z.null(),
      lastCalculatedAt: repackHeatTimestampSchema,
      expiredAt: repackHeatTimestampSchema,
    })
    .strict()
    .refine(
      ({ lastCalculatedAt, expiredAt }) => {
        const ttl = Date.parse(expiredAt) - Date.parse(lastCalculatedAt);
        return ttl > 0 && ttl <= REPACK_HEAT_MAXIMUM_TTL_MILLISECONDS;
      },
      { path: ["expiredAt"], message: "repack_heat.expiry_invalid" },
    ),
  z
    .object({
      status: z.literal("unavailable"),
      signal: z.null(),
      reason: z.enum(["NOT_PUBLISHED", "RELEASE_MISMATCH"]),
    })
    .strict(),
]);

export function unavailableRepackHeat(
  reason: "NOT_PUBLISHED" | "RELEASE_MISMATCH" = "NOT_PUBLISHED",
): PublicRepackHeat {
  return Object.freeze({ status: "unavailable", signal: null, reason });
}

export type RepackHeatState = z.infer<typeof repackHeatStateSchema>;
export type RepackHeatComponentUnavailableReason = z.infer<
  typeof repackHeatComponentUnavailableReasonSchema
>;
export type RepackHeatComponents = z.infer<typeof repackHeatComponentsSchema>;
export type RepackHeatActivityComponent = z.infer<
  typeof repackHeatActivityComponentSchema
>;
export type RepackHeatObservedReturnComponent = z.infer<
  typeof repackHeatObservedReturnComponentSchema
>;
export type RepackHeatLargeHitFrequencyComponent = z.infer<
  typeof repackHeatLargeHitFrequencyComponentSchema
>;
export type RepackHeatChaseAvailabilityComponent = z.infer<
  typeof repackHeatChaseAvailabilityComponentSchema
>;
export type RepackHeatPoolCompositionComponent = z.infer<
  typeof repackHeatPoolCompositionComponentSchema
>;
export type RepackHeatProvenance = z.infer<typeof repackHeatProvenanceSchema>;
export type RepackHeatWindow = z.infer<typeof repackHeatWindowSchema>;
export type RepackHeatSignalConfidence = z.infer<
  typeof repackHeatSignalConfidenceSchema
>;
export type RepackHeatLimitationCode = z.infer<
  typeof repackHeatLimitationCodeSchema
>;
export type RepackHeatDriverCode = z.infer<typeof repackHeatDriverCodeSchema>;
export type RepackHeatDriver = z.infer<typeof repackHeatDriverSchema>;
export type RepackHeatPolicyVersion = z.infer<
  typeof repackHeatPolicyVersionSchema
>;
export type PublicRepackHeatSignal = z.infer<
  typeof publicRepackHeatSignalSchema
>;
export type PublicRepackHeat = z.infer<typeof publicRepackHeatSchema>;
