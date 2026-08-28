import {
  acceptedRepackQuerySchema,
  containsProtectedEvPublicationKeyV3,
  contextualRepackFacetsSchema,
  dashboardKpisSchema,
  dataReleaseV3IdentitySchema,
  desiredCollectibleRepackResultsV3Schema,
  publicCollectibleSchema,
  publicDashboardBundleV3Schema,
  publicOpaqueCursorSchema,
  publicReadError,
  publicReadErrorSchema,
  publicRepackFiltersSchema,
  publicRepackListPageV3Schema,
  publicRepackViewDetailV3Schema,
  publicShellStatusV3Schema,
  repackPageRangeSchema,
  repackSummaryGroupSchema,
  type AcceptedRepackQuery,
  type ContextualRepackFacets,
  type DashboardKpis,
  type DataReleaseV3Identity,
  type DesiredCollectibleRepackResultsV3,
  type PublicCollectible,
  type PublicDashboardBundleV3,
  type PublicReadError,
  type PublicRepackFilters,
  type PublicRepackListPageV3,
  type PublicRepackViewDetailV3,
  type PublicResult,
  type PublicShellStatusV3,
  type RepackPageRange,
} from "@packscout/contracts";

/**
 * Browser-safe data_release_v3 read-result types and fail-closed parsers.
 *
 * Every public read is validated against the exact v3 contracts before any
 * component sees it. Parsing the contract schemas is itself the arithmetic
 * validation: publicRepackSummaryV3Schema re-proves the four public metrics
 * against the comparable Pack Price with the versioned calculation invariant
 * in every environment, so no browser code ever recomputes a metric to trust
 * it. Any malformed, mixed, protected-field, or inconsistent payload
 * collapses to the bounded RELEASE_UNAVAILABLE error.
 */

export type RepackSummaryGroupV3 = ReturnType<
  (typeof repackSummaryGroupSchema)["parse"]
>;

export type DashboardBundleV3 = PublicDashboardBundleV3 &
  Readonly<{
    kpis: DashboardKpis;
    vendorSummaries: readonly RepackSummaryGroupV3[];
    categorySummaries: readonly RepackSummaryGroupV3[];
    facets: ContextualRepackFacets;
    activeFilters: PublicRepackFilters;
  }>;

export type ListPublicRepacksPageV3 = PublicRepackListPageV3 &
  Readonly<{
    facets: ContextualRepackFacets;
    activeQuery: AcceptedRepackQuery;
    queryFingerprint: string;
    nextCursor: string | null;
    hasPrevious: boolean;
    range: RepackPageRange;
    paginationReset: "release_changed" | null;
  }>;

export type { PublicShellStatusV3 };

export type PublicCollectibleSearchResultsV3 = Readonly<{
  release: DataReleaseV3Identity;
  matches: readonly PublicCollectible[];
}>;

export type GetPublicShellStatusV3Result = PublicResult<PublicShellStatusV3>;
export type GetDashboardBundleV3Result = PublicResult<DashboardBundleV3>;
export type ListPublicRepacksV3Result = PublicResult<ListPublicRepacksPageV3>;
export type GetPublicRepackV3Result = PublicResult<PublicRepackViewDetailV3>;
export type SearchPublicCollectiblesV3Result =
  PublicResult<PublicCollectibleSearchResultsV3>;
export type FindRepacksByDesiredCollectibleV3Result =
  PublicResult<DesiredCollectibleRepackResultsV3>;

const QUERY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResultEnvelope =
  | Readonly<{ kind: "error"; error: PublicReadError }>
  | Readonly<{ kind: "data"; data: unknown }>
  | null;

function parseResultEnvelope(input: unknown): ResultEnvelope {
  if (containsProtectedEvPublicationKeyV3(input)) return null;
  if (!isRecord(input)) return null;
  if (input.ok === false) {
    const parsed = publicReadErrorSchema.safeParse(input);
    return parsed.success ? { kind: "error", error: parsed.data } : null;
  }
  if (input.ok === true && "data" in input) {
    return { kind: "data", data: input.data };
  }
  return null;
}

function failClosed<T>(): PublicResult<T> {
  return publicReadError("RELEASE_UNAVAILABLE");
}

function parsedResult<T>(
  input: unknown,
  parseData: (data: unknown) => T | null,
): PublicResult<T> {
  const envelope = parseResultEnvelope(input);
  if (envelope === null) return failClosed<T>();
  if (envelope.kind === "error") return envelope.error;
  const data = parseData(envelope.data);
  return data === null ? failClosed<T>() : { ok: true, data };
}

const summaryGroupsSchema = repackSummaryGroupSchema.array().max(5);
const collectibleMatchesSchema = publicCollectibleSchema.array().max(20);

function parseDashboardBundleV3(data: unknown): DashboardBundleV3 | null {
  if (!isRecord(data)) return null;
  const {
    kpis,
    vendorSummaries,
    categorySummaries,
    facets,
    activeFilters,
    ...core
  } = data;
  const coreParsed = publicDashboardBundleV3Schema.safeParse(core);
  const kpisParsed = dashboardKpisSchema.safeParse(kpis);
  const vendorParsed = summaryGroupsSchema.safeParse(vendorSummaries);
  const categoryParsed = summaryGroupsSchema.safeParse(categorySummaries);
  const facetsParsed = contextualRepackFacetsSchema.safeParse(facets);
  const filtersParsed = publicRepackFiltersSchema.safeParse(activeFilters);
  if (
    !coreParsed.success ||
    !kpisParsed.success ||
    !vendorParsed.success ||
    !categoryParsed.success ||
    !facetsParsed.success ||
    !filtersParsed.success
  ) {
    return null;
  }
  return {
    ...coreParsed.data,
    kpis: kpisParsed.data,
    vendorSummaries: vendorParsed.data,
    categorySummaries: categoryParsed.data,
    facets: facetsParsed.data,
    activeFilters: filtersParsed.data,
  };
}

