import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./DesiredCollectibleSearch.client.tsx", import.meta.url),
  "utf8",
);

test("outside click aborts in-flight collectible search before applying matches", () => {
  assert.match(source, /shouldApplyDesiredCollectibleSearchResults/);
  assert.match(source, /dismissedRef\.current = true/);
  assert.match(source, /searchControllerRef\.current\?\.abort\(\)/);
  assert.match(source, /closeOnOutsidePress/);
});
