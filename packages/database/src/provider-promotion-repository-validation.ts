import {
  buildProviderCatalogSourceWatermarkV1,
  canonicalJson,
  parseProviderReleasePublicationJson,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseImmutableProofV1Schema,
  providerReleaseReceiptSchema,
  providerReleaseSignedReceiptEnvelopeSchema,
  providerReleaseStartRequestSchema,
  type ProviderReleaseApplyBatchRequest,
  type ProviderReleaseReceipt,
} from "@packscout/contracts";
import {
  PROMOTION_V2_MAX_OPERATION_COUNT,
  PROMOTION_V2_MAX_PROVIDER_RECEIPT_BYTES,
  PROMOTION_V2_MAX_REQUEST_BYTES,
  PROMOTION_V2_MAX_RESPONSE_BYTES,
  PROMOTION_V2_MAX_SUMMARY_BYTES,
  PromotionV2PersistenceError,
  parseProviderCheckpointIdentityBody,
  promotionV2CanonicalJson,
  promotionV2Sha256,
  type ExactPromotionOperationInput,
  type ExactPromotionReceiptEvidence,
  type ProviderPromotionPreparedSummary,
} from "./promotion-v2-types.ts";

export interface ProviderPromotionOperationRow {
  operationIndex: number;
  operationId: string;
  operationKind: string;
  requestPath: string;
  canonicalRequestBody: string;
  requestSha256: string;
  state: "pending" | "sent" | "acknowledged";
  sendCount: number;
  lastSentAt: Date | null;
  acknowledgedAt: Date | null;
  canonicalReceiptBody: string | null;
  receiptSha256: string | null;
  exactResponseBody: string | null;
  responseSha256: string | null;
}

const providerOperationKinds = new Set([
  "start", "applyBatch", "finalize", "confirmReuse", "block",
]);

export function providerPromotionByteCount(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function providerPromotionPreparedSummaryBody(
  summary: ProviderPromotionPreparedSummary,
): string {
  return promotionV2CanonicalJson({
    ...summary,
    targetCheckpoint: String(summary.targetCheckpoint),
  });
}

export function parseProviderPromotionPreparedSummary(
  body: string,
): ProviderPromotionPreparedSummary {
  const value = JSON.parse(body) as Omit<
    ProviderPromotionPreparedSummary,
    "targetCheckpoint"
  > & { targetCheckpoint: string };
  const parsed: ProviderPromotionPreparedSummary = {
    ...value,
    targetCheckpoint: BigInt(value.targetCheckpoint),
  };
  if (providerPromotionPreparedSummaryBody(parsed) !== body) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_STATE_CONFLICT");
  }
  return parsed;
}

function parseProviderRequest(operation: ExactPromotionOperationInput) {
  switch (operation.operationKind) {
    case "start":
      if (operation.requestPath !== PRODUCTION_PROVIDER_RELEASE_PATHS.start) {
        return null;
      }
      return parseProviderReleasePublicationJson(
        operation.canonicalRequestBody,
        providerReleaseStartRequestSchema,
      );
    case "applyBatch":
      if (operation.requestPath !== PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch) {
        return null;
      }
      return parseProviderReleasePublicationJson(
        operation.canonicalRequestBody,
        providerReleaseApplyBatchRequestSchema,
      );
    case "finalize":
      if (operation.requestPath !== PRODUCTION_PROVIDER_RELEASE_PATHS.finalize) {
        return null;
      }
      return parseProviderReleasePublicationJson(
        operation.canonicalRequestBody,
        providerReleaseFinalizeRequestSchema,
      );
    case "confirmReuse":
      if (operation.requestPath !== PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse) {
        return null;
      }
      return parseProviderReleasePublicationJson(
        operation.canonicalRequestBody,
        providerReleaseConfirmReuseRequestSchema,
      );
    case "block":
      if (operation.requestPath !== PRODUCTION_PROVIDER_RELEASE_PATHS.block) {
        return null;
      }
      return parseProviderReleasePublicationJson(
        operation.canonicalRequestBody,
        providerReleaseBlockRequestSchema,
      );
    default:
      return null;
  }
}

