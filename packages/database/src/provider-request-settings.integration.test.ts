import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaAdminProviderRuntimeRepository } from "./admin-provider-runtime-repository.ts";
import { providerMixedCursorFingerprint } from "./provider-mixed-page-contract.ts";
import { createRequestSettingsHarness } from "./provider-request-settings.test-support.ts";

test("request revisions validate 1..5000 and preserve the complete runtime and historical unknown pins", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const old = await h.client.provider_runs.create({ data: { idempotency_key: `history/${randomUUID()}`,
      trigger: "scheduled", state: "failed", config_version_id: h.configId, config_version_number: 1n,
      worker_fence: 1n, requested_at: new Date(), started_at: new Date(), finished_at: new Date(), failure_code: "HISTORICAL_FAILURE",
      failure_class: "source", failure_summary: "Historical fixture." } });
    const cursor = { value: "synthetic-preserved-checkpoint" };
    await h.client.provider_runtime.update({ where: { singleton_key: true }, data: {
      source_cursor: cursor, source_cursor_hash: providerMixedCursorFingerprint(cursor), row_version: { increment: 1n },
    } });
    const before = await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    assert.equal(await h.settings.current({ providerId: h.providerId }), null);
    for (const count of [0, 5001, 1.5, Number.NaN, Infinity]) {
      await assert.rejects(h.settings.revise({ ...h.reviseInput, recordsPerRequest: count }));
    }
    const first = await h.settings.revise({ ...h.reviseInput, recordsPerRequest: 1 });
    assert.equal(first.kind, "updated"); if (first.kind !== "updated") return;
    const last = await h.settings.revise({ ...h.reviseInput, expectedRevisionId: first.revision.id, recordsPerRequest: 5000 });
    assert.equal(last.kind, "updated"); if (last.kind !== "updated") return;
    assert.equal(last.revision.revisionNumber, 2n); assert.equal(last.revision.origin, "operator");
    assert.equal((await h.settings.revise({ ...h.reviseInput, expectedRevisionId: last.revision.id, recordsPerRequest: 5000 })).kind, "unchanged");
    assert.equal((await h.settings.revise({ ...h.reviseInput, expectedRevisionId: first.revision.id })).kind, "revision_conflict");
    assert.deepEqual(await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }), before);
    assert.deepEqual(await h.client.provider_runs.findUniqueOrThrow({ where: { id: old.id } }), old);
    await assert.rejects(h.client.provider_runs.update({ where: { id: old.id }, data: {
      records_per_request: 5000, request_settings_revision_id: last.revision.id, row_version: { increment: 1n },
    } }));
    await assert.rejects(h.client.provider_request_settings_revisions.update({ where: { id: first.revision.id }, data: { records_per_request: 2 } }));
    await assert.rejects(h.client.provider_request_settings.delete({ where: { singleton_key: true } }));
    assert.equal(await h.client.local_audit_events.count({ where: { action: "provider.request_settings.revised" } }), 2);
  } finally { await h.close(); }
});

test("settings authority refuses crossed provider/config/adapter, expiry, and concurrent stale CAS", async () => {
  const h = await createRequestSettingsHarness();
  try {
    await assert.rejects(h.settings.current({ providerId: randomUUID() }), /identity mismatch/u);
    for (const [patch, kind] of [
      [{ providerId: randomUUID() }, "identity_mismatch"],
      [{ expectedConfigVersionId: randomUUID() }, "configuration_conflict"],
      [{ expectedConfigVersionNumber: 2n }, "configuration_conflict"],
      [{ adapterKey: "different-adapter" }, "configuration_conflict"],
    ] as const) assert.equal((await h.settings.revise({ ...h.reviseInput, ...patch })).kind, kind);
    const first = await h.settings.revise(h.reviseInput); assert.equal(first.kind, "updated"); if (first.kind !== "updated") return;
    const attempts = await Promise.all([1000, 2000].map((recordsPerRequest) => h.settings.revise({
      ...h.reviseInput, expectedRevisionId: first.revision.id, recordsPerRequest,
    })));
    assert.deepEqual(attempts.map((result) => result.kind).sort(), ["revision_conflict", "updated"]);
    assert.equal(await h.client.provider_request_settings_revisions.count(), 2);
    await h.client.provider_runtime.update({ where: { singleton_key: true }, data: {
      config_expires_at: new Date(Date.now() - 1000), row_version: { increment: 1n },
    } });
    assert.equal((await h.settings.revise(h.reviseInput)).kind, "configuration_expired");
  } finally { await h.close(); }
});