function parseListPublicRepacksPageV3(
  data: unknown,
): ListPublicRepacksPageV3 | null {
  if (!isRecord(data)) return null;
  const {
    facets,
    activeQuery,
    queryFingerprint,
    nextCursor,
    hasPrevious,
    range,
    paginationReset,
    ...core
  } = data;
  const coreParsed = publicRepackListPageV3Schema.safeParse(core);
  const facetsParsed = contextualRepackFacetsSchema.safeParse(facets);
  const queryParsed = acceptedRepackQuerySchema.safeParse(activeQuery);
  const rangeParsed = repackPageRangeSchema.safeParse(range);
  if (
    !coreParsed.success ||
    !facetsParsed.success ||
    !queryParsed.success ||
    !rangeParsed.success ||
    typeof queryFingerprint !== "string" ||
    !QUERY_FINGERPRINT_PATTERN.test(queryFingerprint) ||
    typeof hasPrevious !== "boolean" ||
    (paginationReset !== null && paginationReset !== "release_changed")
  ) {
    return null;
  }
  let cursor: string | null = null;
  if (nextCursor !== null) {
    const cursorParsed = publicOpaqueCursorSchema.safeParse(nextCursor);
    if (!cursorParsed.success) return null;
    cursor = cursorParsed.data;
  }
  const visibleCount =
    rangeParsed.data.total === 0
      ? 0
      : rangeParsed.data.end - rangeParsed.data.start + 1;
  if (visibleCount !== coreParsed.data.rows.length) return null;
  return {
    ...coreParsed.data,
    facets: facetsParsed.data,
    activeQuery: queryParsed.data,
    queryFingerprint,
    nextCursor: cursor,
    hasPrevious,
    range: rangeParsed.data,
    paginationReset,
  };
}

function parseShellStatusV3(data: unknown): PublicShellStatusV3 | null {
  const parsed = publicShellStatusV3Schema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

function parseCollectibleSearchResultsV3(
  data: unknown,
): PublicCollectibleSearchResultsV3 | null {
  if (!isRecord(data)) return null;
  const releaseParsed = dataReleaseV3IdentitySchema.safeParse(data.release);
  const matchesParsed = collectibleMatchesSchema.safeParse(data.matches);
  if (!releaseParsed.success || !matchesParsed.success) return null;
  const identifiers = new Set(
    matchesParsed.data.map(({ publicCollectibleId }) => publicCollectibleId),
  );
  if (identifiers.size !== matchesParsed.data.length) return null;
  return { release: releaseParsed.data, matches: matchesParsed.data };
}

export function parseGetPublicShellStatusV3Result(
  input: unknown,
): GetPublicShellStatusV3Result {
  return parsedResult(input, parseShellStatusV3);
}

export function parseGetDashboardBundleV3Result(
  input: unknown,
): GetDashboardBundleV3Result {
  return parsedResult(input, parseDashboardBundleV3);
}

export function parseListPublicRepacksV3Result(
  input: unknown,
): ListPublicRepacksV3Result {
  return parsedResult(input, parseListPublicRepacksPageV3);
}

export function parseGetPublicRepackV3Result(
  input: unknown,
): GetPublicRepackV3Result {
  return parsedResult(input, (data) => {
    const parsed = publicRepackViewDetailV3Schema.safeParse(data);
    return parsed.success ? parsed.data : null;
  });
}

export function parseSearchPublicCollectiblesV3Result(
  input: unknown,
): SearchPublicCollectiblesV3Result {
  return parsedResult(input, parseCollectibleSearchResultsV3);
}

export function parseFindRepacksByDesiredCollectibleV3Result(
  input: unknown,
): FindRepacksByDesiredCollectibleV3Result {
  return parsedResult(input, (data) => {
    const parsed = desiredCollectibleRepackResultsV3Schema.safeParse(data);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * The dashboard facets span the whole active release, so an entirely empty
 * facet universe with zero matching repacks means the catalog itself is
 * empty rather than filtered down to nothing.
 */
export function dashboardCatalogIsEmpty(bundle: DashboardBundleV3): boolean {
  return (
    bundle.kpis.totalRepacks === 0 &&
    bundle.facets.vendors.length === 0 &&
    bundle.facets.categories.length === 0 &&
    bundle.facets.collectibleTypes.length === 0
  );
}

/**
 * The All Repacks projection carries no release-wide count, so the empty
 * catalog state is reserved for a zero-result default query — any search,
 * filter, or desired-collectible constraint renders the no-matches recovery
 * instead so constrained results stay recoverable.
 */
export function allRepacksCatalogIsEmpty(page: ListPublicRepacksPageV3): boolean {
  const query = page.activeQuery;
  return (
    page.range.total === 0 &&
    query.search === "" &&
    query.desiredPublicCollectibleId === null &&
    query.filters.vendors.length === 0 &&
    query.filters.categories.length === 0 &&
    query.filters.collectibleTypes.length === 0 &&
    query.filters.price.mode === "full"
  );
}
