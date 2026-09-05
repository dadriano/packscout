import { z } from "zod";
import { packScoutBuybackEvCanonicalUsdMoneyV1Schema, packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema, packScoutBuybackEvTimestampV1Schema } from "./buyback-adjusted-ev-v1-common.ts";
import { PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1 } from "./buyback-adjusted-ev-v1-result.ts";
import { containsNormalizedProtectedPublicationField, normalizeProtectedPublicationFieldKey } from "./protected-publication-fields.ts";

/**
 * Public-release policy applied after the raw V1 calculation. Raw revisions
 * remain exact; V1 only publishes estimates at or below break-even.
 */
export const PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V1 =
  "packscout-public-ev-nonpositive-v1" as const;
export const packScoutPublicEvPolicyVersionV1Schema = z.literal(
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V1,
);
export const PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V1 =
  60 * 60_000;

/**
 * The exact signed-metric gate for the versioned public EV policy. Raw V1
 * revisions deliberately do not use this predicate; release assembly and
 * independent reconciliation do.
 */
export function packScoutPublicEvMetricsAreNonpositiveV1(metrics: {
  readonly grossReturnBasisPoints: number;
  readonly evDollars: Readonly<{ minorUnits: number }>;
  readonly evPercentBasisPoints: number;
}): boolean {
  return (
    metrics.grossReturnBasisPoints <= 10_000 &&
    metrics.evDollars.minorUnits <= 0 &&
    metrics.evPercentBasisPoints <= 0
  );
}

const safeIntegerSchema = z.number().int().safe();
const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0);

/**
 * Revision-layer spellings of the task-001 protected values. The task-005
 * revision store persists the protected underlying-outcome EV number as
 * `underlyingOutcomeEvMinorUnits` and the protected draw semantics as
 * `drawMultiplier` (see `PackScoutBuybackEvRevisionMetricsV1`), so a payload
 * carrying either spelling leaks the same protected evidence as
 * `protectedEvidence.underlyingOutcomeEvMoney` and must be rejected
 * identically. `packPriceMinorUnits` is deliberately absent: the pack price
 * is public (`price` on every repack projection) and the spelling appears in
 * the legitimate in-memory metric-invariant shape.
 */
const PUBLIC_EV_PROTECTED_REVISION_SPELLINGS_V1 = [
  "underlyingOutcomeEvMinorUnits",
  "drawMultiplier",
] as const;

/**
 * Public keys that must never appear anywhere inside a public catalog
 * payload. Every leaf segment of the task-001 protected field names is
 * included, plus the revision-layer spellings of the same protected values,
 * and the shared publication-fragment scan additionally rejects raw-like
 * provider keys (rawPayload, providerResponse, and similar).
 */
export const PUBLIC_EV_PROTECTED_FIELD_KEYS_V1: ReadonlySet<string> =
  new Set([
    ...PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1.flatMap((path) =>
      path.split(".").map(normalizeProtectedPublicationFieldKey),
    ),
    ...PUBLIC_EV_PROTECTED_REVISION_SPELLINGS_V1.map(
      normalizeProtectedPublicationFieldKey,
    ),
  ]);

export function containsProtectedEvPublicationKeyV1(value: unknown): boolean {
  return containsNormalizedProtectedPublicationField(
    value,
    PUBLIC_EV_PROTECTED_FIELD_KEYS_V1,
  );
}

export const packScoutPublicEvMetricsV1Schema = z
  .object({
    grossEvMoney: packScoutBuybackEvCanonicalUsdMoneyV1Schema,
    grossReturnBasisPoints: safeIntegerSchema,
    evDollars: packScoutBuybackEvSignedCanonicalUsdMoneyV1Schema,
    evPercentBasisPoints: safeIntegerSchema,
  })
  .strict()
  .superRefine((metrics, context) => {
    if (
      metrics.evPercentBasisPoints !== metrics.grossReturnBasisPoints - 10_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["evPercentBasisPoints"],
        message: "data_release_v3.ev_percent_inconsistent",
      });
    }
    if (!packScoutPublicEvMetricsAreNonpositiveV1(metrics)) {
      context.addIssue({
        code: "custom",
        message: "data_release_v3.positive_public_ev_forbidden",
      });
    }
  });


export const PUBLIC_BUYBACK_SUMMARY_KINDS_V1 = Object.freeze([
  "uniform_rate",
  "varies_by_outcome",
  "fixed_or_final_payout",
  "not_documented",
  "unavailable",
] as const);

export type PublicBuybackSummaryKindV1 =
  (typeof PUBLIC_BUYBACK_SUMMARY_KINDS_V1)[number];

/**
 * The bounded public buyback summary. A numeric rate is honest only for a
 * documented uniform rate; no other kind may carry basis points, and no
 * per-outcome term, payout formula, or synthetic average is representable.
 */
export const publicBuybackSummaryV1Schema = z.discriminatedUnion("kind", [
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

const publicReportedMoneyV1Schema = z
  .object({
    minorUnits: nonNegativeSafeIntegerSchema,
    currency: z.string().regex(/^[A-Z0-9]{2,12}$/u),
  })
  .strict();

const vendorReportedUsdComparisonV1Schema = z.discriminatedUnion("status", [
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
export const vendorReportedEvV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      sourceMoney: publicReportedMoneyV1Schema,
      usdComparison: vendorReportedUsdComparisonV1Schema,
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
