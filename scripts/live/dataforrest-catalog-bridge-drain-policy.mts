import { opaqueCursorEnvelopeSchema } from "@packscout/contracts";
import { providerMixedCursorFingerprint } from "@packscout/database";
import {
  catalogBridgeDrainReceiptSchema,
  type CatalogBridgeDrainReceipt,
} from "./dataforrest-catalog-bridge-drain-receipt.mts";
export { catalogBridgeDrainReceiptSchema } from "./dataforrest-catalog-bridge-drain-receipt.mts";
export type { CatalogBridgeDrainReceipt } from "./dataforrest-catalog-bridge-drain-receipt.mts";
import {
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgeProviderKey,
} from "./dataforrest-catalog-bridge-plan.mts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const positiveInteger = /^[1-9][0-9]*$/u;

export interface CatalogBridgeDrainPins {
  readonly operationId: string;
  readonly providerKey: CatalogBridgeProviderKey;
  readonly operatorId: string;
}

export interface CatalogBridgeDrainProcessObservation {
  readonly launchdLabel: string;
  readonly launchdLoaded: boolean;
  readonly processCount: number;
  readonly pids: readonly number[];
  readonly processIdentitySha256: string | null;
  readonly residencyPort: number;
  readonly residencyPortListening: boolean;
}

export interface CatalogBridgeDrainBoundary {
  readonly observedAt: string;
  readonly databaseNow: string;
  readonly central: Readonly<{
    organizationId: string;
    providerId: string;
    providerKey: string;
    providerRowVersion: string;
    activeConfigId: string;
    activeConfigNumber: number;
    maximumConfigNumber: number;
    activeAdapterVersion: string;
    configuration: unknown;
    configurationDigest: string;
    authorityDigest: string;
  }>;
  readonly runtime: Readonly<{
    providerId: string;
    providerKey: string;
    databaseName: string;
    databasePort: number;
    databaseRole: string;
    schemaVersion: string;
    state: string;
    generation: string;
    rowVersion: string;
    cachedConfigId: string;
    cachedConfigNumber: number;
    cachedConfiguration: unknown;
    sourceCursor: unknown;
    sourceCursorHash: string;
    activeRunCount: number;
    actionableCommandCount: number;
    otherOwnedLeaseCount: number;
    otherActiveTransactionCount: number;
  }>;
  readonly importLease: Readonly<{
    owner: string | null;
    fence: string;
    expiresAt: string | null;
  }>;
  readonly run: Readonly<{
    id: string;
    state: string;
    configId: string;
    configNumber: number;
    workerFence: string;
    pageCount: number;
    reachedSourceHead: boolean;
    finishedAt: string | null;
    failureCode: string | null;
    finalCursor: unknown;
    finalCursorHash: string;
    runDigest: string;
  }>;
  readonly lastPage: Readonly<{
    id: string;
    pageNumber: number;
    nextCursor: unknown;
    nextCursorHash: string;
    continuation: string;
    lastPageDigest: string;
  }> | null;
  readonly headProof: Readonly<{
    runId: string;
    sourceRunId: string;
    headPageId: string;
    pageNumber: number;
    checkpointHash: string;
    configVersionId: string;
    configVersionNumber: number;
    fullReplay: boolean;
    reconciliationComplete: boolean;
    receipt: Readonly<{ details: unknown; outcome: string; targetType: string; workerFence: string }>;
    proofDigest: string;
  }> | null;
  readonly process: CatalogBridgeDrainProcessObservation;
}

export interface CatalogBridgePauseIntent {
  readonly schemaVersion: "dataforrest_catalog_bridge_pause_intent_v1";
  readonly kind: "running" | "offline_idle_head";
  readonly operationId: string;
  readonly providerKey: CatalogBridgeProviderKey;
  readonly providerId: string;
  readonly operatorId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedGeneration: string;
  readonly runId: string;
  readonly runFence: string;
  readonly configId: string;
  readonly cursorHash: string;
  readonly boundaryDigest: string;
  readonly processIdentitySha256: string | null;
  readonly requestedAt: string;
  readonly reason: string;
}

