import {
  findRepacksByDesiredCollectibleInputSchema,
  getPublicRepackInputSchema,
  publicReadError,
  publicRepackViewSummaryFromDetail,
  searchPublicCollectiblesInputSchema,
  type DashboardBundle,
  type DesiredCollectibleRepackMatch,
  type FindRepacksByDesiredCollectibleInput,
  type FindRepacksByDesiredCollectibleResult,
  type GetDashboardBundleResult,
  type GetPublicRepackResult,
  type GetPublicShellStatusResult,
  type ListPublicRepacksPage,
  type ListPublicRepacksResult,
  type PublicCollectible,
  type PublicRepackChase,
  type SearchPublicCollectiblesResult,
  normalizePublicSearchText,
} from "@packscout/contracts";
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { resolvePublicCatalogPagination } from "./publicCatalogPagination";
import {
  loadActivePublicCatalogManifest,
  type ActivePublicCatalogManifest,
} from "./publicCatalogManifestReadModel";
import { attachHeatToCatalogManifestDetails } from "./publicCatalogHeatReadModel";
import {
  contextualFacets,
  dashboardKpis,
  matchingRepackRows,
  repackSummaries,
  selectionsAreKnown,
} from "./publicRepackAggregates";
import {
  loadProviderDesiredChases,
  loadProviderRepackDetail,
  loadProviderRepackDetails,
  loadSharedCollectible,
  searchProviderCollectibles,
  type PublicProviderCatalog,
  type SharedCollectible,
} from "./publicProviderCatalogReadModel";
import {
  compareRepackRows,
  createQueryFingerprint,
  encodeRepackCursor,
  parseDashboardRequest,
  parseRepackListRequest,
  rowMatchesFilters,
  type RepackSearchRow,
} from "./publicRepackValidation";

function success<T>(data: T): { readonly ok: true; readonly data: T } {
  return { ok: true, data };
}

function directArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter((entry) => entry[1] !== undefined),
  );
}

