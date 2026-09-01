import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { batchWorker, prepareBatchFixture } from "./provider-quarantine-batch-integration-support.ts";
import { cardRecord, categoryRecord } from "./provider-collectible-batch-test-support.ts";
import { pullRecord, eventRecord, factBatchState, type FactRecordInput } from "./provider-fact-batch-test-support.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";

test("fact chunks preserve same-key replay, immutable corrections and original per-record quarantine order", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    const records = [categoryRecord(), cardRecord("card-0"), pullRecord("repeat"), pullRecord(" repeat "),
      pullRecord("repeat", { factDigest: "c".repeat(64) }), pullRecord("tail"),
      eventRecord("repeat"), eventRecord("repeat"), eventRecord("repeat", { factDigest: "c".repeat(64) }), eventRecord("tail")];
    const page = fixture.page(records);
    const result = await repo.commit({ workerId: batchWorker, page });
    assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
    assert.deepEqual(result.counts, { records: 10, catalog: 2, pulls: 4, marketEvents: 4,
      accepted: 6, duplicate: 2, quarantined: 2, materialChanges: 6 });
    const state = await factBatchState(client, fixture.runId);
    assert.equal(state.pulls.length, 2); assert.equal(state.items.length, 2); assert.equal(state.events.length, 2);
    assert.deepEqual(state.quarantines.map(row => row.record_index).sort((a, b) => a - b), [4, 8]);
    assert.ok(state.quarantines.every(row => row.reason_code === "IMMUTABLE_FACT_CONFLICT"));
    assert.equal(state.outbox.filter(row => row.local_quarantine_id !== null).length, 2);
    assert.equal(state.promotions.length, 8); assert.equal(state.ledger.last_sequence, 8n);
    assert.equal((await repo.commit({ workerId: batchWorker, page })).kind, "replayed");
    assert.deepEqual(await factBatchState(client, fixture.runId), state);
  } finally { await harness.close(); }
});

test("batched replay retains create-only validation timing and validates references and item fields first", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("card-0"),
      pullRecord("p1"), pullRecord("p2"), eventRecord("e1"), eventRecord("e2")]) });
    const before = await factBatchState(client, fixture.runId);
    const replay = await repo.commit({ workerId: batchWorker, page: fixture.page([
      pullRecord("p1", { paidAmount: "not-money" }), pullRecord("p2", { paidAmount: "not-money" }),
      eventRecord("e1", { amount: "not-money", quantity: "0" }), eventRecord("e2", { amount: "not-money" }),
    ], 2) });
    assert.equal(replay.kind, "committed"); if (replay.kind !== "committed") return;
    assert.equal(replay.counts.duplicate, 4); assert.equal(replay.counts.quarantined, 0);
    const after = await factBatchState(client, fixture.runId);
    for (const key of ["pulls", "items", "events", "promotions", "ledger"] as const) assert.deepEqual(after[key], before[key]);
    const invalid = await repo.commit({ workerId: batchWorker, page: fixture.page([
      pullRecord("p1", { providerAccountKey: "missing-account" }), pullRecord("p2", { items: [{
        collectibleKey: "card-0", collectibleInstanceKey: null, quantity: "0", statedValueAmount: null, statedValueCurrency: null,
      }] }), eventRecord("e1", { fromProviderAccountKey: "missing-account" }),
      eventRecord("e2", { collectibleInstanceKey: "missing-instance" }),
    ], 3) });
    assert.equal(invalid.kind, "committed"); if (invalid.kind !== "committed") return;
    assert.equal(invalid.counts.quarantined, 4); assert.equal(invalid.counts.duplicate, 0);
    const final = await factBatchState(client, fixture.runId);
    for (const key of ["pulls", "items", "events", "promotions", "ledger"] as const) assert.deepEqual(final[key], before[key]);
  } finally { await harness.close(); }
});

