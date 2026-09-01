import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const plan = await tsImport("./dataforrest-catalog-bridge-plan.mts", import.meta.url);
const policy = await tsImport("./dataforrest-catalog-bridge-drain-policy.mts", import.meta.url);
const drain = await tsImport("./dataforrest-catalog-bridge-drain.mts", import.meta.url);
const journal = await tsImport("./dataforrest-catalog-bridge-drain-journal.mts", import.meta.url);
const { providerMixedCursorFingerprint } = await tsImport("@packscout/database", import.meta.url);

const pins = { operationId: "30000000-0000-4000-8000-000000000001", providerKey: "collector_crypt",
  operatorId: "30000000-0000-4000-8000-000000000002" };
const definition = plan.catalogBridgeProvider(pins.providerKey);
const secretCursor = "cursor-material-that-must-not-escape";
const cursor = { sourceInstanceId: definition.providerId, sourceRevisionId: definition.currentConfigId,
  sourceTypeKey: definition.eventManifest.sourceTypeKey, adapterVersion: definition.eventManifest.adapterVersion,
  cursorCodecKey: definition.eventManifest.cursorCodecKey, cursorGeneration: 1, value: secretCursor };
const cursorHash = providerMixedCursorFingerprint(cursor);
const hash = letter => letter.repeat(64);

function processOnline() {
  return { launchdLabel: definition.launchdLabel, launchdLoaded: true, processCount: 1, pids: [99123],
    processIdentitySha256: hash("a"), residencyPort: definition.residencyPort, residencyPortListening: true };
}

function processOffline() {
  return { launchdLabel: definition.launchdLabel, launchdLoaded: false, processCount: 0, pids: [],
    processIdentitySha256: null, residencyPort: definition.residencyPort, residencyPortListening: false };
}

function runningBoundary() {
  return { observedAt: "2026-09-01T03:00:00.000Z", databaseNow: "2026-09-01T03:00:00.000Z",
    central: { organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, providerRowVersion: "4", activeConfigId: definition.currentConfigId,
      activeConfigNumber: definition.currentConfigNumber, maximumConfigNumber: definition.currentConfigNumber,
      activeAdapterVersion: definition.eventManifest.adapterVersion, configuration: { platform: definition.providerKey },
      configurationDigest: plan.catalogBridgeDigest({ platform: definition.providerKey }), authorityDigest: hash("b") },
    runtime: { providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort, databaseRole: "provider",
      schemaVersion: "distributed-provider-v1", state: "running", generation: "26", rowVersion: "50",
      cachedConfigId: definition.currentConfigId, cachedConfigNumber: definition.currentConfigNumber,
      cachedConfiguration: { adapterKey: definition.eventManifest.adapterVersion,
        settings: { platform: definition.providerKey } }, sourceCursor: structuredClone(cursor), sourceCursorHash: cursorHash,
      activeRunCount: 1, actionableCommandCount: 0, otherOwnedLeaseCount: 0, otherActiveTransactionCount: 0 },
    importLease: { owner: "provider-import:collector", fence: "14", expiresAt: "2026-09-01T03:02:00.000Z" },
    run: { id: "30000000-0000-4000-8000-000000000003", state: "running",
      configId: definition.currentConfigId, configNumber: definition.currentConfigNumber, workerFence: "14", pageCount: 8,
      reachedSourceHead: false, finishedAt: null, failureCode: null,
      finalCursor: structuredClone(cursor), finalCursorHash: cursorHash, runDigest: hash("c") },
    lastPage: { id: "30000000-0000-4000-8000-000000000004", pageNumber: 8,
      nextCursor: structuredClone(cursor), nextCursorHash: cursorHash, continuation: "more",
      lastPageDigest: hash("d") },
    headProof: null,
    process: processOnline() };
}

function headProofFor(boundary) {
  const proof = { runId: boundary.run.id, sourceRunId: boundary.run.id, headPageId: boundary.lastPage.id,
    pageNumber: boundary.run.pageCount, checkpointHash: boundary.run.finalCursorHash,
    configVersionId: boundary.run.configId, configVersionNumber: boundary.run.configNumber, fullReplay: false,
    reconciliationComplete: true, receipt: { details: { phase: "complete", headPageId: boundary.lastPage.id },
      outcome: "success", targetType: "provider_run", workerFence: boundary.run.workerFence } };
  return { ...proof, proofDigest: plan.catalogBridgeDigest(proof) };
}

