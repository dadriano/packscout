import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath, readdir, symlink, lstat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
process.env.NODE_ENV = "test";
const { publishClutchpacksProductionPostHead: publish, clutchpacksProductionPostHeadSchema } =
  await tsImport("./clutchpacks-production-post-head.mts", import.meta.url);
const recoveryModule = await tsImport("./clutchpacks-production-post-head-recovery.mts", import.meta.url);
const executeRecoveryLive = recoveryModule.executeClutchpacksProductionPostHeadRecoveryPublication;
const recoveryHarness = recoveryModule.clutchpacksProductionPostHeadRecoveryTestHarness;
assert.ok(recoveryHarness); const executeRecovery = recoveryHarness.execute;
const { clutchpacksProductionPostHeadSuccessorPreparerTestHarness: preparerHarness } =
  await import("./prepare-clutchpacks-production-post-head-successor-ledger.mjs");
const { clutchpacksProductionPostHeadSuccessorLauncherTestHarness: launcherHarness } =
  await import("./clutchpacks-production-post-head-successor-launcher.mjs");
const { clutchpacksProductionRecoveryPublishShimTestHarness: shimHarness } =
  await import("./clutchpacks-production-recovery-publish-shim.mjs");
const { clutchpacksProductionObservationOperationId } =
  await tsImport("./clutchpacks-production-v3-publication.mts", import.meta.url);
const { CLUTCHPACKS_PRODUCTION_SCOPE: scope, CLUTCHPACKS_PRODUCTION_TARGET: target, productionPublicationSha256: digest } =
  await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);
const id = suffix => `11111111-1111-5111-8111-${suffix.padStart(12, "0")}`;
const rawHash = value => createHash("sha256").update(value).digest("hex");
const executablePinPromise = readFile(process.execPath).then(bytes => ({ path: process.execPath, sha256: rawHash(bytes) }));
const now = "2026-08-31T18:00:00.000Z";
const save = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
const read = async file => JSON.parse(await readFile(file, "utf8"));

test("preparer and recovery agree on the frozen prefixed attempt directory", async t => {
  const run = await realpath(await mkdtemp(path.join(os.tmpdir(), "clutch-c533-cross-attempt-")));
  t.after(() => rm(run, { recursive: true, force: true }));
  const expected = path.join(run, recoveryHarness.oldAttemptDirectoryName);
  await mkdir(expected, { mode: 0o700 });
  assert.equal(await preparerHarness.frozenAttemptDirectory(run), expected);
});

