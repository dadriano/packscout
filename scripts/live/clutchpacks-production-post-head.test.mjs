import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, lstat, realpath, readdir, rename, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
process.env.NODE_ENV = "test";
// Recovery requires an explicit temp-directory pin; Linux runners need not set
// TMPDIR. Supply the fixture environment without relaxing the live policy.
process.env.TMPDIR ||= os.tmpdir();
const { publishClutchpacksProductionPostHead: publish, clutchpacksProductionPostHeadSchema } =
  await tsImport("./clutchpacks-production-post-head.mts", import.meta.url);
const recoveryModule = await tsImport("./clutchpacks-production-post-head-recovery.mts", import.meta.url);
const executeRecoveryLive = recoveryModule.executeClutchpacksProductionPostHeadRecoveryPublication;
const recoverLive = recoveryModule.recoverClutchpacksProductionPostHeadArtifacts;
const recoveryHarness = recoveryModule.clutchpacksProductionPostHeadRecoveryTestHarness;
assert.ok(recoveryHarness); const executeRecovery = recoveryHarness.execute, recover = recoveryHarness.recover;
const { CLUTCHPACKS_PRODUCTION_SCOPE: scope, CLUTCHPACKS_PRODUCTION_TARGET: target, productionPublicationSha256: digest } =
  await tsImport("./clutchpacks-production-publication-policy.mts", import.meta.url);
const { clutchpacksProductionObservationOperationId: observationId } =
  await tsImport("./clutchpacks-production-v3-publication.mts", import.meta.url);
