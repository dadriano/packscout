import { z } from "zod";

export const CATALOG_SNAPSHOT_SCHEMA_VERSION = "catalog_snapshot_v1" as const;
export const CATALOG_RELEVANCE_VERSION = "packscout_relevance_v1" as const;

export const publicAvailabilityReasonSchema = z.enum([
  "ESTIMATE_INPUT_INCOMPLETE",
  "PRICE_UNAVAILABLE",
  "CURRENCY_UNSUPPORTED",
  "BUYBACK_UNAVAILABLE",
  "CHASE_UNAVAILABLE",
]);

export type PublicAvailabilityReason = z.infer<
  typeof publicAvailabilityReasonSchema
>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const sourceWatermarkSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/);
const timestampSchema = z.iso.datetime({ offset: true });
const safeIntegerSchema = z.number().int().safe();
const nonNegativeSafeIntegerSchema = safeIntegerSchema.min(0);
const nonBlankTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const platformKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/);
export const publicFacetKeySchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9_-]{0,98}[a-z0-9])?$/);
const publicUuidV5Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

export const publicSha256Schema = sha256Schema;
export const publicTimestampSchema = timestampSchema;
export const publicPlatformKeySchema = platformKeySchema;
export const publicPackIdSchema = publicUuidV5Schema;

function parsedHttpsUrl(value: string): URL | null {
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

const publicHttpsOriginSchema = publicHttpsUrlSchema.refine((value) => {
  const parsed = parsedHttpsUrl(value);
  return parsed !== null && value === parsed.origin;
}, { message: "public_origin.invalid" });

const publicHostSchema = z
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

function isStrictlySortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  return values.every(
    (value, index) => index === 0 || key(values[index - 1]!) < key(value),
  );
}

export const publicMoneySchema = z
  .object({
    minorUnits: nonNegativeSafeIntegerSchema,
    currency: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{1,11}$/),
  })
  .strict();

export const publicUsdMoneySchema = z
  .object({
    minorUnits: nonNegativeSafeIntegerSchema,
    currency: z.literal("USD"),
  })
  .strict();

export const publicSignedUsdMoneySchema = z
  .object({
    minorUnits: safeIntegerSchema,
    currency: z.literal("USD"),
  })
  .strict();

export const publicBasisPointsSchema = z
  .object({ basisPoints: safeIntegerSchema })
  .strict();

export type PublicMoney = z.infer<typeof publicMoneySchema>;
export type PublicUsdMoney = z.infer<typeof publicUsdMoneySchema>;
export type PublicSignedUsdMoney = z.infer<
  typeof publicSignedUsdMoneySchema
>;
export type PublicBasisPoints = z.infer<typeof publicBasisPointsSchema>;

export function publicSortableValueSchema<
  TValueSchema extends z.ZodType,
  TReasonSchema extends z.ZodType,
>(valueSchema: TValueSchema, reasonSchema: TReasonSchema) {
  return z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("available"),
        value: valueSchema,
        reason: z.null(),
        nullRank: z.literal(0),
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        value: z.null(),
        reason: reasonSchema,
        nullRank: z.literal(1),
      })
      .strict(),
  ]);
}

export type PublicSortableValue<T, TReason extends string> =
  | {
      readonly status: "available";
      readonly value: T;
      readonly reason: null;
      readonly nullRank: 0;
    }
  | {
      readonly status: "unavailable";
      readonly value: null;
      readonly reason: TReason;
      readonly nullRank: 1;
    };

export const publicPriceComparisonSchema = publicSortableValueSchema(
  publicUsdMoneySchema,
  z.enum(["PRICE_UNAVAILABLE", "CURRENCY_UNSUPPORTED"]),
);

export const publicGrossEvSchema = publicSortableValueSchema(
  publicUsdMoneySchema,
  z.enum(["CURRENCY_UNSUPPORTED", "ESTIMATE_INPUT_INCOMPLETE"]),
);

export const publicGrossReturnSchema = publicSortableValueSchema(
  z.object({ basisPoints: nonNegativeSafeIntegerSchema }).strict(),
  z.enum(["CURRENCY_UNSUPPORTED", "ESTIMATE_INPUT_INCOMPLETE"]),
);