test("all sealed direct boundaries accept only the exact macOS-injected environment key", () => {
  const expected = structuredClone(launcherHarness.productionSettings.environment), uid = 502;
  const injected = `0x${uid.toString(16).toUpperCase()}:0x0:0x0`;
  const normalizers = [preparerHarness.normalizeSealedEnvironment, launcherHarness.normalizeSealedEnvironment,
    recoveryHarness.normalizeSealedEnvironment, shimHarness.normalizeSealedEnvironment];
  for (const normalize of normalizers) {
    assert.deepEqual(normalize({ ...expected }, expected, "linux", uid), expected);
    assert.deepEqual(normalize({ ...expected, __CF_USER_TEXT_ENCODING: injected }, expected, "darwin", uid), expected);
    for (const [environment, platform, runtimeUid] of [
      [{ ...expected, EXTRA: "unexpected" }, "darwin", uid],
      [{ ...expected, __CF_USER_TEXT_ENCODING: injected }, "linux", uid],
      [{ ...expected, __CF_USER_TEXT_ENCODING: injected.toLowerCase() }, "darwin", uid],
      [{ ...expected, __CF_USER_TEXT_ENCODING: injected }, "darwin", -1],
      [{ ...expected, __CF_USER_TEXT_ENCODING: injected }, "darwin", 1.5],
      [{ ...expected, __CF_USER_TEXT_ENCODING: injected }, "darwin", Number.MAX_SAFE_INTEGER + 1],
      [{ ...expected, PATH: "/usr/bin:/bin", __CF_USER_TEXT_ENCODING: injected }, "darwin", uid],
    ]) assert.throws(() => normalize(environment, expected, platform, runtimeUid));
  }
});

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
    outputMutation: null, hang: false, terminated: false, outputBytes: 0, sourceHeadOverride: null, onSpawn: null,
    sidecarMode: null };
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
            const leaseAttemptId = randomUUID(), leaseRequest = { role: "import",
              owner: `production-publication:${intent.operationId}:${leaseAttemptId}`, leaseMilliseconds: 900_000 };
            const leasePath = `${first}.lease.${leaseAttemptId}.json`;
            const observedAt = new Date(Date.parse(now) + children.length).toISOString(), observationSequence = Date.parse(observedAt);
            const observationRequest = { schemaVersion: "data_release_v3",
              operationId: clutchpacksProductionObservationOperationId(intent, observedAt),
              idempotencyKey: clutchpacksProductionObservationOperationId(intent, observedAt),
              publicReleaseId: intent.candidate.publicReleaseId, releaseFingerprint: intent.candidate.releaseFingerprint,
              publicVendorId: id("10"), vendorKey: "clutchpacks", observationSequence, observedAt,
              freshThrough: new Date(Date.parse(observedAt) + 60_000).toISOString(),
              lastHeadReachedAt: intent.source.lastHeadReachedAt, sourceHeadSequence: intent.source.promotionSequence,
              settledSequence: intent.source.promotionSequence, sourceLifecycle: "active", connectionState: "healthy",
              qualityState: intent.source.qualityState, releaseAlignment: "aligned" };
            const observationPath = `${first}.observation.${observationSequence}.json`;
            if (controls.sidecarMode !== "missing-lease") await save(leasePath, {
              schemaVersion: "clutchpacks_production_lease_attempt_v1", bundleSha256: bundle.bundleSha256,
              attemptId: leaseAttemptId, intentSha256: digest(intent), request: leaseRequest,
              requestSha256: digest(leaseRequest) });
            await save(observationPath, { schemaVersion: "clutchpacks_production_observation_attempt_v1",
              bundleSha256: bundle.bundleSha256, intentSha256: digest(intent), request: observationRequest,
              requestSha256: controls.sidecarMode === "tampered-observation" ? "0".repeat(64) : digest(observationRequest) });
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
          await controls.outputMutation?.(output, phase); child.stdout.write(JSON.stringify(output));
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
test("an adjacent receipt symlink is refused without following its target", async t => {
  const f = await fixture(t); let link;
  f.controls.outputMutation = async (output, phase) => {
    if (phase !== "--publish") return;
    link = path.join(path.dirname(output.receiptPath), `bundle.json.receipt.${randomUUID()}.json`);
    await symlink(output.receiptPath, link); output.receiptPath = link;
  };
  await assert.rejects(publish(f.options, f.deps), safelyBlocked("POST_HEAD_FILE_INVALID"));
  assert.equal((await lstat(link)).isSymbolicLink(), true);
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

async function treeEvidence(root) {
  const result = [];
  async function visit(directory, relative = "") {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name), key = path.join(relative, name), metadata = await lstat(file);
      if (metadata.isDirectory()) { result.push([key, "directory", metadata.mode & 0o777]); await visit(file, key); }
      else if (metadata.isSymbolicLink()) result.push([key, "symlink", await realpath(file)]);
      else result.push([key, "file", metadata.mode & 0o777, rawHash(await readFile(file))]);
    }
  }
  await visit(root); return result;
}
async function writeModule(worktree, relative, label) {
  const file = path.join(worktree, relative); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `export const fixture = ${JSON.stringify(label)};\n`, { mode: 0o644 });
  return { path: file, sha256: rawHash(await readFile(file)) };
}
async function recoveryFixture(t) {
  const f = await fixture(t); await publish(f.options, f.deps);
  const oldRoot = f.options.artifactDirectory, run = path.join(oldRoot, f.options.head.runId);
  const preparedBundle = await read(path.join(run, "bundle.json"));
  const attemptName = (await readdir(run)).find(name => name.startsWith("attempt-"));
  assert.ok(attemptName); const attempt = path.join(run, attemptName);
  for (const name of await readdir(run)) {
    if (name === "verified.json" || /^bundle\.json\.(?:lease\.|observation\.|receipt\.)/u.test(name)) {
      await rm(path.join(run, name));
    }
  }
  await rm(path.join(attempt, "publish.completed.json")); await rm(path.join(attempt, "verified.json"));
  await writeFile(path.join(attempt, "publish.stdout"), "", { mode: 0o600 });
  await writeFile(path.join(attempt, "publish.stderr"),
    `${JSON.stringify({ status: "refused", code: "CLUTCHPACKS_PRODUCTION_CONVEX_RUNTIME_UNAVAILABLE" })}\n`, { mode: 0o600 });
  const pending = path.join(oldRoot, "pending"); await mkdir(pending, { mode: 0o700 });
  const pendingHead = path.join(pending, "head.json");
  await save(pendingHead, { head: f.options.head, publisherCommit: f.options.expectedPublisherCommit });
  const blocked = path.join(pending, `blocked-${randomUUID()}.json`);
  await save(blocked, { status: "blocked", code: "POST_HEAD_CHILD_FAILED" });
  const pin = async file => ({ path: file, sha256: rawHash(await readFile(file)) });
  const targetPrevious = { publicReleaseId: id("8"), releaseFingerprint: "4".repeat(64) };
  const priorActive = preparedBundle.intent.predecessor;
  const predecessorIntent = { ...structuredClone(preparedBundle.intent), operationId: id("88"),
    predecessor: { generation: priorActive.generation - 1, ...targetPrevious },
    candidate: { publicReleaseId: priorActive.publicReleaseId, releaseFingerprint: priorActive.releaseFingerprint,
      planSha256: digest(preparedBundle.plan) } };
  const predecessorBundleBody = { ...structuredClone(preparedBundle), intent: predecessorIntent };
  delete predecessorBundleBody.bundleSha256;
  const predecessorDirectory = path.join(f.directory, "predecessor-run"); await mkdir(predecessorDirectory, { mode: 0o700 });
  const predecessorBundlePath = path.join(predecessorDirectory, "bundle.json");
  const predecessorBundle = { ...predecessorBundleBody, bundleSha256: digest(predecessorBundleBody) };
  await save(predecessorBundlePath, predecessorBundle);
  const predecessorReceiptPath = path.join(predecessorDirectory, `bundle.json.receipt.${randomUUID()}.json`);
  await save(predecessorReceiptPath, { schemaVersion: "clutchpacks_production_publication_receipt_v1", status: "verified",
    operationId: predecessorIntent.operationId, intentSha256: digest(predecessorIntent), target: predecessorIntent.target,
    scope: predecessorIntent.scope, readAt: predecessorIntent.readAt, source: predecessorIntent.source,
    candidate: predecessorIntent.candidate, approvedConfigurationSha256: predecessorIntent.approvedConfigurationSha256,
    generation: priorActive.generation, verifiedAt: now, publicReadbackSha256: "7".repeat(64), repackCount: 17,
    publicationOutcome: "activated", observationReceiptDigest: "6".repeat(64),
    activateReceiptDigest: "5".repeat(64), bundleSha256: predecessorBundle.bundleSha256 });
  const pointerOnly = pointer => ({ publicReleaseId: pointer.publicReleaseId, releaseFingerprint: pointer.releaseFingerprint });
  const rich = (pointer, completedAt = now) => ({ ...pointerOnly(pointer), methodVersion: "packscout-buyback-adjusted-ev-v1",
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
    publicEvPolicyVersion: "packscout-public-ev-nonpositive-v1", dataAsOf: now, completedAt,
    counts: { categories: 10, collectibles: 17, repacks: 17, chases: 17, searchShards: 1 } });
  const fullStatus = pointer => ({ ...pointerOnly(pointer), lifecycle: "complete",
    acceptedCounts: { categories: 10, collectibles: 17, repacks: 17, chases: 17, searchShards: 1 },
    acceptedBatchCount: 5, acceptedBatchChainHash: "1".repeat(64),
    acceptedEntityChainHashes: { categories: "2".repeat(64), collectibles: "3".repeat(64),
      repacks: "4".repeat(64), chases: "5".repeat(64) }, acceptedSearchRowCount: 17,
    acceptedSearchRowSetHash: "6".repeat(64), acceptedTopChaseCount: 17,
    acceptedVerifiedTopChaseCount: 17, completedAt: now });
  const targetPreflightPath = path.join(f.directory, "target-preflight.json");
  const publicationClientPin = await writeModule(f.options.publisherWorktree,
    "packages/services/src/convex-data-release-v3-publication-client.ts", "publication-client");
  await save(targetPreflightPath, { schemaVersion: "clutchpacks_c533_authenticated_target_preflight_v1",
    startedAt: now, completedAt: now,
    publisher: { worktree: f.options.publisherWorktree, commit: f.options.expectedPublisherCommit,
      runtimeModule: { path: path.join(f.options.publisherWorktree, "scripts/live/clutchpacks-production-convex-runtime.mts"),
        sha256: rawHash("export const fixture = \"runtime\";\n") }, publicationClient: publicationClientPin },
    authenticatedReads: { activeStateOperationId: "data-release-v3-active-state",
      statusPublicReleaseIds: [priorActive.publicReleaseId, targetPrevious.publicReleaseId,
        preparedBundle.intent.candidate.publicReleaseId] },
    firstActiveState: { generation: priorActive.generation, activeRelease: rich(priorActive),
      previousRelease: rich(targetPrevious) },
    secondActiveState: { generation: priorActive.generation, activeRelease: rich(priorActive),
      previousRelease: rich(targetPrevious) },
    activeStatus: fullStatus(priorActive), previousStatus: fullStatus(targetPrevious),
    candidate: { publicReleaseId: preparedBundle.intent.candidate.publicReleaseId, status: null } });
  const targetPreflightScriptPath = path.join(f.directory, "target-preflight.mjs");
  await writeFile(targetPreflightScriptPath, "// fixture authenticated reader\n", { mode: 0o600 });
  const targetPreflightStderrPath = path.join(f.directory, "target-preflight.stderr");
  await writeFile(targetPreflightStderrPath, "", { mode: 0o600 });
  const targetChain = { authenticatedPreflight: await pin(targetPreflightPath),
    preflightScript: await pin(targetPreflightScriptPath), preflightStderr: await pin(targetPreflightStderrPath),
    predecessorBundle: await pin(predecessorBundlePath),
    predecessorReceipt: await pin(predecessorReceiptPath) };
  const old = { artifactDirectory: oldRoot, publisherWorktree: f.options.publisherWorktree,
    publisherCommit: f.options.expectedPublisherCommit, pendingHead: await pin(pendingHead),
    journal: await pin(path.join(run, "head.json")), sourceConfig: await pin(path.join(run, "source-config.json")),
    bundle: await pin(path.join(run, "bundle.json")), targetPrevious, targetChain, failure: { pendingBlocked: await pin(blocked),
      prepared: await pin(path.join(run, "prepared.json")), prepareStarted: await pin(path.join(attempt, "prepare.started.json")),
      prepareStdout: await pin(path.join(attempt, "prepare.stdout")), prepareStderr: await pin(path.join(attempt, "prepare.stderr")),
      prepareCompleted: await pin(path.join(attempt, "prepare.completed.json")),
      publishStarted: await pin(path.join(attempt, "publish.started.json")),
      publishStdout: await pin(path.join(attempt, "publish.stdout")), publishStderr: await pin(path.join(attempt, "publish.stderr")) } };
  const publisherModules = {
    promoteCli: await writeModule(f.options.publisherWorktree, "scripts/live/promote-clutchpacks-production.mts", "promote"),
    convexRuntime: await writeModule(f.options.publisherWorktree, "scripts/live/clutchpacks-production-convex-runtime.mts", "runtime"),
    publicationOrchestrator: await writeModule(f.options.publisherWorktree, "scripts/live/clutchpacks-production-v3-publication.mts", "orchestrator"),
    publicationPolicy: await writeModule(f.options.publisherWorktree, "scripts/live/clutchpacks-production-publication-policy.mts", "policy"),
    genericPublisher: await writeModule(f.options.publisherWorktree, "packages/services/src/buyback-adjusted-ev-release-publisher.ts", "generic"),
    sourceReader: await writeModule(f.options.publisherWorktree,
      "scripts/live/clutchpacks-production-source-reader.mts", "source-reader"),
    servicesIndex: await writeModule(f.options.publisherWorktree, "packages/services/src/index.ts", "services-index"),
  };
  const loaderPin = await writeModule(f.options.publisherWorktree, "node_modules/tsx/dist/loader.mjs", "loader");
  const executorWorktree = path.join(f.directory, "executor-worktree"); await mkdir(executorWorktree, { mode: 0o700 });
  await mkdir(path.join(executorWorktree, "node_modules"), { mode: 0o700 });
  const executorModules = {
    recovery: await writeModule(executorWorktree, "scripts/live/clutchpacks-production-post-head-recovery.mts", "recovery"),
    postHead: await writeModule(executorWorktree, "scripts/live/clutchpacks-production-post-head.mts", "post-head"),
    publishShim: await writeModule(executorWorktree, "scripts/live/clutchpacks-production-recovery-publish-shim.mjs", "shim"),
    runtimeInventory: await writeModule(executorWorktree, "scripts/live/clutchpacks-production-runtime-inventory.mjs", "inventory"),
    launcher: await writeModule(executorWorktree,
      "scripts/live/clutchpacks-production-post-head-successor-launcher.mjs", "launcher"),
  };
  const publisherCommit = f.options.expectedPublisherCommit, executorCommit = "c".repeat(40);
  const successorRoot = path.join(f.directory, "successor-artifacts");
  const proofDirectory = path.join(f.directory, "successor-proof");
  const secondSuccessorRoot = path.join(f.directory, "successor-artifacts-2");
  const secondProofDirectory = path.join(f.directory, "successor-proof-2");
  const ledgerPath = path.join(f.directory, "ledger"); await mkdir(ledgerPath, { mode: 0o700 });
  await mkdir(path.join(ledgerPath, "records"), { mode: 0o700 });
  const executorPolicyPath = path.join(ledgerPath, "executor-policy.json");
  const executablePin = await executablePinPromise;
  const runtimeInventory = { schemaVersion: "clutchpacks_production_runtime_inventory_v1",
    root: path.join(f.options.publisherWorktree, "node_modules"), allowedTargetRoot: f.options.publisherWorktree,
    entryCount: 3, fileCount: 2, directoryCount: 1, symlinkCount: 0, totalBytes: 12,
    treeSha256: "3".repeat(64) };
  const executorRuntimeInventory = { ...runtimeInventory, root: path.join(executorWorktree, "node_modules"),
    allowedTargetRoot: executorWorktree, treeSha256: "4".repeat(64) };
  const sourceReaderIdentity = { worktree: f.options.publisherWorktree, commit: publisherCommit,
    script: publisherModules.promoteCli, policy: structuredClone(f.options.baseSourceConfig),
    executable: executablePin, loader: loaderPin, runtimeInventory };
  const expectedEnvironment = { HOME: path.resolve(process.env.HOME), NODE_ENV: "production", PATH: process.env.PATH,
    TMPDIR: path.resolve(process.env.TMPDIR) };
  const publisherIdentity = { worktree: f.options.publisherWorktree, commit: publisherCommit, modules: publisherModules };
  const executorIdentity = { worktree: executorWorktree, commit: executorCommit, modules: executorModules };
  const roots = [
    { ordinal: 1, rootId: "c80f32fe-d8d7-469a-8667-5f801c082f99", artifactDirectory: successorRoot, proofDirectory },
    { ordinal: 2, rootId: "9825ddf9-5fdc-4660-b2db-51c8fc74b041", artifactDirectory: secondSuccessorRoot,
      proofDirectory: secondProofDirectory },
  ];
  const oldRootInventory = await recoveryHarness.rootInventory(oldRoot);
  const manifestCore = { schemaVersion: "clutchpacks_production_post_head_successor_recovery_manifest_v1",
    createdAt: now, incidentId: f.options.head.runId, ledgerPath, recordsPath: path.join(ledgerPath, "records"),
    ledgerSchemaSha256: recoveryHarness.ledgerSchemaSha256, head: structuredClone(f.options.head),
    freshnessCutoff: "2026-09-02T02:52:20.539Z", old: structuredClone(old),
    oldRootInventorySha256: oldRootInventory.inventorySha256, publisher: publisherIdentity,
    executor: executorIdentity, sourceReader: sourceReaderIdentity, roots };
  const manifestPath = path.join(ledgerPath, "incident-manifest.json");
  await save(manifestPath, { ...manifestCore, manifestSha256: digest(manifestCore) });
  const incidentManifest = await pin(manifestPath);
  const executorPolicyCore = { schemaVersion: "clutchpacks_production_post_head_recovery_executor_policy_v1",
    executor: executorIdentity,
    importedRecoveryModule: executorModules.recovery,
    publisher: publisherIdentity,
    executable: executablePin, loader: loaderPin, runtimeInventory, executorRuntimeInventory,
    sourceReader: sourceReaderIdentity, environment: expectedEnvironment,
    incidentManifest, ledgerPath, roots };
  await save(executorPolicyPath, { ...executorPolicyCore, policySha256: digest(executorPolicyCore) });
  await save(path.join(ledgerPath, "launch-policy.json"), { fixture: true });
  const executorPolicy = await pin(executorPolicyPath), controls = { dirty: new Set(), wrongCommit: new Map() };
  const commits = new Map([[f.options.publisherWorktree, publisherCommit], [executorWorktree, executorCommit]]);
  const git = async (args, options) => {
    if (args[0] === "status") return controls.dirty.has(options.cwd) ? " M tracked-file\n" : "";
    if (args[0] === "ls-files") return `${args[2]}\n`;
    if (args[1] === "HEAD") return `${controls.wrongCommit.get(options.cwd) ?? commits.get(options.cwd)}\n`;
    return `${options.cwd}\n`;
  };
  const executionInput = { schemaVersion: "clutchpacks_production_post_head_successor_v1",
    head: structuredClone(f.options.head), old: structuredClone(old),
    publisher: publisherIdentity, executor: executorIdentity,
    executorPolicy, incidentManifest, deadlineMs: 900_000 };
  const activePredecessor = structuredClone(preparedBundle.intent.predecessor);
  const targetControls = { snapshot: { active: structuredClone(activePredecessor), previous: structuredClone(targetPrevious),
    activeStatus: { publicReleaseId: activePredecessor.publicReleaseId,
      releaseFingerprint: activePredecessor.releaseFingerprint, lifecycle: "complete" },
    previousStatus: { ...structuredClone(targetPrevious), lifecycle: "complete" }, candidateStatus: null,
    assertionProvenance: { activeChain: "signed_active_state_double_read_v1",
      lifecycle: "signed_release_status_projection_v1", stagingExclusion: "publisher_start_cas_v1" } } };
  const sourceProof = { ...structuredClone(f.options.head), runtimeState: "idle", disposition: "due",
    importLeaseOwned: false, assertionProvenance: { headAndImportLease: "clutchpacks_poller_check_only_v1",
      noActiveOrActionableWork: "continuous_decision_due_v1" } };
  const recoveryQuietProof = { ...structuredClone(f.options.head), runtimeState: "idle",
    importLeaseOwner: null, importLeaseExpiresAt: null, sourceStateDigest: "a".repeat(64),
    assertionProvenance: "production_source_state_strict_admission_v1" };
  const baseSpawn = f.deps.spawn;
  const spawn = (file, args, input) => {
    assert.deepEqual(input.env, expectedEnvironment);
    assert.deepEqual(Object.keys(input.env).sort(), ["HOME", "NODE_ENV", "PATH", "TMPDIR"]);
    const publishOffset = args.indexOf("--publish"), bundlePath = args[publishOffset + 1];
    const handshakePath = args[args.indexOf("--handshake") + 1];
    const continuePath = args[args.indexOf("--continue") + 1];
    if (publishOffset >= 0 && typeof bundlePath === "string") {
      const attemptDirectory = path.dirname(handshakePath);
      const checkout = (worktree, commit) => {
        const value = { worktree, commit, cleanStatusSha256: rawHash(""), trackedFilesSha256: "6".repeat(64), verifiedAt: now };
        return { ...value, proofSha256: digest(value) };
      };
      const core = { schemaVersion: "clutchpacks_production_post_head_recovery_child_lock_v1",
        acquiredAt: now, pid: 123, port: 47_432, attemptDirectory,
        bundle: { path: bundlePath, sha256: rawHash(readFileSync(bundlePath)) }, executorPolicy,
        executable: executablePin, loader: loaderPin, shim: executorModules.publishShim,
        cli: publisherModules.promoteCli, runtimeInventory, executorRuntimeInventory,
        sourceRuntimeInventory: runtimeInventory,
        publisherCheckout: checkout(f.options.publisherWorktree, publisherCommit),
        executorCheckout: checkout(executorWorktree, executorCommit),
        sourceCheckout: checkout(sourceReaderIdentity.worktree, sourceReaderIdentity.commit) };
      writeFileSync(path.join(attemptDirectory, "publish.lock-acquired.json"),
        `${JSON.stringify({ ...core, lockSha256: digest(core) })}\n`, { mode: 0o600, flag: "wx" });
    }
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
    let childClosed = false; child.once("close", () => { childClosed = true; });
    f.children.push({ file, args, input, child });
    setImmediate(async () => {
      try {
        while (!(await stat(continuePath).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error)))) {
          if (childClosed) throw new Error("fixture child closed before continue");
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        const directArgs = ["--import", loaderPin.path,
          path.join(f.options.publisherWorktree, "scripts/live/promote-clutchpacks-production.mts"), "--publish", bundlePath];
        const actual = baseSpawn(file, directArgs, input);
        actual.stdout.pipe(child.stdout, { end: false }); actual.stderr.pipe(child.stderr, { end: false });
        actual.once("close", code => {
          child.stdout.end(); child.stderr.end();
          if (code === 0) targetControls.snapshot = {
        active: { generation: activePredecessor.generation + 1,
          publicReleaseId: preparedBundle.intent.candidate.publicReleaseId,
          releaseFingerprint: preparedBundle.intent.candidate.releaseFingerprint },
        previous: { publicReleaseId: activePredecessor.publicReleaseId,
          releaseFingerprint: activePredecessor.releaseFingerprint },
        activeStatus: { publicReleaseId: preparedBundle.intent.candidate.publicReleaseId,
          releaseFingerprint: preparedBundle.intent.candidate.releaseFingerprint, lifecycle: "complete" },
        previousStatus: { publicReleaseId: activePredecessor.publicReleaseId,
          releaseFingerprint: activePredecessor.releaseFingerprint, lifecycle: "complete" },
        candidateStatus: { publicReleaseId: preparedBundle.intent.candidate.publicReleaseId,
          releaseFingerprint: preparedBundle.intent.candidate.releaseFingerprint, lifecycle: "complete" },
        assertionProvenance: { activeChain: "signed_active_state_double_read_v1",
          lifecycle: "signed_release_status_projection_v1", stagingExclusion: "publisher_start_cas_v1" } };
          child.emit("close", code);
        });
      } catch { child.stdout.end(); child.stderr.end(); child.emit("close", 1); }
    });
    return child;
  };
  const deps = { ...f.deps, spawn, git, now: () => now,
    readTargetProof: async () => structuredClone(targetControls.snapshot),
    readSourceProof: async () => structuredClone(sourceProof),
    readRecoveryQuietProof: async () => structuredClone(recoveryQuietProof),
    inspectChildTermination: async (proof, executionLock) => ({ checkedAt: now, pid: proof.pid,
      processGroupId: proof.pid, processAbsent: true, processGroupAbsent: true, executionLock }),
    inspectUnboundChildAbsence: async (_successor, _bundlePath, executionLock) => {
      const core = { checkedAt: now, matchingProcessIds: [], matchingProcessGroupIds: [], executionLock };
      return { ...core, proofSha256: digest(core) };
    },
    readRuntimeInventory: async (root, allowedTargetRoot) => structuredClone(root === executorRuntimeInventory.root
      ? executorRuntimeInventory : { ...runtimeInventory, root, allowedTargetRoot }),
    acquireResidencyExclusion: async () => ({ proof: { label: "com.packscout.provider-import.clutchpacks",
      port: 56_432, launchdUnloaded: true, residentProcessCount: 0, portBound: true,
      acquiredAt: now, checkedAt: now },
    refreshProof: async () => ({ label: "com.packscout.provider-import.clutchpacks", port: 56_432,
      launchdUnloaded: true, residentProcessCount: 0, portBound: true, acquiredAt: now, checkedAt: now }),
    release: () => undefined }),
    acquireExecutionExclusion: async () => ({ proof: { port: 47_432, portBound: true, acquiredAt: now },
      refreshProof: async () => ({ port: 47_432, portBound: true, acquiredAt: now }),
      release: () => undefined, relinquishForChild: () => undefined, reacquireAfterChild: () => undefined }) };
  const execute = (overrides = {}) => executeRecovery(executionInput, { ...deps, ...overrides });
  return { ...f, sourceControls: f.controls, oldRoot, run, attempt, old, pin, preparedBundle,
    targetPrevious, fullStatus, targetPreflightPath, predecessorBundlePath, predecessorReceiptPath,
    publisherCommit, publisherModules,
    executorWorktree, executorCommit, executorModules, executorPolicyPath, controls, commits, git,
    executionInput, deps, activePredecessor, targetControls, sourceProof, recoveryQuietProof,
    execute, successorRoot, proofDirectory,
    ledgerPath, manifestPath, roots, oldRootInventory };
}

