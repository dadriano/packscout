import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./DashboardOverviewClient.client.tsx", import.meta.url),
  "utf8",
);

test("dashboard filter misses render the shared no-matches recovery", () => {
  assert.match(source, /if \(bundle\.kpis\.totalRepacks === 0\)/);
  assert.match(source, /<NoMatches/);
  assert.match(source, /constraints=\{activeConstraints\(bundle\.activeFilters\)\}/);
  assert.match(source, /onClearFilters=\{resetFilters\}/);
});

test("dashboard telemetry counts the availability constraint", () => {
  assert.match(source, /Number\(filters\.availability === "all"\)/);
  assert.match(source, /0 \| 1 \| 2 \| 3 \| 4 \| 5/);
});