test("first explicit initialization requires drained old work; unknown runs cannot resume", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const lease = await h.leases.acquire({ role: "import", owner: h.workerId, leaseMilliseconds: 60_000 });
    assert.notEqual(lease.kind, "held"); if (lease.kind === "held") return;
    assert.equal((await h.settings.revise(h.reviseInput)).kind, "initialization_requires_handoff");
    const historical = await h.client.provider_runs.create({ data: {
      idempotency_key: `old/${randomUUID()}`, trigger: "scheduled", state: "running",
      config_version_id: h.configId, config_version_number: 1n, worker_fence: lease.lease.fence,
      requested_at: new Date(), started_at: new Date(),
    } });
    const recovery = await h.runs.recoverActive({ recoveryRunId: randomUUID(), workerId: h.workerId,
      workerFence: lease.lease.fence, correlationId: randomUUID() });
    assert.equal(recovery.kind, "request_settings_unavailable");
    assert.deepEqual(await h.client.provider_runs.findUniqueOrThrow({ where: { id: historical.id } }), historical);
    await h.leases.release({ role: "import", owner: h.workerId, fence: lease.lease.fence });
    assert.equal((await h.settings.revise(h.reviseInput)).kind, "initialization_requires_handoff");
    assert.equal(await h.client.provider_request_settings_revisions.count(), 0);
  } finally { await h.close(); }
});

test("queue/start atomically pin current revision; explicit default bootstrap is recorded, never implicit 5000", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const commands = new PrismaAdminProviderRuntimeRepository(h.client);
    const input = { providerId: h.providerId, operatorId: h.operatorId, expectedConfigVersionId: h.configId,
      expectedConfigVersionNumber: 1n, expectedGeneration: 0n, idempotencyKey: `queue/${randomUUID()}`,
      commandId: randomUUID(), runId: randomUUID(), correlationId: randomUUID() };
    assert.equal((await commands.requestRunNow(input)).kind, "request_settings_unavailable");
    assert.equal(await h.client.control_commands.count(), 0);
    const queued = await commands.requestRunNow({ ...input, requestSettingsDefault: { recordsPerRequest: 100, adapterKey: h.adapterKey } });
    assert.equal(queued.kind, "created"); if (queued.kind !== "created") return;
    assert.equal(queued.run.recordsPerRequest, 100);
    const current = await h.settings.current({ providerId: h.providerId }); assert.equal(current?.origin, "adapter_default");
    assert.equal((await h.settings.revise({ ...h.reviseInput, expectedRevisionId: current!.id, recordsPerRequest: 1000 })).kind, "updated");
    const lease = await h.leases.acquire({ role: "import", owner: h.workerId, leaseMilliseconds: 60_000 });
    assert.notEqual(lease.kind, "held"); if (lease.kind === "held") return;
    const started = await h.runs.start({ runId: input.runId, controlCommandId: input.commandId,
      idempotencyKey: `command/${input.commandId}`, trigger: "manual", requestedByOperatorId: h.operatorId,
      configVersionId: h.configId, configVersionNumber: 1n, workerId: h.workerId,
      workerFence: lease.lease.fence, correlationId: input.correlationId, requestedAt: queued.run.requestedAt });
    assert.equal(started.kind, "started"); if (started.kind !== "started") return;
    assert.equal(started.run.recordsPerRequest, 100); assert.equal(started.run.requestSettingsRevisionId, current!.id);
    const runningRuntime = await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    const latest = await h.settings.current({ providerId: h.providerId });
    assert.equal((await h.settings.revise({ ...h.reviseInput, expectedRevisionId: latest!.id, recordsPerRequest: 2000 })).kind, "updated");
    assert.deepEqual(await h.client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }), runningRuntime);
    assert.equal((await commands.requestRunNow(input)).kind, "deduplicated");
    const run = await h.client.provider_runs.findUniqueOrThrow({ where: { id: input.runId } });
    await assert.rejects(h.client.provider_runs.update({ where: { id: run.id }, data: { records_per_request: 1000, row_version: { increment: 1n } } }));
  } finally { await h.close(); }
});

test("historical queued work is not assigned a guessed pin on start", async () => {
  const h = await createRequestSettingsHarness();
  try {
    const requestedAt = new Date();
    const run = await h.client.provider_runs.create({ data: { idempotency_key: `old/${randomUUID()}`,
      trigger: "scheduled", state: "queued", config_version_id: h.configId, config_version_number: 1n,
      worker_fence: 0n, requested_at: requestedAt } });
    const lease = await h.leases.acquire({ role: "import", owner: h.workerId, leaseMilliseconds: 60_000 });
    assert.notEqual(lease.kind, "held"); if (lease.kind === "held") return;
    assert.equal((await h.runs.start({ runId: run.id, idempotencyKey: run.idempotency_key, trigger: "scheduled",
      requestedByOperatorId: null, configVersionId: h.configId, configVersionNumber: 1n, workerId: h.workerId,
      workerFence: lease.lease.fence, correlationId: randomUUID(), requestedAt,
      requestSettingsDefault: { recordsPerRequest: 100, adapterKey: h.adapterKey } })).kind, "request_settings_unavailable");
    assert.deepEqual(await h.client.provider_runs.findUniqueOrThrow({ where: { id: run.id } }), run);
    assert.equal(await h.client.provider_request_settings_revisions.count(), 0);
  } finally { await h.close(); }
});