export interface CatalogBridgePauseCommand {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly state: string;
  readonly targetRunId: string | null;
  readonly targetQuarantineId: string | null;
  readonly expectedGeneration: string;
  readonly requestedByOperatorId: string;
  readonly correlationId: string;
  readonly reason: string | null;
  readonly resultOutcome: string;
  readonly resultCode: string;
  readonly resultGeneration: string;
  readonly resultingRunId: string | null;
  readonly requestedAt: string;
  readonly completedAt: string;
}

export interface CatalogBridgeBootoutReceipt {
  readonly launchdLabel: string;
  readonly expectedPid: number;
  readonly expectedProcessIdentitySha256: string;
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly outcome: "unloaded";
}

export type CatalogBridgeDrainTerminalKind = "interrupted_checkpoint" | "succeeded_reconciled_head";

function deterministicId(pins: CatalogBridgeDrainPins, label: string): string {
  if (!uuid.test(pins.operationId)) refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PINS_INVALID");
  const hex = catalogBridgeDigest(`catalog-bridge-drain/${pins.operationId}/${pins.providerKey}/${label}`).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function catalogBridgeDrainIds(pins: CatalogBridgeDrainPins) {
  return Object.freeze({
    runningPauseCommandId: deterministicId(pins, "running-pause-command"),
    idlePauseCommandId: deterministicId(pins, "idle-head-pause-command"),
  });
}

export function catalogBridgeDrainReason(pins: CatalogBridgeDrainPins): string {
  return `DataForrest ${pins.providerKey} catalog bridge checkpoint drain`;
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function assertPins(pins: CatalogBridgeDrainPins): void {
  catalogBridgeProvider(pins.providerKey);
  if (!uuid.test(pins.operationId) || !uuid.test(pins.operatorId)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PINS_INVALID");
  }
}

export function assertCatalogBridgeProcessOnline(boundary: CatalogBridgeDrainBoundary): void {
  const definition = catalogBridgeProvider(boundary.central.providerKey);
  const process = boundary.process;
  if (process.launchdLabel !== definition.launchdLabel || !process.launchdLoaded || process.processCount !== 1 ||
    process.pids.length !== 1 || !Number.isSafeInteger(process.pids[0]) || process.pids[0]! < 1 ||
    !sha256.test(process.processIdentitySha256 ?? "") || process.residencyPort !== definition.residencyPort ||
    !process.residencyPortListening) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT");
  }
}

export function assertCatalogBridgeProcessOffline(boundary: CatalogBridgeDrainBoundary): void {
  const definition = catalogBridgeProvider(boundary.central.providerKey);
  const process = boundary.process;
  if (process.launchdLabel !== definition.launchdLabel || process.launchdLoaded || process.processCount !== 0 ||
    process.pids.length !== 0 || process.processIdentitySha256 !== null ||
    process.residencyPort !== definition.residencyPort || process.residencyPortListening) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_STILL_PRESENT");
  }
}

