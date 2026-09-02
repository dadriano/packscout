import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const stateModule = await tsImport("./dataforrest-catalog-bridge-state.mts", import.meta.url);
const catalog = await tsImport("./dataforrest-catalog-bridge-catalog.mts", import.meta.url);
const eventResume = await tsImport("./dataforrest-catalog-bridge-event-resume.mts", import.meta.url);
const policyModule = await tsImport("./dataforrest-catalog-bridge-catalog-live-policy.mts", import.meta.url);
const liveDatabase = await tsImport("./dataforrest-catalog-bridge-catalog-live-database.mts", import.meta.url);
const liveRunner = await tsImport("./run-dataforrest-catalog-bridge-catalog.mts", import.meta.url);
const residentHandoff = await tsImport("../local/provider-resident-handoff.mts", import.meta.url);
const residentSupervisor = await tsImport("../local/run-provider-backfill-supervisor.mts", import.meta.url);
const { pins: residentPins, residentFixture } =
  await import("../local/provider-resident-test-fixture.mjs");
const { providerMixedCursorFingerprint, providerResumeEvidenceDigest } =
  await tsImport("@packscout/database", import.meta.url);
const { providerCatalogIdentityChainDigest } = await tsImport("@packscout/services", import.meta.url);

const operationId = "30000000-0000-4000-8000-000000000001";
const operatorId = "30000000-0000-4000-8000-000000000002";
const hash = (letter) => letter.repeat(64);

