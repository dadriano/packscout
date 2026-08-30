import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { authority, control, createCollectorRepairHarness, databaseModule, installSyntheticCheckpointHash,
  operatorId, plan, policy } from "./collector-reconciliation-retry-test-fixture.mjs";

const p = plan.collectorRepair, id = plan.collectorRepairId;
const enabled = process.env.PACKSCOUT_COLLECTOR_REPAIR_INTEGRATION === "1";
const options = { timeout: 180_000, concurrency: false, skip: enabled ? false : "Enable explicit isolated Collector repair integration." };
async function runtime(client) { return client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }); }
async function parentHistory(client) {
  return policy.backfillDigest({
    run: await client.provider_runs.findUniqueOrThrow({ where: { id: p.parentRunId } }),
    pages: await client.provider_run_pages.findMany({ where: { provider_run_id: p.parentRunId }, orderBy: { page_number: "asc" } }),
  });
}
function guardedQueue(lease) {
  return { providerId: p.providerId, operatorId, expectedConfigVersionId: p.configId, expectedConfigVersionNumber: 3n,
    expectedGeneration: 25n, expectedCursorFingerprint: p.cursorHash, requireNoActiveRun: true,
    commandId: crypto.randomUUID(), runId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
    idempotencyKey: `synthetic-guard/${crypto.randomUUID()}`, expectedImportLease: lease };
}

test("actual Collector repair preserves 387-page history through receipt/resume crashes and expired/foreign leases", options, async (t) => {
  installSyntheticCheckpointHash(t);
  const harness = await createCollectorRepairHarness(), client = harness.client;
  try {
    const before = await parentHistory(client);
    const inspected = await client.$transaction((tx) => control.inspectCollectorRepair(tx, authority));
    assert.equal(inspected.queued, false);
    const receipt = inspected.receipt;
    assert.equal(receipt.originalExceptionKnown, false);
    assert.equal(policy.transientBackfillCodes.has(p.failureCode), false);
    const input = { database: client, authority, receipt, readAuthority: async () => authority };
    await assert.rejects(control.executeCollectorRepair({ ...input,
      readAuthority: async () => ({ ...authority, digest: "b".repeat(64) }),
    }), /AUTHORITY_CHANGED/);
    assert.equal(await client.local_audit_events.count({ where: { action: p.action } }), 0);

    // Receipt committed, then pre-resume validation interrupted. Nothing is queued.
    let reads = 0;
    await assert.rejects(control.executeCollectorRepair({ ...input, readAuthority: async () => {
      if (++reads === 2) throw new Error("synthetic-crash-after-receipt"); return authority;
    } }), /synthetic-crash-after-receipt/);
    assert.equal(await client.local_audit_events.count({ where: { action: p.action } }), 1);
    assert.equal((await runtime(client)).state_generation, 24n);
    assert.equal(await client.control_commands.count(), 0);

    // Normal Resume committed; a later interrupted check must be restartable.
    reads = 0;
    await assert.rejects(control.executeCollectorRepair({ ...input, readAuthority: async () => {
      if (++reads === 3) throw new Error("synthetic-crash-after-resume"); return authority;
    } }), /synthetic-crash-after-resume/);
    assert.equal((await runtime(client)).operating_state, "idle");
    assert.equal((await runtime(client)).state_generation, 25n);
    assert.equal(await client.control_commands.count(), 1);
    const commands = new databaseModule.PrismaAdminProviderRuntimeRepository(client);
    const leases = new databaseModule.PrismaProviderWorkerLeaseRepository(client);
    const current = await client.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } });
    const oldLease = { owner: p.owner, fence: current.lease_fence };
    const foreign = await leases.acquire({ role: "import", owner: "test:foreign", leaseMilliseconds: 30_000 });
    assert.notEqual(foreign.kind, "held");
    assert.equal((await commands.requestRunNow(guardedQueue(oldLease))).kind, "runtime_unavailable");
    await assert.rejects(control.executeCollectorRepair(input), /CHECKPOINT_CHANGED/);
    assert.equal(await client.provider_runs.count(), 1);
    await leases.release({ role: "import", owner: "test:foreign", fence: foreign.lease.fence });

    const owned = await leases.acquire({ role: "import", owner: p.owner, leaseMilliseconds: 30_000 });
    assert.notEqual(owned.kind, "held");
    await client.provider_worker_states.update({ where: { worker_role: "import" }, data: {
      heartbeat_at: new Date(Date.now() - 2000), lease_expires_at: new Date(Date.now() - 1000),
      row_version: { increment: 1 },
    } });
    assert.equal((await commands.requestRunNow(guardedQueue({ owner: p.owner, fence: owned.lease.fence }))).kind, "runtime_unavailable");
    assert.equal(await client.control_commands.count(), 1);
    assert.equal((await control.executeCollectorRepair(input)).phase, "queued");
    assert.equal((await control.executeCollectorRepair(input)).phase, "already_queued");
    assert.equal(await client.provider_runs.count(), 2);
    assert.equal(await client.control_commands.count(), 2);
    assert.equal(await client.local_audit_events.count({ where: { action: p.action } }), 1);
    const parent = await client.provider_runs.findUniqueOrThrow({ where: { id: p.parentRunId } });
    const child = await client.provider_runs.findUniqueOrThrow({ where: { id: id("run") } });
    assert.equal(child.state, "queued"); assert.equal(child.page_count, 0); assert.equal(child.worker_fence, 0n);
    assert.equal(child.config_version_id, p.configId); assert.equal(child.config_version_number, 3n);
    assert.equal(child.requested_cursor_hash, p.cursorHash);
    assert.ok(isDeepStrictEqual(child.requested_cursor, parent.final_cursor));
    assert.equal(await parentHistory(client), before);
    assert.equal((await client.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } })).lease_owner, null);
    // An existing queue is a read-only idempotent answer, even after release.
    const recorded = await client.control_commands.findFirstOrThrow({ where: { command_type: "run" } });
    assert.equal((await commands.requestRunNow({ ...guardedQueue(oldLease), idempotencyKey: recorded.idempotency_key })).kind, "deduplicated");
    t.diagnostic("One same-config child queued exactly once; all 387 parent pages and exact opaque checkpoint preserved.");
  } finally { await harness.close(); }
});

