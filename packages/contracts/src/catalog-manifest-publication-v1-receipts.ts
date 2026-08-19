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
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  activeCatalogManifestStateCoreV1Schema,
  activeCatalogManifestStateV1Schema,
  catalogManifestBlockReasonV1Schema,
  catalogManifestIdempotencyKeySchema,
  catalogManifestOperationIdSchema,
  catalogManifestStatusTargetSchema,
  globalCatalogManifestPointerV1Schema,
} from "./catalog-manifest-publication-v1.ts";
import {
  publicProviderReleaseIdV1Schema,
  providerCatalogSequenceV1Schema,
} from "./provider-catalog-release-v1.ts";

export const CATALOG_MANIFEST_RECEIPT_HASH_DOMAIN =
  "packscout.catalog-manifest-publication.receipt.v1" as const;
export const MAX_CATALOG_MANIFEST_RECEIPT_BYTES = 256 * 1_024;

export const catalogManifestOperationKindSchema = z.enum([
  "activeState",
  "activateManifest",
  "refreshActiveState",
  "rollback",
  "block",
]);

const receiptBaseShape = {
  schemaVersion: z.literal(CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION),
  operationId: catalogManifestOperationIdSchema,
  idempotencyKey: catalogManifestIdempotencyKeySchema,
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  receiptDigest: sha256Schema,
} as const;

const observedReceiptBaseShape = {
  schemaVersion: z.literal(CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION),
  operationId: catalogManifestOperationIdSchema,
  serverTime: timestampSchema,
  requestDigest: sha256Schema,
  receiptDigest: sha256Schema,
} as const;

export const catalogManifestActiveStateReceiptSchema = z.object({
  ...observedReceiptBaseShape,
  operationKind: z.literal("activeState"),
  terminalState: z.literal("observed"),
  result: z.literal("active_state"),
  details: z.object({
    activeState: activeCatalogManifestStateV1Schema,
  }).strict(),
}).strict();

const manifestReceiptBaseShape = {
  ...receiptBaseShape,
  publicReleaseId: publicProviderReleaseIdV1Schema,
  manifestFingerprint: sha256Schema,
} as const;

const transitionDetailsShape = {
  expectedActiveState: activeCatalogManifestStateV1Schema,
  activeState: activeCatalogManifestStateCoreV1Schema,
} as const;

type TransitionReceipt = Readonly<{
  publicReleaseId: string;
  manifestFingerprint: string;
  details: Readonly<{
    expectedActiveState: z.infer<typeof activeCatalogManifestStateV1Schema>;
    activeState: z.infer<typeof activeCatalogManifestStateCoreV1Schema>;
  }>;
}>;

function samePointer(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateTransitionGeneration(
  receipt: TransitionReceipt,
  context: z.RefinementCtx,
): void {
  if (
    receipt.details.activeState.generation !==
      receipt.details.expectedActiveState.generation + 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "activeState", "generation"],
      message: "catalog_manifest_publication.generation_not_advanced",
    });
  }
}

function validateActiveReceiptIdentity(
  receipt: TransitionReceipt,
  context: z.RefinementCtx,
): void {
  const active = receipt.details.activeState.activeManifest;
  if (
    active === null ||
    active.publicReleaseId !== receipt.publicReleaseId ||
    active.manifestFingerprint !== receipt.manifestFingerprint
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "activeState", "activeManifest"],
      message: "catalog_manifest_publication.receipt_manifest_mismatch",
    });
  }
}

export const catalogManifestActivationReceiptSchema = z.object({
  ...manifestReceiptBaseShape,
  operationKind: z.literal("activateManifest"),
  terminalState: z.literal("complete"),
  result: z.literal("activated"),
  details: z.object(transitionDetailsShape).strict(),
}).strict().superRefine((receipt, context) => {
  validateTransitionGeneration(receipt, context);
  validateActiveReceiptIdentity(receipt, context);
  const expected = receipt.details.expectedActiveState;
  const result = receipt.details.activeState;
  if (
    expected.activeManifest?.publicReleaseId === receipt.publicReleaseId ||
    !samePointer(result.previousManifest, expected.activeManifest)
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "activeState", "previousManifest"],
      message: "catalog_manifest_publication.activation_predecessor_mismatch",
    });
  }
});

export const catalogManifestRefreshReceiptSchema = z.object({
  ...manifestReceiptBaseShape,
  operationKind: z.literal("refreshActiveState"),
  terminalState: z.literal("complete"),
  result: z.literal("refreshed"),
  details: z.object(transitionDetailsShape).strict(),
}).strict().superRefine((receipt, context) => {
  validateTransitionGeneration(receipt, context);
  validateActiveReceiptIdentity(receipt, context);
  const expected = receipt.details.expectedActiveState;
  const result = receipt.details.activeState;
  if (
    expected.activeManifest === null || result.activeManifest === null ||
    !samePointer(result.activeManifest, expected.activeManifest) ||
    !samePointer(result.previousManifest, expected.previousManifest) ||
    result.observation === null || expected.observation === null ||
    result.observation.observationSequence <=
      expected.observation.observationSequence
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "activeState"],
      message: "catalog_manifest_publication.refresh_transition_invalid",
    });
  }
});