async function rewriteBoundRoots(f, mutate) {
  const manifest = await read(f.manifestPath); mutate(manifest.roots);
  const { manifestSha256: _oldManifestSha256, ...manifestCore } = manifest;
  await writeFile(f.manifestPath, `${JSON.stringify({ ...manifestCore, manifestSha256: digest(manifestCore) })}\n`,
    { mode: 0o600 });
  f.executionInput.incidentManifest = await f.pin(f.manifestPath);
  const policy = await read(f.executorPolicyPath);
  policy.incidentManifest = structuredClone(f.executionInput.incidentManifest);
  policy.roots = structuredClone(manifest.roots);
  const { policySha256: _oldPolicySha256, ...policyCore } = policy;
  await writeFile(f.executorPolicyPath, `${JSON.stringify({ ...policyCore, policySha256: digest(policyCore) })}\n`,
    { mode: 0o600 });
  f.executionInput.executorPolicy = await f.pin(f.executorPolicyPath);
}

test("offline preparer documents cross-validate byte-for-byte through launcher, recovery, and shim boundaries", async t => {
  assert.equal(preparerHarness.ledgerSchemaSha256, recoveryHarness.ledgerSchemaSha256);
  assert.equal(launcherHarness.ledgerSchemaSha256, recoveryHarness.ledgerSchemaSha256);
  const f = await recoveryFixture(t), manifest = await read(f.manifestPath), policy = await read(f.executorPolicyPath);
  const { manifestSha256: _manifestSha256, ...manifestCore } = manifest;
  const { policySha256: _policySha256, incidentManifest: _policyManifest, ...executorPolicyCore } = policy;
  const { incidentManifest: _inputManifest, executorPolicy: _inputExecutorPolicy, ...launchPolicyCore } = f.executionInput;
  const built = preparerHarness.buildSealedDocuments({ manifestCore, executorPolicyCore, launchPolicyCore });
  const launcherValidated = launcherHarness.validatePreparedDocumentBytes(built.documents);
  assert.deepEqual(recoveryHarness.manifest(launcherValidated.manifest), launcherValidated.manifest);
  assert.deepEqual(recoveryHarness.executorPolicy(launcherValidated.executorPolicy), launcherValidated.executorPolicy);
  assert.deepEqual(recoveryHarness.successorInput(launcherValidated.input), launcherValidated.input);
  assert.deepEqual(shimHarness.validateIncidentManifestDocument(launcherValidated.manifest,
    launcherValidated.manifestPin, launcherValidated.executorPolicy), launcherValidated.manifest);
  assert.equal(launcherValidated.input.incidentManifest.sha256,
    rawHash(built.documents["incident-manifest.json"]));
  assert.equal(launcherValidated.input.executorPolicy.sha256,
    rawHash(built.documents["executor-policy.json"]));
});

