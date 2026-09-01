import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const EXECUTOR = "/Users/lains/Projects/packscout/.worktrees/clutch-c533-publication-recovery";
const PUBLISHER = "/Users/lains/Projects/packscout/.worktrees/clutchpacks-runtime-open-retry";
const SOURCE = "/Users/lains/Projects/packscout/.worktrees/clutch-minute-polling";
const OLD_ROOT = "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-successor-20260901T011542Z-7454390-126d1069";
const LEDGER = "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533e197-9a56-5360-a7cc-e35ad9677978-successor-recovery-ledger-v1";
const RECORDS = path.join(LEDGER, "records");
const RUN_ID = "c533e197-9a56-5360-a7cc-e35ad9677978";
const OLD_ATTEMPT_ID = "c1f1602d-d61d-4699-84cc-a0bd8a3f86c4";
const PUBLISHER_COMMIT = "7454390f7bc85648f38320f8d52451f63a899422";
const SOURCE_COMMIT = "c4d6bf21cddde7155d1f6ebb1b979c69910d21dd";
const LEDGER_SCHEMA_SHA256 = "6d1414761b3dad2358b9287386731b8c503bde4293d93c83f0687ec9725b6e10";
const FRESHNESS_CUTOFF = "2026-09-02T02:52:20.539Z";
const NODE = "/Users/lains/.hermes/node/bin/node";
const NODE_SHA256 = "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c";
const SOURCE_POLICY = "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutchpacks-production-poller-successor-20260901T011542Z-7454390-126d1069.json";
const SOURCE_POLICY_SHA256 = "49a9e30f7b9cf09d7951da7963dede5e93a8a0b8bb91fb35cc7d5182ca9700c0";
const TMPDIR = "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-successor-tmp-c533e197-v1";
const PREPARER = path.join(EXECUTOR, "scripts/live/prepare-clutchpacks-production-post-head-successor-ledger.mjs");
const HEAD = Object.freeze({ providerId: "14787a87-77c0-5771-bfe1-cd5507bf2881",
  configId: "de37fd7f-4461-4df1-86e6-6609486df4b7", configNumber: "4", runId: RUN_ID,
  checkpointHash: "21d42b7688028e0e4fd95b2564dc5975ef32fa01ce2beec032c3beceb384e76f",
  generation: "87", runtimeRowVersion: "880", headFinishedAt: "2026-09-01T02:52:20.539Z",
  authorityDigest: "5cc97f73ecefa4e93b7706e37a3dd00a6fddf3b4c397eca9ec4b6bcc01b26384" });
const PREVIOUS = Object.freeze({ publicReleaseId: "dd5597c1-7caf-85ae-84b4-28939255e4ef",
  releaseFingerprint: "aaedc8ecfe45fb920fbfcd94c13f9d486ced2803cd2387c06ff39be8e0d8e024" });
