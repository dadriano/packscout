import { z } from "zod";
import { normalizedCurrencyTickerSchema } from "./provider-source-facts-v1.ts";

const canonicalTimestampSchema = z
  .iso.datetime({ offset: true })
  .refine(
    (value) => new Date(value).toISOString() === value,
    "provider_source.canonical_timestamp_not_normalized",
  );
const boundedTextSchema = z
  .string()
  .min(1)
  .max(10_000)
  .refine((value) => value === value.trim());
const boundedIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim());
const imageReferenceSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value === value.trim());
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeIntegerSchema = nonnegativeSafeIntegerSchema.min(1);
const probabilitySchema = z.number().finite().min(0).max(1);
const percentageSchema = z.number().finite().min(0).max(100);

const canonicalMoneySchema = z
  .object({
    amountMinor: nonnegativeSafeIntegerSchema,
    currency: normalizedCurrencyTickerSchema,
  })
  .strict();

const dataQualityEvidenceSchema = z
  .object({
    code: boundedIdentitySchema.max(128),
    severity: z.enum(["info", "warning"]),
    fieldPath: boundedIdentitySchema.max(256).nullable(),
  })
  .strict();

const commonCatalogShape = {
  schemaVersion: z.literal("catalog-projection-v1"),
  firstSeenAt: canonicalTimestampSchema,
  imageUrls: z.array(imageReferenceSchema).max(64),
  dataQualityEvidence: z.array(dataQualityEvidenceSchema).max(128),
} as const;

const ordinaryAvailabilityProvenanceSchema = z
  .object({
    kind: z.literal("canonical_provider_observation"),
    observedAvailability: z.enum(["available", "unavailable", "unknown"]),
  })
  .strict();
const soldOutAvailabilityProvenanceSchema = z
  .object({
    kind: z.literal("explicit_authoritative_sold_out"),
    authority: z.literal("provider_explicit_sold_out"),
  })
  .strict();

export const providerSourceCanonicalPackContentV1Schema = z
  .object({
    ...commonCatalogShape,
    entityType: z.literal("pack"),
    evInputStatus: z.enum(["ready", "unavailable"]),
    parentExternalId: z.null(),
    name: boundedTextSchema,
    category: boundedTextSchema.nullable(),
    description: boundedTextSchema.nullable(),
    availability: z.enum(["available", "unavailable", "unknown", "sold_out"]),
    availabilityProvenance: z.union([
      ordinaryAvailabilityProvenanceSchema,
      soldOutAvailabilityProvenanceSchema,
    ]),
    sourceStatus: z.null(),
    priceValueMinor: nonnegativeSafeIntegerSchema.nullable(),
    priceCurrency: normalizedCurrencyTickerSchema.nullable(),
    providerReportedEvValueMinor: nonnegativeSafeIntegerSchema.nullable(),
    providerReportedEvCurrency: normalizedCurrencyTickerSchema.nullable(),
    buybackPercent: percentageSchema.nullable(),
    drawCount: positiveSafeIntegerSchema.nullable(),
  })
  .strict()
  .superRefine((content, context) => {
    if ((content.priceValueMinor === null) !== (content.priceCurrency === null)) {
      context.addIssue({
        code: "custom",
        message: "provider_source.pack_price_pair_invalid",
        path: ["priceCurrency"],
      });
    }
    if (
      (content.providerReportedEvValueMinor === null) !==
      (content.providerReportedEvCurrency === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "provider_source.pack_provider_ev_pair_invalid",
        path: ["providerReportedEvCurrency"],
      });
    }
    const expectedProvenance = content.availability === "sold_out"
      ? "explicit_authoritative_sold_out"
      : "canonical_provider_observation";
    if (content.availabilityProvenance.kind !== expectedProvenance) {
      context.addIssue({
        code: "custom",
        message: "provider_source.pack_availability_provenance_invalid",
        path: ["availabilityProvenance"],
      });
    }
    if (
      content.availabilityProvenance.kind ===
        "canonical_provider_observation" &&
      content.availabilityProvenance.observedAvailability !==
        content.availability
    ) {
      context.addIssue({
        code: "custom",
        message: "provider_source.pack_availability_provenance_invalid",
        path: ["availabilityProvenance", "observedAvailability"],
      });
    }
  });

export const providerSourceCanonicalCatalogAssetContentV1Schema = z
  .object({
    ...commonCatalogShape,
    entityType: z.literal("catalog_asset"),
    assetType: z.literal("card"),
    relatedPackExternalId: z.null(),
    parentExternalId: z.null(),
    name: boundedTextSchema.nullable(),
    description: boundedTextSchema.nullable(),
    category: boundedTextSchema.nullable(),
    availability: z.enum(["available", "unavailable", "unknown"]),
    sourceStatus: z.null(),
    providerValueMinor: nonnegativeSafeIntegerSchema.nullable(),
    providerValueCurrency: normalizedCurrencyTickerSchema.nullable(),
    valueSource: boundedTextSchema.nullable(),
  })
  .strict()
  .superRefine((content, context) => {
    if (
      (content.providerValueMinor === null) !==
      (content.providerValueCurrency === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "provider_source.catalog_asset_value_pair_invalid",
        path: ["providerValueCurrency"],
      });
    }
  });

const evBucketSchema = z
  .object({
    bucketId: boundedIdentitySchema.max(256),
    label: boundedTextSchema.max(500).nullable(),
    probability: probabilitySchema,
    lowerValueMinor: nonnegativeSafeIntegerSchema,
    upperValueMinor: nonnegativeSafeIntegerSchema,
  })
  .strict()
  .refine(
    (bucket) => bucket.lowerValueMinor <= bucket.upperValueMinor,
    "provider_source.ev_bucket_value_range_invalid",
  );
