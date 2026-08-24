import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The provider tree renders above every page — including the holding surface
 * (closed-beta-access/008), the only page a held signed-in visitor can be
 * on — and the capability gate (closed-beta-access/004) refuses that
 * account's saved-items read as a matter of course. A raw `useQuery` throws
 * a refused read during render, above every error boundary. These assertions
 * pin that the tree's session reads go through the tolerant hook, whose
 * partitioning is behavior-tested in tolerant-query.test.ts.
 */

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const savedItemsSource = source("./AuthenticatedSavedItemsProvider.client.tsx");
const bridgeSource = source("./InitializedPackScoutAuthProvider.client.tsx");
const boundarySource = source("./ConfiguredPackScoutAuthProvider.client.tsx");
const contextSource = source("./AuthContext.client.tsx");

test("a held account's refused session reads are absorbed, never thrown into the tree", () => {
  assert.match(
    savedItemsSource,
    /useTolerantQuery\(\s*api\.savedItems\.getSavedItemIds,\s*signedIn \? \{\} : "skip",\s*\)\.data/,
  );
  assert.match(
    savedItemsSource,
    /useTolerantQuery\(\s*api\.productUsers\.getMyStanding,\s*signedIn \? \{\} : "skip",\s*\)\.data/,
  );
  // The throwing hook is gone from this provider; mutations keep their own
  // per-action error handling.
  assert.doesNotMatch(savedItemsSource, /\buseQuery\b/);
});

test("the session context exposes the verified identity from the provider's own user object", () => {
  assert.match(contextSource, /identity: VerifiedSignInIdentity \| null;/);
  assert.match(
    bridgeSource,
    /verifiedIdentityFromProviderUser\(user\)/,
  );
  // Outside an established session there is nothing to show.
  assert.match(
    bridgeSource,
    /ready && authenticated \? verifiedIdentityFromProviderUser\(user\) : null/,
  );
  assert.match(boundarySource, /identity: null,/);
});

test("a session boot request establishes an existing session but never opens a login", () => {
  assert.match(
    boundarySource,
    /const requestSessionBoot = useCallback\(\s*\(\) => startProvider\(false\),\s*\[startProvider\],\s*\);/,
  );
  // Once initialized, the request has nothing left to do.
  assert.match(bridgeSource, /requestSessionBoot: sessionBootAlreadyDone,/);
  assert.match(contextSource, /requestSessionBoot: noSessionBoot,/);
});
