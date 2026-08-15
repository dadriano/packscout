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
  repackSearchRowSchema,
  type RepackSearchRow,
} from "./data-release-v2-search.ts";
import { z } from "zod";
import {
  DATA_RELEASE_BATCH_HASH_DOMAIN,
  EMPTY_BATCH_CHAIN_HASH,
  PRODUCTION_BATCH_CHAIN_HASH_DOMAIN,
  PRODUCTION_MANIFEST_HASH_DOMAIN,
  PRODUCTION_ORIGIN_SET_HASH_DOMAIN,
  PRODUCTION_RECEIPT_HASH_DOMAIN,
  canonicalJsonByteCount,
  sha256CanonicalJson,
} from "./data-release-v2-canonical.ts";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  REPACK_SEARCH_VERSION,
  publicHttpsOriginSchema,
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";

export const MAX_PRODUCTION_BATCH_RECORDS = 100;
export const MAX_PRODUCTION_BATCH_BYTES = 48 * 1_024;
export const MAX_PRODUCTION_HTTP_BODY_BYTES = 128 * 1_024;
export const MAX_PRODUCTION_BATCH_COUNT = 4_096;

export const PRODUCTION_DATA_RELEASE_PATHS = Object.freeze({
  start: "/internal/data-release/v2/start",
  applyBatch: "/internal/data-release/v2/apply-batch",
  finalize: "/internal/data-release/v2/finalize",
  status: "/internal/data-release/v2/status",
  refreshObservation: "/internal/data-release/v2/refresh-observation",
  rollback: "/internal/data-release/v2/rollback",
  retain: "/internal/data-release/v2/retain",
});

export type ProductionReleaseCounts = Readonly<{
  vendors: number;
  categories: number;
  collectibles: number;
  repacks: number;
  repackChases: number;
  searchShards: number;
}>;

export type ProductionStartManifest = Readonly<{
  publicReleaseId: string;
  sourceWatermark: string;
  observationSequence: number;
  manifestFingerprint: string;
  contentHash: string;
  publicConfigRevision: number;
  publicConfigHash: string;
  originSetHash: string;
  searchAlgorithmVersion: typeof REPACK_SEARCH_VERSION;
  repackSearchIndexHash: string;
  confidencePolicyVersion: string;
  createdAt: string;
  dataAsOf: string;
  lastSuccessfulObservationAt: string;
  staleAt: string;
  freshness: "fresh" | "delayed";
  delayedVendorCount: number;
  counts: ProductionReleaseCounts;
  batchCount: number;
  batchChainHash: string;
  publicAssetOrigins: readonly string[];
}>;

type OperationEnvelope = Readonly<{
  schemaVersion: typeof DATA_RELEASE_SCHEMA_VERSION;
  operationId: string;
  idempotencyKey: string;
}>;

export type ProductionStartRequest = OperationEnvelope & Readonly<{
  publicationId: string;
  expectedPredecessorPublicReleaseId: string | null;
  manifest: ProductionStartManifest;
}>;

export type ProductionSearchShard = Readonly<{
  shardNumber: number;
  rowCount: number;
  byteCount: number;
  contentHash: string;
  rows: readonly RepackSearchRow[];
}>;

export interface ProductionBatchRecordMap {
  vendors: PublicVendor;
  categories: PublicCategory;
  collectibles: PublicCollectible;
  repacks: PublicRepackDetail;
  repack_chases: PublicRepackChase;
  search_shards: ProductionSearchShard;
}

export type ProductionBatchKind = keyof ProductionBatchRecordMap;
export const PRODUCTION_BATCH_KINDS: readonly ProductionBatchKind[] = [
  "vendors",
  "categories",
  "collectibles",
  "repacks",
  "repack_chases",
  "search_shards",
];

export type ProductionApplyBatchRequest<
  K extends ProductionBatchKind = ProductionBatchKind,
> = K extends ProductionBatchKind
  ? OperationEnvelope & Readonly<{
      publicationId: string;
      batchIndex: number;
      kind: K;
      batchHash: string;
      records: readonly ProductionBatchRecordMap[K][];
    }>
  : never;