test("catalog boundaries preserve unresolved and retired references without replay enrichment", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    const first = await repo.commit({ workerId: batchWorker, page: fixture.page([
      pullRecord("before-1"), pullRecord("before-2"), categoryRecord(), cardRecord("card-0"),
      pullRecord("after-1"), pullRecord("after-2"), eventRecord("after-1"), eventRecord("after-2"),
    ]) });
    assert.equal(first.kind, "committed");
    const card = await client.collectibles.findUniqueOrThrow({ where: { collectible_key: "card-0" } });
    const original = await factBatchState(client, fixture.runId);
    const beforeIds = new Set(original.pulls.filter(row => row.pull_key.startsWith("before")).map(row => row.id));
    assert.ok(original.items.filter(row => beforeIds.has(row.pull_id)).every(row => row.collectible_id === null));
    assert.ok(original.items.filter(row => !beforeIds.has(row.pull_id)).every(row => row.collectible_id === card.id));
    const records: FactRecordInput[] = [{ kind: "catalog", entityType: "collectible", operation: "retire",
      candidate: { id: card.id, expectedRowVersion: "1", retiredAt: "2026-08-30T00:00:00.000Z" } },
      pullRecord("before-1"), pullRecord("before-2"), pullRecord("retired-1"), pullRecord("retired-2"),
      eventRecord("retired-1"), eventRecord("retired-2")];
    const second = await repo.commit({ workerId: batchWorker, page: fixture.page(records, 2) });
    assert.equal(second.kind, "committed"); if (second.kind !== "committed") return;
    assert.equal(second.counts.accepted, 5); assert.equal(second.counts.duplicate, 2); assert.equal(second.counts.quarantined, 0);
    const after = await factBatchState(client, fixture.runId);
    assert.deepEqual(after.items.filter(row => beforeIds.has(row.pull_id)), original.items.filter(row => beforeIds.has(row.pull_id)));
    assert.ok(after.events.filter(row => row.event_key.startsWith("retired")).every(row => row.collectible_id === card.id));
    assert.ok(after.items.filter(row => !beforeIds.has(row.pull_id)).every(row => row.collectible_id === card.id));
  } finally { await harness.close(); }
});

for (const kind of ["pull", "market_event"] as const) {
  test(`native ${kind} foreign-key failure rolls back bulk writes then quarantines only the bad record`, async context => {
    if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
    const harness = await createProviderHarness(), { client } = harness;
    try {
      const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
      await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("card-0")]) });
      const column = kind === "pull" ? "collectible_id" : "from_provider_account_id";
      const table = kind === "pull" ? "pull_items" : "market_events";
      const condition = kind === "pull" ? "NEW.collectible_key = 'reject'" : "NEW.event_key = 'reject'";
      await client.$executeRawUnsafe(`CREATE FUNCTION synthetic_fact_constraint() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condition} THEN NEW.${column} := '${randomUUID()}'::uuid; END IF; RETURN NEW; END; $$`);
      await client.$executeRawUnsafe(`CREATE TRIGGER synthetic_fact_constraint BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION synthetic_fact_constraint()`);
      const make = kind === "pull" ? pullRecord : eventRecord;
      const bad = kind === "pull" ? pullRecord("reject", { items: [{ collectibleKey: "reject", collectibleInstanceKey: null,
        quantity: "1", statedValueAmount: null, statedValueCurrency: null }] }) : eventRecord("reject");
      const result = await repo.commit({ workerId: batchWorker, page: fixture.page([make("first"), bad, make("last")], 2) });
      assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
      assert.equal(result.counts.accepted, 2); assert.equal(result.counts.quarantined, 1);
      const state = await factBatchState(client, fixture.runId);
      assert.equal(state.pulls.length, kind === "pull" ? 2 : 0); assert.equal(state.items.length, kind === "pull" ? 2 : 0);
      assert.equal(state.events.length, kind === "market_event" ? 2 : 0);
      assert.equal(state.promotions.length, kind === "pull" ? 6 : 4);
      assert.equal(state.quarantines[0]!.record_index, 1); assert.equal(state.quarantines[0]!.reason_code, "CANONICAL_CONSTRAINT_FAILED");
      assert.equal(state.outbox.filter(row => row.local_quarantine_id !== null).length, 1);
    } finally { await harness.close(); }
  });
}

