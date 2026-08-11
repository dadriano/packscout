import { z } from "zod";
import {
  publicBasisPointsSchema,
  publicFacetKeySchema,
  publicPackDetailSchema,
  publicPackIdSchema,
  publicPackSummarySchema,
  publicPlatformKeySchema,
  publicSha256Schema,
  publicSortableValueSchema,
  publicUsdMoneySchema,
  snapshotMetadataSchema,
  type PublicPackDetail,
} from "./catalog-snapshot-v1.ts";

export const PUBLIC_CATALOG_PRICE_MIN_MINOR = 1_000 as const;
export const PUBLIC_CATALOG_PRICE_MAX_MINOR = 1_200_000 as const;
export const PUBLIC_CATALOG_DEFAULT_PAGE_SIZE = 25 as const;
export const PUBLIC_CATALOG_MAX_PAGE_SIZE = 50 as const;
export const PUBLIC_CATALOG_MAX_SEARCH_LENGTH = 120 as const;

export const publicReadErrorCodeSchema = z.enum([
  "INVALID_QUERY",
  "CURSOR_EXPIRED",
  "SNAPSHOT_UNAVAILABLE",
  "PACK_NOT_FOUND",
]);

export type PublicReadErrorCode = z.infer<typeof publicReadErrorCodeSchema>;

export const PUBLIC_READ_ERRORS = Object.freeze({
  INVALID_QUERY: Object.freeze({
    error: "Catalog query is invalid.",
    retryable: false,
  }),
  CURSOR_EXPIRED: Object.freeze({
    error: "This catalog page has expired.",
    retryable: false,
  }),
  SNAPSHOT_UNAVAILABLE: Object.freeze({
    error: "Pack data is temporarily unavailable.",
    retryable: true,
  }),
  PACK_NOT_FOUND: Object.freeze({
    error: "Pack not found.",
    retryable: false,
  }),
} satisfies Readonly<
  Record<PublicReadErrorCode, { readonly error: string; readonly retryable: boolean }>
>);

export const publicReadErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      ok: z.literal(false),
      code: z.literal("INVALID_QUERY"),
      error: z.literal(PUBLIC_READ_ERRORS.INVALID_QUERY.error),
      retryable: z.literal(PUBLIC_READ_ERRORS.INVALID_QUERY.retryable),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.literal("CURSOR_EXPIRED"),
      error: z.literal(PUBLIC_READ_ERRORS.CURSOR_EXPIRED.error),
      retryable: z.literal(PUBLIC_READ_ERRORS.CURSOR_EXPIRED.retryable),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.literal("SNAPSHOT_UNAVAILABLE"),
      error: z.literal(PUBLIC_READ_ERRORS.SNAPSHOT_UNAVAILABLE.error),
      retryable: z.literal(PUBLIC_READ_ERRORS.SNAPSHOT_UNAVAILABLE.retryable),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.literal("PACK_NOT_FOUND"),
      error: z.literal(PUBLIC_READ_ERRORS.PACK_NOT_FOUND.error),
      retryable: z.literal(PUBLIC_READ_ERRORS.PACK_NOT_FOUND.retryable),
    })
    .strict(),
]);

export type PublicReadError = z.infer<typeof publicReadErrorSchema>;

export function publicReadError(code: PublicReadErrorCode): PublicReadError {
  return Object.freeze({ ok: false, code, ...PUBLIC_READ_ERRORS[code] }) as PublicReadError;
}

export function publicResultSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
) {
  return z.union([
    z.object({ ok: z.literal(true), data: dataSchema }).strict(),
    publicReadErrorSchema,
  ]);
}

export type PublicResult<T> =
  | { readonly ok: true; readonly data: T }
  | PublicReadError;

