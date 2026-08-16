import { z } from "zod";
import {
  canonicalJson,
  sha256CanonicalJson,
} from "./data-release-v2-canonical.ts";
import {
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  productionAuthKeyIdSchema,
} from "./data-release-v2-publication-auth.ts";
import {
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  buildProviderCatalogSourceWatermarkV1,
  providerCatalogPlatformKeyV1Schema,
  providerCatalogReleaseCheckpointV1Schema,
  providerCatalogReleaseCountsV1Schema,
  providerCatalogReleaseEntityHashesV1Schema,
  providerCatalogReleaseObservationV1Schema,
  providerCatalogSequenceV1Schema,
  providerCatalogSharedConfigurationEpochV1Schema,
  publicProviderReleaseIdV1Schema,
} from "./provider-catalog-release-v1.ts";
import {
  MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  providerReleaseBlockReasonV1Schema,
  providerReleaseCompletedHeadStateV1Schema,
  providerReleaseExpectedCompletedHeadV1Schema,
  providerReleaseImmutableProofV1Schema,
  providerReleaseStatusTargetSchema,
} from "./provider-release-publication-v1.ts";

export const PROVIDER_RELEASE_RECEIPT_HASH_DOMAIN =
  "packscout.provider-release-publication.receipt.v1" as const;
export const MAX_PROVIDER_RELEASE_RECEIPT_BYTES = 384 * 1_024;

const operationIdSchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u);
const idempotencyKeySchema = z.string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u);
const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const providerReleaseBatchKindSchema = z.enum(
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
);
const completedCheckpointReceiptSchema = providerCatalogReleaseCheckpointV1Schema
  .refine(({ settledSequence }) => settledSequence !== "0", {
    path: ["settledSequence"],
    message: "provider_release_publication.completed_checkpoint_required",
  });

export const providerReleaseOperationKindSchema = z.enum([
  "completedHead",
  "start",
  "applyBatch",
  "finalize",
  "confirmReuse",
  "block",
  "cleanup",
]);

const mutationReceiptBaseShape = {
  schemaVersion: z.literal(PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION),
  operationId: operationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  platformKey: providerCatalogPlatformKeyV1Schema,
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  receiptDigest: sha256Schema,
} as const;

const releaseReceiptBaseShape = {
  ...mutationReceiptBaseShape,
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  sharedConfigurationEpoch:
    providerCatalogSharedConfigurationEpochV1Schema,
  providerCheckpoint: completedCheckpointReceiptSchema,
} as const;

const releaseContextDetailsShape = {
  release: providerReleaseImmutableProofV1Schema,
  providerCheckpoint: completedCheckpointReceiptSchema,
  sourceWatermark: z.string().min(1).max(256),
  observation: providerCatalogReleaseObservationV1Schema,
  expectedCompletedHead: providerReleaseExpectedCompletedHeadV1Schema,
} as const;

type ReleaseReceiptLike = Readonly<{
  platformKey: string;
  publicProviderReleaseId: string;
  sharedConfigurationEpoch: z.infer<
    typeof providerCatalogSharedConfigurationEpochV1Schema
  >;
  providerCheckpoint: z.infer<typeof completedCheckpointReceiptSchema>;
  details: Readonly<{
    release: z.infer<typeof providerReleaseImmutableProofV1Schema>;
    providerCheckpoint: z.infer<typeof completedCheckpointReceiptSchema>;
    sourceWatermark: string;
    observation: z.infer<typeof providerCatalogReleaseObservationV1Schema>;
    expectedCompletedHead: z.infer<
      typeof providerReleaseExpectedCompletedHeadV1Schema
    >;
  }>;
}>;

