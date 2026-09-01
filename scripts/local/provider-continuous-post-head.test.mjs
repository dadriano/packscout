import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { runContinuousPostHead, continuousPostHeadMaximumMilliseconds,
  continuousPostHeadPolicyForRegistration } = await tsImport("./provider-continuous-post-head.mts", import.meta.url);
const { residentFailureCode } = await tsImport("./provider-resident-errors.mts", import.meta.url);
const pins = { organizationId: "2a333333-3333-4333-8333-333333333331", providerId: "2a333333-3333-4333-8333-333333333332",
  providerKey: "clutchpacks", configId: "2a333333-3333-4333-8333-333333333333", initialRunId: "2a333333-3333-4333-8333-333333333334",
  operationId: "2a333333-3333-4333-8333-333333333335", operatorId: "2a333333-3333-4333-8333-333333333336" };
const policyFingerprint = "e".repeat(64);
function fixture() {
  return { snapshot: { now: new Date("2026-08-31T06:01:00Z"), providerId: pins.providerId, providerKey: pins.providerKey,
    configId: pins.configId, configNumber: 4n, configurationMatches: true, state: "idle", generation: 41n, runtimeRowVersion: 64n,
    checkpointHash: "a".repeat(64), checkpointValid: true, activeRunIds: [], actionableCommands: [],
    lease: { owner: null, fence: 1n, expiresAt: null }, run: { id: pins.initialRunId, configId: pins.configId,
      configNumber: 4n, state: "succeeded", fence: 1n, requestedHash: "b".repeat(64), requestedMatches: true,
      finalHash: "a".repeat(64), finalMatches: true, reachedHead: true, pageCount: 4, accepted: 123,
      failureCode: null, finishedAt: new Date("2026-08-31T06:00:00Z"), committedPageCount: 4 },
    lastPage: { number: 4, continuation: "head", hash: "a".repeat(64), matches: true } },
  cycle: null, cycleQueued: false, scheduleSeconds: 3600,
  cadence: { kind: "operator_interval", intervalSeconds: 60 }, postHeadPolicy: { kind: "none" }, authorityDigest: "c".repeat(64) };
}
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function run(registration, view = fixture(), signal = new AbortController().signal) {
  const registered = registration === undefined ? undefined : { policyFingerprint, ...registration };
  if (view && registered) view.postHeadPolicy = { kind: "callback", fingerprint: registered.policyFingerprint,
    timeoutMilliseconds: registered.timeoutMilliseconds };
  return runContinuousPostHead({ registration: registered, view, pins, parentAbortSignal: signal });
}

test("registration derives a frozen policy for startup without calling or exposing the callback", () => {
  const registration = { policyFingerprint, timeoutMilliseconds: 60_000, run() { assert.fail("validation never invokes"); } };
  const policy = continuousPostHeadPolicyForRegistration(registration);
  assert.deepEqual(policy, { kind: "callback", fingerprint: policyFingerprint, timeoutMilliseconds: 60_000 });
  assert.equal(Object.isFrozen(policy), true);
  registration.timeoutMilliseconds = 10;
  assert.equal(policy.timeoutMilliseconds, 60_000);
  const none = continuousPostHeadPolicyForRegistration();
  assert.deepEqual(none, { kind: "none" }); assert.equal(Object.isFrozen(none), true);
});

test("startup and invocation reject missing or malformed fingerprints and invalid callbacks", async () => {
  for (const fingerprint of [undefined, null, "", "f".repeat(63), "f".repeat(65), "E".repeat(64), "g".repeat(64), 123]) {
    const registration = { policyFingerprint: fingerprint, timeoutMilliseconds: 60_000,
      run() { assert.fail("invalid registration never invokes"); } };
    assert.throws(() => continuousPostHeadPolicyForRegistration(registration), hasCode("CONTINUOUS_POST_HEAD_INVALID"));
    await assert.rejects(run(registration), hasCode("CONTINUOUS_POST_HEAD_INVALID"));
  }
  for (const callback of [null, undefined, "run", {}]) {
    assert.throws(() => continuousPostHeadPolicyForRegistration({ policyFingerprint, timeoutMilliseconds: 60_000, run: callback }),
      hasCode("CONTINUOUS_POST_HEAD_INVALID"));
  }
  for (const timeoutMilliseconds of [0, -1, 1.5, Infinity, 900_001, undefined]) {
    assert.throws(() => continuousPostHeadPolicyForRegistration({ policyFingerprint, timeoutMilliseconds, run() {} }),
      hasCode("CONTINUOUS_POST_HEAD_INVALID"));
  }
});
function hasCode(code) {
  return error => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(residentFailureCode(error), code);
    return true;
  };
}

test("no registered post-head hook is a no-op without inspecting the view", async () => {
  const stop = new AbortController(); stop.abort();
  await run(undefined, null, stop.signal);
});

test("a verified head is frozen and safe, invokes once, and is awaited before later work", async () => {
  const released = deferred(); const started = deferred(); const events = []; const view = fixture(); let calls = 0;
  const completion = run({ timeoutMilliseconds: continuousPostHeadMaximumMilliseconds, async run(head, signal) {
    calls++; events.push("start"); assert.equal(signal.aborted, false);
    assert.deepEqual(head, { providerId: pins.providerId, configId: pins.configId, configNumber: "4",
      runId: pins.initialRunId, checkpointHash: "a".repeat(64), generation: "41", runtimeRowVersion: "64",
      headFinishedAt: "2026-08-31T06:00:00.000Z", authorityDigest: "c".repeat(64) });
    assert.equal(Object.isFrozen(head), true);
    assert.throws(() => { head.checkpointHash = "changed"; }, TypeError);
    view.snapshot.generation = 42n;
    assert.equal(head.generation, "41", "the callback receives an immutable copy, not the live view");
    started.resolve(); await released.promise; events.push("finish");
  } }, view).then(() => events.push("next"));
  await started.promise;
  assert.deepEqual(events, ["start"]);
  released.resolve(); await completion;
  assert.equal(calls, 1); assert.deepEqual(events, ["start", "finish", "next"]);
});

