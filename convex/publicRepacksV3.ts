import {
  dataReleaseV3IdentitySchema,
  desiredCollectibleRepackResultsV3Schema,
  findRepacksByDesiredCollectibleInputSchema,
  normalizeDashboardQueryInput,
  normalizeListPublicRepacksInput,
  normalizePublicSearchText,
  publicDashboardBundleV3Schema,
  publicReadError,
  publicRepackListPageV3Schema,
  publicRepackViewDetailV3Schema,
  publicRepackViewSummaryV3FromDetail,
  searchPublicCollectiblesInputSchema,
  unavailableRepackHeat,
  type DashboardKpis,
  type DataReleaseV3Identity,
  type ListPublicRepacksInput,
  type PublicCollectible,
  type PublicReadError,
  type PublicRepackChase,
  type PublicRepackDetailV3,
  type PublicRepackFilters,
  type PublicRepackViewDetailV3,
  type PackScoutPublicEvV3,
} from "@packscout/contracts";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import {
  loadActiveDataReleaseV3State,
  loadDataReleaseV3ByPublicReleaseId,
} from "./dataReleaseV3Lifecycle";
import {
  dataReleaseV3SearchRowMatchesDetail,
  type DataReleaseV3SearchRow,
} from "./dataReleaseV3Search";
import {
  createQueryFingerprint,
  decodeRepackCursor,
  encodeRepackCursor,
  validateCursorSet,
} from "./publicRepackValidation";

/**
 * data_release_v3 public reads (task buyback-adjusted-ev/008).
 *
 * Every read resolves exactly one atomically activated release, re-proves its
 * internal consistency, and fails closed with a bounded error instead of ever
 * serving a partial, mixed, or tampered projection. Deadline safety is
 * server-clock based: a stored current estimate whose 60-minute deadline has
 * passed the caller-supplied request clock is presented as unavailable with
 * the stable `SOURCE_DATA_STALE` reason and excluded from every ranking, KPI,
 * median, and summary — even when no expiry transition has materialized yet.
 *
 * Heat republication against v3 releases belongs to task 009; until a heat
 * frame targets a v3 release, every view carries the explicit unavailable
 * heat state rather than borrowing a v2-aligned signal.
 */

const MAX_DESIRED_CHASES_PER_COLLECTIBLE = 512;

type Success<T> = { readonly ok: true; readonly data: T };
type PublicResult<T> = Success<T> | PublicReadError;

