import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);
const { DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION } = await tsImport("@packscout/contracts", import.meta.url);
const { providerDataforrestLiveIntegrationRegistry } = await tsImport("../../apps/worker/src/provider-dataforrest-live-integration.ts", import.meta.url);
export const pins = { organizationId: "2a333333-3333-4333-8333-333333333331", providerId: "2a333333-3333-4333-8333-333333333332",
  providerKey: "clutchpacks", configId: "2a333333-3333-4333-8333-333333333333", initialRunId: "2a333333-3333-4333-8333-333333333334",
  operationId: "2a333333-3333-4333-8333-333333333335", operatorId: "2a333333-3333-4333-8333-333333333336" };
export function residentFixture() {
  const now = new Date("2026-08-30T06:05:00Z");
  const integration = providerDataforrestLiveIntegrationRegistry.resolve(
    "clutchpacks",
    DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  );
  const authority = { configNumber: 4n, integration, cachedConfiguration: { adapterKey: integration.manifest.adapterVersion,
    settings: { platform: "clutchpacks" } }, expiresAt: null, scheduleSeconds: 300, digest: "d".repeat(64) };
  const cursor = { sourceInstanceId: pins.providerId, sourceRevisionId: pins.configId, sourceTypeKey: integration.manifest.sourceTypeKey,
    adapterVersion: integration.manifest.adapterVersion, cursorCodecKey: integration.manifest.cursorCodecKey,
    cursorGeneration: 1, value: "synthetic-private-continuation" };
  const hash = providerMixedCursorFingerprint(cursor);
  const runtime = { central_provider_id: pins.providerId, provider_key: pins.providerKey, operating_state: "idle",
    state_generation: 11n, cached_config_version_id: pins.configId, cached_config_version_number: 4n,
    cached_configuration: authority.cachedConfiguration, config_expires_at: null, schedule_seconds: 300,
    source_cursor: cursor, source_cursor_hash: hash };
  const parent = { id: pins.initialRunId, trigger: "manual", state: "succeeded", config_version_id: pins.configId,
    config_version_number: 4n, worker_fence: 459n, requested_cursor: cursor, requested_cursor_hash: hash,
    final_cursor: cursor, final_cursor_hash: hash, reached_source_head: true, page_count: 1, accepted_count: 0,
    failure_code: null, finished_at: new Date("2026-08-30T06:00:00Z"), requested_at: new Date("2026-08-30T05:59:00Z"), recovery_of_run_id: null };
  const last = { id: "2a333333-3333-4333-8333-333333333339", page_number: 1, continuation: "head", next_cursor: cursor, next_cursor_hash: hash };
  const runs = new Map([[parent.id, parent]]); const commands = []; const audits = []; const writes = [];
  const lease = { worker_role: "import", lease_owner: null, lease_fence: 459n,
    heartbeat_at: null, lease_expires_at: null, row_version: 1n, database_now: now };
  const filterAudit = where => audits.filter(row => (!where.action || row.action === where.action) &&
    (!where.correlation_id || row.correlation_id === where.correlation_id) &&
    (!where.target_id || row.target_id === where.target_id) &&
    (!where.details || row.details[where.details.path[0]] === where.details.equals)).reverse();
  const database = {
    $transaction: async (fn, options) => { assert.equal(options.isolationLevel, "Serializable"); return fn(database); },
    $queryRaw: async sql => {
      const text = (Array.isArray(sql) ? sql : sql.strings).join(" ");
      if (text.includes("from provider_worker_states")) return [lease];
      if (text.includes("from provider_runtime")) return [runtime];
      if (text.includes("from provider_runs")) return [...runs.values()];
      if (text.includes("clock_timestamp")) return [{ now }];
      throw new Error("Unexpected resident fixture query");
    },
    database_identity: { findUniqueOrThrow: async () => ({ database_role: "provider", provider_id: pins.providerId, provider_key: pins.providerKey }) },
    provider_runtime: { findUniqueOrThrow: async () => runtime, findUnique: async () => runtime },
    provider_worker_states: { findUniqueOrThrow: async () => lease, updateMany: async ({ where, data }) => {
      assert.equal(where.row_version, lease.row_version); writes.push("lease");
      const next = { ...data }; delete next.row_version; Object.assign(lease, next); lease.row_version++; return { count: 1 };
    } },
    provider_runs: {
      findUnique: async ({ where }) => runs.get(where.id) ?? null,
      findFirst: async () => [...runs.values()].sort((a, b) => b.requested_at - a.requested_at)[0],
      findMany: async ({ where }) => [...runs.values()].filter(row => where.recovery_of_run_id
        ? row.recovery_of_run_id === where.recovery_of_run_id : ["queued", "running"].includes(row.state)),
      count: async ({ where }) => [...runs.values()].filter(row => where.state.in.includes(row.state)).length,
    },
    provider_run_pages: { findFirst: async ({ where }) => where.provider_run_id === parent.id ? last : null },
    control_commands: { findMany: async () => commands, findUnique: async () => null,
      count: async ({ where }) => commands.filter(row => where.state.in.includes(row.state)).length },
    local_audit_events: {
      findMany: async ({ where, take }) => filterAudit(where).slice(0, take),
      findFirst: async ({ where }) => filterAudit(where)[0] ?? null,
      create: async ({ data }) => { writes.push("audit"); const row = { ...structuredClone(data), sequence: BigInt(audits.length + 1) }; audits.push(row); return row; },
    },
  };
  return { now, authority, cursor, hash, runtime, parent, last, runs, commands, audits, writes, lease, database };
}
