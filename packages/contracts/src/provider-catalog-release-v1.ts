import { z } from "zod";
import {
  canonicalJson,
} from "./data-release-v2-canonical.ts";
import {
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "./data-release-v2-entities.ts";
import {
  MAX_REPACK_SEARCH_SHARDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  repackSearchRowFromDetail,
  repackSearchRowSchema,
} from "./data-release-v2-search.ts";
import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_SEARCH_VERSION,
  canonicalArraySchema,
  isStrictlySortedUnique,
  publicHttpsOriginSchema,
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import { validateDataReleaseV2EntityGraph } from "./data-release-v2-graph.ts";
import {
  EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  buildProviderCatalogSourceWatermarkV1,
  derivePublicProviderReleaseIdV1,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  initializeProviderCatalogReleaseEntityHashV1,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogReleaseBatchHashV1,
  recomputeProviderCatalogReleaseContentHashV1,
  recomputeProviderCatalogReleaseFingerprintV1,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  type ProviderCatalogReleaseBatchKindV1,
} from "./provider-catalog-release-v1-canonical.ts";
import {
  containsNormalizedProtectedPublicationField,
  normalizeProtectedPublicationFieldKey,
} from "./protected-publication-fields.ts";

export * from "./provider-catalog-release-v1-canonical.ts";

export const MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS = 100;
export const MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES = 48 * 1_024;
export const MAX_PROVIDER_CATALOG_RELEASE_HTTP_BODY_BYTES = 128 * 1_024;
export const MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT = 4_096;
export const MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES = 100_000;
/**
 * Maximum serialized provider-plan bytes admitted into one in-memory
 * publication or manifest-composition boundary. Storage may retain larger
 * artifacts, but callers must not hydrate them without a streaming design.
 */
export const MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES =
  32 * 1_024 * 1_024;

const MAX_SIGNED_INT64 = BigInt("9223372036854775807");
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const positiveSafeIntegerSchema = z.number().int().safe().positive();

export const providerCatalogNonNegativeSequenceV1Schema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/u)
  .refine((value) => BigInt(value) <= MAX_SIGNED_INT64, {
    message: "provider_catalog_release.sequence_out_of_range",
  });

export const providerCatalogSequenceV1Schema =
  providerCatalogNonNegativeSequenceV1Schema.refine(
    (value) => value !== "0",
    { message: "provider_catalog_release.sequence_must_be_positive" },
  );

export const publicProviderReleaseIdV1Schema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);

export const providerCatalogPlatformKeyV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u);

export const providerCatalogSharedConfigurationEpochV1Schema = z
  .object({
    configurationKey: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u),
    revision: positiveSafeIntegerSchema,
    publicChangeSequence: providerCatalogSequenceV1Schema,
    configurationHash: sha256Schema,
  })
  .strict();