test("a timed-out hook signals abort but drains ignored cancellation before rejecting late success", async () => {
  const released = deferred(); const aborted = deferred(); let settled = false; let calls = 0;
  const completion = run({ timeoutMilliseconds: 1, async run(_head, signal) {
    calls++; signal.addEventListener("abort", () => aborted.resolve(signal.reason), { once: true });
    await released.promise;
  } });
  void completion.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(completion, hasCode("CONTINUOUS_POST_HEAD_TIMEOUT"));
  const reason = await aborted.promise;
  assert.equal(reason.code, "CONTINUOUS_POST_HEAD_TIMEOUT");
  assert.equal(settled, false, "deadline cannot release the resident while callback work remains");
  released.resolve(); await rejected; assert.equal(calls, 1);
});

test("timeout also drains callback rejection and discards its untrusted details", async () => {
  const cleanup = deferred(); const aborted = deferred(); let settled = false;
  const completion = run({ timeoutMilliseconds: 1, async run(_head, signal) {
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    aborted.resolve(); await cleanup.promise; throw new Error("private callback detail");
  } });
  void completion.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(completion, hasCode("CONTINUOUS_POST_HEAD_TIMEOUT"));
  await aborted.promise; assert.equal(settled, false);
  cleanup.resolve(); await rejected;
});

test("parent cancellation propagates a safe reason and waits for callback cleanup", async () => {
  const stop = new AbortController(); const started = deferred(); const cleanup = deferred(); let callbackSignal; let settled = false;
  const completion = run({ timeoutMilliseconds: 1000, async run(_head, signal) {
    callbackSignal = signal; started.resolve(); await cleanup.promise;
  } }, fixture(), stop.signal);
  void completion.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(completion, hasCode("CONTINUOUS_POST_HEAD_ABORTED"));
  await started.promise; stop.abort(new Error("private parent reason"));
  assert.equal(callbackSignal.aborted, true);
  assert.equal(callbackSignal.reason.message, "CONTINUOUS_POST_HEAD_ABORTED");
  assert.equal(settled, false);
  cleanup.resolve(); await rejected;
});

test("an already-aborted parent cannot start callback work", async () => {
  const stop = new AbortController(); stop.abort();
  await assert.rejects(run({ timeoutMilliseconds: 1000, async run() { assert.fail("must not invoke"); } }, fixture(), stop.signal),
    hasCode("CONTINUOUS_POST_HEAD_ABORTED"));
});

test("late synchronous success cannot outrun the deadline timer", async () => {
  let callbackSignal;
  await assert.rejects(run({ timeoutMilliseconds: 1, async run(_head, signal) {
    callbackSignal = signal;
    const end = performance.now() + 10;
    while (performance.now() < end) { /* Deliberately occupy this event-loop turn beyond the deadline. */ }
  } }), hasCode("CONTINUOUS_POST_HEAD_TIMEOUT"));
  assert.equal(callbackSignal.aborted, true);
});

test("invalid hook bounds and uncallable registrations refuse before callback work", async () => {
  for (const timeoutMilliseconds of [0, -1, 1.5, NaN, Infinity, 900_001, Number.MAX_SAFE_INTEGER, "60", undefined]) {
    await assert.rejects(run({ timeoutMilliseconds, async run() { assert.fail("must not invoke"); } }),
      hasCode("CONTINUOUS_POST_HEAD_INVALID"));
  }
  await assert.rejects(run({ timeoutMilliseconds: 60, run: null }), hasCode("CONTINUOUS_POST_HEAD_INVALID"));
});

test("callbacks require succeeded drained released heads with matching source authority", async () => {
  for (const mutate of [view => { view.snapshot.state = "paused"; }, view => { view.snapshot.run.state = "running"; },
    view => { view.snapshot.run.reachedHead = false; }, view => { view.snapshot.checkpointHash = null; },
    view => { view.snapshot.lease.owner = "foreign"; }, view => { view.snapshot.lease.expiresAt = new Date(); },
    view => { view.snapshot.activeRunIds.push(pins.initialRunId); },
    view => { view.snapshot.actionableCommands.push({ id: pins.operationId, runId: pins.initialRunId }); },
    view => { view.snapshot.lastPage.matches = false; }, view => { view.snapshot.run.finalMatches = false; },
    view => { view.snapshot.run.finishedAt = new Date(NaN); }, view => { view.snapshot.configId = pins.operationId; },
    view => { view.snapshot.configurationMatches = false; }, view => { view.authorityDigest = "private authority detail"; },
    view => { delete view.snapshot.runtimeRowVersion; }, view => { view.snapshot.runtimeRowVersion = 0n; },
    view => { view.snapshot.runtimeRowVersion = -1n; }]) {
    const view = fixture(); mutate(view);
    await assert.rejects(run({ timeoutMilliseconds: 1000, async run() { assert.fail("must not invoke"); } }, view),
      error => /^(CONTINUOUS|BACKFILL)_[A-Z_]+$/u.test(error.code));
  }
});

test("synchronous and asynchronous callback failures expose only the stable failure code", async () => {
  for (const callback of [() => { throw new Error("private callback detail"); },
    async () => { throw new Proxy({}, { get() { assert.fail("error must not be inspected"); } }); }]) {
    await assert.rejects(run({ timeoutMilliseconds: 1000, run: callback }), hasCode("CONTINUOUS_POST_HEAD_FAILED"));
  }
});
