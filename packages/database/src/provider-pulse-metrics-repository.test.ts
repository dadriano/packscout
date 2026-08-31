import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import { PrismaProviderPulseMetricsRepository } from "./provider-pulse-metrics-repository.ts";

const measuredAt = new Date("2026-08-30T12:00:00.000Z");
const totalsRow = {
  measured_at: measuredAt, processed: 0n, accepted: 0n,
  categories: 0n, packs: 0n, collectibles: 0n, aliases: 0n,
  instances: 0n, packContents: 0n, accounts: 0n, pulls: 0n,
  pullItems: 0n, marketEvents: 0n,
};

function repositoryFor(read: (query: Prisma.Sql) => readonly unknown[]) {
  const database = {
    $transaction: async (callback: (transaction: ProviderTransactionClient) => Promise<unknown>) => callback({
      $executeRaw: async () => 0,
      $queryRaw: async (query: Prisma.Sql) => query.sql.includes("set_config") ? [] : read(query),
    } as unknown as ProviderTransactionClient),
  } as unknown as ProviderPrismaClient;
  return new PrismaProviderPulseMetricsRepository(database);
}

test("provider pulse refuses lossy numbers and totals that exceed safe JSON integer precision", async () => {
  const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  for (const row of [
    { ...totalsRow, categories: tooLarge },
    { ...totalsRow, categories: BigInt(Number.MAX_SAFE_INTEGER), pulls: 1n },
    { ...totalsRow, processed: tooLarge },
    { ...totalsRow, accepted: tooLarge },
    { ...totalsRow, categories: -1n },
  ]) {
    await assert.rejects(repositoryFor(() => [row]).readTotals(), RangeError);
  }
  const largest = await repositoryFor(() => [{
    ...totalsRow, processed: BigInt(Number.MAX_SAFE_INTEGER),
  }]).readTotals();
  assert.equal(largest.processed, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.parse(JSON.stringify(largest)).measuredAt, measuredAt.toISOString());
});

test("provider pulse surfaces missing or failed measurements rather than inventing zeros", async () => {
  const empty = repositoryFor(() => []);
  await assert.rejects(empty.readTotals(), /totals are unavailable/u);
  await assert.rejects(empty.readLeases(), /leases are unavailable/u);
  await assert.rejects(empty.readHistory(), /history is unavailable/u);
  const failure = new Error("database timeout");
  const failed = repositoryFor(() => { throw failure; });
  await assert.rejects(failed.readTotals(), (error) => error === failure);
  await assert.rejects(failed.readLeases(), (error) => error === failure);
  await assert.rejects(failed.readHistory(), (error) => error === failure);
});

test("provider pulse refuses unsafe retained quarantine counts", async () => {
  const repository = repositoryFor(() => [{
    measured_at: measuredAt, last_committed_page_at: null,
    open: 0n, resolved: 0n, expired: 0n, retained: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  }]);
  await assert.rejects(repository.readHistory(), RangeError);
});

test("provider pulse lease polling reads only the two worker roles, independently of retained history", async () => {
  let reads = 0;
  const repository = repositoryFor((query) => {
    reads += 1;
    assert.deepEqual(query.sql.match(/public\.[a-z_]+/gu), [
      "public.provider_worker_states", "public.provider_worker_states",
    ]);
    assert.match(query.sql, /importer\.worker_role = 'import'/u);
    assert.match(query.sql, /promoter\.worker_role = 'promotion'/u);
    return [{
      measured_at: measuredAt,
      import_state: "active", import_heartbeat_at: measuredAt,
      import_expires_at: new Date(measuredAt.getTime() + 60_000),
      promotion_state: "unowned", promotion_heartbeat_at: null, promotion_expires_at: null,
    }];
  });
  assert.deepEqual(await repository.readLeases(), {
    measuredAt: measuredAt.toISOString(),
    importLease: {
      state: "active", heartbeatAt: measuredAt.toISOString(),
      expiresAt: "2026-08-30T12:01:00.000Z",
    },
    promotionLease: { state: "unowned", heartbeatAt: null, expiresAt: null },
  });
  assert.equal(reads, 1);
});