function success<T>(data: T): Success<T> {
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

export type ActiveDataReleaseV3 = Readonly<{
  identity: DataReleaseV3Identity;
  releaseDocument: Doc<"dataReleaseV3Releases">;
  rows: readonly DataReleaseV3SearchRow[];
  rowByPublicId: ReadonlyMap<string, DataReleaseV3SearchRow>;
  categoryByPublicId: ReadonlyMap<
    string,
    Readonly<{ parentPublicCategoryId: string | null; depth: number }>
  >;
}>;

async function loadActiveDataReleaseV3(
  ctx: QueryCtx,
): Promise<ActiveDataReleaseV3 | null> {
  try {
    const state = await loadActiveDataReleaseV3State(ctx);
    if (
      state === null ||
      state.activeReleaseId === null ||
      state.activeRelease === null
    ) {
      return null;
    }
    const release = await ctx.db.get(
      "dataReleaseV3Releases",
      state.activeReleaseId,
    );
    if (
      release === null ||
      release.lifecycle !== "complete" ||
      release.completedAt === null ||
      release.publicReleaseId !== state.activeRelease.publicReleaseId ||
      release.releaseFingerprint !== state.activeRelease.releaseFingerprint ||
      release.completedAt !== state.activeRelease.completedAt ||
      canonicalJson(release.expectedCounts) !==
        canonicalJson(state.activeRelease.counts) ||
      canonicalJson(release.acceptedCounts) !==
        canonicalJson(release.expectedCounts) ||
      canonicalJson(release.acceptedEntityChainHashes) !==
        canonicalJson(release.expectedEntityChainHashes) ||
      release.acceptedBatchCount !== release.expectedBatchCount ||
      release.acceptedBatchChainHash !== release.expectedBatchChainHash ||
      release.acceptedSearchRowCount !== release.expectedCounts.repacks
    ) {
      return null;
    }
    const identityParse = dataReleaseV3IdentitySchema.safeParse({
      schemaVersion: "data_release_v3",
      publicReleaseId: release.publicReleaseId,
      methodVersion: release.methodVersion,
      confidencePolicyVersion: release.confidencePolicyVersion,
      dataAsOf: release.dataAsOf,
      completedAt: release.completedAt,
    });
    if (!identityParse.success) return null;

    const shardBudget = release.expectedCounts.searchShards;
    const shards = await ctx.db
      .query("dataReleaseV3SearchShards")
      .withIndex("by_release_id_and_shard_number", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(shardBudget + 1);
    if (shards.length !== shardBudget) return null;
    const rows: DataReleaseV3SearchRow[] = [];
    for (const [index, shard] of shards.entries()) {
      if (shard.shardNumber !== index || shard.rows.length !== shard.rowCount) {
        return null;
      }
      rows.push(...(shard.rows as DataReleaseV3SearchRow[]));
    }
    if (rows.length !== release.expectedCounts.repacks) return null;
    const sorted = rows.every(
      (row, index) =>
        index === 0 || rows[index - 1]!.publicRepackId < row.publicRepackId,
    );
    if (!sorted) return null;

    const categories = await ctx.db
      .query("dataReleaseV3Categories")
      .withIndex("by_release_id_and_public_category_id", (index) =>
        index.eq("releaseId", release._id),
      )
      .take(release.expectedCounts.categories + 1);
    if (categories.length !== release.expectedCounts.categories) return null;
    const categoryByPublicId = new Map(
      categories.map((category) => [
        category.publicCategoryId,
        {
          parentPublicCategoryId: category.detail.parentPublicCategoryId,
          depth: category.detail.depth,
        },
      ]),
    );
    return {
      identity: identityParse.data,
      releaseDocument: release,
      rows,
      rowByPublicId: new Map(rows.map((row) => [row.publicRepackId, row])),
      categoryByPublicId,
    };
  } catch {
    return null;
  }
}

/**
 * Server-clock deadline safety: a stored current estimate whose exact expiry
 * deadline has passed converts to the deterministic stale public state. The
 * conversion is applied identically to rows and details so no projection can
 * disagree with another.
 */
function presentPackScoutEvV3(
  estimate: PackScoutPublicEvV3,
  currentTime: number,
): PackScoutPublicEvV3 {
  if (
    estimate.status !== "current" ||
    currentTime <= Date.parse(estimate.expiresAt)
  ) {
    return estimate;
  }
  return {
    status: "unavailable",
    methodVersion: estimate.methodVersion,
    confidencePolicyVersion: estimate.confidencePolicyVersion,
    metrics: null,
    confidence: null,
    calculatedAt: new Date(currentTime).toISOString(),
    dataAsOf: estimate.dataAsOf,
    reason: "SOURCE_DATA_STALE",
  };
}

function presentSearchRow(
  row: DataReleaseV3SearchRow,
  currentTime: number,
): DataReleaseV3SearchRow {
  if (
    row.packScoutExpiresAtMillis === null ||
    currentTime <= row.packScoutExpiresAtMillis
  ) {
    return row;
  }
  return {
    ...row,
    packScoutEvDollarsMinor: null,
    packScoutEvDollarsNullRank: 1,
    packScoutGrossEvMinor: null,
    packScoutGrossEvNullRank: 1,
    packScoutEvPercentBasisPoints: null,
    packScoutEvPercentNullRank: 1,
    packScoutConfidenceBasisPoints: null,
    packScoutConfidenceNullRank: 1,
    packScoutConfidenceBand: null,
    packScoutExpiresAtMillis: null,
  };
}

function presentDetail(
  detail: PublicRepackDetailV3,
  currentTime: number,
): PublicRepackDetailV3 {
  const packScout = presentPackScoutEvV3(
    detail.evEstimates.packScout,
    currentTime,
  );
  return packScout === detail.evEstimates.packScout
    ? detail
    : { ...detail, evEstimates: { ...detail.evEstimates, packScout } };
}

async function hydrateRepackViews(
  ctx: QueryCtx,
  release: ActiveDataReleaseV3,
  rows: readonly DataReleaseV3SearchRow[],
  currentTime: number,
): Promise<PublicRepackViewDetailV3[] | null> {
  const views: PublicRepackViewDetailV3[] = [];
  for (const row of rows) {
    const storedRow = release.rowByPublicId.get(row.publicRepackId);
    if (storedRow === undefined) return null;
    const stored = await ctx.db
      .query("dataReleaseV3Repacks")
      .withIndex("by_release_id_and_public_repack_id", (index) =>
        index
          .eq("releaseId", release.releaseDocument._id)
          .eq("publicRepackId", row.publicRepackId),
      )
      .unique();
    if (stored === null) return null;
    const detail = stored.detail as PublicRepackDetailV3;
    // The staged search projection must byte-match the deterministic
    // derivation of its staged detail before either is presented.
    if (!dataReleaseV3SearchRowMatchesDetail(storedRow, detail)) return null;
    const view = publicRepackViewDetailV3Schema.safeParse({
      ...presentDetail(detail, currentTime),
      heat: unavailableRepackHeat(),
    });
    if (!view.success) return null;
    views.push(view.data);
  }
  return views;
}

// --- bounded filtering, search, sorting, and aggregates over v3 rows ---

function rowMatchesSearch(
  row: DataReleaseV3SearchRow,
  normalizedSearch: string,
): boolean {
  if (normalizedSearch === "") return true;
  const queryTokens = normalizedSearch.split(" ");
  const candidateTokens = [
    ...row.normalizedName.split(" "),
    ...row.normalizedVendor.split(" "),
    ...row.normalizedCategories.split(" "),
  ];
  return queryTokens.every((queryToken) =>
    candidateTokens.some((candidate) => candidate.startsWith(queryToken)),
  );
}

function rowMatchesFilters(
  row: DataReleaseV3SearchRow,
  filters: PublicRepackFilters,
  options: {
    readonly ignoreVendors?: boolean;
    readonly ignoreCategories?: boolean;
    readonly ignoreCollectibleTypes?: boolean;
  } = {},
): boolean {
  if (filters.availability === "active" && row.availability !== "active") {
    return false;
  }
  if (
    !options.ignoreVendors &&
    filters.vendors.length > 0 &&
    !filters.vendors.includes(row.vendorKey)
  ) {
    return false;
  }
  if (
    !options.ignoreCategories &&
    filters.categories.length > 0 &&
    !filters.categories.some((publicCategoryId) =>
      row.publicCategoryIds.includes(publicCategoryId),
    )
  ) {
    return false;
  }
  if (
    !options.ignoreCollectibleTypes &&
    filters.collectibleTypes.length > 0 &&
    !filters.collectibleTypes.some((type) =>
      row.collectibleTypes.includes(type),
    )
  ) {
    return false;
  }
  if (filters.price.mode === "narrowed") {
    return (
      row.priceMinor !== null &&
      row.priceMinor >= filters.price.minMinor &&
      row.priceMinor <= filters.price.maxMinor
    );
  }
  return true;
}

function selectionsAreKnown(
  rows: readonly DataReleaseV3SearchRow[],
  filters: PublicRepackFilters,
): boolean {
  const vendors = new Set(rows.map((row) => row.vendorKey));
  const categories = new Set(rows.flatMap((row) => row.publicCategoryIds));
  const collectibleTypes = new Set(
    rows.flatMap((row) => row.collectibleTypes),
  );
  return (
    filters.vendors.every((key) => vendors.has(key)) &&
    filters.categories.every((id) => categories.has(id)) &&
    filters.collectibleTypes.every((type) => collectibleTypes.has(type))
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type SortableMetricField =
  | "priceMinor"
  | "packScoutEvDollarsMinor"
  | "packScoutEvPercentBasisPoints"
  | "packScoutGrossEvMinor"
  | "packScoutConfidenceBasisPoints"
  | "buybackRateBasisPoints"
  | "topChaseValueMinor"
  | "vendorReportedEvUsdMinor";

type SortableRankField =
  | "priceNullRank"
  | "packScoutEvDollarsNullRank"
  | "packScoutEvPercentNullRank"
  | "packScoutGrossEvNullRank"
  | "packScoutConfidenceNullRank"
  | "buybackRateNullRank"
  | "topChaseNullRank"
  | "vendorReportedEvUsdNullRank";

const V3_METRIC_FIELDS: Readonly<
  Partial<
    Record<
      ListPublicRepacksInput["sort"],
      readonly [SortableMetricField, SortableRankField]
    >
  >
> = {
  repack_price: ["priceMinor", "priceNullRank"],
  packscout_ev_dollars: ["packScoutEvDollarsMinor", "packScoutEvDollarsNullRank"],
  packscout_ev_percent: [
    "packScoutEvPercentBasisPoints",
    "packScoutEvPercentNullRank",
  ],
  packscout_gross_ev: ["packScoutGrossEvMinor", "packScoutGrossEvNullRank"],
  packscout_confidence: [
    "packScoutConfidenceBasisPoints",
    "packScoutConfidenceNullRank",
  ],
  buyback_percent: ["buybackRateBasisPoints", "buybackRateNullRank"],
  top_chase_value: ["topChaseValueMinor", "topChaseNullRank"],
};

function sortIsSupported(sort: ListPublicRepacksInput["sort"]): boolean {
  // Vendor-reported EV is structurally independent in data_release_v3 and
  // carries no percent projection, so a v2 vendor-percent sort cannot be
  // honored honestly and fails closed as an invalid query.
  return sort === "repack" || V3_METRIC_FIELDS[sort] !== undefined;
}

function relevance(row: DataReleaseV3SearchRow, normalizedSearch: string) {
  const queryTokens = normalizedSearch.split(" ");
  const nameTokens = row.normalizedName.split(" ");
  const matchingNameTokens = queryTokens.filter((queryToken) =>
    nameTokens.some((candidate) => candidate.startsWith(queryToken)),
  ).length;
  const tier =
    row.normalizedName === normalizedSearch
      ? 0
      : row.normalizedName.startsWith(`${normalizedSearch} `)
        ? 1
        : matchingNameTokens === queryTokens.length
          ? 2
          : 3;
  return { tier, matchingNameTokens };
}

function compareRows(
  left: DataReleaseV3SearchRow,
  right: DataReleaseV3SearchRow,
  input: Pick<ListPublicRepacksInput, "search" | "sort" | "direction">,
): number {
  if (input.search !== "") {
    const leftRelevance = relevance(left, input.search);
    const rightRelevance = relevance(right, input.search);
    return (
      leftRelevance.tier - rightRelevance.tier ||
      rightRelevance.matchingNameTokens - leftRelevance.matchingNameTokens ||
      compareText(left.normalizedName, right.normalizedName) ||
      compareText(left.publicRepackId, right.publicRepackId)
    );
  }
  if (input.sort === "repack") {
    const nameComparison = compareText(left.normalizedName, right.normalizedName);
    return (
      (input.direction === "asc" ? nameComparison : -nameComparison) ||
      compareText(left.publicRepackId, right.publicRepackId)
    );
  }
  const fields = V3_METRIC_FIELDS[input.sort];
  if (fields === undefined) {
    return compareText(left.publicRepackId, right.publicRepackId);
  }
  const [valueField, rankField] = fields;
  const leftRank = left[rankField];
  const rightRank = right[rankField];
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftValue = left[valueField];
  const rightValue = right[valueField];
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    const comparison = leftValue - rightValue;
    return input.direction === "asc" ? comparison : -comparison;
  }
  return compareText(left.publicRepackId, right.publicRepackId);
}

function medianPackScoutEvPercent(
  rows: readonly DataReleaseV3SearchRow[],
): DashboardKpis["medianPackScoutEvPercent"] {
  const values = rows
    .flatMap((row) =>
      row.packScoutEvPercentBasisPoints === null
        ? []
        : [row.packScoutEvPercentBasisPoints],
    )
    .sort((left, right) => left - right);
  if (values.length === 0) {
    return {
      status: "unavailable",
      basisPoints: null,
      reason: "ESTIMATE_UNAVAILABLE",
    };
  }
  const middle = Math.floor(values.length / 2);
  const basisPoints =
    values.length % 2 === 1
      ? values[middle]!
      : Math.round((values[middle - 1]! + values[middle]!) / 2);
  return { status: "available", basisPoints };
}

function dashboardKpis(rows: readonly DataReleaseV3SearchRow[]): DashboardKpis {
  const chaseValues = rows.flatMap((row) =>
    row.topChaseValueMinor === null ? [] : [row.topChaseValueMinor],
  );
  return {
    totalRepacks: rows.length,
    positiveEvRepacks: rows.filter(
      (row) =>
        row.availability === "active" &&
        row.packScoutEvDollarsMinor !== null &&
        row.packScoutEvDollarsMinor > 0,
    ).length,
    medianPackScoutEvPercent: medianPackScoutEvPercent(rows),
    highestChaseValueUsdMinor:
      chaseValues.length === 0 ? null : Math.max(...chaseValues),
    highConfidenceRepacks: rows.filter(
      (row) =>
        row.packScoutConfidenceBasisPoints !== null &&
        row.packScoutConfidenceBasisPoints >= 8_000,
    ).length,
  };
}

function repackSummaries(
  rows: readonly DataReleaseV3SearchRow[],
  group: "vendor" | "category",
) {
  const groups = new Map<
    string,
    { label: string; rows: DataReleaseV3SearchRow[] }
  >();
  for (const row of rows) {
    if (group === "vendor") {
      const existing = groups.get(row.vendorKey);
      if (existing) existing.rows.push(row);
      else groups.set(row.vendorKey, { label: row.vendorDisplayName, rows: [row] });
      continue;
    }
    row.publicCategoryIds.forEach((categoryId, index) => {
      const existing = groups.get(categoryId);
      if (existing) existing.rows.push(row);
      else {
        groups.set(categoryId, {
          label: row.categoryLabels[index] ?? categoryId,
          rows: [row],
        });
      }
    });
  }
  return [...groups]
    .map(([key, value]) => ({
      key,
      label: value.label,
      repackCount: value.rows.length,
      medianPackScoutEvPercent: medianPackScoutEvPercent(value.rows),
    }))
    .sort(
      (left, right) =>
        right.repackCount - left.repackCount || left.key.localeCompare(right.key),
    )
    .slice(0, 5);
}

function contextualFacets(
  universeRows: readonly DataReleaseV3SearchRow[],
  countableRows: readonly DataReleaseV3SearchRow[],
  filters: PublicRepackFilters,
  search: string,
  categoryHierarchy: ActiveDataReleaseV3["categoryByPublicId"],
) {
  const vendorLabels = new Map<string, string>();
  const categoryLabels = new Map<string, string>();
  const collectibleTypeLabels = new Map<string, string>();
  for (const row of universeRows) {
    vendorLabels.set(row.vendorKey, row.vendorDisplayName);
    row.publicCategoryIds.forEach((id, index) =>
      categoryLabels.set(id, row.categoryLabels[index] ?? id),
    );
    row.collectibleTypes.forEach((type) =>
      collectibleTypeLabels.set(
        type,
        type
          .split("_")
          .map((part) => part[0]!.toUpperCase() + part.slice(1))
          .join(" "),
      ),
    );
  }
  const searched = countableRows.filter((row) => rowMatchesSearch(row, search));
  const vendorCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const collectibleTypeCounts = new Map<string, number>();
  for (const row of searched) {
    if (rowMatchesFilters(row, filters, { ignoreVendors: true })) {
      vendorCounts.set(row.vendorKey, (vendorCounts.get(row.vendorKey) ?? 0) + 1);
    }
    if (rowMatchesFilters(row, filters, { ignoreCategories: true })) {
      for (const id of row.publicCategoryIds) {
        categoryCounts.set(id, (categoryCounts.get(id) ?? 0) + 1);
      }
    }
    if (rowMatchesFilters(row, filters, { ignoreCollectibleTypes: true })) {
      for (const type of row.collectibleTypes) {
        collectibleTypeCounts.set(
          type,
          (collectibleTypeCounts.get(type) ?? 0) + 1,
        );
      }
    }
  }
  const options = (
    labels: ReadonlyMap<string, string>,
    counts: ReadonlyMap<string, number>,
    selected: readonly string[],
  ) =>
    [...labels]
      .map(([key, label]) => ({
        key,
        label,
        repackCount: counts.get(key) ?? 0,
        selected: selected.includes(key),
      }))
      .filter((option) => option.repackCount > 0 || option.selected)
      .sort((left, right) => left.key.localeCompare(right.key));
  const categories = [...categoryLabels]
    .map(([key, label]) => {
      const node = categoryHierarchy.get(key);
      return {
        key,
        label,
        repackCount: categoryCounts.get(key) ?? 0,
        selected: filters.categories.includes(key),
        parentKey: node?.parentPublicCategoryId ?? null,
        depth: node?.depth ?? 0,
      };
    })
    .filter((option) => option.repackCount > 0 || option.selected)
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    vendors: options(vendorLabels, vendorCounts, filters.vendors),
    categories,
    collectibleTypes: options(
      collectibleTypeLabels,
      collectibleTypeCounts,
      filters.collectibleTypes,
    ),
  };
}

// --- shared collectible lookups ---

type SharedCollectibleLookup =
  | { readonly status: "found"; readonly detail: PublicCollectible }
  | { readonly status: "not_found" }
  | { readonly status: "invalid" };

async function loadReleaseCollectible(
  ctx: QueryCtx,
  release: ActiveDataReleaseV3,
  publicCollectibleId: string,
): Promise<SharedCollectibleLookup> {
  const matches = await ctx.db
    .query("dataReleaseV3Collectibles")
    .withIndex("by_release_id_and_public_collectible_id", (index) =>
      index
        .eq("releaseId", release.releaseDocument._id)
        .eq("publicCollectibleId", publicCollectibleId),
    )
    .take(2);
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "invalid" };
  return { status: "found", detail: matches[0]!.detail as PublicCollectible };
}

function collectibleDisplay(detail: PublicCollectible) {
  return {
    publicCollectibleId: detail.publicCollectibleId,
    name: detail.name,
    collectibleType: detail.collectibleType,
    publicCategoryIds: detail.publicCategoryIds,
    primaryImage: detail.primaryImage,
    valuation: detail.valuation,
  };
}

async function loadDesiredChases(
  ctx: QueryCtx,
  release: ActiveDataReleaseV3,
  publicCollectibleId: string,
): Promise<ReadonlyMap<string, PublicRepackChase> | null> {
  const chases = await ctx.db
    .query("dataReleaseV3Chases")
    .withIndex("by_release_id_and_public_collectible_id", (index) =>
      index
        .eq("releaseId", release.releaseDocument._id)
        .eq("publicCollectibleId", publicCollectibleId),
    )
    .take(MAX_DESIRED_CHASES_PER_COLLECTIBLE + 1);
  if (chases.length > MAX_DESIRED_CHASES_PER_COLLECTIBLE) return null;
  const byRepack = new Map<string, PublicRepackChase>();
  for (const chase of chases) {
    if (byRepack.has(chase.publicRepackId)) return null;
    byRepack.set(chase.publicRepackId, chase.detail as PublicRepackChase);
  }
  return byRepack;
}

// --- public queries ---

export const getPublicShellStatusV3 = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<PublicResult<{ release: DataReleaseV3Identity }>> => {
    const active = await loadActiveDataReleaseV3(ctx);
    return active === null
      ? publicReadError("RELEASE_UNAVAILABLE")
      : success({ release: active.identity });
  },
});

