import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { statfs } from "node:fs/promises";
import { z } from "zod";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy,
  createCentralDatabaseLifecycle, locateProviderDatabase, providerMixedPageDigest,
  PROVIDER_HEAD_RECONCILIATION_ACTION,
  type ProviderPrismaClient, type ProviderDatabaseOperationResult } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { assertLocalBackfillDestination, localBackfillProviderPorts,
  readLocalBackfillEnvironment } from "./provider-backfill-supervisor-authority.mts";
import { providerImportHealth, type ProviderHeadReconciliationHealth } from "./provider-import-health-policy.mts";

const residentSchema = z.object({ providerId: z.string().uuid(), providerKey: z.string(),
  pid: z.number().int().positive(), state: z.string().regex(/^[a-z_]{1,40}$/u),
  runId: z.string().uuid().optional(), nextDueAt: z.string().datetime().optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u).optional() });
const code = (value: string | null) => value === null || /^[A-Z][A-Z0-9_]{0,127}$/u.test(value)
  ? value : "UNSAFE_FAILURE_CODE_REDACTED";
const canonicalTables = ["categories", "packs", "collectibles", "collectible_name_aliases",
  "collectible_instances", "pack_contents", "provider_accounts", "pulls", "pull_items", "market_events"] as const;
const headReceiptSchema = z.object({ occurredAt: z.date(), outcome: z.literal("success"), targetType: z.literal("provider_run"),
  schemaVersion: z.literal(1), configVersionId: z.string().uuid(), checkpointHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  leaseFence: z.string().regex(/^[1-9][0-9]*$/u), batchNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(["facts", "quarantines", "complete"]) }).strict();

/** Projection contains no source/reconciliation cursors; invalid evidence is never progress. */
export function providerHealthHeadReconciliation(receipt: unknown, pins: {
  configVersionId: string; checkpointHash: string | null; workerFence: bigint;
}): ProviderHeadReconciliationHealth {
  if (receipt === undefined) return { state: "absent" };
  const parsed = headReceiptSchema.safeParse(receipt);
  if (!parsed.success || parsed.data.configVersionId !== pins.configVersionId
    || parsed.data.checkpointHash !== pins.checkpointHash || parsed.data.leaseFence !== pins.workerFence.toString()) {
    return { state: "invalid" };
  }
  const { occurredAt, batchNumber, phase } = parsed.data;
  return { state: "recorded", occurredAt, batchNumber, phase };
}