export const providerCatalogReleaseCheckpointV1Schema = z
  .object({
    settledSequence: providerCatalogNonNegativeSequenceV1Schema,
    settledAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine(({ settledAt, settledSequence }, context) => {
    if ((settledSequence === "0") !== (settledAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["settledAt"],
        message: "provider_catalog_release.checkpoint_time_mismatch",
      });
    }
  });

export const providerCatalogReleaseObservationV1Schema = z
  .object({
    sourceHeadSequence: providerCatalogSequenceV1Schema,
    lastSuccessfulObservationAt: timestampSchema,
    staleAt: timestampSchema,
    freshness: z.enum(["fresh", "delayed"]),
  })
  .strict()
  .refine(
    ({ lastSuccessfulObservationAt, staleAt }) =>
      Date.parse(staleAt) > Date.parse(lastSuccessfulObservationAt),
    {
      path: ["staleAt"],
      message: "provider_catalog_release.stale_deadline_invalid",
    },
  );

export const providerCatalogReleaseGoverningHashesV1Schema = z
  .object({
    providerConfigurationHash: sha256Schema,
    sharedCategoriesHash: sha256Schema,
    identityMappingsHash: sha256Schema,
    originSetHash: sha256Schema,
    confidencePolicyHash: sha256Schema,
  })
  .strict();

export const providerCatalogReleaseEntityHashesV1Schema = z
  .object({
    vendors: sha256Schema,
    categories: sha256Schema,
    collectibles: sha256Schema,
    repacks: sha256Schema,
    repack_chases: sha256Schema,
    search_shards: sha256Schema,
  })
  .strict();

export const providerCatalogReleaseCountsV1Schema = z
  .object({
    vendors: z.literal(1),
    categories: nonNegativeSafeIntegerSchema.max(4_096),
    collectibles: nonNegativeSafeIntegerSchema.max(
      MAX_PROVIDER_CATALOG_RELEASE_COLLECTIBLES,
    ),
    repacks: nonNegativeSafeIntegerSchema.max(MAX_PUBLIC_REPACKS_PER_RELEASE),
    repackChases: nonNegativeSafeIntegerSchema.max(250_000),
    searchShards: nonNegativeSafeIntegerSchema.max(MAX_REPACK_SEARCH_SHARDS),
  })
  .strict();

export const providerCatalogReleaseSearchShardV1Schema = z
  .object({
    shardNumber: nonNegativeSafeIntegerSchema.max(
      MAX_REPACK_SEARCH_SHARDS - 1,
    ),
    rowCount: nonNegativeSafeIntegerSchema.max(
      MAX_ROWS_PER_REPACK_SEARCH_SHARD,
    ),
    byteCount: nonNegativeSafeIntegerSchema.max(
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
    ),
    contentHash: sha256Schema,
    rows: z
      .array(repackSearchRowSchema)
      .min(1)
      .max(MAX_ROWS_PER_REPACK_SEARCH_SHARD),
  })
  .strict()
  .superRefine((shard, context) => {
    if (shard.rowCount !== shard.rows.length) {
      context.addIssue({
        code: "custom",
        path: ["rowCount"],
        message: "provider_catalog_release.search_row_count_mismatch",
      });
    }
    if (shard.byteCount !== providerCatalogReleaseBatchByteCount(shard.rows)) {
      context.addIssue({
        code: "custom",
        path: ["byteCount"],
        message: "provider_catalog_release.search_byte_count_mismatch",
      });
    }
    if (
      !isStrictlySortedUnique(
        shard.rows,
        ({ publicRepackId }) => publicRepackId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message: "provider_catalog_release.search_rows_not_canonical",
      });
    }
  });

export interface ProviderCatalogReleaseBatchRecordMapV1 {
  readonly vendors: PublicVendor;
  readonly categories: PublicCategory;
  readonly collectibles: PublicCollectible;
  readonly repacks: PublicRepackDetail;
  readonly repack_chases: PublicRepackChase;
  readonly search_shards: ProviderCatalogReleaseSearchShardV1;
}

const batchEnvelopeShape = {
  batchIndex: nonNegativeSafeIntegerSchema.max(
    MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT - 1,
  ),
  batchHash: sha256Schema,
  byteCount: positiveSafeIntegerSchema.max(
    MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  ),
} as const;

export const providerCatalogReleaseBatchV1Schema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        ...batchEnvelopeShape,
        kind: z.literal("vendors"),
        records: z
          .array(publicVendorSchema)
          .min(1)
          .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeShape,
        kind: z.literal("categories"),
        records: z
          .array(publicCategorySchema)
          .min(1)
          .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeShape,
        kind: z.literal("collectibles"),
        records: z
          .array(publicCollectibleSchema)
          .min(1)
          .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeShape,
        kind: z.literal("repacks"),
        records: z
          .array(publicRepackDetailSchema)
          .min(1)
          .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeShape,
        kind: z.literal("repack_chases"),
        records: z
          .array(publicRepackChaseSchema)
          .min(1)
          .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS),
      })
      .strict(),
    z
      .object({
        ...batchEnvelopeShape,
        kind: z.literal("search_shards"),
        records: z
          .array(providerCatalogReleaseSearchShardV1Schema)
          .min(1)
          .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS),
      })
      .strict(),
  ],
);