export type ProductionFinalizeRequest = OperationEnvelope & Readonly<{
  publicationId: string;
  expectedPredecessorPublicReleaseId: string | null;
  expectedCounts: ProductionReleaseCounts;
  expectedBatchCount: number;
  expectedBatchChainHash: string;
}>;

export type ProductionStatusRequest = Readonly<{
  schemaVersion: typeof DATA_RELEASE_SCHEMA_VERSION;
  operationId: string;
  publicationId: string | null;
}>;

export type ProductionRefreshRequest = OperationEnvelope & Readonly<{
  publicReleaseId: string;
  contentHash: string;
  observationSequence: number;
  dataAsOf: string;
  lastSuccessfulObservationAt: string;
  staleAt: string;
  freshness: "fresh" | "delayed";
  delayedVendorCount: number;
}>;

export type ProductionRollbackRequest = OperationEnvelope & Readonly<{
  expectedActivePublicReleaseId: string;
  targetPublicReleaseId: string | null;
  clearAuthorization: "clear_catalog_v1" | null;
}>;

export type ProductionRetainRequest = OperationEnvelope;

const operationIdSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const publicReleaseIdSchema = z.uuid();
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const operationEnvelopeSchema = {
  schemaVersion: z.literal(DATA_RELEASE_SCHEMA_VERSION),
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
} as const;

export const productionReleaseCountsSchema = z.object({
  vendors: nonNegativeSafeIntegerSchema.max(128),
  categories: nonNegativeSafeIntegerSchema.max(4_096),
  collectibles: nonNegativeSafeIntegerSchema.max(100_000),
  repacks: nonNegativeSafeIntegerSchema.max(8_000),
  repackChases: nonNegativeSafeIntegerSchema.max(250_000),
  searchShards: nonNegativeSafeIntegerSchema.max(250),
}).strict();

export const productionStartManifestSchema = z.object({
  publicReleaseId: publicReleaseIdSchema,
  sourceWatermark: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u),
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
  batchCount: nonNegativeSafeIntegerSchema.max(MAX_PRODUCTION_BATCH_COUNT),
  batchChainHash: sha256Schema,
  publicAssetOrigins: z.array(publicHttpsOriginSchema).max(64),
}).strict();

export const productionStartRequestSchema = z.object({
  ...operationEnvelopeSchema,
  publicationId: publicReleaseIdSchema,
  expectedPredecessorPublicReleaseId: publicReleaseIdSchema.nullable(),
  manifest: productionStartManifestSchema,
}).strict();

export const productionSearchShardSchema = z.object({
  shardNumber: nonNegativeSafeIntegerSchema.max(MAX_REPACK_SEARCH_SHARDS - 1),
  rowCount: nonNegativeSafeIntegerSchema.max(MAX_ROWS_PER_REPACK_SEARCH_SHARD),
  byteCount: nonNegativeSafeIntegerSchema.max(MAX_PRODUCTION_BATCH_BYTES),
  contentHash: sha256Schema,
  rows: z.array(repackSearchRowSchema).max(MAX_ROWS_PER_REPACK_SEARCH_SHARD),
}).strict();

const batchEnvelopeSchema = {
  ...operationEnvelopeSchema,
  publicationId: publicReleaseIdSchema,
  batchIndex: nonNegativeSafeIntegerSchema.max(MAX_PRODUCTION_BATCH_COUNT - 1),
  batchHash: sha256Schema,
} as const;

export const productionApplyBatchRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...batchEnvelopeSchema, kind: z.literal("vendors"), records: z.array(publicVendorSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS) }).strict(),
  z.object({ ...batchEnvelopeSchema, kind: z.literal("categories"), records: z.array(publicCategorySchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS) }).strict(),
  z.object({ ...batchEnvelopeSchema, kind: z.literal("collectibles"), records: z.array(publicCollectibleSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS) }).strict(),
  z.object({ ...batchEnvelopeSchema, kind: z.literal("repacks"), records: z.array(publicRepackDetailSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS) }).strict(),
  z.object({ ...batchEnvelopeSchema, kind: z.literal("repack_chases"), records: z.array(publicRepackChaseSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS) }).strict(),
  z.object({ ...batchEnvelopeSchema, kind: z.literal("search_shards"), records: z.array(productionSearchShardSchema).min(1).max(MAX_PRODUCTION_BATCH_RECORDS) }).strict(),
]);

