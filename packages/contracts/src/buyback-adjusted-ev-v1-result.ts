import { z } from "zod";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  packScoutBuybackEvCanonicalUsdMoneyV1Schema,
  packScoutBuybackEvConfidencePolicyVersionV1Schema,
  packScoutBuybackEvDataAsOfV1Schema,
  packScoutBuybackEvInternalReasonsV1Schema,
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  packScoutBuybackEvSchemaVersionV1Schema,
  packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema,
  packScoutBuybackEvTimestampV1Schema,
  type PackScoutBuybackEvInternalReasonCodeV1,
} from "./buyback-adjusted-ev-v1-common.ts";
import {
  packScoutBuybackEvMetricsAreConsistentV1,
  packScoutBuybackEvProtectedCalculationEvidenceV1Schema,
  packScoutBuybackEvProtectedProvenanceV1Schema,
} from "./buyback-adjusted-ev-v1-calculation.ts";

const basisPointsSchema = z.number().int().safe();
const confidenceBasisPointsSchema = z.number().int().min(0).max(10_000);

export const PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1 =
  Object.freeze([
    "closed_range_midpoint",
    "platform_published_odds",
    "source_age_over_15_through_30_minutes",
    "source_age_over_30_through_60_minutes",
  ] as const);

export type PackScoutBuybackEvConfidenceLimitationCodeV1 =
  (typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1)[number];

export const packScoutBuybackEvConfidenceLimitationCodeV1Schema = z.enum(
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
);

const confidencePenaltyByLimitation: Readonly<
  Record<PackScoutBuybackEvConfidenceLimitationCodeV1, number>
> = Object.freeze({
  closed_range_midpoint: 2_000,
  platform_published_odds: 1_500,
  source_age_over_15_through_30_minutes: 1_000,
  source_age_over_30_through_60_minutes: 2_500,
});

export const PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1 = Object.freeze({
  platformPublishedOdds: 1_500,
  closedRangeMidpoint: 2_000,
  sourceAgeOver15Through30Minutes: 1_000,
  sourceAgeOver30Through60Minutes: 2_500,
} as const);

function confidenceBand(scoreBasisPoints: number): "low" | "medium" | "high" {
  if (scoreBasisPoints <= 4_999) return "low";
  if (scoreBasisPoints <= 7_999) return "medium";
  return "high";
}

function confidenceScore(
  limitations: readonly PackScoutBuybackEvConfidenceLimitationCodeV1[],
): number {
  const deductions = limitations.reduce(
    (total, limitation) => total + confidencePenaltyByLimitation[limitation],
    0,
  );
  return Math.max(0, 10_000 - deductions);
}

export const packScoutBuybackEvConfidenceResultV1Schema = z
  .object({
    policyVersion: packScoutBuybackEvConfidencePolicyVersionV1Schema,
    scoreBasisPoints: confidenceBasisPointsSchema,
    band: z.enum(["low", "medium", "high"]),
    limitationCodes: z
      .array(packScoutBuybackEvConfidenceLimitationCodeV1Schema)
      .max(PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1.length)
      .refine(
        (codes) =>
          codes.every(
            (code, index) =>
              index === 0 ||
              PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1.indexOf(
                  codes[index - 1]!,
                ) <
                PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1.indexOf(
                  code,
                ),
          ),
        {
          message: "packscout_buyback_ev.confidence_limitations_not_canonical",
        },
      ),
  })
  .strict()
  .superRefine((confidence, context) => {
    const expectedScore = confidenceScore(confidence.limitationCodes);
    if (confidence.scoreBasisPoints !== expectedScore) {
      context.addIssue({
        code: "custom",
        path: ["scoreBasisPoints"],
        message: "packscout_buyback_ev.confidence_score_mismatch",
      });
    }
    if (confidence.band !== confidenceBand(expectedScore)) {
      context.addIssue({
        code: "custom",
        path: ["band"],
        message: "packscout_buyback_ev.confidence_band_mismatch",
      });
    }
    if (
      confidence.limitationCodes.includes(
        "source_age_over_15_through_30_minutes",
      ) &&
      confidence.limitationCodes.includes(
        "source_age_over_30_through_60_minutes",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["limitationCodes"],
        message: "packscout_buyback_ev.confidence_freshness_conflict",
      });
    }
  });