const immutableReleaseProofShape = {
  platformKey: providerCatalogPlatformKeyV1Schema,
  sharedConfigurationEpoch: providerCatalogSharedConfigurationEpochV1Schema,
  dataAsOf: timestampSchema,
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  providerReleaseFingerprint: sha256Schema,
  contentHash: sha256Schema,
  publicAssetOrigins: canonicalArraySchema(publicHttpsOriginSchema, 64),
  governingHashes: providerCatalogReleaseGoverningHashesV1Schema,
  entityHashes: providerCatalogReleaseEntityHashesV1Schema,
  counts: providerCatalogReleaseCountsV1Schema,
  searchAlgorithmVersion: z.literal(REPACK_SEARCH_VERSION),
  providerSearchIndexHash: sha256Schema,
  batchCount: positiveSafeIntegerSchema.max(
    MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  ),
  batchChainHash: sha256Schema,
} as const;

export const providerCatalogCompletedReleaseProofV1Schema = z
  .object({
    state: z.literal("complete"),
    ...immutableReleaseProofShape,
  })
  .strict();

const planContextShape = {
  schemaVersion: z.literal(PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION),
  platformKey: providerCatalogPlatformKeyV1Schema,
  sharedConfigurationEpoch: providerCatalogSharedConfigurationEpochV1Schema,
  providerCheckpoint: providerCatalogReleaseCheckpointV1Schema,
  sourceWatermark: z.string().min(1).max(256),
} as const;

const successfulPlanShape = {
  ...planContextShape,
  ...immutableReleaseProofShape,
  observation: providerCatalogReleaseObservationV1Schema,
} as const;

export const providerCatalogReleasePublishPlanV1Schema = z
  .object({
    ...successfulPlanShape,
    classification: z.literal("publish"),
    batches: z
      .array(providerCatalogReleaseBatchV1Schema)
      .min(1)
      .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT),
  })
  .strict();

export const providerCatalogReleaseReusePlanV1Schema = z
  .object({
    ...successfulPlanShape,
    classification: z.literal("reuse"),
    batches: z.array(providerCatalogReleaseBatchV1Schema).max(0),
    reuseProof: providerCatalogCompletedReleaseProofV1Schema,
  })
  .strict();

export const PROVIDER_CATALOG_RELEASE_BLOCK_REASONS = [
  "PROVIDER_SOURCE_INVALID",
  "PROVIDER_SCOPE_MISMATCH",
  "PROVIDER_CHECKPOINT_UNSETTLED",
  "PROVIDER_CHECKPOINT_REGRESSED",
  "PROVIDER_CHECKPOINT_EPOCH_MISMATCH",
  "PROVIDER_SOURCE_TECHNICAL_FAILURE",
  "INITIAL_BACKFILL_INCOMPLETE",
  "SETTLED_DERIVATION_INCOMPLETE",
  "PUBLIC_CONFIGURATION_INVALID",
  "PUBLIC_IDENTITY_MAPPING_MISSING",
  "CANONICAL_PROJECTION_INVALID",
  "PUBLIC_REFERENCE_INVALID",
  "PUBLIC_ORIGIN_UNAPPROVED",
  "PUBLIC_ACTION_UNAPPROVED",
  "PUBLIC_ARITHMETIC_INVALID",
  "PUBLIC_CONTRACT_INVALID",
  "PUBLICATION_BATCH_TOO_LARGE",
  "PUBLICATION_BATCH_LIMIT_EXCEEDED",
  "PROTECTED_PUBLICATION_FIELD",
] as const;

export const providerCatalogReleaseBlockReasonV1Schema = z.enum(
  PROVIDER_CATALOG_RELEASE_BLOCK_REASONS,
);

export const providerCatalogReleaseBlockedPlanV1Schema = z
  .object({
    ...planContextShape,
    classification: z.literal("blocked"),
    publicProviderReleaseId: z.null(),
    dataAsOf: z.null(),
    observation: z.null(),
    reason: providerCatalogReleaseBlockReasonV1Schema,
  })
  .strict();

