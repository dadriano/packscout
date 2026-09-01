import {
  PROVIDER_CATALOG_RELEASE_BATCH_KINDS,
  PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
  canonicalJson,
  verifyProviderCatalogReleasePlanV1,
  type ProviderCatalogReleaseBatchKindV1,
  type ProviderCatalogReleaseBatchRecordMapV1,
  type ProviderCatalogReleaseBatchV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderCatalogReleaseSearchShardV1,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import { normalizeLegacyPackAvailability } from "./publicRepackValidation";

type StoredReleaseGraph = Readonly<{
  batches: readonly Doc<"providerCatalogBatches">[];
  vendors: readonly Doc<"providerCatalogVendors">[];
  categories: readonly Doc<"providerCatalogCategories">[];
  collectibles: readonly Doc<"providerCatalogCollectibles">[];
  repacks: readonly Doc<"providerCatalogRepacks">[];
  repackChases: readonly Doc<"providerCatalogRepackChases">[];
  searchShards: readonly Doc<"providerCatalogSearchShards">[];
  repackReconciliation: readonly Doc<"providerCatalogRepackReconciliation">[];
  collectibleReconciliation: readonly Doc<"providerCatalogCollectibleReconciliation">[];
}>;

type RecordsByKind = {
  [Kind in ProviderCatalogReleaseBatchKindV1]:
    readonly ProviderCatalogReleaseBatchRecordMapV1[Kind][];
};

function reconciliationFailed(): never {
  refuseProviderRelease("PROVIDER_RELEASE_RECONCILIATION_FAILED");
}

function exactCount<T>(documents: readonly T[], expected: number): readonly T[] {
  if (documents.length !== expected) reconciliationFailed();
  return documents;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueBy<T>(
  documents: readonly T[],
  key: (document: T) => string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const document of documents) {
    const identity = key(document);
    if (result.has(identity)) reconciliationFailed();
    result.set(identity, document);
  }
  return result;
}

async function loadStoredReleaseGraph(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<StoredReleaseGraph> {
  const [
    batches,
    vendors,
    categories,
    collectibles,
    repacks,
    repackChases,
    searchShards,
    repackReconciliation,
    collectibleReconciliation,
  ] = await Promise.all([
    ctx.db
      .query("providerCatalogBatches")
      .withIndex("by_release_id_and_batch_index", (index) =>
        index.eq("releaseId", release._id),
      )
      .order("asc")
      .take(release.batchCount + 1),
    ctx.db
      .query("providerCatalogVendors")
      .withIndex("by_release_id_and_public_vendor_id", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(release.counts.vendors + 1),
    ctx.db
      .query("providerCatalogCategories")
      .withIndex("by_release_id_and_public_category_id", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(release.counts.categories + 1),
    ctx.db
      .query("providerCatalogCollectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(release.counts.collectibles + 1),
    ctx.db
      .query("providerCatalogRepacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(release.counts.repacks + 1),
    ctx.db
      .query("providerCatalogRepackChases")
      .withIndex("by_release_id_and_repack_id", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(release.counts.repackChases + 1),
    ctx.db
      .query("providerCatalogSearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", release._id),
      )
      .order("asc")
      .take(release.counts.searchShards + 1),
    ctx.db
      .query("providerCatalogRepackReconciliation")
      .withIndex("by_release_id", (index) => index.eq("releaseId", release._id))
      .take(release.counts.repacks + 1),
    ctx.db
      .query("providerCatalogCollectibleReconciliation")
      .withIndex("by_release_id", (index) => index.eq("releaseId", release._id))
      .take(release.counts.collectibles + 1),
  ]);

  return {
    batches: exactCount(batches, release.batchCount),
    vendors: exactCount(vendors, release.counts.vendors),
    categories: exactCount(categories, release.counts.categories),
    collectibles: exactCount(collectibles, release.counts.collectibles),
    repacks: exactCount(repacks, release.counts.repacks),
    repackChases: exactCount(repackChases, release.counts.repackChases),
    searchShards: exactCount(searchShards, release.counts.searchShards),
    repackReconciliation: exactCount(
      repackReconciliation,
      release.counts.repacks,
    ),
    collectibleReconciliation: exactCount(
      collectibleReconciliation,
      release.counts.collectibles,
    ),
  };
}

function assertStoredLinks(graph: StoredReleaseGraph): void {
  const vendorsById = uniqueBy(graph.vendors, ({ _id }) => _id);
  const categoriesById = uniqueBy(graph.categories, ({ _id }) => _id);
  const categoriesByPublicId = uniqueBy(
    graph.categories,
    ({ publicCategoryId }) => publicCategoryId,
  );
  const collectiblesById = uniqueBy(graph.collectibles, ({ _id }) => _id);
  const repacksById = uniqueBy(graph.repacks, ({ _id }) => _id);
  const chasesByRepackId = new Map<string, Doc<"providerCatalogRepackChases">[]>();
  const chaseCountByCollectibleId = new Map<string, number>();

  for (const vendor of graph.vendors) {
    if (
      vendor.publicVendorId !== vendor.detail.publicVendorId ||
      vendor.vendorKey !== vendor.detail.vendorKey
    ) {
      reconciliationFailed();
    }
  }
  for (const category of graph.categories) {
    const parent = category.parentCategoryId === null
      ? null
      : categoriesById.get(category.parentCategoryId) ?? null;
    if (
      category.publicCategoryId !== category.detail.publicCategoryId ||
      category.categoryKey !== category.detail.categoryKey ||
      (category.detail.parentPublicCategoryId === null) !== (parent === null) ||
      (parent !== null &&
        parent.publicCategoryId !== category.detail.parentPublicCategoryId) ||
      category.detail.pathPublicCategoryIds.some(
        (publicCategoryId) => !categoriesByPublicId.has(publicCategoryId),
      )
    ) {
      reconciliationFailed();
    }
  }
  for (const collectible of graph.collectibles) {
    if (
      collectible.publicCollectibleId !== collectible.detail.publicCollectibleId ||
      collectible.collectibleType !== collectible.detail.collectibleType ||
      collectible.normalizedName !== collectible.detail.normalizedName ||
      collectible.searchText !== collectible.detail.searchText
    ) {
      reconciliationFailed();
    }
  }
  for (const repack of graph.repacks) {
    const vendor = vendorsById.get(repack.vendorId);
    if (
      repack.publicRepackId !== repack.detail.publicRepackId ||
      vendor === undefined ||
      vendor.publicVendorId !== repack.detail.publicVendorId
    ) {
      reconciliationFailed();
    }
  }
  for (const chase of graph.repackChases) {
    const repack = repacksById.get(chase.repackId);
    const collectible = collectiblesById.get(chase.collectibleId);
    if (
      repack === undefined ||
      collectible === undefined ||
      repack.publicRepackId !== chase.detail.publicRepackId ||
      collectible.publicCollectibleId !== chase.detail.publicCollectibleId
    ) {
      reconciliationFailed();
    }
    const repackChases = chasesByRepackId.get(chase.repackId) ?? [];
    repackChases.push(chase);
    chasesByRepackId.set(chase.repackId, repackChases);
    chaseCountByCollectibleId.set(
      chase.collectibleId,
      (chaseCountByCollectibleId.get(chase.collectibleId) ?? 0) + 1,
    );
  }

  const repackStateByPublicId = uniqueBy(
    graph.repackReconciliation,
    ({ publicRepackId }) => publicRepackId,
  );
  for (const repack of graph.repacks) {
    const state = repackStateByPublicId.get(repack.publicRepackId);
    const chases = chasesByRepackId.get(repack._id) ?? [];
    const topChaseCount = chases.filter(
      ({ detail }) => detail.role === "top_chase",
    ).length;
    const expectedTopChaseJson = repack.detail.topChase === null
      ? null
      : canonicalJson(repack.detail.topChase);
    if (
      state === undefined ||
      state.repackId !== repack._id ||
      state.expectedChaseCount !== repack.detail.contentSummary.chaseCount ||
      state.acceptedChaseCount !== chases.length ||
      state.acceptedChaseCount !== state.expectedChaseCount ||
      state.expectedTopChaseJson !== expectedTopChaseJson ||
      state.acceptedTopChaseCount !== topChaseCount ||
      state.bestChaseJson !== expectedTopChaseJson ||
      !state.complete
    ) {
      reconciliationFailed();
    }
  }

  const collectibleStateByPublicId = uniqueBy(
    graph.collectibleReconciliation,
    ({ publicCollectibleId }) => publicCollectibleId,
  );
  for (const collectible of graph.collectibles) {
    const state = collectibleStateByPublicId.get(
      collectible.publicCollectibleId,
    );
    if (
      state === undefined ||
      state.collectibleId !== collectible._id ||
      state.chaseCount !== (chaseCountByCollectibleId.get(collectible._id) ?? 0)
    ) {
      reconciliationFailed();
    }
  }
}

function recordsByKind(graph: StoredReleaseGraph): RecordsByKind {
  return {
    vendors: graph.vendors
      .map(({ detail }) => detail)
      .sort((left, right) =>
        compareText(left.publicVendorId, right.publicVendorId)
      ),
    categories: graph.categories
      .map(({ detail }) => detail)
      .sort((left, right) =>
        left.depth - right.depth ||
        compareText(left.publicCategoryId, right.publicCategoryId)
      ),
    collectibles: graph.collectibles
      .map(({ detail }) => detail)
      .sort((left, right) =>
        compareText(left.publicCollectibleId, right.publicCollectibleId)
      ),
    repacks: graph.repacks
      .map(({ detail }) => ({
        ...detail,
        availability: normalizeLegacyPackAvailability(detail.availability),
      }))
      .sort((left, right) =>
        compareText(left.publicRepackId, right.publicRepackId)
      ),
    repack_chases: graph.repackChases
      .map(({ detail }) => detail)
      .sort((left, right) =>
        compareText(left.publicRepackId, right.publicRepackId) ||
        left.displayOrder - right.displayOrder ||
        compareText(left.publicCollectibleId, right.publicCollectibleId)
      ),
    search_shards: graph.searchShards.map((shard) => ({
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
      rows: [...shard.rows],
    })) as readonly ProviderCatalogReleaseSearchShardV1[],
  };
}

function consumeBatch(
  stored: Doc<"providerCatalogBatches">,
  records: RecordsByKind,
  offsets: Record<ProviderCatalogReleaseBatchKindV1, number>,
): ProviderCatalogReleaseBatchV1 {
  const start = offsets[stored.kind];
  const end = start + stored.recordCount;
  const selected = records[stored.kind].slice(start, end);
  if (selected.length !== stored.recordCount) reconciliationFailed();
  offsets[stored.kind] = end;
  return {
    batchIndex: stored.batchIndex,
    kind: stored.kind,
    batchHash: stored.batchHash,
    byteCount: stored.byteCount,
    records: [...selected],
  } as ProviderCatalogReleaseBatchV1;
}

function rebuildPublicationPlan(
  release: Doc<"providerCatalogReleases">,
  publication: Doc<"providerCatalogPublications">,
  graph: StoredReleaseGraph,
): ProviderCatalogReleasePublishPlanV1 {
  if (release.counts.vendors !== 1) reconciliationFailed();
  const records = recordsByKind(graph);
  const offsets = Object.fromEntries(
    PROVIDER_CATALOG_RELEASE_BATCH_KINDS.map((kind) => [kind, 0]),
  ) as Record<ProviderCatalogReleaseBatchKindV1, number>;
  const batches = graph.batches.map((stored, index) => {
    if (
      stored.batchIndex !== index ||
      stored.releaseId !== release._id ||
      stored.platformKey !== release.platformKey ||
      stored.publicProviderReleaseId !== release.publicProviderReleaseId ||
      stored.recordCount <= 0
    ) {
      reconciliationFailed();
    }
    return consumeBatch(stored, records, offsets);
  });
  if (
    PROVIDER_CATALOG_RELEASE_BATCH_KINDS.some(
      (kind) => offsets[kind] !== records[kind].length,
    )
  ) {
    reconciliationFailed();
  }
  return {
    schemaVersion: PROVIDER_CATALOG_RELEASE_SCHEMA_VERSION,
    classification: "publish",
    platformKey: release.platformKey,
    sharedConfigurationEpoch: release.sharedConfigurationEpoch,
    providerCheckpoint: publication.providerCheckpoint,
    sourceWatermark: publication.sourceWatermark,
    observation: publication.observation,
    dataAsOf: release.dataAsOf,
    publicProviderReleaseId: release.publicProviderReleaseId,
    providerReleaseFingerprint: release.providerReleaseFingerprint,
    contentHash: release.contentHash,
    publicAssetOrigins: release.publicAssetOrigins,
    governingHashes: release.governingHashes,
    entityHashes: release.entityHashes,
    counts: { ...release.counts, vendors: 1 },
    searchAlgorithmVersion: release.searchAlgorithmVersion,
    providerSearchIndexHash: release.providerSearchIndexHash,
    batchCount: release.batchCount,
    batchChainHash: release.batchChainHash,
    batches,
  };
}

export async function assertProviderReleaseFinalization(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
  publication: Doc<"providerCatalogPublications">,
): Promise<void> {
  const graph = await loadStoredReleaseGraph(ctx, release);
  assertStoredLinks(graph);
  try {
    const verified = await verifyProviderCatalogReleasePlanV1(
      rebuildPublicationPlan(release, publication, graph),
    );
    if (verified.classification !== "publish") reconciliationFailed();
  } catch {
    reconciliationFailed();
  }
}
