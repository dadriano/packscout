import { z } from "zod";
import {
  canonicalArraySchema,
  nonBlankTextSchema,
  publicCategoryIdSchema,
  publicCategorySchema,
  publicChaseEvidenceKindSchema,
  publicCollectibleIdSchema,
  publicCollectibleTypeSchema,
  publicHttpsOriginSchema,
  publicRepackIdSchema,
  publicVendorSchema,
  timestampSchema,
} from "./data-release-v2.ts";
import { providerPlatformKeySchema } from "./provider.ts";

export const APPROVED_PUBLIC_CATALOG_CONFIGURATION_VERSION =
  "approved_public_catalog_v1" as const;
export const MAX_APPROVED_PUBLIC_PLATFORMS = 8 as const;

const sourceValueSchema = nonBlankTextSchema(240);

const categoryMappingSchema = z.object({
  sourceValue: sourceValueSchema,
  publicCategoryIds: canonicalArraySchema(publicCategoryIdSchema, 32),
}).strict();

const collectibleTypeMappingSchema = z.object({
  sourceValue: sourceValueSchema,
  collectibleType: publicCollectibleTypeSchema,
}).strict();

export const approvedPublicPlatformConfigurationSchema = z.object({
  platformKey: providerPlatformKeySchema,
  vendor: publicVendorSchema,
  format: z.enum(["repack", "gacha"]),
  defaultPublicCategoryIds: canonicalArraySchema(publicCategoryIdSchema, 32),
  categoryMappings: z.array(categoryMappingSchema).max(512),
  collectibleTypeMappings: z.array(collectibleTypeMappingSchema).max(128),
}).strict().superRefine((platform, context) => {
  const sortedUnique = <T>(values: readonly T[], key: (value: T) => string) =>
    values.every((value, index) => index === 0 || key(values[index - 1]!) < key(value));
  if (!sortedUnique(platform.categoryMappings, ({ sourceValue }) => sourceValue)) {
    context.addIssue({ code: "custom", path: ["categoryMappings"], message: "public_config.category_mappings_not_canonical" });
  }
  if (!sortedUnique(platform.collectibleTypeMappings, ({ sourceValue }) => sourceValue)) {
    context.addIssue({ code: "custom", path: ["collectibleTypeMappings"], message: "public_config.type_mappings_not_canonical" });
  }
});

export const approvedPublicCollectibleMappingSchema = z.object({
  platformKey: providerPlatformKeySchema,
  externalId: nonBlankTextSchema(500),
  publicCollectibleId: publicCollectibleIdSchema,
  aliases: canonicalArraySchema(nonBlankTextSchema(240), 32),
  collectibleType: publicCollectibleTypeSchema,
  publicCategoryIds: canonicalArraySchema(publicCategoryIdSchema, 32),
  year: z.number().int().min(1000).max(9999).nullable(),
  brand: nonBlankTextSchema(120).nullable(),
  setOrSeries: nonBlankTextSchema(200).nullable(),
  cardNumber: nonBlankTextSchema(100).nullable(),
  referenceNumber: nonBlankTextSchema(100).nullable(),
  subject: nonBlankTextSchema(200).nullable(),
  grade: nonBlankTextSchema(100).nullable(),
  grader: nonBlankTextSchema(100).nullable(),
  probabilityBucketId: nonBlankTextSchema(240).nullable(),
  matchConfidenceBasisPoints: z.number().int().min(0).max(10_000),
  chaseEvidenceKinds: canonicalArraySchema(publicChaseEvidenceKindSchema, 8)
    .refine((values) => values.length > 0, {
      message: "public_config.chase_evidence_required",
    }),
}).strict();

export const approvedPublicRepackIdentityMappingSchema = z.object({
  platformKey: providerPlatformKeySchema,
  packExternalId: nonBlankTextSchema(500),
  publicRepackId: publicRepackIdSchema,
}).strict();

export const approvedPublicConfidencePolicySchema = z.object({
  version: nonBlankTextSchema(128),
  completeScoreBasisPoints: z.number().int().min(0).max(10_000),
  partialScoreBasisPoints: z.number().int().min(0).max(10_000),
  unknownScoreBasisPoints: z.number().int().min(0).max(10_000),
  limitationPenaltyBasisPoints: z.number().int().min(0).max(10_000),
}).strict().refine(
  ({ completeScoreBasisPoints, partialScoreBasisPoints, unknownScoreBasisPoints }) =>
    completeScoreBasisPoints >= partialScoreBasisPoints &&
    partialScoreBasisPoints >= unknownScoreBasisPoints,
  { message: "public_config.confidence_scores_not_monotonic" },
);

