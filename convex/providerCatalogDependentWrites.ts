import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
  parsedHttpsUrl,
  providerCatalogReleaseBatchByteCount,
  recomputeProviderCatalogSearchShardHashV1,
  type ProviderCatalogReleaseSearchShardV1,
  type PublicCategory,
  type PublicRepackChase,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import { refuseProviderRelease } from "./providerReleaseErrors";
import { repackSearchRowMatchesDetail } from "./publicRepackValidation";

export type ProviderCatalogDependentWriteResult = Readonly<{
  unresolvedRepackDelta: number;
  latestEvidenceAt: string | null;
  lastSearchPublicRepackId: string | null;
  searchRowCountDelta: number;
}>;

function comparableChaseValue(chase: PublicRepackChase): number | null {
  const comparison = chase.collectible.valuation?.usdComparison;
  return comparison?.status === "available"
    ? comparison.value.minorUnits
    : null;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareChasePriority(
  left: PublicRepackChase,
  right: PublicRepackChase,
): number {
  const leftValue = comparableChaseValue(left);
  const rightValue = comparableChaseValue(right);
  if (leftValue !== null && rightValue === null) return -1;
  if (leftValue === null && rightValue !== null) return 1;
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    return leftValue > rightValue ? -1 : 1;
  }
  return (
    compareCodeUnits(left.publicCollectibleId, right.publicCollectibleId) ||
    left.displayOrder - right.displayOrder
  );
}

async function oneRepack(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  publicRepackId: string,
): Promise<Doc<"providerCatalogRepacks"> | null> {
  const repacks = await ctx.db
    .query("providerCatalogRepacks")
    .withIndex("by_release_id_and_public_repack_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicRepackId", publicRepackId),
    )
    .take(2);
  if (repacks.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return repacks[0] ?? null;
}

