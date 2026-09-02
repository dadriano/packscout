import {
  CatalogBridgeError,
  catalogBridgeDigest,
  catalogBridgeProvider,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  assertCatalogBridgeBootoutReceipt,
  assertCatalogBridgeDrainReceipt,
  assertCatalogBridgeIdleHead,
  assertCatalogBridgePausedDrain,
  assertCatalogBridgePausedTransition,
  assertCatalogBridgePauseCommand,
  assertCatalogBridgeProcessOffline,
  assertCatalogBridgeRunningEntry,
  catalogBridgeDrainStableDatabaseEvidence,
  createCatalogBridgeDrainReceipt,
  createCatalogBridgePauseIntent,
  type CatalogBridgeBootoutReceipt,
  type CatalogBridgeDrainBoundary,
  type CatalogBridgeDrainPins,
  type CatalogBridgeDrainProcessObservation,
  type CatalogBridgeDrainReceipt,
  type CatalogBridgePauseCommand,
  type CatalogBridgePauseIntent,
} from "./dataforrest-catalog-bridge-drain-policy.mts";

export interface CatalogBridgePauseSubmission {
  readonly commandId: string;
  readonly outcome: "accepted" | "deduplicated" | "conflict" | "forbidden" | "failed";
  readonly code: string;
  readonly state: string;
  readonly generation: string;
}

export interface CatalogBridgeDrainDependencies {
  readonly readExistingReceipt: () => Promise<unknown | null>;
  readonly readBoundary: () => Promise<CatalogBridgeDrainBoundary>;
  /**
   * The production adapter must use the existing provider lock order: import
   * lease, exact run, then runtime. It must re-read the redacted boundary
   * digest and append one immutable intent audit; it must not change state.
   */
  readonly recordPauseIntent: (intent: CatalogBridgePauseIntent) => Promise<Readonly<{
    intentDigest: string;
    exactRetry: boolean;
  }>>;
  /** Submit through PrismaAdminProviderRuntimeRepository. No direct SQL state transition is admitted. */
  readonly submitPause: (intent: CatalogBridgePauseIntent) => Promise<CatalogBridgePauseSubmission>;
  readonly readPauseCommand: (commandId: string) => Promise<CatalogBridgePauseCommand | null>;
  readonly bootout: (input: Readonly<{
    launchdLabel: string;
    expectedPid: number;
    expectedProcessIdentitySha256: string;
  }>) => Promise<CatalogBridgeBootoutReceipt>;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly persistReceipt: (receipt: CatalogBridgeDrainReceipt) => Promise<Readonly<{
    sha256: string;
    exactRetry: boolean;
  }>>;
}

export interface CatalogBridgeDrainOptions {
  readonly maximumObservations?: number;
  readonly pollMilliseconds?: number;
}

export interface CatalogBridgeDrainResult {
  readonly outcome: "drained" | "already_drained";
  readonly operationId: string;
  readonly providerKey: string;
  readonly terminalKind: "interrupted_checkpoint" | "succeeded_reconciled_head";
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
  readonly gracefulStopReceiptSha256: string;
}

function sameOnlineProcess(left: CatalogBridgeDrainProcessObservation,
  right: CatalogBridgeDrainProcessObservation): boolean {
  return left.launchdLabel === right.launchdLabel && left.launchdLoaded && right.launchdLoaded &&
    left.processCount === 1 && right.processCount === 1 && left.pids.length === 1 && right.pids.length === 1 &&
    left.pids[0] === right.pids[0] && left.processIdentitySha256 === right.processIdentitySha256 &&
    left.residencyPort === right.residencyPort && left.residencyPortListening && right.residencyPortListening;
}

function assertIntentRecorded(intent: CatalogBridgePauseIntent,
  result: Readonly<{ intentDigest: string; exactRetry: boolean }>): void {
  if (result.intentDigest !== catalogBridgeDigest(intent) || typeof result.exactRetry !== "boolean") {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_INTENT_NOT_DURABLE");
  }
}

function expectedPausedGeneration(intent: CatalogBridgePauseIntent): string {
  return (BigInt(intent.expectedGeneration) + 1n).toString();
}

