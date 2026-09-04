import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { pins, residentFixture } from "./provider-resident-test-fixture.mjs";
const { superviseResidentBootstrap, ContinuousReadUnavailableError } = await tsImport("./provider-resident-policy.mts", import.meta.url);
const { readBackfillView } = await tsImport("./run-provider-backfill-supervisor.mts", import.meta.url);
const { superviseProviderBackfill } = await tsImport("./provider-backfill-supervisor.mts", import.meta.url);
const { persistResidentHandoff, residentContinuousPins } = await tsImport("./provider-resident-handoff.mts", import.meta.url);
const { continuousDecision } = await tsImport("./provider-continuous-policy.mts", import.meta.url);
const { ProviderBackfillSupervisorError } = await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
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
  const ports = { read: async () => handoff ? { handoff, backfill: null } : view,
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
  const { f, view } = await ready(); let reads = 0; let waits = 0; let handoff;
  const result = await superviseResidentBootstrap({ read: async () => {
    if (++reads === 1) throw new ContinuousReadUnavailableError();
    return handoff ? { handoff, backfill: null } : view;
  },
    persist: async backfill => handoff = await persistResidentHandoff(f.database, pins, f.authority, backfill),
    execute: async () => assert.fail(),
    wait: async milliseconds => { assert.equal(milliseconds, 15000); waits++; assert.ok(waits < 3, "read outage must recover without latching"); }, emit() {},
  }, new AbortController().signal);
  assert.ok(result); assert.equal(waits, 1); assert.equal(f.audits.length, 1);
});
test("explicit initial-run wait performs no source or persistence work until admission appears", async () => {
  const { f, view } = await ready();
  const waiting = { handoff: null, backfill: null, awaitingInitialRun: true };
  const states = []; let reads = 0; let waits = 0; let handoff;
  const result = await superviseResidentBootstrap({
    read: async () => ++reads === 1 ? waiting : handoff ? { handoff, backfill: null } : view,
    persist: async backfill => handoff = await persistResidentHandoff(f.database, pins, f.authority, backfill),
    execute: async () => assert.fail("source execution must wait for the deterministic run"),
    wait: async milliseconds => { assert.equal(milliseconds, 15000); waits++; },
    emit: event => states.push(event.state),
  }, new AbortController().signal);
  assert.ok(result); assert.equal(waits, 1); assert.equal(states[0], "waiting_initial_run");
  assert.equal(f.audits.length, 1);
});
test("persisted handoff cannot enter continuous polling before the journal release appears", async () => {
  const { backfill, view } = await ready();
  const waiting = { handoff: null, backfill: null, awaitingInitialRun: true };
  const stop = new AbortController(); const states = []; let persisted = false; let released = false;
  const result = await superviseResidentBootstrap({
    read: async () => !persisted ? view : released
      ? { handoff: { pins, authorityDigest: "d".repeat(64), headRunId: pins.initialRunId,
        checkpointHash: backfill.snapshot.checkpointHash, generation: backfill.snapshot.generation.toString(),
        continuousOperationId: pins.operatorId, createdAt: backfill.snapshot.now.toISOString() }, backfill: null }
      : waiting,
    persist: async () => { persisted = true; return {}; },
    execute: async () => assert.fail("source execution must remain gated after handoff"),
    wait: async milliseconds => { assert.equal(milliseconds, 15000); released = true; },
    emit: event => states.push(event.state),
  }, stop.signal);
  assert.ok(result); assert.deepEqual(states, ["handoff", "waiting_initial_run"]);
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
async function pendingBackfill() {
  const state = await ready(); Object.assign(state.backfill.snapshot, { state: "error" });
  Object.assign(state.backfill.snapshot.run, { state: "failed", reachedHead: false, failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT",
    requestedHash: "b".repeat(64) }); state.backfill.snapshot.lastPage.continuation = "more";
  return state;
}
const unavailable = () => new ProviderBackfillSupervisorError("BACKFILL_PROVIDER_DATABASE_UNAVAILABLE");
test("provider-database refusal during backfill execution waits with backoff, then resumes from the intact checkpoint", async () => {
  const { f, backfill, view } = await pendingBackfill(); const head = structuredClone(backfill.snapshot);
  // Production: the parent's first query after a long child run was refused
  // (a pooled connection left read-only); the checkpoint was intact and a hand
  // restart resumed at once. The resident must do that itself.
  let executions = 0; const waits = []; const events = []; let handoff;
  const result = await superviseResidentBootstrap({ read: async () => handoff ? { handoff, backfill: null } : view,
    persist: async observed => { handoff = await persistResidentHandoff(f.database, pins, f.authority, observed); return handoff; },
    execute: async () => { if (++executions <= 3) throw unavailable(); backfill.snapshot = head; return "head"; },
    wait: async ms => { waits.push(ms); }, emit: event => events.push(event) }, new AbortController().signal);
  assert.deepEqual(result, residentContinuousPins(handoff)); assert.equal(executions, 4);
  assert.deepEqual(waits, [15000, 30000, 60000]);
  assert.deepEqual(events.filter(event => event.state === "provider_unavailable").map(event => event.retry), [1, 2, 3]);
  assert.equal(events.every(event => event.code === undefined || event.code === "BACKFILL_PROVIDER_DATABASE_UNAVAILABLE"), true);
  assert.equal(events.some(event => event.state === "blocked"), false);
  assert.equal(events.filter(event => event.state === "backfilling").length, 4, "every retry is a fresh observe-verify-act pass");
});
test("a refusal that never clears latches blocked at the retry limit; any other execution refusal latches at once", async () => {
  const { view } = await pendingBackfill(); const stop = new AbortController(); let executions = 0; const waits = []; const events = [];
  await superviseResidentBootstrap({ read: async () => view, persist: async () => assert.fail(),
    execute: async () => { executions++; throw unavailable(); },
    wait: async ms => { waits.push(ms); if (waits.length === 27) stop.abort(); }, emit: event => events.push(event) }, stop.signal);
  assert.equal(executions, 25, "24 retries, then the next refusal latches and nothing launches again");
  assert.deepEqual(waits.slice(0, 6), [15000, 30000, 60000, 120000, 240000, 300000]);
  assert.equal(waits.slice(6, 24).every(ms => ms === 300000), true); assert.deepEqual(waits.slice(24), [15000, 15000, 15000]);
  assert.equal(events.filter(event => event.state === "provider_unavailable").length, 24);
  const blocked = events.findIndex(event => event.state === "blocked");
  assert.ok(blocked > 0); assert.equal(events[blocked].code, "BACKFILL_PROVIDER_DATABASE_UNAVAILABLE");
  assert.equal(events.slice(blocked).every(event => event.state === "blocked" || event.state === "stopped"), true);

  const other = await pendingBackfill(); const halt = new AbortController(); const states = []; let launches = 0;
  await superviseResidentBootstrap({ read: async () => other.view, persist: async () => assert.fail(),
    execute: async () => { launches++; throw new ProviderBackfillSupervisorError("BACKFILL_ACTIVE_RUN_CHANGED"); },
    wait: async () => { if (states.filter(state => state === "blocked").length === 2) halt.abort(); },
    emit: event => states.push(event.state) }, halt.signal);
  assert.equal(launches, 1); assert.deepEqual(states, ["backfilling", "blocked", "blocked", "stopped"]);
});
