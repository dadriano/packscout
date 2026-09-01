import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins, residentFixture } from "./provider-resident-test-fixture.mjs";
const { readResidentBootstrapView, persistResidentHandoff, readResidentHandoff, residentContinuousPins } =
  await tsImport("./provider-resident-handoff.mts", import.meta.url);
const { readBackfillView } = await tsImport("./run-provider-backfill-supervisor.mts", import.meta.url);
const { readOwnedBackfillLeaseExpiry, releaseExpiredBackfillHeadLease } = await tsImport("./provider-backfill-supervisor-persistence.mts", import.meta.url);
const { superviseProviderBackfill } = await tsImport("./provider-backfill-supervisor.mts", import.meta.url);
test("head handoff commits exactly once, restart reuses its original pins after newer cycles", async () => {
  const f = residentFixture(); const before = structuredClone(f.parent);
  const view = await readResidentBootstrapView(f.database, pins, f.authority);
  assert.equal(view.handoff, null); assert.equal(f.writes.length, 0);
  const handoff = await persistResidentHandoff(f.database, pins, f.authority, view.backfill);
  assert.deepEqual(await persistResidentHandoff(f.database, pins, f.authority, view.backfill), handoff);
  assert.equal(f.audits.length, 1); assert.deepEqual(f.parent, before); assert.equal(f.runs.size, 1);
  assert.equal(JSON.stringify(handoff).includes(f.cursor.value), false);
  f.runs.set(pins.operatorId, { ...f.parent, id: pins.operatorId, requested_at: f.now });
  f.runtime.state_generation += 4n;
  const restarted = await readResidentBootstrapView(f.database, pins, f.authority);
  assert.deepEqual(restarted.handoff, handoff); assert.equal(restarted.backfill, null);
  assert.equal(residentContinuousPins(restarted.handoff).initialRunId, pins.initialRunId);
  assert.equal(f.audits.length, 1);
});
test("handoff refuses changed controls, head/checkpoint, latest run and foreign lease without writes", async () => {
  for (const mutate of [f => f.runtime.operating_state = "paused", f => f.runtime.operating_state = "stopped",
    f => f.runtime.state_generation++, f => f.authority.digest = "e".repeat(64),
    f => f.runtime.source_cursor_hash = "e".repeat(64),
    f => f.runtime.source_cursor = null, f => f.parent.reached_source_head = false,
    f => f.parent.state = "failed", f => f.last.continuation = "more",
    f => f.commands.push({ id: pins.operatorId, resulting_run_id: null }),
    f => f.runs.set(pins.operatorId, { ...f.parent, id: pins.operatorId, requested_at: f.now }),
    f => { f.lease.lease_owner = "foreign"; f.lease.lease_expires_at = new Date(f.now.getTime() - 1); }]) {
    const f = residentFixture(); const observed = await readBackfillView(f.database, pins, f.authority);
    mutate(f);
    await assert.rejects(persistResidentHandoff(f.database, pins, f.authority, observed));
    assert.deepEqual(f.writes, []);
  }
});
test("handoff receipt cannot change its original scope, authority or deterministic operation", async () => {
  for (const mutate of [f => f.authority.digest = "f".repeat(64), f => f.audits[0].details.pins.configId = pins.operatorId,
    f => f.audits[0].details.continuousOperationId = pins.operatorId, f => f.audits[0].target_id = pins.operatorId,
    f => f.audits[0].actor_operator_id = pins.providerId, f => f.audits.push(structuredClone(f.audits[0]))]) {
    const f = residentFixture(); const observed = await readBackfillView(f.database, pins, f.authority);
    await persistResidentHandoff(f.database, pins, f.authority, observed); mutate(f);
    await assert.rejects(readResidentHandoff(f.database, pins, f.authority), /HANDOFF_DRIFT/);
  }
});
test("live survivor wait requires exact claim provenance and current fenced recovery lineage", async () => {
  const f = residentFixture(); const snapshot = (await readBackfillView(f.database, pins, f.authority)).snapshot;
  snapshot.lease = { owner: "owned-child", fence: 459n, expiresAt: new Date(f.now.getTime() + 5000) };
  const row = { correlation_id: pins.operationId, action: "local.provider_backfill.execution_claim",
    actor_operator_id: pins.operatorId, target_type: "provider_run", target_id: pins.initialRunId, outcome: "success",
    details: { owner: "owned-child", fence: "459", authorityDigest: f.authority.digest } };
  f.audits.push(row);
  assert.deepEqual(await readOwnedBackfillLeaseExpiry(f.database, pins, f.authority, snapshot), snapshot.lease.expiresAt);
  for (const mutation of [r => r.correlation_id = pins.operatorId, r => r.actor_operator_id = pins.providerId,
    r => r.outcome = "failed", r => r.details.fence = "458", r => r.details.authorityDigest = "f".repeat(64),
    r => r.target_id = pins.operatorId, r => r.details.owner = "foreign"]) {
    f.audits[0] = structuredClone(row); mutation(f.audits[0]);
    assert.equal(await readOwnedBackfillLeaseExpiry(f.database, pins, f.authority, snapshot), null);
  }
  f.audits[0] = row;
  f.runs.set(pins.operatorId, { ...f.parent, id: pins.operatorId, recovery_of_run_id: pins.initialRunId, trigger: "recovery" });
  snapshot.run.id = pins.operatorId;
  assert.deepEqual(await readOwnedBackfillLeaseExpiry(f.database, pins, f.authority, snapshot), snapshot.lease.expiresAt);
  snapshot.now = snapshot.lease.expiresAt;
  assert.deepEqual(await readOwnedBackfillLeaseExpiry(f.database, pins, f.authority, snapshot), snapshot.lease.expiresAt);
  assert.deepEqual(f.writes, []);
});
test("head plus expired exact owned lease recovers by normal fencing and release without another run", async () => {
  const f = residentFixture(); const before = structuredClone(f.parent);
  f.lease.lease_owner = "owned-child"; f.lease.lease_expires_at = new Date(f.now.getTime() - 1);
  f.audits.push({ correlation_id: pins.operationId, action: "local.provider_backfill.execution_claim",
    actor_operator_id: pins.operatorId, target_type: "provider_run", target_id: pins.initialRunId, outcome: "success",
    details: { owner: "owned-child", fence: "459", authorityDigest: f.authority.digest } });
  assert.equal(await superviseProviderBackfill({ pins,
    read: () => readBackfillView(f.database, pins, f.authority),
    releaseExpiredHeadLease: view => releaseExpiredBackfillHeadLease(f.database, pins, f.authority, view.snapshot, "replacement"),
    persistRetry: async () => assert.fail(), execute: async () => assert.fail(), wait: async () => assert.fail(), emit() {},
  }, new AbortController().signal), "head");
  assert.equal(f.lease.lease_owner, null); assert.equal(f.lease.lease_fence, 460n);
  assert.deepEqual(f.parent, before); assert.equal(f.runs.size, 1); assert.equal(f.commands.length, 0);
  assert.deepEqual(f.writes, ["audit", "lease", "lease"]);
});
test("expired-head cleanup refuses changed owner, live lease, new work and pause before lease writes", async () => {
  for (const mutate of [f => f.lease.lease_owner = "foreign", f => f.lease.lease_expires_at = new Date(f.now.getTime() + 1),
    f => f.runtime.operating_state = "paused", f => f.commands.push({ id: pins.operatorId, resulting_run_id: null })]) {
    const f = residentFixture(); f.lease.lease_owner = "owned"; f.lease.lease_expires_at = new Date(f.now.getTime() - 1);
    f.audits.push({ correlation_id: pins.operationId, action: "local.provider_backfill.execution_claim",
      actor_operator_id: pins.operatorId, target_type: "provider_run", target_id: pins.initialRunId, outcome: "success",
      details: { owner: "owned", fence: "459", authorityDigest: f.authority.digest } });
    const observed = (await readBackfillView(f.database, pins, f.authority)).snapshot; mutate(f);
    await assert.rejects(releaseExpiredBackfillHeadLease(f.database, pins, f.authority, observed, "replacement"));
    assert.deepEqual(f.writes, []);
  }
});