function assertAcceptedPause(result: CatalogBridgePauseSubmission, intent: CatalogBridgePauseIntent): void {
  if (result.commandId !== intent.commandId || !["accepted", "deduplicated"].includes(result.outcome) ||
    result.state !== "paused" || result.generation !== expectedPausedGeneration(intent) ||
    !["RUNTIME_TRANSITION_APPLIED", "RUNTIME_ALREADY_IN_STATE"].includes(result.code)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PAUSE_REFUSED");
  }
}

function assertGenerationConflict(result: CatalogBridgePauseSubmission, intent: CatalogBridgePauseIntent): void {
  if (result.commandId !== intent.commandId || result.outcome !== "conflict" ||
    result.code !== "RUNTIME_GENERATION_CONFLICT" || result.state !== "idle" ||
    result.generation !== expectedPausedGeneration(intent)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PAUSE_REFUSED");
  }
}

async function readCommand(dependencies: CatalogBridgeDrainDependencies,
  intent: CatalogBridgePauseIntent): Promise<CatalogBridgePauseCommand> {
  const command = await dependencies.readPauseCommand(intent.commandId);
  if (command === null) refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PAUSE_PROVENANCE_MISSING");
  assertCatalogBridgePauseCommand(command, intent);
  return command;
}

function parameters(options: CatalogBridgeDrainOptions): Readonly<{
  maximumObservations: number;
  pollMilliseconds: number;
}> {
  const maximumObservations = options.maximumObservations ?? 75;
  const pollMilliseconds = options.pollMilliseconds ?? 1_000;
  if (!Number.isSafeInteger(maximumObservations) || maximumObservations < 1 || maximumObservations > 300 ||
    !Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 1 || pollMilliseconds > 5_000) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_WAIT_BOUNDS_INVALID");
  }
  return { maximumObservations, pollMilliseconds };
}

async function waitForPausedDrain(input: Readonly<{
  dependencies: CatalogBridgeDrainDependencies;
  pins: CatalogBridgeDrainPins;
  entry: CatalogBridgeDrainBoundary;
  intent: CatalogBridgePauseIntent;
  options: Required<CatalogBridgeDrainOptions>;
}>): Promise<CatalogBridgeDrainBoundary> {
  for (let index = 0; index < input.options.maximumObservations; index += 1) {
    const boundary = await input.dependencies.readBoundary();
    try {
      assertCatalogBridgePausedDrain(boundary, input.pins, { runId: input.intent.runId,
        runFence: input.intent.runFence, generation: expectedPausedGeneration(input.intent) });
      if (!sameOnlineProcess(input.entry.process, boundary.process)) {
        refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_CHANGED");
      }
      return boundary;
    } catch (error) {
      if (!(error instanceof CatalogBridgeError) || error.code !== "CATALOG_BRIDGE_DRAIN_NOT_SETTLED") throw error;
    }
    assertCatalogBridgePausedTransition(boundary, input.pins, input.entry, expectedPausedGeneration(input.intent));
    await input.dependencies.wait(input.options.pollMilliseconds);
  }
  return refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_WAIT_EXPIRED");
}

async function waitForIdleHead(input: Readonly<{
  dependencies: CatalogBridgeDrainDependencies;
  pins: CatalogBridgeDrainPins;
  entry: CatalogBridgeDrainBoundary;
  generation: string;
  options: Required<CatalogBridgeDrainOptions>;
}>): Promise<CatalogBridgeDrainBoundary> {
  for (let index = 0; index < input.options.maximumObservations; index += 1) {
    const boundary = await input.dependencies.readBoundary();
    if (!sameOnlineProcess(input.entry.process, boundary.process)) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_CHANGED");
    }
    try {
      assertCatalogBridgeIdleHead(boundary, input.pins, { runId: input.entry.run.id,
        runFence: input.entry.run.workerFence, generation: input.generation });
      return boundary;
    } catch (error) {
      if (!(error instanceof CatalogBridgeError) || error.code !== "CATALOG_BRIDGE_DRAIN_IDLE_HEAD_INVALID") throw error;
      if (boundary.runtime.state !== "idle" || boundary.runtime.generation !== input.generation ||
        boundary.runtime.activeRunCount !== 0 || boundary.runtime.actionableCommandCount !== 0 ||
        boundary.run.id !== input.entry.run.id || boundary.run.state !== "succeeded" ||
        !boundary.run.reachedSourceHead || boundary.importLease.owner !== input.entry.importLease.owner ||
        boundary.importLease.fence !== input.entry.importLease.fence) throw error;
    }
    await input.dependencies.wait(input.options.pollMilliseconds);
  }
  return refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_WAIT_EXPIRED");
}

