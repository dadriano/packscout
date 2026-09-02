import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ProviderPrismaClient, ProviderQueryClient, ProviderTransactionClient } from "./provider-database.ts";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { PrismaProviderRuntimeRepository } from "./provider-runtime-repository.ts";
import { PrismaProviderWorkerLeaseRepository } from "./provider-worker-lease-repository.ts";
import { PrismaProviderRunRepository } from "./provider-run-repository.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { ProviderPageTransactionExpiredError } from "./provider-page-transaction.ts";
import { PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerMixedCursorFingerprint,
  providerMixedPageDigest } from "./provider-mixed-page-contract.ts";

const workerId = "integration:page-constraint-boundary";

async function pageState(database: ProviderQueryClient, runId: string) {
  return {
    runtime: await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    run: await database.provider_runs.findUniqueOrThrow({ where: { id: runId } }),
    pages: await database.provider_run_pages.count(), categories: await database.categories.count(),
    pulls: await database.pulls.count(), items: await database.pull_items.count(),
    quarantines: await database.quarantine_records.count(), outbox: await database.provider_activity_outbox.count(),
    promotions: await database.promotion_changes.count(),
    ledger: await database.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }),
  };
}

async function prepare(client: ProviderPrismaClient, providerKey: string) {
  const { provider_id: providerId } = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
  assert.ok(providerId);
  const configId = randomUUID(), runId = randomUUID();
  await new PrismaProviderRuntimeRepository(client).synchronizeConfiguration({ centralProviderId: providerId,
    providerKey, configVersionId: configId, configVersionNumber: 1n, configuration: { adapterKey: "synthetic" },
    expiresAt: null, scheduleSeconds: 300, nextDueAt: null, synchronizedAt: new Date() });
  const leased = await new PrismaProviderWorkerLeaseRepository(client).acquire({ role: "import", owner: workerId,
    leaseMilliseconds: 300_000 });
  assert.notEqual(leased.kind, "held"); if (leased.kind === "held") throw new Error("Synthetic lease unavailable.");
  const fence = leased.lease.fence;
  const started = await new PrismaProviderRunRepository(client).start({ runId, idempotencyKey: "constraint-boundary",
    trigger: "manual", requestedByOperatorId: null, configVersionId: configId, configVersionNumber: 1n,
    workerId, workerFence: fence, correlationId: randomUUID(), requestedAt: new Date() });
  assert.equal(started.kind, "started");
  const nextCursor = { page: "synthetic-next" };
  const body = { contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerId, runId,
    configVersionId: configId, configVersionNumber: "1", leaseFence: fence.toString(), pageId: randomUUID(),
    pageNumber: 1, inputCursor: null, inputCursorFingerprint: null, nextCursor,
    nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor), continuation: "more", records: [
      { position: 0, providerId, kind: "catalog", entityType: "category", operation: "upsert",
        candidate: { categoryKey: "synthetic-category", parentCategoryKey: null, displayName: "Synthetic category" } },
      { position: 1, providerId, kind: "pull", candidate: { pullKey: "synthetic-pull", factDigest: "a".repeat(64),
        packKey: null, providerAccountKey: null, occurredAt: "2026-08-31T00:00:00.000Z",
        paidAmount: null, paidCurrency: null, items: [{ collectibleKey: "missing-collectible",
          collectibleInstanceKey: null, quantity: "1", statedValueAmount: null, statedValueCurrency: null }] } },
      { position: 2, providerId, kind: "catalog", entityType: "category", operation: "upsert",
        candidate: { categoryKey: "unresolved-category", parentCategoryKey: "missing-parent", displayName: "Unresolved category" } },
      { position: 3, providerId, kind: "pull", disposition: "quarantine", candidate: {},
        sourceRecordKey: `source:${"b".repeat(64)}`, reasonCode: "NORMALIZED_CANDIDATE_INVALID",
        fieldPath: null, sanitizedSummary: "Synthetic mapping failure." },
    ] };
  await client.$executeRawUnsafe(`CREATE FUNCTION synthetic_slow_page_constraint() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN IF current_setting('packscout.synthetic_slow_constraint', true) = 'on' THEN
      PERFORM pg_sleep(3); END IF; RETURN NULL; END; $$`);
  await client.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER synthetic_slow_page_constraint
    AFTER INSERT ON categories DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION synthetic_slow_page_constraint()`);
  return { runId, page: { ...body, responseDigest: providerMixedPageDigest(body) } };
}

for (const exhaustion of [false, true]) {
  test(`deferred mixed-page constraint expiry ${exhaustion ? "exhausts two attempts with no page effects" : "rolls back before the one retry commits the entire page"}`, async context => {
    if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
      context.skip("An explicit disposable PostgreSQL test target is required."); return;
    }
    const harness = await createProviderHarness(); const { client } = harness;
    try {
      const { runId, page } = await prepare(client, harness.providerKey);
      const before = await pageState(client, runId); let attempts = 0;
      // Shorten only this disposable test's transaction. The production helper
      // still owns its normal deadlines, lease checks and two-attempt policy.
      const database = new Proxy(client, { get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return <T>(operation: (tx: ProviderTransactionClient) => Promise<T>, options: { maxWait: number; timeout: number }) => {
          attempts += 1; const slow = exhaustion || attempts === 1;
          return target.$transaction(async tx => {
            if (attempts > 1) assert.deepEqual(await pageState(tx, runId), before,
              "Canonical facts, promotions, checkpoint, page, counters, quarantines and outboxes must roll back together.");
            await tx.$executeRawUnsafe(slow ? "SET LOCAL packscout.synthetic_slow_constraint = 'on'"
              : "SET LOCAL packscout.synthetic_slow_constraint = 'off'");
            return operation(tx);
          }, { ...options, timeout: slow ? 1000 : options.timeout });
        };
      } });
      const operation = new PrismaProviderMixedPageRepository(database).commit({ workerId, page });
      if (exhaustion) {
        await assert.rejects(operation, ProviderPageTransactionExpiredError);
        assert.equal(attempts, 2); assert.deepEqual(await pageState(client, runId), before);
        return;
      }
      const result = await operation;
      assert.equal(result.kind, "committed"); assert.equal(attempts, 2);
      if (result.kind !== "committed") return;
      assert.deepEqual(result.counts, { records: 4, catalog: 2, pulls: 2, marketEvents: 0,
        accepted: 2, duplicate: 0, quarantined: 2, materialChanges: 2 });
      const after = await pageState(client, runId);
      assert.equal(after.categories, 1); assert.equal(after.pulls, 1); assert.equal(after.items, 1);
      assert.equal(after.promotions, 3); assert.equal(after.ledger.last_sequence, 3n);
      assert.equal(after.pages, 1); assert.equal(after.run.page_count, 1);
      assert.equal(after.run.accepted_count, 2); assert.equal(after.run.quarantined_count, 2);
      assert.equal(after.runtime.source_cursor_hash, page.nextCursorFingerprint);
      assert.equal(after.quarantines, 2); assert.equal(after.outbox, before.outbox + 2);
      assert.deepEqual((await client.quarantine_records.findMany({ select: { state: true }, orderBy: { state: "asc" } }))
        .map(row => row.state).sort(), ["expired", "open"]);
      const replay = await new PrismaProviderMixedPageRepository(client).commit({ workerId, page });
      assert.equal(replay.kind, "replayed"); assert.deepEqual(await pageState(client, runId), after);
    } finally { await harness.close(); }
  });
}
