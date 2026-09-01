import {
  assertCatalogHead,
  catalogBridgeConfigurationPlan,
  catalogBridgeDigest,
  catalogBridgePauseCommandDigest,
  catalogBridgeProvider,
  reEnvelopeSavedEventCursor,
  refuseCatalogBridge,
  type CatalogBridgeCanonicalEvidence,
  type CatalogBridgeHeadObservation,
  type CatalogBridgeOperationPins,
  type CatalogBridgePrivatePreparedState,
  type CatalogBridgePublicPreparedReceipt,
} from "./dataforrest-catalog-bridge-plan.mts";

const sha256 = /^[a-f0-9]{64}$/u;
const positiveInteger = /^[1-9][0-9]*$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const catalogBridgePhases = Object.freeze([
  "prepared",
  "catalog_activated",
  "catalog_run_admitted",
  "catalog_completed",
  "event_successor_staged",
  "event_cursor_restored",
  "resumed",
] as const);
export type CatalogBridgePhase = typeof catalogBridgePhases[number];

export interface CatalogBridgeReceipt {
  readonly schemaVersion: "dataforrest_catalog_bridge_receipt_v1";
  readonly phase: CatalogBridgePhase;
  readonly operationId: string;
  readonly providerKey: string;
  readonly planDigest: string;
  readonly observedAt: string;
  readonly previousReceiptHash: string | null;
  readonly evidence: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CatalogBridgePublicJournal {
  readonly schemaVersion: "dataforrest_catalog_bridge_journal_v1";
  readonly operationId: string;
  readonly providerKey: string;
  readonly planDigest: string;
  readonly phase: CatalogBridgePhase;
  readonly receipts: readonly CatalogBridgeReceipt[];
  readonly headReceiptHash: string;
}

function receiptFromPrepared(receipt: CatalogBridgePublicPreparedReceipt): CatalogBridgeReceipt {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    phase: receipt.phase,
    operationId: receipt.operationId,
    providerKey: receipt.providerKey,
    planDigest: receipt.planDigest,
    observedAt: receipt.preparedAt,
    previousReceiptHash: null,
    evidence: Object.freeze({
      providerRowVersion: receipt.providerRowVersion,
      runtimeGeneration: receipt.runtimeGeneration,
      runtimeRowVersion: receipt.runtimeRowVersion,
      authorityDigest: receipt.authorityDigest,
      savedEventCursorHash: receipt.savedEventCursorHash,
      savedOpaqueValueHash: receipt.savedOpaqueValueHash,
      catalogOriginResponseSha256: receipt.catalogOriginResponseSha256,
      savedEventCanaryResponseSha256: receipt.savedEventCanaryResponseSha256,
      gracefulStopReceiptSha256: receipt.gracefulStopReceiptSha256,
      pauseCommandId: receipt.pauseCommandId,
      pauseCommandDigest: receipt.pauseCommandDigest,
      latestTerminalRunId: receipt.latestTerminalRunId,
      latestTerminalRunDigest: receipt.latestTerminalRunDigest,
      baselineDigest: receipt.baselineDigest,
      sourceHeadCountProvenance: receipt.sourceHeadCountProvenance,
      sourceHeadCardCount: receipt.sourceHeadCardCount,
      sourceHeadPackCount: receipt.sourceHeadPackCount,
    }),
  });
}

export function createCatalogBridgeJournal(receipt: CatalogBridgePublicPreparedReceipt): CatalogBridgePublicJournal {
  const prepared = receiptFromPrepared(receipt);
  const headReceiptHash = catalogBridgeDigest(prepared);
  return Object.freeze({ schemaVersion: "dataforrest_catalog_bridge_journal_v1", operationId: receipt.operationId,
    providerKey: receipt.providerKey, planDigest: receipt.planDigest, phase: "prepared",
    receipts: Object.freeze([prepared]), headReceiptHash });
}

const receiptKeys = Object.freeze(["evidence", "observedAt", "operationId", "phase", "planDigest",
  "previousReceiptHash", "providerKey", "schemaVersion"]);
