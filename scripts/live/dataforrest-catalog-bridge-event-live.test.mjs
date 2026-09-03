import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const eventLive = await tsImport("./dataforrest-catalog-bridge-event-live.mts", import.meta.url);

const operationId = "52000000-0000-4000-8000-000000000001";

function fixture(overrides = {}) {
  const definition = plan.catalogBridgeProvider("collector_crypt");
  const state = { operationId, providerKey: definition.providerKey,
    catalogConfigId: "52000000-0000-4000-8000-000000000002",
    eventSuccessorConfigId: "52000000-0000-4000-8000-000000000003" };
  const policy = { utility: {
    workerId: `catalog-bridge/${operationId}/${definition.providerKey}/catalog-utility`,
  }, successorLaunchAgent: { fileSha256: "a".repeat(64),
    startupMaximumObservations: 2, startupPollMilliseconds: 100 } };
  const offline = { launchdLabel: definition.launchdLabel, launchdLoaded: false,
    processCount: 0, pids: [], processIdentitySha256: null,
    residencyPort: definition.residencyPort, residencyPortListening: false };
  const online = { ...offline, launchdLoaded: true, processCount: 1, pids: [93_001],
    processIdentitySha256: "b".repeat(64), residencyPortListening: true };
  const boundary = { observedAt: "2026-09-01T07:00:00.000Z", residentOffline: true,
    runtimeState: "paused", activeRunCount: 0, actionableCommandCount: 0,
    importLeaseOwner: null, importLeaseHeartbeatAt: null, importLeaseExpiresAt: null,
    otherActiveTransactionCount: 0, activeConfigId: state.eventSuccessorConfigId,
    cachedConfigId: state.eventSuccessorConfigId };
  const resumed = { observedAt: "2026-09-01T07:01:00.000Z",
    launchdLabel: definition.launchdLabel, processCount: 1, residencyPortListening: true,
    activeConfigId: state.eventSuccessorConfigId, cachedConfigId: state.eventSuccessorConfigId,
    startupRunId: "52000000-0000-4000-8000-000000000004", startupRunState: "succeeded",
    startupRunRequestedCursorHash: "c".repeat(64), startupRunReachedHead: true,
    activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null };
  const calls = [];
  const processObservations = [...(overrides.processObservations ?? [offline])];
  const boundaries = [...(overrides.boundaries ?? [boundary])];
  const resumeObservations = [...(overrides.resumeObservations ?? [resumed])];
  const proof = { observedAt: "2026-09-01T07:00:30.000Z",
    activeConfigId: state.eventSuccessorConfigId, runtimeGeneration: "41",
    runtimeRowVersion: "52", pauseCommandId: "52000000-0000-4000-8000-000000000005",
    pauseCommandDigest: "d".repeat(64),
    latestTerminalRunId: "52000000-0000-4000-8000-000000000006",
    latestTerminalRunDigest: "e".repeat(64) };
  const database = {
    async readEventDatabaseBoundary() { calls.push("db:boundary");
      return boundaries.shift() ?? overrides.fallbackBoundary ?? boundary; },
    async admitEventResumeRun() { calls.push("db:admit");
      if (overrides.admitError) throw overrides.admitError; },
    async readResumeObservation() { calls.push("db:resumed");
      return resumeObservations.shift() ?? overrides.fallbackResume ?? null; },
    async pauseResidentForRecovery() { calls.push("db:pause");
      if (overrides.pauseError) throw overrides.pauseError; return proof; },
    async proveResidentRecoveryPaused() { calls.push("db:prove");
      if (overrides.proveError) throw overrides.proveError; },
    async ensureResidentOfflineAndPaused() { calls.push("db:ensure"); },
  };
  const bootstrap = {
    async check() { calls.push("plist:check"); },
    async bootstrap() { calls.push("launchctl:bootstrap");
      if (overrides.bootstrapError) throw overrides.bootstrapError;
      return overrides.bootstrapProcess ?? online; },
  };
  const dependencies = { database, bootstrap,
    async observeProcess() { calls.push("process:observe");
      return processObservations.shift() ?? overrides.fallbackProcess ?? offline; },
    async bootoutExact(input) { calls.push("bootout:enter");
      const authorized = await input.authorize();
      calls.push(`bootout:authorized:${authorized.pids[0] ?? "offline"}`);
      if (overrides.bootoutError) throw overrides.bootoutError;
      calls.push("launchctl:bootout"); },
    async wait() { calls.push("wait"); },
  };
  return { definition, state, policy, offline, online, boundary, resumed, proof, calls,
    orchestrator: eventLive.createCatalogBridgeEventLiveOrchestrator({ policy, state, dependencies }) };
}

