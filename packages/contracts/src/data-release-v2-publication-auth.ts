import { z } from "zod";
import { PRODUCTION_DATA_RELEASE_PATHS } from "./data-release-v2-publication.ts";
import { PRODUCTION_REPACK_HEAT_PATHS } from "./repack-heat-publication.ts";
import { PRODUCTION_PROVIDER_RELEASE_PATHS } from "./provider-release-publication-v1.ts";
import { PRODUCTION_CATALOG_MANIFEST_PATHS } from "./catalog-manifest-publication-v1.ts";
import { PRODUCTION_CATALOG_RETENTION_PATHS } from "./catalog-retention-v1-paths.ts";
import { PRODUCTION_DATA_RELEASE_V3_PATHS } from "./data-release-v3-publication-paths.ts";

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
export const PRODUCTION_AUTH_CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export const productionAuthKeyIdSchema = z.string()
  .regex(PRODUCTION_AUTH_KEY_ID_PATTERN);
export const productionAuthNonceSchema = z.string()
  .regex(PRODUCTION_AUTH_NONCE_PATTERN);
export const productionAuthTimestampSchema = z.string()
  .regex(PRODUCTION_AUTH_TIMESTAMP_PATTERN)
  .refine((value) => Number.isSafeInteger(Number(value)));

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeProductionAuthSecretBase64(
  value: string,
): Uint8Array | null {
  if (
    value.length === 0 ||
    value.length > 344 ||
    !PRODUCTION_AUTH_CANONICAL_BASE64_PATTERN.test(value)
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = BASE64_ALPHABET.indexOf(value[offset]!);
    const second = BASE64_ALPHABET.indexOf(value[offset + 1]!);
    const third = value[offset + 2] === "="
      ? 0
      : BASE64_ALPHABET.indexOf(value[offset + 2]!);
    const fourth = value[offset + 3] === "="
      ? 0
      : BASE64_ALPHABET.indexOf(value[offset + 3]!);
    const packed = (first << 18) | (second << 12) | (third << 6) | fourth;
    if (outputIndex < output.length) output[outputIndex++] = packed >>> 16;
    if (outputIndex < output.length) output[outputIndex++] = packed >>> 8;
    if (outputIndex < output.length) output[outputIndex++] = packed;
  }
  const lastCompleteOffset = value.length - 4;
  const secondLast = BASE64_ALPHABET.indexOf(value[lastCompleteOffset + 1]!);
  const thirdLast = value[lastCompleteOffset + 2] === "="
    ? 0
    : BASE64_ALPHABET.indexOf(value[lastCompleteOffset + 2]!);
  if (
    (padding === 2 && (secondLast & 0x0f) !== 0) ||
    (padding === 1 && (thirdLast & 0x03) !== 0)
  ) {
    return null;
  }
  return output;
}
export const productionDataReleasePathSchema = z.enum([
  PRODUCTION_DATA_RELEASE_PATHS.activeState,
  PRODUCTION_DATA_RELEASE_PATHS.start,
  PRODUCTION_DATA_RELEASE_PATHS.applyBatch,
  PRODUCTION_DATA_RELEASE_PATHS.finalize,
  PRODUCTION_DATA_RELEASE_PATHS.status,
  PRODUCTION_DATA_RELEASE_PATHS.refreshObservation,
  PRODUCTION_DATA_RELEASE_PATHS.rollback,
  PRODUCTION_DATA_RELEASE_PATHS.retain,
]);

export const productionRepackHeatPathSchema = z.enum([
  PRODUCTION_REPACK_HEAT_PATHS.activeState,
  PRODUCTION_REPACK_HEAT_PATHS.start,
  PRODUCTION_REPACK_HEAT_PATHS.applyBatch,
  PRODUCTION_REPACK_HEAT_PATHS.finalize,
  PRODUCTION_REPACK_HEAT_PATHS.status,
  PRODUCTION_REPACK_HEAT_PATHS.refreshFrame,
  PRODUCTION_REPACK_HEAT_PATHS.retain,
]);

export const productionProviderReleasePathSchema = z.enum([
  PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
  PRODUCTION_PROVIDER_RELEASE_PATHS.start,
  PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
  PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
  PRODUCTION_PROVIDER_RELEASE_PATHS.status,
  PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
  PRODUCTION_PROVIDER_RELEASE_PATHS.block,
  PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
]);

export const productionCatalogManifestPathSchema = z.enum([
  PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
  PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest,
  PRODUCTION_CATALOG_MANIFEST_PATHS.status,
  PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState,
  PRODUCTION_CATALOG_MANIFEST_PATHS.rollback,
  PRODUCTION_CATALOG_MANIFEST_PATHS.block,
]);

export const productionCatalogRetentionPathSchema = z.enum([
  PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
  PRODUCTION_CATALOG_RETENTION_PATHS.retainProviderReleases,
  PRODUCTION_CATALOG_RETENTION_PATHS.status,
]);

export const productionDataReleaseV3PathSchema = z.enum([
  PRODUCTION_DATA_RELEASE_V3_PATHS.activeState,
  PRODUCTION_DATA_RELEASE_V3_PATHS.start,
  PRODUCTION_DATA_RELEASE_V3_PATHS.applyBatch,
  PRODUCTION_DATA_RELEASE_V3_PATHS.finalize,
  PRODUCTION_DATA_RELEASE_V3_PATHS.activate,
  PRODUCTION_DATA_RELEASE_V3_PATHS.rollback,
  PRODUCTION_DATA_RELEASE_V3_PATHS.status,
]);

export const productionPublicationPathSchema = z.union([
  productionDataReleasePathSchema,
  productionRepackHeatPathSchema,
  productionProviderReleasePathSchema,
  productionCatalogManifestPathSchema,
  productionCatalogRetentionPathSchema,
  productionDataReleaseV3PathSchema,
]);

export type ProductionDataReleasePath = z.infer<
  typeof productionDataReleasePathSchema
>;
export type ProductionRepackHeatPath = z.infer<
  typeof productionRepackHeatPathSchema
>;
export type ProductionProviderReleasePath = z.infer<
  typeof productionProviderReleasePathSchema
>;
export type ProductionCatalogManifestPath = z.infer<
  typeof productionCatalogManifestPathSchema
>;
export type ProductionCatalogRetentionPath = z.infer<
  typeof productionCatalogRetentionPathSchema
>;
export type ProductionDataReleaseV3Path = z.infer<
  typeof productionDataReleaseV3PathSchema
>;
export type ProductionPublicationPath = z.infer<
  typeof productionPublicationPathSchema
>;

export function productionPublicationRequestSigningValue(input: Readonly<{
  method: "POST" | "post";
  path: ProductionPublicationPath;
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
  | "PUBLICATION_DATA_REGRESSION"
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
  "PUBLICATION_DATA_REGRESSION",
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