const currentFreshnessStateV1Schema = z
  .object({
    state: z.literal("current"),
    sourceAgeMilliseconds: z.number().int().min(0).max(60 * 60_000),
    expiresAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict();

const expiredFreshnessStateV1Schema = z
  .object({
    state: z.literal("expired"),
    sourceAgeMilliseconds: z.number().int().safe().min(60 * 60_000 + 1),
    expiresAt: packScoutBuybackEvTimestampV1Schema,
    reason: z.literal("STALE_EVIDENCE"),
  })
  .strict();

const unknownFreshnessStateV1Schema = z
  .object({
    state: z.literal("unknown_source_time"),
    sourceAgeMilliseconds: z.null(),
    expiresAt: z.null(),
    reason: z.literal("MISSING_SOURCE_TIME"),
  })
  .strict();

export const packScoutBuybackEvFreshnessStateV1Schema =
  z.discriminatedUnion("state", [
    currentFreshnessStateV1Schema,
    expiredFreshnessStateV1Schema,
    unknownFreshnessStateV1Schema,
  ]);

function exactExpiry(observedAt: string): string {
  return new Date(Date.parse(observedAt) + 60 * 60_000).toISOString();
}

function freshnessMatchesKnownTimes(input: {
  readonly calculatedAt: string;
  readonly observedAt: string;
  readonly freshness:
    | z.infer<typeof currentFreshnessStateV1Schema>
    | z.infer<typeof expiredFreshnessStateV1Schema>;
}): boolean {
  const sourceAgeMilliseconds =
    Date.parse(input.calculatedAt) - Date.parse(input.observedAt);
  return (
    sourceAgeMilliseconds >= 0 &&
    input.freshness.sourceAgeMilliseconds === sourceAgeMilliseconds &&
    input.freshness.expiresAt === exactExpiry(input.observedAt) &&
    (input.freshness.state === "current"
      ? sourceAgeMilliseconds <= 60 * 60_000
      : sourceAgeMilliseconds > 60 * 60_000)
  );
}

function freshnessLimitationForAge(
  sourceAgeMilliseconds: number,
): PackScoutBuybackEvConfidenceLimitationCodeV1 | null {
  if (sourceAgeMilliseconds > 30 * 60_000) {
    return "source_age_over_30_through_60_minutes";
  }
  if (sourceAgeMilliseconds > 15 * 60_000) {
    return "source_age_over_15_through_30_minutes";
  }
  return null;
}

const availableConfidenceEvaluationV1Schema = z
  .object({
    schemaVersion: packScoutBuybackEvSchemaVersionV1Schema,
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion:
      packScoutBuybackEvConfidencePolicyVersionV1Schema,
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    status: z.literal("available"),
    confidence: packScoutBuybackEvConfidenceResultV1Schema,
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: z
      .object({
        state: z.literal("known"),
        observedAt: packScoutBuybackEvTimestampV1Schema,
      })
      .strict(),
    freshness: currentFreshnessStateV1Schema,
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (
      !freshnessMatchesKnownTimes({
        calculatedAt: evaluation.calculatedAt,
        observedAt: evaluation.dataAsOf.observedAt,
        freshness: evaluation.freshness,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "packscout_buyback_ev.freshness_time_mismatch",
      });
    }
    const expectedLimitation = freshnessLimitationForAge(
      evaluation.freshness.sourceAgeMilliseconds,
    );
    const actualFreshnessLimitations =
      evaluation.confidence.limitationCodes.filter((code) =>
        code.startsWith("source_age_"),
      );
    if (
      actualFreshnessLimitations.length !==
        (expectedLimitation === null ? 0 : 1) ||
      (expectedLimitation !== null &&
        actualFreshnessLimitations[0] !== expectedLimitation)
    ) {
      context.addIssue({
        code: "custom",
        path: ["confidence", "limitationCodes"],
        message: "packscout_buyback_ev.freshness_limitation_mismatch",
      });
    }
  });

const unavailableConfidenceEvaluationV1Schema = z
  .object({
    schemaVersion: packScoutBuybackEvSchemaVersionV1Schema,
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion:
      packScoutBuybackEvConfidencePolicyVersionV1Schema,
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    status: z.literal("unavailable"),
    confidence: z.null(),
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: packScoutBuybackEvDataAsOfV1Schema,
    freshness: z.discriminatedUnion("state", [
      expiredFreshnessStateV1Schema,
      unknownFreshnessStateV1Schema,
    ]),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (
      evaluation.dataAsOf.state === "unknown_source_time" &&
      evaluation.freshness.state !== "unknown_source_time"
    ) {
      context.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "packscout_buyback_ev.unknown_freshness_mismatch",
      });
    }
    if (
      evaluation.dataAsOf.state === "known" &&
      (evaluation.freshness.state !== "expired" ||
        !freshnessMatchesKnownTimes({
          calculatedAt: evaluation.calculatedAt,
          observedAt: evaluation.dataAsOf.observedAt,
          freshness: evaluation.freshness,
        }))
    ) {
      context.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "packscout_buyback_ev.expired_freshness_mismatch",
      });
    }
  });

