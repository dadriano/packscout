import { z } from "zod";
import {
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  productionAuthKeyIdSchema,
} from "./data-release-v2-publication-auth.ts";
import { sha256Schema, timestampSchema } from "./data-release-v2-values.ts";
import {
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  productionHeatManifestAlignmentSchema,
} from "./repack-heat-publication.ts";

const operationIdSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const publicIdSchema = z.uuid();
const sourceWatermarkSchema = z.string().regex(/^[1-9][0-9]{0,18}$/u);
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);

export const productionHeatOperationKindSchema = z.enum([
  "activeState", "start", "applyBatch", "finalize", "refreshFrame", "retain",
]);

const receiptBaseShape = {
  schemaVersion: z.literal(REPACK_HEAT_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  receiptDigest: sha256Schema,
} as const;

export const productionHeatActiveStateReceiptSchema = z.union([
  z.object({
    ...receiptBaseShape,
    operationKind: z.literal("activeState"),
    publicationId: z.null(),
    terminalState: z.literal("observed"),
    result: z.literal("active_state"),
    details: z.object({
      activePublicHeatFrameId: z.null(),
      manifestAlignment: z.null(),
      sourceWatermark: z.null(),
      frameSequence: z.literal(0),
      terminalReceiptSha256: z.null(),
    }).strict(),
  }).strict(),
  z.object({
    ...receiptBaseShape,
    operationKind: z.literal("activeState"),
    publicationId: publicIdSchema,
    terminalState: z.literal("observed"),
    result: z.literal("active_state"),
    details: z.object({
      activePublicHeatFrameId: publicIdSchema,
      manifestAlignment: productionHeatManifestAlignmentSchema,
      sourceWatermark: sourceWatermarkSchema,
      frameSequence: z.number().int().safe().positive(),
      terminalReceiptSha256: sha256Schema,
    }).strict(),
  }).strict().refine(
    ({ publicationId, details }) =>
      publicationId === details.activePublicHeatFrameId,
    {
      path: ["publicationId"],
      message: "repack_heat_publication.identity_mismatch",
    },
  ),
]);

export const productionHeatStartReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("start"),
  publicationId: publicIdSchema,
  terminalState: z.literal("staging"),
  result: z.literal("created"),
  details: z.object({
    manifestAlignment: productionHeatManifestAlignmentSchema,
    frameHash: sha256Schema,
    signalSetHash: sha256Schema,
    sourceWatermark: sourceWatermarkSchema,
    frameSequence: z.number().int().safe().positive(),
    expectedSignalCount: nonNegativeSafeIntegerSchema,
    expectedBatchCount: nonNegativeSafeIntegerSchema,
  }).strict(),
}).strict();

export const productionHeatBatchReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("applyBatch"),
  publicationId: publicIdSchema,
  terminalState: z.literal("staging"),
  result: z.literal("accepted"),
  details: z.object({
    batchIndex: nonNegativeSafeIntegerSchema,
    batchHash: sha256Schema,
    recordCount: nonNegativeSafeIntegerSchema,
    byteCount: nonNegativeSafeIntegerSchema,
    coreByteCount: nonNegativeSafeIntegerSchema,
    acceptedSignalCount: nonNegativeSafeIntegerSchema,
    signalSetProgressHash: sha256Schema,
  }).strict(),
}).strict();

const activatedDetailsSchema = z.object({
  manifestAlignment: productionHeatManifestAlignmentSchema,
  activePublicHeatFrameId: publicIdSchema,
  previousPublicHeatFrameId: publicIdSchema.nullable(),
  frameHash: sha256Schema,
  signalSetHash: sha256Schema,
  sourceWatermark: sourceWatermarkSchema,
  frameSequence: z.number().int().safe().positive(),
  signalCount: nonNegativeSafeIntegerSchema,
  calculatedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict();

export const productionHeatFinalizeReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("finalize"),
  publicationId: publicIdSchema,
  terminalState: z.literal("complete"),
  result: z.literal("activated"),
  details: activatedDetailsSchema,
}).strict().refine(
  ({ publicationId, details }) =>
    publicationId === details.activePublicHeatFrameId,
  {
    path: ["publicationId"],
    message: "repack_heat_publication.identity_mismatch",
  },
);

export const productionHeatRefreshFrameReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("refreshFrame"),
  publicationId: publicIdSchema,
  terminalState: z.literal("complete"),
  result: z.literal("refreshed"),
  details: activatedDetailsSchema,
}).strict().refine(
  ({ publicationId, details }) =>
    publicationId === details.activePublicHeatFrameId,
  {
    path: ["publicationId"],
    message: "repack_heat_publication.identity_mismatch",
  },
);

export const productionHeatRetainReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("retain"),
  publicationId: z.null(),
  terminalState: z.union([
    z.literal("complete"),
    z.literal("continuation_required"),
  ]),
  result: z.literal("retained"),
  details: z.object({
    deletedFrameCount: nonNegativeSafeIntegerSchema,
    deletedSignalCount: nonNegativeSafeIntegerSchema,
    deletedSignalSetCount: nonNegativeSafeIntegerSchema,
    deletedOperationCount: nonNegativeSafeIntegerSchema,
    deletedMetadataCount: nonNegativeSafeIntegerSchema,
    hasMore: z.boolean(),
    maximumDocumentsPerMutation: z.literal(100),
  }).strict(),
}).strict();

export const productionHeatReceiptSchema = z.union([
  productionHeatActiveStateReceiptSchema,
  productionHeatStartReceiptSchema,
  productionHeatBatchReceiptSchema,
  productionHeatFinalizeReceiptSchema,
  productionHeatRefreshFrameReceiptSchema,
  productionHeatRetainReceiptSchema,
]);

export const productionHeatStatusNotFoundReceiptSchema = z.object({
  schemaVersion: z.literal(REPACK_HEAT_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
  publicationId: publicIdSchema.nullable(),
  terminalState: z.literal("not_found"),
  result: z.literal("not_found"),
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  details: z.object({}).strict(),
  receiptDigest: z.null(),
}).strict();

export const productionHeatSignedReceiptEnvelopeSchema = z.object({
  ok: z.literal(true),
  receipt: z.union([
    productionHeatReceiptSchema,
    productionHeatStatusNotFoundReceiptSchema,
  ]),
  responseAuth: z.object({
    signatureVersion: z.literal(PRODUCTION_AUTH_SIGNATURE_VERSION),
    keyId: productionAuthKeyIdSchema,
    receiptDigest: sha256Schema,
    signature: sha256Schema,
  }).strict(),
}).strict();

export type ProductionHeatOperationKind = z.infer<
  typeof productionHeatOperationKindSchema
>;
export type ProductionHeatActiveStateReceipt = z.infer<
  typeof productionHeatActiveStateReceiptSchema
>;
export type ProductionHeatReceipt = z.infer<typeof productionHeatReceiptSchema>;
export type ProductionHeatStatusNotFoundReceipt = z.infer<
  typeof productionHeatStatusNotFoundReceiptSchema
>;
export type ProductionHeatSignedReceiptEnvelope = z.infer<
  typeof productionHeatSignedReceiptEnvelopeSchema
>;