export const approvedPublicCatalogConfigurationV1Schema = z.object({
  schemaVersion: z.literal(APPROVED_PUBLIC_CATALOG_CONFIGURATION_VERSION),
  configurationKey: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/),
  revision: z.number().int().safe().positive(),
  approvedAt: timestampSchema,
  staleAfterSeconds: z.number().int().safe().min(60).max(31_536_000),
  confidencePolicy: approvedPublicConfidencePolicySchema,
  publicAssetOrigins: canonicalArraySchema(publicHttpsOriginSchema, 64),
  categories: z.array(publicCategorySchema).max(4_096),
  platforms: z.array(approvedPublicPlatformConfigurationSchema)
    .min(1)
    .max(MAX_APPROVED_PUBLIC_PLATFORMS, {
      message: "public_config.platform_limit_exceeded",
    }),
  repacks: z.array(approvedPublicRepackIdentityMappingSchema).max(8_000),
  collectibles: z.array(approvedPublicCollectibleMappingSchema).max(100_000),
}).strict().superRefine((configuration, context) => {
  const sortedUnique = <T>(values: readonly T[], key: (value: T) => string) =>
    values.every((value, index) => index === 0 || key(values[index - 1]!) < key(value));
  const checks = [
    ["categories", sortedUnique(configuration.categories, ({ publicCategoryId }) => publicCategoryId)],
    ["platforms", sortedUnique(configuration.platforms, ({ platformKey }) => platformKey)],
    ["repacks", sortedUnique(configuration.repacks, ({ platformKey, packExternalId }) => `${platformKey}\u0000${packExternalId}`)],
    ["collectibles", sortedUnique(configuration.collectibles, ({ platformKey, externalId }) => `${platformKey}\u0000${externalId}`)],
  ] as const;
  for (const [path, valid] of checks) {
    if (!valid) context.addIssue({ code: "custom", path: [path], message: "public_config.not_canonical" });
  }
  const categoryIds = new Set(configuration.categories.map(({ publicCategoryId }) => publicCategoryId));
  const platformKeys = new Set(configuration.platforms.map(({ platformKey }) => platformKey));
  const referencedCategoryIds = [
    ...configuration.platforms.flatMap((platform) => [
      ...platform.defaultPublicCategoryIds,
      ...platform.categoryMappings.flatMap(({ publicCategoryIds }) => publicCategoryIds),
    ]),
    ...configuration.collectibles.flatMap(({ publicCategoryIds }) => publicCategoryIds),
  ];
  if (referencedCategoryIds.some((id) => !categoryIds.has(id))) {
    context.addIssue({ code: "custom", message: "public_config.category_reference_missing" });
  }
  if ([...configuration.repacks, ...configuration.collectibles]
      .some(({ platformKey }) => !platformKeys.has(platformKey)) ||
      new Set(configuration.repacks.map(({ publicRepackId }) => publicRepackId)).size !==
        configuration.repacks.length ||
      new Set(configuration.collectibles.map(({ publicCollectibleId }) => publicCollectibleId)).size !==
        configuration.collectibles.length) {
    context.addIssue({ code: "custom", message: "public_config.identity_mapping_invalid" });
  }
  const governedOrigins = new Set(configuration.publicAssetOrigins);
  if (configuration.platforms.some(({ vendor }) =>
    vendor.imageOrigins.some((origin) => !governedOrigins.has(origin)))) {
    context.addIssue({ code: "custom", message: "public_config.origin_not_governed" });
  }
});

export type ApprovedPublicCatalogConfigurationV1 = z.infer<
  typeof approvedPublicCatalogConfigurationV1Schema
>;
export type ApprovedPublicPlatformConfiguration = z.infer<
  typeof approvedPublicPlatformConfigurationSchema
>;
export type ApprovedPublicCollectibleMapping = z.infer<
  typeof approvedPublicCollectibleMappingSchema
>;
export type ApprovedPublicRepackIdentityMapping = z.infer<
  typeof approvedPublicRepackIdentityMappingSchema
>;
