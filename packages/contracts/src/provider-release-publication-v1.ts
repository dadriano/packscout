import { z } from "zod";
import {
  canonicalJson,
} from "./data-release-v2-canonical.ts";
import {
  sha256Schema,
} from "./data-release-v2-values.ts";
import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  MAX_PROVIDER_CATALOG_RELEASE_HTTP_BODY_BYTES,
  PROVIDER_CATALOG_RELEASE_BLOCK_REASONS,
  buildProviderCatalogSourceWatermarkV1,
  containsProtectedProviderCatalogReleaseField,
  providerCatalogCompletedReleaseProofV1Schema,
  providerCatalogPlatformKeyV1Schema,
  providerCatalogReleaseBatchByteCount,
  providerCatalogReleaseBatchV1Schema,
  providerCatalogReleaseCheckpointV1Schema,
  providerCatalogReleaseObservationV1Schema,
  providerCatalogSequenceV1Schema,
  providerCatalogSharedConfigurationEpochV1Schema,
  publicProviderReleaseIdV1Schema,
} from "./provider-catalog-release-v1.ts";

export const PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION =
  "provider_release_publication_v1" as const;
export const MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS = 100;
export const MAX_PROVIDER_RELEASE_BLOCK_REASON_LENGTH = 128;
export const MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES =
  MAX_PROVIDER_CATALOG_RELEASE_HTTP_BODY_BYTES;

export const PRODUCTION_PROVIDER_RELEASE_PATHS = Object.freeze({
  completedHead: "/internal/provider-release/v1/completed-head",
  start: "/internal/provider-release/v1/start",
  applyBatch: "/internal/provider-release/v1/apply-batch",
  finalize: "/internal/provider-release/v1/finalize",
  status: "/internal/provider-release/v1/status",
  confirmReuse: "/internal/provider-release/v1/confirm-reuse",
  block: "/internal/provider-release/v1/block",
  cleanup: "/internal/provider-release/v1/cleanup",
});

const operationIdSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const positiveSafeIntegerSchema = z.number().int().safe().positive();

export const providerReleaseOperationIdSchema = operationIdSchema;
export const providerReleaseIdempotencyKeySchema = idempotencyKeySchema;

export const providerReleaseImmutableProofV1Schema =
  providerCatalogCompletedReleaseProofV1Schema.omit({ state: true });

const emptyCheckpointSchema = z.object({
  settledSequence: z.literal("0"),
  settledAt: z.null(),
}).strict();

const completedCheckpointSchema = providerCatalogReleaseCheckpointV1Schema
  .refine(({ settledSequence }) => settledSequence !== "0", {
    path: ["settledSequence"],
    message: "provider_release_publication.completed_checkpoint_required",
  });

const nonemptyExpectedCompletedHeadV1Schema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  sharedConfigurationEpoch:
    providerCatalogSharedConfigurationEpochV1Schema,
  providerCheckpoint: completedCheckpointSchema,
  observation: providerCatalogReleaseObservationV1Schema,
  terminalReceiptSha256: sha256Schema,
}).strict().superRefine((head, context) => {
  if (
    head.observation.sourceHeadSequence !==
      head.providerCheckpoint.settledSequence
  ) {
    context.addIssue({
      code: "custom",
      path: ["observation", "sourceHeadSequence"],
      message: "provider_release_publication.predecessor_observation_mismatch",
    });
  }
  const settledAt = head.providerCheckpoint.settledAt;
  if (
    settledAt === null ||
    BigInt(head.sharedConfigurationEpoch.publicChangeSequence) >
      BigInt(head.providerCheckpoint.settledSequence) ||
    Date.parse(head.observation.lastSuccessfulObservationAt) >
      Date.parse(settledAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint"],
      message: "provider_release_publication.predecessor_context_invalid",
    });
  }
});

export const providerReleaseExpectedCompletedHeadV1Schema = z.union([
  z.object({
    platformKey: providerCatalogPlatformKeyV1Schema,
    publicProviderReleaseId: z.null(),
    sharedConfigurationEpoch: z.null(),
    providerCheckpoint: emptyCheckpointSchema,
    observation: z.null(),
    terminalReceiptSha256: z.null(),
  }).strict(),
  nonemptyExpectedCompletedHeadV1Schema,
]);

export const providerReleaseCompletedHeadV1Schema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  release: providerReleaseImmutableProofV1Schema,
  providerCheckpoint: completedCheckpointSchema,
  observation: providerCatalogReleaseObservationV1Schema,
  terminalReceiptSha256: sha256Schema,
}).strict().superRefine((head, context) => {
  validateReleaseContext(head, context);
});

