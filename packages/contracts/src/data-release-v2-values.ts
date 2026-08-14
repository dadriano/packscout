import { z } from "zod";

export const DATA_RELEASE_SCHEMA_VERSION = "data_release_v2" as const;
export const REPACK_SEARCH_VERSION = "repack_search_v2" as const;
export const MAX_PUBLIC_REPACKS_PER_RELEASE = 8_000 as const;
export const MAX_REPACK_CHASES_PER_COLLECTIBLE = 500 as const;

const safeIntegerSchema = z.number().int().safe();
export const nonNegativeIntegerSchema = safeIntegerSchema.min(0);
export const timestampSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const nonBlankTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const canonicalKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/);
const uuidV5Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

export const publicTimestampSchema = timestampSchema;
export const publicSha256Schema = sha256Schema;
export const publicVendorKeySchema = canonicalKeySchema;
export const publicCategoryKeySchema = canonicalKeySchema;
export const publicRepackIdSchema = uuidV5Schema;
export const publicCollectibleIdSchema = uuidV5Schema;
export const publicCategoryIdSchema = uuidV5Schema;
export const publicVendorIdSchema = uuidV5Schema;

export function normalizePublicSearchText(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
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

export function parsedHttpsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === ""
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export const publicHttpsUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => parsedHttpsUrl(value) !== null, {
    message: "public_url.invalid",
  });

export const publicHttpsOriginSchema = publicHttpsUrlSchema.refine((value) => {
  const parsed = parsedHttpsUrl(value);
  return parsed !== null && value === parsed.origin;
}, { message: "public_origin.invalid" });

export const publicHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => {
    if (value !== value.toLowerCase() || /[/@?#]/.test(value)) return false;
    try {
      const parsed = new URL(`https://${value}`);
      return parsed.host === value && parsed.pathname === "/";
    } catch {
      return false;
    }
  }, { message: "public_host.invalid" });

export function isStrictlySortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  return values.every(
    (value, index) => index === 0 || key(values[index - 1]!) < key(value),
  );
}

export function canonicalArraySchema<TSchema extends z.ZodType>(
  itemSchema: TSchema,
  maximum: number,
) {
  return z
    .array(itemSchema)
    .max(maximum)
    .refine((values) => isStrictlySortedUnique(values, String), {
      message: "public_array.not_canonical",
    });
}

export const publicMoneySchema = z
  .object({
    minorUnits: nonNegativeIntegerSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const publicReportedMoneySchema = z
  .object({
    minorUnits: nonNegativeIntegerSchema,
    currency: z.string().regex(/^[A-Z0-9]{2,12}$/),
  })
  .strict();

export const publicSignedMoneySchema = z
  .object({
    minorUnits: safeIntegerSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();

export const publicUsdMoneySchema = z
  .object({ minorUnits: nonNegativeIntegerSchema, currency: z.literal("USD") })
  .strict();

export const publicSignedUsdMoneySchema = z
  .object({ minorUnits: safeIntegerSchema, currency: z.literal("USD") })
  .strict();

export const publicImageSchema = z
  .object({ url: publicHttpsUrlSchema, alt: nonBlankTextSchema(200) })
  .strict();

export const publicCollectibleTypeSchema = z.enum([
  "card",
  "watch",
  "coin",
  "sealed_product",
  "memorabilia",
  "other",
]);

export const publicCategoryKindSchema = z.enum([
  "vertical",
  "sport",
  "league",
  "franchise",
  "brand",
  "set",
  "other",
]);

export const publicAvailabilityReasonSchema = z.enum([
  "PRICE_UNAVAILABLE",
  "CURRENCY_UNSUPPORTED",
  "ESTIMATE_UNAVAILABLE",
  "BUYBACK_UNAVAILABLE",
  "VALUATION_UNAVAILABLE",
]);

export function publicAvailableValueSchema<
  TSchema extends z.ZodType,
  TReasonSchema extends z.ZodType,
>(
  valueSchema: TSchema,
  reasonSchema: TReasonSchema,
) {
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("available"), value: valueSchema }).strict(),
    z
      .object({
        status: z.literal("unavailable"),
        value: z.null(),
        reason: reasonSchema,
      })
      .strict(),
  ]);
}

export const publicPriceSchema = z
  .object({
    displayMoney: publicMoneySchema.nullable(),
    usdComparison: publicAvailableValueSchema(
      publicUsdMoneySchema,
      z.enum(["PRICE_UNAVAILABLE", "CURRENCY_UNSUPPORTED"]),
    ),
  })
  .strict()
  .superRefine((price, context) => {
    if (
      price.displayMoney?.currency === "USD" &&
      (price.usdComparison.status !== "available" ||
        price.displayMoney.minorUnits !== price.usdComparison.value.minorUnits)
    ) {
      context.addIssue({
        code: "custom",
        path: ["usdComparison"],
        message: "public_price.usd_evidence_mismatch",
      });
    }
    if (
      price.usdComparison.status === "unavailable" &&
      price.usdComparison.reason === "PRICE_UNAVAILABLE" &&
      price.displayMoney !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["displayMoney"],
        message: "public_price.unavailable_has_display_money",
      });
    }
  });

export const publicBuybackSchema = publicAvailableValueSchema(
  z
    .object({
      basisPoints: z.number().int().min(0).max(10_000),
      sourceKind: z.enum(["vendor_reported", "packscout_derived"]),
    })
    .strict(),
  z.literal("BUYBACK_UNAVAILABLE"),
);

