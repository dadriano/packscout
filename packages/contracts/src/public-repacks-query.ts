import { z } from "zod";
import {
  publicCategoryIdSchema,
  publicCollectibleIdSchema,
  publicCollectibleTypeSchema,
  normalizePublicSearchText,
  publicRepackIdSchema,
  publicSha256Schema,
  publicVendorKeySchema,
} from "./data-release-v2.ts";

export const PUBLIC_REPACK_PRICE_MIN_MINOR = 1_000 as const;
export const PUBLIC_REPACK_PRICE_MAX_MINOR = 1_200_000 as const;
export const PUBLIC_REPACK_DEFAULT_PAGE_SIZE = 25 as const;
export const PUBLIC_REPACK_MAX_PAGE_SIZE = 50 as const;
export const PUBLIC_SEARCH_MAX_LENGTH = 120 as const;
export const PUBLIC_COLLECTIBLE_SEARCH_MAX_RESULTS = 20 as const;

export { normalizePublicSearchText } from "./data-release-v2.ts";

const normalizedSearchSchema = z
  .string()
  .max(1_024)
  .transform(normalizePublicSearchText)
  .refine((value) => value.length <= PUBLIC_SEARCH_MAX_LENGTH, {
    message: "public_query.search_too_long",
  });

function canonicalSelectionSchema<TSchema extends z.ZodType<string>>(
  valueSchema: TSchema,
  maximum = 64,
) {
  return z
    .array(valueSchema)
    .max(maximum)
    .transform((values) => Object.freeze([...new Set(values)].sort()));
}

export const publicPriceFilterSchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("full"),
        minMinor: z.literal(PUBLIC_REPACK_PRICE_MIN_MINOR),
        maxMinor: z.literal(PUBLIC_REPACK_PRICE_MAX_MINOR),
      })
      .strict(),
    z
      .object({
        mode: z.literal("narrowed"),
        minMinor: z
          .number()
          .int()
          .min(PUBLIC_REPACK_PRICE_MIN_MINOR)
          .max(PUBLIC_REPACK_PRICE_MAX_MINOR),
        maxMinor: z
          .number()
          .int()
          .min(PUBLIC_REPACK_PRICE_MIN_MINOR)
          .max(PUBLIC_REPACK_PRICE_MAX_MINOR),
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
      price.minMinor === PUBLIC_REPACK_PRICE_MIN_MINOR &&
      price.maxMinor === PUBLIC_REPACK_PRICE_MAX_MINOR
    ) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "public_query.full_price_mode_required",
      });
    }
  });

const defaultPriceFilter = Object.freeze({
  mode: "full" as const,
  minMinor: PUBLIC_REPACK_PRICE_MIN_MINOR,
  maxMinor: PUBLIC_REPACK_PRICE_MAX_MINOR,
});

const defaultRepackFilters = Object.freeze({
  vendors: Object.freeze([] as string[]),
  categories: Object.freeze([] as string[]),
  collectibleTypes: Object.freeze(
    [] as Array<
      "card" | "watch" | "coin" | "sealed_product" | "memorabilia" | "other"
    >,
  ),
  price: defaultPriceFilter,
});

export const publicRepackFiltersSchema = z
  .object({
    vendors: canonicalSelectionSchema(publicVendorKeySchema).default([]),
    categories: canonicalSelectionSchema(publicCategoryIdSchema).default([]),
    collectibleTypes: canonicalSelectionSchema(publicCollectibleTypeSchema, 8).default(
      [],
    ),
    price: publicPriceFilterSchema.default(defaultPriceFilter),
  })
  .strict();

export const publicRepackSortSchema = z.enum([
  "repack",
  "repack_price",
  "packscout_ev_dollars",
  "packscout_ev_percent",
  "vendor_reported_ev_percent",
  "buyback_percent",
  "packscout_gross_ev",
  "top_chase_value",
  "packscout_confidence",
]);

export const dashboardQueryInputSchema = z
  .object({
    filters: publicRepackFiltersSchema.default(defaultRepackFilters),
    selectedPublicRepackId: publicRepackIdSchema.nullable().default(null),
  })
  .strict();

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

export function decodePublicCursorStack(value: string): readonly string[] | null {
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
      !parsed.every((entry) => publicOpaqueCursorSchema.safeParse(entry).success) ||
      encodeBase64UrlAscii(JSON.stringify(parsed)) !== value
    ) {
      return null;
    }
    return Object.freeze([...parsed]) as readonly string[];
  } catch {
    return null;
  }
}

