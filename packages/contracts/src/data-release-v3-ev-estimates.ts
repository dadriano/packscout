import { z } from "zod";
import {
  packScoutBuybackEvCanonicalUsdMoneyV1Schema,
  packScoutBuybackEvConfidencePolicyVersionV1Schema,
  packScoutBuybackEvDataAsOfV1Schema,
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutBuybackEvPublicReasonCodeV1Schema,
  packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema,
  packScoutBuybackEvTimestampV1Schema,
  parsePackScoutBuybackEvTimestampMillisV1,
} from "./buyback-adjusted-ev-v1-common.ts";
import {
  PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1,
  packScoutBuybackEvConfidenceResultV1Schema,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
} from "./buyback-adjusted-ev-v1-result.ts";
import {
  containsNormalizedProtectedPublicationField,
  normalizeProtectedPublicationFieldKey,
} from "./protected-publication-fields.ts";

export const DATA_RELEASE_V3_SCHEMA_VERSION = "data_release_v3" as const;
export const PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3 =
  60 * 60_000;

const safeIntegerSchema = z.number().int().safe();
const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0);

/**
 * Public keys that must never appear anywhere inside a data_release_v3
 * payload. Every leaf segment of the task-001 protected field names is
 * included, and the shared publication-fragment scan additionally rejects
 * raw-like provider keys (rawPayload, providerResponse, and similar).
 */
export const DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS: ReadonlySet<string> =
  new Set(
    PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1.flatMap((path) =>
      path.split(".").map(normalizeProtectedPublicationFieldKey),
    ),
  );

export function containsProtectedEvPublicationKeyV3(value: unknown): boolean {
  return containsNormalizedProtectedPublicationField(
    value,
    DATA_RELEASE_V3_PROTECTED_EV_FIELD_KEYS,
  );
}

export const packScoutPublicEvMetricsV3Schema = z
  .object({
    grossEvMoney: packScoutBuybackEvCanonicalUsdMoneyV1Schema,
    grossReturnBasisPoints: safeIntegerSchema,
    evDollars: packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema,
    evPercentBasisPoints: safeIntegerSchema,
  })
  .strict()
  .refine(
    ({ grossReturnBasisPoints, evPercentBasisPoints }) =>
      evPercentBasisPoints === grossReturnBasisPoints - 10_000,
    {
      path: ["evPercentBasisPoints"],
      message: "data_release_v3.ev_percent_inconsistent",
    },
  );

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

export const PUBLIC_BUYBACK_SUMMARY_KINDS_V3 = Object.freeze([
  "uniform_rate",
  "varies_by_outcome",
  "fixed_or_final_payout",
  "not_documented",
  "unavailable",
] as const);

export type PublicBuybackSummaryKindV3 =
  (typeof PUBLIC_BUYBACK_SUMMARY_KINDS_V3)[number];

/**
 * The bounded public buyback summary. A numeric rate is honest only for a
 * documented uniform rate; no other kind may carry basis points, and no
 * per-outcome term, payout formula, or synthetic average is representable.
 */
export const publicBuybackSummaryV3Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("uniform_rate"),
      rateBasisPoints: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("varies_by_outcome") }).strict(),
  z.object({ kind: z.literal("fixed_or_final_payout") }).strict(),
  z.object({ kind: z.literal("not_documented") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);

const publicReportedMoneyV3Schema = z
  .object({
    minorUnits: nonNegativeSafeIntegerSchema,
    currency: z.string().regex(/^[A-Z0-9]{2,12}$/u),
  })
  .strict();

const vendorReportedUsdComparisonV3Schema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      value: packScoutBuybackEvCanonicalUsdMoneyV1Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      value: z.null(),
      reason: z.literal("CURRENCY_UNSUPPORTED"),
    })
    .strict(),
]);

/**
 * Vendor-reported EV is a structurally independent source: its own reported
 * money, an optional normalized USD comparison, and its own observation
 * time. It shares no field with the PackScout estimate and can never
 * substitute for one.
 */
export const vendorReportedEvV3Schema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      sourceMoney: publicReportedMoneyV3Schema,
      usdComparison: vendorReportedUsdComparisonV3Schema,
      observedAt: packScoutBuybackEvTimestampV1Schema,
    })
    .strict()
    .superRefine((estimate, context) => {
      if (
        estimate.sourceMoney.currency === "USD" &&
        (estimate.usdComparison.status !== "available" ||
          estimate.usdComparison.value.minorUnits !==
            estimate.sourceMoney.minorUnits)
      ) {
        context.addIssue({
          code: "custom",
          path: ["usdComparison"],
          message: "data_release_v3.vendor_usd_evidence_mismatch",
        });
      }
    }),
  z
    .object({
      status: z.literal("unavailable"),
      sourceMoney: z.null(),
      usdComparison: z.null(),
      observedAt: packScoutBuybackEvTimestampV1Schema.nullable(),
      reason: z.literal("NOT_REPORTED"),
    })
    .strict(),
]);

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
