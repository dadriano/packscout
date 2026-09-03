import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const policy = await tsImport("./provider-continuous-policy.mts", import.meta.url);
const cadencePolicy = await tsImport("./provider-continuous-cadence.mts", import.meta.url);
const postHeadPolicy = await tsImport("./provider-continuous-post-head-policy.mts", import.meta.url);
const callbackPolicy = { kind: "callback", fingerprint: "e".repeat(64), timeoutMilliseconds: 1000 };
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
  return { snapshot, cycle: null, cycleQueued: false, scheduleSeconds: 30,
    cadence: cadencePolicy.defaultContinuousCadence, postHeadPolicy: postHeadPolicy.defaultContinuousPostHeadPolicy,
    authorityDigest: "c".repeat(64) };
}
test("explicit minute cadence preserves the hourly config and rejects invalid or unknown policy", () => {
  const v = fixture(); v.scheduleSeconds = 3600;
  assert.equal(policy.continuousDecision(v, pins).nextDueAt, "2026-08-30T07:00:00.000Z");
  v.cadence = { kind: "operator_interval", intervalSeconds: 60 };
  const before = structuredClone(v.snapshot), cycle = policy.makeContinuousCycle(v, pins);
  assert.equal(policy.continuousDecision(v, pins).state, "due");
  assert.equal(cycle.version, 2); assert.deepEqual(cycle.cadence, v.cadence); assert.equal(cycle.effectiveIntervalSeconds, 60);
  assert.equal(cycle.notBefore, "2026-08-30T06:01:00.000Z"); assert.equal(v.scheduleSeconds, 3600);
  assert.deepEqual(v.snapshot, before);
  assert.equal(cadencePolicy.effectiveContinuousIntervalSeconds(30), 60);
  assert.equal(cadencePolicy.effectiveContinuousIntervalSeconds(3600, { kind: "operator_interval", intervalSeconds: 86400 }), 86400);
  for (const cadence of [null, {}, { kind: "unknown" }, { kind: "central", intervalSeconds: 60 },
    ...[0, 59, 86401, 60.5, NaN, Infinity, "60"].map(intervalSeconds => ({ kind: "operator_interval", intervalSeconds }))]) {
    assert.throws(() => cadencePolicy.effectiveContinuousIntervalSeconds(3600, cadence), /CADENCE_INVALID/);
  }
  for (const schedule of [0, -1, 86401, NaN, Infinity, 1.5]) {
    assert.throws(() => cadencePolicy.effectiveContinuousIntervalSeconds(schedule, v.cadence), /CADENCE_INVALID/);
  }
});
test("cycle cadence, effective interval and exact due time cannot drift or fall back to old receipts", () => {
  const v = fixture(); v.scheduleSeconds = 3600; v.cadence = { kind: "operator_interval", intervalSeconds: 60 };
  const cycle = policy.makeContinuousCycle(v, pins);
  for (const change of [{ cadence: { kind: "central" } }, { effectiveIntervalSeconds: 3600 },
    { notBefore: "2026-08-30T06:00:00.000Z" }, { version: 1 }]) {
    assert.throws(() => policy.assertContinuousCycle({ ...cycle, ...change }, pins, v.authorityDigest, v.cadence, 3600), /CYCLE_DRIFT/);
  }
  const { version, cadence, effectiveIntervalSeconds, postHeadPolicy: omittedPolicy, ...historical } = cycle;
  assert.doesNotThrow(() => policy.assertHistoricalContinuousCycle(historical, pins, v.authorityDigest));
  assert.throws(() => policy.assertContinuousCycle(historical, pins, v.authorityDigest, v.cadence, 3600), /CYCLE_DRIFT/);
  assert.throws(() => policy.assertHistoricalContinuousCycle(cycle, pins, v.authorityDigest), /CYCLE_DRIFT/);
  assert.throws(() => policy.continuousDecision({ ...v, cycle, cycleQueued: true, cadence: { kind: "central" } }, pins), /CYCLE_DRIFT/);
});
test("post-head policy requires an exact bounded callback identity and never fills absent receipt fields", () => {
  assert.ok(Object.isFrozen(postHeadPolicy.defaultContinuousPostHeadPolicy));
  assert.deepEqual(postHeadPolicy.defaultContinuousPostHeadPolicy, { kind: "none" });
  assert.ok(Object.isFrozen(postHeadPolicy.validatedContinuousPostHeadPolicy(callbackPolicy)));
  assert.doesNotThrow(() => postHeadPolicy.validatedContinuousPostHeadPolicy({ ...callbackPolicy, timeoutMilliseconds: 900000 }));
  for (const value of [undefined, null, {}, { kind: "unknown" }, { kind: "none", fingerprint: callbackPolicy.fingerprint },
    { kind: "callback", timeoutMilliseconds: 1000 }, { kind: "callback", fingerprint: callbackPolicy.fingerprint },
    ...["a".repeat(63), "A".repeat(64), "g".repeat(64), ""].map(fingerprint => ({ ...callbackPolicy, fingerprint })),
    ...[0, 900001, 0.5, NaN, Infinity, "1000"].map(timeoutMilliseconds => ({ ...callbackPolicy, timeoutMilliseconds }))]) {
    assert.throws(() => postHeadPolicy.validatedContinuousPostHeadPolicy(value), /POST_HEAD_POLICY_INVALID/);
  }
  const v = fixture(); v.postHeadPolicy = callbackPolicy;
  const cycle = policy.makeContinuousCycle(v, pins);
  assert.deepEqual(cycle.postHeadPolicy, callbackPolicy);
  assert.doesNotThrow(() => policy.assertContinuousCycle(cycle, pins, v.authorityDigest, v.cadence, 30, callbackPolicy));
  for (const changed of [undefined, { kind: "none" }, { ...callbackPolicy, timeoutMilliseconds: 1001 },
    { ...callbackPolicy, fingerprint: "f".repeat(64) }]) {
    assert.throws(() => policy.assertContinuousCycle({ ...cycle, postHeadPolicy: changed }, pins,
      v.authorityDigest, v.cadence, 30, callbackPolicy), /CYCLE_DRIFT/);
    assert.throws(() => policy.assertContinuousCycle(cycle, pins, v.authorityDigest, v.cadence, 30, changed), /CYCLE_DRIFT/);
  }
  assert.throws(() => policy.continuousDecision({ ...v, postHeadPolicy: undefined }, pins), /POST_HEAD_POLICY_INVALID/);
});
test("callback presence must match bound policy before any new source or queue admission", async () => {
  for (const mode of ["missing", "unbound"]) {
    const v = fixture(), stop = new AbortController(), events = [];
    if (mode === "missing") v.postHeadPolicy = callbackPolicy;
    await policy.superviseContinuousProvider({ pins, read: async () => v,
      ...(mode === "unbound" ? { postHead: async () => assert.fail("Unbound callback cannot run.") } : {}),
      persist: async () => assert.fail(), queue: async () => assert.fail(), execute: async () => assert.fail(),
      wait: async () => stop.abort(), emit: event => events.push(event),
    }, stop.signal);
    assert.equal(events[0].state, "blocked"); assert.equal(events[0].code, "CONTINUOUS_POST_HEAD_POLICY_DRIFT");
  }
});
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
test("post-head work is awaited once per verified head before subsequent cycle admission", async () => {
  const v = fixture(), stop = new AbortController(), events = []; let reads = 0, lastHookRead = -1, executions = 0;
  v.postHeadPolicy = callbackPolicy;
  await policy.superviseContinuousProvider({ pins,
    read: async () => { reads++; return v; },
    postHead: async view => { events.push(`hook:${view.snapshot.run.id}`); lastHookRead = reads;
      await Promise.resolve(); if (executions === 1) stop.abort(); },
    persist: async view => { assert.ok(reads > lastHookRead, "A fresh authoritative read must follow the hook.");
      events.push("persist"); v.cycle = policy.makeContinuousCycle(view, pins); },
    queue: async cycle => { events.push("queue"); v.cycleQueued = true; v.snapshot.run = { ...v.snapshot.run,
      id: cycle.runId, state: "queued", reachedHead: false, requestedHash: cycle.checkpointHash }; v.snapshot.activeRunIds = [cycle.runId]; },
    execute: async () => { events.push("execute"); executions++; v.snapshot.run.state = "succeeded";
      v.snapshot.run.reachedHead = true; v.snapshot.run.finishedAt = new Date(v.snapshot.now); v.snapshot.activeRunIds = []; return "head"; },
    wait: async () => assert.fail("The first due cycle should run after its hook."),
    emit: event => { if (event.state === "post_head") events.push("post_head"); },
  }, stop.signal);
  assert.deepEqual(events.slice(0, 5), ["post_head", `hook:${pins.initialRunId}`, "persist", "queue", "execute"]);
  assert.equal(events.filter(value => value.startsWith("hook:")).length, 2);
});
test("post-head callback changes require a fresh read and failures latch without any queue", async () => {
  for (const mode of ["pause", "failure"]) {
    const v = fixture(), stop = new AbortController(), states = []; let hooks = 0, reads = 0;
    v.postHeadPolicy = callbackPolicy;
    await policy.superviseContinuousProvider({ pins, read: async () => { reads++; return v; },
      postHead: async () => { hooks++; if (mode === "failure") throw new Error("Synthetic post-head failure");
        v.snapshot.state = "paused"; },
      persist: async () => assert.fail("Post-head pause/failure cannot create a cycle."),
      queue: async () => assert.fail(), execute: async () => assert.fail(),
      wait: async () => { if (mode === "failure" && reads < 2) return; stop.abort(); }, emit: event => states.push(event.state),
    }, stop.signal);
    assert.equal(hooks, 1); assert.ok(reads >= 2); assert.equal(states.includes(mode === "pause" ? "paused" : "blocked"), true);
  }
});
test("an unchanged head runs post-head work once across repeated cadence waits", async () => {
  const v = fixture(), stop = new AbortController(); v.scheduleSeconds = 3600; let hooks = 0, waits = 0;
  v.postHeadPolicy = callbackPolicy;
  await policy.superviseContinuousProvider({ pins, read: async () => v, postHead: async () => { hooks++; },
    persist: async () => assert.fail(), queue: async () => assert.fail(), execute: async () => assert.fail(),
    wait: async () => { if (++waits === 3) stop.abort(); }, emit() {},
  }, stop.signal);
  assert.equal(hooks, 1); assert.equal(waits, 3);
});
test("deployment drift after cadence wait refuses cycle admission before durable or source work", async () => {
  for (const stage of ["due", "queue", "execute"]) {
    const v = fixture(), stop = new AbortController(), states = []; let checks = 0, waits = 0;
    if (stage !== "due") v.cycle = policy.makeContinuousCycle(v, pins);
    if (stage === "execute") {
      v.cycleQueued = true; v.snapshot.run = { ...v.snapshot.run, id: v.cycle.runId,
        state: "queued", reachedHead: false, requestedHash: v.cycle.checkpointHash };
      v.snapshot.activeRunIds = [v.cycle.runId];
    }
    if (stage === "due") v.snapshot.now = new Date(v.snapshot.now.getTime() - 1000);
    await policy.superviseContinuousProvider({ pins, read: async () => v,
      beforeSource: async () => { checks++; throw new Error("private deployment changed"); },
      persist: async () => assert.fail("Changed deployment must not persist a cycle."),
      queue: async () => assert.fail("Changed deployment must not queue a run."),
      execute: async () => assert.fail("Changed deployment must not launch a worker."),
      wait: async () => { waits++; if (stage === "due" && waits === 1) {
        v.snapshot.now = new Date(v.snapshot.now.getTime() + 1000);
      } else stop.abort(); }, emit: event => states.push(event),
    }, stop.signal);
    assert.equal(checks, 1); assert.ok(states.some(event => event.state === "blocked"));
    assert.equal(JSON.stringify(states).includes("private deployment"), false);
  }
});
test("paused and owned work never invokes post-head callback", async () => {
  for (const mode of ["paused", "owned"]) {
    const v = fixture(), stop = new AbortController();
    v.postHeadPolicy = callbackPolicy;
    if (mode === "paused") v.snapshot.state = "paused";
    else { v.ownedLeaseExpiresAt = new Date(v.snapshot.now.getTime() + 1000);
      v.snapshot.lease.owner = "owned:child"; v.snapshot.lease.expiresAt = v.ownedLeaseExpiresAt; }
    await policy.superviseContinuousProvider({ pins, read: async () => v, postHead: async () => assert.fail(),
      persist: async () => assert.fail(), queue: async () => assert.fail(), execute: async () => assert.fail(),
      wait: async () => stop.abort(), emit() {},
    }, stop.signal);
  }
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
  const awaited = parseContinuousArguments(["--run", "--bootstrap-backfill", "--await-initial-run",
    ...keys.flatMap((key, index) => [`--${key}`, values[index]])]);
  assert.equal(awaited.bootstrapBackfill, true); assert.equal(awaited.awaitInitialRun, true);
  assert.throws(() => parseContinuousArguments(["--run", "--await-initial-run",
    ...keys.flatMap((key, index) => [`--${key}`, values[index]])]));
  assert.throws(() => parseContinuousArguments([...args, "--reset-cursor"]));
});
