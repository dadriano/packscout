#!/usr/bin/env node
import path from "node:path";
import { open, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, createCentralDatabaseLifecycle } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { localBackfillProviderPorts, readBackfillAuthority, readLocalBackfillEnvironment } from "./provider-backfill-supervisor-authority.mts";
import { claimContinuousResidency } from "./provider-continuous-residency.mts";
import { createOperatorContinuation } from "./provider-operator-continuation-control.mts";
import { assertNoContinuationWriter, continuationDigest, continuationIds, continuationReviewSchema,
  OperatorContinuationError, refuseContinuation as refuse, type ContinuationReview } from "./provider-operator-continuation-policy.mts";

const exec = promisify(execFile);
/** Gateway transport failures must not erase a trusted operator-policy refusal. */
export async function captureOperatorContinuationResult<T>(operation: () => Promise<T>) {
  try { return { ok: true as const, value: await operation() }; }
  catch (error) {
    if (error instanceof OperatorContinuationError) return { ok: false as const, code: error.code };
    throw error;
  }
}
export function parseOperatorContinuationArguments(args: readonly string[]) {
  if (args[0] !== "--review-file" || !args[1] || !path.isAbsolute(args[1])) refuse("CONTINUATION_ARGUMENTS_INVALID");
  if (args.length === 3 && args[2] === "--check-only") return { file: args[1], digest: null };
  if (args.length === 5 && args[2] === "--apply" && args[3] === "--review-digest" && /^[a-f0-9]{64}$/u.test(args[4]!)) {
    return { file: args[1], digest: args[4]! };
  }
  return refuse("CONTINUATION_ARGUMENTS_INVALID");
}
export async function readOperatorContinuationReview(file: string) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384) refuse("CONTINUATION_REVIEW_TOO_LARGE");
    const buffer = Buffer.alloc(16_385);
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_384) refuse("CONTINUATION_REVIEW_TOO_LARGE");
      return continuationReviewSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
    } finally { buffer.fill(0); }
  } finally { await handle.close(); }
}
export async function assertContinuationSourceCommit(review: ContinuationReview) {
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const [head, status] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 }),
    exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd, timeout: 5000 }),
  ]);
  if (head.stdout.trim() !== review.sourceCommit || status.stdout.trim() !== "") refuse("CONTINUATION_SOURCE_REVISION_CHANGED");
}
/** A gateway timeout is not callback cancellation. Drain before releasing residency/keyring. */
export async function withContinuationDeadline<T>(operation: (active: () => void) => Promise<T>, milliseconds = 55_000) {
  let expired = false; const deadline = Date.now() + milliseconds;
  const timer = setTimeout(() => { expired = true; }, milliseconds);
  try { return await operation(() => { if (expired || Date.now() >= deadline) refuse("CONTINUATION_OPERATION_DEADLINE"); }); }
  finally { clearTimeout(timer); expired = true; }
}
export async function runOperatorContinuation(args: ReturnType<typeof parseOperatorContinuationArguments>) {
  const review = await readOperatorContinuationReview(args.file);
  await assertContinuationSourceCommit(review);
  const checkProcess = async () => {
    const result = await exec("/bin/ps", ["-axo", "pid=,ppid=,command="], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    assertNoContinuationWriter(result.stdout, review);
  };
  await checkProcess();
  const environment = await readLocalBackfillEnvironment();
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"],
      allowedPorts: [localBackfillProviderPorts[review.pins.providerKey]], allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationTimeoutMs: 60_000 });
  let residency: Awaited<ReturnType<typeof claimContinuousResidency>> | undefined;
  let pending: Promise<unknown> | undefined;
  let gatewayActive = true;
  try {
    await central.start();
    const readAuthority = () => readBackfillAuthority(central.client, cipher, review.pins);
    const authority = await readAuthority(), control = createOperatorContinuation(review);
    if (args.digest !== null) residency = await claimContinuousResidency(review.pins, () => ({ state: "operator_continuation" }));
    const routed = await gateway.runWithCachedProviderDatabase(authority.route, database => {
      const run = captureOperatorContinuationResult(() => withContinuationDeadline(async assertDeadline => {
        const active = () => { assertDeadline(); if (!gatewayActive) refuse("CONTINUATION_GATEWAY_EXPIRED"); };
        const state = await database.$transaction(async tx => { await tx.$executeRaw`set transaction read only`;
          return control.inspect(tx, authority); }, { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 25_000 });
        const reviewDigest = continuationDigest(state.receipt);
        if (args.digest === null) return { phase: state.queued ? "already_queued" : "check_only", reviewDigest,
          providerId: review.pins.providerId, parentRunId: review.pins.initialRunId, runId: continuationIds(review).run,
          pages: state.snapshot.parent.page_count, accepted: state.snapshot.parent.accepted_count,
          quarantined: state.snapshot.parent.quarantined_count, sourceRequestsPerformed: false, mutationsPerformed: false };
        if (args.digest !== reviewDigest) refuse("CONTINUATION_REVIEW_STALE");
        await assertContinuationSourceCommit(review); active();
        return control.apply(database, state.receipt, readAuthority, checkProcess, active);
      }));
      pending = run; return run;
    });
    gatewayActive = false;
    if (pending) await pending.catch(() => undefined);
    if (routed.state !== "reachable") refuse("CONTINUATION_PROVIDER_UNAVAILABLE");
    if (!routed.value.ok) refuse(routed.value.code);
    return routed.value.value;
  } finally {
    gatewayActive = false;
    if (pending) await pending.catch(() => undefined);
    await gateway.close(); await central.close(); environment.key.fill(0); await residency?.close();
  }
}
export async function operatorContinuationDirectInvocation(argument: string | undefined, moduleUrl = import.meta.url) {
  return argument !== undefined && await realpath(argument) === await realpath(fileURLToPath(moduleUrl));
}
if (await operatorContinuationDirectInvocation(process.argv[1])) {
  Promise.resolve().then(() => runOperatorContinuation(parseOperatorContinuationArguments(process.argv.slice(2))))
    .then(value => process.stdout.write(`${JSON.stringify(value)}\n`), (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ outcome: "refused", code: error instanceof OperatorContinuationError
        ? error.code : "CONTINUATION_OPERATION_FAILED" })}\n`); process.exitCode = 1;
    });
}