function fixture() {
  const definition = plan.catalogBridgeProvider("collector_crypt");
  const cursor = { sourceInstanceId: definition.providerId,
    sourceRevisionId: definition.currentConfigId,
    sourceTypeKey: definition.currentEventManifest.sourceTypeKey,
    adapterVersion: definition.currentEventManifest.adapterVersion,
    cursorCodecKey: definition.currentEventManifest.cursorCodecKey,
    cursorGeneration: 1, value: "private-catalog-live-test-cursor" };
  const cursorHash = providerMixedCursorFingerprint(cursor);
  const pins = { operationId, providerKey: definition.providerKey, operatorId,
    residentCheckout: "/private/approved/catalog-resident",
    residentCommit: "a".repeat(40), utilityModuleSha256: hash("b"),
    sourceHeadCountProvenance: "manually_reviewed_exact_source_head_counts_v1",
    sourceHeadCounts: { ...definition.documentedCatalogFloor } };
  const pause = { commandId: "30000000-0000-4000-8000-000000000003", commandDigest: hash("0"),
    commandType: "pause", commandState: "completed",
    idempotencyKey: `catalog-bridge/${operationId}/running/pause`, targetRunId: null,
    targetQuarantineId: null, resultingRunId: null, requestedByOperatorId: operatorId,
    expectedGeneration: "29", resultOutcome: "accepted", resultCode: "RUNTIME_TRANSITION_APPLIED",
    resultGeneration: "30", correlationId: operationId,
    reason: "DataForrest collector_crypt catalog bridge checkpoint drain",
    requestedAt: "2026-09-01T03:55:00.000Z", completedAt: "2026-09-01T03:55:05.000Z" };
  pause.commandDigest = plan.catalogBridgePauseCommandDigest(pause);
  const terminal = { runId: "30000000-0000-4000-8000-000000000004", runDigest: hash("9"),
    terminalKind: "interrupted_checkpoint", headProofDigest: null, state: "failed",
    failureCode: "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING", reachedSourceHead: false,
    finishedAt: "2026-09-01T03:55:06.000Z", pageCount: 3, finalCursorHash: cursorHash,
    lastPageNumber: 3, lastPageCursorHash: cursorHash, lastPageContinuation: "more",
    lastPageDigest: hash("8") };
  const baseline = { cards: 10, packs: 0, pulls: 4_000_000, marketEvents: 500,
    pullsDigest: hash("c"), marketEventsDigest: hash("d") };
  const observation = { observedAt: "2026-09-01T04:00:00.000Z",
    repository: { checkout: pins.residentCheckout, expectedCommit: pins.residentCommit,
      observedCommit: pins.residentCommit, clean: true, utilityModuleSha256: pins.utilityModuleSha256 },
    worker: { launchdLabel: definition.launchdLabel, gracefullyUnloaded: true,
      processCount: 0, residencyPortListening: false, gracefulStopReceiptSha256: hash("7") },
    central: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, providerRowVersion: "20",
      activeConfigId: definition.currentConfigId, activeConfigNumber: definition.currentConfigNumber,
      maximumConfigNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      configuration: { platform: definition.providerKey },
      configurationDigest: plan.catalogBridgeDigest({ platform: definition.providerKey }),
      authorityDigest: hash("1"), sourceCredentialDigest: hash("2"), databaseRouteDigest: hash("3") },
    runtime: { providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort,
      databaseRole: "provider", schemaVersion: "distributed-provider-v1", runtimeState: "paused",
      generation: "30", rowVersion: "40", cachedConfigId: definition.currentConfigId,
      cachedConfigNumber: definition.currentConfigNumber,
      cachedConfiguration: { adapterKey: definition.currentEventManifest.adapterVersion,
        settings: { platform: definition.providerKey } },
      sourceCursor: cursor, sourceCursorHash: cursorHash, activeRunCount: 0,
      actionableCommandCount: 0, importLeaseOwner: null, otherOwnedLeaseCount: 0,
      otherActiveTransactionCount: 0, pauseProvenance: pause, latestTerminalRun: terminal },
    sourceCanaries: {
      catalogOrigin: { adapterVersion: definition.catalogAdapterVersion, requestedCursorHash: null,
        status: 200, recordCount: 2, cardCount: 1, packCount: 1, pullCount: 0, tradeCount: 0,
        responseSha256: hash("4"), nextCursorHash: hash("5"), checkedAt: "2026-09-01T03:59:30.000Z",
        responseBytes: 1000, durationMilliseconds: 10 },
      savedEventCursor: { adapterVersion: definition.eventSuccessorManifest.adapterVersion,
        requestedCursorHash: cursorHash, opaqueValueHash: plan.catalogBridgeDigest(cursor.value),
        status: 200, recordCount: 1, responseSha256: hash("6"),
        checkedAt: "2026-09-01T03:59:45.000Z", responseBytes: 1000, durationMilliseconds: 10 },
    }, baseline };
  observation.worker.gracefulStopReceipt = {
    schemaVersion: "dataforrest_catalog_bridge_drain_receipt_v1", operationId,
    providerKey: definition.providerKey, providerId: definition.providerId, operatorId,
    entryKind: "running", currentConfigId: definition.currentConfigId,
    drainedAt: "2026-09-01T03:56:00.000Z", intentDigests: [hash("a")],
    pause: { commandId: pause.commandId, commandDigest: pause.commandDigest,
      expectedGeneration: pause.expectedGeneration, resultGeneration: pause.resultGeneration,
      reason: pause.reason, correlationId: pause.correlationId,
      requestedAt: pause.requestedAt, completedAt: pause.completedAt },
    terminal: { kind: terminal.terminalKind, runId: terminal.runId, runFence: "17",
      state: terminal.state, failureCode: terminal.failureCode,
      reachedSourceHead: terminal.reachedSourceHead, finishedAt: terminal.finishedAt,
      pageCount: terminal.pageCount, finalCursorHash: terminal.finalCursorHash,
      lastPageNumber: terminal.lastPageNumber, lastPageCursorHash: terminal.lastPageCursorHash,
      lastPageContinuation: terminal.lastPageContinuation, runDigest: terminal.runDigest,
      lastPageDigest: terminal.lastPageDigest, headProofDigest: terminal.headProofDigest },
    worker: { launchdLabel: definition.launchdLabel, initialPid: 90345,
      initialProcessIdentitySha256: hash("e"), bootoutReceiptDigest: hash("f"),
      offlineProcessEvidenceDigest: hash("0") }, drainedEvidenceDigest: hash("a"),
  };
  observation.worker.gracefulStopReceiptSha256 =
    plan.catalogBridgeDigest(observation.worker.gracefulStopReceipt);
  const prepared = plan.prepareCatalogBridge({ pins, observation });
  const journal = stateModule.createCatalogBridgeJournal(prepared.publicReceipt);
  const config = plan.catalogBridgeConfigurationPlan(prepared.privateState);
  const commit = { schemaVersion: "dataforrest_catalog_bridge_commit_v1",
    operationId, providerKey: definition.providerKey,
    privateStateSha256: plan.catalogBridgeDigest(prepared.privateState),
    publicJournalSha256: plan.catalogBridgeDigest(journal) };
  const policy = policyModule.catalogBridgeCatalogLivePolicySchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_catalog_live_v1", environment: "live",
    authorization: "operator_requested_catalog_bridge_catalog_cutover", pins,
    journalDirectory: "/private/catalog-journal",
    capabilityProof: { path: "/private/catalog-capability-proof.json",
      fileSha256: hash("e"), proofDigest: hash("f") },
    prepared: { privateStateSha256: commit.privateStateSha256,
      publicJournalSha256: commit.publicJournalSha256,
      journalHeadReceiptSha256: journal.headReceiptHash },
    current: { providerId: definition.providerId, configId: definition.currentConfigId,
      configNumber: definition.currentConfigNumber, providerRowVersion: "20",
      centralAuthorityDigest: observation.central.authorityDigest,
      databaseRouteDigest: observation.central.databaseRouteDigest,
      runtimeGeneration: "30", runtimeRowVersion: "40", sourceCursorHash: cursorHash,
      latestTerminalRunId: terminal.runId, latestTerminalRunDigest: terminal.runDigest,
      pauseCommandId: pause.commandId, pauseCommandDigest: pause.commandDigest },
    evidence: { drainReceiptSha256: observation.worker.gracefulStopReceiptSha256,
      catalogOriginCanarySha256: observation.sourceCanaries.catalogOrigin.responseSha256,
      savedEventCanarySha256: observation.sourceCanaries.savedEventCursor.responseSha256,
      baselineSha256: plan.catalogBridgeDigest(baseline) },
    utility: { workerId: `catalog-bridge/${operationId}/${definition.providerKey}/catalog-utility`,
      leaseMilliseconds: 60_000, oneShotModuleSha256: hash("e"),
      executionTimeoutMilliseconds: policyModule.catalogBridgeCatalogExecutionBudget(pins)
        .executionTimeoutMilliseconds, pausePollMilliseconds: 50,
      pauseMaximumObservations: 2 },
    successorLaunchAgent: {
      stagedPath: `/private/staged/${definition.launchdLabel}.plist`,
      installedPath: `/private/installed/${definition.launchdLabel}.plist`,
      fileSha256: hash("7"), nodePath: "/private/node",
      logPath: "/private/logs/catalog-successor.log",
      residentModuleSha256: hash("6"), bootstrapPollMilliseconds: 50,
      bootstrapTimeoutMilliseconds: 1_000, startupMaximumObservations: 2,
      startupPollMilliseconds: 100,
    },
  });
  const ready = { observedAt: "2026-09-01T04:01:00.000Z", residentOffline: true,
    providerId: definition.providerId, providerKey: definition.providerKey, providerRowVersion: "20",
    centralAuthorityDigest: observation.central.authorityDigest,
    databaseRouteDigest: observation.central.databaseRouteDigest,
    activeConfigId: definition.currentConfigId, activeConfigNumber: definition.currentConfigNumber,
    maximumConfigNumber: definition.currentConfigNumber, runtimeState: "paused",
    runtimeGeneration: "30", runtimeRowVersion: "40", cachedConfigId: definition.currentConfigId,
    cachedConfigNumber: definition.currentConfigNumber, sourceCursorPresent: true, sourceCursorHash: cursorHash,
    latestTerminalRunId: terminal.runId, latestTerminalRunDigest: terminal.runDigest,
    pauseCommandId: pause.commandId, pauseCommandDigest: pause.commandDigest,
    activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null,
    otherActiveTransactionCount: 0, canonical: baseline };
  const activated = { observedAt: "2026-09-01T04:02:00.000Z",
    centralActiveConfigId: config.catalog.id, centralActiveConfigNumber: config.catalog.versionNumber,
    centralActiveAdapterVersion: definition.catalogAdapterVersion,
    centralActiveConfigurationDigest: plan.catalogBridgeDigest(config.catalog.configuration),
    providerRowVersion: "21", providerCachedConfigId: config.catalog.id,
    providerCachedConfigNumber: config.catalog.versionNumber,
    providerCachedConfigurationDigest: plan.catalogBridgeDigest({
      adapterKey: definition.catalogAdapterVersion, settings: config.catalog.configuration }),
    runtimeGeneration: "30", runtimeRowVersion: "41", sourceCursorHash: null,
    sourceCursorPresent: false, runtimeState: "paused", pauseCommandId: pause.commandId,
    pauseCommandDigest: pause.commandDigest, latestTerminalRunId: terminal.runId,
    latestTerminalRunDigest: terminal.runDigest, activeRunCount: 0, actionableCommandCount: 0,
    importLeaseOwner: null, otherActiveTransactionCount: 0, canonical: baseline };
  const admission = { observedAt: "2026-09-01T04:03:00.000Z", runtimeState: "idle",
    runtimeGeneration: "31", activeConfigId: config.catalog.id, cachedConfigId: config.catalog.id,
    sourceCursorPresent: false, sourceCursorHash: null,
    resumeCommandId: "30000000-0000-4000-8000-000000000005", resumeCommandDigest: hash("1"),
    resumeCommandType: "resume", resumeCommandState: "completed", resumeExpectedGeneration: "30",
    resumeResultGeneration: "31", pausedOriginGuardDigest: hash("2"),
    catalogRunId: prepared.privateState.catalogRunId, catalogRunState: "queued",
    catalogRunConfigId: config.catalog.id, catalogRunConfigNumber: config.catalog.versionNumber,
    catalogRunRequestedCursorHash: null,
    requestRunCommandId: "30000000-0000-4000-8000-000000000006",
    requestRunCommandDigest: hash("3"), utilityLeaseDigest: hash("4") };
  const head = { runId: prepared.privateState.catalogRunId, configId: config.catalog.id,
    configNumber: config.catalog.versionNumber, state: "succeeded", reachedHead: true,
    requestedCursorHash: null,
    sourceRecordCount: pins.sourceHeadCounts.card + pins.sourceHeadCounts.pack,
    catalogRecordCount: pins.sourceHeadCounts.card + pins.sourceHeadCounts.pack,
    cardRecordCount: pins.sourceHeadCounts.card, packRecordCount: pins.sourceHeadCounts.pack,
    distinctCardIdentityCount: pins.sourceHeadCounts.card,
    distinctPackIdentityCount: pins.sourceHeadCounts.pack,
    identityChainDigest: hash("6"), identityMultisetDigest: hash("7"),
    pullRecordCount: 0, marketEventRecordCount: 0, quarantinedCount: 0,
    finalCursorHash: hash("5"), runtimeState: "idle", activeRunCount: 0,
    actionableCommandCount: 0, importLeaseOwner: null,
    canonicalAfter: { ...baseline, cards: pins.sourceHeadCounts.card, packs: pins.sourceHeadCounts.pack } };
  return { definition, prepared, journal, commit, policy, ready, activated, admission, head };
}

function dependencies(value, overrides = {}) {
  const calls = [];
  let headReads = 0;
  const defaults = {
    async readPreparedBoundary() { calls.push("read"); return value.ready; },
    async activateCatalogConfiguration() { calls.push("activate"); return value.activated; },
    async admitCatalogRun(input) {
      calls.push("admit");
      assert.equal(input.originReceiptDigest, plan.catalogBridgeDigest(value.activatedJournal.receipts[1]));
      return value.admission;
    },
    async readCatalogHead() { calls.push("head"); headReads += 1; return headReads === 1 ? null : value.head; },
    async executeCatalogRun() { calls.push("execute");
      return { kind: "completed", runId: value.prepared.privateState.catalogRunId }; },
    async persistJournal({ next }) { calls.push(`persist:${next.phase}`);
      return { schemaVersion: "dataforrest_catalog_bridge_commit_v1", operationId,
        providerKey: value.definition.providerKey,
        privateStateSha256: plan.catalogBridgeDigest(value.prepared.privateState),
        publicJournalSha256: plan.catalogBridgeDigest(next) }; },
    async ensureResidentOfflineAndPaused() { calls.push("safe"); },
  };
  return { calls, value: { ...defaults, ...overrides } };
}

