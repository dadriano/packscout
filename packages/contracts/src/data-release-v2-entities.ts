import { z } from "zod";
import {
  canonicalArraySchema,
  isStrictlySortedUnique,
  normalizePublicSearchText,
  nonBlankTextSchema,
  nonNegativeIntegerSchema,
  parsedHttpsUrl,
  publicAvailableValueSchema,
  publicBuybackSchema,
  publicCategoryIdSchema,
  publicCategoryKeySchema,
  publicCategoryKindSchema,
  publicCollectibleIdSchema,
  publicCollectibleTypeSchema,
  publicEvEstimatesSchema,
  publicHostSchema,
  publicHttpsOriginSchema,
  publicHttpsUrlSchema,
  publicImageSchema,
  publicReportedMoneySchema,
  publicPriceSchema,
  publicPromoSchema,
  publicReferralParameterSchema,
  publicRepackActionsSchema,
  publicRepackIdSchema,
  publicUsdMoneySchema,
  publicVendorIdSchema,
  publicVendorKeySchema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import { publicPackAvailabilitySchema } from "./public-pack-availability-v1.ts";

export const publicVendorSchema = z
  .object({
    publicVendorId: publicVendorIdSchema,
    vendorKey: publicVendorKeySchema,
    displayName: nonBlankTextSchema(100),
    logoUrl: publicHttpsUrlSchema.nullable(),
    websiteUrl: publicHttpsUrlSchema.nullable(),
    listingHosts: canonicalArraySchema(publicHostSchema, 16),
    imageOrigins: canonicalArraySchema(publicHttpsOriginSchema, 16),
    referralParameters: z
      .array(publicReferralParameterSchema)
      .max(8)
      .refine(
        (values) => isStrictlySortedUnique(values, ({ name }) => name),
        { message: "public_referrals.not_canonical" },
      ),
    publicPromo: publicPromoSchema.nullable(),
  })
  .strict()
  .superRefine((vendor, context) => {
    if (
      vendor.logoUrl !== null &&
      !vendor.imageOrigins.includes(parsedHttpsUrl(vendor.logoUrl)?.origin ?? "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["logoUrl"],
        message: "public_vendor.logo_origin_not_approved",
      });
    }
  });

export const publicCategorySchema = z
  .object({
    publicCategoryId: publicCategoryIdSchema,
    parentPublicCategoryId: publicCategoryIdSchema.nullable(),
    categoryKey: publicCategoryKeySchema,
    name: nonBlankTextSchema(100),
    kind: publicCategoryKindSchema,
    depth: z.number().int().min(0).max(12),
    pathPublicCategoryIds: z.array(publicCategoryIdSchema).min(1).max(12),
    displayOrder: nonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((category, context) => {
    if (
      category.pathPublicCategoryIds.at(-1) !== category.publicCategoryId ||
      new Set(category.pathPublicCategoryIds).size !==
        category.pathPublicCategoryIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["pathPublicCategoryIds"],
        message: "public_category.path_invalid",
      });
    }
    if (category.depth !== category.pathPublicCategoryIds.length - 1) {
      context.addIssue({
        code: "custom",
        path: ["depth"],
        message: "public_category.depth_mismatch",
      });
    }
    const expectedParent = category.pathPublicCategoryIds.at(-2) ?? null;
    if (category.parentPublicCategoryId !== expectedParent) {
      context.addIssue({
        code: "custom",
        path: ["parentPublicCategoryId"],
        message: "public_category.parent_mismatch",
      });
    }
  });

const nullableTextSchema = (maximum: number) =>
  nonBlankTextSchema(maximum).nullable();

export type PublicCollectibleSearchIdentity = Readonly<{
  name: string;
  aliases: readonly string[];
  year: number | null;
  brand: string | null;
  setOrSeries: string | null;
  cardNumber: string | null;
  referenceNumber: string | null;
  subject: string | null;
  grade: string | null;
  grader: string | null;
}>;

export function buildPublicCollectibleSearchText(
  identity: PublicCollectibleSearchIdentity,
): string {
  return normalizePublicSearchText(
    [
      identity.name,
      ...identity.aliases,
      identity.year === null ? null : String(identity.year),
      identity.brand,
      identity.setOrSeries,
      identity.cardNumber,
      identity.referenceNumber,
      identity.subject,
      identity.grade,
      identity.grader,
    ]
      .filter((value): value is string => value !== null)
      .join(" "),
  );
}

export const publicCollectibleValuationSchema = z
  .object({
    displayMoney: publicReportedMoneySchema.nullable(),
    usdComparison: publicAvailableValueSchema(
      publicUsdMoneySchema,
      z.enum(["VALUATION_UNAVAILABLE", "CURRENCY_UNSUPPORTED"]),
    ),
    valuationType: z.enum([
      "market_estimate",
      "vendor_reported",
      "last_sale",
      "appraisal",
    ]),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((valuation, context) => {
    if (
      valuation.displayMoney?.currency === "USD" &&
      (valuation.usdComparison.status !== "available" ||
        valuation.usdComparison.value.minorUnits !==
          valuation.displayMoney.minorUnits)
    ) {
      context.addIssue({
        code: "custom",
        path: ["usdComparison"],
        message: "public_valuation.usd_evidence_mismatch",
      });
    }
    if (
      valuation.usdComparison.status === "unavailable" &&
      valuation.usdComparison.reason === "VALUATION_UNAVAILABLE" &&
      valuation.displayMoney !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["displayMoney"],
        message: "public_valuation.unavailable_has_display_money",
      });
    }
  });

