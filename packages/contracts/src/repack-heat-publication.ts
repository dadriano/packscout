import { z } from "zod";
import {
  EMPTY_BATCH_CHAIN_HASH,
  canonicalJson,
  canonicalJsonByteCount,
  sha256CanonicalJson,
} from "./data-release-v2-canonical.ts";
import {
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import {
  MAX_PRODUCTION_BATCH_BYTES,
  MAX_PRODUCTION_BATCH_COUNT,
  MAX_PRODUCTION_BATCH_RECORDS,
} from "./data-release-v2-publication.ts";
import {
  REPACK_HEAT_AGGREGATION_VERSION,
  REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS,
  REPACK_HEAT_POLICY_VERSION,
  parseRepackHeatTimestampMillis,
  publicRepackHeatSignalSchema,
  type PublicRepackHeatSignal,
} from "./repack-heat.ts";

export const REPACK_HEAT_PUBLICATION_SCHEMA_VERSION =
  "repack_heat_publication_v1" as const;
export const PRODUCTION_HEAT_FRAME_TTL_MILLISECONDS = 15 * 60 * 1_000;
export const PRODUCTION_HEAT_CURRENT_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
export const PRODUCTION_HEAT_BASELINE_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const PRODUCTION_HEAT_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_PRODUCTION_HEAT_BATCH_RECORDS = MAX_PRODUCTION_BATCH_RECORDS;
export const MAX_PRODUCTION_HEAT_BATCH_BYTES = MAX_PRODUCTION_BATCH_BYTES;
export const MAX_PRODUCTION_HEAT_BATCH_COUNT = MAX_PRODUCTION_BATCH_COUNT;
export const EMPTY_PRODUCTION_HEAT_SIGNAL_SET_HASH = EMPTY_BATCH_CHAIN_HASH;

export const PRODUCTION_REPACK_HEAT_PATHS = Object.freeze({
  activeState: "/internal/repack-heat/v1/active-state",
  start: "/internal/repack-heat/v1/start",
  applyBatch: "/internal/repack-heat/v1/apply-batch",
  finalize: "/internal/repack-heat/v1/finalize",
  status: "/internal/repack-heat/v1/status",
  refreshFrame: "/internal/repack-heat/v1/refresh-frame",
  retain: "/internal/repack-heat/v1/retain",
});

export const PRODUCTION_HEAT_BATCH_HASH_DOMAIN =
  "packscout.repack-heat.batch.v1" as const;
export const PRODUCTION_HEAT_SIGNAL_SET_HASH_DOMAIN =
  "packscout.repack-heat.signal-set.v1" as const;
export const PRODUCTION_HEAT_FRAME_HASH_DOMAIN =
  "packscout.repack-heat.frame.v1" as const;
export const PRODUCTION_HEAT_RECEIPT_HASH_DOMAIN =
  "packscout.repack-heat.receipt.v1" as const;

const operationIdSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const publicIdSchema = z.uuid();
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const sourceWatermarkSchema = z.string()
  .regex(/^[1-9][0-9]{0,18}$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: "repack_heat_publication.source_watermark_invalid",
  });

