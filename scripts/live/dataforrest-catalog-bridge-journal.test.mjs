import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const journalModule = await tsImport("./dataforrest-catalog-bridge-journal.mts", import.meta.url);
const stateModule = await tsImport("./dataforrest-catalog-bridge-state.mts", import.meta.url);
const cli = await tsImport("./prepare-dataforrest-catalog-bridge.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);

const secret = "private-saved-cursor-for-journal-test";
const hash = (letter) => letter.repeat(64);

function preparationDocument() {
  const definition = plan.catalogBridgeProvider("collector_crypt");
  const cursor = { sourceInstanceId: definition.providerId, sourceRevisionId: definition.currentConfigId,
    sourceTypeKey: definition.eventManifest.sourceTypeKey, adapterVersion: definition.eventManifest.adapterVersion,
    cursorCodecKey: definition.eventManifest.cursorCodecKey, cursorGeneration: 1, value: secret };
  const sourceCursorHash = providerMixedCursorFingerprint(cursor);
  const pins = { operationId: "20000000-0000-4000-8000-000000000001", providerKey: definition.providerKey,
    operatorId: "20000000-0000-4000-8000-000000000002", residentCheckout: "/approved/resident",
    residentCommit: "a".repeat(40), utilityModuleSha256: hash("b"),
    sourceHeadCountProvenance: "manually_reviewed_exact_source_head_counts_v1",
    sourceHeadCounts: { ...definition.documentedCatalogFloor } };
  const observation = { observedAt: "2026-09-01T03:00:00.000Z",
    repository: { checkout: pins.residentCheckout, expectedCommit: pins.residentCommit,
      observedCommit: pins.residentCommit, clean: true, utilityModuleSha256: pins.utilityModuleSha256 },
    worker: { launchdLabel: definition.launchdLabel, gracefullyUnloaded: true, processCount: 0,
      residencyPortListening: false, gracefulStopReceiptSha256: hash("c") },
    central: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, providerRowVersion: "4", activeConfigId: definition.currentConfigId,
      activeConfigNumber: definition.currentConfigNumber, maximumConfigNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.eventManifest.adapterVersion,
      configuration: { platform: definition.providerKey },
      configurationDigest: plan.catalogBridgeDigest({ platform: definition.providerKey }),
      authorityDigest: hash("e"), sourceCredentialDigest: hash("f"),
      databaseRouteDigest: hash("1") },
    runtime: { providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort, databaseRole: "provider",
      schemaVersion: "distributed-provider-v1", runtimeState: "paused", generation: "7", rowVersion: "8",
      cachedConfigId: definition.currentConfigId, cachedConfigNumber: definition.currentConfigNumber,
      cachedConfiguration: { adapterKey: definition.eventManifest.adapterVersion,
        settings: { platform: definition.providerKey } },
      sourceCursor: cursor, sourceCursorHash, activeRunCount: 0, actionableCommandCount: 0,
      importLeaseOwner: null, otherOwnedLeaseCount: 0, otherActiveTransactionCount: 0,
      pauseProvenance: { commandId: "20000000-0000-4000-8000-000000000003", commandDigest: hash("7"),
        commandType: "pause", commandState: "completed",
        idempotencyKey: `catalog-bridge/${pins.operationId}/running/pause`, targetRunId: null,
        targetQuarantineId: null, resultingRunId: null, requestedByOperatorId: pins.operatorId,
        expectedGeneration: "6", resultOutcome: "accepted", resultCode: "RUNTIME_TRANSITION_APPLIED",
        resultGeneration: "7", correlationId: pins.operationId,
        reason: `DataForrest ${definition.providerKey} catalog bridge checkpoint drain`,
        requestedAt: "2026-09-01T02:55:00.000Z", completedAt: "2026-09-01T02:55:05.000Z" },
      latestTerminalRun: { runId: "20000000-0000-4000-8000-000000000005", runDigest: hash("8"),
        terminalKind: "interrupted_checkpoint", headProofDigest: null,
        state: "failed", failureCode: "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING", reachedSourceHead: false,
        finishedAt: "2026-09-01T02:55:06.000Z", pageCount: 4, finalCursorHash: sourceCursorHash,
        lastPageNumber: 4, lastPageCursorHash: sourceCursorHash, lastPageContinuation: "more",
        lastPageDigest: hash("9") } },
    sourceCanaries: {
      catalogOrigin: { adapterVersion: definition.catalogAdapterVersion, requestedCursorHash: null, status: 200,
        recordCount: 2, cardCount: 1, packCount: 1, pullCount: 0, tradeCount: 0,
        responseSha256: hash("2"), nextCursorHash: hash("3"), checkedAt: "2026-09-01T02:59:30.000Z",
        responseBytes: 1000, durationMilliseconds: 10 },
      savedEventCursor: { adapterVersion: definition.eventManifest.adapterVersion, requestedCursorHash: sourceCursorHash,
        opaqueValueHash: plan.catalogBridgeDigest(secret), status: 200, recordCount: 1,
        responseSha256: hash("4"), checkedAt: "2026-09-01T02:59:45.000Z",
        responseBytes: 1000, durationMilliseconds: 10 },
    },
    baseline: { cards: 1, packs: 0, pulls: 2, marketEvents: 3,
      pullsDigest: hash("5"), marketEventsDigest: hash("6") } };
  observation.runtime.pauseProvenance.commandDigest =
    plan.catalogBridgePauseCommandDigest(observation.runtime.pauseProvenance);
  const latest = observation.runtime.latestTerminalRun;
  const pause = observation.runtime.pauseProvenance;
  observation.worker.gracefulStopReceipt = {
    schemaVersion: "dataforrest_catalog_bridge_drain_receipt_v1", operationId: pins.operationId,
    providerKey: definition.providerKey, providerId: definition.providerId, operatorId: pins.operatorId,
    entryKind: "running", currentConfigId: definition.currentConfigId,
    drainedAt: "2026-09-01T02:56:00.000Z", intentDigests: [hash("a")],
    pause: { commandId: pause.commandId, commandDigest: pause.commandDigest,
      expectedGeneration: pause.expectedGeneration, resultGeneration: pause.resultGeneration,
      reason: pause.reason, correlationId: pause.correlationId,
      requestedAt: pause.requestedAt, completedAt: pause.completedAt },
    terminal: { kind: latest.terminalKind, runId: latest.runId, runFence: "21", state: latest.state,
      failureCode: latest.failureCode, reachedSourceHead: latest.reachedSourceHead, finishedAt: latest.finishedAt,
      pageCount: latest.pageCount, finalCursorHash: latest.finalCursorHash,
      lastPageNumber: latest.lastPageNumber, lastPageCursorHash: latest.lastPageCursorHash,
      lastPageContinuation: latest.lastPageContinuation, runDigest: latest.runDigest,
      lastPageDigest: latest.lastPageDigest, headProofDigest: latest.headProofDigest },
    worker: { launchdLabel: definition.launchdLabel, initialPid: 90234,
      initialProcessIdentitySha256: hash("b"), bootoutReceiptDigest: hash("c"),
      offlineProcessEvidenceDigest: hash("d") }, drainedEvidenceDigest: hash("a"),
  };
  observation.worker.gracefulStopReceiptSha256 = plan.catalogBridgeDigest(observation.worker.gracefulStopReceipt);
  return { pins, observation };
}

