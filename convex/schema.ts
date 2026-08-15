import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
  REPACK_HEAT_MINIMUM_BASELINE_PULLS,
  REPACK_HEAT_MINIMUM_CURRENT_PULLS,
  REPACK_HEAT_POLICY_VERSION,
  REPACK_HEAT_SCENARIO_VERSION,
} from "@packscout/contracts";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { repackSearchRowValidator } from "./publicRepackValidation";

const sha256Validator = v.string();
const timestampValidator = v.string();
const nullableTimestampValidator = v.union(timestampValidator, v.null());
const nullableTextValidator = v.union(v.string(), v.null());

const moneyValidator = v.object({
  minorUnits: v.number(),
  currency: v.string(),
});

const reportedMoneyValidator = v.object({
  minorUnits: v.number(),
  currency: v.string(),
});

const usdMoneyValidator = v.object({
  minorUnits: v.number(),
  currency: v.literal("USD"),
});

const imageValidator = v.object({
  url: v.string(),
  alt: v.string(),
});

const nullableImageValidator = v.union(imageValidator, v.null());

const referralParameterValidator = v.object({
  name: v.string(),
  value: v.string(),
});

const promoValidator = v.object({
  code: v.string(),
  label: v.string(),
});

const packLinkValidator = v.object({
  listingUrl: v.string(),
  listingHost: v.string(),
  referralParameters: v.array(referralParameterValidator),
});

const priceValidator = v.object({
  displayMoney: v.union(moneyValidator, v.null()),
  usdComparison: v.union(
    v.object({
      status: v.literal("available"),
      value: usdMoneyValidator,
    }),
    v.object({
      status: v.literal("unavailable"),
      value: v.null(),
      reason: v.union(
        v.literal("PRICE_UNAVAILABLE"),
        v.literal("CURRENCY_UNSUPPORTED"),
      ),
    }),
  ),
});

const estimateMetricsValidator = v.object({
  grossEv: usdMoneyValidator,
  grossReturnBasisPoints: v.number(),
  evDollars: v.object({
    minorUnits: v.number(),
    currency: v.literal("USD"),
  }),
  evPercentBasisPoints: v.number(),
});

const confidenceBandValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);

const repackHeatComponentUnavailableValidator = v.object({
  status: v.literal("unavailable"),
  reason: v.union(
    v.literal("CURRENT_SAMPLE_INSUFFICIENT"),
    v.literal("BASELINE_SAMPLE_INSUFFICIENT"),
    v.literal("BASELINE_UNAVAILABLE"),
    v.literal("EVIDENCE_INCOMPLETE"),
    v.literal("METRIC_UNSUPPORTED"),
  ),
});

const repackHeatProvenanceValidator = v.union(
  v.object({
    kind: v.literal("observed"),
    aggregationVersion: v.literal(REPACK_HEAT_AGGREGATION_VERSION),
  }),
  v.object({
    kind: v.literal("simulated"),
    aggregationVersion: v.literal(REPACK_HEAT_AGGREGATION_VERSION),
    scenarioVersion: v.literal(REPACK_HEAT_SCENARIO_VERSION),
  }),
);

const repackHeatWindowValidator = v.object({
  startedAt: timestampValidator,
  endedAt: timestampValidator,
  pullCount: v.number(),
});