const safelyRecoveryBlocked = code => error => {
  assert.equal(error.code, code); assert.doesNotMatch(error.message, /token|secret|postgres/iu); return true;
};

test("trusted tracked-code pins admit production-shaped 0644 files and reject writable or symlinked code", async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "packscout-trusted-code-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tracked = path.join(directory, "tracked.mjs");
  await writeFile(tracked, "export const trusted = true;\n", { mode: 0o644 });
  const expected = { path: tracked, sha256: rawHash(await readFile(tracked)) };
  assert.deepEqual(await recoveryHarness.pinTrustedRegular(tracked), expected);
  await chmod(tracked, 0o755);
  assert.deepEqual(await recoveryHarness.pinTrustedRegular(tracked), expected);
  await chmod(tracked, 0o664);
  await assert.rejects(recoveryHarness.pinTrustedRegular(tracked),
    safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED"));
  await chmod(tracked, 0o644);
  const linked = path.join(directory, "linked.mjs"); await symlink(tracked, linked);
  await assert.rejects(recoveryHarness.pinTrustedRegular(linked),
    safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED"));
});

test("the immediate runtime-closure sandwich refuses code or dependency drift before import", async t => {
  await t.test("tracked module drift", async child => {
    const f = await recoveryFixture(child), policy = await read(f.executorPolicyPath); let reads = 0;
    await assert.rejects(recoveryHarness.verifyTrustedPublisherRuntimeClosure(f.executionInput.publisher,
      policy.runtimeInventory, async () => {
        reads += 1;
        if (reads === 1) await writeFile(f.publisherModules.sourceReader.path, "tampered\n", { mode: 0o644 });
        return structuredClone(policy.runtimeInventory);
      }, f.git), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_MODULE_CHANGED"));
  });
  await t.test("untracked dependency drift", async child => {
    const f = await recoveryFixture(child), policy = await read(f.executorPolicyPath); let reads = 0;
    await assert.rejects(recoveryHarness.verifyTrustedPublisherRuntimeClosure(f.executionInput.publisher,
      policy.runtimeInventory, async () => {
        reads += 1; const value = structuredClone(policy.runtimeInventory);
        if (reads === 2) value.treeSha256 = "f".repeat(64);
        return value;
      }, f.git), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED"));
  });
});

test("the late target import refuses an untracked publisher dependency changed after the prior proof", async t => {
  const f = await recoveryFixture(t), policy = await read(f.executorPolicyPath);
  const dependency = path.join(f.options.publisherWorktree, "node_modules", "late-target-dependency.mjs");
  const initialBytes = Buffer.from("export const value = 'initial';\n");
  await writeFile(dependency, initialBytes, { mode: 0o644 });
  let inventoryReads = 0;
  const readInventory = async () => {
    inventoryReads += 1;
    const value = (await readFile(dependency)).equals(initialBytes) ? structuredClone(policy.runtimeInventory) :
      { ...structuredClone(policy.runtimeInventory), totalBytes: policy.runtimeInventory.totalBytes + 1,
        treeSha256: "e".repeat(64) };
    if (inventoryReads === 1) {
      await writeFile(dependency, "export const value = 'changed';\n", { mode: 0o644 });
    }
    return value;
  };
  let targetImportReached = false;
  await assert.rejects(recoveryHarness.verifyTrustedTargetRuntimeClosure(f.executionInput.publisher,
    f.publisherModules.convexRuntime, policy.runtimeInventory, readInventory, f.git).then(() => {
      targetImportReached = true;
    }), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED"));
  assert.equal(targetImportReached, false);
  assert.equal(inventoryReads, 2);
});

test("real release status is fully validated before projection into the signed target proof", async t => {
  const f = await recoveryFixture(t), full = f.fullStatus(f.activePredecessor);
  assert.deepEqual(recoveryHarness.projectReleaseStatus(full), {
    publicReleaseId: f.activePredecessor.publicReleaseId,
    releaseFingerprint: f.activePredecessor.releaseFingerprint, lifecycle: "complete" });
  assert.equal(recoveryHarness.projectReleaseStatus(null), null);
  assert.throws(() => recoveryHarness.projectReleaseStatus({ ...full, invented: true }));
  assert.throws(() => recoveryHarness.projectReleaseStatus({ ...full, acceptedBatchChainHash: "bad" }));
});

test("historical signed chain is semantically bound beyond its raw file hash", async t => {
  const f = await recoveryFixture(t), bundleBytes = await readFile(f.old.bundle.path), values = {
    preflightBytes: await readFile(f.targetPreflightPath),
    predecessorBundleBytes: await readFile(f.predecessorBundlePath),
    predecessorReceiptBytes: await readFile(f.predecessorReceiptPath),
  };
  assert.ok(recoveryHarness.validateHistoricalTarget(f.executionInput, bundleBytes, values));
  const tampered = JSON.parse(values.preflightBytes.toString("utf8"));
  tampered.authenticatedReads.statusPublicReleaseIds.reverse();
  assert.throws(() => recoveryHarness.validateHistoricalTarget(f.executionInput, bundleBytes,
    { ...values, preflightBytes: Buffer.from(`${JSON.stringify(tampered)}\n`) }),
  safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_TARGET_HISTORY_INVALID"));
});

test("only the exact launchctl service-not-found result admits residency", () => {
  const uid = 501, missing = `Could not find service \"com.packscout.provider-import.clutchpacks\" in domain for user gui: ${uid}\n`;
  assert.equal(recoveryHarness.launchctlServiceIsMissing({ code: 113, stdout: "", stderr: missing }, uid), true);
  assert.equal(recoveryHarness.launchctlServiceIsMissing({ code: 113, stdout: "", stderr: `permission denied\n${missing}` }, uid), false);
  assert.equal(recoveryHarness.launchctlServiceIsMissing({ code: "ETIMEDOUT", stdout: "", stderr: missing }, uid), false);
  assert.equal(recoveryHarness.launchctlServiceIsMissing({ code: 1, stdout: "", stderr: missing }, uid), false);
});

test("a successor proof path under the old root refuses before mkdir and preserves the old inventory", async t => {
  const f = await recoveryFixture(t), before = await treeEvidence(f.oldRoot);
  const nestedProof = path.join(f.oldRoot, "must-never-be-created");
  await rewriteBoundRoots(f, roots => { roots[0].proofDirectory = nestedProof; });
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_MANIFEST_INVALID"));
  await assert.rejects(stat(nestedProof), error => error.code === "ENOENT");
  assert.deepEqual(await treeEvidence(f.oldRoot), before);
});

test("one-shot successor preserves the blocked root, copies exact bytes, and reenters without prepare", async t => {
  const f = await recoveryFixture(t), before = await treeEvidence(f.oldRoot);
  for (const pin of [...Object.values(f.executionInput.publisher.modules),
    ...Object.values(f.executionInput.executor.modules)]) {
    assert.equal((await stat(pin.path)).mode & 0o777, 0o644);
  }
  assert.equal((await stat(process.execPath)).mode & 0o777, 0o755);
  assert.equal((await stat(f.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.executorPolicyPath)).mode & 0o777, 0o600);
  const result = await f.execute();
  assert.equal(result.status, "verified");
  assert.deepEqual(await treeEvidence(f.oldRoot), before);
  assert.deepEqual(await readFile(path.join(f.successorRoot, f.options.head.runId, "bundle.json")),
    await readFile(f.old.bundle.path));
  assert.equal((await stat(path.join(f.successorRoot, f.options.head.runId, "bundle.json"))).ino ===
    (await stat(f.old.bundle.path)).ino, false);
  assert.equal((await readdir(f.successorRoot)).includes("pending"), false);
  assert.equal((await read(path.join(f.successorRoot, f.options.head.runId, "verified.json"))).status, "verified");
  assert.equal((await read(path.join(f.proofDirectory, "successor.completed.json"))).schemaVersion,
    "clutchpacks_production_post_head_successor_receipt_v1");
  const recoveryChildren = f.children.filter(child => child.args.includes("--handshake"));
  assert.equal(recoveryChildren.length, 2);
  assert.ok(recoveryChildren.every(child => child.args.includes("--publish") && !child.args.includes("--prepare")));
});

test("successor receipt evidence refuses an adjacent symlink before reading its target", async t => {
  const f = await recoveryFixture(t); let injected = false, link;
  f.sourceControls.outputMutation = async (output, phase) => {
    if (phase !== "--publish" || injected) return; injected = true;
    link = path.join(path.dirname(output.receiptPath), `bundle.json.receipt.${randomUUID()}.json`);
    await symlink(output.receiptPath, link); output.receiptPath = link;
  };
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_SIDECAR_INVALID"));
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test("direct-dispatch crash consumes ordinal one and only a durable retry authorization can claim ordinal two", async t => {
  const f = await recoveryFixture(t); let crash = true;
  await assert.rejects(f.execute({ afterLedgerDispatch: phase => {
    if (phase === "initial" && crash) { crash = false; throw new Error("injected after direct dispatch"); }
  } }));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED"));
  assert.equal(await stat(f.roots[1].artifactDirectory).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error)), false);
  const result = await f.execute(); assert.equal(result.status, "verified");
  assert.equal(result.artifactDirectory, f.roots[1].artifactDirectory);
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(name =>
    read(path.join(f.ledgerPath, "records", name))));
  assert.deepEqual(records.map(record => [record.ordinal, record.event]), [[1, "attempt_claimed"],
    [1, "direct_dispatched"], [1, "retry_authorized"], [2, "attempt_claimed"],
    [2, "direct_dispatched"], [2, "direct_verified"], [2, "adoption_dispatched"], [2, "complete"]]);
  const again = await f.execute(); assert.equal(again.status, "verified");
  assert.equal((await readdir(path.join(f.ledgerPath, "records"))).length, records.length);
});

for (const [name, hook] of [["before successor mkdir", "afterAttemptClaimed"],
  ["after artifact-root mkdir", "afterArtifactRootCreated"], ["after child handshake", "afterChildHandshake"]]) {
  test(`attempt-claim crash ${name} seals root one and authorizes only root two`, async t => {
    const f = await recoveryFixture(t); let crash = true;
    await assert.rejects(f.execute({ [hook]: () => {
      if (crash) { crash = false; throw new Error(`injected ${hook}`); }
    } }));
    await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED"));
    const firstRootExists = await stat(f.roots[0].artifactDirectory).then(() => true,
      error => error.code === "ENOENT" ? false : Promise.reject(error));
    const firstRootBefore = firstRootExists ? await treeEvidence(f.roots[0].artifactDirectory) : null;
    const result = await f.execute(); assert.equal(result.artifactDirectory, f.roots[1].artifactDirectory);
    if (firstRootBefore === null) await assert.rejects(stat(f.roots[0].artifactDirectory), error => error.code === "ENOENT");
    else assert.deepEqual(await treeEvidence(f.roots[0].artifactDirectory), firstRootBefore);
    const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(file =>
      read(path.join(f.ledgerPath, "records", file))));
    assert.deepEqual(records.slice(0, 3).map(record => [record.ordinal, record.event, record.payload.reason]),
      [[1, "attempt_claimed", undefined], [1, "retry_authorized", "claim_interrupted"],
        [2, "attempt_claimed", undefined]]);
  });
}

test("ordinal two attempt-claim interruption becomes terminal and never permits a third root", async t => {
  const f = await recoveryFixture(t); let firstCrash = true, secondCrash = true;
  await assert.rejects(f.execute({ afterAttemptClaimed: () => {
    if (firstCrash) { firstCrash = false; throw new Error("ordinal one claim crash"); }
  } }));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED"));
  await assert.rejects(f.execute({ afterAttemptClaimed: () => {
    if (secondCrash) { secondCrash = false; throw new Error("ordinal two claim crash"); }
  } }));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL"));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL"));
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(file =>
    read(path.join(f.ledgerPath, "records", file))));
  assert.deepEqual(records.slice(-2).map(record => [record.ordinal, record.event, record.payload.reason]),
    [[2, "attempt_claimed", undefined], [2, "terminal", "claim_retry_exhausted"]]);
  assert.equal(records.some(record => record.ordinal > 2), false);
});