function assertAuthorityAndCheckpoint(boundary: CatalogBridgeDrainBoundary, pins: CatalogBridgeDrainPins): void {
  assertPins(pins);
  const definition = catalogBridgeProvider(pins.providerKey);
  const { central, runtime, run, lastPage } = boundary;
  if (!validInstant(boundary.observedAt) || !validInstant(boundary.databaseNow) ||
    central.organizationId !== definition.organizationId || central.providerId !== definition.providerId ||
    central.providerKey !== definition.providerKey || !positiveInteger.test(central.providerRowVersion) ||
    central.activeConfigId !== definition.currentConfigId || central.activeConfigNumber !== definition.currentConfigNumber ||
    central.maximumConfigNumber !== definition.currentConfigNumber ||
    central.activeAdapterVersion !== definition.currentEventManifest.adapterVersion ||
    catalogBridgeDigest(central.configuration) !== catalogBridgeDigest({ platform: definition.providerKey }) ||
    central.configurationDigest !== catalogBridgeDigest(central.configuration) || !sha256.test(central.authorityDigest) ||
    runtime.providerId !== definition.providerId || runtime.providerKey !== definition.providerKey ||
    runtime.databaseName !== definition.databaseName || runtime.databasePort !== definition.databasePort ||
    runtime.databaseRole !== "provider" || runtime.schemaVersion !== "distributed-provider-v1" ||
    !positiveInteger.test(runtime.generation) || !positiveInteger.test(runtime.rowVersion) ||
    runtime.cachedConfigId !== definition.currentConfigId || runtime.cachedConfigNumber !== definition.currentConfigNumber ||
    catalogBridgeDigest(runtime.cachedConfiguration) !== catalogBridgeDigest({
      adapterKey: definition.currentEventManifest.adapterVersion,
      settings: { platform: definition.providerKey },
    }) || !sha256.test(runtime.sourceCursorHash) || runtime.otherOwnedLeaseCount !== 0 ||
    !Number.isSafeInteger(runtime.otherActiveTransactionCount) || runtime.otherActiveTransactionCount < 0 ||
    !uuid.test(run.id) || run.configId !== definition.currentConfigId || run.configNumber !== definition.currentConfigNumber ||
    !positiveInteger.test(run.workerFence) || !Number.isSafeInteger(run.pageCount) || run.pageCount < 1 ||
    !sha256.test(run.runDigest) ||
    run.finalCursorHash !== runtime.sourceCursorHash || lastPage === null || !uuid.test(lastPage.id) ||
    !sha256.test(lastPage.lastPageDigest) ||
    lastPage.pageNumber !== run.pageCount || lastPage.nextCursorHash !== run.finalCursorHash ||
    catalogBridgeDigest(runtime.sourceCursor) !== catalogBridgeDigest(run.finalCursor) ||
    catalogBridgeDigest(run.finalCursor) !== catalogBridgeDigest(lastPage.nextCursor)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_BOUNDARY_DRIFT");
  }
  for (const cursor of [runtime.sourceCursor, run.finalCursor, lastPage.nextCursor]) {
    const parsed = opaqueCursorEnvelopeSchema.safeParse(cursor);
    if (!parsed.success || parsed.data.value === null || parsed.data.sourceInstanceId !== definition.providerId ||
      parsed.data.sourceRevisionId !== definition.currentConfigId ||
      parsed.data.adapterVersion !== definition.currentEventManifest.adapterVersion ||
      parsed.data.sourceTypeKey !== definition.currentEventManifest.sourceTypeKey ||
      parsed.data.cursorCodecKey !== definition.currentEventManifest.cursorCodecKey ||
      parsed.data.cursorGeneration !== 1 ||
      providerMixedCursorFingerprint(parsed.data) !== runtime.sourceCursorHash) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CURSOR_INVALID");
    }
  }
  if (boundary.headProof !== null) {
    const { proofDigest, ...proof } = boundary.headProof;
    if (!sha256.test(proofDigest) || catalogBridgeDigest(proof) !== proofDigest) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_HEAD_PROOF_INVALID");
    }
  }
}

export function catalogBridgeDrainBoundaryEvidence(boundary: CatalogBridgeDrainBoundary) {
  return Object.freeze({
    observedAt: boundary.observedAt,
    databaseNow: boundary.databaseNow,
    central: boundary.central,
    runtime: { ...boundary.runtime, sourceCursor: undefined },
    importLease: boundary.importLease,
    run: { ...boundary.run, finalCursor: undefined },
    lastPage: boundary.lastPage && { ...boundary.lastPage, nextCursor: undefined },
    headProof: boundary.headProof,
    process: boundary.process,
  });
}

export function catalogBridgeDrainStableDatabaseEvidence(boundary: CatalogBridgeDrainBoundary) {
  const evidence = catalogBridgeDrainBoundaryEvidence(boundary);
  return Object.freeze({ central: evidence.central, runtime: evidence.runtime, importLease: evidence.importLease,
    run: evidence.run, lastPage: evidence.lastPage, headProof: evidence.headProof });
}

