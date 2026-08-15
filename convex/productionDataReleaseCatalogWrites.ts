import {
  parsedHttpsUrl,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import { refuseProductionDataRelease } from "./productionDataReleaseErrors";

export type CatalogWriteResult = Readonly<{
  unresolvedRepackDelta: number;
  latestEvidenceAt: string | null;
}>;

function maximumTimestamp(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null);
  return present.length === 0
    ? null
    : present.reduce((latest, value) =>
        Date.parse(value) > Date.parse(latest) ? value : latest,
      );
}

async function oneCategory(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  publicCategoryId: string,
): Promise<Doc<"categories"> | null> {
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
  return categories[0] ?? null;
}

async function oneVendor(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  publicVendorId: string,
): Promise<Doc<"vendors"> | null> {
  const vendors = await ctx.db
    .query("vendors")
    .withIndex("by_release_id_and_public_vendor_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicVendorId", publicVendorId),
    )
    .take(2);
  if (vendors.length > 1) {
    refuseProductionDataRelease("PUBLICATION_STATE_CONFLICT");
  }
  return vendors[0] ?? null;
}

export async function writeVendors(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  records: readonly PublicVendor[],
  approvedOrigins: ReadonlySet<string>,
): Promise<CatalogWriteResult> {
  for (const detail of records) {
    const [byId, byKey] = await Promise.all([
      oneVendor(ctx, releaseId, detail.publicVendorId),
      ctx.db
        .query("vendors")
        .withIndex("by_release_id_and_vendor_key", (index) =>
          index.eq("releaseId", releaseId).eq("vendorKey", detail.vendorKey),
        )
        .take(2),
    ]);
    if (
      byId !== null ||
      byKey.length !== 0 ||
      detail.imageOrigins.some((origin) => !approvedOrigins.has(origin))
    ) {
      refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
    }
    await ctx.db.insert("vendors", {
      releaseId,
      publicVendorId: detail.publicVendorId,
      vendorKey: detail.vendorKey,
      detail,
    });
  }
  return { unresolvedRepackDelta: 0, latestEvidenceAt: null };
}

export async function writeCategories(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  records: readonly PublicCategory[],
): Promise<CatalogWriteResult> {
  for (const detail of records) {
    const [byId, byKey] = await Promise.all([
      oneCategory(ctx, releaseId, detail.publicCategoryId),
      ctx.db
        .query("categories")
        .withIndex("by_release_id_and_category_key", (index) =>
          index.eq("releaseId", releaseId).eq("categoryKey", detail.categoryKey),
        )
        .take(2),
    ]);
    if (byId !== null || byKey.length !== 0) {
      refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
    }
    const parent = detail.parentPublicCategoryId === null
      ? null
      : await oneCategory(ctx, releaseId, detail.parentPublicCategoryId);
    if (
      (detail.parentPublicCategoryId === null) !== (parent === null) ||
      (parent !== null &&
        canonicalJson(detail.pathPublicCategoryIds) !==
          canonicalJson([
            ...parent.detail.pathPublicCategoryIds,
            detail.publicCategoryId,
          ]))
    ) {
      refuseProductionDataRelease("PUBLICATION_REFERENCE_INVALID");
    }
    await ctx.db.insert("categories", {
      releaseId,
      publicCategoryId: detail.publicCategoryId,
      categoryKey: detail.categoryKey,
      parentCategoryId: parent?._id ?? null,
      detail,
    });
  }
  return { unresolvedRepackDelta: 0, latestEvidenceAt: null };
}

export async function writeCollectibles(
  ctx: MutationCtx,
  releaseId: Id<"dataReleases">,
  records: readonly PublicCollectible[],
  approvedOrigins: ReadonlySet<string>,
): Promise<CatalogWriteResult> {
  let latestEvidenceAt: string | null = null;
  for (const detail of records) {
    const matches = await ctx.db
      .query("collectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index
          .eq("releaseId", releaseId)
          .eq("publicCollectibleId", detail.publicCollectibleId),
      )
      .take(2);
    if (matches.length !== 0) {
      refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
    }
    for (const categoryId of detail.publicCategoryIds) {
      if ((await oneCategory(ctx, releaseId, categoryId)) === null) {
        refuseProductionDataRelease("PUBLICATION_REFERENCE_INVALID");
      }
    }
    if (
      detail.primaryImage !== null &&
      !approvedOrigins.has(
        parsedHttpsUrl(detail.primaryImage.url)?.origin ?? "",
      )
    ) {
      refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
    }
    const collectibleId = await ctx.db.insert("collectibles", {
      releaseId,
      publicCollectibleId: detail.publicCollectibleId,
      collectibleType: detail.collectibleType,
      normalizedName: detail.normalizedName,
      searchText: detail.searchText,
      detail,
    });
    await ctx.db.insert("dataReleaseCollectibleReconciliation", {
      releaseId,
      collectibleId,
      publicCollectibleId: detail.publicCollectibleId,
      chaseCount: 0,
    });
    latestEvidenceAt = maximumTimestamp([
      latestEvidenceAt,
      detail.dataAsOf,
      detail.valuation?.observedAt ?? null,
    ]);
  }
  return { unresolvedRepackDelta: 0, latestEvidenceAt };
}

