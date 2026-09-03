import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { batchWorker, prepareBatchFixture, sourceRejection } from "./provider-quarantine-batch-integration-support.ts";
import { cardRecord, categoryRecord } from "./provider-collectible-batch-test-support.ts";
import { pullRecord, eventRecord, factBatchState, factProfilePackRecord } from "./provider-fact-batch-test-support.ts";

test("795 pulls with 462 immutable corrections and 9 replays keep neighbors batched and preserve all evidence", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey, 900_000);
    const repo = new PrismaProviderMixedPageRepository(client);
    await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(),
      ...Array.from({ length: 471 }, (_, n) => pullRecord(`pull-${n}`, { factDigest: (n < 462 ? "c" : "a").repeat(64) })),
    ]), maximumTransactionMilliseconds: 480_000, deadlineAt: Date.now() + 540_000 });
    const before = await factBatchState(client, fixture.runId), oldIds = new Set(before.pulls.map(row => row.id));
    const records = [categoryRecord("Updated synthetic category"),
      ...Array.from({ length: 6 }, (_, n) => ({ ...categoryRecord(), candidate: {
        categoryKey: `other-category-${n}`, parentCategoryKey: null, displayName: `Synthetic ${n}` } })),
      ...Array.from({ length: 17 }, (_, n) => factProfilePackRecord(`synthetic-pack-${n}`)),
      ...Array.from({ length: 775 }, (_, n) => cardRecord(`card-${n}`)),
      ...Array.from({ length: 795 }, (_, n) => pullRecord(`pull-${n}`)),
      ...Array.from({ length: 268 }, (_, n) => eventRecord(`event-${n}`)),
      ...Array.from({ length: 3 }, (_, n) => ({ ...sourceRejection(`synthetic-rejected-${n}`),
        kind: "catalog" as const }))];
    const operations: string[] = [];
    const observed = client.$extends({ query: { async $allOperations({ model, operation, args, query }) {
      operations.push(`${model ?? "raw"}.${operation}`); return query(args);
    } } }) as unknown as ProviderPrismaClient;
    const page = fixture.page(records, 2);
    const result = await new PrismaProviderMixedPageRepository(observed).commit({ workerId: batchWorker, page,
      maximumTransactionMilliseconds: 480_000, deadlineAt: Date.now() + 540_000 });
    assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
    assert.deepEqual(result.counts, { records: 1865, catalog: 802, pulls: 795, marketEvents: 268,
      accepted: 1391, duplicate: 9, quarantined: 465, materialChanges: 1391 });
    context.diagnostic(JSON.stringify({ scenario: "462_corrections_9_replays", records: 1865,
      operations: operations.length, modeledTransportAt100ms: operations.length * 100 }));
    assert.ok(operations.length <= 400, `Corrections must not restore per-record fact writes: ${operations.length}`);
    assert.equal(operations.filter(value => value === "pulls.create").length, 0);
    const after = await factBatchState(client, fixture.runId);
    assert.deepEqual(after.pulls.filter(row => oldIds.has(row.id)), before.pulls);
    assert.deepEqual(after.items.filter(row => oldIds.has(row.pull_id)), before.items);
    assert.equal(after.pulls.length, 795); assert.equal(after.items.length, 795); assert.equal(after.events.length, 268);
    assert.equal(after.run.page_count, 2); assert.equal(after.run.accepted_count, 1863);
    assert.equal(after.run.duplicate_count, 9); assert.equal(after.run.quarantined_count, 465);
    assert.equal(after.run.material_change_count, 1863);
    assert.equal(after.runtime.source_cursor_hash, page.nextCursorFingerprint);
    assert.equal(after.pages[1]!.response_digest, page.responseDigest);
    assert.deepEqual(after.pages[1]!.requested_cursor, page.inputCursor);
    assert.equal(after.pages[1]!.accepted_count, 1391); assert.equal(after.pages[1]!.duplicate_count, 9);
    assert.equal(after.pages[1]!.quarantined_count, 465); assert.equal(after.pages[1]!.material_change_count, 1391);
    const quarantines = [...after.quarantines].sort((a, b) => a.record_index - b.record_index);
    assert.deepEqual(quarantines.slice(0, 462).map(row => row.record_index), Array.from({ length: 462 }, (_, n) => 799 + n));
    for (const row of quarantines.slice(0, 462)) {
      assert.equal(row.reason_code, "IMMUTABLE_FACT_CONFLICT"); assert.equal(row.state, "open");
      assert.equal(row.provider_run_id, fixture.runId); assert.equal(row.provider_run_page_id, page.pageId);
      assert.equal(row.record_kind, "pull"); assert.equal(row.field_path, null);
      assert.deepEqual(row.normalized_candidate, page.records[row.record_index]!.candidate);
      assert.equal(row.candidate_schema_version, page.contractVersion);
    }
    assert.deepEqual(quarantines.slice(462).map(row => row.record_index), [1862, 1863, 1864]);
    assert.ok(quarantines.slice(462).every(row => row.state === "expired" && row.normalized_candidate === null));
    assert.equal(after.outbox.filter(row => row.local_quarantine_id !== null).length, 465);
    assert.equal(after.promotions.length, 2658); assert.equal(after.ledger.last_sequence, 2658n);
    assert.deepEqual(after.promotions.map(row => row.sequence), Array.from({ length: 2658 }, (_, n) => BigInt(n + 1)));
    const newPulls = new Map(after.pulls.filter(row => !oldIds.has(row.id)).map(row => [row.pull_key, row]));
    const itemByPull = new Map(after.items.map(row => [row.pull_id, row]));
    const start = before.promotions.length + 799;
    for (let n = 471; n < 795; n += 1) {
      const pull = newPulls.get(`pull-${n}`)!, item = itemByPull.get(pull.id)!;
      assert.deepEqual(after.promotions.slice(start + (n - 471) * 2, start + (n - 471) * 2 + 2)
        .map(row => [row.entity_type, row.entity_id]), [["pull", pull.id], ["pull_item", item.id]]);
    }
    assert.equal((await repo.commit({ workerId: batchWorker, page })).kind, "replayed");
    assert.deepEqual(await factBatchState(client, fixture.runId), after);
  } finally { await harness.close(); }
});
