import {
  assertCatalogHead,
  catalogBridgeDigest,
  refuseCatalogBridge,
  type CatalogBridgeCanonicalEvidence,
  type CatalogBridgeHeadObservation,
  type CatalogBridgePrivatePreparedState,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  catalogBridgePhases,
  recordCatalogActivated,
  recordCatalogCompleted,
  recordCatalogRunAdmitted,
  type CatalogBridgeCatalogRunAdmissionObservation,
  type CatalogBridgePublicJournal,
  type CatalogBridgeQuiescentConfigurationObservation,
} from "./dataforrest-catalog-bridge-state.mts";
import type { CatalogBridgeJournalCommit } from
  "./dataforrest-catalog-bridge-journal.mts";
import type { CatalogBridgeCatalogLivePolicy } from
  "./dataforrest-catalog-bridge-catalog-live-policy.mts";

export interface CatalogBridgeCatalogReadyObservation {
  readonly observedAt: string;
  readonly residentOffline: boolean;
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerRowVersion: string;
  readonly centralAuthorityDigest: string;
  readonly databaseRouteDigest: string;
  readonly activeConfigId: string;
  readonly activeConfigNumber: number;
  readonly maximumConfigNumber: number;
  readonly runtimeState: string;
  readonly runtimeGeneration: string;
  readonly runtimeRowVersion: string;
  readonly cachedConfigId: string;
  readonly cachedConfigNumber: number;
  readonly sourceCursorPresent: boolean;
  readonly sourceCursorHash: string | null;
  readonly latestTerminalRunId: string;
  readonly latestTerminalRunDigest: string;
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly importLeaseOwner: string | null;
  readonly otherActiveTransactionCount: number;
  readonly canonical: CatalogBridgeCanonicalEvidence;
}

export interface CatalogBridgeCatalogStageDependencies {
  readPreparedBoundary(): Promise<CatalogBridgeCatalogReadyObservation>;
  activateCatalogConfiguration(): Promise<CatalogBridgeQuiescentConfigurationObservation>;
  admitCatalogRun(input: Readonly<{
    originReceiptDigest: string;
  }>): Promise<CatalogBridgeCatalogRunAdmissionObservation>;
  readCatalogHead(): Promise<CatalogBridgeHeadObservation | null>;
  executeCatalogRun(): Promise<Readonly<{
    kind: "completed";
    runId: string;
  }> | Readonly<{
    kind: "failed" | "blocked";
    runId: string | null;
    failureCode: string;
  }>>;
  persistJournal(input: Readonly<{
    expected: CatalogBridgePublicJournal;
    next: CatalogBridgePublicJournal;
  }>): Promise<CatalogBridgeJournalCommit>;
  ensureResidentOfflineAndPaused(input?: Readonly<{ originReceiptDigest: string }>): Promise<void>;
}

function catalogRecoveryInput(journal: CatalogBridgePublicJournal):
Readonly<{ originReceiptDigest: string }> | undefined {
  const receipt = journal.receipts[catalogBridgePhases.indexOf("catalog_activated")];
  return receipt ? Object.freeze({ originReceiptDigest: catalogBridgeDigest(receipt) }) : undefined;
}

