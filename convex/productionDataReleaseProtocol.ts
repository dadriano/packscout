import {
  DATA_RELEASE_SCHEMA_VERSION,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
  REPACK_SEARCH_VERSION,
  publicCategorySchema,
  publicCollectibleSchema,
  publicHttpsOriginSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  sha256Schema,
  timestampSchema,
} from "@packscout/contracts";
import { z } from "zod";
import {
  DATA_RELEASE_BATCH_HASH_DOMAIN,
  canonicalJson,
  sha256CanonicalJson,
} from "./dataReleaseCanonicalHash";
import {
  MAX_REPACK_SEARCH_SHARDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  isValidRepackSearchRow,
  type RepackSearchRow,
} from "./publicRepackValidation";

export const PRODUCTION_BATCH_CHAIN_HASH_DOMAIN =
  "packscout.data-release.batch-chain.v2" as const;
export const PRODUCTION_MANIFEST_HASH_DOMAIN =
  "packscout.data-release.manifest.v2" as const;
export const PRODUCTION_ORIGIN_SET_HASH_DOMAIN =
  "packscout.data-release.origin-set.v2" as const;
export const PRODUCTION_RECEIPT_HASH_DOMAIN =
  "packscout.data-release.receipt.v2" as const;
export const EMPTY_BATCH_CHAIN_HASH = "0".repeat(64);
export const MAX_PRODUCTION_BATCH_RECORDS = 100;
export const MAX_PRODUCTION_BATCH_BYTES = 48 * 1_024;
export const MAX_PRODUCTION_HTTP_BODY_BYTES = 128 * 1_024;
export const MAX_PRODUCTION_BATCH_COUNT = 4_096;

const PROTECTED_PUBLICATION_FIELDS = new Set([
  "actorId",
  "collectibleId",
  "credential",
  "credentials",
  "internalRunId",
  "organizationId",
  "providerPayload",
  "quarantine",
  "rawPayload",
  "releaseId",
  "repackId",
  "secret",
  "tenantId",
  "vendorId",
]);

export function containsProtectedPublicationField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsProtectedPublicationField);
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      PROTECTED_PUBLICATION_FIELDS.has(key) ||
      containsProtectedPublicationField(nested),
  );
}

const operationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const publicReleaseIdSchema = z.uuid();
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);

export const productionReleaseCountsSchema = z
  .object({
    vendors: nonNegativeSafeIntegerSchema.max(128),
    categories: nonNegativeSafeIntegerSchema.max(4_096),
    collectibles: nonNegativeSafeIntegerSchema.max(100_000),
    repacks: nonNegativeSafeIntegerSchema.max(MAX_PUBLIC_REPACKS_PER_RELEASE),
    repackChases: nonNegativeSafeIntegerSchema.max(250_000),
    searchShards: nonNegativeSafeIntegerSchema.max(MAX_REPACK_SEARCH_SHARDS),
  })
  .strict();

const operationEnvelopeShape = {
  schemaVersion: z.literal(DATA_RELEASE_SCHEMA_VERSION),
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
} as const;

export const productionStartRequestSchema = z
  .object({
    ...operationEnvelopeShape,
    publicationId: publicReleaseIdSchema,
    expectedPredecessorPublicReleaseId: publicReleaseIdSchema.nullable(),
    manifest: z
      .object({
        publicReleaseId: publicReleaseIdSchema,
        sourceWatermark: z
          .string()
          .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u),
        observationSequence: z.number().int().safe().positive(),
        manifestFingerprint: sha256Schema,
        contentHash: sha256Schema,
        publicConfigRevision: z.number().int().safe().positive(),
        publicConfigHash: sha256Schema,
        originSetHash: sha256Schema,
        searchAlgorithmVersion: z.literal(REPACK_SEARCH_VERSION),
        repackSearchIndexHash: sha256Schema,
        confidencePolicyVersion: z.string().trim().min(1).max(128),
        createdAt: timestampSchema,
        dataAsOf: timestampSchema,
        lastSuccessfulObservationAt: timestampSchema,
        staleAt: timestampSchema,
        freshness: z.enum(["fresh", "delayed"]),
        delayedVendorCount: nonNegativeSafeIntegerSchema.max(128),
        counts: productionReleaseCountsSchema,
        batchCount: z
          .number()
          .int()
          .safe()
          .min(0)
          .max(MAX_PRODUCTION_BATCH_COUNT),
        batchChainHash: sha256Schema,
        publicAssetOrigins: z.array(publicHttpsOriginSchema).max(64),
      })
      .strict(),
  })
  .strict();

