import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

process.env.NODE_ENV = "test";
const launcherPath = path.join(path.dirname(new URL(import.meta.url).pathname),
  "clutchpacks-production-post-head-successor-launcher.mjs");
const { clutchpacksProductionPostHeadSuccessorLauncherTestHarness: harness } = await import(launcherPath);
const { readClutchpacksProductionRuntimeInventory, clutchpacksProductionRuntimeInventoryTestHarness: inventoryHarness } =
  await import(new URL("./clutchpacks-production-runtime-inventory.mjs", import.meta.url));
const { clutchpacksProductionPostHeadSuccessorPreparerTestHarness: preparerHarness } =
  await import(new URL("./prepare-clutchpacks-production-post-head-successor-ledger.mjs", import.meta.url));
assert.ok(harness);
const settings = harness.productionSettings;
const fixedHash = "1".repeat(64), fixedCommit = "2".repeat(40);

function runtime(overrides = {}) {
  return {
    argv: [settings.node, settings.launcher, "--input", settings.launchPolicy, "--input-sha256", fixedHash,
      "--manifest", settings.manifest, "--manifest-sha256", fixedHash,
      "--launcher-sha256", fixedHash, "--executor-commit", fixedCommit],
    execArgv: [], environment: { ...settings.environment }, execPath: settings.node,
    cwd: settings.executorWorktree, launcherModulePath: settings.launcher, ...overrides,
  };
}
function refusal(promise) {
  return assert.rejects(promise, error => error?.message === "CLUTCHPACKS_C533_SUCCESSOR_LAUNCHER_REFUSED");
}

test("production entry refuses every extra or changed environment key before binding or importing", async () => {
  for (const environment of [{ ...settings.environment, EXTRA: "unexpected" },
    { ...settings.environment, PATH: "/usr/bin:/bin" }]) {
    const events = [];
    await refusal(harness.execute(runtime({ environment }), {
      acquireResidencyServer: async () => { events.push("bind"); },
      registerLoader: () => events.push("register"), loadRecovery: async () => { events.push("import"); },
    }));
    assert.deepEqual(events, []);
  }
});

test("production entry refuses inherited Node hooks before reading policy or importing code", async () => {
  const events = [];
  await refusal(harness.execute(runtime({ execArgv: ["--import", "/tmp/untrusted.mjs"] }), {
    acquireResidencyServer: async () => { events.push("bind"); }, registerLoader: () => events.push("register"),
    loadRecovery: async () => { events.push("import"); },
  }));
  assert.deepEqual(events, []);
});

test("sealed identities require the launcher and full publisher source-reader closure", () => {
  const pin = relative => ({ path: path.join(settings.executorWorktree, relative), sha256: fixedHash });
  const executor = { worktree: settings.executorWorktree, commit: fixedCommit,
    modules: Object.fromEntries(Object.entries(harness.executorModules).map(([name, relative]) => [name, pin(relative)])) };
  assert.equal(harness.validateIdentity(executor, settings.executorWorktree, fixedCommit, harness.executorModules), executor);
  const missingLauncher = structuredClone(executor); delete missingLauncher.modules.launcher;
  assert.throws(() => harness.validateIdentity(missingLauncher, settings.executorWorktree, fixedCommit, harness.executorModules));
  assert.deepEqual(Object.keys(harness.publisherModules).sort(), ["convexRuntime", "genericPublisher", "promoteCli",
    "publicationOrchestrator", "publicationPolicy", "servicesIndex", "sourceReader"].sort());
});

test("launcher and preparer share one canonical runtime inventory for publisher, executor, and source", async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "packscout-inventory-cross-consumer-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const locations = {};
  for (const name of ["publisher", "executor", "source"]) {
    const allowedTargetRoot = path.join(directory, name), root = path.join(allowedTargetRoot, "node_modules");
    await mkdir(path.join(root, "package"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, "package", "index.mjs"), `export const consumer = ${JSON.stringify(name)};\n`,
      { mode: 0o600 });
    locations[name] = { root, allowedTargetRoot };
  }
  const inventoryModulePath = fileURLToPath(new URL("./clutchpacks-production-runtime-inventory.mjs", import.meta.url));
  const preparerReader = await preparerHarness.loadRuntimeInventoryReader({ path: inventoryModulePath,
    sha256: harness.sha256(await readFile(inventoryModulePath)) });
  const expected = Object.fromEntries(await Promise.all(Object.entries(locations).map(async ([name, location]) =>
    [name, await preparerReader(location.root, location.allowedTargetRoot)])));
  const verified = await harness.verifyRuntimeInventoryTriplet(
    readClutchpacksProductionRuntimeInventory, expected, locations);
  assert.deepEqual(verified, expected);
  assert.equal(inventoryHarness.canonicalEntry({ z: 1, a: "utf8-✓" }).toString("utf8"),
    '{"a":"utf8-✓","z":1}\n');

  for (const name of ["publisher", "executor", "source"]) {
    const mismatched = structuredClone(expected);
    mismatched[name].treeSha256 = fixedHash;
    await refusal(harness.verifyRuntimeInventoryTriplet(readClutchpacksProductionRuntimeInventory,
      mismatched, locations));
  }
  await writeFile(path.join(locations.publisher.root, "package", "unpinned-runtime.js"), "export default 1;\n",
    { mode: 0o600 });
  await refusal(harness.verifyRuntimeInventoryTriplet(readClutchpacksProductionRuntimeInventory, expected, locations));
});

