import { DATA_RELEASE_SCHEMA_VERSION } from "@packscout/contracts";
import type { z } from "zod";
import { v } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  loadExactOperationReplay,
  storeProductionReceipt,
} from "./productionDataReleaseOperations";
import {
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  containsProtectedPublicationField,
  parseStrictJson,
  productionRetainRequestSchema,
  type ProductionRetainRequest,
} from "./productionDataReleaseProtocol";

const MAX_DELETIONS_PER_MUTATION = 100;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type OwnedRow = Readonly<{ _id: Id<TableNames> }>;

function parseRequest<T>(bodyJson: string, schema: z.ZodType<T>): T {
  if (new TextEncoder().encode(bodyJson).byteLength > MAX_PRODUCTION_HTTP_BODY_BYTES) {
    refuseProductionDataRelease("PUBLICATION_BODY_TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson) as unknown;
  } catch {
    return refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !==
      DATA_RELEASE_SCHEMA_VERSION
  ) {
    refuseProductionDataRelease("PUBLICATION_SCHEMA_UNSUPPORTED");
  }
  if (containsProtectedPublicationField(raw)) {
    refuseProductionDataRelease("PUBLICATION_PROTECTED_FIELD");
  }
  return parseStrictJson(bodyJson, schema) ??
    refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
}

async function pointerProtectedReleaseIds(
  ctx: MutationCtx,
): Promise<ReadonlySet<string>> {
  const protectedIds = new Set<string>();
  const releaseStates = await ctx.db
    .query("dataReleaseState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  const heatStates = await ctx.db
    .query("repackHeatState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (releaseStates.length > 1 || heatStates.length > 1) {
    refuseProductionDataRelease("PUBLICATION_RETENTION_UNSAFE");
  }
  const releaseState = releaseStates[0];
  if (releaseState?.activeReleaseId !== null && releaseState !== undefined) {
    protectedIds.add(releaseState.activeReleaseId);
  }
  if (releaseState?.previousReleaseId !== null && releaseState !== undefined) {
    protectedIds.add(releaseState.previousReleaseId);
  }
  const heatState = heatStates[0];
  for (const snapshotId of [
    heatState?.activeHeatSnapshotId ?? null,
    heatState?.previousHeatSnapshotId ?? null,
  ]) {
    if (snapshotId === null) continue;
    const snapshot = await ctx.db.get("repackHeatSnapshots", snapshotId);
    if (snapshot === null) {
      refuseProductionDataRelease("PUBLICATION_RETENTION_UNSAFE");
    }
    protectedIds.add(snapshot.releaseId);
  }
  return protectedIds;
}

async function retentionCandidate(
  ctx: MutationCtx,
  now: string,
  protectedIds: ReadonlySet<string>,
): Promise<Doc<"dataReleases"> | null> {
  const expiredComplete = await ctx.db
    .query("dataReleases")
    .withIndex("by_lifecycle_and_retention_eligible_at", (index) =>
      index
        .eq("lifecycle", "complete")
        .lte("retentionEligibleAt", now),
    )
    .order("asc")
    .take(5);
  const expiredCandidate = expiredComplete.find(
    (release) => !protectedIds.has(release._id),
  );
  if (expiredCandidate !== undefined) return expiredCandidate;

  const complete = await ctx.db
    .query("dataReleases")
    .withIndex("by_lifecycle_and_retention_eligible_at", (index) =>
      index.eq("lifecycle", "complete"),
    )
    .order("desc")
    .take(8);
  const otherComplete = complete.filter(
    (release) => !protectedIds.has(release._id),
  );
  const oldComplete = otherComplete.find(
    (_release, index) => index >= 3,
  );
  if (oldComplete !== undefined) return oldComplete;

  for (const lifecycle of ["staging", "failed"] as const) {
    const candidates = await ctx.db
      .query("dataReleases")
      .withIndex("by_lifecycle_and_retention_eligible_at", (index) =>
        index
          .eq("lifecycle", lifecycle)
          .lte("retentionEligibleAt", now),
      )
      .order("asc")
      .take(3);
    const candidate = candidates.find(
      (release) => !protectedIds.has(release._id),
    );
    if (candidate !== undefined) return candidate;
  }
  return null;
}

async function deleteRows(
  ctx: MutationCtx,
  rows: readonly OwnedRow[],
  remaining: number,
): Promise<number> {
  const selected = rows.slice(0, remaining);
  for (const row of selected) await ctx.db.delete(row._id);
  return selected.length;
}

async function deleteOwnedReleaseDocuments(
  ctx: MutationCtx,
  release: Doc<"dataReleases">,
): Promise<{ deletedDocumentCount: number; hasMore: boolean }> {
  const loaders: Array<(limit: number) => Promise<readonly OwnedRow[]>> = [
    (limit) =>
      ctx.db
        .query("repackHeatSignals")
        .withIndex("by_release_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("repackHeatSnapshots")
        .withIndex("by_release_id_and_sequence", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("repackChases")
        .withIndex("by_release_id_and_repack_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("repacks")
        .withIndex("by_release_id_and_public_repack_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("collectibles")
        .withIndex("by_release_id_and_public_collectible_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("categories")
        .withIndex("by_release_id_and_public_category_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("vendors")
        .withIndex("by_release_id_and_public_vendor_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("repackSearchShards")
        .withIndex("by_release_id_and_shard_number", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("dataReleaseBatches")
        .withIndex("by_release_id_and_batch_index", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("dataReleaseRepackReconciliation")
        .withIndex("by_release_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("dataReleaseCollectibleReconciliation")
        .withIndex("by_release_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("dataReleaseOperations")
        .withIndex("by_public_release_id_and_kind", (index) =>
          index.eq("publicReleaseId", release.publicReleaseId),
        )
        .take(limit),
    (limit) =>
      ctx.db
        .query("dataReleasePublications")
        .withIndex("by_release_id", (index) =>
          index.eq("releaseId", release._id),
        )
        .take(limit),
  ];
  let deletedDocumentCount = 0;
  for (const load of loaders) {
    const remaining = MAX_DELETIONS_PER_MUTATION - deletedDocumentCount;
    if (remaining === 0) {
      return { deletedDocumentCount, hasMore: true };
    }
    deletedDocumentCount += await deleteRows(
      ctx,
      await load(remaining),
      remaining,
    );
  }
  if (deletedDocumentCount === MAX_DELETIONS_PER_MUTATION) {
    return { deletedDocumentCount, hasMore: true };
  }
  await ctx.db.delete("dataReleases", release._id);
  return { deletedDocumentCount: deletedDocumentCount + 1, hasMore: false };
}

async function deleteExpiredNonces(
  ctx: MutationCtx,
  now: string,
): Promise<number> {
  const expired = await ctx.db
    .query("dataReleaseAuthNonces")
    .withIndex("by_expires_at", (index) => index.lte("expiresAt", now))
    .take(MAX_DELETIONS_PER_MUTATION);
  return await deleteRows(ctx, expired, MAX_DELETIONS_PER_MUTATION);
}

export const retain = internalMutation({
  args: {
    bodyJson: v.string(),
    requestDigest: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!SHA256_PATTERN.test(args.requestDigest)) {
      refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
    }
    const request: ProductionRetainRequest = parseRequest(
      args.bodyJson,
      productionRetainRequestSchema,
    );
    const replay = await loadExactOperationReplay(ctx, {
      kind: "retain",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: args.requestDigest,
    });
    if (replay !== null) return replay;

    const now = new Date().toISOString();
    const protectedIds = await pointerProtectedReleaseIds(ctx);
    const candidate = await retentionCandidate(ctx, now, protectedIds);
    const deletion = candidate === null
      ? {
          deletedDocumentCount: await deleteExpiredNonces(ctx, now),
          hasMore: false,
        }
      : await deleteOwnedReleaseDocuments(ctx, candidate);
    return await storeProductionReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "retain",
      idempotencyKey: request.idempotencyKey,
      publicationId: null,
      terminalState: deletion.hasMore ? "continuation_required" : "complete",
      result: candidate === null ? "nonce_cleanup" : "retained",
      serverTime: now,
      requestDigest: args.requestDigest,
      details: {
        deletedPublicReleaseId: candidate?.publicReleaseId ?? null,
        deletedDocumentCount: deletion.deletedDocumentCount,
        hasMore: deletion.hasMore,
        maximumDocumentsPerMutation: MAX_DELETIONS_PER_MUTATION,
      },
    });
  },
});