export const publicDerivedEvDollarsSchema = publicSortableValueSchema(
  publicSignedUsdMoneySchema,
  z.enum([
    "PRICE_UNAVAILABLE",
    "CURRENCY_UNSUPPORTED",
    "ESTIMATE_INPUT_INCOMPLETE",
  ]),
);

export const publicDerivedEvPercentSchema = publicSortableValueSchema(
  publicBasisPointsSchema,
  z.enum([
    "PRICE_UNAVAILABLE",
    "CURRENCY_UNSUPPORTED",
    "ESTIMATE_INPUT_INCOMPLETE",
  ]),
);

export const publicBuybackSchema = publicSortableValueSchema(
  z
    .object({
      basisPoints: z.number().int().min(0).max(10_000),
      sourceKind: z.enum(["direct", "derived"]),
    })
    .strict(),
  z.literal("BUYBACK_UNAVAILABLE"),
);

export const publicPriceSchema = z
  .object({
    displayMoney: publicMoneySchema.nullable(),
    usdComparison: publicPriceComparisonSchema,
  })
  .strict()
  .superRefine((price, context) => {
    if (
      price.usdComparison.status === "available" &&
      price.displayMoney?.currency === "USD" &&
      price.displayMoney.minorUnits !== price.usdComparison.value.minorUnits
    ) {
      context.addIssue({
        code: "custom",
        path: ["usdComparison", "value", "minorUnits"],
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

export const publicEstimateCoverageSchema = z
  .object({
    evidenceCompleteness: z.enum(["complete", "partial", "unknown"]),
    probabilityCoverageBasisPoints: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .nullable(),
  })
  .strict();

function derivedMetricReason(input: {
  price: z.infer<typeof publicPriceComparisonSchema>;
  gross: z.infer<typeof publicGrossEvSchema>;
}):
  | "PRICE_UNAVAILABLE"
  | "CURRENCY_UNSUPPORTED"
  | "ESTIMATE_INPUT_INCOMPLETE"
  | null {
  if (
    input.price.status === "unavailable" &&
    input.price.reason === "PRICE_UNAVAILABLE"
  ) {
    return "PRICE_UNAVAILABLE";
  }
  if (
    (input.price.status === "unavailable" &&
      input.price.reason === "CURRENCY_UNSUPPORTED") ||
    (input.gross.status === "unavailable" &&
      input.gross.reason === "CURRENCY_UNSUPPORTED")
  ) {
    return "CURRENCY_UNSUPPORTED";
  }
  return input.gross.status === "unavailable"
    ? "ESTIMATE_INPUT_INCOMPLETE"
    : null;
}

const estimatedEvSummaryShape = {
  grossEv: publicGrossEvSchema,
  grossReturn: publicGrossReturnSchema,
  evDollars: publicDerivedEvDollarsSchema,
  evPercent: publicDerivedEvPercentSchema,
  calculatedAt: timestampSchema.nullable(),
} as const;

export const publicEstimatedEvSummarySchema = z
  .object(estimatedEvSummaryShape)
  .strict();

export const publicEstimatedEvSchema = z
  .object({
    ...estimatedEvSummaryShape,
    coverage: publicEstimateCoverageSchema,
    limitations: z.array(nonBlankTextSchema(240)).max(8),
  })
  .strict();

function validateEstimatedEvConsistency(
  price: z.infer<typeof publicPriceSchema>,
  estimatedEv: z.infer<typeof publicEstimatedEvSummarySchema>,
  context: z.RefinementCtx,
): void {
  const { grossEv, grossReturn, evDollars, evPercent } = estimatedEv;
  if (
    grossEv.status !== grossReturn.status ||
    (grossEv.status === "unavailable" &&
      grossReturn.status === "unavailable" &&
      grossEv.reason !== grossReturn.reason)
  ) {
    context.addIssue({
      code: "custom",
      path: ["estimatedEv", "grossReturn"],
      message: "public_ev.gross_return_mismatch",
    });
  }
  if (
    (grossEv.status === "available") !== (estimatedEv.calculatedAt !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["estimatedEv", "calculatedAt"],
      message: "public_ev.calculation_time_mismatch",
    });
  }

  const reason = derivedMetricReason({
    price: price.usdComparison,
    gross: grossEv,
  });
  if (reason === null) {
    if (
      price.usdComparison.status !== "available" ||
      grossEv.status !== "available" ||
      grossReturn.status !== "available" ||
      evDollars.status !== "available" ||
      evPercent.status !== "available"
    ) {
      context.addIssue({
        code: "custom",
        path: ["estimatedEv"],
        message: "public_ev.available_bundle_incomplete",
      });
      return;
    }
    const expectedDollars =
      grossEv.value.minorUnits - price.usdComparison.value.minorUnits;
    if (evDollars.value.minorUnits !== expectedDollars) {
      context.addIssue({
        code: "custom",
        path: ["estimatedEv", "evDollars", "value", "minorUnits"],
        message: "public_ev.dollars_inconsistent",
      });
    }
    if (evPercent.value.basisPoints !== grossReturn.value.basisPoints - 10_000) {
      context.addIssue({
        code: "custom",
        path: ["estimatedEv", "evPercent", "value", "basisPoints"],
        message: "public_ev.percent_inconsistent",
      });
    }
    return;
  }
  for (const [field, value] of [
    ["evDollars", evDollars],
    ["evPercent", evPercent],
  ] as const) {
    if (value.status !== "unavailable" || value.reason !== reason) {
      context.addIssue({
        code: "custom",
        path: ["estimatedEv", field],
        message: "public_ev.reason_precedence_mismatch",
      });
    }
  }
}

export const publicImageSchema = z
  .object({
    url: publicHttpsUrlSchema,
    alt: nonBlankTextSchema(200),
  })
  .strict();

const publicChaseComparisonSchema = publicSortableValueSchema(
  publicUsdMoneySchema,
  z.enum(["CHASE_UNAVAILABLE", "CURRENCY_UNSUPPORTED"]),
);

export const publicTopChaseSummarySchema = publicSortableValueSchema(
  z
    .object({
      publicChaseId: publicUuidV5Schema,
      name: nonBlankTextSchema(200),
      displayMoney: publicMoneySchema.nullable(),
      usdComparison: publicChaseComparisonSchema,
      primaryImage: publicImageSchema.nullable(),
    })
    .strict(),
  z.literal("CHASE_UNAVAILABLE"),
);

export const publicTopChaseDetailSchema = publicSortableValueSchema(
  z
    .object({
      publicChaseId: publicUuidV5Schema,
      name: nonBlankTextSchema(200),
      displayMoney: publicMoneySchema.nullable(),
      usdComparison: publicChaseComparisonSchema,
      primaryImage: publicImageSchema.nullable(),
      evidenceKind: z.enum([
        "canonical_asset_value",
        "canonical_asset_identity",
      ]),
      observedAt: timestampSchema,
    })
    .strict(),
  z.literal("CHASE_UNAVAILABLE"),
);

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

export const publicPackLinkSchema = z
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

export const publicPackActionsSchema = z
  .object({
    promo: publicPromoSchema.optional(),
    packLink: publicPackLinkSchema.optional(),
  })
  .strict();

export const publicActionAvailabilitySchema = z
  .object({
    promo: z.boolean(),
    packLink: z.boolean(),
  })
  .strict();

const packSummaryShape = {
  publicPackId: publicUuidV5Schema,
  platformKey: platformKeySchema,
  platformDisplayName: nonBlankTextSchema(100),
  platformLogoUrl: publicHttpsUrlSchema.nullable(),
  category: nonBlankTextSchema(100),
  name: nonBlankTextSchema(200),
  availability: z.enum(["active", "sold_out"]),
  price: publicPriceSchema,
  estimatedEv: publicEstimatedEvSummarySchema,
  buyback: publicBuybackSchema,
  primaryImage: publicImageSchema.nullable(),
  topChase: publicTopChaseSummarySchema,
  actionAvailability: publicActionAvailabilitySchema,
  sourceFirstSeenAt: timestampSchema,
  sourceCollectedAt: timestampSchema,
} as const;

export const publicPackSummarySchema = z
  .object(packSummaryShape)
  .strict()
  .superRefine((pack, context) => {
    validateEstimatedEvConsistency(pack.price, pack.estimatedEv, context);
    if (pack.availability === "sold_out" && pack.actionAvailability.packLink) {
      context.addIssue({
        code: "custom",
        path: ["actionAvailability", "packLink"],
        message: "public_pack.sold_out_actionable",
      });
    }
  });

export const publicPackDetailSchema = z
  .object({
    ...packSummaryShape,
    description: nonBlankTextSchema(4_000).nullable(),
    estimatedEv: publicEstimatedEvSchema,
    topChase: publicTopChaseDetailSchema,
    actions: publicPackActionsSchema,
  })
  .strict()
  .superRefine((pack, context) => {
    validateEstimatedEvConsistency(pack.price, pack.estimatedEv, context);
    if (
      pack.actionAvailability.promo !== (pack.actions.promo !== undefined) ||
      pack.actionAvailability.packLink !==
        (pack.actions.packLink !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actionAvailability"],
        message: "public_pack.action_availability_mismatch",
      });
    }
    if (
      pack.availability === "sold_out" &&
      pack.actions.packLink !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["actions", "packLink"],
        message: "public_pack.sold_out_actionable",
      });
    }
  });

export type PublicPrice = z.infer<typeof publicPriceSchema>;
export type PublicEstimatedEvSummary = z.infer<
  typeof publicEstimatedEvSummarySchema
>;
export type PublicEstimatedEv = z.infer<typeof publicEstimatedEvSchema>;
export type PublicBuyback = z.infer<typeof publicBuybackSchema>;
export type PublicImage = z.infer<typeof publicImageSchema>;
export type PublicTopChaseSummary = z.infer<
  typeof publicTopChaseSummarySchema
>;
export type PublicTopChaseDetail = z.infer<typeof publicTopChaseDetailSchema>;
export type PublicPackActions = z.infer<typeof publicPackActionsSchema>;
export type PublicPackSummary = z.infer<typeof publicPackSummarySchema>;
export type PublicPackDetail = z.infer<typeof publicPackDetailSchema>;

export const publicPlatformConfigSchema = z
  .object({
    platformKey: platformKeySchema,
    revision: z.number().int().positive(),
    contentHash: sha256Schema,
    displayName: nonBlankTextSchema(100),
    logoUrl: publicHttpsUrlSchema.nullable(),
    listingHosts: z
      .array(publicHostSchema)
      .max(16)
      .refine((values) => isStrictlySortedUnique(values, (value) => value), {
        message: "public_listing_hosts.not_canonical",
      }),
    imageOrigins: z
      .array(publicHttpsOriginSchema)
      .max(16)
      .refine((values) => isStrictlySortedUnique(values, (value) => value), {
        message: "public_image_origins.not_canonical",
      }),
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
  .superRefine((config, context) => {
    if (
      config.logoUrl !== null &&
      !config.imageOrigins.includes(parsedHttpsUrl(config.logoUrl)?.origin ?? "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["logoUrl"],
        message: "public_config.logo_origin_not_approved",
      });
    }
  });

export type PublicPlatformConfig = z.infer<typeof publicPlatformConfigSchema>;

export const snapshotMetadataSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SNAPSHOT_SCHEMA_VERSION),
    dataSource: z.enum(["canonical", "mock"]),
    publicationId: z.uuid(),
    sourceWatermark: sourceWatermarkSchema,
    manifestFingerprint: sha256Schema,
    contentHash: sha256Schema,
    publicConfigRevision: z.number().int().positive(),
    publicConfigHash: sha256Schema,
    originSetHash: sha256Schema,
    createdAt: timestampSchema,
    completedAt: timestampSchema,
    dataAsOf: timestampSchema,
    lastSuccessfulObservationAt: timestampSchema,
    staleAt: timestampSchema,
    freshness: z.enum(["fresh", "delayed"]),
    delayedSourceCount: nonNegativeSafeIntegerSchema,
    platformConfigCount: z.number().int().min(0).max(64),
    packCount: z.number().int().min(0).max(10_000),
    searchAlgorithmVersion: z.literal(CATALOG_RELEVANCE_VERSION),
  })
  .strict()
  .superRefine((metadata, context) => {
    const createdAt = Date.parse(metadata.createdAt);
    const completedAt = Date.parse(metadata.completedAt);
    if (completedAt < createdAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "snapshot.completed_before_created",
      });
    }
    if (Date.parse(metadata.staleAt) <= Date.parse(metadata.lastSuccessfulObservationAt)) {
      context.addIssue({
        code: "custom",
        path: ["staleAt"],
        message: "snapshot.stale_deadline_invalid",
      });
    }
    if (
      Date.parse(metadata.dataAsOf) >
      Date.parse(metadata.lastSuccessfulObservationAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataAsOf"],
        message: "snapshot.data_after_observation",
      });
    }
    if (
      metadata.freshness === "fresh" &&
      metadata.delayedSourceCount !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["delayedSourceCount"],
        message: "snapshot.fresh_has_delayed_sources",
      });
    }
  });

