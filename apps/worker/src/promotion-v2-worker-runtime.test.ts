import assert from "node:assert/strict";
import test from "node:test";
import type { ManifestEligibilitySnapshot } from "@packscout/services";
import {
  PromotionV2WorkerRuntime,
  type PromotionV2WorkerLogEvent,
} from "./promotion-v2-worker-runtime.ts";

const now = new Date("2026-08-16T12:00:00.000Z");

function snapshot(enabledPlatformKeys: readonly string[]):
ManifestEligibilitySnapshot {
  return {
    organizationId: "54000000-0000-4000-8000-000000000001",
    sharedConfigurationEpoch: {
      configurationKey: "catalog", revision: 1,
      publicChangeSequence: 1n, configurationHash: "a".repeat(64),
    },
    confidencePolicyVersion: "confidence-v1",
    staleAfterSeconds: 300,
    configuredPlatformKeys: ["alpha", "beta"],
    enabledPlatformKeys,
    lifecycleDecisionSequence: 1n,
    checkpoints: [],
  };
}

test("bootstrap precedes claims and enabled provider lanes run concurrently with manifest", async () => {
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const events: PromotionV2WorkerLogEvent[] = [];
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() { calls.push("eligibility"); },
    bootstrap: { ensureVerified() { calls.push("bootstrap"); return Promise.resolve(); } },
    providerLanes: [
      { platformKey: "alpha", async runCycle() {
        calls.push("alpha:start"); await gate; calls.push("alpha:end");
      }, runRecoveryCycle() { calls.push("alpha:recovery"); return Promise.resolve(); } },
      { platformKey: "beta", runCycle() {
        calls.push("beta"); return Promise.resolve();
      }, runRecoveryCycle() { calls.push("beta:recovery"); return Promise.resolve(); } },
    ],
    manifestLane: { async runCycle() {
      calls.push("manifest:start"); await gate; calls.push("manifest:end");
    } },
    pollIntervalMilliseconds: 5_000,
    clock: { now: () => now },
    logger: { write: (event) => events.push(event) },
  });

  const cycle = runtime.runCycle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    "eligibility", "bootstrap", "alpha:start", "beta:recovery", "manifest:start",
  ]);
  release!();
  await cycle;
  assert.equal(calls.includes("beta"), false);
  assert.equal(events.at(-1)?.enabledProviderCount, 1);
});

test("eligibility is reevaluated each cycle while bootstrap remains one-time", async () => {
  let enabled: readonly string[] = ["alpha"];
  let bootstrapCalls = 0;
  const calls: string[] = [];
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(enabled)) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { bootstrapCalls += 1; return Promise.resolve(); } },
    providerLanes: [
      { platformKey: "alpha", runCycle() { calls.push("alpha"); return Promise.resolve(); },
        runRecoveryCycle() { calls.push("alpha:recovery"); return Promise.resolve(); } },
      { platformKey: "beta", runCycle() { calls.push("beta"); return Promise.resolve(); },
        runRecoveryCycle() { calls.push("beta:recovery"); return Promise.resolve(); } },
    ],
    manifestLane: { runCycle() { calls.push("manifest"); return Promise.resolve(); } },
    pollIntervalMilliseconds: 5_000,
    clock: { now: () => now },
    logger: { write() {} },
  });

  await runtime.runCycle();
  enabled = ["beta"];
  await runtime.runCycle();
  assert.deepEqual(calls, [
    "alpha", "beta:recovery", "manifest",
    "alpha:recovery", "beta", "manifest",
  ]);
  assert.equal(bootstrapCalls, 2);
});

test("stop aborts an in-flight provider and manifest cycle", async () => {
  const observed: boolean[] = [];
  let started = 0;
  let markStarted: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const cycle = (signal?: AbortSignal) => new Promise<void>((resolve) => {
    started += 1;
    if (started === 2) markStarted!();
    const done = () => { observed.push(signal?.aborted === true); resolve(); };
    if (signal?.aborted === true) done();
    else signal?.addEventListener("abort", done, { once: true });
  });
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { return Promise.resolve(); } },
    providerLanes: [{
      platformKey: "alpha", runCycle: cycle,
      runRecoveryCycle: cycle,
    }],
    manifestLane: { runCycle: cycle },
    pollIntervalMilliseconds: 5_000,
    clock: { now: () => now },
    logger: { write() {} },
  });

  const running = runtime.start();
  await allStarted;
  runtime.stop();
  await running;
  assert.deepEqual(observed, [true, true]);
});

