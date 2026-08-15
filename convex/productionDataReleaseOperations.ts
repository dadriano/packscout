import {
  DATA_RELEASE_SCHEMA_VERSION,
  productionReceiptSchema,
  type ProductionOperationKind,
  type ProductionReceipt,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import { productionReceiptHash } from "./productionDataReleaseProtocol";

async function parseStoredReceipt(
  operation: Doc<"dataReleaseOperations">,
): Promise<ProductionReceipt> {
  if (
    operation.status !== "completed" ||
    operation.completedAt === null ||
    operation.confirmationReceiptHash === null ||
    operation.receiptJson === undefined
  ) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  try {
    const parsed = productionReceiptSchema.parse(
      JSON.parse(operation.receiptJson) as unknown,
    );
    const { receiptDigest: _storedDigest, ...receiptWithoutDigest } = parsed;
    if (
      parsed.operationId !== operation.operationId ||
      parsed.operationKind !== operation.kind ||
      parsed.publicationId !== operation.publicReleaseId ||
      parsed.requestDigest !== operation.bodyHash ||
      parsed.receiptDigest !== operation.confirmationReceiptHash ||
      parsed.receiptDigest !== await productionReceiptHash(receiptWithoutDigest)
    ) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    return parsed;
  } catch {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
}

export async function loadExactOperationReplay(
  ctx: MutationCtx,
  input: {
    kind: ProductionOperationKind;
    operationId: string;
    idempotencyKey: string;
    bodyHash: string;
  },
): Promise<ProductionReceipt | null> {
  const [byOperationId, byIdempotencyKey] = await Promise.all([
    ctx.db
      .query("dataReleaseOperations")
      .withIndex("by_operation_id", (index) =>
        index.eq("operationId", input.operationId),
      )
      .take(2),
    ctx.db
      .query("dataReleaseOperations")
      .withIndex("by_kind_and_idempotency_key", (index) =>
        index.eq("kind", input.kind).eq("idempotencyKey", input.idempotencyKey),
      )
      .take(2),
  ]);
  if (byOperationId.length > 1 || byIdempotencyKey.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  const operation = byOperationId[0] ?? byIdempotencyKey[0] ?? null;
  if (operation === null) return null;
  if (
    byOperationId[0]?._id !== operation._id ||
    byIdempotencyKey[0]?._id !== operation._id ||
    operation.kind !== input.kind ||
    operation.operationId !== input.operationId ||
    operation.idempotencyKey !== input.idempotencyKey ||
    operation.bodyHash !== input.bodyHash
  ) {
    refuseProductionDataRelease("PUBLICATION_OPERATION_CONFLICT");
  }
  return await parseStoredReceipt(operation);
}

export async function storeProductionReceipt(
  ctx: MutationCtx,
  input: {
    operationId: string;
    operationKind: ProductionOperationKind;
    idempotencyKey: string;
    publicationId: string | null;
    terminalState: string;
    result: string;
    serverTime: string;
    requestDigest: string;
    releaseVersion?: string | null;
    observationSequence?: number | null;
    details: Readonly<Record<string, unknown>>;
  },
): Promise<ProductionReceipt> {
  const receiptWithoutDigest = {
    schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
    operationId: input.operationId,
    operationKind: input.operationKind,
    publicationId: input.publicationId,
    terminalState: input.terminalState,
    result: input.result,
    serverTime: input.serverTime,
    requestDigest: input.requestDigest,
    details: input.details,
  } as const;
  const receipt = productionReceiptSchema.parse({
    ...receiptWithoutDigest,
    receiptDigest: await productionReceiptHash(receiptWithoutDigest),
  });
  const receiptJson = canonicalJson(receipt);
  if (new TextEncoder().encode(receiptJson).byteLength > 16 * 1_024) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  await ctx.db.insert("dataReleaseOperations", {
    operationId: input.operationId,
    kind: input.operationKind,
    idempotencyKey: input.idempotencyKey,
    bodyHash: input.requestDigest,
    publicReleaseId: input.publicationId,
    observationSequence: input.observationSequence ?? null,
    status: "completed",
    result: input.result,
    convexReleaseVersion: input.releaseVersion ?? null,
    confirmationReceiptHash: receipt.receiptDigest,
    acceptedAt: input.serverTime,
    completedAt: input.serverTime,
    receiptJson,
  });
  return receipt;
}

export async function loadReceiptByOperationId(
  ctx: MutationCtx,
  operationId: string,
  publicationId: string | null,
): Promise<ProductionReceipt | null> {
  const operations = await ctx.db
    .query("dataReleaseOperations")
    .withIndex("by_operation_id", (index) => index.eq("operationId", operationId))
    .take(2);
  if (operations.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  const operation = operations[0] ?? null;
  if (operation === null) return null;
  if (
    publicationId !== null &&
    operation.publicReleaseId !== publicationId
  ) {
    refuseProductionDataRelease("PUBLICATION_OPERATION_CONFLICT");
  }
  return await parseStoredReceipt(operation);
}