function validateReleaseReceiptContext(
  receipt: ReleaseReceiptLike,
  context: z.RefinementCtx,
): void {
  const { details } = receipt;
  if (
    details.release.platformKey !== receipt.platformKey ||
    details.release.publicProviderReleaseId !==
      receipt.publicProviderReleaseId ||
    canonicalJson(details.release.sharedConfigurationEpoch) !==
      canonicalJson(receipt.sharedConfigurationEpoch) ||
    canonicalJson(details.providerCheckpoint) !==
      canonicalJson(receipt.providerCheckpoint)
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "release"],
      message: "provider_release_publication.receipt_release_mismatch",
    });
  }
  if (details.expectedCompletedHead.platformKey !== receipt.platformKey) {
    context.addIssue({
      code: "custom",
      path: ["details", "expectedCompletedHead", "platformKey"],
      message: "provider_release_publication.predecessor_platform_mismatch",
    });
  }
  if (
    details.sourceWatermark !== buildProviderCatalogSourceWatermarkV1(
      receipt.platformKey,
      receipt.providerCheckpoint.settledSequence,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "sourceWatermark"],
      message: "provider_release_publication.source_watermark_mismatch",
    });
  }
  if (
    details.observation.sourceHeadSequence !==
      receipt.providerCheckpoint.settledSequence
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "observation", "sourceHeadSequence"],
      message: "provider_release_publication.observation_checkpoint_mismatch",
    });
  }
  const settledAt = receipt.providerCheckpoint.settledAt;
  if (
    settledAt === null ||
    Date.parse(details.release.dataAsOf) > Date.parse(settledAt) ||
    Date.parse(details.observation.lastSuccessfulObservationAt) >
      Date.parse(settledAt) ||
    BigInt(details.release.sharedConfigurationEpoch.publicChangeSequence) >
      BigInt(receipt.providerCheckpoint.settledSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint"],
      message: "provider_release_publication.receipt_context_invalid",
    });
  }
  if (
    Date.parse(details.release.dataAsOf) >
      Date.parse(details.observation.lastSuccessfulObservationAt)
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "release", "dataAsOf"],
      message: "provider_release_publication.data_after_observation",
    });
  }
}

function receiptEpochsMatch(
  left: z.infer<typeof providerCatalogSharedConfigurationEpochV1Schema>,
  right: z.infer<typeof providerCatalogSharedConfigurationEpochV1Schema>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateAdvancingReleaseReceipt(
  receipt: ReleaseReceiptLike,
  context: z.RefinementCtx,
): void {
  validateReleaseReceiptContext(receipt, context);
  const predecessor = receipt.details.expectedCompletedHead;
  if (predecessor.publicProviderReleaseId === null) return;
  if (
    BigInt(receipt.providerCheckpoint.settledSequence) <=
      BigInt(predecessor.providerCheckpoint.settledSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint", "settledSequence"],
      message: "provider_release_publication.checkpoint_not_advanced",
    });
  }
  if (
    receipt.publicProviderReleaseId === predecessor.publicProviderReleaseId
  ) {
    context.addIssue({
      code: "custom",
      path: ["publicProviderReleaseId"],
      message: "provider_release_publication.new_release_required",
    });
  }
  if (
    !receiptEpochsMatch(
      receipt.sharedConfigurationEpoch,
      predecessor.sharedConfigurationEpoch,
    ) &&
    BigInt(receipt.sharedConfigurationEpoch.publicChangeSequence) <=
      BigInt(predecessor.sharedConfigurationEpoch.publicChangeSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["sharedConfigurationEpoch", "publicChangeSequence"],
      message: "provider_release_publication.epoch_not_advanced",
    });
  }
}

