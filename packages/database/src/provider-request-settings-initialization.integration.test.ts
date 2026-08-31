import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { createRequestSettingsHarness } from "./provider-request-settings.test-support.ts";

test("explicit handoff initialization locks both worker lanes and preserves the exact failed checkpoint and all history", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const cursor = { value: "synthetic-existing-checkpoint" }; const hash = providerMixedPageDigest(cursor);
    const runId = randomUUID(); const pageId = randomUUID(); const at = new Date();
    const lease = await h.leases.acquire({ role: "import", owner: h.workerId, leaseMilliseconds: 60_000 });
    assert.notEqual(lease.kind, "held"); if (lease.kind === "held") return;
    // Reproduce an old, uninitialized writer's valid durable page. The additive
    // migration must leave that already-authorized writer's history untouched.
    await h.client.$transaction(async (tx) => {
      await tx.provider_runs.create({ data: { id: runId, idempotency_key: `old/${runId}`, trigger: "scheduled",
        state: "running", config_version_id: h.configId, config_version_number: 1n,
        worker_fence: lease.lease.fence, requested_at: at, started_at: at } });
      await tx.provider_state_events.create({ data: { from_state: "idle", to_state: "running", state_generation: 1n,
        actor_type: "runner", actor_id: h.workerId, correlation_id: randomUUID(), occurred_at: at } });
      await tx.provider_runtime.update({ where: { singleton_key: true }, data: { operating_state: "running",
        state_generation: 1n, source_cursor: cursor, source_cursor_hash: hash, row_version: { increment: 1n } } });
      await tx.provider_runs.update({ where: { id: runId }, data: { page_count: 1, row_version: { increment: 1n } } });
      await tx.provider_run_pages.create({ data: { id: pageId, provider_run_id: runId, page_number: 1,
        contract_version: "historical-test-v1", next_cursor: cursor, next_cursor_hash: hash, continuation: "more",
        response_digest: "a".repeat(64), record_count: 0, catalog_record_count: 0, pull_record_count: 0,
        market_event_record_count: 0, accepted_count: 0, duplicate_count: 0, quarantined_count: 0,
        material_change_count: 0, committed_at: at } });
    });
    assert.equal((await h.runs.finish({ runId, workerId: h.workerId, workerFence: lease.lease.fence,
      state: "failed", failureCode: "SYNTHETIC_FAILURE", failureClass: "source", failureSummary: "Synthetic fixture.",
      correlationId: randomUUID(), finishedAt: new Date() })).kind, "finished");
    await h.leases.release({ role: "import", owner: h.workerId, fence: lease.lease.fence });
    const before = { runtime: await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      run: await h.client.provider_runs.findUniqueOrThrow({ where: { id: runId } }),
      page: await h.client.provider_run_pages.findUniqueOrThrow({ where: { id: pageId } }) };
    const boundary = { expectedGeneration: before.runtime.state_generation, expectedCursorFingerprint: hash,
      expectedImportFence: lease.lease.fence, parentRunId: runId, deadline: new Date(Date.now() + 60_000) };
    for (const patch of [{ expectedGeneration: boundary.expectedGeneration + 1n }, { expectedImportFence: 99n },
      { expectedCursorFingerprint: "b".repeat(64) }, { parentRunId: randomUUID() }, { deadline: new Date(0) }]) {
      assert.equal((await h.settings.revise({ ...h.reviseInput, recordsPerRequest: 1000,
        initializationBoundary: { ...boundary, ...patch } })).kind, "initialization_requires_handoff");
      assert.equal(await h.client.provider_request_settings_revisions.count(), 0);
    }
    const promotion = await h.leases.acquire({ role: "promotion", owner: "promotion:fixture", leaseMilliseconds: 60_000 });
    assert.notEqual(promotion.kind, "held"); if (promotion.kind === "held") return;
    assert.equal((await h.settings.revise({ ...h.reviseInput, initializationBoundary: boundary })).kind, "initialization_requires_handoff");
    await h.leases.release({ role: "promotion", owner: "promotion:fixture", fence: promotion.lease.fence });
    const created = await h.settings.revise({ ...h.reviseInput, recordsPerRequest: 1000, initializationBoundary: boundary });
    assert.equal(created.kind, "updated");
    assert.deepEqual(await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }), before.runtime);
    assert.deepEqual(await h.client.provider_runs.findUniqueOrThrow({ where: { id: runId } }), before.run);
    assert.deepEqual(await h.client.provider_run_pages.findUniqueOrThrow({ where: { id: pageId } }), before.page);
    assert.equal(await h.client.local_audit_events.count({ where: { action: "provider.request_settings.revised" } }), 1);
  } finally { await h.close(); }
});
