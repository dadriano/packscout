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

const CATEGORY_ID = "00000000-0000-5000-8000-000000000101";
const COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000201";

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
  assert.equal(reset.selectedPublicRepackId, null);
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
});
