import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const rehearsal = await tsImport(
  "./dataforrest-catalog-bridge-rehearsal.mts",
  import.meta.url,
);
const plan = await tsImport(
  "../live/dataforrest-catalog-bridge-plan.mts",
  import.meta.url,
);
const state = await tsImport(
  "../live/dataforrest-catalog-bridge-state.mts",
  import.meta.url,
);
const policy = await tsImport(
  "../live/dataforrest-catalog-bridge-catalog-live-policy.mts",
  import.meta.url,
);
const drainPolicy = await tsImport(
  "../live/dataforrest-catalog-bridge-drain-policy.mts",
  import.meta.url,
);
const censusProofModule = await tsImport(
  "../live/dataforrest-catalog-bridge-source-census-proof.mts",
  import.meta.url,
);
const { providerMixedCursorFingerprint } = await tsImport(
  "@packscout/database",
  import.meta.url,
);
const { providerCatalogIdentityChainDigest } = await tsImport(
  "@packscout/services",
  import.meta.url,
);

const INTERRUPTED_OPERATION = "30000000-0000-4000-8000-000000000001";
const RECOVERY_OPERATION = "40000000-0000-4000-8000-000000000001";
const OPERATOR_ID = "50000000-0000-4000-8000-000000000001";
const INTERRUPTION = "CATALOG_BRIDGE_CATALOG_RUN_REHEARSAL_INTERRUPTED_BY_FAILPOINT";
const RESTART_REFUSAL =
  "CATALOG_BRIDGE_CATALOG_RUN_PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED";
const hash = (value) => plan.catalogBridgeDigest(value);
const repeatedHash = (letter) => letter.repeat(64);
const EXPECTED_IDENTITY_MULTISET_DIGEST = hash({
  cards: 191_383,
  packs: 69,
  kind: "final-multiset",
});

