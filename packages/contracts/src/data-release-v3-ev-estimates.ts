import {
  PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V1 as PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3,
  containsProtectedEvPublicationKeyV1 as containsProtectedEvPublicationKeyV3,
  packScoutPublicEvMetricsV1Schema as packScoutPublicEvMetricsV3Schema,
  publicBuybackSummaryV1Schema as publicBuybackSummaryV3Schema,
  vendorReportedEvV1Schema as vendorReportedEvV3Schema,
} from "./public-ev-values-v1.ts";
export {
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V1 as PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  packScoutPublicEvPolicyVersionV1Schema as packScoutPublicEvPolicyVersionV3Schema,
  PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V1 as PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3,
  packScoutPublicEvMetricsAreNonpositiveV1 as packScoutPublicEvMetricsAreNonpositiveV3,
  PUBLIC_EV_PROTECTED_FIELD_KEYS_V1 as DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS,
  containsProtectedEvPublicationKeyV1 as containsProtectedEvPublicationKeyV3,
  packScoutPublicEvMetricsV1Schema as packScoutPublicEvMetricsV3Schema,
  PUBLIC_BUYBACK_SUMMARY_KINDS_V1 as PUBLIC_BUYBACK_SUMMARY_KINDS_V3,
  publicBuybackSummaryV1Schema as publicBuybackSummaryV3Schema,
  vendorReportedEvV1Schema as vendorReportedEvV3Schema,
} from "./public-ev-values-v1.ts";
export type { PublicBuybackSummaryKindV1 as PublicBuybackSummaryKindV3 } from "./public-ev-values-v1.ts";
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
  packScoutBuybackEvConfidenceResultV1Schema,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
} from "./buyback-adjusted-ev-v1-result.ts";

export const DATA_RELEASE_V3_SCHEMA_VERSION = "data_release_v3" as const;
export const PACKSCOUT_PUBLIC_EV_SOURCE_AGE_STATES_V3 = Object.freeze([
  "fresh_within_15_minutes",
  "delayed_over_15_through_30_minutes",
  "delayed_over_30_through_60_minutes",
] as const);

export type PackScoutPublicEvSourceAgeStateV3 =
  (typeof PACKSCOUT_PUBLIC_EV_SOURCE_AGE_STATES_V3)[number];

export const packScoutPublicEvSourceAgeV3Schema = z
  .object({
    milliseconds: z
      .number()
      .int()
      .min(0)
      .max(PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3),
    state: z.enum(PACKSCOUT_PUBLIC_EV_SOURCE_AGE_STATES_V3),
  })
  .strict();

function expectedSourceAgeStateV3(
  ageMilliseconds: number,
): PackScoutPublicEvSourceAgeStateV3 {
  if (ageMilliseconds > 30 * 60_000) {
    return "delayed_over_30_through_60_minutes";
  }
  if (ageMilliseconds > 15 * 60_000) {
    return "delayed_over_15_through_30_minutes";
  }
  return "fresh_within_15_minutes";
}

function expectedFreshnessLimitationV3(
  ageMilliseconds: number,
): PackScoutBuybackEvConfidenceLimitationCodeV1 | null {
  if (ageMilliseconds > 30 * 60_000) {
    return "source_age_over_30_through_60_minutes";
  }
  if (ageMilliseconds > 15 * 60_000) {
    return "source_age_over_15_through_30_minutes";
  }
  return null;
}

function canonicalExpiryV3(observedAtMilliseconds: number): string {
  return new Date(
    observedAtMilliseconds + PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3,
  ).toISOString();
}

interface FrozenObservationV3 {
  readonly calculatedAt: string;
  readonly dataAsOf: { readonly observedAt: string };
  readonly sourceAge: z.infer<typeof packScoutPublicEvSourceAgeV3Schema>;
  readonly confidence: z.infer<
    typeof packScoutBuybackEvConfidenceResultV1Schema
  >;
}

