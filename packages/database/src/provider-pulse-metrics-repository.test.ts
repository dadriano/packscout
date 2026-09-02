import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import { EXACT_STORAGE_SCAN_BYTE_CEILING, PrismaProviderPulseMetricsRepository } from "./provider-pulse-metrics-repository.ts";

const measuredAt = new Date("2026-08-30T12:00:00.000Z");
const countsRow = {
  measured_at: measuredAt,
  categories: 0n, packs: 0n, collectibles: 0n, aliases: 0n,
  instances: 0n, packContents: 0n, accounts: 0n, pulls: 0n,
  pullItems: 0n, marketEvents: 0n,
};
const recordTotalsRow = { measured_at: measuredAt, processed: 0n, accepted: 0n };
const estimateRow = { ...countsRow, scan_bytes: 0n };
const isEstimate = (sql: string) => sql.includes("scan_bytes");
const isExactScan = (sql: string) => sql.includes("count(*)");

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
    { ...estimateRow, categories: tooLarge },
    { ...estimateRow, categories: BigInt(Number.MAX_SAFE_INTEGER), pulls: 1n },
    { ...estimateRow, categories: -1n },
    { ...estimateRow, scan_bytes: tooLarge },
  ]) {
    await assert.rejects(repositoryFor(() => [row]).readStorageCounts(), RangeError);
  }
  for (const row of [
    { ...recordTotalsRow, processed: tooLarge },
    { ...recordTotalsRow, accepted: tooLarge },
  ]) {
    await assert.rejects(repositoryFor(() => [row]).readRecordTotals(), RangeError);
  }
  const largest = await repositoryFor(() => [{
    ...recordTotalsRow, processed: BigInt(Number.MAX_SAFE_INTEGER),
  }]).readRecordTotals();
  assert.equal(largest.processed, Number.MAX_SAFE_INTEGER);
  assert.equal(JSON.parse(JSON.stringify(largest)).measuredAt, measuredAt.toISOString());
});

test("stored rows are counted below the byte ceiling and estimated above it", async () => {
  const statements: string[] = [];
  const exact = await repositoryFor((query) => {
    statements.push(query.sql);
    return [{ ...estimateRow, pulls: 7n, scan_bytes: BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) }];
  }).readStorageCounts();
  assert.equal(exact.precision, "exact");
  // The estimate decides, then the exact scan runs: two separate statements.
  assert.equal(statements.filter(isEstimate).length, 1);
  assert.equal(statements.filter(isExactScan).length, 1);

  const statementsAbove: string[] = [];
  const estimated = await repositoryFor((query) => {
    statementsAbove.push(query.sql);
    return [{ ...estimateRow, pulls: 9n, scan_bytes: BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) + 1n }];
  }).readStorageCounts();
  assert.equal(estimated.precision, "estimated");
  assert.equal(estimated.counts.total, 9);
  // Above the ceiling no row is ever counted, so nothing scans the tables.
  assert.equal(statementsAbove.some(isExactScan), false);
});

test("a reset row estimate cannot route a large provider into a scan it cannot finish", async () => {
  // A statistics reset zeroes n_live_tup while the tables stay large. The
  // decision reads relation size, which a reset does not touch, so the scan
  // is not attempted and the provider is still measured.
  const statements: string[] = [];
  const measured = await repositoryFor((query) => {
    statements.push(query.sql);
    return [{ ...estimateRow, scan_bytes: BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) + 1n }];
  }).readStorageCounts();
  assert.equal(measured.precision, "estimated");
  assert.equal(statements.some(isExactScan), false, "no scan is attempted on a large provider");
});

test("an exact scan that still fails downgrades to the estimate rather than withholding it", async () => {
  let scans = 0;
  const measured = await repositoryFor((query) => {
    if (!isExactScan(query.sql)) return [{ ...estimateRow, pulls: 12n, scan_bytes: 1_024n }];
    scans += 1;
    throw new Error("canceling statement due to statement timeout");
  }).readStorageCounts();
  assert.equal(scans, 1, "the scan was attempted, since the provider is small");
  assert.equal(measured.precision, "estimated", "its failure downgrades rather than withholding");
  assert.equal(measured.counts.total, 12);
});

test("an empty provider database reports a measured zero, not missing evidence", async () => {
  const statements: string[] = [];
  const measured = await repositoryFor((query) => {
    statements.push(query.sql);
    return [estimateRow];
  }).readStorageCounts();
  assert.equal(measured.precision, "exact");
  assert.equal(measured.counts.total, 0);
  assert.equal(statements.filter(isExactScan).length, 1);
});

test("provider pulse surfaces missing or failed measurements rather than inventing zeros", async () => {
  const empty = repositoryFor(() => []);
  await assert.rejects(empty.readStorageCounts(), /storage estimates are unavailable/u);
  await assert.rejects(empty.readRecordTotals(), /record totals are unavailable/u);
  await assert.rejects(empty.readLeases(), /leases are unavailable/u);
  await assert.rejects(empty.readHistory(), /history is unavailable/u);
  const failure = new Error("database timeout");
  const failed = repositoryFor(() => { throw failure; });
  await assert.rejects(failed.readStorageCounts(), (error) => error === failure);
  await assert.rejects(failed.readRecordTotals(), (error) => error === failure);
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