test("catalog live policy binds its timeout to exact source-head and adapter evidence", () => {
  const value = fixture();
  assert.equal(value.policy.utility.executionTimeoutMilliseconds,
    8 * 60 * 60_000 + 30 * 60_000);
  assert.throws(() => policyModule.catalogBridgeCatalogLivePolicySchema.parse({ ...value.policy,
    utility: { ...value.policy.utility,
      executionTimeoutMilliseconds: value.policy.utility.executionTimeoutMilliseconds + 60_000 } }));
});

test("successor plist proof gates every catalog stage action", async () => {
  const refusedCalls = [];
  await assert.rejects(liveRunner.runAfterCatalogBridgeSuccessorCheck({
    async check() {
      refusedCalls.push("check");
      throw new plan.CatalogBridgeError("CATALOG_BRIDGE_BOOTSTRAP_PLIST_INVALID");
    },
    async action() { refusedCalls.push("action"); },
  }), { code: "CATALOG_BRIDGE_BOOTSTRAP_PLIST_INVALID" });
  assert.deepEqual(refusedCalls, ["check"]);

  const acceptedCalls = [];
  const result = await liveRunner.runAfterCatalogBridgeSuccessorCheck({
    async check() { acceptedCalls.push("check"); },
    async action() { acceptedCalls.push("action"); return "catalog-stage-result"; },
  });
  assert.equal(result, "catalog-stage-result");
  assert.deepEqual(acceptedCalls, ["check", "action"]);
});

function input(value, dependencies, mode = "apply", journal = value.journal) {
  return { mode, policy: value.policy, state: value.prepared.privateState, journal,
    commit: { ...value.commit, publicJournalSha256: plan.catalogBridgeDigest(journal) }, dependencies };
}

function activateFixture(value) {
  const activatedJournal = stateModule.recordCatalogActivated({ journal: value.journal,
    state: value.prepared.privateState, observation: value.activated });
  return Object.assign(value, { activatedJournal });
}

test("check-only proves readiness without executing any write or source action", async () => {
  const value = activateFixture(fixture());
  const deps = dependencies(value);
  const result = await catalog.runCatalogBridgeCatalogStage(input(value, deps.value, "check_only"));
  assert.equal(result.outcome, "ready");
  assert.deepEqual(deps.calls, ["read"]);
  assert.equal(result.databaseWritesPerformed, false);
  assert.equal(result.sourceExecutionPerformed, false);
});

test("catalog stage follows activation, durable admission, one-shot and census order", async () => {
  const value = activateFixture(fixture());
  const deps = dependencies(value);
  const result = await catalog.runCatalogBridgeCatalogStage(input(value, deps.value));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(deps.calls, ["read", "activate", "persist:catalog_activated", "admit",
    "persist:catalog_run_admitted", "head", "execute", "head", "persist:catalog_completed", "safe"]);
});

test("catalog admission journal failure safely pauses and retries only the exact durable queue", async () => {
  const value = activateFixture(fixture());
  const calls = [];
  let runtime = "idle";
  let queued = false;
  let persistAdmissionFailures = 1;
  let headReads = 0;
  const deps = {
    async readPreparedBoundary() { calls.push("unexpected:read"); return value.ready; },
    async activateCatalogConfiguration() { calls.push("unexpected:activate"); return value.activated; },
    async admitCatalogRun() {
      calls.push(runtime === "paused" ? "admit:recover-exact-queue" : "admit:initial");
      if (runtime === "paused") {
        assert.equal(queued, true);
        runtime = "idle";
      } else {
        assert.equal(runtime, "idle");
        queued = true;
      }
      return value.admission;
    },
    async readCatalogHead() {
      calls.push("head");
      headReads += 1;
      return headReads === 1 ? null : value.head;
    },
    async executeCatalogRun() {
      calls.push("execute");
      assert.equal(runtime, "idle");
      assert.equal(queued, true);
      queued = false;
      return { kind: "completed", runId: value.prepared.privateState.catalogRunId };
    },
    async persistJournal({ next }) {
      calls.push(`persist:${next.phase}`);
      if (next.phase === "catalog_run_admitted" && persistAdmissionFailures > 0) {
        persistAdmissionFailures -= 1;
        throw new Error("journal unavailable");
      }
      return { schemaVersion: "dataforrest_catalog_bridge_commit_v1", operationId,
        providerKey: value.definition.providerKey,
        privateStateSha256: plan.catalogBridgeDigest(value.prepared.privateState),
        publicJournalSha256: plan.catalogBridgeDigest(next) };
    },
    async ensureResidentOfflineAndPaused() {
      calls.push(queued ? "safe:pause-exact-queue" : "safe:final");
      runtime = "paused";
    },
  };
  await assert.rejects(catalog.runCatalogBridgeCatalogStage(
    input(value, deps, "apply", value.activatedJournal)), /journal unavailable/u);
  assert.equal(calls.includes("execute"), false);
  assert.equal(runtime, "paused");
  const retry = await catalog.runCatalogBridgeCatalogStage(
    input(value, deps, "apply", value.activatedJournal));
  assert.equal(retry.phase, "catalog_completed");
  assert.ok(calls.indexOf("admit:recover-exact-queue") < calls.indexOf("execute"));
  assert.equal(calls.includes("unexpected:read"), false);
});

test("catalog resume-without-run uses a distinct prequeue pause and retries before source I/O", async () => {
  const value = activateFixture(fixture());
  const originReceiptDigest = plan.catalogBridgeDigest(value.activatedJournal.receipts[1]);
  const calls = [];
  let runtime = "paused";
  let originResumed = false;
  let queued = false;
  let completed = false;
  let admissionAttempts = 0;
  let headReads = 0;
  const deps = {
    async readPreparedBoundary() { calls.push("unexpected:read"); return value.ready; },
    async activateCatalogConfiguration() { calls.push("unexpected:activate"); return value.activated; },
    async admitCatalogRun(admissionInput) {
      assert.equal(admissionInput.originReceiptDigest, originReceiptDigest);
      admissionAttempts += 1;
      if (admissionAttempts === 1) {
        calls.push("admit:origin-resumed");
        assert.equal(runtime, "paused");
        runtime = "idle";
        originResumed = true;
        throw new Error("queue unavailable after origin resume");
      }
      calls.push("admit:prequeue-resumed-and-queued");
      assert.equal(originResumed, true);
      assert.equal(runtime, "paused");
      runtime = "idle";
      queued = true;
      return value.admission;
    },
    async readCatalogHead() {
      calls.push("head");
      headReads += 1;
      return headReads === 1 ? null : value.head;
    },
    async executeCatalogRun() {
      calls.push("execute");
      assert.equal(runtime, "idle");
      assert.equal(queued, true);
      queued = false;
      completed = true;
      return { kind: "completed", runId: value.prepared.privateState.catalogRunId };
    },
    async persistJournal({ next }) {
      calls.push(`persist:${next.phase}`);
      return { schemaVersion: "dataforrest_catalog_bridge_commit_v1", operationId,
        providerKey: value.definition.providerKey,
        privateStateSha256: plan.catalogBridgeDigest(value.prepared.privateState),
        publicJournalSha256: plan.catalogBridgeDigest(next) };
    },
    async ensureResidentOfflineAndPaused(recoveryInput) {
      assert.equal(recoveryInput.originReceiptDigest, originReceiptDigest);
      if (!completed) {
        calls.push("safe:prequeue-pause");
        assert.equal(originResumed, true);
        assert.equal(queued, false);
      } else {
        calls.push("safe:post-catalog-pause");
      }
      runtime = "paused";
    },
  };
  await assert.rejects(catalog.runCatalogBridgeCatalogStage(
    input(value, deps, "apply", value.activatedJournal)), /queue unavailable after origin resume/u);
  assert.equal(runtime, "paused");
  assert.equal(calls.includes("safe:post-catalog-pause"), false);
  assert.equal(calls.includes("execute"), false);

  const retry = await catalog.runCatalogBridgeCatalogStage(
    input(value, deps, "apply", value.activatedJournal));
  assert.equal(retry.phase, "catalog_completed");
  assert.ok(calls.indexOf("safe:prequeue-pause") <
    calls.indexOf("admit:prequeue-resumed-and-queued"));
  assert.ok(calls.indexOf("admit:prequeue-resumed-and-queued") < calls.indexOf("execute"));
  assert.equal(calls.filter(call => call === "safe:post-catalog-pause").length, 1);
});