function pausedBoundary(entry, kind = "interrupted_checkpoint", online = true) {
  const head = kind === "succeeded_reconciled_head";
  const boundary = { ...structuredClone(entry), observedAt: "2026-09-01T03:00:01.000Z",
    databaseNow: "2026-09-01T03:00:01.000Z",
    runtime: { ...structuredClone(entry.runtime), state: "paused", generation: "27", rowVersion: "52",
      activeRunCount: 0, otherActiveTransactionCount: 0 },
    importLease: { owner: null, fence: entry.importLease.fence, expiresAt: null },
    run: { ...structuredClone(entry.run), state: head ? "succeeded" : "incomplete", reachedSourceHead: head,
      finishedAt: "2026-09-01T03:00:00.500Z",
      failureCode: head ? null : "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE" },
    lastPage: { ...structuredClone(entry.lastPage), continuation: head ? "head" : "more" },
    process: online ? processOnline() : processOffline() };
  boundary.headProof = head ? headProofFor(boundary) : null;
  return boundary;
}

function idleHeadBoundary(entry, online = true) {
  const boundary = { ...structuredClone(entry), observedAt: "2026-09-01T03:00:00.500Z",
    databaseNow: "2026-09-01T03:00:00.500Z",
    runtime: { ...structuredClone(entry.runtime), state: "idle", generation: "27", rowVersion: "51",
      activeRunCount: 0, otherActiveTransactionCount: 0 },
    importLease: { owner: null, fence: entry.importLease.fence, expiresAt: null },
    run: { ...structuredClone(entry.run), state: "succeeded", reachedSourceHead: true,
      finishedAt: "2026-09-01T03:00:00.250Z", failureCode: null },
    lastPage: { ...structuredClone(entry.lastPage), continuation: "head" },
    process: online ? processOnline() : processOffline() };
  boundary.headProof = headProofFor(boundary);
  return boundary;
}

function commandFor(intent) {
  const generation = (BigInt(intent.expectedGeneration) + 1n).toString();
  const requestedAt = intent.kind === "running" ? "2026-09-01T03:00:00.100Z" : "2026-09-01T03:00:00.600Z";
  const completedAt = intent.kind === "running" ? "2026-09-01T03:00:00.200Z" : "2026-09-01T03:00:00.700Z";
  return { id: intent.commandId, idempotencyKey: intent.idempotencyKey, commandType: "pause", state: "completed",
    targetRunId: null, targetQuarantineId: null, expectedGeneration: intent.expectedGeneration,
    requestedByOperatorId: intent.operatorId, correlationId: intent.operationId, reason: intent.reason,
    resultOutcome: "accepted", resultCode: "RUNTIME_TRANSITION_APPLIED", resultGeneration: generation,
    resultingRunId: null, requestedAt, completedAt };
}

function harness(boundaries, submit = null) {
  const queue = boundaries.map(value => structuredClone(value));
  const events = [];
  const intents = [];
  const commands = new Map();
  let saved = null;
  const dependencies = {
    readExistingReceipt: async () => saved,
    readBoundary: async () => structuredClone(queue.length > 1 ? queue.shift() : queue[0]),
    recordPauseIntent: async intent => { events.push(`intent:${intent.kind}`); intents.push(structuredClone(intent));
      return { intentDigest: plan.catalogBridgeDigest(intent), exactRetry: false }; },
    submitPause: async intent => {
      events.push(`pause:${intent.kind}`);
      if (submit) return submit(intent, commands);
      const command = commandFor(intent); commands.set(intent.commandId, command);
      return { commandId: intent.commandId, outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED",
        state: "paused", generation: command.resultGeneration };
    },
    readPauseCommand: async id => structuredClone(commands.get(id) ?? null),
    bootout: async input => { events.push("bootout"); return { launchdLabel: input.launchdLabel,
      expectedPid: input.expectedPid, expectedProcessIdentitySha256: input.expectedProcessIdentitySha256,
      requestedAt: "2026-09-01T03:00:01.100Z", completedAt: "2026-09-01T03:00:01.200Z", outcome: "unloaded" }; },
    wait: async () => { events.push("wait"); },
    persistReceipt: async receipt => { events.push("persist"); saved = structuredClone(receipt);
      return { sha256: plan.catalogBridgeDigest(receipt), exactRetry: false }; },
  };
  return { dependencies, events, intents, commands, get saved() { return saved; }, set saved(value) { saved = value; } };
}

