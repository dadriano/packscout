import { z } from "zod";
import {
  isStrictlySortedUnique,
  nonBlankTextSchema,
  canonicalArraySchema,
  publicCollectibleTypeSchema,
  publicHttpsUrlSchema,
  publicImageSchema,
  publicPriceSchema,
  publicRepackActionsSchema,
  publicRepackIdSchema,
  publicVendorIdSchema,
  publicVendorKeySchema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import {
  publicContentModeSchema,
  publicContentSummarySchema,
  publicRepackAvailabilitySchema,
  publicRepackCategorySchema,
  publicRepackChaseSchema,
  publicRepackFormatSchema,
} from "./data-release-v2-entities.ts";
import { packScoutBuybackEvMetricsAreConsistentV1 } from "./buyback-adjusted-ev-v1-calculation.ts";
import {
  containsProtectedEvPublicationKeyV3,
  packScoutPublicEvV3IsPresentableAt,
  publicBuybackSummaryV3Schema,
  publicEvEstimatesV3Schema,
} from "./data-release-v3-ev-estimates.ts";

const repackSummaryV3Shape = {
  publicRepackId: publicRepackIdSchema,
  publicVendorId: publicVendorIdSchema,
  vendorKey: publicVendorKeySchema,
  vendorDisplayName: nonBlankTextSchema(100),
  vendorLogoUrl: publicHttpsUrlSchema.nullable(),
  name: nonBlankTextSchema(200),
  format: publicRepackFormatSchema,
  contentMode: publicContentModeSchema,
  categories: z
    .array(publicRepackCategorySchema)
    .max(32)
    .refine(
      (values) =>
        isStrictlySortedUnique(values, ({ publicCategoryId }) => publicCategoryId),
      { message: "data_release_v3.categories_not_canonical" },
    ),
  collectibleTypes: canonicalArraySchema(publicCollectibleTypeSchema, 8),
  availability: publicRepackAvailabilitySchema,
  price: publicPriceSchema,
  buyback: publicBuybackSummaryV3Schema,
  primaryImage: publicImageSchema.nullable(),
  evEstimates: publicEvEstimatesV3Schema,
  topChase: publicRepackChaseSchema.nullable(),
  contentSummary: publicContentSummarySchema,
  actionAvailability: z
    .object({ promo: z.boolean(), repackLink: z.boolean() })
    .strict(),
  sourceUpdatedAt: timestampSchema,
} as const;

type RepackSummaryV3Input = z.infer<z.ZodObject<typeof repackSummaryV3Shape>>;

function validateRepackSummaryV3(
  repack: RepackSummaryV3Input,
  context: z.RefinementCtx,
): void {
  if (
    repack.contentSummary.categoryCount !== repack.categories.length ||
    repack.contentSummary.collectibleTypeCount !== repack.collectibleTypes.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["contentSummary"],
      message: "data_release_v3.content_count_mismatch",
    });
  }
  if (
    repack.topChase !== null &&
    (repack.topChase.publicRepackId !== repack.publicRepackId ||
      repack.topChase.role !== "top_chase")
  ) {
    context.addIssue({
      code: "custom",
      path: ["topChase"],
      message: "data_release_v3.top_chase_mismatch",
    });
  }

  const packScout = repack.evEstimates.packScout;
  if (packScout.status === "current" || packScout.status === "sold_out_historical") {
    if (repack.price.usdComparison.status !== "available") {
      context.addIssue({
        code: "custom",
        path: ["evEstimates", "packScout"],
        message: "data_release_v3.comparable_price_required",
      });
    } else if (
      !packScoutBuybackEvMetricsAreConsistentV1({
        grossEvMinorUnits: packScout.metrics.grossEvMoney.minorUnits,
        grossReturnBasisPoints: packScout.metrics.grossReturnBasisPoints,
        evDollarsMinorUnits: packScout.metrics.evDollars.minorUnits,
        evPercentBasisPoints: packScout.metrics.evPercentBasisPoints,
        packPriceMinorUnits: repack.price.usdComparison.value.minorUnits,
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["evEstimates", "packScout", "metrics"],
        message: "data_release_v3.metric_price_inconsistent",
      });
    }
  }

  if (repack.availability === "active" && packScout.status === "sold_out_historical") {
    context.addIssue({
      code: "custom",
      path: ["evEstimates", "packScout", "status"],
      message: "data_release_v3.historical_on_active_repack",
    });
  }
  if (repack.availability === "sold_out" && packScout.status === "current") {
    context.addIssue({
      code: "custom",
      path: ["evEstimates", "packScout", "status"],
      message: "data_release_v3.current_on_sold_out_repack",
    });
  }
  if (repack.buyback.kind === "not_documented" && packScout.status === "current") {
    context.addIssue({
      code: "custom",
      path: ["buyback"],
      message: "data_release_v3.undocumented_buyback_with_current_ev",
    });
  }
}