function independentBranchCount(categories: readonly Doc<"categories">[]): number {
  const byId = new Map(
    categories.map((category) => [category.publicCategoryId, category.detail]),
  );
  return categories.filter((candidate) =>
    !categories.some(
      (other) =>
        other._id !== candidate._id &&
        byId
          .get(other.publicCategoryId)
          ?.pathPublicCategoryIds.includes(candidate.publicCategoryId),
    ),
  ).length;
}

function repackTimelineIsValid(
  detail: PublicRepackDetail,
  release: Doc<"dataReleases">,
): boolean {
  const vendorObservedAt = detail.evEstimates.vendorReported.observedAt;
  const packScout = detail.evEstimates.packScout;
  return (
    (vendorObservedAt === null ||
      Date.parse(vendorObservedAt) <=
        Date.parse(release.metadata.lastSuccessfulObservationAt)) &&
    packScout.confidencePolicyVersion ===
      release.metadata.confidencePolicyVersion &&
    (packScout.calculatedAt === null ||
      ((packScout.dataAsOf === null ||
        Date.parse(packScout.calculatedAt) >= Date.parse(packScout.dataAsOf)) &&
        (packScout.dataAsOf === null ||
          Date.parse(packScout.dataAsOf) <=
            Date.parse(release.metadata.dataAsOf))))
  );
}

export async function writeRepacks(
  ctx: MutationCtx,
  release: Doc<"dataReleases">,
  records: readonly PublicRepackDetail[],
): Promise<CatalogWriteResult> {
  let unresolvedRepackDelta = 0;
  let latestEvidenceAt: string | null = null;
  for (const detail of records) {
    const existing = await ctx.db
      .query("repacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index
          .eq("releaseId", release._id)
          .eq("publicRepackId", detail.publicRepackId),
      )
      .take(2);
    const vendor = await oneVendor(
      ctx,
      release._id,
      detail.publicVendorId,
    );
    const categories: Doc<"categories">[] = [];
    for (const categoryProjection of detail.categories) {
      const category = await oneCategory(
        ctx,
        release._id,
        categoryProjection.publicCategoryId,
      );
      if (
        category === null ||
        category.detail.name !== categoryProjection.label
      ) {
        refuseProductionDataRelease("PUBLICATION_REFERENCE_INVALID");
      }
      categories.push(category);
    }
    const categoryIds = new Set(
      categories.map(({ publicCategoryId }) => publicCategoryId),
    );
    const branchCount = independentBranchCount(categories);
    const expectedMode = branchCount > 1 || detail.collectibleTypes.length > 1
      ? "mixed"
      : branchCount === 1 || detail.collectibleTypes.length === 1
        ? "focused"
        : "unknown";
    if (
      existing.length !== 0 ||
      vendor === null ||
      vendor.vendorKey !== detail.vendorKey ||
      vendor.detail.displayName !== detail.vendorDisplayName ||
      vendor.detail.logoUrl !== detail.vendorLogoUrl ||
      categories.some(({ detail: category }) =>
        category.pathPublicCategoryIds.some(
          (ancestorId) => !categoryIds.has(ancestorId),
        ),
      ) ||
      detail.contentMode !== expectedMode ||
      (detail.primaryImage !== null &&
        !vendor.detail.imageOrigins.includes(
          parsedHttpsUrl(detail.primaryImage.url)?.origin ?? "",
        )) ||
      canonicalJson(detail.actions.promo ?? null) !==
        canonicalJson(vendor.detail.publicPromo) ||
      (detail.actions.repackLink !== undefined &&
        (!vendor.detail.listingHosts.includes(
          detail.actions.repackLink.listingHost,
        ) ||
          canonicalJson(detail.actions.repackLink.referralParameters) !==
            canonicalJson(vendor.detail.referralParameters))) ||
      !repackTimelineIsValid(detail, release) ||
      (detail.contentSummary.chaseCount === 0) !== (detail.topChase === null)
    ) {
      refuseProductionDataRelease("PUBLICATION_ENTITY_INVALID");
    }
    const repackId = await ctx.db.insert("repacks", {
      releaseId: release._id,
      publicRepackId: detail.publicRepackId,
      vendorId: vendor._id,
      detail,
    });
    const complete = detail.contentSummary.chaseCount === 0;
    await ctx.db.insert("dataReleaseRepackReconciliation", {
      releaseId: release._id,
      repackId,
      publicRepackId: detail.publicRepackId,
      expectedChaseCount: detail.contentSummary.chaseCount,
      acceptedChaseCount: 0,
      expectedTopChaseJson:
        detail.topChase === null ? null : canonicalJson(detail.topChase),
      bestChaseJson: null,
      complete,
    });
    if (!complete) unresolvedRepackDelta += 1;
    const packScout = detail.evEstimates.packScout;
    latestEvidenceAt = maximumTimestamp([
      latestEvidenceAt,
      detail.sourceUpdatedAt,
      detail.evEstimates.vendorReported.observedAt,
      packScout.dataAsOf,
      packScout.calculatedAt,
    ]);
  }
  return { unresolvedRepackDelta, latestEvidenceAt };
}
