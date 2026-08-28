import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CATALOG_QUERY,
  catalogHrefForSummary,
  catalogSheetInspectorInitiallyOpen,
  clearCatalogRepackSelection,
  nextCatalogPage,
  parseCatalogViewLayout,
  parseCatalogQueryState,
  previousCatalogPage,
  resetCatalogPagination,
  selectCatalogRepack,
  serializeCatalogQueryState,
  serializeCatalogViewState,
  serializeDashboardFilters,
} from "./catalog-query-state.client";

const CATEGORY_ID = "00000000-0000-5000-8000-000000000101";
const COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000201";
const REPACK_ID = "00000000-0000-5000-8000-000000000301";

test("the empty URL restores the complete default repack query", () => {
  const parsed = parseCatalogQueryState(new URLSearchParams());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.query, DEFAULT_CATALOG_QUERY);
  assert.equal(serializeCatalogQueryState(parsed.query), "/packs");
});

test("query state is normalized and serialized in canonical order", () => {
  const parameters = new URLSearchParams();
  parameters.append("category", CATEGORY_ID);
  parameters.append("vendor", "courtyard");
  parameters.set("q", " Mythic  Gacha ");
  parameters.append("vendor", "collector_crypt");
  parameters.append("category", CATEGORY_ID);
  parameters.append("collectibleType", "card");
  parameters.set("minPrice", "25.50");
  parameters.set("maxPrice", "2500");
  parameters.set("sort", "repack_price");
  parameters.set("direction", "asc");

  const parsed = parseCatalogQueryState(parameters);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.query.search, "mythic gacha");
  assert.deepEqual(parsed.query.filters.vendors, ["collector_crypt", "courtyard"]);
  assert.deepEqual(parsed.query.filters.categories, [CATEGORY_ID]);
  assert.deepEqual(parsed.query.filters.collectibleTypes, ["card"]);
  assert.deepEqual(parsed.query.filters.price, {
    mode: "narrowed",
    minMinor: 2_550,
    maxMinor: 250_000,
  });
  assert.equal(
    serializeCatalogQueryState(parsed.query),
    `/packs?q=mythic+gacha&vendor=collector_crypt&vendor=courtyard&category=${CATEGORY_ID}&collectibleType=card&minPrice=25.50&maxPrice=2500&sort=repack_price&direction=asc`,
  );
});

test("non-available repacks stay hidden unless the URL opts into every availability", () => {
  const parsed = parseCatalogQueryState(new URLSearchParams());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.query.filters.availability, "available");

  const including = parseCatalogQueryState(new URLSearchParams("availability=all"));
  assert.equal(including.ok, true);
  if (!including.ok) return;
  assert.equal(including.query.filters.availability, "all");
  assert.equal(
    serializeCatalogQueryState(including.query),
    "/packs?availability=all",
  );
});