const id = suffix => `11111111-1111-5111-8111-${suffix.padStart(12, "0")}`;
const rawHash = value => createHash("sha256").update(value).digest("hex");
const now = "2026-08-31T18:00:00.000Z";
const fixedPublisherWorktree = "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final";
const fixedPublisherCommit = "143e954fe5eca845f33c9727652486d62885174a";
const fixedPublisherModules = {
  promoteCli: { path: path.join(fixedPublisherWorktree, "scripts/live/promote-clutchpacks-production.mts"), sha256: "91911ba0b8952027d97801615a0414eeaafac2d690ec0733c2e23c866c5c306a" },
  convexRuntime: { path: path.join(fixedPublisherWorktree, "scripts/live/clutchpacks-production-convex-runtime.mts"), sha256: "b5a67cf97b435e27d78ea38211c087b542d30ce606f9c16555a0cb8383b2614a" },
  publicationOrchestrator: { path: path.join(fixedPublisherWorktree, "scripts/live/clutchpacks-production-v3-publication.mts"), sha256: "9d9f59cea89d78fa4f56ffd996f96cb5c7476a6d73155c40603ab1478cf48ff1" },
  publicationPolicy: { path: path.join(fixedPublisherWorktree, "scripts/live/clutchpacks-production-publication-policy.mts"), sha256: "29383064ab860e29e7d5e0380b2b6fa0468746b5ff3c69b8d50aff3faaa3bc74" },
  genericPublisher: { path: path.join(fixedPublisherWorktree, "packages/services/src/buyback-adjusted-ev-release-publisher.ts"), sha256: "787c80bdb03cc0a93728da8ca67c2995111f96ff6b23c2f1c3c9832d2dba5f6d" },
};
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
    outputMutation: null, hang: false, terminated: false, outputBytes: 0, sourceHeadOverride: null, onSpawn: null,
    sidecarMode: null, observationOffset: 0 };
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
          await controls.onSpawn?.();
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
            const lease = { schemaVersion: "clutchpacks_production_lease_attempt_v1", bundleSha256: bundle.bundleSha256,
              attemptId: leaseAttemptId, intentSha256: digest(intent), request: leaseRequest, requestSha256: digest(leaseRequest) };
            const observedAt = new Date(Date.parse(now) + controls.observationOffset++).toISOString();
            const observationSequence = Date.parse(observedAt), operationId = observationId(intent, observedAt);
            const observationRequest = { operationId, idempotencyKey: operationId,
              publicReleaseId: intent.candidate.publicReleaseId, releaseFingerprint: intent.candidate.releaseFingerprint,
              observationSequence, observedAt };
            const observation = { schemaVersion: "clutchpacks_production_observation_attempt_v1",
              bundleSha256: bundle.bundleSha256, intentSha256: digest(intent), request: observationRequest,
              requestSha256: digest(observationRequest) };
            const receipt = { schemaVersion: "clutchpacks_production_publication_receipt_v1", status: "verified",
              operationId: intent.operationId, intentSha256: digest(intent), target: intent.target, scope: intent.scope,
              readAt: intent.readAt, source: intent.source, candidate: intent.candidate,
              approvedConfigurationSha256: intent.approvedConfigurationSha256, generation: 3, verifiedAt: now,
              publicReadbackSha256: "7".repeat(64), repackCount: 17, publicationOutcome: "activated",
              observationReceiptDigest: "6".repeat(64), activateReceiptDigest: "5".repeat(64), bundleSha256: bundle.bundleSha256 };
            if (controls.sidecarMode === "tampered-lease") lease.request.owner = "production-publication:wrong:owner";
            if (controls.sidecarMode === "tampered-observation") observation.request.publicReleaseId = id("97");
            controls.receiptMutation?.(receipt); await save(receiptPath, receipt);
            if (controls.sidecarMode !== "missing-lease") await save(`${first}.lease.${leaseAttemptId}.json`, lease);
            await save(`${first}.observation.${observationSequence}.json`, observation);
            if (controls.sidecarMode === "extra-receipt") await save(`${first}.receipt.${randomUUID()}.json`, receipt);
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
const safelyRecoveryBlocked = code => error => {
  assert.equal(error.code, code); assert.doesNotMatch(error.message, /token|secret|postgres/iu); return true;
};

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
  await writeFile(file, `export const fixture = ${JSON.stringify(label)};\n`, { mode: 0o600 });
  return { path: file, sha256: rawHash(await readFile(file)) };
}
async function recoveryFixture(t) {
  const f = await fixture(t); await publish(f.options, f.deps);
  const oldRoot = f.options.artifactDirectory, run = path.join(oldRoot, f.options.head.runId);
  const pending = path.join(oldRoot, "pending"); await mkdir(pending, { mode: 0o700 });
  const pendingHead = path.join(pending, "head.json");
  await save(pendingHead, { head: f.options.head, publisherCommit: f.options.expectedPublisherCommit });
  const blocked = path.join(pending, `blocked-${randomUUID()}.json`);
  await save(blocked, { status: "blocked", code: "POST_HEAD_CHILD_FAILED" });
  const attempt = path.join(run, `attempt-${randomUUID()}`); await mkdir(attempt, { mode: 0o700 });
  const bundle = path.join(run, "bundle.json"), bundleValue = await read(bundle);
  const publishStarted = path.join(attempt, "publish.started.json"), publishStderr = path.join(attempt, "publish.stderr");
  await save(publishStarted, { phase: "publish", args: ["--publish", bundle] });
  await save(publishStderr, { status: "refused", code: "PRODUCTION_PUBLICATION_FAILED" });
  const leaseAttemptId = randomUUID(), leaseRequest = { role: "import",
    owner: `production-publication:${bundleValue.intent.operationId}:${leaseAttemptId}`, leaseMilliseconds: 900_000 };
  const leaseAttempt = `${bundle}.lease.${leaseAttemptId}.json`;
  await save(leaseAttempt, { schemaVersion: "clutchpacks_production_lease_attempt_v1",
    bundleSha256: bundleValue.bundleSha256, attemptId: leaseAttemptId, intentSha256: digest(bundleValue.intent),
    request: leaseRequest, requestSha256: digest(leaseRequest) });
  const pin = async file => ({ path: file, sha256: rawHash(await readFile(file)) });
  const old = { artifactDirectory: oldRoot, publisherWorktree: f.options.publisherWorktree,
    publisherCommit: f.options.expectedPublisherCommit, pendingHead: await pin(pendingHead),
    journal: await pin(path.join(run, "head.json")), sourceConfig: await pin(path.join(run, "source-config.json")),
    bundle: await pin(bundle), failure: { pendingBlocked: await pin(blocked), publishStarted: await pin(publishStarted),
      publishStderr: await pin(publishStderr), leaseAttempt: await pin(leaseAttempt) } };
  const publisherWorktree = path.join(f.directory, "publisher-worktree"); await mkdir(publisherWorktree, { mode: 0o700 });
  const publisherModules = {
    promoteCli: await writeModule(publisherWorktree, "scripts/live/promote-clutchpacks-production.mts", "promote"),
    convexRuntime: await writeModule(publisherWorktree, "scripts/live/clutchpacks-production-convex-runtime.mts", "runtime"),
    publicationOrchestrator: await writeModule(publisherWorktree, "scripts/live/clutchpacks-production-v3-publication.mts", "orchestrator"),
    publicationPolicy: await writeModule(publisherWorktree, "scripts/live/clutchpacks-production-publication-policy.mts", "policy"),
    genericPublisher: await writeModule(publisherWorktree, "packages/services/src/buyback-adjusted-ev-release-publisher.ts", "generic"),
  };
  await writeModule(publisherWorktree, "node_modules/tsx/dist/loader.mjs", "loader");
  const executorWorktree = path.join(f.directory, "executor-worktree"); await mkdir(executorWorktree, { mode: 0o700 });
  const executorModules = {
    recovery: await writeModule(executorWorktree, "scripts/live/clutchpacks-production-post-head-recovery.mts", "recovery"),
    postHead: await writeModule(executorWorktree, "scripts/live/clutchpacks-production-post-head.mts", "post-head"),
  };
  const publisherCommit = "b".repeat(40), executorCommit = "c".repeat(40);
  const executionDirectory = path.join(f.directory, "recovery-execution");
  const destinationDirectory = path.join(f.directory, "recovered-artifacts");
  const executorPolicyPath = path.join(f.directory, "executor-policy.json");
  const executorPolicyCore = {
    schemaVersion: "clutchpacks_production_post_head_recovery_executor_policy_v1",
    executor: { worktree: executorWorktree, commit: executorCommit, modules: executorModules },
    importedRecoveryModule: executorModules.recovery,
    publisher: { worktree: publisherWorktree, commit: publisherCommit, modules: publisherModules },
    executionDirectory, destinationDirectory,
  };
  await save(executorPolicyPath, { ...executorPolicyCore, policySha256: digest(executorPolicyCore) });
  const executorPolicy = await pin(executorPolicyPath);
  const controls = { dirty: new Set(), wrongCommit: new Map() };
  const commits = new Map([[f.options.publisherWorktree, f.options.expectedPublisherCommit],
    [publisherWorktree, publisherCommit], [executorWorktree, executorCommit]]);
  const git = async (args, options) => {
    if (args[0] === "status") return controls.dirty.has(options.cwd) ? " M tracked-file\n" : "";
    if (args[0] === "ls-files") return `${args[2]}\n`;
    if (args[1] === "HEAD") return `${controls.wrongCommit.get(options.cwd) ?? commits.get(options.cwd)}\n`;
    return `${options.cwd}\n`;
  };
  const executionInput = { schemaVersion: "clutchpacks_production_post_head_recovery_execution_v1",
    head: structuredClone(f.options.head), old: structuredClone(old),
    publisher: { worktree: publisherWorktree, commit: publisherCommit, modules: publisherModules },
    executor: { worktree: executorWorktree, commit: executorCommit, modules: executorModules },
    executorPolicy, executionDirectory, deadlineMs: 900_000 };
  const deps = { ...f.deps, git, now: () => now };
  const execute = () => executeRecovery(executionInput, deps);
  const seedInput = manifest => ({ schemaVersion: "clutchpacks_production_post_head_recovery_v1",
    head: structuredClone(f.options.head), old: { ...structuredClone(old), executionManifest: manifest },
    destination: { artifactDirectory: destinationDirectory,
      publisherWorktree, publisherCommit, baseSourceConfig: structuredClone(f.options.baseSourceConfig),
      residentAuthorityDigest: f.options.expectedResidentAuthorityDigest } });
  return { ...f, sourceControls: f.controls, oldRoot, run, attempt, old, pin, publisherWorktree, publisherCommit, publisherModules,
    executorWorktree, executorCommit, executorModules, executorPolicyPath, controls, commits, git,
    executionInput, deps, execute, seedInput };
}
async function repinJson(pin, change) {
  const value = await read(pin.path); change(value); await writeFile(pin.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  pin.sha256 = rawHash(await readFile(pin.path));
}

test("one-shot recovery executes a private bundle copy and seeds without changing the frozen old root", async t => {
  const f = await recoveryFixture(t), before = await treeEvidence(f.oldRoot);
  const executed = await f.execute();
  assert.equal(executed.status, "verified"); assert.equal(path.basename(executed.manifest.path), "execution.completed.json");
  assert.deepEqual(await treeEvidence(f.oldRoot), before);
  const publishChild = f.children.at(-1), publishOffset = publishChild.args.indexOf("--publish");
  assert.equal(publishChild.args[publishOffset + 1], path.join(f.executionInput.executionDirectory, "bundle.json"));
  assert.notEqual(publishChild.args[publishOffset + 1], f.old.bundle.path);
  const result = await recover(f.seedInput(executed.manifest), { git: f.git });
  assert.equal(result.status, "recovered"); assert.deepEqual(await treeEvidence(f.oldRoot), before);
  assert.equal((await readdir(path.dirname(result.runDirectory))).includes("pending"), false);
  const attestation = await read(path.join(result.runDirectory, "recovery-attestation.json"));
  assert.equal(attestation.recoveredAt, (await read(executed.manifest.path)).completedAt);
  assert.equal(attestation.old.executionManifest.sha256, executed.manifest.sha256);
});

test("live recovery entrypoints cannot receive dependency injection to bypass fixed policy", async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(executeRecoveryLive(f.executionInput, { ...f.deps, validateIncident: () => {} }),
    safelyRecoveryBlocked("POST_HEAD_RECOVERY_PUBLISHER_INVALID"));
  await assert.rejects(recoverLive(f.seedInput({ path: path.join(f.directory, "missing"), sha256: "0".repeat(64) }),
    { git: f.git, validateIncident: () => {} }), safelyRecoveryBlocked("POST_HEAD_RECOVERY_DESTINATION_INVALID"));
  assert.equal(f.children.length, 2); await assert.rejects(stat(f.executionInput.executionDirectory));
});

