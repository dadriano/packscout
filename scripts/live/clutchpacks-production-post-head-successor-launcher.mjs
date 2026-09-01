import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { register } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const MAX_PATH_BYTES = 4096;
const MAX_INVENTORY_ENTRIES = 300_000;
const MAX_INVENTORY_BYTES = 5 * 1024 * 1024 * 1024;
const HOST = "127.0.0.1";
const RESIDENCY_PORT = 56_432;
const LABEL = "com.packscout.provider-import.clutchpacks";

const EXECUTOR_WORKTREE = "/Users/lains/Projects/packscout/.worktrees/clutch-c533-publication-recovery";
const PUBLISHER_WORKTREE = "/Users/lains/Projects/packscout/.worktrees/clutchpacks-runtime-open-retry";
const PUBLISHER_COMMIT = "7454390f7bc85648f38320f8d52451f63a899422";
const SOURCE_WORKTREE = "/Users/lains/Projects/packscout/.worktrees/clutch-minute-polling";
const SOURCE_COMMIT = "c4d6bf21cddde7155d1f6ebb1b979c69910d21dd";
const SOURCE_POLICY = "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutchpacks-production-poller-successor-20260901T011542Z-7454390-126d1069.json";
const SOURCE_POLICY_SHA256 = "49a9e30f7b9cf09d7951da7963dede5e93a8a0b8bb91fb35cc7d5182ca9700c0";
const SOURCE_SCRIPT_SHA256 = "ba85446bcc7f5a7f24adb7b924d4dd667e746febd1f959c330e4de8dc840d6f0";
const SOURCE_LOADER_SHA256 = "274e965b148911ea8ccd08923aecf1b898e46db70c8c5a5071b1cc6035f5851d";
const NODE = "/Users/lains/.hermes/node/bin/node";
const NODE_SHA256 = "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c";
const LEDGER = "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533e197-9a56-5360-a7cc-e35ad9677978-successor-recovery-ledger-v1";
const MANIFEST = `${LEDGER}/incident-manifest.json`;
const LAUNCH_POLICY = `${LEDGER}/launch-policy.json`;
const EXECUTOR_POLICY = `${LEDGER}/executor-policy.json`;
const RECORDS = `${LEDGER}/records`;
const RECOVERY = `${EXECUTOR_WORKTREE}/scripts/live/clutchpacks-production-post-head-recovery.mts`;
const LAUNCHER = `${EXECUTOR_WORKTREE}/scripts/live/clutchpacks-production-post-head-successor-launcher.mjs`;
const FRESHNESS_CUTOFF = "2026-09-02T02:52:20.539Z";
const RUN_ID = "c533e197-9a56-5360-a7cc-e35ad9677978";
const LEDGER_SCHEMA_SHA256 = "6d1414761b3dad2358b9287386731b8c503bde4293d93c83f0687ec9725b6e10";

