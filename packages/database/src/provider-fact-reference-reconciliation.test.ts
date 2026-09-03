import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderQueryClient } from "./provider-database.ts";
import { resolveProviderFactReferencesBatch } from "./provider-fact-reference-reconciliation.ts";

const target = (index: number) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  key: `target-${String(index).padStart(4, "0")}`,
});
function harness(packs: number, collectibles: number, matches = 0) {
  const queries: ProviderPrisma.Sql[] = [];
  const client = { async $queryRaw(query: ProviderPrisma.Sql) {
    queries.push(query);
    if (query.sql.includes("SELECT id,")) {
      return Array.from({ length: query.sql.includes("FROM packs") ? packs : collectibles }, (_, i) => target(i));
    }
    return Array.from({ length: matches }, (_, i) => ({ id: target(i).id, row_version: 2n }));
  } } as unknown as Pick<ProviderQueryClient, "$queryRaw">;
  return { client, queries };
}

test("empty catalog and an empty explicit target scope do not query the fact history", async () => {
  const f = harness(0, 0);
  assert.deepEqual(await resolveProviderFactReferencesBatch(f.client), {
    pulls: [], pullItems: [], marketEventPacks: [], marketEventCollectibles: [], nextScanCursor: null,
  });
  assert.equal(f.queries.length, 2);
  assert.ok(f.queries.every((query) => !/\b(pulls|pull_items|market_events)\b/u.test(query.sql)));
  f.queries.length = 0;
  await resolveProviderFactReferencesBatch(f.client, { targets: { packKeys: [], collectibleKeys: [] } });
  assert.equal(f.queries.length, 0);
});

test("a no-match target page advances its keyset rather than falsely reporting completion", async () => {
  const f = harness(0, 251);
  const result = await resolveProviderFactReferencesBatch(f.client);
  assert.equal(result.pullItems.length + result.marketEventCollectibles.length, 0);
  assert.deepEqual(result.nextScanCursor, {
    packs: { afterKey: null, done: true }, collectibles: { afterKey: target(249).key, done: false },
  });
  f.queries.length = 0;
  await resolveProviderFactReferencesBatch(f.client, { after: result.nextScanCursor! });
  assert.equal(f.queries.filter((query) => query.sql.includes("SELECT id,")).length, 1);
  assert.ok(f.queries[0]!.values.includes(target(249).key));
  assert.match(f.queries[0]!.sql, /collectible_key > \?/u);
});

test("full relationship batches keep the same target keyset until all fanout is drained", async () => {
  const f = harness(1, 1, 500);
  const result = await resolveProviderFactReferencesBatch(f.client);
  assert.deepEqual(result.nextScanCursor, {
    packs: { afterKey: null, done: false }, collectibles: { afterKey: null, done: false },
  });
});

test("indexed probes cap both catalog targets and fact updates, retaining locks and row versions", async () => {
  const f = harness(251, 251);
  await resolveProviderFactReferencesBatch(f.client);
  for (const query of f.queries.slice(0, 2)) {
    assert.match(query.sql, /ORDER BY (?:pack|collectible)_key LIMIT \?/u);
    assert.equal(query.values.at(-1), 251);
  }
  for (const query of f.queries.slice(2)) {
    assert.match(query.sql, /WITH targets\(id, key\) AS \(VALUES/u);
    assert.equal(query.values.length, 502); // 250 UUID/key pairs plus two fact limits.
    assert.deepEqual(query.values.slice(-2), [500, 500]);
    assert.match(query.sql, /unresolved\.(?:pack|collectible)_id IS NULL/u);
    assert.match(query.sql, /FOR UPDATE OF unresolved SKIP LOCKED/u);
    assert.match(query.sql, /row_version = fact\.row_version \+ 1/u);
    assert.doesNotMatch(query.sql, /FROM (?:packs|collectibles) AS target/u);
  }
});

test("explicit arriving keys are parameterized and rejected scans execute no query", async () => {
  const f = harness(1, 0);
  await resolveProviderFactReferencesBatch(f.client, { targets: { packKeys: ["incoming-pack"], collectibleKeys: [] } });
  assert.match(f.queries[0]!.sql, /pack_key IN \(\?\)/u);
  assert.ok(f.queries[0]!.values.includes("incoming-pack"));
  const invalid = harness(1, 1);
  await assert.rejects(resolveProviderFactReferencesBatch(invalid.client, {
    targets: { packKeys: Array.from({ length: 4001 }, () => "key"), collectibleKeys: [] },
  }));
  assert.equal(invalid.queries.length, 0);
});

test("a rejected statement does not start overlapping work or retry a transaction", async () => {
  const error = new Error("synthetic settled transaction conflict");
  let calls = 0;
  const client = { async $queryRaw() { calls += 1; throw error; } } as unknown as Pick<ProviderQueryClient, "$queryRaw">;
  await assert.rejects(resolveProviderFactReferencesBatch(client), (value) => value === error);
  assert.equal(calls, 1);
});