export const publicRepackSummaryV3Schema = z
  .object(repackSummaryV3Shape)
  .strict()
  .superRefine(validateRepackSummaryV3);

export const publicRepackDetailV3Schema = z
  .object({
    ...repackSummaryV3Shape,
    description: nonBlankTextSchema(4_000).nullable(),
    actions: publicRepackActionsSchema,
  })
  .strict()
  .superRefine((repack, context) => {
    validateRepackSummaryV3(repack, context);
    if (
      repack.actionAvailability.promo !== (repack.actions.promo !== undefined) ||
      repack.actionAvailability.repackLink !==
        (repack.actions.repackLink !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actionAvailability"],
        message: "data_release_v3.action_availability_mismatch",
      });
    }
    if (repack.availability === "sold_out" && repack.actions.repackLink) {
      context.addIssue({
        code: "custom",
        path: ["actions", "repackLink"],
        message: "data_release_v3.sold_out_actionable",
      });
    }
  });

export type PublicRepackSummaryV3 = z.infer<typeof publicRepackSummaryV3Schema>;
export type PublicRepackDetailV3 = z.infer<typeof publicRepackDetailV3Schema>;

export function publicRepackSummaryV3FromDetail(
  repack: PublicRepackDetailV3,
): PublicRepackSummaryV3 {
  const summary = Object.fromEntries(
    Object.entries(repack).filter(
      ([key]) => key !== "description" && key !== "actions",
    ),
  );
  return publicRepackSummaryV3Schema.parse(summary);
}

/** Canonical bytes of one repack projection's EV estimates. */
export function packScoutEvProjectionBytesV3(projection: {
  readonly evEstimates: z.infer<typeof publicEvEstimatesV3Schema>;
}): string {
  return JSON.stringify(projection.evEstimates);
}

/**
 * Validator for cross-projection EV consistency: two projections of the
 * same repack must carry byte-equivalent EV estimates. Any semantic or
 * arithmetic divergence between summary, detail, dashboard, list,
 * desired-collectible, or selected-item projections fails closed.
 */
export function packScoutEvProjectionsAreByteEquivalentV3(
  left: {
    readonly publicRepackId: string;
    readonly evEstimates: z.infer<typeof publicEvEstimatesV3Schema>;
  },
  right: {
    readonly publicRepackId: string;
    readonly evEstimates: z.infer<typeof publicEvEstimatesV3Schema>;
  },
): boolean {
  return (
    left.publicRepackId === right.publicRepackId &&
    packScoutEvProjectionBytesV3(left) === packScoutEvProjectionBytesV3(right)
  );
}

export type SafeParsePublicRepackDetailV3Failure =
  | "protected_field_present"
  | "schema_invalid"
  | "current_past_deadline";

export type SafeParsePublicRepackDetailV3Result =
  | { readonly success: true; readonly detail: PublicRepackDetailV3 }
  | {
      readonly success: false;
      readonly reason: SafeParsePublicRepackDetailV3Failure;
    };

/**
 * Fail-closed parse for one public repack detail: protected or raw-like
 * keys are rejected at every nesting level before schema validation, and a
 * current PackScout estimate is rejected after its exact expiry deadline.
 */
export function safeParsePublicRepackDetailV3(
  input: unknown,
  referenceTimeIso: string,
): SafeParsePublicRepackDetailV3Result {
  if (containsProtectedEvPublicationKeyV3(input)) {
    return { success: false, reason: "protected_field_present" };
  }
  const parsed = publicRepackDetailV3Schema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reason: "schema_invalid" };
  }
  if (
    !packScoutPublicEvV3IsPresentableAt(
      parsed.data.evEstimates.packScout,
      referenceTimeIso,
    )
  ) {
    return { success: false, reason: "current_past_deadline" };
  }
  return { success: true, detail: parsed.data };
}