export type SnapshotMetadata = z.infer<typeof snapshotMetadataSchema>;

export function publicPackSummaryFromDetail(
  pack: PublicPackDetail,
): PublicPackSummary {
  const summaryTopChase =
    pack.topChase.status === "unavailable"
      ? pack.topChase
      : {
          ...pack.topChase,
          value: {
            publicChaseId: pack.topChase.value.publicChaseId,
            name: pack.topChase.value.name,
            displayMoney: pack.topChase.value.displayMoney,
            usdComparison: pack.topChase.value.usdComparison,
            primaryImage: pack.topChase.value.primaryImage,
          },
        };
  return publicPackSummarySchema.parse({
    publicPackId: pack.publicPackId,
    platformKey: pack.platformKey,
    platformDisplayName: pack.platformDisplayName,
    platformLogoUrl: pack.platformLogoUrl,
    category: pack.category,
    name: pack.name,
    availability: pack.availability,
    price: pack.price,
    estimatedEv: {
      grossEv: pack.estimatedEv.grossEv,
      grossReturn: pack.estimatedEv.grossReturn,
      evDollars: pack.estimatedEv.evDollars,
      evPercent: pack.estimatedEv.evPercent,
      calculatedAt: pack.estimatedEv.calculatedAt,
    },
    buyback: pack.buyback,
    primaryImage: pack.primaryImage,
    topChase: summaryTopChase,
    actionAvailability: pack.actionAvailability,
    sourceFirstSeenAt: pack.sourceFirstSeenAt,
    sourceCollectedAt: pack.sourceCollectedAt,
  });
}

