import {
  getPublicPackInputSchema,
  publicPackDetailSchema,
  publicPackSummarySchema,
  publicReadError,
  snapshotMetadataSchema,
  type DashboardBundle,
  type GetDashboardBundleResult,
  type GetPublicPackResult,
  type GetPublicShellStatusResult,
  type ListPublicPacksInput,
  type ListPublicPacksPage,
  type ListPublicPacksResult,
  type PublicCatalogFilters,
  type PublicPackDetail,
  type PublicPackSummary,
  type SnapshotMetadata,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import {
  MAX_QUERY_SHARDS,
  MAX_ROWS_PER_QUERY_SHARD,
  compareCatalogRows,
  createQueryFingerprint,
  decodeCatalogCursor,
  encodeCatalogCursor,
  isValidCatalogQueryRow,
  parseCatalogRequest,
  parseDashboardRequest,
  rowMatchesFilters,
  rowMatchesSearch,
  validateCursorSet,
  type CatalogQueryRow,
} from "./publicCatalogValidation";

type ActiveCatalog = {
  readonly state: Doc<"catalogState">;
  readonly snapshot: Doc<"catalogSnapshots">;
  readonly metadata: SnapshotMetadata;
};

function success<T>(data: T): { readonly ok: true; readonly data: T } {
  return { ok: true, data };
}

async function oneSnapshotByPublicationId(
  ctx: QueryCtx,
  publicationId: string,
): Promise<Doc<"catalogSnapshots"> | null> {
  const matches = await ctx.db
    .query("catalogSnapshots")
    .withIndex("by_publication_id", (index) =>
      index.eq("publicationId", publicationId),
    )
    .take(2);
  return matches.length === 1 ? matches[0]! : null;
}

async function loadActiveCatalog(ctx: QueryCtx): Promise<ActiveCatalog | null> {
  const states = await ctx.db
    .query("catalogState")
    .withIndex("by_key", (index) => index.eq("key", "singleton"))
    .take(2);
  if (states.length !== 1 || states[0]!.activeSnapshotId === null) return null;
  const state = states[0]!;
  const activeSnapshotId = state.activeSnapshotId;
  if (activeSnapshotId === null) return null;
  const snapshot = await ctx.db.get("catalogSnapshots", activeSnapshotId);
  if (
    snapshot === null ||
    snapshot.lifecycle !== "complete" ||
    snapshot.publicationId !== snapshot.metadata.publicationId ||
    snapshot.platformConfigs.length > 64 ||
    snapshot.platformConfigs.length !== snapshot.metadata.platformConfigCount ||
    snapshot.facets.platforms.length > 64 ||
    snapshot.facets.categories.length > 64
  ) {
    return null;
  }
  const metadataResult = snapshotMetadataSchema.safeParse({
    ...snapshot.metadata,
    dataAsOf: state.dataAsOf,
    lastSuccessfulObservationAt: state.lastSuccessfulObservationAt,
    staleAt: state.staleAt,
    freshness: state.freshness,
    delayedSourceCount: state.delayedSourceCount,
  });
  return metadataResult.success
    ? { state, snapshot, metadata: metadataResult.data }
    : null;
}

async function loadQueryRows(
  ctx: QueryCtx,
  snapshot: Doc<"catalogSnapshots">,
): Promise<readonly CatalogQueryRow[] | null> {
  if (
    !Number.isSafeInteger(snapshot.shardCount) ||
    snapshot.shardCount < 0 ||
    snapshot.shardCount > MAX_QUERY_SHARDS
  ) {
    return null;
  }
  const shards = await ctx.db
    .query("catalogQueryShards")
    .withIndex("by_snapshot_id_and_shard_number", (index) =>
      index.eq("snapshotId", snapshot._id),
    )
    .order("asc")
    .take(MAX_QUERY_SHARDS + 1);
  if (shards.length !== snapshot.shardCount) return null;

  const rows: CatalogQueryRow[] = [];
  const publicPackIds = new Set<string>();
  for (const [index, shard] of shards.entries()) {
    if (
      shard.shardNumber !== index ||
      shard.rowCount !== shard.rows.length ||
      shard.rows.length > MAX_ROWS_PER_QUERY_SHARD ||
      shard.byteCount > 48 * 1_024
    ) {
      return null;
    }
    for (const row of shard.rows) {
      if (!isValidCatalogQueryRow(row) || publicPackIds.has(row.publicPackId)) {
        return null;
      }
      publicPackIds.add(row.publicPackId);
      rows.push(row);
    }
  }
  return rows.length === snapshot.metadata.packCount ? rows : null;
}

async function loadPackDetail(
  ctx: QueryCtx,
  snapshotId: Id<"catalogSnapshots">,
  publicPackId: string,
): Promise<PublicPackDetail | null> {
  const documents = await ctx.db
    .query("publicPacks")
    .withIndex("by_snapshot_id_and_public_pack_id", (index) =>
      index.eq("snapshotId", snapshotId).eq("publicPackId", publicPackId),
    )
    .take(2);
  if (documents.length !== 1) return null;
  const parsed = publicPackDetailSchema.safeParse(documents[0]!.detail);
  return parsed.success ? parsed.data : null;
}

async function loadPackDetails(
  ctx: QueryCtx,
  snapshotId: Id<"catalogSnapshots">,
  rows: readonly CatalogQueryRow[],
): Promise<readonly PublicPackDetail[] | null> {
  const details: PublicPackDetail[] = [];
  for (const row of rows) {
    const detail = await loadPackDetail(ctx, snapshotId, row.publicPackId);
    if (detail === null) return null;
    details.push(detail);
  }
  return details;
}

function packSummary(detail: PublicPackDetail): PublicPackSummary {
  const {
    description: _description,
    actions: _actions,
    topChase,
    estimatedEv,
    ...base
  } = detail;
  const {
    coverage: _coverage,
    limitations: _limitations,
    ...estimatedEvSummary
  } = estimatedEv;
  const summaryTopChase =
    topChase.status === "unavailable"
      ? topChase
      : {
          ...topChase,
          value: {
            publicChaseId: topChase.value.publicChaseId,
            name: topChase.value.name,
            displayMoney: topChase.value.displayMoney,
            usdComparison: topChase.value.usdComparison,
            primaryImage: topChase.value.primaryImage,
          },
        };
  return publicPackSummarySchema.parse({
    ...base,
    estimatedEv: estimatedEvSummary,
    topChase: summaryTopChase,
  });
}

function selectionsAreKnown(
  rows: readonly CatalogQueryRow[],
  filters: PublicCatalogFilters,
): boolean {
  const platforms = new Set(rows.map((row) => row.platformKey));
  const categories = new Set(rows.map((row) => row.categoryKey));
  return (
    filters.platforms.every((key) => platforms.has(key)) &&
    filters.categories.every((key) => categories.has(key))
  );
}

function filteredRows(
  rows: readonly CatalogQueryRow[],
  filters: PublicCatalogFilters,
  search: string,
): CatalogQueryRow[] {
  return rows.filter(
    (row) => rowMatchesSearch(row, search) && rowMatchesFilters(row, filters),
  );
}

function contextualFacets(
  universeRows: readonly CatalogQueryRow[],
  countableRows: readonly CatalogQueryRow[],
  filters: PublicCatalogFilters,
  search: string,
): DashboardBundle["facets"] {
  const platformLabels = new Map<string, string>();
  const categoryLabels = new Map<string, string>();
  for (const row of universeRows) {
    platformLabels.set(row.platformKey, row.platformDisplayName);
    categoryLabels.set(row.categoryKey, row.category);
  }
  const searched = countableRows.filter((row) => rowMatchesSearch(row, search));
  const platformCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  for (const row of searched) {
    if (rowMatchesFilters(row, filters, { ignorePlatforms: true })) {
      platformCounts.set(
        row.platformKey,
        (platformCounts.get(row.platformKey) ?? 0) + 1,
      );
    }
    if (rowMatchesFilters(row, filters, { ignoreCategories: true })) {
      categoryCounts.set(
        row.categoryKey,
        (categoryCounts.get(row.categoryKey) ?? 0) + 1,
      );
    }
  }
  return {
    platforms: [...platformLabels]
      .map(([key, label]) => ({
        key,
        label,
        packCount: platformCounts.get(key) ?? 0,
        selected: filters.platforms.includes(key),
      }))
      .filter((option) => option.packCount > 0 || option.selected)
      .sort((left, right) => left.key.localeCompare(right.key)),
    categories: [...categoryLabels]
      .map(([key, label]) => ({
        key,
        label,
        packCount: categoryCounts.get(key) ?? 0,
        selected: filters.categories.includes(key),
      }))
      .filter((option) => option.packCount > 0 || option.selected)
      .sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function medianBasisPoints(rows: readonly CatalogQueryRow[]) {
  const values = rows
    .flatMap((row) =>
      row.evPercentBasisPoints === null ? [] : [row.evPercentBasisPoints],
    )
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return {
      status: "unavailable" as const,
      value: null,
      reason: "ESTIMATE_INPUT_INCOMPLETE" as const,
      nullRank: 1 as const,
    };
  }
  const middle = Math.floor(values.length / 2);
  const value =
    values.length % 2 === 1
      ? values[middle]!
      : Math.round((values[middle - 1]! + values[middle]!) / 2);
  return {
    status: "available" as const,
    value: { basisPoints: value },
    reason: null,
    nullRank: 0 as const,
  };
}

function highestChase(rows: readonly CatalogQueryRow[]) {
  const values = rows.flatMap((row) =>
    row.topChaseValueMinor === null ? [] : [row.topChaseValueMinor],
  );
  if (values.length === 0) {
    const reason = rows.some(
      (row) => row.topChaseReason === "CURRENCY_UNSUPPORTED",
    )
      ? ("CURRENCY_UNSUPPORTED" as const)
      : ("CHASE_UNAVAILABLE" as const);
    return {
      status: "unavailable" as const,
      value: null,
      reason,
      nullRank: 1 as const,
    };
  }
  return {
    status: "available" as const,
    value: { minorUnits: Math.max(...values), currency: "USD" as const },
    reason: null,
    nullRank: 0 as const,
  };
}

function catalogSummaries(
  rows: readonly CatalogQueryRow[],
  key: "platform" | "category",
): DashboardBundle["platformSummaries"] {
  const groups = new Map<
    string,
    { readonly label: string; readonly rows: CatalogQueryRow[] }
  >();
  for (const row of rows) {
    const groupKey = key === "platform" ? row.platformKey : row.categoryKey;
    const label = key === "platform" ? row.platformDisplayName : row.category;
    const group = groups.get(groupKey);
    if (group) group.rows.push(row);
    else groups.set(groupKey, { label, rows: [row] });
  }
  return [...groups]
    .map(([groupKey, group]) => ({
      key: groupKey,
      label: group.label,
      packCount: group.rows.length,
      medianEvPercent: medianBasisPoints(group.rows),
    }))
    .sort(
      (left, right) =>
        right.packCount - left.packCount || left.key.localeCompare(right.key),
    )
    .slice(0, 5);
}

function directArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter((entry) => entry[1] !== undefined),
  );
}

