import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./AllRepacksTable.client.tsx", import.meta.url),
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
