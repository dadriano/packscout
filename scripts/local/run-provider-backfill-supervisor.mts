#!/usr/bin/env node
import { randomUUID, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BoundedProviderDatabaseGateway, PrismaProviderWorkerLeaseRepository,
  createCentralDatabaseLifecycle, type ProviderPrismaClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { assertBackfillPins, backfillPinsSchema, classifyBackfillCheckpoint, refuseBackfill, backfillId, safeBackfillFailureCode,
  ProviderBackfillSupervisorError, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import { readBackfillEnvironment, readBackfillAuthority, backfillWorkspaceRoot,
  type BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { readBackfillIntent, readBackfillSnapshot, currentBackfillRunId } from "./provider-backfill-supervisor-state.mts";
import { assertBackfillOperation, persistBackfillIntent, claimBackfillExecution,
  assertBackfillRetryPinned, readOwnedBackfillLeaseExpiry, releaseExpiredBackfillHeadLease } from "./provider-backfill-supervisor-persistence.mts";
import { queueBackfillRetry } from "./provider-backfill-supervisor-queue.mts";
import { superviseProviderBackfill, backfillHasOwnedExpiredHeadLease, type BackfillView } from "./provider-backfill-supervisor.mts";
import { readBackfillRestart, recordBackfillLaunch, persistClosedBackfillRestart } from "./provider-backfill-supervisor-restart.mts";
import { withResidentOperation } from "./provider-resident-operation.mts";

export function parseBackfillArguments(args: readonly string[]) {
  const mode = args[0];
  if ((mode !== "--check-only" && mode !== "--run") || args.length !== 15) refuseBackfill("BACKFILL_ARGUMENTS_INVALID");
  const keys = new Map([ ["--organization-id", "organizationId"], ["--provider-id", "providerId"],
    ["--provider-key", "providerKey"], ["--config-id", "configId"], ["--initial-run-id", "initialRunId"],
    ["--operation-id", "operationId"], ["--operator-id", "operatorId"] ]);
  const input: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = keys.get(args[i]!);
    if (!key || input[key] !== undefined) refuseBackfill("BACKFILL_ARGUMENTS_INVALID");
    input[key] = args[i + 1]!;
  }
  const parsed = backfillPinsSchema.safeParse(input);
  if (!parsed.success) refuseBackfill("BACKFILL_ARGUMENTS_INVALID");
  return { mode, pins: parsed.data };
}

export async function readBackfillView(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority): Promise<BackfillView> {
  await assertBackfillOperation(database, pins, authority, false);
  const intent = await readBackfillIntent(database, pins);
  if (intent && (intent.authorityDigest !== authority.digest || BigInt(intent.configNumber) !== authority.configNumber)) {
    refuseBackfill("BACKFILL_AUTHORITY_DRIFT");
  }
  const target = intent ? await database.provider_runs.findUnique({ where: { id: intent.runId } }) : null;
  if (target && intent) {
    const commandId = backfillId(pins.operationId, `command/${intent.parentRunId}`);
    const command = await database.control_commands.findUnique({ where: { id: commandId } });
    if (target.control_command_id !== commandId || target.requested_cursor_hash !== intent.checkpointHash ||
      target.config_version_id !== pins.configId || target.config_version_number !== authority.configNumber ||
      !command || command.resulting_run_id !== target.id || command.command_type !== "run" ||
      command.correlation_id !== pins.operationId || command.requested_by_operator_id !== pins.operatorId ||
      command.expected_generation !== BigInt(intent.generation) + 1n ||
      command.idempotency_key !== `backfill/${pins.operationId}/${intent.parentRunId}/run`) refuseBackfill("BACKFILL_QUEUED_RUN_CONFLICT");
  }
  const pendingRetry = intent !== null && target === null;
  const restart = await readBackfillRestart(database, pins, authority);
  const anchorRunId = intent?.runId ?? pins.initialRunId;
  // A verified closed-child receipt checkpoints recovery lineage too; the bounded
  // traversal is not a cumulative retry budget for a long-lived operation.
  const knownRunId = restart?.anchorRunId === anchorRunId ? restart.runId : anchorRunId;
  const runId = pendingRetry ? intent.parentRunId : await currentBackfillRunId(database, knownRunId);
  const snapshot = await readBackfillSnapshot(database, pins, authority, runId);
  assertBackfillPins(snapshot, pins, authority.configNumber);
  if (pendingRetry && intent && (snapshot.checkpointHash !== intent.checkpointHash ||
    snapshot.run.failureCode !== intent.failureCode || snapshot.run.state !== "failed" ||
    ![BigInt(intent.generation), BigInt(intent.generation) + 1n].includes(snapshot.generation))) {
    refuseBackfill("BACKFILL_PENDING_CHECKPOINT_DRIFT");
  }
  return { snapshot, intent, pendingRetry, restart, authorityDigest: authority.digest,
    ownedLeaseExpiresAt: await readOwnedBackfillLeaseExpiry(database, pins, authority, snapshot) };
}

export async function executeBackfillChild(input: { pins: BackfillPins; owner: string;
  environment: NodeJS.ProcessEnv; signal: AbortSignal }): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (input.signal.aborted) return { code: null, signal: "SIGTERM" };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(backfillWorkspaceRoot,
      "apps/worker/src/provider-manual-import-local.ts")], { cwd: backfillWorkspaceRoot,
      env: { ...input.environment, PACKSCOUT_PROVIDER_ID: input.pins.providerId,
        PACKSCOUT_PROVIDER_KEY: input.pins.providerKey, PACKSCOUT_PROVIDER_WORKER_ID: input.owner },
      stdio: "inherit" });
    const stop = () => { child.kill("SIGTERM"); };
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    child.once("error", () => { input.signal.removeEventListener("abort", stop); reject(new ProviderBackfillSupervisorError("BACKFILL_WORKER_START_FAILED")); });
    child.once("close", (code, signal) => { input.signal.removeEventListener("abort", stop); resolve({ code, signal }); });
  });
}