function fixtureId(operationId, number) {
  const prefix = operationId.startsWith("3") ? "3" : "4";
  return `${prefix}1000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function sourcePages(cardCount, packCount, reachesHead) {
  const total = cardCount + packCount;
  const pages = [];
  let cards = 0;
  let packs = 0;
  let requestedCursorHash = null;
  let previousChainDigest = null;
  for (let offset = 0, pageNumber = 1; offset < total; offset += 100, pageNumber += 1) {
    const returnedRecordCount = Math.min(100, total - offset);
    const cardDelta = Math.min(returnedRecordCount, cardCount - cards);
    const packDelta = returnedRecordCount - cardDelta;
    cards += cardDelta;
    packs += packDelta;
    const final = offset + returnedRecordCount === total;
    const continuation = final && reachesHead ? "head" : "more";
    const responseSha256 = hash({ pageNumber, cards, packs, kind: "response" });
    const pageIdentityMultisetDigest = hash({ pageNumber, cardDelta, packDelta });
    const identityChainDigest = providerCatalogIdentityChainDigest({
      previousChainDigest,
      pageNumber,
      pageResponseDigest: responseSha256,
      pageIdentityMultisetDigest,
    });
    const nextCursorHash = continuation === "more"
      ? hash({ pageNumber, kind: "next-cursor" })
      : null;
    pages.push(Object.freeze({ pageNumber, requestedCursorHash, nextCursorHash,
      requestedLimit: 100, returnedRecordCount, continuation, responseSha256,
      rawCardObservationCount: cards, rawPackObservationCount: packs,
      distinctCardIdentityCount: cards, distinctPackIdentityCount: packs,
      pageIdentityMultisetDigest, identityChainDigest,
      identityMultisetDigest: continuation === "head"
        ? hash({ cards, packs, kind: "final-multiset" }) : null }));
    requestedCursorHash = nextCursorHash;
    previousChainDigest = identityChainDigest;
  }
  return Object.freeze(pages);
}

function sourceCensusProof(definition, operationId, timing = "before_interruption") {
  const timeline = timing === "after_interruption"
    ? { capturedAt: "2026-09-02T20:00:02.000Z",
        first: ["2026-09-02T20:00:00.100Z", "2026-09-02T20:00:00.500Z"],
        second: ["2026-09-02T20:00:01.000Z", "2026-09-02T20:00:02.000Z"] }
    : timing === "at_interruption"
      ? { capturedAt: "2026-09-02T19:59:59.000Z",
          first: ["2026-09-02T19:59:57.000Z", "2026-09-02T19:59:58.000Z"],
          second: ["2026-09-02T19:59:58.500Z", "2026-09-02T19:59:59.000Z"] }
      : { capturedAt: "2026-09-02T19:58:04.000Z",
          first: ["2026-09-02T19:58:00.000Z", "2026-09-02T19:58:01.000Z"],
          second: ["2026-09-02T19:58:02.000Z", "2026-09-02T19:58:04.000Z"] };
  const pass = (passNumber, startedAt, completedAt) => ({ passNumber, startedAt,
    completedAt, pageCount: 1_915, sourceRequestCount: 1_915,
    sourceRecordCount: 191_452, rawCardObservationCount: 191_383,
    rawPackObservationCount: 69, distinctCardIdentityCount: 191_383,
    distinctPackIdentityCount: 69,
    identityMultisetDigest: EXPECTED_IDENTITY_MULTISET_DIGEST,
    traversalChainDigest: repeatedHash("a"), finalCursorHash: repeatedHash("b"),
    maximumResponseBytes: 1_000, totalResponseBytes: 1_915_000 });
  return censusProofModule.catalogBridgeSourceCensusSchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_source_census_v1",
    authorization: "operator_requested_read_only_catalog_source_census",
    operationId, providerKey: "collector_crypt", capturedAt: timeline.capturedAt,
    executor: { checkout: "/private/rehearsal/checkout", commit: "a".repeat(40),
      runnerModuleSha256: repeatedHash("3"), censusModuleSha256: repeatedHash("4"),
      inspectionModuleSha256: repeatedHash("5") },
    source: { providerId: definition.providerId, configId: definition.currentConfigId,
      configNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      catalogAdapterVersion: definition.catalogAdapterVersion,
      sourceCredentialDigest: repeatedHash("2"),
      pageLimit: definition.catalogManifest.requestBounds.pageLimit,
      requestTimeoutMilliseconds: definition.catalogManifest.requestBounds.timeoutMilliseconds,
      maximumResponseBytes: definition.catalogManifest.requestBounds.maximumResponseBytes },
    passes: [
      pass(1, ...timeline.first),
      pass(2, ...timeline.second),
    ],
    agreement: { sourceRecordCount: 191_452, cardCount: 191_383, packCount: 69,
      pageCount: 1_915, identityMultisetDigest: EXPECTED_IDENTITY_MULTISET_DIGEST,
      traversalChainDigest: repeatedHash("a"), finalCursorHash: repeatedHash("b") },
    databaseWritesPerformed: false, sourceRequestsPerformed: true,
    rawResponsesPersisted: false, rawCursorsPersisted: false,
    sourceRecordIdsPersisted: false,
  });
}

function buildCatalogFixture(operationId, source, options = {}) {
  const definition = plan.catalogBridgeProvider("collector_crypt");
  const censusProof = sourceCensusProof(
    definition,
    operationId,
    options.censusTiming ?? "before_interruption",
  );
  const censusFileSha256 =
    censusProofModule.catalogBridgeSourceCensusFileSha256(censusProof);
  const censusProofDigest = hash(censusProof);
  const cursor = { sourceInstanceId: definition.providerId,
    sourceRevisionId: definition.currentConfigId,
    sourceTypeKey: definition.currentEventManifest.sourceTypeKey,
    adapterVersion: definition.currentEventManifest.adapterVersion,
    cursorCodecKey: definition.currentEventManifest.cursorCodecKey,
    cursorGeneration: 1, value: "fixture-cursor-must-never-escape" };
  const cursorHash = providerMixedCursorFingerprint(cursor);
  const pins = { operationId, providerKey: definition.providerKey,
    operatorId: OPERATOR_ID, residentCheckout: "/private/rehearsal/checkout",
    residentCommit: "a".repeat(40), utilityModuleSha256: repeatedHash("b"),
    sourceHeadCountProvenance: "two_pass_read_only_catalog_census_v1",
    sourceHeadCounts: { ...definition.documentedCatalogFloor },
    sourceHeadCensusFileSha256: censusFileSha256,
    sourceHeadCensusProofDigest: censusProofDigest,
    sourceHeadIdentityMultisetDigest: EXPECTED_IDENTITY_MULTISET_DIGEST };
  const pause = options.drainFixture
    ? structuredClone(options.drainFixture.pause)
    : { commandId: fixtureId(operationId, 11), commandDigest: repeatedHash("0"),
        commandType: "pause", commandState: "completed",
        idempotencyKey: `catalog-bridge/${operationId}/running/pause`,
        targetRunId: null, targetQuarantineId: null, resultingRunId: null,
        requestedByOperatorId: OPERATOR_ID, expectedGeneration: "29",
        resultOutcome: "accepted", resultCode: "RUNTIME_TRANSITION_APPLIED",
        resultGeneration: "30", correlationId: operationId,
        reason: "DataForrest collector_crypt catalog bridge checkpoint drain",
        requestedAt: "2026-09-02T20:00:00.000Z",
        completedAt: "2026-09-02T20:00:01.000Z" };
  if (!options.drainFixture) {
    pause.commandDigest = plan.catalogBridgePauseCommandDigest(pause);
  }
  const latest = options.latestOverride ?? options.drainFixture?.latest ?? {
    runId: fixtureId(operationId, 12),
    runDigest: repeatedHash("9"), terminalKind: "interrupted_checkpoint",
    headProofDigest: null, state: "failed",
    failureCode: "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING", reachedSourceHead: false,
    finishedAt: "2026-09-02T19:59:59.000Z", pageCount: 3,
    finalCursorHash: cursorHash, lastPageNumber: 3,
    lastPageCursorHash: cursorHash, lastPageContinuation: "more",
    lastPageDigest: repeatedHash("8") };
  const baseline = { cards: 10, packs: 0, pulls: 7_000_000,
    marketEvents: 800_000, pullsDigest: repeatedHash("c"),
    marketEventsDigest: repeatedHash("d") };
  const drainReceipt = options.drainFixture?.receipt ?? {
    schemaVersion: "dataforrest_catalog_bridge_drain_receipt_v1", operationId,
    providerKey: definition.providerKey, providerId: definition.providerId,
    operatorId: OPERATOR_ID, entryKind: "running",
    currentConfigId: definition.currentConfigId,
    drainedAt: "2026-09-02T20:00:02.000Z", intentDigests: [repeatedHash("a")],
    pause: { commandId: pause.commandId, commandDigest: pause.commandDigest,
      expectedGeneration: pause.expectedGeneration, resultGeneration: pause.resultGeneration,
      reason: pause.reason, correlationId: pause.correlationId,
      requestedAt: pause.requestedAt, completedAt: pause.completedAt },
    terminal: { kind: latest.terminalKind, runId: latest.runId, runFence: "17",
      state: latest.state, failureCode: latest.failureCode,
      reachedSourceHead: latest.reachedSourceHead, finishedAt: latest.finishedAt,
      pageCount: latest.pageCount, finalCursorHash: latest.finalCursorHash,
      lastPageNumber: latest.lastPageNumber, lastPageCursorHash: latest.lastPageCursorHash,
      lastPageContinuation: latest.lastPageContinuation, runDigest: latest.runDigest,
      lastPageDigest: latest.lastPageDigest, headProofDigest: latest.headProofDigest },
    worker: { launchdLabel: definition.launchdLabel, initialPid: 90345,
      initialProcessIdentitySha256: repeatedHash("e"),
      bootoutReceiptDigest: repeatedHash("f"),
      offlineProcessEvidenceDigest: repeatedHash("0") },
    drainedEvidenceDigest: repeatedHash("a"),
  };
  const observation = { observedAt: "2026-09-02T20:00:03.000Z",
    repository: { checkout: pins.residentCheckout, expectedCommit: pins.residentCommit,
      observedCommit: pins.residentCommit, clean: true,
      utilityModuleSha256: pins.utilityModuleSha256 },
    worker: { launchdLabel: definition.launchdLabel, gracefullyUnloaded: true,
      processCount: 0, residencyPortListening: false,
      gracefulStopReceiptSha256: plan.catalogBridgeDigest(drainReceipt),
      gracefulStopReceipt: drainReceipt },
    central: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, providerRowVersion: "20",
      activeConfigId: definition.currentConfigId,
      activeConfigNumber: definition.currentConfigNumber,
      maximumConfigNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      configuration: { platform: definition.providerKey },
      configurationDigest: hash({ platform: definition.providerKey }),
      authorityDigest: repeatedHash("1"), sourceCredentialDigest: repeatedHash("2"),
      databaseRouteDigest: repeatedHash("3") },
    runtime: { providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort,
      databaseRole: "provider", schemaVersion: "distributed-provider-v1",
      runtimeState: "paused", generation: "30", rowVersion: "40",
      cachedConfigId: definition.currentConfigId,
      cachedConfigNumber: definition.currentConfigNumber,
      cachedConfiguration: { adapterKey: definition.currentEventManifest.adapterVersion,
        settings: { platform: definition.providerKey } }, sourceCursor: cursor,
      sourceCursorHash: cursorHash, activeRunCount: 0, actionableCommandCount: 0,
      importLeaseOwner: null, otherOwnedLeaseCount: 0,
      otherActiveTransactionCount: 0, pauseProvenance: pause,
      latestTerminalRun: latest },
    sourceCanaries: {
      catalogOrigin: { adapterVersion: definition.catalogAdapterVersion,
        requestedCursorHash: null, status: 200, recordCount: 2,
        cardCount: 1, packCount: 1, pullCount: 0, tradeCount: 0,
        responseSha256: repeatedHash("4"), nextCursorHash: repeatedHash("5"),
        checkedAt: "2026-09-02T20:00:02.000Z", responseBytes: 1000,
        durationMilliseconds: 10 },
      savedEventCursor: { adapterVersion: definition.eventSuccessorManifest.adapterVersion,
        requestedCursorHash: cursorHash, opaqueValueHash: hash(cursor.value), status: 200,
        recordCount: 1, responseSha256: repeatedHash("6"),
        checkedAt: "2026-09-02T20:00:02.000Z", responseBytes: 1000,
        durationMilliseconds: 10 },
    }, sourceCensus: { proof: censusProof, fileSha256: censusFileSha256,
      proofDigest: censusProofDigest }, baseline };
  const prepared = plan.prepareCatalogBridge({ pins, observation });
  const journal = state.createCatalogBridgeJournal(prepared.publicReceipt);
  const config = plan.catalogBridgeConfigurationPlan(prepared.privateState);
  const commit = { schemaVersion: "dataforrest_catalog_bridge_commit_v1", operationId,
    providerKey: definition.providerKey,
    privateStateSha256: hash(prepared.privateState), publicJournalSha256: hash(journal) };
  const catalogPolicy = policy.catalogBridgeCatalogLivePolicySchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_catalog_live_v1", environment: "live",
    authorization: "operator_requested_catalog_bridge_catalog_cutover", pins,
    journalDirectory: "/private/rehearsal/journal",
    capabilityProof: { path: "/private/rehearsal/capability.json",
      fileSha256: repeatedHash("e"), proofDigest: repeatedHash("f") },
    prepared: { privateStateSha256: commit.privateStateSha256,
      publicJournalSha256: commit.publicJournalSha256,
      journalHeadReceiptSha256: journal.headReceiptHash },
    current: { providerId: definition.providerId, configId: definition.currentConfigId,
      configNumber: definition.currentConfigNumber, providerRowVersion: "20",
      centralAuthorityDigest: observation.central.authorityDigest,
      databaseRouteDigest: observation.central.databaseRouteDigest,
      runtimeGeneration: "30", runtimeRowVersion: "40", sourceCursorHash: cursorHash,
      latestTerminalRunId: latest.runId, latestTerminalRunDigest: latest.runDigest,
      pauseCommandId: pause.commandId, pauseCommandDigest: pause.commandDigest },
    evidence: { drainReceiptSha256: observation.worker.gracefulStopReceiptSha256,
      catalogOriginCanarySha256: observation.sourceCanaries.catalogOrigin.responseSha256,
      savedEventCanarySha256: observation.sourceCanaries.savedEventCursor.responseSha256,
      baselineSha256: hash(baseline) },
    utility: { workerId: `catalog-bridge/${operationId}/collector_crypt/catalog-utility`,
      leaseMilliseconds: 60_000, oneShotModuleSha256: repeatedHash("e"),
      executionTimeoutMilliseconds:
        policy.catalogBridgeCatalogExecutionBudget(pins).executionTimeoutMilliseconds,
      pausePollMilliseconds: 50, pauseMaximumObservations: 2 },
    successorLaunchAgent: { stagedPath:
        `/private/rehearsal/${definition.launchdLabel}.plist`,
      installedPath: `/private/rehearsal/installed/${definition.launchdLabel}.plist`,
      fileSha256: repeatedHash("7"), nodePath: "/private/node",
      logPath: "/private/rehearsal/resident.log", residentModuleSha256: repeatedHash("6"),
      bootstrapPollMilliseconds: 50, bootstrapTimeoutMilliseconds: 1_000,
      startupMaximumObservations: 2, startupPollMilliseconds: 100 },
  });
  const ready = { observedAt: "2026-09-02T20:01:00.000Z", residentOffline: true,
    providerId: definition.providerId, providerKey: definition.providerKey,
    providerRowVersion: "20", centralAuthorityDigest: observation.central.authorityDigest,
    databaseRouteDigest: observation.central.databaseRouteDigest,
    activeConfigId: definition.currentConfigId,
    activeConfigNumber: definition.currentConfigNumber,
    maximumConfigNumber: definition.currentConfigNumber, runtimeState: "paused",
    runtimeGeneration: "30", runtimeRowVersion: "40",
    cachedConfigId: definition.currentConfigId,
    cachedConfigNumber: definition.currentConfigNumber, sourceCursorPresent: true,
    sourceCursorHash: cursorHash, latestTerminalRunId: latest.runId,
    latestTerminalRunDigest: latest.runDigest, pauseCommandId: pause.commandId,
    pauseCommandDigest: pause.commandDigest, activeRunCount: 0,
    actionableCommandCount: 0, importLeaseOwner: null,
    otherActiveTransactionCount: 0, canonical: baseline };
  const activated = { observedAt: "2026-09-02T20:02:00.000Z",
    centralActiveConfigId: config.catalog.id,
    centralActiveConfigNumber: config.catalog.versionNumber,
    centralActiveAdapterVersion: definition.catalogAdapterVersion,
    centralActiveConfigurationDigest: hash(config.catalog.configuration),
    providerRowVersion: "21", providerCachedConfigId: config.catalog.id,
    providerCachedConfigNumber: config.catalog.versionNumber,
    providerCachedConfigurationDigest: hash({ adapterKey: definition.catalogAdapterVersion,
      settings: config.catalog.configuration }), runtimeGeneration: "30",
    runtimeRowVersion: "41", sourceCursorHash: null, sourceCursorPresent: false,
    runtimeState: "paused", pauseCommandId: pause.commandId,
    pauseCommandDigest: pause.commandDigest, latestTerminalRunId: latest.runId,
    latestTerminalRunDigest: latest.runDigest, activeRunCount: 0,
    actionableCommandCount: 0, importLeaseOwner: null,
    otherActiveTransactionCount: 0, canonical: baseline };
  const admission = { observedAt: "2026-09-02T20:03:00.000Z", runtimeState: "idle",
    runtimeGeneration: "31", activeConfigId: config.catalog.id,
    cachedConfigId: config.catalog.id, sourceCursorPresent: false, sourceCursorHash: null,
    resumeCommandId: fixtureId(operationId, 13), resumeCommandDigest: repeatedHash("1"),
    resumeCommandType: "resume", resumeCommandState: "completed",
    resumeExpectedGeneration: "30", resumeResultGeneration: "31",
    pausedOriginGuardDigest: repeatedHash("2"),
    catalogRunId: prepared.privateState.catalogRunId, catalogRunState: "queued",
    catalogRunConfigId: config.catalog.id,
    catalogRunConfigNumber: config.catalog.versionNumber,
    catalogRunRequestedCursorHash: null, requestRunCommandId: fixtureId(operationId, 14),
    requestRunCommandDigest: repeatedHash("3"), utilityLeaseDigest: repeatedHash("4") };
  const last = source.at(-1);
  const head = { runId: prepared.privateState.catalogRunId, configId: config.catalog.id,
    configNumber: config.catalog.versionNumber, state: "succeeded", reachedHead: true,
    requestedCursorHash: null,
    sourceRecordCount: pins.sourceHeadCounts.card + pins.sourceHeadCounts.pack,
    catalogRecordCount: pins.sourceHeadCounts.card + pins.sourceHeadCounts.pack,
    cardRecordCount: pins.sourceHeadCounts.card, packRecordCount: pins.sourceHeadCounts.pack,
    distinctCardIdentityCount: pins.sourceHeadCounts.card,
    distinctPackIdentityCount: pins.sourceHeadCounts.pack,
    identityChainDigest: last.identityChainDigest,
    identityMultisetDigest: last.identityMultisetDigest, pullRecordCount: 0,
    marketEventRecordCount: 0, quarantinedCount: 0, finalCursorHash: repeatedHash("5"),
    runtimeState: "idle", activeRunCount: 0, actionableCommandCount: 0,
    importLeaseOwner: null,
    canonicalAfter: { ...baseline, cards: pins.sourceHeadCounts.card,
      packs: pins.sourceHeadCounts.pack } };
  return { definition, prepared, journal, commit, policy: catalogPolicy, config,
    ready, activated, admission, head, baseline, cursorHash, latest, pause };
}

function catalogOperation(value, source, mode, options = {}) {
  let journal = value.journal;
  let commit = value.commit;
  let executionCount = 0;
  let completed = false;
  const observedPages = [];
  const updateJournal = (next) => {
    journal = next;
    commit = { ...commit, publicJournalSha256: hash(next) };
    return commit;
  };
  const operation = {
    async readCommitted() {
      return { policy: value.policy, state: value.prepared.privateState, journal, commit };
    },
    async readSourcePages() { return structuredClone(observedPages); },
    async readDatabaseLineage() {
      return structuredClone(options.databaseLineage);
    },
    catalogDependencies: {
      async readPreparedBoundary() { return value.ready; },
      async activateCatalogConfiguration() { return value.activated; },
      async admitCatalogRun() { return value.admission; },
      async readCatalogHead() { return completed ? value.head : null; },
      async executeCatalogRun() {
        executionCount += 1;
        if (mode === "interrupted") {
          if (executionCount === 1) observedPages.push(...structuredClone(source));
          if (executionCount > 1 && options.sourceIoOnReuse) {
            observedPages.push(structuredClone(source[0]));
          }
          return { kind: "failed", runId: value.prepared.privateState.catalogRunId,
            failureCode: executionCount === 1
              ? "REHEARSAL_INTERRUPTED_BY_FAILPOINT"
              : "PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED" };
        }
        observedPages.push(...structuredClone(source));
        completed = true;
        return { kind: "completed", runId: value.prepared.privateState.catalogRunId };
      },
      async persistJournal({ next }) { return updateJournal(next); },
      async ensureResidentOfflineAndPaused() {},
    },
    updateJournal,
    get journal() { return journal; },
  };
  return operation;
}

function attachEventDependencies(operation, value, options = {}) {
  const catalogRunDigest = hash(value.head);
  const pause = { commandId: fixtureId(value.prepared.privateState.operationId, 15),
    commandDigest: repeatedHash("0"), commandType: "pause", commandState: "completed",
    idempotencyKey: `catalog-bridge/${value.prepared.privateState.operationId}/post-catalog/pause`,
    targetRunId: null, targetQuarantineId: null, resultingRunId: null,
    requestedByOperatorId: OPERATOR_ID, expectedGeneration: "31",
    resultOutcome: "accepted", resultCode: "RUNTIME_TRANSITION_APPLIED",
    resultGeneration: "32", correlationId: value.prepared.privateState.operationId,
    reason: "DataForrest collector_crypt catalog bridge post-catalog pause",
    requestedAt: "2026-09-02T20:05:01.000Z",
    completedAt: "2026-09-02T20:05:02.000Z" };
  pause.commandDigest = plan.catalogBridgePauseCommandDigest(pause);
  const staged = { observedAt: "2026-09-02T20:06:00.000Z",
    centralActiveConfigId: value.config.catalog.id, centralProviderRowVersion: "21",
    stagedConfigId: value.config.eventSuccessor.id,
    stagedConfigNumber: value.config.eventSuccessor.versionNumber,
    stagedAdapterVersion: value.config.eventSuccessor.adapterVersion,
    stagedConfigurationDigest: hash(value.config.eventSuccessor.configuration),
    activationProofDigest: repeatedHash("8"),
    providerStillAtCatalogConfigId: value.config.catalog.id, activeRunCount: 0,
    actionableCommandCount: 0, importLeaseOwner: null, runtimeState: "paused",
    runtimeGeneration: "32", runtimeRowVersion: "44", pauseCommandId: pause.commandId,
    pauseCommandDigest: pause.commandDigest, pauseCommandType: pause.commandType,
    pauseCommandState: pause.commandState, pauseIdempotencyKey: pause.idempotencyKey,
    pauseTargetRunId: null, pauseTargetQuarantineId: null, pauseResultingRunId: null,
    pauseRequestedByOperatorId: pause.requestedByOperatorId,
    pauseExpectedGeneration: pause.expectedGeneration,
    pauseResultOutcome: pause.resultOutcome, pauseResultCode: pause.resultCode,
    pauseResultGeneration: pause.resultGeneration,
    pauseCorrelationId: pause.correlationId, pauseReason: pause.reason,
    pauseRequestedAt: pause.requestedAt, pauseCompletedAt: pause.completedAt,
    latestTerminalRunId: value.prepared.privateState.catalogRunId,
    latestTerminalRunDigest: catalogRunDigest };
  const restored = plan.reEnvelopeSavedEventCursor(value.prepared.privateState);
  const restoredObservation = { observedAt: "2026-09-02T20:07:00.000Z",
    centralActiveConfigId: value.config.eventSuccessor.id,
    centralActiveConfigNumber: value.config.eventSuccessor.versionNumber,
    centralActiveAdapterVersion: value.config.eventSuccessor.adapterVersion,
    centralActiveConfigurationDigest: hash(value.config.eventSuccessor.configuration),
    providerRowVersion: "22", providerCachedConfigId: value.config.eventSuccessor.id,
    providerCachedConfigNumber: value.config.eventSuccessor.versionNumber,
    providerCachedConfigurationDigest: hash({ adapterKey: value.config.eventSuccessor.adapterVersion,
      settings: value.config.eventSuccessor.configuration }), runtimeGeneration: "32",
    runtimeRowVersion: "45", sourceCursorHash: restored.cursorHash,
    sourceCursorPresent: true, runtimeState: "paused", pauseCommandId: pause.commandId,
    pauseCommandDigest: pause.commandDigest,
    latestTerminalRunId: value.prepared.privateState.catalogRunId,
    latestTerminalRunDigest: catalogRunDigest, activeRunCount: 0,
    actionableCommandCount: 0, importLeaseOwner: null, otherActiveTransactionCount: 0,
    canonical: value.head.canonicalAfter, restoredCursorHash: restored.cursorHash,
    restoredOpaqueValueHash: restored.opaqueValueHash,
    cursorEnvelopeDigest: hash(restored.cursor) };
  const resumed = { observedAt: "2026-09-02T20:10:00.000Z",
    launchdLabel: value.definition.launchdLabel, processCount: 1,
    residencyPortListening: true, activeConfigId: value.config.eventSuccessor.id,
    cachedConfigId: value.config.eventSuccessor.id,
    startupRunId: state.catalogBridgeResumeRunId(
      value.prepared.privateState.operationId,
      value.definition.providerKey,
    ), startupRunState: "succeeded", startupRunRequestedCursorHash: restored.cursorHash,
    startupRunReachedHead: true, activeRunCount: 0, actionableCommandCount: 0,
    importLeaseOwner: null };
  const ready = () => ({ observedAt: "2026-09-02T20:05:30.000Z", residentOffline: true,
    runtimeState: "paused", activeRunCount: 0, actionableCommandCount: 0,
    importLeaseOwner: null, importLeaseHeartbeatAt: null, importLeaseExpiresAt: null,
    otherActiveTransactionCount: 0,
    activeConfigId: value.config.catalog.id, cachedConfigId: value.config.catalog.id,
    stagedLaunchAgentSha256: value.policy.successorLaunchAgent.fileSha256 });
  operation.eventDependencies = {
    async readEventBoundary() { return ready(); },
    async stageEventSuccessor() { return staged; },
    async restoreEventCursor() { return restoredObservation; },
    async resumeResident() { return resumed; },
    async readResumed() { return resumed; },
    async releaseResidentAfterJournal() {},
    async persistJournal({ next }) { return operation.updateJournal(next); },
    async ensureResidentOfflineAndPaused() {},
  };
  let canonicalReadCount = 0;
  operation.readCanonicalEvidence = async () => {
    canonicalReadCount += 1;
    const canonical = canonicalReadCount > 1 && options.afterHandoffCanonical
      ? options.afterHandoffCanonical
      : value.head.canonicalAfter;
    return structuredClone(canonical);
  };
  return operation;
}

function processObservation(definition, online) {
  return { launchdLabel: definition.launchdLabel, launchdLoaded: online,
    processCount: online ? 1 : 0, pids: online ? [99123] : [],
    processIdentitySha256: online ? repeatedHash("a") : null,
    residencyPort: definition.residencyPort, residencyPortListening: online };
}

function drainDependencies() {
  const definition = plan.catalogBridgeProvider("collector_crypt");
  const pins = { operationId: INTERRUPTED_OPERATION, providerKey: "collector_crypt",
    operatorId: OPERATOR_ID };
  const cursor = { sourceInstanceId: definition.providerId,
    sourceRevisionId: definition.currentConfigId,
    sourceTypeKey: definition.currentEventManifest.sourceTypeKey,
    adapterVersion: definition.currentEventManifest.adapterVersion,
    cursorCodecKey: definition.currentEventManifest.cursorCodecKey,
    cursorGeneration: 1, value: "fixture-cursor-must-never-escape" };
  const cursorHash = providerMixedCursorFingerprint(cursor);
  const entry = { observedAt: "2026-09-02T19:50:00.000Z",
    databaseNow: "2026-09-02T19:50:00.000Z",
    central: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, providerRowVersion: "4",
      activeConfigId: definition.currentConfigId,
      activeConfigNumber: definition.currentConfigNumber,
      maximumConfigNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.currentEventManifest.adapterVersion,
      configuration: { platform: definition.providerKey },
      configurationDigest: hash({ platform: definition.providerKey }),
      authorityDigest: repeatedHash("b") },
    runtime: { providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort,
      databaseRole: "provider", schemaVersion: "distributed-provider-v1", state: "running",
      generation: "29", rowVersion: "50", cachedConfigId: definition.currentConfigId,
      cachedConfigNumber: definition.currentConfigNumber,
      cachedConfiguration: { adapterKey: definition.currentEventManifest.adapterVersion,
        settings: { platform: definition.providerKey } }, sourceCursor: cursor,
      sourceCursorHash: cursorHash, activeRunCount: 1, actionableCommandCount: 0,
      otherOwnedLeaseCount: 0, otherActiveTransactionCount: 0 },
    importLease: { owner: "provider-import:collector", fence: "14",
      expiresAt: "2026-09-02T19:52:00.000Z" },
    run: { id: fixtureId(INTERRUPTED_OPERATION, 12), state: "running",
      configId: definition.currentConfigId, configNumber: definition.currentConfigNumber,
      workerFence: "14", pageCount: 3, reachedSourceHead: false, finishedAt: null,
      failureCode: null, finalCursor: cursor, finalCursorHash: cursorHash,
      runDigest: repeatedHash("c") },
    lastPage: { id: fixtureId(INTERRUPTED_OPERATION, 22), pageNumber: 3,
      nextCursor: cursor, nextCursorHash: cursorHash, continuation: "more",
      lastPageDigest: repeatedHash("d") }, headProof: null,
    process: processObservation(definition, true) };
  const paused = structuredClone(entry);
  Object.assign(paused, { observedAt: "2026-09-02T19:50:01.000Z",
    databaseNow: "2026-09-02T19:50:01.000Z" });
  Object.assign(paused.runtime, { state: "paused", generation: "30", rowVersion: "52",
    activeRunCount: 0 });
  Object.assign(paused.importLease, { owner: null, expiresAt: null });
  Object.assign(paused.run, { state: "incomplete", finishedAt: "2026-09-02T19:50:00.500Z",
    failureCode: "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE" });
  const offline = structuredClone(paused);
  offline.observedAt = "2026-09-02T19:50:02.000Z";
  offline.databaseNow = "2026-09-02T19:50:02.000Z";
  offline.process = processObservation(definition, false);
  const intent = drainPolicy.createCatalogBridgePauseIntent({ pins, boundary: entry,
    kind: "running" });
  const command = { id: intent.commandId, idempotencyKey: intent.idempotencyKey,
    commandType: "pause", state: "completed", targetRunId: null,
    targetQuarantineId: null, expectedGeneration: intent.expectedGeneration,
    requestedByOperatorId: intent.operatorId, correlationId: intent.operationId,
    reason: intent.reason, resultOutcome: "accepted",
    resultCode: "RUNTIME_TRANSITION_APPLIED", resultGeneration: "30",
    resultingRunId: null, requestedAt: "2026-09-02T19:50:00.100Z",
    completedAt: "2026-09-02T19:50:00.200Z" };
  const bootoutReceipt = { launchdLabel: definition.launchdLabel,
    expectedPid: entry.process.pids[0],
    expectedProcessIdentitySha256: entry.process.processIdentitySha256,
    requestedAt: "2026-09-02T19:50:01.100Z",
    completedAt: "2026-09-02T19:50:01.200Z", outcome: "unloaded" };
  const expectedReceipt = drainPolicy.createCatalogBridgeDrainReceipt({ pins,
    entryKind: "running", intents: [intent], command, finalBoundary: offline,
    initialProcess: entry.process, bootoutReceipt });
  const pause = { commandId: command.id, commandDigest: hash(command),
    commandType: command.commandType, commandState: command.state,
    idempotencyKey: command.idempotencyKey, targetRunId: command.targetRunId,
    targetQuarantineId: command.targetQuarantineId,
    resultingRunId: command.resultingRunId,
    requestedByOperatorId: command.requestedByOperatorId,
    expectedGeneration: command.expectedGeneration,
    resultOutcome: command.resultOutcome, resultCode: command.resultCode,
    resultGeneration: command.resultGeneration, correlationId: command.correlationId,
    reason: command.reason, requestedAt: command.requestedAt,
    completedAt: command.completedAt };
  const terminal = expectedReceipt.terminal;
  const latest = { runId: terminal.runId, runDigest: terminal.runDigest,
    terminalKind: terminal.kind, headProofDigest: terminal.headProofDigest,
    state: terminal.state, failureCode: terminal.failureCode,
    reachedSourceHead: terminal.reachedSourceHead, finishedAt: terminal.finishedAt,
    pageCount: terminal.pageCount, finalCursorHash: terminal.finalCursorHash,
    lastPageNumber: terminal.lastPageNumber,
    lastPageCursorHash: terminal.lastPageCursorHash,
    lastPageContinuation: terminal.lastPageContinuation,
    lastPageDigest: terminal.lastPageDigest };
  const queue = [entry, paused, offline];
  let receipt = null;
  return {
    pins,
    options: { maximumObservations: 1, pollMilliseconds: 1 },
    dependencies: {
      async readExistingReceipt() { return receipt; },
      async readBoundary() { return structuredClone(queue.length > 1 ? queue.shift() : queue[0]); },
      async recordPauseIntent(intent) {
        return { intentDigest: hash(intent), exactRetry: false };
      },
      async submitPause(submittedIntent) {
        return { commandId: submittedIntent.commandId, outcome: "accepted",
          code: "RUNTIME_TRANSITION_APPLIED", state: "paused", generation: "30" };
      },
      async readPauseCommand(id) {
        return id === command.id ? structuredClone(command) : null;
      },
      async bootout() { return structuredClone(bootoutReceipt); },
      async wait() {},
      async persistReceipt(value) { receipt = structuredClone(value);
        return { sha256: hash(value), exactRetry: false }; },
    },
    binding: { receipt: expectedReceipt, pause, latest },
  };
}

function rebindRecoveryState(fixture, mutate) {
  const privateState = structuredClone(fixture.prepared.privateState);
  mutate(privateState);
  const privateStateSha256 = hash(privateState);
  fixture.prepared = { ...fixture.prepared, privateState };
  fixture.commit = { ...fixture.commit, privateStateSha256 };
  fixture.policy = { ...fixture.policy, prepared: {
    ...fixture.policy.prepared, privateStateSha256,
  } };
}

function buildHarness(options = {}) {
  const interruptedPages = sourcePages(200, 0, false);
  const validCompletePages = sourcePages(191_383, 69, true);
  const completePages = options.invalidPageLimit
    ? Object.freeze([{ ...validCompletePages[0], requestedLimit: 101 },
        ...validCompletePages.slice(1)])
    : validCompletePages;
  const drain = drainDependencies();
  const interruptedFixture = buildCatalogFixture(INTERRUPTED_OPERATION, interruptedPages,
    options.separateDrain ? {} : { drainFixture: drain.binding });
  const latest = { ...interruptedFixture.latest,
    runId: interruptedFixture.prepared.privateState.catalogRunId,
    runDigest: repeatedHash("7"), pageCount: interruptedPages.length,
    lastPageNumber: interruptedPages.length,
    finishedAt: "2026-09-02T19:59:59.000Z" };
  const recoveryFixture = buildCatalogFixture(RECOVERY_OPERATION, completePages, {
    latestOverride: latest,
    censusTiming: options.reuseInterruptedCensus
      ? "before_interruption"
      : options.censusCapturedAtInterruption
        ? "at_interruption"
        : "after_interruption",
  });
  if (options.invalidRecoveryRepositoryBinding) {
    rebindRecoveryState(recoveryFixture, (privateState) => {
      privateState.preflight.repository.observedCommit = "b".repeat(40);
    });
  }
  if (options.invalidRecoveryDatabaseRoute) {
    rebindRecoveryState(recoveryFixture, (privateState) => {
      privateState.preflight.central.databaseRouteDigest = repeatedHash("6");
    });
  }
  const proofLevels = options.claimProductionShaped
    ? { database: "migrated_disposable_postgresql", process: "isolated_darwin_launchd",
        source: "live_dataforrest_api" }
    : { database: "deterministic_fake", process: "deterministic_fake",
        source: "deterministic_fake" };
  const databaseInstanceSha256 = hash({ kind: "rehearsal-database-instance" });
  const interruptedDatabaseLineage = {
    databaseInstanceSha256,
    latestTerminalRunId: latest.runId,
    latestTerminalRunDigest: options.staleInterruptedRunDigest
      ? repeatedHash("8") : latest.runDigest,
  };
  const recoveryDatabaseLineage = {
    databaseInstanceSha256: options.differentRecoveryDatabaseInstance
      ? hash({ kind: "copied-independent-rehearsal-database" })
      : databaseInstanceSha256,
    latestTerminalRunId: latest.runId,
    latestTerminalRunDigest: latest.runDigest,
  };
  const interrupted = catalogOperation(interruptedFixture, interruptedPages, "interrupted",
    { sourceIoOnReuse: options.sourceIoOnReuse,
      databaseLineage: interruptedDatabaseLineage });
  const afterHandoffCanonical = options.deleteCatalogRowsAfterHandoff
    ? { ...recoveryFixture.head.canonicalAfter, cards: 10, packs: 0 }
    : null;
  const recovery = attachEventDependencies(
    catalogOperation(recoveryFixture, completePages, "recovery",
      { databaseLineage: recoveryDatabaseLineage }),
    recoveryFixture,
    { afterHandoffCanonical },
  );
  const databaseProofDigest = rehearsal.catalogBridgeRehearsalDatabaseProofDigest({
    schemaVersion: "dataforrest_catalog_bridge_rehearsal_database_binding_v1",
    declaredLevel: proofLevels.database,
    databaseInstanceSha256,
    interruptedOperationId: interruptedFixture.prepared.privateState.operationId,
    interruptedCatalogRunId: interruptedFixture.prepared.privateState.catalogRunId,
    recoveryOperationId: recoveryFixture.prepared.privateState.operationId,
    recoveryCatalogRunId: recoveryFixture.prepared.privateState.catalogRunId,
    latestInterruptedRunId: latest.runId,
    latestInterruptedRunDigest: latest.runDigest,
  });
  return { proof: { database: { level: proofLevels.database,
      databaseInstanceSha256,
      evidenceSha256: options.invalidDatabaseProofDigest
        ? repeatedHash("1") : databaseProofDigest }, process: { level: proofLevels.process,
      evidenceSha256: repeatedHash("2") }, source: { level: proofLevels.source,
      evidenceSha256: repeatedHash("3") }, isolationEvidenceSha256: repeatedHash("4") },
    drain: { pins: drain.pins, options: drain.options, dependencies: drain.dependencies },
    interrupted, recovery,
    expectedInterruptionCode: INTERRUPTION, expectedReuseRefusalCode: RESTART_REFUSAL,
    now: () => new Date("2026-09-02T20:11:00.000Z") };
}

test("runs the real cores but marks fixture evidence non-certifying and config retry blocked", async () => {
  const evidence = await rehearsal.rehearseDataforrestCatalogBridge(buildHarness());
  assert.equal(evidence.classification, "non_certifying_hybrid");
  assert.equal(evidence.certificationBoundary,
    "external_attesting_host_binder_required");
  assert.equal(evidence.readiness.status, "blocked");
  assert.equal(evidence.readiness.freshOperationConfigProgression,
    "failed_fixed_current_config_3");
  assert.equal(evidence.readiness.blockerCode,
    "CATALOG_BRIDGE_REHEARSAL_FIXED_CONFIG_3_RETRY_UNSUPPORTED");
  assert.equal(evidence.readiness.expectedRecoveryBaseConfigNumber,
    evidence.readiness.observedPolicyCurrentConfigNumber + 1);
  assert.equal(evidence.readiness.observedPolicyCurrentConfigId,
    evidence.readiness.observedCentralActiveConfigId);
  assert.equal(evidence.readiness.observedPolicyCurrentConfigId,
    evidence.readiness.observedRuntimeCachedConfigId);
  assert.equal(evidence.readiness.plannedRecoveryCatalogConfigNumber,
    evidence.readiness.expectedRecoveryBaseConfigNumber);
  assert.ok(evidence.readiness.plannedRecoveryEventSuccessorConfigNumber >
    evidence.readiness.plannedRecoveryCatalogConfigNumber);
  assert.equal(evidence.databaseLineage.databaseInstanceSha256,
    evidence.proof.database.databaseInstanceSha256);
  assert.equal(evidence.databaseLineage.databaseProofDigest,
    evidence.proof.database.evidenceSha256);
  assert.notEqual(evidence.interrupted.operationId, evidence.recovery.operationId);
  assert.notEqual(evidence.interrupted.catalogRunId, evidence.recovery.catalogRunId);
  assert.equal(evidence.interrupted.pageCount, 2);
  assert.equal(evidence.interrupted.finalContinuation, "more");
  assert.equal(evidence.reuseRefusal.sourceRequestCountBefore,
    evidence.reuseRefusal.sourceRequestCountAfter);
  assert.equal(evidence.recovery.pageCount, 1_915);
  assert.equal(evidence.recovery.maximumRequestedLimit, 100);
  assert.equal(evidence.recovery.maximumReturnedRecordCount, 100);
  assert.equal(evidence.recovery.rawCardObservationCount, 191_383);
  assert.equal(evidence.recovery.rawPackObservationCount, 69);
  assert.equal(evidence.recovery.quarantinedCount, 0);
  assert.notEqual(evidence.censusRecovery.interruptedCensusFileSha256,
    evidence.censusRecovery.recoveryCensusFileSha256);
  assert.notEqual(evidence.censusRecovery.interruptedCensusProofDigest,
    evidence.censusRecovery.recoveryCensusProofDigest);
  assert.ok(Date.parse(evidence.censusRecovery.recoveryCensusCapturedAt) >
    Date.parse(evidence.censusRecovery.interruptedTerminalFinishedAt));
  assert.equal(evidence.canonicalContinuity.postCatalog.cards, 191_383);
  assert.equal(evidence.canonicalContinuity.postCatalog.packs, 69);
  assert.deepEqual(evidence.canonicalContinuity.afterHandoff,
    evidence.canonicalContinuity.postCatalog);
  assert.equal(evidence.unrelatedEvents.pullCountBefore,
    evidence.unrelatedEvents.pullCountAfter);
  assert.equal(evidence.unrelatedEvents.marketEventsDigestBefore,
    evidence.unrelatedEvents.marketEventsDigestAfter);
  assert.equal(evidence.cursorAndHandoff.savedOpaqueValueHash,
    evidence.cursorAndHandoff.restoredOpaqueValueHash);
  assert.equal(evidence.cursorAndHandoff.restoredEventCursorHash,
    evidence.cursorAndHandoff.startupRunRequestedCursorHash);
  assert.equal(evidence.cursorAndHandoff.startupRunReachedHead, true);
  assert.equal(JSON.stringify(evidence).includes("fixture-cursor-must-never-escape"), false);
  assert.deepEqual(rehearsal.catalogBridgeRehearsalEvidenceSchema.parse(evidence), evidence);
});

test("strict evidence schema rejects forged production-shaped fixture certification", async () => {
  const evidence = await rehearsal.rehearseDataforrestCatalogBridge(buildHarness());
  const forged = { ...evidence, classification: "production_shaped_candidate" };
  const { evidenceSha256: ignored, ...withoutDigest } = forged;
  forged.evidenceSha256 = hash(withoutDigest);
  assert.throws(() => rehearsal.catalogBridgeRehearsalEvidenceSchema.parse(forged),
    /non_certifying_hybrid/u);
  assert.throws(() => rehearsal.catalogBridgeRehearsalEvidenceSchema.parse({
    ...evidence, unexpected: "secret-shaped-field",
  }));
});

test("caller-claimed real adapters remain non-certifying and require a host attestor", async () => {
  const evidence = await rehearsal.rehearseDataforrestCatalogBridge(
    buildHarness({ claimProductionShaped: true }),
  );
  assert.equal(evidence.proof.database.level, "migrated_disposable_postgresql");
  assert.equal(evidence.proof.process.level, "isolated_darwin_launchd");
  assert.equal(evidence.proof.source.level, "live_dataforrest_api");
  assert.equal(evidence.readiness.status, "blocked");
  assert.equal(evidence.classification, "non_certifying_hybrid");
  assert.equal(evidence.certificationBoundary,
    "external_attesting_host_binder_required");
});

test("reuse must refuse before making another source request", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(buildHarness({ sourceIoOnReuse: true })),
    { code: "CATALOG_BRIDGE_REHEARSAL_REUSE_PERFORMED_SOURCE_IO" },
  );
});

test("every source request is hard bounded to at most 100 records", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(buildHarness({ invalidPageLimit: true })),
    { code: "CATALOG_BRIDGE_REHEARSAL_SOURCE_TRACE_INVALID" },
  );
});

test("fresh recovery requires a distinct census captured after the failed run", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ reuseInterruptedCensus: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_FRESH_OPERATION_INVALID" },
  );
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ censusCapturedAtInterruption: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_FRESH_OPERATION_INVALID" },
  );
});

test("fresh recovery requires exact clean-repository census binding", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ invalidRecoveryRepositoryBinding: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_CENSUS_REPOSITORY_BINDING_INVALID" },
  );
});

test("fresh recovery cannot cross provider database routes", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ invalidRecoveryDatabaseRoute: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_PROVIDER_DATABASE_LINEAGE_INVALID" },
  );
});

test("successor handoff cannot delete or revert recovered catalog rows", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ deleteCatalogRowsAfterHandoff: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_CANONICAL_CONTINUITY_INVALID" },
  );
});

test("drain evidence must be the receipt embedded in the interrupted state", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(buildHarness({ separateDrain: true })),
    { code: "CATALOG_BRIDGE_REHEARSAL_DRAIN_BINDING_INVALID" },
  );
});

test("fresh recovery must observe the same database instance and durable failed run", async () => {
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ differentRecoveryDatabaseInstance: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_DATABASE_LINEAGE_INVALID" },
  );
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ staleInterruptedRunDigest: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_DATABASE_LINEAGE_INVALID" },
  );
  await assert.rejects(
    rehearsal.rehearseDataforrestCatalogBridge(
      buildHarness({ invalidDatabaseProofDigest: true }),
    ),
    { code: "CATALOG_BRIDGE_REHEARSAL_DATABASE_LINEAGE_INVALID" },
  );
});