function validateReuseReceipt(
  receipt: ReleaseReceiptLike,
  context: z.RefinementCtx,
): void {
  validateReleaseReceiptContext(receipt, context);
  const predecessor = receipt.details.expectedCompletedHead;
  if (predecessor.publicProviderReleaseId === null) {
    context.addIssue({
      code: "custom",
      path: ["details", "expectedCompletedHead"],
      message: "provider_release_publication.reuse_predecessor_required",
    });
    return;
  }
  if (
    receipt.publicProviderReleaseId !== predecessor.publicProviderReleaseId
  ) {
    context.addIssue({
      code: "custom",
      path: ["publicProviderReleaseId"],
      message: "provider_release_publication.reuse_release_mismatch",
    });
  }
  if (
    !receiptEpochsMatch(
      receipt.sharedConfigurationEpoch,
      predecessor.sharedConfigurationEpoch,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["sharedConfigurationEpoch"],
      message: "provider_release_publication.reuse_epoch_mismatch",
    });
  }
  if (
    BigInt(receipt.providerCheckpoint.settledSequence) <=
      BigInt(predecessor.providerCheckpoint.settledSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerCheckpoint", "settledSequence"],
      message: "provider_release_publication.checkpoint_not_advanced",
    });
  }
}

function validateCompletedHeadResult(
  receipt: ReleaseReceiptLike & Readonly<{
    details: ReleaseReceiptLike["details"] & Readonly<{
      completedHead: z.infer<
        typeof providerReleaseCompletedHeadResultV1Schema
      >;
    }>;
  }>,
  context: z.RefinementCtx,
): void {
  const { completedHead, release, observation } = receipt.details;
  if (
    completedHead.platformKey !== receipt.platformKey ||
    canonicalJson(completedHead.release) !== canonicalJson(release) ||
    canonicalJson(completedHead.providerCheckpoint) !==
      canonicalJson(receipt.providerCheckpoint) ||
    canonicalJson(completedHead.observation) !== canonicalJson(observation)
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "completedHead"],
      message: "provider_release_publication.completed_head_mismatch",
    });
  }
}

export const providerReleaseCompletedHeadReceiptSchema = z.union([
  z.object({
    schemaVersion: z.literal(PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION),
    operationKind: z.literal("completedHead"),
    operationId: operationIdSchema,
    platformKey: providerCatalogPlatformKeyV1Schema,
    publicProviderReleaseId: z.null(),
    terminalState: z.literal("observed"),
    result: z.literal("completed_head"),
    serverTime: timestampSchema,
    requestDigest: sha256Schema,
    receiptDigest: sha256Schema,
    details: z.object({
      head: providerReleaseCompletedHeadStateV1Schema,
    }).strict(),
  }).strict().superRefine((receipt, context) => {
    if (
      receipt.details.head.platformKey !== receipt.platformKey ||
      receipt.details.head.release !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["details", "head"],
        message: "provider_release_publication.completed_head_mismatch",
      });
    }
  }),
  z.object({
    schemaVersion: z.literal(PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION),
    operationKind: z.literal("completedHead"),
    operationId: operationIdSchema,
    platformKey: providerCatalogPlatformKeyV1Schema,
    publicProviderReleaseId: publicProviderReleaseIdV1Schema,
    terminalState: z.literal("observed"),
    result: z.literal("completed_head"),
    serverTime: timestampSchema,
    requestDigest: sha256Schema,
    receiptDigest: sha256Schema,
    details: z.object({
      head: providerReleaseCompletedHeadStateV1Schema,
    }).strict(),
  }).strict().superRefine((receipt, context) => {
    const { head } = receipt.details;
    if (
      head.platformKey !== receipt.platformKey ||
      head.release === null ||
      head.release.publicProviderReleaseId !== receipt.publicProviderReleaseId
    ) {
      context.addIssue({
        code: "custom",
        path: ["details", "head"],
        message: "provider_release_publication.completed_head_mismatch",
      });
    }
  }),
]);

export const providerReleaseStartReceiptSchema = z.object({
  ...releaseReceiptBaseShape,
  operationKind: z.literal("start"),
  terminalState: z.literal("staging"),
  result: z.literal("created"),
  details: z.object({
    ...releaseContextDetailsShape,
    acceptedBatchCount: z.literal(0),
  }).strict(),
}).strict().superRefine(validateAdvancingReleaseReceipt);

