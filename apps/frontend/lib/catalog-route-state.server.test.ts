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
    pageSize: "50",
  });
  assert.equal(allRepacks.ok, true);
  if (allRepacks.ok) {
    assert.equal(allRepacks.query.search, "mythic pokemon");
    assert.equal(allRepacks.query.pageSize, 50);
  }

  const dashboard = parseDashboardRouteQuery({
    underdog: "",
    vendor: "courtyard",
    minPrice: "25",
    maxPrice: "1000",
  });
  assert.equal(dashboard.ok, true);
  if (dashboard.ok) {
    assert.equal(dashboard.provider, "underdog");
    assert.deepEqual(dashboard.query.filters.vendors, ["courtyard"]);
  }
  const collector = parseDashboardRouteQuery({ collector: "" });
  assert.equal(collector.ok, true);
  if (collector.ok) assert.equal(collector.provider, "collector");
  assert.equal(parseDashboardRouteQuery({ underdog: "promoted" }).ok, false);
  assert.equal(
    parseDashboardRouteQuery({ underdog: "", collector: "" }).ok,
    false,
  );
  assert.equal(parseDashboardRouteQuery({ q: "pokemon" }).ok, false);
  assert.equal(
    parseDashboardRouteQuery({
      chase: "00000000-0000-5000-8000-000000000201",
    }).ok,
    false,
  );
});
