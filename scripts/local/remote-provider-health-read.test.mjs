import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { remoteHealthFixture, now, id, secret } from "./remote-provider-health-test-fixture.mjs";
const { readRemoteProviderHealth } = await tsImport("./remote-provider-health-read.mts", import.meta.url);
const { inspectRemoteHealthProviders } = await tsImport("./inspect-remote-provider-import-health.mts", import.meta.url);
const { runRemoteHealthTransaction } = await tsImport("./remote-provider-health-transaction.mts", import.meta.url);
const { providerMixedPageDigest } = await tsImport("@packscout/database", import.meta.url);
const inspect = f => inspectRemoteHealthProviders(f.scope, f.environment, { readAuthority: async () => f.authority,
  run: async (_route, callback) => ({ state: "reachable", value: await callback(f.database) }) });
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);

test("remote observation is read-only, bounded and redacted while retaining counters and safe checkpoints", async () => {
  const f = await remoteHealthFixture(); const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("No source call is permitted"); };
  try {
    f.data.leases[1].lease_owner = secret; f.data.runtime.latest_failure_code = secret; f.data.run.failure_code = secret;
    const result = await inspect(f), observed = result.observations[0];
    assert.equal(observed.health, "paused_with_active_work"); assert.equal(observed.runtime.stateGeneration, 5n);
    assert.equal(observed.run.accepted, 10000); assert.equal(observed.totals.accepted_count, 33300);
    assert.equal(observed.leases[1].ownerPresent, true); assert.equal(observed.checkpoint.hashValid, true);
    assert.equal(observed.checkpoint.envelopeValid, true); assert.equal(observed.route.host, f.pin.routeHost);
    assert.equal(result.databaseWritesPerformed, false); assert.equal(result.sourceRequestsPerformed, false);
    assert.equal(serialize(result).includes(secret), false);
    for (const forbidden of ["source_cursor", "cached_configuration", "failure_summary", "lease_owner", "encryptedCredential", "bearerToken"])
      assert.equal(serialize(result).includes(forbidden), false);
    assert.deepEqual(f.calls.slice(0, 3), [{ transaction: "begin" }, { sql: "SET TRANSACTION READ ONLY" },
      { sql: "SET LOCAL statement_timeout = '10000ms'" }]);
    assert.deepEqual(f.calls.at(-1), { transaction: "end" });
    assert.equal(f.calls.some(call => ["categories", "packs", "pulls", "provider_accounts"].includes(call.table)), false);
    const receiptQuery = f.calls.find(call => call.sql?.includes("local_audit_events"));
    assert.match(receiptQuery.sql, /LIMIT 1/u); assert.doesNotMatch(receiptQuery.sql, /SELECT\s+\*/u);
  } finally { globalThis.fetch = previousFetch; }
});
test("wrong database or runtime identity, missing leases and unreadable counts are unavailable without invented zeros", async () => {
  for (const change of [d => { d.identity = null; }, d => { d.identity.provider_id = id(50); },
    d => { d.identity.provider_key = "courtyard"; }, d => { d.identity.database_role = "central"; },
    d => { d.identity.schema_version = "unknown"; }, d => { d.clock.database_name = "packscout_courtyard"; },
    d => { d.runtime = null; }, d => { d.runtime.central_provider_id = id(50); },
    d => { d.leases = []; }, d => { d.active = undefined; }, d => { d.commands = undefined; }, d => { d.clock = null; }]) {
    const f = await remoteHealthFixture(); change(f.data); const result = (await inspect(f)).observations[0];
    assert.equal(result.health, "unavailable"); assert.equal("totals" in result, false);
    assert.equal("activeRunCount" in result, false); assert.equal(serialize(result).includes(secret), false);
  }
});
test("missing provider authority and authority drift do not produce an adopted healthy snapshot", async () => {
  const f = await remoteHealthFixture(); let reads = 0, connections = 0;
  const missing = await inspectRemoteHealthProviders(f.scope, f.environment, {
    readAuthority: async () => { throw new Error(secret); }, run: async () => { connections++; },
  });
  assert.equal(missing.observations[0].health, "unavailable"); assert.equal(connections, 0);
  const drift = await inspectRemoteHealthProviders(f.scope, f.environment, {
    readAuthority: async () => ({ ...f.authority, digest: ++reads === 1 ? f.authority.digest : "d".repeat(64) }),
    run: async (_route, callback) => ({ state: "reachable", value: await callback(f.database) }),
  });
  assert.equal(drift.observations[0].code, "REMOTE_HEALTH_AUTHORITY_CHANGED");
  assert.equal("totals" in drift.observations[0], false);
});
test("null run history stays unavailable with null sums, and unobserved residents are never assumed present or absent", async () => {
  const f = await remoteHealthFixture(); f.data.run = null;
  f.data.totals = { _count: { _all: 0 }, _sum: { page_count: null, accepted_count: null, duplicate_count: null, quarantined_count: null } };
  const result = await readRemoteProviderHealth(f.database, f.pin, f.authority);
  assert.equal(result.health, "unavailable"); assert.equal(result.run, null); assert.equal(result.totals.accepted_count, null);
  const head = await remoteHealthFixture(); head.data.runtime.operating_state = "idle";
  assert.equal((await readRemoteProviderHealth(head.database, head.pin, head.authority)).health, "head_reached_resident_unobserved");
});
test("checkpoint hashes validate the complete envelope, configuration and source identity without exposing opaque values", async () => {
  for (const change of [d => { d.runtime.source_cursor_hash = "e".repeat(64); },
    d => { d.runtime.source_cursor.sourceRevisionId = id(50); d.runtime.source_cursor_hash = providerMixedPageDigest(d.runtime.source_cursor); },
    d => { d.runtime.source_cursor.value = null; d.runtime.source_cursor_hash = providerMixedPageDigest(d.runtime.source_cursor); }]) {
    const f = await remoteHealthFixture(); change(f.data);
    assert.equal((await readRemoteProviderHealth(f.database, f.pin, f.authority)).health, "checkpoint_invalid");
  }
  const f = await remoteHealthFixture(); f.data.runtime.cached_config_version_number = 2n;
  assert.equal((await readRemoteProviderHealth(f.database, f.pin, f.authority)).health, "configuration_mismatch");
  f.data.runtime.cached_config_version_number = 3n; f.data.runtime.cached_configuration = { ...f.authority.cachedConfiguration, settings: { platform: "courtyard" } };
  assert.equal((await readRemoteProviderHealth(f.database, f.pin, f.authority)).health, "configuration_mismatch");
});
test("active head reconciliation requires a recent valid receipt and exact live import fence", async () => {
  const f = await remoteHealthFixture(); f.data.runtime.operating_state = "running"; f.data.run.state = "running";
  f.data.active = 1; f.data.leases[0].lease_owner = secret; f.data.leases[0].lease_expires_at = new Date(now.getTime() + 60000);
  f.data.receipt = { occurredAt: now, outcome: "success", targetType: "provider_run", schemaVersion: 1,
    configVersionId: f.pin.configId, checkpointHash: f.data.runtime.source_cursor_hash, leaseFence: "6", batchNumber: 3001, phase: "facts" };
  assert.equal((await readRemoteProviderHealth(f.database, f.pin, f.authority)).health, "reconciling");
  f.data.receipt.occurredAt = new Date(now.getTime() - 180001);
  assert.equal((await readRemoteProviderHealth(f.database, f.pin, f.authority)).health, "stalled");
  f.data.receipt.occurredAt = now; f.data.receipt.leaseFence = "5";
  assert.equal((await readRemoteProviderHealth(f.database, f.pin, f.authority)).health, "reconciliation_receipt_invalid");
});
test("transaction rejection and gateway timeout both drain callbacks before returning", async () => {
  let begin, release, returned = false;
  const started = new Promise(resolve => { begin = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const reading = runRemoteHealthTransaction(async callback => {
    void callback({}); await started; throw new Error("synthetic transaction deadline");
  }, async () => { begin(); await barrier; return "read finished"; }).finally(() => { returned = true; });
  await started; await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false);
  release(); await assert.rejects(reading, /synthetic transaction deadline/);
  const f = await remoteHealthFixture(); let finishTransaction, transactionStarted, authorityReads = 0;
  const transactionBarrier = new Promise(resolve => { finishTransaction = resolve; });
  const began = new Promise(resolve => { transactionStarted = resolve; });
  f.database.$transaction = async () => { transactionStarted(); await transactionBarrier; throw new Error(secret); };
  returned = false;
  const inspecting = inspectRemoteHealthProviders(f.scope, f.environment, {
    readAuthority: async () => { authorityReads++; return f.authority; },
    run: async (_route, callback) => { void callback(f.database); await began; return { state: "unreachable" }; },
  }).finally(() => { returned = true; });
  await began; await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false); assert.equal(authorityReads, 1);
  finishTransaction(); const result = await inspecting; assert.equal(result.observations[0].health, "unavailable");
  assert.equal(serialize(result).includes(secret), false);
});
