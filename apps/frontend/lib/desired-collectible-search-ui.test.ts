import assert from "node:assert/strict";
import { test } from "node:test";
import {
  desiredCollectibleSearchStatusCopy,
  shouldApplyDesiredCollectibleSearchResults,
} from "./desired-collectible-search-ui";

test("in-flight desired collectible matches are ignored after abort or dismiss", () => {
  assert.equal(
    shouldApplyDesiredCollectibleSearchResults({
      aborted: false,
      dismissed: false,
    }),
    true,
  );
  assert.equal(
    shouldApplyDesiredCollectibleSearchResults({
      aborted: true,
      dismissed: false,
    }),
    false,
  );
  assert.equal(
    shouldApplyDesiredCollectibleSearchResults({
      aborted: false,
      dismissed: true,
    }),
    false,
  );
});

test("an exact desired-chase selection wins over stale loading state", () => {
  assert.equal(
    desiredCollectibleSearchStatusCopy({
      exactSelectedName: true,
      optionCount: 8,
      searchable: false,
      selectedIdentity: "Example card, PSA 10",
      status: "loading",
    }),
    "Selected desired chase: Example card, PSA 10.",
  );
  assert.equal(
    desiredCollectibleSearchStatusCopy({
      exactSelectedName: false,
      optionCount: 0,
      searchable: true,
      selectedIdentity: null,
      status: "loading",
    }),
    "Searching collectibles…",
  );
});
