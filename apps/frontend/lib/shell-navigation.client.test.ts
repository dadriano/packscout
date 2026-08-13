import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogSearchHref,
  normalizeCatalogQuery,
  resolveDashboardView,
  resolveGlobalDestination,
  shouldFocusCatalogSearch,
} from "./shell-navigation.client";

test("shell navigation marks only the approved route families", () => {
  assert.equal(resolveGlobalDestination("/"), "dashboard");
  assert.equal(resolveGlobalDestination("/packs"), "dashboard");
  assert.equal(resolveGlobalDestination("/learn"), "learn");
  assert.equal(resolveGlobalDestination("/learn/expected-value"), "learn");
  assert.equal(resolveGlobalDestination("/unknown"), null);

  assert.equal(resolveDashboardView("/"), "overview");
  assert.equal(resolveDashboardView("/packs"), "all-repacks");
  assert.equal(resolveDashboardView("/learn"), null);
});

test("global repack search trims and normalizes a single All Repacks query", () => {
  assert.equal(normalizeCatalogQuery("  mythic   pokemon\n gacha "), "mythic pokemon gacha");
  assert.equal(catalogSearchHref("   "), "/packs");
  assert.equal(catalogSearchHref("One Piece & Magic"), "/packs?q=One+Piece+%26+Magic");
});

test("Command or Control K focuses search without hijacking another form field", () => {
  const shortcut = {
    altKey: false,
    ctrlKey: false,
    key: "k",
    metaKey: true,
    target: null,
  };
  assert.equal(shouldFocusCatalogSearch(shortcut), true);
  assert.equal(shouldFocusCatalogSearch({ ...shortcut, metaKey: false }), false);
  assert.equal(
    shouldFocusCatalogSearch({
      ...shortcut,
      target: { tagName: "INPUT" } as unknown as EventTarget,
    }),
    false,
  );
  assert.equal(
    shouldFocusCatalogSearch({ ...shortcut, altKey: true }),
    false,
  );
});