test("catalog apply reconciles each exact activation prefix before the public receipt", async () => {
  for (const prefix of [
    (value) => ({ ...value.ready, maximumConfigNumber: value.activated.centralActiveConfigNumber }),
    (value) => ({ ...value.ready, maximumConfigNumber: value.activated.centralActiveConfigNumber,
      cachedConfigId: value.activated.providerCachedConfigId,
      cachedConfigNumber: value.activated.providerCachedConfigNumber,
      runtimeRowVersion: value.activated.runtimeRowVersion,
      sourceCursorPresent: false, sourceCursorHash: null }),
    (value) => ({ ...value.ready, maximumConfigNumber: value.activated.centralActiveConfigNumber,
      activeConfigId: value.activated.centralActiveConfigId,
      activeConfigNumber: value.activated.centralActiveConfigNumber,
      providerRowVersion: value.activated.providerRowVersion,
      cachedConfigId: value.activated.providerCachedConfigId,
      cachedConfigNumber: value.activated.providerCachedConfigNumber,
      runtimeRowVersion: value.activated.runtimeRowVersion,
      sourceCursorPresent: false, sourceCursorHash: null }),
  ]) {
    const value = activateFixture(fixture());
    const deps = dependencies(value, { async readPreparedBoundary() {
      deps.calls.push("read"); return prefix(value); } });
    const result = await catalog.runCatalogBridgeCatalogStage(input(value, deps.value));
    assert.equal(result.phase, "catalog_completed");
    assert.equal(deps.calls.includes("activate"), true);
  }
});

test("catalog check-only still refuses a partially mutated prepared boundary", async () => {
  const value = activateFixture(fixture());
  const deps = dependencies(value, { async readPreparedBoundary() {
    deps.calls.push("read");
    return { ...value.ready, maximumConfigNumber: value.activated.centralActiveConfigNumber };
  } });
  await assert.rejects(catalog.runCatalogBridgeCatalogStage(input(value, deps.value, "check_only")),
    { code: "CATALOG_BRIDGE_CATALOG_PREPARED_BOUNDARY_CHANGED" });
  assert.deepEqual(deps.calls, ["read"]);
});

test("central CAS drift and null-origin refusal stop before source execution and keep the resident safe", async () => {
  for (const scenario of [
    { expected: "CATALOG_BRIDGE_CATALOG_CENTRAL_CAS_FAILED",
      overrides: { async activateCatalogConfiguration() {
        throw new plan.CatalogBridgeError("CATALOG_BRIDGE_CATALOG_CENTRAL_CAS_FAILED"); } } },
    { expected: "CATALOG_BRIDGE_CATALOG_NULL_ORIGIN_CHANGED",
      overrides: { async admitCatalogRun() {
        throw new plan.CatalogBridgeError("CATALOG_BRIDGE_CATALOG_NULL_ORIGIN_CHANGED"); } } },
  ]) {
    const value = activateFixture(fixture());
    const deps = dependencies(value, scenario.overrides);
    await assert.rejects(catalog.runCatalogBridgeCatalogStage(input(value, deps.value)),
      { code: scenario.expected });
    assert.equal(deps.calls.includes("execute"), false);
    assert.equal(deps.calls.at(-1), "safe");
  }
});

test("lease loss after admission refuses completion and invokes safe pause", async () => {
  const value = activateFixture(fixture());
  const deps = dependencies(value, { async executeCatalogRun() {
    deps.calls.push("execute");
    return { kind: "blocked", runId: value.prepared.privateState.catalogRunId,
      failureCode: "PROVIDER_IMPORT_LEASE_LOST" };
  } });
  await assert.rejects(catalog.runCatalogBridgeCatalogStage(input(value, deps.value)),
    { code: "CATALOG_BRIDGE_CATALOG_RUN_PROVIDER_IMPORT_LEASE_LOST" });
  assert.equal(deps.calls.at(-1), "safe");
  assert.equal(deps.calls.includes("persist:catalog_completed"), false);
});

test("catalog census refuses source drift, event mutation and canonical persistence loss", async () => {
  const mutations = [
    (head) => ({ ...head, cardRecordCount: head.cardRecordCount - 1,
      catalogRecordCount: head.catalogRecordCount - 1 }),
    (head) => ({ ...head, canonicalAfter: { ...head.canonicalAfter, pullsDigest: hash("f") } }),
    (head) => ({ ...head, canonicalAfter: { ...head.canonicalAfter, packs: 0 } }),
  ];
  for (const mutate of mutations) {
    const value = activateFixture(fixture());
    value.head = mutate(value.head);
    const deps = dependencies(value);
    await assert.rejects(catalog.runCatalogBridgeCatalogStage(input(value, deps.value)),
      { code: "CATALOG_BRIDGE_CATALOG_HEAD_INVALID" });
    assert.equal(deps.calls.at(-1), "safe");
    assert.equal(deps.calls.includes("persist:catalog_completed"), false);
  }
});

test("completed retry is idempotent and re-proves the head before safe pause", async () => {
  const value = activateFixture(fixture());
  let journal = value.activatedJournal;
  journal = stateModule.recordCatalogRunAdmitted({ journal, state: value.prepared.privateState,
    observation: value.admission });
  journal = stateModule.recordCatalogCompleted({ pins: value.policy.pins, journal,
    state: value.prepared.privateState, observedAt: "2026-09-01T04:05:00.000Z",
    observation: value.head });
  const deps = dependencies(value, { async readCatalogHead() { deps.calls.push("head"); return value.head; } });
  const result = await catalog.runCatalogBridgeCatalogStage(input(value, deps.value, "apply", journal));
  assert.equal(result.outcome, "already_completed");
  assert.deepEqual(deps.calls, ["head", "safe"]);
});