export function validateProviderPromotionPrepared(
  platformKey: string,
  targetCheckpoint: bigint,
  evaluationCheckpointBody: string,
  evaluationCheckpointSha256: string,
  summary: ProviderPromotionPreparedSummary,
  operations: readonly ExactPromotionOperationInput[],
): void {
  const body = providerPromotionPreparedSummaryBody(summary);
  const checkpoint = parseProviderCheckpointIdentityBody(
    evaluationCheckpointBody,
  );
  if (
    summary.platformKey !== platformKey ||
    summary.targetCheckpoint !== targetCheckpoint ||
    summary.checkpointSha256 !== evaluationCheckpointSha256 ||
    promotionV2Sha256(evaluationCheckpointBody) !==
      evaluationCheckpointSha256 ||
    checkpoint.platformKey !== platformKey ||
    checkpoint.settledSequence !== targetCheckpoint ||
    checkpoint.settledSequence <= 0n ||
    checkpoint.blockedState.kind !== "ready" ||
    canonicalJson(summary.immutableProof.sharedConfigurationEpoch) !==
      canonicalJson({
        ...checkpoint.sharedConfigurationEpoch,
        publicChangeSequence: String(
          checkpoint.sharedConfigurationEpoch.publicChangeSequence,
        ),
      }) ||
    canonicalJson(summary.providerCheckpoint) !== canonicalJson({
      settledSequence: String(checkpoint.settledSequence),
      settledAt: checkpoint.settledAt?.toISOString() ?? null,
    }) ||
    canonicalJson(summary.observation) !== canonicalJson({
      sourceHeadSequence: String(checkpoint.sourceHeadSequence),
      lastSuccessfulObservationAt:
        checkpoint.lastSuccessfulObservationAt.toISOString(),
      staleAt: checkpoint.staleAt.toISOString(),
      freshness: checkpoint.freshness,
    }) ||
    summary.operationCount !== operations.length ||
    operations.length === 0 ||
    operations.length > PROMOTION_V2_MAX_OPERATION_COUNT ||
    providerPromotionByteCount(body) > PROMOTION_V2_MAX_SUMMARY_BYTES ||
    !providerReleaseImmutableProofV1Schema.safeParse(summary.immutableProof).success
  ) throw new PromotionV2PersistenceError("PROMOTION_V2_INPUT_INVALID");

  const expectedKinds = summary.classification === "reuse"
    ? ["confirmReuse"]
    : [
        "start",
        ...Array(Math.max(0, operations.length - 2)).fill("applyBatch"),
        "finalize",
      ];
  if (expectedKinds.length !== operations.length) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_ORDER");
  }
  operations.forEach((operation, index) => {
    if (
      operation.operationIndex !== index ||
      operation.operationKind !== expectedKinds[index] ||
      !providerOperationKinds.has(operation.operationKind) ||
      providerPromotionByteCount(operation.canonicalRequestBody) >
        PROMOTION_V2_MAX_REQUEST_BYTES
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_ORDER");
    const request = parseProviderRequest(operation);
    if (
      request === null ||
      request.operationId !== operation.operationId ||
      request.release.platformKey !== platformKey ||
      request.release.publicProviderReleaseId !== summary.publicProviderReleaseId ||
      request.release.providerReleaseFingerprint !==
        summary.providerReleaseFingerprint ||
      canonicalJson(request.providerCheckpoint) !==
        canonicalJson(summary.providerCheckpoint) ||
      canonicalJson(request.observation) !== canonicalJson(summary.observation) ||
      request.sourceWatermark !== buildProviderCatalogSourceWatermarkV1(
        platformKey,
        summary.providerCheckpoint.settledSequence,
      ) ||
      request.providerCheckpoint.settledSequence !== String(targetCheckpoint) ||
      canonicalJson(request.release) !== canonicalJson(summary.immutableProof) ||
      canonicalJson(request.expectedCompletedHead) !==
        canonicalJson(summary.expectedCompletedHead)
    ) throw new PromotionV2PersistenceError("PROMOTION_V2_OPERATION_CONFLICT");
  });
}

