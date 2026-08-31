#!/usr/bin/env node
import path from "node:path";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, createCentralDatabaseLifecycle, readDatabaseReadiness,
  type CentralTransactionClient, type ProviderTransactionClient, type ProviderPrismaClient, type ProviderQueryClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillAuthority, readBackfillEnvironment, type BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { claimContinuousResidency } from "./provider-continuous-residency.mts";
import { operatorContinuationDirectInvocation, withContinuationDeadline } from "./provider-operator-continuation.mts";
import { runRemoteHealthTransaction } from "./remote-provider-health-transaction.mts";
import { createPausedHeadAdoption } from "./provider-paused-head-control.mts";
import { providerHeadPeerScopeOption, verifyProviderHeadPeerProcessScope } from "./provider-head-process-scope.mts";
import { pausedHeadDigest, pausedHeadReviewSchema, PausedHeadError, refusePausedHead as refuse,
  type PausedHeadReview } from "./provider-paused-head-policy.mts";

const exec = promisify(execFile);
export function parsePausedHeadArguments(args: readonly string[]) {
  if (args[0] !== "--review-file" || !args[1] || !path.isAbsolute(args[1])) refuse("PAUSED_HEAD_ARGUMENTS_INVALID");
  if (args.length === 3 && args[2] === "--check-only") return { file: args[1], digest: null };
  if (args.length === 5 && args[2] === "--apply" && args[3] === "--review-digest" && /^[a-f0-9]{64}$/u.test(args[4]!)) {
    return { file: args[1], digest: args[4]! };
  }
  return refuse("PAUSED_HEAD_ARGUMENTS_INVALID");
}
export async function readPrivateProviderOperatorFile(file: string, maximum: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > maximum) refuse("PAUSED_HEAD_PRIVATE_FILE_INVALID");
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) { bytes.fill(0); refuse("PAUSED_HEAD_PRIVATE_FILE_INVALID"); }
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
export async function readPausedHeadReview(file: string) {
  const bytes = await readPrivateProviderOperatorFile(file, 16_384);
  try { return pausedHeadReviewSchema.parse(JSON.parse(bytes.toString("utf8"))); }
  finally { bytes.fill(0); }
}
export async function assertPausedHeadArtifacts(review: Pick<PausedHeadReview, "sourceCommit" | "migrationProofPath" | "migrationProofDigest">) {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const [head, status] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 }),
    exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, timeout: 5000 }),
  ]);
  if (head.stdout.trim() !== review.sourceCommit || status.stdout.trim() !== "") refuse("PAUSED_HEAD_SOURCE_REVISION_CHANGED");
  const proof = await readPrivateProviderOperatorFile(review.migrationProofPath, 1_048_576);
  try { if (createHash("sha256").update(proof).digest("hex") !== review.migrationProofDigest) refuse("PAUSED_HEAD_MIGRATION_PROOF_CHANGED"); }
  finally { proof.fill(0); }
}
export function assertPausedHeadEnvironment(review: Pick<PausedHeadReview, "central" | "provider">, environment: Awaited<ReturnType<typeof readBackfillEnvironment>>) {
  const url = new URL(environment.centralDatabaseUrl), c = review.central;
  const strictTls = url.searchParams.getAll("sslmode").length === 1 && url.searchParams.getAll("sslaccept").length <= 1 &&
    (url.searchParams.get("sslmode") === "verify-full" ||
      url.searchParams.get("sslmode") === "require" && url.searchParams.get("sslaccept") === "strict");
  if (environment.runtimePolicy.mode !== "remote" || url.hostname !== c.host || Number(url.port || 5432) !== c.port ||
    decodeURIComponent(url.pathname.slice(1)) !== c.databaseName || c.sslMode !== "verify-full" || !strictTls) {
    refuse("PAUSED_HEAD_REMOTE_ENVIRONMENT_DRIFT");
  }
  environment.runtimePolicy.assertCentralDatabaseUrl(url.toString());
  environment.runtimePolicy.destinationPolicy.assertAllowed(review.provider);
}
export function assertNoPausedHeadWriter(text: string, ownPid = process.pid) {
  for (const line of text.split("\n").filter(Boolean)) {
    const row = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    if (!row) refuse("PAUSED_HEAD_PROCESS_INVENTORY_INVALID");
    if (Number(row[1]) === ownPid) continue;
    const command = row[3]!;
    if (/(?:^|\s)(?:\S*\/)?(?:node|tsx)(?:\s|$)/u.test(command) &&
      /(?:provider-manual-import-local|clutchpacks-manual-import-local|source-supervisor-local|start-provider-source-task010-supervisor|(?:apps\/worker\/)?src\/index|run-provider-continuous-poller|run-provider-backfill-supervisor|provider-(?:paused|failed)-head-resume|provider-operator-continuation|provider[^\s]*promotion[^\s]*|promote-distributed-[a-z0-9-]+-to-local-convex)\.(?:ts|mts)(?:\s|$)/u.test(command) &&
      !command.includes("--check-only")) refuse("PAUSED_HEAD_WRITER_PRESENT");
  }
}
type RemoteHeadReview = Pick<PausedHeadReview, "pins" | "central" | "provider" | "sourceCommit" | "migrationProofPath" | "migrationProofDigest" | "checkpointHash">;
interface ReviewedHeadControl<Receipt> {
  inspect(db: ProviderQueryClient, authority: BackfillAuthority): Promise<{ receipt: Receipt; completed: boolean }>;
  apply(db: ProviderPrismaClient, receipt: Receipt, readAuthority: () => Promise<BackfillAuthority>,
    assertProcess: () => Promise<void>, active: () => void, notAfter: Date): Promise<unknown>;
}
/** Shared remote operator transport: policy, file/process safety, bounded reads and callback draining. */
export async function runReviewedProviderHeadControl<Review extends RemoteHeadReview, Receipt>(
  args: ReturnType<typeof parsePausedHeadArguments>, readReview: (file: string) => Promise<Review>,
  createControl: (review: Review) => ReviewedHeadControl<Receipt>, completedPhase = "already_adopted") {
  const review = await readReview(args.file); await assertPausedHeadArtifacts(review);
  const checkProcess = async () => {
    try {
      const scope = providerHeadPeerScopeOption(process.env);
      if (scope) { await verifyProviderHeadPeerProcessScope({ ...scope, protectedPins: review.pins }); return; }
    } catch { return refuse("PAUSED_HEAD_PEER_PROCESS_SCOPE_INVALID"); }
    const rows = await exec("/bin/ps", ["-axo", "pid=,ppid=,command="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    assertNoPausedHeadWriter(rows.stdout);
  };
  await checkProcess(); const environment = await readBackfillEnvironment();
  let residency: Awaited<ReturnType<typeof claimContinuousResidency>> | undefined;
  try {
    assertPausedHeadEnvironment(review, environment);
    const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
      keys: new Map([[environment.version, environment.key]]) });
    const boundedCentralUrl = new URL(environment.centralDatabaseUrl);
    boundedCentralUrl.searchParams.set("connect_timeout", "5"); boundedCentralUrl.searchParams.set("pool_timeout", "5");
    const central = createCentralDatabaseLifecycle({ databaseUrl: boundedCentralUrl.toString(), connectionLimit: 1 });
    const gateway = new BoundedProviderDatabaseGateway({ central,
      credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher), destinationPolicy: environment.runtimePolicy.destinationPolicy,
      connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationTimeoutMs: 60_000 });
    let pending: Promise<unknown> | undefined, gatewayActive = true;
    try {
      const readAuthority = () => runRemoteHealthTransaction(callback => central.client.$transaction(callback,
        { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 15_000 }), async (tx: CentralTransactionClient) => {
        await tx.$executeRaw`set transaction read only`;
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
        const readiness = await readDatabaseReadiness({ client: tx, target: central.target });
        if (readiness.state !== "ready") refuse("PAUSED_HEAD_CENTRAL_UNAVAILABLE");
        return readBackfillAuthority(tx, cipher, review.pins, environment.runtimePolicy);
      });
      const authority = await readAuthority(), control = createControl(review);
      if (args.digest !== null) residency = await claimContinuousResidency(review.pins, () => ({ state: "reviewed_head_control" }));
      const gatewayNotAfter = Date.now() + 55_000;
      const routed = await gateway.runWithCachedProviderDatabase(authority.route, db => {
        const notAfter = new Date(Math.min(gatewayNotAfter, Date.now() + 55_000));
        const task = withContinuationDeadline(async deadline => {
          const active = () => { deadline(); if (!gatewayActive || Date.now() >= notAfter.getTime()) refuse("PAUSED_HEAD_GATEWAY_EXPIRED"); };
          const checked = await runRemoteHealthTransaction(callback => db.$transaction(callback,
            { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 25_000 }), async (tx: ProviderTransactionClient) => {
            await tx.$executeRaw`set transaction read only`;
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
            return control.inspect(tx, authority);
          });
          const reviewDigest = pausedHeadDigest(checked.receipt);
          if (args.digest === null) return { phase: checked.completed ? completedPhase : "check_only", reviewDigest,
            providerId: review.pins.providerId, parentRunId: review.pins.initialRunId, checkpointHash: review.checkpointHash,
            sourceRequestsPerformed: false, mutationsPerformed: false };
          if (args.digest !== reviewDigest) refuse("PAUSED_HEAD_REVIEW_STALE");
          await assertPausedHeadArtifacts(review); active();
          return control.apply(db, checked.receipt, readAuthority, checkProcess, active, notAfter);
        }).then(value => ({ ok: true as const, value }), (error: unknown) => {
          if (error instanceof PausedHeadError) return { ok: false as const, code: error.code };
          throw error;
        });
        pending = task; return task;
      });
      gatewayActive = false; if (pending) await pending.catch(() => undefined);
      if (routed.state !== "reachable") refuse("PAUSED_HEAD_PROVIDER_UNAVAILABLE");
      if (!routed.value.ok) refuse(routed.value.code);
      return routed.value.value;
    } finally { gatewayActive = false; if (pending) await pending.catch(() => undefined); await gateway.close(); await central.close(); }
  } finally { environment.key.fill(0); await residency?.close(); }
}
export function runPausedHeadAdoption(args: ReturnType<typeof parsePausedHeadArguments>) {
  return runReviewedProviderHeadControl(args, readPausedHeadReview, createPausedHeadAdoption);
}
if (await operatorContinuationDirectInvocation(process.argv[1], import.meta.url)) {
  Promise.resolve().then(() => runPausedHeadAdoption(parsePausedHeadArguments(process.argv.slice(2))))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`), (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof PausedHeadError
        ? error.code : "PAUSED_HEAD_OPERATION_FAILED" })}\n`); process.exitCode = 1;
    });
}
