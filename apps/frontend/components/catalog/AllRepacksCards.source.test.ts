import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./AllRepacksCards.client.tsx", import.meta.url),
  "utf8",
);

test("card layout keeps the selectable repack and core comparison metrics", () => {
  assert.match(source, /onSelect\(repack\.publicRepackId, event\.currentTarget\)/);
  assert.match(source, /metric=\{estimate\.evDollars\}/);
  assert.match(source, /metric=\{estimate\.evPercent\}/);
  assert.match(source, /metric=\{buyback\}/);
});