export type ProductionStartRequest = z.infer<
  typeof productionStartRequestSchema
>;
export type ProductionReleaseCounts = z.infer<
  typeof productionReleaseCountsSchema
>;

const REPACK_SEARCH_ROW_KEYS = [
  "availability",
  "buybackBasisPoints",
  "buybackNullRank",
  "categoryLabels",
  "collectibleTypes",
  "contentMode",
  "name",
  "normalizedCategories",
  "normalizedName",
  "normalizedVendor",
  "packScoutConfidenceBand",
  "packScoutConfidenceBasisPoints",
  "packScoutConfidenceNullRank",
  "packScoutEvDollarsMinor",
  "packScoutEvDollarsNullRank",
  "packScoutEvPercentBasisPoints",
  "packScoutEvPercentNullRank",
  "packScoutGrossEvMinor",
  "packScoutGrossEvNullRank",
  "priceMinor",
  "priceNullRank",
  "publicCategoryIds",
  "publicRepackId",
  "publicVendorId",
  "topChaseNullRank",
  "topChaseReason",
  "topChaseValueMinor",
  "vendorDisplayName",
  "vendorKey",
  "vendorReportedEvDollarsMinor",
  "vendorReportedEvDollarsNullRank",
  "vendorReportedEvPercentBasisPoints",
  "vendorReportedEvPercentNullRank",
  "vendorReportedGrossEvMinor",
  "vendorReportedGrossEvNullRank",
] as const;

function isStrictSearchRow(value: unknown): value is RepackSearchRow {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...REPACK_SEARCH_ROW_KEYS].sort()) &&
    isValidRepackSearchRow(value as RepackSearchRow)
  );
}

export const productionSearchShardSchema = z
  .object({
    shardNumber: nonNegativeSafeIntegerSchema.max(MAX_REPACK_SEARCH_SHARDS - 1),
    rowCount: nonNegativeSafeIntegerSchema.max(
      MAX_ROWS_PER_REPACK_SEARCH_SHARD,
    ),
    byteCount: nonNegativeSafeIntegerSchema.max(MAX_PRODUCTION_BATCH_BYTES),
    contentHash: sha256Schema,
    rows: z.array(z.custom<RepackSearchRow>(isStrictSearchRow)).max(
      MAX_ROWS_PER_REPACK_SEARCH_SHARD,
    ),
  })
  .strict();

const batchEnvelopeShape = {
  ...operationEnvelopeShape,
  publicationId: publicReleaseIdSchema,
  batchIndex: nonNegativeSafeIntegerSchema.max(MAX_PRODUCTION_BATCH_COUNT - 1),
  batchHash: sha256Schema,
} as const;

export const productionApplyBatchRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...batchEnvelopeShape,
      kind: z.literal("vendors"),
      records: z.array(publicVendorSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS),
    })
    .strict(),
  z
    .object({
      ...batchEnvelopeShape,
      kind: z.literal("categories"),
      records: z.array(publicCategorySchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS),
    })
    .strict(),
  z
    .object({
      ...batchEnvelopeShape,
      kind: z.literal("collectibles"),
      records: z.array(publicCollectibleSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS),
    })
    .strict(),
  z
    .object({
      ...batchEnvelopeShape,
      kind: z.literal("repacks"),
      records: z.array(publicRepackDetailSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS),
    })
    .strict(),
  z
    .object({
      ...batchEnvelopeShape,
      kind: z.literal("repack_chases"),
      records: z.array(publicRepackChaseSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS),
    })
    .strict(),
  z
    .object({
      ...batchEnvelopeShape,
      kind: z.literal("search_shards"),
      records: z.array(productionSearchShardSchema).min(1).max(
        MAX_PRODUCTION_BATCH_RECORDS,
      ),
    })
    .strict(),
]);

export type ProductionApplyBatchRequest = z.infer<
  typeof productionApplyBatchRequestSchema
>;
export type ProductionBatchKind = ProductionApplyBatchRequest["kind"];

export const PRODUCTION_BATCH_KINDS: readonly ProductionBatchKind[] = [
  "vendors",
  "categories",
  "collectibles",
  "repacks",
  "repack_chases",
  "search_shards",
];

export const productionFinalizeRequestSchema = z
  .object({
    ...operationEnvelopeShape,
    publicationId: publicReleaseIdSchema,
    expectedPredecessorPublicReleaseId: publicReleaseIdSchema.nullable(),
    expectedCounts: productionReleaseCountsSchema,
    expectedBatchCount: z.number().int().safe().min(0).max(
      MAX_PRODUCTION_BATCH_COUNT,
    ),
    expectedBatchChainHash: sha256Schema,
  })
  .strict();

