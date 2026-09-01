import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins, residentFixture } from "./provider-resident-test-fixture.mjs";
const { superviseResidentBootstrap, ContinuousReadUnavailableError } = await tsImport("./provider-resident-policy.mts", import.meta.url);
const { readBackfillView } = await tsImport("./run-provider-backfill-supervisor.mts", import.meta.url);
const { superviseProviderBackfill } = await tsImport("./provider-backfill-supervisor.mts", import.meta.url);
const { persistResidentHandoff, residentContinuousPins } = await tsImport("./provider-resident-handoff.mts", import.meta.url);
const { continuousDecision } = await tsImport("./provider-continuous-policy.mts", import.meta.url);
async function ready() {
  const f = residentFixture(); const backfill = await readBackfillView(f.database, pins, f.authority);
  return { f, backfill, view: { backfill, handoff: null } };
}
test("bootstrap runs pinned backfill, commits one head handoff, then restart skips backfill", async () => {
  const { f, backfill, view } = await ready(); let executions = 0; const head = structuredClone(backfill.snapshot);
  Object.assign(backfill.snapshot, { state: "error" });
  Object.assign(backfill.snapshot.run, { state: "failed", reachedHead: false, failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT",
    requestedHash: "b".repeat(64) }); backfill.snapshot.lastPage.continuation = "more";
  let handoff;
  const ports = { read: async () => view,
    persist: async observed => { handoff = await persistResidentHandoff(f.database, pins, f.authority, observed); return handoff; },
    execute: async () => { executions++; backfill.snapshot = head; return "head"; },
    wait: async () => assert.fail(), emit() {} };
  const result = await superviseResidentBootstrap(ports, new AbortController().signal);
  assert.deepEqual(result, residentContinuousPins(handoff)); assert.equal(executions, 1); assert.equal(f.audits.length, 1);
  view.handoff = handoff; view.backfill = null;
  assert.deepEqual(await superviseResidentBootstrap({ ...ports, persist: async () => assert.fail(),
    execute: async () => assert.fail() }, new AbortController().signal), result);
});
test("pause and stop block handoff and execution; direct child stop stays stopped", async () => {
  const { backfill, view } = await ready(); backfill.snapshot.state = "paused"; const states = [];
  assert.equal(await superviseResidentBootstrap({ read: async () => view,
    persist: async () => assert.fail(), execute: async () => assert.fail(),
    wait: async () => { backfill.snapshot.state = "stopped"; }, emit: event => states.push(event.state),
  }, new AbortController().signal), null);
  assert.deepEqual(states, ["paused", "stopped"]);
  const queued = await ready(); queued.backfill.snapshot.state = "idle";
  Object.assign(queued.backfill.snapshot.run, { state: "queued", reachedHead: false,
    requestedHash: queued.backfill.snapshot.checkpointHash });
  queued.backfill.snapshot.activeRunIds = [pins.initialRunId];
  assert.equal(await superviseResidentBootstrap({ read: async () => queued.view,
    persist: async () => assert.fail(), execute: async () => "operator_stop", wait: async () => assert.fail(), emit() {},
  }, new AbortController().signal), null);
});
test("unknown handoff write failure latches through later successful reads and read outages", async () => {
  const { view } = await ready(); const stop = new AbortController(); let reads = 0; let writes = 0; let waits = 0; const events = [];
  await superviseResidentBootstrap({ read: async () => { if (++reads === 2) throw new ContinuousReadUnavailableError(); return view; },
    persist: async () => { writes++; throw new Error("secret private DB failure"); }, execute: async () => assert.fail(),
    wait: async () => { if (++waits === 3) stop.abort(); }, emit: event => events.push(event),
  }, stop.signal);
  assert.equal(writes, 1); assert.equal(events.filter(event => event.state === "blocked").length, 3);
  assert.equal(JSON.stringify(events).includes("private DB"), false);
});
test("read-only outage retries before handoff without treating any write as retryable", async () => {
  const { f, view } = await ready(); let reads = 0; let waits = 0;
  const result = await superviseResidentBootstrap({ read: async () => { if (++reads === 1) throw new ContinuousReadUnavailableError(); return view; },
    persist: backfill => persistResidentHandoff(f.database, pins, f.authority, backfill), execute: async () => assert.fail(),
    wait: async milliseconds => { assert.equal(milliseconds, 15000); waits++; assert.ok(waits < 3, "read outage must recover without latching"); }, emit() {},
  }, new AbortController().signal);
  assert.ok(result); assert.equal(waits, 1); assert.equal(f.audits.length, 1);
});
test("proven live child waits across terminal head until release; pause interrupts the wait", async () => {
  for (const paused of [false, true]) {
    const { backfill, view, f } = await ready(); let waits = 0;
    backfill.ownedLeaseExpiresAt = new Date(backfill.snapshot.now.getTime() + 20000);
    backfill.snapshot.lease = { owner: "owned", fence: 459n, expiresAt: backfill.ownedLeaseExpiresAt };
    const continuous = { snapshot: backfill.snapshot, cycle: null, cycleQueued: false, scheduleSeconds: 300,
      cadence: { kind: "central" }, postHeadPolicy: { kind: "none" },
      authorityDigest: f.authority.digest, ownedLeaseExpiresAt: backfill.ownedLeaseExpiresAt };
    assert.equal(continuousDecision(continuous, pins).state, "waiting");
    const result = await superviseProviderBackfill({ pins, read: async () => backfill,
      persistRetry: async () => assert.fail(), execute: async () => assert.fail(),
      wait: async ms => { assert.equal(ms, 15000); waits++;
        backfill.ownedLeaseExpiresAt = null; backfill.snapshot.lease = { owner: null, fence: 459n, expiresAt: null };
        if (paused) backfill.snapshot.state = "paused"; }, emit() {},
    }, new AbortController().signal);
    assert.equal(result, paused ? "operator_stop" : "head"); assert.equal(waits, 1);
    if (!paused) {
      view.backfill.ownedLeaseExpiresAt = new Date(backfill.snapshot.now.getTime() + 1000);
      const stop = new AbortController(); let writes = 0;
      await superviseResidentBootstrap({ read: async () => view, persist: async () => { writes++; assert.fail(); },
        execute: async () => assert.fail(), wait: async () => stop.abort(), emit() {} }, stop.signal);
      assert.equal(writes, 0);
    }
  }
});
