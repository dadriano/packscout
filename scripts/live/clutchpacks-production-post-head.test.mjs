import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { publishClutchpacksProductionPostHead: publish, clutchpacksProductionPostHeadSchema } =
  await tsImport("./clutchpacks-production-post-head.mts", import.meta.url);
const { CLUTCHPACKS_PRODUCTION_SCOPE: scope, CLUTCHPACKS_PRODUCTION_TARGET: target, productionPublicationSha256: digest } =
  await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);
const id = suffix => `11111111-1111-5111-8111-${suffix.padStart(12, "0")}`;
const rawHash = value => createHash("sha256").update(value).digest("hex");
const now = "2026-08-31T18:00:00.000Z";
const save = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
const read = async file => JSON.parse(await readFile(file, "utf8"));
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "packscout-post-head-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = path.join(directory, "worktree"); await mkdir(worktree, { mode: 0o700 });
  const pinned = { path: path.join(directory, "unused-private-input"), sha256: "f".repeat(64) };
  const config = { schemaVersion: "clutchpacks_production_source_config_v1", frozenEnvironment: pinned,
    centralHost: "central.us-west-2.aws.neon.tech", providerHost: "provider.us-west-2.aws.neon.tech",
    scope: { organizationId: scope.organizationId, providerId: scope.providerId, providerKey: "clutchpacks",
      operatorId: id("1"), configVersionId: scope.configId, configVersionNumber: "4" },
    expected: { routeDigest: "a".repeat(64), latestSucceededRunId: id("2"), checkpointHash: "b".repeat(64),
      stateGeneration: "2", runtimeRowVersion: "3" }, baseline: pinned, identityProof: pinned,
    namespaceUuid: id("3"), approvedPublicAssetOrigins: ["https://cdn.example.test"] };
  const basePath = path.join(directory, "source-config-base.json"); await save(basePath, config);
  const options = { head: { providerId: scope.providerId, configId: scope.configId, configNumber: "4", runId: id("4"),
    checkpointHash: "c".repeat(64), generation: "15", runtimeRowVersion: "41", headFinishedAt: now, authorityDigest: "d".repeat(64) },
    baseSourceConfig: { path: basePath, sha256: rawHash(await readFile(basePath)) },
    artifactDirectory: path.join(directory, "artifacts"), publisherWorktree: worktree, expectedPublisherCommit: "a".repeat(40),
    expectedResidentAuthorityDigest: "d".repeat(64), timeoutMs: 5_000 };
  const events = [], children = [], gitCalls = [];
  const controls = { qualityState: "degraded", dirty: false, wrongCommit: false, phaseFailure: null, receiptMutation: null,
    outputMutation: null, hang: false, terminated: false, outputBytes: 0, sourceHeadOverride: null, onSpawn: null };
  const makeBundle = sourceConfig => {
    const approvedConfiguration = { fixtureApprovedConfiguration: true }, plan = { manifest: { counts: { repacks: 17 } } };
    const intent = { schemaVersion: "clutchpacks_production_publication_v1", operationId: id("5"), target,
      scope, readAt: now, source: { runId: options.head.runId, checkpointHash: options.head.checkpointHash,
        stateGeneration: options.head.generation, promotionSequence: "65536", stabilityFingerprint: "e".repeat(64),
        lastHeadReachedAt: controls.sourceHeadOverride ?? options.head.headFinishedAt, qualityState: controls.qualityState, quarantineCount: 465 },
      approvedConfigurationSha256: digest(approvedConfiguration), candidate: { publicReleaseId: id("6"),
        releaseFingerprint: "8".repeat(64), planSha256: digest(plan) }, predecessor: { generation: 2,
        publicReleaseId: id("7"), releaseFingerprint: "9".repeat(64) } };
    const body = { schemaVersion: "clutchpacks_production_bundle_v1", sourceConfig, sourceConfigSha256: digest(sourceConfig),
      intent, approvedConfiguration, plan, productionInventory: { fixture: "inventory" }, productionInventorySha256: digest({ fixture: "inventory" }) };
    return { ...body, bundleSha256: digest(body) };
  };
  const deps = {
    async git(args, input) {
      gitCalls.push({ args, input });
      if (args[0] === "status") return controls.dirty ? " M scripts/live/promote-clutchpacks-production.mts\n" : "";
      if (args[0] === "ls-files") return "scripts/live/promote-clutchpacks-production.mts\n";
      return args[1] === "HEAD" ? `${controls.wrongCommit ? "b".repeat(40) : options.expectedPublisherCommit}\n` : `${worktree}\n`;
    },
    spawn(file, args, input) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
      children.push({ file, args, input, child }); const offset = args.findIndex(value => value === "--prepare" || value === "--publish");
      const [phase, first, second] = args.slice(offset); events.push(phase);
      setImmediate(async () => {
        try {
          controls.onSpawn?.();
          if (controls.hang) return;
          if (controls.outputBytes) { child.stdout.write(Buffer.alloc(controls.outputBytes)); return; }
          if (controls.phaseFailure === phase) { child.stderr.write("private-token-must-stay-private"); child.stdout.end(); child.stderr.end(); child.emit("close", 1); return; }
          let output;
          if (phase === "--prepare") {
            const bundle = makeBundle(await read(first)); await save(second, bundle);
            output = { status: "prepared", bundlePath: second, bundleSha256: bundle.bundleSha256,
              operationId: bundle.intent.operationId, publicReleaseId: bundle.intent.candidate.publicReleaseId,
              readAt: bundle.intent.readAt, qualityState: bundle.intent.source.qualityState, quarantineCount: bundle.intent.source.quarantineCount };
          } else {
            const bundle = await read(first), intent = bundle.intent, receiptPath = `${first}.receipt.${randomUUID()}.json`;
            const receipt = { schemaVersion: "clutchpacks_production_publication_receipt_v1", status: "verified",
              operationId: intent.operationId, intentSha256: digest(intent), target: intent.target, scope: intent.scope,
              readAt: intent.readAt, source: intent.source, candidate: intent.candidate,
              approvedConfigurationSha256: intent.approvedConfigurationSha256, generation: 3, verifiedAt: now,
              publicReadbackSha256: "7".repeat(64), repackCount: 17, publicationOutcome: "activated",
              observationReceiptDigest: "6".repeat(64), activateReceiptDigest: "5".repeat(64), bundleSha256: bundle.bundleSha256 };
            controls.receiptMutation?.(receipt); await save(receiptPath, receipt);
            output = { status: "verified", receiptPath, bundleSha256: bundle.bundleSha256, operationId: intent.operationId,
              publicReleaseId: intent.candidate.publicReleaseId, qualityState: intent.source.qualityState, quarantineCount: intent.source.quarantineCount };
          }
          controls.outputMutation?.(output, phase); child.stdout.write(JSON.stringify(output));
          child.stdout.end(); child.stderr.end(); child.emit("close", 0);
        } catch { child.stdout.end(); child.stderr.end(); child.emit("close", 1); }
      });
      return child;
    },
    kill(child, signal) {
      events.push(signal);
      setTimeout(() => { controls.terminated = true; child.stdout.end(); child.stderr.end(); child.emit("close", null); }, 35);
    },
  };
  return { directory, config, options, deps, events, children, controls, gitCalls };
}
const safelyBlocked = code => error => { assert.equal(error.code, code); assert.doesNotMatch(error.message, /token|secret|postgres/iu); return true; };