export const catalogFacetSchema = z
  .object({
    key: publicFacetKeySchema,
    label: nonBlankTextSchema(100),
    packCount: nonNegativeSafeIntegerSchema,
  })
  .strict();

export const catalogFacetsSchema = z
  .object({
    platforms: z
      .array(catalogFacetSchema)
      .max(64)
      .refine((values) => isStrictlySortedUnique(values, ({ key }) => key), {
        message: "catalog_facets.platforms_not_canonical",
      }),
    categories: z
      .array(catalogFacetSchema)
      .max(64)
      .refine((values) => isStrictlySortedUnique(values, ({ key }) => key), {
        message: "catalog_facets.categories_not_canonical",
      }),
  })
  .strict();

export type CatalogFacet = z.infer<typeof catalogFacetSchema>;
export type CatalogFacets = z.infer<typeof catalogFacetsSchema>;

function approvedImage(
  image: z.infer<typeof publicImageSchema> | null,
  config: PublicPlatformConfig,
): boolean {
  if (image === null) return true;
  const origin = parsedHttpsUrl(image.url)?.origin;
  return origin !== undefined && config.imageOrigins.includes(origin);
}

function sameReferralParameters(
  left: readonly z.infer<typeof publicReferralParameterSchema>[],
  right: readonly z.infer<typeof publicReferralParameterSchema>[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.name === right[index]?.name && entry.value === right[index]?.value,
    )
  );
}

