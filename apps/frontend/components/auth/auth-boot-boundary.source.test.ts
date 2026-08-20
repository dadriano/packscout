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

test("an authenticated session reaches the product-user directory", () => {
  assert.match(
    initializedSource,
    /const sessionKey = convexAuthSessionKey\(\{/,
  );
  assert.match(
    initializedSource,
    /<AuthenticatedSignInRecorder sessionKey=\{sessionKey\}>[\s\S]*<AuthenticatedSavedItemsProvider[\s\S]*<\/AuthenticatedSignInRecorder>/,
  );
  assert.match(recorderSource, /api\.productUsers\.recordSignIn/);
});

test("recording stays invisible and cannot break the provider tree", () => {
  // The write only leaves on a decision, and only through the helper that
  // absorbs failures, so nothing here can surface an error to the session.
  assert.match(recorderSource, /if \(!decision\.record\) return;/);
  assert.match(
    recorderSource,
    /void recordSignInBestEffort\(\(\) => recordSignIn\(\{\}\)\);/,
  );
  assert.equal(recorderSource.match(/recordSignIn\(\{\}\)/g)?.length, 1);
  assert.equal(recorderSource.includes("catch"), false);
  // Children render unconditionally: the recorder contributes no markup.
  assert.match(recorderSource, /return <>\{children\}<\/>;/);
  assert.equal(recorderSource.includes("className"), false);
  assert.equal(recorderSource.includes("aria-"), false);
});
