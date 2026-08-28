import { z } from "zod";
import {
  dataReleaseMetadataSchema,
  publicCategoryIdSchema,
  publicCollectibleSchema,
  publicCollectibleTypeSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicRepackIdSchema,
  publicRepackSummaryFromDetail,
  publicRepackSummarySchema,
  publicVendorKeySchema,
  type PublicRepackDetail,
  type PublicRepackSummary,
} from "./data-release-v2.ts";
import {
  publicRepackHeatSchema,
  type PublicRepackHeat,
} from "./repack-heat.ts";
import {
  acceptedRepackQuerySchema,
  publicOpaqueCursorSchema,
  publicRepackFiltersSchema,
} from "./public-repacks-query.ts";

export const publicReadErrorCodeSchema = z.enum([
  "INVALID_QUERY",
  "CURSOR_EXPIRED",
  "RELEASE_UNAVAILABLE",
  "REPACK_NOT_FOUND",
  "COLLECTIBLE_NOT_FOUND",
]);

export type PublicReadErrorCode = z.infer<typeof publicReadErrorCodeSchema>;

export const PUBLIC_READ_ERRORS = Object.freeze({
  INVALID_QUERY: Object.freeze({
    error: "Repack query is invalid.",
    retryable: false,
  }),
  CURSOR_EXPIRED: Object.freeze({
    error: "This repack page has expired.",
    retryable: false,
  }),
  RELEASE_UNAVAILABLE: Object.freeze({
    error: "Repack data is temporarily unavailable.",
    retryable: true,
  }),
  REPACK_NOT_FOUND: Object.freeze({
    error: "Repack not found.",
    retryable: false,
  }),
  COLLECTIBLE_NOT_FOUND: Object.freeze({
    error: "Collectible not found.",
    retryable: false,
  }),
} satisfies Readonly<
  Record<PublicReadErrorCode, { readonly error: string; readonly retryable: boolean }>
>);

export const publicReadErrorSchema = z.discriminatedUnion("code", [
  z.object({
    ok: z.literal(false),
    code: z.literal("INVALID_QUERY"),
    error: z.literal(PUBLIC_READ_ERRORS.INVALID_QUERY.error),
    retryable: z.literal(false),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.literal("CURSOR_EXPIRED"),
    error: z.literal(PUBLIC_READ_ERRORS.CURSOR_EXPIRED.error),
    retryable: z.literal(false),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.literal("RELEASE_UNAVAILABLE"),
    error: z.literal(PUBLIC_READ_ERRORS.RELEASE_UNAVAILABLE.error),
    retryable: z.literal(true),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.literal("REPACK_NOT_FOUND"),
    error: z.literal(PUBLIC_READ_ERRORS.REPACK_NOT_FOUND.error),
    retryable: z.literal(false),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.literal("COLLECTIBLE_NOT_FOUND"),
    error: z.literal(PUBLIC_READ_ERRORS.COLLECTIBLE_NOT_FOUND.error),
    retryable: z.literal(false),
  }).strict(),
]);

export type PublicReadError = z.infer<typeof publicReadErrorSchema>;

export function publicReadError(code: PublicReadErrorCode): PublicReadError {
  return Object.freeze({ ok: false, code, ...PUBLIC_READ_ERRORS[code] }) as PublicReadError;
}

export function publicResultSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z.union([
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    publicReadErrorSchema,
  ]);
}

export type PublicResult<T> =
  | { readonly ok: true; readonly data: T }
  | PublicReadError;

export const contextualFacetOptionSchema = z
  .object({
    key: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(100),
    repackCount: z.number().int().safe().min(0),
    selected: z.boolean(),
  })
  .strict();

function canonicalKeyOrder<T extends { readonly key: string }>(
  values: readonly T[],
): boolean {
  return values.every(
    ({ key }, index) => index === 0 || values[index - 1]!.key < key,
  );
}

function canonicalFacetList(keySchema: z.ZodType<string>, maximum: number) {
  return z
    .array(contextualFacetOptionSchema.extend({ key: keySchema }))
    .max(maximum)
    .refine(canonicalKeyOrder, { message: "public_facets.not_canonical" });
}

export const categoryFacetOptionSchema = contextualFacetOptionSchema
  .extend({
    key: publicCategoryIdSchema,
    parentKey: publicCategoryIdSchema.nullable(),
    depth: z.number().int().min(0).max(12),
  })
  .strict();

