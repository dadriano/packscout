import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const state = await tsImport("./dataforrest-catalog-bridge-state.mts", import.meta.url);
const censusProof = await tsImport("./dataforrest-catalog-bridge-source-census-proof.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);

const operationId = "10000000-0000-4000-8000-000000000001";
const operatorId = "10000000-0000-4000-8000-000000000002";
const observedAt = "2026-09-01T02:00:00.000Z";
const hash = (letter) => letter.repeat(64);
const secretCursor = "private-vendor-cursor-must-never-enter-a-public-receipt";

function sourceCensus(definition, providerKey, checkout, commit) {
  const counts = definition.documentedCatalogFloor;
  const sourceRecordCount = counts.card + counts.pack;
  const pageCount = Math.ceil(sourceRecordCount / definition.catalogManifest.requestBounds.pageLimit);
  const pass = (passNumber, startedAt, completedAt) => ({ passNumber, startedAt, completedAt,
    pageCount, sourceRequestCount: pageCount, sourceRecordCount,
    rawCardObservationCount: counts.card, rawPackObservationCount: counts.pack,
    distinctCardIdentityCount: counts.card, distinctPackIdentityCount: counts.pack,
    identityMultisetDigest: hash("f"), traversalChainDigest: hash("7"),
    finalCursorHash: hash("0"), maximumResponseBytes: 1000,
    totalResponseBytes: pageCount * 1000 });
  return censusProof.catalogBridgeSourceCensusSchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_source_census_v1",
    authorization: "operator_requested_read_only_catalog_source_census",
    operationId, providerKey,
    capturedAt: "2026-09-01T01:59:00.000Z",
    executor: { checkout, commit, runnerModuleSha256: hash("1"),
      censusModuleSha256: hash("2"), inspectionModuleSha256: hash("3") },
    source: { providerId: definition.providerId, configId: definition.currentConfigId,
      configNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      catalogAdapterVersion: definition.catalogAdapterVersion,
      sourceCredentialDigest: hash("2"),
      pageLimit: definition.catalogManifest.requestBounds.pageLimit,
      requestTimeoutMilliseconds: definition.catalogManifest.requestBounds.timeoutMilliseconds,
      maximumResponseBytes: definition.catalogManifest.requestBounds.maximumResponseBytes },
    passes: [pass(1, "2026-09-01T01:57:00.000Z", "2026-09-01T01:58:00.000Z"),
      pass(2, "2026-09-01T01:58:01.000Z", "2026-09-01T01:59:00.000Z")],
    agreement: { sourceRecordCount, cardCount: counts.card, packCount: counts.pack,
      pageCount, identityMultisetDigest: hash("f"), traversalChainDigest: hash("7"),
      finalCursorHash: hash("0") },
    databaseWritesPerformed: false, sourceRequestsPerformed: true,
    rawResponsesPersisted: false, rawCursorsPersisted: false, sourceRecordIdsPersisted: false,
  });
}