export function normalizePublicSearchText(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const token of normalized.split(" ")) {
    if (token.length > 0 && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens.join(" ");
}

const normalizedSearchSchema = z
  .string()
  .max(1_024)
  .transform(normalizePublicSearchText)
  .refine((value) => value.length <= PUBLIC_CATALOG_MAX_SEARCH_LENGTH, {
    message: "public_query.search_too_long",
  });

function canonicalSelectionSchema<TSchema extends z.ZodType<string>>(
  valueSchema: TSchema,
) {
  return z
    .array(valueSchema)
    .max(64)
    .transform((values) => Object.freeze([...new Set(values)].sort()));
}

export const publicPriceFilterSchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("full"),
        minMinor: z.literal(PUBLIC_CATALOG_PRICE_MIN_MINOR),
        maxMinor: z.literal(PUBLIC_CATALOG_PRICE_MAX_MINOR),
      })
      .strict(),
    z
      .object({
        mode: z.literal("narrowed"),
        minMinor: z
          .number()
          .int()
          .min(PUBLIC_CATALOG_PRICE_MIN_MINOR)
          .max(PUBLIC_CATALOG_PRICE_MAX_MINOR),
        maxMinor: z
          .number()
          .int()
          .min(PUBLIC_CATALOG_PRICE_MIN_MINOR)
          .max(PUBLIC_CATALOG_PRICE_MAX_MINOR),
      })
      .strict(),
  ])
  .superRefine((price, context) => {
    if (price.minMinor > price.maxMinor) {
      context.addIssue({
        code: "custom",
        path: ["minMinor"],
        message: "public_query.price_inverted",
      });
    }
    if (
      price.mode === "narrowed" &&
      price.minMinor === PUBLIC_CATALOG_PRICE_MIN_MINOR &&
      price.maxMinor === PUBLIC_CATALOG_PRICE_MAX_MINOR
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "public_query.full_price_mode_required",
      });
    }
  });

export type PublicPriceFilter = z.infer<typeof publicPriceFilterSchema>;

const defaultPriceFilter = Object.freeze({
  mode: "full" as const,
  minMinor: PUBLIC_CATALOG_PRICE_MIN_MINOR,
  maxMinor: PUBLIC_CATALOG_PRICE_MAX_MINOR,
});

const defaultCatalogFilters = Object.freeze({
  platforms: Object.freeze([] as string[]),
  categories: Object.freeze([] as string[]),
  price: defaultPriceFilter,
});

export const publicCatalogFiltersSchema = z
  .object({
    platforms: canonicalSelectionSchema(publicPlatformKeySchema).default([]),
    categories: canonicalSelectionSchema(publicFacetKeySchema).default([]),
    price: publicPriceFilterSchema.default(defaultPriceFilter),
  })
  .strict();

export type PublicCatalogFilters = z.infer<
  typeof publicCatalogFiltersSchema
>;

export const publicCatalogSortSchema = z.enum([
  "pack",
  "pack_price",
  "ev_dollars",
  "ev_percent",
  "buyback_percent",
  "gross_ev",
  "top_chase_value",
]);

export type PublicCatalogSort = z.infer<typeof publicCatalogSortSchema>;

export const dashboardQueryInputSchema = z
  .object({
    filters: publicCatalogFiltersSchema.default(defaultCatalogFilters),
    selectedPublicPackId: publicPackIdSchema.nullable().default(null),
  })
  .strict();

export type DashboardQueryInput = z.infer<typeof dashboardQueryInputSchema>;

export const publicOpaqueCursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,2048}$/);

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]{1,4096}$/);

function encodeBase64UrlAscii(value: string): string {
  return globalThis
    .btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodePublicCursorStack(
  value: string,
): readonly string[] | null {
  if (!base64UrlSchema.safeParse(value).success) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = globalThis.atob(
      base64 + "=".repeat((4 - (base64.length % 4)) % 4),
    );
    const parsed: unknown = JSON.parse(decoded);
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length > 40 ||
      !parsed.every(
        (entry) => publicOpaqueCursorSchema.safeParse(entry).success,
      ) ||
      encodeBase64UrlAscii(JSON.stringify(parsed)) !== value
    ) {
      return null;
    }
    return Object.freeze([...parsed]) as readonly string[];
  } catch {
    return null;
  }
}

export function encodePublicCursorStack(cursors: readonly string[]): string {
  const parsed = z
    .array(publicOpaqueCursorSchema)
    .min(1)
    .max(40)
    .parse(cursors);
  const encoded = encodeBase64UrlAscii(JSON.stringify(parsed));
  return publicCursorStackSchema.parse(encoded);
}

export const publicCursorStackSchema = base64UrlSchema.refine(
  (value) => decodePublicCursorStack(value) !== null,
  { message: "public_query.cursor_stack_invalid" },
);

export const listPublicPacksInputSchema = z
  .object({
    search: normalizedSearchSchema.default(""),
    filters: publicCatalogFiltersSchema.default(defaultCatalogFilters),
    sort: publicCatalogSortSchema.default("ev_dollars"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    cursor: publicOpaqueCursorSchema.nullable().default(null),
    cursorStack: publicCursorStackSchema.nullable().default(null),
    queryFingerprint: publicSha256Schema.nullable().default(null),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(PUBLIC_CATALOG_MAX_PAGE_SIZE)
      .default(PUBLIC_CATALOG_DEFAULT_PAGE_SIZE),
    selectedPublicPackId: publicPackIdSchema.nullable().default(null),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      (input.cursor !== null || input.cursorStack !== null) &&
      input.queryFingerprint === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["queryFingerprint"],
        message: "public_query.cursor_fingerprint_required",
      });
    }
  });