export const providerReleaseBatchReceiptSchema = z.object({
  ...releaseReceiptBaseShape,
  operationKind: z.literal("applyBatch"),
  terminalState: z.literal("staging"),
  result: z.literal("accepted"),
  details: z.object({
    ...releaseContextDetailsShape,
    batchIndex: nonNegativeSafeIntegerSchema.max(
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT - 1,
    ),
    kind: providerReleaseBatchKindSchema,
    batchHash: sha256Schema,
    recordCount: z.number().int().safe().positive().max(
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
    ),
    byteCount: z.number().int().safe().positive().max(
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
    ),
    acceptedBatchCount: z.number().int().safe().positive().max(
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
    ),
    acceptedCounts: providerCatalogReleaseCountsV1Schema,
    acceptedEntityHashes: providerCatalogReleaseEntityHashesV1Schema,
    acceptedBatchChainHash: sha256Schema,
  }).strict(),
}).strict().superRefine((receipt, context) => {
  validateAdvancingReleaseReceipt(receipt, context);
  const details = receipt.details;
  if (
    details.batchIndex >= details.release.batchCount ||
    details.acceptedBatchCount !== details.batchIndex + 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "acceptedBatchCount"],
      message: "provider_release_publication.batch_progress_mismatch",
    });
  }
  const accepted = details.acceptedCounts;
  const expected = details.release.counts;
  if (
    accepted.vendors > expected.vendors ||
    accepted.categories > expected.categories ||
    accepted.collectibles > expected.collectibles ||
    accepted.repacks > expected.repacks ||
    accepted.repackChases > expected.repackChases ||
    accepted.searchShards > expected.searchShards
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "acceptedCounts"],
      message: "provider_release_publication.accepted_counts_exceed_release",
    });
  }
});

export const providerReleaseCompletedHeadResultV1Schema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  release: providerReleaseImmutableProofV1Schema,
  providerCheckpoint: completedCheckpointReceiptSchema,
  observation: providerCatalogReleaseObservationV1Schema,
}).strict();

const completionDetailsSchema = z.object({
  ...releaseContextDetailsShape,
  completedHead: providerReleaseCompletedHeadResultV1Schema,
}).strict();

export const providerReleaseCompletionReceiptSchema = z.object({
  ...releaseReceiptBaseShape,
  operationKind: z.literal("finalize"),
  terminalState: z.literal("complete"),
  result: z.literal("completed"),
  details: completionDetailsSchema,
}).strict().superRefine((receipt, context) => {
  validateAdvancingReleaseReceipt(receipt, context);
  validateCompletedHeadResult(receipt, context);
});

export const providerReleaseReuseReceiptSchema = z.object({
  ...releaseReceiptBaseShape,
  operationKind: z.literal("confirmReuse"),
  terminalState: z.literal("complete"),
  result: z.literal("reused"),
  details: completionDetailsSchema,
}).strict().superRefine((receipt, context) => {
  validateReuseReceipt(receipt, context);
  validateCompletedHeadResult(receipt, context);
});

export const providerReleaseBlockReceiptSchema = z.object({
  ...releaseReceiptBaseShape,
  operationKind: z.literal("block"),
  terminalState: z.literal("blocked"),
  result: z.literal("blocked"),
  details: z.object({
    ...releaseContextDetailsShape,
    blockSequence: providerCatalogSequenceV1Schema,
    reason: providerReleaseBlockReasonV1Schema,
  }).strict(),
}).strict().superRefine(validateReleaseReceiptContext);

const cleanupReceiptBaseShape = {
  ...mutationReceiptBaseShape,
  operationKind: z.literal("cleanup"),
  publicProviderReleaseId: z.null(),
  result: z.literal("cleaned"),
} as const;

