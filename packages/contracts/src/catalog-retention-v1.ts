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
  activeCatalogManifestStateV1Schema,
  catalogManifestIdempotencyKeySchema,
  catalogManifestOperationIdSchema,
  globalCatalogManifestIdentityV1Schema,
} from "./catalog-manifest-publication-v1.ts";
import {
  containsProtectedProviderReleasePublicationField,
  providerReleaseExpectedCompletedHeadV1Schema,
  providerReleaseOperationIdSchema,
} from "./provider-release-publication-v1.ts";
import {
  providerCatalogPlatformKeyV1Schema,
  publicProviderReleaseIdV1Schema,
} from "./provider-catalog-release-v1.ts";
import {
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import {
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
} from "./global-catalog-manifest-v1.ts";
export { PRODUCTION_CATALOG_RETENTION_PATHS } from "./catalog-retention-v1-paths.ts";

export const CATALOG_RETENTION_SCHEMA_VERSION =
  "catalog_retention_v1" as const;
export const CATALOG_RETENTION_POSTGRES_PROOF_HASH_DOMAIN =
  "packscout.catalog-retention.postgres-proof.v1" as const;
export const CATALOG_RETENTION_RECEIPT_HASH_DOMAIN =
  "packscout.catalog-retention.receipt.v1" as const;

export const MAX_CATALOG_RETENTION_HTTP_BODY_BYTES = 256 * 1_024;
export const MAX_CATALOG_RETENTION_HTTP_RESPONSE_BYTES =
  MAX_CATALOG_RETENTION_HTTP_BODY_BYTES + 4_096;
export const MAX_CATALOG_RETENTION_POSTGRES_PROOF_BYTES = 240 * 1_024;
export const MAX_CATALOG_RETENTION_ARTIFACT_DOCUMENTS = 90;
export const MIN_CATALOG_RETENTION_MANIFEST_DOCUMENTS = 9;
export const MAX_CATALOG_RETENTION_DOCUMENTS_PER_MUTATION = 100;
export const MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS = 10;
export const MAX_CATALOG_RETENTION_OPERATION_RECEIPTS = 128;
export const CATALOG_RETENTION_OPERATION_RECEIPT_MILLISECONDS =
  7 * 24 * 60 * 60 * 1_000;
export const CATALOG_RETENTION_COMPLETE_MILLISECONDS =
  7 * 24 * 60 * 60 * 1_000;
export const CATALOG_RETENTION_ABANDONED_MILLISECONDS =
  24 * 60 * 60 * 1_000;
export const MAX_CATALOG_RETENTION_ADDITIONAL_COMPLETE = 3;
export const MAX_CATALOG_RETENTION_PLATFORM_COUNT =
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES;
export const MAX_CATALOG_RETENTION_EXTERNAL_MANIFEST_PROTECTIONS = 32;
export const MAX_CATALOG_RETENTION_EXTERNAL_PROVIDER_PROTECTIONS = 32;
export const MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS = 40;
export const MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM =
  80;
// Keep the prior eight-platform aggregate while allowing the configured
// platform roster to grow to the manifest limit. This bounds both Convex graph
// reads and the signed receipt carried by the retention HTTP response.
export const MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES = 640;

const nonNegativeSafeIntegerSchema = z.number().int().safe().min(0);
const positiveSnapshotSequenceSchema = z.string().regex(/^[1-9][0-9]*$/u);

const activeStateProofSchema = z.object({
  state: activeCatalogManifestStateV1Schema,
  terminalOperationId: catalogManifestOperationIdSchema.nullable(),
}).strict().superRefine((proof, context) => {
  if ((proof.state.generation === 0) !== (proof.terminalOperationId === null)) {
    context.addIssue({
      code: "custom",
      path: ["terminalOperationId"],
      message: "catalog_retention.active_state_proof_invalid",
    });
  }
});

const completedHeadProofSchema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  completedHead: providerReleaseExpectedCompletedHeadV1Schema,
  terminalOperationId: providerReleaseOperationIdSchema.nullable(),
}).strict().superRefine((proof, context) => {
  if (
    proof.completedHead.platformKey !== proof.platformKey ||
    (proof.completedHead.publicProviderReleaseId === null) !==
      (proof.terminalOperationId === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "catalog_retention.completed_head_proof_invalid",
    });
  }
});