export const providerReleaseCompletedHeadStateV1Schema = z.union([
  z.object({
    platformKey: providerCatalogPlatformKeyV1Schema,
    release: z.null(),
    providerCheckpoint: emptyCheckpointSchema,
    observation: z.null(),
    terminalReceiptSha256: z.null(),
  }).strict(),
  providerReleaseCompletedHeadV1Schema,
]);

const operationEnvelopeShape = {
  schemaVersion: z.literal(PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
} as const;

const releaseContextShape = {
  release: providerReleaseImmutableProofV1Schema,
  providerCheckpoint: completedCheckpointSchema,
  sourceWatermark: z.string().min(1).max(256),
  observation: providerCatalogReleaseObservationV1Schema,
  expectedCompletedHead: providerReleaseExpectedCompletedHeadV1Schema,
} as const;

type ReleaseContext = Readonly<{
  release: z.infer<typeof providerReleaseImmutableProofV1Schema>;
  providerCheckpoint: z.infer<typeof completedCheckpointSchema>;
  sourceWatermark?: string;
  observation: z.infer<typeof providerCatalogReleaseObservationV1Schema>;
  expectedCompletedHead?: z.infer<
    typeof providerReleaseExpectedCompletedHeadV1Schema
  >;
}>;

function sameEpoch(
  left: z.infer<typeof providerCatalogSharedConfigurationEpochV1Schema>,
  right: z.infer<typeof providerCatalogSharedConfigurationEpochV1Schema>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateReleaseContext(
  value: ReleaseContext & { platformKey?: string },
  context: z.RefinementCtx,
): void {
  const platformKey = value.platformKey ?? value.release.platformKey;
  if (platformKey !== value.release.platformKey) {
    context.addIssue({
      code: "custom",
      path: ["platformKey"],
      message: "provider_release_publication.platform_mismatch",
    });
  }
  if (
    value.sourceWatermark !== undefined &&
    value.sourceWatermark !== buildProviderCatalogSourceWatermarkV1(
      value.release.platformKey,
      value.providerCheckpoint.settledSequence,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["sourceWatermark"],
      message: "provider_release_publication.source_watermark_mismatch",
    });
  }
  if (
    value.observation.sourceHeadSequence !==
      value.providerCheckpoint.settledSequence
  ) {
    context.addIssue({
      code: "custom",
      path: ["observation", "sourceHeadSequence"],
      message: "provider_release_publication.observation_checkpoint_mismatch",
    });
  }
  if (
    BigInt(value.release.sharedConfigurationEpoch.publicChangeSequence) >
      BigInt(value.providerCheckpoint.settledSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["release", "sharedConfigurationEpoch", "publicChangeSequence"],
      message: "provider_release_publication.epoch_after_checkpoint",
    });
  }
  const checkpointSettledAt = value.providerCheckpoint.settledAt;
  if (
    checkpointSettledAt !== null &&
    Date.parse(value.release.dataAsOf) > Date.parse(checkpointSettledAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["release", "dataAsOf"],
      message: "provider_release_publication.data_after_checkpoint",
    });
  }
  if (
    checkpointSettledAt !== null &&
    Date.parse(value.observation.lastSuccessfulObservationAt) >
      Date.parse(checkpointSettledAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["observation", "lastSuccessfulObservationAt"],
      message: "provider_release_publication.observation_after_checkpoint",
    });
  }
  if (
    Date.parse(value.release.dataAsOf) >
      Date.parse(value.observation.lastSuccessfulObservationAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["release", "dataAsOf"],
      message: "provider_release_publication.data_after_observation",
    });
  }
  if (
    value.expectedCompletedHead !== undefined &&
    value.expectedCompletedHead.platformKey !== value.release.platformKey
  ) {
    context.addIssue({
      code: "custom",
      path: ["expectedCompletedHead", "platformKey"],
      message: "provider_release_publication.predecessor_platform_mismatch",
    });
  }
}

function validateAdvancingRelease(
  value: ReleaseContext,
  context: z.RefinementCtx,
): void {
  validateReleaseContext(value, context);
  const predecessor = value.expectedCompletedHead;
  if (predecessor === undefined || predecessor.publicProviderReleaseId === null) {
    return;
  }
  if (
    BigInt(value.providerCheckpoint.settledSequence) <=
      BigInt(predecessor.providerCheckpoint.settledSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint", "settledSequence"],
      message: "provider_release_publication.checkpoint_not_advanced",
    });
  }
  if (
    value.release.publicProviderReleaseId ===
      predecessor.publicProviderReleaseId
  ) {
    context.addIssue({
      code: "custom",
      path: ["release", "publicProviderReleaseId"],
      message: "provider_release_publication.new_release_required",
    });
  }
  if (
    !sameEpoch(
      value.release.sharedConfigurationEpoch,
      predecessor.sharedConfigurationEpoch,
    ) &&
    BigInt(value.release.sharedConfigurationEpoch.publicChangeSequence) <=
      BigInt(predecessor.sharedConfigurationEpoch.publicChangeSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["release", "sharedConfigurationEpoch", "publicChangeSequence"],
      message: "provider_release_publication.epoch_not_advanced",
    });
  }
}