test("event live boundary validates the exact plist before the read-only database observation", async () => {
  const value = fixture();
  const observed = await value.orchestrator.readEventBoundary();
  assert.equal(observed.stagedLaunchAgentSha256, value.policy.successorLaunchAgent.fileSha256);
  assert.deepEqual(value.calls, ["plist:check", "db:boundary"]);
});

test("event live admits the deterministic run while offline before bootstrap", async () => {
  const value = fixture({ processObservations: [] });
  const result = await value.orchestrator.resumeResident({ cursorRestoreReceiptDigest: "f".repeat(64),
    expectedProviderRowVersion: "22", expectedRuntimeRowVersion: "45",
    restoredCursorHash: "c".repeat(64) });
  assert.equal(result.startupRunState, "succeeded");
  assert.deepEqual(value.calls, ["process:observe", "db:boundary", "db:admit",
    "launchctl:bootstrap", "process:observe", "db:resumed"]);
  assert.ok(value.calls.indexOf("db:admit") < value.calls.indexOf("launchctl:bootstrap"));
});

test("offline crash prefixes reach admission reconciliation before bootstrap", async () => {
  const base = fixture();
  const workerId = `catalog-bridge/${operationId}/collector_crypt/catalog-utility`;
  for (const work of [
    { runtimeState: "paused", activeRunCount: 0, actionableCommandCount: 0 },
    { runtimeState: "idle", activeRunCount: 0, actionableCommandCount: 0 },
    { runtimeState: "idle", activeRunCount: 1, actionableCommandCount: 1 },
  ]) {
    const boundary = { ...base.boundary, ...work,
      importLeaseOwner: workerId,
      importLeaseHeartbeatAt: "2026-09-01T07:00:10.000Z",
      importLeaseExpiresAt: "2026-09-01T07:01:10.000Z" };
    const value = fixture({ boundaries: [boundary], processObservations: [] });
    await value.orchestrator.resumeResident({ cursorRestoreReceiptDigest: "f".repeat(64),
      expectedProviderRowVersion: "22", expectedRuntimeRowVersion: "45",
      restoredCursorHash: "c".repeat(64) });
    assert.ok(value.calls.indexOf("db:admit") < value.calls.indexOf("launchctl:bootstrap"));
    assert.equal(value.calls.includes("db:ensure"), false);
  }
});

test("event live resume refuses work, lease and process mismatch before admission", async () => {
  for (const changed of [
    { activeRunCount: 1 }, { actionableCommandCount: 1 },
    { importLeaseHeartbeatAt: "2026-09-01T07:00:00.000Z" }, { otherActiveTransactionCount: 1 },
    { importLeaseOwner: "foreign-worker",
      importLeaseHeartbeatAt: "2026-09-01T07:00:00.000Z",
      importLeaseExpiresAt: "2026-09-01T07:01:00.000Z" },
  ]) {
    const base = fixture();
    const value = fixture({ boundaries: [{ ...base.boundary, ...changed }] });
    await assert.rejects(value.orchestrator.resumeResident({ cursorRestoreReceiptDigest: "f".repeat(64),
      expectedProviderRowVersion: "22", expectedRuntimeRowVersion: "45",
      restoredCursorHash: "c".repeat(64) }),
    { code: "CATALOG_BRIDGE_EVENT_BOOTSTRAP_BOUNDARY_CHANGED" });
    assert.equal(value.calls.includes("launchctl:bootstrap"), false);
    assert.equal(value.calls.includes("db:admit"), false);
  }
  const base = fixture();
  const wrongPort = { ...base.online, residencyPort: 56_432 };
  const value = fixture({ bootstrapProcess: wrongPort });
  await assert.rejects(value.orchestrator.resumeResident({ cursorRestoreReceiptDigest: "f".repeat(64),
    expectedProviderRowVersion: "22", expectedRuntimeRowVersion: "45",
    restoredCursorHash: "c".repeat(64) }),
  { code: "CATALOG_BRIDGE_EVENT_RECOVERY_PROCESS_NOT_EXACT" });
  assert.equal(value.calls.includes("db:admit"), true);
});