test("live executor refuses an alternate execution root even with the coherent fixed publisher", async t => {
  const f = await recoveryFixture(t), input = structuredClone(f.executionInput);
  input.publisher = { worktree: fixedPublisherWorktree, commit: fixedPublisherCommit,
    modules: structuredClone(fixedPublisherModules) };
  await assert.rejects(executeRecoveryLive(input), safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTION_PATH_INVALID"));
  assert.equal(f.children.length, 2); await assert.rejects(stat(input.executionDirectory));
});

test("live seed refuses an alternate destination root before reading a manifest", async t => {
  const f = await recoveryFixture(t), input = f.seedInput({ path: path.join(f.directory, "missing"), sha256: "0".repeat(64) });
  input.destination.publisherWorktree = fixedPublisherWorktree; input.destination.publisherCommit = fixedPublisherCommit;
  await assert.rejects(recoverLive(input), safelyRecoveryBlocked("POST_HEAD_RECOVERY_DESTINATION_INVALID"));
  await assert.rejects(stat(input.destination.artifactDirectory));
});

test("the recovery execution directory is an atomic one-use token", async t => {
  const f = await recoveryFixture(t); await f.execute(); const childCount = f.children.length;
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTION_EXISTS"));
  assert.equal(f.children.length, childCount);
});

test("recovery still refuses a missing explicit temporary directory before launch", async t => {
  const f = await recoveryFixture(t), priorTmpdir = process.env.TMPDIR;
  assert.ok(priorTmpdir);
  delete process.env.TMPDIR;
  try {
    await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTION_FAILED"));
    assert.equal(f.children.length, 2);
    await assert.rejects(stat(f.executionInput.executionDirectory));
  } finally { process.env.TMPDIR = priorTmpdir; }
});

test("executor policy refuses a coherent alternate executor checkout", async t => {
  const f = await recoveryFixture(t), alternate = path.join(f.directory, "alternate-executor");
  await mkdir(alternate, { mode: 0o700 });
  const modules = {
    recovery: await writeModule(alternate, "scripts/live/clutchpacks-production-post-head-recovery.mts", "alternate-recovery"),
    postHead: await writeModule(alternate, "scripts/live/clutchpacks-production-post-head.mts", "alternate-post-head"),
  };
  const commit = "d".repeat(40); f.commits.set(alternate, commit);
  f.executionInput.executor = { worktree: alternate, commit, modules };
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTOR_POLICY_INVALID"));
  await assert.rejects(stat(f.executionInput.executionDirectory));
});

test("executor policy refuses a different currently imported recovery module", async t => {
  const f = await recoveryFixture(t);
  await repinJson(f.executionInput.executorPolicy, value => {
    value.importedRecoveryModule = structuredClone(value.executor.modules.postHead);
    const { policySha256: _prior, ...core } = value; value.policySha256 = digest(core);
  });
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTOR_POLICY_INVALID"));
  await assert.rejects(stat(f.executionInput.executionDirectory));
});

for (const mode of ["missing-lease", "extra-receipt", "tampered-lease", "tampered-observation"]) {
  test(`recovery executor refuses ${mode} publication sidecars`, async t => {
    const f = await recoveryFixture(t); f.sourceControls.sidecarMode = mode;
    await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_SIDECAR_INVALID"));
    assert.ok((await readdir(f.executionInput.executionDirectory)).some(name => name.startsWith("blocked-")));
  });
}

test("old-root inventory detects mutation of an otherwise unlisted file during publication", async t => {
  const f = await recoveryFixture(t), extra = path.join(f.oldRoot, "unlisted-proof.json"); await save(extra, { value: 1 });
  f.sourceControls.onSpawn = () => writeFile(extra, `${JSON.stringify({ value: 2 })}\n`, { mode: 0o600 });
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_INVENTORY_CHANGED"));
});

for (const kind of ["file", "symlink"]) test(`old-root inventory detects an inserted ${kind} during publication`, async t => {
  const f = await recoveryFixture(t), inserted = path.join(f.oldRoot, `inserted-${kind}`);
  f.sourceControls.onSpawn = () => kind === "file"
    ? writeFile(inserted, "new\n", { mode: 0o600 }) : symlink(f.old.bundle.path, inserted);
  await assert.rejects(f.execute(), safelyRecoveryBlocked(kind === "file"
    ? "POST_HEAD_RECOVERY_INVENTORY_CHANGED" : "POST_HEAD_RECOVERY_INVENTORY_INVALID"));
});

for (const [name, mutate, code] of [
  ["wrong publisher commit", async f => f.controls.wrongCommit.set(f.publisherWorktree, "d".repeat(40)), "POST_HEAD_RECOVERY_EXECUTION_FAILED"],
  ["wrong publisher module", async f => { f.executionInput.publisher.modules.promoteCli.sha256 = "0".repeat(64); }, "POST_HEAD_RECOVERY_EXECUTOR_POLICY_INVALID"],
  ["wrong old bundle pin", async f => { f.executionInput.old.bundle.sha256 = "0".repeat(64); }, "POST_HEAD_RECOVERY_INPUT_CHANGED"],
  ["wrong receipt", async f => { f.sourceControls.receiptMutation = value => { value.candidate.publicReleaseId = id("98"); }; }, "POST_HEAD_RECOVERY_EXECUTION_OUTPUT_INVALID"],
]) test(`one-shot execution refuses ${name}`, async t => {
  const f = await recoveryFixture(t); await mutate(f);
  await assert.rejects(f.execute(), safelyRecoveryBlocked(code));
});

test("seed refuses a caller-provided receipt without a wrapper execution manifest", async t => {
  const f = await recoveryFixture(t), input = f.seedInput(undefined);
  input.old.receipt = { path: path.join(f.run, "invented-receipt.json"), sha256: "0".repeat(64) };
  await assert.rejects(recover(input, { git: f.git }),
    safelyRecoveryBlocked("POST_HEAD_RECOVERY_INVALID"));
  await assert.rejects(stat(input.destination.artifactDirectory));
});

test("seed refuses a repinned but internally tampered completed execution manifest", async t => {
  const f = await recoveryFixture(t), executed = await f.execute();
  const manifest = await read(executed.manifest.path); manifest.completedAt = "2026-08-31T18:01:00.000Z";
  await writeFile(executed.manifest.path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const repinned = { path: executed.manifest.path, sha256: rawHash(await readFile(executed.manifest.path)) };
  const input = f.seedInput(repinned);
  await assert.rejects(recover(input, { git: f.git }),
    safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTION_MANIFEST_INVALID"));
  await assert.rejects(stat(input.destination.artifactDirectory));
});

test("seed final fence detects an unlisted old-root mutation and retains pending", async t => {
  const f = await recoveryFixture(t), extra = path.join(f.oldRoot, "unlisted-final-fence.json"); await save(extra, { value: 1 });
  const executed = await f.execute(), input = f.seedInput(executed.manifest); let oldStatuses = 0;
  const git = async (args, options) => {
    if (options.cwd === f.options.publisherWorktree && args[0] === "status" && ++oldStatuses === 2) {
      await writeFile(extra, `${JSON.stringify({ value: 2 })}\n`, { mode: 0o600 });
    }
    return f.git(args, options);
  };
  await assert.rejects(recover(input, { git }), safelyRecoveryBlocked("POST_HEAD_RECOVERY_INVENTORY_CHANGED"));
  const pending = path.join(input.destination.artifactDirectory, "pending");
  assert.ok((await readdir(pending)).some(name => name.startsWith("blocked-")));
});

test("seed rereads the exact pending owner before unlink", async t => {
  const f = await recoveryFixture(t), executed = await f.execute(), input = f.seedInput(executed.manifest);
  let publisherStatuses = 0;
  const git = async (args, options) => {
    if (options.cwd === f.publisherWorktree && args[0] === "status" && ++publisherStatuses === 4) {
      const pendingHead = path.join(input.destination.artifactDirectory, "pending", "head.json");
      await writeFile(pendingHead, `${JSON.stringify({ owner: "changed" })}\n`, { mode: 0o600 });
    }
    return f.git(args, options);
  };
  await assert.rejects(recover(input, { git }), safelyRecoveryBlocked("POST_HEAD_RECOVERY_INPUT_CHANGED"));
  assert.ok((await readdir(path.join(input.destination.artifactDirectory, "pending"))).some(name => name.startsWith("blocked-")));
});

test("executor rejects receipt verification outside its own started/completed clock", async t => {
  const f = await recoveryFixture(t); f.deps.now = () => "2026-08-31T18:01:00.000Z";
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTION_TIME_INVALID"));
  assert.ok((await readdir(f.executionInput.executionDirectory)).some(name => name.startsWith("blocked-")));
});

test("executor refuses a symlinked failed-attempt directory before launch", async t => {
  const f = await recoveryFixture(t), moved = path.join(f.directory, "moved-attempt");
  await rename(f.attempt, moved); await symlink(moved, f.attempt);
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_EXECUTION_FAILED"));
  await assert.rejects(stat(f.executionInput.executionDirectory));
});

test("executor binds the lease filename UUID to the signed lease attempt", async t => {
  const f = await recoveryFixture(t), prior = f.executionInput.old.failure.leaseAttempt;
  const renamed = path.join(path.dirname(prior.path), `bundle.json.lease.${randomUUID()}.json`); await rename(prior.path, renamed);
  f.executionInput.old.failure.leaseAttempt = await f.pin(renamed);
  await assert.rejects(f.execute(), safelyRecoveryBlocked("POST_HEAD_RECOVERY_FAILURE_EVIDENCE_INVALID"));
  await assert.rejects(stat(f.executionInput.executionDirectory));
});
