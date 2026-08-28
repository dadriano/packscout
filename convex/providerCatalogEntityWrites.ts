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
import { refuseProviderRelease } from "./providerReleaseErrors";

export type ProviderCatalogWriteResult = Readonly<{
  unresolvedRepackDelta: number;
  latestEvidenceAt: string | null;
}>;

export type ProviderCatalogTimeline = Readonly<{
  lastSuccessfulObservationAt: string;
  checkpointSettledAt: string;
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
  releaseId: Id<"providerCatalogReleases">,
  publicCategoryId: string,
): Promise<Doc<"providerCatalogCategories"> | null> {
  const categories = await ctx.db
    .query("providerCatalogCategories")
    .withIndex("by_release_id_and_public_category_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicCategoryId", publicCategoryId),
    )
    .take(2);
  if (categories.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return categories[0] ?? null;
}

async function oneVendor(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  publicVendorId: string,
): Promise<Doc<"providerCatalogVendors"> | null> {
  const vendors = await ctx.db
    .query("providerCatalogVendors")
    .withIndex("by_release_id_and_public_vendor_id", (index) =>
      index.eq("releaseId", releaseId).eq("publicVendorId", publicVendorId),
    )
    .take(2);
  if (vendors.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  return vendors[0] ?? null;
}

export async function writeProviderVendors(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  records: readonly PublicVendor[],
  approvedOrigins: ReadonlySet<string>,
): Promise<ProviderCatalogWriteResult> {
  for (const detail of records) {
    const [byId, byKey] = await Promise.all([
      oneVendor(ctx, releaseId, detail.publicVendorId),
      ctx.db
        .query("providerCatalogVendors")
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
      refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
    }
    await ctx.db.insert("providerCatalogVendors", {
      releaseId,
      publicVendorId: detail.publicVendorId,
      vendorKey: detail.vendorKey,
      detail,
    });
  }
  return { unresolvedRepackDelta: 0, latestEvidenceAt: null };
}

export async function writeProviderCategories(
  ctx: MutationCtx,
  releaseId: Id<"providerCatalogReleases">,
  records: readonly PublicCategory[],
): Promise<ProviderCatalogWriteResult> {
  for (const detail of records) {
    const [byId, byKey] = await Promise.all([
      oneCategory(ctx, releaseId, detail.publicCategoryId),
      ctx.db
        .query("providerCatalogCategories")
        .withIndex("by_release_id_and_category_key", (index) =>
          index
            .eq("releaseId", releaseId)
            .eq("categoryKey", detail.categoryKey),
        )
        .take(2),
    ]);
    if (byId !== null || byKey.length !== 0) {
      refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
    }
    const parent =
      detail.parentPublicCategoryId === null
        ? null
        : await oneCategory(ctx, releaseId, detail.parentPublicCategoryId);
    const expectedPath =
      parent === null
        ? [detail.publicCategoryId]
        : [...parent.detail.pathPublicCategoryIds, detail.publicCategoryId];
    if (
      (detail.parentPublicCategoryId === null) !== (parent === null) ||
      canonicalJson(detail.pathPublicCategoryIds) !==
        canonicalJson(expectedPath)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_REFERENCE_INVALID");
    }
    await ctx.db.insert("providerCatalogCategories", {
      releaseId,
      publicCategoryId: detail.publicCategoryId,
      categoryKey: detail.categoryKey,
      parentCategoryId: parent?._id ?? null,
      detail,
    });
  }
  return { unresolvedRepackDelta: 0, latestEvidenceAt: null };
}

export async function writeProviderCollectibles(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
  records: readonly PublicCollectible[],
  approvedOrigins: ReadonlySet<string>,
): Promise<ProviderCatalogWriteResult> {
  let latestEvidenceAt: string | null = null;
  for (const detail of records) {
    const matches = await ctx.db
      .query("providerCatalogCollectibles")
      .withIndex("by_release_id_and_public_collectible_id", (index) =>
        index
          .eq("releaseId", release._id)
          .eq("publicCollectibleId", detail.publicCollectibleId),
      )
      .take(2);
    if (matches.length !== 0) {
      refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
    }
    for (const categoryId of detail.publicCategoryIds) {
      if ((await oneCategory(ctx, release._id, categoryId)) === null) {
        refuseProviderRelease("PROVIDER_RELEASE_REFERENCE_INVALID");
      }
    }
    const valuationObservedAt = detail.valuation?.observedAt ?? null;
    if (
      (detail.primaryImage !== null &&
        !approvedOrigins.has(
          parsedHttpsUrl(detail.primaryImage.url)?.origin ?? "",
        )) ||
      Date.parse(detail.dataAsOf) > Date.parse(release.dataAsOf) ||
      (valuationObservedAt !== null &&
        (Date.parse(valuationObservedAt) > Date.parse(detail.dataAsOf) ||
          Date.parse(valuationObservedAt) > Date.parse(release.dataAsOf)))
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
    }
    const collectibleId = await ctx.db.insert("providerCatalogCollectibles", {
      releaseId: release._id,
      publicCollectibleId: detail.publicCollectibleId,
      collectibleType: detail.collectibleType,
      normalizedName: detail.normalizedName,
      searchText: detail.searchText,
      detail,
    });
    await ctx.db.insert("providerCatalogCollectibleReconciliation", {
      releaseId: release._id,
      collectibleId,
      publicCollectibleId: detail.publicCollectibleId,
      chaseCount: 0,
    });
    latestEvidenceAt = maximumTimestamp([
      latestEvidenceAt,
      detail.dataAsOf,
      valuationObservedAt,
    ]);
  }
  return { unresolvedRepackDelta: 0, latestEvidenceAt };
}

function independentBranchCount(
  categories: readonly Doc<"providerCatalogCategories">[],
): number {
  const byId = new Map(
    categories.map((category) => [category.publicCategoryId, category.detail]),
  );
  return categories.filter(
    (candidate) =>
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
  release: Doc<"providerCatalogReleases">,
  timeline: ProviderCatalogTimeline,
): boolean {
  const releaseDataAsOf = Date.parse(release.dataAsOf);
  const vendorObservedAt = detail.evEstimates.vendorReported.observedAt;
  const packScout = detail.evEstimates.packScout;
  return (
    Date.parse(detail.sourceUpdatedAt) <= releaseDataAsOf &&
    (vendorObservedAt === null ||
      (Date.parse(vendorObservedAt) <= releaseDataAsOf &&
        Date.parse(vendorObservedAt) <=
          Date.parse(timeline.lastSuccessfulObservationAt))) &&
    !(packScout.status === "available" && packScout.calculatedAt === null) &&
    (packScout.dataAsOf === null ||
      Date.parse(packScout.dataAsOf) <= releaseDataAsOf) &&
    (packScout.calculatedAt === null ||
      (Date.parse(packScout.calculatedAt) <=
          Date.parse(timeline.checkpointSettledAt) &&
        (packScout.dataAsOf === null ||
          Date.parse(packScout.calculatedAt) >=
            Date.parse(packScout.dataAsOf))))
  );
}

export async function writeProviderRepacks(
  ctx: MutationCtx,
  release: Doc<"providerCatalogReleases">,
  records: readonly PublicRepackDetail[],
  timeline: ProviderCatalogTimeline,
): Promise<ProviderCatalogWriteResult> {
  let unresolvedRepackDelta = 0;
  let latestEvidenceAt: string | null = null;
  for (const detail of records) {
    const existing = await ctx.db
      .query("providerCatalogRepacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index
          .eq("releaseId", release._id)
          .eq("publicRepackId", detail.publicRepackId),
      )
      .take(2);
    const vendor = await oneVendor(ctx, release._id, detail.publicVendorId);
    const categories: Doc<"providerCatalogCategories">[] = [];
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
        refuseProviderRelease("PROVIDER_RELEASE_REFERENCE_INVALID");
      }
      categories.push(category);
    }
    const categoryIds = new Set(
      categories.map(({ publicCategoryId }) => publicCategoryId),
    );
    const branchCount = independentBranchCount(categories);
    const expectedMode =
      branchCount > 1 || detail.collectibleTypes.length > 1
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
        canonicalJson(
          detail.availability === "available"
            ? vendor.detail.publicPromo
            : null,
        ) ||
      (detail.actions.repackLink !== undefined &&
        (!vendor.detail.listingHosts.includes(
          detail.actions.repackLink.listingHost,
        ) ||
          canonicalJson(detail.actions.repackLink.referralParameters) !==
            canonicalJson(vendor.detail.referralParameters))) ||
      !repackTimelineIsValid(detail, release, timeline) ||
      (detail.contentSummary.chaseCount === 0) !== (detail.topChase === null)
    ) {
      refuseProviderRelease("PROVIDER_RELEASE_ENTITY_INVALID");
    }
    const repackId = await ctx.db.insert("providerCatalogRepacks", {
      releaseId: release._id,
      publicRepackId: detail.publicRepackId,
      vendorId: vendor._id,
      detail,
    });
    const complete = detail.contentSummary.chaseCount === 0;
    await ctx.db.insert("providerCatalogRepackReconciliation", {
      releaseId: release._id,
      repackId,
      publicRepackId: detail.publicRepackId,
      expectedChaseCount: detail.contentSummary.chaseCount,
      acceptedChaseCount: 0,
      expectedTopChaseJson:
        detail.topChase === null ? null : canonicalJson(detail.topChase),
      bestChaseJson: null,
      acceptedTopChaseCount: 0,
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
