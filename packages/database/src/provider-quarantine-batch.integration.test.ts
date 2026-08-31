import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { batchRecords, batchState, batchWorker, prepareBatchFixture, recordBatchOperations,
  sourceRejection } from "./provider-quarantine-batch-integration-support.ts";

test("mixed quarantines preserve order, duplicates, digest-bound outboxes and replay with bounded database operations", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("An explicit disposable PostgreSQL test target is required."); return; }
  const harness = await createProviderHarness(); const { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey);
    const repository = new PrismaProviderMixedPageRepository(client);
    assert.equal((await repository.commit({ workerId: batchWorker, page: fixture.page([sourceRejection("prior")]) })).kind, "committed");
    const before = await batchState(client, fixture.runId), page = fixture.page(batchRecords(), 2);
    const observed = recordBatchOperations(client);
    const result = await new PrismaProviderMixedPageRepository(observed.database).commit({ workerId: batchWorker, page });
    assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
    assert.deepEqual(result.counts, { records: 106, catalog: 2, pulls: 104, marketEvents: 0,
      accepted: 1, duplicate: 2, quarantined: 103, materialChanges: 1 });
    assert.deepEqual(observed.operations, ["quarantine_records.findMany", "quarantine_records.createMany",
      "provider_activity_outbox.createMany", "quarantine_records.createMany", "provider_activity_outbox.createMany"],
    "One source-key lookup and two insert pairs replace per-record database operations.");
    const after = await batchState(client, fixture.runId);
    const quarantines = after.quarantines.filter(row => row.provider_run_page_id === page.pageId)
      .sort((left, right) => left.record_index - right.record_index);
    assert.deepEqual(result.quarantineIds, quarantines.map(row => row.id));
    assert.deepEqual(quarantines.map(row => row.record_index), [1, 3, ...Array.from({ length: 101 }, (_, index) => index + 5)]);
    assert.equal(after.categories.length, 1, "A valid category after a failed record retains the existing savepoint behavior.");
    assert.equal(after.promotions.length, before.promotions.length + 1);
    assert.equal(after.run.page_count, 2); assert.equal(after.run.quarantined_count, 104);
    assert.equal(after.runtime.source_cursor_hash, page.nextCursorFingerprint);
    const prior = after.quarantines.find(row => row.id === before.quarantines[0]!.id);
    assert.deepEqual(prior, before.quarantines[0], "An earlier source rejection is not rewritten.");
    for (const row of quarantines) {
      const source = row.source_record_key !== null;
      assert.equal(row.state, source ? "expired" : "open");
      assert.equal(row.protected_evidence, null);
      if (source) { assert.equal(row.normalized_candidate, null); assert.deepEqual(row.evidence_expired_at, row.created_at); }
      else { assert.notEqual(row.normalized_candidate, null); assert.equal(row.evidence_expired_at, null); }
      const activity = after.outbox.filter(event => event.local_quarantine_id === row.id);
      assert.equal(activity.length, 1); const event = activity[0]!;
      assert.equal(event.local_run_id, page.runId);
      assert.equal(event.event_type, source ? "provider.quarantine.expired" : "provider.quarantine.opened");
      assert.equal(event.dedupe_key, `quarantine:${row.id}:${source ? "expired" : "open"}`);
      assert.equal(event.recovery_key, `quarantine:${row.id}`);
      assert.deepEqual(event.evidence, { quarantineState: row.state });
      const identity = { id: event.id, eventType: event.event_type, severity: event.severity,
        dedupeKey: event.dedupe_key, recoveryKey: event.recovery_key, localRunId: event.local_run_id,
        localQuarantineId: event.local_quarantine_id, title: event.title, summary: event.summary,
        evidence: event.evidence, eventAt: event.event_at.toISOString() };
      assert.equal(event.event_digest, createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
    }
    const replay = await repository.commit({ workerId: batchWorker, page });
    assert.equal(replay.kind, "replayed"); if (replay.kind === "replayed") assert.deepEqual(replay.quarantineIds, result.quarantineIds);
    assert.deepEqual(await batchState(client, fixture.runId), after);
  } finally { await harness.close(); }
});

test("failure in a later outbox batch rolls back earlier batches, canonical writes, promotions, receipt and checkpoint", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("An explicit disposable PostgreSQL test target is required."); return; }
  const harness = await createProviderHarness(); const { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey);
    const repository = new PrismaProviderMixedPageRepository(client);
    await repository.commit({ workerId: batchWorker, page: fixture.page([sourceRejection("prior")]) });
    const before = await batchState(client, fixture.runId), page = fixture.page(batchRecords(), 2);
    await client.$executeRawUnsafe(`CREATE FUNCTION synthetic_reject_late_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS (SELECT 1 FROM quarantine_records WHERE id = NEW.local_quarantine_id AND record_index >= 103)
      THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'synthetic_late_outbox_rejected'; END IF; RETURN NEW; END; $$`);
    await client.$executeRawUnsafe(`CREATE TRIGGER synthetic_reject_late_outbox BEFORE INSERT ON provider_activity_outbox
      FOR EACH ROW EXECUTE FUNCTION synthetic_reject_late_outbox()`);
    const observed = recordBatchOperations(client);
    await assert.rejects(new PrismaProviderMixedPageRepository(observed.database).commit({ workerId: batchWorker, page }));
    assert.equal(observed.operations.filter(value => value === "quarantine_records.findMany").length, 1,
      "A failed outbox constraint must not broaden the existing transaction retry policy.");
    assert.equal(observed.operations.filter(value => value === "provider_activity_outbox.createMany").length, 2);
    assert.deepEqual(await batchState(client, fixture.runId), before);
    await client.$executeRawUnsafe("DROP TRIGGER synthetic_reject_late_outbox ON provider_activity_outbox");
    assert.equal((await repository.commit({ workerId: batchWorker, page })).kind, "committed");
  } finally { await harness.close(); }
});

test("provider identity and insufficient extended lease refuse before quarantine lookup or writes", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) { context.skip("An explicit disposable PostgreSQL test target is required."); return; }
  const harness = await createProviderHarness(); const { client } = harness;
  try {
    const fixture = await prepareBatchFixture(client, harness.providerKey, 60_000);
    const before = await batchState(client, fixture.runId), observed = recordBatchOperations(client);
    const repository = new PrismaProviderMixedPageRepository(observed.database);
    const page = fixture.page([sourceRejection("new")]);
    assert.deepEqual(await repository.commit({ workerId: batchWorker, page,
      maximumTransactionMilliseconds: 480_000, deadlineAt: Date.now() + 540_000 }), { kind: "lease_lost" });
    const providerId = randomUUID(); const { responseDigest, ...body } = page;
    const wrong = { ...body, providerId,
      records: page.records.map(record => ({ ...record, providerId })) };
    const wrongDigest = providerMixedPageDigest(wrong); assert.notEqual(wrongDigest, responseDigest);
    assert.deepEqual(await repository.commit({ workerId: batchWorker,
      page: { ...wrong, responseDigest: wrongDigest } }), { kind: "provider_mismatch" });
    assert.deepEqual(observed.operations, []); assert.deepEqual(await batchState(client, fixture.runId), before);
    assert.equal((await repository.commit({ workerId: batchWorker, page })).kind, "committed",
      "The ordinary 30-second local page path is unchanged.");
  } finally { await harness.close(); }
});