function fixture(providerKey = "collector_crypt") {
  const definition = plan.catalogBridgeProvider(providerKey);
  const cursor = {
    sourceInstanceId: definition.providerId,
    sourceRevisionId: definition.currentConfigId,
    sourceTypeKey: definition.currentEventManifest.sourceTypeKey,
    adapterVersion: definition.currentEventManifest.adapterVersion,
    cursorCodecKey: definition.currentEventManifest.cursorCodecKey,
    cursorGeneration: 1,
    value: secretCursor,
  };
  const cursorHash = providerMixedCursorFingerprint(cursor);
  const residentCheckout = "/private/approved/resident";
  const residentCommit = "a".repeat(40);
  const proof = sourceCensus(definition, providerKey, residentCheckout, residentCommit);
  const sourceHeadCensusFileSha256 = censusProof.catalogBridgeSourceCensusFileSha256(proof);
  const sourceHeadCensusProofDigest = plan.catalogBridgeDigest(proof);
  const pins = {
    operationId, providerKey, operatorId,
    residentCheckout,
    residentCommit,
    utilityModuleSha256: hash("b"),
    sourceHeadCountProvenance: "two_pass_read_only_catalog_census_v1",
    sourceHeadCounts: { ...definition.documentedCatalogFloor },
    sourceHeadCensusFileSha256,
    sourceHeadCensusProofDigest,
    sourceHeadIdentityMultisetDigest: proof.agreement.identityMultisetDigest,
  };
  const baseline = { cards: 10, packs: 2, pulls: 50, marketEvents: 60,
    pullsDigest: hash("c"), marketEventsDigest: hash("d") };
  const observation = {
    observedAt,
    repository: { checkout: pins.residentCheckout, expectedCommit: pins.residentCommit,
      observedCommit: pins.residentCommit, clean: true, utilityModuleSha256: pins.utilityModuleSha256 },
    worker: { launchdLabel: definition.launchdLabel, gracefullyUnloaded: true, processCount: 0,
      residencyPortListening: false, gracefulStopReceiptSha256: hash("e") },
    central: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey, providerRowVersion: "20", activeConfigId: definition.currentConfigId,
      activeConfigNumber: definition.currentConfigNumber, maximumConfigNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      configuration: { platform: providerKey }, configurationDigest: plan.catalogBridgeDigest({ platform: providerKey }),
      authorityDigest: hash("1"), sourceCredentialDigest: hash("2"),
      databaseRouteDigest: hash("3") },
    runtime: { providerId: definition.providerId, providerKey, databaseName: definition.databaseName,
      databasePort: definition.databasePort, databaseRole: "provider", schemaVersion: "distributed-provider-v1",
      runtimeState: "paused", generation: "30", rowVersion: "40", cachedConfigId: definition.currentConfigId,
      cachedConfigNumber: definition.currentConfigNumber,
      cachedConfiguration: { adapterKey: definition.currentEventManifest.adapterVersion,
        settings: { platform: providerKey } },
      sourceCursor: cursor, sourceCursorHash: cursorHash,
      activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null, otherOwnedLeaseCount: 0,
      otherActiveTransactionCount: 0,
      pauseProvenance: { commandId: "10000000-0000-4000-8000-000000000003", commandDigest: hash("8"),
        commandType: "pause", commandState: "completed",
        idempotencyKey: `catalog-bridge/${operationId}/running/pause`, targetRunId: null,
        targetQuarantineId: null, resultingRunId: null, requestedByOperatorId: operatorId,
        expectedGeneration: "29", resultOutcome: "accepted", resultCode: "RUNTIME_TRANSITION_APPLIED",
        resultGeneration: "30", correlationId: operationId,
        reason: `DataForrest ${providerKey} catalog bridge checkpoint drain`,
        requestedAt: "2026-09-01T01:55:00.000Z", completedAt: "2026-09-01T01:55:05.000Z" },
      latestTerminalRun: { runId: "10000000-0000-4000-8000-000000000005", runDigest: hash("9"),
        terminalKind: "interrupted_checkpoint", headProofDigest: null,
        state: "incomplete", failureCode: "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE", reachedSourceHead: false,
        finishedAt: "2026-09-01T01:55:06.000Z", pageCount: 4, finalCursorHash: cursorHash,
        lastPageNumber: 4, lastPageCursorHash: cursorHash, lastPageContinuation: "more", lastPageDigest: hash("a") } },
    sourceCanaries: {
      catalogOrigin: { adapterVersion: definition.catalogAdapterVersion, requestedCursorHash: null,
        status: 200, recordCount: 2, cardCount: 1, packCount: 1, pullCount: 0, tradeCount: 0,
        responseSha256: hash("4"), nextCursorHash: hash("5"), checkedAt: "2026-09-01T01:59:30.000Z",
        responseBytes: 1000, durationMilliseconds: 10 },
      savedEventCursor: { adapterVersion: definition.eventSuccessorManifest.adapterVersion,
        requestedCursorHash: cursorHash, opaqueValueHash: plan.catalogBridgeDigest(secretCursor), status: 200,
        recordCount: 1, responseSha256: hash("6"), checkedAt: "2026-09-01T01:59:45.000Z",
        responseBytes: 1000, durationMilliseconds: 10 },
    },
    sourceCensus: { proof, fileSha256: sourceHeadCensusFileSha256,
      proofDigest: sourceHeadCensusProofDigest },
    baseline,
  };
  observation.runtime.pauseProvenance.commandDigest =
    plan.catalogBridgePauseCommandDigest(observation.runtime.pauseProvenance);
  const latest = observation.runtime.latestTerminalRun;
  const pause = observation.runtime.pauseProvenance;
  observation.worker.gracefulStopReceipt = {
    schemaVersion: "dataforrest_catalog_bridge_drain_receipt_v1", operationId, providerKey,
    providerId: definition.providerId, operatorId, entryKind: "running",
    currentConfigId: definition.currentConfigId, drainedAt: "2026-09-01T01:56:00.000Z",
    intentDigests: [hash("7")],
    pause: { commandId: pause.commandId, commandDigest: pause.commandDigest,
      expectedGeneration: pause.expectedGeneration, resultGeneration: pause.resultGeneration,
      reason: pause.reason, correlationId: pause.correlationId,
      requestedAt: pause.requestedAt, completedAt: pause.completedAt },
    terminal: { kind: latest.terminalKind, runId: latest.runId, runFence: "19", state: latest.state,
      failureCode: latest.failureCode, reachedSourceHead: latest.reachedSourceHead, finishedAt: latest.finishedAt,
      pageCount: latest.pageCount, finalCursorHash: latest.finalCursorHash,
      lastPageNumber: latest.lastPageNumber, lastPageCursorHash: latest.lastPageCursorHash,
      lastPageContinuation: latest.lastPageContinuation, runDigest: latest.runDigest,
      lastPageDigest: latest.lastPageDigest, headProofDigest: latest.headProofDigest },
    worker: { launchdLabel: definition.launchdLabel, initialPid: 90123,
      initialProcessIdentitySha256: hash("6"), bootoutReceiptDigest: hash("5"),
      offlineProcessEvidenceDigest: hash("4") },
    drainedEvidenceDigest: hash("3"),
  };
  observation.worker.gracefulStopReceiptSha256 = plan.catalogBridgeDigest(observation.worker.gracefulStopReceipt);
  return { definition, pins, observation, baseline, cursor, cursorHash };
}