test("selected repack survives canonical URL parsing until filters are revised", () => {
  const selected = selectCatalogRepack(DEFAULT_CATALOG_QUERY, REPACK_ID);
  expectSelectionLifecycle(selected);

  const parsed = parseCatalogQueryState(
    new URLSearchParams(`selected=${REPACK_ID}`),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  expectSelectionLifecycle(parsed.query);

  function expectSelectionLifecycle(
    query: ReturnType<typeof selectCatalogRepack>,
  ) {
    assert.equal(query.selectedPublicRepackId, REPACK_ID);
    assert.equal(
      serializeCatalogQueryState(query),
      `/packs?selected=${REPACK_ID}`,
    );
    const revised = resetCatalogPagination(query, {
      filters: { ...query.filters, availability: "all" },
    });
    assert.equal(revised.selectedPublicRepackId, null);
    assert.equal(
      serializeCatalogQueryState(revised),
      "/packs?availability=all",
    );
  }
});

test("closing the sheet clears only the selected repack from the query", () => {
  const selected = selectCatalogRepack(
    nextCatalogPage(DEFAULT_CATALOG_QUERY, "page-two", "d".repeat(64)),
    REPACK_ID,
  );
  const cleared = clearCatalogRepackSelection(selected);
  assert.deepEqual(cleared, { ...selected, selectedPublicRepackId: null });
  assert.equal(serializeCatalogQueryState(cleared).includes("selected"), false);
});

test("catalog page size and view are constrained, canonical URL state", () => {
  const cards = parseCatalogQueryState(new URLSearchParams("pageSize=50&view=cards"));
  assert.equal(cards.ok, true);
  if (!cards.ok) return;
  assert.equal(cards.query.pageSize, 50);
  assert.equal(parseCatalogViewLayout("cards"), "cards");
  assert.equal(
    serializeCatalogViewState(cards.query, "cards"),
    "/packs?pageSize=50&view=cards",
  );
  assert.equal(parseCatalogViewLayout(null), "table");
  assert.equal(parseCatalogQueryState(new URLSearchParams("pageSize=13")).ok, false);
  assert.equal(parseCatalogQueryState(new URLSearchParams("view=list")).ok, false);
});

test("malformed singleton, partial price, unknown key, and cursor state are rejected", () => {
  for (const query of [
    "q=one&q=two",
    "minPrice=10",
    "surprise=true",
    "cursor=page-two",
    "sort=probability",
    "availability=available",
    "availability=sold_out",
    "availability=all&availability=available",
    "selected=not-a-public-repack-id",
    `selected=${REPACK_ID}&selected=${REPACK_ID}`,
    "pageSize=25&pageSize=50",
    "view=table&view=cards",
  ]) {
    assert.equal(parseCatalogQueryState(new URLSearchParams(query)).ok, false, query);
  }
});

test("saved links using the retired pre-buyback vendor sort reset instead of reinterpreting", () => {
  const parsed = parseCatalogQueryState(
    new URLSearchParams("sort=vendor_reported_ev_percent"),
  );
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.message, "The catalog sort is invalid.");
});

test("search, filters, and sorting reset cursor navigation together", () => {
  const paged = {
    ...DEFAULT_CATALOG_QUERY,
    cursor: "page-two",
    cursorStack: "WyJwYWdlLW9uZSJd",
    queryFingerprint: "a".repeat(64),
    selectedPublicRepackId: REPACK_ID,
  };
  const reset = resetCatalogPagination(paged, { search: "pokemon" });
  assert.equal(reset.search, "pokemon");
  assert.equal(reset.cursor, null);
  assert.equal(reset.cursorStack, null);
  assert.equal(reset.queryFingerprint, null);
  assert.equal(reset.selectedPublicRepackId, null);
});

test("changing page size resets cursor navigation before a new page is read", () => {
  const reset = resetCatalogPagination(
    {
      ...DEFAULT_CATALOG_QUERY,
      cursor: "page-two",
      cursorStack: "WyJwYWdlLW9uZSJd",
      queryFingerprint: "a".repeat(64),
    },
    { pageSize: 50 },
  );
  assert.equal(reset.pageSize, 50);
  assert.equal(reset.cursor, null);
  assert.equal(reset.cursorStack, null);
  assert.equal(reset.queryFingerprint, null);
});

test("exact desired chase selection uses a stable collectible ID and resets pagination", () => {
  const selected = resetCatalogPagination(
    {
      ...DEFAULT_CATALOG_QUERY,
      cursor: "page-two",
      queryFingerprint: "c".repeat(64),
    },
    { desiredPublicCollectibleId: COLLECTIBLE_ID },
  );
  assert.equal(selected.desiredPublicCollectibleId, COLLECTIBLE_ID);
  assert.equal(selected.cursor, null);
  assert.equal(selected.queryFingerprint, null);
  assert.equal(
    serializeCatalogQueryState(selected),
    `/packs?chase=${COLLECTIBLE_ID}`,
  );
  const parsed = parseCatalogQueryState(
    new URLSearchParams(`chase=${COLLECTIBLE_ID}`),
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.query.desiredPublicCollectibleId, COLLECTIBLE_ID);
  }
  assert.equal(
    parseCatalogQueryState(new URLSearchParams("chase=charizard")).ok,
    false,
  );
});

