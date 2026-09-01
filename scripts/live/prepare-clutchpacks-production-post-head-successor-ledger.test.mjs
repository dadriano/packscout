import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
const { clutchpacksProductionPostHeadSuccessorPreparerTestHarness: harness } =
  await import("./prepare-clutchpacks-production-post-head-successor-ledger.mjs");
assert.ok(harness);
const fixedHash = "1".repeat(64), fixedCommit = "2".repeat(40);

function runtime(overrides = {}) {
  const settings = harness.settings;
  return { argv: [settings.node, settings.preparer, "--executor-commit", fixedCommit,
    "--launcher-sha256", fixedHash, "--preparer-sha256", fixedHash, "--created-at", "2026-09-01T07:00:00.000Z"],
  execArgv: [], environment: { ...harness.environment }, execPath: settings.node, cwd: settings.executor,
  modulePath: settings.preparer, ...overrides };
}

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "clutch-c533-preparer-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const ledger = path.join(parent, "ledger"), records = path.join(ledger, "records");
  const reservedPaths = [path.join(parent, "artifact-1"), path.join(parent, "proof-1"),
    path.join(parent, "artifact-2"), path.join(parent, "proof-2")];
  const documents = { "incident-manifest.json": Buffer.from("manifest\n"),
    "executor-policy.json": Buffer.from("executor\n"), "launch-policy.json": Buffer.from("launch\n") };
  return { parent, ledger, records, reservedPaths, documents };
}

test("offline ledger install is private, exclusive, and exactly idempotent", async t => {
  const f = await fixture(t);
  await harness.installLedger(f, f.documents); await harness.installLedger(f, f.documents);
  assert.equal((await stat(f.ledger)).mode & 0o777, 0o700);
  assert.equal((await stat(f.records)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(f.ledger)).sort(),
    ["executor-policy.json", "incident-manifest.json", "launch-policy.json", "records"]);
  assert.deepEqual(await readdir(f.records), []);
  for (const [name, bytes] of Object.entries(f.documents)) {
    assert.equal((await stat(path.join(f.ledger, name))).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(path.join(f.ledger, name)), bytes);
  }
});

test("a private crash orphan is removed, while mismatched installed evidence is never overwritten", async t => {
  const f = await fixture(t); await mkdir(f.ledger, { mode: 0o700 });
  await writeFile(path.join(f.ledger, `.clutchpacks-c533-prepare-${randomUUID()}.tmp`), "partial", { mode: 0o600 });
  await harness.installLedger(f, f.documents);
  await writeFile(path.join(f.ledger, "incident-manifest.json"), "tamper", { mode: 0o600 });
  const before = await readFile(path.join(f.ledger, "incident-manifest.json"));
  await assert.rejects(harness.installLedger(f, f.documents));
  assert.deepEqual(await readFile(path.join(f.ledger, "incident-manifest.json")), before);
});

test("an occupied reserved successor path refuses before the ledger is created", async t => {
  const f = await fixture(t); await mkdir(f.reservedPaths[0], { mode: 0o700 });
  await assert.rejects(harness.installLedger(f, f.documents));
  await assert.rejects(stat(f.ledger), error => error.code === "ENOENT");
});

test("preparer requires the exact direct-Node execution boundary and four-key environment", () => {
  assert.deepEqual(harness.parseRuntime(runtime()), { executorCommit: fixedCommit, launcherSha256: fixedHash,
    preparerSha256: fixedHash, createdAt: "2026-09-01T07:00:00.000Z" });
  for (const changed of [
    { environment: { ...harness.environment, NODE_OPTIONS: "--import=/tmp/hook.mjs" } },
    { execArgv: ["--import", "/tmp/hook.mjs"] }, { execPath: "/usr/bin/node" }, { cwd: "/tmp" },
    { modulePath: "/tmp/preparer.mjs" },
  ]) assert.throws(() => harness.parseRuntime(runtime(changed)));
});

test("preparer refuses an unreviewed self hash and runtime-inventory module before importing it", async () => {
  await assert.rejects(harness.verifySelfPin(fixedHash));
  await assert.rejects(harness.loadRuntimeInventoryReader({ path: harness.settings.preparer, sha256: fixedHash }));
});

test("preparer creates an initially absent private TMPDIR before loader work", async t => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "clutch-c533-preparer-tmp-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, "sealed-tmp");
  await harness.ensurePrivateDirectory(directory, true);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(await realpath(directory), directory);
});
