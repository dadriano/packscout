import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
const { clutchpacksProductionRecoveryPublishShimTestHarness: harness } =
  await import("./clutchpacks-production-recovery-publish-shim.mjs");
assert.ok(harness);

const ledger = "/private/clutch-ledger";
const roots = [{ ordinal: 1, rootId: "c80f32fe-d8d7-469a-8667-5f801c082f99",
  artifactDirectory: "/private/artifact-1", proofDirectory: "/private/proof-1" },
{ ordinal: 2, rootId: "9825ddf9-5fdc-4660-b2db-51c8fc74b041",
  artifactDirectory: "/private/artifact-2", proofDirectory: "/private/proof-2" }];
const publisher = { worktree: "/publisher", commit: "7".repeat(40), modules: { pinned: true } };
const executor = { worktree: "/executor", commit: "8".repeat(40), modules: { pinned: true } };
const sourceReader = { worktree: "/source", commit: "9".repeat(40), script: { pinned: true } };
const policy = { ledgerPath: ledger, roots, publisher, executor, sourceReader };
const manifestCore = { schemaVersion: "clutchpacks_production_post_head_successor_recovery_manifest_v1",
  createdAt: "2026-09-01T07:00:00.000Z", incidentId: "c533e197-9a56-5360-a7cc-e35ad9677978",
  ledgerPath: ledger, recordsPath: `${ledger}/records`, ledgerSchemaSha256: "1".repeat(64),
  head: { liveShaped: true }, freshnessCutoff: "2026-09-02T02:52:20.539Z", old: { pinned: true },
  oldRootInventorySha256: "2".repeat(64), publisher, executor, sourceReader, roots };
const manifest = { ...manifestCore, manifestSha256: harness.sha256(harness.canonical(manifestCore)) };
const manifestBytes = Buffer.from(`${harness.canonical(manifest)}\n`);
const rawPin = { path: `${ledger}/incident-manifest.json`, sha256: harness.sha256(manifestBytes) };

test("live-shaped ledger records bind the canonical manifest-core digest while retaining the raw file pin", () => {
  assert.notEqual(rawPin.sha256, manifest.manifestSha256);
  const parsed = harness.validateIncidentManifestDocument(manifest, rawPin, policy);
  assert.doesNotThrow(() => harness.validateLedgerManifestDomain({ manifestSha256: manifest.manifestSha256,
    incidentId: manifest.incidentId, ledgerSchemaSha256: manifest.ledgerSchemaSha256 }, parsed, rawPin));
});

test("a ledger record that substitutes the raw manifest-file hash for the canonical domain digest is refused", () => {
  const parsed = harness.validateIncidentManifestDocument(manifest, rawPin, policy);
  assert.throws(() => harness.validateLedgerManifestDomain({ manifestSha256: rawPin.sha256,
    incidentId: manifest.incidentId, ledgerSchemaSha256: manifest.ledgerSchemaSha256 }, parsed, rawPin));
});