const refusal = (error) => error?.name === "CatalogBridgeError" && /^CATALOG_BRIDGE_[A-Z_]+$/u.test(error.code);

test("definitions stay exact while census-bound preparation is Collector-only", () => {
  assert.deepEqual(plan.catalogBridgeProviderDefinitions.map((entry) => entry.providerKey),
    ["collector_crypt", "courtyard", "phygitals"]);
  for (const providerKey of ["collector_crypt", "courtyard", "phygitals"]) {
    const value = fixture(providerKey);
    if (providerKey !== "collector_crypt") {
      assert.throws(
        () => plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation }),
        { code: "CATALOG_BRIDGE_SOURCE_CENSUS_PROVIDER_UNSUPPORTED" },
      );
      continue;
    }
    const prepared = plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation });
    const configuration = plan.catalogBridgeConfigurationPlan(prepared.privateState);
    assert.deepEqual(configuration.catalog.configuration, { platform: providerKey, stream: "catalog" });
    assert.deepEqual(configuration.eventSuccessor.configuration, { platform: providerKey });
    assert.equal(configuration.catalog.versionNumber, value.definition.currentConfigNumber + 1);
    assert.equal(configuration.eventSuccessor.versionNumber, value.definition.currentConfigNumber + 2);
    assert.notEqual(configuration.catalog.id, configuration.eventSuccessor.id);
    const publicBytes = JSON.stringify(prepared.publicReceipt);
    assert.equal(publicBytes.includes(secretCursor), false);
    assert.equal(publicBytes.includes("sourceCursor"), false);
  }
});

test("Collector config 3 stays V1 while catalog and event successors are V2", () => {
  const value = fixture("collector_crypt");
  assert.equal(
    value.definition.currentConfigId,
    "0d53bce0-fe5d-54bf-bd07-f47142690a8f",
  );
  assert.equal(value.definition.currentConfigNumber, 3);
  assert.equal(
    value.definition.currentEventManifest.adapterVersion,
    "dataforrest-collector-crypt-distributed-adapter-v1",
  );
  assert.equal(
    value.definition.eventSuccessorManifest.adapterVersion,
    "dataforrest-collector-crypt-distributed-adapter-v2",
  );
  assert.equal(
    value.definition.catalogManifest.adapterVersion,
    "dataforrest-collector-crypt-catalog-adapter-v2",
  );
  assert.equal(
    value.cursor.adapterVersion,
    "dataforrest-collector-crypt-distributed-adapter-v1",
  );

  const prepared = plan.prepareCatalogBridge({
    pins: value.pins,
    observation: value.observation,
  });
  const restored = plan.reEnvelopeSavedEventCursor(prepared.privateState);
  assert.equal(
    restored.cursor.adapterVersion,
    "dataforrest-collector-crypt-distributed-adapter-v2",
  );
  assert.equal(restored.cursor.value, value.cursor.value);
  assert.notEqual(restored.cursorHash, value.cursorHash);
});

