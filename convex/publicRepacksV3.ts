import {
  dataReleaseV3IdentitySchema,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  desiredCollectibleRepackResultsV3Schema,
  findRepacksByDesiredCollectibleInputSchema,
  normalizeDashboardQueryInput,
  normalizeListPublicRepacksInput,
  normalizePublicSearchText,
  publicCatalogRecordUpdateStatusV3Schema,
  publicDashboardBundleV3Schema,
  publicReadError,
  publicRepackListPageV3Schema,
  publicRepackDetailV3Schema,
  publicShellStatusV3Schema,
  publicRepackViewDetailV3Schema,
  unavailableRepackHeat,
  type PackScoutDisplayedEvV3,
  type PublicCatalogRecordUpdateStatusV3,
  publicRepackViewSummaryV3FromDetail,
  searchPublicCollectiblesInputSchema,
  type DashboardKpis,
  type DataReleaseV3Identity,
  type ListPublicRepacksInput,
  type PublicCollectible,
  type PublicReadError,
  type PublicRepackChase,
  type PublicRepackFilters,
  type PublicRepackViewDetailV3,
  type PublicShellStatusV3,
  type PublicPackAvailability,
} from "@packscout/contracts";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  action,
  internalQuery,
  query,
  type QueryCtx,
} from "./_generated/server";
import { canonicalJson } from "./dataReleaseCanonicalHash";
import {
  catalogReadAuthorized,
  catalogReadTokenArg,
} from "./publicCatalogReadAccess";
import {
  loadActiveDataReleaseV3State,
} from "./dataReleaseV3Lifecycle";
import {
  dataReleaseV3SearchRowMatchesDetail,
  displayedEvMetricFromDataReleaseV3SearchRow,
  type DataReleaseV3SearchRow,
} from "./dataReleaseV3Search";
import { evFactsFromDetail, type DataReleaseV3EvFacts } from "./dataReleaseV3EvFacts";
import { loadDataReleaseV3DisplayedRepacks } from "./dataReleaseV3DisplayedRepacks";
import { medianDisplayedEvPercent, type DisplayedEvMedianContext } from "./dataReleaseV3DisplayedEvMedian";
import { usesLegacyEvSnapshot } from "./dataReleaseV3EvMigrationState";
import { loadRetainedEvPointer } from "./dataReleaseV3RetainedEv";
import {
  encodeDataReleaseV3Cursor,
  isDataReleaseV3EvaluationTime,
  resolveDataReleaseV3Pagination,
} from "./dataReleaseV3Pagination";
import {
  loadDataReleaseV3ProviderHealthSnapshot,
  missingDataReleaseV3ProviderHealth,
  type DataReleaseV3ProviderHealthSnapshot,
} from "./dataReleaseV3ProviderObservation";
import {
  dataReleaseV3ProviderHealthContext,
  dataReleaseV3PresentationContext,
} from "./dataReleaseV3PublicPresentation";

/**
 * data_release_v3 public reads (task buyback-adjusted-ev/008).
 *
 * Every read resolves exactly one atomically activated release, re-proves its
 * internal consistency, and fails closed with a bounded error instead of ever
 * serving a partial, mixed, or tampered projection. Valid published values
 * remain visible as last-known EV, with confidence evaluated at the request
 * clock. The activation-owned retained projection also survives later
 * unavailable releases; all rankings and details use that same projection.
 * Public actions mint the trusted clock; cursor-pinned confidence never uses
 * a caller-controlled clock. Provider health is informational only.
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

const currentTimeIsValid = isDataReleaseV3EvaluationTime;

/**
 * The one pack-availability state a repack may be ranked, counted, or acted on
 * from. `available` is exhaustively opposed by `sold_out`, `unavailable`, and
 * `unknown`: all three stay fully discoverable in the catalog and all three
 * stay out of every opportunity ranking and outbound action.
 * Nothing falls into an `else` branch that assumes availability — a state this
 * code has never seen reads as not-purchasable, never as purchasable.
 *
 * Pack availability is a separate axis from PackScout EV availability: an
 * `available` repack may carry an unavailable estimate, and a repack that is
 * not purchasable may still carry a presentable historical estimate.
 */
function packIsPurchasable(availability: PublicPackAvailability): boolean {
  return availability === "available";
}