async function productionFixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "clutch-shim-production-shaped-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executorWorktree = path.join(directory, "executor"), publisherWorktree = path.join(directory, "publisher"),
    sourceWorktree = path.join(directory, "source"), ledgerPath = path.join(directory, "ledger"),
    artifactDirectory = path.join(directory, "artifact"), proofDirectory = path.join(directory, "proof"),
    secondArtifactDirectory = path.join(directory, "artifact-2"), secondProofDirectory = path.join(directory, "proof-2"),
    runDirectory = path.join(artifactDirectory, "c533e197-9a56-5360-a7cc-e35ad9677978"),
    attemptDirectory = path.join(runDirectory, "attempt-c80f32fe-d8d7-469a-8667-5f801c082f99");
  for (const value of [executorWorktree, publisherWorktree, sourceWorktree, ledgerPath,
    path.join(ledgerPath, "records"), artifactDirectory, proofDirectory, runDirectory, attemptDirectory])
    await mkdir(value, { recursive: true, mode: 0o700 });
  const writePin = async (root, relative, bytes = `fixture:${relative}\n`, mode = 0o644) => {
    const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode });
    return { path: file, sha256: harness.sha256(await readFile(file)) };
  };
  const originalShim = await readFile(new URL("./clutchpacks-production-recovery-publish-shim.mjs", import.meta.url));
  const executorModules = {
    recovery: await writePin(executorWorktree, "scripts/live/clutchpacks-production-post-head-recovery.mts"),
    postHead: await writePin(executorWorktree, "scripts/live/clutchpacks-production-post-head.mts"),
    publishShim: await writePin(executorWorktree, "scripts/live/clutchpacks-production-recovery-publish-shim.mjs", originalShim),
    runtimeInventory: await writePin(executorWorktree, "scripts/live/clutchpacks-production-runtime-inventory.mjs",
      "export async function readClutchpacksProductionRuntimeInventory(root, allowedTargetRoot) { return globalThis.__shimInventory(root, allowedTargetRoot); }\n"),
    launcher: await writePin(executorWorktree, "scripts/live/clutchpacks-production-post-head-successor-launcher.mjs"),
  };
  const publisherModules = {
    promoteCli: await writePin(publisherWorktree, "scripts/live/promote-clutchpacks-production.mts"),
    convexRuntime: await writePin(publisherWorktree, "scripts/live/clutchpacks-production-convex-runtime.mts"),
    publicationOrchestrator: await writePin(publisherWorktree, "scripts/live/clutchpacks-production-v3-publication.mts"),
    publicationPolicy: await writePin(publisherWorktree, "scripts/live/clutchpacks-production-publication-policy.mts"),
    genericPublisher: await writePin(publisherWorktree,
      "packages/services/src/buyback-adjusted-ev-release-publisher.ts"),
    sourceReader: await writePin(publisherWorktree, "scripts/live/clutchpacks-production-source-reader.mts"),
    servicesIndex: await writePin(publisherWorktree, "packages/services/src/index.ts"),
  };
  const executable = await writePin(directory, "sealed-node", "fixture:sealed-node\n", 0o755),
    loader = await writePin(publisherWorktree, "node_modules/tsx/dist/loader.mjs"),
    sourceScript = await writePin(sourceWorktree, "scripts/live/run-clutchpacks-production-poller.mts"),
    sourcePolicy = await writePin(sourceWorktree, "source-policy.json", "fixture:source-policy.json\n", 0o600),
    sourceExecutable = executable,
    sourceLoader = await writePin(sourceWorktree, "node_modules/tsx/dist/loader.mjs");
  const inventory = (root, allowedTargetRoot, treeSha256) => ({
    schemaVersion: "clutchpacks_production_runtime_inventory_v1", root, allowedTargetRoot,
    entryCount: 2, fileCount: 1, directoryCount: 1, symlinkCount: 0, totalBytes: 1, treeSha256,
  });
  const publisherInventory = inventory(path.join(publisherWorktree, "node_modules"), publisherWorktree, "3".repeat(64));
  const executorInventory = inventory(path.join(executorWorktree, "node_modules"), executorWorktree, "4".repeat(64));
  const sourceInventory = inventory(path.join(sourceWorktree, "node_modules"), sourceWorktree, "5".repeat(64));
  const publisherIdentity = { worktree: publisherWorktree, commit: "7".repeat(40), modules: publisherModules };
  const executorIdentity = { worktree: executorWorktree, commit: "8".repeat(40), modules: executorModules };
  const sourceIdentity = { worktree: sourceWorktree, commit: "9".repeat(40), script: sourceScript,
    policy: sourcePolicy, executable: sourceExecutable, loader: sourceLoader, runtimeInventory: sourceInventory };
  const rootsValue = [{ ordinal: 1, rootId: "c80f32fe-d8d7-469a-8667-5f801c082f99",
    artifactDirectory, proofDirectory }, { ordinal: 2, rootId: "9825ddf9-5fdc-4660-b2db-51c8fc74b041",
    artifactDirectory: secondArtifactDirectory, proofDirectory: secondProofDirectory }];
  const manifestCoreValue = { schemaVersion: "clutchpacks_production_post_head_successor_recovery_manifest_v1",
    createdAt: "2026-09-01T07:00:00.000Z", incidentId: "c533e197-9a56-5360-a7cc-e35ad9677978",
    ledgerPath, recordsPath: path.join(ledgerPath, "records"), ledgerSchemaSha256: "1".repeat(64),
    head: { pinned: true }, freshnessCutoff: "2026-09-02T02:52:20.539Z", old: { immutable: true },
    oldRootInventorySha256: "2".repeat(64), publisher: publisherIdentity, executor: executorIdentity,
    sourceReader: sourceIdentity, roots: rootsValue };
  const manifestValue = { ...manifestCoreValue, manifestSha256: harness.sha256(harness.canonical(manifestCoreValue)) };
  const manifestPath = path.join(ledgerPath, "incident-manifest.json");
  await writeFile(manifestPath, `${harness.canonical(manifestValue)}\n`, { mode: 0o600 });
  const manifestPin = { path: manifestPath, sha256: harness.sha256(await readFile(manifestPath)) };
  const environment = { HOME: "/Users/lains", NODE_ENV: "production",
    PATH: "/Users/lains/.hermes/node/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: path.join(directory, "tmp") };
  const policyCoreValue = { schemaVersion: "clutchpacks_production_post_head_recovery_executor_policy_v1",
    executor: executorIdentity, importedRecoveryModule: executorModules.recovery, publisher: publisherIdentity,
    executable, loader, runtimeInventory: publisherInventory, executorRuntimeInventory: executorInventory,
    sourceReader: sourceIdentity, environment, incidentManifest: manifestPin, ledgerPath, roots: rootsValue };
  const policyValue = { ...policyCoreValue, policySha256: harness.sha256(harness.canonical(policyCoreValue)) };
  const policyPath = path.join(ledgerPath, "executor-policy.json");
  await writeFile(policyPath, `${harness.canonical(policyValue)}\n`, { mode: 0o600 });
  const policySha256 = harness.sha256(await readFile(policyPath));
  const bundlePath = path.join(runDirectory, "bundle.json"); await writeFile(bundlePath, "sealed-bundle\n", { mode: 0o600 });
  const handshakePath = path.join(attemptDirectory, "publish.lock-acquired.json"),
    continuePath = path.join(attemptDirectory, "publish.continue.json"), now = "2026-09-01T07:00:01.000Z";
  const events = []; let runtimeChanged = false;
  const inventories = new Map([[publisherInventory.root, publisherInventory],
    [executorInventory.root, executorInventory], [sourceInventory.root, sourceInventory]]);
  const checkout = identity => {
    const core = { worktree: identity.worktree, commit: identity.commit, cleanStatusSha256: harness.sha256(""),
      trackedFilesSha256: "6".repeat(64), verifiedAt: now };
    return { ...core, proofSha256: harness.sha256(harness.canonical(core)) };
  };
  let hook = options.hook;
  const dependencies = {
    now: () => now, sleep: async () => undefined,
    loadRuntimeInventoryModule: async () => ({ readClutchpacksProductionRuntimeInventory: async root => {
      const value = structuredClone(inventories.get(root));
      if (runtimeChanged && root === publisherInventory.root) value.treeSha256 = "f".repeat(64);
      return value;
    } }),
    verifyCheckout: async (identity, _modules, receivedEnvironment) => {
      assert.deepEqual(receivedEnvironment, environment);
      assert.deepEqual(Object.keys(receivedEnvironment).sort(), ["HOME", "NODE_ENV", "PATH", "TMPDIR"]);
      events.push(`checkout:${path.basename(identity.worktree)}`); return checkout(identity);
    },
    registerLoader: () => events.push("register"),
    loadCli: async () => ({ runClutchpacksProductionCli: async (args, env) => {
      events.push("publish"); assert.deepEqual(args, ["--publish", bundlePath]); assert.deepEqual(env, environment);
      return { status: "verified", fixture: true };
    } }), writeStdout: value => events.push(`stdout:${value}`),
    afterHandshake: async context => {
      const head = { providerId: "14787a87-77c0-5771-bfe1-cd5507bf2881",
        configId: "de37fd7f-4461-4df1-86e6-6609486df4b7", configNumber: "4",
        runId: "c533e197-9a56-5360-a7cc-e35ad9677978", checkpointHash: "a".repeat(64), generation: "87",
        runtimeRowVersion: "880", headFinishedAt: "2026-09-01T02:52:20.539Z", authorityDigest: "b".repeat(64) };
      const sourcePreDispatch = { startedAt: now, completedAt: now, snapshot: { ...head, runtimeState: "idle",
        disposition: "due", importLeaseOwned: false, assertionProvenance: {
          headAndImportLease: "clutchpacks_poller_check_only_v1",
          noActiveOrActionableWork: "continuous_decision_due_v1" } } };
      const active = { generation: 25, publicReleaseId: "e6525685-89eb-8c5b-8ebf-e82d319ca1ff",
        releaseFingerprint: "c".repeat(64) }, previous = {
        publicReleaseId: "dd5597c1-7caf-85ae-84b4-28939255e4ef", releaseFingerprint: "d".repeat(64) };
      const targetPreDispatch = { startedAt: now, completedAt: now, snapshot: { active, previous,
        activeStatus: { publicReleaseId: active.publicReleaseId, releaseFingerprint: active.releaseFingerprint,
          lifecycle: "complete" }, previousStatus: { ...previous, lifecycle: "complete" }, candidateStatus: null,
        assertionProvenance: { activeChain: "signed_active_state_double_read_v1",
          lifecycle: "signed_release_status_projection_v1", stagingExclusion: "publisher_start_cas_v1" } } };
      const residencyPreDispatch = { label: "com.packscout.provider-import.clutchpacks", port: 56_432,
        launchdUnloaded: true, residentProcessCount: 0, portBound: true, acquiredAt: now, checkedAt: now };
      const handshakePin = { path: handshakePath, sha256: harness.sha256(await readFile(handshakePath)) };
      const payload = { phase: "direct", attemptDirectory, handshake: handshakePin,
        sourcePreDispatch, targetPreDispatch, residencyPreDispatch };
      const claimCore = { schemaVersion: "clutchpacks_production_post_head_successor_ledger_record_v1",
        sequence: 0, previousRecordSha256: null, manifestSha256: manifestValue.manifestSha256,
        ledgerSchemaSha256: manifestValue.ledgerSchemaSha256, incidentId: manifestValue.incidentId,
        recordedAt: now, ordinal: 1, root: rootsValue[0], event: "attempt_claimed",
        payload: { artifactRootAbsent: true, proofRootAbsent: true } };
      const claim = { ...claimCore, recordSha256: harness.sha256(harness.canonical(claimCore)) };
      const claimPath = path.join(ledgerPath, "records", "000000.json");
      await writeFile(claimPath, `${harness.canonical(claim)}\n`, { mode: 0o600 });
      const recordCore = { schemaVersion: "clutchpacks_production_post_head_successor_ledger_record_v1",
        sequence: options.recordSequence ?? 1, previousRecordSha256: claim.recordSha256,
        manifestSha256: manifestValue.manifestSha256, ledgerSchemaSha256: manifestValue.ledgerSchemaSha256,
        incidentId: manifestValue.incidentId, recordedAt: now, ordinal: 1, root: rootsValue[0],
        event: "direct_dispatched", payload };
      const record = { ...recordCore, recordSha256: harness.sha256(harness.canonical(recordCore)) };
      const recordPath = path.join(ledgerPath, "records", "000001.json");
      await writeFile(recordPath, `${harness.canonical(record)}\n`, { mode: 0o600 });
      const ledgerRecord = { path: recordPath, sha256: harness.sha256(await readFile(recordPath)) };
      const tokenCore = { schemaVersion: "clutchpacks_production_post_head_recovery_continue_v1", createdAt: now,
        attemptDirectory, bundle: context.lockProof.bundle, handshake: handshakePin,
        executorPolicy: { path: policyPath, sha256: policySha256 }, sourcePreDispatch, targetPreDispatch,
        residencyPreDispatch, ledgerRecord };
      const token = { ...tokenCore, tokenSha256: harness.sha256(harness.canonical(tokenCore)) };
      await hook?.({ ...context, cliPath: publisherModules.promoteCli.path, bundlePath, policyPath, manifestPath });
      await writeFile(continuePath, `${harness.canonical(token)}\n`, { mode: 0o600 });
    },
    afterPrePublicationInventory: async () => {
      if (options.mutateUnpinnedRuntimeAfterInventory) runtimeChanged = true;
      if (options.mutateOlderRecordAfterInventory) {
        const claimPath = path.join(ledgerPath, "records", "000000.json"), claim = JSON.parse(await readFile(claimPath));
        claim.payload.artifactRootAbsent = false;
        await writeFile(claimPath, `${harness.canonical(claim)}\n`, { mode: 0o600 });
      }
    },
  };
  const runtime = { argv: [executable.path, executorModules.publishShim.path, "--publish", bundlePath, "--policy",
    policyPath, "--policy-sha256", policySha256, "--handshake", handshakePath, "--continue", continuePath],
  execArgv: [], environment, execPath: executable.path, modulePath: executorModules.publishShim.path, pid: 43210 };
  return { runtime, dependencies, events, paths: { bundlePath, policyPath, manifestPath, continuePath }, policyValue };
}