function assertPolicyBinding(input: Readonly<{
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  journal: CatalogBridgePublicJournal;
  commit: CatalogBridgeJournalCommit;
}>): void {
  const { policy, state, journal, commit } = input;
  const preflight = state.preflight;
  const current = preflight.runtime;
  const preparedReceipt = journal.receipts[0];
  const preparedJournal = preparedReceipt === undefined ? null : Object.freeze({ ...journal,
    phase: "prepared" as const, receipts: Object.freeze([preparedReceipt]),
    headReceiptHash: catalogBridgeDigest(preparedReceipt) });
  if (state.operationId !== policy.pins.operationId ||
    state.providerKey !== policy.pins.providerKey ||
    state.planDigest !== catalogBridgeDigest(policy.pins) ||
    journal.operationId !== state.operationId || journal.providerKey !== state.providerKey ||
    journal.planDigest !== state.planDigest ||
    commit.operationId !== state.operationId || commit.providerKey !== state.providerKey ||
    commit.privateStateSha256 !== policy.prepared.privateStateSha256 ||
    commit.publicJournalSha256 !== catalogBridgeDigest(journal) ||
    policy.prepared.privateStateSha256 !== catalogBridgeDigest(state) ||
    preparedJournal === null || policy.prepared.publicJournalSha256 !== catalogBridgeDigest(preparedJournal) ||
    policy.prepared.journalHeadReceiptSha256 !== preparedJournal.headReceiptHash ||
    policy.current.providerId !== current.providerId ||
    policy.current.configId !== current.cachedConfigId ||
    policy.current.configNumber !== current.cachedConfigNumber ||
    policy.current.providerRowVersion !== preflight.central.providerRowVersion ||
    policy.current.centralAuthorityDigest !== preflight.central.authorityDigest ||
    policy.current.databaseRouteDigest !== preflight.central.databaseRouteDigest ||
    policy.current.runtimeGeneration !== current.generation ||
    policy.current.runtimeRowVersion !== current.rowVersion ||
    policy.current.sourceCursorHash !== current.sourceCursorHash ||
    policy.current.latestTerminalRunId !== current.latestTerminalRun.runId ||
    policy.current.latestTerminalRunDigest !== current.latestTerminalRun.runDigest ||
    policy.current.pauseCommandId !== current.pauseProvenance.commandId ||
    policy.current.pauseCommandDigest !== current.pauseProvenance.commandDigest ||
    policy.evidence.drainReceiptSha256 !== preflight.worker.gracefulStopReceiptSha256 ||
    policy.evidence.catalogOriginCanarySha256 !== preflight.sourceCanaries.catalogOrigin.responseSha256 ||
    policy.evidence.savedEventCanarySha256 !== preflight.sourceCanaries.savedEventCursor.responseSha256 ||
    policy.evidence.baselineSha256 !== catalogBridgeDigest(preflight.baseline)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_POLICY_BINDING_CHANGED");
  }
}

function assertPreparedBoundary(input: Readonly<{
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  observation: CatalogBridgeCatalogReadyObservation;
}>): void {
  const { policy, state, observation } = input;
  const expected = state.preflight;
  if (!Number.isFinite(Date.parse(observation.observedAt)) || !observation.residentOffline ||
    observation.providerId !== policy.current.providerId ||
    observation.providerKey !== policy.pins.providerKey ||
    observation.providerRowVersion !== policy.current.providerRowVersion ||
    observation.centralAuthorityDigest !== policy.current.centralAuthorityDigest ||
    observation.databaseRouteDigest !== policy.current.databaseRouteDigest ||
    observation.activeConfigId !== policy.current.configId ||
    observation.activeConfigNumber !== policy.current.configNumber ||
    observation.maximumConfigNumber !== policy.current.configNumber ||
    observation.runtimeState !== "paused" ||
    observation.runtimeGeneration !== policy.current.runtimeGeneration ||
    observation.runtimeRowVersion !== policy.current.runtimeRowVersion ||
    observation.cachedConfigId !== policy.current.configId ||
    observation.cachedConfigNumber !== policy.current.configNumber ||
    !observation.sourceCursorPresent || observation.sourceCursorHash !== policy.current.sourceCursorHash ||
    observation.latestTerminalRunId !== policy.current.latestTerminalRunId ||
    observation.latestTerminalRunDigest !== policy.current.latestTerminalRunDigest ||
    observation.pauseCommandId !== policy.current.pauseCommandId ||
    observation.pauseCommandDigest !== policy.current.pauseCommandDigest ||
    observation.activeRunCount !== 0 || observation.actionableCommandCount !== 0 ||
    observation.importLeaseOwner !== null || observation.otherActiveTransactionCount !== 0 ||
    catalogBridgeDigest(observation.canonical) !== catalogBridgeDigest(expected.baseline)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREPARED_BOUNDARY_CHANGED");
  }
}