export const catalogRetentionManifestOperationProofSchema = z.object({
  operationKind: z.enum(["activateManifest", "rollback", "block"]),
  operationId: catalogManifestOperationIdSchema,
  operationState: z.enum(["pending", "sent", "acknowledged"]),
  canonicalRequestBody: z.string().min(2)
    .max(MAX_CATALOG_RETENTION_HTTP_BODY_BYTES).nullable(),
  requestDigest: sha256Schema,
  terminalReceiptSha256: sha256Schema.nullable(),
}).strict().superRefine(validateOperationProofState);

export const catalogRetentionProviderOperationProofSchema = z.object({
  operationKind: z.enum([
    "start",
    "applyBatch",
    "finalize",
    "confirmReuse",
    "block",
  ]),
  operationId: providerReleaseOperationIdSchema,
  operationState: z.enum(["pending", "sent", "acknowledged"]),
  canonicalRequestBody: z.string().min(2)
    .max(MAX_CATALOG_RETENTION_HTTP_BODY_BYTES).nullable(),
  requestDigest: sha256Schema,
  terminalReceiptSha256: sha256Schema.nullable(),
}).strict().superRefine(validateOperationProofState);

function validateOperationProofState(
  proof: Readonly<{
    operationState: "pending" | "sent" | "acknowledged";
    canonicalRequestBody: string | null;
    terminalReceiptSha256: string | null;
  }>,
  context: z.RefinementCtx,
): void {
  if (
    (proof.operationState === "acknowledged") !==
      (proof.terminalReceiptSha256 !== null) ||
    (proof.operationState === "acknowledged") !==
      (proof.canonicalRequestBody === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["terminalReceiptSha256"],
      message: "catalog_retention.operation_state_proof_invalid",
    });
  }
}

export const catalogRetentionExternalManifestProtectionSchema = z.object({
  manifest: globalCatalogManifestIdentityV1Schema,
  reason: z.enum([
    "in_flight_attempt",
    "rollback_recovery",
    "block_recovery",
  ]),
  operationProof: catalogRetentionManifestOperationProofSchema,
}).strict().superRefine((protection, context) => {
  if (
    (protection.reason === "block_recovery" &&
      protection.operationProof.operationKind !== "block") ||
    (protection.reason === "rollback_recovery" &&
      protection.operationProof.operationKind !== "activateManifest" &&
      protection.operationProof.operationKind !== "rollback")
  ) {
    context.addIssue({
      code: "custom",
      path: ["operationProof", "operationKind"],
      message: "catalog_retention.manifest_proof_kind_invalid",
    });
  }
  if (
    protection.reason !== "in_flight_attempt" &&
    protection.operationProof.operationState !== "acknowledged"
  ) {
    context.addIssue({
      code: "custom",
      path: ["operationProof", "operationState"],
      message: "catalog_retention.recovery_proof_not_acknowledged",
    });
  }
});

export const catalogRetentionProviderReleaseIdentitySchema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  providerReleaseFingerprint: sha256Schema,
}).strict();

export const catalogRetentionExternalProviderProtectionSchema = z.object({
  release: catalogRetentionProviderReleaseIdentitySchema,
  reason: z.enum([
    "in_flight_attempt",
    "rollback_recovery",
    "block_recovery",
  ]),
  operationProof: catalogRetentionProviderOperationProofSchema,
}).strict().superRefine((protection, context) => {
  const operationKind = protection.operationProof.operationKind;
  if (
    (protection.reason === "block_recovery" && operationKind !== "block") ||
    (protection.reason === "rollback_recovery" &&
      operationKind !== "finalize" && operationKind !== "confirmReuse")
  ) {
    context.addIssue({
      code: "custom",
      path: ["operationProof", "operationKind"],
      message: "catalog_retention.provider_proof_kind_invalid",
    });
  }
  if (
    protection.reason !== "in_flight_attempt" &&
    protection.operationProof.operationState !== "acknowledged"
  ) {
    context.addIssue({
      code: "custom",
      path: ["operationProof", "operationState"],
      message: "catalog_retention.recovery_proof_not_acknowledged",
    });
  }
});

