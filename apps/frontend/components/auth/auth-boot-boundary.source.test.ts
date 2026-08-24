import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const boundarySource = readFileSync(
  new URL("./ConfiguredPackScoutAuthProvider.client.tsx", import.meta.url),
  "utf8",
);
const providerBoundarySource = readFileSync(
  new URL("./AuthProviderBoundary.client.tsx", import.meta.url),
  "utf8",
);
const initializedSource = readFileSync(
  new URL("./InitializedPackScoutAuthProvider.client.tsx", import.meta.url),
  "utf8",
);
const recorderSource = readFileSync(
  new URL("./AuthenticatedSignInRecorder.client.tsx", import.meta.url),
  "utf8",
);
const accountSource = readFileSync(
  new URL("./AccountControl.client.tsx", import.meta.url),
  "utf8",
);
const savedButtonSource = readFileSync(
  new URL("./SavedItemButton.client.tsx", import.meta.url),
  "utf8",
);

test("the configured public boundary has no eager Privy or Convex client import", () => {
  assert.match(
    providerBoundarySource,
    /import \{ ConfiguredPackScoutAuthProvider \} from "\.\/ConfiguredPackScoutAuthProvider\.client"/,
  );
  assert.equal(providerBoundarySource.includes("lazy("), false);
  assert.equal(boundarySource.includes("@privy-io/react-auth"), false);
  assert.equal(boundarySource.includes('from "convex/react"'), false);
  assert.match(
    boundarySource,
    /import\(\s*"\.\/InitializedPackScoutAuthProvider\.client"\s*\)/,
  );
  assert.match(initializedSource, /from "@privy-io\/react-auth"/);
  assert.match(initializedSource, /from "convex\/react"/);
});

test("both account and guest save controls send the same boot intent", () => {
  assert.match(accountSource, /auth\.login\(\)/);
  assert.match(savedButtonSource, /auth\.login\(\)/);
});

test("an authenticated session establishes its directory record and admission decision", () => {
  assert.match(
    initializedSource,
    /const sessionKey = convexAuthSessionKey\(\{/,
  );
  assert.match(
    initializedSource,
    /<AuthenticatedSignInRecorder sessionKey=\{sessionKey\}>[\s\S]*<AuthenticatedSavedItemsProvider[\s\S]*<\/AuthenticatedSignInRecorder>/,
  );
  // Establishment (closed-beta-access/001) is the directory write plus the
  // awaiting-review default, so session recording keeps the record the
  // server-side gate routes on fresh.
  assert.match(recorderSource, /api\.productUserAccess\.establishAccess/);
  assert.equal(recorderSource.includes("api.productUsers.recordSignIn"), false);
});

test("recording stays invisible and cannot break the provider tree", () => {
  // The write only leaves on a decision, and only through the helper that
  // absorbs failures, so nothing here can surface an error to the session.
  assert.match(recorderSource, /if \(!decision\.record\) return;/);
  assert.match(
    recorderSource,
    /void recordSignInBestEffort\(\(\) => establishAccess\(\{\}\)\)/,
  );
  assert.equal(recorderSource.match(/establishAccess\(\{\}\)/g)?.length, 1);
  assert.equal(recorderSource.includes("catch"), false);
  // Children render unconditionally: the recorder contributes no markup.
  assert.match(recorderSource, /return <>\{children\}<\/>;/);
  assert.equal(recorderSource.includes("className"), false);
  assert.equal(recorderSource.includes("aria-"), false);
});

test("a failed sign-in record is retried on a timer the effect owns", () => {
  // The outcome of the write decides what happens next, so a rejection is no
  // longer indistinguishable from a completed write.
  assert.match(recorderSource, /settleSignInRecording\(/);
  // The retry is scheduled, never spun, and both the budget and the wait come
  // from the logic module rather than from anything hard-coded here.
  assert.match(recorderSource, /setTimeout\(attempt, settled\.retryDelayMs\)/);
  assert.equal(/\bwhile\s*\(|\bfor\s*\(/.test(recorderSource), false);
  assert.equal(/setTimeout\([^)]*\d/.test(recorderSource), false);
  // An unmount or a changed session drops the pending retry.
  assert.match(recorderSource, /clearTimeout\(retryTimer\)/);
  assert.match(recorderSource, /return \(\) => \{/);
});

test("the identity cookie follows the session and only exists inside the initialized tree", () => {
  const cookieSyncSource = readFileSync(
    new URL("./IdentityCookieSync.client.tsx", import.meta.url),
    "utf8",
  );
  // The sync component mounts inside the lazily-booted provider, so a
  // signed-out visitor who never asks for authentication never runs it.
  assert.match(initializedSource, /<IdentityAccessCookieSync \/>/);
  assert.equal(boundarySource.includes("IdentityAccessCookieSync"), false);
  // The cookie is written from the provider-issued token, refreshed while
  // the tab lives, and cleared the moment the session ends or sign-out runs.
  assert.match(cookieSyncSource, /getAccessToken/);
  assert.match(cookieSyncSource, /buildIdentityCookieValue/);
  assert.match(cookieSyncSource, /IDENTITY_COOKIE_REFRESH_INTERVAL_MS/);
  assert.match(cookieSyncSource, /visibilitychange/);
  assert.match(cookieSyncSource, /clearBrowserIdentityCookie/);
  assert.match(initializedSource, /clearBrowserIdentityCookie\(\);/);
  // Transport, not trust: nothing here decides admission client-side.
  assert.equal(cookieSyncSource.includes("admitted"), false);
  assert.equal(cookieSyncSource.includes("getMyAccess"), false);
});