/** Strict task-003 output before confidence is composed with EV metrics. */
export const packScoutBuybackEvConfidenceEvaluationV1Schema =
  z.discriminatedUnion("status", [
    availableConfidenceEvaluationV1Schema,
    unavailableConfidenceEvaluationV1Schema,
  ]);

function expectedLimitations(input: {
  readonly calculatedAt: string;
  readonly dataAsOf: { readonly observedAt: string };
  readonly provenance: {
    readonly oddsSource: "current_remaining_inventory" | "platform_published";
    readonly usedClosedRangeMidpoint: boolean;
  };
}): readonly PackScoutBuybackEvConfidenceLimitationCodeV1[] {
  const expected = new Set<PackScoutBuybackEvConfidenceLimitationCodeV1>();
  if (input.provenance.usedClosedRangeMidpoint) {
    expected.add("closed_range_midpoint");
  }
  if (input.provenance.oddsSource === "platform_published") {
    expected.add("platform_published_odds");
  }
  const ageMilliseconds =
    Date.parse(input.calculatedAt) - Date.parse(input.dataAsOf.observedAt);
  if (ageMilliseconds > 30 * 60_000) {
    expected.add("source_age_over_30_through_60_minutes");
  } else if (ageMilliseconds > 15 * 60_000) {
    expected.add("source_age_over_15_through_30_minutes");
  }
  return PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1.filter((code) =>
    expected.has(code),
  );
}

const availableProtectedResultV1Schema = z
  .object({
    schemaVersion: packScoutBuybackEvSchemaVersionV1Schema,
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion:
      packScoutBuybackEvConfidencePolicyVersionV1Schema,
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    status: z.literal("available"),
    grossEvMoney: packScoutBuybackEvCanonicalUsdMoneyV1Schema,
    grossReturnBasisPoints: basisPointsSchema,
    evDollars: packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema,
    evPercentBasisPoints: basisPointsSchema,
    confidence: packScoutBuybackEvConfidenceResultV1Schema,
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: z
      .object({
        state: z.literal("known"),
        observedAt: packScoutBuybackEvTimestampV1Schema,
      })
      .strict(),
    freshness: currentFreshnessStateV1Schema,
    provenance: packScoutBuybackEvProtectedProvenanceV1Schema,
    protectedEvidence:
      packScoutBuybackEvProtectedCalculationEvidenceV1Schema,
  })
  .strict()
  .superRefine((result, context) => {
    const packPrice = result.protectedEvidence.packPriceMoney.minorUnits;
    if (
      !packScoutBuybackEvMetricsAreConsistentV1({
        grossEvMinorUnits: result.grossEvMoney.minorUnits,
        grossReturnBasisPoints: result.grossReturnBasisPoints,
        evDollarsMinorUnits: result.evDollars.minorUnits,
        evPercentBasisPoints: result.evPercentBasisPoints,
        packPriceMinorUnits: packPrice,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["grossEvMoney"],
        message: "packscout_buyback_ev.metric_invariants_failed",
      });
    }
    const ageMilliseconds =
      Date.parse(result.calculatedAt) - Date.parse(result.dataAsOf.observedAt);
    if (
      ageMilliseconds < 0 ||
      ageMilliseconds > 60 * 60_000 ||
      !freshnessMatchesKnownTimes({
        calculatedAt: result.calculatedAt,
        observedAt: result.dataAsOf.observedAt,
        freshness: result.freshness,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataAsOf"],
        message: "packscout_buyback_ev.available_freshness_invalid",
      });
    }
    const limitations = expectedLimitations(result);
    if (
      limitations.length !== result.confidence.limitationCodes.length ||
      limitations.some(
        (limitation, index) =>
          limitation !== result.confidence.limitationCodes[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["confidence", "limitationCodes"],
        message: "packscout_buyback_ev.confidence_evidence_mismatch",
      });
    }
  });

