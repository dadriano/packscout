import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PROVIDER_MIXED_PAGE_CONTRACT_VERSION, PROVIDER_HEAD_RECONCILIATION_ACTION,
  PrismaProviderHeadReconciliationRepository, PrismaProviderRuntimeRepository, readProviderRunHeadProof,
  providerMixedCursorFingerprint, providerMixedPageDigest, type ProviderPrismaClient } from "@packscout/database";
import { createHarness, enqueue } from "./provider-manual-import-integration-support.ts";
import { ProviderManualImportExecutor } from "./provider-manual-import-executor.ts";

async function seedWideCatalog(client: ProviderPrismaClient) {
  await client.$transaction(async tx => {
    await tx.$executeRaw`
      INSERT INTO collectibles (id, collectible_key, collectible_type, display_name, normalized_name, data_as_of)
      SELECT md5('head-target-' || n)::uuid, 'target-' || lpad(n::text, 6, '0'),
        'card'::collectible_type, 'Synthetic target', 'synthetic target', CURRENT_TIMESTAMP FROM generate_series(1, 501) AS n
    `;
    await tx.$executeRaw`
      INSERT INTO market_events (event_key, fact_digest, event_type, collectible_key, occurred_at)
      VALUES ('late-event', repeat('b', 64), 'sale'::market_event_type, 'target-000501', CURRENT_TIMESTAMP)
    `;
    await tx.promotion_ledger.update({ where: { singleton_key: true }, data: { last_sequence: 502n } });
    await tx.$executeRaw`
      INSERT INTO promotion_changes (sequence, entity_type, entity_id, entity_version, operation, changed_at)
      SELECT row_number() OVER (ORDER BY kind, id), kind, id, 1, 'upsert'::promotion_operation, CURRENT_TIMESTAMP
      FROM (SELECT 'collectible' AS kind, id FROM collectibles UNION ALL SELECT 'market_event', id FROM market_events) AS seed
    `;
  });
}

