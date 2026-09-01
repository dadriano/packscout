import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const policy = await tsImport("./provider-backfill-supervisor-policy.mts", import.meta.url);
const { superviseProviderBackfill } = await tsImport("./provider-backfill-supervisor.mts", import.meta.url);
const { parseBackfillArguments } = await tsImport("./run-provider-backfill-supervisor.mts", import.meta.url);
const { readBackfillEnvironment } = await tsImport("./provider-backfill-supervisor-authority.mts", import.meta.url);
const pins = { organizationId: "04f5b7bb-0b83-44eb-aef5-103f9b92d281", providerId: "04f5b7bb-0b83-44eb-aef5-103f9b92d282",
  providerKey: "phygitals", configId: "04f5b7bb-0b83-44eb-aef5-103f9b92d283",
  initialRunId: "04f5b7bb-0b83-44eb-aef5-103f9b92d284", operationId: "04f5b7bb-0b83-44eb-aef5-103f9b92d285",
  operatorId: "04f5b7bb-0b83-44eb-aef5-103f9b92d286" };
function snapshot() {
  return { now: new Date("2026-08-30T05:00:00Z"), providerId: pins.providerId, providerKey: pins.providerKey,
    configId: pins.configId, configNumber: 4n, configurationMatches: true, state: "error", generation: 2n,
    checkpointHash: "a".repeat(64), checkpointValid: true, activeRunIds: [], actionableCommands: [],
    lease: { owner: null, fence: 1n, expiresAt: null },
    run: { id: pins.initialRunId, configId: pins.configId, configNumber: 4n, state: "failed", fence: 1n,
      requestedHash: "b".repeat(64), requestedMatches: true, finalHash: "a".repeat(64), finalMatches: true,
      reachedHead: false, pageCount: 100, committedPageCount: 100, accepted: 10000,
      failureCode: "PROVIDER_DATAFORREST_REQUEST_TIMEOUT", finishedAt: new Date("2026-08-30T04:59:00Z") },
    lastPage: { number: 100, continuation: "more", hash: "a".repeat(64), matches: true } };
}
function intent(s = snapshot(), previous = null) {
  return policy.createBackfillIntent({ pins, authorityDigest: "c".repeat(64), snapshot: s, previous, jitter: 0 });
}

test("only explicit transport/rate/server and settled expired-query failures automatically retry", () => {
  for (const code of policy.transientBackfillCodes) {
    const s = snapshot(); s.run.failureCode = code;
    assert.equal(policy.classifyBackfillCheckpoint(s), "transient_retry");
  }
  for (const suffix of ["INVALID_RESPONSE", "RESPONSE_TOO_LARGE", "INVALID_CURSOR", "CANCELLED", "TLS_FAILED", "AUTHENTICATION_FAILED", "UNKNOWN"]) {
    const s = snapshot(); s.run.failureCode = `PROVIDER_DATAFORREST_${suffix}`;
    assert.throws(() => policy.classifyBackfillCheckpoint(s), /BACKFILL_PERMANENT_FAILURE/);
  }
});
test("settled database query expiry resumes only the exact saved checkpoint with durable backoff", () => {
  const s = snapshot(); s.run.failureCode = "PROVIDER_IMPORT_DATABASE_TRANSACTION_EXPIRED";
  assert.equal(policy.classifyBackfillCheckpoint(s), "transient_retry");
  const first = intent(s);
  assert.equal(first.checkpointHash, s.checkpointHash); assert.equal(first.parentRunId, s.run.id);
  assert.equal(first.configNumber, "4"); assert.equal(first.generation, "2");
  assert.equal(Date.parse(first.notBefore) - s.now.getTime(), 5000);
  const next = intent(s, first); assert.equal(next.consecutiveNoProgress, 2);
  assert.equal(next.checkpointHash, s.checkpointHash); assert.equal(Date.parse(next.notBefore) - s.now.getTime(), 10000);
  for (const code of ["P2028", "PROVIDER_IMPORT_EXECUTION_FAILED", "PROVIDER_IMPORT_INVALID_CURSOR",
    "PROVIDER_IMPORT_DATABASE_TRANSACTION_FAILED", "PROVIDER_DATAFORREST_INVALID_RESPONSE"]) {
    const failed = structuredClone(s); failed.run.failureCode = code;
    assert.throws(() => policy.classifyBackfillCheckpoint(failed), /BACKFILL_PERMANENT_FAILURE/);
  }
  for (const mutate of [v => v.checkpointHash = null, v => v.run.finalMatches = false,
    v => v.activeRunIds.push(pins.operatorId), v => v.lastPage.hash = "c".repeat(64)]) {
    const invalid = structuredClone(s); mutate(invalid);
    assert.throws(() => policy.classifyBackfillCheckpoint(invalid), /BACKFILL_TERMINAL_CHECKPOINT_UNSAFE/);
  }
});

