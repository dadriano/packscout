import {
  MAX_REPACK_SEARCH_SHARDS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  providerReleaseCompletionReceiptSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseReuseReceiptSchema,
  providerReleaseTerminalReceiptSha256,
  recomputeProviderCatalogSearchIndexHashV1,
  type ProviderReleaseConfirmReuseRequest,
  type ProviderReleaseFinalizeRequest,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import { assertProviderReleaseFinalization } from "./providerReleaseFinalization";
import {
  buildProviderReleaseReceipt,
  loadExactProviderOperationReplay,
  storeProviderReleaseReceipt,
} from "./providerReleaseOperations";
import {
  assertStoredProviderReleaseCompletion,
  providerReleaseProofMatches,
  storeProviderReleaseCompletionProof,
  storeProviderTerminalReceiptProof,
} from "./providerReleaseProof";
import {
  assertExpectedProviderHead,
  assertProviderPlatformAuthority,
  assertProviderReleaseNotBlocked,
  assertProviderReleaseProof,
  assertProviderRequestDigest,
  parseProviderReleaseRequest,
  providerRequestMatchesStaging,
} from "./providerReleaseRequests";
import {
  oneProviderCompletedHead,
  oneProviderPublication,
  oneProviderRelease,
} from "./providerReleaseState";

const COMPLETE_RETENTION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

function assertNewReleaseTransition(
  head: Doc<"providerCatalogCompletedHeads"> | null,
  request: ProviderReleaseFinalizeRequest,
): void {
  if (head === null) return;
  if (
    BigInt(request.providerCheckpoint.settledSequence) <=
      BigInt(head.providerCheckpoint.settledSequence) ||
    request.release.publicProviderReleaseId === head.publicProviderReleaseId
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_CHECKPOINT_REGRESSED");
  }
  const sameEpoch = canonicalJson(request.release.sharedConfigurationEpoch) ===
    canonicalJson(head.sharedConfigurationEpoch);
  if (
    !sameEpoch &&
    BigInt(request.release.sharedConfigurationEpoch.publicChangeSequence) <=
      BigInt(head.sharedConfigurationEpoch.publicChangeSequence)
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_EPOCH_CONFLICT");
  }
}

function assertReuseTransition(
  head: Doc<"providerCatalogCompletedHeads"> | null,
  request: ProviderReleaseConfirmReuseRequest,
): asserts head is Doc<"providerCatalogCompletedHeads"> {
  if (
    head === null ||
    head.publicProviderReleaseId !== request.release.publicProviderReleaseId ||
    canonicalJson(head.sharedConfigurationEpoch) !==
      canonicalJson(request.release.sharedConfigurationEpoch) ||
    BigInt(request.providerCheckpoint.settledSequence) <=
      BigInt(head.providerCheckpoint.settledSequence)
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_CHECKPOINT_REGRESSED");
  }
}

async function reconcileProviderSearchProof(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<boolean> {
  const proofs = await ctx.db
    .query("providerCatalogSearchShardProofs")
    .withIndex("by_release_id_and_shard_number", (index) =>
      index.eq("releaseId", release._id),
    )
    .order("asc")
    .take(MAX_REPACK_SEARCH_SHARDS + 1);
  if (
    proofs.length !== release.counts.searchShards ||
    proofs.some(({ shardNumber }, index) => shardNumber !== index)
  ) {
    return false;
  }
  return release.providerSearchIndexHash ===
    await recomputeProviderCatalogSearchIndexHashV1(proofs);
}

async function writeCompletedHead(
  ctx: MutationCtx,
  input: {
    previous: Doc<"providerCatalogCompletedHeads"> | null;
    release: Doc<"providerCatalogReleases">;
    request: ProviderReleaseFinalizeRequest | ProviderReleaseConfirmReuseRequest;
    terminalOperationKind: "finalize" | "confirmReuse";
    terminalReceiptSha256: string;
    serverTime: string;
  },
): Promise<void> {
  const fields = {
    platformKey: input.release.platformKey,
    releaseId: input.release._id,
    publicProviderReleaseId: input.release.publicProviderReleaseId,
    sharedConfigurationEpoch: input.release.sharedConfigurationEpoch,
    providerCheckpoint: input.request.providerCheckpoint,
    observation: input.request.observation,
    terminalReceiptSha256: input.terminalReceiptSha256,
    terminalOperationId: input.request.operationId,
    terminalOperationKind: input.terminalOperationKind,
    updatedAt: input.serverTime,
  } as const;
  if (input.previous === null) {
    await ctx.db.insert("providerCatalogCompletedHeads", fields);
  } else {
    await ctx.db.replace(
      "providerCatalogCompletedHeads",
      input.previous._id,
      fields,
    );
  }
}

export const finalize = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseFinalizeRequestSchema,
    );
    assertProviderPlatformAuthority(
      args.authenticatedKeyId,
      request.release.platformKey,
    );
    const replay = await loadExactProviderOperationReplay(ctx, {
      operationKind: "finalize",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    await assertProviderReleaseProof(request);
    const [publication, release] = await Promise.all([
      oneProviderPublication(ctx, request.release.publicProviderReleaseId),
      oneProviderRelease(
        ctx,
        request.release.platformKey,
        request.release.publicProviderReleaseId,
      ),
    ]);
    if (
      publication === null ||
      release === null ||
      !providerRequestMatchesStaging(request, release, publication)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
    }
    await assertProviderReleaseNotBlocked(
      ctx,
      release.platformKey,
      release.providerReleaseFingerprint,
    );
    await assertExpectedProviderHead(ctx, request);
    const previous = await oneProviderCompletedHead(ctx, release.platformKey);
    assertNewReleaseTransition(previous, request);
    if (
      publication.acceptedBatchCount !== publication.expectedBatchCount ||
      publication.acceptedBatchChainHash !==
        publication.expectedBatchChainHash ||
      canonicalJson(publication.acceptedCounts) !==
        canonicalJson(publication.expectedCounts) ||
      canonicalJson(publication.acceptedEntityHashes) !==
        canonicalJson(release.entityHashes) ||
      publication.acceptedSearchRowCount !== release.counts.repacks ||
      publication.unresolvedRepackCount !== 0 ||
      (publication.latestEvidenceAt !== null &&
        Date.parse(publication.latestEvidenceAt) > Date.now()) ||
      !(await reconcileProviderSearchProof(ctx, release))
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_RECONCILIATION_FAILED");
    }
    await assertProviderReleaseFinalization(ctx, release, publication);

    const serverTime = new Date().toISOString();
    const completedHead = {
      platformKey: release.platformKey,
      release: request.release,
      providerCheckpoint: request.providerCheckpoint,
      observation: request.observation,
    };
    const receipt = await buildProviderReleaseReceipt(
      (value) => providerReleaseCompletionReceiptSchema.parse(value),
      {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationKind: "finalize",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        platformKey: release.platformKey,
        publicProviderReleaseId: release.publicProviderReleaseId,
        sharedConfigurationEpoch: release.sharedConfigurationEpoch,
        providerCheckpoint: request.providerCheckpoint,
        terminalState: "complete",
        result: "completed",
        serverTime,
        requestDigest: args.requestDigest,
        details: {
          release: request.release,
          providerCheckpoint: request.providerCheckpoint,
          sourceWatermark: request.sourceWatermark,
          observation: request.observation,
          expectedCompletedHead: request.expectedCompletedHead,
          completedHead,
        },
      },
    );
    const terminalReceiptSha256 =
      await providerReleaseTerminalReceiptSha256(receipt);
    await ctx.db.patch("providerCatalogReleases", release._id, {
      lifecycle: "complete",
      completedAt: serverTime,
      completionOperationId: request.operationId,
      completionReceiptSha256: terminalReceiptSha256,
      retentionEligibleAt: new Date(
        Date.parse(serverTime) + COMPLETE_RETENTION_MILLISECONDS,
      ).toISOString(),
    });
    await ctx.db.patch("providerCatalogPublications", publication._id, {
      state: "complete",
      completedAt: serverTime,
    });
    await storeProviderReleaseReceipt(ctx, receipt);
    await storeProviderTerminalReceiptProof(ctx, {
      releaseId: release._id,
      releaseProof: request.release,
      operationId: request.operationId,
      operationKind: "finalize",
      requestDigest: args.requestDigest,
      completedAt: serverTime,
      terminalReceiptSha256,
      receiptDigest: receipt.receiptDigest,
    });
    await storeProviderReleaseCompletionProof(ctx, {
      releaseId: release._id,
      releaseProof: request.release,
      operationId: request.operationId,
      completedAt: serverTime,
      terminalReceiptSha256,
      receiptDigest: receipt.receiptDigest,
    });
    await writeCompletedHead(ctx, {
      previous,
      release,
      request,
      terminalOperationKind: "finalize",
      terminalReceiptSha256,
      serverTime,
    });
    return receipt;
  },
});

