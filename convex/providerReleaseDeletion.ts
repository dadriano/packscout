import type { Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export type ProviderOwnedRow = Readonly<{ _id: Id<TableNames> }>;

export async function deleteProviderOwnedRows(
  ctx: MutationCtx,
  rows: readonly ProviderOwnedRow[],
  remaining: number,
): Promise<number> {
  const selected = rows.slice(0, remaining);
  for (const row of selected) await ctx.db.delete(row._id);
  return selected.length;
}

export async function deleteProviderReleaseOwnedDocuments(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  maximumDocuments: number,
): Promise<{ deletedDocumentCount: number; hasMore: boolean }> {
  const loaders: Array<
    (limit: number) => Promise<readonly ProviderOwnedRow[]>
  > = [
    (limit) => ctx.db
      .query("providerCatalogRepackChases")
      .withIndex("by_release_id_and_repack_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogRepackReconciliation")
      .withIndex("by_release_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogCollectibleReconciliation")
      .withIndex("by_release_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogRepacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogCollectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogCategories")
      .withIndex("by_release_id_and_public_category_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogVendors")
      .withIndex("by_release_id_and_public_vendor_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogSearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogSearchShardProofs")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogBatches")
      .withIndex("by_release_id_and_batch_index", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogPublications")
      .withIndex("by_release_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogReleaseCompletionProofs")
      .withIndex("by_release_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
    (limit) => ctx.db
      .query("providerCatalogTerminalReceiptProofs")
      .withIndex("by_release_id", (index) =>
        index.eq("releaseId", releaseId),
      )
      .take(limit),
  ];
  let deletedDocumentCount = 0;
  for (const load of loaders) {
    const remaining = maximumDocuments - deletedDocumentCount;
    if (remaining === 0) {
      return { deletedDocumentCount, hasMore: true };
    }
    deletedDocumentCount += await deleteProviderOwnedRows(
      ctx,
      await load(remaining),
      remaining,
    );
  }
  if (deletedDocumentCount === maximumDocuments) {
    return { deletedDocumentCount, hasMore: true };
  }
  await ctx.db.delete("providerCatalogReleases", releaseId);
  return { deletedDocumentCount: deletedDocumentCount + 1, hasMore: false };
}
