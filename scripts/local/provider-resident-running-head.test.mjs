import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins, residentFixture } from "./provider-resident-test-fixture.mjs";
const { readBackfillView } = await tsImport("./run-provider-backfill-supervisor.mts", import.meta.url);
const { classifyBackfillCheckpoint, assertBackfillPins, assertBackfillLeaseAvailable } =
  await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
async function runningHead() {
  const f = residentFixture(); const s = (await readBackfillView(f.database, pins, f.authority)).snapshot;
  s.state = "running"; s.run.state = "running"; s.activeRunIds = [s.run.id];
  s.headProof = { runId: s.run.id, sourceRunId: s.run.id, checkpointHash: s.checkpointHash, reconciliationComplete: false };
  return s;
}
test("committed running head can recover only with matching bounded reconciliation proof", async () => {
  const s = await runningHead(); assert.equal(classifyBackfillCheckpoint(s), "execute");
  for (const mutate of [x => x.headProof = null, x => x.headProof.runId = pins.operatorId,
    x => x.headProof.checkpointHash = "f".repeat(64), x => x.lastPage.continuation = "more",
    x => x.lastPage.number++, x => x.lastPage.matches = false,
    x => x.activeRunIds.push(pins.operatorId), x => x.actionableCommands.push({ id: pins.operatorId, runId: null }),
    x => x.state = "idle"]) {
    const invalid = structuredClone(s); mutate(invalid); assert.throws(() => classifyBackfillCheckpoint(invalid));
  }
  for (const state of ["paused", "stopped"]) assert.equal(classifyBackfillCheckpoint({ ...s, state }), "operator_stop");
  const drift = structuredClone(s); drift.configId = pins.operatorId;
  assert.throws(() => assertBackfillPins(drift, pins, 4n), /DRIFT/);
  s.lease = { owner: "foreign", fence: 1n, expiresAt: new Date(s.now.getTime() + 1) };
  assert.throws(() => assertBackfillLeaseAvailable(s, new Set()), /LEASE_UNAVAILABLE/);
  s.lease.expiresAt = new Date(s.now.getTime() - 1);
  assert.throws(() => assertBackfillLeaseAvailable(s, new Set()), /LEASE_UNAVAILABLE/);
});
test("zero-page recovery inherits only verified head lineage and completes without fabricated page counters", async () => {
  const s = await runningHead(); s.run.id = pins.operatorId; s.activeRunIds = [s.run.id];
  s.run.pageCount = 0; s.run.committedPageCount = 0; s.lastPage = null; s.run.requestedHash = s.checkpointHash;
  s.headProof = { runId: s.run.id, sourceRunId: pins.initialRunId, checkpointHash: s.checkpointHash, reconciliationComplete: false };
  assert.equal(classifyBackfillCheckpoint(s), "execute");
  const missing = structuredClone(s); missing.headProof = null; assert.throws(() => classifyBackfillCheckpoint(missing));
  const changed = structuredClone(s); changed.run.requestedHash = "f".repeat(64); assert.throws(() => classifyBackfillCheckpoint(changed));
  s.run.state = "succeeded"; s.state = "idle"; s.activeRunIds = [];
  assert.throws(() => classifyBackfillCheckpoint(s), /TERMINAL_CHECKPOINT_UNSAFE/);
  s.headProof.reconciliationComplete = true;
  assert.equal(classifyBackfillCheckpoint(s), "head"); assert.equal(s.run.pageCount, 0); assert.equal(s.lastPage, null);
});
test("headed terminal transaction failure does not become a fresh source retry", async () => {
  const s = await runningHead(); s.state = "error"; s.run.state = "failed"; s.activeRunIds = [];
  s.run.failureCode = "PROVIDER_IMPORT_DATABASE_TRANSACTION_EXPIRED";
  assert.throws(() => classifyBackfillCheckpoint(s), /TERMINAL_CHECKPOINT_UNSAFE/);
});
test("snapshot reads the database proof for an inherited running head and completed zero-page child", async () => {
  const f = residentFixture(); f.parent.state = "incomplete"; f.parent.failure_code = "PROVIDER_IMPORT_LEASE_EXPIRED";
  const child = { ...f.parent, id: pins.operatorId, state: "running", trigger: "recovery", recovery_of_run_id: f.parent.id,
    page_count: 0, worker_fence: 460n, final_cursor: null, final_cursor_hash: null, failure_code: null };
  f.runs.set(child.id, child); f.runtime.operating_state = "running";
  const running = (await readBackfillView(f.database, pins, f.authority)).snapshot;
  assert.deepEqual(running.headProof, { runId: child.id, sourceRunId: f.parent.id, checkpointHash: f.hash, reconciliationComplete: false });
  assert.equal(classifyBackfillCheckpoint(running), "execute"); assert.equal(running.lastPage, null);
  child.state = "succeeded"; child.final_cursor = f.cursor; child.final_cursor_hash = f.hash; f.runtime.operating_state = "idle";
  const details = { schemaVersion: 1, headPageId: f.last.id, configVersionId: pins.configId,
    checkpointHash: f.hash, leaseFence: "460", batchNumber: 1, phase: "complete", packAfterId: null,
    collectibleAfterId: null, packScanDone: true, collectibleScanDone: true, quarantineAfterId: null, quarantineAfterAt: null };
  f.audits.push({ action: "provider.run.head_reconciliation", target_id: child.id, target_type: "provider_run", outcome: "success", details });
  const completed = (await readBackfillView(f.database, pins, f.authority)).snapshot;
  assert.equal(classifyBackfillCheckpoint(completed), "head"); assert.equal(completed.run.pageCount, 0);
  details.leaseFence = "999";
  const invalid = (await readBackfillView(f.database, pins, f.authority)).snapshot;
  assert.equal(invalid.headProof, null); assert.throws(() => classifyBackfillCheckpoint(invalid));
});
