#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, createCentralDatabaseLifecycle,
  type ProviderPrismaClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillEnvironment, readBackfillAuthority, type BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { ProviderBackfillSupervisorError, classifyBackfillCheckpoint, refuseBackfill } from "./provider-backfill-supervisor-policy.mts";
import { parseBackfillArguments, runBackfillSupervisor } from "./run-provider-backfill-supervisor.mts";
import { continuousDecision, cyclePins, superviseContinuousProvider, type ContinuousView } from "./provider-continuous-policy.mts";
import { readContinuousView, persistContinuousOperation, persistContinuousCycle, queueContinuousCycle } from "./provider-continuous-persistence.mts";
import { continuousCadenceSchema, defaultContinuousCadence, effectiveContinuousIntervalSeconds } from "./provider-continuous-cadence.mts";
import { continuousPostHeadPolicyForRegistration, runContinuousPostHead, type ContinuousPostHeadRegistration } from "./provider-continuous-post-head.mts";
import { continuousResidencyPort, withContinuousResidency, type ContinuousHealth } from "./provider-continuous-residency.mts";
import { createContinuousProviderReader } from "./provider-continuous-read.mts";
import { readResidentBootstrapView, persistResidentHandoff, residentContinuousPins, type ResidentBootstrapView } from "./provider-resident-handoff.mts";
import { superviseResidentBootstrap } from "./provider-resident-policy.mts";
import { residentFailureCode, withResidentStartup } from "./provider-resident-errors.mts";
import { withResidentOperation } from "./provider-resident-operation.mts";
import { backfillHasOwnedExpiredHeadLease } from "./provider-backfill-supervisor.mts";

