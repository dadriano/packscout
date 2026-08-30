#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, createCentralDatabaseLifecycle,
  type ProviderPrismaClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillEnvironment, readBackfillAuthority, type BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { ProviderBackfillSupervisorError, refuseBackfill } from "./provider-backfill-supervisor-policy.mts";
import { parseBackfillArguments, runBackfillSupervisor } from "./run-provider-backfill-supervisor.mts";
import { continuousDecision, cyclePins, superviseContinuousProvider, type ContinuousView } from "./provider-continuous-policy.mts";
import { readContinuousView, persistContinuousCycle, queueContinuousCycle } from "./provider-continuous-persistence.mts";
import { continuousResidencyPort, withContinuousResidency, type ContinuousHealth } from "./provider-continuous-residency.mts";
import { createContinuousProviderReader } from "./provider-continuous-read.mts";

export const parseContinuousArguments = parseBackfillArguments;
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
  const withDatabase = async <T,>(operation: (db: ProviderPrismaClient, authority: BackfillAuthority) => Promise<T>): Promise<T> => {
    const authority = await readAuthority();
    const result = await gateway.runWithCachedProviderDatabase(authority.route, async db => {
      try { return { ok: true as const, value: await operation(db, authority) }; }
      catch (error) {
        if (error instanceof ProviderBackfillSupervisorError) return { ok: false as const, code: error.code };
        throw error;
      }
    });
    if (result.state !== "reachable") refuseBackfill("CONTINUOUS_PROVIDER_UNAVAILABLE");
    if (!result.value.ok) refuseBackfill(result.value.code);
    return result.value.value;
  };
  const read = createContinuousProviderReader<BackfillAuthority, ContinuousView>({ authority: readAuthority,
    run: (authority, operation) => gateway.runWithCachedProviderDatabase(authority.route, operation),
    read: (db, authority) => readContinuousView(db, args.pins, authority) });
  let health: ContinuousHealth = { state: "starting" };
  const emit = (event: ContinuousHealth) => {
    health = event;
    process.stdout.write(`${JSON.stringify({ event: "provider_continuous_state", providerId: args.pins.providerId,
      providerKey: args.pins.providerKey, operationId: args.pins.operationId, pid: process.pid,
      observedAt: new Date().toISOString(), ...event })}\n`);
  };
  try {
    await central.start();
    if (args.mode === "--check-only") {
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
    await readAuthority();
    return await withContinuousResidency(args.pins, () => health, () => superviseContinuousProvider({ pins: args.pins, read,
      persist: async view => { await withDatabase((db, authority) => persistContinuousCycle(db, args.pins, authority, view)); },
      queue: async cycle => { await withDatabase(db => queueContinuousCycle({ database: db, cycle, readAuthority })); },
      execute: async cycle => {
        emit({ state: "polling", runId: cycle.runId });
        const result = await runBackfillSupervisor({ mode: "--run", pins: cyclePins(cycle) }, signal);
        if (result.outcome !== "head" && result.outcome !== "operator_stop") refuseBackfill("CONTINUOUS_CYCLE_OUTCOME_INVALID");
        return result.outcome;
      },
      wait: milliseconds => new Promise<void>(resolve => {
        const timer = setTimeout(done, milliseconds);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
      }), emit,
    }, signal));
  } finally { await gateway.close(); await central.close(); environment.key.fill(0); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
  Promise.resolve().then(() => runContinuousPoller(parseContinuousArguments(process.argv.slice(2)), stop.signal)).then(
    result => process.stdout.write(`${JSON.stringify({ outcome: result })}\n`),
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ outcome: "blocked", code: error instanceof ProviderBackfillSupervisorError
        ? error.code : "CONTINUOUS_POLLER_FAILED" })}\n`); process.exitCode = 1;
    });
}