const ROOTS = Object.freeze([
  Object.freeze({ ordinal: 1, rootId: "c80f32fe-d8d7-469a-8667-5f801c082f99",
    artifactDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-c533-recovery-1-20260901T065004Z-c80f32fe",
    proofDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publication-proofs-c533-recovery-1-20260901T065004Z-c80f32fe" }),
  Object.freeze({ ordinal: 2, rootId: "9825ddf9-5fdc-4660-b2db-51c8fc74b041",
    artifactDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-c533-recovery-2-20260901T065004Z-9825ddf9",
    proofDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publication-proofs-c533-recovery-2-20260901T065004Z-9825ddf9" }),
]);
const ENVIRONMENT = Object.freeze({ HOME: "/Users/lains", NODE_ENV: "production",
  PATH: "/Users/lains/.hermes/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-successor-tmp-c533e197-v1" });
const ENVIRONMENT_KEYS = Object.freeze(Object.keys(ENVIRONMENT).sort());
const MACOS_INJECTED_ENVIRONMENT_KEY = "__CF_USER_TEXT_ENCODING";
const PUBLISHER_MODULES = Object.freeze({
  promoteCli: "scripts/live/promote-clutchpacks-production.mts",
  convexRuntime: "scripts/live/clutchpacks-production-convex-runtime.mts",
  publicationOrchestrator: "scripts/live/clutchpacks-production-v3-publication.mts",
  publicationPolicy: "scripts/live/clutchpacks-production-publication-policy.mts",
  genericPublisher: "packages/services/src/buyback-adjusted-ev-release-publisher.ts",
  sourceReader: "scripts/live/clutchpacks-production-source-reader.mts",
  servicesIndex: "packages/services/src/index.ts",
});
const EXECUTOR_MODULES = Object.freeze({ recovery: "scripts/live/clutchpacks-production-post-head-recovery.mts",
  postHead: "scripts/live/clutchpacks-production-post-head.mts",
  publishShim: "scripts/live/clutchpacks-production-recovery-publish-shim.mjs",
  runtimeInventory: "scripts/live/clutchpacks-production-runtime-inventory.mjs",
  launcher: "scripts/live/clutchpacks-production-post-head-successor-launcher.mjs" });
const SOURCE_FILES = Object.freeze({
  script: "scripts/live/run-clutchpacks-production-poller.mts",
  loader: "node_modules/tsx/dist/loader.mjs",
});
const TARGET_CHAIN = Object.freeze({
  authenticatedPreflight: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.json", sha256: "ccfe601f5aebcd107374980e78796cc3337f2e7790624ee2fd2b62291b68494b" }),
  preflightScript: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.mjs", sha256: "98f8426710d0ebb02360fca3a78b38009e9a1145764979f9e5c6137436ab835d" }),
  preflightStderr: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.stderr", sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }),
  predecessorBundle: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-successor-20260901T011542Z-7454390-126d1069/5ee207cb-2608-5f47-a6db-0a16deb2682a/bundle.json", sha256: "0a0af154538c1feaa78fa279c2988dfd718cdf5a51f5b641d59a5d158e71e5d8" }),
  predecessorReceipt: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-successor-20260901T011542Z-7454390-126d1069/5ee207cb-2608-5f47-a6db-0a16deb2682a/bundle.json.receipt.b209365f-b9f3-421b-be2d-2a2da3f05a13.json", sha256: "2980cefc2db5977b074d65a3227730922b251990fb44a3202395c45e8c9f07ae" }),
});

class LauncherRefusal extends Error {
  constructor() { super("CLUTCHPACKS_C533_SUCCESSOR_LAUNCHER_REFUSED"); }
}
function refuse() { throw new LauncherRefusal(); }
function record(value) { if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(); return value; }
function exactKeys(value, keys) {
  if (Object.keys(record(value)).sort().join("\n") !== [...keys].sort().join("\n")) refuse();
}
function absolute(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PATH_BYTES &&
    path.isAbsolute(value) && path.resolve(value) === value && !/[\r\n\0]/u.test(value);
}
function hash(value) { return typeof value === "string" && HASH.test(value); }
function uuid(value) { return typeof value === "string" && UUID.test(value); }
function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value);
  return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function same(left, right) { return canonical(left) === canonical(right); }
function normalizeSealedEnvironment(source, expected = ENVIRONMENT,
  platform = process.platform, uid = process.getuid?.()) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) refuse();
  const environment = Object.fromEntries(Object.entries(source));
  if (Object.hasOwn(environment, MACOS_INJECTED_ENVIRONMENT_KEY)) {
    if (platform !== "darwin" || !Number.isSafeInteger(uid) || uid < 0 ||
      environment[MACOS_INJECTED_ENVIRONMENT_KEY] !== `0x${uid.toString(16).toUpperCase()}:0x0:0x0`) refuse();
    delete environment[MACOS_INJECTED_ENVIRONMENT_KEY];
  }
  if (!same(Object.keys(environment).sort(), ENVIRONMENT_KEYS) || !same(environment, expected)) refuse();
  return Object.freeze(Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, environment[key]])));
}
function iso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function inside(parent, child) { return child === parent || child.startsWith(`${parent}${path.sep}`); }
function metadataSame(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid &&
    left.mode === right.mode && left.nlink === right.nlink && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readRegular(file, { maximum = 256 * 1024 * 1024, minimum = 1, privateFile = false } = {}) {
  if (!absolute(file)) refuse();
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const uid = process.getuid?.();
    if (!before.isFile() || before.size < minimum || before.size > maximum || before.uid !== uid ||
      (before.mode & 0o022) !== 0 || (privateFile && ((before.mode & 0o777) !== 0o600 || before.nlink !== 1)) ||
      await realpath(file) !== file) refuse();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const outside = await lstat(file);
    if (bytes.length !== before.size || !metadataSame(before, after) || !metadataSame(before, outside)) refuse();
    return bytes;
  } finally { await handle.close(); }
}
async function pin(raw, expectedPath, maximum = 8 * 1024 * 1024, privateFile = false, minimum = 1) {
  exactKeys(raw, ["path", "sha256"]);
  if (raw.path !== expectedPath || !absolute(raw.path) || !hash(raw.sha256)) refuse();
  const bytes = await readRegular(raw.path, { maximum, minimum, privateFile });
  if (sha256(bytes) !== raw.sha256) refuse();
  return Object.freeze({ path: raw.path, sha256: raw.sha256 });
}
async function privateJson(file, expectedSha256, maximum = 1024 * 1024) {
  try {
    if (!hash(expectedSha256)) refuse();
    const bytes = await readRegular(file, { maximum, privateFile: true });
    if (sha256(bytes) !== expectedSha256) refuse();
    const value = JSON.parse(bytes.toString("utf8"));
    return { bytes, value: record(value), pin: Object.freeze({ path: file, sha256: expectedSha256 }) };
  } catch { refuse(); }
}