export type ListPublicPacksInput = z.infer<
  typeof listPublicPacksInputSchema
>;

export const getPublicPackInputSchema = z
  .object({
    publicPackId: publicPackIdSchema,
    snapshotPublicationId: z.uuid(),
  })
  .strict();

export type GetPublicPackInput = z.infer<typeof getPublicPackInputSchema>;

export const getPublicShellStatusInputSchema = z.object({}).strict();

export type GetPublicShellStatusInput = z.infer<
  typeof getPublicShellStatusInputSchema
>;

export function normalizeDashboardQueryInput(
  input: unknown,
): DashboardQueryInput {
  return dashboardQueryInputSchema.parse(input);
}

export function normalizeListPublicPacksInput(
  input: unknown,
): ListPublicPacksInput {
  return listPublicPacksInputSchema.parse(input);
}

export const contextualFacetOptionSchema = z
  .object({
    key: publicFacetKeySchema,
    label: z.string().trim().min(1).max(100),
    packCount: z.number().int().safe().min(0),
    selected: z.boolean(),
  })
  .strict();

export const contextualCatalogFacetsSchema = z
  .object({
    platforms: z
      .array(contextualFacetOptionSchema)
      .max(64)
      .refine(
        (values) =>
          values.every(
            ({ key }, index) => index === 0 || values[index - 1]!.key < key,
          ),
        { message: "public_facets.platforms_not_canonical" },
      ),
    categories: z
      .array(contextualFacetOptionSchema)
      .max(64)
      .refine(
        (values) =>
          values.every(
            ({ key }, index) => index === 0 || values[index - 1]!.key < key,
          ),
        { message: "public_facets.categories_not_canonical" },
      ),
  })
  .strict();

export type ContextualFacetOption = z.infer<
  typeof contextualFacetOptionSchema
>;
export type ContextualCatalogFacets = z.infer<
  typeof contextualCatalogFacetsSchema
>;

const publicMedianEvPercentSchema = publicSortableValueSchema(
  publicBasisPointsSchema,
  z.literal("ESTIMATE_INPUT_INCOMPLETE"),
);

const publicHighestChaseSchema = publicSortableValueSchema(
  publicUsdMoneySchema,
  z.enum(["CHASE_UNAVAILABLE", "CURRENCY_UNSUPPORTED"]),
);

export const dashboardKpisSchema = z
  .object({
    totalPacks: z.number().int().safe().min(0),
    positiveEvPacks: z.number().int().safe().min(0),
    medianEvPercent: publicMedianEvPercentSchema,
    highestChaseValue: publicHighestChaseSchema,
  })
  .strict()
  .refine(({ totalPacks, positiveEvPacks }) => positiveEvPacks <= totalPacks, {
    path: ["positiveEvPacks"],
    message: "public_dashboard.positive_count_invalid",
  });

export type DashboardKpis = z.infer<typeof dashboardKpisSchema>;

export const catalogSummarySchema = z
  .object({
    key: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(100),
    packCount: z.number().int().safe().min(0),
    medianEvPercent: publicMedianEvPercentSchema,
  })
  .strict();

export type CatalogSummary = z.infer<typeof catalogSummarySchema>;

export const dashboardBundleSchema = z
  .object({
    metadata: snapshotMetadataSchema,
    kpis: dashboardKpisSchema,
    opportunities: z.array(publicPackSummarySchema).max(6),
    platformSummaries: z.array(catalogSummarySchema).max(5),
    categorySummaries: z.array(catalogSummarySchema).max(5),
    facets: contextualCatalogFacetsSchema,
    activeFilters: publicCatalogFiltersSchema,
    selectedPack: publicPackDetailSchema.nullable(),
  })
  .strict()
  .superRefine((bundle, context) => {
    bundle.opportunities.forEach((pack, index) => {
      if (
        pack.availability !== "active" ||
        pack.estimatedEv.evDollars.status !== "available"
      ) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", index],
          message: "public_dashboard.opportunity_ineligible",
        });
      }
      if (index > 0) {
        const previous = bundle.opportunities[index - 1]!;
        const previousEv = previous.estimatedEv.evDollars;
        const currentEv = pack.estimatedEv.evDollars;
        if (
          previousEv.status === "available" &&
          currentEv.status === "available" &&
          (previousEv.value.minorUnits < currentEv.value.minorUnits ||
            (previousEv.value.minorUnits === currentEv.value.minorUnits &&
              previous.publicPackId >= pack.publicPackId))
        ) {
          context.addIssue({
            code: "custom",
            path: ["opportunities", index],
            message: "public_dashboard.opportunities_not_canonical",
          });
        }
      }
    });
    if (
      (bundle.opportunities.length === 0) !== (bundle.selectedPack === null) ||
      (bundle.selectedPack !== null &&
        !bundle.opportunities.some(
          ({ publicPackId }) =>
            publicPackId === bundle.selectedPack?.publicPackId,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedPack"],
        message: "public_dashboard.selection_mismatch",
      });
    }
  });