export const PROTECTED_PROVIDER_CATALOG_RELEASE_FIELDS = [
  "apiKey",
  "apiKeys",
  "actorId",
  "attemptId",
  "collectibleId",
  "credential",
  "credentials",
  "importAttemptId",
  "internalRunId",
  "internalId",
  "importId",
  "organizationId",
  "orgId",
  "password",
  "passwords",
  "pollId",
  "pollAttemptId",
  "providerId",
  "providerPayload",
  "providerResponse",
  "quarantine",
  "quarantineDetail",
  "rawPayload",
  "rawResponse",
  "releaseId",
  "repackId",
  "secret",
  "secrets",
  "sourcePayload",
  "sourceResponse",
  "tenantId",
  "token",
  "tokens",
  "vendorId",
] as const;

const protectedProviderCatalogReleaseFields = new Set<string>(
  PROTECTED_PROVIDER_CATALOG_RELEASE_FIELDS.map(
    normalizeProtectedPublicationFieldKey,
  ),
);

export function containsProtectedProviderCatalogReleaseField(
  value: unknown,
): boolean {
  return containsNormalizedProtectedPublicationField(
    value,
    protectedProviderCatalogReleaseFields,
  );
}

type BatchRecord = z.infer<typeof providerCatalogReleaseBatchV1Schema>["records"][number];

function entityOrderKey(
  kind: ProviderCatalogReleaseBatchKindV1,
  record: BatchRecord,
): string {
  switch (kind) {
    case "vendors":
      return (record as PublicVendor).publicVendorId;
    case "categories": {
      const category = record as PublicCategory;
      return `${String(category.depth).padStart(2, "0")}:${category.publicCategoryId}`;
    }
    case "collectibles":
      return (record as PublicCollectible).publicCollectibleId;
    case "repacks":
      return (record as PublicRepackDetail).publicRepackId;
    case "repack_chases": {
      const chase = record as PublicRepackChase;
      return `${chase.publicRepackId}:${String(chase.displayOrder).padStart(16, "0")}:${chase.publicCollectibleId}`;
    }
    case "search_shards":
      return String(
        (record as ProviderCatalogReleaseSearchShardV1).shardNumber,
      ).padStart(4, "0");
  }
}

function immutableProofValue(value: z.infer<
  typeof providerCatalogReleaseReusePlanV1Schema
>) {
  return {
    state: "complete" as const,
    platformKey: value.platformKey,
    sharedConfigurationEpoch: value.sharedConfigurationEpoch,
    dataAsOf: value.dataAsOf,
    publicProviderReleaseId: value.publicProviderReleaseId,
    providerReleaseFingerprint: value.providerReleaseFingerprint,
    contentHash: value.contentHash,
    publicAssetOrigins: value.publicAssetOrigins,
    governingHashes: value.governingHashes,
    entityHashes: value.entityHashes,
    counts: value.counts,
    searchAlgorithmVersion: value.searchAlgorithmVersion,
    providerSearchIndexHash: value.providerSearchIndexHash,
    batchCount: value.batchCount,
    batchChainHash: value.batchChainHash,
  };
}

