import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat, realpath, unlink, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson } from "@packscout/contracts";
import { clutchpacksProductionSourceConfigSchema } from "./promote-clutchpacks-production.mts";
import { clutchpacksProductionPublicationIntentSchema as intentSchema,
  productionPublicationSha256 as digest } from "./clutchpacks-production-publication-policy.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
const iso = z.iso.datetime().refine(value => new Date(value).toISOString() === value);
const absolute = z.string().max(4096).refine(value => path.isAbsolute(value) && !/[\r\n\0]/u.test(value));
const count = z.number().int().safe().nonnegative();
export const clutchpacksProductionPostHeadSchema = z.object({ providerId: z.uuid(), configId: z.uuid(),
  configNumber: decimal, runId: z.uuid(), checkpointHash: hash, generation: decimal,
  runtimeRowVersion: decimal, headFinishedAt: iso, authorityDigest: hash }).strict();
export type ClutchpacksProductionPostHead = z.infer<typeof clutchpacksProductionPostHeadSchema>;
const optionsSchema = z.object({ head: clutchpacksProductionPostHeadSchema,
  baseSourceConfig: z.object({ path: absolute, sha256: hash }).strict(), artifactDirectory: absolute,
  publisherWorktree: absolute, expectedPublisherCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  expectedResidentAuthorityDigest: hash,
  timeoutMs: z.number().int().min(1).max(900_000).default(900_000) }).strict();
export interface ClutchpacksProductionPostHeadOptions extends z.input<typeof optionsSchema> {
  readonly signal?: AbortSignal;
}
const preparedSchema = z.object({ status: z.literal("prepared"), bundlePath: absolute, bundleSha256: hash,
  operationId: z.uuid(), publicReleaseId: z.uuid(), readAt: iso,
  qualityState: intentSchema.shape.source.shape.qualityState, quarantineCount: count }).strict();
const verifiedOutputSchema = preparedSchema.omit({ bundlePath: true, readAt: true }).extend({
  status: z.literal("verified"), receiptPath: absolute }).strict();
const bundleSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_bundle_v1"),
  sourceConfig: clutchpacksProductionSourceConfigSchema, sourceConfigSha256: hash, intent: intentSchema,
  approvedConfiguration: z.unknown(), plan: z.object({ manifest: z.object({ counts: z.object({ repacks: count.positive() }).passthrough() }).passthrough() }).passthrough(),
  productionInventory: z.unknown(), productionInventorySha256: hash, bundleSha256: hash }).strict();
const receiptSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_publication_receipt_v1"),
  status: z.literal("verified"), operationId: z.uuid(), intentSha256: hash, target: intentSchema.shape.target,
  scope: intentSchema.shape.scope, readAt: iso, source: intentSchema.shape.source, candidate: intentSchema.shape.candidate,
  approvedConfigurationSha256: hash, generation: count, verifiedAt: iso, publicReadbackSha256: hash,
  repackCount: count.positive(), publicationOutcome: z.enum(["activated", "unchanged"]),
  observationReceiptDigest: hash, activateReceiptDigest: hash.nullable(), bundleSha256: hash }).strict();
const evidenceSchema = z.object({ status: z.literal("verified"), headDigest: hash, runId: z.uuid(), bundleSha256: hash,
  receiptPath: absolute, receiptSha256: hash, operationId: z.uuid(), publicReleaseId: z.uuid(),
  releaseFingerprint: hash, generation: count, verifiedAt: iso, publicReadbackSha256: hash }).strict();