export async function runBackfillSupervisor(args: ReturnType<typeof parseBackfillArguments>, signal: AbortSignal) {
  const environment = await readBackfillEnvironment();
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: environment.runtimePolicy.destinationPolicy,
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationTimeoutMs: 60_000,
    // The only place the real rejection behind BACKFILL_PROVIDER_DATABASE_UNAVAILABLE survives.
    diagnostics: event => process.stderr.write(`${JSON.stringify({ level: "warning",
      event: `provider_database_${event.kind}`, providerKey: args.pins.providerKey, ...event })}\n`) });
  const owner = `local:backfill:${args.pins.operationId}:${randomUUID()}`;
  const withDatabase = async <T,>(operation: (db: ProviderPrismaClient, authority: BackfillAuthority, active: () => void) => Promise<T>): Promise<T> => {
    const authority = await readBackfillAuthority(central.client, cipher, args.pins, environment.runtimePolicy);
    const outcome = await withResidentOperation(async (db: ProviderPrismaClient, active) => {
      try { return { ok: true as const, value: await operation(db, authority, active) }; }
      catch (error) {
        if (error instanceof ProviderBackfillSupervisorError) return { ok: false as const, code: error.code };
        throw error;
      }
    }, callback => gateway.runWithCachedProviderDatabase(authority.route, callback), signal);
    if (outcome.state !== "reachable") refuseBackfill("BACKFILL_PROVIDER_DATABASE_UNAVAILABLE");
    if (!outcome.value.ok) refuseBackfill(outcome.value.code);
    return outcome.value.value;
  };
  try {
    await central.start();
    const read = () => withDatabase((db, authority) => readBackfillView(db, args.pins, authority));
    if (args.mode === "--check-only") {
      const view = await read();
      const disposition = view.pendingRetry ? "durable_retry_pending" : backfillHasOwnedExpiredHeadLease(view)
        ? "owned_expired_head_cleanup" : classifyBackfillCheckpoint(view.snapshot);
      return { outcome: disposition, providerId: args.pins.providerId, runId: view.snapshot.run.id,
        state: view.snapshot.run.state, pages: view.snapshot.run.pageCount, accepted: view.snapshot.run.accepted,
        failureCode: safeBackfillFailureCode(view.snapshot.run.failureCode), retryRunId: view.intent?.runId ?? null,
        notBefore: view.intent?.notBefore ?? null, leaseOwned: view.snapshot.lease.owner !== null };
    }
    const outcome = await superviseProviderBackfill({ pins: args.pins, read,
      releaseExpiredHeadLease: view => withDatabase(async (db, authority, active) => {
        const current = await readBackfillView(db, args.pins, authority);
        if (current.snapshot.run.id !== view.snapshot.run.id || current.snapshot.generation !== view.snapshot.generation ||
          current.snapshot.checkpointHash !== view.snapshot.checkpointHash || !backfillHasOwnedExpiredHeadLease(current)) {
          refuseBackfill("BACKFILL_HEAD_LEASE_CHANGED");
        }
        await releaseExpiredBackfillHeadLease(db, args.pins, authority, current.snapshot, owner, active);
      }),
      persistRetry: (view) => withDatabase(async (db, authority, active) => {
        active();
        await assertBackfillOperation(db, args.pins, authority, true, active);
        let snapshot = view.snapshot;
        if (snapshot.lease.owner !== null) {
          const lease = await claimBackfillExecution(db, args.pins, authority, snapshot, owner, active);
          await new PrismaProviderWorkerLeaseRepository(db).release(lease);
          snapshot = await readBackfillSnapshot(db, args.pins, authority, snapshot.run.id);
        }
        active();
        await persistBackfillIntent(db, args.pins, authority, snapshot, view.intent, randomInt(1_000_000) / 1_000_000, active);
      }),
      async execute(view) {
        const held = await withDatabase(async (db, authority, active) => {
          active();
          await assertBackfillOperation(db, args.pins, authority, true, active);
          const lease = await claimBackfillExecution(db, args.pins, authority, view.snapshot, owner, active);
          try {
            if (view.pendingRetry && view.intent) await queueBackfillRetry({ database: db, intent: view.intent,
              assertPinned: async (resumed) => { active(); await assertBackfillRetryPinned(db, authority, view.intent!, lease, resumed); active(); } });
            else {
              const current = await readBackfillView(db, args.pins, authority);
              if (current.snapshot.run.id !== view.snapshot.run.id || classifyBackfillCheckpoint(current.snapshot) !== "execute" ||
                current.snapshot.actionableCommands.some((command) => command.runId !== current.snapshot.run.id)) {
                refuseBackfill("BACKFILL_ACTIVE_RUN_CHANGED");
              }
            }
            const current = await readBackfillView(db, args.pins, authority);
            active();
            const launch = await recordBackfillLaunch(db, args.pins, authority, lease, current.snapshot.run.id,
              view.intent?.runId ?? args.pins.initialRunId, active);
            return { lease, route: authority.route, authority, launch };
          } catch (error) { await new PrismaProviderWorkerLeaseRepository(db).release(lease); throw error; }
        });
        try {
          const closed = await executeBackfillChild({ pins: args.pins, owner, environment: environment.workerEnvironment, signal });
          if (closed.signal === "SIGTERM" || closed.signal === "SIGINT") return "operator_stop" as const;
          if (!signal.aborted) {
            await withDatabase(async (db, authority, active) => {
              const after = await readBackfillView(db, args.pins, authority);
              if (["queued", "running"].includes(after.snapshot.run.state) && !["paused", "stopped"].includes(after.snapshot.state)) {
                await persistClosedBackfillRestart({ database: db, pins: args.pins, authority,
                  lease: held.lease, launch: held.launch, childClosed: true, aborted: signal.aborted,
                  jitter: randomInt(1_000_000) / 1_000_000, active });
              }
            });
          }
        }
        finally {
          // Fenced release is cleanup even after operator abort; still drain it
          // before gateway close or the next authoritative observation.
          await withResidentOperation((db: ProviderPrismaClient) => new PrismaProviderWorkerLeaseRepository(db).release(held.lease),
            callback => gateway.runWithCachedProviderDatabase(held.route, callback), new AbortController().signal);
        }
      },
      wait: (milliseconds) => new Promise<void>((resolve) => {
        const timer = setTimeout(done, milliseconds);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
      }),
      emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    }, signal);
    return { outcome, providerId: args.pins.providerId };
  } finally { await gateway.close(); await central.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
  Promise.resolve().then(() => runBackfillSupervisor(parseBackfillArguments(process.argv.slice(2)), stop.signal)).then(
    (result) => { process.stdout.write(`${JSON.stringify(result)}\n`); },
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ outcome: "blocked", code: error instanceof ProviderBackfillSupervisorError
        ? error.code : "BACKFILL_SUPERVISOR_FAILED" })}\n`); process.exitCode = 1;
    });
}