export const contextualRepackFacetsSchema = z
  .object({
    vendors: canonicalFacetList(publicVendorKeySchema, 128),
    categories: z
      .array(categoryFacetOptionSchema)
      .max(4_096)
      .refine(canonicalKeyOrder, { message: "public_facets.not_canonical" }),
    collectibleTypes: canonicalFacetList(publicCollectibleTypeSchema, 8),
  })
  .strict();

const nullableMetricSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("available"), basisPoints: z.number().int().safe() })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      basisPoints: z.null(),
      reason: z.literal("ESTIMATE_UNAVAILABLE"),
    })
    .strict(),
]);

export const dashboardKpisSchema = z
  .object({
    totalRepacks: z.number().int().safe().min(0),
    positiveEvRepacks: z.number().int().safe().min(0),
    medianPackScoutEvPercent: nullableMetricSchema,
    highestChaseValueUsdMinor: z.number().int().safe().min(0).nullable(),
    highConfidenceRepacks: z.number().int().safe().min(0),
  })
  .strict()
  .refine(
    ({
      totalRepacks,
      positiveEvRepacks,
      highConfidenceRepacks,
    }) =>
      positiveEvRepacks <= totalRepacks &&
      highConfidenceRepacks <= totalRepacks,
    { message: "public_dashboard.count_invalid" },
  );

export const repackSummaryGroupSchema = z
  .object({
    key: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(100),
    repackCount: z.number().int().safe().min(0),
    medianPackScoutEvPercent: nullableMetricSchema,
  })
  .strict();

export type PublicRepackViewSummary = PublicRepackSummary &
  Readonly<{ heat: PublicRepackHeat }>;
export type PublicRepackViewDetail = PublicRepackDetail &
  Readonly<{ heat: PublicRepackHeat }>;

export const publicRepackViewSummarySchema: z.ZodType<PublicRepackViewSummary> =
  publicRepackSummarySchema.safeExtend({ heat: publicRepackHeatSchema });
export const publicRepackViewDetailSchema: z.ZodType<PublicRepackViewDetail> =
  publicRepackDetailSchema.safeExtend({ heat: publicRepackHeatSchema });

export function publicRepackViewSummaryFromDetail(
  detail: PublicRepackViewDetail,
): PublicRepackViewSummary {
  const { heat, ...baseDetail } = detail;
  return publicRepackViewSummarySchema.parse({
    ...publicRepackSummaryFromDetail(baseDetail),
    heat,
  });
}

function summaryMatchesDetail(
  summary: PublicRepackViewSummary,
  detail: PublicRepackViewDetail | undefined,
): boolean {
  return (
    detail !== undefined &&
    JSON.stringify(summary) ===
      JSON.stringify(publicRepackViewSummaryFromDetail(detail))
  );
}

function collectibleDisplayFromPublic(
  collectible: z.infer<typeof publicCollectibleSchema>,
) {
  return {
    publicCollectibleId: collectible.publicCollectibleId,
    name: collectible.name,
    collectibleType: collectible.collectibleType,
    publicCategoryIds: collectible.publicCategoryIds,
    primaryImage: collectible.primaryImage,
    valuation: collectible.valuation,
  };
}

export const dashboardBundleSchema = z
  .object({
    metadata: dataReleaseMetadataSchema,
    kpis: dashboardKpisSchema,
    opportunities: z.array(publicRepackViewSummarySchema).max(6),
    details: z.array(publicRepackViewDetailSchema).max(6),
    vendorSummaries: z.array(repackSummaryGroupSchema).max(5),
    categorySummaries: z.array(repackSummaryGroupSchema).max(5),
    facets: contextualRepackFacetsSchema,
    activeFilters: publicRepackFiltersSchema,
    selectedRepack: publicRepackViewDetailSchema.nullable(),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (
      bundle.opportunities.length !== bundle.details.length ||
      bundle.opportunities.some(
        (summary, index) => !summaryMatchesDetail(summary, bundle.details[index]),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["details"],
        message: "public_dashboard.opportunity_details_mismatch",
      });
    }
    bundle.opportunities.forEach((repack, index) => {
      if (
        repack.availability !== "available" ||
        repack.evEstimates.packScout.status !== "available"
      ) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", index],
          message: "public_dashboard.opportunity_ineligible",
        });
      }
      const previous = bundle.opportunities[index - 1];
      if (
        previous?.evEstimates.packScout.status === "available" &&
        repack.evEstimates.packScout.status === "available" &&
        (previous.evEstimates.packScout.metrics.evDollars.minorUnits <
          repack.evEstimates.packScout.metrics.evDollars.minorUnits ||
          (previous.evEstimates.packScout.metrics.evDollars.minorUnits ===
            repack.evEstimates.packScout.metrics.evDollars.minorUnits &&
            previous.publicRepackId >= repack.publicRepackId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", index],
          message: "public_dashboard.opportunities_not_canonical",
        });
      }
    });
    if (
      (bundle.opportunities.length === 0) !== (bundle.selectedRepack === null) ||
      (bundle.selectedRepack !== null &&
        !bundle.opportunities.some(
          ({ publicRepackId }) =>
            publicRepackId === bundle.selectedRepack?.publicRepackId,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedRepack"],
        message: "public_dashboard.selection_mismatch",
      });
    }
  });