function eventFixture() {
  const value = activateFixture(fixture());
  let journal = stateModule.recordCatalogRunAdmitted({ journal: value.activatedJournal,
    state: value.prepared.privateState, observation: value.admission });
  journal = stateModule.recordCatalogCompleted({ pins: value.policy.pins, journal,
    state: value.prepared.privateState, observedAt: "2026-09-01T04:05:00.000Z",
    observation: value.head });
  const configuration = plan.catalogBridgeConfigurationPlan(value.prepared.privateState);
  const pause = {
    commandId: "30000000-0000-4000-8000-000000000007", commandDigest: hash("0"),
    commandType: "pause", commandState: "completed",
    idempotencyKey: `catalog-bridge/${operationId}/post-catalog/pause`,
    targetRunId: null, targetQuarantineId: null, resultingRunId: null,
    requestedByOperatorId: operatorId, expectedGeneration: "31",
    resultOutcome: "accepted", resultCode: "RUNTIME_TRANSITION_APPLIED",
    resultGeneration: "32", correlationId: operationId,
    reason: `DataForrest ${value.definition.providerKey} catalog bridge post-catalog pause`,
    requestedAt: "2026-09-01T04:05:01.000Z", completedAt: "2026-09-01T04:05:02.000Z",
  };
  pause.commandDigest = plan.catalogBridgePauseCommandDigest(pause);
  const catalogRunDigest = plan.catalogBridgeDigest(value.head);
  const staged = {
    observedAt: "2026-09-01T04:06:00.000Z",
    centralActiveConfigId: configuration.catalog.id, centralProviderRowVersion: "21",
    stagedConfigId: configuration.eventSuccessor.id,
    stagedConfigNumber: configuration.eventSuccessor.versionNumber,
    stagedAdapterVersion: configuration.eventSuccessor.adapterVersion,
    stagedConfigurationDigest: plan.catalogBridgeDigest(configuration.eventSuccessor.configuration),
    activationProofDigest: hash("8"), providerStillAtCatalogConfigId: configuration.catalog.id,
    activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null,
    runtimeState: "paused", runtimeGeneration: "32", runtimeRowVersion: "44",
    pauseCommandId: pause.commandId, pauseCommandDigest: pause.commandDigest,
    pauseCommandType: pause.commandType, pauseCommandState: pause.commandState,
    pauseIdempotencyKey: pause.idempotencyKey, pauseTargetRunId: null,
    pauseTargetQuarantineId: null, pauseResultingRunId: null,
    pauseRequestedByOperatorId: pause.requestedByOperatorId,
    pauseExpectedGeneration: pause.expectedGeneration, pauseResultOutcome: pause.resultOutcome,
    pauseResultCode: pause.resultCode, pauseResultGeneration: pause.resultGeneration,
    pauseCorrelationId: pause.correlationId, pauseReason: pause.reason,
    pauseRequestedAt: pause.requestedAt, pauseCompletedAt: pause.completedAt,
    latestTerminalRunId: value.prepared.privateState.catalogRunId,
    latestTerminalRunDigest: catalogRunDigest,
  };
  const restored = plan.reEnvelopeSavedEventCursor(value.prepared.privateState);
  const restoredObservation = {
    observedAt: "2026-09-01T04:07:00.000Z",
    centralActiveConfigId: configuration.eventSuccessor.id,
    centralActiveConfigNumber: configuration.eventSuccessor.versionNumber,
    centralActiveAdapterVersion: configuration.eventSuccessor.adapterVersion,
    centralActiveConfigurationDigest: plan.catalogBridgeDigest(configuration.eventSuccessor.configuration),
    providerRowVersion: "22", providerCachedConfigId: configuration.eventSuccessor.id,
    providerCachedConfigNumber: configuration.eventSuccessor.versionNumber,
    providerCachedConfigurationDigest: plan.catalogBridgeDigest({
      adapterKey: configuration.eventSuccessor.adapterVersion,
      settings: configuration.eventSuccessor.configuration,
    }),
    runtimeGeneration: "32", runtimeRowVersion: "45", sourceCursorHash: restored.cursorHash,
    sourceCursorPresent: true, runtimeState: "paused", pauseCommandId: pause.commandId,
    pauseCommandDigest: pause.commandDigest, latestTerminalRunId: value.prepared.privateState.catalogRunId,
    latestTerminalRunDigest: catalogRunDigest, activeRunCount: 0, actionableCommandCount: 0,
    importLeaseOwner: null, otherActiveTransactionCount: 0, canonical: value.head.canonicalAfter,
    restoredCursorHash: restored.cursorHash, restoredOpaqueValueHash: restored.opaqueValueHash,
    cursorEnvelopeDigest: plan.catalogBridgeDigest(restored.cursor),
  };
  const resumed = {
    observedAt: "2026-09-01T04:10:00.000Z", launchdLabel: value.definition.launchdLabel,
    processCount: 1, residencyPortListening: true, activeConfigId: configuration.eventSuccessor.id,
    cachedConfigId: configuration.eventSuccessor.id,
    startupRunId: stateModule.catalogBridgeResumeRunId(operationId, value.definition.providerKey),
    startupRunState: "succeeded", startupRunRequestedCursorHash: restored.cursorHash,
    startupRunReachedHead: true, activeRunCount: 0, actionableCommandCount: 0,
    importLeaseOwner: null,
  };
  const ready = (phase) => ({ observedAt: "2026-09-01T04:05:30.000Z",
    residentOffline: phase !== "resumed", runtimeState: phase === "resumed" ? "idle" : "paused",
    activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null,
    importLeaseHeartbeatAt: null, importLeaseExpiresAt: null, otherActiveTransactionCount: 0,
    activeConfigId: ["event_cursor_restored", "resumed"].includes(phase)
      ? configuration.eventSuccessor.id : configuration.catalog.id,
    cachedConfigId: ["event_cursor_restored", "resumed"].includes(phase)
      ? configuration.eventSuccessor.id : configuration.catalog.id,
    stagedLaunchAgentSha256: value.policy.successorLaunchAgent.fileSha256 });
  return { ...value, journal, configuration, staged, restoredObservation, resumed, ready };
}

function eventDependencies(value, overrides = {}) {
  const calls = [];
  const defaults = {
    async readEventBoundary() { calls.push("read"); return value.ready(value.journal.phase); },
    async stageEventSuccessor(input) { calls.push("stage");
      assert.equal(input.catalogRunDigest, value.staged.latestTerminalRunDigest); return value.staged; },
    async restoreEventCursor(input) { calls.push("restore");
      assert.equal(input.eventStageReceiptDigest,
        plan.catalogBridgeDigest(value.stagedJournal.receipts[4]));
      return value.restoredObservation; },
    async resumeResident(input) { calls.push("resume");
      assert.equal(input.restoredCursorHash, value.restoredObservation.restoredCursorHash);
      return value.resumed; },
    async readResumed() { calls.push("resumed"); return value.resumed; },
    async releaseResidentAfterJournal({ resumedReceiptDigest }) { calls.push("release");
      assert.match(resumedReceiptDigest, /^[a-f0-9]{64}$/u); },
    async persistJournal({ next }) { calls.push(`persist:${next.phase}`);
      return { schemaVersion: "dataforrest_catalog_bridge_commit_v1", operationId,
        providerKey: value.definition.providerKey,
        privateStateSha256: plan.catalogBridgeDigest(value.prepared.privateState),
        publicJournalSha256: plan.catalogBridgeDigest(next) }; },
    async ensureResidentOfflineAndPaused() { calls.push("safe"); },
  };
  return { calls, value: { ...defaults, ...overrides } };
}

function eventInput(value, dependencies, mode = "apply", journal = value.journal) {
  return { mode, policy: value.policy, state: value.prepared.privateState, journal,
    commit: { ...value.commit, publicJournalSha256: plan.catalogBridgeDigest(journal) }, dependencies };
}

test("event successor check-only is inert and proves the paused catalog boundary", async () => {
  const value = eventFixture();
  const deps = eventDependencies(value);
  const result = await eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, deps.value, "check_only"));
  assert.equal(result.outcome, "ready");
  assert.equal(result.databaseWritesPerformed, false);
  assert.equal(result.launchctlBootstrapPerformed, false);
  assert.equal(result.sourceExecutionPerformed, false);
  assert.deepEqual(deps.calls, ["read"]);
});

test("event successor stages, restores, bootstraps and accepts in reviewed order", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const deps = eventDependencies(value);
  const result = await eventResume.runCatalogBridgeEventResumeStage(eventInput(value, deps.value));
  assert.equal(result.outcome, "completed");
  assert.deepEqual(deps.calls, ["read", "stage", "persist:event_successor_staged", "restore",
    "persist:event_cursor_restored", "resume", "persist:resumed", "release"]);
});

test("event restore apply reconciles provider-sync and central-activation prefixes", async () => {
  for (const ready of [
    (value) => ({ ...value.ready("event_successor_staged"),
      cachedConfigId: value.configuration.eventSuccessor.id }),
    (value) => ({ ...value.ready("event_successor_staged"),
      activeConfigId: value.configuration.eventSuccessor.id,
      cachedConfigId: value.configuration.eventSuccessor.id }),
  ]) {
    const value = eventFixture();
    value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
      state: value.prepared.privateState, observation: value.staged });
    value.journal = value.stagedJournal;
    const deps = eventDependencies(value, { async readEventBoundary() {
      deps.calls.push("read"); return ready(value); } });
    const result = await eventResume.runCatalogBridgeEventResumeStage(eventInput(value, deps.value));
    assert.equal(result.phase, "resumed");
    assert.equal(deps.calls.includes("restore"), true);
  }
});

test("event check-only refuses a restore prefix without advancing it", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  value.journal = value.stagedJournal;
  const deps = eventDependencies(value, { async readEventBoundary() {
    deps.calls.push("read"); return { ...value.ready("event_successor_staged"),
      cachedConfigId: value.configuration.eventSuccessor.id }; } });
  await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, deps.value, "check_only")),
  { code: "CATALOG_BRIDGE_EVENT_READY_BOUNDARY_CHANGED" });
  assert.deepEqual(deps.calls, ["read"]);
});

test("event successor CAS and restored-event evidence drift fail closed before bootstrap", async () => {
  for (const scenario of [
    { code: "CATALOG_BRIDGE_EVENT_STAGE_CAS_FAILED", overrides: {
      async stageEventSuccessor() {
        throw new plan.CatalogBridgeError("CATALOG_BRIDGE_EVENT_STAGE_CAS_FAILED");
      } } },
    { code: "CATALOG_BRIDGE_EVENT_ROWS_CHANGED", overrides: {
      async restoreEventCursor() { return { ...eventFixture().restoredObservation,
        canonical: { ...eventFixture().restoredObservation.canonical, pullsDigest: hash("f") } }; }
    } },
  ]) {
    const value = eventFixture();
    value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
      state: value.prepared.privateState, observation: value.staged });
    const deps = eventDependencies(value, scenario.overrides);
    await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(eventInput(value, deps.value)),
      { code: scenario.code });
    assert.equal(deps.calls.includes("resume"), false);
    assert.equal(deps.calls.at(-1), "safe");
  }
});