test("Run-now rejects a lease that expires while waiting for its runtime lock", options, async (t) => {
  installSyntheticCheckpointHash(t);
  const harness = await createCollectorRepairHarness(), client = harness.client, contender = harness.createClient();
  try {
    const commands = new databaseModule.PrismaAdminProviderRuntimeRepository(client);
    assert.equal((await commands.submitRuntimeCommand({
      commandId: crypto.randomUUID(), commandType: "resume", expectedGeneration: 24n,
      idempotencyKey: "synthetic-lock-wait-resume", requestedByOperatorId: operatorId,
      correlationId: crypto.randomUUID(), reason: null, requestedAt: new Date(),
    })).outcome, "accepted");
    const acquired = await new databaseModule.PrismaProviderWorkerLeaseRepository(client).acquire({
      role: "import", owner: p.owner, leaseMilliseconds: 1000,
    });
    assert.notEqual(acquired.kind, "held");
    const [backend] = await contender.$queryRaw`select pg_backend_pid() as pid`;
    let queued;
    await client.$transaction(async (tx) => {
      await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key = true for update`;
      queued = new databaseModule.PrismaAdminProviderRuntimeRepository(contender).requestRunNow(
        guardedQueue({ owner: p.owner, fence: acquired.lease.fence }),
      );
      // Prove the contender reached a database lock wait, not merely a timer.
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const [activity] = await tx.$queryRaw`select wait_event_type from pg_stat_activity where pid = ${backend.pid}`;
        blocked = activity?.wait_event_type === "Lock";
        if (!blocked) await delay(10);
      }
      assert.equal(blocked, true);
      await delay(Math.max(0, acquired.lease.expiresAt.getTime() - Date.now()) + 75);
      const [clock] = await tx.$queryRaw`select clock_timestamp() as now`;
      assert.ok(clock.now > acquired.lease.expiresAt);
    }, { maxWait: 5000, timeout: 10000 });
    assert.equal((await queued).kind, "runtime_unavailable");
    assert.equal(await client.provider_runs.count(), 1);
    assert.equal(await client.control_commands.count({ where: { command_type: "run" } }), 0);
    assert.equal((await runtime(client)).state_generation, 25n);
  } finally { await contender.$disconnect(); await harness.close(); }
});

test("an operator pause between real Resume and Run-now prevents the Collector repair queue", options, async (t) => {
  installSyntheticCheckpointHash(t);
  const harness = await createCollectorRepairHarness(), client = harness.client;
  try {
    const { receipt } = await client.$transaction((tx) => control.inspectCollectorRepair(tx, authority));
    let reads = 0;
    await assert.rejects(control.executeCollectorRepair({ database: client, authority, receipt, readAuthority: async () => {
      if (++reads === 3) {
        const paused = await new databaseModule.PrismaAdminProviderRuntimeRepository(client).submitRuntimeCommand({
          commandId: crypto.randomUUID(), commandType: "pause", expectedGeneration: 25n,
          idempotencyKey: "synthetic-operator-pause", requestedByOperatorId: operatorId,
          correlationId: crypto.randomUUID(), reason: "Operator paused the synthetic repair.", requestedAt: new Date(),
        });
        assert.equal(paused.outcome, "accepted");
      }
      return authority;
    } }), /CHECKPOINT_CHANGED/);
    const state = await runtime(client);
    assert.equal(state.operating_state, "paused"); assert.equal(state.state_generation, 26n);
    assert.equal(await client.provider_runs.count(), 1);
    assert.equal(await client.control_commands.count({ where: { command_type: "run" } }), 0);
    assert.equal((await client.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } })).lease_owner, null);
  } finally { await harness.close(); }
});