export type ActiveDataReleaseV3 = Readonly<{
  identity: DataReleaseV3Identity;
  releaseDocument: Doc<"dataReleaseV3Releases">;
  rows: readonly DataReleaseV3SearchRow[];
  rowByPublicId: ReadonlyMap<string, DataReleaseV3SearchRow>;
  storedRowByPublicId: ReadonlyMap<string, DataReleaseV3SearchRow>;
  evByPublicId: ReadonlyMap<string, PackScoutDisplayedEvV3>;
  factsByPublicId: ReadonlyMap<string, DataReleaseV3EvFacts>;
  legacyEvSnapshot: boolean;
  categoryByPublicId: ReadonlyMap<
    string,
    Readonly<{ parentPublicCategoryId: string | null; depth: number }>
  >;
  vendors: readonly Readonly<{
    publicVendorId: string;
    vendorKey: string;
  }>[];
}>;

async function loadActiveDataReleaseV3(
  ctx: QueryCtx,
  currentTime?: number,
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
      release.publicEvPolicyVersion !== PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 ||
      state.activeRelease.publicEvPolicyVersion !==
        PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 ||
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
      publicEvPolicyVersion: release.publicEvPolicyVersion,
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
    const vendorKeyByPublicId = new Map<string, string>();
    for (const row of rows) {
      const existing = vendorKeyByPublicId.get(row.publicVendorId);
      if (existing !== undefined && existing !== row.vendorKey) return null;
      vendorKeyByPublicId.set(row.publicVendorId, row.vendorKey);
    }

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
    const legacyEvSnapshot = await usesLegacyEvSnapshot(ctx, release, state);
    if (!legacyEvSnapshot) await loadRetainedEvPointer(ctx, state);
    const displayed = currentTime === undefined || legacyEvSnapshot ? null
      : await loadDataReleaseV3DisplayedRepacks(ctx, release, rows, currentTime);
    if (currentTime !== undefined && !legacyEvSnapshot && displayed === null) return null;
    const publicRows = displayed?.rows ?? rows;
    return {
      identity: identityParse.data,
      releaseDocument: release,
      rows: publicRows,
      rowByPublicId: new Map(publicRows.map((row) => [row.publicRepackId, row])),
      storedRowByPublicId: new Map(rows.map((row) => [row.publicRepackId, row])),
      evByPublicId: displayed?.evByPublicId ?? new Map(),
      factsByPublicId: displayed?.factsByPublicId ?? new Map(),
      legacyEvSnapshot,
      categoryByPublicId,
      vendors: [...vendorKeyByPublicId].map(([publicVendorId, vendorKey]) => ({
        publicVendorId,
        vendorKey,
      })),
    };
  } catch {
    return null;
  }
}

