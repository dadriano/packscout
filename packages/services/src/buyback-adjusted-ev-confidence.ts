import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  packScoutBuybackEvConfidenceInputV1Schema,
  parsePackScoutBuybackEvTimestampMillisV1,
  type PackScoutBuybackEvConfidenceEvaluationV1,
  type PackScoutBuybackEvConfidenceInputV1,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
} from "@packscout/contracts";

/**
 * Confidence Policy `packscout-buyback-adjusted-ev-confidence-v1`.
 *
 * Every available estimate starts at 10,000 basis points and only the four
 * approved penalties may reduce it. Confidence describes evidence reliability
 * and freshness; EV sign and magnitude, Heat, vendor-reported EV, and
 * chase-match evidence are excluded from the input contract by construction.
 * Missing essential evidence never lowers the score; it makes the evaluation
 * unavailable with a null confidence.
 */
export const PACKSCOUT_BUYBACK_EV_CONFIDENCE_START_SCORE_BASIS_POINTS = 10_000;

const MINUTE_MILLISECONDS = 60_000;

/** Source age at or below this inclusive bound carries no freshness penalty. */
export const PACKSCOUT_BUYBACK_EV_SOURCE_AGE_NO_PENALTY_MAX_MILLISECONDS =
  15 * MINUTE_MILLISECONDS;

/**
 * Source age above the no-penalty bound through this inclusive bound deducts
 * the 1,000-point delayed-source penalty.
 */
export const PACKSCOUT_BUYBACK_EV_SOURCE_AGE_DELAYED_MAX_MILLISECONDS =
  30 * MINUTE_MILLISECONDS;

/**
 * Source age above the delayed bound through this inclusive bound deducts the
 * 2,500-point delayed-source penalty. Older evidence expires and the
 * evaluation becomes unavailable rather than retaining a low score.
 */
export const PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS =
  60 * MINUTE_MILLISECONDS;

const LOW_BAND_MAX_BASIS_POINTS = 4_999;
const MEDIUM_BAND_MAX_BASIS_POINTS = 7_999;

const penaltyBasisPointsByLimitation: Readonly<
  Record<PackScoutBuybackEvConfidenceLimitationCodeV1, number>
> = Object.freeze({
  closed_range_midpoint:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.closedRangeMidpoint,
  platform_published_odds:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.platformPublishedOdds,
  source_age_over_15_through_30_minutes:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1
      .sourceAgeOver15Through30Minutes,
  source_age_over_30_through_60_minutes:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1
      .sourceAgeOver30Through60Minutes,
});

/**
 * Approved public copy for each score-affecting limitation. The strings
 * describe evidence reliability only and never claim confidence measures an
 * outcome; provider payload text never appears here.
 */
export const PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_EXPLANATIONS_V1: Readonly<
  Record<PackScoutBuybackEvConfidenceLimitationCodeV1, string>
> = Object.freeze({
  closed_range_midpoint:
    "At least one supported value uses the midpoint of a platform-stated closed range instead of an exact stated value.",
  platform_published_odds:
    "Odds come from complete platform-published odds because verified current-pool odds were unavailable.",
  source_age_over_15_through_30_minutes:
    "The oldest essential source observation is more than 15 and at most 30 minutes old.",
  source_age_over_30_through_60_minutes:
    "The oldest essential source observation is more than 30 and at most 60 minutes old.",
});

export type PackScoutBuybackEvConfidenceExplainedConditionV1 =
  | "current"
  | "expired"
  | "unknown_source_time"
  | "evidence_gate_failed";

/**
 * Approved public copy for each freshness and unavailability condition the
 * confidence boundary can report.
 */
export const PACKSCOUT_BUYBACK_EV_CONFIDENCE_CONDITION_EXPLANATIONS_V1: Readonly<
  Record<PackScoutBuybackEvConfidenceExplainedConditionV1, string>
> = Object.freeze({
  current:
    "Every essential source observation is at most 60 minutes old, so the estimate reflects current evidence.",
  expired:
    "The oldest essential source observation is more than 60 minutes old, so the estimate is unavailable until fresher evidence is observed.",
  unknown_source_time:
    "The essential source observation time is unknown, so evidence freshness cannot be established and the estimate is unavailable.",
  evidence_gate_failed:
    "Essential source evidence is incomplete, so the estimate is unavailable and has no confidence score.",
});

function confidenceBandForScore(
  scoreBasisPoints: number,
): "low" | "medium" | "high" {
  if (scoreBasisPoints <= LOW_BAND_MAX_BASIS_POINTS) return "low";
  if (scoreBasisPoints <= MEDIUM_BAND_MAX_BASIS_POINTS) return "medium";
  return "high";
}

