import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaAdminProviderRuntimeRepository } from "./admin-provider-runtime-repository.ts";
import { PrismaProviderCommandRepository } from "./provider-command-repository.ts";
import { PrismaProviderSourceRequestAuditRepository } from "./provider-source-request-audit-repository.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerMixedPageDigest } from "./provider-mixed-page-contract.ts";
import { createRequestSettingsHarness } from "./provider-request-settings.test-support.ts";

test("source receipt enforces the run pin before writes while canonical expansion retains its independent cap", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const { run, fence } = await h.start(1);
    const audit = new PrismaProviderSourceRequestAuditRepository(h.client);
    const records = [0, 1].map((position) => ({ position, providerId: h.providerId, kind: "catalog", operation: "upsert",
      entityType: "category", candidate: { categoryKey: `category-${position}`, parentCategoryKey: null,
        displayName: `Category ${position}`, expectedRowVersion: null } }));
    const body = { contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerId: h.providerId,
      runId: run.id, configVersionId: h.configId, configVersionNumber: "1", leaseFence: fence.toString(),
      pageId: randomUUID(), pageNumber: 1, inputCursor: null, inputCursorFingerprint: null,
      nextCursor: null, nextCursorFingerprint: null, continuation: "head", records };
    const page = { ...body, responseDigest: providerMixedPageDigest(body) };
    const pages = new PrismaProviderMixedPageRepository(h.client);
    const receipt = { runId: run.id, workerId: h.workerId, workerFence: fence, requestAttemptId: randomUUID(),
      pageAttemptId: randomUUID(), pageNumber: 1, sourceRecordCount: 1, normalizedRecordCount: 2,
      mixedPageId: page.pageId, responseDigest: page.responseDigest, recordsPerRequest: 1,
      requestSettingsRevisionId: run.requestSettingsRevisionId! };
    assert.equal((await pages.commit({ workerId: h.workerId, page })).kind, "source_receipt_missing");
    for (const patch of [{ recordsPerRequest: 2 }, { requestSettingsRevisionId: randomUUID() }, { mixedPageId: undefined }]) {
      assert.equal((await audit.recordPageTranslation({ ...receipt, ...patch })).kind, "request_settings_mismatch");
    }
    assert.equal((await audit.recordPageTranslation({ ...receipt, sourceRecordCount: 2 })).kind, "request_limit_exceeded");
    assert.equal(await h.client.categories.count(), 0); assert.equal(await h.client.provider_run_pages.count(), 0);
    for (const patch of [{ mixedPageId: randomUUID() }, { responseDigest: "f".repeat(64) }, { normalizedRecordCount: 1 }, { pageNumber: 2 }]) {
      assert.equal((await audit.recordPageTranslation({ ...receipt, ...patch })).kind, "recorded");
      assert.equal((await pages.commit({ workerId: h.workerId, page })).kind, "source_receipt_missing");
    }
    assert.equal((await audit.recordPageTranslation(receipt)).kind, "recorded");
    const committed = await pages.commit({ workerId: h.workerId, page });
    assert.equal(committed.kind, "committed"); if (committed.kind !== "committed") return;
    assert.equal(committed.counts.records, 2); assert.equal(committed.counts.accepted, 2);
    assert.equal(await h.client.categories.count(), 2);
    assert.equal((await pages.commit({ workerId: h.workerId, page })).kind, "replayed");
    assert.equal((await h.client.provider_runs.findUniqueOrThrow({ where: { id: run.id } })).records_per_request, 1);
  } finally { await h.close(); }
});

test("direct canonical callback is never called without the exact source-count receipt", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const { run, fence } = await h.start(); let writes = 0;
    const result = await h.runs.commitPage({ pageId: randomUUID(), runId: run.id, workerId: h.workerId,
      workerFence: fence, contractVersion: "synthetic-test-v1", requestedCursor: null, requestedCursorHash: null,
      nextCursor: null, nextCursorHash: null, continuation: "head", responseDigest: "a".repeat(64),
      counts: { records: 1, catalog: 1, pulls: 0, marketEvents: 0, accepted: 1, duplicate: 0, quarantined: 0, materialChanges: 1 },
      committedAt: new Date(), applyCanonicalWrites: async () => { writes += 1; } });
    assert.equal(result.kind, "source_receipt_missing"); assert.equal(writes, 0);
    assert.equal(await h.client.provider_run_pages.count(), 0);
  } finally { await h.close(); }
});

test("fenced recovery retains the original pin after a newer setting revision", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const { run, fence } = await h.start(100);
    assert.equal((await h.settings.revise({ ...h.reviseInput, expectedRevisionId: run.requestSettingsRevisionId,
      recordsPerRequest: 1000 })).kind, "updated");
    await h.leases.release({ role: "import", owner: h.workerId, fence });
    const newWorker = "worker:request-size:recovery";
    const next = await h.leases.acquire({ role: "import", owner: newWorker, leaseMilliseconds: 60_000 });
    assert.notEqual(next.kind, "held"); if (next.kind === "held") return;
    const recovered = await h.runs.recoverActive({ recoveryRunId: randomUUID(), workerId: newWorker,
      workerFence: next.lease.fence, correlationId: randomUUID() });
    assert.equal(recovered.kind, "recovered"); if (recovered.kind !== "recovered") return;
    assert.equal(recovered.run.recordsPerRequest, 100); assert.equal(recovered.run.requestSettingsRevisionId, run.requestSettingsRevisionId);
    const parent = await h.client.provider_runs.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(parent.state, "incomplete"); assert.equal(parent.records_per_request, 100);
    const child = await h.client.provider_runs.findUniqueOrThrow({ where: { id: recovered.run.id } });
    assert.equal(child.request_settings_parent_run_id, run.id);
    assert.equal((await h.settings.current({ providerId: h.providerId }))?.recordsPerRequest, 1000);
  } finally { await h.close(); }
});