test("saved-cursor retry rejects cursor corruption, origin reset, configuration changes and active work", () => {
  for (const mutate of [s => s.configId = pins.operationId, s => s.configNumber = 5n,
    s => s.providerId = pins.operationId, s => s.configurationMatches = false,
    s => s.checkpointValid = false, s => s.run.requestedMatches = false]) {
    const s = snapshot(); mutate(s);
    assert.throws(() => policy.assertBackfillPins(s, pins, 4n), /BACKFILL_CONFIGURATION_OR_CHECKPOINT_DRIFT/);
  }
  for (const mutate of [s => s.checkpointHash = null, s => s.run.finalMatches = false,
    s => s.lastPage.matches = false, s => s.lastPage.number--, s => s.activeRunIds.push(pins.operationId),
    s => s.actionableCommands.push({ id: pins.operationId, runId: null }), s => s.run.requestedHash = s.checkpointHash]) {
    const s = snapshot(); mutate(s);
    assert.throws(() => policy.classifyBackfillCheckpoint(s), /BACKFILL_TERMINAL_CHECKPOINT_UNSAFE/);
  }
});

test("only exact durable 50k continuation advances; generic step bound and no-progress cycles fail closed", () => {
  const s = snapshot(); s.run.failureCode = "PROVIDER_IMPORT_PAGE_LIMIT_EXCEEDED";
  s.run.pageCount = 50000; s.run.committedPageCount = 50000; s.lastPage.number = 50000;
  assert.equal(policy.classifyBackfillCheckpoint(s), "page_bound_continuation");
  for (const mutate of [x => x.run.pageCount--, x => x.run.committedPageCount--,
    x => x.lastPage.continuation = "head", x => x.run.requestedHash = x.checkpointHash,
    x => x.run.failureCode = "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED"]) {
    const changed = structuredClone(s); mutate(changed); assert.throws(() => policy.classifyBackfillCheckpoint(changed));
  }
});

test("zero-page timeout retries the unchanged saved checkpoint; bounded run with pages must advance", () => {
  const s = snapshot(); s.run.pageCount = 0; s.run.committedPageCount = 0; s.lastPage = null;
  s.run.requestedHash = s.checkpointHash;
  assert.equal(policy.classifyBackfillCheckpoint(s), "transient_retry");
});

test("lease policy refuses every live owner and foreign expired ownership, accepting only exact expired execution evidence", () => {
  const s = snapshot(); policy.assertBackfillLeaseAvailable(s, new Set());
  s.lease = { owner: "own", fence: 2n, expiresAt: new Date(s.now.getTime() + 1) };
  assert.throws(() => policy.assertBackfillLeaseAvailable(s, new Set(["own"])), /LEASE_UNAVAILABLE/);
  s.lease.expiresAt = new Date(s.now.getTime() - 1);
  assert.throws(() => policy.assertBackfillLeaseAvailable(s, new Set()), /LEASE_UNAVAILABLE/);
  policy.assertBackfillLeaseAvailable(s, new Set(["own"]));
});

test("durable jitter is positive and capped even after prolonged no progress; no retry count abandons the backfill", () => {
  assert.equal(policy.backfillDelayMilliseconds(1, 0), 5000);
  assert.equal(policy.backfillDelayMilliseconds(2, 0), 10000);
  assert.equal(policy.backfillDelayMilliseconds(1000, 0), 150000);
  assert.ok(policy.backfillDelayMilliseconds(100000, .999999) < 300000);
  for (const invalid of [-1, 1, Number.NaN]) assert.throws(() => policy.backfillDelayMilliseconds(1, invalid));
  const previous = intent(); previous.consecutiveNoProgress = 999; previous.retryNumber = 999;
  const next = intent(snapshot(), previous);
  assert.equal(next.consecutiveNoProgress, 1000); assert.equal(next.retryNumber, 1000);
  assert.equal(Date.parse(next.notBefore) - Date.parse(next.createdAt), 150000);
  assert.equal(policy.backfillDigest({ b: 1, a: 2 }), policy.backfillDigest({ a: 2, b: 1 }));
});