export type DashboardBundle = z.infer<typeof dashboardBundleSchema>;

export const publicShellStatusSchema = z
  .object({ metadata: snapshotMetadataSchema })
  .strict();

export type PublicShellStatus = z.infer<typeof publicShellStatusSchema>;

export const acceptedCatalogQuerySchema = z
  .object({
    search: normalizedSearchSchema,
    filters: publicCatalogFiltersSchema,
    sort: publicCatalogSortSchema,
    direction: z.enum(["asc", "desc"]),
    pageSize: z.number().int().min(1).max(PUBLIC_CATALOG_MAX_PAGE_SIZE),
  })
  .strict();

export type AcceptedCatalogQuery = z.infer<
  typeof acceptedCatalogQuerySchema
>;

export const catalogPageRangeSchema = z
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
      context.addIssue({
        code: "custom",
        message: "public_catalog.range_invalid",
      });
    }
  });

export type CatalogPageRange = z.infer<typeof catalogPageRangeSchema>;

export const listPublicPacksPageSchema = z
  .object({
    metadata: snapshotMetadataSchema,
    rows: z.array(publicPackSummarySchema).max(PUBLIC_CATALOG_MAX_PAGE_SIZE),
    selectedPack: publicPackDetailSchema.nullable(),
    selectedPackEligible: z.boolean(),
    facets: contextualCatalogFacetsSchema,
    activeQuery: acceptedCatalogQuerySchema,
    queryFingerprint: publicSha256Schema,
    nextCursor: publicOpaqueCursorSchema.nullable(),
    hasPrevious: z.boolean(),
    range: catalogPageRangeSchema,
    paginationReset: z.enum(["snapshot_changed"]).nullable(),
  })
  .strict()
  .superRefine((page, context) => {
    const visibleCount =
      page.range.total === 0 ? 0 : page.range.end - page.range.start + 1;
    if (visibleCount !== page.rows.length) {
      context.addIssue({
        code: "custom",
        path: ["range"],
        message: "public_catalog.range_row_mismatch",
      });
    }
    if (page.rows.length === 0 && page.nextCursor !== null) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "public_catalog.empty_page_has_next_cursor",
      });
    }
    if (
      page.paginationReset === "snapshot_changed" &&
      (page.hasPrevious ||
        (page.range.total > 0 && page.range.start !== 1))
    ) {
      context.addIssue({
        code: "custom",
        path: ["paginationReset"],
        message: "public_catalog.reset_not_first_page",
      });
    }
    if (
      page.selectedPackEligible !== (page.selectedPack !== null) ||
      (page.selectedPack !== null &&
        !page.rows.some(
          ({ publicPackId }) =>
            publicPackId === page.selectedPack?.publicPackId,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedPackEligible"],
        message: "public_catalog.selection_mismatch",
      });
    }
  });

export type ListPublicPacksPage = z.infer<
  typeof listPublicPacksPageSchema
>;

export const getPublicShellStatusResultSchema = publicResultSchema(
  publicShellStatusSchema,
);
export const getDashboardBundleResultSchema = publicResultSchema(
  dashboardBundleSchema,
);
export const listPublicPacksResultSchema = publicResultSchema(
  listPublicPacksPageSchema,
);
export const getPublicPackResultSchema = publicResultSchema(
  publicPackDetailSchema,
);

export type GetPublicShellStatusResult = PublicResult<PublicShellStatus>;
export type GetDashboardBundleResult = PublicResult<DashboardBundle>;
export type ListPublicPacksResult = PublicResult<ListPublicPacksPage>;
export type GetPublicPackResult = PublicResult<PublicPackDetail>;
