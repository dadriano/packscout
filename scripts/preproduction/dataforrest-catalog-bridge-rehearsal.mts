import { z } from "zod";
import {
  CatalogBridgeError,
  catalogBridgeConfigurationPlan,
  catalogBridgeDigest,
  refuseCatalogBridge,
  type CatalogBridgeCanonicalEvidence,
  type CatalogBridgePrivatePreparedState,
} from "../live/dataforrest-catalog-bridge-plan.mts";
import {
  drainCatalogBridgeProvider,
  type CatalogBridgeDrainDependencies,
  type CatalogBridgeDrainOptions,
  type CatalogBridgeDrainResult,
} from "../live/dataforrest-catalog-bridge-drain.mts";
import type { CatalogBridgeDrainPins } from
  "../live/dataforrest-catalog-bridge-drain-policy.mts";
import {
  runCatalogBridgeCatalogStage,
  type CatalogBridgeCatalogStageDependencies,
} from "../live/dataforrest-catalog-bridge-catalog.mts";
import {
  runCatalogBridgeEventResumeStage,
  type CatalogBridgeEventResumeDependencies,
} from "../live/dataforrest-catalog-bridge-event-resume.mts";
import {
  assertCatalogBridgeJournal,
  type CatalogBridgePublicJournal,
} from "../live/dataforrest-catalog-bridge-state.mts";
import type { CatalogBridgeJournalCommit } from
  "../live/dataforrest-catalog-bridge-journal.mts";
import type { CatalogBridgeCatalogLivePolicy } from
  "../live/dataforrest-catalog-bridge-catalog-live-policy.mts";
import {
  catalogBridgeSourceCensusFileSha256,
  catalogBridgeSourceCensusSchema,
} from "../live/dataforrest-catalog-bridge-source-census-proof.mts";
import { providerCatalogIdentityChainDigest } from "@packscout/services";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const safeCount = z.number().int().nonnegative().safe();
const failureCode = z.string().regex(/^CATALOG_BRIDGE_CATALOG_RUN_[A-Z0-9_]+$/u);

const databaseProofLevelSchema = z.enum([
  "deterministic_fake",
  "migrated_disposable_postgresql",
]);
const databaseProofSchema = z.object({
  level: databaseProofLevelSchema,
  databaseInstanceSha256: sha256,
  evidenceSha256: sha256,
}).strict();
const processProofSchema = z.object({
  level: z.enum(["deterministic_fake", "isolated_darwin_launchd"]),
  evidenceSha256: sha256,
}).strict();
const sourceProofSchema = z.object({
  level: z.enum(["deterministic_fake", "live_dataforrest_api"]),
  evidenceSha256: sha256,
}).strict();

const proofInputSchema = z.object({
  database: databaseProofSchema,
  process: processProofSchema,
  source: sourceProofSchema,
  isolationEvidenceSha256: sha256,
}).strict();

/**
 * These are caller-declared adapter descriptions, not attestations. The
 * dependency-injected harness cannot establish which code or host supplied an
 * adapter, so no combination of these values can certify a rehearsal. A future
 * host-bound attestor must bind real adapters and sign independent evidence.
 */
export type CatalogBridgeRehearsalProof = z.infer<typeof proofInputSchema>;

const databaseLineageObservationSchema = z.object({
  databaseInstanceSha256: sha256,
  latestTerminalRunId: uuid,
  latestTerminalRunDigest: sha256,
}).strict();

export type CatalogBridgeRehearsalDatabaseLineageObservation = z.infer<
  typeof databaseLineageObservationSchema
>;

const databaseProofBindingSchema = z.object({
  schemaVersion: z.literal("dataforrest_catalog_bridge_rehearsal_database_binding_v1"),
  declaredLevel: databaseProofLevelSchema,
  databaseInstanceSha256: sha256,
  interruptedOperationId: uuid,
  interruptedCatalogRunId: uuid,
  recoveryOperationId: uuid,
  recoveryCatalogRunId: uuid,
  latestInterruptedRunId: uuid,
  latestInterruptedRunDigest: sha256,
}).strict();

export type CatalogBridgeRehearsalDatabaseProofBinding = z.infer<
  typeof databaseProofBindingSchema
>;

export function catalogBridgeRehearsalDatabaseProofDigest(
  input: CatalogBridgeRehearsalDatabaseProofBinding,
): string {
  return catalogBridgeDigest(databaseProofBindingSchema.parse(input));
}

/**
 * A hash-only observation of one source request. Implementations must collect
 * this at the actual source boundary; raw identities, cursors, and bodies are
 * deliberately not representable.
 */
const sourcePageObservationSchema = z.object({
  pageNumber: z.number().int().positive().safe(),
  requestedCursorHash: sha256.nullable(),
  nextCursorHash: sha256.nullable(),
  requestedLimit: z.number().int().positive().max(100),
  returnedRecordCount: z.number().int().nonnegative().max(100),
  continuation: z.enum(["more", "head"]),
  responseSha256: sha256,
  rawCardObservationCount: safeCount,
  rawPackObservationCount: safeCount,
  distinctCardIdentityCount: safeCount,
  distinctPackIdentityCount: safeCount,
  pageIdentityMultisetDigest: sha256,
  identityChainDigest: sha256,
  identityMultisetDigest: sha256.nullable(),
}).strict();

export type CatalogBridgeSourcePageObservation = z.infer<
  typeof sourcePageObservationSchema
>;

export interface CatalogBridgeRehearsalOperationContext {
  readonly policy: CatalogBridgeCatalogLivePolicy;
  readonly state: CatalogBridgePrivatePreparedState;
  readonly journal: CatalogBridgePublicJournal;
  readonly commit: CatalogBridgeJournalCommit;
}

export interface CatalogBridgeRehearsalOperation {
  /** Reads the authoritative journal commit immediately before each core call. */
  readonly readCommitted: () => Promise<CatalogBridgeRehearsalOperationContext>;
  readonly catalogDependencies: CatalogBridgeCatalogStageDependencies;
  /** Hash-only source-boundary trace accumulated for this operation. */
  readonly readSourcePages: () => Promise<readonly CatalogBridgeSourcePageObservation[]>;
  /** Stable, hash-only database identity and durable interrupted-run observation. */
  readonly readDatabaseLineage: () =>
    Promise<CatalogBridgeRehearsalDatabaseLineageObservation>;
}

export interface CatalogBridgeRecoveryRehearsalOperation extends
  CatalogBridgeRehearsalOperation {
  readonly eventDependencies: CatalogBridgeEventResumeDependencies;
  /** Must read the same canonical tables used by the live database adapter. */
  readonly readCanonicalEvidence: () => Promise<CatalogBridgeCanonicalEvidence>;
}

export interface CatalogBridgeRehearsalDependencies {
  readonly proof: CatalogBridgeRehearsalProof;
  readonly drain: Readonly<{
    pins: CatalogBridgeDrainPins;
    dependencies: CatalogBridgeDrainDependencies;
    options?: CatalogBridgeDrainOptions;
  }>;
  readonly interrupted: CatalogBridgeRehearsalOperation;
  readonly recovery: CatalogBridgeRecoveryRehearsalOperation;
  readonly expectedInterruptionCode: string;
  readonly expectedReuseRefusalCode:
    "CATALOG_BRIDGE_CATALOG_RUN_PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED";
  readonly now?: () => Date;
}

