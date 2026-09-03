import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import { EXACT_STORAGE_SCAN_BYTE_CEILING, PrismaProviderPulseMetricsRepository, type ProviderPulseCounts } from "./provider-pulse-metrics-repository.ts";

const measuredAt = new Date("2026-08-30T12:00:00.000Z");
const countsRow = {
  measured_at: measuredAt,
  categories: 0n, packs: 0n, collectibles: 0n, aliases: 0n,
  instances: 0n, packContents: 0n, accounts: 0n, pulls: 0n,
  pullItems: 0n, marketEvents: 0n,
};
const recordTotalsRow = { measured_at: measuredAt, processed: 0n, accepted: 0n };
const ENTITY_KEYS = Object.keys(countsRow).filter((key) => key !== "measured_at") as Array<Exclude<keyof ProviderPulseCounts, "total">>;
/** Every canonical table empty and weightless, so nothing is estimated. */
const estimateRow = {
  ...countsRow,
  ...Object.fromEntries(ENTITY_KEYS.map((key) => [`bytes_${key}`, 0n])),
  readable_tables: 10n,
};
/** An estimate row where the named entities are large enough to be estimated. */
function sized(bytes: Readonly<Record<string, bigint>>, rows: Readonly<Record<string, bigint>> = {}) {
  return {
    ...estimateRow,
    ...Object.fromEntries(Object.entries(bytes).map(([key, value]) => [`bytes_${key}`, value])),
    ...rows,
  };
}
const isEstimate = (sql: string) => sql.includes("readable_tables");
// Only the exact scan reads the canonical tables; the estimate reads catalogs.
const isExactScan = (sql: string) => sql.includes("count(*) from public.");
const scannedTables = (sql: string) =>
  [...sql.matchAll(/count\(\*\) from public\.([a-z_]+)/gu)].map((match) => match[1]!);

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
    { ...estimateRow, bytes_pulls: tooLarge },
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
    return [sized({ pulls: BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) }, { pulls: 7n })];
  }).readStorageCounts();
  assert.equal(exact.precision, "exact");
  assert.deepEqual(exact.estimatedEntities, []);
  assert.equal(statements.filter(isEstimate).length, 1);
  assert.equal(statements.filter(isExactScan).length, 1);

  const statementsAbove: string[] = [];
  const estimated = await repositoryFor((query) => {
    statementsAbove.push(query.sql);
    return [sized(
      Object.fromEntries(ENTITY_KEYS.map((key) => [key, BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) + 1n])),
      { pulls: 9n },
    )];
  }).readStorageCounts();
  assert.equal(estimated.precision, "estimated");
  assert.equal(estimated.counts.total, 9);
  assert.deepEqual([...estimated.estimatedEntities].sort(), [...ENTITY_KEYS].sort());
  // Every table is over the ceiling, so nothing is scanned at all.
  assert.equal(statementsAbove.some(isExactScan), false);
});

test("one oversized table is estimated without costing the counts of the tables beside it", async () => {
  // The measured shape of a real provider: seven empty canonical tables, a
  // 49 MB market_events, and pulls and pull_items in the gigabytes.
  const statements: string[] = [];
  const measured = await repositoryFor((query) => {
    statements.push(query.sql);
    return [sized(
      { pulls: 2_220n * 1024n * 1024n, pullItems: 1_132n * 1024n * 1024n, marketEvents: 49n * 1024n * 1024n },
      { pulls: 8_698_233n, pullItems: 8_697_996n, marketEvents: 180_891n },
    )];
  }).readStorageCounts();

  assert.equal(measured.precision, "estimated", "the measurement as a whole is an estimate");
  assert.deepEqual([...measured.estimatedEntities].sort(), ["pullItems", "pulls"],
    "only the two oversized tables are estimated");

  const scanned = statements.filter(isExactScan).flatMap(scannedTables);
  assert.equal(scanned.includes("market_events"), true, "a 49 MB table is still counted exactly");
  assert.equal(scanned.includes("categories"), true, "an empty table is still counted exactly");
  assert.equal(scanned.includes("pulls"), false, "the oversized tables are never scanned");
  assert.equal(scanned.includes("pull_items"), false);
  assert.equal(scanned.length, 8, "eight of ten entities are counted exactly");

  // The estimated values still reach the caller, and the total reconciles.
  assert.equal(measured.counts.pulls, 8_698_233);
  assert.equal(measured.counts.marketEvents, 180_891);
  const summed = ENTITY_KEYS.reduce((sum, key) => sum + measured.counts[key], 0);
  assert.equal(measured.counts.total, summed);
});