test("event cursor-restored and resumed retries are idempotent", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const restoredJournal = stateModule.recordEventCursorRestored({ journal: value.stagedJournal,
    state: value.prepared.privateState, observation: value.restoredObservation });
  value.journal = restoredJournal;
  const first = eventDependencies(value);
  const result = await eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, first.value, "apply", restoredJournal));
  assert.equal(result.phase, "resumed");
  assert.deepEqual(first.calls, ["read", "resume", "persist:resumed", "release"]);
  const resumedJournal = stateModule.recordResumed({ journal: restoredJournal,
    state: value.prepared.privateState, observation: value.resumed });
  value.journal = resumedJournal;
  const second = eventDependencies(value);
  const retried = await eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, second.value, "apply", resumedJournal));
  assert.equal(retried.outcome, "already_completed");
  assert.deepEqual(second.calls, ["release"]);
});

test("event cursor-restored apply reconciles queued, running and succeeded admissions", async () => {
  for (const transition of [
    { residentOffline: true, runtimeState: "idle", activeRunCount: 1 },
    { residentOffline: false, runtimeState: "running", activeRunCount: 1,
      importLeaseOwner: "resident-worker", importLeaseHeartbeatAt: "2026-09-01T04:08:00.000Z",
      importLeaseExpiresAt: "2026-09-01T04:09:00.000Z" },
    { residentOffline: false, runtimeState: "idle", activeRunCount: 0 },
  ]) {
    const value = eventFixture();
    value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
      state: value.prepared.privateState, observation: value.staged });
    const restoredJournal = stateModule.recordEventCursorRestored({ journal: value.stagedJournal,
      state: value.prepared.privateState, observation: value.restoredObservation });
    value.journal = restoredJournal;
    const deps = eventDependencies(value, { async readEventBoundary() {
      deps.calls.push("read"); return { ...value.ready("event_cursor_restored"), ...transition }; } });
    const result = await eventResume.runCatalogBridgeEventResumeStage(
      eventInput(value, deps.value, "apply", restoredJournal));
    assert.equal(result.phase, "resumed");
    assert.deepEqual(deps.calls, ["read", "resume", "persist:resumed", "release"]);
  }
});

test("locked event admission classifier refuses foreign work and mismatched lease tuples", () => {
  const now = new Date("2026-09-01T04:08:00.000Z");
  const base = { operationId, runState: "queued", runReachedHead: false,
    runWorkerFence: 0n, runCommandState: "accepted", runtimeState: "idle", activeRunCount: 1,
    actionableCommandCount: 1, processOffline: true, processOnline: false,
    leaseOwner: null, leaseFence: 40n, leaseHeartbeatAt: null,
    leaseExpiresAt: null, databaseNow: now };
  assert.doesNotThrow(() => liveDatabase.assertEventResumeAdmissionState(base));
  const utilityOwner = `catalog-bridge/${operationId}/collector_crypt/catalog-utility`;
  const operationOwned = { ...base, leaseOwner: utilityOwner, leaseHeartbeatAt: now,
    leaseExpiresAt: new Date("2026-09-01T04:09:00.000Z"),
    expectedUtilityLeaseOwner: utilityOwner };
  assert.doesNotThrow(() => liveDatabase.assertEventResumeAdmissionState(operationOwned));
  assert.doesNotThrow(() => liveDatabase.assertEventResumeAdmissionState({ ...operationOwned,
    runState: "succeeded", runReachedHead: true, runWorkerFence: 41n,
    runCommandState: "completed", activeRunCount: 0, actionableCommandCount: 0 }));
  assert.throws(() => liveDatabase.assertEventResumeAdmissionState({ ...operationOwned,
    expectedUtilityLeaseOwner: `${utilityOwner}/foreign` }),
  { code: "CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_UNPROVEN" });
  const residentOwner = `local:backfill:${operationId}:40000000-0000-4000-8000-000000000001`;
  const running = { ...base, runState: "running", runtimeState: "running",
    runCommandState: "completed", actionableCommandCount: 0,
    processOffline: false, processOnline: true, leaseOwner: residentOwner,
    leaseFence: 41n, runWorkerFence: 41n, leaseHeartbeatAt: now,
    leaseExpiresAt: new Date("2026-09-01T04:09:00.000Z") };
  assert.doesNotThrow(() => liveDatabase.assertEventResumeAdmissionState(running));
  assert.doesNotThrow(() => liveDatabase.assertEventResumeAdmissionState({ ...base,
    runState: "succeeded", runReachedHead: true, runWorkerFence: 41n,
    runCommandState: "completed", activeRunCount: 0, actionableCommandCount: 0 }));
  assert.throws(() => liveDatabase.assertEventResumeAdmissionState({ ...base,
    runState: "succeeded", runReachedHead: true, runWorkerFence: 41n,
    runCommandState: "completed", runtimeState: "paused",
    activeRunCount: 0, actionableCommandCount: 0 }),
  { code: "CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_UNPROVEN" });
  for (const changed of [
    { activeRunCount: 2 },
    { actionableCommandCount: 2 },
    { runCommandState: "completed" },
    { runWorkerFence: 1n },
    { ...running, leaseOwner: "foreign-worker" },
    { ...running, runWorkerFence: 42n },
    { ...running, leaseExpiresAt: now },
    { leaseHeartbeatAt: now },
    { leaseExpiresAt: new Date("2026-09-01T04:09:00.000Z") },
  ]) {
    assert.throws(() => liveDatabase.assertEventResumeAdmissionState({ ...base, ...changed }),
      { code: "CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_UNPROVEN" });
  }
});

test("catalog pending classifier accounts for only the exact accepted queue command", () => {
  const now = new Date("2026-09-01T04:08:00.000Z");
  const expectedWorkerId = `catalog-bridge/${operationId}/collector_crypt/catalog-utility`;
  const queued = { expectedWorkerId, runState: "queued", runWorkerFence: 0n,
    runCommandState: "accepted", runtimeState: "idle", activeRunCount: 1,
    actionableCommandCount: 1, leaseOwner: expectedWorkerId, leaseFence: 40n,
    leaseHeartbeatAt: now, leaseExpiresAt: new Date("2026-09-01T04:09:00.000Z"),
    databaseNow: now };
  assert.doesNotThrow(() => liveDatabase.assertCatalogPendingRunState(queued));
  const running = { ...queued, runState: "running", runWorkerFence: 40n,
    runCommandState: "completed", runtimeState: "running", actionableCommandCount: 0 };
  assert.doesNotThrow(() => liveDatabase.assertCatalogPendingRunState(running));
  for (const changed of [
    { actionableCommandCount: 2 }, { activeRunCount: 2 },
    { runCommandState: "completed" }, { runWorkerFence: 1n },
    { leaseOwner: "foreign-worker" }, { leaseHeartbeatAt: null },
    { leaseExpiresAt: now },
    { ...running, actionableCommandCount: 1 },
    { ...running, runWorkerFence: 41n },
  ]) assert.throws(() => liveDatabase.assertCatalogPendingRunState({ ...queued, ...changed }),
    { code: "CATALOG_BRIDGE_CATALOG_QUEUED_RUN_RACE" });
});

