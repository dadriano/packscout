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
  assert.match(source, /navigate\(selectCatalogRepack\(query, publicRepackId\)\)/);
});

test("closing the sheet clears the selected repack from the URL", () => {
  assert.match(source, /navigate\(clearCatalogRepackSelection\(query\)\)/);
  assert.match(source, /onClose=\{closeInspector\}/);
});

test("all-repacks delegates the desired-chase search to the page heading", () => {
  assert.equal(source.includes("all-repacks-search"), false);
  assert.equal(source.includes("Search all repacks"), false);
  assert.equal(source.includes("<DesiredCollectibleSearch"), false);
});

test("all-repacks supports persistent result layout and page-size choices", () => {
  assert.match(source, /<CatalogResultsControls/);
  assert.match(source, /<AllRepacksCards/);
  assert.match(source, /serializeCatalogViewState/);
  assert.match(source, /changePageSize/);
});
