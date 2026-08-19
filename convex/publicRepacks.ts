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
  type ListPublicRepacksInput,
  type ListPublicRepacksPage,
  type ListPublicRepacksResult,
  type PublicCollectible,
  type PublicRepackChase,
  type SearchPublicCollectiblesResult,
  normalizePublicSearchText,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import {
  contextualFacets,
  dashboardKpis,
  matchingRepackRows,
  repackSummaries,
  selectionsAreKnown,
} from "./publicRepackAggregates";
import {
  loadCollectible,
  collectibleFromDocument,
  loadDesiredChases,
  loadReadableDataRelease,
  loadRepackDetail,
  loadRepackDetails,
  loadRepackSearchRows,
  loadCategoryHierarchy,
  oneReleaseByPublicId,
} from "./publicRepackReadModel";
import { attachHeatToRepackDetails } from "./repackHeatReadModel";
import {
  compareRepackRows,
  createQueryFingerprint,
  decodeRepackCursor,
  encodeRepackCursor,
  parseDashboardRequest,
  parseRepackListRequest,
  rowMatchesFilters,
  validateCursorSet,
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

export const getPublicShellStatus = query({
  args: {},
  handler: async (ctx): Promise<GetPublicShellStatusResult> => {
    const active = await loadReadableDataRelease(ctx);
    return active === null
      ? publicReadError("RELEASE_UNAVAILABLE")
      : success({ metadata: active.metadata });
  },
});

export const getDashboardBundle = query({
  args: {
    filters: v.optional(v.any()),
    selectedPublicRepackId: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<GetDashboardBundleResult> => {
    const request = parseDashboardRequest(directArgs(args));
    if (!request.ok) return publicReadError("INVALID_QUERY");
    const active = await loadReadableDataRelease(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const allRows = await loadRepackSearchRows(ctx, active.release);
    if (allRows === null) return publicReadError("RELEASE_UNAVAILABLE");
    const categoryHierarchy = await loadCategoryHierarchy(ctx, active.release._id);
    if (categoryHierarchy === null) return publicReadError("RELEASE_UNAVAILABLE");
    if (!selectionsAreKnown(allRows, request.value.filters)) {
      return publicReadError("INVALID_QUERY");
    }

    const matchingRows = matchingRepackRows(
      allRows,
      request.value.filters,
      "",
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
    const baseDetails = await loadRepackDetails(
      ctx,
      active.release._id,
      opportunityRows,
    );
    if (baseDetails === null) return publicReadError("RELEASE_UNAVAILABLE");
    const details = await attachHeatToRepackDetails(
      ctx,
      active.release,
      baseDetails,
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
        categoryHierarchy,
      ),
      activeFilters: request.value.filters,
      selectedRepack,
    };
    return success(data);
  },
});

type PaginationResolution =
  | { readonly ok: false; readonly code: "INVALID_QUERY" | "CURSOR_EXPIRED" }
  | {
      readonly ok: true;
      readonly offset: number;
      readonly paginationReset: "release_changed" | null;
    };

async function resolvePagination(
  ctx: QueryCtx,
  input: ListPublicRepacksInput,
  activePublicReleaseId: string,
  activeFingerprint: string,
): Promise<PaginationResolution> {
  if (input.cursor === null) {
    const stack = validateCursorSet({
      cursor: null,
      cursorStack: input.cursorStack,
      expectedFingerprint: activeFingerprint,
      expectedReleaseId: activePublicReleaseId,
      pageSize: input.pageSize,
    });
    if (!stack.ok || stack.value.stack.length > 0) {
      return { ok: false, code: "INVALID_QUERY" };
    }
    return {
      ok: true,
      offset: 0,
      paginationReset:
        input.queryFingerprint !== null &&
        input.queryFingerprint !== activeFingerprint
          ? "release_changed"
          : null,
    };
  }

  const cursor = decodeRepackCursor(input.cursor);
  if (cursor === null || input.queryFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  const expectedFingerprint = await createQueryFingerprint(
    cursor.publicReleaseId,
    input,
  );
  if (expectedFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  const cursorSet = validateCursorSet({
    cursor: input.cursor,
    cursorStack: input.cursorStack,
    expectedFingerprint,
    expectedReleaseId: cursor.publicReleaseId,
    pageSize: input.pageSize,
  });
  if (!cursorSet.ok) return { ok: false, code: "INVALID_QUERY" };
  if (cursor.publicReleaseId === activePublicReleaseId) {
    return { ok: true, offset: cursor.offset, paginationReset: null };
  }
  const retained = await oneReleaseByPublicId(ctx, cursor.publicReleaseId);
  return retained === null || retained.lifecycle !== "complete"
    ? { ok: false, code: "CURSOR_EXPIRED" }
    : { ok: true, offset: 0, paginationReset: "release_changed" };
}

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
  },
  handler: async (ctx, args): Promise<ListPublicRepacksResult> => {
    const request = parseRepackListRequest(directArgs(args));
    if (!request.ok) return publicReadError("INVALID_QUERY");
    const active = await loadReadableDataRelease(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const allRows = await loadRepackSearchRows(ctx, active.release);
    if (allRows === null) return publicReadError("RELEASE_UNAVAILABLE");
    const categoryHierarchy = await loadCategoryHierarchy(ctx, active.release._id);
    if (categoryHierarchy === null) return publicReadError("RELEASE_UNAVAILABLE");
    if (!selectionsAreKnown(allRows, request.value.filters)) {
      return publicReadError("INVALID_QUERY");
    }

    let desiredCollectible: PublicCollectible | null = null;
    let desiredChases: ReadonlyMap<string, PublicRepackChase> = new Map();
    if (request.value.desiredPublicCollectibleId !== null) {
      const collectible = await loadCollectible(
        ctx,
        active.release._id,
        request.value.desiredPublicCollectibleId,
      );
      if (collectible === null) {
        return publicReadError("COLLECTIBLE_NOT_FOUND");
      }
      const chases = await loadDesiredChases(
        ctx,
        active.release._id,
        collectible,
        new Set(allRows.map(({ publicRepackId }) => publicRepackId)),
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
      active.release.publicReleaseId,
      request.value,
    );
    const pagination = await resolvePagination(
      ctx,
      request.value,
      active.release.publicReleaseId,
      fingerprint,
    );
    if (!pagination.ok) return publicReadError(pagination.code);

    const matchingRows = matchingRepackRows(
      eligibleRows,
      request.value.filters,
      request.value.search,
    ).sort((left, right) => compareRepackRows(left, right, request.value));
    if (pagination.offset > matchingRows.length) {
      return publicReadError("INVALID_QUERY");
    }
    const pageRows = matchingRows.slice(
      pagination.offset,
      pagination.offset + request.value.pageSize,
    );
    const baseDetails = await loadRepackDetails(
      ctx,
      active.release._id,
      pageRows,
    );
    if (baseDetails === null) return publicReadError("RELEASE_UNAVAILABLE");
    const details = await attachHeatToRepackDetails(
      ctx,
      active.release,
      baseDetails,
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
            publicReleaseId: active.release.publicReleaseId,
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
        categoryHierarchy,
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
  },
  handler: async (ctx, args): Promise<GetPublicRepackResult> => {
    const request = getPublicRepackInputSchema.safeParse(args);
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadReadableDataRelease(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    if (request.data.publicReleaseId !== active.release.publicReleaseId) {
      return publicReadError("REPACK_NOT_FOUND");
    }
    const detail = await loadRepackDetail(
      ctx,
      active.release._id,
      request.data.publicRepackId,
    );
    if (detail === null) return publicReadError("REPACK_NOT_FOUND");
    const [view] = await attachHeatToRepackDetails(
      ctx,
      active.release,
      [detail],
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
    const active = await loadReadableDataRelease(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const candidateLimit = Math.min(100, request.data.limit * 10);
    const documentGroups = request.data.collectibleTypes.length === 0
      ? [
          await ctx.db
            .query("collectibles")
            .withSearchIndex("search_search_text", (search) =>
              search
                .search("searchText", request.data.search)
                .eq("releaseId", active.release._id),
            )
            .take(candidateLimit),
        ]
      : await Promise.all(
          request.data.collectibleTypes.map((collectibleType) =>
            ctx.db
              .query("collectibles")
              .withSearchIndex("search_search_text", (search) =>
                search
                  .search("searchText", request.data.search)
                  .eq("releaseId", active.release._id)
                  .eq("collectibleType", collectibleType),
              )
              .take(candidateLimit)
          ),
        );
    const documents = [
      ...new Map(
        documentGroups.flat().map((document) => [document._id, document]),
      ).values(),
    ];
    const matches: PublicCollectible[] = [];
    for (const document of documents) {
      const parsed = collectibleFromDocument(document);
      if (parsed === null) return publicReadError("RELEASE_UNAVAILABLE");
      if (
        request.data.collectibleTypes.length === 0 ||
        request.data.collectibleTypes.includes(parsed.detail.collectibleType)
      ) {
        matches.push(parsed.detail);
      }
    }
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
        left.normalizedName.localeCompare(right.normalizedName) ||
        left.publicCollectibleId.localeCompare(right.publicCollectibleId),
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
  return left.publicRepackId.localeCompare(right.publicRepackId);
}

async function desiredCollectibleMatches(
  ctx: QueryCtx,
  collectible: Awaited<ReturnType<typeof loadCollectible>> & {},
  release: Doc<"dataReleases">,
  rows: readonly RepackSearchRow[],
  input: FindRepacksByDesiredCollectibleInput,
): Promise<{
  readonly matches: DesiredCollectibleRepackMatch[];
  readonly total: number;
} | null> {
  const rowByPublicId = new Map(rows.map((row) => [row.publicRepackId, row]));
  const desiredChases = await loadDesiredChases(
    ctx,
    release._id,
    collectible,
    new Set(rowByPublicId.keys()),
  );
  if (desiredChases === null) return null;
  const matchingRows = rows.filter(
    (row) =>
      desiredChases.has(row.publicRepackId) &&
      rowMatchesFilters(row, input.filters),
  ).sort((left, right) =>
    compareDesiredRows(left, right, desiredChases, input)
  );
  const visibleRows = matchingRows.slice(0, input.limit);
  const baseDetails = await loadRepackDetails(ctx, release._id, visibleRows);
  if (baseDetails === null) return null;
  const details = await attachHeatToRepackDetails(ctx, release, baseDetails);
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
  },
  handler: async (ctx, args): Promise<FindRepacksByDesiredCollectibleResult> => {
    const request = findRepacksByDesiredCollectibleInputSchema.safeParse(
      directArgs(args),
    );
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadReadableDataRelease(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const [collectible, rows] = await Promise.all([
      loadCollectible(
        ctx,
        active.release._id,
        request.data.publicCollectibleId,
      ),
      loadRepackSearchRows(ctx, active.release),
    ]);
    if (collectible === null) return publicReadError("COLLECTIBLE_NOT_FOUND");
    if (rows === null) return publicReadError("RELEASE_UNAVAILABLE");
    if (!selectionsAreKnown(rows, request.data.filters)) {
      return publicReadError("INVALID_QUERY");
    }
    const matchResult = await desiredCollectibleMatches(
      ctx,
      collectible,
      active.release,
      rows,
      request.data,
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
