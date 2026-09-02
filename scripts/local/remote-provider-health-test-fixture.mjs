import assert from "node:assert/strict";
import { tsImport } from "tsx/esm/api";
const { providerDataforrestLiveIntegrationRegistry } = await tsImport(
  "../../apps/worker/src/provider-dataforrest-live-integration.ts", import.meta.url);
const { readBackfillEnvironment, readBackfillAuthority } = await tsImport("./provider-backfill-supervisor-authority.mts", import.meta.url);
const { remoteProviderRouteDigest, remoteHealthAuthorityPins } = await tsImport("./remote-provider-health-policy.mts", import.meta.url);
const { providerMixedPageDigest } = await tsImport("@packscout/database", import.meta.url);
const { AesGcmProviderCredentialCipher } = await tsImport("@packscout/services", import.meta.url);
const { DATAFORREST_EVENTS_V1_ENDPOINT } = await tsImport("@packscout/contracts", import.meta.url);

export const id = n => `75000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const now = new Date("2026-08-31T15:00:00Z");
export const secret = "synthetic-private-never-output";
export function environmentFixture() {
  return { NODE_ENV: "development", PACKSCOUT_DATABASE_MODE: "remote",
    PACKSCOUT_CENTRAL_DATABASE_URL: `postgresql://app:${secret}@central.example.test:5432/packscout?sslmode=require&sslaccept=strict`,
    PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: "central.example.test",
    PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: "provider.example.test",
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: Buffer.alloc(32, 7).toString("base64") };
}
export async function remoteHealthFixture() {
  const environment = await readBackfillEnvironment(environmentFixture(), {});
  const integration = providerDataforrestLiveIntegrationRegistry.resolveProvider("clutchpacks");
  const route = { organizationId: id(1), configVersionId: id(4), providerRowVersion: 2n, topologyVersion: 3n,
    target: { providerId: id(3), providerKey: "clutchpacks", databaseName: "packscout_clutchpacks",
      databaseRole: "provider", schemaVersion: "distributed-provider-v1" },
    node: { nodeId: id(5), host: "provider.example.test", port: 5432, sslMode: "verify-full", rowVersion: 4n,
      credentialVersionId: id(6), encryptedCredential: { ciphertext: Buffer.from(secret),
        nonce: Buffer.alloc(12, 1), authTag: Buffer.alloc(16, 2), keyVersion: 1 } } };
  const pin = { providerKey: "clutchpacks", providerId: id(3), configId: id(4), configNumber: "3",
    routeHost: "provider.example.test", routeDigest: remoteProviderRouteDigest(route) };
  const scope = { schemaVersion: 1, sourceCommit: "a".repeat(40), migrationEvidence: {
    path: "/synthetic/private/migration.json", sha256: "b".repeat(64) }, centralHost: "central.example.test",
    organizationId: id(1), operatorId: id(2), providers: [pin] };
  const authority = { route, configNumber: 3n, integration, cachedConfiguration: {
    adapterKey: integration.manifest.adapterVersion, settings: { platform: "clutchpacks" } },
    expiresAt: null, scheduleSeconds: 3600, digest: "c".repeat(64) };
  const cursor = { sourceInstanceId: pin.providerId, sourceRevisionId: pin.configId,
    sourceTypeKey: integration.manifest.sourceTypeKey, adapterVersion: integration.manifest.adapterVersion,
    cursorCodecKey: integration.manifest.cursorCodecKey, cursorGeneration: 1, value: secret };
  const runtime = { central_provider_id: pin.providerId, provider_key: pin.providerKey, operating_state: "paused",
    state_generation: 5n, row_version: 8n, cached_config_version_id: pin.configId, cached_config_version_number: 3n,
    cached_configuration: authority.cachedConfiguration, config_expires_at: null, schedule_seconds: 3600,
    next_due_at: now, source_cursor: cursor, source_cursor_hash: providerMixedPageDigest(cursor),
    consecutive_failures: 0, latest_failure_code: null, last_attempted_at: now,
    last_head_reached_at: now, last_runner_heartbeat_at: now, state_reason: secret };
  const run = { id: id(7), recovery_of_run_id: id(8), state: "succeeded", reached_source_head: true,
    page_count: 100, accepted_count: 10000, duplicate_count: 0, quarantined_count: 2, material_change_count: 7,
    last_progress_at: now, failure_code: null, config_version_id: pin.configId, config_version_number: 3n,
    worker_fence: 6n, row_version: 9n, heartbeat_at: now, requested_cursor: null, requested_cursor_hash: null,
    final_cursor: cursor, final_cursor_hash: runtime.source_cursor_hash, requested_at: now, started_at: now,
    finished_at: now, failure_summary: secret, idempotency_key: secret };
  const data = { runtime, run, identity: { database_role: "provider", schema_version: "distributed-provider-v1",
    provider_id: pin.providerId, provider_key: pin.providerKey }, clock: { observed_at: now, database_name: "packscout_clutchpacks" },
    leases: ["import", "promotion"].map(worker_role => ({ worker_role, lease_owner: null, lease_fence: 6n,
      heartbeat_at: now, lease_expires_at: null, row_version: 5n })), active: 0, commands: 0,
    totals: { _count: { _all: 3 }, _sum: { page_count: 333, accepted_count: 33300, duplicate_count: 0, quarantined_count: 2 } },
    quarantine: [{ state: "open", _count: { _all: 2 } }], receipt: undefined };
  const calls = [];
  const delegate = (table, methods) => new Proxy(methods, { get(target, key) {
    if (!(key in target)) throw new Error(`Forbidden database operation ${table}.${String(key)}`);
    return async args => { calls.push({ table, method: key, args }); return target[key](args); };
  } });
  const transaction = {
    $executeRawUnsafe: async sql => { assert.ok(["SET TRANSACTION READ ONLY", "SET LOCAL statement_timeout = '10000ms'"].includes(sql)); calls.push({ sql }); },
    $queryRaw: async (strings, ...parameters) => {
      const sql = strings.join("?"); assert.match(sql.trim(), /^SELECT/u); calls.push({ sql, parameters });
      return sql.includes("clock_timestamp") ? (data.clock ? [data.clock] : []) : (data.receipt ? [data.receipt] : []);
    },
    database_identity: delegate("database_identity", { findUnique: () => data.identity }),
    provider_runtime: delegate("provider_runtime", { findUnique: () => data.runtime }),
    provider_worker_states: delegate("provider_worker_states", { findMany: () => data.leases }),
    provider_runs: delegate("provider_runs", { findFirst: () => data.run, count: () => data.active, aggregate: () => data.totals }),
    control_commands: delegate("control_commands", { count: () => data.commands }),
    quarantine_records: delegate("quarantine_records", { groupBy: () => data.quarantine }),
  };
  const database = { $transaction: async (callback, options) => {
    assert.deepEqual(options, { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 25000 });
    calls.push({ transaction: "begin" }); const value = await callback(transaction); calls.push({ transaction: "end" }); return value;
  } };
  return { environment, authority, pin, scope, data, calls, database, cursor };
}