const ROOTS = Object.freeze([
  Object.freeze({ ordinal: 1, rootId: "c80f32fe-d8d7-469a-8667-5f801c082f99",
    artifactDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-c533-recovery-1-20260901T065004Z-c80f32fe",
    proofDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publication-proofs-c533-recovery-1-20260901T065004Z-c80f32fe" }),
  Object.freeze({ ordinal: 2, rootId: "9825ddf9-5fdc-4660-b2db-51c8fc74b041",
    artifactDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-c533-recovery-2-20260901T065004Z-9825ddf9",
    proofDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publication-proofs-c533-recovery-2-20260901T065004Z-9825ddf9" }),
]);
const TARGET_CHAIN = Object.freeze({
  authenticatedPreflight: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.json", sha256: "ccfe601f5aebcd107374980e78796cc3337f2e7790624ee2fd2b62291b68494b" }),
  preflightScript: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.mjs", sha256: "98f8426710d0ebb02360fca3a78b38009e9a1145764979f9e5c6137436ab835d" }),
  preflightStderr: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.stderr", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }),
  predecessorBundle: Object.freeze({ path: `${OLD_ROOT}/5ee207cb-2608-5f47-a6db-0a16deb2682a/bundle.json`, sha256: "0a0af154538c1feaa78fa279c2988dfd718cdf5a51f5b641d59a5d158e71e5d8" }),
  predecessorReceipt: Object.freeze({ path: `${OLD_ROOT}/5ee207cb-2608-5f47-a6db-0a16deb2682a/bundle.json.receipt.b209365f-b9f3-421b-be2d-2a2da3f05a13.json`, sha256: "2980cefc2db5977b074d65a3227730922b251990fb44a3202395c45e8c9f07ae" }),
});
const PUBLISHER_MODULES = Object.freeze({ promoteCli: "scripts/live/promote-clutchpacks-production.mts",
  convexRuntime: "scripts/live/clutchpacks-production-convex-runtime.mts",
  publicationOrchestrator: "scripts/live/clutchpacks-production-v3-publication.mts",
  publicationPolicy: "scripts/live/clutchpacks-production-publication-policy.mts",
  genericPublisher: "packages/services/src/buyback-adjusted-ev-release-publisher.ts",
  sourceReader: "scripts/live/clutchpacks-production-source-reader.mts", servicesIndex: "packages/services/src/index.ts" });
const EXECUTOR_MODULES = Object.freeze({ recovery: "scripts/live/clutchpacks-production-post-head-recovery.mts",
  postHead: "scripts/live/clutchpacks-production-post-head.mts",
  publishShim: "scripts/live/clutchpacks-production-recovery-publish-shim.mjs",
  runtimeInventory: "scripts/live/clutchpacks-production-runtime-inventory.mjs",
  launcher: "scripts/live/clutchpacks-production-post-head-successor-launcher.mjs" });
const ENVIRONMENT = Object.freeze({ HOME: "/Users/lains", NODE_ENV: "production",
  PATH: "/Users/lains/.hermes/node/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR });
const ENVIRONMENT_KEYS = Object.freeze(Object.keys(ENVIRONMENT).sort());

class PreparationRefusal extends Error {
  constructor() { super("CLUTCHPACKS_C533_SUCCESSOR_PREPARATION_REFUSED"); }
}
function refuse() { throw new PreparationRefusal(); }
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") refuse();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function same(left, right) { return canonical(left) === canonical(right); }
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const hashBytes = value => createHash("sha256").update(value).digest("hex");
const jsonBytes = value => Buffer.from(`${canonical(value)}\n`);
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function frozenAttemptDirectory(run) {
  if (await exists(path.join(run, OLD_ATTEMPT_ID))) refuse();
  return path.join(run, `attempt-${OLD_ATTEMPT_ID}`);
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateDirectory(directory, create = false) {
  if (create) {
    let created = true;
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; created = false; });
    if (created) await syncDirectory(path.dirname(directory));
  }
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.() ||
    (value.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) refuse();
}
async function readPrivate(file, maximum = 256 * 1024 * 1024, minimum = 1, exactMode = false) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return refuse(); }
  try {
    const before = await handle.stat(), outside = await lstat(file);
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o022) !== 0 ||
      (exactMode && ((before.mode & 0o777) !== 0o600 || before.nlink !== 1)) || before.size < minimum ||
      before.size > maximum || before.dev !== outside.dev || before.ino !== outside.ino || before.size !== outside.size) refuse();
    const bytes = await handle.readFile(); if (bytes.length !== before.size) refuse(); return bytes;
  } finally { await handle.close(); }
}
async function pin(file, maximum, minimum = 1, exactMode = false) {
  return { path: file, sha256: hashBytes(await readPrivate(file, maximum, minimum, exactMode)) };
}
async function requirePin(expected, maximum = 256 * 1024 * 1024, minimum = 1, exactMode = false) {
  const actual = await pin(expected.path, maximum, minimum, exactMode);
  if (actual.sha256 !== expected.sha256) refuse(); return actual;
}
async function cleanupInstallTemps(directory) {
  const pattern = /^\.clutchpacks-c533-prepare-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;
  const names = (await readdir(directory)).filter(name => pattern.test(name));
  if (names.length > 4) refuse();
  for (const name of names) {
    const file = path.join(directory, name), value = await lstat(file);
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() ||
      (value.mode & 0o777) !== 0o600 || value.size > 8 * 1024 * 1024 || value.nlink < 1 || value.nlink > 2) refuse();
    await unlink(file);
  }
  if (names.length > 0) await syncDirectory(directory);
}
async function installOrValidate(file, bytes) {
  if (await exists(file)) {
    if (!Buffer.from(await readPrivate(file, Math.max(bytes.length, 1), bytes.length, true)).equals(bytes)) refuse();
    return;
  }
  const temporary = path.join(path.dirname(file), `.clutchpacks-c533-prepare-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await link(temporary, file); await syncDirectory(path.dirname(file));
  } finally {
    await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined);
    await syncDirectory(path.dirname(file)).catch(() => undefined);
  }
}
async function installLedger(settings, documents) {
  for (const reserved of settings.reservedPaths) if (await exists(reserved)) refuse();
  await privateDirectory(path.dirname(settings.ledger));
  await privateDirectory(settings.ledger, true); await cleanupInstallTemps(settings.ledger);
  const allowed = new Set(["records", ...Object.keys(documents)]);
  if ((await readdir(settings.ledger)).some(name => !allowed.has(name))) refuse();
  await privateDirectory(settings.records, true);
  if ((await readdir(settings.records)).length !== 0) refuse();
  for (const [name, bytes] of Object.entries(documents)) await installOrValidate(path.join(settings.ledger, name), bytes);
  if ((await readdir(settings.ledger)).sort().join("\n") !== [...allowed].sort().join("\n")) refuse();
  await syncDirectory(settings.records); await syncDirectory(settings.ledger);
}
async function git(worktree, args) {
  return (await promisify(execFile)("/usr/bin/git", args, { cwd: worktree,
    env: { HOME: "/Users/lains", PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
async function identity(worktree, expectedCommit, modules) {
  const [top, head, status] = await Promise.all([git(worktree, ["rev-parse", "--show-toplevel"]),
    git(worktree, ["rev-parse", "HEAD"]), git(worktree, ["status", "--porcelain=v1", "--untracked-files=normal"])]);
  if (top.trim() !== worktree || head.trim() !== expectedCommit || status !== "") refuse();
  const pins = {};
  for (const [name, relative] of Object.entries(modules)) {
    if ((await git(worktree, ["ls-files", "--error-unmatch", relative])).trim() !== relative) refuse();
    pins[name] = await pin(path.join(worktree, relative), 8 * 1024 * 1024);
  }
  return { worktree, commit: expectedCommit, modules: pins };
}
function parseRuntime(runtime) {
  const expected = ["--executor-commit", null, "--launcher-sha256", null, "--preparer-sha256", null,
    "--created-at", null];
  const argv = runtime.argv;
  if (!Array.isArray(argv) || !Array.isArray(runtime.execArgv) || runtime.execArgv.length !== 0 ||
    runtime.execPath !== NODE || runtime.cwd !== EXECUTOR || runtime.modulePath !== PREPARER ||
    !same(runtime.environment, ENVIRONMENT) ||
    !same(Object.keys(runtime.environment ?? {}).sort(), ENVIRONMENT_KEYS) ||
    argv.length !== expected.length + 2 || argv[0] !== NODE || argv[1] !== PREPARER) refuse();
  for (let index = 0; index < expected.length; index += 1)
    if (expected[index] !== null && argv[index + 2] !== expected[index]) refuse();
  const executorCommit = argv[3], launcherSha256 = argv[5], preparerSha256 = argv[7], createdAt = argv[9];
  if (!/^[a-f0-9]{40}$/u.test(executorCommit) || !/^[a-f0-9]{64}$/u.test(launcherSha256) ||
    !/^[a-f0-9]{64}$/u.test(preparerSha256) ||
    !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt ||
    Date.parse(createdAt) >= Date.parse(FRESHNESS_CUTOFF)) refuse();
  return { executorCommit, launcherSha256, preparerSha256, createdAt };
}
async function verifySelfPin(expectedSha256) {
  const bytes = await readPrivate(PREPARER, 1024 * 1024);
  if (hashBytes(bytes) !== expectedSha256 || await realpath(PREPARER) !== PREPARER) refuse();
  return { path: PREPARER, sha256: expectedSha256 };
}
async function loadRuntimeInventoryReader(runtimePin) {
  const first = await readPrivate(runtimePin.path, 1024 * 1024);
  if (hashBytes(first) !== runtimePin.sha256) refuse();
  const bytes = await readPrivate(runtimePin.path, 1024 * 1024);
  if (hashBytes(bytes) !== runtimePin.sha256 || !bytes.equals(first)) refuse();
  const loaded = await import(`data:text/javascript;base64,${bytes.toString("base64")}#${runtimePin.sha256}`);
  const reader = loaded?.readClutchpacksProductionRuntimeInventory;
  if (typeof reader !== "function") refuse();
  return reader;
}
function buildSealedDocuments({ manifestCore, executorPolicyCore, launchPolicyCore }) {
  const manifest = { ...manifestCore, manifestSha256: digest(manifestCore) }, manifestBytes = jsonBytes(manifest);
  const incidentManifest = { path: path.join(manifestCore.ledgerPath, "incident-manifest.json"),
    sha256: hashBytes(manifestBytes) };
  const boundExecutorPolicyCore = { ...executorPolicyCore, incidentManifest };
  const executorPolicy = { ...boundExecutorPolicyCore, policySha256: digest(boundExecutorPolicyCore) };
  const executorPolicyBytes = jsonBytes(executorPolicy), executorPolicyPin = {
    path: path.join(manifestCore.ledgerPath, "executor-policy.json"), sha256: hashBytes(executorPolicyBytes) };
  const launchPolicy = { ...launchPolicyCore, executorPolicy: executorPolicyPin, incidentManifest };
  return { documents: { "incident-manifest.json": manifestBytes, "executor-policy.json": executorPolicyBytes,
    "launch-policy.json": jsonBytes(launchPolicy) }, manifest, executorPolicy, launchPolicy };
}
async function productionDocuments(args) {
  if (Date.now() >= Date.parse(FRESHNESS_CUTOFF)) refuse();
  await verifySelfPin(args.preparerSha256);
  const executor = await identity(EXECUTOR, args.executorCommit, EXECUTOR_MODULES);
  if ((await git(EXECUTOR, ["ls-files", "--error-unmatch", path.relative(EXECUTOR, PREPARER)])).trim() !==
    path.relative(EXECUTOR, PREPARER)) refuse();
  await verifySelfPin(args.preparerSha256);
  const readRuntimeInventory = await loadRuntimeInventoryReader(executor.modules.runtimeInventory);
  const publisher = await identity(PUBLISHER, PUBLISHER_COMMIT, PUBLISHER_MODULES);
  if (executor.modules.launcher.sha256 !== args.launcherSha256) refuse();
  const sourceScript = await pin(path.join(SOURCE, "scripts/live/run-clutchpacks-production-poller.mts"), 8 * 1024 * 1024);
  if ((await git(SOURCE, ["rev-parse", "--show-toplevel"])).trim() !== SOURCE ||
    (await git(SOURCE, ["rev-parse", "HEAD"])).trim() !== SOURCE_COMMIT ||
    await git(SOURCE, ["status", "--porcelain=v1", "--untracked-files=normal"]) !== "" ||
    (await git(SOURCE, ["ls-files", "--error-unmatch", "scripts/live/run-clutchpacks-production-poller.mts"])).trim() !==
      "scripts/live/run-clutchpacks-production-poller.mts") refuse();
  if (sourceScript.sha256 !== "ba85446bcc7f5a7f24adb7b924d4dd667e746febd1f959c330e4de8dc840d6f0") refuse();
  const [nodePin, publisherLoader, sourceLoader, sourcePolicy, publisherRuntime, executorRuntime, sourceRuntime] = await Promise.all([
    requirePin({ path: NODE, sha256: NODE_SHA256 }), pin(path.join(PUBLISHER, "node_modules/tsx/dist/loader.mjs"), 8 * 1024 * 1024),
    requirePin({ path: path.join(SOURCE, "node_modules/tsx/dist/loader.mjs"), sha256: "274e965b148911ea8ccd08923aecf1b898e46db70c8c5a5071b1cc6035f5851d" }, 8 * 1024 * 1024),
    requirePin({ path: SOURCE_POLICY, sha256: SOURCE_POLICY_SHA256 }, 1_048_576, 1, true),
    readRuntimeInventory(path.join(PUBLISHER, "node_modules"), PUBLISHER),
    readRuntimeInventory(path.join(EXECUTOR, "node_modules"), EXECUTOR),
    readRuntimeInventory(path.join(SOURCE, "node_modules"), SOURCE),
  ]);
  for (const item of Object.values(TARGET_CHAIN)) await requirePin(item, 128 * 1024 * 1024,
    item === TARGET_CHAIN.preflightStderr ? 0 : 1, true);
  const run = path.join(OLD_ROOT, RUN_ID), attempt = await frozenAttemptDirectory(run),
    pending = path.join(OLD_ROOT, "pending");
  const pendingNames = (await readdir(pending)).sort(), blocked = pendingNames.find(name => name.startsWith("blocked-"));
  if (!blocked || pendingNames.length !== 2 || !pendingNames.includes("head.json")) refuse();
  const old = { artifactDirectory: OLD_ROOT, publisherWorktree: PUBLISHER, publisherCommit: PUBLISHER_COMMIT,
    pendingHead: await requirePin({ path: path.join(pending, "head.json"), sha256: "775dae39249407d3718da5cad190644099590ed9458971da6af2cc43dd518029" }, 65_536, 1, true),
    journal: await pin(path.join(run, "head.json"), 65_536, 1, true),
    sourceConfig: await pin(path.join(run, "source-config.json"), 1_048_576, 1, true),
    bundle: await pin(path.join(run, "bundle.json"), 128 * 1024 * 1024, 1, true), targetPrevious: PREVIOUS,
    targetChain: TARGET_CHAIN,
    failure: { pendingBlocked: await requirePin({ path: path.join(pending, blocked), sha256: "9f186ae8b523973d3684c33189901417e8bf12bbffffb77ae481f0995f6c1046" }, 65_536, 1, true),
      prepared: await pin(path.join(run, "prepared.json"), 65_536, 1, true),
      prepareStarted: await pin(path.join(attempt, "prepare.started.json"), 65_536, 1, true),
      prepareStdout: await pin(path.join(attempt, "prepare.stdout"), 65_536, 1, true),
      prepareStderr: await pin(path.join(attempt, "prepare.stderr"), 65_536, 0, true),
      prepareCompleted: await pin(path.join(attempt, "prepare.completed.json"), 65_536, 1, true),
      publishStarted: await pin(path.join(attempt, "publish.started.json"), 65_536, 1, true),
      publishStdout: await pin(path.join(attempt, "publish.stdout"), 65_536, 0, true),
      publishStderr: await pin(path.join(attempt, "publish.stderr"), 65_536, 1, true) } };
  const finalExecutor = await identity(EXECUTOR, args.executorCommit, EXECUTOR_MODULES);
  const finalPublisher = await identity(PUBLISHER, PUBLISHER_COMMIT, PUBLISHER_MODULES);
  if (!same(finalExecutor, executor) || !same(finalPublisher, publisher) ||
    (await git(EXECUTOR, ["ls-files", "--error-unmatch", path.relative(EXECUTOR, PREPARER)])).trim() !==
      path.relative(EXECUTOR, PREPARER) || (await git(SOURCE, ["rev-parse", "--show-toplevel"])).trim() !== SOURCE ||
    (await git(SOURCE, ["rev-parse", "HEAD"])).trim() !== SOURCE_COMMIT ||
    await git(SOURCE, ["status", "--porcelain=v1", "--untracked-files=normal"]) !== "" ||
    !same(await verifySelfPin(args.preparerSha256), { path: PREPARER, sha256: args.preparerSha256 }) ||
    !same(await requirePin(publisherLoader, 8 * 1024 * 1024), publisherLoader) ||
    !same(await requirePin(sourceLoader, 8 * 1024 * 1024), sourceLoader) ||
    !same(await requirePin(executor.modules.recovery, 8 * 1024 * 1024), executor.modules.recovery)) refuse();
  const finalRuntimeReader = await loadRuntimeInventoryReader(finalExecutor.modules.runtimeInventory);
  const [finalPublisherRuntime, finalExecutorRuntime, finalSourceRuntime] = await Promise.all([
    finalRuntimeReader(path.join(PUBLISHER, "node_modules"), PUBLISHER),
    finalRuntimeReader(path.join(EXECUTOR, "node_modules"), EXECUTOR),
    finalRuntimeReader(path.join(SOURCE, "node_modules"), SOURCE),
  ]);
  if (!same(finalPublisherRuntime, publisherRuntime) || !same(finalExecutorRuntime, executorRuntime) ||
    !same(finalSourceRuntime, sourceRuntime)) refuse();
  await Promise.all([
    verifySelfPin(args.preparerSha256), requirePin(nodePin), requirePin(publisherLoader, 8 * 1024 * 1024),
    requirePin(sourceLoader, 8 * 1024 * 1024), requirePin(sourcePolicy, 1_048_576, 1, true),
    ...Object.values(finalExecutor.modules).map(item => requirePin(item, 8 * 1024 * 1024)),
    ...Object.values(finalPublisher.modules).map(item => requirePin(item, 8 * 1024 * 1024)),
    requirePin(sourceScript, 8 * 1024 * 1024),
  ]);
  register(pathToFileURL(publisherLoader.path), import.meta.url);
  const loaded = await import(pathToFileURL(executor.modules.recovery.path).href);
  const inventoryOld = loaded.readClutchpacksProductionPostHeadRootInventoryForPreparation;
  if (typeof inventoryOld !== "function") refuse();
  const oldInventory = await inventoryOld(OLD_ROOT);
  const sourceReader = { worktree: SOURCE, commit: SOURCE_COMMIT, script: sourceScript, policy: sourcePolicy,
    executable: nodePin, loader: sourceLoader, runtimeInventory: sourceRuntime };
  const manifestCore = { schemaVersion: "clutchpacks_production_post_head_successor_recovery_manifest_v1",
    createdAt: args.createdAt, incidentId: RUN_ID, ledgerPath: LEDGER, recordsPath: RECORDS,
    ledgerSchemaSha256: LEDGER_SCHEMA_SHA256, head: HEAD, freshnessCutoff: FRESHNESS_CUTOFF, old,
    oldRootInventorySha256: oldInventory.inventorySha256, publisher, executor, sourceReader, roots: ROOTS };
  const executorPolicyCore = { schemaVersion: "clutchpacks_production_post_head_recovery_executor_policy_v1",
    executor, importedRecoveryModule: executor.modules.recovery, publisher, executable: nodePin, loader: publisherLoader,
    runtimeInventory: publisherRuntime, executorRuntimeInventory: executorRuntime, sourceReader, environment: ENVIRONMENT,
    ledgerPath: LEDGER, roots: ROOTS };
  const built = buildSealedDocuments({ manifestCore, executorPolicyCore,
    launchPolicyCore: { schemaVersion: "clutchpacks_production_post_head_successor_v1", head: HEAD, old,
      publisher, executor, deadlineMs: 900_000 } });
  return { documents: built.documents, launcher: executor.modules.launcher, executorCommit: args.executorCommit };
}
async function main() {
  const args = parseRuntime({ argv: process.argv, execArgv: process.execArgv, environment: process.env,
    execPath: process.execPath, cwd: process.cwd(), modulePath: fileURLToPath(import.meta.url) });
  await verifySelfPin(args.preparerSha256);
  await privateDirectory(TMPDIR, true);
  const built = await productionDocuments(args);
  await installLedger({ ledger: LEDGER, records: RECORDS,
    reservedPaths: ROOTS.flatMap(root => [root.artifactDirectory, root.proofDirectory]) }, built.documents);
  const hashes = Object.fromEntries(Object.entries(built.documents).map(([name, bytes]) => [name, hashBytes(bytes)]));
  process.stdout.write(`${JSON.stringify({ status: "prepared", ledger: LEDGER, hashes,
    launcher: built.launcher, preparer: { path: PREPARER, sha256: args.preparerSha256 },
    executorCommit: built.executorCommit })}\n`);
}

export const clutchpacksProductionPostHeadSuccessorPreparerTestHarness = process.env.NODE_ENV === "test" ?
  Object.freeze({ installLedger, installOrValidate, cleanupInstallTemps, parseRuntime, canonical, hashBytes,
    verifySelfPin, loadRuntimeInventoryReader, buildSealedDocuments, ensurePrivateDirectory: privateDirectory,
    frozenAttemptDirectory,
    environment: ENVIRONMENT, ledgerSchemaSha256: LEDGER_SCHEMA_SHA256,
    settings: { node: NODE, executor: EXECUTOR, preparer: PREPARER } }) : undefined;

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('{"status":"refused","code":"CLUTCHPACKS_C533_SUCCESSOR_PREPARATION_REFUSED"}\n');
  process.exitCode = 1;
});
