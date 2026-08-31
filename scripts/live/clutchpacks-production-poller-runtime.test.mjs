import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { fixture, publisherModule, policyHashKey } from "./clutchpacks-production-poller-fixture.mjs";
const { runClutchpacksProductionPollerCli: cli } = await tsImport("./run-clutchpacks-production-poller.mts", import.meta.url);
const { readClutchpacksProductionPollerSettings: read } = await tsImport("./clutchpacks-production-poller-policy.mts", import.meta.url);
const { createClutchpacksProductionPostHead: registration } = await tsImport("./clutchpacks-production-poller-runtime.mts", import.meta.url);
function output() { const results = [], errors = []; return { results, errors,
  result: value => results.push(value), error: value => errors.push(value) }; }

test("check-only supplies the exact pinned callback without importing publisher or creating artifacts", async t => {
  const f = await fixture(t), out = output(), controller = new AbortController(); let imports = 0, calls = 0;
  assert.equal(await cli(f.args("--check-only"), controller.signal, out, { environment: f.environment, moduleRoot: f.resident,
    loadPublisher: async () => { imports++; assert.fail("Check-only cannot import publisher code."); },
    run: async (args, signal, lifecycle) => {
      calls++; assert.equal(args.mode, "--check-only"); assert.equal(args.bootstrapBackfill, false);
      assert.deepEqual(args.pins, f.pins); assert.deepEqual(args.cadence, f.policy.cadence); assert.equal(signal, controller.signal);
      assert.equal(lifecycle.postHead.policyFingerprint, f.environment[policyHashKey]);
      assert.equal(lifecycle.postHead.timeoutMilliseconds, f.policy.timeoutMilliseconds);
      await assert.rejects(lifecycle.postHead.run(f.head, signal), /CHECK_ONLY/);
      return "checked";
    } }), 0);
  assert.equal(calls, 1); assert.equal(imports, 0); assert.deepEqual(out.errors, []);
  await assert.rejects(readFile(f.policy.artifactDirectory), { code: "ENOENT" });
});
test("native argv must match ClutchPacks head-only minute policy and all startup failures are sanitized", async t => {
  const f = await fixture(t);
  const cases = [f.args().slice(0, -2), [...f.args().slice(0, -1), "120"], [...f.args(), "--bootstrap-backfill"],
    f.args().map(value => value === "clutchpacks" ? "courtyard" : value),
    f.args().map(value => value === f.pins.operationId ? f.pins.initialRunId : value), [...f.args(), "--unsafe-reset"]];
  for (const args of cases) {
    const out = output(); assert.equal(await cli(args, new AbortController().signal, out, {
      environment: f.environment, moduleRoot: f.resident, run: async () => assert.fail("Unsupported scope must not reach runner.") }), 1);
    assert.equal(out.errors[0].outcome, "blocked"); assert.deepEqual(out.results, []);
  }
  for (const environment of [{ NODE_ENV: "development" }, { ...f.environment, NODE_ENV: "production" },
    { ...f.environment, PACKSCOUT_CENTRAL_DATABASE_URL: "postgresql://synthetic-never-log-this" }]) {
    const out = output(); assert.equal(await cli([...f.args(), "--launchd"], new AbortController().signal, out, {
      environment, moduleRoot: f.resident, run: async () => assert.fail() }), 0, "Known launchd startup refusal does not spin.");
    assert.equal(out.errors[0].outcome, "blocked"); assert.equal(JSON.stringify(out).includes("synthetic-never-log-this"), false);
  }
});
test("publisher receives exact frozen head, hashes, commits, timeout and abort signal through one awaited call", async t => {
  const f = await fixture(t), settings = await read(f.environment, f.resident), controller = new AbortController();
  let imported = 0, invoked = 0, release, signalInvocation;
  const pending = new Promise(resolve => { release = resolve; }), invocation = new Promise(resolve => { signalInvocation = resolve; });
  const hook = registration(settings, f.resident, false, async specifier => {
    imported++; assert.equal(specifier, pathToFileURL(path.join(f.publisher, publisherModule)).href);
    return { publishClutchpacksProductionPostHead: async options => {
      invoked++; assert.deepEqual(options, { head: f.head, baseSourceConfig: f.policy.baseSourceConfig,
        artifactDirectory: f.policy.artifactDirectory, publisherWorktree: f.publisher, expectedPublisherCommit: f.policy.publisher.commit,
        expectedResidentAuthorityDigest: f.policy.expectedResidentAuthorityDigest, timeoutMs: f.policy.timeoutMilliseconds,
        signal: controller.signal });
      assert.equal(options.head, f.head); assert.ok(Object.isFrozen(options.baseSourceConfig));
      signalInvocation(); await pending; return { status: "verified", syntheticEvidence: true };
    } };
  }, f.environment);
  assert.equal(hook.policyFingerprint, f.environment[policyHashKey]); let settled = false;
  const running = hook.run(f.head, controller.signal).then(() => { settled = true; });
  await Promise.race([invocation, running]);
  assert.equal(settled, false); release(); await running; assert.equal(imported, 1); assert.equal(invoked, 1);
});
test("callback rejects unknown outcomes, thrown errors, wrong authority and cancellation without exposing private detail", async t => {
  const f = await fixture(t), settings = await read(f.environment, f.resident);
  for (const result of [undefined, null, { status: "prepared" }, { status: "unknown" }]) {
    const hook = registration(settings, f.resident, false, async () => ({ publishClutchpacksProductionPostHead: async () => result }), f.environment);
    await assert.rejects(hook.run(f.head, new AbortController().signal), /PUBLICATION_UNVERIFIED/);
  }
  const failing = registration(settings, f.resident, false, async () => ({ publishClutchpacksProductionPostHead: async () => {
    throw new Error("synthetic secret never-log-this"); } }), f.environment);
  await assert.rejects(failing.run(f.head, new AbortController().signal), error =>
    error.code === "CONTINUOUS_CLUTCHPACKS_PUBLICATION_FAILED" && !error.message.includes("never-log-this"));
  const controller = new AbortController(); let imports = 0;
  const hook = registration(settings, f.resident, false, async () => { imports++; assert.fail(); }, f.environment);
  await assert.rejects(hook.run({ ...f.head, authorityDigest: "e".repeat(64) }, controller.signal), /HEAD_CHANGED/);
  controller.abort(); await assert.rejects(hook.run(f.head, controller.signal), /ABORTED/); assert.equal(imports, 0);
});
test("callback abort is forwarded and a late verified result never becomes success", async t => {
  const f = await fixture(t), settings = await read(f.environment, f.resident), controller = new AbortController(); let aborted = false;
  const hook = registration(settings, f.resident, false, async () => ({ publishClutchpacksProductionPostHead: async options => {
    options.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    controller.abort(); return { status: "verified" };
  } }), f.environment);
  await assert.rejects(hook.run(f.head, controller.signal), /ABORTED/); assert.equal(aborted, true);
});
test("source admission and callback both revalidate ignored environment before any new work", async t => {
  const f = await fixture(t), out = output(), signal = new AbortController().signal; let imported = 0;
  assert.equal(await cli(f.args(), signal, out, { environment: f.environment, moduleRoot: f.resident,
    loadPublisher: async () => { imported++; assert.fail(); }, run: async (_args, _signal, lifecycle) => {
      await lifecycle.beforeSource(signal);
      await writeFile(path.join(f.resident, ".env"), "PACKSCOUT_DATABASE_MODE=changed\n");
      await assert.rejects(lifecycle.beforeSource(signal), /DEPLOYMENT_CHANGED/);
      await assert.rejects(lifecycle.postHead.run(f.head, signal), /DEPLOYMENT_CHANGED/);
      return "stopped";
    } }), 0);
  assert.equal(imported, 0);
});