test("a custom check error remains unknown and rolls back the whole page", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    const before = await factBatchState(client, fixture.runId);
    await client.$executeRawUnsafe(`CREATE FUNCTION synthetic_fact_unknown() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_key = 'reject' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='synthetic_unknown'; END IF; RETURN NEW; END; $$`);
    await client.$executeRawUnsafe(`CREATE TRIGGER synthetic_fact_unknown BEFORE INSERT ON market_events
      FOR EACH ROW EXECUTE FUNCTION synthetic_fact_unknown()`);
    await assert.rejects(repo.commit({ workerId: batchWorker, page: fixture.page([
      categoryRecord(), pullRecord("before"), pullRecord("before-2"), eventRecord("first"), eventRecord("reject"),
    ]) }), Prisma.PrismaClientUnknownRequestError);
    assert.deepEqual(await factBatchState(client, fixture.runId), before);
  } finally { await harness.close(); }
});

for (const code of ["P2010", "P2028"] as const) {
  test(`unknown ${code} after fact inserts aborts without fallback or whole-page retry`, async context => {
    if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
    const harness = await createProviderHarness(), { client } = harness;
    try {
      const fixture = await prepareBatchFixture(client, harness.providerKey), before = await factBatchState(client, fixture.runId);
      const error = new Prisma.PrismaClientKnownRequestError("Synthetic unknown fact failure", {
        code, clientVersion: "6.19.3", meta: { code: "P0001", error: "Synthetic non-expiration failure" },
      });
      let intercepted = 0;
      const observed = client.$extends({ query: { pull_items: { async createMany({ args, query }) {
        await query(args); intercepted += 1; throw error;
      } } } }) as unknown as ProviderPrismaClient;
      await assert.rejects(new PrismaProviderMixedPageRepository(observed).commit({ workerId: batchWorker,
        page: fixture.page([categoryRecord(), pullRecord("a"), pullRecord("b")]) }), actual => actual === error);
      assert.equal(intercepted, 1); assert.deepEqual(await factBatchState(client, fixture.runId), before);
    } finally { await harness.close(); }
  });
}

test("an unexpected bulk insertion count rolls back before fallback without leaking parent or item identities", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey); let injected = false;
    const observed = client.$extends({ query: { pull_items: { async createMany({ args, query }) {
      const result = await query(args);
      if (!injected) { injected = true; return { count: result.count - 1 }; }
      return result;
    } } } }) as unknown as ProviderPrismaClient;
    const result = await new PrismaProviderMixedPageRepository(observed).commit({ workerId: batchWorker,
      page: fixture.page([pullRecord("a"), pullRecord("b")]) });
    assert.equal(result.kind, "committed"); assert.equal(injected, true);
    const state = await factBatchState(client, fixture.runId);
    assert.equal(state.pulls.length, 2); assert.equal(state.items.length, 2); assert.equal(state.promotions.length, 4);
    assert.equal(state.quarantines.length, 0); assert.equal(state.ledger.last_sequence, 4n);
  } finally { await harness.close(); }
});

test("wrong provider and lease fences refuse a fact batch before writes", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    const before = await factBatchState(client, fixture.runId);
    const { responseDigest: originalDigest, ...body } = fixture.page([pullRecord("a"), pullRecord("b")]);
    for (const wrongProvider of [true, false]) {
      const providerId = wrongProvider ? randomUUID() : body.providerId;
      const changed = { ...body, providerId, leaseFence: wrongProvider ? body.leaseFence : "9999",
        records: body.records.map(row => ({ ...row, providerId })) };
      const responseDigest = providerMixedPageDigest(changed); assert.notEqual(responseDigest, originalDigest);
      assert.deepEqual(await repo.commit({ workerId: batchWorker, page: { ...changed, responseDigest } }),
        { kind: wrongProvider ? "provider_mismatch" : "lease_lost" });
      assert.deepEqual(await factBatchState(client, fixture.runId), before);
    }
  } finally { await harness.close(); }
});
