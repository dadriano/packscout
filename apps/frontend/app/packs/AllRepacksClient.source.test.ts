import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("./AllRepacksClient.client.tsx", import.meta.url), "utf8");

test("all-repacks opens the sheet only from an explicit query selection", () => {
  assert.match(
    source,
    /catalogSheetInspectorInitiallyOpen\(\s*navigationQuery\.selectedPublicRepackId,?\s*\)/,
  );
  assert.match(
    source,
    /initialInspectorOpen \? page\.selectedRepack\?\.publicRepackId \?\? null : null/,
  );
  assert.match(source, /navigate\(selectCatalogRepack\(navigationQuery, publicRepackId\)\)/);
});

test("closing the sheet clears the selected repack from the URL", () => {
  assert.match(source, /setSelectedPublicRepackId\(null\)/);
  assert.match(source, /navigate\(clearCatalogRepackSelection\(navigationQuery\)\)/);
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

test("release-change pagination replaces stale URL state and uses the normalized query", () => {
  assert.match(source, /catalogQueryForPageNavigation\(query, page\)/);
  assert.match(source, /router\.replace\(navigationHref\)/);
  assert.match(
    source,
    /nextCatalogPage\(\s*navigationQuery,\s*page\.nextCursor,\s*page\.queryFingerprint,?\s*\)/,
  );
  assert.match(
    source,
    /previousCatalogPage\(navigationQuery, page\.queryFingerprint\)/,
  );
});

test("nested promo and outbound actions do not select a repack", () => {
  const copyPromo = source.match(
    /async function copyPromo[\s\S]*?(?=\n  function openRepack)/,
  )?.[0];
  const openRepack = source.match(
    /function openRepack[\s\S]*?(?=\n  const noMatches)/,
  )?.[0];
  assert.ok(copyPromo);
  assert.ok(openRepack);
  assert.doesNotMatch(copyPromo, /selectRepack|setInspectorOpen|setSelectedPublicRepackId/);
  assert.doesNotMatch(openRepack, /selectRepack|setInspectorOpen|setSelectedPublicRepackId/);
  assert.doesNotMatch(openRepack, /window\.open/);
});

test("selecting a repack clears feedback from the previously used row action", () => {
  assert.match(
    source,
    /function selectRepack\(publicRepackId: string\) \{[\s\S]*?actionFeedbackRepackIdRef\.current = null;[\s\S]*?setActionFeedback\(""\);/,
  );
  assert.match(
    source,
    /if \(actionFeedbackRepackIdRef\.current === publicRepackId\) \{\s*setActionFeedback/,
  );
});