export function parseContinuousArguments(args: readonly string[]) {
  const flags = new Set(["--bootstrap-backfill", "--await-initial-run", "--launchd"]);
  const selected = args.filter(value => flags.has(value));
  if (new Set(selected).size !== selected.length) refuseBackfill("CONTINUOUS_ARGUMENTS_INVALID");
  const remaining: string[] = [];
  let interval: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (flags.has(value)) continue;
    if (value !== "--poll-interval-seconds") { remaining.push(value); continue; }
    const raw = args[++index];
    if (interval !== undefined || !raw || !/^[1-9][0-9]*$/u.test(raw)) refuseBackfill("CONTINUOUS_ARGUMENTS_INVALID");
    interval = Number(raw);
  }
  const policy = continuousCadenceSchema.safeParse(interval === undefined
    ? defaultContinuousCadence : { kind: "operator_interval", intervalSeconds: interval });
  if (!policy.success) refuseBackfill("CONTINUOUS_ARGUMENTS_INVALID");
  if (selected.includes("--bootstrap-backfill") && policy.data.kind !== "central") {
    refuseBackfill("CONTINUOUS_BOOTSTRAP_POLICY_UNSUPPORTED");
  }
  const parsed = parseBackfillArguments(remaining);
  if ((selected.includes("--launchd") && parsed.mode !== "--run") ||
    (selected.includes("--await-initial-run") && !selected.includes("--bootstrap-backfill"))) {
    refuseBackfill("CONTINUOUS_ARGUMENTS_INVALID");
  }
  return { ...parsed, bootstrapBackfill: selected.includes("--bootstrap-backfill"),
    awaitInitialRun: selected.includes("--await-initial-run"), launchd: selected.includes("--launchd"),
    cadence: policy.data };
}
export async function runContinuousPoller(args: ReturnType<typeof parseContinuousArguments>, signal: AbortSignal,
  lifecycle: { postHead?: ContinuousPostHeadRegistration; beforeSource?: (signal: AbortSignal) => Promise<void> } = {}) {
  const postHead = lifecycle.postHead === undefined ? undefined : Object.freeze({
    policyFingerprint: lifecycle.postHead.policyFingerprint,
    timeoutMilliseconds: lifecycle.postHead.timeoutMilliseconds, run: lifecycle.postHead.run });
  const postHeadPolicy = continuousPostHeadPolicyForRegistration(postHead);
  const beforeSource = lifecycle.beforeSource;
  if (beforeSource !== undefined && typeof beforeSource !== "function") refuseBackfill("CONTINUOUS_DEPLOYMENT_CHECK_INVALID");
  // Bootstrap's older operation receipts do not bind custom continuous policy.
  // Admit custom cadence/hooks only after a separately verified source head.
  if (args.bootstrapBackfill && (args.cadence.kind !== "central" || postHeadPolicy.kind !== "none")) {
    refuseBackfill("CONTINUOUS_BOOTSTRAP_POLICY_UNSUPPORTED");
  }
  const environment = await readBackfillEnvironment();
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: environment.runtimePolicy.destinationPolicy,
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationTimeoutMs: 60_000,
    // The only place the real rejection behind "database unreachable" survives.
    diagnostics: event => process.stderr.write(`${JSON.stringify({ level: "warning",
      event: `provider_database_${event.kind}`, providerKey: args.pins.providerKey, ...event })}\n`) });
  let effectiveIntervalSeconds: number | undefined;
  const readAuthority = async () => {
    const authority = await readBackfillAuthority(central.client, cipher, args.pins, environment.runtimePolicy);
    effectiveIntervalSeconds = effectiveContinuousIntervalSeconds(authority.scheduleSeconds, args.cadence);
    return authority;
  };
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
    read: (db, authority) => readContinuousView(db, pollingPins, authority, args.cadence, postHeadPolicy) });
  const readBootstrap = createContinuousProviderReader<BackfillAuthority, ResidentBootstrapView>({ authority: readAuthority,
    run: (authority, operation) => gateway.runWithCachedProviderDatabase(authority.route, operation),
    read: (db, authority) => readResidentBootstrapView(db, args.pins, authority, args.awaitInitialRun) });
  let health: ContinuousHealth = { state: "starting" };
  const emit = (event: ContinuousHealth) => {
    health = event;
    process.stdout.write(`${JSON.stringify({ event: "provider_continuous_state", providerId: args.pins.providerId,
      providerKey: args.pins.providerKey, operationId: args.pins.operationId, pid: process.pid,
      observedAt: new Date().toISOString(), cadence: args.cadence, effectiveIntervalSeconds,
      postHeadPolicy, ...event })}\n`);
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
        const disposition = "awaitingInitialRun" in view && view.awaitingInitialRun ? "awaiting_initial_run" :
          view.backfill ? (backfillHasOwnedExpiredHeadLease(view.backfill) ? "owned_expired_head_cleanup"
          : view.backfill.ownedLeaseExpiresAt && view.backfill.ownedLeaseExpiresAt > view.backfill.snapshot.now ? "waiting_owned_child"
            : classifyBackfillCheckpoint(view.backfill.snapshot)) : "handoff_saved";
        return { state: disposition, providerId: args.pins.providerId,
          runId: view.handoff?.headRunId ?? view.backfill?.snapshot.run.id,
          checkpointHash: view.handoff?.checkpointHash ?? view.backfill?.snapshot.checkpointHash,
          runtimeState: view.backfill?.snapshot.state ?? null, residencyPort: continuousResidencyPort(args.pins),
          residency: "not_claimed_check_only", cadence: args.cadence, effectiveIntervalSeconds, postHeadPolicy, pid: process.pid };
      }
      const view = await read();
      const decision = continuousDecision(view, args.pins);
      return { ...decision, providerId: args.pins.providerId, runId: view.snapshot.run.id,
        checkpointHash: view.snapshot.checkpointHash, scheduleSeconds: view.scheduleSeconds,
        cadence: args.cadence, effectiveIntervalSeconds, postHeadPolicy,
        runtimeState: view.snapshot.state, generation: view.snapshot.generation.toString(),
        runtimeRowVersion: view.snapshot.runtimeRowVersion?.toString(), authorityDigest: view.authorityDigest,
        configVersionId: view.snapshot.configId, configVersionNumber: view.snapshot.run.configNumber.toString(),
        headFinishedAt: view.snapshot.run.finishedAt?.toISOString(),
        leaseOwned: view.snapshot.lease.owner !== null, leaseFence: view.snapshot.lease.fence.toString(),
        pages: view.snapshot.run.pageCount, accepted: view.snapshot.run.accepted,
        cycleOperationId: view.cycle?.cycleOperationId ?? null, residencyPort: continuousResidencyPort(args.pins),
        residency: "not_claimed_check_only", pid: process.pid };
    }
    // Resolve central scope before claiming local residency; no DB mutation yet.
    await withResidentStartup(readAuthority);
    return await withContinuousResidency(args.pins, () => ({ ...health, cadence: args.cadence, effectiveIntervalSeconds, postHeadPolicy }), async () => {
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
      const initial = await read();
      await withDatabase((db, authority, active) => persistContinuousOperation(db, pollingPins, authority, initial, active, args.cadence, postHeadPolicy));
      return superviseContinuousProvider({ pins: pollingPins, read,
      beforeSource: beforeSource ? () => beforeSource(signal) : undefined,
      postHead: postHead ? view => runContinuousPostHead({ registration: postHead, view,
        pins: pollingPins, parentAbortSignal: signal }) : undefined,
      persist: async view => { await withDatabase((db, authority, active) => persistContinuousCycle(db, pollingPins, authority, view, active, args.cadence, postHeadPolicy)); },
      queue: async cycle => { await withDatabase((db, _authority, active) => queueContinuousCycle({ database: db, cycle, readAuthority, active, cadence: args.cadence, postHeadPolicy })); },
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
