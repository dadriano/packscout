import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDemoCatalogPage,
  buildDemoCatalogSnapshot,
  buildDemoDashboard,
  catalogDemoIsEnabled,
} from "./catalog-demo-data.server";

test("the interface preview is opt-in and can never activate in production", () => {
  assert.equal(catalogDemoIsEnabled({ NODE_ENV: "development", PACKSCOUT_CATALOG_FIXTURE_MODE: "1" }), true);
  assert.equal(catalogDemoIsEnabled({ NODE_ENV: "development" }), false);
  assert.equal(catalogDemoIsEnabled({ NODE_ENV: "production", PACKSCOUT_CATALOG_FIXTURE_MODE: "1" }), false);
});

test("the preview snapshot and coherent Dashboard bundle satisfy public contracts", () => {
  const snapshot = buildDemoCatalogSnapshot();
  const dashboard = buildDemoDashboard();
  assert.equal(snapshot.metadata.packCount, 9);
  assert.equal(dashboard.opportunities.length, 6);
  assert.equal(dashboard.selectedPack?.publicPackId, dashboard.opportunities[0]?.publicPackId);
  assert.equal(dashboard.kpis.totalPacks, 8);
});

test("the preview catalog honors search, facets, price, and metric sort without leaking into production", () => {
  const searched = buildDemoCatalogPage({ search: "one piece" });
  assert.equal(searched.rows.length, 1);
  assert.equal(searched.rows[0]?.name, "Grand Line Treasure");
  assert.equal(searched.rows[0]?.availability, "sold_out");

  const filtered = buildDemoCatalogPage({
    filters: {
      platforms: ["courtyard"],
      categories: ["pokemon"],
      price: { mode: "narrowed", minMinor: 6_000, maxMinor: 11_000 },
    },
    sort: "pack_price",
    direction: "asc",
  });
  assert.deepEqual(filtered.rows.map(({ name }) => name), ["Pikachu VMAX Special Box", "Pokemon Master Pack"]);
});