const cleanupProgressShape = {
  expectedCompletedHead: providerReleaseExpectedCompletedHeadV1Schema,
  deletedDocumentCount: nonNegativeSafeIntegerSchema.max(
    MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS,
  ),
  maximumDocuments: z.number().int().safe().positive().max(
    MAX_PROVIDER_RELEASE_CLEANUP_DOCUMENTS,
  ),
  hasMore: z.boolean(),
} as const;

const artifactCleanupDetailsShape = {
  cleanupKind: z.literal("expired_provider_artifacts"),
  expectedCompletedHead: cleanupProgressShape.expectedCompletedHead,
  deletedDocumentCount: cleanupProgressShape.deletedDocumentCount,
  maximumDocuments: cleanupProgressShape.maximumDocuments,
  deletedStagingDocumentCount: nonNegativeSafeIntegerSchema,
  deletedFailedDocumentCount: nonNegativeSafeIntegerSchema,
} as const;

function validateCleanupProgress(
  details: Readonly<{
    deletedDocumentCount: number;
    maximumDocuments: number;
  }>,
  context: z.RefinementCtx,
): void {
  if (details.deletedDocumentCount > details.maximumDocuments) {
    context.addIssue({
      code: "custom",
      path: ["details", "deletedDocumentCount"],
      message: "provider_release_publication.cleanup_count_exceeds_maximum",
    });
  }
}

export const providerReleaseArtifactCleanupReceiptSchema = z.union([
  z.object({
    ...cleanupReceiptBaseShape,
    terminalState: z.literal("complete"),
    details: z.object({
      ...artifactCleanupDetailsShape,
      hasMore: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    ...cleanupReceiptBaseShape,
    terminalState: z.literal("continuation_required"),
    details: z.object({
      ...artifactCleanupDetailsShape,
      hasMore: z.literal(true),
    }).strict(),
  }).strict(),
]).superRefine((receipt, context) => {
  const details = receipt.details;
  validateCleanupProgress(details, context);
  if (details.expectedCompletedHead.platformKey !== receipt.platformKey) {
    context.addIssue({
      code: "custom",
      path: ["details", "expectedCompletedHead", "platformKey"],
      message: "provider_release_publication.predecessor_platform_mismatch",
    });
  }
  if (
    details.deletedDocumentCount !==
      details.deletedStagingDocumentCount +
        details.deletedFailedDocumentCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "deletedDocumentCount"],
      message: "provider_release_publication.cleanup_count_mismatch",
    });
  }
});

const nonceCleanupDetailsShape = {
  cleanupKind: z.literal("expired_auth_nonces"),
  expectedCompletedHead: cleanupProgressShape.expectedCompletedHead,
  deletedDocumentCount: cleanupProgressShape.deletedDocumentCount,
  maximumDocuments: cleanupProgressShape.maximumDocuments,
  deletedNonceCount: nonNegativeSafeIntegerSchema,
} as const;

export const providerReleaseNonceCleanupReceiptSchema = z.union([
  z.object({
    ...cleanupReceiptBaseShape,
    terminalState: z.literal("complete"),
    details: z.object({
      ...nonceCleanupDetailsShape,
      hasMore: z.literal(false),
    }).strict(),
  }).strict(),
  z.object({
    ...cleanupReceiptBaseShape,
    terminalState: z.literal("continuation_required"),
    details: z.object({
      ...nonceCleanupDetailsShape,
      hasMore: z.literal(true),
    }).strict(),
  }).strict(),
]).superRefine((receipt, context) => {
  validateCleanupProgress(receipt.details, context);
  if (
    receipt.details.expectedCompletedHead.platformKey !== receipt.platformKey
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "expectedCompletedHead", "platformKey"],
      message: "provider_release_publication.predecessor_platform_mismatch",
    });
  }
  if (
    receipt.details.deletedDocumentCount !==
      receipt.details.deletedNonceCount
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "deletedDocumentCount"],
      message: "provider_release_publication.cleanup_count_mismatch",
    });
  }
});