async function oneCollectible(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  publicCollectibleId: string,
): Promise<Doc<"providerCatalogCollectibles"> | null> {
  const collectibles = await ctx.db
    .query("providerCatalogCollectibles")
    .withIndex("by_release_id_and_public_collectible_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("publicCollectibleId", publicCollectibleId),
    )
    .take(2);
  if (collectibles.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return collectibles[0] ?? null;
}

async function categoryByPublicId(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  publicCategoryId: string,
): Promise<PublicCategory | null> {
  const categories = await ctx.db
    .query("providerCatalogCategories")
    .withIndex("by_release_id_and_public_category_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicCategoryId", publicCategoryId),
    )
    .take(2);
  if (categories.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return categories[0]?.detail ?? null;
}

async function classificationsShareBranch(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  repackCategoryIds: readonly string[],
  collectibleCategoryIds: readonly string[],
): Promise<boolean> {
  if (repackCategoryIds.length === 0 || collectibleCategoryIds.length === 0) {
    return true;
  }
  const allIds = new Set([...repackCategoryIds, ...collectibleCategoryIds]);
  const byId = new Map<string, PublicCategory>();
  for (const id of allIds) {
    const category = await categoryByPublicId(ctx, releaseId, id);
    if (category === null) return false;
    byId.set(id, category);
  }
  return repackCategoryIds.some((leftId) =>
    collectibleCategoryIds.some(
      (rightId) =>
        leftId === rightId ||
        byId.get(leftId)!.pathPublicCategoryIds.includes(rightId) ||
        byId.get(rightId)!.pathPublicCategoryIds.includes(leftId),
    ),
  );
}

function collectibleProjection(document: Doc<"providerCatalogCollectibles">) {
  const detail = document.detail;
  return {
    publicCollectibleId: detail.publicCollectibleId,
    name: detail.name,
    collectibleType: detail.collectibleType,
    publicCategoryIds: detail.publicCategoryIds,
    primaryImage: detail.primaryImage,
    valuation: detail.valuation,
  };
}

export async function writeProviderRepackChases(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
  records: readonly PublicRepackChase[],
): Promise<ProviderCatalogDependentWriteResult> {
  let unresolvedRepackDelta = 0;
  let latestEvidenceAt: string | null = null;
  for (const detail of records) {
    const [repack, collectible, repackReconciliations, collectibleStates] =
      await Promise.all([
        oneRepack(ctx, release._id, detail.publicRepackId),
        oneCollectible(ctx, release._id, detail.publicCollectibleId),
        ctx.db
          .query("providerCatalogRepackReconciliation")
          .withIndex("by_release_id_and_public_repack_id", (index) =>
            index
              .eq("releaseId", release._id)
              .eq("publicRepackId", detail.publicRepackId),
          )
          .take(2),
        ctx.db
          .query("providerCatalogCollectibleReconciliation")
          .withIndex("by_release_id_and_public_collectible_id", (index) =>
            index
              .eq("releaseId", release._id)
              .eq("publicCollectibleId", detail.publicCollectibleId),
          )
          .take(2),
      ]);
    if (
      repack === null ||
      collectible === null ||
      repackReconciliations.length !== 1 ||
      collectibleStates.length !== 1
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_REFERENCE_INVALID");
    }
    const repackState = repackReconciliations[0]!;
    const collectibleState = collectibleStates[0]!;
    const duplicate = await ctx.db
      .query("providerCatalogRepackChases")
      .withIndex("by_release_id_and_repack_id_and_collectible_id", (index) =>
        index
          .eq("releaseId", release._id)
          .eq("repackId", repack._id)
          .eq("collectibleId", collectible._id),
      )
      .take(2);
    if (
      duplicate.length !== 0 ||
      repackState.complete ||
      detail.displayOrder !== repackState.acceptedChaseCount ||
      repackState.acceptedChaseCount >= repackState.expectedChaseCount ||
      collectibleState.chaseCount >= MAX_REPACK_CHASES_PER_COLLECTIBLE ||
      !repack.detail.collectibleTypes.includes(
        collectible.detail.collectibleType,
      ) ||
      canonicalJson(detail.collectible) !==
        canonicalJson(collectibleProjection(collectible)) ||
      !(await classificationsShareBranch(
        ctx,
        release._id,
        repack.detail.categories.map(
          ({ publicCategoryId }) => publicCategoryId,
        ),
        collectible.detail.publicCategoryIds,
      )) ||
      (detail.collectible.primaryImage !== null &&
        !release.publicAssetOrigins.includes(
          parsedHttpsUrl(detail.collectible.primaryImage.url)?.origin ?? "",
        )) ||
      Date.parse(detail.observedAt) > Date.parse(release.dataAsOf)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
    }
    const previousBest =
      repackState.bestChaseJson === null
        ? null
        : (JSON.parse(repackState.bestChaseJson) as PublicRepackChase);
    const best =
      previousBest === null || compareChasePriority(detail, previousBest) < 0
        ? detail
        : previousBest;
    const acceptedChaseCount = repackState.acceptedChaseCount + 1;
    const acceptedTopChaseCount = repackState.acceptedTopChaseCount +
      (detail.role === "top_chase" ? 1 : 0);
    const complete = acceptedChaseCount === repackState.expectedChaseCount;
    if (
      acceptedTopChaseCount > 1 ||
      (complete &&
        (detail.displayOrder !== repackState.expectedChaseCount - 1 ||
        acceptedTopChaseCount !== 1 ||
        repack.detail.contentSummary.knownCollectibleCount <
          acceptedChaseCount ||
        best.role !== "top_chase" ||
        canonicalJson(best) !== repackState.expectedTopChaseJson))
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_RECONCILIATION_FAILED");
    }
    await ctx.db.insert("providerCatalogRepackChases", {
      releaseId: release._id,
      repackId: repack._id,
      collectibleId: collectible._id,
      detail,
    });
    await ctx.db.patch("providerCatalogRepackReconciliation", repackState._id, {
      acceptedChaseCount,
      bestChaseJson: canonicalJson(best),
      acceptedTopChaseCount,
      complete,
    });
    await ctx.db.patch(
      "providerCatalogCollectibleReconciliation",
      collectibleState._id,
      { chaseCount: collectibleState.chaseCount + 1 },
    );
    if (complete) unresolvedRepackDelta -= 1;
    if (
      latestEvidenceAt === null ||
      Date.parse(detail.observedAt) > Date.parse(latestEvidenceAt)
    ) {
      latestEvidenceAt = detail.observedAt;
    }
  }
  return {
    unresolvedRepackDelta,
    latestEvidenceAt,
    lastSearchPublicRepackId: null,
    searchRowCountDelta: 0,
  };
}

function searchShardCanAcceptFirstRow(
  previous: ProviderCatalogReleaseSearchShardV1,
  next: ProviderCatalogReleaseSearchShardV1,
): boolean {
  const candidateRows = [...previous.rows, next.rows[0]!];
  const candidateRecord = {
    shardNumber: previous.shardNumber,
    rowCount: candidateRows.length,
    byteCount: providerCatalogReleaseBatchByteCount(candidateRows),
    contentHash: "0".repeat(64),
    rows: candidateRows,
  };
  return candidateRows.length <= MAX_ROWS_PER_REPACK_SEARCH_SHARD &&
    providerCatalogReleaseBatchByteCount([candidateRecord]) <=
      MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES;
}

export async function writeProviderSearchShards(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  records: readonly ProviderCatalogReleaseSearchShardV1[],
  expectedFirstShardNumber: number,
  previousPublicRepackId: string | null,
): Promise<ProviderCatalogDependentWriteResult> {
  let lastPublicRepackId = previousPublicRepackId;
  let previousShard: ProviderCatalogReleaseSearchShardV1 | null = null;
  if (expectedFirstShardNumber > 0) {
    const matches = await ctx.db
      .query("providerCatalogSearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index
          .eq("releaseId", releaseId)
          .eq("shardNumber", expectedFirstShardNumber - 1),
      )
      .take(2);
    const stored = matches[0];
    if (
      matches.length !== 1 ||
      stored === undefined ||
      stored.rowCount !== stored.rows.length ||
      stored.byteCount !== providerCatalogReleaseBatchByteCount(stored.rows) ||
      stored.contentHash !==
        await recomputeProviderCatalogSearchShardHashV1(stored.rows)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
    }
    previousShard = stored;
  }
  let searchRowCountDelta = 0;
  for (const [offset, shard] of records.entries()) {
    const existing = await ctx.db
      .query("providerCatalogSearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", releaseId).eq("shardNumber", shard.shardNumber),
      )
      .take(2);
    if (shard.byteCount > MAX_PROVIDER_CATALOG_RELEASE_BATCH_BYTES) {
      refuseProviderRelease("PROVIDER_RELEASE_BATCH_TOO_LARGE");
    }
    if (
      existing.length !== 0 ||
      shard.shardNumber !== expectedFirstShardNumber + offset ||
      shard.rowCount !== shard.rows.length ||
      shard.byteCount !== providerCatalogReleaseBatchByteCount(shard.rows) ||
      shard.contentHash !==
        (await recomputeProviderCatalogSearchShardHashV1(shard.rows))
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
    }
    if (
      previousShard !== null &&
      searchShardCanAcceptFirstRow(previousShard, shard)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_BATCH_OUT_OF_ORDER");
    }
    for (const row of shard.rows) {
      if (
        lastPublicRepackId !== null &&
        row.publicRepackId <= lastPublicRepackId
      ) {
        refuseProviderRelease("PROVIDER_RELEASE_REFERENCE_INVALID");
      }
      const repack = await oneRepack(ctx, releaseId, row.publicRepackId);
      if (repack === null) {
        refuseProviderRelease("PROVIDER_RELEASE_REFERENCE_INVALID");
      }
      if (!repackSearchRowMatchesDetail(row, repack.detail)) {
        refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
      }
      lastPublicRepackId = row.publicRepackId;
    }
    await ctx.db.insert("providerCatalogSearchShards", {
      releaseId,
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
      rows: [...shard.rows],
    });
    await ctx.db.insert("providerCatalogSearchShardProofs", {
      releaseId,
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
    });
    previousShard = shard;
    searchRowCountDelta += shard.rows.length;
  }
  return {
    unresolvedRepackDelta: 0,
    latestEvidenceAt: null,
    lastSearchPublicRepackId: lastPublicRepackId,
    searchRowCountDelta,
  };
}
