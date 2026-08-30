import { z } from "zod";
import {
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvTimestampV1Schema,
  parsePackScoutBuybackEvTimestampMillisV1,
  type PackScoutBuybackEvPublicReasonCodeV1,
} from "./buyback-adjusted-ev-v1-common.ts";
import { packScoutBuybackEvMetricsAreConsistentV1 } from "./buyback-adjusted-ev-v1-calculation.ts";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1,
} from "./buyback-adjusted-ev-v1-result.ts";
import {
  PACKSCOUT_PUBLIC_EV_SOURCE_AGE_STATES_V3,
  containsProtectedEvPublicationKeyV3,
  packScoutPublicEvMetricsV3Schema,
  packScoutPublicEvV3Schema,
  type PackScoutPublicEvV3,
} from "./data-release-v3-ev-estimates.ts";

/** Presentation policy, independent of the immutable calculation's V1 policy. */
export const PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION =
  "packscout-last-known-ev-confidence-v1" as const;
export const PACKSCOUT_DISPLAYED_EV_SOURCE_AGE_STATES_V3 = Object.freeze([
  ...PACKSCOUT_PUBLIC_EV_SOURCE_AGE_STATES_V3,
  "delayed_over_60_minutes",
] as const);
export type PackScoutDisplayedEvSourceAgeStateV3 =
  (typeof PACKSCOUT_DISPLAYED_EV_SOURCE_AGE_STATES_V3)[number];
export const PACKSCOUT_DISPLAYED_EV_CONFIDENCE_LIMITATION_CODES_V3 = Object.freeze([
  ...PACKSCOUT_BUYBACK_EV_CONFIDENCE_LIMITATION_CODES_V1,
  "source_age_over_60_minutes",
  "latest_calculation_unavailable",
] as const);
export type PackScoutDisplayedEvConfidenceLimitationCodeV3 =
  (typeof PACKSCOUT_DISPLAYED_EV_CONFIDENCE_LIMITATION_CODES_V3)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const knownDataAsOf = z.object({
  state: z.literal("known"),
  observedAt: packScoutBuybackEvTimestampV1Schema,
}).strict();

function ageState(age: number): PackScoutDisplayedEvSourceAgeStateV3 {
  if (age > HOUR) return "delayed_over_60_minutes";
  if (age > 30 * MINUTE) return "delayed_over_30_through_60_minutes";
  if (age > 15 * MINUTE) return "delayed_over_15_through_30_minutes";
  return "fresh_within_15_minutes";
}

function confidenceAt(input: {
  readonly age: number;
  readonly limitations: readonly string[];
  readonly latestUnavailableReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
}) {
  const midpoint = input.limitations.includes("closed_range_midpoint");
  const published = input.limitations.includes("platform_published_odds");
  const base = 10_000 -
    (midpoint ? PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.closedRangeMidpoint : 0) -
    (published ? PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.platformPublishedOdds : 0);
  // Bound before multiplying so arbitrarily old valid timestamps remain safe.
  const agePenalty = input.age > HOUR
    ? Math.min(10_000, 2_500 + Math.floor(Math.min(input.age - HOUR, 3 * HOUR) * 2_500 / HOUR))
    : input.age > 30 * MINUTE ? 2_500 : input.age > 15 * MINUTE ? 1_000 : 0;
  const scoreBasisPoints = input.latestUnavailableReason === null
    ? Math.max(0, base - agePenalty) : 0;
  const applied = new Set<PackScoutDisplayedEvConfidenceLimitationCodeV3>();
  if (midpoint) applied.add("closed_range_midpoint");
  if (published) applied.add("platform_published_odds");
  if (input.age > HOUR) applied.add("source_age_over_60_minutes");
  else if (input.age > 30 * MINUTE) applied.add("source_age_over_30_through_60_minutes");
  else if (input.age > 15 * MINUTE) applied.add("source_age_over_15_through_30_minutes");
  if (input.latestUnavailableReason !== null) applied.add("latest_calculation_unavailable");
  return {
    policyVersion: PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints,
    band: scoreBasisPoints < 5_000 ? "low" as const : scoreBasisPoints < 8_000 ? "medium" as const : "high" as const,
    limitationCodes: PACKSCOUT_DISPLAYED_EV_CONFIDENCE_LIMITATION_CODES_V3.filter(code => applied.has(code)),
  };
}

