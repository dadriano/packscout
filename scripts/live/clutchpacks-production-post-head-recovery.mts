import { randomUUID } from "node:crypto";
import { execFile, spawn as spawnChild, type ChildProcess } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { clutchpacksProductionPostHeadSchema,
  clutchpacksProductionPostHeadRecoveryPrimitives as artifact } from "./clutchpacks-production-post-head.mts";
import { clutchpacksProductionObservationOperationId } from "./clutchpacks-production-v3-publication.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const iso = z.iso.datetime().refine(value => new Date(value).toISOString() === value);
const absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && path.resolve(value) === value && !/[\r\n\0]/u.test(value));
const filePin = z.object({ path: absolute, sha256: hash }).strict();
const failurePins = z.object({ pendingBlocked: filePin, publishStarted: filePin,
  publishStderr: filePin, leaseAttempt: filePin }).strict();
const oldIncidentPins = z.object({ artifactDirectory: absolute, publisherWorktree: absolute, publisherCommit: commit,
  pendingHead: filePin, journal: filePin, sourceConfig: filePin, bundle: filePin, failure: failurePins }).strict();
const modulePins = z.object({ promoteCli: filePin, convexRuntime: filePin,
  publicationOrchestrator: filePin, publicationPolicy: filePin, genericPublisher: filePin }).strict();
const inventoryRelativePath = z.string().min(1).max(4096).refine(value => value === "." ||
  (!path.isAbsolute(value) && path.normalize(value) === value && !value.split(path.sep).includes("..") && !/[\r\n\0]/u.test(value)));
const inventoryBase = { relativePath: inventoryRelativePath, uid: z.number().int().safe().nonnegative(),
  mode: z.number().int().min(0).max(0o7777), size: z.number().int().safe().nonnegative() };
const oldRootInventorySchema = z.object({ entries: z.array(z.discriminatedUnion("type", [
  z.object({ ...inventoryBase, type: z.literal("directory") }).strict(),
  z.object({ ...inventoryBase, type: z.literal("file"), sha256: hash }).strict(),
])).min(1).max(20_000), inventorySha256: hash }).strict();
const executorPins = z.object({ recovery: filePin, postHead: filePin }).strict();
const publisherIdentity = z.object({ worktree: absolute, commit, modules: modulePins }).strict();
const executorIdentity = z.object({ worktree: absolute, commit, modules: executorPins }).strict();
const executorPolicySchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_post_head_recovery_executor_policy_v1"),
  executor: executorIdentity, importedRecoveryModule: filePin, publisher: publisherIdentity,
  executionDirectory: absolute, destinationDirectory: absolute, policySha256: hash,
}).strict();
const executionInputSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_recovery_execution_v1"),
  head: clutchpacksProductionPostHeadSchema, old: oldIncidentPins,
  publisher: publisherIdentity, executor: executorIdentity, executorPolicy: filePin,
  executionDirectory: absolute, deadlineMs: z.number().int().min(1).max(900_000) }).strict();
const executionStartedSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_recovery_execution_started_v1"),
  startedAt: iso, head: clutchpacksProductionPostHeadSchema, old: oldIncidentPins,
  publisher: publisherIdentity, executionDirectory: absolute,
  executor: executorIdentity, executorPolicy: filePin,
  oldRootInventory: oldRootInventorySchema,
  attemptDirectory: absolute, originalBundle: filePin, executionBundle: filePin, bundleSha256: hash,
  intentSha256: hash, operationId: z.uuid(), candidate: z.object({ publicReleaseId: z.uuid(),
    releaseFingerprint: hash, planSha256: hash }).strict(), manifestSha256: hash }).strict();
const invocationSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_recovery_invocation_v1"),
  recordedAt: iso, executable: filePin, loader: filePin, cli: filePin, cwd: absolute,
  argv: z.array(z.string().max(4096)).min(5).max(16), environmentKeys: z.array(z.string()).max(8), invocationSha256: hash }).strict();
const commandRecordSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_recovery_command_v1"),
  startedAt: iso, completedAt: iso, exitCode: z.literal(0), invocationSha256: hash,
  stdoutSha256: hash, stderrSha256: hash, commandSha256: hash }).strict();
const executionArtifactsSchema = z.object({ executionStarted: filePin, executionBundle: filePin, invocation: filePin,
  commandStarted: filePin, stdout: filePin, stderr: filePin, phaseCompleted: filePin,
  commandCompleted: filePin, readback: filePin, receipt: filePin,
  publisherSidecars: z.array(filePin).length(3) }).strict();
const executionManifestSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_recovery_execution_receipt_v1"),
  startedAt: iso, completedAt: iso, head: clutchpacksProductionPostHeadSchema, old: oldIncidentPins,
  publisher: publisherIdentity, executionDirectory: absolute,
  executor: executorIdentity, executorPolicy: filePin,
  oldRootInventory: oldRootInventorySchema,
  attemptDirectory: absolute, startedManifestSha256: hash, bundleSha256: hash, intentSha256: hash,
  operationId: z.uuid(), candidate: z.object({ publicReleaseId: z.uuid(), releaseFingerprint: hash,
    planSha256: hash }).strict(), artifacts: executionArtifactsSchema, evidence: z.unknown(), manifestSha256: hash }).strict();
export type ClutchpacksProductionPostHeadRecoveryExecutionInput = z.input<typeof executionInputSchema>;
const inputSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_recovery_v1"),
  head: clutchpacksProductionPostHeadSchema,
  old: oldIncidentPins.extend({ executionManifest: filePin }).strict(),
  destination: z.object({ artifactDirectory: absolute, publisherWorktree: absolute, publisherCommit: commit,
    baseSourceConfig: filePin, residentAuthorityDigest: hash }).strict() }).strict();
export type ClutchpacksProductionPostHeadRecoveryInput = z.input<typeof inputSchema>;
interface RecoveryDependencies {
  readonly git?: (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;
  readonly spawn?: (file: string, args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"];
  }) => ChildProcess;
  readonly kill?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  readonly startDeadline?: (abort: () => void, milliseconds: number) => () => void;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}
interface RecoveryPolicy { readonly production: boolean; readonly importedRecoveryModulePath?: string; }
class RecoveryError extends Error {
  constructor(readonly code: string) { super("ClutchPacks production post-head recovery artifacts were refused safely."); }
}
const refuse = (code: string): never => { throw new RecoveryError(code); };
const same = (left: unknown, right: unknown) => artifact.digest(left) === artifact.digest(right);
// PackScout production maintenance owns this one-shot exception. Remove this module,
// its tests, and the temporary post-head exports immediately after the frozen failed
// run is reconciled and the final successor artifact root is seeded.
const incident = Object.freeze({
  oldRoot: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications",
  oldWorktree: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-promotion",
  oldCommit: "a1cdbf396924b8e4a27fbf6c00e7926d28db9fc5",
  basePath: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-source-20260831T174022Z-route-v2.json",
  baseRaw: "d27b2a1ab8076ea5d79dfcab1d69cdc5aeba426b25f8ae29a5509539f7fc0ba1",
  runId: "1ad202c3-0a38-5943-a383-f51b52f438d2", attemptId: "a03a264b-7c7d-4003-b3da-7c0f104d7fe0",
  leaseAttemptId: "ee5db0f1-061b-4d59-8168-b41d25bbed28",
  candidateId: "49072352-0803-8e53-8622-9471df512ea9",
  operationId: "e9c43f0d-4f2b-4d7c-bd65-627c337deff7",
  bundleSha256: "30da9de50f6b7f77cd3202666c988ef122f9874d2a089f6ce9be09200cc99ae8",
  pendingRaw: "fd58042e0aecca230356a7f36aa9c5ba6c01253f02902043f1986ef4ae57dc8f",
  journalRaw: "528d8c1430832ba3bf20ea89a3baa81886d35224976558bc50a9ee9aa4950218",
  sourceConfigRaw: "11c1c701603f66c7ec2cd2c1e21e501e26d8e435db66f5285f6e5e0afed005c6",
  bundleRaw: "4dee42a649aca41f0d6d37849a84127e5704cfde15b2d58e59e587fa08f07f54",
  blockedRaw: "9f186ae8b523973d3684c33189901417e8bf12bbffffb77ae481f0995f6c1046",
  startedRaw: "302415061927b98f940b9b1ae729273d5bea39412cce87efba47e149b7fcb5ed",
  stderrRaw: "751584c4c6f44a0b4907bac4ae03f8e73cacb353c721550caa90660d42496233",
  leaseRaw: "27fd48fa72de1da336fa4abee7a6241b8327e94405a48bf94b9ce1fb9f520edc",
  head: Object.freeze({ providerId: "14787a87-77c0-5771-bfe1-cd5507bf2881",
    configId: "de37fd7f-4461-4df1-86e6-6609486df4b7", configNumber: "4",
    runId: "1ad202c3-0a38-5943-a383-f51b52f438d2",
    checkpointHash: "2626875860a981704f3780ac9ad570bba0b33d78e96da43593b8598dc985fabc",
    generation: "45", runtimeRowVersion: "229", headFinishedAt: "2026-08-31T20:59:49.377Z",
    authorityDigest: "5cc97f73ecefa4e93b7706e37a3dd00a6fddf3b4c397eca9ec4b6bcc01b26384" }),
});
const moduleRelativePaths = Object.freeze({ promoteCli: "scripts/live/promote-clutchpacks-production.mts",
  convexRuntime: "scripts/live/clutchpacks-production-convex-runtime.mts",
  publicationOrchestrator: "scripts/live/clutchpacks-production-v3-publication.mts",
  publicationPolicy: "scripts/live/clutchpacks-production-publication-policy.mts",
  genericPublisher: "packages/services/src/buyback-adjusted-ev-release-publisher.ts" });