const externalProviderProtectionGroupSchema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  releases: z.array(catalogRetentionExternalProviderProtectionSchema)
    .max(MAX_CATALOG_RETENTION_EXTERNAL_PROVIDER_PROTECTIONS),
}).strict().superRefine((group, context) => {
  if (
    group.releases.some(({ release }) =>
      release.platformKey !== group.platformKey
    ) ||
    !isStrictlyCanonical(group.releases, (protection) =>
      [
        protection.release.publicProviderReleaseId,
        protection.reason,
        protection.operationProof.operationId,
      ].join("\n"))
  ) {
    context.addIssue({
      code: "custom",
      path: ["releases"],
      message: "catalog_retention.provider_protections_not_canonical",
    });
  }
});

function isStrictlyCanonical<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  return values.every(
    (value, index) => index === 0 || key(values[index - 1]!) < key(value),
  );
}

const postgresProofSnapshotWithoutDigestSchema = z.object({
  snapshotId: catalogManifestOperationIdSchema,
  snapshotSequence: positiveSnapshotSequenceSchema,
  evaluatedAt: timestampSchema,
  activeState: activeStateProofSchema,
  completedHeads: z.array(completedHeadProofSchema)
    .max(MAX_CATALOG_RETENTION_PLATFORM_COUNT),
  manifestProtections: z.array(
    catalogRetentionExternalManifestProtectionSchema,
  ).max(MAX_CATALOG_RETENTION_EXTERNAL_MANIFEST_PROTECTIONS),
  providerProtectionsByPlatform: z.array(
    externalProviderProtectionGroupSchema,
  ).max(MAX_CATALOG_RETENTION_PLATFORM_COUNT),
}).strict().superRefine((snapshot, context) => {
  if (!isStrictlyCanonical(snapshot.completedHeads, (proof) =>
    proof.platformKey)) {
    context.addIssue({
      code: "custom",
      path: ["completedHeads"],
      message: "catalog_retention.completed_heads_not_canonical",
    });
  }
  if (!isStrictlyCanonical(snapshot.manifestProtections, (protection) =>
    [
      protection.manifest.publicReleaseId,
      protection.reason,
      protection.operationProof.operationId,
    ].join("\n"))) {
    context.addIssue({
      code: "custom",
      path: ["manifestProtections"],
      message: "catalog_retention.manifest_protections_not_canonical",
    });
  }
  if (!isStrictlyCanonical(
    snapshot.providerProtectionsByPlatform,
    ({ platformKey }) => platformKey,
  )) {
    context.addIssue({
      code: "custom",
      path: ["providerProtectionsByPlatform"],
      message: "catalog_retention.provider_groups_not_canonical",
    });
  }
});

export const catalogRetentionPostgresProofSnapshotSchema =
  postgresProofSnapshotWithoutDigestSchema.extend({
    snapshotDigest: sha256Schema,
  }).strict().superRefine((snapshot, context) => {
    if (
      new TextEncoder().encode(canonicalJson(snapshot)).byteLength >
        MAX_CATALOG_RETENTION_POSTGRES_PROOF_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "catalog_retention.postgres_proof_too_large",
      });
    }
  });

