import { createHash } from "node:crypto";
import {
  canonicalJson,
  containsProtectedPublicationField,
  productionApplyBatchRequestSchema,
  productionFinalizeRequestSchema,
  productionReceiptSchema,
  productionRefreshRequestSchema,
  productionStartRequestSchema,
  type ProductionApplyBatchRequest,
  type ProductionReceipt,
} from "@packscout/contracts";
import type { CatalogReleaseBaseline } from "./catalog-release-types.ts";
import { CATALOG_PROMOTION_PATH_BY_KIND } from "./catalog-promotion-types.ts";
import type {
  CatalogPromotionOperation,
  CatalogPromotionOperationKind,
  CatalogPromotionPreparedSummary,
} from "./catalog-promotion-types.ts";
import type { CatalogReleasePlanV2 } from "./catalog-release-types.ts";

export type CatalogPromotionPreparationFailureCode =
  | "CATALOG_PLAN_BLOCKED"
  | "PUBLICATION_PROTECTED_FIELD"
  | "PUBLICATION_REQUEST_INVALID";

export class CatalogPromotionPreparationError extends Error {
  constructor(readonly code: CatalogPromotionPreparationFailureCode) {
    super("Catalog promotion preparation failed safely.");
    this.name = "CatalogPromotionPreparationError";
  }
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestSchema(kind: CatalogPromotionOperationKind) {
  switch (kind) {
    case "start": return productionStartRequestSchema;
    case "applyBatch": return productionApplyBatchRequestSchema;
    case "finalize": return productionFinalizeRequestSchema;
    case "refreshObservation": return productionRefreshRequestSchema;
  }
}

function operation(
  ordinal: number,
  kind: CatalogPromotionOperationKind,
  request: unknown,
): CatalogPromotionOperation {
  if (containsProtectedPublicationField(request)) {
    throw new CatalogPromotionPreparationError("PUBLICATION_PROTECTED_FIELD");
  }
  const parsed = requestSchema(kind).safeParse(request);
  if (!parsed.success) {
    throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
  }
  const bodyJson = canonicalJson(parsed.data);
  const identity = parsed.data as {
    operationId: string;
    publicationId?: string;
    publicReleaseId?: string;
  };
  return {
    ordinal,
    kind,
    operationId: identity.operationId,
    publicationId: identity.publicationId ?? identity.publicReleaseId!,
    path: CATALOG_PROMOTION_PATH_BY_KIND[kind],
    bodyJson,
    bodyDigest: sha256Utf8(bodyJson),
    dispatchCount: 0,
    lastDispatchedAt: null,
    acknowledgedAt: null,
    receipt: null,
  };
}

export function validateCatalogPromotionOperation(
  candidate: CatalogPromotionOperation,
): void {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate.bodyJson) as unknown;
  } catch {
    throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
  }
  if (containsProtectedPublicationField(parsedJson)) {
    throw new CatalogPromotionPreparationError("PUBLICATION_PROTECTED_FIELD");
  }
  const parsed = requestSchema(candidate.kind).safeParse(parsedJson);
  if (!parsed.success || canonicalJson(parsed.data) !== candidate.bodyJson ||
      sha256Utf8(candidate.bodyJson) !== candidate.bodyDigest ||
      candidate.path !== CATALOG_PROMOTION_PATH_BY_KIND[candidate.kind]) {
    throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
  }
  const identity = parsed.data as {
    operationId: string;
    publicationId?: string;
    publicReleaseId?: string;
  };
  if (identity.operationId !== candidate.operationId ||
      (identity.publicationId ?? identity.publicReleaseId) !==
        candidate.publicationId) {
    throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
  }
}

