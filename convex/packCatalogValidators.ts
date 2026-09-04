import { v, type Infer } from "convex/values";

/**
 * Convex document validators for the `pack_catalog_v1` store
 * (pack-version-publication/005). They mirror the P01 Zod contracts field for
 * field so every stored snapshot, head, and profile is shaped exactly like the
 * bytes the publisher sealed; the Zod schemas remain the semantic authority
 * and re-validate documents on the read path.
 */

const sha256Validator = v.string();
const timestampValidator = v.string();
const nullableText = v.union(v.string(), v.null());

export const packCatalogMoneyValidator = v.object({
  currency: v.string(),
  minorUnits: v.number(),
});

export const packCatalogCategoryValidator = v.object({
  publicCategoryId: v.string(),
  label: v.string(),
});

export const packAvailabilityValidator = v.union(
  v.literal("available"),
  v.literal("unavailable"),
  v.literal("sold_out"),
  v.literal("unknown"),
);
export const packRetirementValidator = v.union(v.literal("active"), v.literal("retired"));

export const packLifecycleValidator = v.object({
  availability: packAvailabilityValidator,
  retirement: packRetirementValidator,
  availabilityEvidence: v.union(
    v.object({
      kind: v.literal("canonical_state"),
      canonicalState: v.union(v.literal("active"), v.literal("disabled"), v.literal("unknown")),
      sourceIdentity: v.string(),
    }),
    v.object({ kind: v.literal("explicit_sold_out"), sourceIdentity: v.string() }),
  ),
  retirementEvidence: v.union(
    v.object({ kind: v.literal("not_retired") }),
    v.object({ kind: v.literal("explicit_provider_retirement"), evidenceIdentity: v.string() }),
  ),
});

export const packValuationValidator = v.union(
  v.object({
    status: v.literal("available"),
    amount: packCatalogMoneyValidator,
    valuationIdentity: sha256Validator,
    observedAt: timestampValidator,
  }),
  v.object({
    status: v.literal("unavailable"),
    valuationIdentity: sha256Validator,
    reason: v.union(v.literal("NO_MARKET_EVIDENCE"), v.literal("NOT_ELIGIBLE")),
  }),
);

export const packContentValidator = v.object({
  publicCollectibleId: v.string(),
  collectibleProfileSnapshotId: v.string(),
  displayName: v.string(),
  imageUrl: nullableText,
  category: packCatalogCategoryValidator,
  quantity: v.number(),
  probabilityMicros: v.number(),
  eligibleForChase: v.boolean(),
  valuation: packValuationValidator,
});

export const packChaseValidator = v.union(
  v.null(),
  v.object({
    publicCollectibleId: v.string(),
    valuationIdentity: sha256Validator,
    amount: packCatalogMoneyValidator,
  }),
);

export const packEvValidator = v.union(
  v.object({
    status: v.literal("available"),
    amount: packCatalogMoneyValidator,
    evaluatedAt: timestampValidator,
    validUntil: timestampValidator,
  }),
  v.object({
    status: v.literal("unavailable"),
    reason: v.literal("NO_CALCULABLE_VALUE"),
    evaluatedAt: timestampValidator,
    validUntil: timestampValidator,
  }),
);

export const packActionValidator = v.object({
  actionId: v.string(),
  kind: v.union(v.literal("purchase"), v.literal("promotion")),
  label: v.string(),
  url: v.string(),
  enabled: v.boolean(),
  disabledReason: v.union(v.literal("PACK_UNAVAILABLE"), v.literal("PACK_RETIRED"), v.null()),
});

export const packSummaryCoreValidator = v.object({
  publicRepackId: v.string(),
  providerId: v.string(),
  title: v.string(),
  imageUrl: v.string(),
  category: packCatalogCategoryValidator,
  price: packCatalogMoneyValidator,
  lifecycle: packLifecycleValidator,
  topChase: packChaseValidator,
  ev: packEvValidator,
  hasEnabledAction: v.boolean(),
});

export const packSearchProjectionValidator = v.object({
  publicRepackId: v.string(),
  normalizedText: v.string(),
  aliases: v.array(v.string()),
  categoryIds: v.array(v.string()),
});

export const packSnapshotIdentityValidator = v.object({
  providerId: v.string(),
  publicRepackId: v.string(),
  publicPackSnapshotId: v.string(),
  contentSha256: sha256Validator,
  summarySha256: sha256Validator,
  dataAsOf: timestampValidator,
  evMethodIdentity: v.string(),
  evPolicyIdentity: v.string(),
});

export const packSnapshotBatchDescriptorValidator = v.object({
  publicPackSnapshotId: v.string(),
  batchIndex: v.number(),
  recordCount: v.number(),
  byteCount: v.number(),
  batchSha256: sha256Validator,
});

export const packSnapshotDescriptorValidator = v.object({
  identity: packSnapshotIdentityValidator,
  lifecycle: packLifecycleValidator,
  contentCount: v.number(),
  valuationDependencyCount: v.number(),
  probabilityInputsSha256: sha256Validator,
  valuationsSha256: sha256Validator,
  evInputsSha256: sha256Validator,
  economicsSha256: sha256Validator,
  batches: v.array(packSnapshotBatchDescriptorValidator),
  completionState: v.literal("complete"),
});