function validatePlanContext(
  plan: z.infer<
    typeof providerCatalogReleasePublishPlanV1Schema |
    typeof providerCatalogReleaseReusePlanV1Schema |
    typeof providerCatalogReleaseBlockedPlanV1Schema
  >,
  context: z.RefinementCtx,
): void {
  if (
    plan.sourceWatermark !==
      buildProviderCatalogSourceWatermarkV1(
        plan.platformKey,
        plan.providerCheckpoint.settledSequence,
      )
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceWatermark"],
      message: "provider_catalog_release.source_watermark_mismatch",
    });
  }
  const settledSequence = BigInt(plan.providerCheckpoint.settledSequence);
  if (
    plan.classification !== "blocked" &&
    BigInt(plan.sharedConfigurationEpoch.publicChangeSequence) > settledSequence
  ) {
    context.addIssue({
      code: "custom",
      path: ["sharedConfigurationEpoch", "publicChangeSequence"],
      message: "provider_catalog_release.epoch_after_checkpoint",
    });
  }
  if (plan.classification !== "blocked" && settledSequence === BigInt("0")) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint", "settledSequence"],
      message: "provider_catalog_release.checkpoint_empty",
    });
  }
  if (plan.observation !== null) {
    const sourceHeadSequence = BigInt(plan.observation.sourceHeadSequence);
    if (sourceHeadSequence < settledSequence) {
      context.addIssue({
        code: "custom",
        path: ["observation", "sourceHeadSequence"],
        message: "provider_catalog_release.source_head_regressed",
      });
    }
    if (sourceHeadSequence !== settledSequence) {
      context.addIssue({
        code: "custom",
        path: ["providerCheckpoint", "settledSequence"],
        message: "provider_catalog_release.checkpoint_unsettled",
      });
    }
    if (
      Date.parse(plan.dataAsOf) >
        Date.parse(plan.observation.lastSuccessfulObservationAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataAsOf"],
        message: "provider_catalog_release.data_after_observation",
      });
    }
  }
  if (containsProtectedProviderCatalogReleaseField(plan)) {
    context.addIssue({
      code: "custom",
      message: "provider_catalog_release.protected_field",
    });
  }
}

