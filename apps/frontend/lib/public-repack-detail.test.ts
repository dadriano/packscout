import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePublicRepackDetailRequest } from "./public-repack-detail";

const REPACK_ID = "00000000-0000-5000-8000-000000000101";

test("accepts a bounded public repack id with no extra request state", () => {
  const parsed = parsePublicRepackDetailRequest(
    `https://packscout.example/api/repacks/${REPACK_ID}`,
  );
  assert.deepEqual(parsed, {
    ok: true,
    input: { publicRepackId: REPACK_ID },
  });
});

test("rejects missing, malformed, or extra pack-detail request state", () => {
  for (const url of [
    "https://packscout.example/api/repacks",
    "https://packscout.example/api/repacks/not-a-uuid",
    "https://packscout.example/api/repacks/00000000-0000-4000-8000-000000000101",
    `https://packscout.example/api/repacks/${REPACK_ID}?selected=1`,
    `https://packscout.example/api/packs/${REPACK_ID}`,
  ]) {
    assert.deepEqual(parsePublicRepackDetailRequest(url), { ok: false }, url);
  }
});