export const publicCursorStackSchema = base64UrlSchema.refine(
  (value) => decodePublicCursorStack(value) !== null,
  { message: "public_query.cursor_stack_invalid" },
);

export function encodePublicCursorStack(cursors: readonly string[]): string {
  const parsed = z
    .array(publicOpaqueCursorSchema)
    .min(1)
    .max(40)
    .parse(cursors);
  return publicCursorStackSchema.parse(
    encodeBase64UrlAscii(JSON.stringify(parsed)),
  );
}

export const listPublicRepacksInputSchema = z
  .object({
    search: normalizedSearchSchema.default(""),
    filters: publicRepackFiltersSchema.default(defaultRepackFilters),
    sort: publicRepackSortSchema.default("packscout_ev_dollars"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    cursor: publicOpaqueCursorSchema.nullable().default(null),
    cursorStack: publicCursorStackSchema.nullable().default(null),
    queryFingerprint: publicSha256Schema.nullable().default(null),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(PUBLIC_REPACK_MAX_PAGE_SIZE)
      .default(PUBLIC_REPACK_DEFAULT_PAGE_SIZE),
    desiredPublicCollectibleId: publicCollectibleIdSchema.nullable().default(null),
    selectedPublicRepackId: publicRepackIdSchema.nullable().default(null),
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
    if (
      input.desiredPublicCollectibleId !== null &&
      input.sort === "top_chase_value"
    ) {
      context.addIssue({
        code: "custom",
        path: ["sort"],
        message: "public_query.desired_chase_sort_incompatible",
      });
    }
  });

export const getPublicRepackInputSchema = z
  .object({
    publicRepackId: publicRepackIdSchema,
    publicReleaseId: z.uuid(),
  })
  .strict();

export const getPublicShellStatusInputSchema = z.object({}).strict();

export const searchPublicCollectiblesInputSchema = z
  .object({
    search: normalizedSearchSchema.refine((value) => value.length >= 2, {
      message: "public_collectible_search.too_short",
    }),
    collectibleTypes: canonicalSelectionSchema(publicCollectibleTypeSchema, 8).default(
      [],
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(PUBLIC_COLLECTIBLE_SEARCH_MAX_RESULTS)
      .default(10),
  })
  .strict();

export const desiredCollectibleRepackSortSchema = z.enum([
  "match_confidence",
  "packscout_ev_percent",
  "repack_price",
]);

export const findRepacksByDesiredCollectibleInputSchema = z
  .object({
    publicCollectibleId: publicCollectibleIdSchema,
    filters: publicRepackFiltersSchema.default(defaultRepackFilters),
    sort: desiredCollectibleRepackSortSchema.default("match_confidence"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(PUBLIC_REPACK_MAX_PAGE_SIZE).default(25),
  })
  .strict();

export const acceptedRepackQuerySchema = z
  .object({
    search: normalizedSearchSchema,
    filters: publicRepackFiltersSchema,
    sort: publicRepackSortSchema,
    direction: z.enum(["asc", "desc"]),
    pageSize: z.number().int().min(1).max(PUBLIC_REPACK_MAX_PAGE_SIZE),
    desiredPublicCollectibleId: publicCollectibleIdSchema.nullable(),
  })
  .strict();

export function normalizeDashboardQueryInput(input: unknown): DashboardQueryInput {
  return dashboardQueryInputSchema.parse(input);
}

export function normalizeListPublicRepacksInput(
  input: unknown,
): ListPublicRepacksInput {
  return listPublicRepacksInputSchema.parse(input);
}

export type PublicPriceFilter = z.infer<typeof publicPriceFilterSchema>;
export type PublicRepackFilters = z.infer<typeof publicRepackFiltersSchema>;
export type PublicRepackSort = z.infer<typeof publicRepackSortSchema>;
export type DashboardQueryInput = z.infer<typeof dashboardQueryInputSchema>;
export type ListPublicRepacksInput = z.infer<
  typeof listPublicRepacksInputSchema
>;
export type GetPublicRepackInput = z.infer<typeof getPublicRepackInputSchema>;
export type GetPublicShellStatusInput = z.infer<
  typeof getPublicShellStatusInputSchema
>;
export type SearchPublicCollectiblesInput = z.infer<
  typeof searchPublicCollectiblesInputSchema
>;
export type FindRepacksByDesiredCollectibleInput = z.infer<
  typeof findRepacksByDesiredCollectibleInputSchema
>;
export type AcceptedRepackQuery = z.infer<typeof acceptedRepackQuerySchema>;
