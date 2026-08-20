import { createHash } from "node:crypto";
import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  canonicalJson,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseReceiptSchema,
  providerReleaseStartRequestSchema,
  providerReleaseStatusRequestSchema,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleasePlanV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogReleaseReusePlanV1,
  type ProviderReleaseExpectedCompletedHeadV1,
  type ProviderReleaseImmutableProofV1,
  type ProviderReleaseMutationRequest,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusRequest,
} from "@packscout/contracts";
import {
  PROVIDER_PROMOTION_PATH_BY_KIND,
  type ProviderPromotionOperationKind,
  type ProviderPromotionOperationRecord,
  type ProviderPromotionPreparedOperation,
  type ProviderPromotionPreparedSummary,
} from "./provider-promotion-types.ts";

export type ProviderPromotionPreparationErrorCode =
  | "PROVIDER_PLAN_BLOCKED"
  | "PROVIDER_PLAN_INVALID"
  | "PROVIDER_PREDECESSOR_INVALID"
  | "PROVIDER_OPERATION_INVALID"
  | "PROVIDER_RECEIPT_INVALID";

export class ProviderPromotionPreparationError extends Error {
  constructor(readonly code: ProviderPromotionPreparationErrorCode) {
    super("Provider promotion preparation failed safely.");
    this.name = "ProviderPromotionPreparationError";
  }
}

