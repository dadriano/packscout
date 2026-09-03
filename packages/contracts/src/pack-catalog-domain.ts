import { z } from "zod";
import { publicHttpsUrlSchema } from "./public-url.ts";
import {
  PACK_CATALOG_V1,
  PACK_SNAPSHOT_HASH_DOMAIN,
  PACK_SNAPSHOT_BATCH_MAX_BYTES,
  PACK_SNAPSHOT_BATCH_MAX_ITEMS,
  PACK_SNAPSHOT_MAX_CONTENTS,
  derivePublicPackSnapshotId,
  derivePublicProfileSnapshotId,
  compareCanonicalStrings,
  isCanonicalAscending,
  hashPackCatalogValue,
  normalizePackCatalogSearchText,
  packCatalogCanonicalJson,
  packCatalogSha256Schema,
  packCatalogTextSchema,
  packCatalogTimestampSchema,
  packCatalogUuidSchema,
} from "./pack-catalog-v1.ts";

const imageUrlSchema = publicHttpsUrlSchema;
export const publicPackSnapshotIdSchema = z.string().regex(/^pps_[0-9a-f]{64}$/u);
export const publicProfileSnapshotIdSchema = z.string().regex(/^ppfs_[0-9a-f]{64}$/u);
const canonicalStrings = (schema: z.ZodType<string>, maximum: number) => z
  .array(schema)
  .max(maximum)
  .refine((values) => isCanonicalAscending(values), "Values must be unique and sorted.");

export const packCatalogMoneySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  minorUnits: z.number().int().safe().nonnegative(),
}).strict();

export const packCatalogPublicPackAvailabilitySchema = z.enum([
  "available",
  "unavailable",
  "sold_out",
  "unknown",
]);
export const publicPackRetirementSchema = z.enum(["active", "retired"]);

const availabilityEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("canonical_state"),
    canonicalState: z.enum(["active", "disabled", "unknown"]),
    sourceIdentity: packCatalogTextSchema(200),
  }).strict(),
  z.object({
    kind: z.literal("explicit_sold_out"),
    sourceIdentity: packCatalogTextSchema(200),
  }).strict(),
]);
const retirementEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_retired") }).strict(),
  z.object({
    kind: z.literal("explicit_provider_retirement"),
    evidenceIdentity: packCatalogTextSchema(200),
  }).strict(),
]);

export const publicPackLifecycleSchema = z.object({
  availability: packCatalogPublicPackAvailabilitySchema,
  retirement: publicPackRetirementSchema,
  availabilityEvidence: availabilityEvidenceSchema,
  retirementEvidence: retirementEvidenceSchema,
}).strict().superRefine((value, context) => {
  const expectedAvailability = value.availabilityEvidence.kind === "explicit_sold_out"
    ? "sold_out"
    : ({ active: "available", disabled: "unavailable", unknown: "unknown" } as const)[
      value.availabilityEvidence.canonicalState
    ];
  if (value.availability !== expectedAvailability) {
    context.addIssue({ code: "custom", path: ["availability"], message: "pack.lifecycle_mapping_invalid" });
  }
  const explicitRetirement = value.retirementEvidence.kind === "explicit_provider_retirement";
  if ((value.retirement === "retired") !== explicitRetirement) {
    context.addIssue({ code: "custom", path: ["retirementEvidence"], message: "pack.retirement_evidence_invalid" });
  }
});

export const publicCategoryDisplaySchema = z.object({
  publicCategoryId: packCatalogUuidSchema,
  label: packCatalogTextSchema(120),
}).strict();

const valuationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    amount: packCatalogMoneySchema,
    valuationIdentity: packCatalogSha256Schema,
    observedAt: packCatalogTimestampSchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    valuationIdentity: packCatalogSha256Schema,
    reason: z.enum(["NO_MARKET_EVIDENCE", "NOT_ELIGIBLE"]),
  }).strict(),
]);