function currentTimeIsValid(currentTime: number): boolean {
  return Number.isSafeInteger(currentTime) && currentTime >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const getPublicShellStatus = query({
  args: {},
  handler: async (ctx): Promise<GetPublicShellStatusResult> => {
    const active = await loadActivePublicCatalogManifest(ctx);
    return active === null
      ? publicReadError("RELEASE_UNAVAILABLE")
      : success({ metadata: active.metadata });
  },
});

export const getDashboardBundle = query({
  args: {
    filters: v.optional(v.any()),
    selectedPublicRepackId: v.optional(v.any()),
    currentTime: v.number(),
  },
  handler: async (ctx, args): Promise<GetDashboardBundleResult> => {
    const { currentTime, ...queryArgs } = args;
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    const request = parseDashboardRequest(directArgs(queryArgs));
    if (!request.ok) return publicReadError("INVALID_QUERY");
    const active = await loadActivePublicCatalogManifest(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const allRows = active.catalog.rows;
    if (!selectionsAreKnown(
      allRows,
      request.value.filters,
      active.catalog.categoryByPublicId,
    )) {
      return publicReadError("INVALID_QUERY");
    }

    const matchingRows = matchingRepackRows(
      allRows,
      request.value.filters,
      "",
      active.catalog.categoryByPublicId,
    );
    // Opportunities are actionable buys, so they stay active-only even when the
    // caller opted into seeing sold-out repacks in the counts and summaries.
    const opportunityRows = [...matchingRows]
      .filter(
        (row) =>
          row.availability === "active" &&
          row.packScoutEvDollarsMinor !== null,
      )
      .sort((left, right) =>
        compareRepackRows(left, right, {
          search: "",
          sort: "packscout_ev_dollars",
          direction: "desc",
        }),
      )
      .slice(0, 6);
    const baseDetails = await loadProviderRepackDetails(
      ctx,
      active.catalog,
      opportunityRows,
    );
    if (baseDetails === null) return publicReadError("RELEASE_UNAVAILABLE");
    const details = await attachHeatToCatalogManifestDetails(
      ctx,
      active,
      baseDetails,
      currentTime,
    );
    const selectedRepack =
      details.find(
        (detail) =>
          detail.publicRepackId === request.value.selectedPublicRepackId,
      ) ?? details[0] ?? null;

    const data: DashboardBundle = {
      metadata: active.metadata,
      kpis: dashboardKpis(matchingRows),
      opportunities: details.map(publicRepackViewSummaryFromDetail),
      details,
      vendorSummaries: repackSummaries(matchingRows, "vendor"),
      categorySummaries: repackSummaries(matchingRows, "category"),
      facets: contextualFacets(
        allRows,
        allRows,
        request.value.filters,
        "",
        active.catalog.categoryByPublicId,
      ),
      activeFilters: request.value.filters,
      selectedRepack,
    };
    return success(data);
  },
});

export const listPublicRepacks = query({
  args: {
    search: v.optional(v.any()),
    filters: v.optional(v.any()),
    sort: v.optional(v.any()),
    direction: v.optional(v.any()),
    cursor: v.optional(v.any()),
    cursorStack: v.optional(v.any()),
    queryFingerprint: v.optional(v.any()),
    pageSize: v.optional(v.any()),
    desiredPublicCollectibleId: v.optional(v.any()),
    selectedPublicRepackId: v.optional(v.any()),
    currentTime: v.number(),
  },
  handler: async (ctx, args): Promise<ListPublicRepacksResult> => {
    const { currentTime, ...queryArgs } = args;
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    const request = parseRepackListRequest(directArgs(queryArgs));
    if (!request.ok) return publicReadError("INVALID_QUERY");
    const active = await loadActivePublicCatalogManifest(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const allRows = active.catalog.rows;
    if (!selectionsAreKnown(
      allRows,
      request.value.filters,
      active.catalog.categoryByPublicId,
    )) {
      return publicReadError("INVALID_QUERY");
    }

    let desiredCollectible: PublicCollectible | null = null;
    let desiredChases: ReadonlyMap<string, PublicRepackChase> = new Map();
    if (request.value.desiredPublicCollectibleId !== null) {
      const collectibleLookup = await loadSharedCollectible(
        ctx,
        active.catalog,
        request.value.desiredPublicCollectibleId,
      );
      if (collectibleLookup.status === "not_found") {
        return publicReadError("COLLECTIBLE_NOT_FOUND");
      }
      if (collectibleLookup.status === "invalid") {
        return publicReadError("RELEASE_UNAVAILABLE");
      }
      const collectible = collectibleLookup.collectible;
      const chases = await loadProviderDesiredChases(
        ctx,
        active.catalog,
        collectible,
      );
      if (chases === null) return publicReadError("RELEASE_UNAVAILABLE");
      desiredCollectible = collectible.detail;
      desiredChases = chases;
    }
    const eligibleRows =
      desiredCollectible === null
        ? allRows
        : allRows.filter((row) => desiredChases.has(row.publicRepackId));

    const fingerprint = await createQueryFingerprint(
      active.metadata.publicReleaseId,
      request.value,
    );
    const pagination = await resolvePublicCatalogPagination(
      ctx,
      request.value,
      active.metadata.publicReleaseId,
      fingerprint,
    );
    if (!pagination.ok) return publicReadError(pagination.code);

    const matchingRows = matchingRepackRows(
      eligibleRows,
      request.value.filters,
      request.value.search,
      active.catalog.categoryByPublicId,
    ).sort((left, right) => compareRepackRows(left, right, request.value));
    if (pagination.offset > matchingRows.length) {
      return publicReadError("INVALID_QUERY");
    }
    const pageRows = matchingRows.slice(
      pagination.offset,
      pagination.offset + request.value.pageSize,
    );
    const baseDetails = await loadProviderRepackDetails(
      ctx,
      active.catalog,
      pageRows,
    );
    if (baseDetails === null) return publicReadError("RELEASE_UNAVAILABLE");
    const details = await attachHeatToCatalogManifestDetails(
      ctx,
      active,
      baseDetails,
      currentTime,
    );
    const selectedRepack =
      details.find(
        (detail) =>
          detail.publicRepackId === request.value.selectedPublicRepackId,
      ) ?? details[0] ?? null;
    const pageEnd = pagination.offset + pageRows.length;
    const nextCursor =
      pageEnd < matchingRows.length
        ? encodeRepackCursor({
            version: 2,
            publicReleaseId: active.metadata.publicReleaseId,
            queryFingerprint: fingerprint,
            offset: pageEnd,
          })
        : null;

    const data: ListPublicRepacksPage = {
      metadata: active.metadata,
      rows: details.map(publicRepackViewSummaryFromDetail),
      details,
      selectedRepack,
      selectedRepackEligible: selectedRepack !== null,
      desiredCollectible,
      desiredChaseMatches:
        desiredCollectible === null
          ? []
          : pageRows.map((row) => ({
              publicRepackId: row.publicRepackId,
              chase: desiredChases.get(row.publicRepackId)!,
            })),
      facets: contextualFacets(
        allRows,
        eligibleRows,
        request.value.filters,
        request.value.search,
        active.catalog.categoryByPublicId,
      ),
      activeQuery: {
        search: request.value.search,
        filters: request.value.filters,
        sort: request.value.sort,
        direction: request.value.direction,
        pageSize: request.value.pageSize,
        desiredPublicCollectibleId:
          request.value.desiredPublicCollectibleId,
      },
      queryFingerprint: fingerprint,
      nextCursor,
      hasPrevious: pagination.offset > 0,
      range:
        matchingRows.length === 0
          ? { start: 0, end: 0, total: 0 }
          : {
              start: pagination.offset + 1,
              end: pageEnd,
              total: matchingRows.length,
            },
      paginationReset: pagination.paginationReset,
    };
    return success(data);
  },
});

export const getPublicRepack = query({
  args: {
    publicRepackId: v.any(),
    publicReleaseId: v.any(),
    currentTime: v.number(),
  },
  handler: async (ctx, args): Promise<GetPublicRepackResult> => {
    const { currentTime, ...queryArgs } = args;
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    const request = getPublicRepackInputSchema.safeParse(queryArgs);
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadActivePublicCatalogManifest(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    if (request.data.publicReleaseId !== active.metadata.publicReleaseId) {
      return publicReadError("REPACK_NOT_FOUND");
    }
    if (
      !active.catalog.repackReleaseByPublicId.has(
        request.data.publicRepackId,
      )
    ) {
      return publicReadError("REPACK_NOT_FOUND");
    }
    const detail = await loadProviderRepackDetail(
      ctx,
      active.catalog,
      request.data.publicRepackId,
    );
    if (detail === null) return publicReadError("RELEASE_UNAVAILABLE");
    const [view] = await attachHeatToCatalogManifestDetails(
      ctx,
      active,
      [detail],
      currentTime,
    );
    return success(view!);
  },
});

export const searchPublicCollectibles = query({
  args: {
    search: v.any(),
    collectibleTypes: v.optional(v.any()),
    limit: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<SearchPublicCollectiblesResult> => {
    const request = searchPublicCollectiblesInputSchema.safeParse(
      directArgs(args),
    );
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadActivePublicCatalogManifest(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const candidateLimit = Math.min(100, request.data.limit * 10);
    const matches = await searchProviderCollectibles(ctx, active.catalog, {
      search: request.data.search,
      collectibleTypes: request.data.collectibleTypes,
      candidateLimit,
    });
    if (matches === null) return publicReadError("RELEASE_UNAVAILABLE");
    const search = normalizePublicSearchText(request.data.search);
    const rank = (collectible: PublicCollectible) =>
      collectible.normalizedName === search
        ? 0
        : collectible.normalizedAliases.includes(search)
          ? 1
          : collectible.normalizedName.startsWith(`${search} `)
            ? 2
            : 3;
    matches.sort(
      (left, right) =>
        rank(left) - rank(right) ||
        compareText(left.normalizedName, right.normalizedName) ||
        compareText(left.publicCollectibleId, right.publicCollectibleId),
    );
    return success({
      metadata: active.metadata,
      matches: matches.slice(0, request.data.limit),
    });
  },
});

function desiredMatchMetric(
  row: RepackSearchRow,
  chase: PublicRepackChase,
  sort: FindRepacksByDesiredCollectibleInput["sort"],
): number | null {
  if (sort === "match_confidence") {
    return chase.matchConfidence.scoreBasisPoints;
  }
  if (sort === "repack_price") {
    return row.priceMinor;
  }
  return row.packScoutEvPercentBasisPoints;
}

function compareDesiredRows(
  left: RepackSearchRow,
  right: RepackSearchRow,
  desiredChases: ReadonlyMap<string, PublicRepackChase>,
  input: Pick<FindRepacksByDesiredCollectibleInput, "sort" | "direction">,
): number {
  const leftChase = desiredChases.get(left.publicRepackId)!;
  const rightChase = desiredChases.get(right.publicRepackId)!;
  const leftValue = desiredMatchMetric(left, leftChase, input.sort);
  const rightValue = desiredMatchMetric(right, rightChase, input.sort);
  if (leftValue === null && rightValue !== null) return 1;
  if (leftValue !== null && rightValue === null) return -1;
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    return input.direction === "asc"
      ? leftValue - rightValue
      : rightValue - leftValue;
  }
  return compareText(left.publicRepackId, right.publicRepackId);
}

async function desiredCollectibleMatches(
  ctx: QueryCtx,
  collectible: SharedCollectible,
  active: ActivePublicCatalogManifest,
  rows: readonly RepackSearchRow[],
  input: FindRepacksByDesiredCollectibleInput,
  currentTime: number,
): Promise<{
  readonly matches: DesiredCollectibleRepackMatch[];
  readonly total: number;
} | null> {
  const desiredChases = await loadProviderDesiredChases(
    ctx,
    active.catalog,
    collectible,
  );
  if (desiredChases === null) return null;
  const matchingRows = rows.filter(
    (row) =>
      desiredChases.has(row.publicRepackId) &&
      rowMatchesFilters(row, input.filters, {
        categoryHierarchy: active.catalog.categoryByPublicId,
      }),
  ).sort((left, right) =>
    compareDesiredRows(left, right, desiredChases, input)
  );
  const visibleRows = matchingRows.slice(0, input.limit);
  const baseDetails = await loadProviderRepackDetails(
    ctx,
    active.catalog,
    visibleRows,
  );
  if (baseDetails === null) return null;
  const details = await attachHeatToCatalogManifestDetails(
      ctx,
      active,
      baseDetails,
      currentTime,
  );
  return {
    matches: details.map((detail) => ({
      repack: publicRepackViewSummaryFromDetail(detail),
      chase: desiredChases.get(detail.publicRepackId)!,
    })),
    total: matchingRows.length,
  };
}

export const findRepacksByDesiredCollectible = query({
  args: {
    publicCollectibleId: v.any(),
    filters: v.optional(v.any()),
    sort: v.optional(v.any()),
    direction: v.optional(v.any()),
    limit: v.optional(v.any()),
    currentTime: v.number(),
  },
  handler: async (ctx, args): Promise<FindRepacksByDesiredCollectibleResult> => {
    const { currentTime, ...queryArgs } = args;
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    const request = findRepacksByDesiredCollectibleInputSchema.safeParse(
      directArgs(queryArgs),
    );
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadActivePublicCatalogManifest(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const collectibleLookup = await loadSharedCollectible(
      ctx,
      active.catalog,
      request.data.publicCollectibleId,
    );
    if (collectibleLookup.status === "not_found") {
      return publicReadError("COLLECTIBLE_NOT_FOUND");
    }
    if (collectibleLookup.status === "invalid") {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    const collectible = collectibleLookup.collectible;
    const rows = active.catalog.rows;
    if (!selectionsAreKnown(
      rows,
      request.data.filters,
      active.catalog.categoryByPublicId,
    )) {
      return publicReadError("INVALID_QUERY");
    }
    const matchResult = await desiredCollectibleMatches(
      ctx,
      collectible,
      active,
      rows,
      request.data,
      currentTime,
    );
    if (matchResult === null) return publicReadError("RELEASE_UNAVAILABLE");
    return success({
      metadata: active.metadata,
      desiredCollectible: collectible.detail,
      matches: matchResult.matches,
      total: matchResult.total,
    });
  },
});