function validateReuse(
  value: ReleaseContext,
  context: z.RefinementCtx,
): void {
  validateReleaseContext(value, context);
  const predecessor = value.expectedCompletedHead;
  if (predecessor === undefined || predecessor.publicProviderReleaseId === null) {
    context.addIssue({
      code: "custom",
      path: ["expectedCompletedHead"],
      message: "provider_release_publication.reuse_predecessor_required",
    });
    return;
  }
  if (
    value.release.publicProviderReleaseId !==
      predecessor.publicProviderReleaseId
  ) {
    context.addIssue({
      code: "custom",
      path: ["release", "publicProviderReleaseId"],
      message: "provider_release_publication.reuse_release_mismatch",
    });
  }
  if (
    !sameEpoch(
      value.release.sharedConfigurationEpoch,
      predecessor.sharedConfigurationEpoch,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["release", "sharedConfigurationEpoch"],
      message: "provider_release_publication.reuse_epoch_mismatch",
    });
  }
  if (
    BigInt(value.providerCheckpoint.settledSequence) <=
      BigInt(predecessor.providerCheckpoint.settledSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint", "settledSequence"],
      message: "provider_release_publication.checkpoint_not_advanced",
    });
  }
}

function validateProtectedFields(
  value: unknown,
  context: z.RefinementCtx,
): void {
  if (containsProtectedProviderCatalogReleaseField(value)) {
    context.addIssue({
      code: "custom",
      message: "provider_release_publication.protected_field",
    });
  }
}