export const publicPackContentSchema = z.object({
  publicCollectibleId: packCatalogUuidSchema,
  collectibleProfileSnapshotId: publicProfileSnapshotIdSchema,
  displayName: packCatalogTextSchema(200),
  imageUrl: imageUrlSchema.nullable(),
  category: publicCategoryDisplaySchema,
  quantity: z.number().int().safe().min(1).max(10_000),
  probabilityMicros: z.number().int().safe().min(1).max(1_000_000),
  eligibleForChase: z.boolean(),
  valuation: valuationSchema,
}).strict().superRefine((value, context) => {
  if (value.eligibleForChase && value.valuation.status !== "available") {
    context.addIssue({ code: "custom", path: ["valuation"], message: "pack.chase_valuation_required" });
  }
});

export const publicPackChaseSchema = z.object({
  publicCollectibleId: packCatalogUuidSchema,
  valuationIdentity: packCatalogSha256Schema,
  amount: packCatalogMoneySchema,
}).strict().nullable();

export const publicPackEvResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    amount: packCatalogMoneySchema,
    evaluatedAt: packCatalogTimestampSchema,
    validUntil: packCatalogTimestampSchema,
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.literal("NO_CALCULABLE_VALUE"),
    evaluatedAt: packCatalogTimestampSchema,
    validUntil: packCatalogTimestampSchema,
  }).strict(),
]).refine(
  ({ evaluatedAt, validUntil }) => Date.parse(validUntil) > Date.parse(evaluatedAt),
  "Pack EV evidence must expire after evaluation.",
);

export const publicPackActionSchema = z.object({
  actionId: z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,63})$/u),
  kind: z.enum(["purchase", "promotion"]),
  label: packCatalogTextSchema(100),
  url: publicHttpsUrlSchema,
  enabled: z.boolean(),
  disabledReason: z.enum(["PACK_UNAVAILABLE", "PACK_RETIRED"]).nullable(),
}).strict().superRefine((value, context) => {
  if (value.enabled === (value.disabledReason !== null)) {
    context.addIssue({ code: "custom", path: ["disabledReason"], message: "pack.action_state_invalid" });
  }
});

export const publicPackSummaryCoreSchema = z.object({
  publicRepackId: packCatalogUuidSchema,
  providerId: packCatalogUuidSchema,
  title: packCatalogTextSchema(200),
  imageUrl: imageUrlSchema,
  category: publicCategoryDisplaySchema,
  price: packCatalogMoneySchema,
  lifecycle: publicPackLifecycleSchema,
  topChase: publicPackChaseSchema,
  ev: publicPackEvResultSchema,
  hasEnabledAction: z.boolean(),
}).strict();

export const publicPackSearchProjectionSchema = z.object({
  publicRepackId: packCatalogUuidSchema,
  normalizedText: z.string().min(1).max(1_024),
  aliases: canonicalStrings(packCatalogTextSchema(120), 100),
  categoryIds: canonicalStrings(packCatalogUuidSchema, 100),
}).strict();

const lifecycleFreezeSchema = z.object({
  previousSnapshotId: publicPackSnapshotIdSchema,
  retainedEconomicsSha256: packCatalogSha256Schema,
  provenanceIdentity: packCatalogTextSchema(200),
}).strict().nullable();