export const productionStatusRequestSchema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_SCHEMA_VERSION),
    operationId: operationIdSchema,
    publicationId: publicReleaseIdSchema.nullable(),
  })
  .strict();

export const productionRefreshRequestSchema = z
  .object({
    ...operationEnvelopeShape,
    publicReleaseId: publicReleaseIdSchema,
    contentHash: sha256Schema,
    observationSequence: z.number().int().safe().positive(),
    dataAsOf: timestampSchema,
    lastSuccessfulObservationAt: timestampSchema,
    staleAt: timestampSchema,
    freshness: z.enum(["fresh", "delayed"]),
    delayedVendorCount: nonNegativeSafeIntegerSchema.max(128),
  })
  .strict();

export const productionRollbackRequestSchema = z
  .object({
    ...operationEnvelopeShape,
    expectedActivePublicReleaseId: publicReleaseIdSchema,
    targetPublicReleaseId: publicReleaseIdSchema.nullable(),
    clearAuthorization: z.literal("clear_catalog_v1").nullable(),
  })
  .strict()
  .refine(
    ({ targetPublicReleaseId, clearAuthorization }) =>
      (targetPublicReleaseId === null) ===
        (clearAuthorization === "clear_catalog_v1"),
    { message: "publication.rollback_authorization_invalid" },
  );

export const productionRetainRequestSchema = z
  .object(operationEnvelopeShape)
  .strict();

export type ProductionFinalizeRequest = z.infer<
  typeof productionFinalizeRequestSchema
>;
export type ProductionStatusRequest = z.infer<
  typeof productionStatusRequestSchema
>;
export type ProductionRefreshRequest = z.infer<
  typeof productionRefreshRequestSchema
>;
export type ProductionRollbackRequest = z.infer<
  typeof productionRollbackRequestSchema
>;
export type ProductionRetainRequest = z.infer<
  typeof productionRetainRequestSchema
>;

export function manifestFingerprintBody(
  request: ProductionStartRequest,
): unknown {
  const manifest = request.manifest;
  return {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    contentHash: manifest.contentHash,
    publicConfigRevision: manifest.publicConfigRevision,
    publicConfigHash: manifest.publicConfigHash,
    originSetHash: manifest.originSetHash,
    searchAlgorithmVersion: manifest.searchAlgorithmVersion,
    repackSearchIndexHash: manifest.repackSearchIndexHash,
    confidencePolicyVersion: manifest.confidencePolicyVersion,
    counts: manifest.counts,
    batchCount: manifest.batchCount,
    batchChainHash: manifest.batchChainHash,
    publicAssetOrigins: manifest.publicAssetOrigins,
  };
}

export async function recomputeProductionManifestFingerprint(
  request: ProductionStartRequest,
): Promise<string> {
  return await sha256CanonicalJson(
    PRODUCTION_MANIFEST_HASH_DOMAIN,
    manifestFingerprintBody(request),
  );
}

export async function recomputeProductionOriginSetHash(
  origins: readonly string[],
): Promise<string> {
  return await sha256CanonicalJson(PRODUCTION_ORIGIN_SET_HASH_DOMAIN, origins);
}

export async function recomputeProductionBatchHash(
  batch: Pick<ProductionApplyBatchRequest, "kind" | "records">,
): Promise<string> {
  return await sha256CanonicalJson(DATA_RELEASE_BATCH_HASH_DOMAIN, {
    kind: batch.kind,
    records: batch.records,
  });
}

export function productionBatchByteCount(records: readonly unknown[]): number {
  return new TextEncoder().encode(canonicalJson(records)).byteLength;
}

export async function extendProductionBatchChain(input: {
  previousHash: string;
  batchIndex: number;
  kind: ProductionBatchKind;
  batchHash: string;
  recordCount: number;
  byteCount: number;
}): Promise<string> {
  return await sha256CanonicalJson(PRODUCTION_BATCH_CHAIN_HASH_DOMAIN, input);
}

export async function productionReceiptHash(
  receiptWithoutDigest: unknown,
): Promise<string> {
  return await sha256CanonicalJson(
    PRODUCTION_RECEIPT_HASH_DOMAIN,
    receiptWithoutDigest,
  );
}

export function parseStrictJson<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T | null {
  try {
    return schema.parse(JSON.parse(bodyJson) as unknown);
  } catch {
    return null;
  }
}
