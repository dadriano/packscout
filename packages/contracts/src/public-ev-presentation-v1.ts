import { z } from "zod";
import {
  packScoutBuybackEvConfidencePolicyVersionV1Schema,
  packScoutBuybackEvDataAsOfV1Schema,
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvTimestampV1Schema,
  parsePackScoutBuybackEvTimestampMillisV1,
} from "./buyback-adjusted-ev-v1-common.ts";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
} from "./buyback-adjusted-ev-v1-result.ts";
import {
  packScoutPublicEvMetricsV3Schema,
  packScoutPublicEvV3Schema,
} from "./data-release-v3-ev-estimates.ts";

export const PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1 =
  "packscout-public-ev-confidence-decay-v1" as const;
export const packScoutPublicEvConfidenceDecayPolicyVersionV1Schema = z.literal(
  PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
);

export const publicEvPresentationResponseContextV1Schema = z
  .object({
    publicFreshnessPolicyVersion:
      packScoutPublicEvConfidenceDecayPolicyVersionV1Schema,
    confidenceEvaluatedAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict();

export type PublicEvPresentationResponseContextV1 = z.infer<
  typeof publicEvPresentationResponseContextV1Schema
>;

/**
 * Provider health may use a newer trusted server clock than cursor-pinned EV
 * confidence. Keeping the clocks distinct prevents a later-page reload from
 * extending an already-running provider freshness window.
 */
export const publicProviderHealthResponseContextV1Schema = z
  .object({
    providerHealthEvaluatedAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict();

export type PublicProviderHealthResponseContextV1 = z.infer<
  typeof publicProviderHealthResponseContextV1Schema
>;

export const PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1 =
  60 * 60_000;
export const PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_TIME_CONSTANT_MILLISECONDS_V1 =
  24 * 60 * 60_000;

export const PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1 =
  Object.freeze([
    "closed_range_midpoint",
    "platform_published_odds",
    "source_age_over_15_through_30_minutes",
    "source_age_over_30_through_60_minutes",
    "source_age_over_60_minutes",
  ] as const);

export type PackScoutPublicEvPresentationLimitationCodeV1 =
  (typeof PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1)[number];

export const packScoutPublicEvPresentationLimitationCodeV1Schema = z.enum(
  PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1,
);

const confidenceBandV1Schema = z.enum(["low", "medium", "high"]);

function confidenceBandV1(
  scoreBasisPoints: number,
): z.infer<typeof confidenceBandV1Schema> {
  if (scoreBasisPoints <= 4_999) return "low";
  if (scoreBasisPoints <= 7_999) return "medium";
  return "high";
}

function limitationsAreCanonicalV1(
  codes: readonly PackScoutPublicEvPresentationLimitationCodeV1[],
): boolean {
  return codes.every(
    (code, index) =>
      index === 0 ||
      PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1.indexOf(
        codes[index - 1]!,
      ) < PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1.indexOf(code),
  );
}

export const packScoutPublicEvPresentationConfidenceV1Schema = z
  .object({
    scoreBasisPoints: z.number().int().min(0).max(10_000),
    band: confidenceBandV1Schema,
    limitationCodes: z
      .array(packScoutPublicEvPresentationLimitationCodeV1Schema)
      .max(PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1.length)
      .refine(limitationsAreCanonicalV1, {
        message: "public_ev_presentation.limitations_not_canonical",
      }),
  })
  .strict()
  .superRefine((confidence, context) => {
    if (confidence.band !== confidenceBandV1(confidence.scoreBasisPoints)) {
      context.addIssue({
        code: "custom",
        path: ["band"],
        message: "public_ev_presentation.confidence_band_mismatch",
      });
    }
    const ageLimitations = confidence.limitationCodes.filter((code) =>
      code.startsWith("source_age_"),
    );
    if (ageLimitations.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["limitationCodes"],
        message: "public_ev_presentation.source_age_limitations_conflict",
      });
    }
  });

export const PACKSCOUT_PUBLIC_EV_PRESENTATION_SOURCE_AGE_STATES_V1 =
  Object.freeze([
    "fresh_within_15_minutes",
    "delayed_over_15_through_30_minutes",
    "delayed_over_30_through_60_minutes",
    "last_known_over_60_minutes",
  ] as const);

export type PackScoutPublicEvPresentationSourceAgeStateV1 =
  (typeof PACKSCOUT_PUBLIC_EV_PRESENTATION_SOURCE_AGE_STATES_V1)[number];

export const packScoutPublicEvPresentationSourceAgeV1Schema = z
  .object({
    milliseconds: z.number().int().safe().min(0),
    state: z.enum(PACKSCOUT_PUBLIC_EV_PRESENTATION_SOURCE_AGE_STATES_V1),
  })
  .strict();

const knownDataAsOfV1Schema = z
  .object({
    state: z.literal("known"),
    observedAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict();

const knownPresentationShapeV1 = {
  methodVersion: packScoutBuybackEvMethodVersionV1Schema,
  confidencePolicyVersion: packScoutBuybackEvConfidencePolicyVersionV1Schema,
  publicFreshnessPolicyVersion:
    packScoutPublicEvConfidenceDecayPolicyVersionV1Schema,
  metrics: packScoutPublicEvMetricsV3Schema,
  confidence: packScoutPublicEvPresentationConfidenceV1Schema,
  calculatedAt: packScoutBuybackEvTimestampV1Schema,
  dataAsOf: knownDataAsOfV1Schema,
  sourceAge: packScoutPublicEvPresentationSourceAgeV1Schema,
  confidenceEvaluatedAt: packScoutBuybackEvTimestampV1Schema,
} as const;

type KnownPresentationV1 = z.infer<
  z.ZodObject<typeof knownPresentationShapeV1>
> & {
  readonly status: "current" | "last_known" | "historical";
};

const staticPenaltyByLimitationV1 = Object.freeze({
  closed_range_midpoint:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.closedRangeMidpoint,
  platform_published_odds:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.platformPublishedOdds,
} as const);

function expectedSourceAgeStateV1(
  sourceAgeMilliseconds: number,
): PackScoutPublicEvPresentationSourceAgeStateV1 {
  if (sourceAgeMilliseconds > PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1) {
    return "last_known_over_60_minutes";
  }
  if (sourceAgeMilliseconds > 30 * 60_000) {
    return "delayed_over_30_through_60_minutes";
  }
  if (sourceAgeMilliseconds > 15 * 60_000) {
    return "delayed_over_15_through_30_minutes";
  }
  return "fresh_within_15_minutes";
}

function expectedSourceAgeLimitationV1(
  sourceAgeMilliseconds: number,
): PackScoutPublicEvPresentationLimitationCodeV1 | null {
  if (sourceAgeMilliseconds > PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1) {
    return "source_age_over_60_minutes";
  }
  if (sourceAgeMilliseconds > 30 * 60_000) {
    return "source_age_over_30_through_60_minutes";
  }
  if (sourceAgeMilliseconds > 15 * 60_000) {
    return "source_age_over_15_through_30_minutes";
  }
  return null;
}

function staticPenaltyV1(
  limitations: readonly PackScoutPublicEvPresentationLimitationCodeV1[],
): number {
  return limitations.reduce((total, limitation) => {
    if (limitation === "closed_range_midpoint") {
      return total + staticPenaltyByLimitationV1.closed_range_midpoint;
    }
    if (limitation === "platform_published_odds") {
      return total + staticPenaltyByLimitationV1.platform_published_odds;
    }
    return total;
  }, 0);
}

function roundHalfUpPositiveRationalV1(
  numerator: bigint,
  denominator: bigint,
): number {
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

function expectedConfidenceScoreV1(
  sourceAgeMilliseconds: number,
  limitations: readonly PackScoutPublicEvPresentationLimitationCodeV1[],
): number {
  const staticPenalty = staticPenaltyV1(limitations);
  if (sourceAgeMilliseconds <= 15 * 60_000) {
    return Math.max(0, 10_000 - staticPenalty);
  }
  if (sourceAgeMilliseconds <= 30 * 60_000) {
    return Math.max(0, 9_000 - staticPenalty);
  }
  const scoreAt60Minutes = Math.max(0, 7_500 - staticPenalty);
  if (sourceAgeMilliseconds <= PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1) {
    return scoreAt60Minutes;
  }
  const deltaMilliseconds =
    sourceAgeMilliseconds - PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1;
  const timeConstant =
    PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_TIME_CONSTANT_MILLISECONDS_V1;
  return roundHalfUpPositiveRationalV1(
    BigInt(scoreAt60Minutes) * BigInt(timeConstant),
    BigInt(timeConstant + deltaMilliseconds),
  );
}

function expectedLimitationsV1(
  sourceAgeMilliseconds: number,
  staticLimitations: readonly PackScoutPublicEvPresentationLimitationCodeV1[],
): readonly PackScoutPublicEvPresentationLimitationCodeV1[] {
  const expected = new Set<PackScoutPublicEvPresentationLimitationCodeV1>(
    staticLimitations.filter(
      (code) =>
        code === "closed_range_midpoint" ||
        code === "platform_published_odds",
    ),
  );
  const sourceAgeLimitation = expectedSourceAgeLimitationV1(
    sourceAgeMilliseconds,
  );
  if (sourceAgeLimitation !== null) expected.add(sourceAgeLimitation);
  return PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1.filter((code) =>
    expected.has(code),
  );
}

function validateKnownPresentationV1(
  presentation: KnownPresentationV1,
  context: z.RefinementCtx,
): void {
  const observedAt = Date.parse(presentation.dataAsOf.observedAt);
  const calculatedAt = Date.parse(presentation.calculatedAt);
  const evaluatedAt = Date.parse(presentation.confidenceEvaluatedAt);
  const sourceAgeMilliseconds = evaluatedAt - observedAt;
  if (
    observedAt > calculatedAt ||
    calculatedAt > evaluatedAt ||
    !Number.isSafeInteger(sourceAgeMilliseconds) ||
    sourceAgeMilliseconds < 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["confidenceEvaluatedAt"],
      message: "public_ev_presentation.clock_order_invalid",
    });
    return;
  }

  const expectedStatus =
    presentation.status === "historical"
      ? "historical"
      : sourceAgeMilliseconds <=
          PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1
        ? "current"
        : "last_known";
  if (presentation.status !== expectedStatus) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "public_ev_presentation.status_age_mismatch",
    });
  }
  if (
    presentation.sourceAge.milliseconds !== sourceAgeMilliseconds ||
    presentation.sourceAge.state !==
      expectedSourceAgeStateV1(sourceAgeMilliseconds)
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceAge"],
      message: "public_ev_presentation.source_age_mismatch",
    });
  }

  const expectedLimitations = expectedLimitationsV1(
    sourceAgeMilliseconds,
    presentation.confidence.limitationCodes,
  );
  if (
    expectedLimitations.length !==
      presentation.confidence.limitationCodes.length ||
    expectedLimitations.some(
      (code, index) =>
        code !== presentation.confidence.limitationCodes[index],
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["confidence", "limitationCodes"],
      message: "public_ev_presentation.source_age_limitation_mismatch",
    });
  }
  const expectedScore = expectedConfidenceScoreV1(
    sourceAgeMilliseconds,
    presentation.confidence.limitationCodes,
  );
  if (presentation.confidence.scoreBasisPoints !== expectedScore) {
    context.addIssue({
      code: "custom",
      path: ["confidence", "scoreBasisPoints"],
      message: "public_ev_presentation.confidence_score_mismatch",
    });
  }
}