function validateSuccessfulPlan(
  plan: z.infer<
    typeof providerCatalogReleasePublishPlanV1Schema |
    typeof providerCatalogReleaseReusePlanV1Schema
  >,
  context: z.RefinementCtx,
): void {
  const completedAt = plan.providerCheckpoint.settledAt;
  if (completedAt === null) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint", "settledAt"],
      message: "provider_catalog_release.checkpoint_empty",
    });
    return;
  }
  if (plan.classification === "reuse") {
    if (canonicalJson(plan.reuseProof) !== canonicalJson(immutableProofValue(plan))) {
      context.addIssue({
        code: "custom",
        path: ["reuseProof"],
        message: "provider_catalog_release.reuse_proof_mismatch",
      });
    }
    return;
  }
  if (plan.batchCount !== plan.batches.length) {
    context.addIssue({
      code: "custom",
      path: ["batchCount"],
      message: "provider_catalog_release.batch_count_mismatch",
    });
  }
  const recordCounts = {
    vendors: 0,
    categories: 0,
    collectibles: 0,
    repacks: 0,
    repackChases: 0,
    searchShards: 0,
  };
  const previousEntityKey = new Map<ProviderCatalogReleaseBatchKindV1, string>();
  let previousKindIndex = -1;
  plan.batches.forEach((batch, batchOffset) => {
    if (batch.batchIndex !== batchOffset) {
      context.addIssue({
        code: "custom",
        path: ["batches", batchOffset, "batchIndex"],
        message: "provider_catalog_release.batch_index_not_canonical",
      });
    }
    const kindIndex = PROVIDER_CATALOG_RELEASE_BATCH_KINDS.indexOf(batch.kind);
    if (kindIndex < previousKindIndex) {
      context.addIssue({
        code: "custom",
        path: ["batches", batchOffset, "kind"],
        message: "provider_catalog_release.batch_kind_not_canonical",
      });
    }
    previousKindIndex = kindIndex;
    const previousBatch = plan.batches[batchOffset - 1];
    if (previousBatch?.kind === batch.kind) {
      const candidateRecords: readonly unknown[] = [
        ...previousBatch.records,
        batch.records[0]!,
      ];
      if (
        candidateRecords.length <= MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS &&
        providerCatalogReleaseBatchByteCount(candidateRecords) <=
          MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES
      ) {
        context.addIssue({
          code: "custom",
          path: ["batches", batchOffset],
          message: "provider_catalog_release.batch_partition_not_canonical",
        });
      }
    }
    if (batch.byteCount !== providerCatalogReleaseBatchByteCount(batch.records)) {
      context.addIssue({
        code: "custom",
        path: ["batches", batchOffset, "byteCount"],
        message: "provider_catalog_release.batch_byte_count_mismatch",
      });
    }
    for (const record of batch.records) {
      const key = entityOrderKey(batch.kind, record);
      const previous = previousEntityKey.get(batch.kind);
      if (previous !== undefined && previous >= key) {
        context.addIssue({
          code: "custom",
          path: ["batches", batchOffset, "records"],
          message: "provider_catalog_release.records_not_canonical",
        });
      }
      previousEntityKey.set(batch.kind, key);
    }
    switch (batch.kind) {
      case "vendors":
        recordCounts.vendors += batch.records.length;
        break;
      case "categories":
        recordCounts.categories += batch.records.length;
        break;
      case "collectibles":
        recordCounts.collectibles += batch.records.length;
        break;
      case "repacks":
        recordCounts.repacks += batch.records.length;
        break;
      case "repack_chases":
        recordCounts.repackChases += batch.records.length;
        break;
      case "search_shards":
        recordCounts.searchShards += batch.records.length;
        break;
    }
  });
  if (canonicalJson(recordCounts) !== canonicalJson(plan.counts)) {
    context.addIssue({
      code: "custom",
      path: ["counts"],
      message: "provider_catalog_release.record_count_mismatch",
    });
  }
  const searchShards = plan.batches
    .filter((batch) => batch.kind === "search_shards")
    .flatMap((batch) => batch.records);
  if (
    searchShards.some(
      (shard, index) => shard.shardNumber !== index,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["batches"],
      message: "provider_catalog_release.search_shards_not_contiguous",
    });
  }
  for (let index = 1; index < searchShards.length; index += 1) {
    const previousShard = searchShards[index - 1]!;
    const shard = searchShards[index]!;
    const candidateRows = [...previousShard.rows, shard.rows[0]!];
    const candidateRecord = {
      shardNumber: previousShard.shardNumber,
      rowCount: candidateRows.length,
      byteCount: providerCatalogReleaseBatchByteCount(candidateRows),
      contentHash: "0".repeat(64),
      rows: candidateRows,
    };
    if (
      candidateRows.length <= MAX_ROWS_PER_REPACK_SEARCH_SHARD &&
      providerCatalogReleaseBatchByteCount([candidateRecord]) <=
        MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["batches"],
        message:
          "provider_catalog_release.search_shard_partition_not_canonical",
      });
    }
  }
  const vendors = plan.batches
    .filter((batch) => batch.kind === "vendors")
    .flatMap((batch) => batch.records);
  const categories = plan.batches
    .filter((batch) => batch.kind === "categories")
    .flatMap((batch) => batch.records);
  const collectibles = plan.batches
    .filter((batch) => batch.kind === "collectibles")
    .flatMap((batch) => batch.records);
  const repacks = plan.batches
    .filter((batch) => batch.kind === "repacks")
    .flatMap((batch) => batch.records);
  const repackChases = plan.batches
    .filter((batch) => batch.kind === "repack_chases")
    .flatMap((batch) => batch.records);
  validateDataReleaseV2EntityGraph(
    {
      publicAssetOrigins: plan.publicAssetOrigins,
      vendors,
      categories,
      collectibles,
      repacks,
      repackChases,
    },
    context,
    {
      categoryKey: (category) =>
        `${String(category.depth).padStart(2, "0")}:${category.publicCategoryId}`,
      repackChaseKey: (chase) =>
        `${chase.publicRepackId}:${String(chase.displayOrder).padStart(16, "0")}:${chase.publicCollectibleId}`,
      timing: {
        dataAsOf: plan.dataAsOf,
        lastSuccessfulObservationAt:
          plan.observation.lastSuccessfulObservationAt,
        recordDataAsOfUpperBound: plan.dataAsOf,
        completedAt,
      },
    },
  );
  const searchRows = searchShards.flatMap(({ rows }) => rows);
  if (
    searchRows.length !== repacks.length ||
    !isStrictlySortedUnique(searchRows, ({ publicRepackId }) => publicRepackId) ||
    searchRows.some(
      (row, index) =>
        canonicalJson(row) !==
          canonicalJson(repackSearchRowFromDetail(repacks[index]!)),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["batches"],
      message: "provider_catalog_release.search_projection_mismatch",
    });
  }
}