test("ordinal two dispatch uncertainty is terminal and a third root cannot be selected", async t => {
  const f = await recoveryFixture(t); let crashes = 0;
  const crashDispatch = { afterLedgerDispatch: phase => {
    if (phase === "initial" && crashes < 2) { crashes += 1; throw new Error("injected dispatch crash"); }
  } };
  await assert.rejects(f.execute(crashDispatch));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED"));
  await assert.rejects(f.execute(crashDispatch));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL"));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL"));
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(name =>
    read(path.join(f.ledgerPath, "records", name))));
  assert.deepEqual(records.slice(-2).map(record => [record.ordinal, record.event, record.payload.reason]),
    [[2, "direct_dispatched", undefined], [2, "terminal", "direct_retry_exhausted"]]);
  assert.equal(records.some(record => record.ordinal > 2), false);
});

test("ledger reducer refuses broken hash chains and any synthetic third ordinal", async t => {
  const f = await recoveryFixture(t); await f.execute();
  const manifest = await read(f.manifestPath);
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(name =>
    read(path.join(f.ledgerPath, "records", name))));
  const broken = structuredClone(records); broken[1].previousRecordSha256 = "0".repeat(64);
  assert.throws(() => recoveryHarness.reduceLedger(manifest, broken), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_INVALID"));
  const third = structuredClone(records.at(-1)); third.sequence = records.length; third.previousRecordSha256 = records.at(-1).recordSha256;
  third.event = "attempt_claimed"; third.ordinal = 3; third.root = { ...third.root, ordinal: 3 };
  third.payload = { artifactRootAbsent: true, proofRootAbsent: true };
  assert.throws(() => recoveryHarness.reduceLedger(manifest, [...records, third]));
});

