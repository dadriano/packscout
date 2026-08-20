import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  providerReleaseBlockReceiptSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseTerminalReceiptSha256,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import {
  buildProviderReleaseReceipt,
  loadExactProviderOperationReplay,
  storeProviderReleaseReceipt,
} from "./providerReleaseOperations";
import {
  assertProviderReleaseProof,
  assertProviderPlatformAuthority,
  assertProviderRequestDigest,
  parseProviderReleaseRequest,
} from "./providerReleaseRequests";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

export const block = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseBlockRequestSchema,
    );
    assertProviderPlatformAuthority(
      args.authenticatedKeyId,
      request.release.platformKey,
    );
    const replay = await loadExactProviderOperationReplay(ctx, {
      operationKind: "block",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    await assertProviderReleaseProof(request);
    const blocks = await ctx.db
      .query("providerCatalogReleaseBlocks")
      .withIndex("by_platform_key_and_provider_release_fingerprint", (index) =>
        index
          .eq("platformKey", request.release.platformKey)
          .eq(
            "providerReleaseFingerprint",
            request.release.providerReleaseFingerprint,
          ),
      )
      .take(2);
    if (blocks.length > 1) {
      refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
    }
    const existing = blocks[0] ?? null;
    const blockSequence = BigInt(request.blockSequence);
    if (existing !== null && blockSequence <= existing.blockSequence) {
      refuseProviderRelease("PROVIDER_RELEASE_BLOCK_SEQUENCE_REGRESSED");
    }

    const serverTime = new Date().toISOString();
    const receipt = await buildProviderReleaseReceipt(
      (value) => providerReleaseBlockReceiptSchema.parse(value),
      {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationKind: "block",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        platformKey: request.release.platformKey,
        publicProviderReleaseId: request.release.publicProviderReleaseId,
        sharedConfigurationEpoch: request.release.sharedConfigurationEpoch,
        providerCheckpoint: request.providerCheckpoint,
        terminalState: "blocked",
        result: "blocked",
        serverTime,
        requestDigest: args.requestDigest,
        details: {
          release: request.release,
          providerCheckpoint: request.providerCheckpoint,
          sourceWatermark: request.sourceWatermark,
          observation: request.observation,
          expectedCompletedHead: request.expectedCompletedHead,
          blockSequence: request.blockSequence,
          reason: request.reason,
        },
      },
    );
    const fields = {
      platformKey: request.release.platformKey,
      providerReleaseFingerprint: request.release.providerReleaseFingerprint,
      blockSequence,
      reason: request.reason,
      originatingOperationId: request.operationId,
      blockedAt: serverTime,
      terminalReceiptSha256:
        await providerReleaseTerminalReceiptSha256(receipt),
    } as const;
    if (existing === null) {
      await ctx.db.insert("providerCatalogReleaseBlocks", fields);
    } else {
      await ctx.db.replace(
        "providerCatalogReleaseBlocks",
        existing._id,
        fields,
      );
    }
    await storeProviderReleaseReceipt(ctx, receipt);
    return receipt;
  },
});
