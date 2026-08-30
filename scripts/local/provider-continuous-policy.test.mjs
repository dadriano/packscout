import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const policy = await tsImport("./provider-continuous-policy.mts", import.meta.url);
const { withContinuousResidency, claimContinuousResidency, continuousResidencyPort } = await tsImport("./provider-continuous-residency.mts", import.meta.url);
const { assertLocalBackfillDestination, localBackfillProviderPorts } = await tsImport("./provider-backfill-supervisor-authority.mts", import.meta.url);
const { dataforrestContinuation } = await tsImport("@packscout/contracts", import.meta.url);
const { parseContinuousArguments } = await tsImport("./run-provider-continuous-poller.mts", import.meta.url);
const { ContinuousReadUnavailableError } = policy;
const pins = { organizationId: "2a333333-3333-4333-8333-333333333331", providerId: "2a333333-3333-4333-8333-333333333332",
  providerKey: "clutchpacks", configId: "2a333333-3333-4333-8333-333333333333", initialRunId: "2a333333-3333-4333-8333-333333333334",
  operationId: "2a333333-3333-4333-8333-333333333335", operatorId: "2a333333-3333-4333-8333-333333333336" };
function fixture() {
  const snapshot = { now: new Date("2026-08-30T06:01:00Z"), providerId: pins.providerId, providerKey: pins.providerKey,
    configId: pins.configId, configNumber: 1n, configurationMatches: true, state: "idle", generation: 2n,
    checkpointHash: "a".repeat(64), checkpointValid: true, activeRunIds: [], actionableCommands: [],
    lease: { owner: null, fence: 1n, expiresAt: null }, run: { id: pins.initialRunId, configId: pins.configId,
      configNumber: 1n, state: "succeeded", fence: 1n, requestedHash: "b".repeat(64), requestedMatches: true,
      finalHash: "a".repeat(64), finalMatches: true, reachedHead: true, pageCount: 4, accepted: 123,
      failureCode: null, finishedAt: new Date("2026-08-30T06:00:00Z"), committedPageCount: 4 },
    lastPage: { number: 4, continuation: "head", hash: "a".repeat(64), matches: true } };
  return { snapshot, cycle: null, cycleQueued: false, scheduleSeconds: 30, authorityDigest: "c".repeat(64) };
}
test("head cycles preserve checkpoint, wait source minimum and honor longer central cadence", () => {
  const v = fixture();
  assert.equal(dataforrestContinuation({ poll_after_seconds: 60 }).minimumDelaySeconds, policy.continuousSourceMinimumSeconds);
  assert.equal(policy.continuousDecision(v, pins).state, "due");
  const cycle = policy.makeContinuousCycle(v, pins);
  assert.equal(cycle.checkpointHash, v.snapshot.checkpointHash);
  assert.equal(cycle.notBefore, "2026-08-30T06:01:00.000Z");
  assert.deepEqual(policy.makeContinuousCycle(v, pins), cycle);
  assert.equal(policy.continuousDecision({ ...v, scheduleSeconds: 300 }, pins).nextDueAt, "2026-08-30T06:05:00.000Z");
  assert.throws(() => policy.makeContinuousCycle({ ...v, scheduleSeconds: 300 }, pins), /NOT_DUE/);
  for (const value of [0, -1, Infinity, 1.5]) assert.throws(() => policy.continuousDueAt(v.snapshot, value));
  const emptyHead = fixture(); emptyHead.snapshot.run.requestedHash = emptyHead.snapshot.checkpointHash;
  assert.equal(policy.continuousDecision(emptyHead, pins).state, "due", "empty source head can poll from the same opaque position");
});
test("initial adoption refuses existing backfills, head corruption, origin reset, foreign work and leases", () => {
  for (const mutate of [v => v.snapshot.run.state = "running", v => v.snapshot.run.reachedHead = false,
    v => v.snapshot.checkpointHash = null, v => v.snapshot.run.finalMatches = false,
    v => v.snapshot.lastPage.number--, v => v.snapshot.activeRunIds.push(pins.providerId),
    v => v.snapshot.actionableCommands.push({ id: pins.providerId, runId: null }),
    v => v.snapshot.lease.owner = "foreign", v => v.snapshot.configurationMatches = false]) {
    const v = fixture(); mutate(v); assert.throws(() => policy.continuousDecision(v, pins));
  }
});
test("pause stays resident without queue or launch; stop exits without overriding controls", async () => {
  const v = fixture(); v.snapshot.state = "paused"; let waits = 0; const states = [];
  assert.equal(await policy.superviseContinuousProvider({ pins, read: async () => v,
    persist: async () => assert.fail(), queue: async () => assert.fail(), execute: async () => assert.fail(),
    wait: async ms => { assert.equal(ms, 15000); waits++; v.snapshot.state = "stopped"; }, emit: e => states.push(e.state),
  }, new AbortController().signal), "stopped");
  assert.equal(waits, 1); assert.deepEqual(states, ["paused", "stopped"]);
});
test("resident performs multiple due cycles after head and waits between polls", async () => {
  const v = fixture(); let executions = 0; let waits = 0; const stop = new AbortController();
  await policy.superviseContinuousProvider({ pins, read: async () => v,
    persist: async view => { v.cycle = policy.makeContinuousCycle(view, pins); v.cycleQueued = false; },
    queue: async cycle => { v.cycleQueued = true; v.snapshot.run = { ...v.snapshot.run, id: cycle.runId,
      state: "queued", reachedHead: false, requestedHash: cycle.checkpointHash };
      v.snapshot.activeRunIds = [cycle.runId]; },
    execute: async () => { executions++; v.snapshot.run.state = "succeeded"; v.snapshot.run.reachedHead = true;
      v.snapshot.run.finishedAt = new Date(v.snapshot.now); v.snapshot.activeRunIds = [];
      if (executions === 3) stop.abort(); return "head"; },
    wait: async ms => { waits++; assert.ok(ms <= 15000); v.snapshot.now = new Date(v.snapshot.now.getTime() + ms); }, emit() {},
  }, stop.signal);
  assert.equal(executions, 3); assert.equal(waits, 8);
});
test("permanent cycle failure latches blocked, never starts a future cycle, and emits no unsafe error", async () => {
  const v = fixture(); v.cycle = policy.makeContinuousCycle(v, pins); v.cycleQueued = true;
  v.snapshot.run.state = "failed"; v.snapshot.run.reachedHead = false; v.snapshot.state = "error";
  v.snapshot.run.failureCode = "PROVIDER_IMPORT_EXECUTION_FAILED"; v.snapshot.lastPage.continuation = "more";
  let waits = 0; const events = []; const stop = new AbortController();
  await policy.superviseContinuousProvider({ pins, read: async () => v,
    persist: async () => assert.fail(), queue: async () => assert.fail(), execute: async () => assert.fail(),
    wait: async () => { if (++waits === 3) stop.abort(); }, emit: event => events.push(event),
  }, stop.signal);
  assert.equal(events[0].code, "BACKFILL_PERMANENT_FAILURE"); assert.equal(waits, 3);
});
test("only read unavailability waits and retries; queue failures remain latched even across unavailable observations", async () => {
  const v = fixture(); let reads = 0; let queues = 0; let waits = 0; const events = []; const stop = new AbortController();
  await policy.superviseContinuousProvider({ pins,
    read: async () => { if (++reads === 1 || reads === 4) throw new ContinuousReadUnavailableError(); return v; },
    persist: async view => { v.cycle = policy.makeContinuousCycle(view, pins); },
    queue: async () => { queues++; throw new ContinuousReadUnavailableError(); },
    execute: async () => assert.fail("must not launch"),
    wait: async ms => { assert.equal(ms, 15000); if (++waits === 4) stop.abort(); }, emit: event => events.push(event),
  }, stop.signal);
  assert.equal(queues, 1); assert.equal(events[0].state, "read_unavailable");
  const blocked = events.findIndex(event => event.state === "blocked");
  assert.ok(blocked > 0); assert.equal(events.slice(blocked, -1).every(event => event.state === "blocked"), true);
});
test("live own crash-gap utility lease is waited out without stealing, expired own lease requests cleanup", () => {
  const v = fixture(); v.cycle = policy.makeContinuousCycle(v, pins);
  v.snapshot.lease = { owner: policy.continuousQueueOwner(v.cycle), fence: 2n,
    expiresAt: new Date(v.snapshot.now.getTime() + 5000) };
  assert.equal(policy.continuousDecision(v, pins).waitMilliseconds, 5000);
  v.snapshot.now = v.snapshot.lease.expiresAt;
  assert.equal(policy.continuousDecision(v, pins).state, "queue");
});
test("exclusive resident collision prevents launch and health exposes safe process identity", async () => {
  const owner = await claimContinuousResidency(pins, () => ({ state: "waiting" }), 0);
  try {
    let launched = false;
    await assert.rejects(withContinuousResidency(pins, () => ({ state: "waiting" }), async () => { launched = true; }, owner.port), /ALREADY_OWNED/);
    assert.equal(launched, false);
    const health = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: owner.port }); let data = "";
      socket.on("data", chunk => { data += chunk; }); socket.once("end", () => resolve(JSON.parse(data))); socket.once("error", reject);
    });
    assert.equal(health.pid, process.pid); assert.equal(health.operationId, pins.operationId); assert.equal(health.state, "waiting");
  } finally { await owner.close(); }
  const replacement = await claimContinuousResidency(pins, () => ({ state: "waiting" }), owner.port); await replacement.close();
});
test("all four isolated destinations are exact, legacy/cross-provider routes and unknown CLI flags refuse", () => {
  for (const [providerKey, port] of Object.entries(localBackfillProviderPorts)) {
    const route = { node: { host: "127.0.0.1", port, sslMode: "disable" }, target: { databaseName: `packscout_${providerKey}` } };
    assert.doesNotThrow(() => assertLocalBackfillDestination(providerKey, route));
    for (const bad of [{ ...route, node: { ...route.node, port: 5432 } }, { ...route, target: { databaseName: "packscout-import-runtime" } },
      { ...route, node: { ...route.node, host: "localhost" } }]) assert.throws(() => assertLocalBackfillDestination(providerKey, bad));
    assert.equal(continuousResidencyPort({ ...pins, providerKey }), port + 1000);
  }
  const keys = ["organization-id", "provider-id", "provider-key", "config-id", "initial-run-id", "operation-id", "operator-id"];
  const values = [pins.organizationId, pins.providerId, pins.providerKey, pins.configId, pins.initialRunId, pins.operationId, pins.operatorId];
  const args = ["--check-only", ...keys.flatMap((key, index) => [`--${key}`, values[index]])];
  assert.deepEqual(parseContinuousArguments(args).pins, pins);
  assert.throws(() => parseContinuousArguments([...args, "--reset-cursor"]));
});
