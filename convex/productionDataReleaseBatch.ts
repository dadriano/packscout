import { DATA_RELEASE_SCHEMA_VERSION } from "@packscout/contracts";
import type { z } from "zod";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  writeCategories,
  writeCollectibles,
  writeRepacks,
  writeVendors,
  type CatalogWriteResult,
} from "./productionDataReleaseCatalogWrites";
import {
  writeRepackChases,
  writeSearchShards,
  type DependentWriteResult,
} from "./productionDataReleaseDependentWrites";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  loadExactOperationReplay,
  storeProductionReceipt,
} from "./productionDataReleaseOperations";
import {
  MAX_PRODUCTION_BATCH_BYTES,
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  PRODUCTION_BATCH_KINDS,
  containsProtectedPublicationField,
  extendProductionBatchChain,
  parseStrictJson,
  productionApplyBatchRequestSchema,
  productionBatchByteCount,
  recomputeProductionBatchHash,
  type ProductionApplyBatchRequest,
  type ProductionBatchKind,
} from "./productionDataReleaseProtocol";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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

async function onePublication(
  ctx: MutationCtx,
  publicationId: string,
): Promise<Doc<"dataReleasePublications">> {
  const publications = await ctx.db
    .query("dataReleasePublications")
    .withIndex("by_publication_id", (index) =>
      index.eq("publicationId", publicationId),
    )
    .take(2);
  if (publications.length !== 1 || publications[0]!.state !== "staging") {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return publications[0]!;
}

function batchKindOrder(kind: string | null): number {
  if (kind === null) return -1;
  return PRODUCTION_BATCH_KINDS.indexOf(kind as ProductionBatchKind);
}

function batchRecordKeys(request: ProductionApplyBatchRequest): string[] {
  switch (request.kind) {
    case "vendors":
      return request.records.map(({ publicVendorId }) => publicVendorId);
    case "categories":
      return request.records.map(
        ({ depth, publicCategoryId }) =>
          `${String(depth).padStart(2, "0")}:${publicCategoryId}`,
      );
    case "collectibles":
      return request.records.map(({ publicCollectibleId }) => publicCollectibleId);
    case "repacks":
      return request.records.map(({ publicRepackId }) => publicRepackId);
    case "repack_chases":
      return request.records.map(
        ({ publicRepackId, displayOrder, publicCollectibleId }) =>
          `${publicRepackId}:${String(displayOrder).padStart(10, "0")}:${publicCollectibleId}`,
      );
    case "search_shards":
      return request.records.map(({ shardNumber }) =>
        String(shardNumber).padStart(6, "0"),
      );
  }
}

function assertDeterministicOrder(
  publication: Doc<"dataReleasePublications">,
  request: ProductionApplyBatchRequest,
): string {
  const previousKindOrder = batchKindOrder(publication.lastBatchKind);
  const currentKindOrder = batchKindOrder(request.kind);
  const keys = batchRecordKeys(request);
  if (
    currentKindOrder < 0 ||
    currentKindOrder < previousKindOrder ||
    keys.some((key, index) => index > 0 && key <= keys[index - 1]!) ||
    (currentKindOrder === previousKindOrder &&
      publication.lastRecordKey !== null &&
      keys[0]! <= publication.lastRecordKey)
  ) {
    refuseProductionDataRelease("PUBLICATION_BATCH_OUT_OF_ORDER");
  }
  return keys.at(-1)!;
}

function countField(kind: ProductionBatchKind): keyof Doc<"dataReleasePublications">["acceptedCounts"] {
  if (kind === "repack_chases") return "repackChases";
  if (kind === "search_shards") return "searchShards";
  return kind;
}

function maximumTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function applyRecords(
  ctx: MutationCtx,
  publication: Doc<"dataReleasePublications">,
  release: Doc<"dataReleases">,
  request: ProductionApplyBatchRequest,
): Promise<DependentWriteResult> {
  let result: CatalogWriteResult | DependentWriteResult;
  switch (request.kind) {
    case "vendors":
      result = await writeVendors(
        ctx,
        release._id,
        request.records,
        new Set(publication.publicAssetOrigins),
      );
      break;
    case "categories":
      result = await writeCategories(ctx, release._id, request.records);
      break;
    case "collectibles":
      result = await writeCollectibles(
        ctx,
        release._id,
        request.records,
        new Set(publication.publicAssetOrigins),
      );
      break;
    case "repacks":
      result = await writeRepacks(ctx, release, request.records);
      break;
    case "repack_chases":
      return await writeRepackChases(ctx, release._id, request.records);
    case "search_shards":
      return await writeSearchShards(
        ctx,
        release._id,
        request.records,
        publication.acceptedCounts.searchShards,
        publication.lastSearchPublicRepackId,
      );
  }
  return {
    ...result,
    lastSearchPublicRepackId: null,
  };
}

export const applyBatch = internalMutation({
  args: {
    bodyJson: v.string(),
    requestDigest: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!SHA256_PATTERN.test(args.requestDigest)) {
      refuseProductionDataRelease("PUBLICATION_REQUEST_INVALID");
    }
    const request = parseRequest(
      args.bodyJson,
      productionApplyBatchRequestSchema,
    );
    const replay = await loadExactOperationReplay(ctx, {
      kind: "applyBatch",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      bodyHash: args.requestDigest,
    });
    if (replay !== null) return replay;

    const publication = await onePublication(ctx, request.publicationId);
    const release = await ctx.db.get("dataReleases", publication.releaseId);
    if (release === null || release.lifecycle !== "staging") {
      refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
    }
    const existingBatches = await ctx.db
      .query("dataReleaseBatches")
      .withIndex("by_release_id_and_batch_index", (index) =>
        index
          .eq("releaseId", release._id)
          .eq("batchIndex", request.batchIndex),
      )
      .take(2);
    if (existingBatches.length !== 0) {
      refuseProductionDataRelease("PUBLICATION_BATCH_CONFLICT");
    }
    const byteCount = productionBatchByteCount(request.records);
    if (byteCount > MAX_PRODUCTION_BATCH_BYTES) {
      refuseProductionDataRelease("PUBLICATION_BATCH_TOO_LARGE");
    }
    if (
      request.batchIndex !== publication.acceptedBatchCount ||
      request.batchIndex >= publication.expectedBatchCount
    ) {
      refuseProductionDataRelease("PUBLICATION_BATCH_OUT_OF_ORDER");
    }
    if (
      request.batchHash !== await recomputeProductionBatchHash(request)
    ) {
      refuseProductionDataRelease("PUBLICATION_BATCH_CONFLICT");
    }
    const lastRecordKey = assertDeterministicOrder(publication, request);
    const field = countField(request.kind);
    const acceptedCounts = {
      ...publication.acceptedCounts,
      [field]: publication.acceptedCounts[field] + request.records.length,
    };
    if (acceptedCounts[field] > publication.expectedCounts[field]) {
      refuseProductionDataRelease("PUBLICATION_RECONCILIATION_FAILED");
    }

    const result = await applyRecords(ctx, publication, release, request);
    const chainHash = await extendProductionBatchChain({
      previousHash: publication.acceptedBatchChainHash,
      batchIndex: request.batchIndex,
      kind: request.kind,
      batchHash: request.batchHash,
      recordCount: request.records.length,
      byteCount,
    });
    const now = new Date().toISOString();
    await ctx.db.insert("dataReleaseBatches", {
      releaseId: release._id,
      batchIndex: request.batchIndex,
      kind: request.kind,
      idempotencyKey: request.idempotencyKey,
      bodyHash: request.batchHash,
      recordCount: request.records.length,
      byteCount,
      acceptedAt: now,
      operationId: request.operationId,
      chainHash,
    });
    await ctx.db.patch("dataReleasePublications", publication._id, {
      acceptedBatchCount: publication.acceptedBatchCount + 1,
      acceptedBatchChainHash: chainHash,
      acceptedCounts,
      lastBatchKind: request.kind,
      lastRecordKey,
      lastSearchPublicRepackId:
        result.lastSearchPublicRepackId ??
        publication.lastSearchPublicRepackId,
      unresolvedRepackCount:
        publication.unresolvedRepackCount + result.unresolvedRepackDelta,
      latestEvidenceAt: maximumTimestamp(
        publication.latestEvidenceAt,
        result.latestEvidenceAt,
      ),
    });
    return await storeProductionReceipt(ctx, {
      operationId: request.operationId,
      operationKind: "applyBatch",
      idempotencyKey: request.idempotencyKey,
      publicationId: request.publicationId,
      terminalState: "staging",
      result: "accepted",
      serverTime: now,
      requestDigest: args.requestDigest,
      releaseVersion: release.metadata.manifestFingerprint,
      observationSequence: publication.observationSequence,
      details: {
        batchIndex: request.batchIndex,
        kind: request.kind,
        batchHash: request.batchHash,
        recordCount: request.records.length,
        byteCount,
        chainHash,
        acceptedCounts,
      },
    });
  },
});