test("event live reconciles an exact already-online admission without bootstrapping twice", async () => {
  const base = fixture();
  const running = { ...base.boundary, residentOffline: false, runtimeState: "running",
    activeRunCount: 1, importLeaseOwner: "resident-worker",
    importLeaseHeartbeatAt: "2026-09-01T07:00:10.000Z",
    importLeaseExpiresAt: "2026-09-01T07:01:10.000Z" };
  const value = fixture({ processObservations: [base.online, base.online], boundaries: [running] });
  const result = await value.orchestrator.resumeResident({ cursorRestoreReceiptDigest: "f".repeat(64),
    expectedProviderRowVersion: "22", expectedRuntimeRowVersion: "45",
    restoredCursorHash: "c".repeat(64) });
  assert.equal(result.startupRunState, "succeeded");
  assert.deepEqual(value.calls, ["process:observe", "db:boundary", "db:admit",
    "process:observe", "db:resumed"]);
  assert.equal(value.calls.includes("launchctl:bootstrap"), false);
});

test("offline settled recovery is idempotent and executes no process command", async () => {
  const value = fixture();
  await value.orchestrator.ensureResidentOfflineAndPaused();
  assert.deepEqual(value.calls, ["process:observe", "db:boundary", "db:ensure"]);
});

test("offline queued-run recovery restarts only the exact successor and fails closed on queue race", async () => {
  const base = fixture();
  const queued = { ...base.boundary, runtimeState: "idle", activeRunCount: 1 };
  const queueRace = new plan.CatalogBridgeError("CATALOG_BRIDGE_EVENT_RECOVERY_QUEUED_RACE");
  const value = fixture({ boundaries: [queued], processObservations: [base.offline],
    fallbackProcess: base.online, pauseError: queueRace });
  await assert.rejects(value.orchestrator.ensureResidentOfflineAndPaused(),
    { code: "CATALOG_BRIDGE_EVENT_RECOVERY_QUEUED_RACE" });
  assert.deepEqual(value.calls, ["process:observe", "db:boundary", "launchctl:bootstrap", "db:pause"]);
  assert.equal(value.calls.includes("launchctl:bootout"), false);
});

test("online recovery proves the paused receipt before and during bootout then proves absence", async () => {
  const base = fixture();
  const value = fixture({ processObservations: [base.online, base.online, base.online] });
  await value.orchestrator.ensureResidentOfflineAndPaused();
  assert.deepEqual(value.calls, ["process:observe", "db:pause", "process:observe", "db:prove",
    "bootout:enter", "db:prove", "process:observe", "bootout:authorized:93001",
    "launchctl:bootout", "db:prove", "db:ensure"]);
  assert.ok(value.calls.indexOf("db:prove") < value.calls.indexOf("launchctl:bootout"));
});

test("online process drift and bootout refusal leave recovery unaccepted", async () => {
  const base = fixture();
  const wrong = { ...base.online, processIdentitySha256: null };
  const mismatch = fixture({ processObservations: [base.online, wrong] });
  await assert.rejects(mismatch.orchestrator.ensureResidentOfflineAndPaused(),
    { code: "CATALOG_BRIDGE_EVENT_RECOVERY_PROCESS_NOT_EXACT" });
  assert.equal(mismatch.calls.includes("bootout:enter"), false);

  const refused = fixture({ processObservations: [base.online, base.online, base.online],
    bootoutError: new plan.CatalogBridgeError("CATALOG_BRIDGE_DRAIN_BOOTOUT_REFUSED") });
  await assert.rejects(refused.orchestrator.ensureResidentOfflineAndPaused(),
    { code: "CATALOG_BRIDGE_DRAIN_BOOTOUT_REFUSED" });
  assert.equal(refused.calls.includes("launchctl:bootout"), false);
  assert.equal(refused.calls.includes("db:ensure"), false);
});