export const getDashboardBundleV3 = query({
  args: {
    filters: v.optional(v.any()),
    selectedPublicRepackId: v.optional(v.any()),
    currentTime: v.number(),
  },
  handler: async (ctx, args) => {
    const { currentTime, ...queryArgs } = args;
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    let request;
    try {
      request = normalizeDashboardQueryInput(directArgs(queryArgs));
    } catch {
      return publicReadError("INVALID_QUERY");
    }
    const active = await loadActiveDataReleaseV3(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const allRows = active.rows.map((row) => presentSearchRow(row, currentTime));
    if (!selectionsAreKnown(allRows, request.filters)) {
      return publicReadError("INVALID_QUERY");
    }
    const matchingRows = allRows.filter((row) =>
      rowMatchesFilters(row, request.filters),
    );
    // Opportunities are actionable buys: only active repacks with a current,
    // unexpired PackScout estimate rank, by signed EV dollars descending.
    const opportunityRows = [...matchingRows]
      .filter(
        (row) =>
          row.availability === "active" && row.packScoutEvDollarsMinor !== null,
      )
      .sort((left, right) =>
        compareRows(left, right, {
          search: "",
          sort: "packscout_ev_dollars",
          direction: "desc",
        }),
      )
      .slice(0, 6);
    const details = await hydrateRepackViews(
      ctx,
      active,
      opportunityRows,
      currentTime,
    );
    if (details === null) return publicReadError("RELEASE_UNAVAILABLE");
    const selectedRepack =
      details.find(
        (detail) => detail.publicRepackId === request.selectedPublicRepackId,
      ) ??
      details[0] ??
      null;
    const bundle = publicDashboardBundleV3Schema.safeParse({
      release: active.identity,
      opportunities: details.map(publicRepackViewSummaryV3FromDetail),
      details,
      selectedRepack,
    });
    if (!bundle.success) return publicReadError("RELEASE_UNAVAILABLE");
    return success({
      ...bundle.data,
      kpis: dashboardKpis(matchingRows),
      vendorSummaries: repackSummaries(matchingRows, "vendor"),
      categorySummaries: repackSummaries(matchingRows, "category"),
      facets: contextualFacets(
        allRows,
        allRows,
        request.filters,
        "",
        active.categoryByPublicId,
      ),
      activeFilters: request.filters,
    });
  },
});

async function resolveDataReleaseV3Pagination(
  ctx: QueryCtx,
  input: ListPublicRepacksInput,
  activePublicReleaseId: string,
  activeFingerprint: string,
): Promise<
  | { readonly ok: false; readonly code: "INVALID_QUERY" | "CURSOR_EXPIRED" }
  | {
      readonly ok: true;
      readonly offset: number;
      readonly paginationReset: "release_changed" | null;
    }
> {
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
  const retained = await loadDataReleaseV3ByPublicReleaseId(
    ctx,
    cursor.publicReleaseId,
  ).catch(() => null);
  return retained !== null && retained.lifecycle === "complete"
    ? { ok: true, offset: 0, paginationReset: "release_changed" }
    : { ok: false, code: "CURSOR_EXPIRED" };
}

export const listPublicRepacksV3 = query({
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
  handler: async (ctx, args) => {
    const { currentTime, ...queryArgs } = args;
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    let request: ListPublicRepacksInput;
    try {
      request = normalizeListPublicRepacksInput(directArgs(queryArgs));
    } catch {
      return publicReadError("INVALID_QUERY");
    }
    if (!sortIsSupported(request.sort)) {
      return publicReadError("INVALID_QUERY");
    }
    const active = await loadActiveDataReleaseV3(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const allRows = active.rows.map((row) => presentSearchRow(row, currentTime));
    if (!selectionsAreKnown(allRows, request.filters)) {
      return publicReadError("INVALID_QUERY");
    }

    let desiredCollectible: ReturnType<typeof collectibleDisplay> | null = null;
    let desiredChases: ReadonlyMap<string, PublicRepackChase> = new Map();
    if (request.desiredPublicCollectibleId !== null) {
      const lookup = await loadReleaseCollectible(
        ctx,
        active,
        request.desiredPublicCollectibleId,
      );
      if (lookup.status === "not_found") {
        return publicReadError("COLLECTIBLE_NOT_FOUND");
      }
      if (lookup.status === "invalid") {
        return publicReadError("RELEASE_UNAVAILABLE");
      }
      const chases = await loadDesiredChases(
        ctx,
        active,
        lookup.detail.publicCollectibleId,
      );
      if (chases === null) return publicReadError("RELEASE_UNAVAILABLE");
      desiredCollectible = collectibleDisplay(lookup.detail);
      desiredChases = chases;
    }
    const eligibleRows =
      desiredCollectible === null
        ? allRows
        : allRows.filter((row) => desiredChases.has(row.publicRepackId));

    const fingerprint = await createQueryFingerprint(
      active.identity.publicReleaseId,
      request,
    );
    const pagination = await resolveDataReleaseV3Pagination(
      ctx,
      request,
      active.identity.publicReleaseId,
      fingerprint,
    );
    if (!pagination.ok) return publicReadError(pagination.code);

    const matchingRows = eligibleRows
      .filter(
        (row) =>
          rowMatchesSearch(row, request.search) &&
          rowMatchesFilters(row, request.filters),
      )
      .sort((left, right) => compareRows(left, right, request));
    if (pagination.offset > matchingRows.length) {
      return publicReadError("INVALID_QUERY");
    }
    const pageRows = matchingRows.slice(
      pagination.offset,
      pagination.offset + request.pageSize,
    );
    const details = await hydrateRepackViews(ctx, active, pageRows, currentTime);
    if (details === null) return publicReadError("RELEASE_UNAVAILABLE");
    const selectedRepack =
      details.find(
        (detail) => detail.publicRepackId === request.selectedPublicRepackId,
      ) ??
      details[0] ??
      null;
    const page = publicRepackListPageV3Schema.safeParse({
      release: active.identity,
      rows: details.map(publicRepackViewSummaryV3FromDetail),
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
    });
    if (!page.success) return publicReadError("RELEASE_UNAVAILABLE");
    const pageEnd = pagination.offset + pageRows.length;
    return success({
      ...page.data,
      facets: contextualFacets(
        allRows,
        eligibleRows,
        request.filters,
        request.search,
        active.categoryByPublicId,
      ),
      activeQuery: {
        search: request.search,
        filters: request.filters,
        sort: request.sort,
        direction: request.direction,
        pageSize: request.pageSize,
        desiredPublicCollectibleId: request.desiredPublicCollectibleId,
      },
      queryFingerprint: fingerprint,
      nextCursor:
        pageEnd < matchingRows.length
          ? encodeRepackCursor({
              version: 2,
              publicReleaseId: active.identity.publicReleaseId,
              queryFingerprint: fingerprint,
              offset: pageEnd,
            })
          : null,
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
    });
  },
});

export const getPublicRepackV3 = query({
  args: {
    publicRepackId: v.any(),
    publicReleaseId: v.any(),
    currentTime: v.number(),
  },
  handler: async (ctx, args) => {
    if (!currentTimeIsValid(args.currentTime)) {
      return publicReadError("INVALID_QUERY");
    }
    if (
      typeof args.publicRepackId !== "string" ||
      typeof args.publicReleaseId !== "string"
    ) {
      return publicReadError("INVALID_QUERY");
    }
    const active = await loadActiveDataReleaseV3(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    if (args.publicReleaseId !== active.identity.publicReleaseId) {
      return publicReadError("REPACK_NOT_FOUND");
    }
    const row = active.rowByPublicId.get(args.publicRepackId);
    if (row === undefined) return publicReadError("REPACK_NOT_FOUND");
    const views = await hydrateRepackViews(ctx, active, [row], args.currentTime);
    if (views === null || views[0] === undefined) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    return success(views[0]);
  },
});

export const searchPublicCollectiblesV3 = query({
  args: {
    search: v.any(),
    collectibleTypes: v.optional(v.any()),
    limit: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const request = searchPublicCollectiblesInputSchema.safeParse(
      directArgs(args),
    );
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadActiveDataReleaseV3(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const search = normalizePublicSearchText(request.data.search);
    const candidateLimit = Math.min(100, request.data.limit * 10);
    const types =
      request.data.collectibleTypes.length === 0
        ? [null]
        : request.data.collectibleTypes;
    const matches: PublicCollectible[] = [];
    const seen = new Set<string>();
    for (const type of types) {
      const results = await ctx.db
        .query("dataReleaseV3Collectibles")
        .withSearchIndex("search_search_text", (index) => {
          const scoped = index
            .search("searchText", search)
            .eq("releaseId", active.releaseDocument._id);
          return type === null ? scoped : scoped.eq("collectibleType", type);
        })
        .take(candidateLimit);
      for (const result of results) {
        if (seen.has(result.publicCollectibleId)) continue;
        seen.add(result.publicCollectibleId);
        matches.push(result.detail as PublicCollectible);
      }
    }
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
      release: active.identity,
      matches: matches.slice(0, request.data.limit),
    });
  },
});

export const findRepacksByDesiredCollectibleV3 = query({
  args: {
    publicCollectibleId: v.any(),
    filters: v.optional(v.any()),
    sort: v.optional(v.any()),
    direction: v.optional(v.any()),
    limit: v.optional(v.any()),
    currentTime: v.number(),
  },
  handler: async (ctx, args) => {
    const { currentTime, ...queryArgs } = args;
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    const request = findRepacksByDesiredCollectibleInputSchema.safeParse(
      directArgs(queryArgs),
    );
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadActiveDataReleaseV3(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const lookup = await loadReleaseCollectible(
      ctx,
      active,
      request.data.publicCollectibleId,
    );
    if (lookup.status === "not_found") {
      return publicReadError("COLLECTIBLE_NOT_FOUND");
    }
    if (lookup.status === "invalid") {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    const allRows = active.rows.map((row) => presentSearchRow(row, currentTime));
    if (!selectionsAreKnown(allRows, request.data.filters)) {
      return publicReadError("INVALID_QUERY");
    }
    const desiredChases = await loadDesiredChases(
      ctx,
      active,
      lookup.detail.publicCollectibleId,
    );
    if (desiredChases === null) return publicReadError("RELEASE_UNAVAILABLE");
    const desiredMetric = (
      row: DataReleaseV3SearchRow,
      chase: PublicRepackChase,
    ): number | null =>
      request.data.sort === "match_confidence"
        ? chase.matchConfidence.scoreBasisPoints
        : request.data.sort === "repack_price"
          ? row.priceMinor
          : row.packScoutEvPercentBasisPoints;
    const matchingRows = allRows
      .filter(
        (row) =>
          desiredChases.has(row.publicRepackId) &&
          rowMatchesFilters(row, request.data.filters),
      )
      .sort((left, right) => {
        const leftValue = desiredMetric(left, desiredChases.get(left.publicRepackId)!);
        const rightValue = desiredMetric(
          right,
          desiredChases.get(right.publicRepackId)!,
        );
        if (leftValue === null && rightValue !== null) return 1;
        if (leftValue !== null && rightValue === null) return -1;
        if (
          leftValue !== null &&
          rightValue !== null &&
          leftValue !== rightValue
        ) {
          return request.data.direction === "asc"
            ? leftValue - rightValue
            : rightValue - leftValue;
        }
        return compareText(left.publicRepackId, right.publicRepackId);
      });
    const visibleRows = matchingRows.slice(0, request.data.limit);
    const details = await hydrateRepackViews(ctx, active, visibleRows, currentTime);
    if (details === null) return publicReadError("RELEASE_UNAVAILABLE");
    const result = desiredCollectibleRepackResultsV3Schema.safeParse({
      release: active.identity,
      desiredCollectible: collectibleDisplay(lookup.detail),
      matches: details.map((detail) => ({
        repack: publicRepackViewSummaryV3FromDetail(detail),
        chase: desiredChases.get(detail.publicRepackId)!,
      })),
      total: matchingRows.length,
    });
    if (!result.success) return publicReadError("RELEASE_UNAVAILABLE");
    return success(result.data);
  },
});