async function bootoutAndProve(input: Readonly<{
  dependencies: CatalogBridgeDrainDependencies;
  pins: CatalogBridgeDrainPins;
  safeBoundary: CatalogBridgeDrainBoundary;
}>): Promise<Readonly<{ boundary: CatalogBridgeDrainBoundary; receipt: CatalogBridgeBootoutReceipt }>> {
  const process = input.safeBoundary.process;
  const pid = process.pids[0];
  if (pid === undefined || process.processIdentitySha256 === null) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_NOT_EXACT");
  }
  const receipt = await input.dependencies.bootout({ launchdLabel: process.launchdLabel,
    expectedPid: pid, expectedProcessIdentitySha256: process.processIdentitySha256 });
  assertCatalogBridgeBootoutReceipt(receipt, process);
  const boundary = await input.dependencies.readBoundary();
  assertCatalogBridgeProcessOffline(boundary);
  if (catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(boundary)) !==
    catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(input.safeBoundary))) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_CHANGED_DURING_BOOTOUT");
  }
  return { boundary, receipt };
}

async function persistResult(input: Readonly<{
  dependencies: CatalogBridgeDrainDependencies;
  pins: CatalogBridgeDrainPins;
  receipt: CatalogBridgeDrainReceipt;
}>): Promise<CatalogBridgeDrainResult> {
  const sha = catalogBridgeDigest(input.receipt);
  const persisted = await input.dependencies.persistReceipt(input.receipt);
  if (persisted.sha256 !== sha || typeof persisted.exactRetry !== "boolean") {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_NOT_DURABLE");
  }
  return { outcome: persisted.exactRetry ? "already_drained" : "drained", operationId: input.pins.operationId,
    providerKey: input.pins.providerKey, terminalKind: input.receipt.terminal.kind,
    pauseCommandId: input.receipt.pause.commandId, pauseCommandDigest: input.receipt.pause.commandDigest,
    gracefulStopReceiptSha256: sha };
}

async function offlineIdleHeadPause(input: Readonly<{
  dependencies: CatalogBridgeDrainDependencies;
  pins: CatalogBridgeDrainPins;
  safeIdle: CatalogBridgeDrainBoundary;
  initialProcess: CatalogBridgeDrainProcessObservation;
  priorIntents: readonly CatalogBridgePauseIntent[];
}>): Promise<CatalogBridgeDrainResult> {
  assertCatalogBridgeIdleHead(input.safeIdle, input.pins);
  const stopped = await bootoutAndProve({ dependencies: input.dependencies, pins: input.pins,
    safeBoundary: input.safeIdle });
  assertCatalogBridgeIdleHead(stopped.boundary, input.pins, { runId: input.safeIdle.run.id,
    runFence: input.safeIdle.run.workerFence, generation: input.safeIdle.runtime.generation });
  const intent = createCatalogBridgePauseIntent({ pins: input.pins, boundary: stopped.boundary,
    kind: "offline_idle_head" });
  const recorded = await input.dependencies.recordPauseIntent(intent);
  assertIntentRecorded(intent, recorded);
  const submitted = await input.dependencies.submitPause(intent);
  assertAcceptedPause(submitted, intent);
  const finalBoundary = await input.dependencies.readBoundary();
  assertCatalogBridgeProcessOffline(finalBoundary);
  const command = await readCommand(input.dependencies, intent);
  const receipt = createCatalogBridgeDrainReceipt({ pins: input.pins, entryKind: "offline_idle_head",
    intents: [...input.priorIntents, intent], command, finalBoundary,
    initialProcess: input.initialProcess, bootoutReceipt: stopped.receipt });
  return persistResult({ dependencies: input.dependencies, pins: input.pins, receipt });
}