function receiptMatchesPersistedRequest(
  receipt: ProviderReleaseReceipt,
  request: NonNullable<ReturnType<typeof parseProviderRequest>>,
  operation: ProviderPromotionOperationRow,
): boolean {
  if (
    receipt.operationKind !== operation.operationKind ||
    receipt.operationId !== request.operationId ||
    !("idempotencyKey" in receipt) ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.requestDigest !== operation.requestSha256 ||
    !("release" in request) || !("details" in receipt) ||
    !("release" in receipt.details) ||
    receipt.platformKey !== request.release.platformKey ||
    receipt.publicProviderReleaseId !== request.release.publicProviderReleaseId ||
    canonicalJson(receipt.details.release) !== canonicalJson(request.release) ||
    canonicalJson(receipt.details.providerCheckpoint) !==
      canonicalJson(request.providerCheckpoint) ||
    receipt.details.sourceWatermark !== request.sourceWatermark ||
    canonicalJson(receipt.details.observation) !==
      canonicalJson(request.observation) ||
    canonicalJson(receipt.details.expectedCompletedHead) !==
      canonicalJson(request.expectedCompletedHead)
  ) return false;
  if (receipt.operationKind === "applyBatch" && "batch" in request) {
    const batchRequest = request as ProviderReleaseApplyBatchRequest;
    return receipt.details.batchIndex === batchRequest.batch.batchIndex &&
      receipt.details.kind === batchRequest.batch.kind &&
      receipt.details.batchHash === batchRequest.batch.batchHash &&
      receipt.details.recordCount === batchRequest.batch.records.length &&
      receipt.details.byteCount === batchRequest.batch.byteCount;
  }
  return true;
}

export function parseProviderPromotionReceiptEvidence(
  operation: ProviderPromotionOperationRow,
  evidence: ExactPromotionReceiptEvidence,
): Readonly<{
  receipt: ProviderReleaseReceipt;
  receiptSha256: string;
  exactResponseBody: string | null;
  responseSha256: string | null;
}> {
  if (providerPromotionByteCount(evidence.canonicalReceiptBody) >
    PROMOTION_V2_MAX_PROVIDER_RECEIPT_BYTES) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(evidence.canonicalReceiptBody);
  } catch {
    throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
  }
  const parsed = providerReleaseReceiptSchema.safeParse(parsedJson);
  const request = parseProviderRequest(operation);
  if (!parsed.success || request === null ||
    canonicalJson(parsed.data) !== evidence.canonicalReceiptBody ||
    !receiptMatchesPersistedRequest(parsed.data, request, operation)) {
    throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
  }
  const exactResponseBody = evidence.exactResponseBody ?? null;
  let responseSha256: string | null = null;
  if (exactResponseBody !== null) {
    if (providerPromotionByteCount(exactResponseBody) >
      PROMOTION_V2_MAX_RESPONSE_BYTES) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    let responseJson: unknown;
    try {
      responseJson = JSON.parse(exactResponseBody);
    } catch {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    const envelope = providerReleaseSignedReceiptEnvelopeSchema.safeParse(
      responseJson,
    );
    if (!envelope.success ||
      canonicalJson(envelope.data.receipt) !== evidence.canonicalReceiptBody) {
      throw new PromotionV2PersistenceError("PROMOTION_V2_RECEIPT_INVALID");
    }
    responseSha256 = promotionV2Sha256(exactResponseBody);
  }
  return {
    receipt: parsed.data,
    receiptSha256: promotionV2Sha256(evidence.canonicalReceiptBody),
    exactResponseBody,
    responseSha256,
  };
}
