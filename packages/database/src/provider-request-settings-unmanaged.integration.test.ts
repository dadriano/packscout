import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaAdminProviderRuntimeRepository } from "./admin-provider-runtime-repository.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { createRequestSettingsHarness } from "./provider-request-settings.test-support.ts";

test("explicit unmanaged capture queues, starts, recovers and commits without invented source counts or pins", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const commands = new PrismaAdminProviderRuntimeRepository(h.client);
    const commandId = randomUUID(); const runId = randomUUID(); const correlationId = randomUUID();
    const queued = await commands.requestRunNow({ providerId: h.providerId, operatorId: h.operatorId,
      expectedConfigVersionId: h.configId, expectedConfigVersionNumber: 1n, expectedGeneration: 0n,
      idempotencyKey: `capture/${randomUUID()}`, commandId, runId, correlationId, requestSettingsPolicy: "unmanaged" });
    assert.equal(queued.kind, "created"); if (queued.kind !== "created") return;
    assert.equal(queued.run.recordsPerRequest, null); assert.equal(queued.run.requestSettingsRevisionId, null);
    const acquired = await h.leases.acquire({ role: "import", owner: h.workerId, leaseMilliseconds: 60_000 });
    assert.notEqual(acquired.kind, "held"); if (acquired.kind === "held") return;
    const started = await h.runs.start({ runId, idempotencyKey: `command/${commandId}`, trigger: "manual",
      requestedByOperatorId: h.operatorId, configVersionId: h.configId, configVersionNumber: 1n,
      workerId: h.workerId, workerFence: acquired.lease.fence, correlationId, controlCommandId: commandId,
      requestedAt: queued.run.requestedAt, requestSettingsPolicy: "unmanaged" });
    assert.equal(started.kind, "started");
    await h.leases.release({ role: "import", owner: h.workerId, fence: acquired.lease.fence });
    const nextWorker = "capture:replacement";
    const replacement = await h.leases.acquire({ role: "import", owner: nextWorker, leaseMilliseconds: 60_000 });
    assert.notEqual(replacement.kind, "held"); if (replacement.kind === "held") return;
    const recovered = await h.runs.recoverActive({ recoveryRunId: randomUUID(), workerId: nextWorker,
      workerFence: replacement.lease.fence, correlationId: randomUUID(), requestSettingsPolicy: "unmanaged" });
    assert.equal(recovered.kind, "recovered"); if (recovered.kind !== "recovered") return;
    assert.equal(recovered.run.recordsPerRequest, null);
    const body = { contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerId: h.providerId,
      runId: recovered.run.id, configVersionId: h.configId, configVersionNumber: "1",
      leaseFence: replacement.lease.fence.toString(), pageId: randomUUID(), pageNumber: 1,
      inputCursor: null, inputCursorFingerprint: null, nextCursor: null, nextCursorFingerprint: null,
      continuation: "head", records: [{ position: 0, providerId: h.providerId, kind: "catalog", operation: "upsert",
        entityType: "category", candidate: { categoryKey: "capture", parentCategoryKey: null,
          displayName: "Protected capture fixture", expectedRowVersion: null } }] };
    const page = { ...body, responseDigest: providerMixedPageDigest(body) };
    const pages = new PrismaProviderMixedPageRepository(h.client);
    assert.equal((await pages.commit({ workerId: nextWorker, page })).kind, "request_settings_unavailable");
    assert.equal((await pages.commit({ workerId: nextWorker, page, requestSettingsPolicy: "unmanaged" })).kind, "committed");
    assert.equal(await h.client.categories.count(), 1);
    assert.equal(await h.client.provider_request_settings_revisions.count(), 0);
    assert.equal(await h.client.local_audit_events.count({ where: { action: "provider.source.page.translated" } }), 0);
    assert.equal((await h.runs.finish({ runId: recovered.run.id, workerId: nextWorker,
      workerFence: replacement.lease.fence, state: "succeeded", failureCode: null, failureClass: null,
      failureSummary: null, correlationId: randomUUID(), finishedAt: new Date() })).kind, "finished");
    const idle = await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    const retry = await commands.requestRunNow({ providerId: h.providerId, operatorId: h.operatorId,
      expectedConfigVersionId: h.configId, expectedConfigVersionNumber: 1n, expectedGeneration: idle.state_generation,
      idempotencyKey: `capture-retry/${randomUUID()}`, commandId: randomUUID(), runId: randomUUID(), correlationId: randomUUID(),
      requestSettingsPolicy: "unmanaged", requestSettingsRecoveryParentRunId: recovered.run.id,
      expectedCursorFingerprint: null, expectedImportLease: { owner: nextWorker, fence: replacement.lease.fence } });
    assert.equal(retry.kind, "created"); if (retry.kind !== "created") return;
    assert.equal(retry.run.recordsPerRequest, null); assert.equal(retry.run.requestSettingsRevisionId, null);
    assert.equal(retry.run.requestSettingsParentRunId, recovered.run.id);
  } finally { await h.close(); }
});

test("initialized providers reject unmanaged queue/start/recovery/commit instead of inheriting or bypassing pins", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const { run, fence } = await h.start(100);
    const commands = new PrismaAdminProviderRuntimeRepository(h.client);
    const before = await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    assert.equal((await commands.requestRunNow({ providerId: h.providerId, operatorId: h.operatorId,
      expectedConfigVersionId: h.configId, expectedConfigVersionNumber: 1n, expectedGeneration: before.state_generation,
      idempotencyKey: `unmanaged/${randomUUID()}`, commandId: randomUUID(), runId: randomUUID(),
      correlationId: randomUUID(), requestSettingsPolicy: "unmanaged" })).kind, "request_settings_unavailable");
    assert.equal((await h.runs.start({ runId: randomUUID(), idempotencyKey: `unmanaged/${randomUUID()}`, trigger: "scheduled",
      requestedByOperatorId: null, configVersionId: h.configId, configVersionNumber: 1n,
      workerId: h.workerId, workerFence: fence, correlationId: randomUUID(), requestedAt: new Date(),
      requestSettingsPolicy: "unmanaged" })).kind, "request_settings_unavailable");
    assert.equal((await h.runs.recoverActive({ recoveryRunId: randomUUID(), workerId: h.workerId, workerFence: fence,
      correlationId: randomUUID(), requestSettingsPolicy: "unmanaged" })).kind, "request_settings_unavailable");
    let callback = false;
    assert.equal((await h.runs.commitPage({ pageId: randomUUID(), runId: run.id, workerId: h.workerId, workerFence: fence,
      contractVersion: "capture-v1", requestedCursor: null, requestedCursorHash: null, nextCursor: null, nextCursorHash: null,
      continuation: "head", responseDigest: "a".repeat(64), counts: { records: 0, catalog: 0, pulls: 0, marketEvents: 0,
        accepted: 0, duplicate: 0, quarantined: 0, materialChanges: 0 }, committedAt: new Date(),
      requestSettingsPolicy: "unmanaged", applyCanonicalWrites: async () => { callback = true; } })).kind, "request_settings_unavailable");
    assert.equal(callback, false);
    assert.deepEqual(await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }), before);
    assert.equal(await h.client.provider_runs.count(), 1);
  } finally { await h.close(); }
});