const unavailableProtectedResultV1Schema = z
  .object({
    schemaVersion: z.literal(PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION),
    methodVersion: z.literal(PACKSCOUT_BUYBACK_EV_METHOD_VERSION),
    confidencePolicyVersion: z.literal(
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    ),
    visibility: z.literal(PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY),
    status: z.literal("unavailable"),
    grossEvMoney: z.null(),
    grossReturnBasisPoints: z.null(),
    evDollars: z.null(),
    evPercentBasisPoints: z.null(),
    confidence: z.null(),
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: packScoutBuybackEvDataAsOfV1Schema,
    freshness: packScoutBuybackEvFreshnessStateV1Schema,
    provenance: packScoutBuybackEvProtectedProvenanceV1Schema.nullable(),
    protectedEvidence: z.null(),
    internalReasons: packScoutBuybackEvInternalReasonsV1Schema,
    publicPrimaryReason: packScoutBuybackEvPublicReasonCodeV1Schema,
  })
  .strict()
  .superRefine((result, context) => {
    const expectedPublicReason =
      packScoutBuybackEvPublicReasonForInternalReasonsV1(
        result.internalReasons,
      );
    if (result.publicPrimaryReason !== expectedPublicReason) {
      context.addIssue({
        code: "custom",
        path: ["publicPrimaryReason"],
        message: "packscout_buyback_ev.public_reason_mismatch",
      });
    }
    const reasons = new Set<PackScoutBuybackEvInternalReasonCodeV1>(
      result.internalReasons,
    );
    if ((result.provenance === null) !== reasons.has("MISSING_PROVENANCE")) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "packscout_buyback_ev.provenance_reason_mismatch",
      });
    }
    if (
      (result.dataAsOf.state === "unknown_source_time") !==
      reasons.has("MISSING_SOURCE_TIME")
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataAsOf"],
        message: "packscout_buyback_ev.source_time_reason_mismatch",
      });
    }
    if (result.dataAsOf.state === "known") {
      const ageMilliseconds =
        Date.parse(result.calculatedAt) - Date.parse(result.dataAsOf.observedAt);
      if (ageMilliseconds < 0) {
        context.addIssue({
          code: "custom",
          path: ["calculatedAt"],
          message: "packscout_buyback_ev.calculation_precedes_evidence",
        });
      }
      if ((ageMilliseconds > 60 * 60_000) !== reasons.has("STALE_EVIDENCE")) {
        context.addIssue({
          code: "custom",
          path: ["internalReasons"],
          message: "packscout_buyback_ev.stale_reason_mismatch",
        });
      }
      if (
        result.freshness.state === "unknown_source_time" ||
        !freshnessMatchesKnownTimes({
          calculatedAt: result.calculatedAt,
          observedAt: result.dataAsOf.observedAt,
          freshness: result.freshness,
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["freshness"],
          message: "packscout_buyback_ev.freshness_time_mismatch",
        });
      }
    } else if (reasons.has("STALE_EVIDENCE")) {
      context.addIssue({
        code: "custom",
        path: ["internalReasons"],
        message: "packscout_buyback_ev.stale_without_source_time",
      });
    } else if (result.freshness.state !== "unknown_source_time") {
      context.addIssue({
        code: "custom",
        path: ["freshness"],
        message: "packscout_buyback_ev.unknown_freshness_mismatch",
      });
    }
  });

/**
 * Protected calculation output. Public release contracts must project an
 * explicit allowlist and must never serialize this object directly.
 */
export const packScoutBuybackEvProtectedResultV1Schema =
  z.discriminatedUnion("status", [
    availableProtectedResultV1Schema,
    unavailableProtectedResultV1Schema,
  ]);

export const PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1 = Object.freeze([
  "internalReasons",
  "protectedEvidence",
  "protectedEvidence.payoutFormula",
  "protectedEvidence.underlyingOutcomeEvMoney",
  "provenance",
  "provenance.productKey",
  "provenance.productRevisionId",
  "provenance.sourceManifestSha256",
  "provenance.sourceRevisionId",
  "visibility",
] as const);

export type PackScoutBuybackEvConfidenceResultV1 = z.infer<
  typeof packScoutBuybackEvConfidenceResultV1Schema
>;
export type PackScoutBuybackEvConfidenceEvaluationV1 = z.infer<
  typeof packScoutBuybackEvConfidenceEvaluationV1Schema
>;
export type PackScoutBuybackEvFreshnessStateV1 = z.infer<
  typeof packScoutBuybackEvFreshnessStateV1Schema
>;
export type PackScoutBuybackEvProtectedResultV1 = z.infer<
  typeof packScoutBuybackEvProtectedResultV1Schema
>;