const publicPackSnapshotPayloadBaseSchema = z.object({
  schemaVersion: z.literal(PACK_CATALOG_V1),
  snapshotKind: z.enum(["full", "lifecycle_only"]),
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  providerProfileSnapshotId: publicProfileSnapshotIdSchema,
  collectibleProfileSnapshotIds: canonicalStrings(publicProfileSnapshotIdSchema, PACK_SNAPSHOT_MAX_CONTENTS),
  dataAsOf: packCatalogTimestampSchema,
  title: packCatalogTextSchema(200),
  imageUrl: imageUrlSchema,
  category: publicCategoryDisplaySchema,
  price: packCatalogMoneySchema,
  lifecycle: publicPackLifecycleSchema,
  contents: z.array(publicPackContentSchema).min(1).max(PACK_SNAPSHOT_MAX_CONTENTS),
  contentCount: z.number().int().safe().min(1).max(PACK_SNAPSHOT_MAX_CONTENTS),
  probabilityTotalMicros: z.literal(1_000_000),
  probabilityInputsSha256: packCatalogSha256Schema,
  valuationDependencyIdentities: canonicalStrings(packCatalogSha256Schema, PACK_SNAPSHOT_MAX_CONTENTS),
  valuationsSha256: packCatalogSha256Schema,
  topChase: publicPackChaseSchema,
  evMethodIdentity: packCatalogTextSchema(120),
  evPolicyIdentity: packCatalogTextSchema(120),
  evInputsSha256: packCatalogSha256Schema,
  ev: publicPackEvResultSchema,
  economicsSha256: packCatalogSha256Schema,
  lifecycleFreeze: lifecycleFreezeSchema,
  actions: z.array(publicPackActionSchema).max(50),
  summaryProjection: publicPackSummaryCoreSchema,
  searchProjection: publicPackSearchProjectionSchema,
}).strict();

function expectedTopChase(contents: readonly PublicPackContent[]) {
  const eligible = contents.filter((entry) =>
    entry.eligibleForChase && entry.valuation.status === "available"
  );
  eligible.sort((left, right) => {
    const amount = right.valuation.status === "available" && left.valuation.status === "available"
      ? right.valuation.amount.minorUnits - left.valuation.amount.minorUnits
      : 0;
    return amount || compareCanonicalStrings(left.publicCollectibleId, right.publicCollectibleId);
  });
  const winner = eligible[0];
  if (!winner || winner.valuation.status !== "available") return null;
  return {
    publicCollectibleId: winner.publicCollectibleId,
    valuationIdentity: winner.valuation.valuationIdentity,
    amount: winner.valuation.amount,
  };
}

export function publicPackSummaryCore(
  value: Pick<PublicPackSnapshotPayload, "publicRepackId" | "providerId" | "title" | "imageUrl" | "category" | "price" | "lifecycle" | "topChase" | "ev" | "actions">,
) {
  return {
    publicRepackId: value.publicRepackId,
    providerId: value.providerId,
    title: value.title,
    imageUrl: value.imageUrl,
    category: value.category,
    price: value.price,
    lifecycle: value.lifecycle,
    topChase: value.topChase,
    ev: value.ev,
    hasEnabledAction: value.actions.some((action) => action.enabled),
  };
}

