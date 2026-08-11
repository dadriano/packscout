import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { catalogQueryRowValidator } from "./publicCatalogValidation";

const sha256Validator = v.string();
const timestampValidator = v.string();
const usdMoneyValidator = v.object({
  minorUnits: v.number(),
  currency: v.literal("USD"),
});
const moneyValidator = v.object({
  minorUnits: v.number(),
  currency: v.string(),
});
const signedUsdMoneyValidator = v.object({
  minorUnits: v.number(),
  currency: v.literal("USD"),
});
const basisPointsValidator = v.object({ basisPoints: v.number() });

const priceComparisonValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: usdMoneyValidator,
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.union(
      v.literal("PRICE_UNAVAILABLE"),
      v.literal("CURRENCY_UNSUPPORTED"),
    ),
    nullRank: v.literal(1),
  }),
);

const grossEvValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: usdMoneyValidator,
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.union(
      v.literal("CURRENCY_UNSUPPORTED"),
      v.literal("ESTIMATE_INPUT_INCOMPLETE"),
    ),
    nullRank: v.literal(1),
  }),
);

const grossReturnValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: basisPointsValidator,
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.union(
      v.literal("CURRENCY_UNSUPPORTED"),
      v.literal("ESTIMATE_INPUT_INCOMPLETE"),
    ),
    nullRank: v.literal(1),
  }),
);

const derivedEvDollarsValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: signedUsdMoneyValidator,
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.union(
      v.literal("PRICE_UNAVAILABLE"),
      v.literal("CURRENCY_UNSUPPORTED"),
      v.literal("ESTIMATE_INPUT_INCOMPLETE"),
    ),
    nullRank: v.literal(1),
  }),
);

const derivedEvPercentValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: basisPointsValidator,
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.union(
      v.literal("PRICE_UNAVAILABLE"),
      v.literal("CURRENCY_UNSUPPORTED"),
      v.literal("ESTIMATE_INPUT_INCOMPLETE"),
    ),
    nullRank: v.literal(1),
  }),
);

const buybackValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: v.object({
      basisPoints: v.number(),
      sourceKind: v.union(v.literal("direct"), v.literal("derived")),
    }),
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.literal("BUYBACK_UNAVAILABLE"),
    nullRank: v.literal(1),
  }),
);

const publicImageValidator = v.object({ url: v.string(), alt: v.string() });
const chaseComparisonValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: usdMoneyValidator,
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.union(
      v.literal("CHASE_UNAVAILABLE"),
      v.literal("CURRENCY_UNSUPPORTED"),
    ),
    nullRank: v.literal(1),
  }),
);
const topChaseDetailValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: v.object({
      publicChaseId: v.string(),
      name: v.string(),
      displayMoney: v.union(moneyValidator, v.null()),
      usdComparison: chaseComparisonValidator,
      primaryImage: v.union(publicImageValidator, v.null()),
      evidenceKind: v.union(
        v.literal("canonical_asset_value"),
        v.literal("canonical_asset_identity"),
      ),
      observedAt: timestampValidator,
    }),
    reason: v.null(),
    nullRank: v.literal(0),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.literal("CHASE_UNAVAILABLE"),
    nullRank: v.literal(1),
  }),
);

const referralParameterValidator = v.object({
  name: v.string(),
  value: v.string(),
});
const promoValidator = v.object({ code: v.string(), label: v.string() });
const packLinkValidator = v.object({
  listingUrl: v.string(),
  listingHost: v.string(),
  referralParameters: v.array(referralParameterValidator),
});

export const publicPackDetailValidator = v.object({
  publicPackId: v.string(),
  platformKey: v.string(),
  platformDisplayName: v.string(),
  platformLogoUrl: v.union(v.string(), v.null()),
  category: v.string(),
  name: v.string(),
  availability: v.union(v.literal("active"), v.literal("sold_out")),
  price: v.object({
    displayMoney: v.union(moneyValidator, v.null()),
    usdComparison: priceComparisonValidator,
  }),
  estimatedEv: v.object({
    grossEv: grossEvValidator,
    grossReturn: grossReturnValidator,
    evDollars: derivedEvDollarsValidator,
    evPercent: derivedEvPercentValidator,
    calculatedAt: v.union(timestampValidator, v.null()),
    coverage: v.object({
      evidenceCompleteness: v.union(
        v.literal("complete"),
        v.literal("partial"),
        v.literal("unknown"),
      ),
      probabilityCoverageBasisPoints: v.union(v.number(), v.null()),
    }),
    limitations: v.array(v.string()),
  }),
  buyback: buybackValidator,
  primaryImage: v.union(publicImageValidator, v.null()),
  topChase: topChaseDetailValidator,
  actionAvailability: v.object({ promo: v.boolean(), packLink: v.boolean() }),
  sourceFirstSeenAt: timestampValidator,
  sourceCollectedAt: timestampValidator,
  description: v.union(v.string(), v.null()),
  actions: v.object({
    promo: v.optional(promoValidator),
    packLink: v.optional(packLinkValidator),
  }),
});

