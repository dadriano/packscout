import {
  canonicalJson,
  MAX_PROVIDER_RELEASE_RECEIPT_BYTES,
  providerReleaseReceiptDigest,
  providerReleaseReceiptSchema,
  providerReleaseTerminalReceiptSha256,
  type ProviderReleaseOperationKind,
  type ProviderReleaseReceipt,
  type ProviderReleaseStatusTarget,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";

export function providerReleaseReceiptJsonFitsStorageLimit(
  receiptJson: string,
): boolean {
  return new TextEncoder().encode(receiptJson).byteLength <=
    MAX_PROVIDER_RELEASE_RECEIPT_BYTES;
}

export type StoredProviderOperationKind = Exclude<
  ProviderReleaseOperationKind,
  "completedHead"
>;

async function parseStoredProviderReceipt(
  operation: Doc<"providerCatalogOperations">,
): Promise<ProviderReleaseReceipt> {
  try {
    const receipt = providerReleaseReceiptSchema.parse(
      JSON.parse(operation.receiptJson) as unknown,
    );
    if (
      receipt.operationKind === "completedHead" ||
      receipt.operationId !== operation.operationId ||
      receipt.operationKind !== operation.kind ||
      receipt.idempotencyKey !== operation.idempotencyKey ||
      receipt.platformKey !== operation.platformKey ||
      receipt.publicProviderReleaseId !== operation.publicProviderReleaseId ||
      receipt.requestDigest !== operation.bodyHash ||
      receipt.receiptDigest !== operation.confirmationReceiptHash ||
      operation.status !== "completed" ||
      receipt.result !== operation.result ||
      receipt.serverTime !== operation.acceptedAt ||
      receipt.serverTime !== operation.completedAt ||
      receipt.receiptDigest !== await providerReleaseReceiptDigest(receipt)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
    }
    return receipt;
  } catch {
    return refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
}

export async function loadProviderOperationById(
  ctx: MutationCtx | QueryCtx,
  operationId: string,
): Promise<{
  operation: Doc<"providerCatalogOperations">;
  receipt: ProviderReleaseReceipt;
  terminalReceiptSha256: string;
} | null> {
  const operations = await ctx.db
    .query("providerCatalogOperations")
    .withIndex("by_operation_id", (index) =>
      index.eq("operationId", operationId),
    )
    .take(2);
  if (operations.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  const operation = operations[0];
  if (operation === undefined) return null;
  const receipt = await parseStoredProviderReceipt(operation);
  return {
    operation,
    receipt,
    terminalReceiptSha256: await providerReleaseTerminalReceiptSha256(receipt),
  };
}

export async function loadExactProviderOperationReplay(
  ctx: MutationCtx,
  input: {
    operationKind: StoredProviderOperationKind;
    operationId: string;
    idempotencyKey: string;
    platformKey: string;
    publicProviderReleaseId: string | null;
    requestDigest: string;
  },
): Promise<ProviderReleaseReceipt | null> {
  const [byOperationId, byIdempotencyKey] = await Promise.all([
    ctx.db
      .query("providerCatalogOperations")
      .withIndex("by_operation_id", (index) =>
        index.eq("operationId", input.operationId),
      )
      .take(2),
    ctx.db
      .query("providerCatalogOperations")
      .withIndex("by_kind_and_idempotency_key", (index) =>
        index
          .eq("kind", input.operationKind)
          .eq("idempotencyKey", input.idempotencyKey),
      )
      .take(2),
  ]);
  if (byOperationId.length > 1 || byIdempotencyKey.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  const operation = byOperationId[0] ?? byIdempotencyKey[0] ?? null;
  if (operation === null) return null;
  if (
    byOperationId[0]?._id !== operation._id ||
    byIdempotencyKey[0]?._id !== operation._id ||
    operation.kind !== input.operationKind ||
    operation.operationId !== input.operationId ||
    operation.idempotencyKey !== input.idempotencyKey ||
    operation.platformKey !== input.platformKey ||
    operation.publicProviderReleaseId !== input.publicProviderReleaseId ||
    operation.bodyHash !== input.requestDigest
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_OPERATION_CONFLICT");
  }
  return await parseStoredProviderReceipt(operation);
}

export async function loadProviderStatusReceipt(
  ctx: MutationCtx,
  target: ProviderReleaseStatusTarget,
): Promise<ProviderReleaseReceipt | null> {
  const loaded = await loadProviderOperationById(ctx, target.operationId);
  if (loaded === null) return null;
  const { operation, receipt } = loaded;
  if (
    operation.kind !== target.operationKind ||
    operation.idempotencyKey !== target.idempotencyKey ||
    operation.platformKey !== target.platformKey ||
    operation.publicProviderReleaseId !== target.publicProviderReleaseId ||
    operation.bodyHash !== target.requestDigest
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_OPERATION_CONFLICT");
  }
  return receipt;
}

export async function storeProviderReleaseReceipt(
  ctx: MutationCtx,
  receipt: ProviderReleaseReceipt,
): Promise<void> {
  if (receipt.operationKind === "completedHead") {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  const receiptJson = canonicalJson(receipt);
  if (!providerReleaseReceiptJsonFitsStorageLimit(receiptJson)) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  await ctx.db.insert("providerCatalogOperations", {
    operationId: receipt.operationId,
    kind: receipt.operationKind,
    idempotencyKey: receipt.idempotencyKey,
    bodyHash: receipt.requestDigest,
    platformKey: receipt.platformKey,
    publicProviderReleaseId: receipt.publicProviderReleaseId,
    status: "completed",
    result: receipt.result,
    confirmationReceiptHash: receipt.receiptDigest,
    acceptedAt: receipt.serverTime,
    completedAt: receipt.serverTime,
    receiptJson,
  });
}

export async function buildProviderReleaseReceipt<T>(
  parse: (value: unknown) => T,
  receiptWithoutDigest: unknown,
): Promise<T> {
  return parse({
    ...(receiptWithoutDigest as Record<string, unknown>),
    receiptDigest: await providerReleaseReceiptDigest(receiptWithoutDigest),
  });
}