const currentPresentationV1Schema = z
  .object({ status: z.literal("current"), ...knownPresentationShapeV1 })
  .strict()
  .superRefine(validateKnownPresentationV1);

const lastKnownPresentationV1Schema = z
  .object({ status: z.literal("last_known"), ...knownPresentationShapeV1 })
  .strict()
  .superRefine(validateKnownPresentationV1);

const historicalPresentationV1Schema = z
  .object({
    status: z.literal("historical"),
    ...knownPresentationShapeV1,
    soldOutAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict()
  .superRefine((presentation, context) => {
    validateKnownPresentationV1(presentation, context);
    if (presentation.confidenceEvaluatedAt !== presentation.soldOutAt) {
      context.addIssue({
        code: "custom",
        path: ["confidenceEvaluatedAt"],
        message: "public_ev_presentation.historical_not_frozen_at_sellout",
      });
    }
  });

const unavailablePresentationV1Schema = z
  .object({
    status: z.literal("unavailable"),
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion:
      packScoutBuybackEvConfidencePolicyVersionV1Schema,
    publicFreshnessPolicyVersion:
      packScoutPublicEvConfidenceDecayPolicyVersionV1Schema,
    metrics: z.null(),
    confidence: z.null(),
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: packScoutBuybackEvDataAsOfV1Schema,
    confidenceEvaluatedAt: packScoutBuybackEvTimestampV1Schema,
    reason: packScoutBuybackEvPublicReasonCodeV1Schema,
  })
  .strict()
  .superRefine((presentation, context) => {
    if (Date.parse(presentation.confidenceEvaluatedAt) < Date.parse(presentation.calculatedAt)) {
      context.addIssue({
        code: "custom",
        path: ["confidenceEvaluatedAt"],
        message: "public_ev_presentation.evaluation_before_calculation",
      });
    }
    if (
      presentation.dataAsOf.state === "known" &&
      Date.parse(presentation.calculatedAt) <
        Date.parse(presentation.dataAsOf.observedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["calculatedAt"],
        message: "public_ev_presentation.calculation_before_evidence",
      });
    }
  });

/**
 * A read-time public presentation overlay. Stored `PackScoutPublicEvV3`
 * remains immutable and continues to identify the raw confidence-v1 policy;
 * this union adds an independently versioned public freshness interpretation.
 */
export const packScoutPublicEvPresentationV1Schema = z.discriminatedUnion(
  "status",
  [
    currentPresentationV1Schema,
    lastKnownPresentationV1Schema,
    historicalPresentationV1Schema,
    unavailablePresentationV1Schema,
  ],
);

export type PackScoutPublicEvPresentationV1 = z.infer<
  typeof packScoutPublicEvPresentationV1Schema
>;

export type SafePresentPackScoutPublicEvV3Failure =
  | "schema_invalid"
  | "evaluation_time_invalid"
  | "evaluation_precedes_calculation"
  | "evaluation_precedes_sellout";

export type SafePresentPackScoutPublicEvV3Result =
  | {
      readonly success: true;
      readonly presentation: PackScoutPublicEvPresentationV1;
    }
  | {
      readonly success: false;
      readonly reason: SafePresentPackScoutPublicEvV3Failure;
    };

function staticLimitationsFromRawV1(
  limitations: readonly PackScoutBuybackEvConfidenceLimitationCodeV1[],
): readonly PackScoutPublicEvPresentationLimitationCodeV1[] {
  return PACKSCOUT_PUBLIC_EV_PRESENTATION_LIMITATION_CODES_V1.filter(
    (code) =>
      (code === "closed_range_midpoint" ||
        code === "platform_published_odds") &&
      limitations.includes(code),
  );
}

function presentationConfidenceV1(
  sourceAgeMilliseconds: number,
  rawLimitations: readonly PackScoutBuybackEvConfidenceLimitationCodeV1[],
): z.infer<typeof packScoutPublicEvPresentationConfidenceV1Schema> {
  const limitations = expectedLimitationsV1(
    sourceAgeMilliseconds,
    staticLimitationsFromRawV1(rawLimitations),
  );
  const scoreBasisPoints = expectedConfidenceScoreV1(
    sourceAgeMilliseconds,
    limitations,
  );
  return {
    scoreBasisPoints,
    band: confidenceBandV1(scoreBasisPoints),
    limitationCodes: [...limitations],
  };
}

const publicEvStaticConfidencePenaltyV1Schema = z.union([
  z.literal(0),
  z.literal(
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.platformPublishedOdds,
  ),
  z.literal(PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.closedRangeMidpoint),
  z.literal(
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.platformPublishedOdds +
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.closedRangeMidpoint,
  ),
]);

export const packScoutPublicEvConfidenceEvaluationInputV1Schema = z
  .object({
    staticPenaltyBasisPoints: publicEvStaticConfidencePenaltyV1Schema,
    observedAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict();

export type PackScoutPublicEvConfidenceEvaluationV1 = Readonly<{
  status: "current" | "last_known";
  publicFreshnessPolicyVersion: typeof PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1;
  confidenceEvaluatedAt: string;
  sourceAge: z.infer<
    typeof packScoutPublicEvPresentationSourceAgeV1Schema
  >;
  confidence: z.infer<
    typeof packScoutPublicEvPresentationConfidenceV1Schema
  >;
}>;

export type SafeEvaluatePackScoutPublicConfidenceV1Result =
  | {
      readonly success: true;
      readonly evaluation: PackScoutPublicEvConfidenceEvaluationV1;
    }
  | {
      readonly success: false;
      readonly reason:
        | "schema_invalid"
        | "evaluation_time_invalid"
        | "evaluation_precedes_observation";
    };

function staticLimitationsFromPenaltyV1(
  staticPenaltyBasisPoints: z.infer<
    typeof publicEvStaticConfidencePenaltyV1Schema
  >,
): readonly PackScoutBuybackEvConfidenceLimitationCodeV1[] {
  switch (staticPenaltyBasisPoints) {
    case 0:
      return [];
    case PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.platformPublishedOdds:
      return ["platform_published_odds"];
    case PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.closedRangeMidpoint:
      return ["closed_range_midpoint"];
    default:
      return ["closed_range_midpoint", "platform_published_odds"];
  }
}

/**
 * Pure search-projection evaluator for rows that retain observation time and
 * the calculation-time static penalty but not the complete raw V3 estimate.
 */
export function safeEvaluatePackScoutPublicConfidenceV1(
  input: unknown,
  evaluationTimeIso: string,
): SafeEvaluatePackScoutPublicConfidenceV1Result {
  const parsedInput =
    packScoutPublicEvConfidenceEvaluationInputV1Schema.safeParse(input);
  if (!parsedInput.success) return { success: false, reason: "schema_invalid" };
  const evaluationMilliseconds =
    parsePackScoutBuybackEvTimestampMillisV1(evaluationTimeIso);
  if (evaluationMilliseconds === null) {
    return { success: false, reason: "evaluation_time_invalid" };
  }
  const sourceAgeMilliseconds =
    evaluationMilliseconds - Date.parse(parsedInput.data.observedAt);
  if (sourceAgeMilliseconds < 0) {
    return { success: false, reason: "evaluation_precedes_observation" };
  }
  const confidence = presentationConfidenceV1(
    sourceAgeMilliseconds,
    staticLimitationsFromPenaltyV1(parsedInput.data.staticPenaltyBasisPoints),
  );
  return {
    success: true,
    evaluation: {
      status:
        sourceAgeMilliseconds <=
        PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1
          ? "current"
          : "last_known",
      publicFreshnessPolicyVersion:
        PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
      confidenceEvaluatedAt: evaluationTimeIso,
      sourceAge: {
        milliseconds: sourceAgeMilliseconds,
        state: expectedSourceAgeStateV1(sourceAgeMilliseconds),
      },
      confidence,
    },
  };
}

/**
 * Safely derives one deterministic public presentation from an immutable V3
 * estimate and a trusted response clock. It never mutates the stored input.
 */
export function safePresentPackScoutPublicEvV3(
  input: unknown,
  evaluationTimeIso: string,
): SafePresentPackScoutPublicEvV3Result {
  const evaluationMilliseconds =
    parsePackScoutBuybackEvTimestampMillisV1(evaluationTimeIso);
  if (evaluationMilliseconds === null) {
    return { success: false, reason: "evaluation_time_invalid" };
  }
  const parsed = packScoutPublicEvV3Schema.safeParse(input);
  if (!parsed.success) return { success: false, reason: "schema_invalid" };

  const raw = parsed.data;
  if (evaluationMilliseconds < Date.parse(raw.calculatedAt)) {
    return { success: false, reason: "evaluation_precedes_calculation" };
  }
  if (
    raw.status === "sold_out_historical" &&
    evaluationMilliseconds < Date.parse(raw.soldOutAt)
  ) {
    return { success: false, reason: "evaluation_precedes_sellout" };
  }

  if (raw.status === "unavailable") {
    const presentation = packScoutPublicEvPresentationV1Schema.safeParse({
      ...raw,
      publicFreshnessPolicyVersion:
        PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
      confidenceEvaluatedAt: evaluationTimeIso,
    });
    return presentation.success
      ? { success: true, presentation: presentation.data }
      : { success: false, reason: "schema_invalid" };
  }

  const confidenceEvaluatedAt =
    raw.status === "sold_out_historical" ? raw.soldOutAt : evaluationTimeIso;
  const sourceAgeMilliseconds =
    Date.parse(confidenceEvaluatedAt) - Date.parse(raw.dataAsOf.observedAt);
  const presentation = packScoutPublicEvPresentationV1Schema.safeParse({
    status:
      raw.status === "sold_out_historical"
        ? "historical"
        : sourceAgeMilliseconds <=
            PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1
          ? "current"
          : "last_known",
    methodVersion: raw.methodVersion,
    confidencePolicyVersion: raw.confidencePolicyVersion,
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
    metrics: raw.metrics,
    confidence: presentationConfidenceV1(
      sourceAgeMilliseconds,
      raw.confidence.limitationCodes,
    ),
    calculatedAt: raw.calculatedAt,
    dataAsOf: raw.dataAsOf,
    sourceAge: {
      milliseconds: sourceAgeMilliseconds,
      state: expectedSourceAgeStateV1(sourceAgeMilliseconds),
    },
    confidenceEvaluatedAt,
    ...(raw.status === "sold_out_historical"
      ? { soldOutAt: raw.soldOutAt }
      : {}),
  });
  return presentation.success
    ? { success: true, presentation: presentation.data }
    : { success: false, reason: "schema_invalid" };
}

export const PUBLIC_PROVIDER_HEALTH_STATUS_REASONS_V1 = Object.freeze([
  "PROVIDER_HEALTH_UNAVAILABLE",
  "PROVIDER_OBSERVATION_STALE",
  "PROVIDER_PAUSED",
  "PROVIDER_UNHEALTHY",
  "PROVIDER_BEHIND",
  "RELEASE_MISMATCH",
] as const);

export const publicProviderHealthStatusReasonV1Schema = z.enum(
  PUBLIC_PROVIDER_HEALTH_STATUS_REASONS_V1,
);

const delayedProviderHealthStatusReasonV1Schema = z.enum([
  "PROVIDER_OBSERVATION_STALE",
  "PROVIDER_PAUSED",
  "PROVIDER_UNHEALTHY",
  "PROVIDER_BEHIND",
  "RELEASE_MISMATCH",
]);

/** Sanitized, informational provider health carried by dynamic public views. */
export const publicProviderHealthV1Schema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("healthy"),
      observedAt: packScoutBuybackEvTimestampV1Schema,
      statusReason: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("delayed"),
      observedAt: packScoutBuybackEvTimestampV1Schema,
      statusReason: delayedProviderHealthStatusReasonV1Schema,
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      observedAt: z.null(),
      statusReason: z.literal("PROVIDER_HEALTH_UNAVAILABLE"),
    })
    .strict(),
]);