const evidenceKeys = Object.freeze({
  prepared: ["authorityDigest", "baselineDigest", "catalogOriginResponseSha256", "gracefulStopReceiptSha256",
    "latestTerminalRunDigest", "latestTerminalRunId", "pauseCommandDigest", "pauseCommandId", "providerRowVersion",
    "runtimeGeneration", "runtimeRowVersion", "savedEventCanaryResponseSha256", "savedEventCursorHash",
    "savedOpaqueValueHash", "sourceHeadCardCount", "sourceHeadCountProvenance", "sourceHeadPackCount"],
  catalog_activated: ["canonicalDigest", "catalogConfigId", "catalogConfigNumber", "configurationDigest",
    "providerRowVersion", "runtimeGeneration", "runtimeRowVersion"],
  catalog_run_admitted: ["catalogRunConfigId", "catalogRunConfigNumber", "catalogRunId", "pausedOriginGuardDigest",
    "requestRunCommandDigest", "requestRunCommandId", "resumeCommandDigest", "resumeCommandId",
    "runtimeGeneration", "utilityLeaseDigest"],
  catalog_completed: ["canonicalAfterDigest", "cardRecordCount", "catalogRecordCount", "catalogRunDigest",
    "catalogRunId", "distinctCardIdentityCount", "distinctPackIdentityCount", "identityChainDigest",
    "identityMultisetDigest", "marketEventRecordCount", "packRecordCount", "pullRecordCount",
    "quarantinedCount", "runtimeState", "sourceHeadCountProvenance", "sourceRecordCount"],
  event_successor_staged: ["activationProofDigest", "centralProviderRowVersion", "eventAdapterVersion",
    "eventSuccessorConfigId", "eventSuccessorConfigNumber", "latestTerminalRunDigest", "latestTerminalRunId",
    "postCatalogPauseCommandDigest", "postCatalogPauseCommandId", "runtimeGeneration", "runtimeRowVersion",
    "stagedConfigurationDigest"],
  event_cursor_restored: ["canonicalDigest", "cursorEnvelopeDigest", "eventSuccessorConfigId",
    "providerRowVersion", "restoredCursorHash", "restoredOpaqueValueHash", "runtimeGeneration",
    "runtimeRowVersion", "configurationDigest"],
  resumed: ["eventSuccessorConfigId", "launchdLabel", "processCount", "residencyPortListening",
    "startupRunId", "startupRunReachedHead", "startupRunRequestedCursorHash"],
} satisfies Record<CatalogBridgePhase, readonly string[]>);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function assertPublicReceipt(receipt: CatalogBridgeReceipt): void {
  if (!exactKeys(receipt as unknown as Record<string, unknown>, receiptKeys) ||
    !exactKeys(receipt.evidence as Record<string, unknown>, evidenceKeys[receipt.phase]) ||
    Object.values(receipt.evidence).some((value) => value !== null &&
      typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
    refuseCatalogBridge("CATALOG_BRIDGE_PUBLIC_RECEIPT_INVALID");
  }
}

export function assertCatalogBridgeJournal(journal: CatalogBridgePublicJournal): CatalogBridgePublicJournal {
  if (journal.schemaVersion !== "dataforrest_catalog_bridge_journal_v1" || journal.receipts.length < 1 ||
    journal.receipts.length > catalogBridgePhases.length || journal.phase !== journal.receipts.at(-1)?.phase ||
    journal.headReceiptHash !== catalogBridgeDigest(journal.receipts.at(-1))) {
    refuseCatalogBridge("CATALOG_BRIDGE_JOURNAL_INVALID");
  }
  let previous: string | null = null;
  for (const [index, receipt] of journal.receipts.entries()) {
    if (receipt.schemaVersion !== "dataforrest_catalog_bridge_receipt_v1" ||
      receipt.phase !== catalogBridgePhases[index] || receipt.operationId !== journal.operationId ||
      receipt.providerKey !== journal.providerKey || receipt.planDigest !== journal.planDigest ||
      receipt.previousReceiptHash !== previous || !Number.isFinite(Date.parse(receipt.observedAt))) {
      refuseCatalogBridge("CATALOG_BRIDGE_JOURNAL_CHAIN_INVALID");
    }
    assertPublicReceipt(receipt);
    previous = catalogBridgeDigest(receipt);
  }
  return journal;
}

function appendReceipt(journal: CatalogBridgePublicJournal, receipt: CatalogBridgeReceipt): CatalogBridgePublicJournal {
  assertCatalogBridgeJournal(journal);
  const desiredIndex = catalogBridgePhases.indexOf(receipt.phase);
  const currentIndex = catalogBridgePhases.indexOf(journal.phase);
  const existing = journal.receipts[desiredIndex];
  if (existing) {
    if (catalogBridgeDigest(existing) !== catalogBridgeDigest(receipt)) {
      refuseCatalogBridge("CATALOG_BRIDGE_RETRY_EVIDENCE_CHANGED");
    }
    return journal;
  }
  if (desiredIndex !== currentIndex + 1 || receipt.operationId !== journal.operationId ||
    receipt.providerKey !== journal.providerKey || receipt.planDigest !== journal.planDigest ||
    receipt.previousReceiptHash !== journal.headReceiptHash) {
    refuseCatalogBridge("CATALOG_BRIDGE_PHASE_ORDER_INVALID");
  }
  assertPublicReceipt(receipt);
  const receipts = Object.freeze([...journal.receipts, Object.freeze(receipt)]);
  return Object.freeze({ ...journal, phase: receipt.phase, receipts, headReceiptHash: catalogBridgeDigest(receipt) });
}

function receipt(input: Readonly<{
  journal: CatalogBridgePublicJournal; state: CatalogBridgePrivatePreparedState; phase: CatalogBridgePhase;
  observedAt: string; evidence: Readonly<Record<string, string | number | boolean | null>>;
}>): CatalogBridgeReceipt {
  if (input.journal.operationId !== input.state.operationId || input.journal.providerKey !== input.state.providerKey ||
    input.journal.planDigest !== input.state.planDigest || !Number.isFinite(Date.parse(input.observedAt))) {
    refuseCatalogBridge("CATALOG_BRIDGE_OPERATION_BINDING_CHANGED");
  }
  const phaseIndex = catalogBridgePhases.indexOf(input.phase);
  const prior = phaseIndex === 0 ? null : input.journal.receipts[phaseIndex - 1];
  if (phaseIndex > 0 && prior === undefined) refuseCatalogBridge("CATALOG_BRIDGE_PHASE_ORDER_INVALID");
  return Object.freeze({ schemaVersion: "dataforrest_catalog_bridge_receipt_v1", phase: input.phase,
    operationId: input.state.operationId, providerKey: input.state.providerKey, planDigest: input.state.planDigest,
    observedAt: input.observedAt, previousReceiptHash: prior === null ? null : catalogBridgeDigest(prior),
    evidence: Object.freeze(input.evidence) });
}

export interface CatalogBridgeQuiescentConfigurationObservation {
  readonly observedAt: string;
  readonly centralActiveConfigId: string;
  readonly centralActiveConfigNumber: number;
  readonly centralActiveAdapterVersion: string;
  readonly centralActiveConfigurationDigest: string;
  readonly providerRowVersion: string;
  readonly providerCachedConfigId: string;
  readonly providerCachedConfigNumber: number;
  readonly providerCachedConfigurationDigest: string;
  readonly runtimeGeneration: string;
  readonly runtimeRowVersion: string;
  readonly sourceCursorHash: string | null;
  readonly sourceCursorPresent: boolean;
  readonly runtimeState: string;
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
  readonly latestTerminalRunId: string;
  readonly latestTerminalRunDigest: string;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly importLeaseOwner: string | null;
  readonly otherActiveTransactionCount: number;
  readonly canonical: CatalogBridgeCanonicalEvidence;
}

function assertUnchangedEventEvidence(before: CatalogBridgeCanonicalEvidence, after: CatalogBridgeCanonicalEvidence): void {
  if (after.pulls !== before.pulls || after.marketEvents !== before.marketEvents ||
    after.pullsDigest !== before.pullsDigest || after.marketEventsDigest !== before.marketEventsDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_ROWS_CHANGED");
  }
}

function assertQuiescent(observation: CatalogBridgeQuiescentConfigurationObservation): void {
  if (!Number.isFinite(Date.parse(observation.observedAt)) || !positiveInteger.test(observation.providerRowVersion) ||
    !positiveInteger.test(observation.runtimeGeneration) || !positiveInteger.test(observation.runtimeRowVersion) ||
    observation.runtimeState !== "paused" || observation.activeRunCount !== 0 ||
    observation.actionableCommandCount !== 0 || observation.importLeaseOwner !== null ||
    observation.otherActiveTransactionCount !== 0) refuseCatalogBridge("CATALOG_BRIDGE_NOT_QUIESCENT");
}

function assertInitialPauseBoundary(state: CatalogBridgePrivatePreparedState,
  observation: Pick<CatalogBridgeQuiescentConfigurationObservation, "pauseCommandId" | "pauseCommandDigest" |
    "latestTerminalRunId" | "latestTerminalRunDigest">): void {
  const runtime = state.preflight.runtime;
  if (observation.pauseCommandId !== runtime.pauseProvenance.commandId ||
    observation.pauseCommandDigest !== runtime.pauseProvenance.commandDigest ||
    observation.latestTerminalRunId !== runtime.latestTerminalRun.runId ||
    observation.latestTerminalRunDigest !== runtime.latestTerminalRun.runDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_PAUSE_PROVENANCE_DRIFT");
  }
}

export function recordCatalogActivated(input: Readonly<{
  journal: CatalogBridgePublicJournal; state: CatalogBridgePrivatePreparedState;
  observation: CatalogBridgeQuiescentConfigurationObservation;
}>): CatalogBridgePublicJournal {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const value = input.observation;
  assertQuiescent(value);
  assertInitialPauseBoundary(input.state, value);
  assertUnchangedEventEvidence(input.state.preflight.baseline, value.canonical);
  if (value.centralActiveConfigId !== plan.catalog.id || value.centralActiveConfigNumber !== plan.catalog.versionNumber ||
    value.centralActiveAdapterVersion !== definition.catalogAdapterVersion || value.providerCachedConfigId !== plan.catalog.id ||
    value.providerCachedConfigNumber !== plan.catalog.versionNumber ||
    value.centralActiveConfigurationDigest !== catalogBridgeDigest(plan.catalog.configuration) ||
    value.providerCachedConfigurationDigest !== catalogBridgeDigest({
      adapterKey: definition.catalogAdapterVersion, settings: plan.catalog.configuration,
    }) || value.sourceCursorPresent || value.sourceCursorHash !== null) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ACTIVATION_INVALID");
  }
  return appendReceipt(input.journal, receipt({ ...input, phase: "catalog_activated", observedAt: value.observedAt,
    evidence: { catalogConfigId: plan.catalog.id, catalogConfigNumber: plan.catalog.versionNumber,
      configurationDigest: value.centralActiveConfigurationDigest,
      providerRowVersion: value.providerRowVersion, runtimeGeneration: value.runtimeGeneration,
      runtimeRowVersion: value.runtimeRowVersion, canonicalDigest: catalogBridgeDigest(value.canonical) } }));
}

