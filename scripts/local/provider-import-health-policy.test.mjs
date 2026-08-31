import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { tsImport } from "tsx/esm/api";
const { providerImportHealth } = await tsImport("./provider-import-health-policy.mts", import.meta.url);
const { readProviderHealthResident, runProviderHealthReadWithDrain, providerHealthConfigurationMatches,
  providerHealthHeadReconciliation } =
  await tsImport("./inspect-provider-import-health.mts", import.meta.url);
const now = new Date("2026-08-31T03:00:00Z");
const healthy = { now, runtimeState: "idle", runState: "succeeded", reachedHead: true,
  lastProgressAt: new Date(now.getTime() - 3_600_000), nextDueAt: new Date(now.getTime() + 60_000),
  leaseOwnerPresent: false, leaseExpiresAt: null, leaseMatchesRun: true, lastHeartbeatAt: null,
  headReconciliation: { state: "absent" }, residentState: "waiting", configurationMatches: true, activeRunCount: 0 };

test("head completion still requires a resident and a valid polling schedule", () => {
  assert.equal(providerImportHealth(healthy), "caught_up_waiting");
  assert.equal(providerImportHealth({ ...healthy, residentState: null }), "missing_resident");
  assert.equal(providerImportHealth({ ...healthy, nextDueAt: null }), "missing_schedule");
  assert.equal(providerImportHealth({ ...healthy, nextDueAt: new Date(now.getTime() - 91_000) }), "overdue");
});
test("operator pause and stop remain intentional even with an old failed run", () => {
  for (const runtimeState of ["paused", "stopped"]) {
    assert.equal(providerImportHealth({ ...healthy, runtimeState, runState: "failed" }), runtimeState);
  }
});
test("a resident socket alone cannot disguise a permanent error or stalled work", () => {
  assert.equal(providerImportHealth({ ...healthy, residentState: "blocked" }), "blocked");
  assert.equal(providerImportHealth({ ...healthy, runtimeState: "error", runState: "failed" }), "failed");
  const running = { ...healthy, runtimeState: "running", runState: "running", reachedHead: false,
    residentState: "polling", leaseOwnerPresent: true, leaseExpiresAt: new Date(now.getTime() + 60_000), activeRunCount: 1 };
  assert.equal(providerImportHealth(running), "stalled");
  assert.equal(providerImportHealth({ ...running, lastProgressAt: now }), "importing");
  assert.equal(providerImportHealth({ ...running, lastProgressAt: now, leaseExpiresAt: now }), "unowned_run");
  assert.equal(providerImportHealth({ ...running, lastProgressAt: now, leaseMatchesRun: false }), "unowned_run");
});
test("queued work is unattended without a resident; missing reads are not healthy", () => {
  assert.equal(providerImportHealth({ ...healthy, runState: "queued", residentState: null, activeRunCount: 1 }), "unattended_queue");
  assert.equal(providerImportHealth({ ...healthy, residentState: "read_unavailable" }), "read_unavailable");
});
test("caught-up status requires coherent idle, waiting, released ownership and no hidden active run", () => {
  assert.equal(providerImportHealth({ ...healthy, configurationMatches: false }), "configuration_mismatch");
  for (const runtimeState of ["running", "unknown"]) {
    assert.equal(providerImportHealth({ ...healthy, runtimeState }), "inconsistent_runtime");
  }
  for (const activeRunCount of [1, 2]) assert.equal(providerImportHealth({ ...healthy, activeRunCount }), "inconsistent_runtime");
  for (const residentState of ["starting", "stopped", "operator_continuation", "polling"]) {
    assert.equal(providerImportHealth({ ...healthy, residentState }), "resident_not_waiting");
  }
  for (const lease of [{ leaseOwnerPresent: true }, { leaseExpiresAt: new Date(now.getTime() - 1000) },
    { leaseOwnerPresent: true, leaseExpiresAt: new Date(now.getTime() + 1000) }]) {
    assert.equal(providerImportHealth({ ...healthy, ...lease }), "lease_not_released");
  }
});
test("running state cannot hide multiple active runs, stale configuration or future progress timestamps", () => {
  const running = { ...healthy, runtimeState: "running", runState: "running", reachedHead: false,
    leaseOwnerPresent: true, leaseExpiresAt: new Date(now.getTime() + 60000), activeRunCount: 1, lastProgressAt: now };
  assert.equal(providerImportHealth(running), "importing");
  assert.equal(providerImportHealth({ ...running, activeRunCount: 2 }), "inconsistent_runtime");
  assert.equal(providerImportHealth({ ...running, configurationMatches: false }), "configuration_mismatch");
  assert.equal(providerImportHealth({ ...running, lastProgressAt: new Date(now.getTime() + 1000) }), "stalled");
});
test("durable head batches report reconciliation even when the last source page is old", () => {
  const reconciling = { ...healthy, runtimeState: "running", runState: "running", activeRunCount: 1,
    leaseOwnerPresent: true, leaseExpiresAt: new Date(now.getTime() + 60_000), residentState: "polling",
    lastHeartbeatAt: now, headReconciliation: { state: "recorded", occurredAt: now, batchNumber: 3001, phase: "facts" } };
  assert.equal(providerImportHealth(reconciling), "reconciling");
  assert.equal(providerImportHealth({ ...reconciling,
    headReconciliation: { ...reconciling.headReconciliation, phase: "quarantines" } }), "reconciling");
  assert.equal(providerImportHealth({ ...reconciling,
    headReconciliation: { ...reconciling.headReconciliation, phase: "complete" } }), "finalizing");
  for (const occurredAt of [new Date(now.getTime() - 180_001), new Date(now.getTime() + 1)]) {
    assert.equal(providerImportHealth({ ...reconciling, lastProgressAt: now,
      headReconciliation: { ...reconciling.headReconciliation, occurredAt } }), "stalled");
  }
  assert.equal(providerImportHealth({ ...reconciling, lastHeartbeatAt: new Date(now.getTime() - 180_001) }), "stalled");
  assert.equal(providerImportHealth({ ...reconciling, leaseMatchesRun: false }), "unowned_run");
  assert.equal(providerImportHealth({ ...reconciling, leaseExpiresAt: now }), "unowned_run");
  assert.equal(providerImportHealth({ ...reconciling, configurationMatches: false }), "configuration_mismatch");
  assert.equal(providerImportHealth({ ...reconciling, activeRunCount: 2 }), "inconsistent_runtime");
  assert.equal(providerImportHealth({ ...reconciling, runtimeState: "paused" }), "paused");
  assert.equal(providerImportHealth({ ...reconciling, headReconciliation: { state: "invalid" } }), "reconciliation_receipt_invalid");
  assert.equal(providerImportHealth({ ...reconciling, headReconciliation: { state: "absent" } }), "stalled");
  assert.equal(providerImportHealth({ ...reconciling, lastProgressAt: now, headReconciliation: { state: "absent" } }), "reconciliation_pending");
});
test("head receipt projection validates current config, checkpoint and run fence without exposing private scan positions", () => {
  const pins = { configVersionId: "11111111-1111-4111-8111-111111111111", checkpointHash: "a".repeat(64), workerFence: 44n };
  const receipt = { occurredAt: now, outcome: "success", targetType: "provider_run", schemaVersion: 1,
    configVersionId: pins.configVersionId, checkpointHash: pins.checkpointHash, leaseFence: "44", batchNumber: 3001, phase: "facts" };
  assert.deepEqual(providerHealthHeadReconciliation(receipt, pins), {
    state: "recorded", occurredAt: now, batchNumber: 3001, phase: "facts" });
  assert.deepEqual(providerHealthHeadReconciliation(undefined, pins), { state: "absent" });
  for (const changed of [{ outcome: "failed" }, { targetType: "quarantine" }, { schemaVersion: 2 },
    { configVersionId: "22222222-2222-4222-8222-222222222222" }, { checkpointHash: "b".repeat(64) },
    { leaseFence: "43" }, { batchNumber: 0 }, { batchNumber: Number.MAX_SAFE_INTEGER + 1 }, { phase: "unknown" },
    { occurredAt: new Date("invalid") }, { packAfterId: "synthetic-private-scan-position" }]) {
    const result = providerHealthHeadReconciliation({ ...receipt, ...changed }, pins);
    assert.deepEqual(result, { state: "invalid" }); assert.equal(JSON.stringify(result).includes("private"), false);
  }
});
test("configuration coherence includes content, revision, schedule, expiry, lifecycle and resolved route", () => {
  const configId = "11111111-1111-4111-8111-111111111111";
  const input = { now, lifecycle: "active", routeConfigId: configId,
    run: { config_version_id: configId, config_version_number: 4n },
    central: { id: configId, version_number: 4n, adapter_key: "synthetic-adapter", configuration: { platform: "phygitals" },
      expires_at: null, schedule_seconds: 3600 }, cached: { cached_config_version_id: configId, cached_config_version_number: 4n,
      cached_configuration: { adapterKey: "synthetic-adapter", settings: { platform: "phygitals" } },
      config_expires_at: null, schedule_seconds: 3600 } };
  assert.equal(providerHealthConfigurationMatches(input), true);
  for (const mutate of [v => { v.lifecycle = "disabled"; }, v => { v.central = null; }, v => { v.routeConfigId = "other"; },
    v => { v.run.config_version_id = "other"; }, v => { v.run.config_version_number = 3n; },
    v => { v.cached.cached_config_version_number = 3n; }, v => { v.cached.cached_config_version_id = "other"; },
    v => { v.cached.schedule_seconds = 60; }, v => { v.cached.cached_configuration.settings.platform = "courtyard"; },
    v => { v.cached.cached_configuration.adapterKey = "old"; }, v => { v.central.expires_at = now; v.cached.config_expires_at = now; },
    v => { v.cached.config_expires_at = new Date(now.getTime() + 1000); }]) {
    const value = structuredClone(input); mutate(value); assert.equal(providerHealthConfigurationMatches(value), false);
  }
});
class SyntheticSocket extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; this.emit("close"); return this; }
}
const providerId = "11111111-1111-4111-8111-111111111111";
test("resident read uses an absolute deadline even while the peer keeps trickling bytes", { timeout: 2000 }, async () => {
  const socket = new SyntheticSocket(); let bytes = 0;
  const interval = setInterval(() => { bytes++; socket.emit("data", Buffer.from(" ")); }, 2);
  try {
    const result = await readProviderHealthResident(1, providerId, "phygitals", { connect: () => socket, timeoutMilliseconds: 40 });
    assert.equal(result, null); assert.equal(socket.destroyed, true); assert.ok(bytes < 4096);
  } finally { clearInterval(interval); }
});
test("resident read strips extra fields and closes immediately on oversized or mismatched replies", async () => {
  const reply = { providerId, providerKey: "phygitals", pid: 123, state: "waiting", token: "synthetic-secret-never-output" };
  for (const body of [JSON.stringify(reply) + "\n", "x".repeat(4097),
    JSON.stringify({ ...reply, providerKey: "courtyard" }) + "\n"]) {
    const socket = new SyntheticSocket();
    const reading = readProviderHealthResident(1, providerId, "phygitals", { connect: () => socket });
    socket.emit("data", Buffer.from(body)); const result = await reading;
    assert.equal(socket.destroyed, true);
    if (body === JSON.stringify(reply) + "\n") {
      assert.equal(result.state, "waiting"); assert.equal("token" in result, false);
    } else assert.equal(result, null);
  }
});
test("gateway timeout does not let inspection close resources before its read-only callback settles", async () => {
  let release, started, finished = false, returned = false;
  const block = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const inspection = runProviderHealthReadWithDrain(async () => {
    started(); await block; finished = true; return { observed: true };
  }, async callback => {
    void callback({}); return { state: "unreachable" };
  }).finally(() => { returned = true; });
  await began; await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(returned, false); release(); assert.equal((await inspection).state, "unreachable"); assert.equal(finished, true);
});
