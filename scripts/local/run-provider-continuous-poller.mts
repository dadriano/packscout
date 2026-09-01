#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, createCentralDatabaseLifecycle,
  type ProviderPrismaClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillEnvironment, readBackfillAuthority, type BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { ProviderBackfillSupervisorError, classifyBackfillCheckpoint, refuseBackfill } from "./provider-backfill-supervisor-policy.mts";
import { parseBackfillArguments, runBackfillSupervisor } from "./run-provider-backfill-supervisor.mts";
import { continuousDecision, cyclePins, superviseContinuousProvider, type ContinuousView } from "./provider-continuous-policy.mts";
import { readContinuousView, persistContinuousCycle, queueContinuousCycle } from "./provider-continuous-persistence.mts";
import { continuousResidencyPort, withContinuousResidency, type ContinuousHealth } from "./provider-continuous-residency.mts";
import { createContinuousProviderReader } from "./provider-continuous-read.mts";
import { readResidentBootstrapView, persistResidentHandoff, residentContinuousPins, type ResidentBootstrapView } from "./provider-resident-handoff.mts";
import { superviseResidentBootstrap } from "./provider-resident-policy.mts";
import { residentFailureCode, withResidentStartup } from "./provider-resident-errors.mts";
import { withResidentOperation } from "./provider-resident-operation.mts";
import { backfillHasOwnedExpiredHeadLease } from "./provider-backfill-supervisor.mts";