function validatePackAgainstConfig(
  pack: PublicPackDetail,
  config: PublicPlatformConfig | undefined,
  index: number,
  context: z.RefinementCtx,
): void {
  if (!config) {
    context.addIssue({
      code: "custom",
      path: ["packs", index, "platformKey"],
      message: "snapshot.pack_config_missing",
    });
    return;
  }
  if (
    pack.platformDisplayName !== config.displayName ||
    pack.platformLogoUrl !== config.logoUrl
  ) {
    context.addIssue({
      code: "custom",
      path: ["packs", index, "platformDisplayName"],
      message: "snapshot.pack_config_identity_mismatch",
    });
  }
  if (!approvedImage(pack.primaryImage, config)) {
    context.addIssue({
      code: "custom",
      path: ["packs", index, "primaryImage"],
      message: "snapshot.pack_image_origin_not_approved",
    });
  }
  if (
    pack.topChase.status === "available" &&
    !approvedImage(pack.topChase.value.primaryImage, config)
  ) {
    context.addIssue({
      code: "custom",
      path: ["packs", index, "topChase", "value", "primaryImage"],
      message: "snapshot.chase_image_origin_not_approved",
    });
  }
  const packLink = pack.actions.packLink;
  if (
    packLink &&
    (!config.listingHosts.includes(packLink.listingHost) ||
      !sameReferralParameters(
        packLink.referralParameters,
        config.referralParameters,
      ))
  ) {
    context.addIssue({
      code: "custom",
      path: ["packs", index, "actions", "packLink"],
      message: "snapshot.pack_link_not_approved",
    });
  }
  if (
    pack.actions.promo !== undefined &&
    (config.publicPromo === null ||
      pack.actions.promo.code !== config.publicPromo.code ||
      pack.actions.promo.label !== config.publicPromo.label)
  ) {
    context.addIssue({
      code: "custom",
      path: ["packs", index, "actions", "promo"],
      message: "snapshot.promo_not_approved",
    });
  }
}