export const publicCollectibleDisplaySchema = z
  .object({
    publicCollectibleId: publicCollectibleIdSchema,
    name: nonBlankTextSchema(240),
    collectibleType: publicCollectibleTypeSchema,
    publicCategoryIds: canonicalArraySchema(publicCategoryIdSchema, 32),
    primaryImage: publicImageSchema.nullable(),
    valuation: publicCollectibleValuationSchema.nullable(),
  })
  .strict();

export const publicCollectibleSchema = z
  .object({
    publicCollectibleId: publicCollectibleIdSchema,
    name: nonBlankTextSchema(240),
    normalizedName: nonBlankTextSchema(240),
    aliases: canonicalArraySchema(nonBlankTextSchema(240), 32),
    normalizedAliases: canonicalArraySchema(nonBlankTextSchema(240), 32),
    collectibleType: publicCollectibleTypeSchema,
    publicCategoryIds: canonicalArraySchema(publicCategoryIdSchema, 32),
    year: z.number().int().min(1000).max(9999).nullable(),
    brand: nullableTextSchema(120),
    setOrSeries: nullableTextSchema(200),
    cardNumber: nullableTextSchema(100),
    referenceNumber: nullableTextSchema(100),
    subject: nullableTextSchema(200),
    grade: nullableTextSchema(100),
    grader: nullableTextSchema(100),
    primaryImage: publicImageSchema.nullable(),
    valuation: publicCollectibleValuationSchema.nullable(),
    searchText: nonBlankTextSchema(1_024),
    dataAsOf: timestampSchema,
  })
  .strict()
  .superRefine((collectible, context) => {
    if (collectible.normalizedName !== normalizePublicSearchText(collectible.name)) {
      context.addIssue({
        code: "custom",
        path: ["normalizedName"],
        message: "public_collectible.normalized_name_mismatch",
      });
    }
    if (collectible.aliases.length !== collectible.normalizedAliases.length) {
      context.addIssue({
        code: "custom",
        path: ["normalizedAliases"],
        message: "public_collectible.alias_count_mismatch",
      });
    }
    const expectedNormalizedAliases = collectible.aliases
      .map(normalizePublicSearchText)
      .sort();
    if (
      collectible.normalizedAliases.some(
        (alias, index) => alias !== expectedNormalizedAliases[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["normalizedAliases"],
        message: "public_collectible.normalized_alias_mismatch",
      });
    }
    if (collectible.searchText !== buildPublicCollectibleSearchText(collectible)) {
      context.addIssue({
        code: "custom",
        path: ["searchText"],
        message: "public_collectible.search_text_mismatch",
      });
    }
  });

export const publicChaseEvidenceKindSchema = z.enum([
  "vendor_inventory",
  "vendor_odds",
  "vendor_featured_chase",
  "packscout_resolved",
  "historical_pull_inference",
  "name_only",
]);

export const publicChaseMatchConfidenceSchema = z
  .object({
    scoreBasisPoints: z.number().int().min(0).max(10_000),
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
    { path: ["band"], message: "public_chase_confidence.band_mismatch" },
  );

export const publicRepackChaseSchema = z
  .object({
    publicRepackId: publicRepackIdSchema,
    publicCollectibleId: publicCollectibleIdSchema,
    role: z.enum(["top_chase", "featured_chase", "possible_outcome"]),
    evidenceKinds: canonicalArraySchema(publicChaseEvidenceKindSchema, 8).refine(
      (values) => values.length > 0,
      { message: "public_chase.evidence_required" },
    ),
    probabilityBasisPoints: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .nullable(),
    collectible: publicCollectibleDisplaySchema,
    matchConfidence: publicChaseMatchConfidenceSchema,
    observedAt: timestampSchema,
    displayOrder: nonNegativeIntegerSchema,
  })
  .strict()
  .refine(
    (chase) =>
      chase.publicCollectibleId === chase.collectible.publicCollectibleId,
    {
      path: ["collectible", "publicCollectibleId"],
      message: "public_chase.collectible_identity_mismatch",
    },
  );

export const publicRepackFormatSchema = z.enum(["repack", "gacha"]);
export const publicContentModeSchema = z.enum(["focused", "mixed", "unknown"]);
export const publicRepackAvailabilitySchema = publicPackAvailabilitySchema;

export const publicContentSummarySchema = z
  .object({
    knownCollectibleCount: nonNegativeIntegerSchema,
    chaseCount: nonNegativeIntegerSchema,
    categoryCount: nonNegativeIntegerSchema,
    collectibleTypeCount: nonNegativeIntegerSchema,
    evidenceCompleteness: z.enum(["complete", "partial", "unknown"]),
    probabilityCoverageBasisPoints: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .nullable(),
  })
  .strict();

export const publicRepackCategorySchema = z
  .object({
    publicCategoryId: publicCategoryIdSchema,
    label: nonBlankTextSchema(100),
  })
  .strict();

const repackSummaryShape = {
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
      { message: "public_repack.categories_not_canonical" },
    ),
  collectibleTypes: canonicalArraySchema(publicCollectibleTypeSchema, 8),
  availability: publicRepackAvailabilitySchema,
  price: publicPriceSchema,
  buyback: publicBuybackSchema,
  primaryImage: publicImageSchema.nullable(),
  evEstimates: publicEvEstimatesSchema,
  topChase: publicRepackChaseSchema.nullable(),
  contentSummary: publicContentSummarySchema,
  actionAvailability: z
    .object({ promo: z.boolean(), repackLink: z.boolean() })
    .strict(),
  sourceUpdatedAt: timestampSchema,
} as const;