export const publicRepackHeatSignalValidator = v.object({
  publicRepackId: v.string(),
  state: v.union(
    v.literal("hot"),
    v.literal("warm"),
    v.literal("normal"),
    v.literal("cold"),
    v.literal("insufficient_data"),
  ),
  scoreBasisPoints: v.union(v.number(), v.null()),
  signalConfidence: v.union(
    v.object({
      scoreBasisPoints: v.number(),
      band: confidenceBandValidator,
    }),
    v.null(),
  ),
  provenance: repackHeatProvenanceValidator,
  sourceCoverage: v.union(v.literal("complete"), v.literal("partial")),
  currentWindow: repackHeatWindowValidator,
  baselineWindow: repackHeatWindowValidator,
  sampleRequirements: v.object({
    minimumCurrentPullCount: v.literal(REPACK_HEAT_MINIMUM_CURRENT_PULLS),
    minimumBaselinePullCount: v.literal(REPACK_HEAT_MINIMUM_BASELINE_PULLS),
  }),
  components: v.object({
    activity: v.union(
      v.object({
        status: v.literal("available"),
        currentPullCount: v.number(),
        baselinePullCount: v.number(),
        relativeRateDeltaBasisPoints: v.number(),
      }),
      repackHeatComponentUnavailableValidator,
    ),
    observedReturn: v.union(
      v.object({
        status: v.literal("available"),
        currentReturnBasisPoints: v.number(),
        baselineReturnBasisPoints: v.number(),
        rateDeltaBasisPoints: v.number(),
      }),
      repackHeatComponentUnavailableValidator,
    ),
    largeHitFrequency: v.union(
      v.object({
        status: v.literal("available"),
        currentHitCount: v.number(),
        baselineHitCount: v.number(),
        currentRateBasisPoints: v.number(),
        baselineRateBasisPoints: v.number(),
        rateDeltaBasisPoints: v.number(),
        thresholdMultipleBasisPoints: v.literal(
          REPACK_HEAT_LARGE_HIT_MULTIPLE_BASIS_POINTS,
        ),
      }),
      repackHeatComponentUnavailableValidator,
    ),
    chaseAvailability: v.union(
      v.object({
        status: v.literal("available"),
        currentAvailableChaseCount: v.number(),
        baselineAvailableChaseCount: v.number(),
        change: v.union(
          v.literal("restocked"),
          v.literal("depleted"),
          v.literal("unchanged"),
        ),
      }),
      repackHeatComponentUnavailableValidator,
    ),
    poolComposition: v.union(
      v.object({
        status: v.literal("available"),
        addedOutcomeCount: v.number(),
        removedOutcomeCount: v.number(),
        changeMagnitudeBasisPoints: v.number(),
        changed: v.boolean(),
      }),
      repackHeatComponentUnavailableValidator,
    ),
  }),
  drivers: v.array(
    v.object({
      code: v.union(
        v.literal("activity"),
        v.literal("chase_availability"),
        v.literal("large_hit_frequency"),
        v.literal("observed_return"),
        v.literal("pool_composition"),
      ),
      contributionBasisPoints: v.number(),
    }),
  ),
  limitationCodes: v.array(
    v.union(
      v.literal("current_sample_below_minimum"),
      v.literal("baseline_sample_below_minimum"),
      v.literal("partial_source_coverage"),
      v.literal("return_data_incomplete"),
      v.literal("large_hit_data_incomplete"),
      v.literal("chase_inventory_incomplete"),
      v.literal("pool_composition_incomplete"),
      v.literal("simulated_data"),
    ),
  ),
  heatPolicyVersion: v.literal(REPACK_HEAT_POLICY_VERSION),
  calculatedAt: timestampValidator,
  expiresAt: timestampValidator,
});

export const repackHeatSignalCoreValidator = publicRepackHeatSignalValidator
  .omit("baselineWindow", "currentWindow", "calculatedAt", "expiresAt")
  .extend({
    baselinePullCount: v.number(),
    currentPullCount: v.number(),
  });

export const productionHeatFrameEnvelopeValidator = v.object({
  publicHeatFrameId: v.string(),
  catalogPublicReleaseId: v.string(),
  frameSequence: v.number(),
  sourceWatermark: v.string(),
  signalSetHash: sha256Validator,
  frameHash: sha256Validator,
  signalCount: v.number(),
  aggregationVersion: v.literal(REPACK_HEAT_AGGREGATION_VERSION),
  heatPolicyVersion: v.literal(REPACK_HEAT_POLICY_VERSION),
  baselineWindowStartedAt: timestampValidator,
  baselineWindowEndedAt: timestampValidator,
  currentWindowStartedAt: timestampValidator,
  currentWindowEndedAt: timestampValidator,
  calculatedAt: timestampValidator,
  expiresAt: timestampValidator,
});

