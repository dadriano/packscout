import { createHash } from "node:crypto";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestReceiptSchema,
  catalogManifestRefreshActiveStateRequestSchema,
  catalogManifestRollbackRequestSchema,
  catalogManifestStatusRequestSchema,
  type CatalogManifestActivateRequest,
  type CatalogManifestReceipt,
  type CatalogManifestRefreshActiveStateRequest,
  type CatalogManifestRollbackRequest,
  type CatalogManifestStatusRequest,
  type GlobalCatalogManifestIdentityV1,
} from "@packscout/contracts";
import {
  MANIFEST_PROMOTION_PATH_BY_KIND,
  type ManifestPromotionMutationKind,
  type ManifestPromotionOperationRecord,
  type ManifestPromotionPreparedOperation,
} from "./manifest-promotion-types.ts";

export type ManifestPromotionPreparationErrorCode =
  | "MANIFEST_OPERATION_INVALID"
  | "MANIFEST_RECEIPT_INVALID";

export class ManifestPromotionPreparationError extends Error {
  constructor(readonly code: ManifestPromotionPreparationErrorCode) {
    super("Manifest promotion preparation failed safely.");
    this.name = "ManifestPromotionPreparationError";
  }
}

function fail(code: ManifestPromotionPreparationErrorCode): never {
  throw new ManifestPromotionPreparationError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY = canonicalJson({
  schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  operationId: "catalog-manifest-active-state",
});

function schemaFor(kind: ManifestPromotionMutationKind) {
  switch (kind) {
    case "activateManifest": return catalogManifestActivateRequestSchema;
    case "refreshActiveState":
      return catalogManifestRefreshActiveStateRequestSchema;
    case "rollback": return catalogManifestRollbackRequestSchema;
  }
}

export function manifestPromotionOperationId(
  evaluationSequence: bigint,
  kind: ManifestPromotionMutationKind,
): string {
  if (evaluationSequence <= 0n) fail("MANIFEST_OPERATION_INVALID");
  const value = `manifest:${evaluationSequence}:${kind}`;
  if (value.length > 128) fail("MANIFEST_OPERATION_INVALID");
  return value;
}

export function prepareManifestPromotionOperation(
  kind: ManifestPromotionMutationKind,
  request: CatalogManifestActivateRequest |
    CatalogManifestRefreshActiveStateRequest |
    CatalogManifestRollbackRequest,
): ManifestPromotionPreparedOperation {
  const parsed = schemaFor(kind).safeParse(request);
  if (!parsed.success) fail("MANIFEST_OPERATION_INVALID");
  const canonicalRequestBody = canonicalJson(parsed.data);
  return {
    operationIndex: 0,
    operationId: parsed.data.operationId,
    operationKind: kind,
    requestPath: MANIFEST_PROMOTION_PATH_BY_KIND[kind],
    canonicalRequestBody,
    requestSha256: sha256(canonicalRequestBody),
  };
}

export function parseManifestPromotionOperation(
  operation: ManifestPromotionPreparedOperation |
    ManifestPromotionOperationRecord,
): CatalogManifestActivateRequest | CatalogManifestRefreshActiveStateRequest |
  CatalogManifestRollbackRequest {
  let value: unknown;
  try {
    value = JSON.parse(operation.canonicalRequestBody) as unknown;
  } catch {
    fail("MANIFEST_OPERATION_INVALID");
  }
  const parsed = schemaFor(operation.operationKind).safeParse(value);
  if (
    !parsed.success ||
    canonicalJson(parsed.data) !== operation.canonicalRequestBody ||
    sha256(operation.canonicalRequestBody) !== operation.requestSha256 ||
    parsed.data.operationId !== operation.operationId ||
    operation.requestPath !==
      MANIFEST_PROMOTION_PATH_BY_KIND[operation.operationKind]
  ) fail("MANIFEST_OPERATION_INVALID");
  return parsed.data;
}

function manifestIdentity(
  request: CatalogManifestActivateRequest |
    CatalogManifestRefreshActiveStateRequest |
    CatalogManifestRollbackRequest,
): Readonly<{
  publicReleaseId: string | null;
  manifestFingerprint: string | null;
}> {
  if (!("manifest" in request)) {
    return request.rollbackKind === "clear"
      ? { publicReleaseId: null, manifestFingerprint: null }
      : {
          publicReleaseId: request.targetManifest.publicReleaseId,
          manifestFingerprint: request.targetManifest.manifestFingerprint,
        };
  }
  return {
    publicReleaseId: request.manifest.publicReleaseId,
    manifestFingerprint: request.manifest.manifestFingerprint,
  };
}

function resultingIdentity(
  receipt: CatalogManifestReceipt,
): GlobalCatalogManifestIdentityV1 | null {
  if (
    receipt.operationKind === "activeState" ||
    receipt.operationKind === "block" ||
    !("activeState" in receipt.details)
  ) return null;
  const pointer = receipt.details.activeState.activeManifest;
  return pointer === null ? null : {
    publicReleaseId: pointer.publicReleaseId,
    manifestFingerprint: pointer.manifestFingerprint,
    sharedConfigurationEpoch: pointer.sharedConfigurationEpoch,
    providerReferenceSetHash: pointer.providerReferenceSetHash,
  };
}

export function validateManifestPromotionReceipt(input: Readonly<{
  operation: ManifestPromotionPreparedOperation |
    ManifestPromotionOperationRecord;
  receipt: unknown;
  canonicalReceiptBody?: string;
  receiptSha256?: string;
}>): CatalogManifestReceipt {
  const request = parseManifestPromotionOperation(input.operation);
  const parsed = catalogManifestReceiptSchema.safeParse(input.receipt);
  const identity = manifestIdentity(request);
  if (
    !parsed.success ||
    parsed.data.operationKind !== input.operation.operationKind ||
    parsed.data.operationId !== request.operationId ||
    parsed.data.idempotencyKey !== request.idempotencyKey ||
    parsed.data.requestDigest !== input.operation.requestSha256 ||
    !("publicReleaseId" in parsed.data) ||
    parsed.data.publicReleaseId !== identity.publicReleaseId ||
    parsed.data.manifestFingerprint !== identity.manifestFingerprint ||
    !("expectedActiveState" in parsed.data.details) ||
    canonicalJson(parsed.data.details.expectedActiveState) !==
      canonicalJson(request.expectedActiveState) ||
    !("activeState" in parsed.data.details) ||
    ("manifest" in request
      ? canonicalJson(parsed.data.details.activeState.observation) !==
          canonicalJson(request.observation) ||
        canonicalJson(resultingIdentity(parsed.data)) !== canonicalJson({
          publicReleaseId: request.manifest.publicReleaseId,
          manifestFingerprint: request.manifest.manifestFingerprint,
          sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
          providerReferenceSetHash: request.manifest.providerReferenceSetHash,
        })
      : request.rollbackKind !== "clear" ||
        parsed.data.details.activeState.activeManifest !== null ||
        parsed.data.details.activeState.previousManifest !== null ||
        parsed.data.details.activeState.observation !== null)
  ) fail("MANIFEST_RECEIPT_INVALID");
  const canonicalReceiptBody = canonicalJson(parsed.data);
  if (
    input.canonicalReceiptBody !== undefined &&
      input.canonicalReceiptBody !== canonicalReceiptBody ||
    input.receiptSha256 !== undefined &&
      input.receiptSha256 !== sha256(canonicalReceiptBody)
  ) fail("MANIFEST_RECEIPT_INVALID");
  return parsed.data;
}

export function manifestPromotionStatusRequest(
  operation: ManifestPromotionPreparedOperation |
    ManifestPromotionOperationRecord,
): CatalogManifestStatusRequest {
  const request = parseManifestPromotionOperation(operation);
  const identity = manifestIdentity(request);
  return catalogManifestStatusRequestSchema.parse({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    target: {
      operationKind: operation.operationKind,
      ...(operation.operationKind === "rollback" &&
        "rollbackKind" in request
        ? { rollbackKind: request.rollbackKind }
        : {}),
      operationId: operation.operationId,
      idempotencyKey: request.idempotencyKey,
      ...identity,
      requestDigest: operation.requestSha256,
    },
  });
}