export const confirmReuse = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseConfirmReuseRequestSchema,
    );
    assertProviderPlatformAuthority(
      args.authenticatedKeyId,
      request.release.platformKey,
    );
    const replay = await loadExactProviderOperationReplay(ctx, {
      operationKind: "confirmReuse",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    await assertProviderReleaseProof(request);
    const release = await oneProviderRelease(
      ctx,
      request.release.platformKey,
      request.release.publicProviderReleaseId,
    );
    if (
      release === null ||
      release.lifecycle !== "complete" ||
      !providerReleaseProofMatches(release, request.release)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_IDENTITY_MISMATCH");
    }
    await assertStoredProviderReleaseCompletion(ctx, release);
    await assertProviderReleaseNotBlocked(
      ctx,
      release.platformKey,
      release.providerReleaseFingerprint,
    );
    await assertExpectedProviderHead(ctx, request);
    const previous = await oneProviderCompletedHead(ctx, release.platformKey);
    assertReuseTransition(previous, request);

    const serverTime = new Date().toISOString();
    const completedHead = {
      platformKey: release.platformKey,
      release: request.release,
      providerCheckpoint: request.providerCheckpoint,
      observation: request.observation,
    };
    const receipt = await buildProviderReleaseReceipt(
      (value) => providerReleaseReuseReceiptSchema.parse(value),
      {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationKind: "confirmReuse",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        platformKey: release.platformKey,
        publicProviderReleaseId: release.publicProviderReleaseId,
        sharedConfigurationEpoch: release.sharedConfigurationEpoch,
        providerCheckpoint: request.providerCheckpoint,
        terminalState: "complete",
        result: "reused",
        serverTime,
        requestDigest: args.requestDigest,
        details: {
          release: request.release,
          providerCheckpoint: request.providerCheckpoint,
          sourceWatermark: request.sourceWatermark,
          observation: request.observation,
          expectedCompletedHead: request.expectedCompletedHead,
          completedHead,
        },
      },
    );
    const terminalReceiptSha256 =
      await providerReleaseTerminalReceiptSha256(receipt);
    await storeProviderReleaseReceipt(ctx, receipt);
    await storeProviderTerminalReceiptProof(ctx, {
      releaseId: release._id,
      releaseProof: request.release,
      operationId: request.operationId,
      operationKind: "confirmReuse",
      requestDigest: args.requestDigest,
      completedAt: serverTime,
      terminalReceiptSha256,
      receiptDigest: receipt.receiptDigest,
    });
    await writeCompletedHead(ctx, {
      previous,
      release,
      request,
      terminalOperationKind: "confirmReuse",
      terminalReceiptSha256,
      serverTime,
    });
    return receipt;
  },
});
