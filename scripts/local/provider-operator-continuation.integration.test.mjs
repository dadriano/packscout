import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { authority as oldAuthority, createCollectorRepairHarness, installSyntheticCheckpointHash, plan,
  operatorId, databaseModule } from "./collector-reconciliation-retry-test-fixture.mjs";
const { createOperatorContinuation } = await tsImport("./provider-operator-continuation-control.mts", import.meta.url);
const { continuationReviewSchema, continuationIds, continuationAction } = await tsImport("./provider-operator-continuation-policy.mts", import.meta.url);
const { providerDataforrestLiveIntegrationRegistry: registry } = await tsImport(
  "../../apps/worker/src/provider-dataforrest-live-integration.ts", import.meta.url);
const enabled = process.env.PACKSCOUT_OPERATOR_CONTINUATION_INTEGRATION === "1";
const options = { timeout: 180_000, concurrency: false,
  skip: enabled ? false : "Enable explicit isolated operator continuation PostgreSQL integration." };
const p = plan.collectorRepair;
function fixture() {
  const review = continuationReviewSchema.parse({ pins: { organizationId: p.organizationId, providerId: p.providerId,
    providerKey: p.providerKey, configId: p.configId, initialRunId: p.parentRunId, operatorId, operationId: crypto.randomUUID() },
    sourceCommit: "a".repeat(40), authorization: "operator_requested_one_time_continuation", expectedGeneration: "24",
    expectedImportFence: "9", expectedCheckpointHash: p.cursorHash, expectedFailureCode: p.failureCode,
    expectedFinishedAt: p.finishedAt, expectedPageCount: 387 });
  const authority = { ...oldAuthority, integration: registry.resolveProvider(p.providerKey),
    route: { ...oldAuthority.route, node: { host: "127.0.0.1", port: 55434, sslMode: "disable" } } };
  return { review, authority, control: createOperatorContinuation(review), ids: continuationIds(review) };
}
async function read(control, client, authority) {
  return client.$transaction(async tx => { await tx.$executeRaw`set transaction read only`;
    return control.inspect(tx, authority); }, { isolationLevel: "RepeatableRead", timeout: 25000 });
}
test("real audited continuation survives receipt/resume gaps, preserves history and queues exactly once", options, async t => {
  installSyntheticCheckpointHash(t);
  const h = await createCollectorRepairHarness(), { review, authority, control, ids } = fixture();
  const client = h.client;
  try {
    const inspected = await read(control, client, authority), receipt = inspected.receipt;
    const history = structuredClone(inspected.snapshot.parent);
    let reads = 0;
    await assert.rejects(control.apply(client, receipt, async () => {
      if (++reads === 2) throw new Error("synthetic-after-receipt"); return authority;
    }, async () => {}), /synthetic-after-receipt/);
    assert.equal(await client.local_audit_events.count({ where: { action: continuationAction } }), 1);
    assert.equal((await client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } })).state_generation, 24n);
    assert.equal(await client.control_commands.count(), 0);
    reads = 0;
    await assert.rejects(control.apply(client, receipt, async () => {
      if (++reads === 3) throw new Error("synthetic-after-resume"); return authority;
    }, async () => {}), /synthetic-after-resume/);
    assert.equal((await client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } })).state_generation, 25n);
    assert.equal(await client.provider_runs.count(), 1);
    assert.equal((await read(control, client, authority)).receipt.historyDigest, receipt.historyDigest);
    const result = await control.apply(client, receipt, async () => authority, async () => {});
    assert.equal(result.phase, "queued"); assert.equal(result.runId, ids.run);
    const child = await client.provider_runs.findUniqueOrThrow({ where: { id: ids.run } });
    assert.deepEqual(child.requested_cursor, history.final_cursor);
    assert.equal(child.requested_cursor_hash, review.expectedCheckpointHash);
    assert.equal(child.recovery_of_run_id, null);
    assert.deepEqual(await client.provider_runs.findUniqueOrThrow({ where: { id: p.parentRunId } }), history);
    assert.equal((await control.apply(client, receipt, async () => authority, async () => {})).phase, "already_queued");
    assert.equal(await client.provider_runs.count(), 2);
    assert.equal(await client.control_commands.count({ where: { command_type: "run" } }), 1);
    assert.equal((await client.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } })).lease_owner, null);
    const leases = new databaseModule.PrismaProviderWorkerLeaseRepository(client);
    const foreign = await leases.acquire({ role: "import", owner: "synthetic:independent-worker", leaseMilliseconds: 30000 });
    assert.equal(foreign.kind, "acquired");
    assert.equal((await control.apply(client, receipt, async () => authority, async () => {})).phase, "already_queued");
    assert.equal((await client.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } })).lease_owner, "synthetic:independent-worker");
    await leases.release({ role: "import", owner: "synthetic:independent-worker", fence: foreign.lease.fence });
  } finally { await h.close(); }
});
test("a concurrent foreign utility lease refuses before receipt/resume/queue mutations", options, async t => {
  installSyntheticCheckpointHash(t);
  const h = await createCollectorRepairHarness(), { authority, control } = fixture(), client = h.client;
  const other = h.createClient();
  try {
    const { receipt } = await read(control, client, authority);
    const leases = new databaseModule.PrismaProviderWorkerLeaseRepository(other);
    const lease = await leases.acquire({ role: "import", owner: "synthetic:concurrent-operator", leaseMilliseconds: 30000 });
    assert.equal(lease.kind, "acquired");
    await assert.rejects(control.apply(client, receipt, async () => authority, async () => {}), /CONTINUATION_RUNTIME_OR_LEASE_DRIFT/);
    assert.equal(await client.local_audit_events.count({ where: { action: continuationAction } }), 0);
    assert.equal(await client.control_commands.count(), 0); assert.equal(await client.provider_runs.count(), 1);
    assert.equal((await other.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } })).lease_owner, "synthetic:concurrent-operator");
    await leases.release({ role: "import", owner: "synthetic:concurrent-operator", fence: lease.lease.fence });
  } finally { await other.$disconnect(); await h.close(); }
});
test("real operator pause between resume and queue blocks continuation without losing the checkpoint", options, async t => {
  installSyntheticCheckpointHash(t);
  const h = await createCollectorRepairHarness(), { authority, control } = fixture(), client = h.client;
  try {
    const { receipt } = await read(control, client, authority); let reads = 0;
    await assert.rejects(control.apply(client, receipt, async () => {
      if (++reads === 3) await new databaseModule.PrismaAdminProviderRuntimeRepository(client).submitRuntimeCommand({
        commandId: crypto.randomUUID(), commandType: "pause", expectedGeneration: 25n, idempotencyKey: crypto.randomUUID(),
        requestedByOperatorId: operatorId, correlationId: crypto.randomUUID(), reason: "Synthetic operator pause", requestedAt: new Date() });
      return authority;
    }, async () => {}), /CONTINUATION_RUNTIME_OR_LEASE_DRIFT/);
    const runtime = await client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    assert.equal(runtime.operating_state, "paused"); assert.equal(runtime.state_generation, 26n);
    assert.equal(runtime.source_cursor_hash, p.cursorHash); assert.equal(await client.provider_runs.count(), 1);
    assert.equal(await client.control_commands.count({ where: { command_type: "run" } }), 0);
  } finally { await h.close(); }
});
