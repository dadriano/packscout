import { z } from "zod";
import { PRODUCTION_DATA_RELEASE_PATHS } from "./data-release-v2-publication.ts";

export const PRODUCTION_AUTH_SIGNATURE_VERSION = "v1" as const;
export const PRODUCTION_AUTH_WINDOW_MILLISECONDS = 5 * 60 * 1_000;
export const PRODUCTION_AUTH_NONCE_RETENTION_MILLISECONDS = 10 * 60 * 1_000;
export const MIN_PRODUCTION_AUTH_SECRET_BYTES = 32;
export const MAX_PRODUCTION_AUTH_SECRET_BYTES = 256;
export const PRODUCTION_AUTH_NONCE_HASH_DOMAIN =
  "packscout.data-release.auth-nonce.v1" as const;

export const PRODUCTION_AUTH_HEADER_NAMES = Object.freeze({
  signatureVersion: "x-packscout-signature-version",
  keyId: "x-packscout-key-id",
  timestamp: "x-packscout-timestamp",
  nonce: "x-packscout-nonce",
  contentSha256: "x-packscout-content-sha256",
  signature: "x-packscout-signature",
});

export const PRODUCTION_AUTH_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const PRODUCTION_AUTH_KEY_ID_PATTERN =
  /^(?=.{4,64}$)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,54})[._-]v[1-9][0-9]*$/u;
export const PRODUCTION_AUTH_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
export const PRODUCTION_AUTH_TIMESTAMP_PATTERN = /^\d{13}$/u;

export const productionAuthKeyIdSchema = z.string()
  .regex(PRODUCTION_AUTH_KEY_ID_PATTERN);
export const productionAuthNonceSchema = z.string()
  .regex(PRODUCTION_AUTH_NONCE_PATTERN);
export const productionAuthTimestampSchema = z.string()
  .regex(PRODUCTION_AUTH_TIMESTAMP_PATTERN)
  .refine((value) => Number.isSafeInteger(Number(value)));
export const productionDataReleasePathSchema = z.enum([
  PRODUCTION_DATA_RELEASE_PATHS.start,
  PRODUCTION_DATA_RELEASE_PATHS.applyBatch,
  PRODUCTION_DATA_RELEASE_PATHS.finalize,
  PRODUCTION_DATA_RELEASE_PATHS.status,
  PRODUCTION_DATA_RELEASE_PATHS.refreshObservation,
  PRODUCTION_DATA_RELEASE_PATHS.rollback,
  PRODUCTION_DATA_RELEASE_PATHS.retain,
]);

export type ProductionDataReleasePath = z.infer<
  typeof productionDataReleasePathSchema
>;

export function productionPublicationRequestSigningValue(input: Readonly<{
  method: "POST" | "post";
  path: ProductionDataReleasePath;
  bodyDigest: string;
  timestamp: string;
  nonce: string;
}>): string {
  return [
    PRODUCTION_AUTH_SIGNATURE_VERSION,
    input.method.toUpperCase(),
    input.path,
    input.bodyDigest,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

export function productionPublicationReceiptSigningValue(
  receiptDigest: string,
): string {
  return [
    PRODUCTION_AUTH_SIGNATURE_VERSION,
    "receipt",
    receiptDigest,
  ].join("\n");
}

export type ProductionDataReleaseErrorCode =
  | "PUBLICATION_AUTH_MISSING" | "PUBLICATION_AUTH_KEY_UNKNOWN"
  | "PUBLICATION_AUTH_INVALID" | "PUBLICATION_AUTH_STALE"
  | "PUBLICATION_AUTH_REPLAYED" | "PUBLICATION_BODY_TOO_LARGE"
  | "PUBLICATION_SCHEMA_UNSUPPORTED" | "PUBLICATION_REQUEST_INVALID"
  | "PUBLICATION_OPERATION_CONFLICT" | "PUBLICATION_STATE_CONFLICT"
  | "PUBLICATION_PREDECESSOR_CONFLICT" | "PUBLICATION_SEQUENCE_REGRESSED"
  | "PUBLICATION_MANIFEST_BLOCKED" | "PUBLICATION_MANIFEST_MISMATCH"
  | "PUBLICATION_BATCH_CONFLICT" | "PUBLICATION_BATCH_OUT_OF_ORDER"
  | "PUBLICATION_BATCH_TOO_LARGE" | "PUBLICATION_ENTITY_INVALID"
  | "PUBLICATION_REFERENCE_INVALID" | "PUBLICATION_PROTECTED_FIELD"
  | "PUBLICATION_RECONCILIATION_FAILED" | "PUBLICATION_REFRESH_STALE"
  | "PUBLICATION_ROLLBACK_UNSAFE" | "PUBLICATION_CLEAR_DISABLED"
  | "PUBLICATION_RETENTION_UNSAFE" | "PUBLICATION_INTERNAL_ERROR";

export const productionDataReleaseErrorCodeSchema = z.enum([
  "PUBLICATION_AUTH_MISSING", "PUBLICATION_AUTH_KEY_UNKNOWN",
  "PUBLICATION_AUTH_INVALID", "PUBLICATION_AUTH_STALE",
  "PUBLICATION_AUTH_REPLAYED", "PUBLICATION_BODY_TOO_LARGE",
  "PUBLICATION_SCHEMA_UNSUPPORTED", "PUBLICATION_REQUEST_INVALID",
  "PUBLICATION_OPERATION_CONFLICT", "PUBLICATION_STATE_CONFLICT",
  "PUBLICATION_PREDECESSOR_CONFLICT", "PUBLICATION_SEQUENCE_REGRESSED",
  "PUBLICATION_MANIFEST_BLOCKED", "PUBLICATION_MANIFEST_MISMATCH",
  "PUBLICATION_BATCH_CONFLICT", "PUBLICATION_BATCH_OUT_OF_ORDER",
  "PUBLICATION_BATCH_TOO_LARGE", "PUBLICATION_ENTITY_INVALID",
  "PUBLICATION_REFERENCE_INVALID", "PUBLICATION_PROTECTED_FIELD",
  "PUBLICATION_RECONCILIATION_FAILED", "PUBLICATION_REFRESH_STALE",
  "PUBLICATION_ROLLBACK_UNSAFE", "PUBLICATION_CLEAR_DISABLED",
  "PUBLICATION_RETENTION_UNSAFE", "PUBLICATION_INTERNAL_ERROR",
]);

export const productionErrorEnvelopeSchema = z.object({
  error: z.string().min(1).max(256),
  code: productionDataReleaseErrorCodeSchema,
}).strict();

export type ProductionErrorEnvelope = z.infer<
  typeof productionErrorEnvelopeSchema
>;

export function isRetryableProductionDataReleaseError(
  code: ProductionDataReleaseErrorCode,
): boolean {
  return code === "PUBLICATION_AUTH_STALE" ||
    code === "PUBLICATION_INTERNAL_ERROR";
}

export function classifyProductionDataReleaseError(
  code: ProductionDataReleaseErrorCode,
): "bounded_retry" | "authentication" | "terminal" {
  if (isRetryableProductionDataReleaseError(code)) return "bounded_retry";
  if (code.startsWith("PUBLICATION_AUTH_")) return "authentication";
  return "terminal";
}