const operationEnvelopeShape = {
  schemaVersion: z.literal(CATALOG_RETENTION_SCHEMA_VERSION),
  operationId: catalogManifestOperationIdSchema,
  idempotencyKey: catalogManifestIdempotencyKeySchema,
  expectedRetentionGeneration: nonNegativeSafeIntegerSchema,
  maximumDocuments: z.number().int().safe().positive()
    .max(MAX_CATALOG_RETENTION_ARTIFACT_DOCUMENTS),
  postgresProof: catalogRetentionPostgresProofSnapshotSchema,
} as const;

export const catalogRetentionManifestRequestSchema = z.object({
  ...operationEnvelopeShape,
  phase: z.literal("manifests"),
}).strict().superRefine((request, context) => {
  validateRetentionRequest(request, context);
  if (request.maximumDocuments < MIN_CATALOG_RETENTION_MANIFEST_DOCUMENTS) {
    context.addIssue({
      code: "custom",
      path: ["maximumDocuments"],
      message: "catalog_retention.manifest_document_limit_too_small",
    });
  }
});

export const catalogRetentionProviderRequestSchema = z.object({
  ...operationEnvelopeShape,
  phase: z.literal("provider_releases"),
  platformKey: providerCatalogPlatformKeyV1Schema,
}).strict().superRefine(validateRetentionRequest);

function validateRetentionRequest(
  request: unknown,
  context: z.RefinementCtx,
): void {
  if (
    new TextEncoder().encode(canonicalJson(request)).byteLength >
      MAX_CATALOG_RETENTION_HTTP_BODY_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "catalog_retention.request_too_large",
    });
  }
  if (containsProtectedCatalogRetentionField(request)) {
    context.addIssue({
      code: "custom",
      message: "catalog_retention.protected_field",
    });
  }
}

export const catalogRetentionMutationRequestSchema = z.union([
  catalogRetentionManifestRequestSchema,
  catalogRetentionProviderRequestSchema,
]);

export const catalogRetentionOperationKindSchema = z.enum([
  "retainManifests",
  "retainProviderReleases",
]);

export const catalogRetentionStatusTargetSchema = z.object({
  operationKind: catalogRetentionOperationKindSchema,
  operationId: catalogManifestOperationIdSchema,
  idempotencyKey: catalogManifestIdempotencyKeySchema,
  phase: z.enum(["manifests", "provider_releases"]),
  platformKey: providerCatalogPlatformKeyV1Schema.nullable(),
  requestDigest: sha256Schema,
}).strict().superRefine((target, context) => {
  if (
    (target.operationKind === "retainManifests") !==
      (target.phase === "manifests") ||
    (target.phase === "manifests") !== (target.platformKey === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "catalog_retention.status_target_invalid",
    });
  }
});

export const catalogRetentionStatusRequestSchema = z.object({
  schemaVersion: z.literal(CATALOG_RETENTION_SCHEMA_VERSION),
  target: catalogRetentionStatusTargetSchema,
}).strict().superRefine(validateRetentionRequest);

export const catalogRetentionRequestSchema = z.union([
  catalogRetentionMutationRequestSchema,
  catalogRetentionStatusRequestSchema,
]);

export const catalogRetentionManifestProtectionReasonSchema = z.enum([
  "active_manifest",
  "previous_manifest",
  "complete_allowance",
  "abandoned_allowance",
  "heat_reference",
  "in_flight_attempt",
  "rollback_recovery",
  "block_recovery",
]);

export const catalogRetentionProviderProtectionReasonSchema = z.enum([
  "retained_manifest_reference",
  "completed_head",
  "active_head",
  "complete_allowance",
  "abandoned_allowance",
  "in_flight_attempt",
  "rollback_recovery",
  "block_recovery",
]);

export const catalogRetentionProtectedManifestSchema = z.object({
  publicReleaseId: publicProviderReleaseIdV1Schema,
  manifestFingerprint: sha256Schema,
  lifecycle: z.enum(["staging", "complete", "failed"]),
  reasons: z.array(catalogRetentionManifestProtectionReasonSchema).min(1),
}).strict().superRefine((entry, context) => {
  if (!isStrictlyCanonical(entry.reasons, (reason) => reason)) {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "catalog_retention.manifest_reasons_not_canonical",
    });
  }
});