function validateRoot(value, expected) {
  exactKeys(value, ["ordinal", "rootId", "artifactDirectory", "proofDirectory"]);
  if (!Number.isSafeInteger(value.ordinal) || !uuid(value.rootId) || !absolute(value.artifactDirectory) ||
    !absolute(value.proofDirectory) || !same(value, expected)) refuse();
  return value;
}
function validateFilePinShape(value) {
  exactKeys(value, ["path", "sha256"]); if (!absolute(value.path) || !hash(value.sha256)) refuse(); return value;
}
function validateHead(value) {
  exactKeys(value, ["providerId", "configId", "configNumber", "runId", "checkpointHash", "generation",
    "runtimeRowVersion", "headFinishedAt", "authorityDigest"]);
  if (value.providerId !== "14787a87-77c0-5771-bfe1-cd5507bf2881" ||
    value.configId !== "de37fd7f-4461-4df1-86e6-6609486df4b7" || value.configNumber !== "4" || value.runId !== RUN_ID ||
    value.checkpointHash !== "21d42b7688028e0e4fd95b2564dc5975ef32fa01ce2beec032c3beceb384e76f" ||
    value.generation !== "87" || value.runtimeRowVersion !== "880" || value.headFinishedAt !== "2026-09-01T02:52:20.539Z" ||
    value.authorityDigest !== "5cc97f73ecefa4e93b7706e37a3dd00a6fddf3b4c397eca9ec4b6bcc01b26384") refuse();
  return value;
}
function validateOld(value) {
  exactKeys(value, ["artifactDirectory", "publisherWorktree", "publisherCommit", "pendingHead", "journal",
    "sourceConfig", "bundle", "targetPrevious", "targetChain", "failure"]);
  if (value.artifactDirectory !== "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-successor-20260901T011542Z-7454390-126d1069" ||
    value.publisherWorktree !== PUBLISHER_WORKTREE || value.publisherCommit !== PUBLISHER_COMMIT) refuse();
  for (const name of ["pendingHead", "journal", "sourceConfig", "bundle"]) validateFilePinShape(value[name]);
  const run = path.join(value.artifactDirectory, RUN_ID), pending = path.join(value.artifactDirectory, "pending");
  if (value.pendingHead.path !== path.join(pending, "head.json") || value.journal.path !== path.join(run, "head.json") ||
    value.sourceConfig.path !== path.join(run, "source-config.json") || value.bundle.path !== path.join(run, "bundle.json")) refuse();
  exactKeys(value.targetPrevious, ["publicReleaseId", "releaseFingerprint"]);
  if (!same(value.targetPrevious, { publicReleaseId: "dd5597c1-7caf-85ae-84b4-28939255e4ef",
    releaseFingerprint: "aaedc8ecfe45fb920fbfcd94c13f9d486ced2803cd2387c06ff39be8e0d8e024" })) refuse();
  exactKeys(value.targetChain, ["authenticatedPreflight", "preflightScript", "preflightStderr",
    "predecessorBundle", "predecessorReceipt"]);
  for (const item of Object.values(value.targetChain)) validateFilePinShape(item);
  if (!same(value.targetChain, TARGET_CHAIN)) refuse();
  exactKeys(value.failure, ["pendingBlocked", "prepared", "prepareStarted", "prepareStdout", "prepareStderr",
    "prepareCompleted", "publishStarted", "publishStdout", "publishStderr"]);
  for (const item of Object.values(value.failure)) validateFilePinShape(item);
  const attempt = path.dirname(value.failure.publishStarted.path);
  if (path.dirname(attempt) !== run || !/^attempt-[a-f0-9-]{36}$/u.test(path.basename(attempt)) ||
    path.dirname(value.failure.pendingBlocked.path) !== pending || value.failure.prepared.path !== path.join(run, "prepared.json")) refuse();
  for (const [name, leaf] of Object.entries({ prepareStarted: "prepare.started.json", prepareStdout: "prepare.stdout",
    prepareStderr: "prepare.stderr", prepareCompleted: "prepare.completed.json", publishStarted: "publish.started.json",
    publishStdout: "publish.stdout", publishStderr: "publish.stderr" }))
    if (value.failure[name].path !== path.join(attempt, leaf)) refuse();
  return value;
}
function validateRuntimeInventory(value, root, allowedTargetRoot) {
  exactKeys(value, ["schemaVersion", "root", "allowedTargetRoot", "entryCount", "fileCount", "directoryCount",
    "symlinkCount", "totalBytes", "treeSha256"]);
  if (value.schemaVersion !== "clutchpacks_production_runtime_inventory_v1" || value.root !== root ||
    value.allowedTargetRoot !== allowedTargetRoot || !hash(value.treeSha256)) refuse();
  for (const name of ["entryCount", "fileCount", "directoryCount", "symlinkCount", "totalBytes"])
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) refuse();
  if (value.entryCount < 1 || value.fileCount < 1 || value.directoryCount < 1 ||
    value.entryCount !== value.fileCount + value.directoryCount + value.symlinkCount ||
    value.entryCount > MAX_INVENTORY_ENTRIES || value.totalBytes < 1 || value.totalBytes > MAX_INVENTORY_BYTES) refuse();
  return value;
}
function validateIdentity(value, worktree, expectedCommit, relativeModules) {
  exactKeys(value, ["worktree", "commit", "modules"]);
  if (value.worktree !== worktree || !COMMIT.test(value.commit) || (expectedCommit && value.commit !== expectedCommit)) refuse();
  exactKeys(value.modules, Object.keys(relativeModules));
  for (const [name, relative] of Object.entries(relativeModules)) {
    validateFilePinShape(value.modules[name]);
    if (value.modules[name].path !== path.join(worktree, relative)) refuse();
  }
  return value;
}
function validateSourceReader(value) {
  exactKeys(value, ["worktree", "commit", "script", "policy", "executable", "loader", "runtimeInventory"]);
  if (value.worktree !== SOURCE_WORKTREE || value.commit !== SOURCE_COMMIT) refuse();
  validateFilePinShape(value.script); validateFilePinShape(value.policy); validateFilePinShape(value.executable);
  validateFilePinShape(value.loader);
  if (value.script.path !== path.join(SOURCE_WORKTREE, SOURCE_FILES.script) ||
    value.script.sha256 !== SOURCE_SCRIPT_SHA256 || value.policy.path !== SOURCE_POLICY ||
    value.policy.sha256 !== SOURCE_POLICY_SHA256 || value.loader.path !== path.join(SOURCE_WORKTREE, SOURCE_FILES.loader) ||
    value.loader.sha256 !== SOURCE_LOADER_SHA256 || value.executable.path !== NODE || value.executable.sha256 !== NODE_SHA256) refuse();
  validateRuntimeInventory(value.runtimeInventory, path.join(SOURCE_WORKTREE, "node_modules"), SOURCE_WORKTREE);
  return value;
}
function validateManifest(value, executorCommit) {
  exactKeys(value, ["schemaVersion", "createdAt", "incidentId", "ledgerPath", "recordsPath", "ledgerSchemaSha256",
    "head", "freshnessCutoff", "old", "oldRootInventorySha256", "publisher", "executor", "sourceReader",
    "roots", "manifestSha256"]);
  if (value.schemaVersion !== "clutchpacks_production_post_head_successor_recovery_manifest_v1" ||
    !iso(value.createdAt) || value.incidentId !== RUN_ID || value.ledgerPath !== LEDGER || value.recordsPath !== RECORDS ||
    value.ledgerSchemaSha256 !== LEDGER_SCHEMA_SHA256 || value.freshnessCutoff !== FRESHNESS_CUTOFF || !hash(value.oldRootInventorySha256) ||
    !hash(value.manifestSha256) || !Array.isArray(value.roots) || value.roots.length !== 2) refuse();
  validateHead(value.head); validateOld(value.old);
  validateIdentity(value.publisher, PUBLISHER_WORKTREE, PUBLISHER_COMMIT, PUBLISHER_MODULES);
  validateIdentity(value.executor, EXECUTOR_WORKTREE, executorCommit, EXECUTOR_MODULES);
  validateSourceReader(value.sourceReader);
  value.roots.forEach((item, index) => validateRoot(item, ROOTS[index]));
  const { manifestSha256, ...core } = value;
  if (sha256(canonical(core)) !== manifestSha256) refuse();
  return value;
}
function validateInput(value, manifestPin, manifest, executorCommit) {
  exactKeys(value, ["schemaVersion", "incidentManifest", "head", "old", "publisher", "executor",
    "executorPolicy", "deadlineMs"]);
  if (value.schemaVersion !== "clutchpacks_production_post_head_successor_v1" ||
    !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 1 || value.deadlineMs > 900_000) refuse();
  validateFilePinShape(value.incidentManifest); validateHead(value.head); validateOld(value.old);
  validateIdentity(value.publisher, PUBLISHER_WORKTREE, PUBLISHER_COMMIT, PUBLISHER_MODULES);
  validateIdentity(value.executor, EXECUTOR_WORKTREE, executorCommit, EXECUTOR_MODULES);
  validateFilePinShape(value.executorPolicy);
  if (!same(value.incidentManifest, manifestPin) || !same(value.head, manifest.head) || !same(value.old, manifest.old) ||
    !same(value.publisher, manifest.publisher) || !same(value.executor, manifest.executor) ||
    value.executorPolicy.path !== EXECUTOR_POLICY) refuse();
  return value;
}
function validateExecutorPolicy(value, input, manifest, executorCommit) {
  exactKeys(value, ["schemaVersion", "executor", "importedRecoveryModule", "publisher", "executable", "loader",
    "runtimeInventory", "executorRuntimeInventory", "sourceReader", "environment", "incidentManifest", "ledgerPath",
    "roots", "policySha256"]);
  if (value.schemaVersion !== "clutchpacks_production_post_head_recovery_executor_policy_v1" ||
    value.ledgerPath !== LEDGER || !hash(value.policySha256) || !Array.isArray(value.roots) || value.roots.length !== 2) refuse();
  validateIdentity(value.executor, EXECUTOR_WORKTREE, executorCommit, EXECUTOR_MODULES);
  validateIdentity(value.publisher, PUBLISHER_WORKTREE, PUBLISHER_COMMIT, PUBLISHER_MODULES);
  validateFilePinShape(value.importedRecoveryModule); validateFilePinShape(value.executable); validateFilePinShape(value.loader);
  if (!same(value.executor, input.executor) || !same(value.publisher, input.publisher) ||
    !same(value.importedRecoveryModule, input.executor.modules.recovery) || value.importedRecoveryModule.path !== RECOVERY ||
    value.executable.path !== NODE || value.executable.sha256 !== NODE_SHA256 ||
    value.loader.path !== path.join(PUBLISHER_WORKTREE, "node_modules/tsx/dist/loader.mjs") ||
    !same(value.incidentManifest, input.incidentManifest) || !same(value.sourceReader, manifest.sourceReader) ||
    !same(value.environment, ENVIRONMENT)) refuse();
  exactKeys(value.environment, ENVIRONMENT_KEYS);
  validateRuntimeInventory(value.runtimeInventory, path.join(PUBLISHER_WORKTREE, "node_modules"), PUBLISHER_WORKTREE);
  validateRuntimeInventory(value.executorRuntimeInventory, path.join(EXECUTOR_WORKTREE, "node_modules"), EXECUTOR_WORKTREE);
  validateSourceReader(value.sourceReader);
  value.roots.forEach((item, index) => validateRoot(item, ROOTS[index]));
  const { policySha256, ...core } = value;
  if (sha256(canonical(core)) !== policySha256) refuse();
  return value;
}

