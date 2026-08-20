import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const publicCatalogSources = [
  "components/catalog/OpportunityTable.client.tsx",
  "components/catalog/AllRepacksTable.client.tsx",
  "components/catalog/PackInspector.client.tsx",
] as const;

test("keeps dormant Heat components disconnected from public catalog surfaces", () => {
  for (const path of publicCatalogSources) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /RepackHeat/);
    assert.doesNotMatch(source, /\.heat\b/);
  }
});

test("keeps Heat out of the public Learn index composition", () => {
  const source = readFileSync(
    new URL("components/learn/LearnIndex.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bHeat\b/i);
});
