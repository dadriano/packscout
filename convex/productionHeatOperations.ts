import {
  REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
  productionHeatReceiptHash,
  productionHeatReceiptSchema,
  type ProductionHeatOperationKind,
  type ProductionHeatReceipt,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

async function parseStoredReceipt(
  operation: Doc<"repackHeatOperations">,
): Promise<ProductionHeatReceipt> {
  if (
    operation.status !== "completed" ||
    operation.completedAt === null ||
    operation.confirmationReceiptHash === null ||
    operation.receiptJson === undefined
  ) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  try {
    const parsed = productionHeatReceiptSchema.parse(
      JSON.parse(operation.receiptJson) as unknown,
    );
    const { receiptDigest: _digest, ...withoutDigest } = parsed;
    void _digest;
    if (
      parsed.operationId !== operation.operationId ||
      parsed.operationKind !== operation.kind ||
      parsed.publicationId !== operation.publicationId ||
      parsed.requestDigest !== operation.bodyHash ||
      parsed.receiptDigest !== operation.confirmationReceiptHash ||
      parsed.receiptDigest !== await productionHeatReceiptHash(withoutDigest)
    ) {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    return parsed;
  } catch {
    return refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
}

export async function loadExactHeatOperationReplay(
  ctx: MutationCtx,
  input: Readonly<{
    kind: ProductionHeatOperationKind;
    operationId: string;
    idempotencyKey: string;
    bodyHash: string;
  }>,
): Promise<ProductionHeatReceipt | null> {
  const [byOperationId, byIdempotencyKey] = await Promise.all([
    ctx.db
      .query("repackHeatOperations")
      .withIndex("by_operation_id", (index) =>
        index.eq("operationId", input.operationId),
      )
      .take(2),
    ctx.db
      .query("repackHeatOperations")
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

export async function storeProductionHeatReceipt(
  ctx: MutationCtx,
  input: Readonly<{
    operationId: string;
    operationKind: ProductionHeatOperationKind;
    idempotencyKey: string;
    publicationId: string | null;
    terminalState: string;
    result: string;
    serverTime: string;
    requestDigest: string;
    details: Readonly<Record<string, unknown>>;
  }>,
): Promise<ProductionHeatReceipt> {
  const receiptWithoutDigest = {
    schemaVersion: REPACK_HEAT_PUBLICATION_SCHEMA_VERSION,
    operationId: input.operationId,
    operationKind: input.operationKind,
    publicationId: input.publicationId,
    terminalState: input.terminalState,
    result: input.result,
    serverTime: input.serverTime,
    requestDigest: input.requestDigest,
    details: input.details,
  } as const;
  const receipt = productionHeatReceiptSchema.parse({
    ...receiptWithoutDigest,
    receiptDigest: await productionHeatReceiptHash(receiptWithoutDigest),
  });
  const receiptJson = canonicalJson(receipt);
  if (new TextEncoder().encode(receiptJson).byteLength > 16 * 1_024) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  await ctx.db.insert("repackHeatOperations", {
    operationId: input.operationId,
    kind: input.operationKind,
    idempotencyKey: input.idempotencyKey,
    bodyHash: input.requestDigest,
    publicationId: input.publicationId,
    status: "completed",
    result: input.result,
    confirmationReceiptHash: receipt.receiptDigest,
    acceptedAt: input.serverTime,
    completedAt: input.serverTime,
    receiptJson,
  });
  return receipt;
}

export async function loadHeatReceiptByOperationId(
  ctx: MutationCtx,
  operationId: string,
  publicationId: string | null,
): Promise<ProductionHeatReceipt | null> {
  const operations = await ctx.db
    .query("repackHeatOperations")
    .withIndex("by_operation_id", (index) => index.eq("operationId", operationId))
    .take(2);
  if (operations.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  const operation = operations[0] ?? null;
  if (operation === null) return null;
  if (publicationId !== null && operation.publicationId !== publicationId) {
    refuseProductionDataRelease("PUBLICATION_OPERATION_CONFLICT");
  }
  return await parseStoredReceipt(operation);
}