function validatePreparedDocumentBytes(documents) {
  exactKeys(documents, ["incident-manifest.json", "executor-policy.json", "launch-policy.json"]);
  const decode = name => record(JSON.parse(Buffer.from(documents[name]).toString("utf8")));
  const manifest = decode("incident-manifest.json"), executorPolicy = decode("executor-policy.json"),
    input = decode("launch-policy.json");
  const { manifestSha256, ...manifestCore } = manifest;
  const { policySha256, ...policyCore } = executorPolicy;
  if (manifest.schemaVersion !== "clutchpacks_production_post_head_successor_recovery_manifest_v1" ||
    executorPolicy.schemaVersion !== "clutchpacks_production_post_head_recovery_executor_policy_v1" ||
    input.schemaVersion !== "clutchpacks_production_post_head_successor_v1" ||
    !hash(manifestSha256) || sha256(canonical(manifestCore)) !== manifestSha256 ||
    !hash(policySha256) || sha256(canonical(policyCore)) !== policySha256) refuse();
  const manifestPin = { path: path.join(manifest.ledgerPath, "incident-manifest.json"),
    sha256: sha256(Buffer.from(documents["incident-manifest.json"])) };
  const executorPolicyPin = { path: path.join(manifest.ledgerPath, "executor-policy.json"),
    sha256: sha256(Buffer.from(documents["executor-policy.json"])) };
  if (!same(executorPolicy.incidentManifest, manifestPin) || !same(input.incidentManifest, manifestPin) ||
    !same(input.executorPolicy, executorPolicyPin) || executorPolicy.ledgerPath !== manifest.ledgerPath ||
    !same(executorPolicy.roots, manifest.roots) || !same(input.head, manifest.head) || !same(input.old, manifest.old) ||
    !same(input.publisher, manifest.publisher) || !same(input.executor, manifest.executor)) refuse();
  return { manifest, executorPolicy, input, manifestPin, executorPolicyPin };
}