test("prepare refuses resident, process, central, runtime, cursor and canary drift", () => {
  const changes = [
    (f) => { f.observation.repository.clean = false; },
    (f) => { f.observation.repository.observedCommit = "b".repeat(40); },
    (f) => { f.observation.worker.gracefullyUnloaded = false; },
    (f) => { f.observation.worker.processCount = 1; },
    (f) => { f.observation.worker.residencyPortListening = true; },
    (f) => { f.observation.worker.gracefulStopReceipt.drainedEvidenceDigest = hash("f"); },
    (f) => { f.observation.central.activeConfigId = operationId; },
    (f) => { f.observation.central.configuration = { platform: f.definition.providerKey, stream: "catalog" }; },
    (f) => { f.observation.central.providerRowVersion = "0"; },
    (f) => { f.observation.runtime.runtimeState = "running"; },
    (f) => { f.observation.runtime.activeRunCount = 1; },
    (f) => { f.observation.runtime.actionableCommandCount = 1; },
    (f) => { f.observation.runtime.importLeaseOwner = "other"; },
    (f) => { f.observation.runtime.pauseProvenance.resultGeneration = "31"; },
    (f) => { f.observation.runtime.pauseProvenance.resultCode = "RUNTIME_UNKNOWN"; },
    (f) => { f.observation.runtime.pauseProvenance.correlationId = operatorId; },
    (f) => { f.observation.runtime.pauseProvenance.reason = ""; },
    (f) => { f.observation.runtime.latestTerminalRun.terminalKind = "succeeded_reconciled_head"; },
    (f) => { f.observation.runtime.sourceCursor.value = "changed"; },
    (f) => { f.observation.sourceCanaries.catalogOrigin.pullCount = 1; },
    (f) => { f.observation.sourceCanaries.catalogOrigin.checkedAt = "2026-09-01T01:57:00.000Z"; },
    (f) => { f.observation.sourceCanaries.savedEventCursor.opaqueValueHash = hash("9"); },
    (f) => { f.pins.sourceHeadCounts.card = f.definition.documentedCatalogFloor.card - 1; },
    (f) => { f.pins.sourceHeadCountProvenance = "manual"; },
    (f) => { f.pins.sourceHeadIdentityMultisetDigest = hash("4"); },
    (f) => { f.observation.sourceCensus.proofDigest = hash("4"); },
    (f) => { f.observation.sourceCensus.proof.source.sourceCredentialDigest = hash("4"); },
    (f) => { f.observation.sourceCensus.proof.passes[1].identityMultisetDigest = hash("4"); },
  ];
  for (const change of changes) {
    const value = structuredClone(fixture());
    change(value);
    assert.throws(() => plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation }), refusal);
  }
});

test("prepare refuses a valid census proof replayed across recovery operations", () => {
  const value = structuredClone(fixture());
  value.observation.sourceCensus.proof.operationId =
    "10000000-0000-4000-8000-000000000099";
  const fileSha256 = censusProof.catalogBridgeSourceCensusFileSha256(
    value.observation.sourceCensus.proof,
  );
  const proofDigest = plan.catalogBridgeDigest(value.observation.sourceCensus.proof);
  value.observation.sourceCensus.fileSha256 = fileSha256;
  value.observation.sourceCensus.proofDigest = proofDigest;
  value.pins.sourceHeadCensusFileSha256 = fileSha256;
  value.pins.sourceHeadCensusProofDigest = proofDigest;
  assert.throws(
    () => plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation }),
    { code: "CATALOG_BRIDGE_SOURCE_CENSUS_INVALID" },
  );
});

