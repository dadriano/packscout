import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldApplyDesiredCollectibleSearchResults } from "./desired-collectible-search-ui";

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
