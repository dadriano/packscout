import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function authProviderSource(name: string): string {
  return readFileSync(
    new URL(`../auth/${name}.client.tsx`, import.meta.url),
    "utf8",
  );
}

const accountProviderSource = readFileSync(
  new URL("./AccountTableColumnLayoutProvider.client.tsx", import.meta.url),
  "utf8",
);

test("every authentication provider mounts a table column layout store", () => {
  for (const provider of [
    "UnavailablePackScoutAuthProvider",
    "ConfiguredPackScoutAuthProvider",
  ]) {
    const source = authProviderSource(provider);
    assert.match(source, /<SessionTableColumnLayoutProvider>/, provider);
  }
  const initialized = authProviderSource("InitializedPackScoutAuthProvider");
  assert.match(initialized, /<AccountTableColumnLayoutProvider>/);
  assert.ok(
    initialized.indexOf("<AuthenticatedSavedItemsProvider") <
      initialized.indexOf("<AccountTableColumnLayoutProvider>"),
    "the account layout store remounts per identity with the saved-items provider",
  );
});

test("account layouts are only read for a signed-in session, and a refused read is absorbed", () => {
  assert.match(accountProviderSource, /const signedIn = auth\.status === "signed_in"/);
  assert.match(
    accountProviderSource,
    /useTolerantQuery\(\s*api\.tableColumnLayouts\.getTableColumnLayouts,\s*signedIn \? \{\} : "skip",\s*\)/,
  );
  assert.match(
    accountProviderSource,
    /const accountAvailable = signedIn && layoutsQuery\.error === undefined/,
  );
  // A held account's refused read must never be thrown into the tree.
  assert.doesNotMatch(accountProviderSource, /\buseQuery\b/);
});

test("a tab layout is adopted into the account once, then removed from the tab", () => {
  assert.match(accountProviderSource, /adoptedTableKeys\.current\.add\(tableKey\)/);
  assert.match(accountProviderSource, /session\.clear\(tableKey\)/);
});