async function loadRuntimeInventoryReader(modulePin, dependencies = {}) {
  if (dependencies.readRuntimeInventory !== undefined) {
    if (typeof dependencies.readRuntimeInventory !== "function") refuse();
    return dependencies.readRuntimeInventory;
  }
  const loaded = await (dependencies.loadRuntimeInventoryModule ??
    (file => import(pathToFileURL(file).href)))(modulePin.path);
  const reader = loaded?.readClutchpacksProductionRuntimeInventory;
  if (typeof reader !== "function") refuse();
  return reader;
}

async function verifyRuntimeInventoryTriplet(inventory, expected, locations) {
  if (typeof inventory !== "function") refuse();
  const publisherInventory = await inventory(locations.publisher.root, locations.publisher.allowedTargetRoot);
  const executorInventory = await inventory(locations.executor.root, locations.executor.allowedTargetRoot);
  const sourceInventory = await inventory(locations.source.root, locations.source.allowedTargetRoot);
  if (!same(publisherInventory, expected.publisher) || !same(executorInventory, expected.executor) ||
    !same(sourceInventory, expected.source)) refuse();
  return Object.freeze({ publisher: publisherInventory, executor: executorInventory, source: sourceInventory });
}

async function proveRuntimeClosure(input, manifest, executorPolicy, dependencies = {}) {
  for (const [identity, modules] of [[input.publisher, PUBLISHER_MODULES],
    [input.executor, EXECUTOR_MODULES], [manifest.sourceReader, { script: SOURCE_FILES.script }]])
    await (dependencies.verifyCheckout ?? verifyCheckout)(identity, modules, dependencies.command);
  for (const [identity, modules] of [[input.publisher, PUBLISHER_MODULES], [input.executor, EXECUTOR_MODULES]])
    for (const [name, relative] of Object.entries(modules))
      await pin(identity.modules[name], path.join(identity.worktree, relative));
  await pin(manifest.sourceReader.script, path.join(SOURCE_WORKTREE, SOURCE_FILES.script));
  await pin(manifest.sourceReader.policy, manifest.sourceReader.policy.path, 1024 * 1024, true);
  await pin(manifest.sourceReader.executable, NODE, 256 * 1024 * 1024);
  await pin(manifest.sourceReader.loader, path.join(SOURCE_WORKTREE, SOURCE_FILES.loader));
  await pin(executorPolicy.executable, NODE, 256 * 1024 * 1024);
  await pin(executorPolicy.loader, path.join(PUBLISHER_WORKTREE, "node_modules/tsx/dist/loader.mjs"));
  const inventory = await loadRuntimeInventoryReader(input.executor.modules.runtimeInventory, dependencies);
  await verifyRuntimeInventoryTriplet(inventory, {
    publisher: executorPolicy.runtimeInventory, executor: executorPolicy.executorRuntimeInventory,
    source: executorPolicy.sourceReader.runtimeInventory,
  }, {
    publisher: { root: path.join(PUBLISHER_WORKTREE, "node_modules"), allowedTargetRoot: PUBLISHER_WORKTREE },
    executor: { root: path.join(EXECUTOR_WORKTREE, "node_modules"), allowedTargetRoot: EXECUTOR_WORKTREE },
    source: { root: path.join(SOURCE_WORKTREE, "node_modules"), allowedTargetRoot: SOURCE_WORKTREE },
  });
  await dependencies.afterRuntimeInventory?.();
  for (const [identity, modules] of [[input.publisher, PUBLISHER_MODULES],
    [input.executor, EXECUTOR_MODULES], [manifest.sourceReader, { script: SOURCE_FILES.script }]])
    await (dependencies.verifyCheckout ?? verifyCheckout)(identity, modules, dependencies.command);
  for (const [identity, modules] of [[input.publisher, PUBLISHER_MODULES], [input.executor, EXECUTOR_MODULES]])
    for (const [name, relative] of Object.entries(modules))
      await pin(identity.modules[name], path.join(identity.worktree, relative));
  await pin(manifest.sourceReader.script, path.join(SOURCE_WORKTREE, SOURCE_FILES.script));
  await pin(manifest.sourceReader.policy, manifest.sourceReader.policy.path, 1024 * 1024, true);
  await pin(manifest.sourceReader.executable, NODE, 256 * 1024 * 1024);
  await pin(manifest.sourceReader.loader, path.join(SOURCE_WORKTREE, SOURCE_FILES.loader));
  await pin(executorPolicy.executable, NODE, 256 * 1024 * 1024);
  await pin(executorPolicy.loader,
    path.join(PUBLISHER_WORKTREE, "node_modules/tsx/dist/loader.mjs"));
  const finalInventories = await verifyRuntimeInventoryTriplet(inventory, {
    publisher: executorPolicy.runtimeInventory, executor: executorPolicy.executorRuntimeInventory,
    source: executorPolicy.sourceReader.runtimeInventory,
  }, {
    publisher: { root: path.join(PUBLISHER_WORKTREE, "node_modules"), allowedTargetRoot: PUBLISHER_WORKTREE },
    executor: { root: path.join(EXECUTOR_WORKTREE, "node_modules"), allowedTargetRoot: EXECUTOR_WORKTREE },
    source: { root: path.join(SOURCE_WORKTREE, "node_modules"), allowedTargetRoot: SOURCE_WORKTREE },
  });
  for (const [name, relative] of Object.entries(PUBLISHER_MODULES))
    await pin(input.publisher.modules[name], path.join(input.publisher.worktree, relative));
  for (const [name, relative] of Object.entries(EXECUTOR_MODULES))
    await pin(input.executor.modules[name], path.join(input.executor.worktree, relative));
  await pin(manifest.sourceReader.script, path.join(SOURCE_WORKTREE, SOURCE_FILES.script));
  await pin(input.executor.modules.runtimeInventory,
    path.join(EXECUTOR_WORKTREE, EXECUTOR_MODULES.runtimeInventory));
  const finalLoader = await pin(executorPolicy.loader,
    path.join(PUBLISHER_WORKTREE, "node_modules/tsx/dist/loader.mjs"));
  return Object.freeze({ loader: finalLoader, inventories: finalInventories });
}