export function assertCatalogBridgeRunningEntry(boundary: CatalogBridgeDrainBoundary, pins: CatalogBridgeDrainPins): void {
  assertAuthorityAndCheckpoint(boundary, pins);
  assertCatalogBridgeProcessOnline(boundary);
  const { runtime, importLease, run, lastPage } = boundary;
  if (runtime.state !== "running" || runtime.activeRunCount !== 1 || runtime.actionableCommandCount !== 0 ||
    run.state !== "running" || run.reachedSourceHead || run.finishedAt !== null || run.failureCode !== null ||
    lastPage?.continuation !== "more" || importLease.owner === null || importLease.fence !== run.workerFence ||
    importLease.expiresAt === null || !validInstant(importLease.expiresAt) ||
    Date.parse(importLease.expiresAt) <= Date.parse(boundary.databaseNow)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RUNNING_ENTRY_INVALID");
  }
}

export function assertCatalogBridgeIdleHead(boundary: CatalogBridgeDrainBoundary, pins: CatalogBridgeDrainPins,
  expected?: Readonly<{ runId: string; runFence: string; generation?: string }>): void {
  assertAuthorityAndCheckpoint(boundary, pins);
  const { runtime, importLease, run, lastPage } = boundary;
  if (runtime.state !== "idle" || runtime.activeRunCount !== 0 || runtime.actionableCommandCount !== 0 ||
    runtime.otherActiveTransactionCount !== 0 || importLease.owner !== null || importLease.expiresAt !== null ||
    run.state !== "succeeded" || !run.reachedSourceHead || run.failureCode !== null ||
    run.finishedAt === null || !validInstant(run.finishedAt) || lastPage?.continuation !== "head" ||
    (expected && (run.id !== expected.runId || run.workerFence !== expected.runFence ||
      (expected.generation !== undefined && runtime.generation !== expected.generation)))) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_IDLE_HEAD_INVALID");
  }
  terminalKind(boundary);
}

function terminalKind(boundary: CatalogBridgeDrainBoundary): CatalogBridgeDrainTerminalKind {
  const { run, lastPage, headProof } = boundary;
  const interruption =
    (run.state === "incomplete" && run.failureCode === "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE") ||
    (run.state === "failed" && run.failureCode === "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING");
  if (interruption && !run.reachedSourceHead && lastPage?.continuation === "more" && headProof === null) {
    return "interrupted_checkpoint";
  }
  if (run.state === "succeeded" && run.failureCode === null && run.reachedSourceHead && lastPage?.continuation === "head" &&
    headProof !== null && headProof.runId === run.id && headProof.sourceRunId === run.id &&
    headProof.headPageId === lastPage.id && headProof.pageNumber === run.pageCount &&
    headProof.checkpointHash === run.finalCursorHash && headProof.configVersionId === run.configId &&
    headProof.configVersionNumber === run.configNumber && headProof.reconciliationComplete &&
    headProof.receipt.outcome === "success" && headProof.receipt.targetType === "provider_run" &&
    headProof.receipt.workerFence === run.workerFence) {
    return "succeeded_reconciled_head";
  }
  return refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_TERMINAL_NOT_ADMITTED");
}

export function assertCatalogBridgePausedDrain(boundary: CatalogBridgeDrainBoundary, pins: CatalogBridgeDrainPins,
  expected: Readonly<{ runId: string; runFence: string; generation: string }>): CatalogBridgeDrainTerminalKind {
  assertAuthorityAndCheckpoint(boundary, pins);
  const { runtime, importLease, run } = boundary;
  if (runtime.state !== "paused" || runtime.generation !== expected.generation || runtime.activeRunCount !== 0 ||
    runtime.actionableCommandCount !== 0 || runtime.otherActiveTransactionCount !== 0 ||
    importLease.owner !== null || importLease.expiresAt !== null || run.id !== expected.runId ||
    run.workerFence !== expected.runFence || run.finishedAt === null || !validInstant(run.finishedAt)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_NOT_SETTLED");
  }
  return terminalKind(boundary);
}