test("safe head prepares once, verifies bound receipt, and same-head reentry publishes the identical bundle", async t => {
  const f = await fixture(t); const result = await publish(f.options, f.deps);
  assert.equal(result.status, "verified"); assert.equal(result.generation, 3); assert.equal(result.headDigest, digest(f.options.head));
  assert.deepEqual(f.events, ["--prepare", "--publish"]);
  const runDirectory = path.join(f.options.artifactDirectory, f.options.head.runId);
  const savedConfig = await read(path.join(runDirectory, "source-config.json"));
  assert.deepEqual(savedConfig, { ...f.config, expected: { ...f.config.expected,
    latestSucceededRunId: f.options.head.runId, checkpointHash: f.options.head.checkpointHash,
    stateGeneration: f.options.head.generation, runtimeRowVersion: f.options.head.runtimeRowVersion } });
  const bundleBefore = await readFile(path.join(runDirectory, "bundle.json"));
  const again = await publish(f.options, f.deps);
  assert.equal(again.bundleSha256, result.bundleSha256); assert.deepEqual(f.events, ["--prepare", "--publish", "--publish"]);
  assert.deepEqual(await readFile(path.join(runDirectory, "bundle.json")), bundleBefore);
  assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
  for (const file of ["head.json", "source-config.json", "bundle.json", "verified.json"]) assert.equal((await stat(path.join(runDirectory, file))).mode & 0o777, 0o600);
  assert.equal((await stat(result.receiptPath)).mode & 0o777, 0o600);
  assert.ok(!(await readdir(f.options.artifactDirectory)).includes("pending"));
  for (const child of f.children) {
    assert.equal(child.file, process.execPath); assert.equal(child.input.env.NODE_ENV, "production");
    assert.ok(Object.keys(child.input.env).every(key => ["NODE_ENV", "PATH", "HOME", "TMPDIR", "SystemRoot"].includes(key)));
    assert.equal(child.args[2], path.join(f.options.publisherWorktree, "scripts/live/promote-clutchpacks-production.mts"));
  }
});
for (const [name, alter, code] of [
  ["changed provider scope", f => { f.options.head.providerId = id("99"); }, "POST_HEAD_SCOPE_CHANGED"],
  ["changed config scope", f => { f.options.head.configNumber = "5"; }, "POST_HEAD_SCOPE_CHANGED"],
  ["changed resident authority", f => { f.options.head.authorityDigest = "0".repeat(64); }, "POST_HEAD_SCOPE_CHANGED"],
  ["unpinned commit", f => { f.controls.wrongCommit = true; }, "POST_HEAD_CHECKOUT_INVALID"],
  ["dirty tracked checkout", f => { f.controls.dirty = true; }, "POST_HEAD_CHECKOUT_INVALID"],
  ["changed base file hash", f => { f.options.baseSourceConfig.sha256 = "0".repeat(64); }, "POST_HEAD_BASE_CHANGED"],
]) test(`${name} refuses before starting a child and blocks later heads`, async t => {
  const f = await fixture(t); alter(f); await assert.rejects(publish(f.options, f.deps), safelyBlocked(code));
  assert.equal(f.children.length, 0); f.options.head.runId = id("98");
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_PENDING_RECONCILIATION"));
});
test("numeric head fields must be exact decimal strings", () => {
  assert.equal(clutchpacksProductionPostHeadSchema.safeParse({ configNumber: 4n }).success, false);
});
test("failed prepare retains a blocked journal and never silently prepares another clock", async t => {
  const f = await fixture(t); f.controls.phaseFailure = "--prepare";
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_CHILD_FAILED"));
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_PENDING_RECONCILIATION"));
  assert.deepEqual(f.events, ["--prepare"]);
  const runDirectory = path.join(f.options.artifactDirectory, f.options.head.runId);
  const attempt = (await readdir(runDirectory)).find(name => name.startsWith("attempt-"));
  const log = path.join(runDirectory, attempt, "prepare.stderr");
  assert.equal(await readFile(log, "utf8"), "private-token-must-stay-private"); assert.equal((await stat(log)).mode & 0o777, 0o600);
});
for (const [name, mutate] of [
  ["wrong candidate", receipt => { receipt.candidate.publicReleaseId = id("99"); }],
  ["wrong public readback count", receipt => { receipt.repackCount = 1; }],
  ["wrong intent digest", receipt => { receipt.intentSha256 = "0".repeat(64); }],
  ["arbitrary private diagnostic", receipt => { receipt.diagnostic = "private-token"; }],
]) test(`a receipt with ${name} never reports verified`, async t => {
  const f = await fixture(t); f.controls.receiptMutation = mutate;
  await assert.rejects(publish(f.options, f.deps));
  assert.ok((await readdir(path.join(f.options.artifactDirectory, "pending"))).some(name => name.startsWith("blocked-")));
});
test("untrusted receipt paths cannot redirect private readback outside the head directory", async t => {
  const f = await fixture(t); f.controls.outputMutation = (output, phase) => { if (phase === "--publish") output.receiptPath = f.options.baseSourceConfig.path; };
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_RECEIPT_INVALID"));
});
test("a prepared bundle must bind the exact safe-head completion clock", async t => {
  const f = await fixture(t); f.controls.sourceHeadOverride = "2026-08-31T17:59:00.000Z";
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_BUNDLE_INVALID"));
  assert.deepEqual(f.events, ["--prepare"]);
});
test("abort waits for child termination and leaves durable blocked evidence", async t => {
  const f = await fixture(t); f.controls.hang = true; const controller = new AbortController();
  const promise = publish({ ...f.options, signal: controller.signal }, f.deps);
  while (!f.children.length) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(); await assert.rejects(promise, safelyBlocked("POST_HEAD_CHILD_FAILED"));
  assert.equal(f.controls.terminated, true); assert.ok(f.events.includes("SIGTERM"));
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_PENDING_RECONCILIATION"));
});
test("timeout also waits for termination instead of releasing the caller while a child runs", async t => {
  const f = await fixture(t); f.controls.hang = true;
  let expire;
  f.deps.startDeadline = (abort, milliseconds) => { assert.equal(milliseconds, 900_000); expire = abort; return () => {}; };
  f.controls.onSpawn = () => expire();
  await assert.rejects(publish({ ...f.options, timeoutMs: 900_000 }, f.deps), safelyBlocked("POST_HEAD_CHILD_FAILED"));
  assert.equal(f.controls.terminated, true);
});
test("an expired deadline before launch starts no process and retains the pending marker", async t => {
  const f = await fixture(t); f.deps.startDeadline = abort => { abort(); return () => {}; };
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_ABORTED"));
  assert.equal(f.children.length, 0); assert.ok((await readdir(f.options.artifactDirectory)).includes("pending"));
});
test("excess output is bounded, terminates the child, and cannot be accepted as success", async t => {
  const f = await fixture(t); f.controls.outputBytes = 1_048_577;
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_CHILD_FAILED")); assert.equal(f.controls.terminated, true);
});
test("a symlinked base config is refused without following it", async t => {
  const f = await fixture(t); const link = path.join(f.directory, "config-link.json"); await symlink(f.options.baseSourceConfig.path, link);
  f.options.baseSourceConfig.path = link; await assert.rejects(publish(f.options, f.deps)); assert.equal(f.children.length, 0);
});
test("same run with changed safe-head pins cannot rebuild its earlier successful bundle", async t => {
  const f = await fixture(t); await publish(f.options, f.deps); f.options.head.runtimeRowVersion = "42";
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_REENTRY_CHANGED"));
  assert.deepEqual(f.events, ["--prepare", "--publish"]);
});
test("a concurrent pending owner and a symlink target remain untouched by a rejected entrant", async t => {
  const f = await fixture(t); await mkdir(f.options.artifactDirectory, { mode: 0o700 });
  const existing = path.join(f.options.artifactDirectory, "pending"); await mkdir(existing, { mode: 0o700 });
  await save(path.join(existing, "head.json"), { owner: "first" }); const before = await readFile(path.join(existing, "head.json"));
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_PENDING_RECONCILIATION"));
  assert.deepEqual(await readdir(existing), ["head.json"]); assert.deepEqual(await readFile(path.join(existing, "head.json")), before);
  await rm(existing, { recursive: true });
  const elsewhere = path.join(f.directory, "elsewhere"); await mkdir(elsewhere, { mode: 0o700 }); await symlink(elsewhere, existing);
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_PENDING_RECONCILIATION"));
  assert.deepEqual(await readdir(elsewhere), []); assert.equal(f.children.length, 0);
});

test("post-head verification retains unknown quality with465 quarantines through prepared and verified outputs", async t => {
  const f = await fixture(t); f.controls.qualityState = "unknown";
  const result = await publish(f.options, f.deps); assert.equal(result.status, "verified");
  const directory = path.join(f.options.artifactDirectory, f.options.head.runId);
  const bundle = await read(path.join(directory, "bundle.json"));
  assert.equal(bundle.intent.source.qualityState, "unknown"); assert.equal(bundle.intent.source.quarantineCount, 465);
  const receipt = await read(result.receiptPath); assert.equal(receipt.source.qualityState, "unknown");
  assert.equal(receipt.source.quarantineCount, 465);
});
