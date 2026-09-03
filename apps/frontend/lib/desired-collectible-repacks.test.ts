import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDesiredCollectibleRepacksRequest } from "./desired-collectible-repacks";

const COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000201";

test("accepts a bounded collectible id and requests the full match page", () => {
  const parsed = parseDesiredCollectibleRepacksRequest(
    `https://packscout.example/api/collectibles/${COLLECTIBLE_ID}/repacks`,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.input.publicCollectibleId, COLLECTIBLE_ID);
  assert.equal(parsed.input.limit, 50);
  assert.equal(parsed.input.sort, "match_confidence");
});

test("rejects missing, malformed, or extra collectible-repack request state", () => {
  for (const url of [
    "https://packscout.example/api/collectibles/repacks",
    "https://packscout.example/api/collectibles/not-a-uuid/repacks",
    "https://packscout.example/api/collectibles/00000000-0000-4000-8000-000000000201/repacks",
    `https://packscout.example/api/collectibles/${COLLECTIBLE_ID}/repacks?limit=10`,
    `https://packscout.example/api/collectibles/${COLLECTIBLE_ID}/packs`,
  ]) {
    assert.deepEqual(parseDesiredCollectibleRepacksRequest(url), { ok: false }, url);
  }
});