test("a failed lane is isolated until all siblings finish and later cycles continue", async () => {
  const calls: string[] = [];
  let alphaFails = true;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha", "beta"])) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { return Promise.resolve(); } },
    providerLanes: [
      {
        platformKey: "alpha",
        runCycle() {
          calls.push("alpha");
          if (alphaFails) return Promise.reject(new Error("lane failed"));
          return Promise.resolve();
        },
        runRecoveryCycle() { return Promise.resolve(); },
      },
      {
        platformKey: "beta",
        async runCycle() {
          await new Promise<void>((resolve) => setImmediate(resolve));
          calls.push("beta");
        },
        runRecoveryCycle() { return Promise.resolve(); },
      },
    ],
    manifestLane: {
      async runCycle() {
        await new Promise<void>((resolve) => setImmediate(resolve));
        calls.push("manifest");
      },
    },
    pollIntervalMilliseconds: 5_000,
    clock: { now: () => now },
    logger: { write() {} },
  });

  await runtime.runCycle();
  assert.deepEqual(calls, ["alpha", "beta", "manifest"]);
  alphaFails = false;
  await runtime.runCycle();
  assert.deepEqual(calls, [
    "alpha", "beta", "manifest", "alpha", "beta", "manifest",
  ]);
});

test("manifest repolls after A completes while unrelated B is still delayed", async () => {
  let alphaCompleted = false;
  let betaCompleted = false;
  let manifestCalls = 0;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: {
      getSnapshot: () => Promise.resolve(snapshot(["alpha", "beta"])),
    },
    validateEligibility() {},
    bootstrap: { ensureVerified() { return Promise.resolve(); } },
    providerLanes: [
      {
        platformKey: "alpha",
        async runCycle() {
          if (!alphaCompleted) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            alphaCompleted = true;
          }
        },
        runRecoveryCycle() { return Promise.resolve(); },
      },
      {
        platformKey: "beta",
        runCycle(signal) {
          return new Promise<void>((resolve) => {
            const finish = () => { betaCompleted = true; resolve(); };
            if (signal?.aborted) finish();
            else signal?.addEventListener("abort", finish, { once: true });
          });
        },
        runRecoveryCycle() { return Promise.resolve(); },
      },
    ],
    manifestLane: {
      runCycle() {
        manifestCalls += 1;
        if (manifestCalls >= 2 && alphaCompleted) runtime.stop();
        return Promise.resolve();
      },
    },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
    sleeper: {
      sleep() {
        return new Promise<void>((resolve) => setImmediate(resolve));
      },
    },
  });

  await runtime.start();
  assert.equal(alphaCompleted, true);
  assert.ok(manifestCalls >= 2);
  assert.equal(betaCompleted, true, "stop aborts and joins the delayed lane");
});

test("throwing logger cannot stop manifest repoll after a provider failure", async () => {
  let manifestCalls = 0;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { return Promise.resolve(); } },
    providerLanes: [{
      platformKey: "alpha",
      runCycle() { throw new Error("provider unavailable"); },
      runRecoveryCycle() { return Promise.resolve(); },
    }],
    manifestLane: {
      runCycle() {
        manifestCalls += 1;
        if (manifestCalls === 2) runtime.stop();
        return Promise.resolve();
      },
    },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() { throw new Error("logger unavailable"); } },
    sleeper: {
      sleep() { return new Promise<void>((resolve) => setImmediate(resolve)); },
    },
  });

  await runtime.start();
  assert.equal(manifestCalls, 2);
});

test("hard lane refusal propagates without joining an abort-ignoring sibling", async () => {
  const refusal = Object.assign(new Error("safe persisted-scope refusal"), {
    code: "PROMOTION_V2_SCOPE_MISMATCH",
  });
  let alphaCalls = 0;
  let betaCalls = 0;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: {
      getSnapshot: () => Promise.resolve(snapshot(["alpha", "beta"])),
    },
    validateEligibility() {},
    bootstrap: { ensureVerified() { return Promise.resolve(); } },
    providerLanes: [
      {
        platformKey: "alpha",
        runCycle() { alphaCalls += 1; throw refusal; },
        runRecoveryCycle() { return Promise.resolve(); },
      },
      {
        platformKey: "beta",
        runCycle() {
          betaCalls += 1;
          return new Promise<never>(() => undefined);
        },
        runRecoveryCycle() { return Promise.resolve(); },
      },
    ],
    manifestLane: { runCycle() { return Promise.resolve(); } },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
  });

  const completion = await Promise.race([
    runtime.start().then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), 100);
    }),
  ]);

  assert.equal(completion.kind, "rejected");
  if (completion.kind === "rejected") assert.equal(completion.error, refusal);
  assert.equal(alphaCalls, 1);
  assert.equal(betaCalls, 1);
});

test("unproven active-state reconciliation exits fatally without retry", async () => {
  const refusal = Object.assign(new Error("active state proof diverged"), {
    code: "PROMOTION_V2_ACTIVE_STATE_UNPROVEN",
  });
  let providerCalls = 0;
  let manifestCalls = 0;
  let sleeps = 0;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { return Promise.resolve(); } },
    providerLanes: [{
      platformKey: "alpha",
      runCycle() {
        providerCalls += 1;
        return new Promise<never>(() => undefined);
      },
      runRecoveryCycle() { return Promise.resolve(); },
    }],
    manifestLane: {
      runCycle() {
        manifestCalls += 1;
        throw refusal;
      },
    },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
    sleeper: {
      sleep() {
        sleeps += 1;
        return Promise.resolve();
      },
    },
  });

  const completion = await Promise.race([
    runtime.start().then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), 100);
    }),
  ]);

  assert.equal(completion.kind, "rejected");
  if (completion.kind === "rejected") assert.equal(completion.error, refusal);
  assert.equal(providerCalls, 1);
  assert.equal(manifestCalls, 1);
  assert.equal(sleeps, 0);
});