export const catalogSnapshotV1Schema = z
  .object({
    metadata: snapshotMetadataSchema,
    platformConfigs: z.array(publicPlatformConfigSchema).max(64),
    packs: z.array(publicPackDetailSchema).max(10_000),
    facets: catalogFacetsSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.metadata.platformConfigCount !== snapshot.platformConfigs.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["metadata", "platformConfigCount"],
        message: "snapshot.platform_config_count_mismatch",
      });
    }
    if (snapshot.metadata.packCount !== snapshot.packs.length) {
      context.addIssue({
        code: "custom",
        path: ["metadata", "packCount"],
        message: "snapshot.pack_count_mismatch",
      });
    }
    if (
      !isStrictlySortedUnique(
        snapshot.platformConfigs,
        ({ platformKey }) => platformKey,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["platformConfigs"],
        message: "snapshot.platform_configs_not_canonical",
      });
    }
    if (!isStrictlySortedUnique(snapshot.packs, ({ publicPackId }) => publicPackId)) {
      context.addIssue({
        code: "custom",
        path: ["packs"],
        message: "snapshot.packs_not_canonical",
      });
    }
    const configs = new Map(
      snapshot.platformConfigs.map((config) => [config.platformKey, config]),
    );
    snapshot.packs.forEach((pack, index) =>
      validatePackAgainstConfig(pack, configs.get(pack.platformKey), index, context),
    );

    const platformCounts = new Map<string, number>();
    const categoryCounts = new Map<string, number>();
    for (const pack of snapshot.packs) {
      platformCounts.set(
        pack.platformKey,
        (platformCounts.get(pack.platformKey) ?? 0) + 1,
      );
      categoryCounts.set(
        pack.category,
        (categoryCounts.get(pack.category) ?? 0) + 1,
      );
    }
    snapshot.facets.platforms.forEach((facet, index) => {
      const config = configs.get(facet.key);
      if (
        config === undefined ||
        config.displayName !== facet.label ||
        platformCounts.get(facet.key) !== facet.packCount
      ) {
        context.addIssue({
          code: "custom",
          path: ["facets", "platforms", index],
          message: "snapshot.platform_facet_mismatch",
        });
      }
    });
    snapshot.facets.categories.forEach((facet, index) => {
      if (categoryCounts.get(facet.label) !== facet.packCount) {
        context.addIssue({
          code: "custom",
          path: ["facets", "categories", index],
          message: "snapshot.category_facet_mismatch",
        });
      }
    });
    if (
      snapshot.facets.platforms.length !== platformCounts.size ||
      snapshot.facets.categories.length !== categoryCounts.size
    ) {
      context.addIssue({
        code: "custom",
        path: ["facets"],
        message: "snapshot.facet_set_incomplete",
      });
    }
  });

export type CatalogSnapshotV1 = z.infer<typeof catalogSnapshotV1Schema>;

export function parseCatalogSnapshotV1(input: unknown): CatalogSnapshotV1 {
  return catalogSnapshotV1Schema.parse(input);
}

export function safeParseCatalogSnapshotV1(input: unknown) {
  return catalogSnapshotV1Schema.safeParse(input);
}