const catalogAttemptEvidenceSchema = z.object({
  operationId: uuid,
  catalogRunId: uuid,
  committedPhase: z.enum(["catalog_run_admitted", "catalog_completed"]),
  pageCount: z.number().int().positive().safe(),
  firstRequestedCursorHash: z.null(),
  maximumRequestedLimit: z.number().int().positive().max(100),
  maximumReturnedRecordCount: z.number().int().nonnegative().max(100),
  requestTraceSha256: sha256,
  finalContinuation: z.enum(["more", "head"]),
  rawCardObservationCount: safeCount,
  rawPackObservationCount: safeCount,
  distinctCardIdentityCount: safeCount,
  distinctPackIdentityCount: safeCount,
  identityChainDigest: sha256,
  identityMultisetDigest: sha256.nullable(),
}).strict();

const canonicalEvidenceSchema = z.object({
  cards: safeCount,
  packs: safeCount,
  pulls: safeCount,
  marketEvents: safeCount,
  pullsDigest: sha256,
  marketEventsDigest: sha256,
}).strict();

const canonicalSnapshotSchema = canonicalEvidenceSchema.extend({
  canonicalSha256: sha256,
}).strict().superRefine((value, context) => {
  const { canonicalSha256, ...canonical } = value;
  if (canonicalSha256 !== catalogBridgeDigest(canonical)) {
    context.addIssue({ code: "custom", path: ["canonicalSha256"],
      message: "Canonical snapshot digest does not match its counts and digests." });
  }
});

export const catalogBridgeRehearsalEvidenceSchema = z.object({
  schemaVersion: z.literal("dataforrest_catalog_bridge_rehearsal_v1"),
  environment: z.literal("preproduction"),
  providerKey: z.literal("collector_crypt"),
  completedAt: z.string().datetime({ offset: true }),
  classification: z.literal("non_certifying_hybrid"),
  certificationBoundary: z.literal("external_attesting_host_binder_required"),
  proof: proofInputSchema,
  databaseLineage: z.object({
    databaseInstanceSha256: sha256,
    latestInterruptedRunId: uuid,
    latestInterruptedRunDigest: sha256,
    databaseProofDigest: sha256,
  }).strict(),
  readiness: z.object({
    status: z.enum(["ready", "blocked"]),
    freshOperationConfigProgression: z.enum([
      "passed",
      "failed_fixed_current_config_3",
    ]),
    expectedRecoveryBaseConfigId: uuid,
    expectedRecoveryBaseConfigNumber: z.number().int().positive().safe(),
    observedPolicyCurrentConfigId: uuid,
    observedPolicyCurrentConfigNumber: z.number().int().positive().safe(),
    observedCentralActiveConfigId: uuid,
    observedCentralActiveConfigNumber: z.number().int().positive().safe(),
    observedRuntimeCachedConfigId: uuid,
    observedRuntimeCachedConfigNumber: z.number().int().positive().safe(),
    plannedRecoveryCatalogConfigId: uuid,
    plannedRecoveryCatalogConfigNumber: z.number().int().positive().safe(),
    plannedRecoveryEventSuccessorConfigId: uuid,
    plannedRecoveryEventSuccessorConfigNumber: z.number().int().positive().safe(),
    blockerCode: z.literal(
      "CATALOG_BRIDGE_REHEARSAL_FIXED_CONFIG_3_RETRY_UNSUPPORTED",
    ).nullable(),
  }).strict(),
  drain: z.object({
    operationId: uuid,
    terminalKind: z.enum(["interrupted_checkpoint", "succeeded_reconciled_head"]),
    pauseCommandId: uuid,
    pauseCommandDigest: sha256,
    gracefulStopReceiptSha256: sha256,
  }).strict(),
  interrupted: catalogAttemptEvidenceSchema.extend({
    committedPhase: z.literal("catalog_run_admitted"),
    finalContinuation: z.literal("more"),
    identityMultisetDigest: z.null(),
    failureCode,
  }).strict(),
  reuseRefusal: z.object({
    operationId: uuid,
    failureCode: z.literal(
      "CATALOG_BRIDGE_CATALOG_RUN_PROVIDER_DATAFORREST_CATALOG_RESTART_UNSUPPORTED",
    ),
    sourceRequestCountBefore: safeCount,
    sourceRequestCountAfter: safeCount,
    requestTraceSha256: sha256,
    admittedJournalSha256: sha256,
  }).strict(),
  recovery: catalogAttemptEvidenceSchema.extend({
    committedPhase: z.literal("catalog_completed"),
    finalContinuation: z.literal("head"),
    identityMultisetDigest: sha256,
    sourceRecordCount: safeCount,
    catalogRecordCount: safeCount,
    quarantinedCount: z.literal(0),
  }).strict(),
  censusRecovery: z.object({
    interruptedCensusFileSha256: sha256,
    interruptedCensusProofDigest: sha256,
    recoveryCensusFileSha256: sha256,
    recoveryCensusProofDigest: sha256,
    interruptedTerminalFinishedAt: z.string().datetime({ offset: true }),
    recoveryCensusCapturedAt: z.string().datetime({ offset: true }),
    executorRepositoryBindingSha256: sha256,
  }).strict(),
  canonicalContinuity: z.object({
    postCatalog: canonicalSnapshotSchema,
    afterHandoff: canonicalSnapshotSchema,
  }).strict(),
  unrelatedEvents: z.object({
    pullCountBefore: safeCount,
    pullCountAfter: safeCount,
    pullsDigestBefore: sha256,
    pullsDigestAfter: sha256,
    marketEventCountBefore: safeCount,
    marketEventCountAfter: safeCount,
    marketEventsDigestBefore: sha256,
    marketEventsDigestAfter: sha256,
  }).strict(),
  cursorAndHandoff: z.object({
    savedEventCursorHash: sha256,
    savedOpaqueValueHash: sha256,
    restoredEventCursorHash: sha256,
    restoredOpaqueValueHash: sha256,
    eventSuccessorConfigId: uuid,
    startupRunId: uuid,
    startupRunRequestedCursorHash: sha256,
    startupRunReachedHead: z.literal(true),
    processCount: z.literal(1),
    residencyPortListening: z.literal(true),
  }).strict(),
  evidenceSha256: sha256,
}).strict().superRefine((value, context) => {
  const expectedConfigId = value.readiness.expectedRecoveryBaseConfigId;
  const expectedConfigNumber = value.readiness.expectedRecoveryBaseConfigNumber;
  const baseProgressionPassed = [
    [value.readiness.observedPolicyCurrentConfigId,
      value.readiness.observedPolicyCurrentConfigNumber],
    [value.readiness.observedCentralActiveConfigId,
      value.readiness.observedCentralActiveConfigNumber],
    [value.readiness.observedRuntimeCachedConfigId,
      value.readiness.observedRuntimeCachedConfigNumber],
  ].every(([configId, configNumber]) =>
    configId === expectedConfigId && configNumber === expectedConfigNumber);
  const recoveryPlanProgressed =
    value.readiness.plannedRecoveryCatalogConfigId !== expectedConfigId &&
    value.readiness.plannedRecoveryCatalogConfigNumber > expectedConfigNumber &&
    value.readiness.plannedRecoveryEventSuccessorConfigId !==
      value.readiness.plannedRecoveryCatalogConfigId &&
    value.readiness.plannedRecoveryEventSuccessorConfigNumber >
      value.readiness.plannedRecoveryCatalogConfigNumber;
  const progressionPassed = baseProgressionPassed && recoveryPlanProgressed;
  const readinessConsistent = progressionPassed
    ? value.readiness.status === "ready" &&
      value.readiness.freshOperationConfigProgression === "passed" &&
      value.readiness.blockerCode === null
    : value.readiness.status === "blocked" &&
      value.readiness.freshOperationConfigProgression === "failed_fixed_current_config_3" &&
      value.readiness.blockerCode ===
        "CATALOG_BRIDGE_REHEARSAL_FIXED_CONFIG_3_RETRY_UNSUPPORTED";
  if (!readinessConsistent) {
    context.addIssue({ code: "custom", path: ["readiness"],
      message: "Rehearsal readiness does not match configuration progression." });
  }
  if (value.drain.operationId !== value.interrupted.operationId ||
    value.drain.terminalKind !== "interrupted_checkpoint") {
    context.addIssue({ code: "custom", path: ["drain"],
      message: "Drain evidence is not bound to the interrupted operation." });
  }
  const expectedDatabaseProofDigest = catalogBridgeRehearsalDatabaseProofDigest({
    schemaVersion: "dataforrest_catalog_bridge_rehearsal_database_binding_v1",
    declaredLevel: value.proof.database.level,
    databaseInstanceSha256: value.databaseLineage.databaseInstanceSha256,
    interruptedOperationId: value.interrupted.operationId,
    interruptedCatalogRunId: value.interrupted.catalogRunId,
    recoveryOperationId: value.recovery.operationId,
    recoveryCatalogRunId: value.recovery.catalogRunId,
    latestInterruptedRunId: value.databaseLineage.latestInterruptedRunId,
    latestInterruptedRunDigest: value.databaseLineage.latestInterruptedRunDigest,
  });
  if (value.databaseLineage.databaseInstanceSha256 !==
      value.proof.database.databaseInstanceSha256 ||
    value.databaseLineage.latestInterruptedRunId !== value.interrupted.catalogRunId ||
    value.databaseLineage.databaseProofDigest !== expectedDatabaseProofDigest ||
    value.proof.database.evidenceSha256 !== expectedDatabaseProofDigest) {
    context.addIssue({ code: "custom", path: ["databaseLineage"],
      message: "Database proof is not bound to one instance and interrupted run." });
  }
  if (value.censusRecovery.interruptedCensusFileSha256 ===
      value.censusRecovery.recoveryCensusFileSha256 ||
    value.censusRecovery.interruptedCensusProofDigest ===
      value.censusRecovery.recoveryCensusProofDigest ||
    Date.parse(value.censusRecovery.recoveryCensusCapturedAt) <=
      Date.parse(value.censusRecovery.interruptedTerminalFinishedAt)) {
    context.addIssue({ code: "custom", path: ["censusRecovery"],
      message: "Recovery census is not distinct and strictly post-failure." });
  }
  const postCatalog = value.canonicalContinuity.postCatalog;
  const afterHandoff = value.canonicalContinuity.afterHandoff;
  const canonicalKeys = ["cards", "packs", "pulls", "marketEvents",
    "pullsDigest", "marketEventsDigest", "canonicalSha256"] as const;
  if (canonicalKeys.some((key) => postCatalog[key] !== afterHandoff[key]) ||
    postCatalog.cards < value.recovery.distinctCardIdentityCount ||
    postCatalog.packs < value.recovery.distinctPackIdentityCount ||
    postCatalog.pulls !== value.unrelatedEvents.pullCountBefore ||
    postCatalog.pulls !== value.unrelatedEvents.pullCountAfter ||
    postCatalog.pullsDigest !== value.unrelatedEvents.pullsDigestBefore ||
    postCatalog.pullsDigest !== value.unrelatedEvents.pullsDigestAfter ||
    postCatalog.marketEvents !== value.unrelatedEvents.marketEventCountBefore ||
    postCatalog.marketEvents !== value.unrelatedEvents.marketEventCountAfter ||
    postCatalog.marketEventsDigest !== value.unrelatedEvents.marketEventsDigestBefore ||
    postCatalog.marketEventsDigest !== value.unrelatedEvents.marketEventsDigestAfter) {
    context.addIssue({ code: "custom", path: ["canonicalContinuity"],
      message: "Canonical state is not continuous through successor handoff." });
  }
  const { evidenceSha256, ...withoutDigest } = value;
  if (evidenceSha256 !== catalogBridgeDigest(withoutDigest)) {
    context.addIssue({ code: "custom", path: ["evidenceSha256"],
      message: "Rehearsal evidence digest does not match." });
  }
});

