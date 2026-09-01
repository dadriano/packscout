import {
  catalogBridgeDigest,
  refuseCatalogBridge,
  type CatalogBridgePrivatePreparedState,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  catalogBridgePhases,
  recordEventCursorRestored,
  recordEventSuccessorStaged,
  recordResumed,
  type CatalogBridgeCursorRestoreObservation,
  type CatalogBridgeEventSuccessorStageObservation,
  type CatalogBridgePublicJournal,
  type CatalogBridgeResumeObservation,
} from "./dataforrest-catalog-bridge-state.mts";
import type { CatalogBridgeJournalCommit } from "./dataforrest-catalog-bridge-journal.mts";
import type { CatalogBridgeCatalogLivePolicy } from
  "./dataforrest-catalog-bridge-catalog-live-policy.mts";

export interface CatalogBridgeEventResumeReadyObservation {
  readonly observedAt: string;
  readonly residentOffline: boolean;
  readonly runtimeState: "paused" | "idle" | "running";
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly importLeaseOwner: string | null;
  readonly importLeaseHeartbeatAt: string | null;
  readonly importLeaseExpiresAt: string | null;
  readonly otherActiveTransactionCount: number;
  readonly activeConfigId: string;
  readonly cachedConfigId: string;
  readonly stagedLaunchAgentSha256: string;
}

export interface CatalogBridgeEventResumeDependencies {
  readEventBoundary(): Promise<CatalogBridgeEventResumeReadyObservation>;
  stageEventSuccessor(input: Readonly<{ catalogRunDigest: string }> ):
    Promise<CatalogBridgeEventSuccessorStageObservation>;
  restoreEventCursor(input: Readonly<{ eventStageReceiptDigest: string;
    expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
    catalogRunDigest: string }> ):
    Promise<CatalogBridgeCursorRestoreObservation>;
  resumeResident(input: Readonly<{ cursorRestoreReceiptDigest: string;
    expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
    restoredCursorHash: string }> ):
    Promise<CatalogBridgeResumeObservation>;
  readResumed(): Promise<CatalogBridgeResumeObservation | null>;
  releaseResidentAfterJournal(input: Readonly<{ resumedReceiptDigest: string }>): Promise<void>;
  persistJournal(input: Readonly<{ expected: CatalogBridgePublicJournal;
    next: CatalogBridgePublicJournal }>): Promise<CatalogBridgeJournalCommit>;
  ensureResidentOfflineAndPaused(): Promise<void>;
}

function phaseReceipt(journal: CatalogBridgePublicJournal,
  phase: typeof catalogBridgePhases[number]) {
  return journal.receipts[catalogBridgePhases.indexOf(phase)] ?? null;
}