export const catalogRetentionProtectedProviderReleaseSchema = z.object({
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  providerReleaseFingerprint: sha256Schema,
  lifecycle: z.enum(["staging", "complete", "failed", "retired"]),
  reasons: z.array(catalogRetentionProviderProtectionReasonSchema).min(1),
}).strict().superRefine((entry, context) => {
  if (!isStrictlyCanonical(entry.reasons, (reason) => reason)) {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "catalog_retention.provider_reasons_not_canonical",
    });
  }
});

const protectedProviderReleaseGroupSchema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  releases: z.array(catalogRetentionProtectedProviderReleaseSchema)
    .max(MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM),
}).strict().superRefine((group, context) => {
  if (!isStrictlyCanonical(
    group.releases,
    ({ publicProviderReleaseId }) => publicProviderReleaseId,
  )) {
    context.addIssue({
      code: "custom",
      path: ["releases"],
      message: "catalog_retention.protected_releases_not_canonical",
    });
  }
});

export const catalogRetentionProtectionSetSchema = z.object({
  authoritativeEvaluationTime: timestampSchema,
  postgresProofSnapshotId: catalogManifestOperationIdSchema,
  postgresProofSnapshotSequence: positiveSnapshotSequenceSchema,
  postgresProofSnapshotDigest: sha256Schema,
  manifests: z.array(catalogRetentionProtectedManifestSchema)
    .max(MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS),
  providerReleasesByPlatform: z.array(protectedProviderReleaseGroupSchema)
    .max(MAX_CATALOG_RETENTION_PLATFORM_COUNT),
}).strict().superRefine((set, context) => {
  if (!isStrictlyCanonical(
    set.manifests,
    ({ publicReleaseId }) => publicReleaseId,
  )) {
    context.addIssue({
      code: "custom",
      path: ["manifests"],
      message: "catalog_retention.protected_manifests_not_canonical",
    });
  }
  if (!isStrictlyCanonical(
    set.providerReleasesByPlatform,
    ({ platformKey }) => platformKey,
  )) {
    context.addIssue({
      code: "custom",
      path: ["providerReleasesByPlatform"],
      message: "catalog_retention.protected_platforms_not_canonical",
    });
  }
  const protectedProviderReleaseCount = set.providerReleasesByPlatform.reduce(
    (count, group) => count + group.releases.length,
    0,
  );
  if (
    protectedProviderReleaseCount >
      MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerReleasesByPlatform"],
      message: "catalog_retention.protected_provider_release_aggregate_too_large",
    });
  }
});

const selectedManifestSchema = z.object({
  publicReleaseId: publicProviderReleaseIdV1Schema,
  manifestFingerprint: sha256Schema,
  lifecycle: z.enum(["staging", "complete", "failed"]),
}).strict();

const selectedProviderReleaseSchema = z.object({
  platformKey: providerCatalogPlatformKeyV1Schema,
  publicProviderReleaseId: publicProviderReleaseIdV1Schema,
  providerReleaseFingerprint: sha256Schema,
  lifecycle: z.enum(["staging", "complete", "failed", "retired"]),
}).strict();

const receiptBaseShape = {
  schemaVersion: z.literal(CATALOG_RETENTION_SCHEMA_VERSION),
  operationKind: catalogRetentionOperationKindSchema,
  operationId: catalogManifestOperationIdSchema,
  idempotencyKey: catalogManifestIdempotencyKeySchema,
  terminalState: z.enum(["complete", "continuation_required"]),
  result: z.literal("retained"),
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  receiptDigest: sha256Schema,
  expectedRetentionGeneration: nonNegativeSafeIntegerSchema,
  retentionGeneration: z.number().int().safe().positive(),
} as const;