function fail(code: ProviderPromotionPreparationErrorCode): never {
  throw new ProviderPromotionPreparationError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function immutableProof(
  plan: ProviderCatalogReleasePublishPlanV1 | ProviderCatalogReleaseReusePlanV1,
): ProviderReleaseImmutableProofV1 {
  return {
    platformKey: plan.platformKey,
    publicProviderReleaseId: plan.publicProviderReleaseId,
    sharedConfigurationEpoch: plan.sharedConfigurationEpoch,
    providerReleaseFingerprint: plan.providerReleaseFingerprint,
    contentHash: plan.contentHash,
    publicAssetOrigins: plan.publicAssetOrigins,
    governingHashes: plan.governingHashes,
    entityHashes: plan.entityHashes,
    counts: plan.counts,
    searchAlgorithmVersion: plan.searchAlgorithmVersion,
    providerSearchIndexHash: plan.providerSearchIndexHash,
    batchCount: plan.batchCount,
    batchChainHash: plan.batchChainHash,
    dataAsOf: plan.dataAsOf,
  };
}

function schemaFor(kind: ProviderPromotionOperationKind) {
  switch (kind) {
    case "start": return providerReleaseStartRequestSchema;
    case "applyBatch": return providerReleaseApplyBatchRequestSchema;
    case "finalize": return providerReleaseFinalizeRequestSchema;
    case "confirmReuse": return providerReleaseConfirmReuseRequestSchema;
  }
}

function preparedOperation(
  operationIndex: number,
  kind: ProviderPromotionOperationKind,
  request: unknown,
): ProviderPromotionPreparedOperation {
  const parsed = schemaFor(kind).safeParse(request);
  if (!parsed.success) fail("PROVIDER_OPERATION_INVALID");
  const canonicalRequestBody = canonicalJson(parsed.data);
  return {
    operationIndex,
    operationId: parsed.data.operationId,
    operationKind: kind,
    requestPath: PROVIDER_PROMOTION_PATH_BY_KIND[kind],
    canonicalRequestBody,
    requestSha256: sha256(canonicalRequestBody),
  };
}

function operationIdentity(
  kind: ProviderPromotionOperationKind,
  plan: ProviderCatalogReleasePublishPlanV1 | ProviderCatalogReleaseReusePlanV1,
  suffix = "",
): string {
  const base = kind === "confirmReuse"
    ? `reuse:${plan.publicProviderReleaseId}:${plan.providerCheckpoint.settledSequence}`
    : `${kind}:${plan.publicProviderReleaseId}${suffix}`;
  if (base.length > 128) fail("PROVIDER_OPERATION_INVALID");
  return base;
}

function context(
  plan: ProviderCatalogReleasePublishPlanV1 | ProviderCatalogReleaseReusePlanV1,
  expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1,
) {
  return {
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    release: immutableProof(plan),
    providerCheckpoint: plan.providerCheckpoint,
    sourceWatermark: plan.sourceWatermark,
    observation: plan.observation,
    expectedCompletedHead,
  };
}

export function prepareProviderPromotion(input: Readonly<{
  plan: ProviderCatalogReleasePlanV1;
  expectedCompletedHead: ProviderReleaseExpectedCompletedHeadV1;
  checkpointSha256: string;
}>): Readonly<{
  summary: ProviderPromotionPreparedSummary;
  operations: readonly ProviderPromotionPreparedOperation[];
}> {
  const { plan, expectedCompletedHead } = input;
  if (plan.classification === "blocked") fail("PROVIDER_PLAN_BLOCKED");
  if (expectedCompletedHead.platformKey !== plan.platformKey) {
    fail("PROVIDER_PREDECESSOR_INVALID");
  }
  const common = context(plan, expectedCompletedHead);
  const operations: ProviderPromotionPreparedOperation[] = [];
  if (plan.classification === "reuse") {
    const operationId = operationIdentity("confirmReuse", plan);
    operations.push(preparedOperation(0, "confirmReuse", {
      ...common,
      operationId,
      idempotencyKey: operationId,
    }));
  } else {
    const startId = operationIdentity("start", plan);
    operations.push(preparedOperation(0, "start", {
      ...common,
      operationId: startId,
      idempotencyKey: startId,
    }));
    for (const batch of plan.batches) {
      const operationId = operationIdentity(
        "applyBatch",
        plan,
        `:${batch.batchIndex}`,
      );
      operations.push(preparedOperation(operations.length, "applyBatch", {
        ...common,
        operationId,
        idempotencyKey: operationId,
        batch,
      }));
    }
    const finalizeId = operationIdentity("finalize", plan);
    operations.push(preparedOperation(operations.length, "finalize", {
      ...common,
      operationId: finalizeId,
      idempotencyKey: finalizeId,
    }));
  }
  return {
    summary: {
      classification: plan.classification,
      platformKey: plan.platformKey,
      targetCheckpoint: BigInt(plan.providerCheckpoint.settledSequence),
      publicProviderReleaseId: plan.publicProviderReleaseId,
      providerReleaseFingerprint: plan.providerReleaseFingerprint,
      immutableProof: immutableProof(plan),
      providerCheckpoint: plan.providerCheckpoint,
      observation: plan.observation,
      expectedCompletedHead,
      operationCount: operations.length,
      checkpointSha256: input.checkpointSha256,
    },
    operations,
  };
}

export function parseProviderPromotionOperation(
  operation: ProviderPromotionPreparedOperation | ProviderPromotionOperationRecord,
): ProviderReleaseMutationRequest {
  let value: unknown;
  try {
    value = JSON.parse(operation.canonicalRequestBody) as unknown;
  } catch {
    fail("PROVIDER_OPERATION_INVALID");
  }
  const parsed = schemaFor(operation.operationKind).safeParse(value);
  if (
    !parsed.success ||
    canonicalJson(parsed.data) !== operation.canonicalRequestBody ||
    sha256(operation.canonicalRequestBody) !== operation.requestSha256 ||
    parsed.data.operationId !== operation.operationId ||
    operation.requestPath !==
      PROVIDER_PROMOTION_PATH_BY_KIND[operation.operationKind]
  ) fail("PROVIDER_OPERATION_INVALID");
  return parsed.data;
}

function receiptMatchesRequest(
  receipt: ProviderReleaseReceipt,
  request: ProviderReleaseMutationRequest,
  expectedKind: ProviderPromotionOperationKind,
): boolean {
  if (
    receipt.operationKind !== expectedKind ||
    receipt.operationId !== request.operationId ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.requestDigest !== sha256(canonicalJson(request))
  ) return false;
  if (!("release" in request) || !("details" in receipt) ||
      !("release" in receipt.details)) return false;
  if (
    receipt.platformKey !== request.release.platformKey ||
    receipt.publicProviderReleaseId !== request.release.publicProviderReleaseId ||
    canonicalJson(receipt.details.release) !== canonicalJson(request.release) ||
    canonicalJson(receipt.details.providerCheckpoint) !==
      canonicalJson(request.providerCheckpoint) ||
    receipt.details.sourceWatermark !== request.sourceWatermark ||
    canonicalJson(receipt.details.observation) !== canonicalJson(request.observation) ||
    canonicalJson(receipt.details.expectedCompletedHead) !==
      canonicalJson(request.expectedCompletedHead)
  ) return false;
  if (receipt.operationKind === "applyBatch" && "batch" in request) {
    return receipt.details.batchIndex === request.batch.batchIndex &&
      receipt.details.kind === request.batch.kind &&
      receipt.details.batchHash === request.batch.batchHash &&
      receipt.details.recordCount === request.batch.records.length &&
      receipt.details.byteCount === request.batch.byteCount;
  }
  return true;
}

export function validateProviderPromotionReceipt(input: Readonly<{
  operation: ProviderPromotionPreparedOperation | ProviderPromotionOperationRecord;
  receipt: unknown;
  canonicalReceiptBody?: string;
  receiptSha256?: string;
}>): ProviderReleaseReceipt {
  const request = parseProviderPromotionOperation(input.operation);
  const parsed = providerReleaseReceiptSchema.safeParse(input.receipt);
  if (!parsed.success || !receiptMatchesRequest(
    parsed.data,
    request,
    input.operation.operationKind,
  )) {
    fail("PROVIDER_RECEIPT_INVALID");
  }
  const canonicalReceiptBody = canonicalJson(parsed.data);
  if (
    input.canonicalReceiptBody !== undefined &&
      input.canonicalReceiptBody !== canonicalReceiptBody ||
    input.receiptSha256 !== undefined &&
      input.receiptSha256 !== sha256(canonicalReceiptBody)
  ) fail("PROVIDER_RECEIPT_INVALID");
  return parsed.data;
}

export function providerPromotionStatusRequest(
  operation: ProviderPromotionPreparedOperation | ProviderPromotionOperationRecord,
): ProviderReleaseStatusRequest {
  const request = parseProviderPromotionOperation(operation);
  if (!("release" in request)) fail("PROVIDER_OPERATION_INVALID");
  return providerReleaseStatusRequestSchema.parse({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    target: {
      operationKind: operation.operationKind,
      operationId: operation.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      requestDigest: operation.requestSha256,
    },
  });
}

function releaseContextBody(request: ProviderReleaseMutationRequest): string {
  if (!("release" in request)) fail("PROVIDER_OPERATION_INVALID");
  return canonicalJson({
    release: request.release,
    providerCheckpoint: request.providerCheckpoint,
    sourceWatermark: request.sourceWatermark,
    observation: request.observation,
    expectedCompletedHead: request.expectedCompletedHead,
  });
}

/** Rebuilds the Task008 plan solely from durable exact operation bytes. */
export async function reconstructVerifiedProviderPromotionPlan(input: Readonly<{
  summary: ProviderPromotionPreparedSummary;
  operations: readonly (
    ProviderPromotionPreparedOperation | ProviderPromotionOperationRecord
  )[];
}>): Promise<ProviderCatalogReleasePublishPlanV1 | ProviderCatalogReleaseReusePlanV1> {
  if (input.operations.length !== input.summary.operationCount ||
      input.operations.length === 0) fail("PROVIDER_OPERATION_INVALID");
  const requests = input.operations.map(parseProviderPromotionOperation);
  const first = requests[0]!;
  if (!("release" in first)) fail("PROVIDER_OPERATION_INVALID");
  const firstContext = releaseContextBody(first);
  if (requests.some((request) => releaseContextBody(request) !== firstContext)) {
    fail("PROVIDER_OPERATION_INVALID");
  }
  const common = {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    ...first.release,
    providerCheckpoint: first.providerCheckpoint,
    sourceWatermark: first.sourceWatermark,
    observation: first.observation,
  };
  const candidate = input.summary.classification === "reuse"
    ? {
        ...common,
        classification: "reuse" as const,
        batches: [],
        reuseProof: { state: "complete" as const, ...first.release },
      }
    : {
        ...common,
        classification: "publish" as const,
        batches: requests.slice(1, -1).map((request) => {
          if (!("batch" in request)) fail("PROVIDER_OPERATION_INVALID");
          return request.batch;
        }),
      };
  let verified;
  try {
    verified = await verifyProviderCatalogReleasePlanV1(candidate);
  } catch {
    fail("PROVIDER_PLAN_INVALID");
  }
  if (verified.classification === "blocked" ||
      verified.classification !== input.summary.classification ||
      verified.platformKey !== input.summary.platformKey ||
      verified.publicProviderReleaseId !==
        input.summary.publicProviderReleaseId ||
      verified.providerReleaseFingerprint !==
        input.summary.providerReleaseFingerprint ||
      canonicalJson(first.release) !== canonicalJson(input.summary.immutableProof) ||
      canonicalJson(first.expectedCompletedHead) !==
        canonicalJson(input.summary.expectedCompletedHead)) {
    fail("PROVIDER_PLAN_INVALID");
  }
  return verified;
}