test("head progress survives a callback crash, resumes receipts without source refetch, and rolls back an unrecorded resolution", async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
    context.skip("An explicit disposable PostgreSQL test target is required."); return;
  }
  const harness = await createHarness(); const { client } = harness;
  try {
    await seedWideCatalog(client);
    const configId = randomUUID();
    await new PrismaProviderRuntimeRepository(client).synchronizeConfiguration({ centralProviderId: harness.providerId,
      providerKey: harness.providerKey, configVersionId: configId, configVersionNumber: 1n,
      configuration: { adapterKey: "synthetic-head" }, expiresAt: null, scheduleSeconds: 300, nextDueAt: null, synchronizedAt: new Date() });
    const runId = await enqueue(harness, configId, 1); let workerId = "integration:durable-head";
    let sourceReads = 0;
    const source = { supports: () => true, async nextPage(input: Parameters<import("./provider-manual-import-executor.ts").ProviderManualImportPageSource["nextPage"]>[0]) {
      sourceReads += 1; assert.equal(sourceReads, 1, "Committed source head must never be fetched again.");
      const nextCursor = { at: "synthetic-head" };
      const body = { contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerId: input.authority.providerId,
        runId: input.runId, configVersionId: configId, configVersionNumber: "1", leaseFence: input.workerFence.toString(),
        pageId: randomUUID(), pageNumber: 1, inputCursor: null, inputCursorFingerprint: null, nextCursor,
        nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor), continuation: "head", records: [] };
      return { ...body, responseDigest: providerMixedPageDigest(body) };
    } };
    const immediateDelivery = { async request() {} };
    const create = () => new ProviderManualImportExecutor({
      database: client,
      workerId,
      source,
      immediateDelivery,
    });
    const first = await create().executeNextPage();
    if (first.kind !== "progress") context.diagnostic(JSON.stringify({ first, run: await client.provider_runs.findUnique({ where: { id: runId }, select: { failure_summary: true } }) }));
    assert.equal(first.kind, "progress");
    const run = await client.provider_runs.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(run.state, "running"); assert.equal(run.reached_source_head, true); assert.equal(run.page_count, 1);
    const before = await client.local_audit_events.findFirstOrThrow({ where: { action: PROVIDER_HEAD_RECONCILIATION_ACTION, target_id: runId }, orderBy: { sequence: "desc" } });
    assert.equal((before.details as { batchNumber: number }).batchNumber, 1);
    assert.equal(await new PrismaProviderHeadReconciliationRepository(client).step({ runId, workerId, workerFence: run.worker_fence + 1n }), "lease_lost");

    // A crashed process loses its lease. Fenced recovery keeps the original
    // source page in its parent while the zero-page child resumes that receipt.
    await client.provider_worker_states.update({ where: { worker_role: "import" }, data: { heartbeat_at: new Date(Date.now() - 10_000), lease_expires_at: new Date(Date.now() - 1_000), row_version: { increment: 1n } } });
    workerId = "integration:durable-head-recovered";
    assert.equal((await create().executeNextPage()).kind, "progress");
    const child = await client.provider_runs.findFirstOrThrow({ where: { recovery_of_run_id: runId, state: "running" } });
    assert.equal(child.page_count, 0); assert.equal(child.reached_source_head, true);
    const proof = await readProviderRunHeadProof(client, child.id);
    assert.equal(proof?.sourceRunId, runId); assert.equal(proof?.reconciliationComplete, false);
    await client.provider_runtime.update({ where: { singleton_key: true }, data: { cached_config_version_id: randomUUID(), row_version: { increment: 1n } } });
    assert.equal(await readProviderRunHeadProof(client, child.id), null);
    assert.equal(await new PrismaProviderHeadReconciliationRepository(client).step({ runId: child.id, workerId, workerFence: child.worker_fence }), "run_not_ready");
    await client.provider_runtime.update({ where: { singleton_key: true }, data: { cached_config_version_id: configId, row_version: { increment: 1n } } });
    await client.provider_runtime.update({ where: { singleton_key: true }, data: { source_cursor_hash: "c".repeat(64), row_version: { increment: 1n } } });
    assert.equal(await readProviderRunHeadProof(client, child.id), null);
    await client.provider_runtime.update({ where: { singleton_key: true }, data: { source_cursor_hash: proof!.checkpointHash, row_version: { increment: 1n } } });
    const faulty = client.$extends({ query: { local_audit_events: { async create({ args, query }) {
      if (args.data.action === PROVIDER_HEAD_RECONCILIATION_ACTION) throw new Error("synthetic crash before receipt");
      return query(args);
    } } } });
    await assert.rejects(new PrismaProviderHeadReconciliationRepository(faulty as unknown as ProviderPrismaClient)
      .step({ runId: child.id, workerId, workerFence: child.worker_fence }), /synthetic crash/u);
    assert.equal(await client.market_events.count({ where: { collectible_id: null } }), 1);
    assert.equal(await client.promotion_changes.count(), 502);
    assert.equal(await client.local_audit_events.count({ where: { action: PROVIDER_HEAD_RECONCILIATION_ACTION, target_id: child.id } }), 1);
    const completed = await create().executeNextPage();
    assert.equal(completed.kind, "completed"); assert.equal(sourceReads, 1);
    assert.equal(await client.market_events.count({ where: { collectible_id: null } }), 0);
    assert.equal(await client.promotion_changes.count(), 503);
    const terminal = await client.provider_runs.findUniqueOrThrow({ where: { id: child.id } });
    assert.equal(terminal.state, "succeeded"); assert.equal(terminal.page_count, 0); assert.equal(terminal.accepted_count, 0);
    assert.equal(await client.local_audit_events.count({ where: { action: PROVIDER_HEAD_RECONCILIATION_ACTION, target_id: child.id } }), 2);
    assert.equal((await client.provider_runs.findUniqueOrThrow({ where: { id: runId } })).state, "incomplete");
    assert.equal((await readProviderRunHeadProof(client, child.id))?.reconciliationComplete, true);
    assert.equal(JSON.stringify(before.details).includes("target-"), false, "Audit positions must contain canonical UUIDs, never source keys.");
  } finally { await harness.close(); }
});
