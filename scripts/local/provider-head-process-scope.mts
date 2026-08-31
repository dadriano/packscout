import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import dotenv from "dotenv";
import { canonicalJson } from "@packscout/contracts";
import { backfillPinsSchema, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";

const exec = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const decimal = z.string().regex(/^[1-9][0-9]*$/u);
const absolute = z.string().max(1024).refine(path.isAbsolute);
const filePin = z.object({ path: absolute, sha256: hash }).strict();
const started = z.string().regex(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u);
const processPin = z.object({ pid: z.number().int().positive(), parentPid: z.number().int().positive(),
  startedAt: started, cwd: absolute, argv: z.array(z.string().min(1).max(1024)).min(4).max(40) }).strict();
const peerSchema = z.object({ pins: backfillPinsSchema, checkout: absolute, sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  environment: filePin, plist: filePin, gateEvidence: filePin, authorityEvidence: filePin,
  routeDigest: hash, authorityDigest: hash, configNumber: decimal,
  expectedWorkerOwner: z.string().max(256).nullable(), expectedWorkerFence: decimal,
  root: processPin, child: processPin.nullable() }).strict();
export const providerHeadPeerScopeSchema = z.object({ schemaVersion: z.literal(1), issuedAt: z.string().datetime(),
  notAfter: z.string().datetime(), protectedPins: backfillPinsSchema, peers: z.array(peerSchema).min(1).max(3) }).strict();
export type ProviderHeadPeerScope = z.infer<typeof providerHeadPeerScopeSchema>;
type Peer = ProviderHeadPeerScope["peers"][number];
const authoritySchema = z.object({ schemaVersion: z.literal(1), observedAt: z.string().datetime(), pins: backfillPinsSchema,
  configNumber: decimal, routeDigest: hash, authorityDigest: hash,
  database: z.object({ organizationId: z.string().uuid(), providerId: z.string().uuid(), providerKey: z.string(),
    databaseName: z.string(), role: z.literal("provider"), schemaVersion: z.literal("distributed-provider-v1") }).strict(),
  operation: z.object({ operationId: z.string().uuid(), authorityDigest: hash, pinsSha256: hash }).strict(),
  lease: z.object({ role: z.literal("import"), owner: z.string().max(256).nullable(), fence: decimal,
    expiresAt: z.string().datetime().nullable() }).strict(),
  executionClaim: z.object({ operationId: z.string().uuid(), owner: z.string().max(256), fence: decimal,
    authorityDigest: hash, outcome: z.literal("success") }).strict().nullable(),
}).strict();
const gateSchema = z.object({ schemaVersion: z.literal(1), sourceCommit: z.string(),
  command: z.literal("npm run verify:framework"), exitCode: z.literal(0), completedAt: z.string().datetime(), logSha256: hash }).strict();
export class ProviderHeadPeerScopeError extends Error {
  constructor(readonly code: string) { super("Provider process ownership could not be proved."); }
}
function refuse(code: string): never { throw new ProviderHeadPeerScopeError(code); }
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
function json(value: string): unknown {
  try { return JSON.parse(value); } catch { return refuse("PEER_SCOPE_DOCUMENT_INVALID"); }
}

export function providerHeadPeerScopeOption(environment: NodeJS.ProcessEnv) {
  const file = environment.PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_FILE;
  const digest = environment.PACKSCOUT_PROVIDER_HEAD_PEER_SCOPE_SHA256;
  if (file === undefined && digest === undefined) return null;
  if (!file || !path.isAbsolute(file) || !digest || !hash.safeParse(digest).success) refuse("PEER_SCOPE_OPTION_INVALID");
  return { file, digest };
}
export function providerHeadWriterCommand(command: string) {
  const nodeCommand = /(?:^|\s)(?:\S*\/)?(?:node|tsx)(?:\s|$)/u.test(command);
  if (nodeCommand && /(?:provider-manual-import-local|clutchpacks-manual-import-local|source-supervisor-local|start-provider-source-task010-supervisor|(?:apps\/worker\/)?src\/(?:index|main))\.(?:ts|mts)(?:\s|$)/u.test(command)) return true;
  const entry = /(provider-manual-import-local|clutchpacks-manual-import-local|source-supervisor-local|start-provider-source-task010-supervisor|(?:apps\/worker\/)?src\/(?:index|main)|run-provider-continuous-poller|run-provider-backfill-supervisor|provider-(?:paused|failed)-head-resume|provider-operator-continuation|provider-resident[^\s]*|provider[^\s]*promotion[^\s]*|promote-distributed-[a-z0-9-]+-to-local-convex)\.(?:ts|mts)(?:\s|$)/u.exec(command)?.[1];
  // Worker entrypoints ignore CLI flags; only reviewed operator CLIs implement a dry run.
  const checkedCli = /^(?:run-provider-(?:continuous-poller|backfill-supervisor)|provider-(?:paused-head-resume|failed-head-resume|operator-continuation)|promote-distributed-[a-z0-9-]+-to-local-convex)$/u.test(entry ?? "");
  return nodeCommand && entry !== undefined && !(checkedCli && /(?:^|\s)--check-only(?:\s|$)/u.test(command));
}
export interface ProviderHeadProcess { pid: number; parentPid: number; startedAt: string; command: string }
export function parseProviderHeadProcesses(text: string): ProviderHeadProcess[] {
  const rows = text.split("\n").filter(line => line.trim() !== "").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(line);
    if (!match) return refuse("PEER_SCOPE_PROCESS_INVENTORY_INVALID");
    return { pid: Number(match[1]), parentPid: Number(match[2]), startedAt: match[3]!.replace(/\s+/gu, " "), command: match[4]! };
  });
  if (rows.length === 0 || rows.length > 10000 || new Set(rows.map(row => row.pid)).size !== rows.length) refuse("PEER_SCOPE_PROCESS_INVENTORY_INVALID");
  return rows;
}
function expectedRootArguments(peer: Peer): string[] {
  const p = peer.pins;
  return [peer.root.argv[0]!, "--import", "tsx", path.join(peer.checkout, "scripts/local/run-provider-continuous-poller.mts"),
    "--run", "--launchd", "--bootstrap-backfill", "--organization-id", p.organizationId, "--provider-id", p.providerId,
    "--provider-key", p.providerKey, "--config-id", p.configId, "--initial-run-id", p.initialRunId,
    "--operation-id", p.operationId, "--operator-id", p.operatorId];
}
function assertProcess(row: ProviderHeadProcess | undefined, expected: z.infer<typeof processPin>) {
  if (!row || row.pid !== expected.pid || row.parentPid !== expected.parentPid || row.startedAt !== expected.startedAt ||
      expected.argv.some(arg => /\s/u.test(arg)) || row.command !== expected.argv.join(" ")) refuse("PEER_SCOPE_PROCESS_CHANGED");
}
export function assertProviderHeadProcessScope(input: { scope: ProviderHeadPeerScope; protectedPins: BackfillPins;
  processes: readonly ProviderHeadProcess[]; now: Date; ownPid?: number }) {
  const { scope, protectedPins, processes } = input;
  const now = input.now.getTime(), issued = Date.parse(scope.issuedAt), until = Date.parse(scope.notAfter);
  if (!Number.isFinite(now) || issued > now || until <= now || until <= issued || until - issued > 120000) refuse("PEER_SCOPE_EXPIRED");
  if (!same(scope.protectedPins, protectedPins)) refuse("PEER_SCOPE_PROTECTED_OPERATION_CHANGED");
  const processById = new Map(processes.map(row => [row.pid, row]));
  if (processById.size !== processes.length) refuse("PEER_SCOPE_PROCESS_INVENTORY_INVALID");
  const accepted = new Set<number>(), peerIds = new Set<string>(), peerKeys = new Set<string>();
  for (const peer of scope.peers) {
    if (peer.pins.providerId === protectedPins.providerId || peer.pins.providerKey === protectedPins.providerKey ||
        peer.pins.organizationId !== protectedPins.organizationId || peer.pins.operatorId !== protectedPins.operatorId ||
        peer.pins.operationId === protectedPins.operationId || peerIds.has(peer.pins.providerId) || peerKeys.has(peer.pins.providerKey)) refuse("PEER_SCOPE_PROVIDER_INVALID");
    peerIds.add(peer.pins.providerId); peerKeys.add(peer.pins.providerKey);
    const rootStarted = Date.parse(peer.root.startedAt);
    if (!Number.isFinite(rootStarted) || rootStarted > now || !path.isAbsolute(peer.root.argv[0]!) || path.basename(peer.root.argv[0]!) !== "node" ||
        peer.root.cwd !== peer.checkout || peer.environment.path !== path.join(peer.checkout, ".env") ||
        !same(peer.root.argv, expectedRootArguments(peer)) || peer.root.pid === input.ownPid || accepted.has(peer.root.pid)) refuse("PEER_SCOPE_ROOT_INVALID");
    assertProcess(processById.get(peer.root.pid), peer.root); accepted.add(peer.root.pid);
    if (peer.child !== null) {
      const childStarted = Date.parse(peer.child.startedAt);
      if (peer.child.parentPid !== peer.root.pid || peer.child.cwd !== peer.checkout || peer.child.pid === input.ownPid ||
          accepted.has(peer.child.pid) || !Number.isFinite(childStarted) || childStarted > now || childStarted < rootStarted ||
          !same(peer.child.argv, [peer.root.argv[0], "--import", "tsx", path.join(peer.checkout, "apps/worker/src/provider-manual-import-local.ts")])) refuse("PEER_SCOPE_CHILD_INVALID");
      assertProcess(processById.get(peer.child.pid), peer.child); accepted.add(peer.child.pid);
    }
  }
  for (const row of processes) if (row.pid !== input.ownPid && providerHeadWriterCommand(row.command) && !accepted.has(row.pid)) {
    refuse("PEER_SCOPE_UNKNOWN_WRITER");
  }
  return { acceptedPeerCount: scope.peers.length, acceptedProcessCount: accepted.size };
}
export function assertProviderHeadPeerEvidence(peer: Peer, value: unknown, gateValue: unknown, now: Date, scope: ProviderHeadPeerScope) {
  const parsed = authoritySchema.safeParse(value), gate = gateSchema.safeParse(gateValue);
  if (!parsed.success || !gate.success) refuse("PEER_SCOPE_EVIDENCE_INVALID");
  const a = parsed.data, p = peer.pins, observed = Date.parse(a.observedAt);
  if (observed > Date.parse(scope.issuedAt) || now.getTime() - observed > 120000 || observed > now.getTime() ||
      gate.data.sourceCommit !== peer.sourceCommit || Date.parse(gate.data.completedAt) > Date.parse(scope.issuedAt) ||
      !same(a.pins, p) || a.configNumber !== peer.configNumber || a.routeDigest !== peer.routeDigest || a.authorityDigest !== peer.authorityDigest ||
      a.database.organizationId !== p.organizationId || a.database.providerId !== p.providerId || a.database.providerKey !== p.providerKey ||
      a.database.databaseName !== `packscout_${p.providerKey}` || a.operation.operationId !== p.operationId ||
      a.operation.authorityDigest !== peer.authorityDigest || a.operation.pinsSha256 !== sha(canonicalJson(p)) ||
      a.lease.owner !== peer.expectedWorkerOwner || a.lease.fence !== peer.expectedWorkerFence) refuse("PEER_SCOPE_AUTHORITY_CHANGED");
  if (peer.child === null) {
    if (a.lease.owner !== null || a.lease.expiresAt !== null || peer.expectedWorkerOwner !== null) refuse("PEER_SCOPE_UNPROVEN_LEASE");
  } else {
    const claim = a.executionClaim;
    if (a.lease.owner === null || !a.lease.owner.startsWith(`local:backfill:${p.operationId}:`) ||
        !z.string().uuid().safeParse(a.lease.owner.slice(`local:backfill:${p.operationId}:`.length)).success ||
        a.lease.expiresAt === null || Date.parse(a.lease.expiresAt) <= now.getTime() || !claim ||
        claim.operationId !== p.operationId || claim.owner !== a.lease.owner || claim.fence !== a.lease.fence ||
        claim.authorityDigest !== peer.authorityDigest) refuse("PEER_SCOPE_UNPROVEN_LEASE");
  }
}
export interface ProviderHeadProcessScopeDependencies {
  now(): Date;
  read(file: string, privateFile: boolean): Promise<Uint8Array>;
  command(file: string, args: string[]): Promise<string>;
}
export async function readProviderHeadPeerFile(file: string, privateFile: boolean): Promise<Uint8Array> {
    if (!path.isAbsolute(file)) refuse("PEER_SCOPE_PRIVATE_FILE_INVALID");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0 || stat.size > 262144) refuse("PEER_SCOPE_PRIVATE_FILE_INVALID");
      const bytes = Buffer.alloc(262145); const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 262144) refuse("PEER_SCOPE_PRIVATE_FILE_INVALID");
      return bytes.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
}
const dependencies: ProviderHeadProcessScopeDependencies = {
  now: () => new Date(), read: readProviderHeadPeerFile,
  async command(file, args) { return (await exec(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout; },
};
async function verifyScope(input: { file: string; digest: string; protectedPins: BackfillPins;
  ownPid?: number }, dep: ProviderHeadProcessScopeDependencies = dependencies) {
  if (!filePin.safeParse({ path: input.file, sha256: input.digest }).success) refuse("PEER_SCOPE_OPTION_INVALID");
  const readPin = async (pin: z.infer<typeof filePin>, privateFile = true) => {
    const bytes = await dep.read(pin.path, privateFile);
    try { if (sha(bytes) !== pin.sha256) refuse("PEER_SCOPE_FILE_CHANGED"); return Buffer.from(bytes).toString("utf8"); }
    finally { bytes.fill(0); }
  };
  const raw = await readPin({ path: input.file, sha256: input.digest });
  const parsed = providerHeadPeerScopeSchema.safeParse(json(raw));
  if (!parsed.success) refuse("PEER_SCOPE_DOCUMENT_INVALID");
  const scope = parsed.data;
  const processes = () => dep.command("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="]).then(parseProviderHeadProcesses);
  const before = await processes();
  const result = assertProviderHeadProcessScope({ scope, protectedPins: input.protectedPins, processes: before, now: dep.now(), ownPid: input.ownPid ?? process.pid });
  const evidence: { peer: Peer; authority: unknown; gate: unknown }[] = [];
  for (const peer of scope.peers) {
    const [head, status] = await Promise.all([
      dep.command("/usr/bin/git", ["-C", peer.checkout, "rev-parse", "HEAD"]),
      dep.command("/usr/bin/git", ["-C", peer.checkout, "status", "--porcelain", "--untracked-files=normal"]),
    ]);
    if (head.trim() !== peer.sourceCommit || status.trim() !== "") refuse("PEER_SCOPE_SOURCE_CHANGED");
    const environment = dotenv.parse(await readPin(peer.environment));
    if (Object.hasOwn(environment, "PACKSCOUT_PROVIDER_LANES_JSON") ||
        (environment.PACKSCOUT_PROVIDER_ID !== undefined && environment.PACKSCOUT_PROVIDER_ID !== peer.pins.providerId) ||
        (environment.PACKSCOUT_PROVIDER_KEY !== undefined && environment.PACKSCOUT_PROVIDER_KEY !== peer.pins.providerKey)) refuse("PEER_SCOPE_ENVIRONMENT_INVALID");
    await readPin(peer.plist, false);
    const plistValue = json(await dep.command("/usr/bin/plutil", ["-convert", "json", "-o", "-", peer.plist.path]));
    if (!plistValue || typeof plistValue !== "object" || Array.isArray(plistValue)) refuse("PEER_SCOPE_PLIST_CHANGED");
    const plist = plistValue as Record<string, unknown>;
    const plistEnvironment = z.object({ NODE_ENV: z.literal("development"), PATH: z.string().min(1) }).strict().safeParse(plist.EnvironmentVariables);
    if (!same(plist.ProgramArguments, peer.root.argv) || plist.WorkingDirectory !== peer.checkout || !plistEnvironment.success) refuse("PEER_SCOPE_PLIST_CHANGED");
    await readPin(peer.plist, false);
    const authority = json(await readPin(peer.authorityEvidence));
    const gate = json(await readPin(peer.gateEvidence));
    assertProviderHeadPeerEvidence(peer, authority, gate, dep.now(), scope);
    evidence.push({ peer, authority, gate });
    for (const expected of [peer.root, peer.child]) if (expected) {
      const cwd = await dep.command("/usr/sbin/lsof", ["-a", "-p", String(expected.pid), "-d", "cwd", "-Fn"]);
      if (!cwd.split("\n").includes(`n${expected.cwd}`)) refuse("PEER_SCOPE_CWD_CHANGED");
    }
    await readPin(peer.environment); await readPin(peer.plist, false);
    if ((await dep.command("/usr/bin/git", ["-C", peer.checkout, "rev-parse", "HEAD"])).trim() !== peer.sourceCommit ||
        (await dep.command("/usr/bin/git", ["-C", peer.checkout, "status", "--porcelain", "--untracked-files=normal"])).trim() !== "") refuse("PEER_SCOPE_SOURCE_CHANGED");
  }
  // Catch recycled PIDs, exits, newly spawned children and expiration during evidence reads.
  const after = await processes();
  assertProviderHeadProcessScope({ scope, protectedPins: input.protectedPins, processes: after, now: dep.now(), ownPid: input.ownPid ?? process.pid });
  if (await readPin({ path: input.file, sha256: input.digest }) !== raw) refuse("PEER_SCOPE_FILE_CHANGED");
  const finalNow = dep.now();
  assertProviderHeadProcessScope({ scope, protectedPins: input.protectedPins, processes: after, now: finalNow, ownPid: input.ownPid ?? process.pid });
  for (const value of evidence) assertProviderHeadPeerEvidence(value.peer, value.authority, value.gate, finalNow, scope);
  return { ...result, scopeSha256: input.digest, notAfter: scope.notAfter };
}
/** Only an explicitly hash-reviewed, private, short-lived proof can permit isolated peers. */
export async function verifyProviderHeadPeerProcessScope(input: { file: string; digest: string; protectedPins: BackfillPins;
  ownPid?: number }, dep: ProviderHeadProcessScopeDependencies = dependencies) {
  try { return await verifyScope(input, dep); } catch (error) {
    if (error instanceof ProviderHeadPeerScopeError) throw error;
    return refuse("PEER_SCOPE_VERIFICATION_UNAVAILABLE");
  }
}