export const getPublicShellStatus = query({
  args: {},
  handler: async (ctx): Promise<GetPublicShellStatusResult> => {
    const active = await loadActiveCatalog(ctx);
    return active === null
      ? publicReadError("SNAPSHOT_UNAVAILABLE")
      : success({ metadata: active.metadata });
  },
});

export const getDashboardBundle = query({
  args: {
    filters: v.optional(v.any()),
    selectedPublicPackId: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<GetDashboardBundleResult> => {
    const request = parseDashboardRequest(directArgs(args));
    if (!request.ok) return publicReadError("INVALID_QUERY");
    const active = await loadActiveCatalog(ctx);
    if (active === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
    const allRows = await loadQueryRows(ctx, active.snapshot);
    if (allRows === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
    if (!selectionsAreKnown(allRows, request.value.filters)) {
      return publicReadError("INVALID_QUERY");
    }

    const activeRows = allRows.filter((row) => row.availability === "active");
    const matchingRows = filteredRows(activeRows, request.value.filters, "");
    const opportunityRows = [...matchingRows]
      .filter((row) => row.evDollarsMinor !== null)
      .sort((left, right) =>
        compareCatalogRows(left, right, {
          search: "",
          sort: "ev_dollars",
          direction: "desc",
        }),
      )
      .slice(0, 6);
    const opportunityDetails = await loadPackDetails(
      ctx,
      active.snapshot._id,
      opportunityRows,
    );
    if (opportunityDetails === null) {
      return publicReadError("SNAPSHOT_UNAVAILABLE");
    }

    const selectedRow =
      opportunityRows.find(
        (row) => row.publicPackId === request.value.selectedPublicPackId,
      ) ??
      opportunityRows[0] ??
      null;
    const selectedPack =
      selectedRow === null
        ? null
        : await loadPackDetail(
            ctx,
            active.snapshot._id,
            selectedRow.publicPackId,
          );
    if (selectedRow !== null && selectedPack === null) {
      return publicReadError("SNAPSHOT_UNAVAILABLE");
    }

    const data: DashboardBundle = {
      metadata: active.metadata,
      kpis: {
        totalPacks: matchingRows.length,
        positiveEvPacks: matchingRows.filter(
          (row) => row.evDollarsMinor !== null && row.evDollarsMinor > 0,
        ).length,
        medianEvPercent: medianBasisPoints(matchingRows),
        highestChaseValue: highestChase(matchingRows),
      },
      opportunities: opportunityDetails.map(packSummary),
      platformSummaries: catalogSummaries(matchingRows, "platform"),
      categorySummaries: catalogSummaries(matchingRows, "category"),
      facets: contextualFacets(
        allRows,
        activeRows,
        request.value.filters,
        "",
      ),
      activeFilters: request.value.filters,
      selectedPack,
    };
    return success(data);
  },
});

type PaginationResolution =
  | { readonly ok: false; readonly code: "INVALID_QUERY" | "CURSOR_EXPIRED" }
  | {
      readonly ok: true;
      readonly offset: number;
      readonly paginationReset: "snapshot_changed" | null;
    };

async function resolvePagination(
  ctx: QueryCtx,
  input: ListPublicPacksInput,
  activePublicationId: string,
  activeFingerprint: string,
): Promise<PaginationResolution> {
  if (input.cursor === null) {
    const stack = validateCursorSet({
      cursor: null,
      cursorStack: input.cursorStack,
      expectedFingerprint: activeFingerprint,
      expectedPublicationId: activePublicationId,
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
          ? "snapshot_changed"
          : null,
    };
  }

  const cursor = decodeCatalogCursor(input.cursor);
  if (cursor === null || input.queryFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  const expectedFingerprint = await createQueryFingerprint(
    cursor.snapshotPublicationId,
    input,
  );
  if (expectedFingerprint !== cursor.queryFingerprint) {
    return { ok: false, code: "INVALID_QUERY" };
  }
  const cursorSet = validateCursorSet({
    cursor: input.cursor,
    cursorStack: input.cursorStack,
    expectedFingerprint,
    expectedPublicationId: cursor.snapshotPublicationId,
    pageSize: input.pageSize,
  });
  if (!cursorSet.ok) return { ok: false, code: "INVALID_QUERY" };
  if (cursor.snapshotPublicationId === activePublicationId) {
    return { ok: true, offset: cursor.offset, paginationReset: null };
  }
  const retained = await oneSnapshotByPublicationId(
    ctx,
    cursor.snapshotPublicationId,
  );
  return retained === null || retained.lifecycle !== "complete"
    ? { ok: false, code: "CURSOR_EXPIRED" }
    : { ok: true, offset: 0, paginationReset: "snapshot_changed" };
}

export const listPublicPacks = query({
  args: {
    search: v.optional(v.any()),
    filters: v.optional(v.any()),
    sort: v.optional(v.any()),
    direction: v.optional(v.any()),
    cursor: v.optional(v.any()),
    cursorStack: v.optional(v.any()),
    queryFingerprint: v.optional(v.any()),
    pageSize: v.optional(v.any()),
    selectedPublicPackId: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<ListPublicPacksResult> => {
    const request = parseCatalogRequest(directArgs(args));
    if (!request.ok) return publicReadError("INVALID_QUERY");
    const active = await loadActiveCatalog(ctx);
    if (active === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
    const allRows = await loadQueryRows(ctx, active.snapshot);
    if (allRows === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
    if (!selectionsAreKnown(allRows, request.value.filters)) {
      return publicReadError("INVALID_QUERY");
    }

    const fingerprint = await createQueryFingerprint(
      active.snapshot.publicationId,
      request.value,
    );
    const pagination = await resolvePagination(
      ctx,
      request.value,
      active.snapshot.publicationId,
      fingerprint,
    );
    if (!pagination.ok) return publicReadError(pagination.code);

    const matchingRows = filteredRows(
      allRows,
      request.value.filters,
      request.value.search,
    ).sort((left, right) => compareCatalogRows(left, right, request.value));
    if (pagination.offset > matchingRows.length) {
      return publicReadError("INVALID_QUERY");
    }
    const pageRows = matchingRows.slice(
      pagination.offset,
      pagination.offset + request.value.pageSize,
    );
    const pageDetails = await loadPackDetails(
      ctx,
      active.snapshot._id,
      pageRows,
    );
    if (pageDetails === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
    const selectedPack =
      pageDetails.find(
        (pack) => pack.publicPackId === request.value.selectedPublicPackId,
      ) ?? pageDetails[0] ?? null;
    const pageEnd = pagination.offset + pageRows.length;
    const nextCursor =
      pageEnd < matchingRows.length
        ? encodeCatalogCursor({
            version: 1,
            snapshotPublicationId: active.snapshot.publicationId,
            queryFingerprint: fingerprint,
            offset: pageEnd,
          })
        : null;
    const data: ListPublicPacksPage = {
      metadata: active.metadata,
      rows: pageDetails.map(packSummary),
      selectedPack,
      selectedPackEligible: selectedPack !== null,
      facets: contextualFacets(
        allRows,
        allRows,
        request.value.filters,
        request.value.search,
      ),
      activeQuery: {
        search: request.value.search,
        filters: request.value.filters,
        sort: request.value.sort,
        direction: request.value.direction,
        pageSize: request.value.pageSize,
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

export const getPublicPack = query({
  args: {
    publicPackId: v.any(),
    snapshotPublicationId: v.any(),
  },
  handler: async (ctx, args): Promise<GetPublicPackResult> => {
    const request = getPublicPackInputSchema.safeParse(args);
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadActiveCatalog(ctx);
    if (active === null) return publicReadError("SNAPSHOT_UNAVAILABLE");
    if (
      request.data.snapshotPublicationId !== active.snapshot.publicationId
    ) {
      return publicReadError("PACK_NOT_FOUND");
    }
    const detail = await loadPackDetail(
      ctx,
      active.snapshot._id,
      request.data.publicPackId,
    );
    return detail === null
      ? publicReadError("PACK_NOT_FOUND")
      : success(detail);
  },
});