test("a reset row estimate cannot route a large provider into a scan it cannot finish", async () => {
  // A statistics reset zeroes n_live_tup while the tables stay large. The
  // decision reads relation size, which a reset does not touch, so the scan
  // is not attempted and the provider is still measured.
  const statements: string[] = [];
  const measured = await repositoryFor((query) => {
    statements.push(query.sql);
    return [sized({ pulls: BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) + 1n })];
  }).readStorageCounts();
  assert.deepEqual(measured.estimatedEntities, ["pulls"]);
  assert.equal(statements.filter(isExactScan).flatMap(scannedTables).includes("pulls"), false,
    "the oversized table is never scanned");
});

function rawQueryFailure(sqlState: string, message: string) {
  return new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${sqlState}\`.`, {
    code: "P2010", clientVersion: "test", meta: { code: sqlState, message },
  });
}

test("a scan the database cancelled downgrades to the estimate rather than withholding it", async () => {
  let scans = 0;
  const measured = await repositoryFor((query) => {
    if (!isExactScan(query.sql)) return [sized({ pulls: 1_024n }, { pulls: 12n })];
    scans += 1;
    throw rawQueryFailure("57014", "ERROR: canceling statement due to statement timeout");
  }).readStorageCounts();
  assert.equal(scans, 1, "the scan was attempted, since the provider is small");
  assert.equal(measured.precision, "estimated", "its cancellation downgrades rather than withholding");
  assert.equal(measured.counts.total, 12);
});

test("a scan that failed for any other reason is reported, never dressed as an estimate", async () => {
  // A missing relation or revoked privilege is a fact about the provider that
  // an estimate cannot stand in for: reporting one would hide the breakage
  // behind numbers that look measured.
  for (const failure of [
    rawQueryFailure("42P01", 'relation "public.pulls" does not exist'),
    rawQueryFailure("42501", "permission denied for table pulls"),
    new Error("connection terminated"),
  ]) {
    const repository = repositoryFor((query) => {
      if (!isExactScan(query.sql)) return [sized({ pulls: 1_024n }, { pulls: 12n })];
      throw failure;
    });
    await assert.rejects(repository.readStorageCounts(), (error) => error === failure);
  }
});

test("a canonical table that is absent or unreadable is reported, not counted as empty", async () => {
  // Such a table estimates zero rows and contributes no bytes, so without this
  // check it would read as a measured empty table on either path.
  for (const scanBytes of [1_024n, BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) + 1n]) {
    const repository = repositoryFor(() => [
      { ...sized({ pulls: scanBytes }), readable_tables: 9n },
    ]);
    await assert.rejects(repository.readStorageCounts(), /canonical tables are missing or unreadable/u);
  }
});

test("an empty provider database reports a measured zero, not missing evidence", async () => {
  const statements: string[] = [];
  const measured = await repositoryFor((query) => {
    statements.push(query.sql);
    return [isExactScan(query.sql) ? countsRow : estimateRow];
  }).readStorageCounts();
  assert.equal(measured.precision, "exact");
  assert.equal(measured.counts.total, 0);
  assert.equal(statements.filter(isExactScan).length, 1);
});

test("a total is summed from the entity columns alone, not from every column read", async () => {
  // The estimate statement carries decision columns beside the entity counts.
  const measured = await repositoryFor(() => [
    sized({ pulls: BigInt(EXACT_STORAGE_SCAN_BYTE_CEILING) + 1n }, { pulls: 3n }),
  ]).readStorageCounts();
  assert.equal(measured.counts.total, 3, "scan_bytes and readable_tables are not entities");
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