test("private journal is mode-bounded, publicly redacted and exactly retryable after a partial crash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "packscout-catalog-bridge-"));
  const directory = path.join(root, "journal");
  try {
    const prepared = plan.prepareCatalogBridge(preparationDocument());
    const first = await journalModule.persistPreparedCatalogBridge({ directory, ...prepared });
    assert.equal(first.exactRetry, false);
    const privateBytes = await readFile(path.join(directory, "private-state.json"), "utf8");
    const publicBytes = await readFile(path.join(directory, "public-journal.json"), "utf8");
    assert.equal(privateBytes.includes(secret), true);
    assert.equal(publicBytes.includes(secret), false);
    assert.equal(publicBytes.includes("savedEventCursor\""), false);
    await unlink(path.join(directory, "commit.json"));
    await unlink(path.join(directory, "public-journal.json"));
    const recovered = await journalModule.persistPreparedCatalogBridge({ directory, ...prepared });
    assert.equal(recovered.exactRetry, false);
    const read = await journalModule.readPreparedCatalogBridge(directory);
    assert.equal(read.privateState.savedEventCursor.value, secret);
    assert.equal(read.journal.phase, "prepared");
    const retry = await journalModule.persistPreparedCatalogBridge({ directory, ...prepared });
    assert.equal(retry.exactRetry, true);
    const changed = structuredClone(prepared);
    changed.privateState.savedEventCursor.value = "changed";
    await assert.rejects(journalModule.persistPreparedCatalogBridge({ directory, ...changed }),
      { code: "CATALOG_BRIDGE_RETRY_EVIDENCE_CHANGED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("journal authority remains on the prior phase when the convenience copy cannot commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "packscout-catalog-journal-cas-"));
  const directory = path.join(root, "journal");
  try {
    const prepared = plan.prepareCatalogBridge(preparationDocument());
    const first = await journalModule.persistPreparedCatalogBridge({ directory, ...prepared });
    const configuration = plan.catalogBridgeConfigurationPlan(prepared.privateState);
    const runtime = prepared.privateState.preflight.runtime;
    const next = stateModule.recordCatalogActivated({ journal: first.journal,
      state: prepared.privateState,
      observation: { observedAt: "2026-09-01T03:01:00.000Z",
        centralActiveConfigId: configuration.catalog.id,
        centralActiveConfigNumber: configuration.catalog.versionNumber,
        centralActiveAdapterVersion: configuration.catalog.adapterVersion,
        centralActiveConfigurationDigest: plan.catalogBridgeDigest(configuration.catalog.configuration),
        providerRowVersion: "5", providerCachedConfigId: configuration.catalog.id,
        providerCachedConfigNumber: configuration.catalog.versionNumber,
        providerCachedConfigurationDigest: plan.catalogBridgeDigest({
          adapterKey: configuration.catalog.adapterVersion,
          settings: configuration.catalog.configuration }),
        runtimeGeneration: runtime.generation, runtimeRowVersion: "9",
        sourceCursorHash: null, sourceCursorPresent: false, runtimeState: "paused",
        pauseCommandId: runtime.pauseProvenance.commandId,
        pauseCommandDigest: runtime.pauseProvenance.commandDigest,
        latestTerminalRunId: runtime.latestTerminalRun.runId,
        latestTerminalRunDigest: runtime.latestTerminalRun.runDigest,
        activeRunCount: 0, actionableCommandCount: 0, importLeaseOwner: null,
        otherActiveTransactionCount: 0, canonical: prepared.privateState.preflight.baseline } });
    const commitBefore = await readFile(path.join(directory, "commit.json"), "utf8");
    await unlink(path.join(directory, "public-journal.json"));
    await mkdir(path.join(directory, "public-journal.json"));
    await assert.rejects(journalModule.persistCatalogBridgeJournal({
      directory, expected: first.journal, next }));
    assert.equal(await readFile(path.join(directory, "commit.json"), "utf8"), commitBefore);
    assert.equal((await journalModule.readPreparedCatalogBridge(directory)).journal.phase, "prepared");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsafe input modes are rejected before parsing private cursor material", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "packscout-catalog-input-"));
  const inputPath = path.join(root, "input.json");
  try {
    await writeFile(inputPath, JSON.stringify(preparationDocument()), { mode: 0o644 });
    await assert.rejects(journalModule.readPrivateJsonFile(inputPath), { code: "CATALOG_BRIDGE_PRIVATE_FILE_UNSAFE" });
    await chmod(inputPath, 0o600);
    assert.equal((await journalModule.readPrivateJsonFile(inputPath)).pins.providerKey, "collector_crypt");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("thin preparation CLI emits only digests and stable refusal codes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "packscout-catalog-cli-"));
  const inputPath = path.join(root, "input.json");
  const directory = path.join(root, "journal");
  const document = preparationDocument();
  try {
    await writeFile(inputPath, JSON.stringify(document), { mode: 0o600 });
    const output = [];
    const errors = [];
    const observeResident = async () => document.observation.repository;
    const code = await cli.runCatalogBridgePreparationCli({
      argv: ["--check-only", "--input", inputPath, "--journal-directory", directory],
      observeResident, output: (value) => output.push(value), error: (value) => errors.push(value),
    });
    assert.equal(code, 0);
    assert.equal(errors.length, 0);
    assert.equal(JSON.stringify(output).includes(secret), false);
    assert.equal(output[0].outcome, "verified");
    const preparedCode = await cli.runCatalogBridgePreparationCli({
      argv: ["--prepare", "--input", inputPath, "--journal-directory", directory],
      observeResident, output: (value) => output.push(value), error: (value) => errors.push(value),
    });
    assert.equal(preparedCode, 0);
    assert.equal(output[1].outcome, "prepared");
    const refused = await cli.runCatalogBridgePreparationCli({
      argv: ["--prepare", "--input", inputPath], observeResident,
      output: (value) => output.push(value), error: (value) => errors.push(value),
    });
    assert.equal(refused, 1);
    assert.deepEqual(errors.at(-1), { outcome: "refused", code: "CATALOG_BRIDGE_ARGUMENTS_INVALID" });
    assert.equal(JSON.stringify(errors).includes(secret), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