export interface CatalogBridgeCatalogRunAdmissionObservation {
  readonly observedAt: string;
  readonly runtimeState: "idle";
  readonly runtimeGeneration: string;
  readonly activeConfigId: string;
  readonly cachedConfigId: string;
  readonly sourceCursorPresent: false;
  readonly sourceCursorHash: null;
  readonly resumeCommandId: string;
  readonly resumeCommandDigest: string;
  readonly resumeCommandType: "resume";
  readonly resumeCommandState: "completed";
  readonly resumeExpectedGeneration: string;
  readonly resumeResultGeneration: string;
  readonly pausedOriginGuardDigest: string;
  readonly catalogRunId: string;
  readonly catalogRunState: "queued";
  readonly catalogRunConfigId: string;
  readonly catalogRunConfigNumber: number;
  readonly catalogRunRequestedCursorHash: null;
  readonly requestRunCommandId: string;
  readonly requestRunCommandDigest: string;
  readonly utilityLeaseDigest: string;
}

/**
 * Records the dedicated paused-origin resume guard and deterministic queue.
 * `ProviderCatalogOriginResumeGuard` is the only admitted null-cursor resume
 * authority. The caller must still persist this receipt before starting work.
 */
export function recordCatalogRunAdmitted(input: Readonly<{
  journal: CatalogBridgePublicJournal; state: CatalogBridgePrivatePreparedState;
  observation: CatalogBridgeCatalogRunAdmissionObservation;
}>): CatalogBridgePublicJournal {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const value = input.observation;
  const entryGeneration = input.state.preflight.runtime.generation;
  if (!Number.isFinite(Date.parse(value.observedAt)) || value.runtimeState !== "idle" ||
    !positiveInteger.test(value.runtimeGeneration) || value.activeConfigId !== plan.catalog.id ||
    value.cachedConfigId !== plan.catalog.id || value.sourceCursorPresent || value.sourceCursorHash !== null ||
    !uuid.test(value.resumeCommandId) || !sha256.test(value.resumeCommandDigest) ||
    value.resumeCommandType !== "resume" || value.resumeCommandState !== "completed" ||
    value.resumeExpectedGeneration !== entryGeneration ||
    value.resumeResultGeneration !== value.runtimeGeneration ||
    BigInt(value.resumeExpectedGeneration) + 1n !== BigInt(value.runtimeGeneration) ||
    !sha256.test(value.pausedOriginGuardDigest) || value.catalogRunId !== input.state.catalogRunId ||
    value.catalogRunState !== "queued" || value.catalogRunConfigId !== plan.catalog.id ||
    value.catalogRunConfigNumber !== plan.catalog.versionNumber || value.catalogRunRequestedCursorHash !== null ||
    !uuid.test(value.requestRunCommandId) || !sha256.test(value.requestRunCommandDigest) ||
    !sha256.test(value.utilityLeaseDigest)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RUN_ADMISSION_INVALID");
  }
  return appendReceipt(input.journal, receipt({ ...input, phase: "catalog_run_admitted", observedAt: value.observedAt,
    evidence: { catalogRunId: value.catalogRunId, catalogRunConfigId: value.catalogRunConfigId,
      catalogRunConfigNumber: value.catalogRunConfigNumber, resumeCommandId: value.resumeCommandId,
      resumeCommandDigest: value.resumeCommandDigest, runtimeGeneration: value.runtimeGeneration,
      pausedOriginGuardDigest: value.pausedOriginGuardDigest, requestRunCommandId: value.requestRunCommandId,
      requestRunCommandDigest: value.requestRunCommandDigest, utilityLeaseDigest: value.utilityLeaseDigest } }));
}

