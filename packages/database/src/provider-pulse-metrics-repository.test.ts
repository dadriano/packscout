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

function repositoryFor(read: () => readonly unknown[]) {
  const database = {
    $transaction: async (callback: (transaction: ProviderTransactionClient) => Promise<unknown>) => callback({
      $executeRaw: async () => 0,
      $queryRaw: async (query: Prisma.Sql) => query.sql.includes("set_config") ? [] : read(),
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
  await assert.rejects(empty.readActivity(), /activity is unavailable/u);
  const failure = new Error("database timeout");
  const failed = repositoryFor(() => { throw failure; });
  await assert.rejects(failed.readTotals(), (error) => error === failure);
  await assert.rejects(failed.readActivity(), (error) => error === failure);
});

test("provider pulse refuses unsafe retained quarantine counts", async () => {
  const repository = repositoryFor(() => [{
    measured_at: measuredAt, last_committed_page_at: null,
    import_state: "unowned", import_heartbeat_at: null, import_expires_at: null,
    promotion_state: "unowned", promotion_heartbeat_at: null, promotion_expires_at: null,
    open: 0n, resolved: 0n, expired: 0n, retained: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  }]);
  await assert.rejects(repository.readActivity(), RangeError);
});
