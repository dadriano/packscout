import {
  PUBLIC_CATALOG_DEFAULT_PAGE_SIZE,
  PUBLIC_CATALOG_PRICE_MAX_MINOR,
  PUBLIC_CATALOG_PRICE_MIN_MINOR,
  decodePublicCursorStack,
  encodePublicCursorStack,
  listPublicPacksInputSchema,
  type ListPublicPacksInput,
  type PublicCatalogSort,
} from "@packscout/contracts";

const SORT_KEYS = new Set<PublicCatalogSort>([
  "pack",
  "pack_price",
  "ev_dollars",
  "ev_percent",
  "buyback_percent",
  "gross_ev",
  "top_chase_value",
]);

export const DEFAULT_CATALOG_QUERY: ListPublicPacksInput = Object.freeze({
  search: "",
  filters: Object.freeze({
    platforms: Object.freeze([]),
    categories: Object.freeze([]),
    price: Object.freeze({
      mode: "full",
      minMinor: PUBLIC_CATALOG_PRICE_MIN_MINOR,
      maxMinor: PUBLIC_CATALOG_PRICE_MAX_MINOR,
    }),
  }),
  sort: "ev_dollars",
  direction: "desc",
  cursor: null,
  cursorStack: null,
  queryFingerprint: null,
  pageSize: PUBLIC_CATALOG_DEFAULT_PAGE_SIZE,
  selectedPublicPackId: null,
});

export type CatalogQueryParseResult =
  | { readonly ok: true; readonly query: ListPublicPacksInput }
  | { readonly ok: false; readonly message: string };

function parseDollarAmount(value: string | null): number | null {
  if (value === null || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [dollars, cents = ""] = value.split(".");
  const minorUnits = Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
  return Number.isSafeInteger(minorUnits) ? minorUnits : null;
}

function formatDollarAmount(minorUnits: number): string {
  const dollars = Math.trunc(minorUnits / 100);
  const cents = minorUnits % 100;
  return cents === 0
    ? String(dollars)
    : `${dollars}.${String(cents).padStart(2, "0")}`;
}

function canonicalValues(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => value.trim()).filter(Boolean))].sort());
}

function onlyKnownKeys(parameters: URLSearchParams): boolean {
  const knownKeys = new Set([
    "q",
    "platform",
    "category",
    "minPrice",
    "maxPrice",
    "sort",
    "direction",
    "cursor",
    "cursorStack",
    "queryFingerprint",
  ]);
  return [...parameters.keys()].every((key) => knownKeys.has(key));
}

function hasDuplicateSingleton(parameters: URLSearchParams): boolean {
  return [
    "q",
    "minPrice",
    "maxPrice",
    "sort",
    "direction",
    "cursor",
    "cursorStack",
    "queryFingerprint",
  ].some((key) => parameters.getAll(key).length > 1);
}

export function parseCatalogQueryState(
  parameters: URLSearchParams,
): CatalogQueryParseResult {
  if (!onlyKnownKeys(parameters) || hasDuplicateSingleton(parameters)) {
    return { ok: false, message: "This catalog link contains unsupported query state." };
  }

  const minRaw = parameters.get("minPrice");
  const maxRaw = parameters.get("maxPrice");
  if ((minRaw === null) !== (maxRaw === null)) {
    return { ok: false, message: "Both price limits are required." };
  }

  const minMinor = minRaw === null ? PUBLIC_CATALOG_PRICE_MIN_MINOR : parseDollarAmount(minRaw);
  const maxMinor = maxRaw === null ? PUBLIC_CATALOG_PRICE_MAX_MINOR : parseDollarAmount(maxRaw);
  if (minMinor === null || maxMinor === null) {
    return { ok: false, message: "The catalog price range is invalid." };
  }

  const sortRaw = parameters.get("sort") ?? DEFAULT_CATALOG_QUERY.sort;
  const directionRaw = parameters.get("direction") ?? DEFAULT_CATALOG_QUERY.direction;
  if (!SORT_KEYS.has(sortRaw as PublicCatalogSort) || !["asc", "desc"].includes(directionRaw)) {
    return { ok: false, message: "The catalog sort is invalid." };
  }

  const cursor = parameters.get("cursor");
  const cursorStack = parameters.get("cursorStack");
  const queryFingerprint = parameters.get("queryFingerprint");
  const parsed = listPublicPacksInputSchema.safeParse({
    search: parameters.get("q") ?? "",
    filters: {
      platforms: canonicalValues(parameters.getAll("platform")),
      categories: canonicalValues(parameters.getAll("category")),
      price:
        minRaw === null && maxRaw === null
          ? DEFAULT_CATALOG_QUERY.filters.price
          : { mode: "narrowed", minMinor, maxMinor },
    },
    sort: sortRaw,
    direction: directionRaw,
    cursor,
    cursorStack,
    queryFingerprint,
    pageSize: PUBLIC_CATALOG_DEFAULT_PAGE_SIZE,
    selectedPublicPackId: null,
  });

  return parsed.success
    ? { ok: true, query: parsed.data }
    : { ok: false, message: "This catalog link cannot be applied." };
}