const publicEvMetricsSchema = z
  .object({
    grossEv: publicUsdMoneySchema,
    grossReturnBasisPoints: safeIntegerSchema,
    evDollars: publicSignedUsdMoneySchema,
    evPercentBasisPoints: safeIntegerSchema,
  })
  .strict()
  .refine(
    ({ grossReturnBasisPoints, evPercentBasisPoints }) =>
      evPercentBasisPoints === grossReturnBasisPoints - 10_000,
    {
      path: ["evPercentBasisPoints"],
      message: "public_ev.percent_inconsistent",
    },
  );

export const vendorReportedEvSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("available"),
        displayMoney: publicReportedMoneySchema,
        metrics: publicEvMetricsSchema,
        observedAt: timestampSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        displayMoney: publicReportedMoneySchema.nullable(),
        metrics: z.null(),
        observedAt: timestampSchema.nullable(),
        reason: z.enum([
          "NOT_REPORTED",
          "PRICE_UNAVAILABLE",
          "CURRENCY_UNSUPPORTED",
        ]),
      })
      .strict(),
  ])
  .superRefine((estimate, context) => {
    if (
      estimate.status === "available" &&
      estimate.displayMoney.currency === "USD" &&
      estimate.displayMoney.minorUnits !== estimate.metrics.grossEv.minorUnits
    ) {
      context.addIssue({
        code: "custom",
        path: ["displayMoney"],
        message: "vendor_reported_ev.usd_evidence_mismatch",
      });
    }
    if (
      estimate.status === "unavailable" &&
      estimate.reason === "NOT_REPORTED" &&
      estimate.displayMoney !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["displayMoney"],
        message: "vendor_reported_ev.not_reported_has_value",
      });
    }
    if (
      estimate.status === "unavailable" &&
      estimate.reason === "PRICE_UNAVAILABLE" &&
      estimate.displayMoney === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["displayMoney"],
        message: "vendor_reported_ev.reported_value_required",
      });
    }
  });

export const publicConfidenceSchema = z
  .object({
    scoreBasisPoints: z.number().int().min(0).max(10_000),
    band: z.enum(["low", "medium", "high"]),
    limitationCodes: canonicalArraySchema(
      z.enum([
        "incomplete_outcome_pool",
        "estimated_value_ranges",
        "partial_probability_coverage",
        "sparse_valuation_data",
        "stale_valuation_data",
        "unresolved_collectibles",
        "currency_normalization_applied",
        "vendor_odds_unverified",
        "vendor_probability_inputs",
      ]),
      16,
    ),
  })
  .strict()
  .refine(
    ({ scoreBasisPoints, band }) =>
      (band === "low" && scoreBasisPoints <= 4_999) ||
      (band === "medium" &&
        scoreBasisPoints >= 5_000 &&
        scoreBasisPoints <= 7_999) ||
      (band === "high" && scoreBasisPoints >= 8_000),
    { path: ["band"], message: "public_confidence.band_mismatch" },
  );

export const packScoutEvSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("available"),
      metrics: publicEvMetricsSchema,
      confidence: publicConfidenceSchema,
      modelVersion: nonBlankTextSchema(128),
      confidencePolicyVersion: nonBlankTextSchema(128),
      dataAsOf: timestampSchema,
      calculatedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      metrics: z.null(),
      confidence: z.null(),
      modelVersion: nonBlankTextSchema(128),
      confidencePolicyVersion: nonBlankTextSchema(128),
      dataAsOf: timestampSchema.nullable(),
      calculatedAt: timestampSchema.nullable(),
      reason: z.enum([
        "PRICE_UNAVAILABLE",
        "CURRENCY_UNSUPPORTED",
        "ESTIMATE_INPUT_INCOMPLETE",
      ]),
    })
    .strict(),
]);

export const publicEvEstimatesSchema = z
  .object({
    vendorReported: vendorReportedEvSchema,
    packScout: packScoutEvSchema,
  })
  .strict();

export const publicReferralParameterSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9._~-]{1,64}$/),
    value: nonBlankTextSchema(256),
  })
  .strict();

export const publicPromoSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    label: nonBlankTextSchema(100),
  })
  .strict();

export const publicRepackLinkSchema = z
  .object({
    listingUrl: publicHttpsUrlSchema,
    listingHost: publicHostSchema,
    referralParameters: z
      .array(publicReferralParameterSchema)
      .max(8)
      .refine(
        (values) => isStrictlySortedUnique(values, ({ name }) => name),
        { message: "public_referrals.not_canonical" },
      ),
  })
  .strict()
  .refine(
    ({ listingUrl, listingHost }) =>
      parsedHttpsUrl(listingUrl)?.host === listingHost,
    { path: ["listingHost"], message: "public_listing.host_mismatch" },
  );

export const publicRepackActionsSchema = z
  .object({
    promo: publicPromoSchema.optional(),
    repackLink: publicRepackLinkSchema.optional(),
  })
  .strict();

export type PublicMoney = z.infer<typeof publicMoneySchema>;
export type PublicImage = z.infer<typeof publicImageSchema>;
export type VendorReportedEv = z.infer<typeof vendorReportedEvSchema>;
export type PublicReportedMoney = z.infer<typeof publicReportedMoneySchema>;
export type PackScoutEv = z.infer<typeof packScoutEvSchema>;
export type PublicEvEstimates = z.infer<typeof publicEvEstimatesSchema>;
export type PublicRepackActions = z.infer<typeof publicRepackActionsSchema>;