export function recordCatalogCompleted(input: Readonly<{
  pins: CatalogBridgeOperationPins; journal: CatalogBridgePublicJournal; state: CatalogBridgePrivatePreparedState;
  observedAt: string; observation: CatalogBridgeHeadObservation;
}>): CatalogBridgePublicJournal {
  const proof = assertCatalogHead({ pins: input.pins, state: input.state, observation: input.observation });
  return appendReceipt(input.journal, receipt({ ...input, phase: "catalog_completed",
    evidence: { catalogRunId: input.observation.runId, catalogRunDigest: proof.catalogRunDigest,
      canonicalAfterDigest: proof.canonicalAfterDigest, cardRecordCount: input.observation.cardRecordCount,
      packRecordCount: input.observation.packRecordCount, catalogRecordCount: input.observation.catalogRecordCount,
      sourceRecordCount: input.observation.sourceRecordCount,
      distinctCardIdentityCount: input.observation.distinctCardIdentityCount,
      distinctPackIdentityCount: input.observation.distinctPackIdentityCount,
      identityChainDigest: input.observation.identityChainDigest,
      identityMultisetDigest: input.observation.identityMultisetDigest,
      runtimeState: input.observation.runtimeState,
      sourceHeadCountProvenance: input.pins.sourceHeadCountProvenance,
      pullRecordCount: 0, marketEventRecordCount: 0, quarantinedCount: 0 } }));
}

