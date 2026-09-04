import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pageSource = readFileSync(
  new URL("./WatchlistPage.client.tsx", import.meta.url),
  "utf8",
);

test("Watchlist sign-in completes the identity-cookie handoff and re-runs the gate", () => {
  assert.match(pageSource, /decideIdentityHandoff\(\{/u);
  assert.match(pageSource, /cookieToken: readBrowserIdentityCookie\(\),/u);
  assert.match(pageSource, /mountedAtMs: mountedAtMs\.current,/u);
  assert.match(pageSource, /useSyncExternalStore\(/u);
  assert.match(pageSource, /subscribeToIdentityCookieWrites,/u);
  assert.match(pageSource, /IDENTITY_HANDOFF_TIMEOUT_MS/u);
  assert.match(pageSource, /IDENTITY_HANDOFF_MAX_ATTEMPTS/u);
  assert.match(pageSource, /router\.refresh\(\)/u);
  assert.match(pageSource, /surrendered\.current = true;/u);
});