export type PublicProviderHealthStatusReasonV1 = z.infer<
  typeof publicProviderHealthStatusReasonV1Schema
>;
export type PublicProviderHealthV1 = z.infer<
  typeof publicProviderHealthV1Schema
>;

const publicProviderHealthSummaryCountsV1 = {
  totalProviderCount: z.number().int().safe().min(0),
  delayedProviderCount: z.number().int().safe().min(0),
  nextHealthEvaluationAt: packScoutBuybackEvTimestampV1Schema.nullable(),
} as const;

function providerHealthSummaryCountsAreValidV1(summary: {
  readonly totalProviderCount: number;
  readonly delayedProviderCount: number;
}): boolean {
  return summary.delayedProviderCount <= summary.totalProviderCount;
}

function providerHealthSummaryTimesAreOrderedV1(summary: {
  readonly observedAt: string;
  readonly freshThrough: string;
}): boolean {
  return Date.parse(summary.observedAt) <= Date.parse(summary.freshThrough);
}

function providerHealthSummaryNextEvaluationIsValidV1(summary: {
  readonly observedAt: string | null;
  readonly nextHealthEvaluationAt: string | null;
  readonly totalProviderCount: number;
  readonly delayedProviderCount: number;
}): boolean {
  const hasFreshProvider =
    summary.delayedProviderCount < summary.totalProviderCount;
  if ((summary.nextHealthEvaluationAt !== null) !== hasFreshProvider) {
    return false;
  }
  return summary.nextHealthEvaluationAt === null ||
    summary.observedAt === null ||
    Date.parse(summary.observedAt) <= Date.parse(summary.nextHealthEvaluationAt);
}

