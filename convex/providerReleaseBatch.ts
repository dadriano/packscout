import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS,
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  extendProviderCatalogReleaseBatchChainV1,
  extendProviderCatalogReleaseEntityHashV1,
  providerCatalogReleaseBatchByteCount,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseBatchReceiptSchema,
  recomputeProviderCatalogReleaseBatchHashV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderReleaseApplyBatchRequest,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  writeProviderCategories,
  writeProviderCollectibles,
  writeProviderRepacks,
  writeProviderVendors,
  type ProviderCatalogWriteResult,
} from "./providerCatalogEntityWrites";
import {
  writeProviderRepackChases,
  writeProviderSearchShards,
  type ProviderCatalogDependentWriteResult,
} from "./providerCatalogDependentWrites";
import { refuseProviderRelease } from "./providerReleaseErrors";
import {
  buildProviderReleaseReceipt,
  loadExactProviderOperationReplay,
  storeProviderReleaseReceipt,
} from "./providerReleaseOperations";
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
  oneProviderPublication,
  oneProviderRelease,
} from "./providerReleaseState";

const EXECUTION_ARGS = {
  bodyJson: v.string(),
  requestDigest: v.string(),
  authenticatedKeyId: v.string(),
} as const;

function countField(
  kind: ProviderCatalogReleaseBatchKindV1,
): keyof Doc<"providerCatalogPublications">["acceptedCounts"] {
  if (kind === "repack_chases") return "repackChases";
  if (kind === "search_shards") return "searchShards";
  return kind;
}

function batchRecordKeys(request: ProviderReleaseApplyBatchRequest): string[] {
  const { batch } = request;
  switch (batch.kind) {
    case "vendors":
      return batch.records.map(({ publicVendorId }) => publicVendorId);
    case "categories":
      return batch.records.map(({ depth, publicCategoryId }) =>
        `${String(depth).padStart(2, "0")}:${publicCategoryId}`,
      );
    case "collectibles":
      return batch.records.map(({ publicCollectibleId }) => publicCollectibleId);
    case "repacks":
      return batch.records.map(({ publicRepackId }) => publicRepackId);
    case "repack_chases":
      return batch.records.map(
        ({ publicRepackId, displayOrder, publicCollectibleId }) =>
          `${publicRepackId}:${String(displayOrder).padStart(16, "0")}:${publicCollectibleId}`,
      );
    case "search_shards":
      return batch.records.map(({ shardNumber }) =>
        String(shardNumber).padStart(4, "0"),
      );
  }
}

function assertCanonicalOrder(
  publication: Doc<"providerCatalogPublications">,
  request: ProviderReleaseApplyBatchRequest,
): string {
  const previousKind = publication.lastBatchKind === null
    ? -1
    : PROVIDER_CATALOG_RELEASE_BATCH_KINDS.indexOf(
        publication.lastBatchKind as ProviderCatalogReleaseBatchKindV1,
      );
  const currentKind = PROVIDER_CATALOG_RELEASE_BATCH_KINDS.indexOf(
    request.batch.kind,
  );
  const keys = batchRecordKeys(request);
  if (
    (publication.lastBatchKind !== null && previousKind === -1) ||
    currentKind < previousKind ||
    keys.some((key, index) => index > 0 && key <= keys[index - 1]!) ||
    (currentKind === previousKind &&
      publication.lastRecordKey !== null &&
      keys[0]! <= publication.lastRecordKey)
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_BATCH_OUT_OF_ORDER");
  }
  return keys.at(-1)!;
}

function maximumTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

