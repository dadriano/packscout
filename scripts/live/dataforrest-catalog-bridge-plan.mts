import { createHash } from "node:crypto";
import {
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
  dataforrestCourtyardCatalogSourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestPhygitalsCatalogSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  opaqueCursorEnvelopeSchema,
  type OpaqueCursorEnvelope,
} from "@packscout/contracts";
import { providerMixedCursorFingerprint } from "@packscout/database";
import {
  catalogBridgeDrainReceiptSchema,
  type CatalogBridgeDrainReceipt,
} from "./dataforrest-catalog-bridge-drain-receipt.mts";
import {
  catalogBridgeSourceCensusFileSha256,
  catalogBridgeSourceCensusSchema,
  type CatalogBridgeSourceCensus,
} from "./dataforrest-catalog-bridge-source-census-proof.mts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const commit = /^[a-f0-9]{40}$/u;
const positiveInteger = /^[1-9][0-9]*$/u;

export class CatalogBridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CatalogBridgeError";
  }
}

export function refuseCatalogBridge(code: string): never {
  throw new CatalogBridgeError(code);
}

function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function catalogBridgeDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function deterministicId(operationId: string, providerKey: string, label: string): string {
  if (!uuid.test(operationId)) refuseCatalogBridge("CATALOG_BRIDGE_OPERATION_ID_INVALID");
  const bytes = createHash("sha256")
    .update(`packscout.live.catalog-bridge/${operationId}/${providerKey}/${label}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const sharedOrganizationId = "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a";

export const catalogBridgeProviderDefinitions = Object.freeze([
  Object.freeze({
    providerKey: "collector_crypt" as const,
    providerId: "c9f60d4e-e4c1-58c2-a24c-e545cab7a0e5",
    organizationId: sharedOrganizationId,
    databaseName: "packscout_collector_crypt",
    databasePort: 55_434,
    launchdLabel: "com.packscout.provider-import.collector_crypt",
    residencyPort: 56_434,
    currentConfigId: "0d53bce0-fe5d-54bf-bd07-f47142690a8f",
    currentConfigNumber: 3,
    currentEventManifest: dataforrestCollectorCryptDistributedSourceAdapterManifest,
    eventSuccessorManifest: dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
    catalogManifest: dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
    catalogAdapterVersion: DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
    documentedCatalogFloor: Object.freeze({ card: 191_383, pack: 69 }),
  }),
  Object.freeze({
    providerKey: "courtyard" as const,
    providerId: "eeba923b-3d0f-53bc-9006-d84fab651824",
    organizationId: sharedOrganizationId,
    databaseName: "packscout_courtyard",
    databasePort: 55_433,
    launchdLabel: "com.packscout.provider-import.courtyard",
    residencyPort: 56_433,
    currentConfigId: "cb42130b-c474-56cf-81e2-63e603aadeb8",
    currentConfigNumber: 3,
    currentEventManifest: dataforrestCourtyardDistributedV2SourceAdapterManifest,
    eventSuccessorManifest: dataforrestCourtyardDistributedV2SourceAdapterManifest,
    catalogManifest: dataforrestCourtyardCatalogSourceAdapterManifest,
    catalogAdapterVersion: DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
    documentedCatalogFloor: Object.freeze({ card: 1_056_550, pack: 100 }),
  }),
  Object.freeze({
    providerKey: "phygitals" as const,
    providerId: "5034af05-8976-5da8-85bb-2d6eac02515c",
    organizationId: sharedOrganizationId,
    databaseName: "packscout_phygitals",
    databasePort: 55_435,
    launchdLabel: "com.packscout.provider-import.phygitals",
    residencyPort: 56_435,
    currentConfigId: "e3e31fff-115f-59df-bdf4-a8975c6ab1b5",
    currentConfigNumber: 4,
    currentEventManifest: dataforrestPhygitalsDistributedV2SourceAdapterManifest,
    eventSuccessorManifest: dataforrestPhygitalsDistributedV2SourceAdapterManifest,
    catalogManifest: dataforrestPhygitalsCatalogSourceAdapterManifest,
    catalogAdapterVersion: DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
    documentedCatalogFloor: Object.freeze({ card: 276_719, pack: 143 }),
  }),
]);

export type CatalogBridgeProviderKey = typeof catalogBridgeProviderDefinitions[number]["providerKey"];
export type CatalogBridgeProviderDefinition = typeof catalogBridgeProviderDefinitions[number];

export function catalogBridgeProvider(providerKey: string): CatalogBridgeProviderDefinition {
  const definition = catalogBridgeProviderDefinitions.find((entry) => entry.providerKey === providerKey);
  if (!definition) refuseCatalogBridge("CATALOG_BRIDGE_PROVIDER_UNAPPROVED");
  return definition;
}

export interface CatalogBridgeOperationPins {
  readonly operationId: string;
  readonly providerKey: CatalogBridgeProviderKey;
  readonly operatorId: string;
  readonly residentCheckout: string;
  readonly residentCommit: string;
  readonly utilityModuleSha256: string;
  readonly sourceHeadCountProvenance: "two_pass_read_only_catalog_census_v1";
  readonly sourceHeadCounts: Readonly<{ card: number; pack: number }>;
  readonly sourceHeadCensusFileSha256: string;
  readonly sourceHeadCensusProofDigest: string;
  readonly sourceHeadIdentityMultisetDigest: string;
}

export function catalogBridgeOperationIds(pins: Pick<CatalogBridgeOperationPins, "operationId" | "providerKey">) {
  catalogBridgeProvider(pins.providerKey);
  return Object.freeze({
    catalogConfigId: deterministicId(pins.operationId, pins.providerKey, "catalog-config"),
    eventSuccessorConfigId: deterministicId(pins.operationId, pins.providerKey, "event-successor-config"),
    catalogRunId: deterministicId(pins.operationId, pins.providerKey, "catalog-run"),
  });
}

/** Deterministic identities used only by the catalog cutover stage. */
export function catalogBridgeCatalogOperationIds(
  pins: Pick<CatalogBridgeOperationPins, "operationId" | "providerKey">,
) {
  catalogBridgeProvider(pins.providerKey);
  const id = (label: string) => deterministicId(pins.operationId, pins.providerKey, label);
  return Object.freeze({
    catalogStageAuditId: id("catalog-stage-audit"),
    catalogActivationTestId: id("catalog-activation-test"),
    catalogActivationAuditId: id("catalog-activation-audit"),
    catalogResumeCommandId: id("catalog-resume-command"),
    catalogRunCommandId: id("catalog-run-command"),
    catalogAdmissionAuditId: id("catalog-admission-audit"),
    postCatalogPauseCommandId: id("post-catalog-pause-command"),
    eventStageAuditId: id("event-successor-stage-audit"),
    eventActivationTestId: id("event-successor-activation-test"),
    eventActivationAuditId: id("event-successor-activation-audit"),
    eventResumeCommandId: id("event-successor-resume-command"),
    eventRunCommandId: id("event-successor-run-command"),
  });
}

export interface CatalogBridgePauseProvenance {
  readonly commandId: string; readonly commandDigest: string; readonly commandType: string; readonly commandState: string;
  readonly idempotencyKey: string; readonly targetRunId: null; readonly targetQuarantineId: null;
  readonly resultingRunId: null; readonly requestedByOperatorId: string; readonly expectedGeneration: string;
  readonly resultOutcome: string; readonly resultCode: string; readonly resultGeneration: string;
  readonly correlationId: string; readonly reason: string | null; readonly requestedAt: string;
  readonly completedAt: string;
}

export function catalogBridgePauseCommandDigest(pause: CatalogBridgePauseProvenance): string {
  return catalogBridgeDigest({
    id: pause.commandId, idempotencyKey: pause.idempotencyKey, commandType: pause.commandType,
    state: pause.commandState, targetRunId: pause.targetRunId, targetQuarantineId: pause.targetQuarantineId,
    expectedGeneration: pause.expectedGeneration, requestedByOperatorId: pause.requestedByOperatorId,
    correlationId: pause.correlationId, reason: pause.reason, resultOutcome: pause.resultOutcome,
    resultCode: pause.resultCode, resultGeneration: pause.resultGeneration, resultingRunId: pause.resultingRunId,
    requestedAt: pause.requestedAt, completedAt: pause.completedAt,
  });
}

export interface CatalogBridgePreflightObservation {
  readonly observedAt: string;
  readonly repository: Readonly<{
    checkout: string; expectedCommit: string; observedCommit: string; clean: boolean; utilityModuleSha256: string;
  }>;
  readonly worker: Readonly<{
    launchdLabel: string; gracefullyUnloaded: boolean; processCount: number; residencyPortListening: boolean;
    gracefulStopReceiptSha256: string;
    /** Full hash-safe receipt produced by the generic pause/drain/bootout operation. */
    gracefulStopReceipt: CatalogBridgeDrainReceipt;
  }>;
  readonly central: Readonly<{
    organizationId: string; providerId: string; providerKey: string; providerRowVersion: string;
    activeConfigId: string; activeConfigNumber: number; activeAdapterVersion: string;
    maximumConfigNumber: number;
    configuration: unknown; configurationDigest: string; authorityDigest: string;
    sourceCredentialDigest: string; databaseRouteDigest: string;
  }>;
  readonly runtime: Readonly<{
    providerId: string; providerKey: string; databaseName: string; databasePort: number; databaseRole: string;
    schemaVersion: string; runtimeState: string; generation: string; rowVersion: string;
    cachedConfigId: string; cachedConfigNumber: number; cachedConfiguration: unknown;
    sourceCursor: unknown; sourceCursorHash: string;
    activeRunCount: number; actionableCommandCount: number; importLeaseOwner: string | null;
    otherOwnedLeaseCount: number; otherActiveTransactionCount: number;
    pauseProvenance: Readonly<CatalogBridgePauseProvenance>;
    latestTerminalRun: Readonly<{
      terminalKind: "interrupted_checkpoint" | "succeeded_reconciled_head";
      runId: string; runDigest: string; state: string; finishedAt: string;
      failureCode: string | null; reachedSourceHead: boolean; headProofDigest: string | null;
      pageCount: number; finalCursorHash: string;
      lastPageNumber: number; lastPageCursorHash: string; lastPageContinuation: string;
      lastPageDigest: string;
    }>;
  }>;
  readonly sourceCanaries: Readonly<{
    catalogOrigin: Readonly<{
      adapterVersion: string; requestedCursorHash: null; status: number; recordCount: number;
      cardCount: number; packCount: number; pullCount: number; tradeCount: number;
      responseSha256: string; nextCursorHash: string | null; checkedAt: string;
      responseBytes: number; durationMilliseconds: number;
    }>;
    savedEventCursor: Readonly<{
      adapterVersion: string; requestedCursorHash: string; opaqueValueHash: string; status: number;
      recordCount: number; responseSha256: string; checkedAt: string;
      responseBytes: number; durationMilliseconds: number;
    }>;
  }>;
  readonly sourceCensus: Readonly<{
    proof: CatalogBridgeSourceCensus;
    fileSha256: string;
    proofDigest: string;
  }>;
  readonly baseline: CatalogBridgeCanonicalEvidence;
}

export interface CatalogBridgeCanonicalEvidence {
  readonly cards: number;
  readonly packs: number;
  readonly pulls: number;
  readonly marketEvents: number;
  readonly pullsDigest: string;
  readonly marketEventsDigest: string;
}

export interface CatalogBridgePrivatePreparedState {
  readonly schemaVersion: "dataforrest_catalog_bridge_private_v1";
  readonly operationId: string;
  readonly providerKey: CatalogBridgeProviderKey;
  readonly planDigest: string;
  readonly preparedAt: string;
  readonly catalogConfigId: string;
  readonly eventSuccessorConfigId: string;
  readonly catalogRunId: string;
  readonly savedEventCursor: OpaqueCursorEnvelope;
  readonly savedEventCursorHash: string;
  readonly savedOpaqueValueHash: string;
  readonly preflight: CatalogBridgePreflightObservation;
}

export interface CatalogBridgePublicPreparedReceipt {
  readonly schemaVersion: "dataforrest_catalog_bridge_receipt_v1";
  readonly phase: "prepared";
  readonly operationId: string;
  readonly providerKey: CatalogBridgeProviderKey;
  readonly planDigest: string;
  readonly preparedAt: string;
  readonly providerRowVersion: string;
  readonly runtimeGeneration: string;
  readonly runtimeRowVersion: string;
  readonly authorityDigest: string;
  readonly savedEventCursorHash: string;
  readonly savedOpaqueValueHash: string;
  readonly catalogOriginResponseSha256: string;
  readonly savedEventCanaryResponseSha256: string;
  readonly gracefulStopReceiptSha256: string;
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
  readonly latestTerminalRunId: string;
  readonly latestTerminalRunDigest: string;
  readonly baselineDigest: string;
  readonly sourceHeadCountProvenance: "two_pass_read_only_catalog_census_v1";
  readonly sourceHeadCardCount: number;
  readonly sourceHeadPackCount: number;
  readonly sourceHeadCensusFileSha256: string;
  readonly sourceHeadCensusProofDigest: string;
  readonly sourceHeadIdentityMultisetDigest: string;
  readonly previousReceiptHash: null;
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function assertFresh(checkedAt: string, observedAt: string): void {
  const age = Date.parse(observedAt) - Date.parse(checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 120_000) refuseCatalogBridge("CATALOG_BRIDGE_CANARY_STALE");
}

function assertCanonicalEvidence(value: CatalogBridgeCanonicalEvidence): void {
  if (![value.cards, value.packs, value.pulls, value.marketEvents].every(validCount) ||
    !sha256.test(value.pullsDigest) || !sha256.test(value.marketEventsDigest)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CANONICAL_EVIDENCE_INVALID");
  }
}

function assertGracefulStopReceipt(input: Readonly<{
  pins: CatalogBridgeOperationPins;
  observation: CatalogBridgePreflightObservation;
}>): void {
  const definition = catalogBridgeProvider(input.pins.providerKey);
  const parsed = catalogBridgeDrainReceiptSchema.safeParse(input.observation.worker.gracefulStopReceipt);
  if (!parsed.success) refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_INVALID");
  const receipt = parsed.data;
  const { pause, terminal, worker } = receipt;
  const runtime = input.observation.runtime;
  const latest = runtime.latestTerminalRun;
  if (catalogBridgeDigest(receipt) !== input.observation.worker.gracefulStopReceiptSha256 ||
    receipt.schemaVersion !== "dataforrest_catalog_bridge_drain_receipt_v1" ||
    receipt.operationId !== input.pins.operationId || receipt.providerKey !== input.pins.providerKey ||
    receipt.providerId !== definition.providerId || receipt.operatorId !== input.pins.operatorId ||
    receipt.currentConfigId !== definition.currentConfigId || !validInstant(receipt.drainedAt) ||
    pause.commandId !== runtime.pauseProvenance.commandId || pause.commandDigest !== runtime.pauseProvenance.commandDigest ||
    pause.expectedGeneration !== runtime.pauseProvenance.expectedGeneration || pause.resultGeneration !== runtime.generation ||
    pause.reason !== runtime.pauseProvenance.reason || pause.correlationId !== input.pins.operationId ||
    pause.requestedAt !== runtime.pauseProvenance.requestedAt || pause.completedAt !== runtime.pauseProvenance.completedAt ||
    terminal.kind !== latest.terminalKind || terminal.runId !== latest.runId || terminal.runDigest !== latest.runDigest ||
    terminal.state !== latest.state || terminal.failureCode !== latest.failureCode ||
    terminal.reachedSourceHead !== latest.reachedSourceHead || terminal.finishedAt !== latest.finishedAt ||
    terminal.pageCount !== latest.pageCount || terminal.finalCursorHash !== latest.finalCursorHash ||
    terminal.lastPageNumber !== latest.lastPageNumber || terminal.lastPageCursorHash !== latest.lastPageCursorHash ||
    terminal.lastPageContinuation !== latest.lastPageContinuation || terminal.lastPageDigest !== latest.lastPageDigest ||
    terminal.headProofDigest !== latest.headProofDigest || worker.launchdLabel !== definition.launchdLabel) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_RECEIPT_INVALID");
  }
}

function assertCatalogBridgeSourceCensus(input: Readonly<{
  pins: CatalogBridgeOperationPins;
  observation: CatalogBridgePreflightObservation;
}>): void {
  if (input.pins.providerKey !== "collector_crypt") {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_PROVIDER_UNSUPPORTED");
  }
  const wrapper = (input.observation as Partial<CatalogBridgePreflightObservation>).sourceCensus;
  if (!wrapper || typeof wrapper !== "object" ||
    Object.keys(wrapper).sort().join(",") !== "fileSha256,proof,proofDigest") {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_INVALID");
  }
  const parsed = catalogBridgeSourceCensusSchema.safeParse(wrapper.proof);
  if (!parsed.success) refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_INVALID");
  const proof = parsed.data;
  const definition = catalogBridgeProvider(input.pins.providerKey);
  const proofDigest = catalogBridgeDigest(proof);
  if (!sha256.test(wrapper.fileSha256) || !sha256.test(wrapper.proofDigest) ||
    wrapper.fileSha256 !== catalogBridgeSourceCensusFileSha256(proof) ||
    wrapper.fileSha256 !== input.pins.sourceHeadCensusFileSha256 ||
    wrapper.proofDigest !== proofDigest ||
    proofDigest !== input.pins.sourceHeadCensusProofDigest ||
    proof.operationId !== input.pins.operationId ||
    proof.providerKey !== input.pins.providerKey ||
    proof.executor.checkout !== input.pins.residentCheckout ||
    proof.executor.commit !== input.pins.residentCommit ||
    proof.source.providerId !== definition.providerId ||
    proof.source.configId !== definition.currentConfigId ||
    proof.source.configNumber !== definition.currentConfigNumber ||
    proof.source.activeAdapterVersion !== definition.currentEventManifest.adapterVersion ||
    proof.source.catalogAdapterVersion !== definition.catalogAdapterVersion ||
    proof.source.sourceCredentialDigest !== input.observation.central.sourceCredentialDigest ||
    proof.source.pageLimit !== definition.catalogManifest.requestBounds.pageLimit ||
    proof.source.requestTimeoutMilliseconds !==
      definition.catalogManifest.requestBounds.timeoutMilliseconds ||
    proof.source.maximumResponseBytes !==
      definition.catalogManifest.requestBounds.maximumResponseBytes ||
    proof.agreement.cardCount !== input.pins.sourceHeadCounts.card ||
    proof.agreement.packCount !== input.pins.sourceHeadCounts.pack ||
    proof.agreement.sourceRecordCount !==
      input.pins.sourceHeadCounts.card + input.pins.sourceHeadCounts.pack ||
    proof.agreement.identityMultisetDigest !==
      input.pins.sourceHeadIdentityMultisetDigest ||
    proof.agreement.cardCount < definition.documentedCatalogFloor.card ||
    proof.agreement.packCount < definition.documentedCatalogFloor.pack ||
    Date.parse(proof.capturedAt) > Date.parse(input.observation.observedAt)) {
    refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CENSUS_INVALID");
  }
}

export function prepareCatalogBridge(input: Readonly<{
  pins: CatalogBridgeOperationPins; observation: CatalogBridgePreflightObservation;
}>): Readonly<{ privateState: CatalogBridgePrivatePreparedState; publicReceipt: CatalogBridgePublicPreparedReceipt }> {
  const { pins, observation } = input;
  const definition = catalogBridgeProvider(pins.providerKey);
  const { repository, worker, central, runtime, sourceCanaries } = observation;
  if (!uuid.test(pins.operationId) || !uuid.test(pins.operatorId) || !commit.test(pins.residentCommit) ||
    !sha256.test(pins.utilityModuleSha256) || !validInstant(observation.observedAt) ||
    pins.sourceHeadCountProvenance !== "two_pass_read_only_catalog_census_v1" ||
    pins.residentCheckout.length === 0 || /[\r\n\0]/u.test(pins.residentCheckout) ||
    !sha256.test(pins.sourceHeadCensusFileSha256) ||
    !sha256.test(pins.sourceHeadCensusProofDigest) ||
    !sha256.test(pins.sourceHeadIdentityMultisetDigest) ||
    !validCount(pins.sourceHeadCounts.card) || !validCount(pins.sourceHeadCounts.pack) ||
    pins.sourceHeadCounts.card < definition.documentedCatalogFloor.card ||
    pins.sourceHeadCounts.pack < definition.documentedCatalogFloor.pack) {
    refuseCatalogBridge("CATALOG_BRIDGE_PINS_INVALID");
  }
  assertCatalogBridgeSourceCensus(input);
  if (repository.checkout !== pins.residentCheckout || repository.expectedCommit !== pins.residentCommit ||
    repository.observedCommit !== pins.residentCommit || !repository.clean ||
    repository.utilityModuleSha256 !== pins.utilityModuleSha256) {
    refuseCatalogBridge("CATALOG_BRIDGE_RESIDENT_DRIFT");
  }
  if (worker.launchdLabel !== definition.launchdLabel || !worker.gracefullyUnloaded || worker.processCount !== 0 ||
    worker.residencyPortListening || !sha256.test(worker.gracefulStopReceiptSha256)) {
    refuseCatalogBridge("CATALOG_BRIDGE_WORKER_NOT_GRACEFULLY_OFFLINE");
  }
  assertGracefulStopReceipt(input);
  if (central.organizationId !== definition.organizationId || central.providerId !== definition.providerId ||
    central.providerKey !== definition.providerKey || !positiveInteger.test(central.providerRowVersion) ||
    central.activeConfigId !== definition.currentConfigId || central.activeConfigNumber !== definition.currentConfigNumber ||
    central.maximumConfigNumber !== definition.currentConfigNumber ||
    central.activeAdapterVersion !== definition.currentEventManifest.adapterVersion ||
    catalogBridgeDigest(central.configuration) !== catalogBridgeDigest({ platform: definition.providerKey }) ||
    central.configurationDigest !== catalogBridgeDigest(central.configuration) ||
    ![central.configurationDigest, central.authorityDigest, central.sourceCredentialDigest,
      central.databaseRouteDigest].every((value) => sha256.test(value))) {
    refuseCatalogBridge("CATALOG_BRIDGE_CENTRAL_AUTHORITY_DRIFT");
  }
  if (runtime.providerId !== definition.providerId || runtime.providerKey !== definition.providerKey ||
    runtime.databaseName !== definition.databaseName || runtime.databasePort !== definition.databasePort ||
    runtime.databaseRole !== "provider" || runtime.schemaVersion !== "distributed-provider-v1" ||
    runtime.runtimeState !== "paused" || !positiveInteger.test(runtime.generation) || !positiveInteger.test(runtime.rowVersion) ||
    runtime.cachedConfigId !== definition.currentConfigId || runtime.cachedConfigNumber !== definition.currentConfigNumber ||
    catalogBridgeDigest(runtime.cachedConfiguration) !== catalogBridgeDigest({
      adapterKey: definition.currentEventManifest.adapterVersion,
      settings: { platform: definition.providerKey },
    }) ||
    runtime.activeRunCount !== 0 || runtime.actionableCommandCount !== 0 || runtime.importLeaseOwner !== null ||
    runtime.otherOwnedLeaseCount !== 0 || runtime.otherActiveTransactionCount !== 0 || !sha256.test(runtime.sourceCursorHash)) {
    refuseCatalogBridge("CATALOG_BRIDGE_RUNTIME_NOT_DRAINED");
  }
  const pause = runtime.pauseProvenance;
  const latest = runtime.latestTerminalRun;
  const interruptedCheckpoint = latest.terminalKind === "interrupted_checkpoint" &&
    ((latest.state === "incomplete" && latest.failureCode === "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE") ||
      (latest.state === "failed" && latest.failureCode === "PROVIDER_MIXED_PAGE_RUNTIME_NOT_RUNNING")) &&
    !latest.reachedSourceHead && latest.headProofDigest === null && latest.lastPageContinuation === "more";
  const reconciledHead = latest.terminalKind === "succeeded_reconciled_head" && latest.state === "succeeded" &&
    latest.failureCode === null && latest.reachedSourceHead && sha256.test(latest.headProofDigest ?? "") &&
    latest.lastPageContinuation === "head";
  const pauseCommandDigest = catalogBridgePauseCommandDigest(pause);
  if (!uuid.test(pause.commandId) || !sha256.test(pause.commandDigest) || pause.commandType !== "pause" ||
    pause.commandState !== "completed" || pause.requestedByOperatorId !== pins.operatorId ||
    pause.commandDigest !== pauseCommandDigest ||
    ![`catalog-bridge/${pins.operationId}/running/pause`,
      `catalog-bridge/${pins.operationId}/offline_idle_head/pause`].includes(pause.idempotencyKey) ||
    pause.targetRunId !== null || pause.targetQuarantineId !== null || pause.resultingRunId !== null ||
    !positiveInteger.test(pause.expectedGeneration) || BigInt(pause.expectedGeneration) + 1n !== BigInt(runtime.generation) ||
    pause.resultOutcome !== "accepted" ||
    !["RUNTIME_TRANSITION_APPLIED", "RUNTIME_ALREADY_IN_STATE"].includes(pause.resultCode) ||
    pause.resultGeneration !== runtime.generation || pause.correlationId !== pins.operationId ||
    pause.reason !== `DataForrest ${pins.providerKey} catalog bridge checkpoint drain` ||
    !validInstant(pause.requestedAt) || !validInstant(pause.completedAt) ||
    Date.parse(pause.completedAt) < Date.parse(pause.requestedAt) ||
    !uuid.test(latest.runId) || !sha256.test(latest.runDigest) || (!interruptedCheckpoint && !reconciledHead) ||
    !validInstant(latest.finishedAt) || !Number.isSafeInteger(latest.pageCount) ||
    latest.pageCount < 1 || latest.finalCursorHash !== runtime.sourceCursorHash ||
    latest.lastPageNumber !== latest.pageCount || latest.lastPageCursorHash !== latest.finalCursorHash ||
    !sha256.test(latest.lastPageDigest)) {
    refuseCatalogBridge("CATALOG_BRIDGE_PAUSE_PROVENANCE_INVALID");
  }
  const parsedCursor = opaqueCursorEnvelopeSchema.safeParse(runtime.sourceCursor);
  if (!parsedCursor.success || parsedCursor.data.value === null || parsedCursor.data.sourceInstanceId !== definition.providerId ||
    parsedCursor.data.sourceRevisionId !== definition.currentConfigId ||
    parsedCursor.data.adapterVersion !== definition.currentEventManifest.adapterVersion ||
    parsedCursor.data.sourceTypeKey !== definition.currentEventManifest.sourceTypeKey ||
    parsedCursor.data.cursorCodecKey !== definition.currentEventManifest.cursorCodecKey ||
    parsedCursor.data.cursorGeneration !== 1 ||
    providerMixedCursorFingerprint(parsedCursor.data) !== runtime.sourceCursorHash) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CURSOR_INVALID");
  }
  const opaqueValueHash = catalogBridgeDigest(parsedCursor.data.value);
  const origin = sourceCanaries.catalogOrigin;
  if (origin.adapterVersion !== definition.catalogAdapterVersion || origin.requestedCursorHash !== null || origin.status !== 200 ||
    definition.catalogManifest.adapterVersion !== definition.catalogAdapterVersion ||
    !validCount(origin.recordCount) || origin.recordCount < 1 || origin.recordCount > definition.catalogManifest.requestBounds.pageLimit ||
    ![origin.cardCount, origin.packCount, origin.pullCount, origin.tradeCount].every(validCount) ||
    origin.cardCount + origin.packCount !== origin.recordCount || origin.pullCount !== 0 || origin.tradeCount !== 0 ||
    !sha256.test(origin.responseSha256) || (origin.nextCursorHash !== null && !sha256.test(origin.nextCursorHash)) ||
    !validCount(origin.responseBytes) || origin.responseBytes < 1 ||
    origin.responseBytes > definition.catalogManifest.requestBounds.maximumResponseBytes ||
    !Number.isFinite(origin.durationMilliseconds) || origin.durationMilliseconds < 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ORIGIN_CANARY_INVALID");
  }
  const savedCanary = sourceCanaries.savedEventCursor;
  if (savedCanary.adapterVersion !== definition.eventSuccessorManifest.adapterVersion ||
    savedCanary.requestedCursorHash !== runtime.sourceCursorHash || savedCanary.opaqueValueHash !== opaqueValueHash ||
    savedCanary.status !== 200 || !validCount(savedCanary.recordCount) ||
    savedCanary.recordCount > definition.eventSuccessorManifest.requestBounds.pageLimit ||
    !sha256.test(savedCanary.responseSha256) ||
    !validCount(savedCanary.responseBytes) || savedCanary.responseBytes < 1 ||
    savedCanary.responseBytes > definition.eventSuccessorManifest.requestBounds.maximumResponseBytes ||
    !Number.isFinite(savedCanary.durationMilliseconds) || savedCanary.durationMilliseconds < 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_SAVED_EVENT_CANARY_INVALID");
  }
  assertFresh(origin.checkedAt, observation.observedAt);
  assertFresh(savedCanary.checkedAt, observation.observedAt);
  assertCanonicalEvidence(observation.baseline);
  const planDigest = catalogBridgeDigest(pins);
  const operationIds = catalogBridgeOperationIds(pins);
  const privateState = Object.freeze({
    schemaVersion: "dataforrest_catalog_bridge_private_v1" as const,
    operationId: pins.operationId,
    providerKey: pins.providerKey,
    planDigest,
    preparedAt: observation.observedAt,
    ...operationIds,
    savedEventCursor: parsedCursor.data,
    savedEventCursorHash: runtime.sourceCursorHash,
    savedOpaqueValueHash: opaqueValueHash,
    preflight: observation,
  });
  const publicReceipt = Object.freeze({
    schemaVersion: "dataforrest_catalog_bridge_receipt_v1" as const,
    phase: "prepared" as const,
    operationId: pins.operationId,
    providerKey: pins.providerKey,
    planDigest,
    preparedAt: observation.observedAt,
    providerRowVersion: central.providerRowVersion,
    runtimeGeneration: runtime.generation,
    runtimeRowVersion: runtime.rowVersion,
    authorityDigest: central.authorityDigest,
    savedEventCursorHash: runtime.sourceCursorHash,
    savedOpaqueValueHash: opaqueValueHash,
    catalogOriginResponseSha256: origin.responseSha256,
    savedEventCanaryResponseSha256: savedCanary.responseSha256,
    gracefulStopReceiptSha256: worker.gracefulStopReceiptSha256,
    pauseCommandId: pause.commandId,
    pauseCommandDigest: pause.commandDigest,
    latestTerminalRunId: latest.runId,
    latestTerminalRunDigest: latest.runDigest,
    baselineDigest: catalogBridgeDigest(observation.baseline),
    sourceHeadCountProvenance: pins.sourceHeadCountProvenance,
    sourceHeadCardCount: pins.sourceHeadCounts.card,
    sourceHeadPackCount: pins.sourceHeadCounts.pack,
    sourceHeadCensusFileSha256: pins.sourceHeadCensusFileSha256,
    sourceHeadCensusProofDigest: pins.sourceHeadCensusProofDigest,
    sourceHeadIdentityMultisetDigest: pins.sourceHeadIdentityMultisetDigest,
    previousReceiptHash: null,
  });
  return { privateState, publicReceipt };
}

export function reEnvelopeSavedEventCursor(state: CatalogBridgePrivatePreparedState): Readonly<{
  cursor: OpaqueCursorEnvelope; cursorHash: string; opaqueValueHash: string;
}> {
  const definition = catalogBridgeProvider(state.providerKey);
  const parsed = opaqueCursorEnvelopeSchema.safeParse(state.savedEventCursor);
  if (!parsed.success || parsed.data.value === null || parsed.data.sourceInstanceId !== definition.providerId ||
    parsed.data.sourceRevisionId !== definition.currentConfigId ||
    parsed.data.adapterVersion !== definition.currentEventManifest.adapterVersion ||
    parsed.data.sourceTypeKey !== definition.currentEventManifest.sourceTypeKey ||
    parsed.data.cursorCodecKey !== definition.currentEventManifest.cursorCodecKey ||
    parsed.data.cursorGeneration !== 1 ||
    providerMixedCursorFingerprint(parsed.data) !== state.savedEventCursorHash ||
    catalogBridgeDigest(parsed.data.value) !== state.savedOpaqueValueHash ||
    definition.currentEventManifest.sourceTypeKey !==
      definition.eventSuccessorManifest.sourceTypeKey ||
    definition.currentEventManifest.cursorCodecKey !==
      definition.eventSuccessorManifest.cursorCodecKey ||
    definition.currentEventManifest.providerSourceContractVersion !==
      definition.eventSuccessorManifest.providerSourceContractVersion ||
    definition.currentEventManifest.normalizedContractVersion !==
      definition.eventSuccessorManifest.normalizedContractVersion ||
    definition.currentEventManifest.compatibleConnectionTypeKey !==
      definition.eventSuccessorManifest.compatibleConnectionTypeKey ||
    catalogBridgeDigest(definition.currentEventManifest.supportedProviders) !==
      catalogBridgeDigest(definition.eventSuccessorManifest.supportedProviders) ||
    !uuid.test(state.eventSuccessorConfigId)) {
    refuseCatalogBridge("CATALOG_BRIDGE_PRIVATE_CURSOR_DRIFT");
  }
  const cursor = opaqueCursorEnvelopeSchema.parse({
    ...parsed.data,
    sourceRevisionId: state.eventSuccessorConfigId,
    sourceTypeKey: definition.eventSuccessorManifest.sourceTypeKey,
    adapterVersion: definition.eventSuccessorManifest.adapterVersion,
    cursorCodecKey: definition.eventSuccessorManifest.cursorCodecKey,
  });
  return Object.freeze({ cursor, cursorHash: providerMixedCursorFingerprint(cursor)!, opaqueValueHash: state.savedOpaqueValueHash });
}

export function catalogBridgeConfigurationPlan(state: CatalogBridgePrivatePreparedState) {
  const definition = catalogBridgeProvider(state.providerKey);
  return Object.freeze({
    catalog: Object.freeze({ id: state.catalogConfigId, versionNumber: definition.currentConfigNumber + 1,
      adapterVersion: definition.catalogAdapterVersion,
      configuration: Object.freeze({ platform: definition.providerKey, stream: "catalog" as const }) }),
    eventSuccessor: Object.freeze({ id: state.eventSuccessorConfigId, versionNumber: definition.currentConfigNumber + 2,
      adapterVersion: definition.eventSuccessorManifest.adapterVersion,
      configuration: Object.freeze({ platform: definition.providerKey }) }),
  });
}

export interface CatalogBridgeHeadObservation {
  readonly runId: string;
  readonly configId: string;
  readonly configNumber: number;
  readonly state: "succeeded";
  readonly reachedHead: true;
  readonly requestedCursorHash: null;
  readonly sourceRecordCount: number;
  readonly catalogRecordCount: number;
  readonly cardRecordCount: number;
  readonly packRecordCount: number;
  readonly distinctCardIdentityCount: number;
  readonly distinctPackIdentityCount: number;
  readonly identityChainDigest: string;
  readonly identityMultisetDigest: string;
  readonly pullRecordCount: number;
  readonly marketEventRecordCount: number;
  readonly quarantinedCount: number;
  readonly finalCursorHash: string | null;
  readonly runtimeState: "idle" | "paused";
  readonly activeRunCount: 0;
  readonly actionableCommandCount: 0;
  readonly importLeaseOwner: null;
  readonly canonicalAfter: CatalogBridgeCanonicalEvidence;
}

export function assertCatalogHead(input: Readonly<{
  pins: CatalogBridgeOperationPins; state: CatalogBridgePrivatePreparedState; observation: CatalogBridgeHeadObservation;
}>): Readonly<{ catalogRunDigest: string; canonicalAfterDigest: string }> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const before = input.state.preflight.baseline;
  const after = input.observation.canonicalAfter;
  assertCanonicalEvidence(after);
  if (input.state.planDigest !== catalogBridgeDigest(input.pins) || input.observation.runId !== input.state.catalogRunId ||
    input.observation.configId !== plan.catalog.id || input.observation.configNumber !== plan.catalog.versionNumber ||
    input.observation.state !== "succeeded" || !input.observation.reachedHead || input.observation.requestedCursorHash !== null ||
    input.pins.sourceHeadCountProvenance !== "two_pass_read_only_catalog_census_v1" ||
    input.observation.cardRecordCount !== input.observation.distinctCardIdentityCount ||
    input.observation.packRecordCount !== input.observation.distinctPackIdentityCount ||
    input.observation.distinctCardIdentityCount !== input.pins.sourceHeadCounts.card ||
    input.observation.distinctPackIdentityCount !== input.pins.sourceHeadCounts.pack ||
    input.observation.sourceRecordCount !== input.observation.cardRecordCount + input.observation.packRecordCount ||
    input.observation.catalogRecordCount < input.observation.sourceRecordCount ||
    !sha256.test(input.observation.identityChainDigest) ||
    !sha256.test(input.observation.identityMultisetDigest) ||
    input.observation.identityMultisetDigest !== input.pins.sourceHeadIdentityMultisetDigest ||
    input.observation.pullRecordCount !== 0 || input.observation.marketEventRecordCount !== 0 ||
    input.observation.quarantinedCount !== 0 ||
    !["idle", "paused"].includes(input.observation.runtimeState) ||
    input.observation.activeRunCount !== 0 ||
    input.observation.actionableCommandCount !== 0 || input.observation.importLeaseOwner !== null ||
    (input.observation.finalCursorHash !== null && !sha256.test(input.observation.finalCursorHash)) ||
    after.cards < before.cards || after.packs < before.packs ||
    after.cards < input.pins.sourceHeadCounts.card ||
    after.packs < input.pins.sourceHeadCounts.pack || after.pulls !== before.pulls ||
    after.marketEvents !== before.marketEvents || after.pullsDigest !== before.pullsDigest ||
    after.marketEventsDigest !== before.marketEventsDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_INVALID");
  }
  return Object.freeze({ catalogRunDigest: catalogBridgeDigest(input.observation), canonicalAfterDigest: catalogBridgeDigest(after) });
}
