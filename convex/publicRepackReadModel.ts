import {
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
  dataReleaseMetadataSchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  type DataReleaseMetadata,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import { env, type QueryCtx } from "./_generated/server";
import {
  REPACK_SEARCH_SHARD_HASH_DOMAIN,
  REPACK_SEARCH_INDEX_HASH_DOMAIN,
  canonicalJson,
  sha256CanonicalJson,
} from "./dataReleaseCanonicalHash";
import {
  MAX_REPACK_SEARCH_SHARDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  isValidRepackSearchRow,
  repackSearchRowMatchesDetail,
  type RepackSearchRow,
} from "./publicRepackValidation";

export type ReadableDataRelease = Readonly<{
  state: Doc<"dataReleaseState">;
  release: Doc<"dataReleases">;
  metadata: DataReleaseMetadata;
}>;

function dataSourceIsReadable(metadata: DataReleaseMetadata): boolean {
  if (metadata.dataSource === "canonical") {
    return (
      /^[0-9a-f]{64}$/.test(env.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH ?? "") &&
      env.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH === metadata.originSetHash
    );
  }
  return (
    env.PACKSCOUT_RUNTIME_ENVIRONMENT === "local" ||
    env.PACKSCOUT_RUNTIME_ENVIRONMENT === "development" ||
    env.PACKSCOUT_RUNTIME_ENVIRONMENT === "preproduction"
  );
}

export async function oneReleaseByPublicId(
  ctx: QueryCtx,
  publicReleaseId: string,
): Promise<Doc<"dataReleases"> | null> {
  const matches = await ctx.db
    .query("dataReleases")
    .withIndex("by_public_release_id", (index) =>
      index.eq("publicReleaseId", publicReleaseId),
    )
    .take(2);
  return matches.length === 1 ? matches[0]! : null;
}

export async function loadReadableDataRelease(
  ctx: QueryCtx,
): Promise<ReadableDataRelease | null> {
  const states = await ctx.db
    .query("dataReleaseState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length !== 1 || states[0]!.activeReleaseId === null) return null;
  const state = states[0]!;
  const activeReleaseId = state.activeReleaseId;
  if (activeReleaseId === null) return null;
  const release = await ctx.db.get("dataReleases", activeReleaseId);
  if (
    release === null ||
    release.lifecycle !== "complete" ||
    release.publicReleaseId !== release.metadata.publicReleaseId ||
    !Number.isSafeInteger(release.searchShardCount) ||
    release.searchShardCount < 0 ||
    release.searchShardCount > MAX_REPACK_SEARCH_SHARDS
  ) {
    return null;
  }
  const parsed = dataReleaseMetadataSchema.safeParse({
    ...release.metadata,
    dataAsOf: state.dataAsOf,
    lastSuccessfulObservationAt: state.lastSuccessfulObservationAt,
    staleAt: state.staleAt,
    freshness: state.freshness,
    delayedVendorCount: state.delayedVendorCount,
  });
  return parsed.success && dataSourceIsReadable(parsed.data)
    ? { state, release, metadata: parsed.data }
    : null;
}

export async function loadRepackSearchRows(
  ctx: QueryCtx,
  release: Doc<"dataReleases">,
): Promise<readonly RepackSearchRow[] | null> {
  const shards = await ctx.db
    .query("repackSearchShards")
    .withIndex("by_release_id_and_shard_number", (index) =>
      index.eq("releaseId", release._id),
    )
    .order("asc")
    .take(MAX_REPACK_SEARCH_SHARDS + 1);
  if (shards.length !== release.searchShardCount) return null;

  const rows: RepackSearchRow[] = [];
  const shardDescriptors: Array<{
    shardNumber: number;
    rowCount: number;
    byteCount: number;
    contentHash: string;
  }> = [];
  const publicRepackIds = new Set<string>();
  for (const [shardIndex, shard] of shards.entries()) {
    const encodedRows = new TextEncoder().encode(canonicalJson(shard.rows));
    if (
      shard.shardNumber !== shardIndex ||
      shard.rowCount !== shard.rows.length ||
      shard.rows.length > MAX_ROWS_PER_REPACK_SEARCH_SHARD ||
      shard.byteCount !== encodedRows.byteLength ||
      shard.byteCount > 48 * 1_024 ||
      shard.contentHash !==
        await sha256CanonicalJson(REPACK_SEARCH_SHARD_HASH_DOMAIN, shard.rows)
    ) {
      return null;
    }
    shardDescriptors.push({
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
    });
    for (const row of shard.rows) {
      if (!isValidRepackSearchRow(row) || publicRepackIds.has(row.publicRepackId)) {
        return null;
      }
      publicRepackIds.add(row.publicRepackId);
      rows.push(row);
    }
  }
  return rows.length === release.metadata.repackCount &&
      release.metadata.repackSearchIndexHash ===
        await sha256CanonicalJson(
          REPACK_SEARCH_INDEX_HASH_DOMAIN,
          shardDescriptors,
        )
    ? rows
    : null;
}

export async function loadRepackDetail(
  ctx: QueryCtx,
  releaseId: Id<"dataReleases">,
  publicRepackId: string,
): Promise<PublicRepackDetail | null> {
  const documents = await ctx.db
    .query("repacks")
    .withIndex("by_release_id_and_public_repack_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicRepackId", publicRepackId),
    )
    .take(2);
  if (documents.length !== 1) return null;
  const parsed = publicRepackDetailSchema.safeParse(documents[0]!.detail);
  return parsed.success &&
      documents[0]!.publicRepackId === parsed.data.publicRepackId
    ? parsed.data
    : null;
}

export async function loadRepackDetails(
  ctx: QueryCtx,
  releaseId: Id<"dataReleases">,
  rows: readonly RepackSearchRow[],
): Promise<PublicRepackDetail[] | null> {
  const details = await Promise.all(
    rows.map((row) => loadRepackDetail(ctx, releaseId, row.publicRepackId)),
  );
  return details.some(
    (detail, index) =>
      detail === null || !repackSearchRowMatchesDetail(rows[index]!, detail),
  )
    ? null
    : (details as PublicRepackDetail[]);
}

export async function loadCollectible(
  ctx: QueryCtx,
  releaseId: Id<"dataReleases">,
  publicCollectibleId: string,
): Promise<{ document: Doc<"collectibles">; detail: PublicCollectible } | null> {
  const documents = await ctx.db
    .query("collectibles")
    .withIndex("by_release_id_and_public_collectible_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("publicCollectibleId", publicCollectibleId),
    )
    .take(2);
  if (documents.length !== 1) return null;
  const parsed = publicCollectibleSchema.safeParse(documents[0]!.detail);
  return parsed.success
    ? collectibleFromDocument(documents[0]!, parsed.data)
    : null;
}

export function collectibleFromDocument(
  document: Doc<"collectibles">,
  detailInput?: PublicCollectible,
): { document: Doc<"collectibles">; detail: PublicCollectible } | null {
  const parsed = detailInput === undefined
    ? publicCollectibleSchema.safeParse(document.detail)
    : { success: true as const, data: detailInput };
  return parsed.success &&
      document.publicCollectibleId === parsed.data.publicCollectibleId &&
      document.collectibleType === parsed.data.collectibleType &&
      document.normalizedName === parsed.data.normalizedName &&
      document.searchText === parsed.data.searchText
    ? { document, detail: parsed.data }
    : null;
}

export async function loadDesiredChases(
  ctx: QueryCtx,
  releaseId: Id<"dataReleases">,
  collectible: { document: Doc<"collectibles">; detail: PublicCollectible },
  allowedPublicRepackIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, PublicRepackChase> | null> {
  const relations = await ctx.db
    .query("repackChases")
    .withIndex("by_release_id_and_collectible_id", (index) =>
      index
        .eq("releaseId", releaseId)
        .eq("collectibleId", collectible.document._id),
    )
    .take(MAX_REPACK_CHASES_PER_COLLECTIBLE + 1);
  if (relations.length > MAX_REPACK_CHASES_PER_COLLECTIBLE) return null;

  const byPublicRepackId = new Map<string, PublicRepackChase>();
  const expectedCollectibleProjection = {
    publicCollectibleId: collectible.detail.publicCollectibleId,
    name: collectible.detail.name,
    collectibleType: collectible.detail.collectibleType,
    publicCategoryIds: collectible.detail.publicCategoryIds,
    primaryImage: collectible.detail.primaryImage,
    valuation: collectible.detail.valuation,
  };
  for (const relation of relations) {
    const chase = publicRepackChaseSchema.safeParse(relation.detail);
    if (
      !chase.success ||
      relation.releaseId !== releaseId ||
      relation.collectibleId !== collectible.document._id ||
      chase.data.publicCollectibleId !== collectible.detail.publicCollectibleId ||
      canonicalJson(chase.data.collectible) !==
        canonicalJson(expectedCollectibleProjection) ||
      !allowedPublicRepackIds.has(chase.data.publicRepackId) ||
      byPublicRepackId.has(chase.data.publicRepackId)
    ) {
      return null;
    }
    byPublicRepackId.set(chase.data.publicRepackId, chase.data);
  }
  return byPublicRepackId;
}