function timestampMilliseconds(timestamp: string): number {
  const milliseconds = parsePackScoutBuybackEvTimestampMillisV1(timestamp);
  if (milliseconds === null) {
    throw new Error(
      "PackScout EV confidence timestamps must be canonical millisecond UTC strings.",
    );
  }
  return milliseconds;
}

/**
 * The task-003 confidence boundary. Consumes the protected confidence input
 * from task 002 and returns one reproducible confidence evaluation:
 *
 * - a passed gate with evidence at most 60 minutes old scores under Confidence
 *   Policy V1 and stays available;
 * - evidence older than 60 minutes expires with a null confidence;
 * - a missing essential observation time reports the explicit
 *   unknown-source-time state with a null confidence;
 * - a failed availability gate never receives a fabricated score.
 *
 * Unsupported versions, inconsistent time states, and unknown fields fail
 * closed by throwing. A failed gate whose known evidence is still current is
 * also rejected: that unavailable state carries non-freshness reasons owned by
 * the calculation result, and the strict evaluation contract deliberately
 * cannot express it.
 */
export function evaluatePackScoutBuybackEvConfidenceV1(
  input: PackScoutBuybackEvConfidenceInputV1,
): PackScoutBuybackEvConfidenceEvaluationV1 {
  const parsed = packScoutBuybackEvConfidenceInputV1Schema.parse(input);
  const envelope = {
    schemaVersion: parsed.schemaVersion,
    methodVersion: parsed.methodVersion,
    confidencePolicyVersion: parsed.confidencePolicyVersion,
    visibility: parsed.visibility,
    calculatedAt: parsed.calculatedAt,
  } as const;

  if (parsed.oldestEssentialObservedAt === null) {
    return {
      ...envelope,
      status: "unavailable",
      confidence: null,
      dataAsOf: { state: "unknown_source_time", observedAt: null },
      freshness: {
        state: "unknown_source_time",
        sourceAgeMilliseconds: null,
        expiresAt: null,
        reason: "MISSING_SOURCE_TIME",
      },
    };
  }

  const observedAtMilliseconds = timestampMilliseconds(
    parsed.oldestEssentialObservedAt,
  );
  const sourceAgeMilliseconds =
    timestampMilliseconds(parsed.calculatedAt) - observedAtMilliseconds;
  const expiresAt = new Date(
    observedAtMilliseconds + PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS,
  ).toISOString();

  if (sourceAgeMilliseconds > PACKSCOUT_BUYBACK_EV_SOURCE_AGE_EXPIRY_MILLISECONDS) {
    return {
      ...envelope,
      status: "unavailable",
      confidence: null,
      dataAsOf: { state: "known", observedAt: parsed.oldestEssentialObservedAt },
      freshness: {
        state: "expired",
        sourceAgeMilliseconds,
        expiresAt,
        reason: "STALE_EVIDENCE",
      },
    };
  }

  if (parsed.availabilityGate.status === "failed") {
    throw new Error(
      "A failed PackScout EV availability gate with current source evidence has no confidence evaluation; the unavailable calculation result owns that state.",
    );
  }

  const applied = new Set<PackScoutBuybackEvConfidenceLimitationCodeV1>();
  if (parsed.usedClosedRangeMidpoint) {
    applied.add("closed_range_midpoint");
  }
  if (parsed.oddsSource === "platform_published") {
    applied.add("platform_published_odds");
  }
  if (
    sourceAgeMilliseconds > PACKSCOUT_BUYBACK_EV_SOURCE_AGE_DELAYED_MAX_MILLISECONDS
  ) {
    applied.add("source_age_over_30_through_60_minutes");
  } else if (
    sourceAgeMilliseconds >
    PACKSCOUT_BUYBACK_EV_SOURCE_AGE_NO_PENALTY_MAX_MILLISECONDS
  ) {
    applied.add("source_age_over_15_through_30_minutes");
  }

  const limitationCodes = PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1
    .filter((code) => applied.has(code));
  const deductionBasisPoints = limitationCodes.reduce(
    (total, code) => total + penaltyBasisPointsByLimitation[code],
    0,
  );
  const scoreBasisPoints = Math.max(
    0,
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_START_SCORE_BASIS_POINTS -
      deductionBasisPoints,
  );

  return {
    ...envelope,
    status: "available",
    confidence: {
      policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      scoreBasisPoints,
      band: confidenceBandForScore(scoreBasisPoints),
      limitationCodes,
    },
    dataAsOf: { state: "known", observedAt: parsed.oldestEssentialObservedAt },
    freshness: { state: "current", sourceAgeMilliseconds, expiresAt },
  };
}
