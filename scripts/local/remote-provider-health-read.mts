import { PROVIDER_HEAD_RECONCILIATION_ACTION, PROVIDER_SCHEMA_VERSION,
  type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { providerHealthConfigurationMatches, providerHealthHeadReconciliation } from "./inspect-provider-import-health.mts";
import { providerImportHealth } from "./provider-import-health-policy.mts";
import { runRemoteHealthTransaction } from "./remote-provider-health-transaction.mts";
import { refuseRemoteHealth, remoteHealthCheckpoint, remoteHealthCount, remoteHealthSafeCode,
  type RemoteHealthProviderPin } from "./remote-provider-health-policy.mts";

/** One bounded repeatable read. SET statements affect only this read-only transaction. */
export async function readRemoteProviderHealth(database: ProviderPrismaClient, pin: RemoteHealthProviderPin,
  authority: BackfillAuthority) {
  return runRemoteHealthTransaction(callback => database.$transaction(callback,
    { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 25_000 }), async (tx: ProviderTransactionClient) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
    const identity = await tx.database_identity.findUnique({ where: { singleton_key: true }, select: {
      database_role: true, schema_version: true, provider_id: true, provider_key: true,
    } });
    if (!identity || identity.database_role !== "provider" || identity.schema_version !== PROVIDER_SCHEMA_VERSION
      || identity.provider_id !== pin.providerId || identity.provider_key !== pin.providerKey) {
      refuseRemoteHealth("REMOTE_HEALTH_DATABASE_IDENTITY_INVALID");
    }
    const [clock] = await tx.$queryRaw<{ observed_at: Date; database_name: string }[]>`
      SELECT clock_timestamp() AS observed_at, current_database() AS database_name`;
    if (!clock || !Number.isFinite(clock.observed_at.getTime())
      || clock.database_name !== authority.route.target.databaseName) refuseRemoteHealth("REMOTE_HEALTH_DATABASE_CLOCK_OR_NAME_INVALID");
    const runtime = await tx.provider_runtime.findUnique({ where: { singleton_key: true }, select: {
      central_provider_id: true, provider_key: true, operating_state: true, state_generation: true, row_version: true,
      cached_config_version_id: true, cached_config_version_number: true, cached_configuration: true,
      config_expires_at: true, schedule_seconds: true, next_due_at: true, source_cursor: true, source_cursor_hash: true,
      consecutive_failures: true, latest_failure_code: true, last_attempted_at: true,
      last_head_reached_at: true, last_runner_heartbeat_at: true,
    } });
    if (!runtime || runtime.central_provider_id !== pin.providerId || runtime.provider_key !== pin.providerKey) {
      refuseRemoteHealth("REMOTE_HEALTH_RUNTIME_IDENTITY_INVALID");
    }
    const leases = await tx.provider_worker_states.findMany({ take: 3, orderBy: { worker_role: "asc" }, select: {
      worker_role: true, lease_owner: true, lease_fence: true, heartbeat_at: true, lease_expires_at: true, row_version: true,
    } });
    if (leases.length !== 2 || !["import", "promotion"].every(role => leases.some(lease => lease.worker_role === role))) {
      refuseRemoteHealth("REMOTE_HEALTH_LEASES_UNAVAILABLE");
    }
    const run = await tx.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }], select: {
      id: true, recovery_of_run_id: true, state: true, reached_source_head: true, page_count: true, accepted_count: true,
      duplicate_count: true, quarantined_count: true, material_change_count: true, last_progress_at: true, failure_code: true,
      config_version_id: true, config_version_number: true, worker_fence: true, row_version: true, heartbeat_at: true,
      requested_cursor: true, requested_cursor_hash: true, final_cursor: true, final_cursor_hash: true,
      requested_at: true, started_at: true, finished_at: true,
    } });
    const activeRunCount = remoteHealthCount(await tx.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }));
    const actionableCommandCount = remoteHealthCount(await tx.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }));
    const totals = await tx.provider_runs.aggregate({ _count: { _all: true }, _sum: {
      page_count: true, accepted_count: true, duplicate_count: true, quarantined_count: true,
    } });
    const runCount = remoteHealthCount(totals._count._all);
    // Null sums mean there is no run history; do not invent a zero baseline.
    const sums = Object.fromEntries(Object.entries(totals._sum).map(([key, value]) =>
      [key, value === null ? null : remoteHealthCount(value)]));
    const quarantine = await tx.quarantine_records.groupBy({ by: ["state"], _count: { _all: true } });
    const quarantineCounts = quarantine.map(row => ({ state: row.state, count: remoteHealthCount(row._count._all) }));
    // Fetch only safe receipt metadata, never its private reconciliation cursor positions.
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
    const centralConfig = authority.cachedConfiguration;
    const configurationMatches = providerHealthConfigurationMatches({ now: clock.observed_at, lifecycle: "active",
      routeConfigId: authority.route.configVersionId, run, central: {
        id: pin.configId, version_number: authority.configNumber, adapter_key: centralConfig.adapterKey,
        configuration: centralConfig.settings, expires_at: authority.expiresAt, schedule_seconds: authority.scheduleSeconds,
      }, cached: runtime });
    const checkpoint = remoteHealthCheckpoint(runtime.source_cursor, runtime.source_cursor_hash, pin, authority.integration.manifest);
    const requestedCheckpoint = run ? remoteHealthCheckpoint(run.requested_cursor, run.requested_cursor_hash, pin, authority.integration.manifest) : null;
    const finalCheckpoint = run ? remoteHealthCheckpoint(run.final_cursor, run.final_cursor_hash, pin, authority.integration.manifest) : null;
    if (run) for (const value of [run.page_count, run.accepted_count, run.duplicate_count, run.quarantined_count, run.material_change_count]) {
      remoteHealthCount(value);
    }
    const lease = leases.find(row => row.worker_role === "import")!;
    let health = providerImportHealth({ now: clock.observed_at, runtimeState: runtime.operating_state,
      runState: run?.state ?? null, reachedHead: run?.reached_source_head ?? false,
      lastProgressAt: run?.last_progress_at ?? null, nextDueAt: runtime.next_due_at,
      leaseOwnerPresent: lease.lease_owner !== null, leaseExpiresAt: lease.lease_expires_at,
      leaseMatchesRun: run !== null && lease.lease_fence === run.worker_fence,
      lastHeartbeatAt: runtime.last_runner_heartbeat_at, headReconciliation, residentState: null,
      activeRunCount, configurationMatches });
    if (!run) health = "unavailable";
    else if (!configurationMatches) health = "configuration_mismatch";
    else if (!checkpoint.hashValid || !checkpoint.envelopeValid) health = "checkpoint_invalid";
    else if (!requestedCheckpoint?.hashValid || !requestedCheckpoint.envelopeValid
      || !finalCheckpoint?.hashValid || !finalCheckpoint.envelopeValid) health = "run_checkpoint_invalid";
    else if ((health === "paused" || health === "stopped") && (activeRunCount > 0 || actionableCommandCount > 0
      || leases.some(row => row.lease_owner !== null || row.lease_expires_at !== null))) health = `${health}_with_active_work`;
    else if (health === "missing_resident") health = "head_reached_resident_unobserved";
    else if (health === "unattended_queue") health = "queued_resident_unobserved";
    return { observedAt: clock.observed_at, health, databaseIdentityValid: true, configurationMatches, checkpoint,
      runtime: { operatingState: runtime.operating_state, stateGeneration: runtime.state_generation, rowVersion: runtime.row_version,
        configId: runtime.cached_config_version_id, configNumber: runtime.cached_config_version_number,
        configExpiresAt: runtime.config_expires_at, scheduleSeconds: runtime.schedule_seconds, nextDueAt: runtime.next_due_at,
        consecutiveFailures: runtime.consecutive_failures, latestFailureCode: remoteHealthSafeCode(runtime.latest_failure_code),
        lastAttemptedAt: runtime.last_attempted_at, lastHeadReachedAt: runtime.last_head_reached_at,
        lastRunnerHeartbeatAt: runtime.last_runner_heartbeat_at },
      run: run ? { id: run.id, parentRunId: run.recovery_of_run_id, state: run.state, reachedHead: run.reached_source_head,
        configId: run.config_version_id, configNumber: run.config_version_number, workerFence: run.worker_fence,
        rowVersion: run.row_version, pages: run.page_count, accepted: run.accepted_count, duplicates: run.duplicate_count,
        quarantined: run.quarantined_count, materialChanges: run.material_change_count,
        requestedAt: run.requested_at, startedAt: run.started_at, finishedAt: run.finished_at,
        heartbeatAt: run.heartbeat_at, lastProgressAt: run.last_progress_at, failureCode: remoteHealthSafeCode(run.failure_code),
        requestedCheckpoint, finalCheckpoint,
      } : null,
      leases: leases.map(row => ({ role: row.worker_role, ownerPresent: row.lease_owner !== null, fence: row.lease_fence,
        heartbeatAt: row.heartbeat_at, expiresAt: row.lease_expires_at, rowVersion: row.row_version })),
      activeRunCount, actionableCommandCount, totals: { runCount, ...sums }, quarantineCounts, headReconciliation,
      resident: { state: "not_observed" },
    };
  });
}