async function applyProviderRecords(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
  publication: Doc<"providerCatalogPublications">,
  request: ProviderReleaseApplyBatchRequest,
): Promise<ProviderCatalogDependentWriteResult> {
  let result: ProviderCatalogWriteResult | ProviderCatalogDependentWriteResult;
  switch (request.batch.kind) {
    case "vendors":
      result = await writeProviderVendors(
        ctx,
        release._id,
        request.batch.records,
        new Set(release.publicAssetOrigins),
      );
      break;
    case "categories":
      result = await writeProviderCategories(
        ctx,
        release._id,
        request.batch.records,
      );
      break;
    case "collectibles":
      result = await writeProviderCollectibles(
        ctx,
        release,
        request.batch.records,
        new Set(release.publicAssetOrigins),
      );
      break;
    case "repacks":
      if (publication.providerCheckpoint.settledAt === null) {
        refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
      }
      result = await writeProviderRepacks(ctx, release, request.batch.records, {
        lastSuccessfulObservationAt:
          publication.observation.lastSuccessfulObservationAt,
        checkpointSettledAt: publication.providerCheckpoint.settledAt,
      });
      break;
    case "repack_chases":
      return await writeProviderRepackChases(
        ctx,
        release,
        request.batch.records,
      );
    case "search_shards":
      return await writeProviderSearchShards(
        ctx,
        release._id,
        request.batch.records,
        publication.acceptedCounts.searchShards,
        publication.lastSearchPublicRepackId,
      );
  }
  return {
    ...result,
    lastSearchPublicRepackId: null,
    searchRowCountDelta: 0,
  };
}