/** Last validated values plus a separately evaluated, continuously aging score. */
export const packScoutPublicEvLastKnownV3Schema = z.object({
  status: z.literal("last_known"),
  methodVersion: packScoutBuybackEvMethodVersionV1Schema,
  confidencePolicyVersion: z.literal(PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION),
  metrics: packScoutPublicEvMetricsV3Schema,
  confidence: z.object({
    policyVersion: z.literal(PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION),
    scoreBasisPoints: z.number().int().min(0).max(10_000),
    band: z.enum(["low", "medium", "high"]),
    limitationCodes: z.array(z.enum(PACKSCOUT_DISPLAYED_EV_CONFIDENCE_LIMITATION_CODES_V3))
      .max(PACKSCOUT_DISPLAYED_EV_CONFIDENCE_LIMITATION_CODES_V3.length),
  }).strict(),
  calculatedAt: packScoutBuybackEvTimestampV1Schema,
  dataAsOf: knownDataAsOf,
  sourceAge: z.object({
    milliseconds: z.number().int().safe().min(0),
    state: z.enum(PACKSCOUT_DISPLAYED_EV_SOURCE_AGE_STATES_V3),
  }).strict(),
  confidenceEvaluatedAt: packScoutBuybackEvTimestampV1Schema,
  calculationPriceUsdMinor: z.number().int().safe().positive(),
  latestUnavailableReason: packScoutBuybackEvPublicReasonCodeV1Schema.nullable(),
  historicalSoldOutAt: packScoutBuybackEvTimestampV1Schema.nullable(),
  expiresAt: z.null(),
}).strict().superRefine((estimate, context) => {
  const observed = Date.parse(estimate.dataAsOf.observedAt);
  const calculated = Date.parse(estimate.calculatedAt);
  const evaluated = Date.parse(estimate.confidenceEvaluatedAt);
  const age = evaluated - observed;
  if (calculated < observed || calculated - observed > HOUR || evaluated < calculated || age < 0 ||
      (estimate.historicalSoldOutAt !== null &&
        (Date.parse(estimate.historicalSoldOutAt) < calculated ||
         Date.parse(estimate.historicalSoldOutAt) > evaluated ||
         Date.parse(estimate.historicalSoldOutAt) - observed > HOUR))) {
    context.addIssue({code:"custom", message:"last_known_ev.timestamps_invalid"});
  }
  if (estimate.sourceAge.milliseconds !== age || estimate.sourceAge.state !== ageState(age)) {
    context.addIssue({code:"custom", path:["sourceAge"], message:"last_known_ev.source_age_mismatch"});
  }
  const confidence = confidenceAt({
    age, limitations: estimate.confidence.limitationCodes,
    latestUnavailableReason: estimate.latestUnavailableReason,
  });
  if (JSON.stringify(estimate.confidence) !== JSON.stringify(confidence)) {
    context.addIssue({code:"custom", path:["confidence"], message:"last_known_ev.confidence_mismatch"});
  }
  if (!packScoutBuybackEvMetricsAreConsistentV1({
    grossEvMinorUnits: estimate.metrics.grossEvMoney.minorUnits,
    grossReturnBasisPoints: estimate.metrics.grossReturnBasisPoints,
    evDollarsMinorUnits: estimate.metrics.evDollars.minorUnits,
    evPercentBasisPoints: estimate.metrics.evPercentBasisPoints,
    packPriceMinorUnits: estimate.calculationPriceUsdMinor,
  })) {
    context.addIssue({code:"custom", path:["metrics"], message:"last_known_ev.calculation_price_mismatch"});
  }
});

export type PackScoutPublicEvLastKnownV3 = z.infer<typeof packScoutPublicEvLastKnownV3Schema>;
export const packScoutDisplayedEvV3Schema = z.union([
  packScoutPublicEvV3Schema,
  packScoutPublicEvLastKnownV3Schema,
]).superRefine((value, context) => {
  if (containsProtectedEvPublicationKeyV3(value)) {
    context.addIssue({code:"custom", message:"last_known_ev.protected_field_present"});
  }
});
export type PackScoutDisplayedEvV3 = PackScoutPublicEvV3 | PackScoutPublicEvLastKnownV3;

/** Never recalculates EV, changes its source clock, or subtracts decay twice. */
export function presentLastKnownPackScoutEvV3(input: {
  readonly estimate: PackScoutDisplayedEvV3;
  readonly calculationPriceUsdMinor: number;
  readonly referenceTimeIso: string;
  readonly latestUnavailableReason?: PackScoutBuybackEvPublicReasonCodeV1 | null;
}): PackScoutDisplayedEvV3 {
  const estimate = packScoutDisplayedEvV3Schema.parse(input.estimate);
  const reference = parsePackScoutBuybackEvTimestampMillisV1(input.referenceTimeIso);
  if (reference === null || reference < Date.parse(estimate.calculatedAt) ||
      (estimate.status === "last_known" && reference < Date.parse(estimate.confidenceEvaluatedAt))) {
    throw new Error("last_known_ev.reference_time_invalid");
  }
  if (estimate.status === "unavailable") return estimate;
  const age = reference - Date.parse(estimate.dataAsOf.observedAt);
  const latestUnavailableReason = input.latestUnavailableReason ??
    (estimate.status === "last_known" ? estimate.latestUnavailableReason : null);
  return packScoutPublicEvLastKnownV3Schema.parse({
    status: "last_known",
    methodVersion: estimate.methodVersion,
    confidencePolicyVersion: PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION,
    metrics: estimate.metrics,
    confidence: confidenceAt({age, limitations: estimate.confidence.limitationCodes, latestUnavailableReason}),
    calculatedAt: estimate.calculatedAt,
    dataAsOf: estimate.dataAsOf,
    sourceAge: {milliseconds: age, state: ageState(age)},
    confidenceEvaluatedAt: input.referenceTimeIso,
    calculationPriceUsdMinor: estimate.status === "last_known"
      ? estimate.calculationPriceUsdMinor : input.calculationPriceUsdMinor,
    latestUnavailableReason,
    historicalSoldOutAt: estimate.status === "sold_out_historical" ? estimate.soldOutAt
      : estimate.status === "last_known" ? estimate.historicalSoldOutAt : null,
    expiresAt: null,
  });
}