async function recognizeRetry(input: Readonly<{
  dependencies: CatalogBridgeDrainDependencies;
  pins: CatalogBridgeDrainPins;
  value: unknown;
}>): Promise<CatalogBridgeDrainResult> {
  const receipt = assertCatalogBridgeDrainReceipt(input.value, input.pins);
  const boundary = await input.dependencies.readBoundary();
  const terminalKind = assertCatalogBridgePausedDrain(boundary, input.pins, { runId: receipt.terminal.runId,
    runFence: receipt.terminal.runFence, generation: receipt.pause.resultGeneration });
  assertCatalogBridgeProcessOffline(boundary);
  const command = await input.dependencies.readPauseCommand(receipt.pause.commandId);
  if (command === null || catalogBridgeDigest(command) !== receipt.pause.commandDigest ||
    command.commandType !== "pause" || command.state !== "completed" || command.resultOutcome !== "accepted" ||
    command.resultGeneration !== receipt.pause.resultGeneration || command.expectedGeneration !== receipt.pause.expectedGeneration ||
    command.requestedByOperatorId !== input.pins.operatorId || command.correlationId !== input.pins.operationId ||
    command.reason !== receipt.pause.reason || boundary.run.finalCursorHash !== receipt.terminal.finalCursorHash ||
    catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(boundary)) !== receipt.drainedEvidenceDigest ||
    catalogBridgeDigest(boundary.process) !== receipt.worker.offlineProcessEvidenceDigest ||
    terminalKind !== receipt.terminal.kind) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RETRY_DRIFT");
  }
  return { outcome: "already_drained", operationId: input.pins.operationId, providerKey: input.pins.providerKey,
    terminalKind, pauseCommandId: receipt.pause.commandId, pauseCommandDigest: receipt.pause.commandDigest,
    gracefulStopReceiptSha256: catalogBridgeDigest(receipt) };
}

export async function drainCatalogBridgeProvider(input: Readonly<{
  pins: CatalogBridgeDrainPins;
  dependencies: CatalogBridgeDrainDependencies;
  options?: CatalogBridgeDrainOptions;
}>): Promise<CatalogBridgeDrainResult> {
  catalogBridgeProvider(input.pins.providerKey);
  const existing = await input.dependencies.readExistingReceipt();
  if (existing !== null) return recognizeRetry({ dependencies: input.dependencies, pins: input.pins, value: existing });
  const options = parameters(input.options ?? {}) as Required<CatalogBridgeDrainOptions>;
  const entry = await input.dependencies.readBoundary();
  if (entry.runtime.state === "idle") {
    assertCatalogBridgeIdleHead(entry, input.pins);
    return offlineIdleHeadPause({ dependencies: input.dependencies, pins: input.pins,
      safeIdle: entry, initialProcess: entry.process, priorIntents: [] });
  }
  assertCatalogBridgeRunningEntry(entry, input.pins);
  const intent = createCatalogBridgePauseIntent({ pins: input.pins, boundary: entry, kind: "running" });
  const recorded = await input.dependencies.recordPauseIntent(intent);
  assertIntentRecorded(intent, recorded);
  const submitted = await input.dependencies.submitPause(intent);
  if (submitted.outcome === "conflict") {
    assertGenerationConflict(submitted, intent);
    const idle = await waitForIdleHead({ dependencies: input.dependencies, pins: input.pins, entry,
      generation: submitted.generation, options });
    return offlineIdleHeadPause({ dependencies: input.dependencies, pins: input.pins,
      safeIdle: idle, initialProcess: entry.process, priorIntents: [intent] });
  }
  assertAcceptedPause(submitted, intent);
  const drained = await waitForPausedDrain({ dependencies: input.dependencies, pins: input.pins, entry, intent, options });
  const command = await readCommand(input.dependencies, intent);
  const stopped = await bootoutAndProve({ dependencies: input.dependencies, pins: input.pins, safeBoundary: drained });
  const receipt = createCatalogBridgeDrainReceipt({ pins: input.pins, entryKind: "running", intents: [intent],
    command, finalBoundary: stopped.boundary, initialProcess: entry.process, bootoutReceipt: stopped.receipt });
  return persistResult({ dependencies: input.dependencies, pins: input.pins, receipt });
}

export async function runCatalogBridgeDrainCli(input: Readonly<{
  pins: CatalogBridgeDrainPins;
  dependencies: CatalogBridgeDrainDependencies;
  options?: CatalogBridgeDrainOptions;
  output: (value: unknown) => void;
  error: (value: unknown) => void;
}>): Promise<number> {
  try {
    input.output(await drainCatalogBridgeProvider(input));
    return 0;
  } catch (error) {
    input.error({ outcome: "refused", code: error instanceof CatalogBridgeError
      ? error.code : "CATALOG_BRIDGE_DRAIN_FAILED" });
    return 1;
  }
}