export type ClutchpacksProductionPostHeadEvidence = z.infer<typeof evidenceSchema>;
export interface ClutchpacksProductionPostHeadDependencies {
  readonly git?: (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;
  readonly spawn?: (file: string, args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"];
  }) => ChildProcess;
  readonly kill?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  readonly startDeadline?: (abort: () => void, milliseconds: number) => () => void;
}
class PostHeadError extends Error {
  constructor(readonly code: string) { super("ClutchPacks production post-head publication was blocked safely."); }
}
function refuse(code: string): never { throw new PostHeadError(code); }
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent: string, child: string) => child === parent || child.startsWith(`${parent}${path.sep}`);
const json = (bytes: Buffer): unknown => JSON.parse(bytes.toString("utf8"));
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readPrivate(file: string, maximum = 64 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > maximum) refuse("POST_HEAD_FILE_INVALID");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) refuse("POST_HEAD_FILE_CHANGED");
    return bytes;
  } finally { await handle.close(); }
}
async function writeExclusive(file: string, value: unknown) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${canonicalJson(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
async function directory(file: string, create = false) {
  if (create) {
    let created = true;
    await mkdir(file, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; created = false; });
    if (created) await syncDirectory(path.dirname(file));
  }
  const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
    await realpath(file) !== file) refuse("POST_HEAD_DIRECTORY_INVALID");
}
function childEnvironment(environment: NodeJS.ProcessEnv) {
  const result: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot"]) if (environment[key] !== undefined) result[key] = environment[key];
  return result;
}
async function verifyCheckout(options: z.output<typeof optionsSchema>, env: NodeJS.ProcessEnv,
  deps: ClutchpacksProductionPostHeadDependencies) {
  const run = deps.git ?? (async (args, input) => (await promisify(execFile)("/usr/bin/git", [...args], {
    ...input, timeout: 10_000, maxBuffer: 1_048_576 })).stdout);
  const cwd = options.publisherWorktree;
  if (await realpath(cwd) !== cwd || inside(cwd, options.artifactDirectory)) refuse("POST_HEAD_CHECKOUT_INVALID");
  for (const [args, expected] of [
    [["rev-parse", "--show-toplevel"], cwd], [["rev-parse", "HEAD"], options.expectedPublisherCommit],
    [["status", "--porcelain=v1", "--untracked-files=no"], ""],
    [["ls-files", "--error-unmatch", "scripts/live/promote-clutchpacks-production.mts"], "scripts/live/promote-clutchpacks-production.mts"],
  ] as const) if ((await run(args, { cwd, env })).trim() !== expected) refuse("POST_HEAD_CHECKOUT_INVALID");
}

/** Always await close after TERM/KILL; output writes are bounded and drained before returning. */
async function command(args: readonly string[], options: z.output<typeof optionsSchema>, attempt: string,
  phase: string, env: NodeJS.ProcessEnv, signal: AbortSignal, deps: ClutchpacksProductionPostHeadDependencies) {
  if (signal.aborted) refuse("POST_HEAD_ABORTED");
  await verifyCheckout(options, env, deps);
  if (signal.aborted) refuse("POST_HEAD_ABORTED");
  await writeExclusive(path.join(attempt, `${phase}.started.json`), { phase, args });
  const stdout = await open(path.join(attempt, `${phase}.stdout`), "wx", 0o600);
  let stderr: FileHandle | undefined;
  try {
    stderr = await open(path.join(attempt, `${phase}.stderr`), "wx", 0o600);
    const launch = deps.spawn ?? ((file, values, spawnOptions) => spawn(file, [...values], spawnOptions));
    const child = launch(process.execPath, ["--import", path.join(options.publisherWorktree, "node_modules/tsx/dist/loader.mjs"),
      path.join(options.publisherWorktree, "scripts/live/promote-clutchpacks-production.mts"), ...args],
    { cwd: options.publisherWorktree, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let failure = false, stopped = false, killer: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (deps.kill) deps.kill(child, kind);
        else if (child.pid !== undefined) process.kill(-child.pid, kind);
      } catch { /* Still await close: lack of proof of termination cannot be success. */ }
    };
    const stop = () => {
      failure = true;
      if (!stopped) { stopped = true; kill("SIGTERM"); killer = setTimeout(() => kill("SIGKILL"), 1_000); }
    };
    const retain = (stream: NodeJS.ReadableStream | null, file: FileHandle) => {
      let size = 0;
      if (!stream) { stop(); return; }
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) { stop(); return; }
        const bytes = Buffer.from(chunk);
        pending = pending.then(async () => { await file.writeFile(bytes); }).catch(() => { stop(); });
      });
      stream.on("error", stop);
    };
    retain(child.stdout, stdout); retain(child.stderr, stderr);
    const closed = new Promise<number | null>(resolve => {
      child.on("error", () => { failure = true; });
      child.once("close", code => resolve(code));
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    let code: number | null;
    try { code = await closed; await pending; await stdout.sync(); await stderr.sync(); }
    finally { signal.removeEventListener("abort", stop); if (killer) clearTimeout(killer); }
    if (failure || signal.aborted || code !== 0) refuse("POST_HEAD_CHILD_FAILED");
  } finally { await stdout.close(); await stderr?.close(); }
  const result = json(await readPrivate(path.join(attempt, `${phase}.stdout`), 65_536));
  await writeExclusive(path.join(attempt, `${phase}.completed.json`), { phase });
  return result;
}