export const publicPackSnapshotPayloadSchema = publicPackSnapshotPayloadBaseSchema
  .superRefine((value, context) => {
    const issue = (path: PropertyKey[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const contentIds = value.contents.map(({ publicCollectibleId }) => publicCollectibleId);
    if (!isCanonicalAscending(contentIds)) issue(["contents"], "pack.contents_not_canonical");
    if (!isCanonicalAscending(value.actions.map(({ actionId }) => actionId))) {
      issue(["actions"], "pack.actions_not_canonical");
    }
    if (value.contentCount !== value.contents.length) issue(["contentCount"], "pack.content_count_mismatch");
    if (value.contents.reduce((sum, entry) => sum + entry.probabilityMicros, 0) !== 1_000_000) {
      issue(["probabilityTotalMicros"], "pack.probability_coverage_invalid");
    }
    const profileIds = value.contents.map(({ collectibleProfileSnapshotId }) => collectibleProfileSnapshotId).sort(compareCanonicalStrings);
    if (packCatalogCanonicalJson(profileIds) !== packCatalogCanonicalJson(value.collectibleProfileSnapshotIds)) {
      issue(["collectibleProfileSnapshotIds"], "pack.profile_dependencies_mismatch");
    }
    const valuationIds = value.contents
      .filter(({ eligibleForChase }) => eligibleForChase)
      .map(({ valuation }) => valuation.valuationIdentity)
      .sort(compareCanonicalStrings);
    if (packCatalogCanonicalJson(valuationIds) !== packCatalogCanonicalJson(value.valuationDependencyIdentities)) {
      issue(["valuationDependencyIdentities"], "pack.valuation_dependencies_mismatch");
    }
    if (packCatalogCanonicalJson(expectedTopChase(value.contents)) !== packCatalogCanonicalJson(value.topChase)) {
      issue(["topChase"], "pack.top_chase_invalid");
    }
    const actionable = value.lifecycle.availability === "available" && value.lifecycle.retirement === "active";
    const disabledReason = value.lifecycle.retirement === "retired" ? "PACK_RETIRED" : actionable ? null : "PACK_UNAVAILABLE";
    if (value.actions.some((action) => action.enabled !== actionable || action.disabledReason !== disabledReason)) {
      issue(["actions"], "pack.action_not_eligible");
    }
    const currencies = [
      value.price.currency,
      ...value.contents.flatMap(({ valuation }) => valuation.status === "available" ? [valuation.amount.currency] : []),
      ...(value.topChase === null ? [] : [value.topChase.amount.currency]),
      ...(value.ev.status === "available" ? [value.ev.amount.currency] : []),
    ];
    if (currencies.some((currency) => currency !== value.price.currency)) {
      issue(["price", "currency"], "pack.currency_mismatch");
    }
    if (packCatalogCanonicalJson(publicPackSummaryCore(value)) !== packCatalogCanonicalJson(value.summaryProjection)) {
      issue(["summaryProjection"], "pack.summary_projection_mismatch");
    }
    if (value.lifecycleFreeze !== null &&
      value.lifecycleFreeze.retainedEconomicsSha256 !== value.economicsSha256) {
      issue(["lifecycleFreeze"], "pack.lifecycle_economics_mismatch");
    }
    if ((value.snapshotKind === "lifecycle_only") !== (value.lifecycleFreeze !== null)) {
      issue(["lifecycleFreeze"], "pack.lifecycle_freeze_required");
    }
    if (value.searchProjection.publicRepackId !== value.publicRepackId) {
      issue(["searchProjection"], "pack.search_projection_mismatch");
    }
    const expectedCategories = [...new Set([
      value.category.publicCategoryId,
      ...value.contents.map(({ category }) => category.publicCategoryId),
    ])].sort(compareCanonicalStrings);
    const expectedSearchText = normalizePackCatalogSearchText([
      value.title,
      ...value.contents.map(({ displayName }) => displayName),
      ...value.searchProjection.aliases,
    ].join(" "));
    if (value.searchProjection.normalizedText !== expectedSearchText ||
      packCatalogCanonicalJson(value.searchProjection.categoryIds) !== packCatalogCanonicalJson(expectedCategories)) {
      issue(["searchProjection"], "pack.search_projection_mismatch");
    }
  });

export function normalizePublicPackSnapshotPayload(value: unknown): PublicPackSnapshotPayload {
  const record = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const stringOrder = (values: unknown) => Array.isArray(values)
    ? [...values].sort((left, right) => compareCanonicalStrings(String(left), String(right)))
    : values;
  const objectOrder = (values: unknown, key: string) => Array.isArray(values)
    ? [...values].sort((left, right) => {
      const leftKey = typeof left === "object" && left !== null ? String((left as Record<string, unknown>)[key]) : "";
      const rightKey = typeof right === "object" && right !== null ? String((right as Record<string, unknown>)[key]) : "";
      return compareCanonicalStrings(leftKey, rightKey);
    })
    : values;
  const search = typeof record.searchProjection === "object" && record.searchProjection !== null
    ? record.searchProjection as Record<string, unknown>
    : {};
  const parsed = publicPackSnapshotPayloadBaseSchema.parse({
    ...record,
    collectibleProfileSnapshotIds: stringOrder(record.collectibleProfileSnapshotIds),
    contents: objectOrder(record.contents, "publicCollectibleId"),
    valuationDependencyIdentities: stringOrder(record.valuationDependencyIdentities),
    actions: objectOrder(record.actions, "actionId"),
    searchProjection: {
      ...search,
      aliases: stringOrder(search.aliases),
      categoryIds: stringOrder(search.categoryIds),
    },
  });
  return publicPackSnapshotPayloadSchema.parse({
    ...parsed,
    collectibleProfileSnapshotIds: [...parsed.collectibleProfileSnapshotIds].sort(compareCanonicalStrings),
    contents: [...parsed.contents].sort((left, right) =>
      compareCanonicalStrings(left.publicCollectibleId, right.publicCollectibleId)
    ),
    valuationDependencyIdentities: [...parsed.valuationDependencyIdentities].sort(compareCanonicalStrings),
    actions: [...parsed.actions].sort((left, right) => compareCanonicalStrings(left.actionId, right.actionId)),
    searchProjection: {
      ...parsed.searchProjection,
      aliases: [...parsed.searchProjection.aliases].sort(compareCanonicalStrings),
      categoryIds: [...parsed.searchProjection.categoryIds].sort(compareCanonicalStrings),
    },
  });
}

export const publicPackSnapshotIdentitySchema = z.object({
  providerId: packCatalogUuidSchema,
  publicRepackId: packCatalogUuidSchema,
  publicPackSnapshotId: publicPackSnapshotIdSchema,
  contentSha256: packCatalogSha256Schema,
  summarySha256: packCatalogSha256Schema,
  dataAsOf: packCatalogTimestampSchema,
  evMethodIdentity: packCatalogTextSchema(120),
  evPolicyIdentity: packCatalogTextSchema(120),
}).strict().superRefine((value, context) => {
  if (value.publicPackSnapshotId !== derivePublicPackSnapshotId(value.contentSha256)) {
    context.addIssue({ code: "custom", path: ["publicPackSnapshotId"], message: "pack.snapshot_identity_invalid" });
  }
});

export const publicPackSnapshotSchema = z.object({
  identity: publicPackSnapshotIdentitySchema,
  payload: publicPackSnapshotPayloadSchema,
}).strict().superRefine(async ({ identity, payload }, context) => {
  for (const key of ["providerId", "publicRepackId", "dataAsOf", "evMethodIdentity", "evPolicyIdentity"] as const) {
    if (identity[key] !== payload[key]) {
      context.addIssue({ code: "custom", path: ["identity", key], message: "pack.snapshot_identity_mismatch" });
    }
  }
  if (identity.summarySha256 !== await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, payload.summaryProjection)) {
    context.addIssue({ code: "custom", path: ["identity", "summarySha256"], message: "pack.summary_digest_mismatch" });
  }
});

export const publicPackSnapshotBatchDescriptorSchema = z.object({
  publicPackSnapshotId: publicPackSnapshotIdSchema,
  batchIndex: z.number().int().safe().nonnegative().max(31),
  recordCount: z.number().int().safe().min(1).max(PACK_SNAPSHOT_BATCH_MAX_ITEMS),
  byteCount: z.number().int().safe().min(1).max(PACK_SNAPSHOT_BATCH_MAX_BYTES),
  batchSha256: packCatalogSha256Schema,
}).strict();
export const publicPackSnapshotBatchSchema = publicPackSnapshotBatchDescriptorSchema.extend({
  records: z.array(publicPackContentSchema).min(1).max(PACK_SNAPSHOT_BATCH_MAX_ITEMS),
}).strict().refine((value) => value.recordCount === value.records.length, "Batch count must match records.");

export const publicPackSnapshotDescriptorSchema = z.object({
  identity: publicPackSnapshotIdentitySchema,
  lifecycle: publicPackLifecycleSchema,
  contentCount: z.number().int().safe().min(1).max(PACK_SNAPSHOT_MAX_CONTENTS),
  valuationDependencyCount: z.number().int().safe().nonnegative().max(PACK_SNAPSHOT_MAX_CONTENTS),
  probabilityInputsSha256: packCatalogSha256Schema,
  valuationsSha256: packCatalogSha256Schema,
  evInputsSha256: packCatalogSha256Schema,
  economicsSha256: packCatalogSha256Schema,
  batches: z.array(publicPackSnapshotBatchDescriptorSchema).min(1).max(32),
  completionState: z.literal("complete"),
}).strict().superRefine((value, context) => {
  if (value.batches.reduce((sum, batch) => sum + batch.recordCount, 0) !== value.contentCount ||
    value.batches.some((batch, index) =>
      batch.batchIndex !== index || batch.publicPackSnapshotId !== value.identity.publicPackSnapshotId
    )) {
    context.addIssue({ code: "custom", path: ["batches"], message: "pack.batch_manifest_invalid" });
  }
});

const publicProfileSnapshotIdentityBaseSchema = z.object({
  publicProfileSnapshotId: publicProfileSnapshotIdSchema,
  contentSha256: packCatalogSha256Schema,
  sourceIdentity: packCatalogTextSchema(200),
  dataAsOf: packCatalogTimestampSchema,
}).strict();
const profileIdentityMatchesHash = (value: { publicProfileSnapshotId: string; contentSha256: string }) =>
  value.publicProfileSnapshotId === derivePublicProfileSnapshotId(value.contentSha256);
export const publicProviderProfileSnapshotIdentitySchema = publicProfileSnapshotIdentityBaseSchema.extend({
  profileKind: z.literal("provider"),
  providerId: packCatalogUuidSchema,
}).strict().refine(profileIdentityMatchesHash, "Provider profile snapshot identity is invalid.");
export const publicCollectibleProfileSnapshotIdentitySchema = publicProfileSnapshotIdentityBaseSchema.extend({
  profileKind: z.literal("collectible"),
  publicCollectibleId: packCatalogUuidSchema,
}).strict().refine(profileIdentityMatchesHash, "Collectible profile snapshot identity is invalid.");
export const publicProfileSnapshotIdentitySchema = z.union([
  publicProviderProfileSnapshotIdentitySchema,
  publicCollectibleProfileSnapshotIdentitySchema,
]).superRefine((value, context) => {
  if (value.publicProfileSnapshotId !== derivePublicProfileSnapshotId(value.contentSha256)) {
    context.addIssue({ code: "custom", path: ["publicProfileSnapshotId"], message: "profile.snapshot_identity_invalid" });
  }
});

const providerPromotionSchema = z.object({
  promotionId: z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,63})$/u),
  label: packCatalogTextSchema(100),
  copy: packCatalogTextSchema(500),
  url: publicHttpsUrlSchema,
}).strict();
export const publicProviderProfileSchema = z.object({
  identity: publicProviderProfileSnapshotIdentitySchema,
  displayName: packCatalogTextSchema(120),
  brandAssets: z.array(z.object({ kind: z.enum(["logo", "banner"]), url: imageUrlSchema, alt: packCatalogTextSchema(160) }).strict()).max(10),
  promotions: z.array(providerPromotionSchema).max(25),
}).strict().superRefine((value, context) => {
  if (!isCanonicalAscending(value.brandAssets.map(({ kind, url }) => `${kind}:${url}`)) ||
    !isCanonicalAscending(value.promotions.map(({ promotionId }) => promotionId))) {
    context.addIssue({ code: "custom", path: ["promotions"], message: "profile.values_not_canonical" });
  }
});