test("catalog worker-start generation proves the complete queued recovery chain", async () => {
  const value = fixture();
  const commands = [];
  const database = {
    control_commands: { async findUnique({ where: { id } }) {
      const pause = commands.length === 0;
      const generation = pause ? 31n : 32n;
      const row = { id, command_type: pause ? "pause" : "resume", state: "completed",
        completed_at: new Date("2026-09-01T04:03:30.000Z"),
        idempotency_key: pause
          ? `catalog-bridge/${operationId}/catalog-admission-recovery/31/pause`
          : `catalog-bridge/${operationId}/catalog-admission-recovery/32/resume`,
        target_run_id: null, target_quarantine_id: null, resulting_run_id: null,
        expected_generation: generation, requested_by_operator_id: operatorId,
        correlation_id: operationId,
        reason: pause
          ? "DataForrest collector_crypt catalog bridge queued admission recovery at generation 31"
          : "DataForrest collector_crypt catalog bridge catalog-admission recovery at generation 32",
        result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED",
          generation: (generation + 1n).toString() } };
      commands.push(row);
      return row;
    } },
    local_audit_events: { async findFirst({ where }) {
      return { outcome: "success", actor_operator_id: operatorId, correlation_id: operationId,
        target_type: "control_command", target_id: where.command_id,
        details: { guardDigest: hash("a") } };
    } },
  };
  await assert.doesNotReject(liveDatabase.proveCatalogRecoveryGenerationHistory({ database,
    policy: value.policy, state: value.prepared.privateState,
    initialIdleGeneration: 31n, targetIdleGeneration: 33n }));

  let reads = 0;
  const changed = { ...database, control_commands: { async findUnique(request) {
    const row = await database.control_commands.findUnique(request);
    reads += 1;
    return reads === 2 ? { ...row, result: { ...row.result, generation: "34" } } : row;
  } } };
  commands.length = 0;
  await assert.rejects(liveDatabase.proveCatalogRecoveryGenerationHistory({ database: changed,
    policy: value.policy, state: value.prepared.privateState,
    initialIdleGeneration: 31n, targetIdleGeneration: 33n }),
  { code: "CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN" });
});

test("event recovery history accepts only the deterministic operation resume chain", async () => {
  const value = fixture();
  const configuration = plan.catalogBridgeConfigurationPlan(value.prepared.privateState);
  const run = { id: "30000000-0000-4000-8000-000000000099", state: "succeeded" };
  const checkpoint = { source: "event-head" };
  const checkpointHash = hash("b");
  const makeDatabase = (resumeReason) => {
    const rows = [];
    return {
      control_commands: { async findUnique({ where: { id } }) {
        const pause = rows.length === 0;
        const generation = pause ? 40n : 41n;
        const row = { id, command_type: pause ? "pause" : "resume", state: "completed",
          completed_at: new Date("2026-09-01T04:09:00.000Z"),
          idempotency_key: pause
            ? `catalog-bridge/${operationId}/event-safe-recovery/40/pause`
            : `catalog-bridge/${operationId}/event-prequeue-recovery/41/resume`,
          target_run_id: null, target_quarantine_id: null, resulting_run_id: null,
          expected_generation: generation, requested_by_operator_id: operatorId,
          correlation_id: operationId,
          reason: pause
            ? "DataForrest collector_crypt catalog bridge safe recovery at generation 40"
            : resumeReason,
          result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED",
            generation: (generation + 1n).toString() } };
        rows.push(row);
        return row;
      } },
      local_audit_events: { async findFirst({ where }) {
        const pause = rows[0];
        const semanticGuard = { entry: "paused", providerId: value.definition.providerId,
          configVersionId: configuration.eventSuccessor.id,
          configVersionNumber: BigInt(configuration.eventSuccessor.versionNumber),
          runtimeRowVersion: 101n, checkpointHash, checkpoint,
          latestRunId: run.id, latestRunDigest: providerResumeEvidenceDigest(run),
          pauseCommandId: pause.id, pauseCommandDigest: providerResumeEvidenceDigest(pause) };
        return { outcome: "success", actor_operator_id: operatorId, correlation_id: operationId,
          target_type: "control_command", target_id: where.command_id,
          details: { guardDigest: providerResumeEvidenceDigest(semanticGuard) } };
      } },
    };
  };
  const exactReason =
    "DataForrest collector_crypt catalog bridge event-prequeue recovery at generation 41";
  await assert.doesNotReject(liveDatabase.proveSucceededEventRecoveryHistory({
    database: makeDatabase(exactReason), policy: value.policy,
    state: value.prepared.privateState, run, baseIdleGeneration: 40n,
    baseIdleRowVersion: 100n, targetIdleGeneration: 42n,
    checkpointHash, checkpoint, scope: "event-prequeue" }));
  await assert.rejects(liveDatabase.proveSucceededEventRecoveryHistory({
    database: makeDatabase("foreign resume"), policy: value.policy,
    state: value.prepared.privateState, run, baseIdleGeneration: 40n,
    baseIdleRowVersion: 100n, targetIdleGeneration: 42n,
    checkpointHash, checkpoint, scope: "event-prequeue" }),
  { code: "CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN" });
});

test("catalog translation proof binds normalized and entity counts to raw observations", () => {
  const pageResponseDigest = hash("a");
  const pageIdentityMultisetDigest = hash("b");
  const row = {
    page_number: 1n, continuation: "head",
    stored_response_digest: pageResponseDigest,
    census_version: "provider_catalog_identity_census_v1",
    page_response_digest: pageResponseDigest,
    raw_cards: 2n, raw_packs: 1n, distinct_cards: 2n, distinct_packs: 1n,
    identity_chain_digest: providerCatalogIdentityChainDigest({
      previousChainDigest: null, pageNumber: 1, pageResponseDigest,
      pageIdentityMultisetDigest,
    }),
    page_identity_multiset_digest: pageIdentityMultisetDigest,
    identity_multiset_digest: hash("c"),
    source_records: 3n, normalized_records: 4n, catalog: 4n,
    cards: 2n, pack_content_snapshots: 1n,
    pulls: 0n, market_events: 0n, rejected: 0n,
  };
  assert.equal(liveDatabase.catalogTranslationProof([row], 1).catalogRecordCount, 4);
  for (const changed of [
    { normalized_records: 3n },
    { cards: 1n },
    { pack_content_snapshots: 2n },
    { normalized_records: 2n, catalog: 2n },
    { normalized_records: null },
  ]) {
    assert.throws(() => liveDatabase.catalogTranslationProof([
      { ...row, ...changed },
    ], 1), { code: "CATALOG_BRIDGE_CATALOG_HEAD_EVIDENCE_CHANGED" });
  }
});

test("event admission reconciles the exact crash cut between resume and run queue", () => {
  const base = { expectedRuntimeRowVersion: 50n, activeRunCount: 0,
    actionableCommandCount: 0 };
  assert.equal(liveDatabase.eventResumeMutationDisposition({ ...base,
    runtimeState: "paused", runtimeRowVersion: 50n, resumeCommandPresent: false,
    exactCompletedResumeCommand: false }), "resume_then_queue");
  assert.equal(liveDatabase.eventResumeMutationDisposition({ ...base,
    runtimeState: "idle", runtimeRowVersion: 51n, resumeCommandPresent: true,
    exactCompletedResumeCommand: true }), "queue_only");
  assert.equal(liveDatabase.eventResumeMutationDisposition({ ...base,
    runtimeState: "paused", runtimeRowVersion: 52n, resumeCommandPresent: true,
    exactCompletedResumeCommand: true }), "resume_prequeue_then_queue");
  assert.equal(liveDatabase.eventResumeMutationDisposition({ ...base,
    runtimeState: "idle", runtimeRowVersion: 53n, resumeCommandPresent: true,
    exactCompletedResumeCommand: true }), "queue_only");
  for (const changed of [
    { runtimeState: "idle", runtimeRowVersion: 51n, resumeCommandPresent: false,
      exactCompletedResumeCommand: false },
    { runtimeState: "idle", runtimeRowVersion: 51n, resumeCommandPresent: true,
      exactCompletedResumeCommand: false },
    { runtimeState: "paused", runtimeRowVersion: 50n, resumeCommandPresent: true,
      exactCompletedResumeCommand: true },
    { runtimeState: "paused", runtimeRowVersion: 53n, resumeCommandPresent: true,
      exactCompletedResumeCommand: true },
    { runtimeState: "paused", runtimeRowVersion: 50n, resumeCommandPresent: false,
      exactCompletedResumeCommand: false, activeRunCount: 1 },
    { runtimeState: "paused", runtimeRowVersion: 50n, resumeCommandPresent: false,
      exactCompletedResumeCommand: false, actionableCommandCount: 1 },
  ]) assert.throws(() => liveDatabase.eventResumeMutationDisposition({ ...base, ...changed }),
    { code: "CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_CHANGED" });
});

test("event successor interruption before resident admission still invokes safe recovery", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const deps = eventDependencies(value, { async restoreEventCursor() {
    throw new plan.CatalogBridgeError("CATALOG_BRIDGE_EVENT_ROWS_CHANGED"); } });
  await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, deps.value, "apply")));
  assert.equal(deps.calls.at(-1), "safe");
});