async function hydrateRepackViews(
  ctx: QueryCtx,
  release: ActiveDataReleaseV3,
  rows: readonly DataReleaseV3SearchRow[],
  health: DataReleaseV3ProviderHealthSnapshot,
): Promise<PublicRepackViewDetailV3[] | null> {
  const views: PublicRepackViewDetailV3[] = [];
  for (const row of rows) {
    const stored = await ctx.db.query("dataReleaseV3Repacks")
      .withIndex("by_release_id_and_public_repack_id", (index) => index.eq("releaseId", release.releaseDocument._id)
        .eq("publicRepackId", row.publicRepackId)).unique();
    const rawRow = release.storedRowByPublicId.get(row.publicRepackId);
    const displayedEstimate = release.evByPublicId.get(row.publicRepackId);
    const facts = release.factsByPublicId.get(row.publicRepackId);
    if (stored === null || rawRow === undefined) return null;
    const parsed = publicRepackDetailV3Schema.safeParse(stored.detail);
    if (!parsed.success || !dataReleaseV3SearchRowMatchesDetail(rawRow, parsed.data)) return null;
    if (!release.legacyEvSnapshot && (displayedEstimate === undefined || facts === undefined ||
        canonicalJson(evFactsFromDetail(parsed.data)) !== canonicalJson(facts))) return null;
    // During the explicit one-time cutover only, keep the published snapshot
    // unchanged. Never expire its values or switch merely because facts seal.
    const estimate = release.legacyEvSnapshot ? parsed.data.evEstimates.packScout : displayedEstimate!;
    const view = publicRepackViewDetailV3Schema.safeParse({ ...parsed.data,
      evEstimates: { ...parsed.data.evEstimates, packScout: estimate },
      heat: unavailableRepackHeat(),
      providerHealth: health.byPublicVendorId.get(parsed.data.publicVendorId) ??
        missingDataReleaseV3ProviderHealth(),
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
  // The "available" filter admits only purchasable packs; "all" is the only
  // way sold-out, unavailable, and unknown packs become visible.
  if (
    filters.availability === "available" &&
    !packIsPurchasable(row.availability)
  ) {
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
  estimates?: ReadonlyMap<string, PackScoutDisplayedEvV3>,
  legacyEvSnapshot = false,
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
  const displayedEvSort = valueField === "packScoutGrossEvMinor" ||
    valueField === "packScoutEvDollarsMinor" || valueField === "packScoutEvPercentBasisPoints";
  const leftValue = displayedEvSort
    ? displayedEvMetricFromDataReleaseV3SearchRow(left, valueField, estimates?.get(left.publicRepackId), legacyEvSnapshot)
    : left[valueField];
  const rightValue = displayedEvSort
    ? displayedEvMetricFromDataReleaseV3SearchRow(right, valueField, estimates?.get(right.publicRepackId), legacyEvSnapshot)
    : right[valueField];
  const leftRank = displayedEvSort ? (leftValue === null ? 1 : 0) : left[rankField];
  const rightRank = displayedEvSort ? (rightValue === null ? 1 : 0) : right[rankField];
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    const comparison = leftValue - rightValue;
    return input.direction === "asc" ? comparison : -comparison;
  }
  return compareText(left.publicRepackId, right.publicRepackId);
}

function purchasableRepackRows(
  rows: readonly DataReleaseV3SearchRow[],
): DataReleaseV3SearchRow[] {
  return rows.filter((row) => packIsPurchasable(row.availability));
}

/**
 * Every ranked, counted, or headline KPI reads from `purchasableRows` so a
 * `sold_out`, `unavailable`, or `unknown` pack can never supply a number the
 * dashboard presents as an opportunity. Only `totalRepacks` stays ungated: it
 * counts the catalog the filters matched, and all four states stay
 * discoverable there.
 */
function dashboardKpis(rows: readonly DataReleaseV3SearchRow[], context: DisplayedEvMedianContext): DashboardKpis {
  const purchasableRows = purchasableRepackRows(rows);
  const chaseValues = purchasableRows.flatMap((row) =>
    row.topChaseValueMinor === null ? [] : [row.topChaseValueMinor],
  );
  return {
    totalRepacks: rows.length,
    medianPackScoutEvPercent: medianDisplayedEvPercent(purchasableRows, context),
    highestChaseValueUsdMinor:
      chaseValues.length === 0 ? null : Math.max(...chaseValues),
    highConfidenceRepacks: purchasableRows.filter(
      (row) =>
        row.packScoutConfidenceBasisPoints !== null &&
        row.packScoutConfidenceBasisPoints >= 8_000,
    ).length,
  };
}

function repackSummaries(
  rows: readonly DataReleaseV3SearchRow[],
  group: "vendor" | "category",
  context: DisplayedEvMedianContext,
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
      medianPackScoutEvPercent: medianDisplayedEvPercent(
        purchasableRepackRows(value.rows), context,
      ),
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

/**
 * Every v3 catalog read runs the same closed-beta two-caller check the v1/v2
 * reads run (closed-beta-access/005), refusing with the identical non-leaking
 * `RELEASE_UNAVAILABLE` result. The frontend reads exclusively from these
 * queries, so leaving them ungated would leave main's closed catalog read
 * model protecting nothing.
 */

export const getPublicShellStatusV3AtTime = internalQuery({
  args: { currentTime: v.number(), ...catalogReadTokenArg },
  handler: async (
    ctx,
    args,
  ): Promise<PublicResult<PublicShellStatusV3>> => {
    if (!(await catalogReadAuthorized(ctx, args.catalogReadToken))) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    if (!currentTimeIsValid(args.currentTime)) {
      return publicReadError("INVALID_QUERY");
    }
    const active = await loadActiveDataReleaseV3(ctx);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const health = await loadDataReleaseV3ProviderHealthSnapshot(
      ctx,
      active.releaseDocument,
      active.vendors,
      args.currentTime,
    );
    const shell = publicShellStatusV3Schema.safeParse({
      release: active.identity,
      ...dataReleaseV3PresentationContext(args.currentTime),
      ...dataReleaseV3ProviderHealthContext(args.currentTime),
      providerHealthSummary: health.summary,
    });
    return shell.success
      ? success(shell.data)
      : publicReadError("RELEASE_UNAVAILABLE");
  },
});

export const getPublicCatalogRecordUpdateStatusV3AtTime = internalQuery({
  args: { currentTime: v.number(), ...catalogReadTokenArg },
  handler: async (
    ctx,
    args,
  ): Promise<PublicResult<PublicCatalogRecordUpdateStatusV3>> => {
    if (!(await catalogReadAuthorized(ctx, args.catalogReadToken))) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    if (!currentTimeIsValid(args.currentTime)) {
      return publicReadError("INVALID_QUERY");
    }
    try {
      const state = await loadActiveDataReleaseV3State(ctx);
      if (
        state === null ||
        state.activeReleaseId === null ||
        state.activeRelease === null
      ) {
        return publicReadError("RELEASE_UNAVAILABLE");
      }
      const release = await ctx.db.get(
        "dataReleaseV3Releases",
        state.activeReleaseId,
      );
      if (
        release === null ||
        release.lifecycle !== "complete" ||
        release.completedAt === null ||
        release.latestCatalogRecordUpdatedAt === null ||
        release.latestCatalogRecordUpdatedAt === undefined ||
        release.publicReleaseId !== state.activeRelease.publicReleaseId ||
        release.releaseFingerprint !== state.activeRelease.releaseFingerprint ||
        release.methodVersion !== state.activeRelease.methodVersion ||
        release.confidencePolicyVersion !==
          state.activeRelease.confidencePolicyVersion ||
        release.publicEvPolicyVersion !==
          PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 ||
        release.publicEvPolicyVersion !==
          state.activeRelease.publicEvPolicyVersion ||
        release.dataAsOf !== state.activeRelease.dataAsOf ||
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
        return publicReadError("RELEASE_UNAVAILABLE");
      }
      const status = publicCatalogRecordUpdateStatusV3Schema.safeParse({
        schemaVersion: "data_release_v3",
        publicReleaseId: release.publicReleaseId,
        latestCatalogRecordUpdatedAt: release.latestCatalogRecordUpdatedAt,
        evaluatedAt: new Date(args.currentTime).toISOString(),
      });
      return status.success
        ? success(status.data)
        : publicReadError("RELEASE_UNAVAILABLE");
    } catch {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
  },
});

export const getDashboardBundleV3AtTime = internalQuery({
  args: {
    filters: v.optional(v.any()),
    selectedPublicRepackId: v.optional(v.any()),
    currentTime: v.number(),
    ...catalogReadTokenArg,
  },
  handler: async (ctx, args) => {
    const { currentTime, catalogReadToken, ...queryArgs } = args;
    if (!(await catalogReadAuthorized(ctx, catalogReadToken))) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    let request;
    try {
      request = normalizeDashboardQueryInput(directArgs(queryArgs));
    } catch {
      return publicReadError("INVALID_QUERY");
    }
    const active = await loadActiveDataReleaseV3(ctx, currentTime);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    const health = await loadDataReleaseV3ProviderHealthSnapshot(
      ctx, active.releaseDocument, active.vendors, currentTime,
    );
    const allRows = active.rows;
    if (!selectionsAreKnown(allRows, request.filters)) {
      return publicReadError("INVALID_QUERY");
    }
    const matchingRows = allRows.filter((row) =>
      rowMatchesFilters(row, request.filters),
    );
    // Opportunities are actionable buys: only available repacks with a
    // last-known PackScout estimate rank, by signed EV dollars
    // descending. Sold-out, unavailable, and unknown packs stay visible in the
    // catalog and never rank here.
    const opportunityRows = [...matchingRows]
      .filter(
        (row) =>
          packIsPurchasable(row.availability) &&
          row.packScoutEvDollarsMinor !== null,
      )
      .sort((left, right) =>
        compareRows(left, right, {
          search: "",
          sort: "packscout_ev_dollars",
          direction: "desc",
        }),
      )
      .slice(0, 6);
    const details = await hydrateRepackViews(ctx, active, opportunityRows, health);
    if (details === null) return publicReadError("RELEASE_UNAVAILABLE");
    const selectedRepack =
      details.find(
        (detail) => detail.publicRepackId === request.selectedPublicRepackId,
      ) ??
      details[0] ??
      null;
    const bundle = publicDashboardBundleV3Schema.safeParse({
      release: active.identity,
      ...dataReleaseV3PresentationContext(currentTime),
      ...dataReleaseV3ProviderHealthContext(currentTime),
      providerHealthSummary: health.summary,
      opportunities: details.map(publicRepackViewSummaryV3FromDetail),
      details,
      selectedRepack,
    });
    if (!bundle.success) return publicReadError("RELEASE_UNAVAILABLE");
    return success({
      ...bundle.data,
      kpis: dashboardKpis(matchingRows, active),
      vendorSummaries: repackSummaries(matchingRows, "vendor", active),
      categorySummaries: repackSummaries(matchingRows, "category", active),
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

export const listPublicRepacksV3AtTime = internalQuery({
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
    ...catalogReadTokenArg,
  },
  handler: async (ctx, args) => {
    const { currentTime, catalogReadToken, ...queryArgs } = args;
    if (!(await catalogReadAuthorized(ctx, catalogReadToken))) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
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
    const storedActive = await loadActiveDataReleaseV3(ctx);
    if (storedActive === null) return publicReadError("RELEASE_UNAVAILABLE");
    const pagination = await resolveDataReleaseV3Pagination(
      ctx, request, storedActive.identity.publicReleaseId, currentTime,
    );
    if (!pagination.ok) return publicReadError(pagination.code);
    const confidenceEvaluatedAtMillis = pagination.confidenceEvaluatedAtMillis;
    const displayed = storedActive.legacyEvSnapshot ? null
      : await loadDataReleaseV3DisplayedRepacks(
          ctx, storedActive.releaseDocument, storedActive.rows, confidenceEvaluatedAtMillis,
        ).catch(() => null);
    if (!storedActive.legacyEvSnapshot && displayed === null) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    const active = displayed === null ? storedActive : {
      ...storedActive, ...displayed,
      rowByPublicId: new Map(displayed.rows.map(row => [row.publicRepackId, row])),
    };
    const health = await loadDataReleaseV3ProviderHealthSnapshot(
      ctx, active.releaseDocument, active.vendors, currentTime,
    );
    const allRows = active.rows;
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

    const matchingRows = eligibleRows
      .filter(
        (row) =>
          rowMatchesSearch(row, request.search) &&
          rowMatchesFilters(row, request.filters),
      )
      .sort((left, right) => compareRows(left, right, request, active.evByPublicId, active.legacyEvSnapshot));
    if (pagination.offset > matchingRows.length) {
      return publicReadError("INVALID_QUERY");
    }
    const pageRows = matchingRows.slice(
      pagination.offset,
      pagination.offset + request.pageSize,
    );
    const details = await hydrateRepackViews(ctx, active, pageRows, health);
    if (details === null) return publicReadError("RELEASE_UNAVAILABLE");
    const selectedRepack =
      details.find(
        (detail) => detail.publicRepackId === request.selectedPublicRepackId,
      ) ??
      details[0] ??
      null;
    const page = publicRepackListPageV3Schema.safeParse({
      release: active.identity,
      ...dataReleaseV3PresentationContext(confidenceEvaluatedAtMillis),
      ...dataReleaseV3ProviderHealthContext(currentTime),
      providerHealthSummary: health.summary,
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
    let nextCursor: string | null = null;
    if (pageEnd < matchingRows.length) {
      if (pagination.cursorSigningKey === null) {
        return publicReadError("RELEASE_UNAVAILABLE");
      }
      nextCursor = await encodeDataReleaseV3Cursor(
        {
          version: 3,
          publicReleaseId: active.identity.publicReleaseId,
          queryFingerprint: pagination.queryFingerprint,
          offset: pageEnd,
          confidenceEvaluatedAtMillis,
        },
        pagination.cursorSigningKey,
      );
    }
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
      queryFingerprint: pagination.queryFingerprint,
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
    });
  },
});

export const getPublicRepackV3AtTime = internalQuery({
  args: {
    publicRepackId: v.any(),
    publicReleaseId: v.any(),
    currentTime: v.number(),
    ...catalogReadTokenArg,
  },
  handler: async (ctx, args) => {
    if (!(await catalogReadAuthorized(ctx, args.catalogReadToken))) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    if (!currentTimeIsValid(args.currentTime)) {
      return publicReadError("INVALID_QUERY");
    }
    if (
      typeof args.publicRepackId !== "string" ||
      typeof args.publicReleaseId !== "string"
    ) {
      return publicReadError("INVALID_QUERY");
    }
    const active = await loadActiveDataReleaseV3(ctx, args.currentTime);
    if (active === null) return publicReadError("RELEASE_UNAVAILABLE");
    if (args.publicReleaseId !== active.identity.publicReleaseId) {
      return publicReadError("REPACK_NOT_FOUND");
    }
    const row = active.rowByPublicId.get(args.publicRepackId);
    if (row === undefined) return publicReadError("REPACK_NOT_FOUND");
    const health = await loadDataReleaseV3ProviderHealthSnapshot(
      ctx, active.releaseDocument, active.vendors, args.currentTime,
    );
    const views = await hydrateRepackViews(ctx, active, [row], health);
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
    ...catalogReadTokenArg,
  },
  handler: async (ctx, args) => {
    const { catalogReadToken, ...queryArgs } = args;
    if (!(await catalogReadAuthorized(ctx, catalogReadToken))) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    const request = searchPublicCollectiblesInputSchema.safeParse(
      directArgs(queryArgs),
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

export const findRepacksByDesiredCollectibleV3AtTime = internalQuery({
  args: {
    publicCollectibleId: v.any(),
    filters: v.optional(v.any()),
    sort: v.optional(v.any()),
    direction: v.optional(v.any()),
    limit: v.optional(v.any()),
    currentTime: v.number(),
    ...catalogReadTokenArg,
  },
  handler: async (ctx, args) => {
    const { currentTime, catalogReadToken, ...queryArgs } = args;
    if (!(await catalogReadAuthorized(ctx, catalogReadToken))) {
      return publicReadError("RELEASE_UNAVAILABLE");
    }
    if (!currentTimeIsValid(currentTime)) return publicReadError("INVALID_QUERY");
    const request = findRepacksByDesiredCollectibleInputSchema.safeParse(
      directArgs(queryArgs),
    );
    if (!request.success) return publicReadError("INVALID_QUERY");
    const active = await loadActiveDataReleaseV3(ctx, currentTime);
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
    const allRows = active.rows;
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
    const health = await loadDataReleaseV3ProviderHealthSnapshot(
      ctx, active.releaseDocument, active.vendors, currentTime,
    );
    const details = await hydrateRepackViews(ctx, active, visibleRows, health);
    if (details === null) return publicReadError("RELEASE_UNAVAILABLE");
    const result = desiredCollectibleRepackResultsV3Schema.safeParse({
      release: active.identity,
      ...dataReleaseV3PresentationContext(currentTime),
      ...dataReleaseV3ProviderHealthContext(currentTime),
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

/**
 * Buyer-facing time-sensitive reads are actions so the evaluation clock comes
 * from Convex, never from a visitor-controlled query argument or URL. The
 * internal `*AtTime` queries above are the deterministic test seam and are not
 * callable by public identities.
 */
export const getPublicShellStatusV3 = action({
  args: { ...catalogReadTokenArg },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.publicRepacksV3.getPublicShellStatusV3AtTime, {
      ...args,
      currentTime: Date.now(),
    }),
});

export const getPublicCatalogRecordUpdateStatusV3 = action({
  args: { ...catalogReadTokenArg },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(
      internal.publicRepacksV3.getPublicCatalogRecordUpdateStatusV3AtTime,
      {
        ...args,
        currentTime: Date.now(),
      },
    ),
});

export const getDashboardBundleV3 = action({
  args: {
    filters: v.optional(v.any()),
    selectedPublicRepackId: v.optional(v.any()),
    ...catalogReadTokenArg,
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.publicRepacksV3.getDashboardBundleV3AtTime, {
      ...args,
      currentTime: Date.now(),
    }),
});

export const listPublicRepacksV3 = action({
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
    ...catalogReadTokenArg,
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.publicRepacksV3.listPublicRepacksV3AtTime, {
      ...args,
      currentTime: Date.now(),
    }),
});

export const getPublicRepackV3 = action({
  args: {
    publicRepackId: v.any(),
    publicReleaseId: v.any(),
    ...catalogReadTokenArg,
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(internal.publicRepacksV3.getPublicRepackV3AtTime, {
      ...args,
      currentTime: Date.now(),
    }),
});

export const findRepacksByDesiredCollectibleV3 = action({
  args: {
    publicCollectibleId: v.any(),
    filters: v.optional(v.any()),
    sort: v.optional(v.any()),
    direction: v.optional(v.any()),
    limit: v.optional(v.any()),
    ...catalogReadTokenArg,
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> =>
    await ctx.runQuery(
      internal.publicRepacksV3.findRepacksByDesiredCollectibleV3AtTime,
      { ...args, currentTime: Date.now() },
    ),
});