export type CatalogBridgeRehearsalEvidence = z.infer<
  typeof catalogBridgeRehearsalEvidenceSchema
>;

function refuse(code: string): never {
  return refuseCatalogBridge(code);
}

function errorCode(error: unknown): string {
  if (error instanceof CatalogBridgeError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return refuse("CATALOG_BRIDGE_REHEARSAL_FAILURE_NOT_STRUCTURED");
}

function assertContext(context: CatalogBridgeRehearsalOperationContext): void {
  assertCatalogBridgeJournal(context.journal);
  if (context.state.providerKey !== "collector_crypt" ||
    context.policy.pins.providerKey !== "collector_crypt" ||
    context.policy.pins.operationId !== context.state.operationId ||
    context.journal.operationId !== context.state.operationId ||
    context.commit.operationId !== context.state.operationId ||
    context.journal.providerKey !== context.state.providerKey ||
    context.commit.providerKey !== context.state.providerKey ||
    context.commit.privateStateSha256 !== catalogBridgeDigest(context.state) ||
    context.commit.publicJournalSha256 !== catalogBridgeDigest(context.journal)) {
    refuse("CATALOG_BRIDGE_REHEARSAL_OPERATION_BINDING_INVALID");
  }
}

async function contextFor(
  operation: CatalogBridgeRehearsalOperation,
): Promise<CatalogBridgeRehearsalOperationContext> {
  const context = await operation.readCommitted();
  assertContext(context);
  return context;
}

function assertDrainBinding(
  drained: CatalogBridgeDrainResult,
  context: CatalogBridgeRehearsalOperationContext,
): void {
  const worker = context.state.preflight.worker;
  const receipt = worker.gracefulStopReceipt;
  const latest = context.state.preflight.runtime.latestTerminalRun;
  const pause = context.state.preflight.runtime.pauseProvenance;
  if (drained.operationId !== context.state.operationId ||
    drained.providerKey !== context.state.providerKey ||
    drained.terminalKind !== latest.terminalKind ||
    drained.pauseCommandId !== pause.commandId ||
    drained.pauseCommandDigest !== pause.commandDigest ||
    drained.gracefulStopReceiptSha256 !== worker.gracefulStopReceiptSha256 ||
    catalogBridgeDigest(receipt) !== worker.gracefulStopReceiptSha256 ||
    receipt.operationId !== context.state.operationId ||
    receipt.providerKey !== context.state.providerKey ||
    receipt.terminal.kind !== latest.terminalKind ||
    receipt.terminal.runId !== latest.runId ||
    receipt.terminal.runDigest !== latest.runDigest ||
    receipt.terminal.finishedAt !== latest.finishedAt ||
    receipt.terminal.pageCount !== latest.pageCount ||
    receipt.terminal.finalCursorHash !== latest.finalCursorHash ||
    receipt.terminal.lastPageNumber !== latest.lastPageNumber ||
    receipt.terminal.lastPageCursorHash !== latest.lastPageCursorHash ||
    receipt.terminal.lastPageContinuation !== latest.lastPageContinuation ||
    receipt.terminal.lastPageDigest !== latest.lastPageDigest ||
    receipt.terminal.headProofDigest !== latest.headProofDigest ||
    receipt.pause.commandId !== pause.commandId ||
    receipt.pause.commandDigest !== pause.commandDigest) {
    refuse("CATALOG_BRIDGE_REHEARSAL_DRAIN_BINDING_INVALID");
  }
}

async function databaseLineageFor(
  operation: CatalogBridgeRehearsalOperation,
): Promise<CatalogBridgeRehearsalDatabaseLineageObservation> {
  const parsed = databaseLineageObservationSchema.safeParse(
    await operation.readDatabaseLineage(),
  );
  if (!parsed.success) {
    refuse("CATALOG_BRIDGE_REHEARSAL_DATABASE_LINEAGE_INVALID");
  }
  return parsed.data;
}

function assertDatabaseLineage(input: Readonly<{
  proof: CatalogBridgeRehearsalProof;
  interrupted: CatalogBridgeRehearsalOperationContext;
  recovery: CatalogBridgeRehearsalOperationContext;
  interruptedObservation: CatalogBridgeRehearsalDatabaseLineageObservation;
  recoveryObservation: CatalogBridgeRehearsalDatabaseLineageObservation;
}>): Readonly<{
  databaseInstanceSha256: string;
  latestInterruptedRunId: string;
  latestInterruptedRunDigest: string;
  databaseProofDigest: string;
}> {
  const interrupted = input.interruptedObservation;
  const recovery = input.recoveryObservation;
  const latest = input.recovery.state.preflight.runtime.latestTerminalRun;
  const binding = {
    schemaVersion: "dataforrest_catalog_bridge_rehearsal_database_binding_v1" as const,
    declaredLevel: input.proof.database.level,
    databaseInstanceSha256: interrupted.databaseInstanceSha256,
    interruptedOperationId: input.interrupted.state.operationId,
    interruptedCatalogRunId: input.interrupted.state.catalogRunId,
    recoveryOperationId: input.recovery.state.operationId,
    recoveryCatalogRunId: input.recovery.state.catalogRunId,
    latestInterruptedRunId: latest.runId,
    latestInterruptedRunDigest: latest.runDigest,
  };
  const databaseProofDigest = catalogBridgeRehearsalDatabaseProofDigest(binding);
  if (interrupted.databaseInstanceSha256 !== recovery.databaseInstanceSha256 ||
    interrupted.databaseInstanceSha256 !== input.proof.database.databaseInstanceSha256 ||
    interrupted.latestTerminalRunId !== recovery.latestTerminalRunId ||
    interrupted.latestTerminalRunDigest !== recovery.latestTerminalRunDigest ||
    interrupted.latestTerminalRunId !== latest.runId ||
    interrupted.latestTerminalRunDigest !== latest.runDigest ||
    latest.runId !== input.interrupted.state.catalogRunId ||
    input.proof.database.evidenceSha256 !== databaseProofDigest) {
    refuse("CATALOG_BRIDGE_REHEARSAL_DATABASE_LINEAGE_INVALID");
  }
  return Object.freeze({ databaseInstanceSha256: interrupted.databaseInstanceSha256,
    latestInterruptedRunId: latest.runId,
    latestInterruptedRunDigest: latest.runDigest,
    databaseProofDigest });
}

async function runCatalog(
  operation: CatalogBridgeRehearsalOperation,
  mode: "check_only" | "apply",
): Promise<Readonly<Record<string, unknown>>> {
  const context = await contextFor(operation);
  return runCatalogBridgeCatalogStage({
    mode,
    ...context,
    dependencies: operation.catalogDependencies,
  });
}

async function runEvent(
  operation: CatalogBridgeRecoveryRehearsalOperation,
  mode: "check_only" | "apply",
): Promise<Readonly<Record<string, unknown>>> {
  const context = await contextFor(operation);
  return runCatalogBridgeEventResumeStage({
    mode,
    ...context,
    dependencies: operation.eventDependencies,
  });
}

interface SourceSummary {
  readonly pageCount: number;
  readonly firstRequestedCursorHash: null;
  readonly maximumRequestedLimit: number;
  readonly maximumReturnedRecordCount: number;
  readonly requestTraceSha256: string;
  readonly finalContinuation: "more" | "head";
  readonly rawCardObservationCount: number;
  readonly rawPackObservationCount: number;
  readonly distinctCardIdentityCount: number;
  readonly distinctPackIdentityCount: number;
  readonly identityChainDigest: string;
  readonly identityMultisetDigest: string | null;
}

function parseSourcePages(value: unknown): CatalogBridgeSourcePageObservation[] {
  const parsed = z.array(sourcePageObservationSchema).min(1).safeParse(value);
  if (!parsed.success) refuse("CATALOG_BRIDGE_REHEARSAL_SOURCE_TRACE_INVALID");
  return parsed.data;
}

function summarizeSourcePages(
  value: readonly CatalogBridgeSourcePageObservation[],
  expectedFinal: "more" | "head",
): SourceSummary {
  const pages = parseSourcePages(value);
  let previousCards = 0;
  let previousPacks = 0;
  let previousDistinctCards = 0;
  let previousDistinctPacks = 0;
  let previousCursorHash: string | null = null;
  let previousChainDigest: string | null = null;
  for (const [index, page] of pages.entries()) {
    const final = index === pages.length - 1;
    const cardDelta = page.rawCardObservationCount - previousCards;
    const packDelta = page.rawPackObservationCount - previousPacks;
    const distinctCardDelta = page.distinctCardIdentityCount - previousDistinctCards;
    const distinctPackDelta = page.distinctPackIdentityCount - previousDistinctPacks;
    if (page.pageNumber !== index + 1 ||
      page.requestedCursorHash !== previousCursorHash ||
      page.returnedRecordCount > page.requestedLimit ||
      cardDelta < 0 || packDelta < 0 ||
      cardDelta + packDelta !== page.returnedRecordCount ||
      distinctCardDelta < 0 || distinctPackDelta < 0 ||
      distinctCardDelta > cardDelta || distinctPackDelta > packDelta ||
      page.rawCardObservationCount < previousCards ||
      page.rawPackObservationCount < previousPacks ||
      page.distinctCardIdentityCount < previousDistinctCards ||
      page.distinctPackIdentityCount < previousDistinctPacks ||
      page.distinctCardIdentityCount > page.rawCardObservationCount ||
      page.distinctPackIdentityCount > page.rawPackObservationCount ||
      page.continuation !== (final ? expectedFinal : "more") ||
      (page.continuation === "more" ? page.nextCursorHash === null : page.nextCursorHash !== null) ||
      page.identityChainDigest !== providerCatalogIdentityChainDigest({
        previousChainDigest,
        pageNumber: page.pageNumber,
        pageResponseDigest: page.responseSha256,
        pageIdentityMultisetDigest: page.pageIdentityMultisetDigest,
      }) ||
      (page.continuation === "head") !== (page.identityMultisetDigest !== null)) {
      refuse("CATALOG_BRIDGE_REHEARSAL_SOURCE_TRACE_INVALID");
    }
    previousCards = page.rawCardObservationCount;
    previousPacks = page.rawPackObservationCount;
    previousDistinctCards = page.distinctCardIdentityCount;
    previousDistinctPacks = page.distinctPackIdentityCount;
    previousCursorHash = page.nextCursorHash;
    previousChainDigest = page.identityChainDigest;
  }
  const last = pages.at(-1)!;
  return Object.freeze({
    pageCount: pages.length,
    firstRequestedCursorHash: null,
    maximumRequestedLimit: Math.max(...pages.map((page) => page.requestedLimit)),
    maximumReturnedRecordCount: Math.max(...pages.map((page) => page.returnedRecordCount)),
    requestTraceSha256: catalogBridgeDigest(pages),
    finalContinuation: last.continuation,
    rawCardObservationCount: last.rawCardObservationCount,
    rawPackObservationCount: last.rawPackObservationCount,
    distinctCardIdentityCount: last.distinctCardIdentityCount,
    distinctPackIdentityCount: last.distinctPackIdentityCount,
    identityChainDigest: last.identityChainDigest,
    identityMultisetDigest: last.identityMultisetDigest,
  });
}

function receipt(
  journal: CatalogBridgePublicJournal,
  phase: CatalogBridgePublicJournal["phase"],
) {
  return journal.receipts.find((entry) => entry.phase === phase) ??
    refuse("CATALOG_BRIDGE_REHEARSAL_RECEIPT_MISSING");
}

interface CensusBinding {
  readonly fileSha256: string;
  readonly proofDigest: string;
  readonly capturedAt: string;
  readonly executorRepositoryBindingSha256: string;
}

function assertCensusBinding(
  context: CatalogBridgeRehearsalOperationContext,
): CensusBinding {
  const wrapper = context.state.preflight.sourceCensus;
  const parsed = catalogBridgeSourceCensusSchema.safeParse(wrapper.proof);
  if (!parsed.success) {
    refuse("CATALOG_BRIDGE_REHEARSAL_CENSUS_REPOSITORY_BINDING_INVALID");
  }
  const proof = parsed.data;
  const repository = context.state.preflight.repository;
  const pins = context.policy.pins;
  const fileSha256 = catalogBridgeSourceCensusFileSha256(proof);
  const proofDigest = catalogBridgeDigest(proof);
  if (!repository.clean ||
    proof.operationId !== context.state.operationId ||
    repository.checkout !== pins.residentCheckout ||
    repository.expectedCommit !== pins.residentCommit ||
    repository.observedCommit !== pins.residentCommit ||
    proof.executor.checkout !== repository.checkout ||
    proof.executor.commit !== repository.expectedCommit ||
    proof.executor.commit !== repository.observedCommit ||
    wrapper.fileSha256 !== fileSha256 ||
    wrapper.proofDigest !== proofDigest ||
    pins.sourceHeadCensusFileSha256 !== fileSha256 ||
    pins.sourceHeadCensusProofDigest !== proofDigest) {
    refuse("CATALOG_BRIDGE_REHEARSAL_CENSUS_REPOSITORY_BINDING_INVALID");
  }
  return Object.freeze({ fileSha256, proofDigest, capturedAt: proof.capturedAt,
    executorRepositoryBindingSha256: catalogBridgeDigest({
      executorCheckoutSha256: catalogBridgeDigest(proof.executor.checkout),
      executorCommit: proof.executor.commit,
      repositoryCheckoutSha256: catalogBridgeDigest(repository.checkout),
      repositoryExpectedCommit: repository.expectedCommit,
      repositoryObservedCommit: repository.observedCommit,
      repositoryClean: repository.clean,
    }) });
}

function assertSameProviderDatabaseLineage(input: Readonly<{
  interrupted: CatalogBridgeRehearsalOperationContext;
  recovery: CatalogBridgeRehearsalOperationContext;
}>): void {
  const interruptedCentral = input.interrupted.state.preflight.central;
  const recoveryCentral = input.recovery.state.preflight.central;
  const interruptedRuntime = input.interrupted.state.preflight.runtime;
  const recoveryRuntime = input.recovery.state.preflight.runtime;
  if (recoveryCentral.organizationId !== interruptedCentral.organizationId ||
    recoveryCentral.providerId !== interruptedCentral.providerId ||
    recoveryCentral.providerKey !== interruptedCentral.providerKey ||
    recoveryCentral.databaseRouteDigest !== interruptedCentral.databaseRouteDigest ||
    recoveryCentral.sourceCredentialDigest !== interruptedCentral.sourceCredentialDigest ||
    recoveryRuntime.providerId !== interruptedRuntime.providerId ||
    recoveryRuntime.providerKey !== interruptedRuntime.providerKey ||
    recoveryRuntime.databaseName !== interruptedRuntime.databaseName ||
    recoveryRuntime.databasePort !== interruptedRuntime.databasePort ||
    recoveryRuntime.databaseRole !== interruptedRuntime.databaseRole ||
    recoveryRuntime.schemaVersion !== interruptedRuntime.schemaVersion ||
    input.interrupted.policy.current.providerId !== interruptedCentral.providerId ||
    input.recovery.policy.current.providerId !== recoveryCentral.providerId ||
    input.interrupted.policy.current.databaseRouteDigest !==
      interruptedCentral.databaseRouteDigest ||
    input.recovery.policy.current.databaseRouteDigest !== recoveryCentral.databaseRouteDigest ||
    input.interrupted.state.preflight.sourceCensus.proof.source.providerId !==
      interruptedCentral.providerId ||
    input.recovery.state.preflight.sourceCensus.proof.source.providerId !==
      recoveryCentral.providerId) {
    refuse("CATALOG_BRIDGE_REHEARSAL_PROVIDER_DATABASE_LINEAGE_INVALID");
  }
}

interface ConfigurationProgression {
  readonly passed: boolean;
  readonly expectedRecoveryBaseConfigId: string;
  readonly expectedRecoveryBaseConfigNumber: number;
  readonly observedPolicyCurrentConfigId: string;
  readonly observedPolicyCurrentConfigNumber: number;
  readonly observedCentralActiveConfigId: string;
  readonly observedCentralActiveConfigNumber: number;
  readonly observedRuntimeCachedConfigId: string;
  readonly observedRuntimeCachedConfigNumber: number;
  readonly plannedRecoveryCatalogConfigId: string;
  readonly plannedRecoveryCatalogConfigNumber: number;
  readonly plannedRecoveryEventSuccessorConfigId: string;
  readonly plannedRecoveryEventSuccessorConfigNumber: number;
}

function configurationProgression(input: Readonly<{
  interrupted: CatalogBridgeRehearsalOperationContext;
  recovery: CatalogBridgeRehearsalOperationContext;
}>): ConfigurationProgression {
  const expected = catalogBridgeConfigurationPlan(input.interrupted.state).catalog;
  const recoveryPlan = catalogBridgeConfigurationPlan(input.recovery.state);
  const activated = receipt(input.interrupted.journal, "catalog_activated").evidence;
  const admitted = receipt(input.interrupted.journal, "catalog_run_admitted").evidence;
  const interruptedCentral = input.interrupted.state.preflight.central;
  const interruptedRuntime = input.interrupted.state.preflight.runtime;
  if (expected.id !== input.interrupted.state.catalogConfigId ||
    expected.id === input.interrupted.policy.current.configId ||
    expected.versionNumber <= input.interrupted.policy.current.configNumber ||
    input.interrupted.policy.current.configId !== interruptedCentral.activeConfigId ||
    input.interrupted.policy.current.configNumber !== interruptedCentral.activeConfigNumber ||
    input.interrupted.policy.current.configId !== interruptedRuntime.cachedConfigId ||
    input.interrupted.policy.current.configNumber !== interruptedRuntime.cachedConfigNumber ||
    activated.catalogConfigId !== expected.id ||
    activated.catalogConfigNumber !== expected.versionNumber ||
    admitted.catalogRunConfigId !== expected.id ||
    admitted.catalogRunConfigNumber !== expected.versionNumber) {
    refuse("CATALOG_BRIDGE_REHEARSAL_INTERRUPTED_CONFIG_LINEAGE_INVALID");
  }
  const recoveryCentral = input.recovery.state.preflight.central;
  const recoveryRuntime = input.recovery.state.preflight.runtime;
  const progression = {
    expectedRecoveryBaseConfigId: expected.id,
    expectedRecoveryBaseConfigNumber: expected.versionNumber,
    observedPolicyCurrentConfigId: input.recovery.policy.current.configId,
    observedPolicyCurrentConfigNumber: input.recovery.policy.current.configNumber,
    observedCentralActiveConfigId: recoveryCentral.activeConfigId,
    observedCentralActiveConfigNumber: recoveryCentral.activeConfigNumber,
    observedRuntimeCachedConfigId: recoveryRuntime.cachedConfigId,
    observedRuntimeCachedConfigNumber: recoveryRuntime.cachedConfigNumber,
    plannedRecoveryCatalogConfigId: recoveryPlan.catalog.id,
    plannedRecoveryCatalogConfigNumber: recoveryPlan.catalog.versionNumber,
    plannedRecoveryEventSuccessorConfigId: recoveryPlan.eventSuccessor.id,
    plannedRecoveryEventSuccessorConfigNumber: recoveryPlan.eventSuccessor.versionNumber,
  };
  const baseProgressionPassed = [
      [progression.observedPolicyCurrentConfigId,
        progression.observedPolicyCurrentConfigNumber],
      [progression.observedCentralActiveConfigId,
        progression.observedCentralActiveConfigNumber],
      [progression.observedRuntimeCachedConfigId,
        progression.observedRuntimeCachedConfigNumber],
    ].every(([configId, configNumber]) =>
      configId === expected.id && configNumber === expected.versionNumber);
  const recoveryPlanProgressed =
    progression.plannedRecoveryCatalogConfigId !== expected.id &&
    progression.plannedRecoveryCatalogConfigNumber > expected.versionNumber &&
    progression.plannedRecoveryEventSuccessorConfigId !==
      progression.plannedRecoveryCatalogConfigId &&
    progression.plannedRecoveryEventSuccessorConfigNumber >
      progression.plannedRecoveryCatalogConfigNumber;
  return Object.freeze({ ...progression,
    passed: baseProgressionPassed && recoveryPlanProgressed });
}

function assertFreshRecovery(input: Readonly<{
  interrupted: CatalogBridgeRehearsalOperationContext;
  recovery: CatalogBridgeRehearsalOperationContext;
  interruptedSource: SourceSummary;
}>): Readonly<{
  interruptedCensus: CensusBinding;
  recoveryCensus: CensusBinding;
  interruptedTerminalFinishedAt: string;
  configuration: ConfigurationProgression;
}> {
  const interruptedState = input.interrupted.state;
  const recoveryState = input.recovery.state;
  const latest = recoveryState.preflight.runtime.latestTerminalRun;
  assertSameProviderDatabaseLineage(input);
  const interruptedCensus = assertCensusBinding(input.interrupted);
  const recoveryCensus = assertCensusBinding(input.recovery);
  const terminalFinishedAt = Date.parse(latest.finishedAt);
  const recoveryCapturedAt = Date.parse(recoveryCensus.capturedAt);
  if (input.interrupted.journal.phase !== "catalog_run_admitted" ||
    input.recovery.journal.phase !== "prepared" ||
    interruptedState.operationId === recoveryState.operationId ||
    interruptedState.catalogRunId === recoveryState.catalogRunId ||
    interruptedState.catalogConfigId === recoveryState.catalogConfigId ||
    interruptedState.eventSuccessorConfigId === recoveryState.eventSuccessorConfigId ||
    interruptedState.savedEventCursorHash !== recoveryState.savedEventCursorHash ||
    interruptedState.savedOpaqueValueHash !== recoveryState.savedOpaqueValueHash ||
    interruptedState.preflight.baseline.pulls !== recoveryState.preflight.baseline.pulls ||
    interruptedState.preflight.baseline.marketEvents !== recoveryState.preflight.baseline.marketEvents ||
    interruptedState.preflight.baseline.pullsDigest !== recoveryState.preflight.baseline.pullsDigest ||
    interruptedState.preflight.baseline.marketEventsDigest !==
      recoveryState.preflight.baseline.marketEventsDigest ||
    latest.terminalKind !== "interrupted_checkpoint" ||
    latest.runId !== interruptedState.catalogRunId ||
    latest.reachedSourceHead || latest.lastPageContinuation !== "more" ||
    latest.pageCount !== input.interruptedSource.pageCount ||
    latest.lastPageNumber !== input.interruptedSource.pageCount ||
    interruptedCensus.fileSha256 === recoveryCensus.fileSha256 ||
    interruptedCensus.proofDigest === recoveryCensus.proofDigest ||
    !Number.isFinite(terminalFinishedAt) || !Number.isFinite(recoveryCapturedAt) ||
    recoveryCapturedAt <= terminalFinishedAt) {
    refuse("CATALOG_BRIDGE_REHEARSAL_FRESH_OPERATION_INVALID");
  }
  return Object.freeze({ interruptedCensus, recoveryCensus,
    interruptedTerminalFinishedAt: latest.finishedAt,
    configuration: configurationProgression(input) });
}

/**
 * Runs the existing dependency-injected live cores against caller-owned,
 * isolated adapters. This function never reads live environment variables and
 * cannot weaken or bypass any live CLI policy gate.
 */
export async function rehearseDataforrestCatalogBridge(
  input: CatalogBridgeRehearsalDependencies,
): Promise<CatalogBridgeRehearsalEvidence> {
  const proof = proofInputSchema.parse(input.proof);
  if (!failureCode.safeParse(input.expectedInterruptionCode).success ||
    input.expectedInterruptionCode === input.expectedReuseRefusalCode) {
    refuse("CATALOG_BRIDGE_REHEARSAL_FAILURE_CODES_INVALID");
  }
  const initialInterrupted = await contextFor(input.interrupted);
  if (input.drain.pins.operationId !== initialInterrupted.state.operationId ||
    input.drain.pins.providerKey !== "collector_crypt" ||
    input.drain.pins.operatorId !== initialInterrupted.policy.pins.operatorId) {
    refuse("CATALOG_BRIDGE_REHEARSAL_DRAIN_BINDING_INVALID");
  }

  const drained = await drainCatalogBridgeProvider(input.drain);
  assertDrainBinding(drained, initialInterrupted);
  await runCatalog(input.interrupted, "check_only");
  try {
    await runCatalog(input.interrupted, "apply");
    refuse("CATALOG_BRIDGE_REHEARSAL_INTERRUPTION_MISSING");
  } catch (error) {
    if (errorCode(error) !== input.expectedInterruptionCode) throw error;
  }
  const afterInterruption = await contextFor(input.interrupted);
  const interruptedSourcePages = await input.interrupted.readSourcePages();
  const interruptedSource = summarizeSourcePages(interruptedSourcePages, "more");
  if (interruptedSource.pageCount < 2 ||
    afterInterruption.journal.phase !== "catalog_run_admitted") {
    refuse("CATALOG_BRIDGE_REHEARSAL_MID_CENSUS_INTERRUPTION_INVALID");
  }
  const admittedJournalSha256 = catalogBridgeDigest(afterInterruption.journal);

  try {
    await runCatalog(input.interrupted, "apply");
    refuse("CATALOG_BRIDGE_REHEARSAL_REUSE_ACCEPTED");
  } catch (error) {
    if (errorCode(error) !== input.expectedReuseRefusalCode) throw error;
  }
  const afterReuse = await contextFor(input.interrupted);
  const afterReusePages = parseSourcePages(await input.interrupted.readSourcePages());
  if (afterReusePages.length !== interruptedSourcePages.length ||
    catalogBridgeDigest(afterReusePages) !== interruptedSource.requestTraceSha256 ||
    catalogBridgeDigest(afterReuse.journal) !== admittedJournalSha256 ||
    afterReuse.journal.phase !== "catalog_run_admitted") {
    refuse("CATALOG_BRIDGE_REHEARSAL_REUSE_PERFORMED_SOURCE_IO");
  }

  const interruptedDatabaseLineage = await databaseLineageFor(input.interrupted);
  const recoveryBefore = await contextFor(input.recovery);
  const recoveryDatabaseLineage = await databaseLineageFor(input.recovery);
  const databaseLineage = assertDatabaseLineage({ proof,
    interrupted: afterInterruption, recovery: recoveryBefore,
    interruptedObservation: interruptedDatabaseLineage,
    recoveryObservation: recoveryDatabaseLineage });
  const freshRecovery = assertFreshRecovery({
    interrupted: afterInterruption, recovery: recoveryBefore,
    interruptedSource });
  const configurationProgressionPassed = freshRecovery.configuration.passed;
  await runCatalog(input.recovery, "check_only");
  const catalogResult = await runCatalog(input.recovery, "apply");
  if (catalogResult.phase !== "catalog_completed") {
    refuse("CATALOG_BRIDGE_REHEARSAL_RECOVERY_CATALOG_INCOMPLETE");
  }
  const afterCatalog = await contextFor(input.recovery);
  const postCatalogCanonical = canonicalEvidenceSchema.parse(
    await input.recovery.readCanonicalEvidence(),
  );
  const recoverySource = summarizeSourcePages(
    await input.recovery.readSourcePages(),
    "head",
  );
  const catalogReceipt = receipt(afterCatalog.journal, "catalog_completed");
  const catalogEvidence = catalogReceipt.evidence;
  if (afterCatalog.journal.phase !== "catalog_completed" ||
    recoverySource.rawCardObservationCount !== catalogEvidence.cardRecordCount ||
    recoverySource.rawPackObservationCount !== catalogEvidence.packRecordCount ||
    recoverySource.distinctCardIdentityCount !== catalogEvidence.distinctCardIdentityCount ||
    recoverySource.distinctPackIdentityCount !== catalogEvidence.distinctPackIdentityCount ||
    recoverySource.identityChainDigest !== catalogEvidence.identityChainDigest ||
    recoverySource.identityMultisetDigest !== catalogEvidence.identityMultisetDigest ||
    catalogEvidence.sourceRecordCount !== recoverySource.rawCardObservationCount +
      recoverySource.rawPackObservationCount ||
    catalogEvidence.catalogRecordCount < catalogEvidence.sourceRecordCount ||
    postCatalogCanonical.cards < recoverySource.distinctCardIdentityCount ||
    postCatalogCanonical.packs < recoverySource.distinctPackIdentityCount ||
    catalogEvidence.canonicalAfterDigest !== catalogBridgeDigest(postCatalogCanonical) ||
    postCatalogCanonical.pulls !== afterCatalog.state.preflight.baseline.pulls ||
    postCatalogCanonical.marketEvents !==
      afterCatalog.state.preflight.baseline.marketEvents ||
    postCatalogCanonical.pullsDigest !==
      afterCatalog.state.preflight.baseline.pullsDigest ||
    postCatalogCanonical.marketEventsDigest !==
      afterCatalog.state.preflight.baseline.marketEventsDigest ||
    catalogEvidence.pullRecordCount !== 0 || catalogEvidence.marketEventRecordCount !== 0 ||
    catalogEvidence.quarantinedCount !== 0) {
    refuse("CATALOG_BRIDGE_REHEARSAL_RECOVERY_CENSUS_INVALID");
  }

  await runEvent(input.recovery, "check_only");
  const eventResult = await runEvent(input.recovery, "apply");
  if (eventResult.phase !== "resumed") {
    refuse("CATALOG_BRIDGE_REHEARSAL_SUCCESSOR_INCOMPLETE");
  }
  const completed = await contextFor(input.recovery);
  const restoredReceipt = receipt(completed.journal, "event_cursor_restored");
  const resumedReceipt = receipt(completed.journal, "resumed");
  const restored = restoredReceipt.evidence;
  const resumed = resumedReceipt.evidence;
  if (completed.journal.phase !== "resumed" ||
    restored.restoredOpaqueValueHash !== completed.state.savedOpaqueValueHash ||
    resumed.startupRunRequestedCursorHash !== restored.restoredCursorHash ||
    resumed.startupRunReachedHead !== true || resumed.processCount !== 1 ||
    resumed.residencyPortListening !== true ||
    resumed.eventSuccessorConfigId !== completed.state.eventSuccessorConfigId) {
    refuse("CATALOG_BRIDGE_REHEARSAL_CURSOR_HANDOFF_INVALID");
  }

  const before = completed.state.preflight.baseline;
  const after = canonicalEvidenceSchema.parse(
    await input.recovery.readCanonicalEvidence(),
  );
  if (catalogBridgeDigest(after) !== catalogBridgeDigest(postCatalogCanonical) ||
    postCatalogCanonical.cards !== after.cards ||
    postCatalogCanonical.packs !== after.packs ||
    postCatalogCanonical.pulls !== after.pulls ||
    postCatalogCanonical.marketEvents !== after.marketEvents ||
    postCatalogCanonical.pullsDigest !== after.pullsDigest ||
    postCatalogCanonical.marketEventsDigest !== after.marketEventsDigest) {
    refuse("CATALOG_BRIDGE_REHEARSAL_CANONICAL_CONTINUITY_INVALID");
  }
  const now = (input.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    refuse("CATALOG_BRIDGE_REHEARSAL_CLOCK_INVALID");
  }

  const withoutDigest = Object.freeze({
    schemaVersion: "dataforrest_catalog_bridge_rehearsal_v1" as const,
    environment: "preproduction" as const,
    providerKey: "collector_crypt" as const,
    completedAt: now.toISOString(),
    classification: "non_certifying_hybrid" as const,
    certificationBoundary: "external_attesting_host_binder_required" as const,
    proof,
    databaseLineage,
    readiness: configurationProgressionPassed
      ? Object.freeze({ status: "ready" as const,
          freshOperationConfigProgression: "passed" as const,
          expectedRecoveryBaseConfigId:
            freshRecovery.configuration.expectedRecoveryBaseConfigId,
          expectedRecoveryBaseConfigNumber:
            freshRecovery.configuration.expectedRecoveryBaseConfigNumber,
          observedPolicyCurrentConfigId:
            freshRecovery.configuration.observedPolicyCurrentConfigId,
          observedPolicyCurrentConfigNumber:
            freshRecovery.configuration.observedPolicyCurrentConfigNumber,
          observedCentralActiveConfigId:
            freshRecovery.configuration.observedCentralActiveConfigId,
          observedCentralActiveConfigNumber:
            freshRecovery.configuration.observedCentralActiveConfigNumber,
          observedRuntimeCachedConfigId:
            freshRecovery.configuration.observedRuntimeCachedConfigId,
          observedRuntimeCachedConfigNumber:
            freshRecovery.configuration.observedRuntimeCachedConfigNumber,
          plannedRecoveryCatalogConfigId:
            freshRecovery.configuration.plannedRecoveryCatalogConfigId,
          plannedRecoveryCatalogConfigNumber:
            freshRecovery.configuration.plannedRecoveryCatalogConfigNumber,
          plannedRecoveryEventSuccessorConfigId:
            freshRecovery.configuration.plannedRecoveryEventSuccessorConfigId,
          plannedRecoveryEventSuccessorConfigNumber:
            freshRecovery.configuration.plannedRecoveryEventSuccessorConfigNumber,
          blockerCode: null })
      : Object.freeze({ status: "blocked" as const,
          freshOperationConfigProgression: "failed_fixed_current_config_3" as const,
          expectedRecoveryBaseConfigId:
            freshRecovery.configuration.expectedRecoveryBaseConfigId,
          expectedRecoveryBaseConfigNumber:
            freshRecovery.configuration.expectedRecoveryBaseConfigNumber,
          observedPolicyCurrentConfigId:
            freshRecovery.configuration.observedPolicyCurrentConfigId,
          observedPolicyCurrentConfigNumber:
            freshRecovery.configuration.observedPolicyCurrentConfigNumber,
          observedCentralActiveConfigId:
            freshRecovery.configuration.observedCentralActiveConfigId,
          observedCentralActiveConfigNumber:
            freshRecovery.configuration.observedCentralActiveConfigNumber,
          observedRuntimeCachedConfigId:
            freshRecovery.configuration.observedRuntimeCachedConfigId,
          observedRuntimeCachedConfigNumber:
            freshRecovery.configuration.observedRuntimeCachedConfigNumber,
          plannedRecoveryCatalogConfigId:
            freshRecovery.configuration.plannedRecoveryCatalogConfigId,
          plannedRecoveryCatalogConfigNumber:
            freshRecovery.configuration.plannedRecoveryCatalogConfigNumber,
          plannedRecoveryEventSuccessorConfigId:
            freshRecovery.configuration.plannedRecoveryEventSuccessorConfigId,
          plannedRecoveryEventSuccessorConfigNumber:
            freshRecovery.configuration.plannedRecoveryEventSuccessorConfigNumber,
          blockerCode: "CATALOG_BRIDGE_REHEARSAL_FIXED_CONFIG_3_RETRY_UNSUPPORTED" as const }),
    drain: Object.freeze({ operationId: drained.operationId,
      terminalKind: drained.terminalKind,
      pauseCommandId: drained.pauseCommandId,
      pauseCommandDigest: drained.pauseCommandDigest,
      gracefulStopReceiptSha256: drained.gracefulStopReceiptSha256 }),
    interrupted: Object.freeze({ operationId: afterInterruption.state.operationId,
      catalogRunId: afterInterruption.state.catalogRunId,
      committedPhase: "catalog_run_admitted" as const, ...interruptedSource,
      failureCode: input.expectedInterruptionCode }),
    reuseRefusal: Object.freeze({ operationId: afterInterruption.state.operationId,
      failureCode: input.expectedReuseRefusalCode,
      sourceRequestCountBefore: interruptedSourcePages.length,
      sourceRequestCountAfter: afterReusePages.length,
      requestTraceSha256: interruptedSource.requestTraceSha256,
      admittedJournalSha256 }),
    recovery: Object.freeze({ operationId: completed.state.operationId,
      catalogRunId: completed.state.catalogRunId,
      committedPhase: "catalog_completed" as const, ...recoverySource,
      sourceRecordCount: Number(catalogEvidence.sourceRecordCount),
      catalogRecordCount: Number(catalogEvidence.catalogRecordCount),
      quarantinedCount: 0 as const }),
    censusRecovery: Object.freeze({
      interruptedCensusFileSha256: freshRecovery.interruptedCensus.fileSha256,
      interruptedCensusProofDigest: freshRecovery.interruptedCensus.proofDigest,
      recoveryCensusFileSha256: freshRecovery.recoveryCensus.fileSha256,
      recoveryCensusProofDigest: freshRecovery.recoveryCensus.proofDigest,
      interruptedTerminalFinishedAt: freshRecovery.interruptedTerminalFinishedAt,
      recoveryCensusCapturedAt: freshRecovery.recoveryCensus.capturedAt,
      executorRepositoryBindingSha256: catalogBridgeDigest({
        interrupted: freshRecovery.interruptedCensus.executorRepositoryBindingSha256,
        recovery: freshRecovery.recoveryCensus.executorRepositoryBindingSha256,
      }),
    }),
    canonicalContinuity: Object.freeze({
      postCatalog: Object.freeze({ ...postCatalogCanonical,
        canonicalSha256: catalogBridgeDigest(postCatalogCanonical) }),
      afterHandoff: Object.freeze({ ...after,
        canonicalSha256: catalogBridgeDigest(after) }),
    }),
    unrelatedEvents: Object.freeze({ pullCountBefore: before.pulls,
      pullCountAfter: after.pulls, pullsDigestBefore: before.pullsDigest,
      pullsDigestAfter: after.pullsDigest, marketEventCountBefore: before.marketEvents,
      marketEventCountAfter: after.marketEvents,
      marketEventsDigestBefore: before.marketEventsDigest,
      marketEventsDigestAfter: after.marketEventsDigest }),
    cursorAndHandoff: Object.freeze({ savedEventCursorHash: completed.state.savedEventCursorHash,
      savedOpaqueValueHash: completed.state.savedOpaqueValueHash,
      restoredEventCursorHash: String(restored.restoredCursorHash),
      restoredOpaqueValueHash: String(restored.restoredOpaqueValueHash),
      eventSuccessorConfigId: completed.state.eventSuccessorConfigId,
      startupRunId: String(resumed.startupRunId),
      startupRunRequestedCursorHash: String(resumed.startupRunRequestedCursorHash),
      startupRunReachedHead: true as const, processCount: 1 as const,
      residencyPortListening: true as const }),
  });
  return catalogBridgeRehearsalEvidenceSchema.parse(Object.freeze({
    ...withoutDigest,
    evidenceSha256: catalogBridgeDigest(withoutDigest),
  }));
}