/** Exercises the actual shared admin/config/registry resolver against synthetic rows only. */
export function centralAuthorityFixture(f) {
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: 1, keys: new Map([[1, f.environment.key]]) });
  const encrypted = cipher.encrypt(secret, { organizationId: f.scope.organizationId, providerId: f.pin.providerId, revisionId: id(9) });
  const source = { id: id(9), provider_id: f.pin.providerId, credential_kind: "source", version_number: 1n,
    ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, auth_tag: encrypted.authTag, key_version: 1,
    lifecycle: "active", activated_at: null, retired_at: null, revoked_at: null };
  const config = { id: f.pin.configId, provider_id: f.pin.providerId, version_number: 3n,
    adapter_key: f.authority.integration.manifest.adapterVersion, endpoint_url: DATAFORREST_EVENTS_V1_ENDPOINT,
    source_credential_version_id: source.id, source_credential: source, configuration: { platform: "clutchpacks" },
    expires_at: null, schedule_seconds: 3600 };
  const provider = { id: f.pin.providerId, organization_id: f.scope.organizationId, provider_key: f.pin.providerKey,
    lifecycle: "active", active_config_version_id: config.id, active_config_version: config,
    row_version: 2n, topology_version: 3n, config_versions: [config], database_nodes: [{
      id: id(5), host: f.pin.routeHost, port: 5432, database_name: "packscout_clutchpacks", ssl_mode: "verify-full",
      row_version: 4n, credential_version_id: id(6), credential: { credential_kind: "database", lifecycle: "active",
        ciphertext: Buffer.from(secret), nonce: Buffer.alloc(12, 1), auth_tag: Buffer.alloc(16, 2), key_version: 1 } }] };
  const data = { provider, membership: { role: "admin" }, config };
  const central = { providers: { findUnique: async () => data.provider }, operator_memberships: {
    findFirst: async args => { assert.equal(args.where.role, "admin"); assert.equal(args.where.operator.state, "active");
      assert.equal(args.where.organization_id, f.scope.organizationId); assert.equal(args.where.operator_id, f.scope.operatorId); return data.membership; } },
    provider_config_versions: { findUnique: async () => data.config ? { ...data.config, provider: data.provider } : null } };
  return { data, read: () => readBackfillAuthority(central, cipher, remoteHealthAuthorityPins(f.scope, f.pin), f.environment.runtimePolicy) };
}
