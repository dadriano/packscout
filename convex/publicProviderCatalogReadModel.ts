import {
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
  MAX_REPACK_SEARCH_SHARDS,
  MAX_ROWS_PER_REPACK_SEARCH_SHARD,
  canonicalJson,
  providerCatalogReleaseBatchByteCount,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  recomputeProviderCatalogSearchIndexHashV1,
  recomputeProviderCatalogSearchShardHashV1,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  isValidRepackSearchRow,
  normalizeLegacyPackAvailability,
  repackSearchRowMatchesDetail,
  type RepackSearchRow,
} from "./publicRepackValidation";

export type SelectedProviderRelease = Readonly<{
  platformKey: string;
  release: Doc<"providerCatalogReleases">;
}>;

export type PublicProviderCatalog = Readonly<{
  providers: readonly SelectedProviderRelease[];
  rows: readonly RepackSearchRow[];
  repackReleaseByPublicId: ReadonlyMap<
    string,
    Doc<"providerCatalogReleases">
  >;
  vendorByReleaseId: ReadonlyMap<
    Id<"providerCatalogReleases">,
    Doc<"providerCatalogVendors">
  >;
  categoryByPublicId: ReadonlyMap<string, PublicCategory>;
  categoryIdsByReleaseId: ReadonlyMap<
    Id<"providerCatalogReleases">,
    ReadonlySet<string>
  >;
}>;

export type SharedCollectible = Readonly<{
  detail: PublicCollectible;
  occurrences: readonly Readonly<{
    release: Doc<"providerCatalogReleases">;
    document: Doc<"providerCatalogCollectibles">;
  }>[];
}>;

export type SharedCollectibleLookup =
  | Readonly<{ status: "found"; collectible: SharedCollectible }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "invalid" }>;

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function loadProviderRows(
  ctx: QueryCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<readonly RepackSearchRow[] | null> {
  if (
    !Number.isSafeInteger(release.counts.searchShards) ||
    release.counts.searchShards < 0 ||
    release.counts.searchShards > MAX_REPACK_SEARCH_SHARDS
  ) {
    return null;
  }
  const [shards, proofs] = await Promise.all([
    ctx.db
      .query("providerCatalogSearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", release._id),
      )
      .order("asc")
      .take(MAX_REPACK_SEARCH_SHARDS + 1),
    ctx.db
      .query("providerCatalogSearchShardProofs")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", release._id),
      )
      .order("asc")
      .take(MAX_REPACK_SEARCH_SHARDS + 1),
  ]);
  if (
    shards.length !== release.counts.searchShards ||
    proofs.length !== release.counts.searchShards
  ) {
    return null;
  }

  const rows: RepackSearchRow[] = [];
  const descriptors: Array<{
    shardNumber: number;
    rowCount: number;
    byteCount: number;
    contentHash: string;
  }> = [];
  let priorPublicRepackId: string | null = null;
  for (const [shardIndex, shard] of shards.entries()) {
    const proof = proofs[shardIndex];
    if (
      proof === undefined ||
      shard.shardNumber !== shardIndex ||
      shard.rowCount !== shard.rows.length ||
      shard.rows.length === 0 ||
      shard.rows.length > MAX_ROWS_PER_REPACK_SEARCH_SHARD ||
      shard.byteCount !== providerCatalogReleaseBatchByteCount(shard.rows) ||
      shard.contentHash !==
        await recomputeProviderCatalogSearchShardHashV1(shard.rows) ||
      proof.shardNumber !== shard.shardNumber ||
      proof.rowCount !== shard.rowCount ||
      proof.byteCount !== shard.byteCount ||
      proof.contentHash !== shard.contentHash
    ) {
      return null;
    }
    descriptors.push({
      shardNumber: shard.shardNumber,
      rowCount: shard.rowCount,
      byteCount: shard.byteCount,
      contentHash: shard.contentHash,
    });
    for (const storedRow of shard.rows) {
      // Shard hashes above cover the stored bytes, so rows persisted before
      // the availability rename are translated only after those checks.
      const row = {
        ...storedRow,
        availability: normalizeLegacyPackAvailability(storedRow.availability),
      };
      if (
        !isValidRepackSearchRow(row) ||
        (priorPublicRepackId !== null &&
          compareText(priorPublicRepackId, row.publicRepackId) >= 0)
      ) {
        return null;
      }
      priorPublicRepackId = row.publicRepackId;
      rows.push(row);
    }
  }
  return rows.length === release.counts.repacks &&
      release.providerSearchIndexHash ===
        await recomputeProviderCatalogSearchIndexHashV1(descriptors)
    ? rows
    : null;
}