const executorRelativePaths = Object.freeze({ recovery: "scripts/live/clutchpacks-production-post-head-recovery.mts",
  postHead: "scripts/live/clutchpacks-production-post-head.mts" });
const productionPolicy = Object.freeze({
  executorPolicyPath: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-recovery-executor-policy-1ad202c3-v1.json",
  publisherWorktree: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final",
  publisherCommit: "143e954fe5eca845f33c9727652486d62885174a",
  executionDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-recovery-execution-1ad202c3-v1",
  destinationDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-timeout-fixed-v1",
  executable: { path: "/Users/lains/.hermes/node/bin/node", sha256: "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c" },
  loader: { path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final/node_modules/tsx/dist/loader.mjs",
    sha256: "274e965b148911ea8ccd08923aecf1b898e46db70c8c5a5071b1cc6035f5851d" },
  modules: Object.freeze({
    promoteCli: { path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final/scripts/live/promote-clutchpacks-production.mts",
      sha256: "91911ba0b8952027d97801615a0414eeaafac2d690ec0733c2e23c866c5c306a" },
    convexRuntime: { path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final/scripts/live/clutchpacks-production-convex-runtime.mts",
      sha256: "b5a67cf97b435e27d78ea38211c087b542d30ce606f9c16555a0cb8383b2614a" },
    publicationOrchestrator: { path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final/scripts/live/clutchpacks-production-v3-publication.mts",
      sha256: "9d9f59cea89d78fa4f56ffd996f96cb5c7476a6d73155c40603ab1478cf48ff1" },
    publicationPolicy: { path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final/scripts/live/clutchpacks-production-publication-policy.mts",
      sha256: "29383064ab860e29e7d5e0380b2b6fa0468746b5ff3c69b8d50aff3faaa3bc74" },
    genericPublisher: { path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-production-timeout-only-final/packages/services/src/buyback-adjusted-ev-release-publisher.ts",
      sha256: "787c80bdb03cc0a93728da8ca67c2995111f96ff6b23c2f1c3c9832d2dba5f6d" },
  }),
  environmentKeys: Object.freeze(["HOME", "NODE_ENV", "PATH", "TMPDIR"]),
});
function safeEnvironment(environment: NodeJS.ProcessEnv) {
  const values = z.object({ HOME: z.string().min(1), PATH: z.string().min(1), TMPDIR: z.string().min(1) })
    .passthrough().parse(environment);
  return { HOME: values.HOME, NODE_ENV: "production", PATH: values.PATH, TMPDIR: values.TMPDIR };
}
async function regularPin(file: string, maximum = 128 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum || await realpath(file) !== file) {
      refuse("POST_HEAD_RECOVERY_EXECUTABLE_INVALID");
    }
    return { path: file, sha256: artifact.hashBytes(await handle.readFile()) };
  } finally { await handle.close(); }
}
async function verifyModules(worktree: string, pins: z.infer<typeof modulePins>) {
  for (const [key, relative] of Object.entries(moduleRelativePaths)) {
    const expected = path.join(worktree, relative), pin = pins[key as keyof typeof pins];
    if (pin.path !== expected || !same(await regularPin(expected, 8 * 1024 * 1024), pin)) {
      refuse("POST_HEAD_RECOVERY_MODULE_INVALID");
    }
  }
}
async function verifyExecutor(worktree: string, pins: z.infer<typeof executorPins>) {
  for (const [key, relative] of Object.entries(executorRelativePaths)) {
    const expected = path.join(worktree, relative), pin = pins[key as keyof typeof pins];
    if (pin.path !== expected || !same(await regularPin(expected, 8 * 1024 * 1024), pin)) {
      refuse("POST_HEAD_RECOVERY_MODULE_INVALID");
    }
  }
}
async function readExecutorPolicy(subject: {
  executorPolicy: z.infer<typeof filePin>; publisher: z.infer<typeof publisherIdentity>;
  executor: z.infer<typeof executorIdentity>; executionDirectory: string;
}, destinationDirectory: string | undefined, policy: RecoveryPolicy) {
  if (policy.production && subject.executorPolicy.path !== productionPolicy.executorPolicyPath) {
    refuse("POST_HEAD_RECOVERY_EXECUTOR_POLICY_INVALID");
  }
  await artifact.directory(path.dirname(subject.executorPolicy.path));
  const bytes = await pinned(subject.executorPolicy, 1_048_576);
  const parsed = executorPolicySchema.safeParse(artifact.parseJsonBytes(bytes));
  if (!parsed.success) refuse("POST_HEAD_RECOVERY_EXECUTOR_POLICY_INVALID");
  const document = parsed.data!;
  const { policySha256, ...core } = document;
  const importedRecoveryModulePath = policy.importedRecoveryModulePath ?? subject.executor.modules.recovery.path;
  if (artifact.digest(core) !== policySha256 || !same(document.executor, subject.executor) ||
    !same(document.publisher, subject.publisher) || document.executionDirectory !== subject.executionDirectory ||
    (destinationDirectory !== undefined && document.destinationDirectory !== destinationDirectory) ||
    document.importedRecoveryModule.path !== importedRecoveryModulePath ||
    document.importedRecoveryModule.path !== path.join(document.executor.worktree, executorRelativePaths.recovery) ||
    !same(document.importedRecoveryModule, document.executor.modules.recovery) ||
    !same(await regularPin(importedRecoveryModulePath, 8 * 1024 * 1024), document.importedRecoveryModule)) {
    refuse("POST_HEAD_RECOVERY_EXECUTOR_POLICY_INVALID");
  }
  if (policy.production && (document.publisher.worktree !== productionPolicy.publisherWorktree ||
    document.publisher.commit !== productionPolicy.publisherCommit || !same(document.publisher.modules, productionPolicy.modules) ||
    document.executionDirectory !== productionPolicy.executionDirectory ||
    document.destinationDirectory !== productionPolicy.destinationDirectory)) {
    refuse("POST_HEAD_RECOVERY_EXECUTOR_POLICY_INVALID");
  }
  return { pin: subject.executorPolicy, document };
}
function validateProductionPublisher(publisher: z.infer<typeof executionInputSchema>["publisher"], policy: RecoveryPolicy) {
  if (!policy.production) return;
  if (publisher.worktree !== productionPolicy.publisherWorktree || publisher.commit !== productionPolicy.publisherCommit ||
    !same(publisher.modules, productionPolicy.modules)) refuse("POST_HEAD_RECOVERY_PUBLISHER_INVALID");
}
function validateProductionExecution(input: z.infer<typeof executionInputSchema>, policy: RecoveryPolicy) {
  if (!policy.production) return;
  validateProductionPublisher(input.publisher, policy);
  if (input.executionDirectory !== productionPolicy.executionDirectory) refuse("POST_HEAD_RECOVERY_EXECUTION_PATH_INVALID");
}
function validateProductionDestination(input: z.infer<typeof inputSchema>, policy: RecoveryPolicy) {
  if (!policy.production) return;
  if (input.destination.artifactDirectory !== productionPolicy.destinationDirectory ||
    input.destination.publisherWorktree !== productionPolicy.publisherWorktree ||
    input.destination.publisherCommit !== productionPolicy.publisherCommit) refuse("POST_HEAD_RECOVERY_DESTINATION_INVALID");
}
async function oldRootInventory(root: string) {
  const entries: z.infer<typeof oldRootInventorySchema>["entries"] = [];
  let totalBytes = 0;
  async function visit(file: string, relativePath: string): Promise<void> {
    if (entries.length >= 20_000) refuse("POST_HEAD_RECOVERY_INVENTORY_INVALID");
    const before = await lstat(file);
    if (before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 ||
      await realpath(file) !== file) refuse("POST_HEAD_RECOVERY_INVENTORY_INVALID");
    const common = { relativePath, uid: before.uid, mode: before.mode & 0o7777, size: before.size };
    if (before.isDirectory()) {
      const names = (await readdir(file)).sort();
      entries.push({ ...common, type: "directory" });
      for (const name of names) {
        if (name.length === 0 || name === "." || name === ".." || /[\/\r\n\0]/u.test(name)) {
          refuse("POST_HEAD_RECOVERY_INVENTORY_INVALID");
        }
        await visit(path.join(file, name), relativePath === "." ? name : path.join(relativePath, name));
      }
      const after = await lstat(file), finalNames = (await readdir(file)).sort();
      if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode ||
        after.size !== before.size || !same(finalNames, names) || after.isSymbolicLink() || await realpath(file) !== file) {
        refuse("POST_HEAD_RECOVERY_INVENTORY_CHANGED");
      }
      return;
    }
    if (!before.isFile() || before.size > 256 * 1024 * 1024 || totalBytes + before.size > 1024 * 1024 * 1024) {
      refuse("POST_HEAD_RECOVERY_INVENTORY_INVALID");
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer, opened: Stats;
    try { opened = await handle.stat(); bytes = await handle.readFile(); }
    finally { await handle.close(); }
    const after = await lstat(file); totalBytes += bytes.length;
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid ||
      opened.mode !== before.mode || opened.size !== before.size || bytes.length !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode ||
      after.size !== before.size || after.isSymbolicLink() || await realpath(file) !== file) {
      refuse("POST_HEAD_RECOVERY_INVENTORY_CHANGED");
    }
    entries.push({ ...common, type: "file", sha256: artifact.hashBytes(bytes) });
  }
  await visit(root, ".");
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const parsed = oldRootInventorySchema.shape.entries.parse(entries);
  return oldRootInventorySchema.parse({ entries: parsed, inventorySha256: artifact.digest(parsed) });
}
async function assertOldRootInventory(root: string, expected: z.infer<typeof oldRootInventorySchema>) {
  const actual = await oldRootInventory(root);
  if (!same(actual, expected)) refuse("POST_HEAD_RECOVERY_INVENTORY_CHANGED");
}
const recoveryLeaseSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_lease_attempt_v1"),
  bundleSha256: hash, attemptId: z.uuid(), intentSha256: hash,
  request: z.object({ role: z.literal("import"), owner: z.string().min(1).max(512),
    leaseMilliseconds: z.literal(900_000) }).strict(), requestSha256: hash }).strict();
const recoveryObservationSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_observation_attempt_v1"),
  bundleSha256: hash, intentSha256: hash, request: z.object({
    operationId: z.string().regex(/^clutchpacks-observation:[a-f0-9]{64}:[0-9]+$/u),
    idempotencyKey: z.string().regex(/^clutchpacks-observation:[a-f0-9]{64}:[0-9]+$/u),
    publicReleaseId: z.uuid(), releaseFingerprint: hash, observationSequence: z.number().int().safe().positive(),
    observedAt: iso }).passthrough(), requestSha256: hash }).strict();
async function validatePublisherSidecars(pins: readonly z.infer<typeof filePin>[], executionDirectory: string,
  bundle: { bundleSha256: string; intent: { operationId: string;
    candidate: { publicReleaseId: string; releaseFingerprint: string } } }, receiptPath: string) {
  if (pins.length !== 3 || new Set(pins.map(pin => pin.path)).size !== 3 ||
    pins.some(pin => path.dirname(pin.path) !== executionDirectory)) refuse("POST_HEAD_RECOVERY_SIDECAR_INVALID");
  const leasePins = pins.filter(pin => /^bundle\.json\.lease\.[a-f0-9-]{36}\.json$/u.test(path.basename(pin.path)));
  const observationPins = pins.filter(pin => /^bundle\.json\.observation\.[0-9]+\.json$/u.test(path.basename(pin.path)));
  const receiptPins = pins.filter(pin => /^bundle\.json\.receipt\.[a-f0-9-]{36}\.json$/u.test(path.basename(pin.path)));
  if (leasePins.length !== 1 || observationPins.length !== 1 || receiptPins.length !== 1 || receiptPins[0]?.path !== receiptPath) {
    refuse("POST_HEAD_RECOVERY_SIDECAR_INVALID");
  }
  const leaseResult = recoveryLeaseSchema.safeParse(artifact.parseJsonBytes(await pinned(leasePins[0]!, 65_536)));
  const observationResult = recoveryObservationSchema.safeParse(artifact.parseJsonBytes(await pinned(observationPins[0]!, 1_048_576)));
  if (!leaseResult.success) refuse("POST_HEAD_RECOVERY_SIDECAR_INVALID");
  if (!observationResult.success) refuse("POST_HEAD_RECOVERY_SIDECAR_INVALID");
  const lease = leaseResult.data!, observation = observationResult.data!;
  const intentSha256 = artifact.digest(bundle.intent), request = observation.request;
  if (path.basename(leasePins[0]!.path) !== `bundle.json.lease.${lease.attemptId}.json` ||
    lease.bundleSha256 !== bundle.bundleSha256 || lease.intentSha256 !== intentSha256 ||
    lease.request.owner !== `production-publication:${bundle.intent.operationId}:${lease.attemptId}` ||
    lease.requestSha256 !== artifact.digest(lease.request) ||
    path.basename(observationPins[0]!.path) !== `bundle.json.observation.${request.observationSequence}.json` ||
    observation.bundleSha256 !== bundle.bundleSha256 || observation.intentSha256 !== intentSha256 ||
    observation.requestSha256 !== artifact.digest(request) || request.publicReleaseId !== bundle.intent.candidate.publicReleaseId ||
    request.releaseFingerprint !== bundle.intent.candidate.releaseFingerprint || request.idempotencyKey !== request.operationId ||
    request.operationId !== clutchpacksProductionObservationOperationId(bundle.intent, request.observedAt)) {
    refuse("POST_HEAD_RECOVERY_SIDECAR_INVALID");
  }
}
async function pinned(pin: z.infer<typeof filePin>, maximum = 64 * 1024 * 1024, minimum = 1) {
  const bytes = await artifact.readPrivate(pin.path, maximum, minimum);
  if (artifact.hashBytes(bytes) !== pin.sha256) refuse("POST_HEAD_RECOVERY_INPUT_CHANGED");
  return bytes;
}
function exactOldPaths(head: z.infer<typeof clutchpacksProductionPostHeadSchema>, old: z.infer<typeof oldIncidentPins>) {
  const oldRun = path.join(old.artifactDirectory, head.runId);
  const publishAttempt = path.dirname(old.failure.publishStarted.path);
  if (old.pendingHead.path !== path.join(old.artifactDirectory, "pending", "head.json") ||
    old.journal.path !== path.join(oldRun, "head.json") || old.sourceConfig.path !== path.join(oldRun, "source-config.json") ||
    old.bundle.path !== path.join(oldRun, "bundle.json") ||
    path.dirname(old.failure.pendingBlocked.path) !== path.join(old.artifactDirectory, "pending") ||
    !/^blocked-[a-f0-9-]{36}\.json$/u.test(path.basename(old.failure.pendingBlocked.path)) ||
    path.dirname(publishAttempt) !== oldRun || !/^attempt-[a-f0-9-]{36}$/u.test(path.basename(publishAttempt)) ||
    old.failure.publishStarted.path !== path.join(publishAttempt, "publish.started.json") ||
    old.failure.publishStderr.path !== path.join(publishAttempt, "publish.stderr") ||
    path.dirname(old.failure.leaseAttempt.path) !== oldRun ||
    !/^bundle\.json\.lease\.[a-f0-9-]{36}\.json$/u.test(path.basename(old.failure.leaseAttempt.path))) {
    refuse("POST_HEAD_RECOVERY_PATH_INVALID");
  }
}
function validateExactIncident(input: { head: z.infer<typeof clutchpacksProductionPostHeadSchema>;
  old: z.infer<typeof oldIncidentPins> }, bundle: { bundleSha256: string;
    intent: { operationId: string; candidate: { publicReleaseId: string } } }) {
  const run = path.join(incident.oldRoot, incident.runId), attempt = path.join(run, `attempt-${incident.attemptId}`);
  const expected = { pendingHead: { path: path.join(incident.oldRoot, "pending", "head.json"), sha256: incident.pendingRaw },
    journal: { path: path.join(run, "head.json"), sha256: incident.journalRaw },
    sourceConfig: { path: path.join(run, "source-config.json"), sha256: incident.sourceConfigRaw },
    bundle: { path: path.join(run, "bundle.json"), sha256: incident.bundleRaw },
    failure: { pendingBlocked: { path: path.join(incident.oldRoot, "pending", "blocked-61001fdb-b4ca-43e7-b396-071e723fc37e.json"), sha256: incident.blockedRaw },
      publishStarted: { path: path.join(attempt, "publish.started.json"), sha256: incident.startedRaw },
      publishStderr: { path: path.join(attempt, "publish.stderr"), sha256: incident.stderrRaw },
      leaseAttempt: { path: path.join(run, `bundle.json.lease.${incident.leaseAttemptId}.json`), sha256: incident.leaseRaw } } };
  if (!same(input.head, incident.head) || input.old.artifactDirectory !== incident.oldRoot ||
    input.old.publisherWorktree !== incident.oldWorktree || input.old.publisherCommit !== incident.oldCommit ||
    !same({ pendingHead: input.old.pendingHead, journal: input.old.journal, sourceConfig: input.old.sourceConfig,
      bundle: input.old.bundle, failure: input.old.failure }, expected) || bundle.bundleSha256 !== incident.bundleSha256 ||
    bundle.intent.operationId !== incident.operationId || bundle.intent.candidate.publicReleaseId !== incident.candidateId) {
    refuse("POST_HEAD_RECOVERY_INCIDENT_MISMATCH");
  }
}
async function reserve(input: z.output<typeof inputSchema>) {
  const root = input.destination.artifactDirectory;
  if (await realpath(path.dirname(root)) !== path.dirname(root)) refuse("POST_HEAD_RECOVERY_PATH_INVALID");
  try { await mkdir(root, { mode: 0o700 }); }
  catch { return refuse("POST_HEAD_RECOVERY_DESTINATION_EXISTS"); }
  await artifact.syncDirectory(path.dirname(root));
  const pending = path.join(root, "pending");
  try { await mkdir(pending, { mode: 0o700 }); }
  catch { return refuse("POST_HEAD_RECOVERY_SEED_FAILED"); }
  await artifact.syncDirectory(root);
  const headPath = path.join(pending, "head.json");
  await artifact.writeExclusive(headPath, { head: input.head, publisherCommit: input.destination.publisherCommit });
  return { directory: pending, head: await privatePin(headPath, 65_536) };
}
async function unchanged(pins: readonly z.infer<typeof filePin>[]) {
  for (const pin of pins) if (artifact.hashBytes(await artifact.readPrivate(pin.path, 64 * 1024 * 1024, 0)) !== pin.sha256) {
    refuse("POST_HEAD_RECOVERY_INPUT_CHANGED");
  }
}
async function validateOldIncident(input: { head: z.infer<typeof clutchpacksProductionPostHeadSchema>;
  old: z.infer<typeof oldIncidentPins> }, dependencies: RecoveryDependencies, policy: RecoveryPolicy) {
  exactOldPaths(input.head, input.old);
  const run = path.join(input.old.artifactDirectory, input.head.runId), attempt = path.dirname(input.old.failure.publishStarted.path);
  await artifact.directory(input.old.artifactDirectory); await artifact.directory(path.join(input.old.artifactDirectory, "pending"));
  await artifact.directory(run); await artifact.directory(attempt);
  const pins = [input.old.pendingHead, input.old.journal, input.old.sourceConfig, input.old.bundle,
    input.old.failure.pendingBlocked, input.old.failure.publishStarted, input.old.failure.publishStderr,
    input.old.failure.leaseAttempt] as const;
  const [pendingBytes, journalBytes, configBytes, bundleBytes, blockedBytes, startedBytes, stderrBytes, leaseBytes] =
    await Promise.all([pinned(input.old.pendingHead, 65_536), pinned(input.old.journal, 65_536),
      pinned(input.old.sourceConfig, 1_048_576), pinned(input.old.bundle), pinned(input.old.failure.pendingBlocked, 65_536),
      pinned(input.old.failure.publishStarted, 65_536), pinned(input.old.failure.publishStderr, 65_536),
      pinned(input.old.failure.leaseAttempt, 65_536)]);
  const pending = artifact.parsePendingHead(artifact.parseJsonBytes(pendingBytes));
  const journal = artifact.parseJournal(artifact.parseJsonBytes(journalBytes));
  const config = artifact.parseSourceConfig(artifact.parseJsonBytes(configBytes));
  if (!same(pending.head, input.head) || pending.publisherCommit !== input.old.publisherCommit ||
    !same(journal.head, input.head) || journal.publisherWorktree !== input.old.publisherWorktree ||
    journal.publisherCommit !== input.old.publisherCommit || journal.residentAuthorityDigest !== input.head.authorityDigest ||
    journal.sourceConfigSha256 !== artifact.digest(config)) refuse("POST_HEAD_RECOVERY_OLD_JOURNAL_INVALID");
  if (policy.production && !same(journal.baseSourceConfig, { path: incident.basePath, sha256: incident.baseRaw })) {
    refuse("POST_HEAD_RECOVERY_INCIDENT_MISMATCH");
  }
  await artifact.directory(path.dirname(journal.baseSourceConfig.path));
  const baseBytes = await pinned(journal.baseSourceConfig, 1_048_576);
  const oldOptions = artifact.parseOptions({ head: input.head, baseSourceConfig: journal.baseSourceConfig,
    artifactDirectory: input.old.artifactDirectory, publisherWorktree: input.old.publisherWorktree,
    expectedPublisherCommit: input.old.publisherCommit, expectedResidentAuthorityDigest: input.head.authorityDigest,
    timeoutMs: 900_000 });
  await artifact.verifyCheckout(oldOptions, safeEnvironment(process.env), { git: dependencies.git });
  const context = artifact.postHeadContext(oldOptions, baseBytes);
  if (!same(context.config, config) || !same(context.journal, journal)) refuse("POST_HEAD_RECOVERY_OLD_JOURNAL_INVALID");
  const bundle = artifact.boundBundleBytes(bundleBytes, config, input.head);
  const blocked = z.object({ status: z.literal("blocked"), code: z.literal("POST_HEAD_CHILD_FAILED") }).strict()
    .parse(artifact.parseJsonBytes(blockedBytes));
  const started = z.object({ phase: z.literal("publish"),
    args: z.tuple([z.literal("--publish"), absolute]) }).strict().parse(artifact.parseJsonBytes(startedBytes));
  const stderr = z.object({ status: z.literal("refused"), code: z.literal("PRODUCTION_PUBLICATION_FAILED") }).strict()
    .parse(artifact.parseJsonBytes(stderrBytes));
  const lease = z.object({ schemaVersion: z.literal("clutchpacks_production_lease_attempt_v1"), bundleSha256: hash,
    attemptId: z.uuid(), intentSha256: hash, request: z.object({ role: z.literal("import"), owner: z.string().min(1).max(512),
      leaseMilliseconds: z.literal(900_000) }).strict(), requestSha256: hash }).strict().parse(artifact.parseJsonBytes(leaseBytes));
  if (started.args[1] !== input.old.bundle.path || lease.bundleSha256 !== bundle.bundleSha256 ||
    lease.intentSha256 !== artifact.digest(bundle.intent) ||
    lease.request.owner !== `production-publication:${bundle.intent.operationId}:${lease.attemptId}` ||
    lease.requestSha256 !== artifact.digest(lease.request) ||
    path.basename(input.old.failure.leaseAttempt.path) !== `bundle.json.lease.${lease.attemptId}.json` ||
    blocked.status !== "blocked" || stderr.status !== "refused") refuse("POST_HEAD_RECOVERY_FAILURE_EVIDENCE_INVALID");
  if (policy.production) validateExactIncident(input, bundle);
  return { pins, baseBytes, bundleBytes, config, bundle, journal, oldOptions, lease };
}