test("ledger removes only a bounded private orphan install temp before reducing records", async t => {
  const f = await recoveryFixture(t), records = path.join(f.ledgerPath, "records");
  const orphan = path.join(records, `.clutchpacks-publication-${randomUUID()}.tmp`);
  await writeFile(orphan, "", { mode: 0o600, flag: "wx" });
  const result = await f.execute(); assert.equal(result.status, "verified");
  await assert.rejects(stat(orphan), error => error.code === "ENOENT");
});

test("ledger refuses unrecognized or non-private temporary artifacts", async t => {
  const f = await recoveryFixture(t), records = path.join(f.ledgerPath, "records");
  await writeFile(path.join(records, ".clutchpacks-publication-not-a-uuid.tmp"), "", { mode: 0o600, flag: "wx" });
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_INVALID"));
});

test("crash after direct verification resumes from immutable receipt evidence without republishing direct", async t => {
  const f = await recoveryFixture(t); let crash = true;
  await assert.rejects(f.execute({ afterFirstPublish: () => {
    if (crash) { crash = false; throw new Error("injected after direct verification"); }
  } }));
  const before = f.children.filter(child => child.args.includes("--handshake")).length;
  const result = await f.execute(); assert.equal(result.status, "verified");
  assert.equal(f.children.filter(child => child.args.includes("--handshake")).length, before + 1);
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(name =>
    read(path.join(f.ledgerPath, "records", name))));
  assert.equal(records.filter(record => record.event === "direct_dispatched").length, 1);
});