function assertReady(input: Readonly<{ policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; journal: CatalogBridgePublicJournal;
  mode: "check_only" | "apply";
  observation: CatalogBridgeEventResumeReadyObservation }>): void {
  const value = input.observation;
  const plan = (input.state.catalogConfigId === value.activeConfigId ||
    input.state.eventSuccessorConfigId === value.activeConfigId);
  const resumed = input.journal.phase === "resumed";
  const reconcilingAdmission = input.mode === "apply" &&
    input.journal.phase === "event_cursor_restored";
  if (!Number.isFinite(Date.parse(value.observedAt)) ||
    (!reconcilingAdmission && (resumed ? value.residentOffline : !value.residentOffline)) || !plan ||
    ![input.state.catalogConfigId, input.state.eventSuccessorConfigId].includes(value.cachedConfigId) ||
    (!reconcilingAdmission && !["paused", "idle"].includes(value.runtimeState)) ||
    (reconcilingAdmission && !["paused", "idle", "running"].includes(value.runtimeState)) ||
    (!reconcilingAdmission && (value.activeRunCount !== 0 || value.actionableCommandCount !== 0 ||
      value.importLeaseOwner !== null ||
      value.importLeaseHeartbeatAt !== null || value.importLeaseExpiresAt !== null ||
      value.otherActiveTransactionCount !== 0)) ||
    value.stagedLaunchAgentSha256 !== input.policy.successorLaunchAgent.fileSha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_READY_BOUNDARY_CHANGED");
  }
  const phase = input.journal.phase;
  if (phase === "catalog_completed" && (value.activeConfigId !== input.state.catalogConfigId ||
    value.cachedConfigId !== input.state.catalogConfigId || value.runtimeState !== "paused")) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_READY_BOUNDARY_CHANGED");
  }
  if (phase === "event_successor_staged") {
    const exactRestorePrefix = value.runtimeState === "paused" && (
      (value.activeConfigId === input.state.catalogConfigId &&
        [input.state.catalogConfigId, input.state.eventSuccessorConfigId].includes(value.cachedConfigId)) ||
      (value.activeConfigId === input.state.eventSuccessorConfigId &&
        value.cachedConfigId === input.state.eventSuccessorConfigId));
    if ((input.mode === "check_only" &&
      (value.activeConfigId !== input.state.catalogConfigId ||
        value.cachedConfigId !== input.state.catalogConfigId || value.runtimeState !== "paused")) ||
      (input.mode === "apply" && !exactRestorePrefix)) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_READY_BOUNDARY_CHANGED");
    }
  }
  if (phase === "event_cursor_restored" &&
    (value.activeConfigId !== input.state.eventSuccessorConfigId ||
      value.cachedConfigId !== input.state.eventSuccessorConfigId ||
      (input.mode === "check_only" ? value.runtimeState !== "paused" :
        !["paused", "idle", "running"].includes(value.runtimeState)))) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_READY_BOUNDARY_CHANGED");
  }
  if (phase === "resumed" && (value.activeConfigId !== input.state.eventSuccessorConfigId ||
    value.cachedConfigId !== input.state.eventSuccessorConfigId || value.runtimeState !== "idle")) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_READY_BOUNDARY_CHANGED");
  }
}