export const providerCatalogReleasePlanV1Schema = z
  .discriminatedUnion("classification", [
    providerCatalogReleasePublishPlanV1Schema,
    providerCatalogReleaseReusePlanV1Schema,
    providerCatalogReleaseBlockedPlanV1Schema,
  ])
  .superRefine((plan, context) => {
    validatePlanContext(plan, context);
    if (plan.classification !== "blocked") {
      validateSuccessfulPlan(plan, context);
    }
  });

export type ProviderCatalogReleaseSearchShardV1 = z.infer<
  typeof providerCatalogReleaseSearchShardV1Schema
>;
export type ProviderCatalogReleaseBatchV1 = z.infer<
  typeof providerCatalogReleaseBatchV1Schema
>;
export type ProviderCatalogCompletedReleaseProofV1 = z.infer<
  typeof providerCatalogCompletedReleaseProofV1Schema
>;
export type ProviderCatalogReleasePublishPlanV1 = z.infer<
  typeof providerCatalogReleasePublishPlanV1Schema
>;
export type ProviderCatalogReleaseReusePlanV1 = z.infer<
  typeof providerCatalogReleaseReusePlanV1Schema
>;
export type ProviderCatalogReleaseBlockedPlanV1 = z.infer<
  typeof providerCatalogReleaseBlockedPlanV1Schema
>;
export type ProviderCatalogReleasePlanV1 = z.infer<
  typeof providerCatalogReleasePlanV1Schema
>;
export type ProviderCatalogReleaseBlockReasonV1 = z.infer<
  typeof providerCatalogReleaseBlockReasonV1Schema
>;

export function parseProviderCatalogReleasePlanV1(
  input: unknown,
): ProviderCatalogReleasePlanV1 {
  return providerCatalogReleasePlanV1Schema.parse(input);
}

export function safeParseProviderCatalogReleasePlanV1(input: unknown) {
  return providerCatalogReleasePlanV1Schema.safeParse(input);
}

export type ProviderCatalogReleaseIntegrityErrorCode =
  | "PROVIDER_CATALOG_RELEASE_BATCH_HASH_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_CONTENT_HASH_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_ENTITY_HASH_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_FINGERPRINT_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_IDENTITY_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_ORIGIN_SET_HASH_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_SEARCH_INDEX_HASH_MISMATCH"
  | "PROVIDER_CATALOG_RELEASE_SEARCH_SHARD_HASH_MISMATCH";

export class ProviderCatalogReleaseIntegrityError extends Error {
  constructor(readonly code: ProviderCatalogReleaseIntegrityErrorCode) {
    super(code);
    this.name = "ProviderCatalogReleaseIntegrityError";
  }
}

function integrityFailure(code: ProviderCatalogReleaseIntegrityErrorCode): never {
  throw new ProviderCatalogReleaseIntegrityError(code);
}

function publishRecordsByKind(
  plan: ProviderCatalogReleasePublishPlanV1,
): Record<ProviderCatalogReleaseBatchKindV1, readonly unknown[]> {
  const result: Record<ProviderCatalogReleaseBatchKindV1, unknown[]> = {
    vendors: [],
    categories: [],
    collectibles: [],
    repacks: [],
    repack_chases: [],
    search_shards: [],
  };
  for (const batch of plan.batches) result[batch.kind].push(...batch.records);
  return result;
}

