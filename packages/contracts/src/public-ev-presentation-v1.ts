import { z } from "zod";
import { packScoutBuybackEvTimestampV1Schema } from "./buyback-adjusted-ev-v1-common.ts";
import { PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION } from "./data-release-v3-last-known-ev.ts";

/** The single public display policy is PR51 retained EV with linear confidence aging. */
export const publicEvPresentationResponseContextV1Schema = z.object({
  publicFreshnessPolicyVersion: z.literal(PACKSCOUT_LAST_KNOWN_EV_CONFIDENCE_POLICY_VERSION),
  confidenceEvaluatedAt: packScoutBuybackEvTimestampV1Schema,
}).strict();
export type PublicEvPresentationResponseContextV1 = z.infer<typeof publicEvPresentationResponseContextV1Schema>;

/** Health advances at the trusted server clock independently of cursor-pinned EV confidence. */
export const publicProviderHealthResponseContextV1Schema = z.object({
  providerHealthEvaluatedAt: packScoutBuybackEvTimestampV1Schema,
}).strict();
export type PublicProviderHealthResponseContextV1 = z.infer<typeof publicProviderHealthResponseContextV1Schema>;

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
