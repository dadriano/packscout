import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  catalogManifestBlockReceiptSchema,
  catalogManifestBlockRequestSchema,
  type CatalogManifestBlockRequest,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { refuseCatalogManifest } from "./catalogManifestErrors";
import {
  buildCatalogManifestReceipt,
  loadExactCatalogManifestReplay,
  storeCatalogManifestReceipt,
} from "./catalogManifestOperations";
import {
  assertCatalogManifestRequestDigest,
  assertCatalogManifestRole,
  parseCatalogManifestRequest,
} from "./catalogManifestRequests";
import {
  loadActiveCatalogManifestState,
  loadCatalogManifestByPublicReleaseId,
} from "./catalogManifestState";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

export async function blockCatalogManifestRequest(
  ctx: MutationCtx,
  request: CatalogManifestBlockRequest,
  requestDigest: string,
) {
  const replay = await loadExactCatalogManifestReplay(ctx, {
    operationKind: "block",
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    publicReleaseId: request.publicReleaseId,
    manifestFingerprint: request.manifestFingerprint,
    rollbackKind: null,
    requestDigest,
  });
  if (replay !== null) {
    if (replay.operationKind !== "block") {
      refuseCatalogManifest("CATALOG_MANIFEST_OPERATION_CONFLICT");
    }
    return replay;
  }
  const active = await loadActiveCatalogManifestState(ctx);
  if (
    active.state.activeManifest?.manifestFingerprint ===
      request.manifestFingerprint
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const manifest = await loadCatalogManifestByPublicReleaseId(
    ctx,
    request.publicReleaseId,
  );
  if (
    manifest !== null &&
    manifest.manifestFingerprint !== request.manifestFingerprint
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_IDENTITY_MISMATCH");
  }
  const blocks = await ctx.db
    .query("catalogManifestBlocks")
    .withIndex("by_manifest_fingerprint", (index) =>
      index.eq("manifestFingerprint", request.manifestFingerprint),
    )
    .take(2);
  if (blocks.length > 1) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const existing = blocks[0] ?? null;
  if (
    existing !== null &&
    existing.publicReleaseId !== request.publicReleaseId
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_IDENTITY_MISMATCH");
  }
  const blockSequence = BigInt(request.blockSequence);
  if (existing !== null && blockSequence <= existing.blockSequence) {
    refuseCatalogManifest("CATALOG_MANIFEST_BLOCK_SEQUENCE_REGRESSED");
  }
  const serverTime = new Date().toISOString();
  const receipt = await buildCatalogManifestReceipt(
    (value) => catalogManifestBlockReceiptSchema.parse(value),
    {
      schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
      operationKind: "block",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      manifestFingerprint: request.manifestFingerprint,
      terminalState: "blocked",
      result: "blocked",
      serverTime,
      requestDigest,
      details: {
        blockSequence: request.blockSequence,
        reason: request.reason,
      },
    },
  );
  const terminalReceiptSha256 = await storeCatalogManifestReceipt(ctx, receipt);
  const fields = {
    publicReleaseId: request.publicReleaseId,
    manifestFingerprint: request.manifestFingerprint,
    blockSequence,
    reason: request.reason,
    originatingOperationId: request.operationId,
    blockedAt: serverTime,
    terminalReceiptSha256,
  } as const;
  if (existing === null) {
    await ctx.db.insert("catalogManifestBlocks", fields);
  } else {
    await ctx.db.replace("catalogManifestBlocks", existing._id, fields);
  }
  return receipt;
}

export const block = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogManifestRequestDigest(args.requestDigest);
    assertCatalogManifestRole(args.authenticatedKeyId, "publish");
    const request = parseCatalogManifestRequest(
      args.bodyJson,
      catalogManifestBlockRequestSchema,
    );
    return await blockCatalogManifestRequest(ctx, request, args.requestDigest);
  },
});