export const snapshotMetadataValidator = v.object({
  schemaVersion: v.literal("catalog_snapshot_v1"),
  publicationId: v.string(),
  sourceWatermark: sha256Validator,
  manifestFingerprint: sha256Validator,
  contentHash: sha256Validator,
  publicConfigRevision: v.number(),
  publicConfigHash: sha256Validator,
  originSetHash: sha256Validator,
  createdAt: timestampValidator,
  completedAt: timestampValidator,
  dataAsOf: timestampValidator,
  lastSuccessfulObservationAt: timestampValidator,
  staleAt: timestampValidator,
  freshness: v.union(v.literal("fresh"), v.literal("delayed")),
  delayedSourceCount: v.number(),
  platformConfigCount: v.number(),
  packCount: v.number(),
  searchAlgorithmVersion: v.literal("packscout_relevance_v1"),
});

const platformConfigValidator = v.object({
  platformKey: v.string(),
  revision: v.number(),
  contentHash: sha256Validator,
  displayName: v.string(),
  logoUrl: v.union(v.string(), v.null()),
  listingHosts: v.array(v.string()),
  imageOrigins: v.array(v.string()),
  referralParameters: v.array(referralParameterValidator),
  publicPromo: v.union(promoValidator, v.null()),
});

const catalogFacetValidator = v.object({
  key: v.string(),
  label: v.string(),
  packCount: v.number(),
});

export default defineSchema({
  catalogState: defineTable({
    key: v.literal("singleton"),
    activeSnapshotId: v.union(v.id("catalogSnapshots"), v.null()),
    previousSnapshotId: v.union(v.id("catalogSnapshots"), v.null()),
    latestObservationSequence: v.number(),
    dataAsOf: timestampValidator,
    lastSuccessfulObservationAt: timestampValidator,
    staleAt: timestampValidator,
    freshness: v.union(v.literal("fresh"), v.literal("delayed")),
    delayedSourceCount: v.number(),
    updatedAt: timestampValidator,
  }).index("by_key", ["key"]),

  catalogSnapshots: defineTable({
    publicationId: v.string(),
    lifecycle: v.union(
      v.literal("staging"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("retired"),
      v.literal("blocked"),
    ),
    metadata: snapshotMetadataValidator,
    platformConfigs: v.array(platformConfigValidator),
    facets: v.object({
      platforms: v.array(catalogFacetValidator),
      categories: v.array(catalogFacetValidator),
    }),
    shardCount: v.number(),
  }).index("by_publication_id", ["publicationId"]),

  publicPacks: defineTable({
    snapshotId: v.id("catalogSnapshots"),
    publicPackId: v.string(),
    detail: publicPackDetailValidator,
  }).index("by_snapshot_id_and_public_pack_id", [
    "snapshotId",
    "publicPackId",
  ]),

  catalogQueryShards: defineTable({
    snapshotId: v.id("catalogSnapshots"),
    shardNumber: v.number(),
    rowCount: v.number(),
    byteCount: v.number(),
    contentHash: sha256Validator,
    rows: v.array(catalogQueryRowValidator),
  }).index("by_snapshot_id_and_shard_number", ["snapshotId", "shardNumber"]),

  publicationBatches: defineTable({
    snapshotId: v.id("catalogSnapshots"),
    batchIndex: v.number(),
    kind: v.union(v.literal("packs"), v.literal("query_shards")),
    idempotencyKey: v.string(),
    bodyHash: sha256Validator,
    recordCount: v.number(),
    byteCount: v.number(),
    acceptedAt: timestampValidator,
  })
    .index("by_snapshot_id_and_batch_index", ["snapshotId", "batchIndex"])
    .index("by_idempotency_key", ["idempotencyKey"]),

  publicationOperations: defineTable({
    operationId: v.string(),
    kind: v.string(),
    idempotencyKey: v.string(),
    bodyHash: sha256Validator,
    publicationId: v.union(v.string(), v.null()),
    observationSequence: v.union(v.number(), v.null()),
    status: v.string(),
    result: v.string(),
    convexSnapshotVersion: v.union(v.string(), v.null()),
    confirmationReceiptHash: v.union(sha256Validator, v.null()),
    acceptedAt: timestampValidator,
    completedAt: v.union(timestampValidator, v.null()),
  })
    .index("by_kind_and_idempotency_key", ["kind", "idempotencyKey"])
    .index("by_publication_id_and_kind", ["publicationId", "kind"]),

  blockedCatalogManifests: defineTable({
    fingerprint: sha256Validator,
    active: v.boolean(),
    blockSequence: v.number(),
    originatingOperationId: v.string(),
    sanitizedReason: v.string(),
    blockedAt: timestampValidator,
    releasedAt: v.union(timestampValidator, v.null()),
    releaseReceiptHash: v.union(sha256Validator, v.null()),
  }).index("by_fingerprint_and_active", ["fingerprint", "active"]),
});