export function assertCatalogBridgePausedTransition(boundary: CatalogBridgeDrainBoundary, pins: CatalogBridgeDrainPins,
  entry: CatalogBridgeDrainBoundary, expectedGeneration: string): void {
  assertAuthorityAndCheckpoint(boundary, pins);
  assertCatalogBridgeProcessOnline(boundary);
  const { runtime, importLease, run } = boundary;
  if (runtime.state !== "paused" || runtime.generation !== expectedGeneration || runtime.actionableCommandCount !== 0 ||
    run.id !== entry.run.id || run.workerFence !== entry.run.workerFence ||
    ![0, 1].includes(runtime.activeRunCount) ||
    (runtime.activeRunCount === 1 && (run.state !== "running" || importLease.owner !== entry.importLease.owner ||
      importLease.fence !== entry.importLease.fence)) ||
    (runtime.activeRunCount === 0 && (run.state === "running" ||
      (importLease.owner === null ? importLease.expiresAt !== null
        : importLease.owner !== entry.importLease.owner || importLease.fence !== entry.importLease.fence ||
          importLease.expiresAt === null)))) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_TRANSITION_DRIFT");
  }
  if (runtime.activeRunCount === 0) terminalKind(boundary);
}

export function createCatalogBridgePauseIntent(input: Readonly<{
  pins: CatalogBridgeDrainPins;
  boundary: CatalogBridgeDrainBoundary;
  kind: "running" | "offline_idle_head";
}>): CatalogBridgePauseIntent {
  const ids = catalogBridgeDrainIds(input.pins);
  const definition = catalogBridgeProvider(input.pins.providerKey);
  return Object.freeze({
    schemaVersion: "dataforrest_catalog_bridge_pause_intent_v1" as const,
    kind: input.kind,
    operationId: input.pins.operationId,
    providerKey: input.pins.providerKey,
    providerId: definition.providerId,
    operatorId: input.pins.operatorId,
    commandId: input.kind === "running" ? ids.runningPauseCommandId : ids.idlePauseCommandId,
    idempotencyKey: `catalog-bridge/${input.pins.operationId}/${input.kind}/pause`,
    expectedGeneration: input.boundary.runtime.generation,
    runId: input.boundary.run.id,
    runFence: input.boundary.run.workerFence,
    configId: definition.currentConfigId,
    cursorHash: input.boundary.runtime.sourceCursorHash,
    boundaryDigest: catalogBridgeDigest(catalogBridgeDrainBoundaryEvidence(input.boundary)),
    processIdentitySha256: input.boundary.process.processIdentitySha256,
    requestedAt: input.boundary.databaseNow,
    reason: catalogBridgeDrainReason(input.pins),
  });
}

export function assertCatalogBridgePauseCommand(command: CatalogBridgePauseCommand, intent: CatalogBridgePauseIntent): string {
  const expectedResultGeneration = (BigInt(intent.expectedGeneration) + 1n).toString();
  if (command.id !== intent.commandId || command.idempotencyKey !== intent.idempotencyKey || command.commandType !== "pause" ||
    command.state !== "completed" || command.targetRunId !== null || command.targetQuarantineId !== null ||
    command.expectedGeneration !== intent.expectedGeneration || command.requestedByOperatorId !== intent.operatorId ||
    command.correlationId !== intent.operationId || command.reason !== intent.reason || command.resultOutcome !== "accepted" ||
    !["RUNTIME_TRANSITION_APPLIED", "RUNTIME_ALREADY_IN_STATE"].includes(command.resultCode) ||
    command.resultGeneration !== expectedResultGeneration || command.resultingRunId !== null ||
    !validInstant(command.requestedAt) || !validInstant(command.completedAt) ||
    Date.parse(command.completedAt) < Date.parse(command.requestedAt)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PAUSE_PROVENANCE_INVALID");
  }
  return catalogBridgeDigest(command);
}

export function assertCatalogBridgeBootoutReceipt(receipt: CatalogBridgeBootoutReceipt,
  online: CatalogBridgeDrainProcessObservation): string {
  if (receipt.launchdLabel !== online.launchdLabel || receipt.expectedPid !== online.pids[0] ||
    receipt.expectedProcessIdentitySha256 !== online.processIdentitySha256 || receipt.outcome !== "unloaded" ||
    !validInstant(receipt.requestedAt) || !validInstant(receipt.completedAt) ||
    Date.parse(receipt.completedAt) < Date.parse(receipt.requestedAt)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_BOOTOUT_RECEIPT_INVALID");
  }
  return catalogBridgeDigest(receipt);
}