test("supervisor persists before waiting/executing, keeps retrying no-progress failures and exits at durable head", async () => {
  let s = snapshot(); let saved = null; let pending = false; let executions = 0;
  const events = []; const order = [];
  const result = await superviseProviderBackfill({ pins,
    async read() { return { snapshot: s, intent: saved, pendingRetry: pending }; },
    async persistRetry() { order.push("persist"); saved = intent(s, saved); pending = true; },
    async wait(ms) { order.push("wait"); assert.ok(ms > 0 && ms <= 15000); s.now = new Date(s.now.getTime() + ms); },
    async execute() {
      order.push("execute"); executions++; pending = false;
      assert.ok(s.now >= new Date(saved.notBefore)); s.run.id = saved.runId;
      if (executions < 12) {
        s.run.pageCount = 0; s.run.committedPageCount = 0; s.run.requestedHash = s.checkpointHash;
        s.lastPage = null; s.generation += 2n;
      } else {
        s.run.state = "succeeded"; s.run.reachedHead = true; s.run.failureCode = null;
        s.state = "idle"; s.run.pageCount = 1; s.lastPage = { number: 1, continuation: "head", hash: s.checkpointHash, matches: true };
      }
    }, emit: e => events.push(e),
  }, new AbortController().signal);
  assert.equal(result, "head"); assert.equal(executions, 12);
  assert.deepEqual(order.slice(0, 3), ["persist", "wait", "execute"]);
  assert.ok(events.some(e => e.event === "backfill_no_progress_alert"));
});

test("operator pause during durable backoff stops without resuming or launching", async () => {
  const s = snapshot(); const saved = intent(s); let executed = false;
  const result = await superviseProviderBackfill({ pins,
    async read() { return { snapshot: s, intent: saved, pendingRetry: true }; },
    async persistRetry() { assert.fail(); }, async execute() { executed = true; },
    async wait() { s.state = "paused"; }, emit() {},
  }, new AbortController().signal);
  assert.equal(result, "operator_stop"); assert.equal(executed, false);
});

test("unknown child exit is not normalized into a retry and returned metadata never leaks unsafe failure text", async () => {
  const s = snapshot(); s.state = "idle"; s.run.state = "queued"; s.run.requestedHash = s.checkpointHash;
  s.activeRunIds = [s.run.id]; s.run.failureCode = "Bearer protected-secret";
  const events = [];
  await assert.rejects(superviseProviderBackfill({ pins,
    async read() { return { snapshot: s, intent: null, pendingRetry: false }; },
    async persistRetry() { assert.fail(); }, async execute() {}, async wait() { assert.fail(); }, emit: e => events.push(e),
  }, new AbortController().signal), /BACKFILL_WORKER_EXIT_WITHOUT_TERMINAL_RESULT/);
  assert.equal(JSON.stringify(events).includes("protected-secret"), false);
  assert.equal(policy.safeBackfillFailureCode("secret\nvalue"), "BACKFILL_UNKNOWN_FAILURE");
});

test("closed-child proof retries via existing active run after backoff, without any source-retry queue", async () => {
  const s = snapshot(); s.state = "idle"; s.run.state = "queued"; s.run.pageCount = 0;
  s.run.requestedHash = s.checkpointHash; s.activeRunIds = [s.run.id];
  let restart = null; let executes = 0; let waits = 0;
  const result = await superviseProviderBackfill({ pins,
    async read() { return { snapshot: s, intent: null, pendingRetry: false, restart }; },
    async persistRetry() { assert.fail("Closed child must not create a new run command."); },
    async execute() {
      executes++;
      if (executes === 1) restart = { kind: "closed_child_restart", runId: s.run.id, owner: "test", fence: "2",
        generation: "2", state: "queued", authorityDigest: "d".repeat(64), checkpointHash: s.checkpointHash,
        consecutiveNoProgress: 1, notBefore: new Date(s.now.getTime() + 5000).toISOString() };
      else { s.run.state = "succeeded"; s.run.reachedHead = true; s.run.pageCount = 100;
        s.lastPage.continuation = "head"; s.activeRunIds = []; s.run.failureCode = null; }
    },
    async wait(ms) { waits++; s.now = new Date(s.now.getTime() + ms); }, emit() {},
  }, new AbortController().signal);
  assert.equal(result, "head"); assert.equal(executes, 2); assert.equal(waits, 1);
});

