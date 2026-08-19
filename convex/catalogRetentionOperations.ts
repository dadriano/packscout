import {
  CATALOG_RETENTION_OPERATION_RECEIPT_MILLISECONDS,
  MAX_CATALOG_RETENTION_HTTP_BODY_BYTES,
  MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS,
  MAX_CATALOG_RETENTION_OPERATION_RECEIPTS,
  canonicalJson,
  catalogRetentionReceiptDigest,
  catalogRetentionReceiptSchema,
  catalogRetentionTerminalReceiptSha256,
  type CatalogRetentionOperationKind,
  type CatalogRetentionReceipt,
  type CatalogRetentionStatusTarget,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { refuseCatalogRetention } from "./catalogRetentionErrors";

function receiptJsonFits(value: string): boolean {
  return new TextEncoder().encode(value).byteLength <=
    MAX_CATALOG_RETENTION_HTTP_BODY_BYTES;
}

async function parseStoredReceipt(
  operation: Doc<"catalogRetentionOperations">,
): Promise<CatalogRetentionReceipt> {
  try {
    const receipt = catalogRetentionReceiptSchema.parse(
      JSON.parse(operation.receiptJson) as unknown,
    );
    if (
      receipt.operationId !== operation.operationId ||
      receipt.operationKind !== operation.kind ||
      receipt.idempotencyKey !== operation.idempotencyKey ||
      receipt.phase !== operation.phase ||
      receipt.platformKey !== operation.platformKey ||
      receipt.requestDigest !== operation.bodyHash ||
      receipt.expectedRetentionGeneration !== operation.expectedGeneration ||
      receipt.retentionGeneration !== operation.resultGeneration ||
      receipt.receiptDigest !== operation.receiptDigest ||
      receipt.serverTime !== operation.completedAt ||
      operation.status !== "completed" || operation.result !== "retained" ||
      receipt.receiptDigest !== await catalogRetentionReceiptDigest(receipt) ||
      operation.terminalReceiptSha256 !==
        await catalogRetentionTerminalReceiptSha256(receipt) ||
      operation.expiresAt !== new Date(
        Date.parse(operation.completedAt) +
          CATALOG_RETENTION_OPERATION_RECEIPT_MILLISECONDS,
      ).toISOString()
    ) {
      refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
    }
    return receipt;
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
  }
}

export async function loadCatalogRetentionOperationById(
  ctx: MutationCtx,
  operationId: string,
): Promise<{
  operation: Doc<"catalogRetentionOperations">;
  receipt: CatalogRetentionReceipt;
} | null> {
  const operations = await ctx.db
    .query("catalogRetentionOperations")
    .withIndex("by_operation_id", (index) =>
      index.eq("operationId", operationId),
    )
    .take(2);
  if (operations.length > 1) {
    refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
  }
  const operation = operations[0];
  return operation === undefined
    ? null
    : { operation, receipt: await parseStoredReceipt(operation) };
}

export async function loadExactCatalogRetentionReplay(
  ctx: MutationCtx,
  input: Readonly<{
    operationKind: CatalogRetentionOperationKind;
    operationId: string;
    idempotencyKey: string;
    phase: "manifests" | "provider_releases";
    platformKey: string | null;
    requestDigest: string;
    expectedGeneration: number;
  }>,
): Promise<CatalogRetentionReceipt | null> {
  const [byOperationId, byIdempotencyKey] = await Promise.all([
    ctx.db
      .query("catalogRetentionOperations")
      .withIndex("by_operation_id", (index) =>
        index.eq("operationId", input.operationId),
      )
      .take(2),
    ctx.db
      .query("catalogRetentionOperations")
      .withIndex("by_kind_and_idempotency_key", (index) =>
        index
          .eq("kind", input.operationKind)
          .eq("idempotencyKey", input.idempotencyKey),
      )
      .take(2),
  ]);
  if (byOperationId.length > 1 || byIdempotencyKey.length > 1) {
    refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
  }
  const operation = byOperationId[0] ?? byIdempotencyKey[0] ?? null;
  if (operation === null) return null;
  if (
    byOperationId[0]?._id !== operation._id ||
    byIdempotencyKey[0]?._id !== operation._id ||
    operation.kind !== input.operationKind ||
    operation.operationId !== input.operationId ||
    operation.idempotencyKey !== input.idempotencyKey ||
    operation.phase !== input.phase ||
    operation.platformKey !== input.platformKey ||
    operation.bodyHash !== input.requestDigest ||
    operation.expectedGeneration !== input.expectedGeneration
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_OPERATION_CONFLICT");
  }
  return await parseStoredReceipt(operation);
}

export async function loadCatalogRetentionStatusReceipt(
  ctx: MutationCtx,
  target: CatalogRetentionStatusTarget,
): Promise<CatalogRetentionReceipt | null> {
  const loaded = await loadCatalogRetentionOperationById(
    ctx,
    target.operationId,
  );
  if (loaded === null) return null;
  const { operation, receipt } = loaded;
  if (
    operation.kind !== target.operationKind ||
    operation.idempotencyKey !== target.idempotencyKey ||
    operation.phase !== target.phase ||
    operation.platformKey !== target.platformKey ||
    operation.bodyHash !== target.requestDigest
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_OPERATION_CONFLICT");
  }
  return receipt;
}

export async function pruneCatalogRetentionOperations(
  ctx: MutationCtx,
  serverTime: string,
): Promise<{ deletedCount: number; hasMore: boolean }> {
  const selected = new Map<
    Doc<"catalogRetentionOperations">["_id"],
    Doc<"catalogRetentionOperations">
  >();
  const expired = await ctx.db
    .query("catalogRetentionOperations")
    .withIndex("by_expires_at", (index) =>
      index.lte("expiresAt", serverTime),
    )
    .order("asc")
    .take(MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS + 1);
  for (const operation of expired) {
    if (selected.size === MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS) break;
    selected.set(operation._id, operation);
  }
  if (selected.size < MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS) {
    const oldest = await ctx.db
      .query("catalogRetentionOperations")
      .withIndex("by_completed_at")
      .order("asc")
      .take(
        MAX_CATALOG_RETENTION_OPERATION_RECEIPTS +
          MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS,
      );
    const existingAllowedBeforeInsert =
      MAX_CATALOG_RETENTION_OPERATION_RECEIPTS - 1;
    const overflow = Math.max(0, oldest.length - existingAllowedBeforeInsert);
    for (const operation of oldest.slice(0, overflow)) {
      if (selected.size === MAX_CATALOG_RETENTION_JOURNAL_PRUNE_DOCUMENTS) break;
      selected.set(operation._id, operation);
    }
  }
  for (const operation of selected.values()) {
    await ctx.db.delete("catalogRetentionOperations", operation._id);
  }
  const [remainingExpired, remainingCountWindow] = await Promise.all([
    ctx.db
      .query("catalogRetentionOperations")
      .withIndex("by_expires_at", (index) =>
        index.lte("expiresAt", serverTime),
      )
      .take(1),
    ctx.db
      .query("catalogRetentionOperations")
      .withIndex("by_completed_at")
      .order("asc")
      .take(MAX_CATALOG_RETENTION_OPERATION_RECEIPTS),
  ]);
  return {
    deletedCount: selected.size,
    hasMore: remainingExpired.length !== 0 ||
      remainingCountWindow.length >= MAX_CATALOG_RETENTION_OPERATION_RECEIPTS,
  };
}

export async function storeCatalogRetentionReceipt(
  ctx: MutationCtx,
  receipt: CatalogRetentionReceipt,
): Promise<void> {
  const receiptJson = canonicalJson(receipt);
  if (!receiptJsonFits(receiptJson)) {
    refuseCatalogRetention("CATALOG_RETENTION_STATE_CONFLICT");
  }
  await ctx.db.insert("catalogRetentionOperations", {
    operationId: receipt.operationId,
    kind: receipt.operationKind,
    idempotencyKey: receipt.idempotencyKey,
    phase: receipt.phase,
    platformKey: receipt.platformKey,
    bodyHash: receipt.requestDigest,
    expectedGeneration: receipt.expectedRetentionGeneration,
    resultGeneration: receipt.retentionGeneration,
    status: "completed",
    result: "retained",
    receiptDigest: receipt.receiptDigest,
    terminalReceiptSha256:
      await catalogRetentionTerminalReceiptSha256(receipt),
    completedAt: receipt.serverTime,
    expiresAt: new Date(
      Date.parse(receipt.serverTime) +
        CATALOG_RETENTION_OPERATION_RECEIPT_MILLISECONDS,
    ).toISOString(),
    receiptJson,
  });
}

export async function buildCatalogRetentionReceipt<T>(
  parse: (value: unknown) => T,
  receiptWithoutDigest: unknown,
): Promise<T> {
  return parse({
    ...(receiptWithoutDigest as Record<string, unknown>),
    receiptDigest: await catalogRetentionReceiptDigest(receiptWithoutDigest),
  });
}