export function createCatalogBridgeDrainReceipt(input: Readonly<{
  pins: CatalogBridgeDrainPins;
  entryKind: "running" | "offline_idle_head";
  intents: readonly CatalogBridgePauseIntent[];
  command: CatalogBridgePauseCommand;
  finalBoundary: CatalogBridgeDrainBoundary;
  initialProcess: CatalogBridgeDrainProcessObservation;
  bootoutReceipt: CatalogBridgeBootoutReceipt;
}>): CatalogBridgeDrainReceipt {
  const definition = catalogBridgeProvider(input.pins.providerKey);
  const intent = input.intents.at(-1);
  if (!intent || input.intents.length > 2) refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_INTENT_INVALID");
  const commandDigest = assertCatalogBridgePauseCommand(input.command, intent);
  const kind = assertCatalogBridgePausedDrain(input.finalBoundary, input.pins, {
    runId: intent.runId, runFence: intent.runFence,
    generation: (BigInt(intent.expectedGeneration) + 1n).toString(),
  });
  assertCatalogBridgeProcessOffline(input.finalBoundary);
  const run = input.finalBoundary.run;
  const lastPage = input.finalBoundary.lastPage!;
  if ((input.entryKind === "running" && Date.parse(input.command.completedAt) > Date.parse(run.finishedAt!)) ||
    (input.entryKind === "offline_idle_head" && Date.parse(run.finishedAt!) > Date.parse(input.command.requestedAt))) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_TIMELINE_INVALID");
  }
  const terminalBase = { runId: run.id, runFence: run.workerFence, state: run.state,
    failureCode: run.failureCode, reachedSourceHead: run.reachedSourceHead, finishedAt: run.finishedAt!,
    pageCount: run.pageCount, finalCursorHash: run.finalCursorHash, lastPageNumber: lastPage.pageNumber,
    lastPageCursorHash: lastPage.nextCursorHash, lastPageContinuation: lastPage.continuation };
  const terminal = { kind, ...terminalBase, runDigest: run.runDigest, lastPageDigest: lastPage.lastPageDigest,
    headProofDigest: kind === "succeeded_reconciled_head" ? input.finalBoundary.headProof!.proofDigest : null };
  return catalogBridgeDrainReceiptSchema.parse({
    schemaVersion: "dataforrest_catalog_bridge_drain_receipt_v1",
    operationId: input.pins.operationId,
    providerKey: input.pins.providerKey,
    providerId: definition.providerId,
    operatorId: input.pins.operatorId,
    entryKind: input.entryKind,
    currentConfigId: definition.currentConfigId,
    drainedAt: input.finalBoundary.observedAt,
    intentDigests: input.intents.map((value) => catalogBridgeDigest(value)),
    pause: { commandId: input.command.id, commandDigest, expectedGeneration: input.command.expectedGeneration,
      resultGeneration: input.command.resultGeneration, reason: intent.reason, correlationId: input.command.correlationId,
      requestedAt: input.command.requestedAt, completedAt: input.command.completedAt },
    terminal,
    worker: { launchdLabel: definition.launchdLabel, initialPid: input.initialProcess.pids[0],
      initialProcessIdentitySha256: input.initialProcess.processIdentitySha256,
      bootoutReceiptDigest: assertCatalogBridgeBootoutReceipt(input.bootoutReceipt, input.initialProcess),
      offlineProcessEvidenceDigest: catalogBridgeDigest(input.finalBoundary.process) },
    drainedEvidenceDigest: catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(input.finalBoundary)),
  });
}

export function assertCatalogBridgeDrainReceipt(value: unknown, pins: CatalogBridgeDrainPins): CatalogBridgeDrainReceipt {
  assertPins(pins);
  const receipt = catalogBridgeDrainReceiptSchema.safeParse(value);
  const definition = catalogBridgeProvider(pins.providerKey);
  if (!receipt.success || receipt.data.operationId !== pins.operationId || receipt.data.providerKey !== pins.providerKey ||
    receipt.data.providerId !== definition.providerId || receipt.data.operatorId !== pins.operatorId ||
    receipt.data.currentConfigId !== definition.currentConfigId) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_INVALID");
  }
  return receipt.data;
}