const progressShape = {
  maximumDocuments: z.number().int().safe().positive()
    .max(MAX_CATALOG_RETENTION_ARTIFACT_DOCUMENTS),
  deletedDocumentCount: nonNegativeSafeIntegerSchema
    .max(MAX_CATALOG_RETENTION_DOCUMENTS_PER_MUTATION),
  deletedRetentionOperationCount: nonNegativeSafeIntegerSchema
    .max(MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS),
  hasMore: z.boolean(),
  protectionSet: catalogRetentionProtectionSetSchema,
} as const;

export const catalogRetentionManifestReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("retainManifests"),
  phase: z.literal("manifests"),
  platformKey: z.null(),
  details: z.object({
    ...progressShape,
    selectedManifest: selectedManifestSchema.nullable(),
    deletedManifestCount: nonNegativeSafeIntegerSchema.max(1),
    deletedManifestReferenceCount: nonNegativeSafeIntegerSchema,
  }).strict(),
}).strict().superRefine(validateManifestReceipt);

export const catalogRetentionProviderReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("retainProviderReleases"),
  phase: z.literal("provider_releases"),
  platformKey: providerCatalogPlatformKeyV1Schema,
  details: z.object({
    ...progressShape,
    manifestPhaseComplete: z.literal(true),
    selectedProviderRelease: selectedProviderReleaseSchema.nullable(),
    deletedProviderReleaseCount: nonNegativeSafeIntegerSchema.max(1),
    deletedProviderOwnedDocumentCount: nonNegativeSafeIntegerSchema,
  }).strict(),
}).strict().superRefine(validateProviderReceipt);

function validateReceiptBase(
  receipt: Readonly<{
    terminalState: "complete" | "continuation_required";
    expectedRetentionGeneration: number;
    retentionGeneration: number;
    details: Readonly<{
      deletedDocumentCount: number;
      deletedRetentionOperationCount: number;
      hasMore: boolean;
    }>;
  }>,
  context: z.RefinementCtx,
): void {
  if (
    new TextEncoder().encode(canonicalJson(receipt)).byteLength >
      MAX_CATALOG_RETENTION_HTTP_BODY_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "catalog_retention.receipt_too_large",
    });
  }
  if (
    receipt.retentionGeneration !==
      receipt.expectedRetentionGeneration + 1 ||
    (receipt.terminalState === "continuation_required") !==
      receipt.details.hasMore
  ) {
    context.addIssue({
      code: "custom",
      message: "catalog_retention.progress_invalid",
    });
  }
}

function validateManifestReceipt(
  receipt: z.infer<typeof catalogRetentionManifestReceiptSchema>,
  context: z.RefinementCtx,
): void {
  validateReceiptBase(receipt, context);
  const details = receipt.details;
  if (
    details.deletedDocumentCount !==
      details.deletedRetentionOperationCount +
        details.deletedManifestCount +
        details.deletedManifestReferenceCount ||
    (details.deletedManifestCount === 0) !==
      (details.selectedManifest === null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "deletedDocumentCount"],
      message: "catalog_retention.manifest_count_mismatch",
    });
  }
}

function validateProviderReceipt(
  receipt: z.infer<typeof catalogRetentionProviderReceiptSchema>,
  context: z.RefinementCtx,
): void {
  validateReceiptBase(receipt, context);
  const details = receipt.details;
  if (
    details.deletedDocumentCount !==
      details.deletedRetentionOperationCount +
        details.deletedProviderOwnedDocumentCount ||
    details.deletedProviderReleaseCount >
      details.deletedProviderOwnedDocumentCount ||
    (details.selectedProviderRelease === null &&
      details.deletedProviderOwnedDocumentCount !== 0)
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "deletedDocumentCount"],
      message: "catalog_retention.provider_count_mismatch",
    });
  }
}

export const catalogRetentionReceiptSchema = z.union([
  catalogRetentionManifestReceiptSchema,
  catalogRetentionProviderReceiptSchema,
]);

export const catalogRetentionStatusNotFoundReceiptSchema = z.object({
  schemaVersion: z.literal(CATALOG_RETENTION_SCHEMA_VERSION),
  target: catalogRetentionStatusTargetSchema,
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
      message: "catalog_retention.status_digest_mismatch",
    });
  }
});

