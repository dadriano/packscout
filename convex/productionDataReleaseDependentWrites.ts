import {
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
  parsedHttpsUrl,
  type PublicCategory,
  type PublicRepackChase,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  REPACK_SEARCH_SHARD_HASH_DOMAIN,
  canonicalJson,
  sha256CanonicalJson,
} from "./dataReleaseCanonicalHash";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";
import {
  MAX_PRODUCTION_BATCH_BYTES,
  type productionSearchShardSchema,
} from "./productionDataReleaseProtocol";
import {
  repackSearchRowMatchesDetail,
} from "./publicRepackValidation";
import type { z } from "zod";

type ProductionSearchShard = z.infer<typeof productionSearchShardSchema>;

export type DependentWriteResult = Readonly<{
  unresolvedRepackDelta: number;
  latestEvidenceAt: string | null;
  lastSearchPublicRepackId: string | null;
}>;

function comparableChaseValue(chase: PublicRepackChase): number | null {
  const comparison = chase.collectible.valuation?.usdComparison;
  return comparison?.status === "available"
    ? comparison.value.minorUnits
    : null;
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
    left.publicCollectibleId.localeCompare(right.publicCollectibleId) ||
    left.displayOrder - right.displayOrder
  );
}

async function oneRepack(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  publicRepackId: string,
): Promise<Doc<"repacks"> | null> {
  const repacks = await ctx.db
    .query("repacks")
    .withIndex("by_release_id_and_public_repack_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicRepackId", publicRepackId),
    )
    .take(2);
  if (repacks.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return repacks[0] ?? null;
}

async function oneCollectible(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  publicCollectibleId: string,
): Promise<Doc<"collectibles"> | null> {
  const collectibles = await ctx.db
    .query("collectibles")
    .withIndex("by_release_id_and_public_collectible_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("publicCollectibleId", publicCollectibleId),
    )
    .take(2);
  if (collectibles.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return collectibles[0] ?? null;
}

async function categoryByPublicId(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  publicCategoryId: string,
): Promise<PublicCategory | null> {
  const categories = await ctx.db
    .query("categories")
    .withIndex("by_release_id_and_public_category_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("publicCategoryId", publicCategoryId),
    )
    .take(2);
  if (categories.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return categories[0]?.detail ?? null;
}

async function classificationsShareBranch(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
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
    collectibleCategoryIds.some((rightId) =>
      leftId === rightId ||
      byId.get(leftId)!.pathPublicCategoryIds.includes(rightId) ||
      byId.get(rightId)!.pathPublicCategoryIds.includes(leftId),
    ),
  );
}

function collectibleProjection(document: Doc<"collectibles">) {
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

export async function writeRepackChases(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  records: readonly PublicRepackChase[],
): Promise<DependentWriteResult> {
  let unresolvedRepackDelta = 0;
  let latestEvidenceAt: string | null = null;
  for (const detail of records) {
    const [repack, collectible, repackReconciliations, collectibleStates] =
      await Promise.all([
        oneRepack(ctx, releaseId, detail.publicRepackId),
        oneCollectible(ctx, releaseId, detail.publicCollectibleId),
        ctx.db
          .query("dataReleaseRepackReconciliation")
          .withIndex("by_release_id_and_public_repack_id", (index) =>
            index
              .eq("releaseId", releaseId)
              .eq("publicRepackId", detail.publicRepackId),
          )
          .take(2),
        ctx.db
          .query("dataReleaseCollectibleReconciliation")
          .withIndex("by_release_id_and_public_collectible_id", (index) =>
            index
              .eq("releaseId", releaseId)
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
      refuseProductionDataRelease("PUBLICATION_REFERENCE_INVALID");
    }
    const repackState = repackReconciliations[0]!;
    const collectibleState = collectibleStates[0]!;
    const duplicate = await ctx.db
      .query("repackChases")
      .withIndex(
        "by_release_id_and_repack_id_and_collectible_id",
        (index) =>
          index
            .eq("releaseId", releaseId)
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
        releaseId,
        repack.detail.categories.map(({ publicCategoryId }) => publicCategoryId),
        collectible.detail.publicCategoryIds,
      )) ||
      (detail.collectible.primaryImage !== null &&
        parsedHttpsUrl(detail.collectible.primaryImage.url) === null)
    ) {
      refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
    }
    const previousBest = repackState.bestChaseJson === null
      ? null
      : (JSON.parse(repackState.bestChaseJson) as PublicRepackChase);
    const best = previousBest === null || compareChasePriority(detail, previousBest) < 0
      ? detail
      : previousBest;
    const acceptedChaseCount = repackState.acceptedChaseCount + 1;
    const complete = acceptedChaseCount === repackState.expectedChaseCount;
    if (
      complete &&
      (detail.displayOrder !== repackState.expectedChaseCount - 1 ||
        best.role !== "top_chase" ||
        canonicalJson(best) !== repackState.expectedTopChaseJson)
    ) {
      refuseProductionDataRelease("PUBLICATION_RECONCILIATION_FAILED");
    }
    await ctx.db.insert("repackChases", {
      releaseId,
      repackId: repack._id,
      collectibleId: collectible._id,
      detail,
    });
    await ctx.db.patch(
      "dataReleaseRepackReconciliation",
      repackState._id,
      {
        acceptedChaseCount,
        bestChaseJson: canonicalJson(best),
        complete,
      },
    );
    await ctx.db.patch(
      "dataReleaseCollectibleReconciliation",
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
  };
}

export async function writeSearchShards(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  records: readonly ProductionSearchShard[],
  expectedFirstShardNumber: number,
  previousPublicRepackId: string | null,
): Promise<DependentWriteResult> {
  let lastPublicRepackId = previousPublicRepackId;
  for (const [offset, shard] of records.entries()) {
    const encodedRows = new TextEncoder().encode(canonicalJson(shard.rows));
    if (
      shard.shardNumber !== expectedFirstShardNumber + offset ||
      shard.rowCount !== shard.rows.length ||
      shard.byteCount !== encodedRows.byteLength ||
      shard.byteCount > MAX_PRODUCTION_BATCH_BYTES ||
      shard.contentHash !==
        await sha256CanonicalJson(REPACK_SEARCH_SHARD_HASH_DOMAIN, shard.rows)
    ) {
      refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
    }
    for (const row of shard.rows) {
      if (
        (lastPublicRepackId !== null &&
          row.publicRepackId <= lastPublicRepackId) ||
        !(await oneRepack(ctx, releaseId, row.publicRepackId))
      ) {
        refuseProductionDataRelease("PUBLICATION_REFERENCE_INVALID");
      }
      const repack = await oneRepack(ctx, releaseId, row.publicRepackId);
      if (
        repack === null ||
        !repackSearchRowMatchesDetail(row, repack.detail)
      ) {
        refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
      }
      lastPublicRepackId = row.publicRepackId;
    }
    await ctx.db.insert("repackSearchShards", {
      releaseId,
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
      rows: shard.rows,
    });
  }
  return {
    unresolvedRepackDelta: 0,
    latestEvidenceAt: null,
    lastSearchPublicRepackId: lastPublicRepackId,
  };
}