export const publicShellStatusSchema = z
  .object({ metadata: dataReleaseMetadataSchema })
  .strict();

export const repackPageRangeSchema = z
  .object({
    start: z.number().int().safe().min(0),
    end: z.number().int().safe().min(0),
    total: z.number().int().safe().min(0),
  })
  .strict()
  .superRefine((range, context) => {
    if (
      range.end > range.total ||
      (range.total === 0 && (range.start !== 0 || range.end !== 0)) ||
      (range.total > 0 && (range.start < 1 || range.end < range.start))
    ) {
      context.addIssue({ code: "custom", message: "public_repacks.range_invalid" });
    }
  });

export const desiredChasePageMatchSchema = z
  .object({
    publicRepackId: publicRepackIdSchema,
    chase: publicRepackChaseSchema,
  })
  .strict()
  .refine(
    ({ publicRepackId, chase }) => publicRepackId === chase.publicRepackId,
    { path: ["chase"], message: "public_desired_chase.repack_mismatch" },
  );

export const listPublicRepacksPageSchema = z
  .object({
    metadata: dataReleaseMetadataSchema,
    rows: z.array(publicRepackViewSummarySchema).max(50),
    details: z.array(publicRepackViewDetailSchema).max(50),
    selectedRepack: publicRepackViewDetailSchema.nullable(),
    selectedRepackEligible: z.boolean(),
    desiredCollectible: publicCollectibleSchema.nullable(),
    desiredChaseMatches: z.array(desiredChasePageMatchSchema).max(50),
    facets: contextualRepackFacetsSchema,
    activeQuery: acceptedRepackQuerySchema,
    queryFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    nextCursor: publicOpaqueCursorSchema.nullable(),
    hasPrevious: z.boolean(),
    range: repackPageRangeSchema,
    paginationReset: z.literal("release_changed").nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    if (
      page.rows.length !== page.details.length ||
      page.rows.some((summary, index) => !summaryMatchesDetail(summary, page.details[index]))
    ) {
      context.addIssue({
        code: "custom",
        path: ["details"],
        message: "public_repacks.row_details_mismatch",
      });
    }
    const visibleCount =
      page.range.total === 0 ? 0 : page.range.end - page.range.start + 1;
    if (visibleCount !== page.rows.length) {
      context.addIssue({
        code: "custom",
        path: ["range"],
        message: "public_repacks.range_row_mismatch",
      });
    }
    if (
      page.selectedRepackEligible !== (page.selectedRepack !== null) ||
      (page.selectedRepack !== null &&
        !page.rows.some(
          ({ publicRepackId }) =>
            publicRepackId === page.selectedRepack?.publicRepackId,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedRepackEligible"],
        message: "public_repacks.selection_mismatch",
      });
    }
    if (
      page.paginationReset === "release_changed" &&
      (page.hasPrevious || (page.range.total > 0 && page.range.start !== 1))
    ) {
      context.addIssue({
        code: "custom",
        path: ["paginationReset"],
        message: "public_repacks.reset_not_first_page",
      });
    }
    const desiredId = page.activeQuery.desiredPublicCollectibleId;
    if (desiredId === null) {
      if (
        page.desiredCollectible !== null ||
        page.desiredChaseMatches.length !== 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["desiredCollectible"],
          message: "public_desired_chase.inactive_has_matches",
        });
      }
      return;
    }
    const rowIds = page.rows.map(({ publicRepackId }) => publicRepackId);
    const matchIds = page.desiredChaseMatches.map(
      ({ publicRepackId }) => publicRepackId,
    );
    if (
      page.desiredCollectible?.publicCollectibleId !== desiredId ||
      !page.desiredChaseMatches.every(
        ({ chase }) =>
          chase.publicCollectibleId === desiredId &&
          page.desiredCollectible !== null &&
          JSON.stringify(chase.collectible) ===
            JSON.stringify(collectibleDisplayFromPublic(page.desiredCollectible)),
      ) ||
      new Set(matchIds).size !== matchIds.length ||
      rowIds.length !== matchIds.length ||
      rowIds.some((rowId) => !matchIds.includes(rowId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["desiredChaseMatches"],
        message: "public_desired_chase.row_matches_incomplete",
      });
    }
  });