export const catalogRetentionSignedReceiptEnvelopeSchema = z.object({
  ok: z.literal(true),
  receipt: z.union([
    catalogRetentionReceiptSchema,
    catalogRetentionStatusNotFoundReceiptSchema,
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
    envelope.receipt.receiptDigest !== envelope.responseAuth.receiptDigest
  ) {
    context.addIssue({
      code: "custom",
      path: ["responseAuth", "receiptDigest"],
      message: "catalog_retention.response_digest_mismatch",
    });
  }
});

export const CATALOG_RETENTION_ERROR_CODES = [
  "CATALOG_RETENTION_AUTH_MISSING",
  "CATALOG_RETENTION_AUTH_KEY_UNKNOWN",
  "CATALOG_RETENTION_AUTH_INVALID",
  "CATALOG_RETENTION_AUTH_STALE",
  "CATALOG_RETENTION_AUTH_REPLAYED",
  "CATALOG_RETENTION_AUTH_FORBIDDEN",
  "CATALOG_RETENTION_BODY_TOO_LARGE",
  "CATALOG_RETENTION_SCHEMA_UNSUPPORTED",
  "CATALOG_RETENTION_REQUEST_INVALID",
  "CATALOG_RETENTION_PROTECTED_FIELD",
  "CATALOG_RETENTION_OPERATION_CONFLICT",
  "CATALOG_RETENTION_STATE_CONFLICT",
  "CATALOG_RETENTION_PREDECESSOR_CONFLICT",
  "CATALOG_RETENTION_PROOF_INCOMPLETE",
  "CATALOG_RETENTION_REFERENCE_INVALID",
  "CATALOG_RETENTION_RETENTION_UNSAFE",
  "CATALOG_RETENTION_INTERNAL_ERROR",
] as const;

export const catalogRetentionErrorCodeSchema = z.enum(
  CATALOG_RETENTION_ERROR_CODES,
);

export const catalogRetentionErrorEnvelopeSchema = z.object({
  error: z.string().min(1).max(256),
  code: catalogRetentionErrorCodeSchema,
}).strict();

export type CatalogRetentionActiveStateProof = z.infer<
  typeof activeStateProofSchema
>;
export type CatalogRetentionCompletedHeadProof = z.infer<
  typeof completedHeadProofSchema
>;
export type CatalogRetentionManifestOperationProof = z.infer<
  typeof catalogRetentionManifestOperationProofSchema
>;
export type CatalogRetentionProviderOperationProof = z.infer<
  typeof catalogRetentionProviderOperationProofSchema
>;
export type CatalogRetentionExternalManifestProtection = z.infer<
  typeof catalogRetentionExternalManifestProtectionSchema
>;
export type CatalogRetentionProviderReleaseIdentity = z.infer<
  typeof catalogRetentionProviderReleaseIdentitySchema
>;
export type CatalogRetentionExternalProviderProtection = z.infer<
  typeof catalogRetentionExternalProviderProtectionSchema
>;
export type CatalogRetentionPostgresProofSnapshot = z.infer<
  typeof catalogRetentionPostgresProofSnapshotSchema
>;
export type CatalogRetentionManifestRequest = z.infer<
  typeof catalogRetentionManifestRequestSchema
>;
export type CatalogRetentionProviderRequest = z.infer<
  typeof catalogRetentionProviderRequestSchema
>;
export type CatalogRetentionMutationRequest = z.infer<
  typeof catalogRetentionMutationRequestSchema
>;
export type CatalogRetentionOperationKind = z.infer<
  typeof catalogRetentionOperationKindSchema
>;
export type CatalogRetentionStatusTarget = z.infer<
  typeof catalogRetentionStatusTargetSchema
>;
export type CatalogRetentionStatusRequest = z.infer<
  typeof catalogRetentionStatusRequestSchema
>;
export type CatalogRetentionRequest = z.infer<
  typeof catalogRetentionRequestSchema
>;
export type CatalogRetentionManifestProtectionReason = z.infer<
  typeof catalogRetentionManifestProtectionReasonSchema
>;
export type CatalogRetentionProviderProtectionReason = z.infer<
  typeof catalogRetentionProviderProtectionReasonSchema
>;
export type CatalogRetentionProtectionSet = z.infer<
  typeof catalogRetentionProtectionSetSchema
>;
export type CatalogRetentionManifestReceipt = z.infer<
  typeof catalogRetentionManifestReceiptSchema
>;
export type CatalogRetentionProviderReceipt = z.infer<
  typeof catalogRetentionProviderReceiptSchema
>;
export type CatalogRetentionReceipt = z.infer<
  typeof catalogRetentionReceiptSchema
>;
export type CatalogRetentionStatusNotFoundReceipt = z.infer<
  typeof catalogRetentionStatusNotFoundReceiptSchema
>;
export type CatalogRetentionSignedReceiptEnvelope = z.infer<
  typeof catalogRetentionSignedReceiptEnvelopeSchema
>;
export type CatalogRetentionErrorCode = z.infer<
  typeof catalogRetentionErrorCodeSchema
>;
export type CatalogRetentionErrorEnvelope = z.infer<
  typeof catalogRetentionErrorEnvelopeSchema
>;

export function containsProtectedCatalogRetentionField(
  value: unknown,
): boolean {
  return containsProtectedProviderReleasePublicationField(value) ||
    containsFieldNamed(value, new Set([
      "deployment",
      "deploymentid",
      "deploymentkey",
    ]));
}

function containsFieldNamed(
  value: unknown,
  names: ReadonlySet<string>,
): boolean {
  if (Array.isArray(value)) {
    return value.some((nested) => containsFieldNamed(nested, names));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, nested]) =>
    names.has(key.toLowerCase().replace(/[^a-z0-9]/gu, "")) ||
    containsFieldNamed(nested, names)
  );
}