export interface CatalogBridgeEventSuccessorStageObservation {
  readonly observedAt: string;
  readonly centralActiveConfigId: string;
  readonly centralProviderRowVersion: string;
  readonly stagedConfigId: string;
  readonly stagedConfigNumber: number;
  readonly stagedAdapterVersion: string;
  readonly stagedConfigurationDigest: string;
  readonly activationProofDigest: string;
  readonly providerStillAtCatalogConfigId: string;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly importLeaseOwner: string | null;
  readonly runtimeState: string;
  readonly runtimeGeneration: string;
  readonly runtimeRowVersion: string;
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
  readonly pauseCommandType: string;
  readonly pauseCommandState: string;
  readonly pauseIdempotencyKey: string;
  readonly pauseTargetRunId: null;
  readonly pauseTargetQuarantineId: null;
  readonly pauseResultingRunId: null;
  readonly pauseRequestedByOperatorId: string;
  readonly pauseExpectedGeneration: string;
  readonly pauseResultOutcome: string;
  readonly pauseResultCode: string;
  readonly pauseResultGeneration: string;
  readonly pauseCorrelationId: string;
  readonly pauseReason: string | null;
  readonly pauseRequestedAt: string;
  readonly pauseCompletedAt: string;
  readonly latestTerminalRunId: string;
  readonly latestTerminalRunDigest: string;
}