async function verifyCheckout(identity, relativeModules, command = promisify(execFile)) {
  const options = { cwd: identity.worktree,
    env: { HOME: "/Users/lains", PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
  const [top, head, status] = await Promise.all([
    command("/usr/bin/git", ["rev-parse", "--show-toplevel"], options),
    command("/usr/bin/git", ["rev-parse", "HEAD"], options),
    command("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=normal"], options),
  ]);
  if (top.stdout.trim() !== identity.worktree || head.stdout.trim() !== identity.commit || status.stdout !== "") refuse();
  for (const relative of Object.values(relativeModules)) {
    const member = await command("/usr/bin/git", ["ls-files", "--error-unmatch", relative], options);
    if (member.stdout.trim() !== relative) refuse();
  }
}
async function verifyLedgerLayout(ledger = LEDGER, records = RECORDS) {
  if (!absolute(ledger) || !absolute(records) || records !== path.join(ledger, "records")) refuse();
  for (const directory of [ledger, records]) {
    const value = await lstat(directory);
    if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.() ||
      (value.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) refuse();
  }
  if (!same((await readdir(ledger)).sort(),
    ["executor-policy.json", "incident-manifest.json", "launch-policy.json", "records"].sort())) refuse();
}
function parseArguments(runtime, settings) {
  const expected = ["--input", settings.launchPolicy, "--input-sha256", null, "--manifest", settings.manifest,
    "--manifest-sha256", null, "--launcher-sha256", null, "--executor-commit", null];
  if (runtime.execArgv.length !== 0 || runtime.argv.length !== expected.length + 2 || runtime.argv[0] !== settings.node ||
    runtime.argv[1] !== settings.launcher) refuse();
  for (let index = 0; index < expected.length; index++)
    if (expected[index] !== null && runtime.argv[index + 2] !== expected[index]) refuse();
  const inputSha256 = runtime.argv[5], manifestSha256 = runtime.argv[9], launcherSha256 = runtime.argv[11],
    executorCommit = runtime.argv[13];
  if (![inputSha256, manifestSha256, launcherSha256].every(hash) || !COMMIT.test(executorCommit)) refuse();
  return { inputSha256, manifestSha256, launcherSha256, executorCommit };
}
function launchctlMissing(error, uid) {
  if (error === null || typeof error !== "object") return false;
  const expected = `Could not find service \"${LABEL}\" in domain for user gui: ${uid}\n`;
  return (error.code === 113 || error.code === "113") && (error.stdout ?? "") === "" &&
    (error.stderr === expected || error.stderr === `Bad request.\n${expected}`);
}
async function inspectResidency(command = promisify(execFile)) {
  const uid = process.getuid?.(); if (uid === undefined) refuse();
  try {
    await command("/bin/launchctl", ["print", `gui/${uid}/${LABEL}`],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10_000, maxBuffer: 1024 * 1024 });
    refuse();
  } catch (error) { if (error instanceof LauncherRefusal || !launchctlMissing(error, uid)) refuse(); }
  const processes = await command("/bin/ps", ["-axo", "pid=,command="],
    { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  if (processes.stderr !== "" || processes.stdout.split("\n").some(line =>
    (line.includes("run-clutchpacks-production-poller.mts") && line.includes("--run") && !line.includes("--check-only")) ||
    line.includes("promote-clutchpacks-production.mts"))) refuse();
}
async function acquireResidencyServer() {
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject); server.listen({ host: HOST, port: RESIDENCY_PORT, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!server.listening || address === null || typeof address === "string" || address.address !== HOST ||
      address.port !== RESIDENCY_PORT || address.family !== "IPv4") refuse();
    return server;
  } catch (error) { await closeServer(server); throw error; }
}
async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(() => resolve()));
}
async function withResidency(dependencies, action) {
  let server;
  try {
    server = await (dependencies.acquireResidencyServer ?? acquireResidencyServer)();
    const acquiredAt = new Date().toISOString();
    await (dependencies.inspectResidency ?? inspectResidency)(dependencies.command);
    return await action(server, acquiredAt);
  } finally { await (dependencies.closeServer ?? closeServer)(server); }
}
async function withRuntimeReproof(dependencies, prove, action) {
  await prove(); await dependencies.afterInitialRuntimeProof?.();
  return withResidency(dependencies, async (server, acquiredAt) => action(server, acquiredAt, await prove()));
}