const confidenceValidator = v.object({
  scoreBasisPoints: v.number(),
  band: confidenceBandValidator,
  limitationCodes: v.array(
    v.union(
      v.literal("incomplete_outcome_pool"),
      v.literal("estimated_value_ranges"),
      v.literal("partial_probability_coverage"),
      v.literal("sparse_valuation_data"),
      v.literal("stale_valuation_data"),
      v.literal("unresolved_collectibles"),
      v.literal("currency_normalization_applied"),
      v.literal("vendor_odds_unverified"),
      v.literal("vendor_probability_inputs"),
    ),
  ),
});

const vendorReportedEvEstimateValidator = v.union(
  v.object({
    status: v.literal("available"),
    displayMoney: reportedMoneyValidator,
    metrics: estimateMetricsValidator,
    observedAt: timestampValidator,
  }),
  v.object({
    status: v.literal("unavailable"),
    displayMoney: v.union(reportedMoneyValidator, v.null()),
    metrics: v.null(),
    observedAt: nullableTimestampValidator,
    reason: v.union(
      v.literal("NOT_REPORTED"),
      v.literal("PRICE_UNAVAILABLE"),
      v.literal("CURRENCY_UNSUPPORTED"),
    ),
  }),
);

const packScoutEvEstimateValidator = v.union(
  v.object({
    status: v.literal("available"),
    metrics: estimateMetricsValidator,
    confidence: confidenceValidator,
    modelVersion: v.string(),
    confidencePolicyVersion: v.string(),
    dataAsOf: timestampValidator,
    calculatedAt: timestampValidator,
  }),
  v.object({
    status: v.literal("unavailable"),
    metrics: v.null(),
    confidence: v.null(),
    modelVersion: v.string(),
    confidencePolicyVersion: v.string(),
    dataAsOf: nullableTimestampValidator,
    calculatedAt: nullableTimestampValidator,
    reason: v.union(
      v.literal("PRICE_UNAVAILABLE"),
      v.literal("CURRENCY_UNSUPPORTED"),
      v.literal("ESTIMATE_INPUT_INCOMPLETE"),
    ),
  }),
);

const buybackValidator = v.union(
  v.object({
    status: v.literal("available"),
    value: v.object({
      basisPoints: v.number(),
      sourceKind: v.union(
        v.literal("vendor_reported"),
        v.literal("packscout_derived"),
      ),
    }),
  }),
  v.object({
    status: v.literal("unavailable"),
    value: v.null(),
    reason: v.literal("BUYBACK_UNAVAILABLE"),
  }),
);

const collectibleTypeValidator = v.union(
  v.literal("card"),
  v.literal("watch"),
  v.literal("coin"),
  v.literal("sealed_product"),
  v.literal("memorabilia"),
  v.literal("other"),
);

const publicVendorValidator = v.object({
  publicVendorId: v.string(),
  vendorKey: v.string(),
  displayName: v.string(),
  logoUrl: nullableTextValidator,
  websiteUrl: nullableTextValidator,
  listingHosts: v.array(v.string()),
  imageOrigins: v.array(v.string()),
  referralParameters: v.array(referralParameterValidator),
  publicPromo: v.union(promoValidator, v.null()),
});

const categoryKindValidator = v.union(
  v.literal("vertical"),
  v.literal("sport"),
  v.literal("league"),
  v.literal("franchise"),
  v.literal("brand"),
  v.literal("set"),
  v.literal("other"),
);

const publicCategoryValidator = v.object({
  publicCategoryId: v.string(),
  parentPublicCategoryId: nullableTextValidator,
  categoryKey: v.string(),
  name: v.string(),
  kind: categoryKindValidator,
  depth: v.number(),
  pathPublicCategoryIds: v.array(v.string()),
  displayOrder: v.number(),
});

