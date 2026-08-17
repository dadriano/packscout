import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  catalogRetentionManifestReceiptSchema,
  catalogRetentionManifestRequestSchema,
  catalogRetentionProviderReceiptSchema,
  catalogRetentionProviderRequestSchema,
  type CatalogRetentionManifestRequest,
  type CatalogRetentionProviderRequest,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  buildCatalogRetentionGraph,
  selectCatalogManifestRetentionCandidate,
  selectProviderRetentionCandidate,
} from "./catalogRetentionGraph";
import {
  buildCatalogRetentionReceipt,
  loadExactCatalogRetentionReplay,
  pruneCatalogRetentionOperations,
  storeCatalogRetentionReceipt,
} from "./catalogRetentionOperations";
import {
  assertCatalogRetentionPostgresProofDigest,
  assertCatalogRetentionRequestDigest,
  assertCatalogRetentionRole,
  parseCatalogRetentionRequest,
} from "./catalogRetentionRequests";
import {
  advanceCatalogRetentionGeneration,
  assertCatalogRetentionGeneration,
} from "./catalogRetentionState";
import { refuseCatalogRetention } from "./catalogRetentionErrors";
import { assertExactCatalogManifestProviderReferences } from
  "./catalogManifestRetentionReferences";
import { deleteProviderReleaseOwnedDocuments } from
  "./providerReleaseDeletion";
import { assertStoredProviderReleaseCompletion } from "./providerReleaseProof";
import { oneProviderCompletedHead } from "./providerReleaseState";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

async function validateRequest(
  request: CatalogRetentionManifestRequest | CatalogRetentionProviderRequest,
): Promise<void> {
  await assertCatalogRetentionPostgresProofDigest(request.postgresProof);
}