async function loadProviderVendor(
  ctx: QueryCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<Doc<"providerCatalogVendors"> | null> {
  if (release.counts.vendors !== 1) return null;
  const documents = await ctx.db
    .query("providerCatalogVendors")
    .withIndex("by_release_id_and_public_vendor_id", (index) =>
      index.eq("releaseId", release._id),
    )
    .take(2);
  const document = documents[0];
  const parsed = document === undefined
    ? null
    : publicVendorSchema.safeParse(document.detail);
  return documents.length === 1 &&
      document !== undefined &&
      parsed?.success === true &&
      document.releaseId === release._id &&
      document.publicVendorId === parsed.data.publicVendorId &&
      document.vendorKey === parsed.data.vendorKey
    ? document
    : null;
}

async function loadProviderCategories(
  ctx: QueryCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<readonly Doc<"providerCatalogCategories">[] | null> {
  if (
    !Number.isSafeInteger(release.counts.categories) ||
    release.counts.categories < 0 ||
    release.counts.categories > 4_096
  ) {
    return null;
  }
  const documents = await ctx.db
    .query("providerCatalogCategories")
    .withIndex("by_release_id_and_public_category_id", (index) =>
      index.eq("releaseId", release._id),
    )
    .take(release.counts.categories + 1);
  if (documents.length !== release.counts.categories) return null;
  const byId = new Map(
    documents.map((document) => [document.publicCategoryId, document]),
  );
  const byInternalId = new Map(
    documents.map((document) => [document._id, document]),
  );
  if (
    byId.size !== documents.length ||
    new Set(documents.map(({ categoryKey }) => categoryKey)).size !==
      documents.length
  ) {
    return null;
  }
  for (const document of documents) {
    const parsed = publicCategorySchema.safeParse(document.detail);
    const parent = document.parentCategoryId === null
      ? null
      : byInternalId.get(document.parentCategoryId) ?? null;
    if (
      !parsed.success ||
      document.releaseId !== release._id ||
      document.publicCategoryId !== parsed.data.publicCategoryId ||
      document.categoryKey !== parsed.data.categoryKey ||
      (parsed.data.parentPublicCategoryId === null) !==
        (document.parentCategoryId === null) ||
      (parsed.data.parentPublicCategoryId !== null &&
        parent?.publicCategoryId !== parsed.data.parentPublicCategoryId) ||
      !sameValue(
        parsed.data.pathPublicCategoryIds,
        parent === null
          ? [parsed.data.publicCategoryId]
          : [
              ...parent.detail.pathPublicCategoryIds,
              parsed.data.publicCategoryId,
            ],
      )
    ) {
      return null;
    }
  }
  return documents;
}

export async function loadPublicProviderCatalog(
  ctx: QueryCtx,
  providers: readonly SelectedProviderRelease[],
  expectedCounts: {
    readonly vendorCount: number;
    readonly categoryCount: number;
    readonly repackCount: number;
  },
): Promise<PublicProviderCatalog | null> {
  if (
    providers.length < 1 ||
    providers.length > MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES
  ) {
    return null;
  }
  const platformKeys = providers.map(({ platformKey }) => platformKey);
  if (
    new Set(platformKeys).size !== platformKeys.length ||
    platformKeys.some(
      (platformKey, index) =>
        index > 0 && compareText(platformKeys[index - 1]!, platformKey) >= 0,
    )
  ) {
    return null;
  }

  const providerParts = await Promise.all(
    providers.map(async ({ platformKey, release }) => {
      if (
        release.platformKey !== platformKey ||
        release.lifecycle !== "complete"
      ) {
        return null;
      }
      const [rows, vendor, categories] = await Promise.all([
        loadProviderRows(ctx, release),
        loadProviderVendor(ctx, release),
        loadProviderCategories(ctx, release),
      ]);
      return rows === null || vendor === null || categories === null
        ? null
        : { release, rows, vendor, categories };
    }),
  );
  if (providerParts.some((part) => part === null)) return null;

  const rows: RepackSearchRow[] = [];
  const repackReleaseByPublicId = new Map<
    string,
    Doc<"providerCatalogReleases">
  >();
  const vendorByReleaseId = new Map<
    Id<"providerCatalogReleases">,
    Doc<"providerCatalogVendors">
  >();
  const vendorIds = new Set<string>();
  const vendorKeys = new Set<string>();
  const categoryByPublicId = new Map<string, PublicCategory>();
  const categoryIdByKey = new Map<string, string>();
  const categoryIdsByReleaseId = new Map<
    Id<"providerCatalogReleases">,
    ReadonlySet<string>
  >();

  for (const part of providerParts) {
    if (part === null) return null;
    if (
      vendorIds.has(part.vendor.publicVendorId) ||
      vendorKeys.has(part.vendor.vendorKey)
    ) {
      return null;
    }
    vendorIds.add(part.vendor.publicVendorId);
    vendorKeys.add(part.vendor.vendorKey);
    vendorByReleaseId.set(part.release._id, part.vendor);

    const releaseCategoryIds = new Set<string>();
    for (const category of part.categories) {
      const existing = categoryByPublicId.get(category.publicCategoryId);
      const existingIdForKey = categoryIdByKey.get(category.categoryKey);
      if (
        (existing !== undefined && !sameValue(existing, category.detail)) ||
        (existingIdForKey !== undefined &&
          existingIdForKey !== category.publicCategoryId)
      ) {
        return null;
      }
      categoryByPublicId.set(category.publicCategoryId, category.detail);
      categoryIdByKey.set(category.categoryKey, category.publicCategoryId);
      releaseCategoryIds.add(category.publicCategoryId);
    }
    categoryIdsByReleaseId.set(part.release._id, releaseCategoryIds);

    for (const row of part.rows) {
      if (
        repackReleaseByPublicId.has(row.publicRepackId) ||
        row.publicVendorId !== part.vendor.publicVendorId ||
        row.vendorKey !== part.vendor.vendorKey ||
        row.vendorDisplayName !== part.vendor.detail.displayName ||
        row.publicCategoryIds.some((id, index) => {
          const category = categoryByPublicId.get(id);
          return !releaseCategoryIds.has(id) ||
            category === undefined ||
            category.name !== row.categoryLabels[index];
        })
      ) {
        return null;
      }
      repackReleaseByPublicId.set(row.publicRepackId, part.release);
      rows.push(row);
    }
  }
  rows.sort((left, right) => compareText(left.publicRepackId, right.publicRepackId));
  return vendorIds.size === expectedCounts.vendorCount &&
      categoryByPublicId.size === expectedCounts.categoryCount &&
      rows.length === expectedCounts.repackCount
    ? {
        providers,
        rows,
        repackReleaseByPublicId,
        vendorByReleaseId,
        categoryByPublicId,
        categoryIdsByReleaseId,
      }
    : null;
}

export async function loadProviderRepackDetail(
  ctx: QueryCtx,
  catalog: PublicProviderCatalog,
  publicRepackId: string,
): Promise<PublicRepackDetail | null> {
  const release = catalog.repackReleaseByPublicId.get(publicRepackId);
  if (release === undefined) return null;
  const documents = await ctx.db
    .query("providerCatalogRepacks")
    .withIndex("by_release_id_and_public_repack_id", (index) =>
      index.eq("releaseId", release._id).eq("publicRepackId", publicRepackId),
    )
    .take(2);
  const document = documents[0];
  // Stored details may predate the availability rename; translate before the
  // strict public parse so legacy releases stay readable.
  const parsed = document === undefined
    ? null
    : publicRepackDetailSchema.safeParse({
        ...document.detail,
        availability: normalizeLegacyPackAvailability(
          document.detail.availability,
        ),
      });
  const vendor = catalog.vendorByReleaseId.get(release._id);
  const releaseCategoryIds = catalog.categoryIdsByReleaseId.get(release._id);
  return documents.length === 1 &&
      document !== undefined &&
      parsed?.success === true &&
      vendor !== undefined &&
      releaseCategoryIds !== undefined &&
      document.releaseId === release._id &&
      document.publicRepackId === publicRepackId &&
      document.vendorId === vendor._id &&
      parsed.data.publicVendorId === vendor.publicVendorId &&
      parsed.data.categories.every(({ publicCategoryId, label }) =>
        releaseCategoryIds.has(publicCategoryId) &&
        catalog.categoryByPublicId.get(publicCategoryId)?.name === label,
      )
    ? parsed.data
    : null;
}

export async function loadProviderRepackDetails(
  ctx: QueryCtx,
  catalog: PublicProviderCatalog,
  rows: readonly RepackSearchRow[],
): Promise<PublicRepackDetail[] | null> {
  const details = await Promise.all(
    rows.map((row) =>
      loadProviderRepackDetail(ctx, catalog, row.publicRepackId),
    ),
  );
  return details.some(
    (detail, index) =>
      detail === null || !repackSearchRowMatchesDetail(rows[index]!, detail),
  )
    ? null
    : (details as PublicRepackDetail[]);
}

export function collectibleFromProviderDocument(
  document: Doc<"providerCatalogCollectibles">,
  detailInput?: PublicCollectible,
): { document: Doc<"providerCatalogCollectibles">; detail: PublicCollectible } | null {
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

function collectibleReferencesAreValid(
  catalog: PublicProviderCatalog,
  releaseId: Id<"providerCatalogReleases">,
  detail: PublicCollectible,
): boolean {
  const categoryIds = catalog.categoryIdsByReleaseId.get(releaseId);
  return categoryIds !== undefined &&
    detail.publicCategoryIds.every((categoryId) => categoryIds.has(categoryId));
}

export async function loadSharedCollectible(
  ctx: QueryCtx,
  catalog: PublicProviderCatalog,
  publicCollectibleId: string,
): Promise<SharedCollectibleLookup> {
  const groups = await Promise.all(
    catalog.providers.map(async ({ release }) => ({
      release,
      documents: await ctx.db
        .query("providerCatalogCollectibles")
        .withIndex("by_release_id_and_public_collectible_id", (index) =>
          index
            .eq("releaseId", release._id)
            .eq("publicCollectibleId", publicCollectibleId),
        )
        .take(2),
    })),
  );
  const occurrences: Array<{
    release: Doc<"providerCatalogReleases">;
    document: Doc<"providerCatalogCollectibles">;
  }> = [];
  let detail: PublicCollectible | null = null;
  for (const group of groups) {
    if (group.documents.length > 1) return { status: "invalid" };
    const document = group.documents[0];
    if (document === undefined) continue;
    const parsed = collectibleFromProviderDocument(document);
    if (
      parsed === null ||
      document.releaseId !== group.release._id ||
      !collectibleReferencesAreValid(catalog, group.release._id, parsed.detail) ||
      (detail !== null && !sameValue(detail, parsed.detail))
    ) {
      return { status: "invalid" };
    }
    detail = parsed.detail;
    occurrences.push({ release: group.release, document });
  }
  return detail === null
    ? { status: "not_found" }
    : { status: "found", collectible: { detail, occurrences } };
}

export async function loadProviderDesiredChases(
  ctx: QueryCtx,
  catalog: PublicProviderCatalog,
  collectible: SharedCollectible,
): Promise<ReadonlyMap<string, PublicRepackChase> | null> {
  const relationGroups = await Promise.all(
    collectible.occurrences.map(async ({ release, document }) => ({
      release,
      document,
      relations: await ctx.db
        .query("providerCatalogRepackChases")
        .withIndex("by_release_id_and_collectible_id", (index) =>
          index.eq("releaseId", release._id).eq("collectibleId", document._id),
        )
        .take(MAX_REPACK_CHASES_PER_COLLECTIBLE + 1),
    })),
  );
  const byPublicRepackId = new Map<string, PublicRepackChase>();
  const expectedCollectibleProjection = {
    publicCollectibleId: collectible.detail.publicCollectibleId,
    name: collectible.detail.name,
    collectibleType: collectible.detail.collectibleType,
    publicCategoryIds: collectible.detail.publicCategoryIds,
    primaryImage: collectible.detail.primaryImage,
    valuation: collectible.detail.valuation,
  };
  for (const group of relationGroups) {
    if (group.relations.length > MAX_REPACK_CHASES_PER_COLLECTIBLE) return null;
    for (const relation of group.relations) {
      const chase = publicRepackChaseSchema.safeParse(relation.detail);
      const owner = chase.success
        ? catalog.repackReleaseByPublicId.get(chase.data.publicRepackId)
        : undefined;
      if (
        !chase.success ||
        relation.releaseId !== group.release._id ||
        relation.collectibleId !== group.document._id ||
        owner?._id !== group.release._id ||
        chase.data.publicCollectibleId !== collectible.detail.publicCollectibleId ||
        !sameValue(chase.data.collectible, expectedCollectibleProjection) ||
        byPublicRepackId.has(chase.data.publicRepackId)
      ) {
        return null;
      }
      byPublicRepackId.set(chase.data.publicRepackId, chase.data);
    }
  }
  return byPublicRepackId;
}

export async function searchProviderCollectibles(
  ctx: QueryCtx,
  catalog: PublicProviderCatalog,
  input: {
    readonly search: string;
    readonly collectibleTypes: readonly PublicCollectible["collectibleType"][];
    readonly candidateLimit: number;
  },
): Promise<PublicCollectible[] | null> {
  if (
    !Number.isSafeInteger(input.candidateLimit) ||
    input.candidateLimit < 1 ||
    input.candidateLimit > 100
  ) {
    return null;
  }
  // Type filters must be applied inside each release-filtered index query so
  // stronger matches of another type cannot consume the bounded candidate set.
  const groups = input.collectibleTypes.length === 0
    ? await Promise.all(
        catalog.providers.map(async ({ release }) => ({
          release,
          documents: await ctx.db
            .query("providerCatalogCollectibles")
            .withSearchIndex("search_search_text", (search) =>
              search
                .search("searchText", input.search)
                .eq("releaseId", release._id),
            )
            .take(input.candidateLimit),
        })),
      )
    : await Promise.all(
        catalog.providers.flatMap(({ release }) =>
          input.collectibleTypes.map(async (collectibleType) => ({
            release,
            documents: await ctx.db
              .query("providerCatalogCollectibles")
              .withSearchIndex("search_search_text", (search) =>
                search
                  .search("searchText", input.search)
                  .eq("releaseId", release._id)
                  .eq("collectibleType", collectibleType),
              )
              .take(input.candidateLimit),
          })),
        ),
      );
  const matches = new Map<string, PublicCollectible>();
  const seenByRelease = new Set<string>();
  for (const group of groups) {
    for (const document of group.documents) {
      const parsed = collectibleFromProviderDocument(document);
      const releaseIdentity = `${group.release._id}:${document.publicCollectibleId}`;
      if (
        parsed === null ||
        document.releaseId !== group.release._id ||
        seenByRelease.has(releaseIdentity) ||
        !collectibleReferencesAreValid(catalog, group.release._id, parsed.detail)
      ) {
        return null;
      }
      seenByRelease.add(releaseIdentity);
      const existing = matches.get(parsed.detail.publicCollectibleId);
      if (existing !== undefined && !sameValue(existing, parsed.detail)) {
        return null;
      }
      if (
        input.collectibleTypes.length === 0 ||
        input.collectibleTypes.includes(parsed.detail.collectibleType)
      ) {
        matches.set(parsed.detail.publicCollectibleId, parsed.detail);
      }
    }
  }
  return [...matches.values()];
}