async function boundBundle(file: string, config: z.infer<typeof clutchpacksProductionSourceConfigSchema>, head: ClutchpacksProductionPostHead) {
  const bundle = bundleSchema.parse(json(await readPrivate(file)));
  const { bundleSha256, ...body } = bundle;
  if (digest(body) !== bundleSha256 || digest(bundle.sourceConfig) !== bundle.sourceConfigSha256 ||
    digest(config) !== bundle.sourceConfigSha256 || digest(bundle.plan) !== bundle.intent.candidate.planSha256 ||
    digest(bundle.approvedConfiguration) !== bundle.intent.approvedConfigurationSha256 ||
    digest(bundle.productionInventory) !== bundle.productionInventorySha256 ||
    bundle.intent.source.runId !== config.expected.latestSucceededRunId ||
    bundle.intent.source.checkpointHash !== config.expected.checkpointHash ||
    bundle.intent.source.stateGeneration !== config.expected.stateGeneration ||
    bundle.intent.source.lastHeadReachedAt !== head.headFinishedAt || bundle.intent.readAt < head.headFinishedAt ||
    bundle.intent.scope.providerId !== config.scope.providerId || bundle.intent.scope.configId !== config.scope.configVersionId ||
    bundle.intent.scope.configVersion !== config.scope.configVersionNumber) refuse("POST_HEAD_BUNDLE_INVALID");
  return bundle;
}
async function receiptEvidence(output: z.infer<typeof verifiedOutputSchema>, bundle: z.infer<typeof bundleSchema>,
  bundlePath: string, head: ClutchpacksProductionPostHead): Promise<ClutchpacksProductionPostHeadEvidence> {
  if (path.dirname(output.receiptPath) !== path.dirname(bundlePath) ||
    !new RegExp(`^bundle\\.json\\.receipt\\.[a-f0-9-]{36}\\.json$`, "u").test(path.basename(output.receiptPath))) refuse("POST_HEAD_RECEIPT_INVALID");
  const bytes = await readPrivate(output.receiptPath, 65_536);
  const receipt = receiptSchema.parse(json(bytes)); const intent = bundle.intent;
  const expectedGeneration = intent.predecessor.generation + (intent.predecessor.publicReleaseId === intent.candidate.publicReleaseId &&
    intent.predecessor.releaseFingerprint === intent.candidate.releaseFingerprint ? 0 : 1);
  if (output.bundleSha256 !== bundle.bundleSha256 || receipt.bundleSha256 !== bundle.bundleSha256 ||
    output.operationId !== intent.operationId || receipt.operationId !== intent.operationId ||
    output.publicReleaseId !== intent.candidate.publicReleaseId || receipt.intentSha256 !== digest(intent) ||
    receipt.generation !== expectedGeneration || receipt.verifiedAt < intent.readAt ||
    receipt.repackCount !== bundle.plan.manifest.counts.repacks ||
    output.qualityState !== intent.source.qualityState || output.quarantineCount !== intent.source.quarantineCount ||
    ((receipt.publicationOutcome === "activated") !== (receipt.activateReceiptDigest !== null)) ||
    ["target", "scope", "readAt", "source", "candidate", "approvedConfigurationSha256"].some(key =>
      digest(receipt[key as keyof typeof receipt]) !== digest(intent[key as keyof typeof intent]))) refuse("POST_HEAD_RECEIPT_INVALID");
  return evidenceSchema.parse({ status: "verified", headDigest: digest(head), runId: head.runId, bundleSha256: bundle.bundleSha256,
    receiptPath: output.receiptPath, receiptSha256: bytesHash(bytes), operationId: intent.operationId,
    publicReleaseId: intent.candidate.publicReleaseId, releaseFingerprint: intent.candidate.releaseFingerprint,
    generation: receipt.generation, verifiedAt: receipt.verifiedAt, publicReadbackSha256: receipt.publicReadbackSha256 });
}

/** Await this hook before scheduling another import. A retained pending directory
 * means a failed/uncertain operation and requires operator reconciliation, never a new clock. */