test("selecting a desired chase clears an incompatible top-chase-value sort", () => {
  const selected = resetCatalogPagination(
    {
      ...DEFAULT_CATALOG_QUERY,
      sort: "top_chase_value",
      direction: "asc",
    },
    {
      desiredPublicCollectibleId: COLLECTIBLE_ID,
      sort: "packscout_ev_dollars",
      direction: "desc",
    },
  );
  assert.equal(selected.desiredPublicCollectibleId, COLLECTIBLE_ID);
  assert.equal(selected.sort, "packscout_ev_dollars");
  assert.equal(selected.direction, "desc");
  assert.equal(
    parseCatalogQueryState(
      new URLSearchParams(
        `chase=${COLLECTIBLE_ID}&sort=top_chase_value`,
      ),
    ).ok,
    false,
  );
});

test("cursor navigation keeps a bounded stack of prior non-initial page starts", () => {
  const fingerprint = "b".repeat(64);
  const pageTwo = nextCatalogPage(DEFAULT_CATALOG_QUERY, "page-two", fingerprint);
  assert.equal(pageTwo.cursor, "page-two");
  assert.equal(pageTwo.cursorStack, null);

  const pageThree = nextCatalogPage(pageTwo, "page-three", fingerprint);
  assert.ok(pageThree.cursorStack);
  const backToTwo = previousCatalogPage(pageThree, fingerprint);
  assert.equal(backToTwo.cursor, "page-two");
  assert.equal(backToTwo.cursorStack, null);

  const backToOne = previousCatalogPage(backToTwo, fingerprint);
  assert.equal(backToOne.cursor, null);
  assert.equal(backToOne.cursorStack, null);
});

test("Overview serializes only compatible accepted filters", () => {
  assert.equal(serializeDashboardFilters(DEFAULT_CATALOG_QUERY.filters), "/");
  assert.equal(
    serializeDashboardFilters({
      ...DEFAULT_CATALOG_QUERY.filters,
      vendors: ["courtyard"],
    }),
    "/?vendor=courtyard",
  );
  assert.equal(
    serializeDashboardFilters(DEFAULT_CATALOG_QUERY.filters, "underdog"),
    "/?underdog",
  );
  assert.equal(
    serializeDashboardFilters(
      {
        ...DEFAULT_CATALOG_QUERY.filters,
        vendors: ["collector_crypt"],
      },
      "collector",
    ),
    "/?collector&vendor=collector_crypt",
  );
});

test("summary links replace their own dimension and preserve other catalog filters", () => {
  const activeFilters = {
    ...DEFAULT_CATALOG_QUERY.filters,
    vendors: ["collector_crypt"],
    categories: [CATEGORY_ID],
    collectibleTypes: ["card"] as const,
    availability: "all" as const,
  };
  const vendor = new URL(catalogHrefForSummary(activeFilters, {
    type: "vendor",
    key: "courtyard",
  }), "https://packscout.test").searchParams;
  assert.deepEqual(vendor.getAll("vendor"), ["courtyard"]);
  assert.deepEqual(vendor.getAll("category"), [CATEGORY_ID]);
  assert.deepEqual(vendor.getAll("collectibleType"), ["card"]);
  assert.equal(vendor.get("availability"), "all");

  const category = new URL(catalogHrefForSummary(activeFilters, {
    type: "category",
    key: "00000000-0000-5000-8000-000000000102",
  }), "https://packscout.test").searchParams;
  assert.deepEqual(category.getAll("vendor"), ["collector_crypt"]);
  assert.deepEqual(category.getAll("category"), ["00000000-0000-5000-8000-000000000102"]);
});

test("the all-repacks sheet stays closed unless the query asked for a specific pack", () => {
  assert.equal(
    catalogSheetInspectorInitiallyOpen(DEFAULT_CATALOG_QUERY.selectedPublicRepackId),
    false,
  );
  assert.equal(
    catalogSheetInspectorInitiallyOpen("00000000-0000-5000-8000-000000000301"),
    true,
  );
});
