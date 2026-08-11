import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CATALOG_QUERY,
  nextCatalogPage,
  parseCatalogQueryState,
  previousCatalogPage,
  resetCatalogPagination,
  serializeCatalogQueryState,
  serializeDashboardFilters,
} from "./catalog-query-state.client";

test("the empty URL restores the complete default catalog query", () => {
  const parsed = parseCatalogQueryState(new URLSearchParams());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.query, DEFAULT_CATALOG_QUERY);
  assert.equal(serializeCatalogQueryState(parsed.query), "/packs");
});

test("query state is normalized and serialized in canonical order", () => {
  const parsed = parseCatalogQueryState(
    new URLSearchParams(
      "category=pokemon&platform=courtyard&q=%20Mythic%20%20Gacha%20&platform=collector_crypt&category=pokemon&minPrice=25.50&maxPrice=2500&sort=pack_price&direction=asc",
    ),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.query.search, "mythic gacha");
  assert.deepEqual(parsed.query.filters.platforms, ["collector_crypt", "courtyard"]);
  assert.deepEqual(parsed.query.filters.categories, ["pokemon"]);
  assert.deepEqual(parsed.query.filters.price, {
    mode: "narrowed",
    minMinor: 2_550,
    maxMinor: 250_000,
  });
  assert.equal(
    serializeCatalogQueryState(parsed.query),
    "/packs?q=mythic+gacha&platform=collector_crypt&platform=courtyard&category=pokemon&minPrice=25.50&maxPrice=2500&sort=pack_price&direction=asc",
  );
});

test("malformed singleton, partial price, unknown key, and cursor state are rejected", () => {
  for (const query of [
    "q=one&q=two",
    "minPrice=10",
    "surprise=true",
    "cursor=page-two",
    "sort=probability",
  ]) {
    assert.equal(parseCatalogQueryState(new URLSearchParams(query)).ok, false, query);
  }
});

test("search, filters, and sorting reset cursor navigation together", () => {
  const paged = {
    ...DEFAULT_CATALOG_QUERY,
    cursor: "page-two",
    cursorStack: "WyJwYWdlLW9uZSJd",
    queryFingerprint: "a".repeat(64),
  };
  const reset = resetCatalogPagination(paged, { search: "pokemon" });
  assert.equal(reset.search, "pokemon");
  assert.equal(reset.cursor, null);
  assert.equal(reset.cursorStack, null);
  assert.equal(reset.queryFingerprint, null);
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

test("Overview serializes only its compatible accepted filters", () => {
  assert.equal(serializeDashboardFilters(DEFAULT_CATALOG_QUERY.filters), "/");
  assert.equal(
    serializeDashboardFilters({
      ...DEFAULT_CATALOG_QUERY.filters,
      platforms: ["courtyard"],
    }),
    "/?platform=courtyard",
  );
});