export const catalogManifestRollbackReceiptSchema = z.object({
  ...manifestReceiptBaseShape,
  operationKind: z.literal("rollback"),
  rollbackKind: z.literal("manifest"),
  terminalState: z.literal("complete"),
  result: z.literal("rolled_back"),
  details: z.object({
    ...transitionDetailsShape,
    outgoingManifestBlocked: z.boolean(),
  }).strict(),
}).strict().superRefine((receipt, context) => {
  validateTransitionGeneration(receipt, context);
  validateActiveReceiptIdentity(receipt, context);
  const expected = receipt.details.expectedActiveState;
  const result = receipt.details.activeState;
  if (
    expected.activeManifest === null ||
    result.activeManifest === null ||
    expected.activeManifest.publicReleaseId === receipt.publicReleaseId ||
    (receipt.details.outgoingManifestBlocked
      ? result.previousManifest !== null
      : !samePointer(result.previousManifest, expected.activeManifest)) ||
    result.observation === null ||
    (expected.observation !== null &&
      result.observation.observationSequence <=
        expected.observation.observationSequence)
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "activeState"],
      message: "catalog_manifest_publication.rollback_transition_invalid",
    });
  }
});

export const catalogManifestClearReceiptSchema = z.object({
  ...receiptBaseShape,
  operationKind: z.literal("rollback"),
  rollbackKind: z.literal("clear"),
  publicReleaseId: z.null(),
  manifestFingerprint: z.null(),
  terminalState: z.literal("cleared"),
  result: z.literal("cleared"),
  details: z.object(transitionDetailsShape).strict(),
}).strict().superRefine((receipt, context) => {
  const expected = receipt.details.expectedActiveState;
  const result = receipt.details.activeState;
  if (
    expected.activeManifest === null ||
    result.generation !== expected.generation + 1 ||
    result.activeManifest !== null ||
    result.previousManifest !== null ||
    result.observation !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["details", "activeState"],
      message: "catalog_manifest_publication.clear_transition_invalid",
    });
  }
});

export const catalogManifestBlockReceiptSchema = z.object({
  ...manifestReceiptBaseShape,
  operationKind: z.literal("block"),
  terminalState: z.literal("blocked"),
  result: z.literal("blocked"),
  details: z.object({
    blockSequence: providerCatalogSequenceV1Schema,
    reason: catalogManifestBlockReasonV1Schema,
  }).strict(),
}).strict();

export const catalogManifestReceiptSchema = z.union([
  catalogManifestActiveStateReceiptSchema,
  catalogManifestActivationReceiptSchema,
  catalogManifestRefreshReceiptSchema,
  catalogManifestRollbackReceiptSchema,
  catalogManifestClearReceiptSchema,
  catalogManifestBlockReceiptSchema,
]);

export const catalogManifestStatusNotFoundReceiptSchema = z.object({
  schemaVersion: z.literal(CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION),
  target: catalogManifestStatusTargetSchema,
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
      message: "catalog_manifest_publication.status_digest_mismatch",
    });
  }
});

export const catalogManifestSignedReceiptEnvelopeSchema = z.object({
  ok: z.literal(true),
  receipt: z.union([
    catalogManifestReceiptSchema,
    catalogManifestStatusNotFoundReceiptSchema,
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
      message: "catalog_manifest_publication.response_digest_mismatch",
    });
  }
});