/** The P01 payload without `contents` and its two contents-derived vectors. */
export const packSnapshotHeaderValidator = v.object({
  schemaVersion: v.literal("pack_catalog_v1"),
  snapshotKind: v.union(v.literal("full"), v.literal("lifecycle_only")),
  providerId: v.string(),
  publicRepackId: v.string(),
  providerProfileSnapshotId: v.string(),
  dataAsOf: timestampValidator,
  title: v.string(),
  imageUrl: v.string(),
  category: packCatalogCategoryValidator,
  price: packCatalogMoneyValidator,
  lifecycle: packLifecycleValidator,
  contentCount: v.number(),
  probabilityTotalMicros: v.number(),
  probabilityInputsSha256: sha256Validator,
  valuationsSha256: sha256Validator,
  topChase: packChaseValidator,
  evMethodIdentity: v.string(),
  evPolicyIdentity: v.string(),
  evInputsSha256: sha256Validator,
  ev: packEvValidator,
  economicsSha256: sha256Validator,
  lifecycleFreeze: v.union(
    v.null(),
    v.object({
      previousSnapshotId: v.string(),
      retainedEconomicsSha256: sha256Validator,
      provenanceIdentity: v.string(),
    }),
  ),
  actions: v.array(packActionValidator),
  summaryProjection: packSummaryCoreValidator,
  searchProjection: packSearchProjectionValidator,
});

export const publicationWorkStateValidator = v.union(
  v.literal("waiting"),
  v.literal("ready"),
  v.literal("publishing"),
  v.literal("retry_scheduled"),
  v.literal("blocked"),
  v.literal("published"),
  v.literal("superseded"),
  v.literal("rolled_back"),
);

export const publicationReasonCodeValidator = v.union(
  v.literal("INCOMPLETE_CONTENTS"),
  v.literal("INVALID_PROBABILITIES"),
  v.literal("EV_INPUTS_PENDING"),
  v.literal("EV_TECHNICAL_RETRY"),
  v.literal("INVALID_DOMAIN_DATA"),
  v.literal("PROFILE_HEAD_MISSING"),
  v.literal("PROVIDER_UNREACHABLE"),
  v.literal("TRANSPORT_TIMEOUT"),
  v.literal("RECEIPT_AMBIGUOUS"),
  v.literal("LEASE_LOST"),
  v.literal("ACTIVATION_CONFLICT"),
  v.literal("OPERATOR_HOLD"),
  v.literal("AUTHORIZATION_REFUSED"),
  v.literal("OPERATION_EXPIRED"),
);

export const packSnapshotStateValidator = v.union(
  v.literal("staging"),
  v.literal("complete"),
  v.literal("blocked"),
);

const profileIdentityFields = {
  publicProfileSnapshotId: v.string(),
  contentSha256: sha256Validator,
  sourceIdentity: v.string(),
  dataAsOf: timestampValidator,
};
export const profileSnapshotIdentityValidator = v.union(
  v.object({ profileKind: v.literal("provider"), providerId: v.string(), ...profileIdentityFields }),
  v.object({ profileKind: v.literal("collectible"), publicCollectibleId: v.string(), ...profileIdentityFields }),
);

export const providerProfileValidator = v.object({
  identity: v.object({ profileKind: v.literal("provider"), providerId: v.string(), ...profileIdentityFields }),
  displayName: v.string(),
  brandAssets: v.array(v.object({
    kind: v.union(v.literal("logo"), v.literal("banner")),
    url: v.string(),
    alt: v.string(),
  })),
  promotions: v.array(v.object({
    promotionId: v.string(),
    label: v.string(),
    copy: v.string(),
    url: v.string(),
  })),
});

export const collectibleProfileValidator = v.object({
  identity: v.object({ profileKind: v.literal("collectible"), publicCollectibleId: v.string(), ...profileIdentityFields }),
  displayName: v.string(),
  imageUrl: nullableText,
  category: packCatalogCategoryValidator,
  aliases: v.array(v.string()),
  searchText: v.string(),
  valuationDisplay: packValuationValidator,
});

export const profileSnapshotDescriptorValidator = v.object({
  identity: profileSnapshotIdentityValidator,
  batch: v.object({
    publicProfileSnapshotId: v.string(),
    batchIndex: v.number(),
    recordCount: v.number(),
    byteCount: v.number(),
    batchSha256: sha256Validator,
  }),
  completionState: v.literal("complete"),
});

export type StoredPackSnapshotHeader = Infer<typeof packSnapshotHeaderValidator>;
export type StoredPackSnapshotDescriptor = Infer<typeof packSnapshotDescriptorValidator>;
export type StoredPackContent = Infer<typeof packContentValidator>;
export type StoredPackSummaryCore = Infer<typeof packSummaryCoreValidator>;
export type StoredProviderProfile = Infer<typeof providerProfileValidator>;
export type StoredCollectibleProfile = Infer<typeof collectibleProfileValidator>;
