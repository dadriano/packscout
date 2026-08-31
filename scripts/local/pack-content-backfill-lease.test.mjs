import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { backfillLeaseFixture, uuid } from "./pack-content-backfill-test-fixture.mjs";
const { acquirePackContentBackfillLease, PACK_CONTENT_BACKFILL_LEASE_ACTION } = await tsImport("./pack-content-backfill-lease.mts", import.meta.url);
const { readPackContentBackfillProgress } = await tsImport("./pack-content-backfill-progress.mts", import.meta.url);
const { packContentBackfillDigest, PACK_CONTENT_BACKFILL_START_ACTION, PACK_CONTENT_BACKFILL_PACK_ACTION } =
  await tsImport("./pack-content-backfill-contract.mts", import.meta.url);
const { providerPackContentSnapshotDigest } = await tsImport("@packscout/database", import.meta.url);

test("an interrupted operation reclaims only its audited expired fence without changing catalog or source pins", async () => {
  const f = backfillLeaseFixture();
  const before = structuredClone({ runtime: f.state.runtime, packs: f.state.packs, sequence: f.state.currentSequence });
  const first = await acquirePackContentBackfillLease(f, f.leases);
  assert.equal(first.fence, 6n);
  assert.equal(f.state.audits[0].action, PACK_CONTENT_BACKFILL_LEASE_ACTION);
  assert.equal(f.state.audits[0].details.expectedFence, "6");
  await assert.rejects(acquirePackContentBackfillLease(f, f.leases), /LEASE_REFUSED/);
  assert.equal(f.state.acquireCalls, 1);
  f.state.now = new Date(first.expiresAt.getTime() + 1);
  const resumed = await acquirePackContentBackfillLease(f, f.leases);
  assert.equal(resumed.fence, 7n);
  assert.deepEqual(f.state.audits.map(row => row.details.expectedFence), ["6", "7"]);
  assert.deepEqual({ runtime: f.state.runtime, packs: f.state.packs, sequence: f.state.currentSequence }, before);
});

test("a crash after the durable claim but before acquisition resumes the same pending claim", async () => {
  const f = backfillLeaseFixture();
  f.state.acquireError = new Error("simulated process exit");
  await assert.rejects(acquirePackContentBackfillLease(f, f.leases), /process exit/);
  assert.equal(f.state.audits.length, 1);
  f.state.acquireError = null;
  assert.equal((await acquirePackContentBackfillLease(f, f.leases)).fence, 6n);
  assert.equal(f.state.audits.length, 1);
});

test("foreign expired owners and unproven own leases never reach acquire", async () => {
  for (const owner of ["foreign-worker", `local:chase-backfill:${uuid(1)}`]) {
    const f = backfillLeaseFixture();
    f.state.lease.lease_owner = owner;
    f.state.lease.lease_expires_at = new Date(f.state.now.getTime() - 1);
    await assert.rejects(acquirePackContentBackfillLease(f, f.leases), /LEASE_REFUSED/);
    assert.equal(f.state.acquireCalls, 0); assert.equal(f.state.audits.length, 0);
  }
});

test("recovery rejects changed manifest, operator and fence evidence", async () => {
  for (const change of [
    f => { f.manifest.responseHashes[0].sha256 = "b".repeat(64); },
    f => { f.state.audits[0].actor_operator_id = uuid(999); },
    f => { f.state.audits[0].details.expectedFence = "5"; },
  ]) {
    const f = backfillLeaseFixture();
    const first = await acquirePackContentBackfillLease(f, f.leases);
    f.state.now = new Date(first.expiresAt.getTime() + 1); change(f);
    await assert.rejects(acquirePackContentBackfillLease(f, f.leases), /LEASE_REFUSED/);
    assert.equal(f.state.acquireCalls, 1); assert.equal(f.state.audits.length, 1);
  }
});

test("a fence change between claim and acquire releases the acquired lease and refuses writes", async () => {
  const f = backfillLeaseFixture(); f.state.acquiredFenceDrift = 1n;
  await assert.rejects(acquirePackContentBackfillLease(f, f.leases), /LEASE_REFUSED/);
  assert.equal(f.state.releaseCalls, 1); assert.equal(f.state.lease.lease_owner, null);
});

test("read-only preflight refuses ledger drift, changed source pins, future capture and superseded snapshots", async () => {
  const unchanged = backfillLeaseFixture();
  assert.equal((await readPackContentBackfillProgress(unchanged.tx, unchanged.manifest)).sequence, 10n);
  assert.equal(unchanged.state.audits.length, 0);
  for (const change of [
    f => { f.state.currentSequence = 11n; },
    f => { f.state.runtime.state_generation = 3n; },
    f => { f.state.runtime.source_cursor = { opaque: "changed" }; },
    f => { f.manifest.capturedAt = "2027-01-01T00:00:00.000Z"; },
    f => { f.state.packs = []; },
    f => { f.state.packs[0].source_updated_at = new Date("2026-08-30T12:01:01.000Z"); },
    f => { f.state.packs[0].content_snapshots = [{ id: uuid(99), source_key: "provider:preview:v1", effective_at: new Date("2026-08-30T12:01:01.000Z") }]; },
  ]) {
    const f = backfillLeaseFixture(); change(f);
    await assert.rejects(readPackContentBackfillProgress(f.tx, f.manifest), /STATE_CHANGED/);
    await assert.rejects(acquirePackContentBackfillLease(f, f.leases), /STATE_CHANGED/);
    assert.equal(f.state.acquireCalls, 0); assert.equal(f.state.audits.length, 0);
  }
});

test("read-only preflight resumes a contiguous committed pack only while its proven snapshot remains latest", async () => {
  const f = backfillLeaseFixture(); const snapshotId = uuid(100);
  const snapshot = f.manifest.snapshots[0];
  const manifestDigest = packContentBackfillDigest(f.manifest);
  const snapshotDigest = providerPackContentSnapshotDigest(snapshot);
  const common = { correlation_id: f.manifest.operationId, actor_operator_id: f.manifest.operatorId, outcome: "success" };
  f.state.audits = [
    { ...common, action: PACK_CONTENT_BACKFILL_START_ACTION, target_type: "provider", target_id: f.manifest.providerId, details: { manifestDigest } },
    { ...common, action: PACK_CONTENT_BACKFILL_PACK_ACTION, target_type: "pack_content_snapshot", target_id: snapshotId,
      details: { index: 0, manifestDigest, snapshotId, snapshotDigest, firstSequence: "11", lastSequence: "12" } },
  ];
  f.state.currentSequence = 12n;
  f.state.packs[0].content_snapshots = [{ id: snapshotId, source_key: snapshot.sourceKey,
    effective_at: new Date(snapshot.effectiveAt), snapshot_digest: snapshotDigest }];
  assert.equal((await readPackContentBackfillProgress(f.tx, f.manifest)).sequence, 12n);
  assert.equal(f.state.audits.length, 2);
  f.state.packs[0].content_snapshots[0].id = uuid(101);
  await assert.rejects(readPackContentBackfillProgress(f.tx, f.manifest), /STATE_CHANGED/);
  assert.equal(f.state.audits.length, 2);
});
