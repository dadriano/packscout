import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { batchWorker, prepareBatchFixture } from "./provider-quarantine-batch-integration-support.ts";

const CARD_COUNT = 1519;
type RecordInput = Omit<ProviderMixedPageRecord, "providerId" | "position">;

function catalog(revision: number): RecordInput[] {
  return [
    { kind: "catalog", entityType: "category", operation: "upsert", candidate: {
      categoryKey: "synthetic-cards", parentCategoryKey: null, displayName: "Synthetic cards",
    } },
    ...Array.from({ length: CARD_COUNT }, (_, index): RecordInput => ({
      kind: "catalog", entityType: "collectible", operation: "upsert", candidate: {
        collectibleKey: `synthetic-card-${index}`, categoryKey: "synthetic-cards", collectibleType: "card",
        displayName: `Synthetic card ${index}`, normalizedName: `synthetic card ${index}`,
        year: 2026, brand: "Synthetic", setOrSeries: null, cardNumber: null, referenceNumber: null,
        subject: null, grade: null, grader: null, primaryImageUrl: null, primaryImageAlt: null,
        valuationAmount: String(10 + revision), valuationCurrency: "USD", valuationUsdAmount: String(10 + revision),
        valuationUnavailableReason: null, valuationType: "synthetic", valuationObservedAt: null,
        dataAsOf: `2026-08-${String(20 + revision).padStart(2, "0")}T00:00:00.000Z`, attributes: { synthetic: true },
      },
    })),
  ];
}

function latencyDatabase(client: ProviderPrismaClient) {
  const operations: string[] = [];
  const database = client.$extends({ query: {
    async $allOperations({ model, operation, args, query }) {
      operations.push(`${model ?? "raw"}.${operation}`);
      // Small deterministic transport cost exercises awaited model AND raw
      // operations without making the test spend minutes simulating the WAN.
      await delay(1);
      return query(args);
    },
  } });
  return { database: database as unknown as ProviderPrismaClient, operations };
}

test("a complete 1519-card page bounds roundtrips for new, changed and unchanged catalog records", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
    context.skip("An explicit disposable PostgreSQL test target is required."); return;
  }
  const harness = await createProviderHarness(); const { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey, 900_000);
    const observed = latencyDatabase(client);
    const repository = new PrismaProviderMixedPageRepository(observed.database);
    for (const [index, revision] of [0, 1, 1].entries()) {
      observed.operations.length = 0;
      const page = fixture.page(catalog(revision), index + 1);
      const result = await repository.commit({ workerId: batchWorker, page,
        maximumTransactionMilliseconds: 480_000, deadlineAt: Date.now() + 540_000 });
      assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
      const expectedChanges = index === 0 ? CARD_COUNT + 1 : index === 1 ? CARD_COUNT : 0;
      assert.deepEqual(result.counts, { records: CARD_COUNT + 1, catalog: CARD_COUNT + 1,
        pulls: 0, marketEvents: 0, accepted: expectedChanges, duplicate: CARD_COUNT + 1 - expectedChanges,
        quarantined: 0, materialChanges: expectedChanges });
      const calls = observed.operations.length;
      context.diagnostic(JSON.stringify({ scenario: ["new", "changed", "unchanged"][index],
        records: CARD_COUNT + 1, databaseOperations: calls, modeledTransportAt100ms: calls * 100 }));
      assert.ok(observed.operations.some(operation => operation.startsWith("raw.")),
        "The measured path must include raw lease/run locks, savepoints and deferred checks.");
      assert.ok(calls <= 250,
        `A page must fit a 25-second transport budget at 100ms per operation; observed ${calls} calls.`);
      const run = await client.provider_runs.findUniqueOrThrow({ where: { id: fixture.runId } });
      assert.equal(run.page_count, index + 1);
      assert.equal(run.accepted_count, index === 0 ? CARD_COUNT + 1 : CARD_COUNT * 2 + 1);
      const runtime = await client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
      assert.equal(runtime.source_cursor_hash, page.nextCursorFingerprint);
      assert.equal(await client.collectibles.count(), CARD_COUNT);
      assert.equal(await client.quarantine_records.count(), 0);
      const pageReceipt = await client.provider_run_pages.findUniqueOrThrow({ where: { id: page.pageId } });
      assert.equal(pageReceipt.response_digest, page.responseDigest);
      const priorCalls = calls;
      assert.equal((await repository.commit({ workerId: batchWorker, page })).kind, "replayed");
      assert.ok(observed.operations.length > priorCalls);
      assert.equal(await client.provider_run_pages.count(), index + 1);
    }
    const rows = await client.collectibles.findMany({ select: { id: true, row_version: true,
      valuation_amount: true, category_id: true } });
    assert.ok(rows.every(row => row.row_version === 2n && row.valuation_amount?.toString() === "11" && row.category_id));
    const ledger = await client.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } });
    assert.equal(ledger.last_sequence, BigInt(CARD_COUNT * 2 + 1));
    const promotions = await client.promotion_changes.findMany({ orderBy: { sequence: "asc" } });
    assert.equal(promotions.length, CARD_COUNT * 2 + 1);
    assert.deepEqual(promotions.map(row => row.sequence),
      Array.from({ length: CARD_COUNT * 2 + 1 }, (_, index) => BigInt(index + 1)));
    const first = promotions.slice(1, CARD_COUNT + 1), second = promotions.slice(CARD_COUNT + 1);
    assert.deepEqual(second.map(row => row.entity_id), first.map(row => row.entity_id),
      "Bulk updates retain the incoming promotion order and existing identities.");
    assert.ok(first.every(row => row.entity_version === 1n));
    assert.ok(second.every(row => row.entity_version === 2n));
  } finally { await harness.close(); }
});