function roundedNonNegativeRatioHalfUp(
  numerator: number,
  denominator: number,
): bigint | null {
  if (denominator === 0) return null;
  const scaledNumerator = BigInt(numerator) * BigInt("10000");
  const exactDenominator = BigInt(denominator);
  const quotient = scaledNumerator / exactDenominator;
  const remainder = scaledNumerator % exactDenominator;
  return quotient + (
    remainder * BigInt("2") >= exactDenominator
      ? BigInt("1")
      : BigInt("0")
  );
}

function validateRepackSummary(
  repack: z.infer<z.ZodObject<typeof repackSummaryShape>>,
  context: z.RefinementCtx,
): void {
  if (
    repack.availability !== "available" &&
    (repack.actionAvailability.promo || repack.actionAvailability.repackLink)
  ) {
    context.addIssue({
      code: "custom",
      path: ["actionAvailability"],
      message: "public_repack.unavailable_actionable",
    });
  }
  if (
    repack.contentSummary.categoryCount !== repack.categories.length ||
    repack.contentSummary.collectibleTypeCount !== repack.collectibleTypes.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["contentSummary"],
      message: "public_repack.content_count_mismatch",
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
      message: "public_repack.top_chase_mismatch",
    });
  }
  for (const [estimateKey, estimate] of Object.entries(repack.evEstimates)) {
    if (estimate.status === "available") {
      if (repack.price.usdComparison.status !== "available") {
        context.addIssue({
          code: "custom",
          path: ["evEstimates", estimateKey],
          message: "public_ev.comparable_price_required",
        });
        continue;
      }
      const priceMinor = repack.price.usdComparison.value.minorUnits;
      const expectedDollars = estimate.metrics.grossEv.minorUnits - priceMinor;
      const expectedReturn = roundedNonNegativeRatioHalfUp(
        estimate.metrics.grossEv.minorUnits,
        priceMinor,
      );
      if (
        estimate.metrics.evDollars.minorUnits !== expectedDollars ||
        expectedReturn === null ||
        BigInt(estimate.metrics.grossReturnBasisPoints) !== expectedReturn
      ) {
        context.addIssue({
          code: "custom",
          path: ["evEstimates", estimateKey, "metrics"],
          message: "public_ev.price_inconsistent",
        });
      }
    }
  }
}

export const publicRepackSummarySchema = z
  .object(repackSummaryShape)
  .strict()
  .superRefine(validateRepackSummary);

export const publicRepackDetailSchema = z
  .object({
    ...repackSummaryShape,
    description: nullableTextSchema(4_000),
    actions: publicRepackActionsSchema,
  })
  .strict()
  .superRefine((repack, context) => {
    validateRepackSummary(repack, context);
    if (
      repack.actionAvailability.promo !== (repack.actions.promo !== undefined) ||
      repack.actionAvailability.repackLink !==
        (repack.actions.repackLink !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actionAvailability"],
        message: "public_repack.action_availability_mismatch",
      });
    }
    if (
      repack.availability !== "available" &&
      (repack.actions.promo !== undefined ||
        repack.actions.repackLink !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: "public_repack.unavailable_actionable",
      });
    }
  });

export function publicRepackSummaryFromDetail(
  repack: PublicRepackDetail,
): PublicRepackSummary {
  const summary = Object.fromEntries(
    Object.entries(repack).filter(
      ([key]) => key !== "description" && key !== "actions",
    ),
  );
  return publicRepackSummarySchema.parse(summary);
}

export type PublicVendor = z.infer<typeof publicVendorSchema>;
export type PublicCategory = z.infer<typeof publicCategorySchema>;
export type PublicCollectible = z.infer<typeof publicCollectibleSchema>;
export type PublicCollectibleDisplay = z.infer<
  typeof publicCollectibleDisplaySchema
>;
export type PublicRepackChase = z.infer<typeof publicRepackChaseSchema>;
export type PublicRepackCategory = z.infer<typeof publicRepackCategorySchema>;
export type PublicRepackSummary = z.infer<typeof publicRepackSummarySchema>;
export type PublicRepackDetail = z.infer<typeof publicRepackDetailSchema>;