export const providerReleaseCleanupReceiptSchema = z.union([
  providerReleaseArtifactCleanupReceiptSchema,
  providerReleaseNonceCleanupReceiptSchema,
]);

export const providerReleaseReceiptSchema = z.union([
  providerReleaseCompletedHeadReceiptSchema,
  providerReleaseStartReceiptSchema,
  providerReleaseBatchReceiptSchema,
  providerReleaseCompletionReceiptSchema,
  providerReleaseReuseReceiptSchema,
  providerReleaseBlockReceiptSchema,
  providerReleaseCleanupReceiptSchema,
]);

export const providerReleaseStatusNotFoundReceiptSchema = z.object({
  schemaVersion: z.literal(PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION),
  target: providerReleaseStatusTargetSchema,
  terminalState: z.literal("not_found"),
  result: z.literal("not_found"),
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  details: z.object({}).strict(),
  receiptDigest: z.null(),
}).strict().superRefine((receipt, context) => {
  if (receipt.requestDigest !== receipt.target.requestDigest) {
    context.addIssue({
      code: "custom",
      path: ["requestDigest"],
      message: "provider_release_publication.status_digest_mismatch",
    });
  }
});

export const providerReleaseSignedReceiptEnvelopeSchema = z.object({
  ok: z.literal(true),
  receipt: z.union([
    providerReleaseReceiptSchema,
    providerReleaseStatusNotFoundReceiptSchema,
  ]),
  responseAuth: z.object({
    signatureVersion: z.literal(PRODUCTION_AUTH_SIGNATURE_VERSION),
    keyId: productionAuthKeyIdSchema,
    receiptDigest: sha256Schema,
    signature: sha256Schema,
  }).strict(),
}).strict().superRefine((envelope, context) => {
  if (
    envelope.receipt.receiptDigest !== null &&
    envelope.responseAuth.receiptDigest !== envelope.receipt.receiptDigest
  ) {
    context.addIssue({
      code: "custom",
      path: ["responseAuth", "receiptDigest"],
      message: "provider_release_publication.response_digest_mismatch",
    });
  }
});

export const PROVIDER_RELEASE_ERROR_CODES = [
  "PROVIDER_RELEASE_AUTH_MISSING",
  "PROVIDER_RELEASE_AUTH_KEY_UNKNOWN",
  "PROVIDER_RELEASE_AUTH_INVALID",
  "PROVIDER_RELEASE_AUTH_STALE",
  "PROVIDER_RELEASE_AUTH_REPLAYED",
  "PROVIDER_RELEASE_BODY_TOO_LARGE",
  "PROVIDER_RELEASE_SCHEMA_UNSUPPORTED",
  "PROVIDER_RELEASE_REQUEST_INVALID",
  "PROVIDER_RELEASE_OPERATION_CONFLICT",
  "PROVIDER_RELEASE_STATE_CONFLICT",
  "PROVIDER_RELEASE_PLATFORM_MISMATCH",
  "PROVIDER_RELEASE_IDENTITY_MISMATCH",
  "PROVIDER_RELEASE_EPOCH_CONFLICT",
  "PROVIDER_RELEASE_CHECKPOINT_REGRESSED",
  "PROVIDER_RELEASE_PREDECESSOR_CONFLICT",
  "PROVIDER_RELEASE_FINGERPRINT_BLOCKED",
  "PROVIDER_RELEASE_BLOCK_SEQUENCE_REGRESSED",
  "PROVIDER_RELEASE_BATCH_CONFLICT",
  "PROVIDER_RELEASE_BATCH_OUT_OF_ORDER",
  "PROVIDER_RELEASE_BATCH_TOO_LARGE",
  "PROVIDER_RELEASE_COUNT_MISMATCH",
  "PROVIDER_RELEASE_HASH_MISMATCH",
  "PROVIDER_RELEASE_ENTITY_INVALID",
  "PROVIDER_RELEASE_REFERENCE_INVALID",
  "PROVIDER_RELEASE_OWNERSHIP_MISMATCH",
  "PROVIDER_RELEASE_PROTECTED_FIELD",
  "PROVIDER_RELEASE_RECONCILIATION_FAILED",
  "PROVIDER_RELEASE_CLEANUP_UNSAFE",
  "PROVIDER_RELEASE_INTERNAL_ERROR",
] as const;