async function retireProviderCandidate(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<Doc<"providerCatalogReleases">> {
  let head;
  try {
    head = await oneProviderCompletedHead(ctx, release.platformKey);
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  if (head?.releaseId === release._id) {
    refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
  }
  const publications = await ctx.db
    .query("providerCatalogPublications")
    .withIndex("by_release_id", (index) => index.eq("releaseId", release._id))
    .take(2);
  if (publications.length > 1) {
    refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  const publication = publications[0] ?? null;
  if (release.lifecycle === "staging") {
    if (
      publication === null || publication.state !== "staging" ||
      release.completedAt !== null || release.completionOperationId !== null ||
      release.completionReceiptSha256 !== null
    ) {
      refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
    }
    await ctx.db.patch("providerCatalogReleases", release._id, {
      lifecycle: "failed",
    });
    await ctx.db.patch("providerCatalogPublications", publication._id, {
      state: "failed",
    });
    return { ...release, lifecycle: "failed" };
  }
  if (release.lifecycle === "failed") {
    if (publication !== null && publication.state !== "failed") {
      refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
    }
    return release;
  }
  if (release.lifecycle !== "complete" && release.lifecycle !== "retired") {
    refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
  }
  const completed = release.lifecycle === "complete"
    ? release
    : { ...release, lifecycle: "complete" as const };
  try {
    await assertStoredProviderReleaseCompletion(ctx, completed);
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  if (publication !== null && publication.state !== "complete") {
    refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  if (release.lifecycle === "complete") {
    await ctx.db.patch("providerCatalogReleases", release._id, {
      lifecycle: "retired",
    });
    return { ...release, lifecycle: "retired" };
  }
  return release;
}

async function retainManifestsRequest(
  ctx: MutationCtx,
  request: CatalogRetentionManifestRequest,
  requestDigest: string,
) {
  const replay = await loadExactCatalogRetentionReplay(ctx, {
    operationKind: "retainManifests",
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    phase: request.phase,
    platformKey: null,
    requestDigest,
    expectedGeneration: request.expectedRetentionGeneration,
  });
  if (replay !== null) return replay;
  await validateRequest(request);
  const retentionState = await assertCatalogRetentionGeneration(
    ctx,
    request.expectedRetentionGeneration,
  );
  const serverTime = new Date().toISOString();
  const before = await buildCatalogRetentionGraph(
    ctx,
    request.postgresProof,
    serverTime,
  );
  const selected = await selectCatalogManifestRetentionCandidate(
    ctx,
    before.manifests,
    serverTime,
  );
  let deletedManifestCount = 0;
  let deletedManifestReferenceCount = 0;
  if (selected !== null) {
    if (before.manifests.has(selected._id)) {
      refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
    }
    let references;
    try {
      references = await assertExactCatalogManifestProviderReferences(
        ctx,
        selected,
      );
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    if (references.length + 1 > request.maximumDocuments) {
      refuseCatalogRetention("CATALOG_RETENTION_REQUEST_INVALID");
    }
    for (const reference of references) {
      await ctx.db.delete("catalogManifestProviderReferences", reference._id);
    }
    await ctx.db.delete("globalCatalogManifests", selected._id);
    deletedManifestCount = 1;
    deletedManifestReferenceCount = references.length;
  }
  const pruned = await pruneCatalogRetentionOperations(ctx, serverTime);
  const retentionGeneration = await advanceCatalogRetentionGeneration(
    ctx,
    retentionState,
    serverTime,
  );
  const after = await buildCatalogRetentionGraph(
    ctx,
    request.postgresProof,
    serverTime,
  );
  const next = await selectCatalogManifestRetentionCandidate(
    ctx,
    after.manifests,
    serverTime,
  );
  const hasMore = next !== null || pruned.hasMore;
  const receipt = await buildCatalogRetentionReceipt(
    (value) => catalogRetentionManifestReceiptSchema.parse(value),
    {
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      operationKind: "retainManifests",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      terminalState: hasMore ? "continuation_required" : "complete",
      result: "retained",
      serverTime,
      requestDigest,
      expectedRetentionGeneration: request.expectedRetentionGeneration,
      retentionGeneration,
      phase: "manifests",
      platformKey: null,
      details: {
        maximumDocuments: request.maximumDocuments,
        deletedDocumentCount: deletedManifestCount +
          deletedManifestReferenceCount + pruned.deletedCount,
        deletedRetentionOperationCount: pruned.deletedCount,
        hasMore,
        protectionSet: after.protectionSet,
        selectedManifest: selected === null
          ? null
          : {
              publicReleaseId: selected.publicReleaseId,
              manifestFingerprint: selected.manifestFingerprint,
              lifecycle: selected.lifecycle,
            },
        deletedManifestCount,
        deletedManifestReferenceCount,
      },
    },
  );
  await storeCatalogRetentionReceipt(ctx, receipt);
  return receipt;
}

async function retainProviderRequest(
  ctx: MutationCtx,
  request: CatalogRetentionProviderRequest,
  requestDigest: string,
) {
  const replay = await loadExactCatalogRetentionReplay(ctx, {
    operationKind: "retainProviderReleases",
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    phase: request.phase,
    platformKey: request.platformKey,
    requestDigest,
    expectedGeneration: request.expectedRetentionGeneration,
  });
  if (replay !== null) return replay;
  await validateRequest(request);
  const retentionState = await assertCatalogRetentionGeneration(
    ctx,
    request.expectedRetentionGeneration,
  );
  const serverTime = new Date().toISOString();
  const before = await buildCatalogRetentionGraph(
    ctx,
    request.postgresProof,
    serverTime,
  );
  if (!before.configuredPlatforms.includes(request.platformKey)) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  if (
    await selectCatalogManifestRetentionCandidate(
      ctx,
      before.manifests,
      serverTime,
    ) !== null
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
  }
  const protectedReleases = before.providerReleasesByPlatform.get(
    request.platformKey,
  );
  if (protectedReleases === undefined) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  const selected = await selectProviderRetentionCandidate(
    ctx,
    request.platformKey,
    protectedReleases,
    serverTime,
  );
  let deletedProviderOwnedDocumentCount = 0;
  let deletedProviderReleaseCount = 0;
  let selectedForReceipt = selected;
  let partial = false;
  if (selected !== null) {
    const retired = await retireProviderCandidate(ctx, selected);
    selectedForReceipt = retired;
    const deletion = await deleteProviderReleaseOwnedDocuments(
      ctx,
      retired._id,
      request.maximumDocuments,
    );
    deletedProviderOwnedDocumentCount = deletion.deletedDocumentCount;
    deletedProviderReleaseCount = deletion.hasMore ? 0 : 1;
    partial = deletion.hasMore;
  }
  const pruned = await pruneCatalogRetentionOperations(ctx, serverTime);
  const retentionGeneration = await advanceCatalogRetentionGeneration(
    ctx,
    retentionState,
    serverTime,
  );
  const after = await buildCatalogRetentionGraph(
    ctx,
    request.postgresProof,
    serverTime,
  );
  const afterProtected = after.providerReleasesByPlatform.get(
    request.platformKey,
  );
  if (afterProtected === undefined) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  const next = await selectProviderRetentionCandidate(
    ctx,
    request.platformKey,
    afterProtected,
    serverTime,
  );
  const hasMore = partial || next !== null || pruned.hasMore;
  const receipt = await buildCatalogRetentionReceipt(
    (value) => catalogRetentionProviderReceiptSchema.parse(value),
    {
      schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
      operationKind: "retainProviderReleases",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      terminalState: hasMore ? "continuation_required" : "complete",
      result: "retained",
      serverTime,
      requestDigest,
      expectedRetentionGeneration: request.expectedRetentionGeneration,
      retentionGeneration,
      phase: "provider_releases",
      platformKey: request.platformKey,
      details: {
        maximumDocuments: request.maximumDocuments,
        deletedDocumentCount: deletedProviderOwnedDocumentCount +
          pruned.deletedCount,
        deletedRetentionOperationCount: pruned.deletedCount,
        hasMore,
        protectionSet: after.protectionSet,
        manifestPhaseComplete: true,
        selectedProviderRelease: selectedForReceipt === null
          ? null
          : {
              platformKey: selectedForReceipt.platformKey,
              publicProviderReleaseId:
                selectedForReceipt.publicProviderReleaseId,
              providerReleaseFingerprint:
                selectedForReceipt.providerReleaseFingerprint,
              lifecycle: selectedForReceipt.lifecycle,
            },
        deletedProviderReleaseCount,
        deletedProviderOwnedDocumentCount,
      },
    },
  );
  await storeCatalogRetentionReceipt(ctx, receipt);
  return receipt;
}

export const retainManifests = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogRetentionRequestDigest(args.requestDigest);
    assertCatalogRetentionRole(args.authenticatedKeyId);
    const request = parseCatalogRetentionRequest(
      args.bodyJson,
      catalogRetentionManifestRequestSchema,
    );
    return await retainManifestsRequest(ctx, request, args.requestDigest);
  },
});

export const retainProviderReleases = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertCatalogRetentionRequestDigest(args.requestDigest);
    assertCatalogRetentionRole(args.authenticatedKeyId);
    const request = parseCatalogRetentionRequest(
      args.bodyJson,
      catalogRetentionProviderRequestSchema,
    );
    return await retainProviderRequest(ctx, request, args.requestDigest);
  },
});