export const CATALOG_MANIFEST_ERROR_CODES = [
  "CATALOG_MANIFEST_AUTH_MISSING",
  "CATALOG_MANIFEST_AUTH_KEY_UNKNOWN",
  "CATALOG_MANIFEST_AUTH_INVALID",
  "CATALOG_MANIFEST_AUTH_STALE",
  "CATALOG_MANIFEST_AUTH_REPLAYED",
  "CATALOG_MANIFEST_AUTH_FORBIDDEN",
  "CATALOG_MANIFEST_BODY_TOO_LARGE",
  "CATALOG_MANIFEST_SCHEMA_UNSUPPORTED",
  "CATALOG_MANIFEST_REQUEST_INVALID",
  "CATALOG_MANIFEST_PROTECTED_FIELD",
  "CATALOG_MANIFEST_OPERATION_CONFLICT",
  "CATALOG_MANIFEST_STATE_CONFLICT",
  "CATALOG_MANIFEST_PREDECESSOR_CONFLICT",
  "CATALOG_MANIFEST_IDENTITY_MISMATCH",
  "CATALOG_MANIFEST_FINGERPRINT_BLOCKED",
  "CATALOG_MANIFEST_MANIFEST_BLOCKED",
  "CATALOG_MANIFEST_BLOCK_SEQUENCE_REGRESSED",
  "CATALOG_MANIFEST_PLATFORM_SET_MISMATCH",
  "CATALOG_MANIFEST_PLATFORM_DISABLED",
  "CATALOG_MANIFEST_PROVIDER_RELEASE_MISSING",
  "CATALOG_MANIFEST_PROVIDER_RELEASE_INCOMPLETE",
  "CATALOG_MANIFEST_PROVIDER_RELEASE_BLOCKED",
  "CATALOG_MANIFEST_PROVIDER_RELEASE_INVALID",
  "CATALOG_MANIFEST_PROVIDER_REFERENCE_MISMATCH",
  "CATALOG_MANIFEST_CONFIGURATION_EPOCH_CONFLICT",
  "CATALOG_MANIFEST_EPOCH_CONFLICT",
  "CATALOG_MANIFEST_BACKFILL_INCOMPLETE",
  "CATALOG_MANIFEST_DERIVATION_UNSETTLED",
  "CATALOG_MANIFEST_ELIGIBILITY_INCOMPLETE",
  "CATALOG_MANIFEST_REFERENCE_SET_UNCHANGED",
  "CATALOG_MANIFEST_AGGREGATE_LIMIT_EXCEEDED",
  "CATALOG_MANIFEST_COUNT_MISMATCH",
  "CATALOG_MANIFEST_HASH_MISMATCH",
  "CATALOG_MANIFEST_CONTENT_INVALID",
  "CATALOG_MANIFEST_SEARCH_INVALID",
  "CATALOG_MANIFEST_REFERENCE_INVALID",
  "CATALOG_MANIFEST_OWNERSHIP_MISMATCH",
  "CATALOG_MANIFEST_OBSERVATION_STALE",
  "CATALOG_MANIFEST_REFRESH_STALE",
  "CATALOG_MANIFEST_FRESHNESS_INVALID",
  "CATALOG_MANIFEST_ROLLBACK_UNSAFE",
  "CATALOG_MANIFEST_CLEAR_UNAUTHORIZED",
  "CATALOG_MANIFEST_RECONCILIATION_FAILED",
  "CATALOG_MANIFEST_INTERNAL_ERROR",
] as const;

export const catalogManifestErrorCodeSchema = z.enum(
  CATALOG_MANIFEST_ERROR_CODES,
);

export const catalogManifestErrorEnvelopeSchema = z.object({
  error: z.string().min(1).max(256),
  code: catalogManifestErrorCodeSchema,
}).strict();

export type CatalogManifestOperationKind = z.infer<
  typeof catalogManifestOperationKindSchema
>;
export type CatalogManifestActiveStateReceipt = z.infer<
  typeof catalogManifestActiveStateReceiptSchema
>;
export type CatalogManifestActivationReceipt = z.infer<
  typeof catalogManifestActivationReceiptSchema
>;
export type CatalogManifestRefreshReceipt = z.infer<
  typeof catalogManifestRefreshReceiptSchema
>;
export type CatalogManifestRollbackReceipt = z.infer<
  typeof catalogManifestRollbackReceiptSchema
>;
export type CatalogManifestClearReceipt = z.infer<
  typeof catalogManifestClearReceiptSchema
>;
export type CatalogManifestBlockReceipt = z.infer<
  typeof catalogManifestBlockReceiptSchema
>;
export type CatalogManifestReceipt = z.infer<
  typeof catalogManifestReceiptSchema
>;
export type CatalogManifestStatusNotFoundReceipt = z.infer<
  typeof catalogManifestStatusNotFoundReceiptSchema
>;
export type CatalogManifestSignedReceiptEnvelope = z.infer<
  typeof catalogManifestSignedReceiptEnvelopeSchema
>;
export type CatalogManifestErrorCode = z.infer<
  typeof catalogManifestErrorCodeSchema
>;
export type CatalogManifestErrorEnvelope = z.infer<
  typeof catalogManifestErrorEnvelopeSchema
>;

export function isRetryableCatalogManifestError(
  code: CatalogManifestErrorCode,
): boolean {
  return code === "CATALOG_MANIFEST_AUTH_STALE" ||
    code === "CATALOG_MANIFEST_INTERNAL_ERROR";
}

export function classifyCatalogManifestError(
  code: CatalogManifestErrorCode,
): "bounded_retry" | "authentication" | "terminal" {
  if (isRetryableCatalogManifestError(code)) return "bounded_retry";
  if (code.startsWith("CATALOG_MANIFEST_AUTH_")) return "authentication";
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

export function catalogManifestReceiptDigest(value: unknown): Promise<string> {
  return sha256CanonicalJson(
    CATALOG_MANIFEST_RECEIPT_HASH_DOMAIN,
    withoutReceiptDigest(value),
  );
}

export async function catalogManifestTerminalReceiptSha256(
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

export function catalogManifestReceiptCanonicalByteCount(
  receipt: unknown,
): number {
  return new TextEncoder().encode(canonicalJson(receipt)).byteLength;
}

export { globalCatalogManifestPointerV1Schema };