export const providerReleaseCompletedHeadRequestSchema = z.object({
  schemaVersion: z.literal(PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
  platformKey: providerCatalogPlatformKeyV1Schema,
}).strict();

export const providerReleaseStartRequestSchema = z.object({
  ...operationEnvelopeShape,
  ...releaseContextShape,
}).strict().superRefine((request, context) => {
  validateAdvancingRelease(request, context);
  validateProtectedFields(request, context);
});

export const providerReleaseApplyBatchRequestSchema = z.object({
  ...operationEnvelopeShape,
  ...releaseContextShape,
  batch: providerCatalogReleaseBatchV1Schema,
}).strict().superRefine((request, context) => {
  validateAdvancingRelease(request, context);
  if (request.batch.batchIndex >= request.release.batchCount) {
    context.addIssue({
      code: "custom",
      path: ["batch", "batchIndex"],
      message: "provider_release_publication.batch_index_out_of_range",
    });
  }
  if (
    request.batch.byteCount !==
      providerCatalogReleaseBatchByteCount(request.batch.records)
  ) {
    context.addIssue({
      code: "custom",
      path: ["batch", "byteCount"],
      message: "provider_release_publication.batch_byte_count_mismatch",
    });
  }
  validateProtectedFields(request, context);
});

export const providerReleaseFinalizeRequestSchema = z.object({
  ...operationEnvelopeShape,
  ...releaseContextShape,
}).strict().superRefine((request, context) => {
  validateAdvancingRelease(request, context);
  validateProtectedFields(request, context);
});

export const providerReleaseConfirmReuseRequestSchema = z.object({
  ...operationEnvelopeShape,
  ...releaseContextShape,
}).strict().superRefine((request, context) => {
  validateReuse(request, context);
  validateProtectedFields(request, context);
});

export const PROVIDER_RELEASE_BLOCK_REASONS = [
  ...PROVIDER_CATALOG_RELEASE_BLOCK_REASONS,
  "PUBLICATION_INTEGRITY_INVALID",
  "PUBLICATION_OWNERSHIP_INVALID",
  "PUBLICATION_PREDECESSOR_CONFLICT",
  "PUBLICATION_RECONCILIATION_FAILED",
  "PUBLICATION_SECURITY_INVALID",
] as const;

export const providerReleaseBlockReasonV1Schema = z.enum(
  PROVIDER_RELEASE_BLOCK_REASONS,
).refine(
  (reason) => reason.length <= MAX_PROVIDER_RELEASE_BLOCK_REASON_LENGTH,
  { message: "provider_release_publication.block_reason_too_long" },
);

export const providerReleaseBlockRequestSchema = z.object({
  ...operationEnvelopeShape,
  ...releaseContextShape,
  blockSequence: providerCatalogSequenceV1Schema,
  reason: providerReleaseBlockReasonV1Schema,
}).strict().superRefine((request, context) => {
  validateReleaseContext(request, context);
  validateProtectedFields(request, context);
});

const cleanupBaseShape = {
  ...operationEnvelopeShape,
  platformKey: providerCatalogPlatformKeyV1Schema,
  expectedCompletedHead: providerReleaseExpectedCompletedHeadV1Schema,
  maximumDocuments: positiveSafeIntegerSchema.max(
    MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS,
  ),
} as const;

export const providerReleaseCleanupRequestSchema = z.object({
  ...cleanupBaseShape,
  cleanupKind: z.literal("expired_auth_nonces"),
}).strict().superRefine((request, context) => {
  if (request.expectedCompletedHead.platformKey !== request.platformKey) {
    context.addIssue({
      code: "custom",
      path: ["expectedCompletedHead", "platformKey"],
      message: "provider_release_publication.predecessor_platform_mismatch",
    });
  }
  validateProtectedFields(request, context);
});

export const providerReleaseStatusOperationKindSchema = z.enum([
  "start",
  "applyBatch",
  "finalize",
  "confirmReuse",
  "block",
  "cleanup",
]);

const statusTargetBaseShape = {
  operationKind: providerReleaseStatusOperationKindSchema,
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  platformKey: providerCatalogPlatformKeyV1Schema,
  requestDigest: sha256Schema,
} as const;

export const providerReleaseStatusTargetSchema = z.union([
  z.object({
    ...statusTargetBaseShape,
    operationKind: z.enum([
      "start", "applyBatch", "finalize", "confirmReuse", "block",
    ]),
    publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  }).strict(),
  z.object({
    ...statusTargetBaseShape,
    operationKind: z.literal("cleanup"),
    publicProviderReleaseId: z.null(),
  }).strict(),
]);

export const providerReleaseStatusRequestSchema = z.object({
  schemaVersion: z.literal(PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION),
  target: providerReleaseStatusTargetSchema,
}).strict();

export const providerReleaseMutationRequestSchema = z.union([
  providerReleaseStartRequestSchema,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseCleanupRequestSchema,
]);

export const providerReleaseRequestSchema = z.union([
  providerReleaseCompletedHeadRequestSchema,
  providerReleaseStatusRequestSchema,
  providerReleaseMutationRequestSchema,
]);

export type ProviderReleaseImmutableProofV1 = z.infer<
  typeof providerReleaseImmutableProofV1Schema
>;
export type ProviderReleaseExpectedCompletedHeadV1 = z.infer<
  typeof providerReleaseExpectedCompletedHeadV1Schema
>;
export type ProviderReleaseCompletedHeadV1 = z.infer<
  typeof providerReleaseCompletedHeadV1Schema
>;
export type ProviderReleaseCompletedHeadStateV1 = z.infer<
  typeof providerReleaseCompletedHeadStateV1Schema
>;
export type ProviderReleaseCompletedHeadRequest = z.infer<
  typeof providerReleaseCompletedHeadRequestSchema
>;
export type ProviderReleaseStartRequest = z.infer<
  typeof providerReleaseStartRequestSchema
>;
export type ProviderReleaseApplyBatchRequest = z.infer<
  typeof providerReleaseApplyBatchRequestSchema
>;
export type ProviderReleaseFinalizeRequest = z.infer<
  typeof providerReleaseFinalizeRequestSchema
>;
export type ProviderReleaseConfirmReuseRequest = z.infer<
  typeof providerReleaseConfirmReuseRequestSchema
>;
export type ProviderReleaseBlockRequest = z.infer<
  typeof providerReleaseBlockRequestSchema
>;
export type ProviderReleaseBlockReasonV1 = z.infer<
  typeof providerReleaseBlockReasonV1Schema
>;
export type ProviderReleaseCleanupRequest = z.infer<
  typeof providerReleaseCleanupRequestSchema
>;
export type ProviderReleaseStatusOperationKind = z.infer<
  typeof providerReleaseStatusOperationKindSchema
>;
export type ProviderReleaseStatusTarget = z.infer<
  typeof providerReleaseStatusTargetSchema
>;
export type ProviderReleaseStatusRequest = z.infer<
  typeof providerReleaseStatusRequestSchema
>;
export type ProviderReleaseMutationRequest = z.infer<
  typeof providerReleaseMutationRequestSchema
>;
export type ProviderReleaseRequest = z.infer<
  typeof providerReleaseRequestSchema
>;

export function containsProtectedProviderReleasePublicationField(
  value: unknown,
): boolean {
  return containsProtectedProviderCatalogReleaseField(value);
}

export async function providerReleasePublicationRequestDigest(
  request: unknown,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(request)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseProviderReleasePublicationJson<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T | null {
  if (
    new TextEncoder().encode(bodyJson).byteLength >
      MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES
  ) {
    return null;
  }
  try {
    const value = JSON.parse(bodyJson) as unknown;
    if (containsProtectedProviderReleasePublicationField(value)) return null;
    const parsed = schema.parse(value);
    return bodyJson === canonicalJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export { MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT };
