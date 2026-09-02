import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { batchWorker, prepareBatchFixture } from "./provider-quarantine-batch-integration-support.ts";
import { cardRecord, categoryRecord, collectibleBatchState } from "./provider-collectible-batch-test-support.ts";

test("collectible chunks preserve mixed create/update/unchanged/older decisions, fields and promotion order", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("same", 2), cardRecord("older", 2), cardRecord("changed")]) });
    const before = await collectibleBatchState(client, fixture.runId);
    const page = fixture.page([cardRecord("created"), cardRecord("same", 2), cardRecord("changed", 3, {
      valuationAmount: "20.500", valuationUsdAmount: "20.500", brand: "Updated", year: 2025,
    }), cardRecord("older", 1, { displayName: "Old value must not replace current" })], 2);
    const result = await repo.commit({ workerId: batchWorker, page });
    assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
    assert.deepEqual(result.counts, { records: 4, catalog: 4, pulls: 0, marketEvents: 0,
      accepted: 2, duplicate: 2, quarantined: 0, materialChanges: 2 });
    const after = await collectibleBatchState(client, fixture.runId);
    for (const key of ["same", "older"]) assert.deepEqual(after.collectibles.find(row => row.collectible_key === key),
      before.collectibles.find(row => row.collectible_key === key));
    const changed = after.collectibles.find(row => row.collectible_key === "changed")!;
    assert.equal(changed.row_version, 2n); assert.equal(changed.valuation_amount!.toString(), "20.5");
    assert.equal(changed.valuation_usd_amount!.toString(), "20.5"); assert.equal(changed.year, 2025); assert.equal(changed.brand, "Updated");
    assert.equal(changed.primary_image_url, "https://example.test/image.png");
    assert.deepEqual(changed.attributes, { synthetic: true, evidence: ["fixed", 1] });
    assert.ok(changed.updated_at > before.collectibles.find(row => row.id === changed.id)!.updated_at);
    assert.deepEqual(changed.created_at, before.collectibles.find(row => row.id === changed.id)!.created_at);
    const byId = new Map(after.collectibles.map(row => [row.id, row.collectible_key]));
    assert.deepEqual(after.promotions.slice(before.promotions.length).map(row => [byId.get(row.entity_id), row.entity_version]),
      [["created", 1n], ["changed", 2n]], "Bulk writes preserve input promotion ordering across create/update groups.");
    assert.equal((await repo.commit({ workerId: batchWorker, page })).kind, "replayed");
    assert.deepEqual(await collectibleBatchState(client, fixture.runId), after);
  } finally { await harness.close(); }
});

test("known conflicts, retired rows, missing categories and repeated keys retain ordered per-record quarantines", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("conflict"), cardRecord("retired"), cardRecord("version")]) });
    const retired = await client.collectibles.findUniqueOrThrow({ where: { collectible_key: "retired" } });
    const records = [{ kind: "catalog", entityType: "collectible", operation: "retire", candidate: {
      id: retired.id, expectedRowVersion: "1", retiredAt: "2026-08-02T00:00:00.000Z",
    } } as const, cardRecord("conflict", 1, { displayName: "Conflicting same-clock value" }),
    cardRecord("retired", 3), cardRecord("version", 3, { expectedRowVersion: "99" }),
    cardRecord("missing", 1, { categoryKey: "category:missing" }), cardRecord("repeat", 1),
    cardRecord("repeat", 2), cardRecord("tail", 1)];
    const result = await repo.commit({ workerId: batchWorker, page: fixture.page(records, 2) });
    assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
    assert.equal(result.counts.accepted, 4); assert.equal(result.counts.quarantined, 4);
    assert.equal((await client.collectibles.findUniqueOrThrow({ where: { collectible_key: "repeat" } })).row_version, 2n);
    const quarantines = await client.quarantine_records.findMany({ orderBy: { record_index: "asc" } });
    assert.deepEqual(quarantines.map(row => row.record_index), [1, 2, 3, 4]);
    assert.deepEqual(quarantines.map(row => row.reason_code), ["CANONICAL_WRITE_CONFLICT", "CANONICAL_ENTITY_RETIRED", "CANONICAL_WRITE_CONFLICT", "NORMALIZED_CANDIDATE_INVALID"]);
    assert.equal(quarantines[3]!.field_path, "categoryKey");
    assert.ok(quarantines.every(row => row.state === "open" && row.normalized_candidate !== null));
    assert.equal(await client.provider_activity_outbox.count({ where: { local_quarantine_id: { not: null } } }), 4);
  } finally { await harness.close(); }
});

test("a native foreign-key failure in bulk CAS rolls back the chunk before known per-record fallback", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("valid"), cardRecord("invalid")]) });
    const before = await collectibleBatchState(client, fixture.runId);
    await client.$executeRawUnsafe(`CREATE FUNCTION synthetic_collectible_check() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.display_name = 'Rejected update' THEN NEW.category_id := '${randomUUID()}'::uuid; END IF; RETURN NEW; END; $$`);
    await client.$executeRawUnsafe(`CREATE TRIGGER synthetic_collectible_check BEFORE UPDATE ON collectibles FOR EACH ROW EXECUTE FUNCTION synthetic_collectible_check()`);
    const result = await repo.commit({ workerId: batchWorker, page: fixture.page([
      cardRecord("created"), cardRecord("valid", 2), cardRecord("invalid", 2, { displayName: "Rejected update" }), cardRecord("last"),
    ], 2) });
    assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
    assert.equal(result.counts.accepted, 3); assert.equal(result.counts.quarantined, 1);
    const after = await collectibleBatchState(client, fixture.runId);
    assert.equal(after.collectibles.length, 4); assert.equal(after.promotions.length, before.promotions.length + 3);
    assert.deepEqual(after.collectibles.find(row => row.collectible_key === "invalid"), before.collectibles.find(row => row.collectible_key === "invalid"));
    assert.equal(after.quarantines[0]!.record_index, 2); assert.equal(after.quarantines[0]!.reason_code, "CANONICAL_CONSTRAINT_FAILED");
  } finally { await harness.close(); }
});