/** Aggregate health freshness for shell, dashboard, and list responses. */
export const publicProviderHealthSummaryV1Schema = z.discriminatedUnion(
  "state",
  [
    z
      .object({
        state: z.literal("healthy"),
        observedAt: packScoutBuybackEvTimestampV1Schema,
        freshThrough: packScoutBuybackEvTimestampV1Schema,
        ...publicProviderHealthSummaryCountsV1,
      })
      .strict()
      .refine(
        (summary) =>
          summary.totalProviderCount > 0 &&
          summary.delayedProviderCount === 0 &&
          providerHealthSummaryTimesAreOrderedV1(summary) &&
          summary.nextHealthEvaluationAt === summary.freshThrough,
        { message: "public_provider_health_summary.healthy_invalid" },
      ),
    z
      .object({
        state: z.literal("delayed"),
        observedAt: packScoutBuybackEvTimestampV1Schema,
        freshThrough: packScoutBuybackEvTimestampV1Schema,
        ...publicProviderHealthSummaryCountsV1,
      })
      .strict()
      .refine(
        (summary) =>
          summary.totalProviderCount > 0 &&
          summary.delayedProviderCount > 0 &&
          providerHealthSummaryCountsAreValidV1(summary) &&
          providerHealthSummaryTimesAreOrderedV1(summary) &&
          providerHealthSummaryNextEvaluationIsValidV1(summary),
        { message: "public_provider_health_summary.delayed_invalid" },
      ),
    z
      .object({
        state: z.literal("unavailable"),
        observedAt: z.null(),
        freshThrough: z.null(),
        ...publicProviderHealthSummaryCountsV1,
      })
      .strict()
      .refine(
        (summary) =>
          providerHealthSummaryCountsAreValidV1(summary) &&
          providerHealthSummaryNextEvaluationIsValidV1(summary),
        {
        message: "public_provider_health_summary.unavailable_counts_invalid",
        },
      ),
  ],
);

export type PublicProviderHealthSummaryV1 = z.infer<
  typeof publicProviderHealthSummaryV1Schema
>;