function validateFrozenObservationV3(
  estimate: FrozenObservationV3,
  context: z.RefinementCtx,
): number | null {
  const ageMilliseconds =
    Date.parse(estimate.calculatedAt) - Date.parse(estimate.dataAsOf.observedAt);
  if (
    ageMilliseconds < 0 ||
    ageMilliseconds > PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3
  ) {
    context.addIssue({
      code: "custom",
      path: ["calculatedAt"],
      message: "data_release_v3.source_age_outside_window",
    });
    return null;
  }
  if (
    estimate.sourceAge.milliseconds !== ageMilliseconds ||
    estimate.sourceAge.state !== expectedSourceAgeStateV3(ageMilliseconds)
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceAge"],
      message: "data_release_v3.source_age_mismatch",
    });
  }
  const expectedLimitation = expectedFreshnessLimitationV3(ageMilliseconds);
  const freshnessLimitations = estimate.confidence.limitationCodes.filter(
    (code) => code.startsWith("source_age_"),
  );
  if (
    freshnessLimitations.length !== (expectedLimitation === null ? 0 : 1) ||
    (expectedLimitation !== null &&
      freshnessLimitations[0] !== expectedLimitation)
  ) {
    context.addIssue({
      code: "custom",
      path: ["confidence", "limitationCodes"],
      message: "data_release_v3.freshness_limitation_mismatch",
    });
  }
  return ageMilliseconds;
}

const packScoutPublicEvKnownDataAsOfV3Schema = z
  .object({
    state: z.literal("known"),
    observedAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict();

const packScoutPublicEvCurrentV3Schema = z
  .object({
    status: z.literal("current"),
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion: packScoutBuybackEvConfidencePolicyVersionV1Schema,
    metrics: packScoutPublicEvMetricsV3Schema,
    confidence: packScoutBuybackEvConfidenceResultV1Schema,
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: packScoutPublicEvKnownDataAsOfV3Schema,
    sourceAge: packScoutPublicEvSourceAgeV3Schema,
    expiresAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict()
  .superRefine((estimate, context) => {
    validateFrozenObservationV3(estimate, context);
    if (
      estimate.expiresAt !==
      canonicalExpiryV3(Date.parse(estimate.dataAsOf.observedAt))
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "data_release_v3.expiry_not_canonical",
      });
    }
  });

const packScoutPublicEvSoldOutHistoricalV3Schema = z
  .object({
    status: z.literal("sold_out_historical"),
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion: packScoutBuybackEvConfidencePolicyVersionV1Schema,
    metrics: packScoutPublicEvMetricsV3Schema,
    confidence: packScoutBuybackEvConfidenceResultV1Schema,
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: packScoutPublicEvKnownDataAsOfV3Schema,
    sourceAge: packScoutPublicEvSourceAgeV3Schema,
    soldOutAt: packScoutBuybackEvTimestampV1Schema,
    expiresAt: z.null(),
  })
  .strict()
  .superRefine((estimate, context) => {
    validateFrozenObservationV3(estimate, context);
    const soldOutMilliseconds = Date.parse(estimate.soldOutAt);
    if (soldOutMilliseconds < Date.parse(estimate.calculatedAt)) {
      context.addIssue({
        code: "custom",
        path: ["soldOutAt"],
        message: "data_release_v3.sold_out_before_calculation",
      });
    }
    if (
      soldOutMilliseconds - Date.parse(estimate.dataAsOf.observedAt) >
      PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3
    ) {
      context.addIssue({
        code: "custom",
        path: ["soldOutAt"],
        message: "data_release_v3.estimate_not_current_at_sellout",
      });
    }
  });

const packScoutPublicEvUnavailableV3Schema = z
  .object({
    status: z.literal("unavailable"),
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion: packScoutBuybackEvConfidencePolicyVersionV1Schema,
    metrics: z.null(),
    confidence: z.null(),
    calculatedAt: packScoutBuybackEvTimestampV1Schema,
    dataAsOf: packScoutBuybackEvDataAsOfV1Schema,
    reason: packScoutBuybackEvPublicReasonCodeV1Schema,
  })
  .strict()
  .superRefine((estimate, context) => {
    if (estimate.dataAsOf.state === "known") {
      const ageMilliseconds =
        Date.parse(estimate.calculatedAt) -
        Date.parse(estimate.dataAsOf.observedAt);
      if (ageMilliseconds < 0) {
        context.addIssue({
          code: "custom",
          path: ["calculatedAt"],
          message: "data_release_v3.calculation_precedes_evidence",
        });
      }
      if (
        estimate.reason === "SOURCE_DATA_STALE" &&
        ageMilliseconds <= PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "data_release_v3.stale_reason_within_window",
        });
      }
      return;
    }
    if (estimate.reason !== "SOURCE_EVIDENCE_UNAVAILABLE") {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "data_release_v3.unknown_time_reason_invalid",
      });
    }
  });

