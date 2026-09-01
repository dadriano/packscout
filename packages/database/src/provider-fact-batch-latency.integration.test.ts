import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { batchWorker, prepareBatchFixture } from "./provider-quarantine-batch-integration-support.ts";
import { cardRecord, categoryRecord } from "./provider-collectible-batch-test-support.ts";
import { pullRecord, eventRecord, factBatchState } from "./provider-fact-batch-test-support.ts";

test("a full 775-collectible 795-pull 268-event page bounds new and replayed fact roundtrips", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey, 900_000);
    const records = [categoryRecord(), ...Array.from({ length: 775 }, (_, n) => cardRecord(`card-${n}`)),
      ...Array.from({ length: 795 }, (_, n) => pullRecord(`pull-${n}`)),
      ...Array.from({ length: 268 }, (_, n) => eventRecord(`event-${n}`))];
    const operations: string[] = [];
    const observed = client.$extends({ query: { async $allOperations({ model, operation, args, query }) {
      operations.push(`${model ?? "raw"}.${operation}`); await delay(1); return query(args);
    } } }) as unknown as ProviderPrismaClient;
    const repo = new PrismaProviderMixedPageRepository(observed);
    let first: Awaited<ReturnType<typeof factBatchState>> | undefined;
    for (const pageNumber of [1, 2]) {
      operations.length = 0;
      const page = fixture.page(records, pageNumber);
      const result = await repo.commit({ workerId: batchWorker, page,
        maximumTransactionMilliseconds: 480_000, deadlineAt: Date.now() + 540_000 });
      assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
      assert.deepEqual(result.counts, { records: 1839, catalog: 776, pulls: 795, marketEvents: 268,
        accepted: pageNumber === 1 ? 1839 : 0, duplicate: pageNumber === 1 ? 0 : 1839,
        quarantined: 0, materialChanges: pageNumber === 1 ? 1839 : 0 });
      context.diagnostic(JSON.stringify({ scenario: pageNumber === 1 ? "new" : "replayed_facts",
        records: 1839, operations: operations.length, modeledTransportAt100ms: operations.length * 100 }));
      assert.ok(operations.length <= 250, `Mixed page exceeded 250 bounded operations: ${operations.length}`);
      assert.ok(operations.includes("raw.$executeRawUnsafe"), "Include savepoints and final deferred checks in the count.");
      const state = await factBatchState(client, fixture.runId);
      assert.equal(state.pulls.length, 795); assert.equal(state.items.length, 795); assert.equal(state.events.length, 268);
      assert.equal(state.promotions.length, 776 + 795 * 2 + 268);
      assert.deepEqual(state.promotions.map(row => row.sequence), Array.from({ length: 2634 }, (_, n) => BigInt(n + 1)));
      assert.equal(state.ledger.last_sequence, 2634n);
      const itemByPull = new Map(state.items.map(row => [row.pull_id, row]));
      const pullByKey = new Map(state.pulls.map(row => [row.pull_key, row]));
      for (let n = 0; n < 795; n += 1) {
        const pull = pullByKey.get(`pull-${n}`)!, item = itemByPull.get(pull.id)!;
        assert.equal(item.ordinal, 1); assert.equal(item.quantity, 2n); assert.ok(item.collectible_id);
        assert.equal(pull.pack_id, null); assert.equal(pull.pack_key, "unresolved-pack");
        assert.deepEqual(state.promotions.slice(776 + n * 2, 778 + n * 2).map(row => [row.entity_type, row.entity_id]),
          [["pull", pull.id], ["pull_item", item.id]]);
      }
      assert.equal(state.run.page_count, pageNumber); assert.equal(state.run.accepted_count, 1839);
      assert.equal(state.runtime.source_cursor_hash, page.nextCursorFingerprint);
      assert.equal(state.quarantines.length, 0);
      if (first) {
        for (const key of ["pulls", "items", "events", "promotions", "ledger"] as const) assert.deepEqual(state[key], first[key]);
      } else first = state;
      assert.equal((await repo.commit({ workerId: batchWorker, page })).kind, "replayed");
      assert.deepEqual(await factBatchState(client, fixture.runId), state);
    }
  } finally { await harness.close(); }
});
