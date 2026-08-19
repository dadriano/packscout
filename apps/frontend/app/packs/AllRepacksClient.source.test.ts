import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./AllRepacksClient.client.tsx", import.meta.url), "utf8");

test("all-repacks opens the sheet only from an explicit query selection", () => {
  assert.match(
    source,
    /catalogSheetInspectorInitiallyOpen\(query\.selectedPublicRepackId\)/,
  );
  assert.equal(source.includes("page.selectedRepack?.publicRepackId !== undefined"), false);
});