function checkoutOptions(worktree: string, expectedCommit: string, artifactDirectory: string,
  head: z.infer<typeof clutchpacksProductionPostHeadSchema>, baseSourceConfig: z.infer<typeof filePin>) {
  return artifact.parseOptions({ head, baseSourceConfig, artifactDirectory, publisherWorktree: worktree,
    expectedPublisherCommit: expectedCommit, expectedResidentAuthorityDigest: head.authorityDigest, timeoutMs: 900_000 });
}
async function createDirectoryExclusive(directory: string) {
  await artifact.directory(path.dirname(directory));
  try { await mkdir(directory, { mode: 0o700 }); }
  catch { return refuse("POST_HEAD_RECOVERY_EXECUTION_EXISTS"); }
  await artifact.syncDirectory(path.dirname(directory)); await artifact.directory(directory);
}
async function privatePin(file: string, maximum = 1_048_576, minimum = 1) {
  return { path: file, sha256: artifact.hashBytes(await artifact.readPrivate(file, maximum, minimum)) };
}

async function executeRecoveryCore(
  raw: ClutchpacksProductionPostHeadRecoveryExecutionInput,
  dependencies: RecoveryDependencies, policy: RecoveryPolicy) {
  let ownedDirectory: string | undefined;
  try {
    const input = executionInputSchema.parse(raw); validateProductionExecution(input, policy);
    const executorPolicy = await readExecutorPolicy(input,
      policy.production ? productionPolicy.destinationDirectory : undefined, policy);
    const old = await validateOldIncident(input, dependencies, policy);
    if (input.executionDirectory === input.old.artifactDirectory ||
      input.executionDirectory.startsWith(`${input.old.artifactDirectory}${path.sep}`) ||
      input.executionDirectory === input.publisher.worktree ||
      input.executionDirectory.startsWith(`${input.publisher.worktree}${path.sep}`) ||
      input.executionDirectory === input.executor.worktree ||
      input.executionDirectory.startsWith(`${input.executor.worktree}${path.sep}`)) {
      refuse("POST_HEAD_RECOVERY_EXECUTION_PATH_INVALID");
    }
    const environment = safeEnvironment(process.env);
    const publisherOptions = checkoutOptions(input.publisher.worktree, input.publisher.commit,
      input.executionDirectory, input.head, old.journal.baseSourceConfig);
    const executorOptions = checkoutOptions(input.executor.worktree, input.executor.commit,
      input.executionDirectory, input.head, old.journal.baseSourceConfig);
    await artifact.verifyCheckout(publisherOptions, environment, { git: dependencies.git }, Object.values(moduleRelativePaths));
    await verifyModules(input.publisher.worktree, input.publisher.modules);
    await artifact.verifyCheckout(executorOptions, environment, { git: dependencies.git }, Object.values(executorRelativePaths));
    await verifyExecutor(input.executor.worktree, input.executor.modules);
    const inventory = await oldRootInventory(input.old.artifactDirectory);
    const executionBundlePath = path.join(input.executionDirectory, "bundle.json");
    const args = ["--publish", executionBundlePath] as const;
    const invocation = artifact.commandInvocation(publisherOptions, args);
    const executable = await regularPin(invocation.file), loader = await regularPin(invocation.loader, 8 * 1024 * 1024);
    if (!same(await regularPin(invocation.cli, 8 * 1024 * 1024), input.publisher.modules.promoteCli)) {
      refuse("POST_HEAD_RECOVERY_MODULE_INVALID");
    }
    if (policy.production && (!same(executable, productionPolicy.executable) || !same(loader, productionPolicy.loader) ||
      !same(Object.keys(environment).sort(), [...productionPolicy.environmentKeys].sort()))) {
      refuse("POST_HEAD_RECOVERY_RUNTIME_INVALID");
    }
    await createDirectoryExclusive(input.executionDirectory); ownedDirectory = input.executionDirectory;
    await artifact.writeBytesExclusive(executionBundlePath, old.bundleBytes);
    const executionBundle = await privatePin(executionBundlePath, 64 * 1024 * 1024);
    const attemptDirectory = path.join(input.executionDirectory, `attempt-${randomUUID()}`);
    await mkdir(attemptDirectory, { mode: 0o700 }); await artifact.syncDirectory(input.executionDirectory);
    await artifact.directory(attemptDirectory);
    const now = dependencies.now ?? (() => new Date().toISOString());
    const startedAt = now(); if (!iso.safeParse(startedAt).success) refuse("POST_HEAD_RECOVERY_EXECUTION_TIME_INVALID");
    const startedCore = { schemaVersion: "clutchpacks_production_post_head_recovery_execution_started_v1" as const,
      startedAt, head: input.head, old: input.old, publisher: input.publisher, executor: input.executor,
      executorPolicy: executorPolicy.pin,
      oldRootInventory: inventory,
      executionDirectory: input.executionDirectory, attemptDirectory, originalBundle: input.old.bundle,
      executionBundle, bundleSha256: old.bundle.bundleSha256, intentSha256: artifact.digest(old.bundle.intent),
      operationId: old.bundle.intent.operationId, candidate: old.bundle.intent.candidate };
    const started = executionStartedSchema.parse({ ...startedCore, manifestSha256: artifact.digest(startedCore) });
    const startedPath = path.join(input.executionDirectory, "execution.started.json");
    await artifact.writeExclusive(startedPath, started);
    const invocationCore = { schemaVersion: "clutchpacks_production_post_head_recovery_invocation_v1" as const,
      recordedAt: startedAt, executable, loader, cli: input.publisher.modules.promoteCli,
      cwd: input.publisher.worktree, argv: [invocation.file, ...invocation.args], environmentKeys: Object.keys(environment).sort() };
    const invocationRecord = invocationSchema.parse({ ...invocationCore, invocationSha256: artifact.digest(invocationCore) });
    const invocationPath = path.join(input.executionDirectory, "execution.argv.json");
    await artifact.writeExclusive(invocationPath, invocationRecord);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    dependencies.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (dependencies.signal?.aborted) controller.abort();
    const cancel = (dependencies.startDeadline ?? ((abort, milliseconds) => {
      const timer = setTimeout(abort, milliseconds); return () => clearTimeout(timer);
    }))(() => controller.abort(), input.deadlineMs);
    let output: unknown;
    try {
      output = await artifact.command(args, publisherOptions, attemptDirectory, "publish", environment,
        controller.signal, { git: dependencies.git, spawn: dependencies.spawn, kill: dependencies.kill });
    } finally { cancel(); dependencies.signal?.removeEventListener("abort", forwardAbort); }
    const verified = artifact.parseVerifiedOutput(output);
    if (verified.bundleSha256 !== old.bundle.bundleSha256 || verified.operationId !== old.bundle.intent.operationId ||
      verified.publicReleaseId !== old.bundle.intent.candidate.publicReleaseId) refuse("POST_HEAD_RECOVERY_EXECUTION_OUTPUT_INVALID");
    const receiptBytes = await artifact.readPrivate(verified.receiptPath, 65_536);
    const evidence = artifact.receiptEvidenceBytes(verified, old.bundle, executionBundlePath, input.head, receiptBytes);
    const completedAt = now(), receipt = artifact.parseReceiptBytes(receiptBytes);
    if (!iso.safeParse(completedAt).success || completedAt < startedAt || receipt.verifiedAt < startedAt ||
      receipt.verifiedAt > completedAt) refuse("POST_HEAD_RECOVERY_EXECUTION_TIME_INVALID");
    const readbackPath = path.join(input.executionDirectory, "execution.readback.json");
    await artifact.writeExclusive(readbackPath, evidence);
    const stdout = await privatePin(path.join(attemptDirectory, "publish.stdout"), 65_536);
    const stderr = await privatePin(path.join(attemptDirectory, "publish.stderr"), 65_536, 0);
    const commandCore = { schemaVersion: "clutchpacks_production_post_head_recovery_command_v1" as const,
      startedAt, completedAt, exitCode: 0 as const, invocationSha256: invocationRecord.invocationSha256,
      stdoutSha256: stdout.sha256, stderrSha256: stderr.sha256 };
    const commandRecord = commandRecordSchema.parse({ ...commandCore, commandSha256: artifact.digest(commandCore) });
    const commandPath = path.join(input.executionDirectory, "execution.command.completed.json");
    await artifact.writeExclusive(commandPath, commandRecord);
    const sidecarNames = (await readdir(input.executionDirectory)).filter(name =>
      /^bundle\.json\.(?:lease\.[a-f0-9-]{36}|observation\.[0-9]+|receipt\.[a-f0-9-]{36})\.json$/u.test(name)).sort();
    const publisherSidecars = await Promise.all(sidecarNames.map(name => privatePin(path.join(input.executionDirectory, name), 1_048_576)));
    if (!publisherSidecars.some(pin => pin.path === verified.receiptPath)) refuse("POST_HEAD_RECOVERY_EXECUTION_OUTPUT_INVALID");
    await validatePublisherSidecars(publisherSidecars, input.executionDirectory, old.bundle, verified.receiptPath);
    const artifacts = executionArtifactsSchema.parse({ executionStarted: await privatePin(startedPath),
      executionBundle, invocation: await privatePin(invocationPath),
      commandStarted: await privatePin(path.join(attemptDirectory, "publish.started.json"), 65_536), stdout, stderr,
      phaseCompleted: await privatePin(path.join(attemptDirectory, "publish.completed.json"), 65_536),
      commandCompleted: await privatePin(commandPath), readback: await privatePin(readbackPath),
      receipt: { path: verified.receiptPath, sha256: artifact.hashBytes(receiptBytes) }, publisherSidecars });
    const executionPins = [artifacts.executionStarted, artifacts.executionBundle, artifacts.invocation,
      artifacts.commandStarted, artifacts.stdout, artifacts.stderr, artifacts.phaseCompleted, artifacts.commandCompleted,
      artifacts.readback, artifacts.receipt, ...artifacts.publisherSidecars];
    await unchanged([...old.pins, old.journal.baseSourceConfig, executorPolicy.pin, ...executionPins]);
    const finalSidecarNames = (await readdir(input.executionDirectory)).filter(name =>
      /^bundle\.json\.(?:lease\.[a-f0-9-]{36}|observation\.[0-9]+|receipt\.[a-f0-9-]{36})\.json$/u.test(name)).sort();
    if (!same(finalSidecarNames, sidecarNames)) refuse("POST_HEAD_RECOVERY_SIDECAR_INVALID");
    await validatePublisherSidecars(artifacts.publisherSidecars, input.executionDirectory, old.bundle, verified.receiptPath);
    await assertOldRootInventory(input.old.artifactDirectory, inventory);
    await artifact.directory(input.executionDirectory); await artifact.directory(attemptDirectory);
    await artifact.verifyCheckout(old.oldOptions, environment, { git: dependencies.git });
    await artifact.verifyCheckout(publisherOptions, environment, { git: dependencies.git }, Object.values(moduleRelativePaths));
    await verifyModules(input.publisher.worktree, input.publisher.modules);
    await artifact.verifyCheckout(executorOptions, environment, { git: dependencies.git }, Object.values(executorRelativePaths));
    await verifyExecutor(input.executor.worktree, input.executor.modules);
    await readExecutorPolicy(input, policy.production ? productionPolicy.destinationDirectory : undefined, policy);
    if (!same(await regularPin(invocation.file), executable) || !same(await regularPin(invocation.loader, 8 * 1024 * 1024), loader)) {
      refuse("POST_HEAD_RECOVERY_EXECUTABLE_INVALID");
    }
    await assertOldRootInventory(input.old.artifactDirectory, inventory);
    const completedCore = { schemaVersion: "clutchpacks_production_post_head_recovery_execution_receipt_v1" as const,
      startedAt, completedAt, head: input.head, old: input.old, publisher: input.publisher, executor: input.executor,
      executorPolicy: executorPolicy.pin,
      oldRootInventory: inventory,
      executionDirectory: input.executionDirectory, attemptDirectory, startedManifestSha256: started.manifestSha256,
      bundleSha256: old.bundle.bundleSha256, intentSha256: artifact.digest(old.bundle.intent),
      operationId: old.bundle.intent.operationId, candidate: old.bundle.intent.candidate, artifacts, evidence };
    const completed = executionManifestSchema.parse({ ...completedCore, manifestSha256: artifact.digest(completedCore) });
    const manifestPath = path.join(input.executionDirectory, "execution.completed.json");
    await artifact.writeExclusive(manifestPath, completed);
    return { status: "verified" as const, manifest: await privatePin(manifestPath), receipt: artifacts.receipt,
      evidence, completedAt };
  } catch (error) {
    const code = error instanceof RecoveryError ? error.code : "POST_HEAD_RECOVERY_EXECUTION_FAILED";
    if (ownedDirectory) await artifact.writeExclusive(path.join(ownedDirectory, `blocked-${randomUUID()}.json`),
      { status: "blocked", code }).catch(() => undefined);
    return refuse(code);
  }
}

