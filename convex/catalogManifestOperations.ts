import {
  MAX_CATALOG_MANIFEST_RECEIPT_BYTES,
  canonicalJson,
  catalogManifestReceiptDigest,
  catalogManifestReceiptSchema,
  catalogManifestTerminalReceiptSha256,
  type CatalogManifestOperationKind,
  type CatalogManifestReceipt,
  type CatalogManifestStatusTarget,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseCatalogManifest } from "./catalogManifestErrors";

export type StoredCatalogManifestOperationKind = Exclude<
  CatalogManifestOperationKind,
  "activeState"
>;
export type StoredCatalogManifestReceipt = Exclude<
  CatalogManifestReceipt,
  { operationKind: "activeState" }
>;

function receiptJsonFitsStorageLimit(receiptJson: string): boolean {
  return new TextEncoder().encode(receiptJson).byteLength <=
    MAX_CATALOG_MANIFEST_RECEIPT_BYTES;
}

async function parseStoredCatalogManifestReceipt(
  operation: Doc<"catalogManifestOperations">,
): Promise<StoredCatalogManifestReceipt> {
  try {
    const receipt = catalogManifestReceiptSchema.parse(
      JSON.parse(operation.receiptJson) as unknown,
    );
    if (
      receipt.operationKind === "activeState" ||
      receipt.operationId !== operation.operationId ||
      receipt.operationKind !== operation.kind ||
      receipt.idempotencyKey !== operation.idempotencyKey ||
      receipt.publicReleaseId !== operation.publicReleaseId ||
      receipt.manifestFingerprint !== operation.manifestFingerprint ||
      (receipt.operationKind === "rollback"
        ? receipt.rollbackKind
        : null) !== operation.rollbackKind ||
      receipt.requestDigest !== operation.bodyHash ||
      receipt.receiptDigest !== operation.confirmationReceiptHash ||
      operation.status !== "completed" ||
      receipt.result !== operation.result ||
      receipt.serverTime !== operation.acceptedAt ||
      receipt.serverTime !== operation.completedAt ||
      receipt.receiptDigest !== await catalogManifestReceiptDigest(receipt) ||
      operation.terminalReceiptSha256 !==
        await catalogManifestTerminalReceiptSha256(receipt)
    ) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    return receipt;
  } catch {
    return refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
}

export async function loadCatalogManifestOperationById(
  ctx: MutationCtx | QueryCtx,
  operationId: string,
): Promise<{
  operation: Doc<"catalogManifestOperations">;
  receipt: StoredCatalogManifestReceipt;
} | null> {
  const operations = await ctx.db
    .query("catalogManifestOperations")
    .withIndex("by_operation_id", (index) =>
      index.eq("operationId", operationId),
    )
    .take(2);
  if (operations.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const operation = operations[0];
  if (operation === undefined) return null;
  return {
    operation,
    receipt: await parseStoredCatalogManifestReceipt(operation),
  };
}

export async function loadExactCatalogManifestReplay(
  ctx: MutationCtx,
  input: Readonly<{
    operationKind: StoredCatalogManifestOperationKind;
    operationId: string;
    idempotencyKey: string;
    publicReleaseId: string | null;
    manifestFingerprint: string | null;
    rollbackKind: "manifest" | "clear" | null;
    requestDigest: string;
  }>,
): Promise<StoredCatalogManifestReceipt | null> {
  const [byOperationId, byIdempotencyKey] = await Promise.all([
    ctx.db
      .query("catalogManifestOperations")
      .withIndex("by_operation_id", (index) =>
        index.eq("operationId", input.operationId),
      )
      .take(2),
    ctx.db
      .query("catalogManifestOperations")
      .withIndex("by_kind_and_idempotency_key", (index) =>
        index
          .eq("kind", input.operationKind)
          .eq("idempotencyKey", input.idempotencyKey),
      )
      .take(2),
  ]);
  if (byOperationId.length > 1 || byIdempotencyKey.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const operation = byOperationId[0] ?? byIdempotencyKey[0] ?? null;
  if (operation === null) return null;
  if (
    byOperationId[0]?._id !== operation._id ||
    byIdempotencyKey[0]?._id !== operation._id ||
    operation.kind !== input.operationKind ||
    operation.operationId !== input.operationId ||
    operation.idempotencyKey !== input.idempotencyKey ||
    operation.publicReleaseId !== input.publicReleaseId ||
    operation.manifestFingerprint !== input.manifestFingerprint ||
    operation.rollbackKind !== input.rollbackKind ||
    operation.bodyHash !== input.requestDigest
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_OPERATION_CONFLICT");
  }
  return await parseStoredCatalogManifestReceipt(operation);
}

export async function loadCatalogManifestStatusReceipt(
  ctx: MutationCtx,
  target: CatalogManifestStatusTarget,
): Promise<StoredCatalogManifestReceipt | null> {
  const loaded = await loadCatalogManifestOperationById(
    ctx,
    target.operationId,
  );
  if (loaded === null) return null;
  const { operation, receipt } = loaded;
  if (
    operation.kind !== target.operationKind ||
    operation.idempotencyKey !== target.idempotencyKey ||
    operation.publicReleaseId !== target.publicReleaseId ||
    operation.manifestFingerprint !== target.manifestFingerprint ||
    operation.rollbackKind !==
      (target.operationKind === "rollback" ? target.rollbackKind : null) ||
    operation.bodyHash !== target.requestDigest
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_OPERATION_CONFLICT");
  }
  return receipt;
}

export async function storeCatalogManifestReceipt(
  ctx: MutationCtx,
  receipt: StoredCatalogManifestReceipt,
): Promise<string> {
  const receiptJson = canonicalJson(receipt);
  if (!receiptJsonFitsStorageLimit(receiptJson)) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const terminalReceiptSha256 =
    await catalogManifestTerminalReceiptSha256(receipt);
  await ctx.db.insert("catalogManifestOperations", {
    operationId: receipt.operationId,
    kind: receipt.operationKind,
    idempotencyKey: receipt.idempotencyKey,
    bodyHash: receipt.requestDigest,
    publicReleaseId: receipt.publicReleaseId,
    manifestFingerprint: receipt.manifestFingerprint,
    rollbackKind: receipt.operationKind === "rollback"
      ? receipt.rollbackKind
      : null,
    status: "completed",
    result: receipt.result,
    confirmationReceiptHash: receipt.receiptDigest,
    terminalReceiptSha256,
    acceptedAt: receipt.serverTime,
    completedAt: receipt.serverTime,
    receiptJson,
  });
  return terminalReceiptSha256;
}

export async function buildCatalogManifestReceipt<T>(
  parse: (value: unknown) => T,
  receiptWithoutDigest: unknown,
): Promise<T> {
  return parse({
    ...(receiptWithoutDigest as Record<string, unknown>),
    receiptDigest: await catalogManifestReceiptDigest(receiptWithoutDigest),
  });
}