test("crash after standard adoption completes from durable evidence without a third publish", async t => {
  const f = await recoveryFixture(t); let crash = true;
  await assert.rejects(f.execute({ afterStandardReentry: () => {
    if (crash) { crash = false; throw new Error("injected after standard adoption"); }
  } }));
  const before = f.children.filter(child => child.args.includes("--handshake")).length;
  const result = await f.execute(); assert.equal(result.status, "verified");
  assert.equal(f.children.filter(child => child.args.includes("--handshake")).length, before);
  assert.equal((await readdir(f.successorRoot)).includes("pending"), false);
});

for (const [name, hook] of [["publish command completion", "afterAdoptionCommandCompleted"],
  ["attempt verification", "afterAdoptionAttemptVerified"], ["run verification boundary", "afterAdoptionRunVerified"]]) {
  test(`completed adoption crash after ${name} reconciles exact evidence and clears stale pending`, async t => {
    const f = await recoveryFixture(t); let crash = true;
    await assert.rejects(f.execute({ [hook]: () => {
      if (crash) { crash = false; throw new Error(`injected ${hook}`); }
    } }));
    assert.equal((await readdir(f.successorRoot)).includes("pending"), true);
    const before = f.children.filter(child => child.args.includes("--handshake")).length;
    const result = await f.execute(); assert.equal(result.status, "verified");
    assert.equal(f.children.filter(child => child.args.includes("--handshake")).length, before);
    assert.equal((await readdir(f.successorRoot)).includes("pending"), false);
    const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(file =>
      read(path.join(f.ledgerPath, "records", file))));
    assert.equal(records.at(-1).event, "complete");
  });
}

test("completed adoption with a missing second sidecar is terminal instead of being guessed complete", async t => {
  const f = await recoveryFixture(t); let crash = true;
  await assert.rejects(f.execute({ afterAdoptionCommandCompleted: () => {
    if (crash) { crash = false; throw new Error("injected completed adoption crash"); }
  } }));
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(file =>
    read(path.join(f.ledgerPath, "records", file))));
  const first = new Set(Object.values(records.find(record => record.event === "direct_verified").payload.sidecars)
    .map(value => path.basename(value.path)));
  const second = (await readdir(path.join(f.successorRoot, f.options.head.runId)))
    .filter(name => name.startsWith("bundle.json.") && !first.has(name));
  assert.equal(second.length, 3); await unlink(path.join(f.successorRoot, f.options.head.runId, second[0]));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL"));
});