const PRODUCTION_SETTINGS = Object.freeze({ executorWorktree: EXECUTOR_WORKTREE, publisherWorktree: PUBLISHER_WORKTREE,
  sourceWorktree: SOURCE_WORKTREE, node: NODE, nodeSha256: NODE_SHA256, ledger: LEDGER, manifest: MANIFEST,
  launchPolicy: LAUNCH_POLICY, executorPolicy: EXECUTOR_POLICY, records: RECORDS, recovery: RECOVERY, launcher: LAUNCHER,
  roots: ROOTS, environment: ENVIRONMENT, publisherCommit: PUBLISHER_COMMIT, sourceCommit: SOURCE_COMMIT });

async function execute(runtime, dependencies = {}, settings = PRODUCTION_SETTINGS) {
  try {
    const args = parseArguments(runtime, settings);
    const environment = normalizeSealedEnvironment(runtime.environment, settings.environment);
    if (!same(environment, settings.environment) ||
      runtime.execPath !== settings.node || runtime.cwd !== settings.executorWorktree ||
      runtime.launcherModulePath !== settings.launcher || await realpath(settings.launcher) !== settings.launcher) refuse();
    const ownBytes = await readRegular(settings.launcher, { maximum: 1024 * 1024 });
    if (sha256(ownBytes) !== args.launcherSha256) refuse();
    const manifestDocument = await privateJson(settings.manifest, args.manifestSha256);
    const manifest = validateManifest(manifestDocument.value, args.executorCommit);
    const inputDocument = await privateJson(settings.launchPolicy, args.inputSha256);
    const input = validateInput(inputDocument.value, manifestDocument.pin, manifest, args.executorCommit);
    const executorPolicyDocument = await privateJson(settings.executorPolicy, input.executorPolicy.sha256);
    const executorPolicy = validateExecutorPolicy(executorPolicyDocument.value, input, manifest, args.executorCommit);
    if (!same(executorPolicyDocument.pin, input.executorPolicy) || Date.now() >= Date.parse(FRESHNESS_CUTOFF)) refuse();
    await (dependencies.verifyLedgerLayout ?? verifyLedgerLayout)(settings.ledger, settings.records);

    return await withRuntimeReproof(dependencies,
      () => proveRuntimeClosure(input, manifest, executorPolicy, dependencies), async (server, acquiredAt, finalRuntime) => {
      await pin({ path: settings.launcher, sha256: args.launcherSha256 }, settings.launcher, 1024 * 1024);
      await pin({ path: settings.launchPolicy, sha256: args.inputSha256 }, settings.launchPolicy, 1024 * 1024, true);
      await pin(input.incidentManifest, settings.manifest, 1024 * 1024, true);
      await pin(input.executorPolicy, settings.executorPolicy, 1024 * 1024, true);
      (dependencies.registerLoader ?? register)(pathToFileURL(finalRuntime.loader.path), import.meta.url);
      const loaded = await (dependencies.loadRecovery ?? (file => import(pathToFileURL(file).href)))(RECOVERY);
      const run = loaded?.runClutchpacksProductionPostHeadSuccessorFromSealedLauncher;
      if (typeof run !== "function") refuse();
      const result = await run(input, { residencyServer: server, acquiredAt, incidentManifest: manifestDocument.pin,
        launcher: { path: settings.launcher, sha256: args.launcherSha256,
          worktree: settings.executorWorktree, commit: args.executorCommit } });
      if (result === null || typeof result !== "object" || result.status !== "verified") refuse();
      return Object.freeze({ status: "verified", code: "CLUTCHPACKS_C533_SUCCESSOR_LAUNCHER_VERIFIED" });
      });
  } catch { refuse(); }
}

export const clutchpacksProductionPostHeadSuccessorLauncherTestHarness = process.env.NODE_ENV === "test" ? Object.freeze({
  execute,
  canonical,
  sha256,
  privateJson,
  withResidency,
  withRuntimeReproof,
  validateIdentity,
  validatePreparedDocumentBytes,
  verifyRuntimeInventoryTriplet,
  proveRuntimeClosure,
  verifyLedgerLayout,
  normalizeSealedEnvironment,
  publisherModules: PUBLISHER_MODULES,
  executorModules: EXECUTOR_MODULES,
  productionSettings: PRODUCTION_SETTINGS,
  ledgerSchemaSha256: LEDGER_SCHEMA_SHA256,
}) : undefined;

async function main() {
  const result = await execute({ argv: process.argv, execArgv: process.execArgv, environment: process.env,
    execPath: process.execPath, cwd: process.cwd(), launcherModulePath: fileURLToPath(import.meta.url) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('{"status":"refused","code":"CLUTCHPACKS_C533_SUCCESSOR_LAUNCHER_REFUSED"}\n');
  process.exitCode = 1;
});
