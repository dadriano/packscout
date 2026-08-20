import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./CatalogFilters.client.tsx", import.meta.url), "utf8");

test("the reset control becomes a clear-filters trash action for selected filters", () => {
  assert.match(source, /function ClearFiltersIcon/);
  assert.match(source, /hasChosenFilters\(draft\)/);
  assert.match(source, /Clear selected filters/);
  assert.match(source, /hasFilters \? <ClearFiltersIcon \/> : <ResetIcon \/>/);
});