export function prepareCatalogPromotion(input: {
  plan: CatalogReleasePlanV2;
  baseline: CatalogReleaseBaseline | null;
}): Readonly<{
  prepared: CatalogPromotionPreparedSummary;
  operations: readonly CatalogPromotionOperation[];
}> {
  const { plan, baseline } = input;
  if (plan.classification === "blocked") {
    throw new CatalogPromotionPreparationError("CATALOG_PLAN_BLOCKED");
  }
  if (plan.classification === "refresh_unchanged") {
    if (baseline === null) {
      throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
    }
    return {
      prepared: {
        classification: plan.classification,
        publicReleaseId: plan.publicReleaseId,
        requestedWatermark: plan.requestedWatermark,
        observationSequence: plan.observationSequence,
        contentHash: plan.contentHash,
        publicConfigHash: baseline.publicConfigHash,
        repackSearchIndexHash: baseline.repackSearchIndexHash,
        publicVendorKeys: plan.publicVendorKeys,
        delayedVendorCount: plan.refreshRequest.delayedVendorCount,
        expectedPredecessorPublicReleaseId:
          plan.expectedPredecessorPublicReleaseId,
      },
      operations: [operation(0, "refreshObservation", plan.refreshRequest)],
    };
  }

  const operations: CatalogPromotionOperation[] = [
    operation(0, "start", plan.startRequest),
  ];
  for (const batch of plan.batches) {
    const request: ProductionApplyBatchRequest = {
      schemaVersion: plan.startRequest.schemaVersion,
      operationId: `batch:${plan.publicReleaseId}:${batch.batchIndex}`,
      idempotencyKey: `batch:${plan.publicReleaseId}:${batch.batchIndex}`,
      publicationId: plan.publicReleaseId,
      batchIndex: batch.batchIndex,
      kind: batch.kind,
      batchHash: batch.batchHash,
      records: batch.records,
    } as ProductionApplyBatchRequest;
    operations.push(operation(operations.length, "applyBatch", request));
  }
  operations.push(operation(
    operations.length,
    "finalize",
    plan.finalizeRequest,
  ));
  return {
    prepared: {
      classification: plan.classification,
      publicReleaseId: plan.publicReleaseId,
      requestedWatermark: plan.requestedWatermark,
      observationSequence: plan.observationSequence,
      contentHash: plan.contentHash,
      publicConfigHash: plan.manifest.metadata.publicConfigHash,
      repackSearchIndexHash: plan.manifest.metadata.repackSearchIndexHash,
      publicVendorKeys: plan.publicVendorKeys,
      delayedVendorCount: plan.manifest.metadata.delayedVendorCount,
      expectedPredecessorPublicReleaseId:
        plan.expectedPredecessorPublicReleaseId,
    },
    operations,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function validateCatalogPromotionReceipt(
  receiptInput: unknown,
  expected: Readonly<{
    operationId: string;
    publicationId: string;
    requestDigest: string;
    kind: CatalogPromotionOperationKind;
    bodyJson?: string;
  }>,
): ProductionReceipt {
  const receipt = productionReceiptSchema.parse(receiptInput);
  if (
    receipt.operationId !== expected.operationId ||
    receipt.publicationId !== expected.publicationId ||
    receipt.requestDigest !== expected.requestDigest ||
    receipt.operationKind !== expected.kind
  ) {
    throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
  }
  if (expected.bodyJson === undefined) return receipt;
  const parsedRequest = requestSchema(expected.kind).parse(
    JSON.parse(expected.bodyJson) as unknown,
  );
  if (expected.kind === "start") {
    const request = parsedRequest as ReturnType<typeof productionStartRequestSchema.parse>;
    if (receipt.operationKind !== "start" ||
        receipt.details.manifestFingerprint !== request.manifest.manifestFingerprint ||
        receipt.details.contentHash !== request.manifest.contentHash ||
        receipt.details.expectedBatchCount !== request.manifest.batchCount ||
        !sameJson(receipt.details.expectedCounts, request.manifest.counts)) {
      throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
    }
  } else if (expected.kind === "applyBatch") {
    const request = parsedRequest as ReturnType<typeof productionApplyBatchRequestSchema.parse>;
    if (receipt.operationKind !== "applyBatch" ||
        receipt.details.batchIndex !== request.batchIndex ||
        receipt.details.kind !== request.kind ||
        receipt.details.batchHash !== request.batchHash ||
        receipt.details.recordCount !== request.records.length) {
      throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
    }
  } else if (expected.kind === "finalize") {
    const request = parsedRequest as ReturnType<typeof productionFinalizeRequestSchema.parse>;
    if (receipt.operationKind !== "finalize" ||
        receipt.details.batchCount !== request.expectedBatchCount ||
        receipt.details.batchChainHash !== request.expectedBatchChainHash ||
        !sameJson(receipt.details.counts, request.expectedCounts)) {
      throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
    }
  } else {
    const request = parsedRequest as ReturnType<typeof productionRefreshRequestSchema.parse>;
    if (receipt.operationKind !== "refreshObservation" ||
        receipt.details.contentHash !== request.contentHash ||
        receipt.details.observationSequence !== request.observationSequence ||
        receipt.details.lastSuccessfulObservationAt !== request.lastSuccessfulObservationAt) {
      throw new CatalogPromotionPreparationError("PUBLICATION_REQUEST_INVALID");
    }
  }
  return receipt;
}