test("chunk fallback preserves an unknown ordinary-Prisma check error as a whole-page failure", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("a"), cardRecord("b")]) });
    const before = await collectibleBatchState(client, fixture.runId);
    await client.$executeRawUnsafe(`CREATE FUNCTION synthetic_unknown_check() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.display_name = 'Unknown check' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='synthetic_unknown_check'; END IF; RETURN NEW; END; $$`);
    await client.$executeRawUnsafe(`CREATE TRIGGER synthetic_unknown_check BEFORE UPDATE ON collectibles FOR EACH ROW EXECUTE FUNCTION synthetic_unknown_check()`);
    await assert.rejects(repo.commit({ workerId: batchWorker, page: fixture.page([
      categoryRecord("Must roll back"), cardRecord("a", 2), cardRecord("b", 2, { displayName: "Unknown check" }),
    ], 2) }), Prisma.PrismaClientUnknownRequestError);
    assert.deepEqual(await collectibleBatchState(client, fixture.runId), before);
  } finally { await harness.close(); }
});

test("a partial bulk CAS result rolls back before per-record fallback and cannot leak an extra version", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("a"), cardRecord("b")]) });
    const before = await collectibleBatchState(client, fixture.runId); let injected = false;
    const database = new Proxy(client, { get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return <T>(operation: (tx: ProviderTransactionClient) => Promise<T>, options: object) => target.$transaction(tx =>
        operation(new Proxy(tx, { get(inner, key, innerReceiver) {
          if (key !== "$queryRaw") return Reflect.get(inner, key, innerReceiver);
          return async (query: Prisma.Sql) => {
            if (!injected && query.sql.includes("UPDATE collectibles AS current")) {
              injected = true;
              // A controlled in-transaction version change makes the real SQL
              // return only the other row. The chunk rollback must remove it.
              await inner.collectibles.updateMany({ where: { collectible_key: "a", row_version: 1n },
                data: { display_name: "Synthetic intervening version", row_version: 2n } });
            }
            return inner.$queryRaw(query);
          };
        } })), options);
    } });
    const result = await new PrismaProviderMixedPageRepository(database).commit({ workerId: batchWorker,
      page: fixture.page([cardRecord("a", 2), cardRecord("b", 2)], 2) });
    assert.equal(result.kind, "committed"); assert.equal(injected, true);
    const after = await collectibleBatchState(client, fixture.runId);
    assert.ok(after.collectibles.every(row => row.row_version === 2n && row.display_name.startsWith("Synthetic ")));
    assert.equal(after.collectibles[0]!.display_name, "Synthetic a");
    assert.equal(after.promotions.length, before.promotions.length + 2); assert.equal(after.quarantines.length, 0);
  } finally { await harness.close(); }
});

for (const code of ["P2010", "P2028"] as const) {
  test(`unknown ${code} after bulk writes aborts the entire page without fallback or retry`, async context => {
    if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
    const harness = await createProviderHarness(), { client } = harness;
    try {
      const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
      await repo.commit({ workerId: batchWorker, page: fixture.page([categoryRecord(), cardRecord("existing")]) });
      const before = await collectibleBatchState(client, fixture.runId);
      let transactions = 0, intercepted = 0;
      const error = new Prisma.PrismaClientKnownRequestError("Synthetic unknown transaction failure", {
        code, clientVersion: "6.19.3", meta: { code: "P0001", error: "Synthetic non-expiration failure" },
      });
      const database = new Proxy(client, { get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return <T>(operation: (tx: ProviderTransactionClient) => Promise<T>, options: object) => {
          transactions += 1;
          return target.$transaction(tx => operation(new Proxy(tx, { get(inner, key, innerReceiver) {
            if (key !== "$queryRaw") return Reflect.get(inner, key, innerReceiver);
            return async (query: Prisma.Sql) => { const result = await inner.$queryRaw(query);
              if (query.sql.includes("UPDATE collectibles AS current")) { intercepted += 1; throw error; }
              return result; };
          } })), options);
        };
      } });
      const page = fixture.page([categoryRecord("Changed category rolls back"), cardRecord("created"), cardRecord("existing", 2)], 2);
      await assert.rejects(new PrismaProviderMixedPageRepository(database).commit({ workerId: batchWorker, page }), actual => actual === error);
      assert.equal(transactions, 1); assert.equal(intercepted, 1);
      assert.deepEqual(await collectibleBatchState(client, fixture.runId), before);
    } finally { await harness.close(); }
  });
}

test("a foreign-provider collectible page is refused before any canonical batch effect", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("Explicit disposable PostgreSQL required."); return; }
  const harness = await createProviderHarness(), { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey), repo = new PrismaProviderMixedPageRepository(client);
    const before = await collectibleBatchState(client, fixture.runId), page = fixture.page([cardRecord("a"), cardRecord("b")]);
    const { responseDigest, ...body } = page; const providerId = randomUUID();
    const wrong = { ...body, providerId, records: body.records.map(row => ({ ...row, providerId })) };
    const digest = providerMixedPageDigest(wrong); assert.notEqual(digest, responseDigest);
    assert.deepEqual(await repo.commit({ workerId: batchWorker, page: { ...wrong, responseDigest: digest } }), { kind: "provider_mismatch" });
    assert.deepEqual(await collectibleBatchState(client, fixture.runId), before);
  } finally { await harness.close(); }
});
