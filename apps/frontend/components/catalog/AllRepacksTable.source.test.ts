import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./AllRepacksTable.client.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(
  new URL("./AllRepacksTable.module.css", import.meta.url),
  "utf8",
);

test("published repack actions retain native safe-link behavior", () => {
  assert.match(source, /<a[\s\S]*?href=\{repackHref\}[\s\S]*?target="_blank"[\s\S]*?>/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(
    source,
    /onClick=\{\(\) => onOpenRepack\(repack\.publicRepackId\)\}/,
  );
});

test("table delegates confidence evidence and removes its inline explanation", () => {
  assert.match(source, /import \{ CatalogConfidenceEvidence \}/);
  assert.match(
    source,
    /<CatalogConfidenceEvidence[\s\S]*?estimate=\{estimate\}[\s\S]*?providerHealth=\{repack\.providerHealth\}[\s\S]*?repackName=\{repack\.name\}/,
  );
  assert.doesNotMatch(source, /styles\.evidenceNote/);
  assert.doesNotMatch(source, /styles\.providerWarning/);
  assert.doesNotMatch(source, /showStatusNote/);
});

test("table thumbnails use the shared failure-aware catalog image", () => {
  assert.match(source, /import \{ CatalogImage \}/);
  assert.match(
    source,
    /<CatalogImage[\s\S]*?fallbackAlt=\{repack\.name\}[\s\S]*?image=\{repack\.primaryImage\}[\s\S]*?variant="thumbnail"/,
  );
  assert.doesNotMatch(source, /from "next\/image"/);
});

test("horizontal scrolling does not contain the shared fixed hint panel", () => {
  assert.doesNotMatch(styles, /\bcontain\s*:/);
  assert.doesNotMatch(styles, /container-type\s*:/);
  assert.match(styles, /\.scroller \{[\s\S]*?overflow-x: auto;/);
  assert.match(styles, /\.table \{[\s\S]*?min-width: 1760px;/);
});

test("desired chase matches open the chase inspector instead of the pack sheet", () => {
  assert.match(source, /onInspectChase\?:/);
  assert.match(
    source,
    /aria-label=\{`View chase \$\{displayedChase\.collectible\.name\}`\}/,
  );
  assert.match(
    source,
    /onInspectChase\(\s*displayedChase\.collectible\.publicCollectibleId,\s*event\.currentTarget,?\s*\)/,
  );
});
