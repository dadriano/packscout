import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  providerReleaseCleanupRequestSchema,
  providerReleaseNonceCleanupReceiptSchema,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import {
  buildProviderReleaseReceipt,
  loadExactProviderOperationReplay,
  storeProviderReleaseReceipt,
} from "./providerReleaseOperations";
import {
  assertProviderRequestDigest,
  assertProviderPlatformAuthority,
  parseProviderReleaseRequest,
} from "./providerReleaseRequests";
import {
  expectedHeadMatchesStored,
} from "./providerReleaseState";
import {
  deleteProviderOwnedRows,
} from "./providerReleaseDeletion";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

async function cleanupNonces(
  ctx: MutationCtx,
  maximumDocuments: number,
  now: string,
) {
  const expired = await ctx.db
    .query("dataReleaseAuthNonces")
    .withIndex("by_expires_at", (index) => index.lte("expiresAt", now))
    .take(maximumDocuments + 1);
  const deletedNonceCount = await deleteProviderOwnedRows(
    ctx,
    expired,
    maximumDocuments,
  );
  return {
    deletedDocumentCount: deletedNonceCount,
    deletedNonceCount,
    hasMore: expired.length > maximumDocuments,
  };
}

export const cleanup = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseCleanupRequestSchema,
    );
    assertProviderPlatformAuthority(
      args.authenticatedKeyId,
      request.platformKey,
    );
    const replay = await loadExactProviderOperationReplay(ctx, {
      operationKind: "cleanup",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.platformKey,
      publicProviderReleaseId: null,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;
    if (!(await expectedHeadMatchesStored(ctx, request.expectedCompletedHead))) {
      refuseProviderRelease("PROVIDER_RELEASE_PREDECESSOR_CONFLICT");
    }

    const serverTime = new Date().toISOString();
    const progress = await cleanupNonces(
      ctx,
      request.maximumDocuments,
      serverTime,
    );
    const receiptWithoutDigest = {
      schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
      operationKind: "cleanup",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.platformKey,
      publicProviderReleaseId: null,
      terminalState: progress.hasMore
        ? "continuation_required"
        : "complete",
      result: "cleaned",
      serverTime,
      requestDigest: args.requestDigest,
      details: {
        cleanupKind: request.cleanupKind,
        expectedCompletedHead: request.expectedCompletedHead,
        maximumDocuments: request.maximumDocuments,
        ...progress,
      },
    };
    const receipt = await buildProviderReleaseReceipt(
      (value) => providerReleaseNonceCleanupReceiptSchema.parse(value),
      receiptWithoutDigest,
    );
    await storeProviderReleaseReceipt(ctx, receipt);
    return receipt;
  },
});