test("prepare accepts a separately proved reconciled head that wins the pause race", () => {
  const value = fixture();
  Object.assign(value.observation.runtime.latestTerminalRun, {
    terminalKind: "succeeded_reconciled_head", state: "succeeded", failureCode: null, reachedSourceHead: true,
    headProofDigest: hash("0"), lastPageContinuation: "head",
  });
  Object.assign(value.observation.worker.gracefulStopReceipt.terminal, {
    kind: "succeeded_reconciled_head", state: "succeeded", failureCode: null, reachedSourceHead: true,
    headProofDigest: hash("0"), lastPageContinuation: "head",
  });
  value.observation.worker.gracefulStopReceiptSha256 =
    plan.catalogBridgeDigest(value.observation.worker.gracefulStopReceipt);
  assert.equal(plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation })
    .privateState.preflight.runtime.latestTerminalRun.terminalKind, "succeeded_reconciled_head");
});

test("private saved event cursor re-envelopes to the deterministic successor identity", () => {
  const value = fixture();
  const prepared = plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation });
  const restored = plan.reEnvelopeSavedEventCursor(prepared.privateState);
  const configurations = plan.catalogBridgeConfigurationPlan(prepared.privateState);
  assert.equal(restored.cursor.sourceRevisionId, configurations.eventSuccessor.id);
  assert.equal(
    restored.cursor.adapterVersion,
    value.definition.eventSuccessorManifest.adapterVersion,
  );
  assert.equal(restored.cursor.value, secretCursor);
  assert.equal(restored.opaqueValueHash, plan.catalogBridgeDigest(secretCursor));
  assert.notEqual(restored.cursorHash, value.cursorHash);
  const changed = structuredClone(prepared.privateState);
  changed.savedEventCursor.value = "changed";
  assert.throws(() => plan.reEnvelopeSavedEventCursor(changed), refusal);
  for (const change of [{ sourceTypeKey: "other" }, { cursorCodecKey: "other" }, { cursorGeneration: 2 }]) {
    const drift = structuredClone(prepared.privateState);
    Object.assign(drift.savedEventCursor, change);
    drift.savedEventCursorHash = providerMixedCursorFingerprint(drift.savedEventCursor);
    assert.throws(() => plan.reEnvelopeSavedEventCursor(drift), refusal);
  }
});

function validHead(prepared, value) {
  const configuration = plan.catalogBridgeConfigurationPlan(prepared.privateState);
  return { runId: prepared.privateState.catalogRunId, configId: configuration.catalog.id,
    configNumber: configuration.catalog.versionNumber, state: "succeeded", reachedHead: true,
    requestedCursorHash: null,
    sourceRecordCount: value.pins.sourceHeadCounts.card + value.pins.sourceHeadCounts.pack,
    catalogRecordCount: value.pins.sourceHeadCounts.card + value.pins.sourceHeadCounts.pack,
    cardRecordCount: value.pins.sourceHeadCounts.card, packRecordCount: value.pins.sourceHeadCounts.pack,
    distinctCardIdentityCount: value.pins.sourceHeadCounts.card,
    distinctPackIdentityCount: value.pins.sourceHeadCounts.pack,
    identityChainDigest: hash("5"), identityMultisetDigest: value.pins.sourceHeadIdentityMultisetDigest,
    pullRecordCount: 0, marketEventRecordCount: 0, quarantinedCount: 0, finalCursorHash: hash("7"),
    runtimeState: "idle", activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null,
    canonicalAfter: { ...value.baseline,
      cards: Math.max(value.baseline.cards + 100, value.pins.sourceHeadCounts.card),
      packs: Math.max(value.baseline.packs + 3, value.pins.sourceHeadCounts.pack) } };
}

test("catalog head acceptance is exact and preserves pull and market evidence", () => {
  const value = fixture();
  const prepared = plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation });
  const head = validHead(prepared, value);
  assert.match(plan.assertCatalogHead({ pins: value.pins, state: prepared.privateState, observation: head }).catalogRunDigest,
    /^[a-f0-9]{64}$/u);
  for (const change of [
    { cardRecordCount: head.cardRecordCount + 1 }, { packRecordCount: head.packRecordCount + 1 },
    { distinctCardIdentityCount: head.distinctCardIdentityCount - 1 },
    { distinctPackIdentityCount: head.distinctPackIdentityCount - 1 },
    { sourceRecordCount: head.sourceRecordCount - 1 },
    { identityMultisetDigest: hash("4") },
    { pullRecordCount: 1 }, { marketEventRecordCount: 1 }, { quarantinedCount: 1 },
    { activeRunCount: 1 }, { actionableCommandCount: 1 }, { importLeaseOwner: "catalog-worker" },
    { canonicalAfter: { ...head.canonicalAfter, pulls: head.canonicalAfter.pulls + 1 } },
    { canonicalAfter: { ...head.canonicalAfter, marketEventsDigest: hash("8") } },
  ]) assert.throws(() => plan.assertCatalogHead({ pins: value.pins, state: prepared.privateState,
    observation: { ...head, ...change } }), refusal);
});

