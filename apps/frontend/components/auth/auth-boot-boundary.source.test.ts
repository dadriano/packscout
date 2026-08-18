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