async function recoverArtifactsCore(raw: ClutchpacksProductionPostHeadRecoveryInput,
  dependencies: RecoveryDependencies, policy: RecoveryPolicy) {
  let destinationPending: Awaited<ReturnType<typeof reserve>> | undefined;
  try {
    const input = inputSchema.parse(raw); validateProductionDestination(input, policy);
    if (input.destination.artifactDirectory === input.old.artifactDirectory ||
      input.destination.artifactDirectory.startsWith(`${input.old.artifactDirectory}${path.sep}`) ||
      input.old.artifactDirectory.startsWith(`${input.destination.artifactDirectory}${path.sep}`)) {
      refuse("POST_HEAD_RECOVERY_PATH_INVALID");
    }
    const old = await validateOldIncident(input, dependencies, policy);
    if (!same(input.destination.baseSourceConfig, old.journal.baseSourceConfig) ||
      input.destination.residentAuthorityDigest !== input.head.authorityDigest) {
      refuse("POST_HEAD_RECOVERY_SOURCE_PINS_CHANGED");
    }
    await artifact.directory(path.dirname(input.old.executionManifest.path));
    const executionManifestBytes = await pinned(input.old.executionManifest, 1_048_576);
    const execution = executionManifestSchema.parse(artifact.parseJsonBytes(executionManifestBytes));
    validateProductionPublisher(execution.publisher, policy);
    if (policy.production && execution.executionDirectory !== productionPolicy.executionDirectory) {
      refuse("POST_HEAD_RECOVERY_EXECUTION_PATH_INVALID");
    }
    const { manifestSha256, ...executionCore } = execution;
    if (artifact.digest(executionCore) !== manifestSha256 || !same(execution.head, input.head) ||
      !same(execution.old, { artifactDirectory: input.old.artifactDirectory, publisherWorktree: input.old.publisherWorktree,
        publisherCommit: input.old.publisherCommit, pendingHead: input.old.pendingHead, journal: input.old.journal,
        sourceConfig: input.old.sourceConfig, bundle: input.old.bundle, failure: input.old.failure }) ||
      execution.publisher.worktree !== input.destination.publisherWorktree ||
      execution.publisher.commit !== input.destination.publisherCommit ||
      input.old.executionManifest.path !== path.join(execution.executionDirectory, "execution.completed.json") ||
      path.dirname(execution.attemptDirectory) !== execution.executionDirectory ||
      !/^attempt-[a-f0-9-]{36}$/u.test(path.basename(execution.attemptDirectory)) ||
      input.destination.artifactDirectory === execution.executionDirectory ||
      input.destination.artifactDirectory.startsWith(`${execution.executionDirectory}${path.sep}`) ||
      execution.executionDirectory.startsWith(`${input.destination.artifactDirectory}${path.sep}`)) {
      refuse("POST_HEAD_RECOVERY_EXECUTION_MANIFEST_INVALID");
    }
    const executorPolicy = await readExecutorPolicy(execution, input.destination.artifactDirectory, policy);
    const seedInventory = await oldRootInventory(input.old.artifactDirectory);
    if (!same(seedInventory, execution.oldRootInventory)) refuse("POST_HEAD_RECOVERY_INVENTORY_CHANGED");
    await artifact.directory(execution.executionDirectory); await artifact.directory(execution.attemptDirectory);
    const a = execution.artifacts;
    if (a.executionStarted.path !== path.join(execution.executionDirectory, "execution.started.json") ||
      a.executionBundle.path !== path.join(execution.executionDirectory, "bundle.json") ||
      a.invocation.path !== path.join(execution.executionDirectory, "execution.argv.json") ||
      a.commandCompleted.path !== path.join(execution.executionDirectory, "execution.command.completed.json") ||
      a.readback.path !== path.join(execution.executionDirectory, "execution.readback.json") ||
      a.commandStarted.path !== path.join(execution.attemptDirectory, "publish.started.json") ||
      a.stdout.path !== path.join(execution.attemptDirectory, "publish.stdout") ||
      a.stderr.path !== path.join(execution.attemptDirectory, "publish.stderr") ||
      a.phaseCompleted.path !== path.join(execution.attemptDirectory, "publish.completed.json") ||
      path.dirname(a.receipt.path) !== execution.executionDirectory ||
      !/^bundle\.json\.receipt\.[a-f0-9-]{36}\.json$/u.test(path.basename(a.receipt.path))) {
      refuse("POST_HEAD_RECOVERY_EXECUTION_MANIFEST_INVALID");
    }
    const executionPins = [execution.executorPolicy, a.executionStarted, a.executionBundle, a.invocation, a.commandStarted, a.stdout,
      a.stderr, a.phaseCompleted, a.commandCompleted, a.readback, a.receipt, ...a.publisherSidecars];
    const [startedBytes, copiedBundleBytes, invocationBytes, commandStartedBytes, stdoutBytes, stderrBytes,
      phaseCompletedBytes, commandBytes, readbackBytes, receiptBytes] = await Promise.all([
      pinned(a.executionStarted, 1_048_576), pinned(a.executionBundle), pinned(a.invocation, 1_048_576),
      pinned(a.commandStarted, 65_536), pinned(a.stdout, 65_536), pinned(a.stderr, 65_536, 0),
      pinned(a.phaseCompleted, 65_536), pinned(a.commandCompleted, 65_536), pinned(a.readback, 1_048_576),
      pinned(a.receipt, 65_536)]);
    if (artifact.hashBytes(copiedBundleBytes) !== input.old.bundle.sha256) refuse("POST_HEAD_RECOVERY_EXECUTION_MANIFEST_INVALID");
    const started = executionStartedSchema.parse(artifact.parseJsonBytes(startedBytes));
    const { manifestSha256: startedSha, ...startedCore } = started;
    const invocation = invocationSchema.parse(artifact.parseJsonBytes(invocationBytes));
    const { invocationSha256, ...invocationCore } = invocation;
    const command = commandRecordSchema.parse(artifact.parseJsonBytes(commandBytes));
    const { commandSha256, ...commandCore } = command;
    const commandStarted = z.object({ phase: z.literal("publish"),
      args: z.tuple([z.literal("--publish"), absolute]) }).strict().parse(artifact.parseJsonBytes(commandStartedBytes));
    const phaseCompleted = z.object({ phase: z.literal("publish") }).strict().parse(artifact.parseJsonBytes(phaseCompletedBytes));
    const stdout = artifact.parseVerifiedOutput(artifact.parseJsonBytes(stdoutBytes));
    const readback = artifact.parseJsonBytes(readbackBytes), receipt = artifact.parseReceiptBytes(receiptBytes);
    const environment = safeEnvironment(process.env);
    const publisherOptions = checkoutOptions(execution.publisher.worktree, execution.publisher.commit,
      execution.executionDirectory, input.head, old.journal.baseSourceConfig);
    const executorOptions = checkoutOptions(execution.executor.worktree, execution.executor.commit,
      execution.executionDirectory, input.head, old.journal.baseSourceConfig);
    const expectedInvocation = artifact.commandInvocation(publisherOptions, ["--publish", a.executionBundle.path]);
    if (policy.production && (!same(invocation.executable, productionPolicy.executable) ||
      !same(invocation.loader, productionPolicy.loader) || !same(invocation.cli, productionPolicy.modules.promoteCli) ||
      !same(invocation.environmentKeys, [...productionPolicy.environmentKeys]))) {
      refuse("POST_HEAD_RECOVERY_RUNTIME_INVALID");
    }
    if (execution.bundleSha256 !== old.bundle.bundleSha256 || execution.intentSha256 !== artifact.digest(old.bundle.intent) ||
      execution.operationId !== old.bundle.intent.operationId || !same(execution.candidate, old.bundle.intent.candidate) ||
      artifact.digest(startedCore) !== startedSha || startedSha !== execution.startedManifestSha256 ||
      !same(started.head, execution.head) || !same(started.old, execution.old) ||
      !same(started.publisher, execution.publisher) || !same(started.executor, execution.executor) ||
      !same(started.executorPolicy, execution.executorPolicy) || !same(execution.executorPolicy, executorPolicy.pin) ||
      started.startedAt !== execution.startedAt || !same(started.oldRootInventory, execution.oldRootInventory) ||
      started.executionDirectory !== execution.executionDirectory || started.attemptDirectory !== execution.attemptDirectory ||
      !same(started.originalBundle, input.old.bundle) || !same(started.executionBundle, a.executionBundle) ||
      started.bundleSha256 !== execution.bundleSha256 || started.intentSha256 !== execution.intentSha256 ||
      started.operationId !== execution.operationId || !same(started.candidate, execution.candidate) ||
      artifact.digest(invocationCore) !== invocationSha256 || invocation.cwd !== execution.publisher.worktree ||
      invocation.recordedAt !== execution.startedAt || !same(invocation.environmentKeys, Object.keys(environment).sort()) ||
      !same(invocation.argv, [expectedInvocation.file, ...expectedInvocation.args]) ||
      !same(invocation.cli, execution.publisher.modules.promoteCli) || commandStarted.args[1] !== a.executionBundle.path ||
      stderrBytes.length !== 0 || phaseCompleted.phase !== "publish" || artifact.digest(commandCore) !== commandSha256 ||
      command.invocationSha256 !== invocation.invocationSha256 || command.stdoutSha256 !== a.stdout.sha256 ||
      command.stderrSha256 !== a.stderr.sha256 || command.startedAt !== execution.startedAt ||
      command.completedAt !== execution.completedAt || stdout.receiptPath !== a.receipt.path ||
      stdout.bundleSha256 !== old.bundle.bundleSha256 || stdout.operationId !== old.bundle.intent.operationId ||
      stdout.publicReleaseId !== old.bundle.intent.candidate.publicReleaseId || execution.startedAt > receipt.verifiedAt ||
      receipt.verifiedAt > execution.completedAt) refuse("POST_HEAD_RECOVERY_EXECUTION_MANIFEST_INVALID");
    if (!same(await regularPin(expectedInvocation.file), invocation.executable) ||
      !same(await regularPin(expectedInvocation.loader, 8 * 1024 * 1024), invocation.loader)) {
      refuse("POST_HEAD_RECOVERY_EXECUTABLE_INVALID");
    }
    const sidecarNames = (await readdir(execution.executionDirectory)).filter(name =>
      /^bundle\.json\.(?:lease\.[a-f0-9-]{36}|observation\.[0-9]+|receipt\.[a-f0-9-]{36})\.json$/u.test(name)).sort();
    if (!same(sidecarNames, a.publisherSidecars.map(pin => path.basename(pin.path)).sort()) ||
      a.publisherSidecars.some(pin => path.dirname(pin.path) !== execution.executionDirectory)) {
      refuse("POST_HEAD_RECOVERY_EXECUTION_MANIFEST_INVALID");
    }
    await validatePublisherSidecars(a.publisherSidecars, execution.executionDirectory, old.bundle, a.receipt.path);
    const executionEvidence = artifact.receiptEvidenceBytes(stdout, old.bundle, a.executionBundle.path, input.head, receiptBytes);
    if (!same(executionEvidence, readback) || !same(executionEvidence, execution.evidence) ||
      !a.publisherSidecars.some(pin => same(pin, a.receipt))) refuse("POST_HEAD_RECOVERY_EXECUTION_MANIFEST_INVALID");
    await artifact.verifyCheckout(publisherOptions, environment, { git: dependencies.git }, Object.values(moduleRelativePaths));
    await verifyModules(execution.publisher.worktree, execution.publisher.modules);
    await artifact.verifyCheckout(executorOptions, environment, { git: dependencies.git }, Object.values(executorRelativePaths));
    await verifyExecutor(execution.executor.worktree, execution.executor.modules);
    const destinationOptions = checkoutOptions(input.destination.publisherWorktree, input.destination.publisherCommit,
      input.destination.artifactDirectory, input.head, input.destination.baseSourceConfig);
    await artifact.verifyCheckout(destinationOptions, environment, { git: dependencies.git }, Object.values(moduleRelativePaths));
    await verifyModules(input.destination.publisherWorktree, execution.publisher.modules);
    const { config: destinationConfig, journal: destinationJournal } = artifact.postHeadContext(destinationOptions, old.baseBytes);
    if (!same(destinationConfig, old.config)) refuse("POST_HEAD_RECOVERY_SOURCE_PINS_CHANGED");
    destinationPending = await reserve(input);
    const run = path.join(input.destination.artifactDirectory, input.head.runId);
    await mkdir(run, { mode: 0o700 }); await artifact.syncDirectory(input.destination.artifactDirectory);
    const headPath = path.join(run, "head.json"), configPath = path.join(run, "source-config.json");
    const bundlePath = path.join(run, "bundle.json"), verifiedPath = path.join(run, "verified.json");
    const attestationPath = path.join(run, "recovery-attestation.json");
    const receiptPath = path.join(run, path.basename(a.receipt.path));
    await artifact.writeExclusive(headPath, destinationJournal);
    await artifact.writeBytesExclusive(configPath, await pinned(input.old.sourceConfig, 1_048_576));
    await artifact.writeBytesExclusive(bundlePath, old.bundleBytes); await artifact.writeBytesExclusive(receiptPath, receiptBytes);
    const destinationBundle = artifact.boundBundleBytes(old.bundleBytes, destinationConfig, input.head);
    const destinationOutput = { ...stdout, receiptPath };
    const evidence = artifact.receiptEvidenceBytes(destinationOutput, destinationBundle, bundlePath, input.head, receiptBytes);
    await artifact.writeExclusive(verifiedPath, evidence);
    const attestationCore = { schemaVersion: "clutchpacks_production_post_head_recovery_attestation_v1" as const,
      recoveredAt: execution.completedAt, head: input.head, headDigest: artifact.digest(input.head),
      operationId: destinationBundle.intent.operationId, candidate: destinationBundle.intent.candidate,
      predecessor: destinationBundle.intent.predecessor, publicationOutcome: receipt.publicationOutcome,
      generation: receipt.generation, activateReceiptDigest: receipt.activateReceiptDigest,
      old: { artifactDirectory: input.old.artifactDirectory, publisherWorktree: input.old.publisherWorktree,
        publisherCommit: input.old.publisherCommit, pendingHead: input.old.pendingHead, journal: input.old.journal,
        sourceConfig: input.old.sourceConfig, bundle: input.old.bundle, executionManifest: input.old.executionManifest,
        journalDigest: artifact.digest(old.journal), sourceConfigDigest: artifact.digest(old.config),
        bundleDigest: destinationBundle.bundleSha256, executionEvidenceDigest: artifact.digest(executionEvidence),
        rootInventorySha256: execution.oldRootInventory.inventorySha256,
        failure: { ...input.old.failure, postHeadAttemptId: path.basename(path.dirname(input.old.failure.publishStarted.path)).slice(8),
          leaseAttemptId: old.lease.attemptId } },
      execution: { publisher: execution.publisher, executor: execution.executor, directory: execution.executionDirectory,
        executorPolicy: execution.executorPolicy, manifestSha256: execution.manifestSha256,
        receipt: a.receipt, receiptSha256: artifact.hashBytes(receiptBytes) },
      destination: { artifactDirectory: input.destination.artifactDirectory,
        publisherWorktree: input.destination.publisherWorktree, publisherCommit: input.destination.publisherCommit,
        baseSourceConfig: input.destination.baseSourceConfig, journalDigest: artifact.digest(destinationJournal),
        sourceConfigDigest: artifact.digest(destinationConfig), bundleDigest: destinationBundle.bundleSha256,
        receiptSha256: artifact.hashBytes(receiptBytes), evidenceDigest: artifact.digest(evidence) } };
    const attestation = { ...attestationCore, attestationSha256: artifact.digest(attestationCore) };
    await artifact.writeExclusive(attestationPath, attestation);
    const destinationPins = { head: await privatePin(headPath), config: await privatePin(configPath, 1_048_576),
      bundle: await privatePin(bundlePath, 64 * 1024 * 1024), receipt: await privatePin(receiptPath, 65_536),
      verified: await privatePin(verifiedPath, 1_048_576), attestation: await privatePin(attestationPath, 1_048_576) };
    if (destinationPins.config.sha256 !== input.old.sourceConfig.sha256 ||
      destinationPins.bundle.sha256 !== input.old.bundle.sha256 || destinationPins.receipt.sha256 !== a.receipt.sha256) {
      refuse("POST_HEAD_RECOVERY_DESTINATION_INVALID");
    }
    await unchanged([...old.pins, old.journal.baseSourceConfig, input.old.executionManifest, ...executionPins]);
    const finalSidecarNames = (await readdir(execution.executionDirectory)).filter(name =>
      /^bundle\.json\.(?:lease\.[a-f0-9-]{36}|observation\.[0-9]+|receipt\.[a-f0-9-]{36})\.json$/u.test(name)).sort();
    if (!same(finalSidecarNames, sidecarNames)) refuse("POST_HEAD_RECOVERY_INPUT_CHANGED");
    await artifact.directory(execution.executionDirectory); await artifact.directory(execution.attemptDirectory);
    await artifact.verifyCheckout(old.oldOptions, environment, { git: dependencies.git });
    await artifact.verifyCheckout(publisherOptions, environment, { git: dependencies.git }, Object.values(moduleRelativePaths));
    await verifyModules(execution.publisher.worktree, execution.publisher.modules);
    await artifact.verifyCheckout(executorOptions, environment, { git: dependencies.git }, Object.values(executorRelativePaths));
    await verifyExecutor(execution.executor.worktree, execution.executor.modules);
    await readExecutorPolicy(execution, input.destination.artifactDirectory, policy);
    await artifact.verifyCheckout(destinationOptions, environment, { git: dependencies.git }, Object.values(moduleRelativePaths));
    await verifyModules(input.destination.publisherWorktree, execution.publisher.modules);
    if (!same(await regularPin(expectedInvocation.file), invocation.executable) ||
      !same(await regularPin(expectedInvocation.loader, 8 * 1024 * 1024), invocation.loader)) {
      refuse("POST_HEAD_RECOVERY_EXECUTABLE_INVALID");
    }
    await assertOldRootInventory(input.old.artifactDirectory, execution.oldRootInventory);
    await artifact.directory(input.destination.artifactDirectory); await artifact.directory(run);
    const [finalHeadBytes, finalConfigBytes, finalBundleBytes, finalReceiptBytes, finalVerifiedBytes, finalAttestationBytes] =
      await Promise.all([pinned(destinationPins.head, 65_536), pinned(destinationPins.config, 1_048_576),
        pinned(destinationPins.bundle), pinned(destinationPins.receipt, 65_536), pinned(destinationPins.verified, 1_048_576),
        pinned(destinationPins.attestation, 1_048_576)]);
    const finalHead = artifact.parseJournal(artifact.parseJsonBytes(finalHeadBytes));
    const finalConfig = artifact.parseSourceConfig(artifact.parseJsonBytes(finalConfigBytes));
    const finalBundle = artifact.boundBundleBytes(finalBundleBytes, finalConfig, input.head);
    const finalReceipt = artifact.parseReceiptBytes(finalReceiptBytes);
    const finalVerified = artifact.parseJsonBytes(finalVerifiedBytes);
    const finalAttestation = artifact.parseJsonBytes(finalAttestationBytes);
    const parsedAttestation = z.object({ attestationSha256: hash }).passthrough().parse(finalAttestation);
    const { attestationSha256, ...finalAttestationCore } = parsedAttestation;
    const finalEvidence = artifact.receiptEvidenceBytes({ ...stdout, receiptPath }, finalBundle,
      bundlePath, input.head, finalReceiptBytes);
    if (!same(finalHead, destinationJournal) || !same(finalConfig, destinationConfig) ||
      !same(finalBundle, destinationBundle) || !same(finalReceipt, receipt) || !same(finalVerified, evidence) ||
      !same(finalEvidence, evidence) || !same(finalAttestation, attestation) ||
      artifact.digest(finalAttestationCore) !== attestationSha256) refuse("POST_HEAD_RECOVERY_DESTINATION_INVALID");
    await unchanged(Object.values(destinationPins));
    await artifact.directory(input.destination.artifactDirectory); await artifact.directory(run);
    const pendingHeadBytes = await pinned(destinationPending.head, 65_536);
    const pendingHead = artifact.parsePendingHead(artifact.parseJsonBytes(pendingHeadBytes));
    if (!same(pendingHead, { head: input.head, publisherCommit: input.destination.publisherCommit })) {
      refuse("POST_HEAD_RECOVERY_DESTINATION_INVALID");
    }
    await unlink(destinationPending.head.path); await rmdir(destinationPending.directory);
    destinationPending = undefined; await artifact.syncDirectory(input.destination.artifactDirectory);
    return { status: "recovered" as const, artifactDirectory: input.destination.artifactDirectory,
      runDirectory: run, bundleSha256: destinationBundle.bundleSha256, receiptPath,
      receiptSha256: artifact.hashBytes(receiptBytes), evidence, attestation };
  } catch (error) {
    const code = error instanceof RecoveryError ? error.code : "POST_HEAD_RECOVERY_INVALID";
    if (destinationPending) await artifact.writeExclusive(path.join(destinationPending.directory, `blocked-${randomUUID()}.json`),
      { status: "blocked", code }).catch(() => undefined);
    return refuse(code);
  }
}