export function recordEventSuccessorStaged(input: Readonly<{
  journal: CatalogBridgePublicJournal; state: CatalogBridgePrivatePreparedState;
  observation: CatalogBridgeEventSuccessorStageObservation;
}>): CatalogBridgePublicJournal {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const value = input.observation;
  const catalogReceipt = input.journal.receipts[catalogBridgePhases.indexOf("catalog_completed")];
  const expectedPauseDigest = catalogBridgePauseCommandDigest({ commandId: value.pauseCommandId,
    commandDigest: value.pauseCommandDigest, commandType: value.pauseCommandType,
    commandState: value.pauseCommandState, idempotencyKey: value.pauseIdempotencyKey,
    targetRunId: value.pauseTargetRunId, targetQuarantineId: value.pauseTargetQuarantineId,
    resultingRunId: value.pauseResultingRunId, requestedByOperatorId: value.pauseRequestedByOperatorId,
    expectedGeneration: value.pauseExpectedGeneration, resultOutcome: value.pauseResultOutcome,
    resultCode: value.pauseResultCode, resultGeneration: value.pauseResultGeneration,
    correlationId: value.pauseCorrelationId, reason: value.pauseReason,
    requestedAt: value.pauseRequestedAt, completedAt: value.pauseCompletedAt });
  if (!Number.isFinite(Date.parse(value.observedAt)) || value.centralActiveConfigId !== plan.catalog.id ||
    !positiveInteger.test(value.centralProviderRowVersion) || value.stagedConfigId !== plan.eventSuccessor.id ||
    value.stagedConfigNumber !== plan.eventSuccessor.versionNumber || value.stagedAdapterVersion !== plan.eventSuccessor.adapterVersion ||
    value.stagedConfigurationDigest !== catalogBridgeDigest(plan.eventSuccessor.configuration) ||
    !sha256.test(value.activationProofDigest) ||
    value.providerStillAtCatalogConfigId !== plan.catalog.id || value.activeRunCount !== 0 ||
    value.actionableCommandCount !== 0 || value.importLeaseOwner !== null || value.runtimeState !== "paused" ||
    !positiveInteger.test(value.runtimeGeneration) || !positiveInteger.test(value.runtimeRowVersion) ||
    !uuid.test(value.pauseCommandId) || !sha256.test(value.pauseCommandDigest) ||
    value.pauseCommandType !== "pause" || value.pauseCommandState !== "completed" ||
    value.pauseCommandDigest !== expectedPauseDigest ||
    value.pauseIdempotencyKey !== `catalog-bridge/${input.state.operationId}/post-catalog/pause` ||
    value.pauseTargetRunId !== null || value.pauseTargetQuarantineId !== null || value.pauseResultingRunId !== null ||
    value.pauseRequestedByOperatorId !== input.state.preflight.runtime.pauseProvenance.requestedByOperatorId ||
    !positiveInteger.test(value.pauseExpectedGeneration) ||
    BigInt(value.pauseExpectedGeneration) + 1n !== BigInt(value.runtimeGeneration) ||
    value.pauseResultOutcome !== "accepted" ||
    !["RUNTIME_TRANSITION_APPLIED", "RUNTIME_ALREADY_IN_STATE"].includes(value.pauseResultCode) ||
    value.pauseResultGeneration !== value.runtimeGeneration ||
    value.pauseCorrelationId !== input.state.operationId ||
    value.pauseReason !== `DataForrest ${input.state.providerKey} catalog bridge post-catalog pause` ||
    !Number.isFinite(Date.parse(value.pauseRequestedAt)) || !Number.isFinite(Date.parse(value.pauseCompletedAt)) ||
    Date.parse(value.pauseCompletedAt) < Date.parse(value.pauseRequestedAt) ||
    value.latestTerminalRunId !== input.state.catalogRunId || !sha256.test(value.latestTerminalRunDigest) ||
    catalogReceipt?.evidence.catalogRunDigest !== value.latestTerminalRunDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_SUCCESSOR_STAGE_INVALID");
  }
  return appendReceipt(input.journal, receipt({ ...input, phase: "event_successor_staged", observedAt: value.observedAt,
    evidence: { eventSuccessorConfigId: value.stagedConfigId, eventSuccessorConfigNumber: value.stagedConfigNumber,
      eventAdapterVersion: value.stagedAdapterVersion, centralProviderRowVersion: value.centralProviderRowVersion,
      stagedConfigurationDigest: value.stagedConfigurationDigest, activationProofDigest: value.activationProofDigest,
      postCatalogPauseCommandId: value.pauseCommandId, postCatalogPauseCommandDigest: value.pauseCommandDigest,
      latestTerminalRunId: value.latestTerminalRunId, latestTerminalRunDigest: value.latestTerminalRunDigest,
      runtimeGeneration: value.runtimeGeneration, runtimeRowVersion: value.runtimeRowVersion } }));
}

