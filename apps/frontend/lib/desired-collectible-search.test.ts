import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDesiredCollectibleSearchRequest } from "./desired-collectible-search";

test("normalizes a bounded desired collectible search request", () => {
  const parsed = parseDesiredCollectibleSearchRequest(
    "https://packscout.example/api/collectibles/search?q=%20Charizard%20%20EX%20",
  );
  assert.deepEqual(parsed, {
    ok: true,
    input: {
      search: "charizard ex",
      collectibleTypes: [],
      limit: 20,
    },
  });
});

test("rejects short, duplicate, missing, and unknown search state", () => {
  for (const url of [
    "https://packscout.example/api/collectibles/search",
    "https://packscout.example/api/collectibles/search?q=c",
    "https://packscout.example/api/collectibles/search?q=charizard&q=pikachu",
    "https://packscout.example/api/collectibles/search?q=charizard&limit=50",
  ]) {
    assert.deepEqual(parseDesiredCollectibleSearchRequest(url), { ok: false });
  }
});