export function serializeCatalogQueryState(query: ListPublicPacksInput): string {
  const parsed = listPublicPacksInputSchema.parse(query);
  const parameters = new URLSearchParams();
  if (parsed.search) parameters.set("q", parsed.search);
  for (const platform of parsed.filters.platforms) parameters.append("platform", platform);
  for (const category of parsed.filters.categories) parameters.append("category", category);
  if (parsed.filters.price.mode === "narrowed") {
    parameters.set("minPrice", formatDollarAmount(parsed.filters.price.minMinor));
    parameters.set("maxPrice", formatDollarAmount(parsed.filters.price.maxMinor));
  }
  if (parsed.sort !== DEFAULT_CATALOG_QUERY.sort) parameters.set("sort", parsed.sort);
  if (parsed.direction !== DEFAULT_CATALOG_QUERY.direction) {
    parameters.set("direction", parsed.direction);
  }
  if (parsed.cursor) parameters.set("cursor", parsed.cursor);
  if (parsed.cursorStack) parameters.set("cursorStack", parsed.cursorStack);
  if (parsed.queryFingerprint) parameters.set("queryFingerprint", parsed.queryFingerprint);
  const serialized = parameters.toString();
  return serialized ? `/packs?${serialized}` : "/packs";
}

export function serializeDashboardFilters(
  filters: ListPublicPacksInput["filters"],
): string {
  const query = listPublicPacksInputSchema.parse({ filters });
  const allPacksHref = serializeCatalogQueryState(query);
  return allPacksHref === "/packs"
    ? "/"
    : allPacksHref.replace("/packs?", "/?");
}

export function resetCatalogPagination(
  query: ListPublicPacksInput,
  changes: Partial<Pick<ListPublicPacksInput, "search" | "filters" | "sort" | "direction">>,
): ListPublicPacksInput {
  return listPublicPacksInputSchema.parse({
    ...query,
    ...changes,
    cursor: null,
    cursorStack: null,
    queryFingerprint: null,
    selectedPublicPackId: null,
  });
}

export function nextCatalogPage(
  query: ListPublicPacksInput,
  nextCursor: string | null,
  queryFingerprint: string,
): ListPublicPacksInput {
  if (nextCursor === null) return query;
  const previousStarts = query.cursorStack
    ? decodePublicCursorStack(query.cursorStack)
    : [];
  if (previousStarts === null) return query;
  const stack = query.cursor
    ? [...previousStarts, query.cursor]
    : [...previousStarts];
  return listPublicPacksInputSchema.parse({
    ...query,
    cursor: nextCursor,
    cursorStack: stack.length > 0 ? encodePublicCursorStack(stack) : null,
    queryFingerprint,
  });
}

export function previousCatalogPage(
  query: ListPublicPacksInput,
  queryFingerprint: string,
): ListPublicPacksInput {
  const previousStarts = query.cursorStack
    ? decodePublicCursorStack(query.cursorStack)
    : [];
  if (previousStarts === null) return query;
  const stack = [...previousStarts];
  const cursor = stack.pop() ?? null;
  return listPublicPacksInputSchema.parse({
    ...query,
    cursor,
    cursorStack: stack.length > 0 ? encodePublicCursorStack(stack) : null,
    queryFingerprint,
  });
}
