import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAllRepacksRouteQuery,
  parseDashboardRouteQuery,
  toUrlSearchParams,
} from "./catalog-route-state.server";

test("Next route parameters preserve repeated facets", () => {
  const parameters = toUrlSearchParams({
    vendor: ["courtyard", "collector_crypt"],
    q: "pokemon",
    ignored: undefined,
  });
  assert.deepEqual(parameters.getAll("vendor"), ["courtyard", "collector_crypt"]);
  assert.equal(parameters.get("q"), "pokemon");
});

test("All Repacks accepts search while Overview accepts compatible filters only", () => {
  const allRepacks = parseAllRepacksRouteQuery({
    q: " Mythic  Pokemon ",
    vendor: ["courtyard", "collector_crypt"],
    sort: "repack_price",
    direction: "asc",
  });
  assert.equal(allRepacks.ok, true);
  if (allRepacks.ok) assert.equal(allRepacks.query.search, "mythic pokemon");

  const dashboard = parseDashboardRouteQuery({
    vendor: "courtyard",
    minPrice: "25",
    maxPrice: "1000",
  });
  assert.equal(dashboard.ok, true);
  if (dashboard.ok) assert.deepEqual(dashboard.query.filters.vendors, ["courtyard"]);
  assert.equal(parseDashboardRouteQuery({ q: "pokemon" }).ok, false);
  assert.equal(
    parseDashboardRouteQuery({
      chase: "00000000-0000-5000-8000-000000000201",
    }).ok,
    false,
  );
});