test("catalog head refuses translated source counts when canonical persistence is missing", () => {
  const value = fixture();
  value.observation.baseline.cards = 0;
  value.observation.baseline.packs = 0;
  value.baseline.cards = 0;
  value.baseline.packs = 0;
  const prepared = plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation });
  const head = validHead(prepared, value);
  assert.equal(head.packRecordCount, value.pins.sourceHeadCounts.pack);
  assert.throws(() => plan.assertCatalogHead({ pins: value.pins, state: prepared.privateState,
    observation: { ...head, canonicalAfter: { ...head.canonicalAfter, packs: 0 } } }), refusal);
  assert.throws(() => plan.assertCatalogHead({ pins: value.pins, state: prepared.privateState,
    observation: { ...head, canonicalAfter: { ...head.canonicalAfter, cards: 0 } } }), refusal);
});

test("journal enforces the reviewed sequence and exact crash retries", () => {
  const value = fixture();
  const prepared = plan.prepareCatalogBridge({ pins: value.pins, observation: value.observation });
  let journal = state.createCatalogBridgeJournal(prepared.publicReceipt);
  const configuration = plan.catalogBridgeConfigurationPlan(prepared.privateState);
  const catalogActivated = { observedAt: "2026-09-01T02:01:00.000Z",
    centralActiveConfigId: configuration.catalog.id, centralActiveConfigNumber: configuration.catalog.versionNumber,
    centralActiveAdapterVersion: value.definition.catalogAdapterVersion,
    centralActiveConfigurationDigest: plan.catalogBridgeDigest(configuration.catalog.configuration),
    providerRowVersion: "21",
    providerCachedConfigId: configuration.catalog.id, providerCachedConfigNumber: configuration.catalog.versionNumber,
    providerCachedConfigurationDigest: plan.catalogBridgeDigest({ adapterKey: value.definition.catalogAdapterVersion,
      settings: configuration.catalog.configuration }),
    runtimeGeneration: "30", runtimeRowVersion: "41", sourceCursorHash: null, sourceCursorPresent: false,
    runtimeState: "paused", pauseCommandId: value.observation.runtime.pauseProvenance.commandId,
    pauseCommandDigest: value.observation.runtime.pauseProvenance.commandDigest,
    latestTerminalRunId: value.observation.runtime.latestTerminalRun.runId,
    latestTerminalRunDigest: value.observation.runtime.latestTerminalRun.runDigest,
    activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null, otherActiveTransactionCount: 0,
    canonical: value.baseline };
  assert.throws(() => state.recordEventSuccessorStaged({ journal, state: prepared.privateState,
    observation: { observedAt, centralActiveConfigId: configuration.catalog.id, centralProviderRowVersion: "21",
      stagedConfigId: configuration.eventSuccessor.id, stagedConfigNumber: configuration.eventSuccessor.versionNumber,
      stagedAdapterVersion: configuration.eventSuccessor.adapterVersion,
      stagedConfigurationDigest: plan.catalogBridgeDigest(configuration.eventSuccessor.configuration),
      activationProofDigest: hash("9"), providerStillAtCatalogConfigId: configuration.catalog.id,
      activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null, runtimeState: "paused",
      runtimeGeneration: "32", runtimeRowVersion: "44",
      pauseCommandId: "10000000-0000-4000-8000-000000000006", pauseCommandDigest: hash("f"),
      pauseCommandType: "pause", pauseCommandState: "completed", pauseRequestedByOperatorId: operatorId,
      pauseExpectedGeneration: "31", pauseResultOutcome: "accepted", pauseResultCode: "RUNTIME_TRANSITION_APPLIED",
      pauseResultGeneration: "32", pauseCorrelationId: operationId,
      pauseReason: `DataForrest ${value.pins.providerKey} catalog bridge post-catalog pause`,
      pauseRequestedAt: "2026-09-01T02:20:01.000Z", pauseCompletedAt: "2026-09-01T02:20:02.000Z",
      latestTerminalRunId: prepared.privateState.catalogRunId,
      latestTerminalRunDigest: plan.catalogBridgeDigest(validHead(prepared, value)) } }), refusal);
  journal = state.recordCatalogActivated({ journal, state: prepared.privateState, observation: catalogActivated });
  assert.equal(state.recordCatalogActivated({ journal, state: prepared.privateState, observation: catalogActivated }), journal);
  const admission = { observedAt: "2026-09-01T02:02:00.000Z", runtimeState: "idle", runtimeGeneration: "31",
    activeConfigId: configuration.catalog.id, cachedConfigId: configuration.catalog.id,
    sourceCursorPresent: false, sourceCursorHash: null,
    resumeCommandId: "10000000-0000-4000-8000-000000000008", resumeCommandDigest: hash("1"),
    resumeCommandType: "resume", resumeCommandState: "completed", resumeExpectedGeneration: "30",
    resumeResultGeneration: "31", pausedOriginGuardDigest: hash("2"), catalogRunId: prepared.privateState.catalogRunId,
    catalogRunState: "queued", catalogRunConfigId: configuration.catalog.id,
    catalogRunConfigNumber: configuration.catalog.versionNumber, catalogRunRequestedCursorHash: null,
    requestRunCommandId: "10000000-0000-4000-8000-000000000009", requestRunCommandDigest: hash("3"),
    utilityLeaseDigest: hash("4") };
  assert.throws(() => state.recordCatalogRunAdmitted({ journal, state: prepared.privateState,
    observation: { ...admission, pausedOriginGuardDigest: "invalid" } }), refusal);
  journal = state.recordCatalogRunAdmitted({ journal, state: prepared.privateState, observation: admission });
  const head = validHead(prepared, value);
  journal = state.recordCatalogCompleted({ pins: value.pins, journal, state: prepared.privateState,
    observedAt: "2026-09-01T02:20:00.000Z", observation: head });
  const staged = { observedAt: "2026-09-01T02:21:00.000Z", centralActiveConfigId: configuration.catalog.id,
    centralProviderRowVersion: "22", stagedConfigId: configuration.eventSuccessor.id,
    stagedConfigNumber: configuration.eventSuccessor.versionNumber,
    stagedAdapterVersion: configuration.eventSuccessor.adapterVersion,
    stagedConfigurationDigest: plan.catalogBridgeDigest(configuration.eventSuccessor.configuration),
    activationProofDigest: hash("9"), providerStillAtCatalogConfigId: configuration.catalog.id,
    activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null, runtimeState: "paused",
    runtimeGeneration: "32", runtimeRowVersion: "44",
    pauseCommandId: "10000000-0000-4000-8000-000000000006", pauseCommandDigest: hash("f"),
    pauseCommandType: "pause", pauseCommandState: "completed", pauseRequestedByOperatorId: operatorId,
    pauseIdempotencyKey: `catalog-bridge/${operationId}/post-catalog/pause`, pauseTargetRunId: null,
    pauseTargetQuarantineId: null, pauseResultingRunId: null,
    pauseExpectedGeneration: "31", pauseResultOutcome: "accepted", pauseResultCode: "RUNTIME_TRANSITION_APPLIED",
    pauseResultGeneration: "32", pauseCorrelationId: operationId,
    pauseReason: `DataForrest ${value.pins.providerKey} catalog bridge post-catalog pause`,
    pauseRequestedAt: "2026-09-01T02:20:01.000Z", pauseCompletedAt: "2026-09-01T02:20:02.000Z",
    latestTerminalRunId: prepared.privateState.catalogRunId,
    latestTerminalRunDigest: plan.catalogBridgeDigest(head) };
  staged.pauseCommandDigest = plan.catalogBridgePauseCommandDigest({ commandId: staged.pauseCommandId,
    commandDigest: staged.pauseCommandDigest, commandType: staged.pauseCommandType,
    commandState: staged.pauseCommandState, idempotencyKey: staged.pauseIdempotencyKey,
    targetRunId: staged.pauseTargetRunId, targetQuarantineId: staged.pauseTargetQuarantineId,
    resultingRunId: staged.pauseResultingRunId, requestedByOperatorId: staged.pauseRequestedByOperatorId,
    expectedGeneration: staged.pauseExpectedGeneration, resultOutcome: staged.pauseResultOutcome,
    resultCode: staged.pauseResultCode, resultGeneration: staged.pauseResultGeneration,
    correlationId: staged.pauseCorrelationId, reason: staged.pauseReason,
    requestedAt: staged.pauseRequestedAt, completedAt: staged.pauseCompletedAt });
  assert.throws(() => state.recordEventSuccessorStaged({ journal, state: prepared.privateState,
    observation: { ...staged, pauseCorrelationId: operatorId } }), refusal);
  assert.throws(() => state.recordEventSuccessorStaged({ journal, state: prepared.privateState,
    observation: { ...staged, pauseReason: null } }), refusal);
  assert.throws(() => state.recordEventSuccessorStaged({ journal, state: prepared.privateState,
    observation: { ...staged, pauseResultCode: "RUNTIME_UNKNOWN" } }), refusal);
  journal = state.recordEventSuccessorStaged({ journal, state: prepared.privateState, observation: staged });
  const restored = plan.reEnvelopeSavedEventCursor(prepared.privateState);
  const restoredObservation = { ...catalogActivated, observedAt: "2026-09-01T02:22:00.000Z",
    centralActiveConfigId: configuration.eventSuccessor.id,
    centralActiveConfigNumber: configuration.eventSuccessor.versionNumber,
    centralActiveAdapterVersion: configuration.eventSuccessor.adapterVersion,
    centralActiveConfigurationDigest: plan.catalogBridgeDigest(configuration.eventSuccessor.configuration),
    providerCachedConfigId: configuration.eventSuccessor.id,
    providerCachedConfigNumber: configuration.eventSuccessor.versionNumber,
    providerCachedConfigurationDigest: plan.catalogBridgeDigest({ adapterKey: configuration.eventSuccessor.adapterVersion,
      settings: configuration.eventSuccessor.configuration }),
    providerRowVersion: "23", runtimeRowVersion: "45", sourceCursorHash: restored.cursorHash,
    sourceCursorPresent: true, restoredCursorHash: restored.cursorHash,
    restoredOpaqueValueHash: restored.opaqueValueHash, cursorEnvelopeDigest: plan.catalogBridgeDigest(restored.cursor),
    runtimeGeneration: staged.runtimeGeneration,
    pauseCommandId: staged.pauseCommandId, pauseCommandDigest: staged.pauseCommandDigest,
    latestTerminalRunId: staged.latestTerminalRunId, latestTerminalRunDigest: staged.latestTerminalRunDigest,
    canonical: head.canonicalAfter };
  assert.throws(() => state.recordEventCursorRestored({ journal, state: prepared.privateState,
    observation: { ...restoredObservation,
      pauseCommandId: value.observation.runtime.pauseProvenance.commandId,
      pauseCommandDigest: value.observation.runtime.pauseProvenance.commandDigest } }), refusal);
  journal = state.recordEventCursorRestored({ journal, state: prepared.privateState, observation: restoredObservation });
  const resumed = { observedAt: "2026-09-01T02:30:00.000Z", launchdLabel: value.definition.launchdLabel,
    processCount: 1, residencyPortListening: true, activeConfigId: configuration.eventSuccessor.id,
    cachedConfigId: configuration.eventSuccessor.id,
    startupRunId: state.catalogBridgeResumeRunId(operationId, value.pins.providerKey), startupRunState: "succeeded",
    startupRunRequestedCursorHash: restored.cursorHash, startupRunReachedHead: true,
    activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null };
  journal = state.recordResumed({ journal, state: prepared.privateState, observation: resumed });
  assert.equal(journal.phase, "resumed");
  assert.equal(journal.receipts.length, 7);
  assert.equal(JSON.stringify(journal).includes(secretCursor), false);
  assert.equal(state.recordResumed({ journal, state: prepared.privateState, observation: resumed }), journal);
  assert.throws(() => state.recordResumed({ journal, state: prepared.privateState,
    observation: { ...resumed, observedAt: "2026-09-01T02:31:00.000Z" } }),
  { code: "CATALOG_BRIDGE_RETRY_EVIDENCE_CHANGED" });
  const poisoned = structuredClone(journal);
  poisoned.receipts[0].evidence.bearerToken = secretCursor;
  poisoned.headReceiptHash = plan.catalogBridgeDigest(poisoned.receipts.at(-1));
  assert.throws(() => state.assertCatalogBridgeJournal(poisoned),
    { code: "CATALOG_BRIDGE_PUBLIC_RECEIPT_INVALID" });
});