export const providerReleaseErrorCodeSchema = z.enum(
  PROVIDER_RELEASE_ERROR_CODES,
);

export const providerReleaseErrorEnvelopeSchema = z.object({
  error: z.string().min(1).max(256),
  code: providerReleaseErrorCodeSchema,
}).strict();

export type ProviderReleaseOperationKind = z.infer<
  typeof providerReleaseOperationKindSchema
>;
export type ProviderReleaseCompletedHeadReceipt = z.infer<
  typeof providerReleaseCompletedHeadReceiptSchema
>;
export type ProviderReleaseCompletionReceipt = z.infer<
  typeof providerReleaseCompletionReceiptSchema
>;
export type ProviderReleaseStartReceipt = z.infer<
  typeof providerReleaseStartReceiptSchema
>;
export type ProviderReleaseBatchReceipt = z.infer<
  typeof providerReleaseBatchReceiptSchema
>;
export type ProviderReleaseCompletedHeadResultV1 = z.infer<
  typeof providerReleaseCompletedHeadResultV1Schema
>;
export type ProviderReleaseReuseReceipt = z.infer<
  typeof providerReleaseReuseReceiptSchema
>;
export type ProviderReleaseBlockReceipt = z.infer<
  typeof providerReleaseBlockReceiptSchema
>;
export type ProviderReleaseArtifactCleanupReceipt = z.infer<
  typeof providerReleaseArtifactCleanupReceiptSchema
>;
export type ProviderReleaseNonceCleanupReceipt = z.infer<
  typeof providerReleaseNonceCleanupReceiptSchema
>;
export type ProviderReleaseCleanupReceipt = z.infer<
  typeof providerReleaseCleanupReceiptSchema
>;
export type ProviderReleaseReceipt = z.infer<
  typeof providerReleaseReceiptSchema
>;
export type ProviderReleaseStatusNotFoundReceipt = z.infer<
  typeof providerReleaseStatusNotFoundReceiptSchema
>;
export type ProviderReleaseSignedReceiptEnvelope = z.infer<
  typeof providerReleaseSignedReceiptEnvelopeSchema
>;
export type ProviderReleaseErrorCode = z.infer<
  typeof providerReleaseErrorCodeSchema
>;
export type ProviderReleaseErrorEnvelope = z.infer<
  typeof providerReleaseErrorEnvelopeSchema
>;

export function isRetryableProviderReleaseError(
  code: ProviderReleaseErrorCode,
): boolean {
  return code === "PROVIDER_RELEASE_AUTH_STALE" ||
    code === "PROVIDER_RELEASE_INTERNAL_ERROR";
}

export function classifyProviderReleaseError(
  code: ProviderReleaseErrorCode,
): "bounded_retry" | "authentication" | "terminal" {
  if (isRetryableProviderReleaseError(code)) return "bounded_retry";
  if (code.startsWith("PROVIDER_RELEASE_AUTH_")) return "authentication";
  return "terminal";
}

function withoutReceiptDigest(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const { receiptDigest: _receiptDigest, ...body } = value as Record<
    string,
    unknown
  >;
  void _receiptDigest;
  return body;
}

export function providerReleaseReceiptDigest(value: unknown): Promise<string> {
  return sha256CanonicalJson(
    PROVIDER_RELEASE_RECEIPT_HASH_DOMAIN,
    withoutReceiptDigest(value),
  );
}

export async function providerReleaseTerminalReceiptSha256(
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