test("bootstrap network and concurrent state conflicts re-probe before claims", async () => {
  let bootstrapCalls = 0;
  let laneCalls = 0;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() {},
    bootstrap: {
      ensureVerified() {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) throw new Error("temporary network failure");
        if (bootstrapCalls === 2) {
          throw Object.assign(new Error("concurrent proof advanced"), {
            code: "PROMOTION_V2_STATE_CONFLICT",
          });
        }
        return Promise.resolve();
      },
    },
    providerLanes: [{
      platformKey: "alpha",
      runCycle() { laneCalls += 1; runtime.stop(); return Promise.resolve(); },
      runRecoveryCycle() { return Promise.resolve(); },
    }],
    manifestLane: { runCycle() { return Promise.resolve(); } },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
    sleeper: { sleep() { return Promise.resolve(); } },
  });

  await runtime.start();
  assert.ok(bootstrapCalls >= 3);
  assert.equal(laneCalls, 1);
});

test("a transient eligibility read is retried before bootstrap or claims", async () => {
  let eligibilityCalls = 0;
  let bootstrapCalls = 0;
  let laneCalls = 0;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: {
      getSnapshot() {
        eligibilityCalls += 1;
        if (eligibilityCalls === 1) throw new Error("temporary database failure");
        return Promise.resolve(snapshot(["alpha"]));
      },
    },
    validateEligibility() {},
    bootstrap: {
      ensureVerified() { bootstrapCalls += 1; return Promise.resolve(); },
    },
    providerLanes: [{
      platformKey: "alpha",
      runCycle() { laneCalls += 1; runtime.stop(); return Promise.resolve(); },
      runRecoveryCycle() { return Promise.resolve(); },
    }],
    manifestLane: { runCycle() { return Promise.resolve(); } },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
    sleeper: { sleep() { return Promise.resolve(); } },
  });

  await runtime.start();
  assert.equal(eligibilityCalls, 4);
  assert.ok(bootstrapCalls >= 1);
  assert.equal(laneCalls, 1);
});

test("stop aborts the bounded sleep after a retryable bootstrap failure", async () => {
  let sleepStarted!: () => void;
  const sleeping = new Promise<void>((resolve) => { sleepStarted = resolve; });
  let laneCalls = 0;
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { throw new Error("temporary failure"); } },
    providerLanes: [{
      platformKey: "alpha",
      runCycle() { laneCalls += 1; return Promise.resolve(); },
      runRecoveryCycle() { return Promise.resolve(); },
    }],
    manifestLane: { runCycle() { return Promise.resolve(); } },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
    sleeper: {
      sleep(_milliseconds, signal) {
        sleepStarted();
        return new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  });

  const running = runtime.start();
  await sleeping;
  runtime.stop();
  await running;
  assert.equal(laneCalls, 0);
});

test("an unproven local bootstrap graph refuses startup without claims", async () => {
  let laneCalls = 0;
  const mismatch = Object.assign(new Error("safe refusal"), {
    code: "PROMOTION_V2_BOOTSTRAP_UNPROVEN",
  });
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { throw mismatch; } },
    providerLanes: [{
      platformKey: "alpha",
      runCycle() { laneCalls += 1; return Promise.resolve(); },
      runRecoveryCycle() { return Promise.resolve(); },
    }],
    manifestLane: { runCycle() { return Promise.resolve(); } },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
    sleeper: { sleep() { throw new Error("must not retry"); } },
  });

  await assert.rejects(runtime.start(), (error) => error === mismatch);
  assert.equal(laneCalls, 0);
});

test("corrupt persisted bootstrap receipt refuses startup without retry", async () => {
  let sleeps = 0;
  const corruption = Object.assign(new Error("safe refusal"), {
    code: "PROMOTION_V2_BOOTSTRAP_UNPROVEN",
  });
  const runtime = new PromotionV2WorkerRuntime({
    workerId: "promotion-worker",
    eligibility: { getSnapshot: () => Promise.resolve(snapshot(["alpha"])) },
    validateEligibility() {},
    bootstrap: { ensureVerified() { throw corruption; } },
    providerLanes: [],
    manifestLane: { runCycle() { throw new Error("must not claim"); } },
    pollIntervalMilliseconds: 100,
    clock: { now: () => now },
    logger: { write() {} },
    sleeper: { sleep() { sleeps += 1; return Promise.resolve(); } },
  });

  await assert.rejects(runtime.start(), (error) => error === corruption);
  assert.equal(sleeps, 0);
});
