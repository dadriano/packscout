import { z } from "zod";
import {
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  productionAuthKeyIdSchema,
} from "./data-release-v2-publication-auth.ts";
import {
  productionReleaseCountsSchema,
} from "./data-release-v2-publication.ts";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";

const operationIdSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const publicReleaseIdSchema = z.uuid();
const sourceWatermarkSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const productionBatchKindSchema = z.enum([
  "vendors", "categories", "collectibles", "repacks",
  "repack_chases", "search_shards",
]);
export const productionOperationKindSchema = z.enum([
  "start", "applyBatch", "finalize",
  "refreshObservation", "rollback", "retain",
]);

const receiptBaseShape = {
  schemaVersion: z.literal(DATA_RELEASE_SCHEMA_VERSION),
  operationId: operationIdSchema,
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  receiptDigest: sha256Schema,
} as const;

export const productionStartReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("start"),
  publicationId: publicReleaseIdSchema,
  terminalState: z.literal("staging"),
  result: z.literal("created"),
  details: z.object({
    sourceWatermark: sourceWatermarkSchema,
    manifestFingerprint: sha256Schema,
    contentHash: sha256Schema,
    expectedBatchCount: nonNegativeSafeIntegerSchema,
    expectedBatchChainHash: sha256Schema,
    expectedCounts: productionReleaseCountsSchema,
  }).strict(),
}).strict();

export const productionBatchReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("applyBatch"),
  publicationId: publicReleaseIdSchema,
  terminalState: z.literal("staging"),
  result: z.literal("accepted"),
  details: z.object({
    batchIndex: nonNegativeSafeIntegerSchema,
    kind: productionBatchKindSchema,
    batchHash: sha256Schema,
    recordCount: nonNegativeSafeIntegerSchema,
    byteCount: nonNegativeSafeIntegerSchema,
    chainHash: sha256Schema,
    acceptedCounts: productionReleaseCountsSchema,
  }).strict(),
}).strict();

export const productionFinalizeReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("finalize"),
  publicationId: publicReleaseIdSchema,
  terminalState: z.literal("complete"),
  result: z.literal("activated"),
  details: z.object({
    manifestFingerprint: sha256Schema,
    contentHash: sha256Schema,
    sourceWatermark: sourceWatermarkSchema,
    activePublicReleaseId: publicReleaseIdSchema,
    previousPublicReleaseId: publicReleaseIdSchema.nullable(),
    counts: productionReleaseCountsSchema,
    batchCount: nonNegativeSafeIntegerSchema,
    batchChainHash: sha256Schema,
  }).strict(),
}).strict();

export const productionRefreshReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("refreshObservation"),
  publicationId: publicReleaseIdSchema,
  terminalState: z.literal("complete"),
  result: z.literal("refreshed"),
  details: z.object({
    contentHash: sha256Schema,
    observationSequence: z.number().int().safe().positive(),
    dataAsOf: timestampSchema,
    lastSuccessfulObservationAt: timestampSchema,
    staleAt: timestampSchema,
    freshness: z.enum(["fresh", "delayed"]),
    delayedVendorCount: nonNegativeSafeIntegerSchema.max(128),
  }).strict(),
}).strict();

export const productionRollbackClearedReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("rollback"),
  publicationId: publicReleaseIdSchema,
  terminalState: z.literal("cleared"),
  result: z.literal("cleared"),
  details: z.object({
    outgoingPublicReleaseId: publicReleaseIdSchema,
    activePublicReleaseId: z.null(),
    previousPublicReleaseId: z.null(),
  }).strict(),
}).strict();

export const productionRollbackReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("rollback"),
  publicationId: publicReleaseIdSchema,
  terminalState: z.literal("complete"),
  result: z.literal("rolled_back"),
  details: z.object({
    outgoingPublicReleaseId: publicReleaseIdSchema,
    activePublicReleaseId: publicReleaseIdSchema,
    previousPublicReleaseId: publicReleaseIdSchema.nullable(),
    outgoingFingerprintBlocked: z.boolean(),
  }).strict(),
}).strict();

const retainedDetailsShape = {
  deletedPublicReleaseId: publicReleaseIdSchema,
  deletedDocumentCount: nonNegativeSafeIntegerSchema,
  maximumDocumentsPerMutation: z.literal(100),
} as const;

export const productionRetainedReceiptSchema = z.union([
  z.object({
    ...receiptBaseShape,
    operationKind: z.literal("retain"),
    publicationId: z.null(),
    terminalState: z.literal("complete"),
    result: z.literal("retained"),
    details: z.object({
      ...retainedDetailsShape,
      hasMore: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    ...receiptBaseShape,
    operationKind: z.literal("retain"),
    publicationId: z.null(),
    terminalState: z.literal("continuation_required"),
    result: z.literal("retained"),
    details: z.object({
      ...retainedDetailsShape,
      hasMore: z.literal(true),
    }).strict(),
  }).strict(),
]);

export const productionNonceCleanupReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("retain"),
  publicationId: z.null(),
  terminalState: z.literal("complete"),
  result: z.literal("nonce_cleanup"),
  details: z.object({
    deletedPublicReleaseId: z.null(),
    deletedDocumentCount: nonNegativeSafeIntegerSchema,
    hasMore: z.literal(false),
    maximumDocumentsPerMutation: z.literal(100),
  }).strict(),
}).strict();

export const productionReceiptSchema = z.union([
  productionStartReceiptSchema,
  productionBatchReceiptSchema,
  productionFinalizeReceiptSchema,
  productionRefreshReceiptSchema,
  productionRollbackClearedReceiptSchema,
  productionRollbackReceiptSchema,
  productionRetainedReceiptSchema,
  productionNonceCleanupReceiptSchema,
]);

export const productionStatusNotFoundReceiptSchema = z.object({
  schemaVersion: z.literal(DATA_RELEASE_SCHEMA_VERSION),
  operationId: operationIdSchema,
  publicationId: publicReleaseIdSchema.nullable(),
  terminalState: z.literal("not_found"),
  result: z.literal("not_found"),
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  details: z.object({}).strict(),
  receiptDigest: z.null(),
}).strict();

export const productionSignedReceiptEnvelopeSchema = z.object({
  ok: z.literal(true),
  receipt: z.union([
    productionReceiptSchema,
    productionStatusNotFoundReceiptSchema,
  ]),
  responseAuth: z.object({
    signatureVersion: z.literal(PRODUCTION_AUTH_SIGNATURE_VERSION),
    keyId: productionAuthKeyIdSchema,
    receiptDigest: sha256Schema,
    signature: sha256Schema,
  }).strict(),
}).strict();

export type ProductionOperationKind = z.infer<
  typeof productionOperationKindSchema
>;
export type ProductionReceipt = z.infer<typeof productionReceiptSchema>;
export type ProductionStatusNotFoundReceipt = z.infer<
  typeof productionStatusNotFoundReceiptSchema
>;
export type ProductionSignedReceiptEnvelope = z.infer<
  typeof productionSignedReceiptEnvelopeSchema
>;