export const productionFinalizeRequestSchema = z.object({
  ...operationEnvelopeSchema,
  publicationId: publicReleaseIdSchema,
  expectedPredecessorPublicReleaseId: publicReleaseIdSchema.nullable(),
  expectedCounts: productionReleaseCountsSchema,
  expectedBatchCount: nonNegativeSafeIntegerSchema.max(MAX_PRODUCTION_BATCH_COUNT),
  expectedBatchChainHash: sha256Schema,
}).strict();

export const productionStatusRequestSchema = z.object({
  schemaVersion: z.literal(DATA_RELEASE_SCHEMA_VERSION),
  operationId: operationIdSchema,
  publicationId: publicReleaseIdSchema.nullable(),
}).strict();

export const productionRefreshRequestSchema = z.object({
  ...operationEnvelopeSchema,
  publicReleaseId: publicReleaseIdSchema,
  contentHash: sha256Schema,
  observationSequence: z.number().int().safe().positive(),
  dataAsOf: timestampSchema,
  lastSuccessfulObservationAt: timestampSchema,
  staleAt: timestampSchema,
  freshness: z.enum(["fresh", "delayed"]),
  delayedVendorCount: nonNegativeSafeIntegerSchema.max(128),
}).strict();

export const productionRollbackRequestSchema = z.object({
  ...operationEnvelopeSchema,
  expectedActivePublicReleaseId: publicReleaseIdSchema,
  targetPublicReleaseId: publicReleaseIdSchema.nullable(),
  clearAuthorization: z.literal("clear_catalog_v1").nullable(),
}).strict().refine(
  ({ targetPublicReleaseId, clearAuthorization }) =>
    (targetPublicReleaseId === null) === (clearAuthorization === "clear_catalog_v1"),
  { message: "publication.rollback_authorization_invalid" },
);

export const productionRetainRequestSchema = z.object(operationEnvelopeSchema).strict();

const PROTECTED_PUBLICATION_FIELDS = new Set([
  "actorId", "collectibleId", "credential", "credentials", "internalRunId",
  "organizationId", "providerId", "providerPayload", "quarantine", "rawPayload",
  "releaseId", "repackId", "secret", "tenantId", "vendorId",
]);

export function containsProtectedPublicationField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProtectedPublicationField);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, nested]) =>
    PROTECTED_PUBLICATION_FIELDS.has(key) || containsProtectedPublicationField(nested));
}

export function productionManifestFingerprintBody(
  manifest: ProductionStartManifest,
): unknown {
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
  manifest: ProductionStartManifest,
): Promise<string> {
  return sha256CanonicalJson(
    PRODUCTION_MANIFEST_HASH_DOMAIN,
    productionManifestFingerprintBody(manifest),
  );
}

export function recomputeProductionOriginSetHash(
  origins: readonly string[],
): Promise<string> {
  return sha256CanonicalJson(PRODUCTION_ORIGIN_SET_HASH_DOMAIN, origins);
}

export function recomputeProductionBatchHash(
  batch: Readonly<{
    kind: ProductionBatchKind;
    records: readonly unknown[];
  }>,
): Promise<string> {
  return sha256CanonicalJson(DATA_RELEASE_BATCH_HASH_DOMAIN, {
    kind: batch.kind,
    records: batch.records,
  });
}

export function productionBatchByteCount(records: readonly unknown[]): number {
  return canonicalJsonByteCount(records);
}

export function extendProductionBatchChain(input: {
  previousHash: string;
  batchIndex: number;
  kind: ProductionBatchKind;
  batchHash: string;
  recordCount: number;
  byteCount: number;
}): Promise<string> {
  return sha256CanonicalJson(PRODUCTION_BATCH_CHAIN_HASH_DOMAIN, input);
}

export function productionReceiptHash(value: unknown): Promise<string> {
  return sha256CanonicalJson(PRODUCTION_RECEIPT_HASH_DOMAIN, value);
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

export { EMPTY_BATCH_CHAIN_HASH };