test("manual retry pins the terminal parent's exact checkpoint/revision and refuses unknown or crossed provenance", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const { run, fence } = await h.start(100);
    assert.equal((await h.runs.finish({ runId: run.id, workerId: h.workerId, workerFence: fence, state: "failed",
      failureCode: "SYNTHETIC_SOURCE_TIMEOUT", failureClass: "source", failureSummary: "Synthetic fixture.",
      correlationId: randomUUID(), finishedAt: new Date() })).kind, "finished");
    assert.equal((await h.settings.revise({ ...h.reviseInput, expectedRevisionId: run.requestSettingsRevisionId,
      recordsPerRequest: 1000 })).kind, "updated");
    const commands = new PrismaAdminProviderRuntimeRepository(h.client);
    const runtime = await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    const resume = await commands.submitRuntimeCommand({ commandId: randomUUID(), idempotencyKey: `resume/${randomUUID()}`,
      commandType: "resume", expectedGeneration: runtime.state_generation, requestedByOperatorId: h.operatorId,
      correlationId: randomUUID(), reason: null, requestedAt: new Date() });
    assert.equal(resume.outcome, "accepted");
    const input = { providerId: h.providerId, operatorId: h.operatorId, expectedConfigVersionId: h.configId,
      expectedConfigVersionNumber: 1n, expectedGeneration: resume.generation, idempotencyKey: `retry/${randomUUID()}`,
      commandId: randomUUID(), runId: randomUUID(), correlationId: randomUUID(), expectedCursorFingerprint: null,
      requireNoActiveRun: true, requestSettingsRecoveryParentRunId: run.id,
      expectedImportLease: { owner: h.workerId, fence } };
    assert.equal((await commands.requestRunNow({ ...input, expectedCursorFingerprint: undefined })).kind, "request_settings_unavailable");
    assert.equal((await commands.requestRunNow({ ...input, requestSettingsRecoveryParentRunId: randomUUID() })).kind, "request_settings_unavailable");
    const retry = await commands.requestRunNow(input); assert.equal(retry.kind, "created"); if (retry.kind !== "created") return;
    assert.equal(retry.run.recordsPerRequest, 100); assert.equal(retry.run.requestSettingsRevisionId, run.requestSettingsRevisionId);
    assert.equal(retry.run.requestSettingsParentRunId, run.id);
    assert.equal((await commands.requestRunNow(input)).kind, "deduplicated");
    assert.equal((await commands.requestRunNow({ ...input, requestSettingsRecoveryParentRunId: undefined })).kind, "idempotency_conflict");
    assert.equal((await h.client.provider_runs.findUniqueOrThrow({ where: { id: run.id } })).state, "failed");
  } finally { await h.close(); }
});

test("accepted retry_run inherits its target pin after a setting edit instead of selecting the newest revision", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const { run, fence } = await h.start(100);
    assert.equal((await h.runs.finish({ runId: run.id, workerId: h.workerId, workerFence: fence, state: "failed",
      failureCode: "SYNTHETIC_SOURCE_TIMEOUT", failureClass: "source", failureSummary: "Synthetic fixture.",
      correlationId: randomUUID(), finishedAt: new Date() })).kind, "finished");
    assert.equal((await h.settings.revise({ ...h.reviseInput, expectedRevisionId: run.requestSettingsRevisionId,
      recordsPerRequest: 1000 })).kind, "updated");
    const runtime = await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    const resume = await new PrismaAdminProviderRuntimeRepository(h.client).submitRuntimeCommand({
      commandId: randomUUID(), idempotencyKey: `resume/${randomUUID()}`, commandType: "resume",
      expectedGeneration: runtime.state_generation, requestedByOperatorId: h.operatorId,
      correlationId: randomUUID(), reason: null, requestedAt: new Date() });
    assert.equal(resume.outcome, "accepted");
    const commandId = randomUUID(); const correlationId = randomUUID(); const requestedAt = new Date();
    const accepted = await new PrismaProviderCommandRepository(h.client).submit({ commandId,
      idempotencyKey: `retry-command/${randomUUID()}`, commandType: "retry_run", targetRunId: run.id,
      targetQuarantineId: null, expectedGeneration: resume.generation, requestedByOperatorId: h.operatorId,
      correlationId, reason: null, requestedAt });
    assert.equal(accepted.outcome, "accepted");
    const input = { runId: randomUUID(), idempotencyKey: `command/${commandId}`, trigger: "manual" as const,
      requestedByOperatorId: h.operatorId, configVersionId: h.configId, configVersionNumber: 1n,
      workerId: h.workerId, workerFence: fence, correlationId, requestedAt, controlCommandId: commandId };
    const started = await h.runs.start(input); assert.equal(started.kind, "started"); if (started.kind !== "started") return;
    assert.equal(started.run.recordsPerRequest, 100);
    assert.equal(started.run.requestSettingsRevisionId, run.requestSettingsRevisionId);
    assert.equal((await h.client.provider_runs.findUniqueOrThrow({ where: { id: started.run.id } })).request_settings_parent_run_id, run.id);
    assert.equal((await h.runs.start(input)).kind, "deduplicated");
    assert.equal((await h.settings.current({ providerId: h.providerId }))?.recordsPerRequest, 1000);
  } finally { await h.close(); }
});