export function parseContinuousArguments(args: readonly string[]) {
  const flags = new Set(["--bootstrap-backfill", "--launchd"]);
  const selected = args.filter(value => flags.has(value));
  if (new Set(selected).size !== selected.length) refuseBackfill("CONTINUOUS_ARGUMENTS_INVALID");
  const parsed = parseBackfillArguments(args.filter(value => !flags.has(value)));
  if (selected.includes("--launchd") && parsed.mode !== "--run") refuseBackfill("CONTINUOUS_ARGUMENTS_INVALID");
  return { ...parsed, bootstrapBackfill: selected.includes("--bootstrap-backfill"), launchd: selected.includes("--launchd") };
}
export async function runContinuousPoller(args: ReturnType<typeof parseContinuousArguments>, signal: AbortSignal) {
  const environment = await readBackfillEnvironment();
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"],
      allowedPorts: [55432, 55433, 55434, 55435], allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationTimeoutMs: 60_000 });
  const readAuthority = () => readBackfillAuthority(central.client, cipher, args.pins);
  const withDatabase = async <T,>(operation: (db: ProviderPrismaClient, authority: BackfillAuthority, active: () => void) => Promise<T>): Promise<T> => {
    const authority = await readAuthority();
    const result = await withResidentOperation(async (db: ProviderPrismaClient, active) => {
      try { return { ok: true as const, value: await operation(db, authority, active) }; }
      catch (error) {
        if (error instanceof ProviderBackfillSupervisorError) return { ok: false as const, code: error.code };
        throw error;
      }
    }, callback => gateway.runWithCachedProviderDatabase(authority.route, callback), signal);
    if (result.state !== "reachable") refuseBackfill("CONTINUOUS_PROVIDER_UNAVAILABLE");
    if (!result.value.ok) refuseBackfill(result.value.code);
    return result.value.value;
  };
  let pollingPins = args.pins;
  const read = createContinuousProviderReader<BackfillAuthority, ContinuousView>({ authority: readAuthority,
    run: (authority, operation) => gateway.runWithCachedProviderDatabase(authority.route, operation),
    read: (db, authority) => readContinuousView(db, pollingPins, authority) });
  const readBootstrap = createContinuousProviderReader<BackfillAuthority, ResidentBootstrapView>({ authority: readAuthority,
    run: (authority, operation) => gateway.runWithCachedProviderDatabase(authority.route, operation),
    read: (db, authority) => readResidentBootstrapView(db, args.pins, authority) });
  let health: ContinuousHealth = { state: "starting" };
  const emit = (event: ContinuousHealth) => {
    health = event;
    process.stdout.write(`${JSON.stringify({ event: "provider_continuous_state", providerId: args.pins.providerId,
      providerKey: args.pins.providerKey, operationId: args.pins.operationId, pid: process.pid,
      observedAt: new Date().toISOString(), ...event })}\n`);
  };
  const wait = (milliseconds: number) => new Promise<void>(resolve => {
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
  });
  try {
    await withResidentStartup(() => central.start());
    if (args.mode === "--check-only") {
      if (args.bootstrapBackfill) {
        const view = await readBootstrap();
        if (view.handoff) { pollingPins = residentContinuousPins(view.handoff); continuousDecision(await read(), pollingPins); }
        const disposition = view.backfill ? (backfillHasOwnedExpiredHeadLease(view.backfill) ? "owned_expired_head_cleanup"
          : view.backfill.ownedLeaseExpiresAt && view.backfill.ownedLeaseExpiresAt > view.backfill.snapshot.now ? "waiting_owned_child"
            : classifyBackfillCheckpoint(view.backfill.snapshot)) : "handoff_saved";
        return { state: disposition, providerId: args.pins.providerId,
          runId: view.handoff?.headRunId ?? view.backfill?.snapshot.run.id,
          checkpointHash: view.handoff?.checkpointHash ?? view.backfill?.snapshot.checkpointHash,
          runtimeState: view.backfill?.snapshot.state ?? null, residencyPort: continuousResidencyPort(args.pins),
          residency: "not_claimed_check_only", pid: process.pid };
      }
      const view = await read();
      const decision = continuousDecision(view, args.pins);
      return { ...decision, providerId: args.pins.providerId, runId: view.snapshot.run.id,
        checkpointHash: view.snapshot.checkpointHash, scheduleSeconds: view.scheduleSeconds,
        runtimeState: view.snapshot.state, generation: view.snapshot.generation.toString(),
        leaseOwned: view.snapshot.lease.owner !== null, leaseFence: view.snapshot.lease.fence.toString(),
        pages: view.snapshot.run.pageCount, accepted: view.snapshot.run.accepted,
        cycleOperationId: view.cycle?.cycleOperationId ?? null, residencyPort: continuousResidencyPort(args.pins),
        residency: "not_claimed_check_only", pid: process.pid };
    }
    // Resolve central scope before claiming local residency; no DB mutation yet.
    await withResidentStartup(readAuthority);
    return await withContinuousResidency(args.pins, () => health, async () => {
      if (args.bootstrapBackfill) {
        const resolved = await superviseResidentBootstrap({ read: readBootstrap,
          persist: view => withDatabase((db, authority, active) => persistResidentHandoff(db, args.pins, authority, view, active)),
          execute: async () => {
            const result = await runBackfillSupervisor({ mode: "--run", pins: args.pins }, signal);
            if (result.outcome !== "head" && result.outcome !== "operator_stop") refuseBackfill("CONTINUOUS_CYCLE_OUTCOME_INVALID");
            return result.outcome;
          },
          wait, emit }, signal);
        if (!resolved || signal.aborted) return "stopped";
        pollingPins = resolved;
      }
      return superviseContinuousProvider({ pins: pollingPins, read,
      persist: async view => { await withDatabase((db, authority, active) => persistContinuousCycle(db, pollingPins, authority, view, active)); },
      queue: async cycle => { await withDatabase((db, _authority, active) => queueContinuousCycle({ database: db, cycle, readAuthority, active })); },
      execute: async cycle => {
        emit({ state: "polling", runId: cycle.runId });
        const result = await runBackfillSupervisor({ mode: "--run", pins: cyclePins(cycle) }, signal);
        if (result.outcome !== "head" && result.outcome !== "operator_stop") refuseBackfill("CONTINUOUS_CYCLE_OUTCOME_INVALID");
        return result.outcome;
      },
      wait, emit,
      }, signal);
    });
  } finally { await read.drain(); await readBootstrap.drain(); await gateway.close(); await central.close(); environment.key.fill(0); }
}
export async function runContinuousCli(argv: readonly string[], signal: AbortSignal,
  output: { result(value: unknown): void; error(value: unknown): void },
  run: typeof runContinuousPoller = runContinuousPoller): Promise<number> {
  let launchd = false;
  try {
    const args = parseContinuousArguments(argv); launchd = args.launchd;
    output.result({ outcome: await run(args, signal) });
    return 0;
  } catch (error) {
    const code = residentFailureCode(error);
    output.error({ outcome: code === "CONTINUOUS_STARTUP_UNAVAILABLE" ? "startup_unavailable" : "blocked", code });
    // Expected startup/configuration errors must not become a launchd spin.
    // Runtime permanent errors stay resident and blocked; crashes remain nonzero.
    if (signal.aborted) return 0;
    return launchd ? (code === "CONTINUOUS_STARTUP_UNAVAILABLE" ? 75 : 0) : 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
  void runContinuousCli(process.argv.slice(2), stop.signal, {
    result: value => { process.stdout.write(`${JSON.stringify(value)}\n`); },
    error: value => { process.stderr.write(`${JSON.stringify(value)}\n`); },
  }).then(code => { process.exitCode = code; });
}
