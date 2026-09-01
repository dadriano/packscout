import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { batchWorker, prepareBatchFixture } from "./provider-quarantine-batch-integration-support.ts";
import { cardRecord, categoryRecord } from "./provider-collectible-batch-test-support.ts";
import { pullRecord, eventRecord, factBatchState, type FactRecordInput } from "./provider-fact-batch-test-support.ts";

test("batched multi-item pulls retain ordinals and oversized valid batches use the original record path", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    const items = Array.from({ length: 3 }, (_, n) => ({ collectibleKey: `card-${n}`, collectibleInstanceKey: null,
      quantity: String(n + 1), statedValueAmount: `${n}.125`, statedValueCurrency: "USD" }));
    const first = await repo.commit({ workerId: batchWorker, page: fixture.page([
      pullRecord("multi-1", { items }), pullRecord("multi-2", { items }),
    ]) });
    assert.equal(first.kind, "committed");
    const state = await factBatchState(client, fixture.runId);
    for (const [n, pull] of state.pulls.entries()) {
      const actual = state.items.filter(row => row.pull_id === pull.id);
      assert.equal(pull.item_count, 3);
      assert.deepEqual(actual.map(row => [row.ordinal, row.collectible_key, row.quantity, row.stated_value_amount?.toString()]),
        [[1, "card-0", 1n, "0.125"], [2, "card-1", 2n, "1.125"], [3, "card-2", 3n, "2.125"]]);
      assert.deepEqual(state.promotions.slice(n * 4, n * 4 + 4).map(row => row.entity_id), [pull.id, ...actual.map(row => row.id)]);
    }
    const largeItems = Array.from({ length: 1001 }, () => ({ collectibleKey: null, collectibleInstanceKey: null,
      quantity: "1", statedValueAmount: null, statedValueCurrency: null }));
    const second = await repo.commit({ workerId: batchWorker, page: fixture.page([
      pullRecord("large-valid", { items: largeItems }), pullRecord("after-large"),
    ], 2) });
    assert.equal(second.kind, "committed"); if (second.kind !== "committed") return;
    assert.equal(second.counts.accepted, 2); assert.equal(second.counts.quarantined, 0);
    const large = await client.pulls.findUniqueOrThrow({ where: { pull_key: "large-valid" } });
    assert.equal(large.item_count, 1001); assert.equal(await client.pull_items.count({ where: { pull_id: large.id } }), 1001);
    assert.equal(await client.promotion_changes.count(), 8 + 1002 + 2);
  } finally { await harness.close(); }
});

test("fact prefetch preserves active account and instance binding and rejects retired or mismatched subjects", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    const accountKey = "d".repeat(64);
    const catalog: FactRecordInput[] = [categoryRecord(), cardRecord("card-0"), cardRecord("card-1"),
      { kind: "catalog", entityType: "provider_account", operation: "upsert", candidate: {
        accountKey, displayName: null, attributes: {} } },
      { kind: "catalog", entityType: "collectible_instance", operation: "upsert", candidate: {
        collectibleKey: "card-0", instanceKey: "instance-0", certifier: null, certificationNumber: null, attributes: {} } }];
    const instanceItem = { collectibleKey: "card-0", collectibleInstanceKey: "instance-0", quantity: "1",
      statedValueAmount: null, statedValueCurrency: null };
    const first = await repo.commit({ workerId: batchWorker, page: fixture.page([...catalog,
      pullRecord("active-1", { providerAccountKey: accountKey, items: [instanceItem] }),
      pullRecord("active-2", { providerAccountKey: accountKey, items: [instanceItem] }),
      eventRecord("active-1", { fromProviderAccountKey: accountKey, collectibleInstanceKey: "instance-0" }),
      eventRecord("active-2", { toProviderAccountKey: accountKey, collectibleInstanceKey: "instance-0" }),
    ]) });
    assert.equal(first.kind, "committed"); if (first.kind !== "committed") return;
    assert.equal(first.counts.quarantined, 0);
    const account = await client.provider_accounts.findUniqueOrThrow({ where: { account_key: accountKey } });
    const instance = await client.collectible_instances.findUniqueOrThrow({ where: { instance_key: "instance-0" } });
    const state = await factBatchState(client, fixture.runId);
    assert.ok(state.pulls.every(row => row.provider_account_id === account.id));
    assert.ok(state.items.every(row => row.collectible_instance_id === instance.id));
    assert.equal(state.events[0]!.from_provider_account_id, account.id);
    assert.equal(state.events[1]!.to_provider_account_id, account.id);
    const mismatch = await repo.commit({ workerId: batchWorker, page: fixture.page([
      pullRecord("mismatch", { items: [{ ...instanceItem, collectibleKey: "card-1" }] }), pullRecord("good"),
      eventRecord("mismatch", { collectibleKey: "card-1", collectibleInstanceKey: "instance-0" }), eventRecord("good"),
    ], 2) });
    assert.equal(mismatch.kind, "committed"); if (mismatch.kind !== "committed") return;
    assert.equal(mismatch.counts.quarantined, 2); assert.equal(mismatch.counts.accepted, 2);
    const retire: FactRecordInput[] = [
      { kind: "catalog", entityType: "provider_account", operation: "retire", candidate: {
        id: account.id, expectedRowVersion: "1", retiredAt: "2026-08-30T00:00:00.000Z" } },
      { kind: "catalog", entityType: "collectible_instance", operation: "retire", candidate: {
        id: instance.id, expectedRowVersion: "1", retiredAt: "2026-08-30T00:00:00.000Z" } },
    ];
    const last = await repo.commit({ workerId: batchWorker, page: fixture.page([...retire,
      pullRecord("retired-account", { providerAccountKey: accountKey }),
      pullRecord("retired-instance", { items: [instanceItem] }),
      eventRecord("retired-account", { fromProviderAccountKey: accountKey }),
      eventRecord("retired-instance", { collectibleInstanceKey: "instance-0" }),
    ], 3) });
    assert.equal(last.kind, "committed"); if (last.kind !== "committed") return;
    assert.equal(last.counts.accepted, 2); assert.equal(last.counts.quarantined, 4);
    assert.equal(await client.pulls.count(), 3); assert.equal(await client.pull_items.count(), 3);
    assert.equal(await client.market_events.count(), 3);
  } finally { await harness.close(); }
});