export const publicCollectibleProfileSchema = z.object({
  identity: publicCollectibleProfileSnapshotIdentitySchema,
  displayName: packCatalogTextSchema(200),
  imageUrl: imageUrlSchema.nullable(),
  category: publicCategoryDisplaySchema,
  aliases: canonicalStrings(packCatalogTextSchema(120), 100),
  searchText: z.string().min(1).max(1_024),
  valuationDisplay: valuationSchema,
}).strict().refine(
  (value) => value.searchText === normalizePackCatalogSearchText([
    value.displayName,
    ...value.aliases,
  ].join(" ")),
  "Collectible profile search text must be derived from display fields.",
);

export const publicProfileSnapshotBatchDescriptorSchema = z.object({
  publicProfileSnapshotId: publicProfileSnapshotIdSchema,
  batchIndex: z.literal(0),
  recordCount: z.literal(1),
  byteCount: z.number().int().safe().min(1).max(PACK_SNAPSHOT_BATCH_MAX_BYTES),
  batchSha256: packCatalogSha256Schema,
}).strict();
export const publicProfileSnapshotBatchSchema = publicProfileSnapshotBatchDescriptorSchema.extend({
  profile: z.union([publicProviderProfileSchema, publicCollectibleProfileSchema]),
}).strict().refine(
  ({ publicProfileSnapshotId, profile }) =>
    publicProfileSnapshotId === profile.identity.publicProfileSnapshotId,
  "Profile batch identity must match its record.",
);
export const publicProfileSnapshotDescriptorSchema = z.object({
  identity: publicProfileSnapshotIdentitySchema,
  batch: publicProfileSnapshotBatchDescriptorSchema,
  completionState: z.literal("complete"),
}).strict().refine(
  ({ identity, batch }) => identity.publicProfileSnapshotId === batch.publicProfileSnapshotId,
  "Profile descriptor identity must match its batch.",
);