export const publicCollectibleSearchResultsSchema = z
  .object({
    metadata: dataReleaseMetadataSchema,
    matches: z.array(publicCollectibleSchema).max(20),
  })
  .strict()
  .refine(
    ({ matches }) =>
      new Set(matches.map(({ publicCollectibleId }) => publicCollectibleId)).size ===
      matches.length,
    { path: ["matches"], message: "public_collectible_search.duplicate" },
  );

export const desiredCollectibleRepackMatchSchema = z
  .object({
    repack: publicRepackViewSummarySchema,
    chase: publicRepackChaseSchema,
  })
  .strict()
  .refine(
    ({ repack, chase }) => repack.publicRepackId === chase.publicRepackId,
    { path: ["chase"], message: "public_desired_collectible.repack_mismatch" },
  );

export const desiredCollectibleRepackResultsSchema = z
  .object({
    metadata: dataReleaseMetadataSchema,
    desiredCollectible: publicCollectibleSchema,
    matches: z.array(desiredCollectibleRepackMatchSchema).max(50),
    total: z.number().int().safe().min(0),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.total < result.matches.length) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "public_desired_collectible.total_invalid",
      });
    }
    if (
      result.matches.some(
        ({ chase }) =>
          chase.publicCollectibleId !== result.desiredCollectible.publicCollectibleId ||
          JSON.stringify(chase.collectible) !==
            JSON.stringify(
              collectibleDisplayFromPublic(result.desiredCollectible),
            ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["matches"],
        message: "public_desired_collectible.identity_mismatch",
      });
    }
  });

export const getPublicShellStatusResultSchema = publicResultSchema(
  publicShellStatusSchema,
);
export const getDashboardBundleResultSchema = publicResultSchema(
  dashboardBundleSchema,
);
export const listPublicRepacksResultSchema = publicResultSchema(
  listPublicRepacksPageSchema,
);
export const getPublicRepackResultSchema = publicResultSchema(
  publicRepackViewDetailSchema,
);
export const searchPublicCollectiblesResultSchema = publicResultSchema(
  publicCollectibleSearchResultsSchema,
);
export const findRepacksByDesiredCollectibleResultSchema = publicResultSchema(
  desiredCollectibleRepackResultsSchema,
);

export type ContextualRepackFacets = z.infer<
  typeof contextualRepackFacetsSchema
>;
export type CategoryFacetOption = z.infer<typeof categoryFacetOptionSchema>;
export type DashboardKpis = z.infer<typeof dashboardKpisSchema>;
export type DashboardBundle = z.infer<typeof dashboardBundleSchema>;
export type PublicShellStatus = z.infer<typeof publicShellStatusSchema>;
export type RepackPageRange = z.infer<typeof repackPageRangeSchema>;
export type ListPublicRepacksPage = z.infer<
  typeof listPublicRepacksPageSchema
>;
export type DesiredChasePageMatch = z.infer<
  typeof desiredChasePageMatchSchema
>;
export type PublicCollectibleSearchResults = z.infer<
  typeof publicCollectibleSearchResultsSchema
>;
export type DesiredCollectibleRepackMatch = z.infer<
  typeof desiredCollectibleRepackMatchSchema
>;
export type DesiredCollectibleRepackResults = z.infer<
  typeof desiredCollectibleRepackResultsSchema
>;
export type GetPublicShellStatusResult = PublicResult<PublicShellStatus>;
export type GetDashboardBundleResult = PublicResult<DashboardBundle>;
export type ListPublicRepacksResult = PublicResult<ListPublicRepacksPage>;
export type GetPublicRepackResult = PublicResult<PublicRepackViewDetail>;
export type SearchPublicCollectiblesResult = PublicResult<
  PublicCollectibleSearchResults
>;
export type FindRepacksByDesiredCollectibleResult = PublicResult<
  DesiredCollectibleRepackResults
>;