test("event resident admission observation errors remain handoff-gated", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const restoredJournal = stateModule.recordEventCursorRestored({ journal: value.stagedJournal,
    state: value.prepared.privateState, observation: value.restoredObservation });
  value.journal = restoredJournal;
  const deps = eventDependencies(value, { async resumeResident() {
    throw new plan.CatalogBridgeError("CATALOG_BRIDGE_RESUME_RUN_FAILED"); } });
  await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, deps.value, "apply", restoredJournal)));
  assert.equal(deps.calls.includes("safe"), false);
});

test("event resume-without-run retries the exact prequeue admission without changing generation", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const restoredJournal = stateModule.recordEventCursorRestored({ journal: value.stagedJournal,
    state: value.prepared.privateState, observation: value.restoredObservation });
  value.journal = restoredJournal;
  const calls = [];
  let admissionAttempts = 0;
  let runtime = "paused";
  let originResumed = false;
  const deps = eventDependencies(value, {
    async readEventBoundary() { calls.push("read"); return value.ready("event_cursor_restored"); },
    async resumeResident() {
      admissionAttempts += 1;
      if (admissionAttempts === 1) {
        calls.push("resume:origin-committed");
        runtime = "idle";
        originResumed = true;
        throw new Error("event queue unavailable after resume");
      }
      calls.push("resume:prequeue-recovered");
      assert.equal(originResumed, true);
      assert.equal(runtime, "idle");
      runtime = "idle";
      return value.resumed;
    },
    async ensureResidentOfflineAndPaused() {
      calls.push("safe:event-prequeue-pause");
      assert.equal(originResumed, true);
      runtime = "paused";
    },
    async persistJournal({ next }) {
      calls.push(`persist:${next.phase}`);
      return { schemaVersion: "dataforrest_catalog_bridge_commit_v1", operationId,
        providerKey: value.definition.providerKey,
        privateStateSha256: plan.catalogBridgeDigest(value.prepared.privateState),
        publicJournalSha256: plan.catalogBridgeDigest(next) };
    },
  });
  await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, deps.value, "apply", restoredJournal)),
  /event queue unavailable after resume/u);
  assert.equal(runtime, "idle");
  assert.equal(calls.includes("safe:event-prequeue-pause"), false);
  const retry = await eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, deps.value, "apply", restoredJournal));
  assert.equal(retry.phase, "resumed");
  assert.ok(calls.indexOf("resume:origin-committed") <
    calls.indexOf("resume:prequeue-recovered"));
});

test("a handoff remains releasable after an admitted resume observation failure", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const restoredJournal = stateModule.recordEventCursorRestored({ journal: value.stagedJournal,
    state: value.prepared.privateState, observation: value.restoredObservation });
  value.journal = restoredJournal;
  const resident = residentFixture();
  const observed = await residentSupervisor.readBackfillView(
    resident.database, residentPins, resident.authority);
  const handoff = await residentHandoff.persistResidentHandoff(
    resident.database, residentPins, resident.authority, observed);
  const first = eventDependencies(value, {
    async resumeResident() {
      first.calls.push("resume:observation-error");
      throw new Error("transient resume observation error");
    },
    async ensureResidentOfflineAndPaused() {
      first.calls.push("safe:generation-advanced");
      resident.runtime.state_generation += 2n;
    },
  });
  await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, first.value, "apply", restoredJournal)),
  /transient resume observation error/u);
  assert.deepEqual(first.calls, ["read", "resume:observation-error"]);
  assert.equal(resident.runtime.state_generation.toString(), handoff.generation);

  let release;
  const retry = eventDependencies(value, {
    async resumeResident() {
      retry.calls.push("resume:exact-retry");
      return value.resumed;
    },
    async releaseResidentAfterJournal({ resumedReceiptDigest }) {
      retry.calls.push("release:real");
      release = await residentHandoff.persistResidentRelease(
        resident.database, residentPins, resident.authority, resumedReceiptDigest);
    },
  });
  const result = await eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, retry.value, "apply", restoredJournal));
  assert.equal(result.phase, "resumed");
  assert.ok(release);
  assert.equal(release.handoffDigest, plan.catalogBridgeDigest(handoff));
  assert.deepEqual(retry.calls,
    ["read", "resume:exact-retry", "persist:resumed", "release:real"]);
});

test("unknown resumed journal commit remains gate-protected and replays its exact release", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const restoredJournal = stateModule.recordEventCursorRestored({ journal: value.stagedJournal,
    state: value.prepared.privateState, observation: value.restoredObservation });
  value.journal = restoredJournal;
  let durableJournal;
  const first = eventDependencies(value, {
    async persistJournal({ next }) {
      first.calls.push(`persist:${next.phase}:unknown`);
      durableJournal = next;
      throw new Error("unknown commit outcome");
    },
  });
  await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, first.value, "apply", restoredJournal)), /unknown commit outcome/u);
  assert.deepEqual(first.calls, ["read", "resume", "persist:resumed:unknown"]);
  assert.equal(first.calls.includes("safe"), false);
  assert.equal(durableJournal.phase, "resumed");

  const retry = eventDependencies(value, {
    async readEventBoundary() { assert.fail("durable resumed retry must not inspect mutable latest work"); },
    async releaseResidentAfterJournal({ resumedReceiptDigest }) {
      retry.calls.push("release:unknown-replay");
      assert.equal(resumedReceiptDigest, durableJournal.headReceiptHash);
    },
  });
  const result = await eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, retry.value, "apply", durableJournal));
  assert.equal(result.outcome, "already_completed");
  assert.deepEqual(retry.calls, ["release:unknown-replay"]);
});

test("durable resumed journal retries only its exact resident release after release failure", async () => {
  const value = eventFixture();
  value.stagedJournal = stateModule.recordEventSuccessorStaged({ journal: value.journal,
    state: value.prepared.privateState, observation: value.staged });
  const restoredJournal = stateModule.recordEventCursorRestored({ journal: value.stagedJournal,
    state: value.prepared.privateState, observation: value.restoredObservation });
  value.journal = restoredJournal;
  let releaseAttempts = 0;
  const first = eventDependencies(value, {
    async releaseResidentAfterJournal() {
      first.calls.push("release:failed"); releaseAttempts += 1;
      throw new Error("release unavailable");
    },
  });
  await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, first.value, "apply", restoredJournal)), /release unavailable/u);
  assert.deepEqual(first.calls, ["read", "resume", "persist:resumed", "release:failed"]);
  assert.equal(first.calls.includes("safe"), false);

  const resumedJournal = stateModule.recordResumed({ journal: restoredJournal,
    state: value.prepared.privateState, observation: value.resumed });
  const retry = eventDependencies(value, {
    async readEventBoundary() { assert.fail("released retry must not depend on a mutable latest run"); },
    async readResumed() { assert.fail("durable journal is the immutable resume proof"); },
    async releaseResidentAfterJournal({ resumedReceiptDigest }) {
      retry.calls.push("release:replayed"); releaseAttempts += 1;
      assert.equal(resumedReceiptDigest, resumedJournal.headReceiptHash);
    },
  });
  const result = await eventResume.runCatalogBridgeEventResumeStage(
    eventInput(value, retry.value, "apply", resumedJournal));
  assert.equal(result.outcome, "already_completed");
  assert.deepEqual(retry.calls, ["release:replayed"]);
  assert.equal(releaseAttempts, 2);
});

test("event ready boundary directly refuses active work and unreleased lease provenance", async () => {
  for (const changed of [
    { activeRunCount: 1 }, { actionableCommandCount: 1 },
    { importLeaseHeartbeatAt: "2026-09-01T04:05:30.000Z" },
    { importLeaseExpiresAt: "2026-09-01T04:06:30.000Z" },
    { otherActiveTransactionCount: 1 },
  ]) {
    const value = eventFixture();
    const deps = eventDependencies(value, { async readEventBoundary() {
      return { ...value.ready(value.journal.phase), ...changed }; } });
    await assert.rejects(eventResume.runCatalogBridgeEventResumeStage(
      eventInput(value, deps.value, "apply")),
    { code: "CATALOG_BRIDGE_EVENT_READY_BOUNDARY_CHANGED" });
    assert.equal(deps.calls.includes("stage"), false);
    assert.equal(deps.calls.includes("resume"), false);
  }
});