export async function runCatalogBridgeEventResumeStage(input: Readonly<{
  mode: "check_only" | "apply";
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  journal: CatalogBridgePublicJournal;
  commit: CatalogBridgeJournalCommit;
  dependencies: CatalogBridgeEventResumeDependencies;
}>): Promise<Readonly<Record<string, unknown>>> {
  if (!input.journal.receipts.some((entry) => entry.phase === "catalog_completed") ||
    input.commit.publicJournalSha256 !== catalogBridgeDigest(input.journal) ||
    input.commit.privateStateSha256 !== catalogBridgeDigest(input.state)) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_JOURNAL_BINDING_CHANGED");
  }
  if (input.mode === "apply" && input.journal.phase === "resumed") {
    await input.dependencies.releaseResidentAfterJournal({
      resumedReceiptDigest: input.journal.headReceiptHash,
    });
    return Object.freeze({ outcome: "already_completed", mode: "apply",
      operationId: input.state.operationId, providerKey: input.state.providerKey,
      phase: input.journal.phase, journalHeadReceiptSha256: input.journal.headReceiptHash });
  }
  const ready = await input.dependencies.readEventBoundary();
  assertReady({ ...input, observation: ready });
  if (input.mode === "check_only") {
    return Object.freeze({ outcome: "ready", mode: "check_only",
      operationId: input.state.operationId, providerKey: input.state.providerKey,
      phase: input.journal.phase, boundaryEvidenceSha256: catalogBridgeDigest(ready),
      databaseWritesPerformed: false, launchctlBootstrapPerformed: false,
      sourceExecutionPerformed: false });
  }
  let journal = input.journal;
  let residentGateProtected = journal.phase === "resumed";
  try {
    if (journal.phase === "catalog_completed") {
      const catalogReceipt = phaseReceipt(journal, "catalog_completed");
      if (!catalogReceipt || typeof catalogReceipt.evidence.catalogRunDigest !== "string") {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CATALOG_RECEIPT_MISSING");
      }
      const staged = await input.dependencies.stageEventSuccessor({
        catalogRunDigest: catalogReceipt.evidence.catalogRunDigest,
      });
      const next = recordEventSuccessorStaged({ journal, state: input.state, observation: staged });
      await input.dependencies.persistJournal({ expected: journal, next });
      journal = next;
    }
    if (journal.phase === "event_successor_staged") {
      const stageReceipt = phaseReceipt(journal, "event_successor_staged");
      if (!stageReceipt) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_STAGE_RECEIPT_MISSING");
      const expectedProviderRowVersion = stageReceipt.evidence.centralProviderRowVersion;
      const expectedRuntimeRowVersion = stageReceipt.evidence.runtimeRowVersion;
      const catalogRunDigest = stageReceipt.evidence.latestTerminalRunDigest;
      if (typeof expectedProviderRowVersion !== "string" ||
        typeof expectedRuntimeRowVersion !== "string" || typeof catalogRunDigest !== "string") {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_STAGE_RECEIPT_MISSING");
      }
      const restored = await input.dependencies.restoreEventCursor({
        eventStageReceiptDigest: catalogBridgeDigest(stageReceipt),
        expectedProviderRowVersion, expectedRuntimeRowVersion, catalogRunDigest,
      });
      const next = recordEventCursorRestored({ journal, state: input.state, observation: restored });
      await input.dependencies.persistJournal({ expected: journal, next });
      journal = next;
    }
    if (journal.phase === "event_cursor_restored") {
      const restoreReceipt = phaseReceipt(journal, "event_cursor_restored");
      if (!restoreReceipt) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CURSOR_RECEIPT_MISSING");
      const expectedProviderRowVersion = restoreReceipt.evidence.providerRowVersion;
      const expectedRuntimeRowVersion = restoreReceipt.evidence.runtimeRowVersion;
      const restoredCursorHash = restoreReceipt.evidence.restoredCursorHash;
      if (typeof expectedProviderRowVersion !== "string" ||
        typeof expectedRuntimeRowVersion !== "string" || typeof restoredCursorHash !== "string") {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CURSOR_RECEIPT_MISSING");
      }
      // Admission is deterministic and the awaited resident may reach its
      // immutable handoff before the observation call returns. From this
      // boundary onward recovery must retry that exact admission; pausing the
      // resident would advance its generation beyond the persisted handoff.
      residentGateProtected = true;
      const resumed = await input.dependencies.resumeResident({
        cursorRestoreReceiptDigest: catalogBridgeDigest(restoreReceipt),
        expectedProviderRowVersion, expectedRuntimeRowVersion, restoredCursorHash,
      });
      const next = recordResumed({ journal, state: input.state, observation: resumed });
      // From this point the awaited resident is protected by its database
      // handoff gate. Unknown journal-commit outcomes must not pause it, because
      // the authoritative commit may already select the resumed receipt.
      await input.dependencies.persistJournal({ expected: journal, next });
      journal = next;
      await input.dependencies.releaseResidentAfterJournal({
        resumedReceiptDigest: journal.headReceiptHash,
      });
    } else if (journal.phase === "resumed") {
      const resumed = await input.dependencies.readResumed();
      if (!resumed) refuseCatalogBridge("CATALOG_BRIDGE_RESUME_EVIDENCE_MISSING");
      recordResumed({ journal, state: input.state, observation: resumed });
      residentGateProtected = true;
    }
    return Object.freeze({ outcome: journal.phase === input.journal.phase ? "already_completed" : "completed",
      mode: "apply", operationId: input.state.operationId, providerKey: input.state.providerKey,
      phase: journal.phase, journalHeadReceiptSha256: journal.headReceiptHash });
  } catch (error) {
    if (!residentGateProtected) {
      try { await input.dependencies.ensureResidentOfflineAndPaused(); }
      catch { refuseCatalogBridge("CATALOG_BRIDGE_EVENT_SAFE_PAUSE_UNPROVEN"); }
    }
    throw error;
  }
}