const inventoryBucketSchema = z
  .object({
    bucketId: boundedIdentitySchema.max(256),
    quantity: positiveSafeIntegerSchema,
  })
  .strict();

export const providerSourceCanonicalEvInputContentV1Schema = z
  .object({
    schemaVersion: z.literal("catalog-projection-v1"),
    entityType: z.literal("ev_input"),
    packExternalId: boundedIdentitySchema,
    currency: normalizedCurrencyTickerSchema,
    unitBasis: z.enum(["per_draw", "per_pack"]),
    drawCount: positiveSafeIntegerSchema,
    buybackPercent: percentageSchema,
    inventory: z
      .object({
        totalQuantity: positiveSafeIntegerSchema,
        bucketQuantities: z.array(inventoryBucketSchema).min(1).max(10_000),
      })
      .strict(),
    evidenceCompleteness: z.literal("complete"),
    coverage: z
      .object({
        declaredCoverage: probabilitySchema,
        calculatedCoverage: probabilitySchema,
        tolerance: z.literal(0.000_001),
        probabilityBucketCount: positiveSafeIntegerSchema,
        topChaseCount: nonnegativeSafeIntegerSchema,
      })
      .strict(),
    probabilityBuckets: z.array(evBucketSchema).min(1).max(10_000),
    topChases: z.array(evBucketSchema).max(10_000),
    readiness: z
      .object({ status: z.literal("ready"), reasons: z.array(z.never()).length(0) })
      .strict(),
    dataQualityEvidence: z.array(dataQualityEvidenceSchema).max(128),
  })
  .strict()
  .superRefine((content, context) => {
    if (
      content.coverage.probabilityBucketCount !==
        content.probabilityBuckets.length ||
      content.coverage.topChaseCount !== content.topChases.length
    ) {
      context.addIssue({
        code: "custom",
        message: "provider_source.ev_coverage_counts_invalid",
        path: ["coverage"],
      });
    }
    if (
      Math.abs(content.coverage.calculatedCoverage - 1) >
        content.coverage.tolerance ||
      Math.abs(
        content.coverage.declaredCoverage -
          content.coverage.calculatedCoverage,
      ) > content.coverage.tolerance
    ) {
      context.addIssue({
        code: "custom",
        message: "provider_source.ev_coverage_invalid",
        path: ["coverage"],
      });
    }
    const probabilityIds = content.probabilityBuckets.map(
      ({ bucketId }) => bucketId,
    );
    const inventoryIds = content.inventory.bucketQuantities.map(
      ({ bucketId }) => bucketId,
    );
    if (
      new Set(probabilityIds).size !== probabilityIds.length ||
      new Set(inventoryIds).size !== inventoryIds.length ||
      probabilityIds.length !== inventoryIds.length ||
      probabilityIds.some((id, index) => id !== inventoryIds[index]) ||
      content.inventory.bucketQuantities.reduce(
        (sum, bucket) => sum + bucket.quantity,
        0,
      ) !== content.inventory.totalQuantity
    ) {
      context.addIssue({
        code: "custom",
        message: "provider_source.ev_inventory_invalid",
        path: ["inventory"],
      });
    }
  });

export const providerSourceCanonicalPullContentV1Schema = z
  .object({
    eventKind: z.literal("pull"),
    displayName: boundedTextSchema.nullable(),
    imageUrls: z.array(imageReferenceSchema).max(64),
    value: canonicalMoneySchema.nullable(),
    valueSource: boundedTextSchema.nullable(),
  })
  .strict();

export const providerSourceCanonicalMarketEventContentV1Schema = z
  .object({
    eventKind: z.literal("market_event"),
    providerEventType: boundedIdentitySchema.max(128),
    eventCategory: z.enum([
      "listed",
      "unlisted",
      "sale",
      "mint",
      "transfer",
      "other",
    ]),
    amount: canonicalMoneySchema.nullable(),
    paymentMethod: boundedTextSchema.max(4_096).nullable(),
    displayName: boundedTextSchema.nullable(),
    imageUrls: z.array(imageReferenceSchema).max(64),
  })
  .strict();

export const providerSourceCanonicalContentV1Schemas = Object.freeze({
  pack: providerSourceCanonicalPackContentV1Schema,
  catalog_asset: providerSourceCanonicalCatalogAssetContentV1Schema,
  ev_input: providerSourceCanonicalEvInputContentV1Schema,
  pull: providerSourceCanonicalPullContentV1Schema,
  market_event: providerSourceCanonicalMarketEventContentV1Schema,
});

export type ProviderSourceCanonicalPackContentV1 = z.infer<
  typeof providerSourceCanonicalPackContentV1Schema
>;
export type ProviderSourceCanonicalCatalogAssetContentV1 = z.infer<
  typeof providerSourceCanonicalCatalogAssetContentV1Schema
>;
export type ProviderSourceCanonicalEvInputContentV1 = z.infer<
  typeof providerSourceCanonicalEvInputContentV1Schema
>;
export type ProviderSourceCanonicalPullContentV1 = z.infer<
  typeof providerSourceCanonicalPullContentV1Schema
>;
export type ProviderSourceCanonicalMarketEventContentV1 = z.infer<
  typeof providerSourceCanonicalMarketEventContentV1Schema
>;