/**
 * The strict public PackScout EV union for data_release_v3. Every branch
 * derives from the protected task-001 result and exposes only the approved
 * public allowlist: four metrics, confidence, versions, timestamps,
 * source-age state, expiry or sellout, and one bounded public reason.
 */
export const packScoutPublicEvV3Schema = z.discriminatedUnion("status", [
  packScoutPublicEvCurrentV3Schema,
  packScoutPublicEvSoldOutHistoricalV3Schema,
  packScoutPublicEvUnavailableV3Schema,
]);

/**
 * A current estimate stays presentable through its exact 60-minute deadline
 * and is rejected only after that deadline, even when a stored freshness
 * state has not advanced. Historical and unavailable estimates never expire
 * into a live-unavailable state.
 */
export function packScoutPublicEvV3IsPresentableAt(
  estimate: PackScoutPublicEvV3,
  referenceTimeIso: string,
): boolean {
  const referenceMilliseconds =
    parsePackScoutBuybackEvTimestampMillisV1(referenceTimeIso);
  if (referenceMilliseconds === null) return false;
  if (estimate.status !== "current") return true;
  return referenceMilliseconds <= Date.parse(estimate.expiresAt);
}

export type SafeParsePackScoutPublicEvV3Failure =
  | "protected_field_present"
  | "schema_invalid"
  | "reference_time_invalid"
  | "current_past_deadline";

export type SafeParsePackScoutPublicEvV3Result =
  | { readonly success: true; readonly estimate: PackScoutPublicEvV3 }
  | {
      readonly success: false;
      readonly reason: SafeParsePackScoutPublicEvV3Failure;
    };

export function safeParsePackScoutPublicEvV3(
  input: unknown,
  referenceTimeIso: string,
): SafeParsePackScoutPublicEvV3Result {
  if (containsProtectedEvPublicationKeyV3(input)) {
    return { success: false, reason: "protected_field_present" };
  }
  const parsed = packScoutPublicEvV3Schema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: "schema_invalid" };
  }
  if (parsePackScoutBuybackEvTimestampMillisV1(referenceTimeIso) === null) {
    return { success: false, reason: "reference_time_invalid" };
  }
  if (!packScoutPublicEvV3IsPresentableAt(parsed.data, referenceTimeIso)) {
    return { success: false, reason: "current_past_deadline" };
  }
  return { success: true, estimate: parsed.data };
}

export const publicEvEstimatesV3Schema = z
  .object({
    packScout: packScoutPublicEvV3Schema,
    vendorReported: vendorReportedEvV3Schema,
  })
  .strict();

export type PackScoutPublicEvMetricsV3 = z.infer<
  typeof packScoutPublicEvMetricsV3Schema
>;
export type PackScoutPublicEvSourceAgeV3 = z.infer<
  typeof packScoutPublicEvSourceAgeV3Schema
>;
export type PackScoutPublicEvV3 = z.infer<typeof packScoutPublicEvV3Schema>;
export type PublicBuybackSummaryV3 = z.infer<
  typeof publicBuybackSummaryV3Schema
>;
export type VendorReportedEvV3 = z.infer<typeof vendorReportedEvV3Schema>;
export type PublicEvEstimatesV3 = z.infer<typeof publicEvEstimatesV3Schema>;