export interface CatalogBridgeCursorRestoreObservation extends CatalogBridgeQuiescentConfigurationObservation {
  readonly restoredCursorHash: string;
  readonly restoredOpaqueValueHash: string;
  readonly cursorEnvelopeDigest: string;
}

export function recordEventCursorRestored(input: Readonly<{
  journal: CatalogBridgePublicJournal; state: CatalogBridgePrivatePreparedState;
  observation: CatalogBridgeCursorRestoreObservation;
}>): CatalogBridgePublicJournal {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const restored = reEnvelopeSavedEventCursor(input.state);
  const value = input.observation;
  assertQuiescent(value);
  const stagedReceipt = input.journal.receipts[catalogBridgePhases.indexOf("event_successor_staged")];
  if (!stagedReceipt || value.pauseCommandId !== stagedReceipt.evidence.postCatalogPauseCommandId ||
    value.pauseCommandDigest !== stagedReceipt.evidence.postCatalogPauseCommandDigest ||
    value.latestTerminalRunId !== stagedReceipt.evidence.latestTerminalRunId ||
    value.latestTerminalRunDigest !== stagedReceipt.evidence.latestTerminalRunDigest ||
    value.runtimeGeneration !== stagedReceipt.evidence.runtimeGeneration ||
    BigInt(value.runtimeRowVersion) <= BigInt(String(stagedReceipt.evidence.runtimeRowVersion))) {
    refuseCatalogBridge("CATALOG_BRIDGE_POST_CATALOG_PAUSE_DRIFT");
  }
  assertUnchangedEventEvidence(input.state.preflight.baseline, value.canonical);
  if (value.centralActiveConfigId !== plan.eventSuccessor.id ||
    value.centralActiveConfigNumber !== plan.eventSuccessor.versionNumber ||
    value.centralActiveAdapterVersion !== definition.eventManifest.adapterVersion ||
    value.providerCachedConfigId !== plan.eventSuccessor.id || value.providerCachedConfigNumber !== plan.eventSuccessor.versionNumber ||
    value.centralActiveConfigurationDigest !== catalogBridgeDigest(plan.eventSuccessor.configuration) ||
    value.providerCachedConfigurationDigest !== catalogBridgeDigest({
      adapterKey: definition.eventManifest.adapterVersion, settings: plan.eventSuccessor.configuration,
    }) ||
    !value.sourceCursorPresent || value.sourceCursorHash !== restored.cursorHash || value.restoredCursorHash !== restored.cursorHash ||
    value.restoredOpaqueValueHash !== restored.opaqueValueHash || value.cursorEnvelopeDigest !== catalogBridgeDigest(restored.cursor)) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CURSOR_RESTORE_INVALID");
  }
  return appendReceipt(input.journal, receipt({ ...input, phase: "event_cursor_restored", observedAt: value.observedAt,
    evidence: { eventSuccessorConfigId: plan.eventSuccessor.id,
      configurationDigest: value.centralActiveConfigurationDigest, restoredCursorHash: restored.cursorHash,
      restoredOpaqueValueHash: restored.opaqueValueHash, cursorEnvelopeDigest: value.cursorEnvelopeDigest,
      providerRowVersion: value.providerRowVersion, runtimeGeneration: value.runtimeGeneration,
      runtimeRowVersion: value.runtimeRowVersion, canonicalDigest: catalogBridgeDigest(value.canonical) } }));
}