export async function publishClutchpacksProductionPostHead(input: ClutchpacksProductionPostHeadOptions,
  deps: ClutchpacksProductionPostHeadDependencies = {}): Promise<ClutchpacksProductionPostHeadEvidence> {
  let pending: string | undefined;
  let cancelDeadline: (() => void) | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  try {
    const { signal, ...raw } = input;
    const options = optionsSchema.parse(raw);
    cancelDeadline = (deps.startDeadline ?? ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer);
    }))(abort, options.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    await directory(options.artifactDirectory, true);
    const pendingPath = path.join(options.artifactDirectory, "pending");
    // Exclusive acquisition also survives process death. Never steal a stale marker.
    await mkdir(pendingPath, { mode: 0o700 }).catch(() => refuse("POST_HEAD_PENDING_RECONCILIATION"));
    pending = pendingPath;
    await syncDirectory(options.artifactDirectory);
    await writeExclusive(path.join(pending, "head.json"), { head: options.head, publisherCommit: options.expectedPublisherCommit });
    const env = childEnvironment(process.env);
    await verifyCheckout(options, env, deps);
    const baseBytes = await readPrivate(options.baseSourceConfig.path, 1_048_576);
    if (bytesHash(baseBytes) !== options.baseSourceConfig.sha256) refuse("POST_HEAD_BASE_CHANGED");
    const base = clutchpacksProductionSourceConfigSchema.parse(json(baseBytes)); const head = options.head;
    if (head.providerId !== base.scope.providerId || head.configId !== base.scope.configVersionId ||
      head.configNumber !== base.scope.configVersionNumber || head.authorityDigest !== options.expectedResidentAuthorityDigest) refuse("POST_HEAD_SCOPE_CHANGED");
    const config = clutchpacksProductionSourceConfigSchema.parse({ ...base, expected: { ...base.expected,
      latestSucceededRunId: head.runId, checkpointHash: head.checkpointHash,
      stateGeneration: head.generation, runtimeRowVersion: head.runtimeRowVersion } });
    const runDirectory = path.join(options.artifactDirectory, head.runId);
    let first = true;
    await mkdir(runDirectory, { mode: 0o700 }).catch(error => { if (error.code === "EEXIST") first = false; else throw error; });
    if (first) await syncDirectory(options.artifactDirectory);
    await directory(runDirectory);
    const journal = { schemaVersion: "clutchpacks_production_post_head_v1", head,
      baseSourceConfig: options.baseSourceConfig, publisherWorktree: options.publisherWorktree,
      publisherCommit: options.expectedPublisherCommit, residentAuthorityDigest: options.expectedResidentAuthorityDigest,
      sourceConfigSha256: digest(config) };
    const configPath = path.join(runDirectory, "source-config.json"), bundlePath = path.join(runDirectory, "bundle.json");
    if (first) {
      await writeExclusive(path.join(runDirectory, "head.json"), journal); await writeExclusive(configPath, config);
    } else {
      if (digest(json(await readPrivate(path.join(runDirectory, "head.json"), 65_536))) !== digest(journal) ||
        digest(json(await readPrivate(configPath, 1_048_576))) !== digest(config)) refuse("POST_HEAD_REENTRY_CHANGED");
      const previous = evidenceSchema.parse(json(await readPrivate(path.join(runDirectory, "verified.json"), 65_536)));
      const priorBundle = await boundBundle(bundlePath, config, head);
      const prior = await receiptEvidence({ status: "verified", receiptPath: previous.receiptPath,
        bundleSha256: previous.bundleSha256, operationId: previous.operationId, publicReleaseId: previous.publicReleaseId,
        qualityState: priorBundle.intent.source.qualityState, quarantineCount: priorBundle.intent.source.quarantineCount }, priorBundle, bundlePath, head);
      if (digest(prior) !== digest(previous)) refuse("POST_HEAD_REENTRY_CHANGED");
    }
    const attempt = path.join(runDirectory, `attempt-${randomUUID()}`); await mkdir(attempt, { mode: 0o700 });
    await syncDirectory(runDirectory);
    if (first) {
      const output = preparedSchema.parse(await command(["--prepare", configPath, bundlePath], options, attempt, "prepare", env, controller.signal, deps));
      const bundle = await boundBundle(bundlePath, config, head);
      if (output.bundlePath !== bundlePath || output.bundleSha256 !== bundle.bundleSha256 ||
        output.operationId !== bundle.intent.operationId || output.publicReleaseId !== bundle.intent.candidate.publicReleaseId ||
        output.readAt !== bundle.intent.readAt || output.qualityState !== bundle.intent.source.qualityState ||
        output.quarantineCount !== bundle.intent.source.quarantineCount) refuse("POST_HEAD_PREPARE_INVALID");
      await writeExclusive(path.join(runDirectory, "prepared.json"), output);
    }
    const bundle = await boundBundle(bundlePath, config, head);
    const output = verifiedOutputSchema.parse(await command(["--publish", bundlePath], options, attempt, "publish", env, controller.signal, deps));
    if (controller.signal.aborted) refuse("POST_HEAD_ABORTED");
    const evidence = await receiptEvidence(output, bundle, bundlePath, head);
    if (controller.signal.aborted) refuse("POST_HEAD_ABORTED");
    await writeExclusive(path.join(attempt, "verified.json"), evidence);
    if (first) await writeExclusive(path.join(runDirectory, "verified.json"), evidence);
    await unlink(path.join(pending, "head.json")); await rmdir(pending); pending = undefined;
    await syncDirectory(options.artifactDirectory);
    return evidence;
  } catch (error) {
    const code = error instanceof PostHeadError ? error.code : "POST_HEAD_FAILED";
    if (pending) await writeExclusive(path.join(pending, `blocked-${randomUUID()}.json`), { status: "blocked", code }).catch(() => undefined);
    return refuse(code);
  } finally { cancelDeadline?.(); input.signal?.removeEventListener("abort", abort); }
}