test("process signal after launch exits without restart and source head cannot mask foreign active work", async () => {
  const s = snapshot(); s.state = "idle"; s.run.state = "queued"; s.run.requestedHash = s.checkpointHash;
  s.activeRunIds = [s.run.id]; const stop = new AbortController();
  assert.equal(await superviseProviderBackfill({ pins,
    async read() { return { snapshot: s, intent: null, pendingRetry: false }; },
    async persistRetry() { assert.fail(); }, async execute() { stop.abort(); }, async wait() { assert.fail(); }, emit() {},
  }, stop.signal), "operator_stop");
  s.run.state = "succeeded"; s.run.reachedHead = true; s.lastPage.continuation = "head";
  assert.throws(() => policy.classifyBackfillCheckpoint(s));
});

test("direct child SIGTERM/SIGINT disposition stops supervisor without automatic restart", async () => {
  const s = snapshot(); s.state = "idle"; s.run.state = "queued"; s.run.requestedHash = s.checkpointHash;
  s.activeRunIds = [s.run.id];
  assert.equal(await superviseProviderBackfill({ pins,
    async read() { return { snapshot: s, intent: null, pendingRetry: false }; },
    async persistRetry() { assert.fail(); }, async execute() { return "operator_stop"; },
    async wait() { assert.fail(); }, emit() {},
  }, new AbortController().signal), "operator_stop");
});

test("CLI is import-side-effect-free and requires one exact installed provider scope", async () => {
  const keys = ["--organization-id", "organizationId", "--provider-id", "providerId", "--provider-key", "providerKey",
    "--config-id", "configId", "--initial-run-id", "initialRunId", "--operation-id", "operationId", "--operator-id", "operatorId"];
  const args = ["--check-only"];
  for (let i = 0; i < keys.length; i += 2) args.push(keys[i], pins[keys[i + 1]]);
  assert.deepEqual(parseBackfillArguments(args).pins, pins);
  const clutch = [...args]; clutch[6] = "clutchpacks";
  assert.equal(parseBackfillArguments(clutch).pins.providerKey, "clutchpacks");
  const invalid = [...args]; invalid[6] = "unknown-provider";
  assert.throws(() => parseBackfillArguments(invalid), /ARGUMENTS_INVALID/);
  assert.throws(() => parseBackfillArguments([...args, "--lanes", "2"]), /ARGUMENTS_INVALID/);
  const env = await readBackfillEnvironment({ NODE_ENV: "development",
    PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://test:test@127.0.0.1:55431/packscout",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 1).toString("base64"),
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: "1", PACKSCOUT_PROVIDER_DATABASE_URL: "must-not-be-used",
    DATAFORREST_BEARER_TOKEN: "must-not-be-forwarded" }, {});
  assert.equal(env.workerEnvironment.PACKSCOUT_PROVIDER_DATABASE_URL, undefined);
  assert.equal(env.workerEnvironment.DATAFORREST_BEARER_TOKEN, undefined);
  for (const url of ["postgresql://test:test@127.0.0.1:5432/packscout", "postgresql://test:test@127.0.0.1/packscout",
    "postgresql://test:test@127.0.0.1:55431/packscout_other"]) {
    await assert.rejects(readBackfillEnvironment({ NODE_ENV: "development",
      PACKSCOUT_CENTRAL_DATABASE_URL: url }, {}), /LOCAL_CENTRAL_REQUIRED/);
  }
  await assert.rejects(readBackfillEnvironment({ NODE_ENV: "production" }, {}), /LOCAL_SINGLE_PROVIDER_REQUIRED/);
  await assert.rejects(readBackfillEnvironment({ NODE_ENV: "development", PACKSCOUT_PROVIDER_LANES_JSON: "" }, {}), /LOCAL_SINGLE_PROVIDER_REQUIRED/);
});
