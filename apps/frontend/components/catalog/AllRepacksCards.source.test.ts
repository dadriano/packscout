import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./AllRepacksCards.client.tsx", import.meta.url),
  "utf8",
);

test("card layout keeps the selectable repack and core comparison metrics", () => {
  assert.match(source, /onSelect\(repack\.publicRepackId, event\.currentTarget\)/);
  assert.match(source, /metric=\{grossEv\.evDollars\}/);
  assert.match(source, /metric=\{grossEv\.evPercent\}/);
  assert.match(source, /metric=\{buyback\}/);
});

test("cards delegate confidence evidence and keep explanations out of the layout", () => {
  assert.match(source, /import \{ CatalogConfidenceEvidence \}/);
  assert.match(
    source,
    /<CatalogConfidenceEvidence[\s\S]*?estimate=\{estimate\}[\s\S]*?providerHealth=\{repack\.providerHealth\}[\s\S]*?repackName=\{repack\.name\}/,
  );
  assert.doesNotMatch(source, /className=\{styles\.evidence\}/);
  assert.doesNotMatch(source, /<dt>Estimate<\/dt>/);
});

test("desired chase names on cards open the chase inspector", () => {
  assert.match(source, /onInspectChase\?:/);
  assert.match(
    source,
    /aria-label=\{`View chase \$\{displayedChase\.collectible\.name\}`\}/,
  );
});