/** Read a bounded local observation; no commands, source calls or process signals. */
export async function readProviderHealthResident(port: number, providerId: string, providerKey: string,
  options: { timeoutMilliseconds?: number; connect?: () => Pick<net.Socket, "on" | "destroy"> } = {}) {
  const timeout = options.timeoutMilliseconds ?? 1500;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1500) throw new Error("HEALTH_RESIDENT_TIMEOUT_INVALID");
  return new Promise<z.infer<typeof residentSchema> | null>(resolve => {
    let body = "";
    let bytes = 0;
    let settled = false;
    let socket: Pick<net.Socket, "on" | "destroy"> | undefined;
    const finish = (value: z.infer<typeof residentSchema> | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy(); resolve(value);
    };
    // Absolute deadline: trickled input must never extend the observation window.
    const timer = setTimeout(() => finish(null), timeout);
    try { socket = options.connect?.() ?? net.createConnection({ host: "127.0.0.1", port }); }
    catch { finish(null); return; }
    socket.on("error", () => finish(null));
    socket.on("data", (data: Buffer) => {
      if (settled) return;
      bytes += data.byteLength;
      if (bytes > 4096) return finish(null);
      body += data.toString("utf8");
      if (!body.includes("\n")) return;
      try {
        const parsed = residentSchema.safeParse(JSON.parse(body.slice(0, body.indexOf("\n"))));
        finish(parsed.success && parsed.data.providerId === providerId && parsed.data.providerKey === providerKey
          ? parsed.data : null);
      } catch { finish(null); }
    });
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

export async function runProviderHealthReadWithDrain<T>(
  read: (database: ProviderPrismaClient) => Promise<T>,
  run: (callback: (database: ProviderPrismaClient) => Promise<T>) => Promise<ProviderDatabaseOperationResult<T>>,
) {
  let pending: Promise<T> | undefined;
  try { return await run(database => { pending = Promise.resolve().then(() => read(database)); return pending; }); }
  finally { if (pending) await pending.catch(() => undefined); }
}

export function providerHealthConfigurationMatches(input: {
  now: Date; lifecycle: string; routeConfigId: string;
  run: { config_version_id: string; config_version_number: bigint } | null;
  central: { id: string; version_number: bigint; adapter_key: string; configuration: unknown;
    expires_at: Date | null; schedule_seconds: number } | null;
  cached: { cached_config_version_id: string | null; cached_config_version_number: bigint | null;
    cached_configuration: unknown; config_expires_at: Date | null; schedule_seconds: number | null };
}) {
  const { central: c, cached: r } = input;
  return input.lifecycle === "active" && c !== null && input.routeConfigId === c.id
    && (input.run === null || (input.run.config_version_id === c.id && input.run.config_version_number === c.version_number))
    && r.cached_config_version_id === c.id && r.cached_config_version_number === c.version_number
    && r.schedule_seconds === c.schedule_seconds && r.config_expires_at?.getTime() === c.expires_at?.getTime()
    && (c.expires_at === null || c.expires_at > input.now)
    && providerMixedPageDigest(r.cached_configuration) === providerMixedPageDigest({ adapterKey: c.adapter_key, settings: c.configuration });
}

export async function inspectProviderImportHealth(organizationId: string) {
  z.string().uuid().parse(organizationId);
  const environment = await readLocalBackfillEnvironment();
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"],
      allowedPorts: Object.values(localBackfillProviderPorts), allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 1, maximumCachedProviders: 4, operationTimeoutMs: 30_000 });
  try {
    await central.start();
    const observations = [];
    for (const [providerKey, port] of Object.entries(localBackfillProviderPorts)) {
      try {
        const providers = await central.client.providers.findMany({
          where: { organization_id: organizationId, provider_key: providerKey }, take: 2,
          select: { id: true, organization_id: true, provider_key: true, lifecycle: true,
            active_config_version: { select: { id: true, version_number: true, schedule_seconds: true,
              adapter_key: true, configuration: true, expires_at: true } } } });
        if (providers.length !== 1) throw new Error("HEALTH_PROVIDER_SCOPE_INVALID");
        const provider = providers[0]!;
        const located = await locateProviderDatabase(central.client, { organizationId, providerId: provider.id });
        if (located.state !== "ready") throw new Error("HEALTH_ROUTE_UNAVAILABLE");
        assertLocalBackfillDestination(providerKey as keyof typeof localBackfillProviderPorts, located.route);
        const resident = await readProviderHealthResident(port + 1000, provider.id, providerKey);
        const result = await runProviderHealthReadWithDrain(db => db.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          const identity = await tx.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
          if (identity.database_role !== "provider" || identity.provider_id !== provider.id
            || identity.provider_key !== providerKey) throw new Error("HEALTH_DATABASE_IDENTITY_INVALID");
          const [clock] = await tx.$queryRawUnsafe<{ observed_at: Date }[]>("SELECT clock_timestamp() AS observed_at");
          const runtime = await tx.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true }, select: {
            operating_state: true, state_generation: true, cached_config_version_id: true,
            cached_config_version_number: true, cached_configuration: true, config_expires_at: true,
            schedule_seconds: true, next_due_at: true, source_cursor_hash: true,
            consecutive_failures: true, latest_failure_code: true, last_attempted_at: true,
            last_head_reached_at: true, last_runner_heartbeat_at: true } });
          const leases = await tx.provider_worker_states.findMany({ select: {
            worker_role: true, lease_owner: true, lease_fence: true, heartbeat_at: true, lease_expires_at: true } });
          const run = await tx.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }], select: {
            id: true, state: true, reached_source_head: true, page_count: true, accepted_count: true,
            duplicate_count: true, quarantined_count: true, last_progress_at: true, failure_code: true,
            config_version_id: true, config_version_number: true, worker_fence: true,
            requested_at: true, started_at: true, finished_at: true } });
          // Latest current-run receipt only. SQL projects safe metadata instead of fetching private scan positions.
          const receipt = run?.reached_source_head ? (await tx.$queryRaw<unknown[]>`
            SELECT occurred_at AS "occurredAt", outcome, target_type AS "targetType",
              details->'schemaVersion' AS "schemaVersion", details->>'configVersionId' AS "configVersionId",
              details->>'checkpointHash' AS "checkpointHash", details->>'leaseFence' AS "leaseFence",
              details->'batchNumber' AS "batchNumber", details->>'phase' AS phase
            FROM local_audit_events WHERE action = ${PROVIDER_HEAD_RECONCILIATION_ACTION} AND target_id = ${run.id}
            ORDER BY sequence DESC LIMIT 1
          `)[0] : undefined;
          const headReconciliation = run ? providerHealthHeadReconciliation(receipt, {
            configVersionId: run.config_version_id, checkpointHash: runtime.source_cursor_hash, workerFence: run.worker_fence,
          }) : { state: "absent" as const };
          const totals = await tx.provider_runs.aggregate({ _sum: { page_count: true, accepted_count: true,
            duplicate_count: true, quarantined_count: true } });
          const activeRunCount = await tx.provider_runs.count({ where: { state: { in: ["queued", "running"] } } });
          // Identifiers come only from the fixed internal whitelist, never CLI/provider values.
          const [counts] = await tx.$queryRawUnsafe<Record<string, string>[]>(`SELECT ${canonicalTables
            .map(table => `(SELECT count(*) FROM ${table})::text AS ${table}`).join(",")}`);
          const quarantine = await tx.quarantine_records.groupBy({ by: ["state"], _count: { _all: true } });
          const lease = leases.find(item => item.worker_role === "import");
          if (!clock) throw new Error("HEALTH_DATABASE_CLOCK_UNAVAILABLE");
          const configurationMatches = providerHealthConfigurationMatches({ now: clock.observed_at, lifecycle: provider.lifecycle,
            routeConfigId: located.route.configVersionId, central: provider.active_config_version, cached: runtime, run });
          const { cached_configuration: _protectedConfiguration, ...safeRuntime } = runtime;
          return { observedAt: clock.observed_at, runtime: { ...safeRuntime, latest_failure_code: code(runtime.latest_failure_code) },
            run: run ? { ...run, failure_code: code(run.failure_code) } : null,
            leases: leases.map(({ lease_owner, ...safe }) => ({ ...safe, ownerPresent: lease_owner !== null })),
            activeRunCount, configurationMatches, headReconciliation, counts, quarantine, totals: totals._sum,
            health: providerImportHealth({ now: clock!.observed_at, runtimeState: runtime.operating_state,
              runState: run?.state ?? null, reachedHead: run?.reached_source_head ?? false,
              lastProgressAt: run?.last_progress_at ?? null, nextDueAt: runtime.next_due_at,
              leaseOwnerPresent: lease?.lease_owner != null, leaseExpiresAt: lease?.lease_expires_at ?? null,
              leaseMatchesRun: lease?.lease_fence === run?.worker_fence,
              lastHeartbeatAt: runtime.last_runner_heartbeat_at, headReconciliation,
              residentState: resident?.state ?? null, activeRunCount, configurationMatches }) };
        }, { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 25_000 }),
        callback => gateway.runWithCachedProviderDatabase(located.route, callback));
        const centralConfig = provider.active_config_version;
        observations.push({ provider: providerKey, providerId: provider.id, lifecycle: provider.lifecycle,
          centralConfig: centralConfig ? { id: centralConfig.id, version_number: centralConfig.version_number,
            schedule_seconds: centralConfig.schedule_seconds, expires_at: centralConfig.expires_at } : null,
          resident, reachability: result.state,
          ...(result.state === "reachable" ? result.value : { health: "unavailable" }) });
      } catch { observations.push({ provider: providerKey, health: "unavailable" }); }
    }
    const disk = await statfs(fileURLToPath(new URL("../../", import.meta.url)), { bigint: true });
    return { observedAt: new Date().toISOString(), organizationId, observations,
      storage: { availableBytes: (disk.bavail * disk.bsize).toString(),
        totalBytes: (disk.blocks * disk.bsize).toString() } };
  } finally { await gateway.close(); await central.close(); environment.key.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--organization-id") throw new Error("HEALTH_ARGUMENTS_INVALID");
    return inspectProviderImportHealth(args[1]!);
  }).then(result => process.stdout.write(`${JSON.stringify(result, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value)}\n`), () => {
    process.stderr.write('{"health":"unavailable","code":"HEALTH_INSPECTION_FAILED"}\n'); process.exitCode = 1;
  });
}
