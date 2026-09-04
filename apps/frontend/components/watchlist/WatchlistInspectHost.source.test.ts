import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("./WatchlistInspectHost.client.tsx", import.meta.url),
  "utf8",
);

test("Watchlist pack inspect loads through the gated pack-detail route", () => {
  assert.match(
    source,
    /fetch\(`\/api\/repacks\/\$\{encodeURIComponent\(request\.publicRepackId\)\}`/,
  );
  assert.match(source, /credentials: "same-origin"/);
  assert.match(source, /parsePublicRepackDetailResponse/);
  assert.match(source, /placement="sheet"/);
  assert.match(source, /key=\{`\$\{request\.publicRepackId\}:\$\{retryKey\}`\}/);
  assert.match(source, /registerPackOpener/);
  assert.doesNotMatch(source, /setLoad\(\{ status: "loading" \}\)/);
});