export async function runCatalogBridgeCatalogStage(input: Readonly<{
  mode: "check_only" | "apply";
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  journal: CatalogBridgePublicJournal;
  commit: CatalogBridgeJournalCommit;
  dependencies: CatalogBridgeCatalogStageDependencies;
}>): Promise<Readonly<Record<string, unknown>>> {
  assertPolicyBinding(input);
  const prepared = input.mode === "check_only" || input.journal.phase === "prepared"
    ? await input.dependencies.readPreparedBoundary() : null;
  // Check-only proves the untouched admission boundary. Apply deliberately lets
  // the database adapter classify and reconcile an exact durable prefix: each
  // catalog substep is independently CAS/idempotency guarded, while a crash can
  // occur before the single public catalog_activated receipt is persisted.
  if (input.journal.phase === "prepared" && input.mode === "check_only") {
    if (prepared === null) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREPARED_BOUNDARY_CHANGED");
    assertPreparedBoundary({ ...input, observation: prepared });
  }
  if (input.mode === "check_only") {
    if (prepared === null) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREPARED_BOUNDARY_CHANGED");
    return Object.freeze({ outcome: "ready", mode: "check_only", operationId: input.state.operationId,
      providerKey: input.state.providerKey, phase: input.journal.phase,
      boundaryEvidenceSha256: catalogBridgeDigest(prepared), databaseWritesPerformed: false,
      sourceExecutionPerformed: false });
  }

  let journal = input.journal;
  try {
    if (journal.phase === "prepared") {
      const activated = await input.dependencies.activateCatalogConfiguration();
      const next = recordCatalogActivated({ journal, state: input.state, observation: activated });
      await input.dependencies.persistJournal({ expected: journal, next });
      journal = next;
    }
    if (journal.phase === "catalog_activated") {
      const activationReceipt = journal.receipts[catalogBridgePhases.indexOf("catalog_activated")];
      if (!activationReceipt) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ACTIVATION_RECEIPT_MISSING");
      const admitted = await input.dependencies.admitCatalogRun({
        originReceiptDigest: catalogBridgeDigest(activationReceipt),
      });
      const next = recordCatalogRunAdmitted({ journal, state: input.state, observation: admitted });
      await input.dependencies.persistJournal({ expected: journal, next });
      journal = next;
    }
    if (journal.phase === "catalog_run_admitted") {
      if (input.journal.phase === "catalog_run_admitted") {
        const activationReceipt = journal.receipts[catalogBridgePhases.indexOf("catalog_activated")];
        if (!activationReceipt) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ACTIVATION_RECEIPT_MISSING");
        // Re-admission performs no source I/O. It only re-proves the exact
        // operation-owned deterministic queue, renews its utility fence, and
        // resumes an operation-owned safety pause when one exists.
        await input.dependencies.admitCatalogRun({
          originReceiptDigest: catalogBridgeDigest(activationReceipt),
        });
      }
      let head = await input.dependencies.readCatalogHead();
      if (head === null) {
        const result = await input.dependencies.executeCatalogRun();
        if (result.kind !== "completed" || result.runId !== input.state.catalogRunId) {
          refuseCatalogBridge(result.kind === "completed"
            ? "CATALOG_BRIDGE_CATALOG_RUN_ID_CHANGED"
            : `CATALOG_BRIDGE_CATALOG_RUN_${result.failureCode}`);
        }
        head = await input.dependencies.readCatalogHead();
      }
      if (head === null) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_MISSING");
      const next = recordCatalogCompleted({ pins: input.policy.pins, journal, state: input.state,
        observedAt: new Date().toISOString(), observation: head });
      await input.dependencies.persistJournal({ expected: journal, next });
      journal = next;
    } else if (journal.phase === "catalog_completed") {
      const head = await input.dependencies.readCatalogHead();
      if (head === null) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_MISSING");
      assertCatalogHead({ pins: input.policy.pins, state: input.state, observation: head });
    }
    await input.dependencies.ensureResidentOfflineAndPaused(catalogRecoveryInput(journal));
    return Object.freeze({ outcome: journal.phase === input.journal.phase ? "already_completed" : "completed",
      mode: "apply", operationId: input.state.operationId, providerKey: input.state.providerKey,
      phase: journal.phase, journalHeadReceiptSha256: journal.headReceiptHash });
  } catch (error) {
    try {
      await input.dependencies.ensureResidentOfflineAndPaused(catalogRecoveryInput(journal));
    } catch {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_SAFE_PAUSE_UNPROVEN");
    }
    throw error;
  }
}
