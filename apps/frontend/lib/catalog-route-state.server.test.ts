import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAllPacksRouteQuery,
  parseDashboardRouteQuery,
  toUrlSearchParams,
} from "./catalog-route-state.server";

test("Next route parameters preserve repeated facets", () => {
  const parameters = toUrlSearchParams({
    platform: ["courtyard", "collector_crypt"],
    q: "pokemon",
    ignored: undefined,
  });
  assert.deepEqual(parameters.getAll("platform"), ["courtyard", "collector_crypt"]);
  assert.equal(parameters.get("q"), "pokemon");
});

test("All Packs accepts canonical state while Overview accepts compatible filters only", () => {
  const allPacks = parseAllPacksRouteQuery({
    q: " Mythic  Pokemon ",
    platform: ["courtyard", "collector_crypt"],
    sort: "pack_price",
    direction: "asc",
  });
  assert.equal(allPacks.ok, true);
  if (allPacks.ok) assert.equal(allPacks.query.search, "mythic pokemon");

  const dashboard = parseDashboardRouteQuery({
    platform: "courtyard",
    minPrice: "25",
    maxPrice: "1000",
  });
  assert.equal(dashboard.ok, true);
  if (dashboard.ok) assert.deepEqual(dashboard.query.filters.platforms, ["courtyard"]);
  assert.equal(parseDashboardRouteQuery({ q: "pokemon" }).ok, false);
});