export async function catalogRetentionPostgresProofSnapshotDigest(
  snapshot: Omit<CatalogRetentionPostgresProofSnapshot, "snapshotDigest"> |
    CatalogRetentionPostgresProofSnapshot,
): Promise<string> {
  const { snapshotDigest: _snapshotDigest, ...proof } = snapshot as
    CatalogRetentionPostgresProofSnapshot;
  void _snapshotDigest;
  return await sha256CanonicalJson(
    CATALOG_RETENTION_POSTGRES_PROOF_HASH_DOMAIN,
    proof,
  );
}

export async function catalogRetentionPublicationRequestDigest(
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

export function catalogRetentionReceiptDigest(value: unknown): Promise<string> {
  return sha256CanonicalJson(
    CATALOG_RETENTION_RECEIPT_HASH_DOMAIN,
    withoutReceiptDigest(value),
  );
}

export async function catalogRetentionTerminalReceiptSha256(
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

export function parseCatalogRetentionPublicationJson<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T | null {
  if (
    new TextEncoder().encode(bodyJson).byteLength >
      MAX_CATALOG_RETENTION_HTTP_BODY_BYTES
  ) return null;
  try {
    const value = JSON.parse(bodyJson) as unknown;
    if (containsProtectedCatalogRetentionField(value)) return null;
    const parsed = schema.parse(value);
    return bodyJson === canonicalJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRetryableCatalogRetentionError(
  code: CatalogRetentionErrorCode,
): boolean {
  return code === "CATALOG_RETENTION_AUTH_STALE" ||
    code === "CATALOG_RETENTION_INTERNAL_ERROR";
}

export function classifyCatalogRetentionError(
  code: CatalogRetentionErrorCode,
): "bounded_retry" | "authentication" | "terminal" {
  if (isRetryableCatalogRetentionError(code)) return "bounded_retry";
  if (code.startsWith("CATALOG_RETENTION_AUTH_")) return "authentication";
  return "terminal";
}