const collectibleValuationValidator = v.object({
  displayMoney: v.union(moneyValidator, v.null()),
  usdComparison: v.union(
    v.object({
      status: v.literal("available"),
      value: usdMoneyValidator,
    }),
    v.object({
      status: v.literal("unavailable"),
      value: v.null(),
      reason: v.union(
        v.literal("VALUATION_UNAVAILABLE"),
        v.literal("CURRENCY_UNSUPPORTED"),
      ),
    }),
  ),
  valuationType: v.union(
    v.literal("market_estimate"),
    v.literal("vendor_reported"),
    v.literal("last_sale"),
    v.literal("appraisal"),
  ),
  observedAt: timestampValidator,
});

const publicCollectibleValidator = v.object({
  publicCollectibleId: v.string(),
  name: v.string(),
  normalizedName: v.string(),
  aliases: v.array(v.string()),
  normalizedAliases: v.array(v.string()),
  collectibleType: collectibleTypeValidator,
  publicCategoryIds: v.array(v.string()),
  year: v.union(v.number(), v.null()),
  brand: nullableTextValidator,
  setOrSeries: nullableTextValidator,
  cardNumber: nullableTextValidator,
  referenceNumber: nullableTextValidator,
  subject: nullableTextValidator,
  grade: nullableTextValidator,
  grader: nullableTextValidator,
  primaryImage: nullableImageValidator,
  valuation: v.union(collectibleValuationValidator, v.null()),
  searchText: v.string(),
  dataAsOf: timestampValidator,
});

const chaseRoleValidator = v.union(
  v.literal("top_chase"),
  v.literal("featured_chase"),
  v.literal("possible_outcome"),
);

const chaseEvidenceKindValidator = v.union(
  v.literal("vendor_inventory"),
  v.literal("vendor_odds"),
  v.literal("vendor_featured_chase"),
  v.literal("packscout_resolved"),
  v.literal("historical_pull_inference"),
  v.literal("name_only"),
);

const collectibleDisplayValidator = v.object({
  publicCollectibleId: v.string(),
  name: v.string(),
  collectibleType: collectibleTypeValidator,
  publicCategoryIds: v.array(v.string()),
  primaryImage: nullableImageValidator,
  valuation: v.union(collectibleValuationValidator, v.null()),
});

const publicRepackChaseValidator = v.object({
  publicRepackId: v.string(),
  publicCollectibleId: v.string(),
  role: chaseRoleValidator,
  evidenceKinds: v.array(chaseEvidenceKindValidator),
  probabilityBasisPoints: v.union(v.number(), v.null()),
  collectible: collectibleDisplayValidator,
  matchConfidence: v.object({
    scoreBasisPoints: v.number(),
    band: confidenceBandValidator,
  }),
  observedAt: timestampValidator,
  displayOrder: v.number(),
});

const publicRepackCategoryValidator = v.object({
  publicCategoryId: v.string(),
  label: v.string(),
});

const publicRepackDetailValidator = v.object({
  publicRepackId: v.string(),
  publicVendorId: v.string(),
  vendorKey: v.string(),
  vendorDisplayName: v.string(),
  vendorLogoUrl: nullableTextValidator,
  name: v.string(),
  format: v.union(v.literal("repack"), v.literal("gacha")),
  contentMode: v.union(
    v.literal("focused"),
    v.literal("mixed"),
    v.literal("unknown"),
  ),
  categories: v.array(publicRepackCategoryValidator),
  collectibleTypes: v.array(collectibleTypeValidator),
  availability: v.union(v.literal("active"), v.literal("sold_out")),
  price: priceValidator,
  evEstimates: v.object({
    vendorReported: vendorReportedEvEstimateValidator,
    packScout: packScoutEvEstimateValidator,
  }),
  buyback: buybackValidator,
  primaryImage: nullableImageValidator,
  topChase: v.union(publicRepackChaseValidator, v.null()),
  contentSummary: v.object({
    knownCollectibleCount: v.number(),
    chaseCount: v.number(),
    categoryCount: v.number(),
    collectibleTypeCount: v.number(),
    evidenceCompleteness: v.union(
      v.literal("complete"),
      v.literal("partial"),
      v.literal("unknown"),
    ),
    probabilityCoverageBasisPoints: v.union(v.number(), v.null()),
  }),
  actionAvailability: v.object({
    promo: v.boolean(),
    repackLink: v.boolean(),
  }),
  sourceUpdatedAt: timestampValidator,
  description: nullableTextValidator,
  actions: v.object({
    promo: v.optional(promoValidator),
    repackLink: v.optional(packLinkValidator),
  }),
});

