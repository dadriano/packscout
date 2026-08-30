import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type { ProviderQueryClient } from "./provider-database.ts";
import { resolveProviderFactReferencesBatch } from
  "./provider-fact-reference-reconciliation.ts";

function harness(packs: boolean, collectibles: boolean) {
  const queries: ProviderPrisma.Sql[] = [];
  const targets = { packs, collectibles };
  const client = {
    async $queryRaw(query: ProviderPrisma.Sql) {
      queries.push(query);
      return query.sql.includes("SELECT EXISTS")
        ? [{ ...targets }]
        : [{ id: "00000000-0000-4000-8000-000000000001", row_version: 2n }];
    },
  } as unknown as Pick<ProviderQueryClient, "$queryRaw">;
  return { client, queries, targets };
}

test("given no catalog targets, reconciliation never queries the fact history", async () => {
  const fixture = harness(false, false);
  assert.deepEqual(await resolveProviderFactReferencesBatch(fixture.client), {
    pulls: [], pullItems: [], marketEventPacks: [], marketEventCollectibles: [],
  });
  assert.equal(fixture.queries.length, 1);
  assert.doesNotMatch(fixture.queries[0]!.sql, /\b(pulls|pull_items|market_events)\b/u);
});

test("given only one catalog kind, only its relationship queries execute", async () => {
  for (const packs of [false, true]) {
    const fixture = harness(packs, !packs);
    const result = await resolveProviderFactReferencesBatch(fixture.client);
    assert.equal(fixture.queries.length, 3);
    assert.equal(result.pulls.length, packs ? 1 : 0);
    assert.equal(result.marketEventPacks.length, packs ? 1 : 0);
    assert.equal(result.pullItems.length, packs ? 0 : 1);
    assert.equal(result.marketEventCollectibles.length, packs ? 0 : 1);
  }
});

test("given late catalog arrival, the next invocation rechecks and resolves it", async () => {
  const fixture = harness(false, false);
  await resolveProviderFactReferencesBatch(fixture.client);
  fixture.targets.packs = true;
  fixture.targets.collectibles = true;
  const result = await resolveProviderFactReferencesBatch(fixture.client);
  assert.equal(fixture.queries.length, 6);
  assert.equal(result.pulls.length + result.pullItems.length
    + result.marketEventPacks.length + result.marketEventCollectibles.length, 4);
});

test("catalog-driven probes retain unresolved indexes, row locks, versions, and the 500 bound", async () => {
  const fixture = harness(true, true);
  await resolveProviderFactReferencesBatch(fixture.client);
  const probes = fixture.queries.slice(1);
  assert.equal(probes.length, 4);
  for (const query of probes) {
    assert.match(query.sql, /FROM (?:packs|collectibles) AS target\s+CROSS JOIN LATERAL/u);
    assert.match(query.sql, /unresolved\.(?:pack|collectible)_id IS NULL/u);
    assert.match(query.sql, /unresolved\.(?:pack|collectible)_key IS NOT NULL/u);
    assert.match(query.sql, /unresolved\.(?:pack|collectible)_key = target\./u);
    assert.match(query.sql, /FOR UPDATE OF unresolved SKIP LOCKED/u);
    assert.match(query.sql, /row_version = fact\.row_version \+ 1/u);
    assert.doesNotMatch(query.sql, /ORDER BY fact\.id/u);
    assert.deepEqual(query.values, [500, 500]);
  }
});

test("given a rejected query, reconciliation does not start overlapping work or retry it", async () => {
  const expected = new Error("synthetic settled transaction conflict");
  let calls = 0;
  const client = {
    async $queryRaw() {
      calls += 1;
      if (calls === 1) return [{ packs: true, collectibles: true }];
      throw expected;
    },
  } as unknown as Pick<ProviderQueryClient, "$queryRaw">;
  await assert.rejects(resolveProviderFactReferencesBatch(client), (error) => error === expected);
  assert.equal(calls, 2);
});