export interface CatalogBridgeResumeObservation {
  readonly observedAt: string;
  readonly launchdLabel: string;
  readonly processCount: number;
  readonly residencyPortListening: boolean;
  readonly activeConfigId: string;
  readonly cachedConfigId: string;
  readonly startupRunId: string;
  readonly startupRunState: "succeeded";
  readonly startupRunRequestedCursorHash: string;
  readonly startupRunReachedHead: true;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly importLeaseOwner: null;
}

export function catalogBridgeResumeRunId(operationId: string, providerKey: string): string {
  const value = catalogBridgeDigest(`${operationId}/${providerKey}/event-resume-run`);
  const bytes = Buffer.from(value.slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function recordResumed(input: Readonly<{
  journal: CatalogBridgePublicJournal; state: CatalogBridgePrivatePreparedState; observation: CatalogBridgeResumeObservation;
}>): CatalogBridgePublicJournal {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const restored = reEnvelopeSavedEventCursor(input.state);
  const expectedRunId = catalogBridgeResumeRunId(input.state.operationId, input.state.providerKey);
  const value = input.observation;
  if (!Number.isFinite(Date.parse(value.observedAt)) || value.launchdLabel !== definition.launchdLabel ||
    value.processCount !== 1 || !value.residencyPortListening || value.activeConfigId !== plan.eventSuccessor.id ||
    value.cachedConfigId !== plan.eventSuccessor.id || value.startupRunId !== expectedRunId ||
    value.startupRunState !== "succeeded" || !value.startupRunReachedHead ||
    value.startupRunRequestedCursorHash !== restored.cursorHash || value.activeRunCount !== 0 ||
    value.actionableCommandCount !== 0 || value.importLeaseOwner !== null) {
    refuseCatalogBridge("CATALOG_BRIDGE_RESUME_INVALID");
  }
  return appendReceipt(input.journal, receipt({ ...input, phase: "resumed", observedAt: value.observedAt,
    evidence: { launchdLabel: value.launchdLabel, processCount: 1, residencyPortListening: true,
      eventSuccessorConfigId: plan.eventSuccessor.id, startupRunId: expectedRunId,
      startupRunRequestedCursorHash: restored.cursorHash, startupRunReachedHead: true } }));
}