const operationEnvelopeShape = {
  schemaVersion: z.literal(REPACK_HEAT_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
} as const;

export const productionHeatActiveStateRequestSchema = z.object({
  schemaVersion: z.literal(REPACK_HEAT_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
}).strict();

export const productionHeatFrameEnvelopeSchema = z.object({
  publicHeatFrameId: publicIdSchema,
  catalogPublicReleaseId: publicIdSchema,
  frameSequence: z.number().int().safe().positive(),
  sourceWatermark: sourceWatermarkSchema,
  signalSetHash: sha256Schema,
  frameHash: sha256Schema,
  signalCount: nonNegativeSafeIntegerSchema.max(MAX_PUBLIC_REPACKS_PER_RELEASE),
  aggregationVersion: z.literal(REPACK_HEAT_AGGREGATION_VERSION),
  heatPolicyVersion: z.literal(REPACK_HEAT_POLICY_VERSION),
  baselineWindowStartedAt: timestampSchema,
  baselineWindowEndedAt: timestampSchema,
  currentWindowStartedAt: timestampSchema,
  currentWindowEndedAt: timestampSchema,
  calculatedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict().superRefine((frame, context) => {
  const baselineStart = parseRepackHeatTimestampMillis(
    frame.baselineWindowStartedAt,
  )!;
  const baselineEnd = parseRepackHeatTimestampMillis(frame.baselineWindowEndedAt)!;
  const currentStart = parseRepackHeatTimestampMillis(
    frame.currentWindowStartedAt,
  )!;
  const currentEnd = parseRepackHeatTimestampMillis(frame.currentWindowEndedAt)!;
  const calculatedAt = parseRepackHeatTimestampMillis(frame.calculatedAt)!;
  const expiresAt = parseRepackHeatTimestampMillis(frame.expiresAt)!;
  if (
    baselineEnd - baselineStart !== PRODUCTION_HEAT_BASELINE_WINDOW_MILLISECONDS ||
    currentEnd - currentStart !== PRODUCTION_HEAT_CURRENT_WINDOW_MILLISECONDS ||
    baselineEnd !== currentStart ||
    currentEnd % 60_000 !== 0 ||
    frame.frameSequence !== currentEnd / 60_000 ||
    calculatedAt < currentEnd ||
    calculatedAt - currentEnd >
      REPACK_HEAT_MAXIMUM_CALCULATION_LAG_MILLISECONDS ||
    expiresAt - calculatedAt !== PRODUCTION_HEAT_FRAME_TTL_MILLISECONDS
  ) {
    context.addIssue({
      code: "custom",
      path: ["currentWindowEndedAt"],
      message: "repack_heat_publication.timeline_invalid",
    });
  }
});

export type ProductionHeatFrameEnvelope = z.infer<
  typeof productionHeatFrameEnvelopeSchema
>;

export const productionHeatStartRequestSchema = z.object({
  ...operationEnvelopeShape,
  publicationId: publicIdSchema,
  frame: productionHeatFrameEnvelopeSchema,
  expectedBatchCount: nonNegativeSafeIntegerSchema.max(
    MAX_PRODUCTION_HEAT_BATCH_COUNT,
  ),
}).strict().refine(
  ({ publicationId, frame }) => publicationId === frame.publicHeatFrameId,
  { path: ["publicationId"], message: "repack_heat_publication.identity_mismatch" },
);

export const productionHeatApplyBatchRequestSchema = z.object({
  ...operationEnvelopeShape,
  publicationId: publicIdSchema,
  batchIndex: nonNegativeSafeIntegerSchema.max(
    MAX_PRODUCTION_HEAT_BATCH_COUNT - 1,
  ),
  batchHash: sha256Schema,
  records: z.array(publicRepackHeatSignalSchema)
    .min(1)
    .max(MAX_PRODUCTION_HEAT_BATCH_RECORDS),
}).strict().superRefine((request, context) => {
  if (request.records.some((signal) => signal.provenance.kind !== "observed")) {
    context.addIssue({
      code: "custom",
      path: ["records"],
      message: "repack_heat_publication.observed_signals_required",
    });
  }
});

export const productionHeatFinalizeRequestSchema = z.object({
  ...operationEnvelopeShape,
  publicationId: publicIdSchema,
  expectedActivePublicHeatFrameId: publicIdSchema.nullable(),
  expectedCatalogPublicReleaseId: publicIdSchema,
  expectedSignalSetHash: sha256Schema,
  expectedFrameHash: sha256Schema,
  expectedSignalCount: nonNegativeSafeIntegerSchema.max(
    MAX_PUBLIC_REPACKS_PER_RELEASE,
  ),
  expectedBatchCount: nonNegativeSafeIntegerSchema.max(
    MAX_PRODUCTION_HEAT_BATCH_COUNT,
  ),
}).strict();

export const productionHeatStatusRequestSchema = z.object({
  schemaVersion: z.literal(REPACK_HEAT_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
  publicationId: publicIdSchema.nullable(),
}).strict();

export const productionHeatRefreshFrameRequestSchema = z.object({
  ...operationEnvelopeShape,
  publicationId: publicIdSchema,
  expectedActivePublicHeatFrameId: publicIdSchema,
  frame: productionHeatFrameEnvelopeSchema,
}).strict().refine(
  ({ publicationId, frame }) => publicationId === frame.publicHeatFrameId,
  { path: ["publicationId"], message: "repack_heat_publication.identity_mismatch" },
);

export const productionHeatRetainRequestSchema = z.object(
  operationEnvelopeShape,
).strict();

export type ProductionHeatStartRequest = z.infer<
  typeof productionHeatStartRequestSchema
>;
export type ProductionHeatActiveStateRequest = z.infer<
  typeof productionHeatActiveStateRequestSchema
>;
export type ProductionHeatApplyBatchRequest = z.infer<
  typeof productionHeatApplyBatchRequestSchema
>;
export type ProductionHeatFinalizeRequest = z.infer<
  typeof productionHeatFinalizeRequestSchema
>;
export type ProductionHeatStatusRequest = z.infer<
  typeof productionHeatStatusRequestSchema
>;
export type ProductionHeatRefreshFrameRequest = z.infer<
  typeof productionHeatRefreshFrameRequestSchema
>;
export type ProductionHeatRetainRequest = z.infer<
  typeof productionHeatRetainRequestSchema
>;

export type RepackHeatSignalCore = Readonly<
  Omit<
    PublicRepackHeatSignal,
    "baselineWindow" | "currentWindow" | "calculatedAt" | "expiresAt"
  > & {
    baselinePullCount: number;
    currentPullCount: number;
  }
>;

export type RepackHeatSignalTimeline = Readonly<{
  baselineWindowStartedAt: string;
  baselineWindowEndedAt: string;
  currentWindowStartedAt: string;
  currentWindowEndedAt: string;
  calculatedAt: string;
  expiresAt: string;
}>;

export function repackHeatSignalCore(
  signal: PublicRepackHeatSignal,
): RepackHeatSignalCore {
  const {
    baselineWindow,
    currentWindow,
    calculatedAt: _calculatedAt,
    expiresAt: _expiresAt,
    ...content
  } = signal;
  void _calculatedAt;
  void _expiresAt;
  return {
    ...content,
    baselinePullCount: baselineWindow.pullCount,
    currentPullCount: currentWindow.pullCount,
  };
}

export function hydrateRepackHeatSignal(
  core: RepackHeatSignalCore,
  frame: RepackHeatSignalTimeline,
): PublicRepackHeatSignal {
  const { baselinePullCount, currentPullCount, ...content } = core;
  return publicRepackHeatSignalSchema.parse({
    ...content,
    baselineWindow: {
      startedAt: frame.baselineWindowStartedAt,
      endedAt: frame.baselineWindowEndedAt,
      pullCount: baselinePullCount,
    },
    currentWindow: {
      startedAt: frame.currentWindowStartedAt,
      endedAt: frame.currentWindowEndedAt,
      pullCount: currentPullCount,
    },
    calculatedAt: frame.calculatedAt,
    expiresAt: frame.expiresAt,
  });
}

export function productionHeatFrameHashBody(
  frame: ProductionHeatFrameEnvelope,
): unknown {
  const { frameHash: _frameHash, ...body } = frame;
  void _frameHash;
  return body;
}

export function recomputeProductionHeatFrameHash(
  frame: ProductionHeatFrameEnvelope,
): Promise<string> {
  return sha256CanonicalJson(
    PRODUCTION_HEAT_FRAME_HASH_DOMAIN,
    productionHeatFrameHashBody(frame),
  );
}

export function recomputeProductionHeatBatchHash(
  records: readonly PublicRepackHeatSignal[],
): Promise<string> {
  return sha256CanonicalJson(
    PRODUCTION_HEAT_BATCH_HASH_DOMAIN,
    records.map(repackHeatSignalCore),
  );
}

export function productionHeatCoreByteCount(
  records: readonly PublicRepackHeatSignal[],
): number {
  return canonicalJsonByteCount(records.map(repackHeatSignalCore));
}

export function productionHeatBatchByteCount(
  records: readonly PublicRepackHeatSignal[],
): number {
  return canonicalJsonByteCount(records);
}

export function extendProductionHeatSignalSetHash(input: Readonly<{
  previousHash: string;
  batchIndex: number;
  batchHash: string;
  recordCount: number;
  coreByteCount: number;
}>): Promise<string> {
  return sha256CanonicalJson(PRODUCTION_HEAT_SIGNAL_SET_HASH_DOMAIN, input);
}

export function productionHeatReceiptHash(value: unknown): Promise<string> {
  return sha256CanonicalJson(PRODUCTION_HEAT_RECEIPT_HASH_DOMAIN, value);
}

export async function productionHeatTerminalReceiptSha256(
  receipt: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(receipt)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