export const dataReleaseMetadataValidator = v.object({
  schemaVersion: v.literal("data_release_v2"),
  dataSource: v.union(v.literal("canonical"), v.literal("mock")),
  publicReleaseId: v.string(),
  sourceWatermark: v.string(),
  manifestFingerprint: sha256Validator,
  contentHash: sha256Validator,
  publicConfigRevision: v.number(),
  publicConfigHash: sha256Validator,
  originSetHash: sha256Validator,
  searchAlgorithmVersion: v.literal("repack_search_v2"),
  repackSearchIndexHash: sha256Validator,
  confidencePolicyVersion: v.string(),
  createdAt: timestampValidator,
  completedAt: v.union(timestampValidator, v.null()),
  dataAsOf: timestampValidator,
  lastSuccessfulObservationAt: timestampValidator,
  staleAt: timestampValidator,
  freshness: v.union(v.literal("fresh"), v.literal("delayed")),
  delayedVendorCount: v.number(),
  vendorCount: v.number(),
  categoryCount: v.number(),
  repackCount: v.number(),
  collectibleCount: v.number(),
  repackChaseCount: v.number(),
});

export default defineSchema({
  dataReleaseState: defineTable({
    key: v.literal("singleton"),
    activeReleaseId: v.union(v.id("dataReleases"), v.null()),
    previousReleaseId: v.union(v.id("dataReleases"), v.null()),
    latestObservationSequence: v.number(),
    dataAsOf: timestampValidator,
    lastSuccessfulObservationAt: timestampValidator,
    staleAt: timestampValidator,
    freshness: v.union(v.literal("fresh"), v.literal("delayed")),
    delayedVendorCount: v.number(),
    updatedAt: timestampValidator,
  }).index("by_key", ["key"]),

  dataReleases: defineTable({
    publicReleaseId: v.string(),
    lifecycle: v.union(
      v.literal("staging"),
      v.literal("complete"),
      v.literal("failed"),
      v.literal("retired"),
    ),
    metadata: dataReleaseMetadataValidator,
    searchShardCount: v.number(),
    retentionEligibleAt: v.optional(timestampValidator),
  })
    .index("by_public_release_id", ["publicReleaseId"])
    .index("by_lifecycle_and_retention_eligible_at", [
      "lifecycle",
      "retentionEligibleAt",
    ]),

  dataReleasePublications: defineTable({
    publicationId: v.string(),
    releaseId: v.id("dataReleases"),
    expectedPredecessorPublicReleaseId: nullableTextValidator,
    publicAssetOrigins: v.array(v.string()),
    expectedBatchCount: v.number(),
    expectedBatchChainHash: sha256Validator,
    acceptedBatchCount: v.number(),
    acceptedBatchChainHash: sha256Validator,
    expectedCounts: v.object({
      vendors: v.number(),
      categories: v.number(),
      collectibles: v.number(),
      repacks: v.number(),
      repackChases: v.number(),
      searchShards: v.number(),
    }),
    acceptedCounts: v.object({
      vendors: v.number(),
      categories: v.number(),
      collectibles: v.number(),
      repacks: v.number(),
      repackChases: v.number(),
      searchShards: v.number(),
    }),
    observationSequence: v.number(),
    lastBatchKind: nullableTextValidator,
    lastRecordKey: nullableTextValidator,
    lastSearchPublicRepackId: nullableTextValidator,
    unresolvedRepackCount: v.number(),
    latestEvidenceAt: nullableTimestampValidator,
    state: v.union(
      v.literal("staging"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    createdAt: timestampValidator,
    completedAt: nullableTimestampValidator,
  })
    .index("by_publication_id", ["publicationId"])
    .index("by_release_id", ["releaseId"]),

  dataReleaseRepackReconciliation: defineTable({
    releaseId: v.id("dataReleases"),
    repackId: v.id("repacks"),
    publicRepackId: v.string(),
    expectedChaseCount: v.number(),
    acceptedChaseCount: v.number(),
    expectedTopChaseJson: nullableTextValidator,
    bestChaseJson: nullableTextValidator,
    complete: v.boolean(),
  })
    .index("by_release_id_and_public_repack_id", [
      "releaseId",
      "publicRepackId",
    ])
    .index("by_release_id", ["releaseId"]),

  dataReleaseCollectibleReconciliation: defineTable({
    releaseId: v.id("dataReleases"),
    collectibleId: v.id("collectibles"),
    publicCollectibleId: v.string(),
    chaseCount: v.number(),
  })
    .index("by_release_id_and_public_collectible_id", [
      "releaseId",
      "publicCollectibleId",
    ])
    .index("by_release_id", ["releaseId"]),

  dataReleaseAuthNonces: defineTable({
    keyId: v.string(),
    nonceHash: sha256Validator,
    requestDigest: sha256Validator,
    acceptedAt: timestampValidator,
    expiresAt: timestampValidator,
  })
    .index("by_key_id_and_nonce_hash", ["keyId", "nonceHash"])
    .index("by_expires_at", ["expiresAt"]),

  repackHeatState: defineTable({
    key: v.literal("singleton"),
    activeHeatSnapshotId: v.union(v.id("repackHeatSnapshots"), v.null()),
    previousHeatSnapshotId: v.union(v.id("repackHeatSnapshots"), v.null()),
    freshness: v.union(
      v.literal("current"),
      v.literal("expired"),
      v.literal("unavailable"),
    ),
    expiresAt: nullableTimestampValidator,
    latestSequence: v.number(),
    updatedAt: timestampValidator,
  }).index("by_key", ["key"]),

  repackHeatSignalSets: defineTable({
    releaseId: v.id("dataReleases"),
    signalSetHash: sha256Validator,
    lifecycle: v.union(
      v.literal("staging"),
      v.literal("complete"),
      v.literal("retired"),
      v.literal("failed"),
    ),
    sourceKind: v.union(v.literal("observed"), v.literal("simulated")),
    scenarioVersion: nullableTextValidator,
    aggregationVersion: v.string(),
    heatPolicyVersion: v.string(),
    signalCount: v.number(),
    originatingPublicationId: nullableTextValidator,
    createdAt: timestampValidator,
    completedAt: nullableTimestampValidator,
    retentionEligibleAt: v.optional(timestampValidator),
  })
    .index("by_signal_set_hash", ["signalSetHash"])
    .index("by_release_id_and_signal_set_hash", [
      "releaseId",
      "signalSetHash",
    ])
    .index("by_lifecycle_and_retention_eligible_at", [
      "lifecycle",
      "retentionEligibleAt",
    ]),

  repackHeatSnapshots: defineTable({
    releaseId: v.id("dataReleases"),
    signalSetId: v.id("repackHeatSignalSets"),
    publicHeatSnapshotId: v.string(),
    publicationId: nullableTextValidator,
    simulationRunId: v.union(v.string(), v.null()),
    sequence: v.number(),
    sourceWatermark: nullableTextValidator,
    lifecycle: v.union(
      v.literal("staging"),
      v.literal("complete"),
      v.literal("retired"),
      v.literal("failed"),
    ),
    sourceKind: v.union(v.literal("observed"), v.literal("simulated")),
    scenarioVersion: v.union(v.string(), v.null()),
    aggregationVersion: v.string(),
    heatPolicyVersion: v.string(),
    contentHash: sha256Validator,
    signalCount: v.number(),
    baselineWindowStartedAt: timestampValidator,
    baselineWindowEndedAt: timestampValidator,
    currentWindowStartedAt: timestampValidator,
    currentWindowEndedAt: timestampValidator,
    calculatedAt: timestampValidator,
    expiresAt: timestampValidator,
    retentionEligibleAt: v.optional(timestampValidator),
  })
    .index("by_public_heat_snapshot_id", ["publicHeatSnapshotId"])
    .index("by_release_id_and_sequence", ["releaseId", "sequence"])
    .index("by_signal_set_id", ["signalSetId"])
    .index("by_lifecycle_and_expires_at", ["lifecycle", "expiresAt"])
    .index("by_simulation_run_id_and_sequence", [
      "simulationRunId",
      "sequence",
    ]),

  repackHeatSignals: defineTable({
    signalSetId: v.id("repackHeatSignalSets"),
    releaseId: v.id("dataReleases"),
    repackId: v.id("repacks"),
    publicRepackId: v.string(),
    detail: repackHeatSignalCoreValidator,
  })
    .index("by_release_id", ["releaseId"])
    .index("by_signal_set_id_and_public_repack_id", [
      "signalSetId",
      "publicRepackId",
    ])
    .index("by_signal_set_id_and_repack_id", [
      "signalSetId",
      "repackId",
    ]),

  repackHeatPublications: defineTable({
    publicationId: v.string(),
    releaseId: v.id("dataReleases"),
    signalSetId: v.id("repackHeatSignalSets"),
    frame: productionHeatFrameEnvelopeValidator,
    expectedBatchCount: v.number(),
    acceptedBatchCount: v.number(),
    acceptedSignalCount: v.number(),
    acceptedSignalSetHash: sha256Validator,
    lastPublicRepackId: nullableTextValidator,
    state: v.union(
      v.literal("staging"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    createdAt: timestampValidator,
    completedAt: nullableTimestampValidator,
    retentionEligibleAt: timestampValidator,
  })
    .index("by_publication_id", ["publicationId"])
    .index("by_release_id", ["releaseId"])
    .index("by_signal_set_id", ["signalSetId"])
    .index("by_state_and_completed_at", ["state", "completedAt"])
    .index("by_state_and_retention_eligible_at", [
      "state",
      "retentionEligibleAt",
    ]),

  repackHeatBatches: defineTable({
    publicationId: v.string(),
    releaseId: v.id("dataReleases"),
    signalSetId: v.id("repackHeatSignalSets"),
    batchIndex: v.number(),
    idempotencyKey: v.string(),
    bodyHash: sha256Validator,
    batchHash: sha256Validator,
    recordCount: v.number(),
    byteCount: v.number(),
    coreByteCount: v.number(),
    signalSetProgressHash: sha256Validator,
    acceptedAt: timestampValidator,
    operationId: v.string(),
  })
    .index("by_publication_id_and_batch_index", [
      "publicationId",
      "batchIndex",
    ])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_release_id", ["releaseId"]),

  repackHeatOperations: defineTable({
    operationId: v.string(),
    kind: v.string(),
    idempotencyKey: v.string(),
    bodyHash: sha256Validator,
    publicationId: nullableTextValidator,
    status: v.string(),
    result: v.string(),
    confirmationReceiptHash: v.union(sha256Validator, v.null()),
    acceptedAt: timestampValidator,
    completedAt: nullableTimestampValidator,
    receiptJson: v.optional(v.string()),
  })
    .index("by_kind_and_idempotency_key", ["kind", "idempotencyKey"])
    .index("by_operation_id", ["operationId"])
    .index("by_publication_id", ["publicationId"])
    .index("by_publication_id_and_kind", ["publicationId", "kind"])
    .index("by_completed_at", ["completedAt"]),

  vendors: defineTable({
    releaseId: v.id("dataReleases"),
    publicVendorId: v.string(),
    vendorKey: v.string(),
    detail: publicVendorValidator,
  })
    .index("by_release_id_and_public_vendor_id", [
      "releaseId",
      "publicVendorId",
    ])
    .index("by_release_id_and_vendor_key", ["releaseId", "vendorKey"]),

  categories: defineTable({
    releaseId: v.id("dataReleases"),
    publicCategoryId: v.string(),
    categoryKey: v.string(),
    parentCategoryId: v.union(v.id("categories"), v.null()),
    detail: publicCategoryValidator,
  })
    .index("by_release_id_and_public_category_id", [
      "releaseId",
      "publicCategoryId",
    ])
    .index("by_release_id_and_category_key", ["releaseId", "categoryKey"])
    .index("by_release_id_and_parent_category_id", [
      "releaseId",
      "parentCategoryId",
    ]),

  repacks: defineTable({
    releaseId: v.id("dataReleases"),
    publicRepackId: v.string(),
    vendorId: v.id("vendors"),
    detail: publicRepackDetailValidator,
  })
    .index("by_release_id_and_public_repack_id", [
      "releaseId",
      "publicRepackId",
    ])
    .index("by_release_id_and_vendor_id", ["releaseId", "vendorId"]),

  collectibles: defineTable({
    releaseId: v.id("dataReleases"),
    publicCollectibleId: v.string(),
    collectibleType: collectibleTypeValidator,
    normalizedName: v.string(),
    searchText: v.string(),
    detail: publicCollectibleValidator,
  })
    .index("by_release_id_and_public_collectible_id", [
      "releaseId",
      "publicCollectibleId",
    ])
    .index("by_release_id_and_normalized_name", [
      "releaseId",
      "normalizedName",
    ])
    .searchIndex("search_search_text", {
      searchField: "searchText",
      filterFields: ["releaseId", "collectibleType"],
    }),

  repackChases: defineTable({
    releaseId: v.id("dataReleases"),
    repackId: v.id("repacks"),
    collectibleId: v.id("collectibles"),
    detail: publicRepackChaseValidator,
  })
    .index("by_release_id_and_repack_id", ["releaseId", "repackId"])
    .index("by_release_id_and_collectible_id", [
      "releaseId",
      "collectibleId",
    ])
    .index("by_release_id_and_repack_id_and_collectible_id", [
      "releaseId",
      "repackId",
      "collectibleId",
    ]),

  repackSearchShards: defineTable({
    releaseId: v.id("dataReleases"),
    shardNumber: v.number(),
    rowCount: v.number(),
    byteCount: v.number(),
    contentHash: sha256Validator,
    rows: v.array(repackSearchRowValidator),
  }).index("by_release_id_and_shard_number", ["releaseId", "shardNumber"]),

  dataReleaseBatches: defineTable({
    releaseId: v.id("dataReleases"),
    batchIndex: v.number(),
    kind: v.union(
      v.literal("vendors"),
      v.literal("categories"),
      v.literal("repacks"),
      v.literal("collectibles"),
      v.literal("repack_chases"),
      v.literal("search_shards"),
    ),
    idempotencyKey: v.string(),
    bodyHash: sha256Validator,
    recordCount: v.number(),
    byteCount: v.number(),
    acceptedAt: timestampValidator,
    operationId: v.optional(v.string()),
    chainHash: v.optional(sha256Validator),
  })
    .index("by_release_id_and_batch_index", ["releaseId", "batchIndex"])
    .index("by_idempotency_key", ["idempotencyKey"]),

  dataReleaseOperations: defineTable({
    operationId: v.string(),
    kind: v.string(),
    idempotencyKey: v.string(),
    bodyHash: sha256Validator,
    publicReleaseId: nullableTextValidator,
    observationSequence: v.union(v.number(), v.null()),
    status: v.string(),
    result: v.string(),
    convexReleaseVersion: nullableTextValidator,
    confirmationReceiptHash: v.union(sha256Validator, v.null()),
    acceptedAt: timestampValidator,
    completedAt: nullableTimestampValidator,
    receiptJson: v.optional(v.string()),
  })
    .index("by_kind_and_idempotency_key", ["kind", "idempotencyKey"])
    .index("by_public_release_id_and_kind", ["publicReleaseId", "kind"])
    .index("by_operation_id", ["operationId"]),

  blockedDataReleaseManifests: defineTable({
    fingerprint: sha256Validator,
    active: v.boolean(),
    blockSequence: v.number(),
    originatingOperationId: v.string(),
    sanitizedReason: v.string(),
    blockedAt: timestampValidator,
    releasedAt: nullableTimestampValidator,
    releaseReceiptHash: v.union(sha256Validator, v.null()),
  }).index("by_fingerprint_and_active", ["fingerprint", "active"]),
});