test("running generation drains through the ordinary pause before launchd bootout", async () => {
  const entry = runningBoundary();
  const transition = { ...pausedBoundary(entry), runtime: { ...pausedBoundary(entry).runtime,
    activeRunCount: 1, otherActiveTransactionCount: 1 }, importLease: structuredClone(entry.importLease),
    run: structuredClone(entry.run) };
  const drained = pausedBoundary(entry);
  const offline = { ...structuredClone(drained), observedAt: "2026-09-01T03:00:02.000Z", process: processOffline() };
  const f = harness([entry, transition, drained, offline]);
  const result = await drain.drainCatalogBridgeProvider({ pins, dependencies: f.dependencies,
    options: { maximumObservations: 3, pollMilliseconds: 1 } });
  assert.equal(result.outcome, "drained");
  assert.equal(result.terminalKind, "interrupted_checkpoint");
  assert.deepEqual(f.events, ["intent:running", "pause:running", "wait", "bootout", "persist"]);
  assert.equal(JSON.stringify({ result, receipt: f.saved }).includes(secretCursor), false);
  assert.equal(f.saved.pause.commandDigest, plan.catalogBridgeDigest(f.commands.get(result.pauseCommandId)));
  assert.equal(f.saved.terminal.runDigest, hash("c"));
  assert.equal(f.saved.terminal.lastPageDigest, hash("d"));
});

test("a run that wins the pause race needs the distinct succeeded-head proof", async () => {
  const entry = runningBoundary();
  const drained = pausedBoundary(entry, "succeeded_reconciled_head");
  const offline = { ...structuredClone(drained), observedAt: "2026-09-01T03:00:02.000Z", process: processOffline() };
  const f = harness([entry, drained, offline]);
  const result = await drain.drainCatalogBridgeProvider({ pins, dependencies: f.dependencies,
    options: { maximumObservations: 2, pollMilliseconds: 1 } });
  assert.equal(result.terminalKind, "succeeded_reconciled_head");
  assert.match(f.saved.terminal.headProofDigest, /^[a-f0-9]{64}$/u);
  const missing = pausedBoundary(entry, "succeeded_reconciled_head");
  missing.headProof = null;
  assert.throws(() => policy.assertCatalogBridgePausedDrain(missing, pins,
    { runId: entry.run.id, runFence: entry.run.workerFence, generation: "27" }),
  { code: "CATALOG_BRIDGE_DRAIN_TERMINAL_NOT_ADMITTED" });
  const fabricated = pausedBoundary(entry, "succeeded_reconciled_head");
  fabricated.headProof.proofDigest = hash("f");
  assert.throws(() => policy.assertCatalogBridgePausedDrain(fabricated, pins,
    { runId: entry.run.id, runFence: entry.run.workerFence, generation: "27" }),
  { code: "CATALOG_BRIDGE_DRAIN_HEAD_PROOF_INVALID" });
});

