import {
  PUBLIC_REPACK_DEFAULT_PAGE_SIZE,
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  decodePublicCursorStack,
  encodePublicCursorStack,
  listPublicRepacksInputSchema,
  type ListPublicRepacksInput,
  type PublicRepackSort,
} from "@packscout/contracts";

const SORT_KEYS = new Set<PublicRepackSort>([
  "repack",
  "repack_price",
  "packscout_ev_dollars",
  "packscout_ev_percent",
  "vendor_reported_ev_percent",
  "buyback_percent",
  "packscout_gross_ev",
  "top_chase_value",
  "packscout_confidence",
]);

export const DEFAULT_CATALOG_QUERY: ListPublicRepacksInput = Object.freeze({
  search: "",
  filters: Object.freeze({
    vendors: Object.freeze([]),
    categories: Object.freeze([]),
    collectibleTypes: Object.freeze([]),
    price: Object.freeze({
      mode: "full",
      minMinor: PUBLIC_REPACK_PRICE_MIN_MINOR,
      maxMinor: PUBLIC_REPACK_PRICE_MAX_MINOR,
    }),
  }),
  sort: "packscout_ev_dollars",
  direction: "desc",
  cursor: null,
  cursorStack: null,
  queryFingerprint: null,
  pageSize: PUBLIC_REPACK_DEFAULT_PAGE_SIZE,
  desiredPublicCollectibleId: null,
  selectedPublicRepackId: null,
});

export type CatalogQueryParseResult =
  | { readonly ok: true; readonly query: ListPublicRepacksInput }
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
    "chase",
    "vendor",
    "category",
    "collectibleType",
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
    "chase",
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

  const minMinor = minRaw === null ? PUBLIC_REPACK_PRICE_MIN_MINOR : parseDollarAmount(minRaw);
  const maxMinor = maxRaw === null ? PUBLIC_REPACK_PRICE_MAX_MINOR : parseDollarAmount(maxRaw);
  if (minMinor === null || maxMinor === null) {
    return { ok: false, message: "The catalog price range is invalid." };
  }

  const sortRaw = parameters.get("sort") ?? DEFAULT_CATALOG_QUERY.sort;
  const directionRaw = parameters.get("direction") ?? DEFAULT_CATALOG_QUERY.direction;
  if (!SORT_KEYS.has(sortRaw as PublicRepackSort) || !["asc", "desc"].includes(directionRaw)) {
    return { ok: false, message: "The catalog sort is invalid." };
  }

  const cursor = parameters.get("cursor");
  const cursorStack = parameters.get("cursorStack");
  const queryFingerprint = parameters.get("queryFingerprint");
  const parsed = listPublicRepacksInputSchema.safeParse({
    search: parameters.get("q") ?? "",
    filters: {
      vendors: canonicalValues(parameters.getAll("vendor")),
      categories: canonicalValues(parameters.getAll("category")),
      collectibleTypes: canonicalValues(parameters.getAll("collectibleType")),
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
    pageSize: PUBLIC_REPACK_DEFAULT_PAGE_SIZE,
    desiredPublicCollectibleId: parameters.get("chase"),
    selectedPublicRepackId: null,
  });

  return parsed.success
    ? { ok: true, query: parsed.data }
    : { ok: false, message: "This catalog link cannot be applied." };
}

export function serializeCatalogQueryState(query: ListPublicRepacksInput): string {
  const parsed = listPublicRepacksInputSchema.parse(query);
  const parameters = new URLSearchParams();
  if (parsed.search) parameters.set("q", parsed.search);
  if (parsed.desiredPublicCollectibleId) {
    parameters.set("chase", parsed.desiredPublicCollectibleId);
  }
  for (const vendor of parsed.filters.vendors) parameters.append("vendor", vendor);
  for (const category of parsed.filters.categories) parameters.append("category", category);
  for (const collectibleType of parsed.filters.collectibleTypes) {
    parameters.append("collectibleType", collectibleType);
  }
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

export function catalogSheetInspectorInitiallyOpen(
  selectedPublicRepackId: ListPublicRepacksInput["selectedPublicRepackId"],
): boolean {
  return selectedPublicRepackId !== null;
}

export function serializeDashboardFilters(
  filters: ListPublicRepacksInput["filters"],
): string {
  const query = listPublicRepacksInputSchema.parse({ filters });
  const allPacksHref = serializeCatalogQueryState(query);
  return allPacksHref === "/packs"
    ? "/"
    : allPacksHref.replace("/packs?", "/?");
}

export function resetCatalogPagination(
  query: ListPublicRepacksInput,
  changes: Partial<
    Pick<
      ListPublicRepacksInput,
      "search" | "filters" | "sort" | "direction" | "desiredPublicCollectibleId"
    >
  >,
): ListPublicRepacksInput {
  return listPublicRepacksInputSchema.parse({
    ...query,
    ...changes,
    cursor: null,
    cursorStack: null,
    queryFingerprint: null,
    selectedPublicRepackId: null,
  });
}

export function nextCatalogPage(
  query: ListPublicRepacksInput,
  nextCursor: string | null,
  queryFingerprint: string,
): ListPublicRepacksInput {
  if (nextCursor === null) return query;
  const previousStarts = query.cursorStack
    ? decodePublicCursorStack(query.cursorStack)
    : [];
  if (previousStarts === null) return query;
  const stack = query.cursor
    ? [...previousStarts, query.cursor]
    : [...previousStarts];
  return listPublicRepacksInputSchema.parse({
    ...query,
    cursor: nextCursor,
    cursorStack: stack.length > 0 ? encodePublicCursorStack(stack) : null,
    queryFingerprint,
  });
}

export function previousCatalogPage(
  query: ListPublicRepacksInput,
  queryFingerprint: string,
): ListPublicRepacksInput {
  const previousStarts = query.cursorStack
    ? decodePublicCursorStack(query.cursorStack)
    : [];
  if (previousStarts === null) return query;
  const stack = [...previousStarts];
  const cursor = stack.pop() ?? null;
  return listPublicRepacksInputSchema.parse({
    ...query,
    cursor,
    cursorStack: stack.length > 0 ? encodePublicCursorStack(stack) : null,
    queryFingerprint,
  });
}