test("deadline abort after durable adoption command evidence reconciles through the same exact gate", async t => {
  const f = await recoveryFixture(t), controller = new AbortController();
  await assert.rejects(f.execute({ signal: controller.signal,
    afterAdoptionCommandCompleted: () => controller.abort() }), safelyRecoveryBlocked("POST_HEAD_ABORTED"));
  assert.equal((await read(path.join(f.successorRoot, "pending",
    (await readdir(path.join(f.successorRoot, "pending"))).find(name => name.startsWith("blocked-"))))).code,
  "POST_HEAD_ABORTED");
  const result = await f.execute(); assert.equal(result.status, "verified");
  assert.equal((await readdir(f.successorRoot)).includes("pending"), false);
});

test("ordinal one adoption-dispatch interruption authorizes root two and preserves old and abandoned roots", async t => {
  const f = await recoveryFixture(t); let crash = true;
  const oldBefore = await treeEvidence(f.oldRoot);
  await assert.rejects(f.execute({ afterLedgerDispatch: phase => {
    if (phase === "reentry" && crash) { crash = false; throw new Error("injected after adoption dispatch"); }
  } }), safelyRecoveryBlocked("POST_HEAD_CHILD_FAILED"));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED"));
  const abandonedArtifact = await treeEvidence(f.roots[0].artifactDirectory);
  const abandonedProof = await treeEvidence(f.roots[0].proofDirectory);
  const result = await f.execute(); assert.equal(result.artifactDirectory, f.roots[1].artifactDirectory);
  assert.deepEqual(await treeEvidence(f.oldRoot), oldBefore);
  assert.deepEqual(await treeEvidence(f.roots[0].artifactDirectory), abandonedArtifact);
  assert.deepEqual(await treeEvidence(f.roots[0].proofDirectory), abandonedProof);
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(name =>
    read(path.join(f.ledgerPath, "records", name))));
  assert.deepEqual(records.slice(3, 6).map(record => [record.ordinal, record.event, record.payload.reason]),
    [[1, "adoption_dispatched", undefined], [1, "retry_authorized", "adoption_interrupted_pending"],
      [2, "attempt_claimed", undefined]]);
});

test("ordinal two adoption-dispatch interruption is terminal and never selects a third root", async t => {
  const f = await recoveryFixture(t); let directCrash = true, adoptionCrash = true;
  await assert.rejects(f.execute({ afterLedgerDispatch: phase => {
    if (phase === "initial" && directCrash) { directCrash = false; throw new Error("ordinal one direct crash"); }
  } }));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED"));
  await assert.rejects(f.execute({ afterLedgerDispatch: phase => {
    if (phase === "reentry" && adoptionCrash) { adoptionCrash = false; throw new Error("ordinal two adoption crash"); }
  } }), safelyRecoveryBlocked("POST_HEAD_CHILD_FAILED"));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL"));
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL"));
  const records = await Promise.all((await readdir(path.join(f.ledgerPath, "records"))).sort().map(name =>
    read(path.join(f.ledgerPath, "records", name))));
  assert.deepEqual(records.slice(-2).map(record => [record.ordinal, record.event, record.payload.reason]),
    [[2, "adoption_dispatched", undefined], [2, "terminal", "adoption_pending_retained"]]);
  assert.equal(records.some(record => record.ordinal > 2), false);
});

for (const [name, mutate, code] of [
  ["changed bundle pin", async f => { f.executionInput.old.bundle.sha256 = "0".repeat(64); }, "POST_HEAD_SUCCESSOR_MANIFEST_INVALID"],
  ["changed publisher module", async f => { f.executionInput.publisher.modules.promoteCli.sha256 = "0".repeat(64); },
    "POST_HEAD_SUCCESSOR_MANIFEST_INVALID"],
  ["dirty executor checkout", async f => { f.controls.dirty.add(f.executorWorktree); }, "POST_HEAD_CHECKOUT_INVALID"],
]) test(`one-shot successor refuses ${name} before creating a destination`, async t => {
  const f = await recoveryFixture(t), before = await treeEvidence(f.oldRoot); await mutate(f);
  await assert.rejects(f.execute(), safelyRecoveryBlocked(code));
  await assert.rejects(stat(f.successorRoot), error => error.code === "ENOENT");
  assert.deepEqual(await treeEvidence(f.oldRoot), before);
});

test("target chain admits exact predecessor and candidate states and rejects ABA previous pointers", async t => {
  const predecessor = await recoveryFixture(t);
  await predecessor.execute();

  const candidate = await recoveryFixture(t);
  const bundle = await read(candidate.old.bundle.path), active = candidate.activePredecessor;
  candidate.targetControls.snapshot = { active: { generation: active.generation + 1,
    publicReleaseId: bundle.intent.candidate.publicReleaseId,
    releaseFingerprint: bundle.intent.candidate.releaseFingerprint },
  previous: { publicReleaseId: active.publicReleaseId, releaseFingerprint: active.releaseFingerprint },
  activeStatus: { publicReleaseId: bundle.intent.candidate.publicReleaseId,
    releaseFingerprint: bundle.intent.candidate.releaseFingerprint, lifecycle: "complete" },
  previousStatus: { publicReleaseId: active.publicReleaseId,
    releaseFingerprint: active.releaseFingerprint, lifecycle: "complete" },
  candidateStatus: { publicReleaseId: bundle.intent.candidate.publicReleaseId,
    releaseFingerprint: bundle.intent.candidate.releaseFingerprint, lifecycle: "complete" },
  assertionProvenance: { activeChain: "signed_active_state_double_read_v1",
    lifecycle: "signed_release_status_projection_v1", stagingExclusion: "publisher_start_cas_v1" } };
  await candidate.execute();

  const aba = await recoveryFixture(t);
  aba.targetControls.snapshot.previous = { publicReleaseId: id("99"), releaseFingerprint: "0".repeat(64) };
  aba.targetControls.snapshot.previousStatus = { ...aba.targetControls.snapshot.previous, lifecycle: "complete" };
  await assert.rejects(aba.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_TARGET_CHANGED"));
  await assert.rejects(stat(aba.successorRoot), error => error.code === "ENOENT");
});

test("a failed successor root is immutable and the same root is never reused", async t => {
  const f = await recoveryFixture(t); f.sourceControls.phaseFailure = "--publish";
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_CHILD_FAILED"));
  const failed = await treeEvidence(f.successorRoot);
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED"));
  assert.deepEqual(await treeEvidence(f.successorRoot), failed);
  f.sourceControls.phaseFailure = null;
  const recovered = await f.execute(); assert.equal(recovered.artifactDirectory, f.roots[1].artifactDirectory);
  assert.deepEqual(await treeEvidence(f.successorRoot), failed);
});

test("live successor entrypoint cannot receive dependency injection", async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(executeRecoveryLive(f.executionInput, { ...f.deps }),
    error => { assert.ok(error.code?.startsWith("POST_HEAD_SUCCESSOR_")); return true; });
});