test("production entry refuses any argv path substitution before loader registration", async () => {
  const value = runtime(); value.argv[3] = "/tmp/alternate-launch-policy.json";
  let registered = false;
  await refusal(harness.execute(value, { registerLoader: () => { registered = true; } }));
  assert.equal(registered, false);
});

test("launcher self SHA is proven before bind, loader registration, or recovery import", async () => {
  const events = [];
  await refusal(harness.execute(runtime(), {
    acquireResidencyServer: async () => { events.push("bind"); },
    registerLoader: () => events.push("register"), loadRecovery: async () => { events.push("import"); },
  }));
  assert.deepEqual(events, []);
  assert.notEqual(harness.sha256(await readFile(settings.launcher)), fixedHash);
});

test("private JSON proof rejects wrong raw SHA, non-0600 mode, and symlink paths", async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "packscout-launcher-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "policy.json"), bytes = Buffer.from('{"sealed":true}\n');
  await writeFile(file, bytes, { mode: 0o600 });
  await refusal(harness.privateJson(file, fixedHash));
  assert.deepEqual((await harness.privateJson(file, harness.sha256(bytes))).value, { sealed: true });
  await chmod(file, 0o640);
  await refusal(harness.privateJson(file, harness.sha256(bytes)));
  await chmod(file, 0o600);
  const link = path.join(directory, "policy-link.json"); await symlink(file, link);
  await refusal(harness.privateJson(link, harness.sha256(bytes)));
});

test("real ledger-layout proof reads the exact private records directory and document set", async t => {
  const ledger = await realpath(await mkdtemp(path.join(os.tmpdir(), "packscout-launcher-ledger-")));
  t.after(() => rm(ledger, { recursive: true, force: true }));
  await chmod(ledger, 0o700); await mkdir(path.join(ledger, "records"), { mode: 0o700 });
  for (const name of ["executor-policy.json", "incident-manifest.json", "launch-policy.json"])
    await writeFile(path.join(ledger, name), "{}\n", { mode: 0o600 });
  await harness.verifyLedgerLayout(ledger, path.join(ledger, "records"));
  await writeFile(path.join(ledger, "unexpected"), "x", { mode: 0o600 });
  await refusal(harness.verifyLedgerLayout(ledger, path.join(ledger, "records")));
});

test("residency port owner is closed when launchctl proof fails", async () => {
  const server = { listening: true }; let closes = 0, actions = 0;
  await assert.rejects(harness.withResidency({
    acquireResidencyServer: async () => server,
    inspectResidency: async () => { throw new Error("untrusted launchctl output"); },
    closeServer: async value => { assert.equal(value, server); value.listening = false; closes += 1; },
  }, async () => { actions += 1; }));
  assert.equal(closes, 1); assert.equal(actions, 0); assert.equal(server.listening, false);
});

test("residency port owner is closed when work after a successful bind fails", async () => {
  const server = { listening: true }; const events = [];
  await assert.rejects(harness.withResidency({
    acquireResidencyServer: async () => { events.push("bind"); return server; },
    inspectResidency: async () => { events.push("launchctl"); },
    closeServer: async () => { events.push("close"); server.listening = false; },
  }, async value => { assert.equal(value, server); events.push("proof-complete"); throw new Error("import refused"); }));
  assert.deepEqual(events, ["bind", "launchctl", "proof-complete", "close"]);
  assert.equal(server.listening, false);
});

test("mutation between initial proof and residency bind is refused by the under-lock reproof", async () => {
  const server = { listening: true }; const events = []; let changed = false, proofs = 0;
  await assert.rejects(harness.withRuntimeReproof({
    afterInitialRuntimeProof: () => { events.push("mutate"); changed = true; },
    acquireResidencyServer: async () => { events.push("bind"); return server; },
    inspectResidency: async () => { events.push("launchctl"); },
    closeServer: async () => { events.push("close"); server.listening = false; },
  }, async () => {
    proofs += 1; events.push(`proof:${proofs}`); if (changed) throw new Error("runtime changed");
    return { sealed: true };
  }, async () => { events.push("import"); }));
  assert.deepEqual(events, ["proof:1", "mutate", "bind", "launchctl", "proof:2", "close"]);
  assert.equal(server.listening, false);
});

test("direct CLI failures expose only the fixed refusal document", async () => {
  const run = promisify(execFile);
  await assert.rejects(run(settings.node, [settings.launcher], {
    cwd: settings.executorWorktree, env: { ...settings.environment }, timeout: 10_000, maxBuffer: 1024 * 1024,
  }), error => {
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, '{"status":"refused","code":"CLUTCHPACKS_C533_SUCCESSOR_LAUNCHER_REFUSED"}\n');
    assert.equal(error.code, 1); return true;
  });
});