async function verifyImmutableIdentity(
  plan: ProviderCatalogReleasePublishPlanV1 | ProviderCatalogReleaseReusePlanV1,
): Promise<void> {
  if (
    await recomputeProviderCatalogReleaseOriginSetHashV1(
      plan.publicAssetOrigins,
    ) !== plan.governingHashes.originSetHash
  ) {
    integrityFailure("PROVIDER_CATALOG_RELEASE_ORIGIN_SET_HASH_MISMATCH");
  }
  if (
    await recomputeProviderCatalogReleaseContentHashV1({
      entityHashes: plan.entityHashes,
    }) !== plan.contentHash
  ) {
    integrityFailure("PROVIDER_CATALOG_RELEASE_CONTENT_HASH_MISMATCH");
  }
  if (
    await recomputeProviderCatalogReleaseFingerprintV1(plan) !==
      plan.providerReleaseFingerprint
  ) {
    integrityFailure("PROVIDER_CATALOG_RELEASE_FINGERPRINT_MISMATCH");
  }
  if (
    await derivePublicProviderReleaseIdV1(plan) !==
      plan.publicProviderReleaseId
  ) {
    integrityFailure("PROVIDER_CATALOG_RELEASE_IDENTITY_MISMATCH");
  }
}

/** Parses the strict wire shape and verifies every available cryptographic proof. */
export async function verifyProviderCatalogReleasePlanV1(
  input: unknown,
): Promise<ProviderCatalogReleasePlanV1> {
  const plan = parseProviderCatalogReleasePlanV1(input);
  if (plan.classification === "blocked") return plan;
  if (plan.classification === "reuse") {
    await verifyImmutableIdentity(plan);
    return plan;
  }

  let batchChainHash = EMPTY_PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_HASH;
  const acceptedEntityHashes = {} as Record<
    ProviderCatalogReleaseBatchKindV1,
    string
  >;
  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    acceptedEntityHashes[kind] =
      await initializeProviderCatalogReleaseEntityHashV1(kind);
  }
  for (const batch of plan.batches) {
    if (
      await recomputeProviderCatalogReleaseBatchHashV1(batch) !== batch.batchHash
    ) {
      integrityFailure("PROVIDER_CATALOG_RELEASE_BATCH_HASH_MISMATCH");
    }
    batchChainHash = await extendProviderCatalogReleaseBatchChainV1({
      previousHash: batchChainHash,
      batchIndex: batch.batchIndex,
      kind: batch.kind,
      batchHash: batch.batchHash,
      recordCount: batch.records.length,
      byteCount: batch.byteCount,
    });
    acceptedEntityHashes[batch.kind] =
      await extendProviderCatalogReleaseEntityHashV1({
        previousHash: acceptedEntityHashes[batch.kind],
        kind: batch.kind,
        batchHash: batch.batchHash,
        recordCount: batch.records.length,
        byteCount: batch.byteCount,
      });
  }
  if (batchChainHash !== plan.batchChainHash) {
    integrityFailure("PROVIDER_CATALOG_RELEASE_BATCH_CHAIN_MISMATCH");
  }

  for (const kind of PROVIDER_CATALOG_RELEASE_BATCH_KINDS) {
    if (acceptedEntityHashes[kind] !== plan.entityHashes[kind]) {
      integrityFailure("PROVIDER_CATALOG_RELEASE_ENTITY_HASH_MISMATCH");
    }
  }
  const recordsByKind = publishRecordsByKind(plan);
  const searchShards = recordsByKind.search_shards as readonly ProviderCatalogReleaseSearchShardV1[];
  for (const shard of searchShards) {
    if (
      await recomputeProviderCatalogSearchShardHashV1(shard.rows) !==
        shard.contentHash
    ) {
      integrityFailure("PROVIDER_CATALOG_RELEASE_SEARCH_SHARD_HASH_MISMATCH");
    }
  }
  if (
    await recomputeProviderCatalogSearchIndexHashV1(searchShards) !==
      plan.providerSearchIndexHash
  ) {
    integrityFailure("PROVIDER_CATALOG_RELEASE_SEARCH_INDEX_HASH_MISMATCH");
  }
  await verifyImmutableIdentity(plan);
  return plan;
}