test("generation conflict unloads an exact idle head before the offline pause", async () => {
  const entry = runningBoundary();
  const idle = idleHeadBoundary(entry);
  const offlineIdle = { ...structuredClone(idle), observedAt: "2026-09-01T03:00:01.000Z", process: processOffline() };
  const final = { ...pausedBoundary(entry, "succeeded_reconciled_head", false),
    observedAt: "2026-09-01T03:00:02.000Z", runtime: { ...pausedBoundary(entry).runtime, generation: "28", rowVersion: "52" },
    run: structuredClone(offlineIdle.run), lastPage: structuredClone(offlineIdle.lastPage) };
  const f = harness([entry, idle, offlineIdle, final], (intent, commands) => {
    if (intent.kind === "running") return { commandId: intent.commandId, outcome: "conflict",
      code: "RUNTIME_GENERATION_CONFLICT", state: "idle", generation: "27" };
    const command = commandFor(intent); commands.set(intent.commandId, command);
    return { commandId: intent.commandId, outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED",
      state: "paused", generation: "28" };
  });
  const result = await drain.drainCatalogBridgeProvider({ pins, dependencies: f.dependencies,
    options: { maximumObservations: 2, pollMilliseconds: 1 } });
  assert.equal(result.terminalKind, "succeeded_reconciled_head");
  assert.deepEqual(f.events, ["intent:running", "pause:running", "bootout",
    "intent:offline_idle_head", "pause:offline_idle_head", "persist"]);
  assert.equal(f.saved.intentDigests.length, 2);
});

test("new actionable work during idle-head bootout refuses without an offline pause", async () => {
  const entry = runningBoundary();
  const idle = idleHeadBoundary(entry);
  const raced = { ...idleHeadBoundary(entry, false), runtime: { ...idle.runtime, actionableCommandCount: 1 } };
  const f = harness([entry, idle, raced], intent => ({ commandId: intent.commandId, outcome: "conflict",
    code: "RUNTIME_GENERATION_CONFLICT", state: "idle", generation: "27" }));
  await assert.rejects(drain.drainCatalogBridgeProvider({ pins, dependencies: f.dependencies,
    options: { maximumObservations: 2, pollMilliseconds: 1 } }),
  { code: "CATALOG_BRIDGE_DRAIN_CHANGED_DURING_BOOTOUT" });
  assert.deepEqual(f.events, ["intent:running", "pause:running", "bootout"]);
});

test("a foreign lease during the paused transition is never waited through", () => {
  const entry = runningBoundary();
  const transition = pausedBoundary(entry);
  transition.importLease = { owner: "foreign-worker", fence: "15", expiresAt: "2026-09-01T03:02:00.000Z" };
  assert.throws(() => policy.assertCatalogBridgePausedTransition(transition, pins, entry, "27"),
    { code: "CATALOG_BRIDGE_DRAIN_TRANSITION_DRIFT" });
});

test("an exact stored receipt is idempotent while drift and unsafe file modes refuse", async () => {
  const entry = runningBoundary();
  const drained = pausedBoundary(entry);
  const offline = { ...structuredClone(drained), observedAt: "2026-09-01T03:00:02.000Z", process: processOffline() };
  const f = harness([entry, drained, offline]);
  await drain.drainCatalogBridgeProvider({ pins, dependencies: f.dependencies,
    options: { maximumObservations: 2, pollMilliseconds: 1 } });
  const receipt = structuredClone(f.saved);
  const retry = harness([offline]);
  retry.saved = receipt;
  retry.commands.set(receipt.pause.commandId, structuredClone(f.commands.get(receipt.pause.commandId)));
  const result = await drain.drainCatalogBridgeProvider({ pins, dependencies: retry.dependencies });
  assert.equal(result.outcome, "already_drained");
  assert.deepEqual(retry.events, []);
  retry.saved.pause.commandDigest = hash("f");
  await assert.rejects(drain.drainCatalogBridgeProvider({ pins, dependencies: retry.dependencies }),
    { code: "CATALOG_BRIDGE_DRAIN_RETRY_DRIFT" });

  const root = await mkdtemp(path.join(tmpdir(), "packscout-catalog-drain-"));
  const file = path.join(root, "receipt.json");
  try {
    await chmod(root, 0o700);
    const persisted = await journal.persistCatalogBridgeDrainReceipt(file, receipt);
    assert.equal(persisted.exactRetry, false);
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.equal((await journal.persistCatalogBridgeDrainReceipt(file, receipt)).exactRetry, true);
    await chmod(file, 0o644);
    await assert.rejects(journal.readCatalogBridgeDrainReceipt(file),
      { code: "CATALOG_BRIDGE_DRAIN_RECEIPT_FILE_UNSAFE" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