test("sealed shim accepts one production-shaped offline dispatch only after lock, token, ledger, and fresh closure proofs", async t => {
  const fixture = await productionFixture(t);
  await harness.execute(fixture.runtime, fixture.dependencies);
  assert.equal(fixture.events.filter(event => event.startsWith("checkout:")).length, 9);
  assert.ok(fixture.events.indexOf("register") < fixture.events.indexOf("publish"));
  assert.equal(fixture.events.at(-1), 'stdout:{"fixture":true,"status":"verified"}');
});

test("sealed shim strips the exact macOS injection before every checkout and the child CLI",
  { skip: process.platform !== "darwin" }, async t => {
    const fixture = await productionFixture(t), uid = process.getuid();
    fixture.runtime.environment = { ...fixture.runtime.environment,
      __CF_USER_TEXT_ENCODING: `0x${uid.toString(16).toUpperCase()}:0x0:0x0` };
    await harness.execute(fixture.runtime, fixture.dependencies);
    assert.equal(fixture.events.filter(event => event.startsWith("checkout:")).length, 9);
    assert.equal(fixture.events.includes("publish"), true);
  });

test("sealed shim refuses argv, environment, ledger sequence, and mutation during the handshake window", async t => {
  await t.test("argv", async child => {
    const f = await productionFixture(child); f.runtime.argv[2] = "--prepare";
    await assert.rejects(harness.execute(f.runtime, f.dependencies)); assert.deepEqual(f.events, []);
  });
  await t.test("environment", async child => {
    const f = await productionFixture(child); f.runtime.environment.NODE_OPTIONS = "--import=/tmp/hook.mjs";
    await assert.rejects(harness.execute(f.runtime, f.dependencies)); assert.equal(f.events.includes("publish"), false);
  });
  await t.test("record sequence", async child => {
    const f = await productionFixture(child, { recordSequence: 2 });
    await assert.rejects(harness.execute(f.runtime, f.dependencies)); assert.equal(f.events.includes("publish"), false);
  });
  await t.test("post-handshake CLI mutation", async child => {
    const f = await productionFixture(child, { hook: async ({ cliPath }) => writeFile(cliPath, "tampered\n", { mode: 0o600 }) });
    await assert.rejects(harness.execute(f.runtime, f.dependencies));
    assert.equal(f.events.includes("register"), false); assert.equal(f.events.includes("publish"), false);
  });
  await t.test("group-writable tracked CLI", async child => {
    const f = await productionFixture(child, { hook: async ({ cliPath }) => chmod(cliPath, 0o664) });
    await assert.rejects(harness.execute(f.runtime, f.dependencies));
    assert.equal(f.events.includes("register"), false); assert.equal(f.events.includes("publish"), false);
  });
  await t.test("symlinked tracked CLI", async child => {
    const f = await productionFixture(child, { hook: async ({ cliPath }) => {
      const replacement = `${cliPath}.replacement`; await writeFile(replacement, await readFile(cliPath), { mode: 0o644 });
      await unlink(cliPath); await symlink(replacement, cliPath);
    } });
    await assert.rejects(harness.execute(f.runtime, f.dependencies));
    assert.equal(f.events.includes("register"), false); assert.equal(f.events.includes("publish"), false);
  });
  await t.test("unpinned runtime mutation after the first final inventory scan", async child => {
    const f = await productionFixture(child, { mutateUnpinnedRuntimeAfterInventory: true });
    await assert.rejects(harness.execute(f.runtime, f.dependencies));
    assert.equal(f.events.includes("register"), false); assert.equal(f.events.includes("publish"), false);
  });
  await t.test("an older ledger record cannot drift while retaining its stored digest", async child => {
    const f = await productionFixture(child, { mutateOlderRecordAfterInventory: true });
    await assert.rejects(harness.execute(f.runtime, f.dependencies));
    assert.equal(f.events.includes("register"), false); assert.equal(f.events.includes("publish"), false);
  });
});