export const applyBatch = internalMutation({
  args: EXECUTION_ARGS,
  returns: v.any(),
  handler: async (ctx, args) => {
    assertProviderRequestDigest(args.requestDigest);
    const request = parseProviderReleaseRequest(
      args.bodyJson,
      providerReleaseApplyBatchRequestSchema,
    );
    assertProviderPlatformAuthority(
      args.authenticatedKeyId,
      request.release.platformKey,
    );
    const replay = await loadExactProviderOperationReplay(ctx, {
      operationKind: "applyBatch",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      platformKey: request.release.platformKey,
      publicProviderReleaseId: request.release.publicProviderReleaseId,
      requestDigest: args.requestDigest,
    });
    if (replay !== null) return replay;

    await assertProviderReleaseProof(request);
    await assertProviderReleaseNotBlocked(
      ctx,
      request.release.platformKey,
      request.release.providerReleaseFingerprint,
    );
    await assertExpectedProviderHead(ctx, request);
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
    const [existing, previous] = await Promise.all([
      ctx.db
        .query("providerCatalogBatches")
        .withIndex("by_release_id_and_batch_index", (index) =>
          index
            .eq("releaseId", release._id)
            .eq("batchIndex", request.batch.batchIndex),
        )
        .take(2),
      request.batch.batchIndex === 0
        ? Promise.resolve([])
        : ctx.db
            .query("providerCatalogBatches")
            .withIndex("by_release_id_and_batch_index", (index) =>
              index
                .eq("releaseId", release._id)
                .eq("batchIndex", request.batch.batchIndex - 1),
            )
            .take(2),
    ]);
    const byteCount = providerCatalogReleaseBatchByteCount(
      request.batch.records,
    );
    if (byteCount > MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES) {
      refuseProviderRelease("PROVIDER_RELEASE_BATCH_TOO_LARGE");
    }
    if (
      existing.length !== 0 ||
      (request.batch.batchIndex > 0 && previous.length !== 1) ||
      request.batch.batchIndex !== publication.acceptedBatchCount ||
      request.batch.batchIndex >= publication.expectedBatchCount
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_BATCH_OUT_OF_ORDER");
    }
    if (
      request.batch.byteCount !== byteCount ||
      request.batch.batchHash !==
        await recomputeProviderCatalogReleaseBatchHashV1(request.batch)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_BATCH_CONFLICT");
    }
    const priorBatch = previous[0];
    if (
      priorBatch !== undefined &&
      priorBatch.kind === request.batch.kind &&
      priorBatch.recordCount < MAX_PROVIDER_CATALOG_RELEASE_BATCH_RECORDS &&
      priorBatch.byteCount +
          providerCatalogReleaseBatchByteCount([request.batch.records[0]!]) -
          1 <=
        MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_BATCH_OUT_OF_ORDER");
    }
    const lastRecordKey = assertCanonicalOrder(publication, request);
    const field = countField(request.batch.kind);
    const acceptedCounts = {
      ...publication.acceptedCounts,
      [field]: publication.acceptedCounts[field] +
        request.batch.records.length,
    };
    if (acceptedCounts[field] > publication.expectedCounts[field]) {
      refuseProviderRelease("PROVIDER_RELEASE_COUNT_MISMATCH");
    }

    const writeResult = await applyProviderRecords(
      ctx,
      release,
      publication,
      request,
    );
    const acceptedSearchRowCount = publication.acceptedSearchRowCount +
      writeResult.searchRowCountDelta;
    if (acceptedSearchRowCount > publication.expectedCounts.repacks) {
      refuseProviderRelease("PROVIDER_RELEASE_COUNT_MISMATCH");
    }
    const acceptedBatchChainHash =
      await extendProviderCatalogReleaseBatchChainV1({
        previousHash: publication.acceptedBatchChainHash,
        batchIndex: request.batch.batchIndex,
        kind: request.batch.kind,
        batchHash: request.batch.batchHash,
        recordCount: request.batch.records.length,
        byteCount,
      });
    const entityHash = await extendProviderCatalogReleaseEntityHashV1({
      previousHash: publication.acceptedEntityHashes[request.batch.kind],
      kind: request.batch.kind,
      batchHash: request.batch.batchHash,
      recordCount: request.batch.records.length,
      byteCount,
    });
    const acceptedEntityHashes = {
      ...publication.acceptedEntityHashes,
      [request.batch.kind]: entityHash,
    };
    const serverTime = new Date().toISOString();
    await ctx.db.insert("providerCatalogBatches", {
      releaseId: release._id,
      platformKey: release.platformKey,
      publicProviderReleaseId: release.publicProviderReleaseId,
      batchIndex: request.batch.batchIndex,
      kind: request.batch.kind,
      idempotencyKey: request.idempotencyKey,
      bodyHash: args.requestDigest,
      batchHash: request.batch.batchHash,
      recordCount: request.batch.records.length,
      byteCount,
      acceptedAt: serverTime,
      operationId: request.operationId,
      chainHash: acceptedBatchChainHash,
      entityHash,
    });
    await ctx.db.patch("providerCatalogPublications", publication._id, {
      acceptedBatchCount: publication.acceptedBatchCount + 1,
      acceptedBatchChainHash,
      acceptedCounts,
      acceptedEntityHashes,
      lastBatchKind: request.batch.kind,
      lastRecordKey,
      lastSearchPublicRepackId:
        writeResult.lastSearchPublicRepackId ??
        publication.lastSearchPublicRepackId,
      acceptedSearchRowCount,
      unresolvedRepackCount:
        publication.unresolvedRepackCount +
        writeResult.unresolvedRepackDelta,
      latestEvidenceAt: maximumTimestamp(
        publication.latestEvidenceAt,
        writeResult.latestEvidenceAt,
      ),
    });
    const receipt = await buildProviderReleaseReceipt(
      (value) => providerReleaseBatchReceiptSchema.parse(value),
      {
        schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
        operationKind: "applyBatch",
        operationId: request.operationId,
        idempotencyKey: request.idempotencyKey,
        platformKey: release.platformKey,
        publicProviderReleaseId: release.publicProviderReleaseId,
        sharedConfigurationEpoch: release.sharedConfigurationEpoch,
        providerCheckpoint: request.providerCheckpoint,
        terminalState: "staging",
        result: "accepted",
        serverTime,
        requestDigest: args.requestDigest,
        details: {
          release: request.release,
          providerCheckpoint: request.providerCheckpoint,
          sourceWatermark: request.sourceWatermark,
          observation: request.observation,
          expectedCompletedHead: request.expectedCompletedHead,
          batchIndex: request.batch.batchIndex,
          kind: request.batch.kind,
          batchHash: request.batch.batchHash,
          recordCount: request.batch.records.length,
          byteCount,
          acceptedBatchCount: publication.acceptedBatchCount + 1,
          acceptedCounts,
          acceptedEntityHashes,
          acceptedBatchChainHash,
        },
      },
    );
    await storeProviderReleaseReceipt(ctx, receipt);
    return receipt;
  },
});