function productionDependencies(signal?: AbortSignal): RecoveryDependencies {
  return {
    signal,
    git: async (args, options) => (await promisify(execFile)("/usr/bin/git", [...args], {
      ...options, timeout: 10_000, maxBuffer: 1_048_576 })).stdout,
    spawn: (file, args, options) => spawnChild(file, [...args], options),
    kill: (child, kind) => {
      if (child.pid === undefined) throw new Error("Recovery publisher child has no process id.");
      process.kill(-child.pid, kind);
    },
    startDeadline: (abort, milliseconds) => {
      const timer = setTimeout(abort, milliseconds); return () => clearTimeout(timer);
    },
    now: () => new Date().toISOString(),
  };
}

/** Executes only the frozen one-shot incident plan with internally owned process dependencies. */
export async function executeClutchpacksProductionPostHeadRecoveryPublication(
  raw: ClutchpacksProductionPostHeadRecoveryExecutionInput, signal?: AbortSignal) {
  return executeRecoveryCore(raw, productionDependencies(signal),
    { production: true, importedRecoveryModulePath: fileURLToPath(import.meta.url) });
}

/** Seeds only the frozen successor root using internally owned checkout verification. */
export async function recoverClutchpacksProductionPostHeadArtifacts(raw: ClutchpacksProductionPostHeadRecoveryInput) {
  return recoverArtifactsCore(raw, productionDependencies(),
    { production: true, importedRecoveryModulePath: fileURLToPath(import.meta.url) });
}

/** Test-only core access. It is absent unless the importing process explicitly runs in test mode. */
export const clutchpacksProductionPostHeadRecoveryTestHarness = process.env.NODE_ENV === "test" ? Object.freeze({
  execute: (raw: ClutchpacksProductionPostHeadRecoveryExecutionInput, dependencies: RecoveryDependencies = {}) =>
    executeRecoveryCore(raw, dependencies, { production: false }),
  recover: (raw: ClutchpacksProductionPostHeadRecoveryInput, dependencies: RecoveryDependencies = {}) =>
    recoverArtifactsCore(raw, dependencies, { production: false }),
}) : undefined;