const activeProfileHeadFields = {
  generation: z.number().int().safe().positive(),
  activeProfileSnapshotId: publicProfileSnapshotIdSchema,
  previousProfileSnapshotId: publicProfileSnapshotIdSchema.nullable(),
  contentSha256: packCatalogSha256Schema,
  activatedAt: packCatalogTimestampSchema,
};
export const activeProviderProfileHeadSchema = z.object({
  providerId: packCatalogUuidSchema,
  ...activeProfileHeadFields,
}).strict().refine(
  ({ activeProfileSnapshotId, contentSha256 }) =>
    activeProfileSnapshotId === derivePublicProfileSnapshotId(contentSha256),
  "Active provider profile head must bind its content hash.",
);
export const activeCollectibleProfileHeadSchema = z.object({
  publicCollectibleId: packCatalogUuidSchema,
  ...activeProfileHeadFields,
}).strict().refine(
  ({ activeProfileSnapshotId, contentSha256 }) =>
    activeProfileSnapshotId === derivePublicProfileSnapshotId(contentSha256),
  "Active collectible profile head must bind its content hash.",
);

export type PublicPackContent = z.infer<typeof publicPackContentSchema>;
export type PublicPackSnapshotIdentity = z.infer<typeof publicPackSnapshotIdentitySchema>;
export type PublicPackSnapshotPayload = z.infer<typeof publicPackSnapshotPayloadSchema>;
export type PublicPackSnapshot = z.infer<typeof publicPackSnapshotSchema>;
export type PublicPackSnapshotBatch = z.infer<typeof publicPackSnapshotBatchSchema>;
export type PublicPackSnapshotDescriptor = z.infer<typeof publicPackSnapshotDescriptorSchema>;
export type PublicProfileSnapshotIdentity = z.infer<typeof publicProfileSnapshotIdentitySchema>;
export type PublicProviderProfile = z.infer<typeof publicProviderProfileSchema>;
export type PublicCollectibleProfile = z.infer<typeof publicCollectibleProfileSchema>;
export type PublicProfileSnapshotBatch = z.infer<typeof publicProfileSnapshotBatchSchema>;
export type PublicProfileSnapshotDescriptor = z.infer<typeof publicProfileSnapshotDescriptorSchema>;
export type ActiveProviderProfileHead = z.infer<typeof activeProviderProfileHeadSchema>;
export type ActiveCollectibleProfileHead = z.infer<typeof activeCollectibleProfileHeadSchema>;
