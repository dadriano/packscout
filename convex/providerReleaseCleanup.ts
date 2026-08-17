import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  providerReleaseArtifactCleanupReceiptSchema,
  providerReleaseCleanupRequestSchema,
  providerReleaseNonceCleanupReceiptSchema,
  type ProviderReleaseCleanupRequest,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
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
  oneProviderCompletedHead,
} from "./providerReleaseState";
import {
  deleteProviderOwnedRows,
  deleteProviderReleaseOwnedDocuments,
} from "./providerReleaseDeletion";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

async function artifactCandidate(
  ctx: MutationCtx,
  platformKey: string,
  now: string,
): Promise<Doc<"providerCatalogReleases"> | null> {
  for (const lifecycle of ["staging", "failed"] as const) {
    const candidates = await ctx.db
      .query("providerCatalogReleases")
      .withIndex(
        "by_platform_key_and_lifecycle_and_retention_eligible_at",
        (index) =>
          index
            .eq("platformKey", platformKey)
            .eq("lifecycle", lifecycle)
            .lte("retentionEligibleAt", now),
      )
      .order("asc")
      .take(1);
    if (candidates[0] !== undefined) return candidates[0];
  }
  return null;
}

async function failStagingCandidateBeforeDeletion(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<Doc<"providerCatalogReleases">> {
  const [publications, completedHead] = await Promise.all([
    ctx.db
      .query("providerCatalogPublications")
      .withIndex("by_release_id", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(2),
    oneProviderCompletedHead(ctx, release.platformKey),
  ]);
  const publication = publications[0] ?? null;
  const publicationMatches = publication !== null &&
    publication.platformKey === release.platformKey &&
    publication.publicProviderReleaseId === release.publicProviderReleaseId;
  if (
    publications.length > 1 ||
    completedHead?.releaseId === release._id ||
    release.completedAt !== null ||
    release.completionOperationId !== null ||
    release.completionReceiptSha256 !== null
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_CLEANUP_UNSAFE");
  }
  if (release.lifecycle === "staging") {
    if (!publicationMatches || publication.state !== "staging") {
      refuseProviderRelease("PROVIDER_RELEASE_CLEANUP_UNSAFE");
    }
    await ctx.db.patch("providerCatalogReleases", release._id, {
      lifecycle: "failed",
    });
    await ctx.db.patch("providerCatalogPublications", publication._id, {
      state: "failed",
    });
    return { ...release, lifecycle: "failed" };
  }
  if (
    release.lifecycle !== "failed" ||
    (publication !== null &&
      (!publicationMatches || publication.state !== "failed"))
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_CLEANUP_UNSAFE");
  }
  return release;
}

async function cleanupArtifacts(
  ctx: MutationCtx,
  request: ProviderReleaseCleanupRequest,
  now: string,
) {
  const candidate = await artifactCandidate(ctx, request.platformKey, now);
  if (candidate === null) {
    return {
      deletedDocumentCount: 0,
      deletedStagingDocumentCount: 0,
      deletedFailedDocumentCount: 0,
      hasMore: false,
    };
  }
  const failedCandidate = await failStagingCandidateBeforeDeletion(
    ctx,
    candidate,
  );
  const deletion = await deleteProviderReleaseOwnedDocuments(
    ctx,
    failedCandidate._id,
    request.maximumDocuments,
  );
  const next = deletion.hasMore
    ? candidate
    : await artifactCandidate(ctx, request.platformKey, now);
  return {
    deletedDocumentCount: deletion.deletedDocumentCount,
    deletedStagingDocumentCount:
      candidate.lifecycle === "staging" ? deletion.deletedDocumentCount : 0,
    deletedFailedDocumentCount:
      candidate.lifecycle === "failed" ? deletion.deletedDocumentCount : 0,
    hasMore: next !== null,
  };
}

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
    const progress = request.cleanupKind === "expired_provider_artifacts"
      ? await cleanupArtifacts(ctx, request, serverTime)
      : await cleanupNonces(ctx, request.maximumDocuments, serverTime);
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
    const receipt = request.cleanupKind === "expired_provider_artifacts"
      ? await buildProviderReleaseReceipt(
          (value) => providerReleaseArtifactCleanupReceiptSchema.parse(value),
          receiptWithoutDigest,
        )
      : await buildProviderReleaseReceipt(
          (value) => providerReleaseNonceCleanupReceiptSchema.parse(value),
          receiptWithoutDigest,
        );
    await storeProviderReleaseReceipt(ctx, receipt);
    return receipt;
  },
});
