import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("dashboard routes structured read errors through retry-or-reset recovery", () => {
  const dashboard = source("./page.tsx");
  assert.match(dashboard, /<CatalogResultRecovery/);
  assert.match(dashboard, /error=\{result\}/);
  assert.match(dashboard, /recoveryHref=\{dashboardHref\}/);
  assert.match(dashboard, /recoveryActionLabel="Reset Dashboard"/);
});

test("all-repacks derives a code-specific canonical recovery URL", () => {
  const allRepacks = source("./packs/page.tsx");
  assert.match(
    allRepacks,
    /catalogQueryAfterReadError\(parsed\.query, result\.code\)/,
  );
  assert.match(allRepacks, /serializeCatalogViewState/);
  assert.match(allRepacks, /<CatalogResultRecovery error=\{result\}/);
});
