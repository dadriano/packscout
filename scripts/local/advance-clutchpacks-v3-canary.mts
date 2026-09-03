#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
} from "@packscout/contracts";
import {
  createPrismaClientLifecycle,
  ProviderSourceAdminLifecycleRepository,
  ProviderSourceLifecycleRepository,
  SourceConnectionAdminRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  AesGcmSourceConnectionConfigurationCipher,
  createProductionSourceAdapterRegistry,
  createProductionSourceAdminConfigurationCodecRegistry,
  launchSourceMapperDescriptors,
  ProviderSourceActivationService,
  ProviderSourceLifecycleService,
  SourceConnectionConfigurationService,
  SourceMapperDescriptorRegistry,
} from "@packscout/services";
import {
  CLUTCHPACKS_V3_CANARY_SOURCE_PINS,
  assertClutchpacksV3ActiveSourceMigrationReadiness,
  type ClutchpacksV3CanaryBootstrapEnvironment,
  type ClutchpacksV3MigrationEvidence,
  readClutchpacksV3ActiveSourceMigrationEvidence,
  readClutchpacksV3CanaryBootstrapEnvironment,
} from "./bootstrap-clutchpacks-v3-canary-tenant.mts";
import { assertConnectedLocalDatabaseIdentity } from
  "./bootstrap-postgres-development-first-admin.mts";

const WORKFLOW = "advance_clutchpacks_v3_canary";
const ACTOR_KEY = "system:clutchpacks-v3-canary-qualification";
const TARGET_SLUG = "packscout-clutchpacks-v3-canary";
const TARGET_NAME = "PackScout ClutchPacks V3 Canary";
const ADVANCE_CONFIRMATION_PREFIX = "ADVANCE CLUTCHPACKS V3 LOCAL";
const PAUSE_CONFIRMATION_PREFIX = "PAUSE ORIGINAL CLUTCHPACKS V1 LOCAL";
const PAUSE_TARGET_CONFIRMATION_PREFIX =
  "PAUSE CLUTCHPACKS V3 TARGET LOCAL";
const RESUME_CONFIRMATION_PREFIX = "RESUME CLUTCHPACKS V3 LOCAL";
const RESET_TARGET_CURSOR_CONFIRMATION_PREFIX =
  "RESET CLUTCHPACKS V3 TARGET CURSOR LOCAL";
const SERVICE_CURSOR_RESET_CONFIRMATION = "RESET CLUTCHPACKS";

export class ClutchpacksV3CanaryDriverError extends Error {
  override readonly name = "ClutchpacksV3CanaryDriverError";

  constructor(readonly code: string) {
    super(code);
  }
}

function refuse(code: string): never {
  throw new ClutchpacksV3CanaryDriverError(code);
}

export interface ClutchpacksV3CanaryDriverConfirmations {
  readonly advance: string;
  readonly pauseOriginal: string;
  readonly pauseTarget: string;
  readonly resume: string;
  readonly resetTargetCursor: string;
}

export function clutchpacksV3CanaryDriverConfirmations(
  targetDigest: string,
): ClutchpacksV3CanaryDriverConfirmations {
  const binding = targetDigest.slice(0, 16);
  return Object.freeze({
    advance: `${ADVANCE_CONFIRMATION_PREFIX} ${binding}`,
    pauseOriginal: `${PAUSE_CONFIRMATION_PREFIX} ${binding}`,
    pauseTarget: `${PAUSE_TARGET_CONFIRMATION_PREFIX} ${binding}`,
    resume: `${RESUME_CONFIRMATION_PREFIX} ${binding}`,
    resetTargetCursor:
      `${RESET_TARGET_CURSOR_CONFIRMATION_PREFIX} ${binding}`,
  });
}

export type ClutchpacksV3CanaryDriverCommand = Readonly<
  | { action: "status" | "plan"; confirmation: null }
  | {
      action: "advance";
      confirmation: string;
      expectedStage: string;
    }
  | {
      action:
        | "pause_original"
        | "pause_target"
        | "resume"
        | "reset_target_cursor";
      confirmation: string;
    }
>;

export function parseClutchpacksV3CanaryDriverCommand(
  argv: readonly string[],
  confirmations: ClutchpacksV3CanaryDriverConfirmations,
): ClutchpacksV3CanaryDriverCommand {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--status")) {
    return Object.freeze({ action: "status", confirmation: null });
  }
  if (argv.length === 1 && argv[0] === "--plan") {
    return Object.freeze({ action: "plan", confirmation: null });
  }
  const declared = new Map<string, Readonly<{
    action:
      | "advance"
      | "pause_original"
      | "pause_target"
      | "resume"
      | "reset_target_cursor";
    confirmation: string;
  }>>([
    ["--advance", Object.freeze({
      action: "advance" as const,
      confirmation: confirmations.advance,
    })],
    ["--pause-original", Object.freeze({
      action: "pause_original" as const,
      confirmation: confirmations.pauseOriginal,
    })],
    ["--pause-target", Object.freeze({
      action: "pause_target" as const,
      confirmation: confirmations.pauseTarget,
    })],
    ["--resume", Object.freeze({
      action: "resume" as const,
      confirmation: confirmations.resume,
    })],
    ["--reset-target-cursor", Object.freeze({
      action: "reset_target_cursor" as const,
      confirmation: confirmations.resetTargetCursor,
    })],
  ]);
  const expected = argv[0] ? declared.get(argv[0]) : undefined;
  if (expected?.action === "advance") {
    if (
      argv.length !== 5 ||
      argv[1] !== "--expected-stage" ||
      !argv[2]?.trim() ||
      argv[3] !== "--confirmation" ||
      argv[4] !== expected.confirmation
    ) refuse("CONFIRMATION_INVALID");
    return Object.freeze({
      ...expected,
      expectedStage: argv[2],
    });
  }
  if (
    !expected ||
    argv.length !== 3 ||
    argv[1] !== "--confirmation" ||
    argv[2] !== expected.confirmation
  ) refuse("CONFIRMATION_INVALID");
  return Object.freeze({
    action: expected.action,
    confirmation: expected.confirmation,
  });
}

export interface OriginalClutchpacksV1Evidence {
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceState: string;
  readonly pauseRequested: boolean;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly connectionProfileState: string;
  readonly connectionRevisionState: string;
  readonly connectionAdapterVersion: string;
  readonly activeRunCount: number;
}

export function assertOriginalClutchpacksV1IsExact(
  evidence: readonly OriginalClutchpacksV1Evidence[],
): OriginalClutchpacksV1Evidence {
  const row = evidence[0];
  if (
    evidence.length !== 1 ||
    !row ||
    !["active", "paused"].includes(row.sourceState) ||
    row.sourceTypeKey !== DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY ||
    row.sourceAdapterVersion !==
      DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION ||
    row.connectionProfileState !== "active" ||
    row.connectionRevisionState !== "active" ||
    row.connectionAdapterVersion !==
      DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION ||
    !Number.isSafeInteger(row.activeRunCount) ||
    row.activeRunCount < 0
  ) refuse("ORIGINAL_CLUTCHPACKS_V1_NOT_EXACT");
  return row;
}

export function assertOriginalClutchpacksV1PausedAndDrained(
  evidence: OriginalClutchpacksV1Evidence,
): void {
  if (evidence.sourceState !== "paused" || evidence.pauseRequested) {
    refuse("ORIGINAL_CLUTCHPACKS_V1_NOT_PAUSED");
  }
  if (evidence.activeRunCount !== 0) {
    refuse("ORIGINAL_CLUTCHPACKS_V1_NOT_DRAINED");
  }
}

export async function assertOriginalClutchpacksV1DatabaseReady(
  readEvidence: () => Promise<readonly ClutchpacksV3MigrationEvidence[]>,
): Promise<void> {
  try {
    assertClutchpacksV3ActiveSourceMigrationReadiness(await readEvidence());
  } catch {
    refuse("ORIGINAL_DATABASE_SCHEMA_NOT_READY");
  }
}

export interface CanaryTestEvidence {
  readonly state: string;
  readonly hasSuccessfulResult: boolean;
}

export interface ClutchpacksV3CanaryTargetEvidence {
  readonly organizationCount: number;
  readonly organization: Readonly<{
    id: string;
    slug: string;
    name: string;
  }> | null;
  readonly providers: readonly Readonly<{
    id: string;
    organizationId: string;
    platformKey: string;
    state: string;
    activeRevisionId: string | null;
    nextRunAt: Date | null;
  }>[];
  readonly profiles: readonly Readonly<{
    id: string;
    organizationId: string;
    sourceTypeKey: string;
    state: string;
    requestLimit: number;
    activeRevisionId: string | null;
  }>[];
  readonly connectionRevisions: readonly Readonly<{
    id: string;
    organizationId: string;
    profileId: string;
    sourceTypeKey: string;
    adapterVersion: string;
    state: string;
    healthGeneration: bigint;
  }>[];
  readonly sources: readonly Readonly<{
    id: string;
    organizationId: string;
    providerId: string;
    profileId: string;
    sourceTypeKey: string;
    state: string;
    pauseRequested: boolean;
    activeRevisionId: string | null;
  }>[];
  readonly sourceRevisions: readonly Readonly<{
    id: string;
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    profileId: string;
    sourceTypeKey: string;
    adapterVersion: string;
    normalizedContractVersion: string;
    mapperKey: string;
    mapperVersion: string;
    identityNamespaceKey: string;
    cursorCodecVersion: string;
    configuration: unknown;
  }>[];
  readonly cursors: readonly Readonly<{
    sourceInstanceId: string;
    sourceRevisionId: string;
    generation: bigint;
    adapterVersion: string;
    fingerprint: string | null;
    advancedByRunId: string | null;
    advancedByPageId: string | null;
  }>[];
  readonly importRunCount: number;
  readonly importPageCount: number;
  readonly pageReadAttemptCount: number;
  readonly sourceRecordIdentityCount: number;
  readonly semanticObservationCount: number;
  readonly deliveryOccurrenceCount: number;
  readonly canonicalEntityCount: number;
  readonly quarantineRecordCount: number;
  readonly warningErrorCriticalDiagnosticCount: number;
  readonly unresolvedCurrentCursorGenerationDiagnosticCount: number;
  readonly legacyProviderConfigRevisionCount: number;
  readonly legacyProviderSecretVersionCount: number;
  readonly legacyProviderCursorCheckpointCount: number;
  readonly queuedOrRunningRunCount: number;
  readonly currentCursorGenerationImportRunCount: number;
  readonly latestRun: Readonly<{
    id: string;
    organizationId: string;
    providerId: string;
    sourceInstanceId: string | null;
    sourceRevisionId: string | null;
    sourceTypeKey: string | null;
    adapterVersion: string | null;
    normalizedContractVersion: string | null;
    mapperKey: string | null;
    mapperVersion: string | null;
    identityNamespaceKey: string | null;
    connectionProfileId: string | null;
    connectionRevisionId: string | null;
    cursorCodecVersion: string | null;
    cursorGeneration: bigint | null;
    configRevisionId: string | null;
    state: string;
    reachedProviderHead: boolean;
    finishedAt: Date | null;
    failureCode: string | null;
  }> | null;
  readonly connectionTest: CanaryTestEvidence | null;
  readonly sourceTest: CanaryTestEvidence | null;
}

function isClutchpacksConfiguration(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return Object.keys(record).length === 1 && record.platform === "clutchpacks";
}

export function assertClutchpacksV3CanaryTargetIsExact(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
  environment: Pick<
    ClutchpacksV3CanaryBootstrapEnvironment,
    | "targetOrganizationId"
    | "providerId"
    | "profileId"
    | "connectionRevisionId"
  >,
): void {
  const provider = snapshot.providers[0];
  const profile = snapshot.profiles[0];
  const connectionRevision = snapshot.connectionRevisions[0];
  const source = snapshot.sources[0];
  const sourceRevision = snapshot.sourceRevisions[0];
  const cursor = snapshot.cursors[0];
  if (
    snapshot.organizationCount !== 1 ||
    snapshot.organization?.id !== environment.targetOrganizationId ||
    snapshot.organization.slug !== TARGET_SLUG ||
    snapshot.organization.name !== TARGET_NAME ||
    snapshot.providers.length !== 1 ||
    !provider ||
    provider.id !== environment.providerId ||
    provider.organizationId !== environment.targetOrganizationId ||
    provider.platformKey !== "clutchpacks" ||
    provider.state !== "active" ||
    provider.activeRevisionId !== null ||
    provider.nextRunAt !== null ||
    snapshot.profiles.length !== 1 ||
    !profile ||
    profile.id !== environment.profileId ||
    profile.organizationId !== environment.targetOrganizationId ||
    profile.sourceTypeKey !== CLUTCHPACKS_V3_CANARY_SOURCE_PINS.sourceTypeKey ||
    !["draft", "active"].includes(profile.state) ||
    profile.requestLimit !== 2 ||
    snapshot.connectionRevisions.length !== 1 ||
    !connectionRevision ||
    connectionRevision.id !== environment.connectionRevisionId ||
    connectionRevision.organizationId !== environment.targetOrganizationId ||
    connectionRevision.profileId !== profile.id ||
    connectionRevision.sourceTypeKey !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.sourceTypeKey ||
    connectionRevision.adapterVersion !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.adapterVersion ||
    !["candidate", "active"].includes(connectionRevision.state) ||
    connectionRevision.healthGeneration < 0n ||
    snapshot.sources.length !== 1 ||
    !source ||
    source.organizationId !== environment.targetOrganizationId ||
    source.providerId !== provider.id ||
    source.profileId !== profile.id ||
    source.sourceTypeKey !== CLUTCHPACKS_V3_CANARY_SOURCE_PINS.sourceTypeKey ||
    !["draft", "paused", "active"].includes(source.state) ||
    (source.state !== "active" && source.pauseRequested) ||
    snapshot.sourceRevisions.length !== 1 ||
    !sourceRevision ||
    sourceRevision.organizationId !== environment.targetOrganizationId ||
    sourceRevision.providerId !== provider.id ||
    sourceRevision.sourceInstanceId !== source.id ||
    sourceRevision.profileId !== profile.id ||
    sourceRevision.sourceTypeKey !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.sourceTypeKey ||
    sourceRevision.adapterVersion !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.adapterVersion ||
    sourceRevision.normalizedContractVersion !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.normalizedContractVersion ||
    sourceRevision.mapperKey !== CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperKey ||
    sourceRevision.mapperVersion !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperVersion ||
    sourceRevision.identityNamespaceKey !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.identityNamespaceKey ||
    sourceRevision.cursorCodecVersion !==
      CLUTCHPACKS_V3_CANARY_SOURCE_PINS.cursorCodecVersion ||
    !isClutchpacksConfiguration(sourceRevision.configuration) ||
    source.activeRevisionId !== sourceRevision.id ||
    snapshot.cursors.length !== 1 ||
    !cursor ||
    cursor.sourceInstanceId !== source.id ||
    cursor.sourceRevisionId !== sourceRevision.id ||
    cursor.generation < 1n ||
    cursor.adapterVersion !== CLUTCHPACKS_V3_CANARY_SOURCE_PINS.adapterVersion ||
    !Number.isSafeInteger(snapshot.quarantineRecordCount) ||
    snapshot.quarantineRecordCount < 0 ||
    !Number.isSafeInteger(snapshot.warningErrorCriticalDiagnosticCount) ||
    snapshot.warningErrorCriticalDiagnosticCount < 0 ||
    !Number.isSafeInteger(
      snapshot.unresolvedCurrentCursorGenerationDiagnosticCount,
    ) ||
    snapshot.unresolvedCurrentCursorGenerationDiagnosticCount < 0 ||
    !Number.isSafeInteger(snapshot.currentCursorGenerationImportRunCount) ||
    snapshot.currentCursorGenerationImportRunCount < 0 ||
    snapshot.legacyProviderConfigRevisionCount !== 0 ||
    snapshot.legacyProviderSecretVersionCount !== 0 ||
    snapshot.legacyProviderCursorCheckpointCount !== 0
  ) refuse("TARGET_V3_TOPOLOGY_NOT_EXACT");
  if (
    (profile.state === "draft" &&
      (profile.activeRevisionId !== null ||
        connectionRevision.state !== "candidate")) ||
    (profile.state === "active" &&
      (profile.activeRevisionId !== connectionRevision.id ||
        connectionRevision.state !== "active")) ||
    (source.state !== "draft" && profile.state !== "active")
  ) refuse("TARGET_V3_LIFECYCLE_NOT_EXACT");
}

export function clutchpacksV3CanaryLineageCount(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
): number {
  return snapshot.importRunCount +
    snapshot.importPageCount +
    snapshot.pageReadAttemptCount +
    snapshot.sourceRecordIdentityCount +
    snapshot.semanticObservationCount +
    snapshot.deliveryOccurrenceCount +
    snapshot.canonicalEntityCount;
}

export function clutchpacksV3CanaryTargetWideSafetyEvidence(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
) {
  return Object.freeze({
    quarantineRecords: snapshot.quarantineRecordCount,
    warningErrorCriticalDiagnostics:
      snapshot.warningErrorCriticalDiagnosticCount,
    unresolvedCurrentCursorGenerationDiagnostics:
      snapshot.unresolvedCurrentCursorGenerationDiagnosticCount,
    targetWideEvidenceClean:
      snapshot.quarantineRecordCount === 0 &&
      snapshot.warningErrorCriticalDiagnosticCount === 0,
    protectiveActionEvidenceClear:
      snapshot.quarantineRecordCount === 0 &&
      snapshot.unresolvedCurrentCursorGenerationDiagnosticCount === 0,
  });
}

export function assertClutchpacksV3CanaryTargetIsPristine(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
): void {
  const cursor = snapshot.cursors[0];
  if (
    !cursor ||
    cursor.generation !== 1n ||
    cursor.fingerprint !== null ||
    cursor.advancedByRunId !== null ||
    cursor.advancedByPageId !== null ||
    snapshot.currentCursorGenerationImportRunCount !== 0 ||
    snapshot.queuedOrRunningRunCount !== 0 ||
    snapshot.quarantineRecordCount !== 0 ||
    snapshot.unresolvedCurrentCursorGenerationDiagnosticCount !== 0 ||
    clutchpacksV3CanaryLineageCount(snapshot) !== 0
  ) refuse("TARGET_NOT_PRISTINE_FOR_RESUME");
}

export function assertClutchpacksV3CanaryResetGenerationAtFeedStart(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
): void {
  const cursor = snapshot.cursors[0];
  if (
    !cursor ||
    cursor.generation <= 1n ||
    cursor.fingerprint !== null ||
    cursor.advancedByRunId !== null ||
    cursor.advancedByPageId !== null ||
    snapshot.currentCursorGenerationImportRunCount !== 0 ||
    snapshot.queuedOrRunningRunCount !== 0 ||
    snapshot.quarantineRecordCount !== 0 ||
    snapshot.unresolvedCurrentCursorGenerationDiagnosticCount !== 0
  ) refuse("TARGET_RESET_GENERATION_NOT_AT_FEED_START");
}

export function clutchpacksV3CanaryHasExactSucceededHeadRun(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
): boolean {
  const provider = snapshot.providers[0];
  const profile = snapshot.profiles[0];
  const connectionRevision = snapshot.connectionRevisions[0];
  const source = snapshot.sources[0];
  const sourceRevision = snapshot.sourceRevisions[0];
  const cursor = snapshot.cursors[0];
  const run = snapshot.latestRun;
  return Boolean(
    provider &&
      profile &&
      connectionRevision &&
      source &&
      sourceRevision &&
      cursor &&
      run &&
      cursor.generation >= 1n &&
      sourceRevision.sourceTypeKey ===
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.sourceTypeKey &&
      sourceRevision.adapterVersion ===
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.adapterVersion &&
      sourceRevision.normalizedContractVersion ===
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.normalizedContractVersion &&
      sourceRevision.mapperKey ===
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperKey &&
      sourceRevision.mapperVersion ===
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperVersion &&
      sourceRevision.identityNamespaceKey ===
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.identityNamespaceKey &&
      sourceRevision.cursorCodecVersion ===
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.cursorCodecVersion &&
      run.organizationId === source.organizationId &&
      run.providerId === provider.id &&
      run.sourceInstanceId === source.id &&
      run.sourceRevisionId === sourceRevision.id &&
      run.sourceTypeKey === sourceRevision.sourceTypeKey &&
      run.adapterVersion === sourceRevision.adapterVersion &&
      run.normalizedContractVersion ===
        sourceRevision.normalizedContractVersion &&
      run.mapperKey === sourceRevision.mapperKey &&
      run.mapperVersion === sourceRevision.mapperVersion &&
      run.identityNamespaceKey === sourceRevision.identityNamespaceKey &&
      run.connectionProfileId === profile.id &&
      run.connectionRevisionId === connectionRevision.id &&
      run.cursorCodecVersion === sourceRevision.cursorCodecVersion &&
      run.cursorGeneration === cursor.generation &&
      run.configRevisionId === null &&
      run.state === "succeeded" &&
      run.reachedProviderHead &&
      run.finishedAt !== null &&
      run.failureCode === null,
  );
}

export function assertClutchpacksV3CanaryTargetCanPause(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
): void {
  if (!clutchpacksV3CanaryHasExactSucceededHeadRun(snapshot)) {
    refuse("TARGET_SUCCEEDED_HEAD_RUN_REQUIRED");
  }
  if (snapshot.queuedOrRunningRunCount !== 0) {
    refuse("TARGET_RUNS_NOT_DRAINED");
  }
  if (snapshot.quarantineRecordCount !== 0) {
    refuse("TARGET_QUARANTINE_NOT_EMPTY");
  }
  if (snapshot.unresolvedCurrentCursorGenerationDiagnosticCount !== 0) {
    refuse("TARGET_CURRENT_GENERATION_DIAGNOSTICS_UNRESOLVED");
  }
}

export interface ClutchpacksV3CanarySupervisorEvidence {
  readonly liveEpochCount: number;
  readonly epochState: string | null;
  readonly maximumExecutionSlots: number | null;
  readonly capacityState: string | null;
  readonly snapshotPublished: boolean;
}

export function assertClutchpacksV3CanaryOneSlotSupervisor(
  evidence: ClutchpacksV3CanarySupervisorEvidence,
): void {
  if (
    evidence.liveEpochCount !== 1 ||
    evidence.epochState !== "active" ||
    evidence.maximumExecutionSlots !== 1 ||
    evidence.capacityState !== "available" ||
    !evidence.snapshotPublished
  ) refuse("TARGET_ONE_SLOT_SUPERVISOR_REQUIRED");
}

export function assertClutchpacksV3CanarySupervisorStopped(
  evidence: ClutchpacksV3CanarySupervisorEvidence,
): void {
  if (evidence.liveEpochCount !== 0) {
    refuse("TARGET_SUPERVISOR_MUST_BE_STOPPED");
  }
}

export type ClutchpacksV3CanaryQualificationStage =
  | "queue_connection_test"
  | "wait_connection_test"
  | "connection_test_failed"
  | "activate_connection"
  | "queue_source_test"
  | "wait_source_test"
  | "source_test_failed"
  | "activate_source_paused"
  | "ready_to_resume"
  | "replay_active"
  | "replay_paused";

function testStage(
  evidence: CanaryTestEvidence | null,
  absent: ClutchpacksV3CanaryQualificationStage,
  waiting: ClutchpacksV3CanaryQualificationStage,
  failed: ClutchpacksV3CanaryQualificationStage,
  succeeded: ClutchpacksV3CanaryQualificationStage,
): ClutchpacksV3CanaryQualificationStage {
  if (!evidence) return absent;
  if (["queued", "running"].includes(evidence.state)) return waiting;
  if (
    evidence.state === "succeeded" &&
    evidence.hasSuccessfulResult
  ) return succeeded;
  if (["failed", "cancelled", "fenced"].includes(evidence.state)) {
    return failed;
  }
  refuse("TARGET_TEST_EVIDENCE_INVALID");
}

export function determineClutchpacksV3CanaryQualificationStage(
  snapshot: ClutchpacksV3CanaryTargetEvidence,
): ClutchpacksV3CanaryQualificationStage {
  const profile = snapshot.profiles[0];
  const source = snapshot.sources[0];
  if (!profile || !source) refuse("TARGET_V3_TOPOLOGY_NOT_EXACT");
  if (source.state === "active") return "replay_active";
  if (source.state === "paused") {
    if (clutchpacksV3CanaryHasExactSucceededHeadRun(snapshot)) {
      return "replay_paused";
    }
    if (
      profile.state !== "active" ||
      snapshot.connectionTest?.hasSuccessfulResult !== true ||
      snapshot.sourceTest?.hasSuccessfulResult !== true
    ) refuse("TARGET_QUALIFICATION_EVIDENCE_INVALID");
    return "ready_to_resume";
  }
  if (profile.state === "draft") {
    return testStage(
      snapshot.connectionTest,
      "queue_connection_test",
      "wait_connection_test",
      "connection_test_failed",
      "activate_connection",
    );
  }
  return testStage(
    snapshot.sourceTest,
    "queue_source_test",
    "wait_source_test",
    "source_test_failed",
    "activate_source_paused",
  );
}

export function assertClutchpacksV3CanaryExpectedStage(
  expectedStage: string,
  currentStage: ClutchpacksV3CanaryQualificationStage,
): void {
  if (expectedStage !== currentStage) refuse("TARGET_STAGE_CHANGED");
}

async function readOriginalEvidence(
  database: PackscoutPrismaClient,
  organizationId: string,
): Promise<readonly OriginalClutchpacksV1Evidence[]> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`set transaction read only`);
    return transaction.$queryRaw<OriginalClutchpacksV1Evidence[]>(Prisma.sql`
      select provider.id as "providerId",
             source.id as "sourceInstanceId",
             source_revision.id as "sourceRevisionId",
             source.state::text as "sourceState",
             source.pause_requested_at is not null as "pauseRequested",
             source_revision.source_type_key as "sourceTypeKey",
             source_revision.source_adapter_version as "sourceAdapterVersion",
             profile.state::text as "connectionProfileState",
             connection_revision.state::text as "connectionRevisionState",
             connection_revision.source_adapter_version
               as "connectionAdapterVersion",
             (
               select count(*)::integer
               from public.import_runs run
               where run.organization_id = source.organization_id
                 and run.source_instance_id = source.id
                 and run.state in ('queued', 'running')
             ) as "activeRunCount"
      from public.provider_sources provider
      join public.provider_source_instances source
        on source.organization_id = provider.organization_id
       and source.provider_id = provider.id
      join public.provider_source_revisions source_revision
        on source_revision.organization_id = source.organization_id
       and source_revision.provider_id = source.provider_id
       and source_revision.source_instance_id = source.id
       and source_revision.id = source.active_revision_id
      join public.source_connection_profiles profile
        on profile.organization_id = source.organization_id
       and profile.id = source.connection_profile_id
      join public.source_connection_revisions connection_revision
        on connection_revision.organization_id = profile.organization_id
       and connection_revision.connection_profile_id = profile.id
       and connection_revision.id = profile.active_revision_id
      where provider.organization_id = ${organizationId}::uuid
        and provider.platform_key = 'clutchpacks'
        and provider.state = 'active'
        and source.state in ('active', 'paused')
    `);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

async function latestConnectionTest(
  database: PackscoutPrismaClient,
  organizationId: string,
  profileId: string,
  revisionId: string,
  healthGeneration: bigint,
): Promise<CanaryTestEvidence | null> {
  const job = await database.source_connection_test_jobs.findFirst({
    where: {
      organization_id: organizationId,
      connection_profile_id: profileId,
      connection_revision_id: revisionId,
      expected_health_generation: healthGeneration,
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    select: { id: true, state: true },
  });
  if (!job) return null;
  const result = await database.source_connection_test_results.findUnique({
    where: { job_id: job.id },
    select: {
      outcome: true,
      request_terminal_state: true,
      resulting_health_generation: true,
    },
  });
  return Object.freeze({
    state: job.state,
    hasSuccessfulResult:
      result?.outcome === "success" &&
      result.request_terminal_state === "captured" &&
      result.resulting_health_generation === healthGeneration,
  });
}

async function latestSourceTest(
  database: PackscoutPrismaClient,
  organizationId: string,
  sourceInstanceId: string,
  sourceRevisionId: string,
  connectionRevisionId: string,
  healthGeneration: bigint,
): Promise<CanaryTestEvidence | null> {
  const job = await database.provider_source_test_jobs.findFirst({
    where: {
      organization_id: organizationId,
      source_instance_id: sourceInstanceId,
      source_revision_id: sourceRevisionId,
      connection_revision_id: connectionRevisionId,
      expected_health_generation: healthGeneration,
    },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    select: { id: true, state: true },
  });
  if (!job) return null;
  const result = await database.provider_source_test_results.findUnique({
    where: { job_id: job.id },
    select: {
      outcome: true,
      request_terminal_state: true,
      resulting_health_generation: true,
    },
  });
  return Object.freeze({
    state: job.state,
    hasSuccessfulResult:
      result?.outcome === "success" &&
      result.request_terminal_state === "captured" &&
      result.resulting_health_generation === healthGeneration,
  });
}

async function readTargetEvidence(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
): Promise<Readonly<{
  snapshot: ClutchpacksV3CanaryTargetEvidence;
  supervisor: ClutchpacksV3CanarySupervisorEvidence;
}>> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`set transaction read only`);
    const [
      organizationCount,
      organization,
      providers,
      profiles,
      connectionRevisions,
      sources,
      sourceRevisions,
      cursors,
      importRunCount,
      importPageCount,
      pageReadAttemptCount,
      sourceRecordIdentityCount,
      semanticObservationCount,
      deliveryOccurrenceCount,
      canonicalEntityCount,
      quarantineRecordCount,
      warningErrorCriticalDiagnosticRows,
      unresolvedCurrentCursorGenerationDiagnosticRows,
      legacyProviderConfigRevisionCount,
      legacyProviderSecretVersionCount,
      legacyProviderCursorCheckpointCount,
      queuedOrRunningRunCount,
      currentCursorGenerationImportRunRows,
      latestRun,
      liveEpochs,
    ] = await Promise.all([
      transaction.organizations.count(),
      transaction.organizations.findUnique({
        where: { id: environment.targetOrganizationId },
        select: { id: true, slug: true, name: true },
      }),
      transaction.provider_sources.findMany({
        select: {
          id: true,
          organization_id: true,
          platform_key: true,
          state: true,
          active_revision_id: true,
          next_run_at: true,
        },
      }),
      transaction.source_connection_profiles.findMany({
        select: {
          id: true,
          organization_id: true,
          source_type_key: true,
          state: true,
          request_limit: true,
          active_revision_id: true,
        },
      }),
      transaction.source_connection_revisions.findMany({
        select: {
          id: true,
          organization_id: true,
          connection_profile_id: true,
          source_type_key: true,
          source_adapter_version: true,
          state: true,
          health_generation: true,
        },
      }),
      transaction.provider_source_instances.findMany({
        select: {
          id: true,
          organization_id: true,
          provider_id: true,
          connection_profile_id: true,
          source_type_key: true,
          state: true,
          pause_requested_at: true,
          active_revision_id: true,
        },
      }),
      transaction.provider_source_revisions.findMany({
        select: {
          id: true,
          organization_id: true,
          provider_id: true,
          source_instance_id: true,
          connection_profile_id: true,
          source_type_key: true,
          source_adapter_version: true,
          normalized_contract_version: true,
          mapper_key: true,
          mapper_version: true,
          identity_namespace_key: true,
          cursor_codec_version: true,
          configuration_json: true,
        },
      }),
      transaction.provider_source_cursors.findMany({
        select: {
          source_instance_id: true,
          source_revision_id: true,
          cursor_generation: true,
          source_adapter_version: true,
          cursor_fingerprint: true,
          advanced_by_run_id: true,
          advanced_by_page_id: true,
        },
      }),
      transaction.import_runs.count(),
      transaction.import_pages.count(),
      transaction.source_request_attempts.count({
        where: { operation_kind: "page_read" },
      }),
      transaction.source_record_identities.count(),
      transaction.source_semantic_observations.count(),
      transaction.source_delivery_occurrences.count(),
      transaction.canonical_entities.count(),
      transaction.quarantine_records.count(),
      transaction.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        select count(*)::integer as "count"
        from public.source_processor_diagnostic_events
        where severity::text <> 'info'
      `),
      transaction.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        with current_cursor as (
          select cursor.organization_id,
                 cursor.provider_id,
                 cursor.source_instance_id,
                 cursor.source_revision_id,
                 cursor.cursor_generation,
                 cursor.updated_at as cursor_updated_at
          from public.provider_source_cursors cursor
          where cursor.organization_id =
            ${environment.targetOrganizationId}::uuid
        ), current_runs as (
          select run.id, run.created_at, run.finished_at, run.state,
                 run.reached_provider_head, run.failure_code
          from public.import_runs run
          join current_cursor cursor
            on cursor.organization_id = run.organization_id
           and cursor.provider_id = run.provider_id
           and cursor.source_instance_id = run.source_instance_id
           and cursor.source_revision_id = run.source_revision_id
           and cursor.cursor_generation = run.cursor_generation
        ), generation_bounds as (
          select coalesce(
                   min(run.created_at),
                   max(cursor.cursor_updated_at)
                 ) as started_at
          from current_cursor cursor
          left join current_runs run on true
        ), latest_succeeded_head as (
          select max(run.finished_at) as finished_at
          from current_runs run
          where run.state = 'succeeded'::public.import_run_state
            and run.reached_provider_head
            and run.finished_at is not null
            and run.failure_code is null
        )
        select count(diagnostic.id)::integer as "count"
        from current_cursor cursor
        cross join generation_bounds generation
        cross join latest_succeeded_head succeeded
        join public.source_processor_diagnostic_events diagnostic
          on diagnostic.organization_id = cursor.organization_id
         and diagnostic.provider_id = cursor.provider_id
         and diagnostic.source_instance_id = cursor.source_instance_id
         and diagnostic.source_revision_id = cursor.source_revision_id
         and diagnostic.occurred_at >= generation.started_at
        where diagnostic.severity::text <> 'info'
          and (
            diagnostic.run_id is null
            or diagnostic.run_id in (select id from current_runs)
          )
          and (
            succeeded.finished_at is null
            or diagnostic.occurred_at > succeeded.finished_at
          )
      `),
      transaction.provider_config_revisions.count(),
      transaction.provider_secret_versions.count(),
      transaction.provider_cursor_checkpoints.count(),
      transaction.import_runs.count({
        where: {
          organization_id: environment.targetOrganizationId,
          state: { in: ["queued", "running"] },
        },
      }),
      transaction.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        select count(run.id)::integer as "count"
        from public.provider_source_cursors cursor
        left join public.import_runs run
          on run.organization_id = cursor.organization_id
         and run.provider_id = cursor.provider_id
         and run.source_instance_id = cursor.source_instance_id
         and run.source_revision_id = cursor.source_revision_id
         and run.cursor_generation = cursor.cursor_generation
        where cursor.organization_id =
          ${environment.targetOrganizationId}::uuid
      `),
      transaction.import_runs.findFirst({
        where: { organization_id: environment.targetOrganizationId },
        orderBy: [{ created_at: "desc" }, { id: "desc" }],
        select: {
          id: true,
          organization_id: true,
          provider_id: true,
          source_instance_id: true,
          source_revision_id: true,
          source_type_key: true,
          source_adapter_version: true,
          normalized_contract_version: true,
          mapper_key: true,
          mapper_version: true,
          identity_namespace_key: true,
          connection_profile_id: true,
          connection_revision_id: true,
          cursor_codec_version: true,
          cursor_generation: true,
          config_revision_id: true,
          state: true,
          reached_provider_head: true,
          finished_at: true,
          failure_code: true,
        },
      }),
      transaction.$queryRaw<Array<{
        epochState: string;
        maximumExecutionSlots: number;
        capacityState: string;
        snapshotUpdatedAt: Date | null;
      }>>(Prisma.sql`
        select state::text as "epochState",
               maximum_execution_slots as "maximumExecutionSlots",
               capacity_state as "capacityState",
               snapshot_updated_at as "snapshotUpdatedAt"
        from public.source_supervisor_epochs
        where state in ('active', 'fenced_draining')
          and lease_expires_at > clock_timestamp()
        order by epoch_number desc
      `),
    ]);
    const source = sources[0];
    const sourceRevision = sourceRevisions[0];
    const connectionRevision = connectionRevisions[0];
    const warningErrorCriticalDiagnosticCount =
      warningErrorCriticalDiagnosticRows[0]?.count;
    const unresolvedCurrentCursorGenerationDiagnosticCount =
      unresolvedCurrentCursorGenerationDiagnosticRows[0]?.count;
    const currentCursorGenerationImportRunCount =
      currentCursorGenerationImportRunRows[0]?.count;
    if (
      warningErrorCriticalDiagnosticCount === undefined ||
      !Number.isSafeInteger(warningErrorCriticalDiagnosticCount) ||
      warningErrorCriticalDiagnosticCount < 0
    ) refuse("TARGET_DIAGNOSTIC_EVIDENCE_INVALID");
    if (
      unresolvedCurrentCursorGenerationDiagnosticCount === undefined ||
      !Number.isSafeInteger(
        unresolvedCurrentCursorGenerationDiagnosticCount,
      ) ||
      unresolvedCurrentCursorGenerationDiagnosticCount < 0
    ) refuse("TARGET_CURRENT_GENERATION_DIAGNOSTIC_EVIDENCE_INVALID");
    if (
      currentCursorGenerationImportRunCount === undefined ||
      !Number.isSafeInteger(currentCursorGenerationImportRunCount) ||
      currentCursorGenerationImportRunCount < 0
    ) refuse("TARGET_CURSOR_GENERATION_EVIDENCE_INVALID");
    const [connectionTest, sourceTest] = await Promise.all([
      latestConnectionTest(
        transaction as unknown as PackscoutPrismaClient,
        environment.targetOrganizationId,
        environment.profileId,
        environment.connectionRevisionId,
        connectionRevision?.health_generation ?? -1n,
      ),
      source && sourceRevision && connectionRevision
        ? latestSourceTest(
            transaction as unknown as PackscoutPrismaClient,
            environment.targetOrganizationId,
            source.id,
            sourceRevision.id,
            connectionRevision.id,
            connectionRevision.health_generation,
          )
        : Promise.resolve(null),
    ]);
    const epoch = liveEpochs[0];
    return Object.freeze({
      snapshot: Object.freeze({
        organizationCount,
        organization,
        providers: providers.map((provider) => Object.freeze({
          id: provider.id,
          organizationId: provider.organization_id,
          platformKey: provider.platform_key,
          state: provider.state,
          activeRevisionId: provider.active_revision_id,
          nextRunAt: provider.next_run_at,
        })),
        profiles: profiles.map((profile) => Object.freeze({
          id: profile.id,
          organizationId: profile.organization_id,
          sourceTypeKey: profile.source_type_key,
          state: profile.state,
          requestLimit: profile.request_limit,
          activeRevisionId: profile.active_revision_id,
        })),
        connectionRevisions: connectionRevisions.map((revision) =>
          Object.freeze({
            id: revision.id,
            organizationId: revision.organization_id,
            profileId: revision.connection_profile_id,
            sourceTypeKey: revision.source_type_key,
            adapterVersion: revision.source_adapter_version,
            state: revision.state,
            healthGeneration: revision.health_generation,
          })
        ),
        sources: sources.map((candidate) => Object.freeze({
          id: candidate.id,
          organizationId: candidate.organization_id,
          providerId: candidate.provider_id,
          profileId: candidate.connection_profile_id,
          sourceTypeKey: candidate.source_type_key,
          state: candidate.state,
          pauseRequested: candidate.pause_requested_at !== null,
          activeRevisionId: candidate.active_revision_id,
        })),
        sourceRevisions: sourceRevisions.map((revision) => Object.freeze({
          id: revision.id,
          organizationId: revision.organization_id,
          providerId: revision.provider_id,
          sourceInstanceId: revision.source_instance_id,
          profileId: revision.connection_profile_id,
          sourceTypeKey: revision.source_type_key,
          adapterVersion: revision.source_adapter_version,
          normalizedContractVersion: revision.normalized_contract_version,
          mapperKey: revision.mapper_key,
          mapperVersion: revision.mapper_version,
          identityNamespaceKey: revision.identity_namespace_key,
          cursorCodecVersion: revision.cursor_codec_version,
          configuration: revision.configuration_json,
        })),
        cursors: cursors.map((cursor) => Object.freeze({
          sourceInstanceId: cursor.source_instance_id,
          sourceRevisionId: cursor.source_revision_id,
          generation: cursor.cursor_generation,
          adapterVersion: cursor.source_adapter_version,
          fingerprint: cursor.cursor_fingerprint,
          advancedByRunId: cursor.advanced_by_run_id,
          advancedByPageId: cursor.advanced_by_page_id,
        })),
        importRunCount,
        importPageCount,
        pageReadAttemptCount,
        sourceRecordIdentityCount,
        semanticObservationCount,
        deliveryOccurrenceCount,
        canonicalEntityCount,
        quarantineRecordCount,
        warningErrorCriticalDiagnosticCount,
        unresolvedCurrentCursorGenerationDiagnosticCount,
        legacyProviderConfigRevisionCount,
        legacyProviderSecretVersionCount,
        legacyProviderCursorCheckpointCount,
        queuedOrRunningRunCount,
        currentCursorGenerationImportRunCount,
        latestRun: latestRun
          ? Object.freeze({
              id: latestRun.id,
              organizationId: latestRun.organization_id,
              providerId: latestRun.provider_id,
              sourceInstanceId: latestRun.source_instance_id,
              sourceRevisionId: latestRun.source_revision_id,
              sourceTypeKey: latestRun.source_type_key,
              adapterVersion: latestRun.source_adapter_version,
              normalizedContractVersion:
                latestRun.normalized_contract_version,
              mapperKey: latestRun.mapper_key,
              mapperVersion: latestRun.mapper_version,
              identityNamespaceKey: latestRun.identity_namespace_key,
              connectionProfileId: latestRun.connection_profile_id,
              connectionRevisionId: latestRun.connection_revision_id,
              cursorCodecVersion: latestRun.cursor_codec_version,
              cursorGeneration: latestRun.cursor_generation,
              configRevisionId: latestRun.config_revision_id,
              state: latestRun.state,
              reachedProviderHead: latestRun.reached_provider_head,
              finishedAt: latestRun.finished_at,
              failureCode: latestRun.failure_code,
            })
          : null,
        connectionTest,
        sourceTest,
      }),
      supervisor: Object.freeze({
        liveEpochCount: liveEpochs.length,
        epochState: epoch?.epochState ?? null,
        maximumExecutionSlots: epoch?.maximumExecutionSlots ?? null,
        capacityState: epoch?.capacityState ?? null,
        snapshotPublished: epoch?.snapshotUpdatedAt !== null &&
          epoch?.snapshotUpdatedAt !== undefined,
      }),
    });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

function sourceServices(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
) {
  const adapters = createProductionSourceAdapterRegistry();
  const codecs = createProductionSourceAdminConfigurationCodecRegistry(adapters);
  const connections = new SourceConnectionConfigurationService({
    repository: new SourceConnectionAdminRepository(database),
    cipher: new AesGcmSourceConnectionConfigurationCipher({
      primaryVersion: environment.connectionKeyVersion,
      keys: new Map([[
        environment.connectionKeyVersion,
        environment.connectionKey,
      ]]),
    }),
    sourceAdapters: adapters,
    adminConfigurationCodecs: codecs,
  });
  const mapperDescriptors = new SourceMapperDescriptorRegistry(
    launchSourceMapperDescriptors,
  );
  const activation = new ProviderSourceActivationService({
    repository: new ProviderSourceLifecycleRepository(database),
    connectionConfigurations: connections,
    sourceAdapters: adapters,
    mapperDescriptors,
  });
  return Object.freeze({
    connections,
    lifecycle: new ProviderSourceLifecycleService({
      repository: new ProviderSourceAdminLifecycleRepository(database),
      activation,
      sourceAdapters: adapters,
      mapperDescriptors,
      adminConfigurationCodecs: codecs,
    }),
  });
}

function publicStatus(
  mode: "status" | "plan",
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
  original: OriginalClutchpacksV1Evidence,
  target: ClutchpacksV3CanaryTargetEvidence,
  supervisor: ClutchpacksV3CanarySupervisorEvidence,
) {
  const stage = determineClutchpacksV3CanaryQualificationStage(target);
  const targetWideSafety = clutchpacksV3CanaryTargetWideSafetyEvidence(target);
  const source = target.sources[0]!;
  let originalReady = true;
  try {
    assertOriginalClutchpacksV1PausedAndDrained(original);
  } catch {
    originalReady = false;
  }
  let supervisorReady = true;
  try {
    assertClutchpacksV3CanaryOneSlotSupervisor(supervisor);
  } catch {
    supervisorReady = false;
  }
  return Object.freeze({
    ok: true as const,
    operation: WORKFLOW,
    mode,
    sourceDatabase: environment.sourceDatabaseName,
    targetDatabase: environment.targetDatabaseName,
    targetDigest: environment.targetDigest,
    confirmations: clutchpacksV3CanaryDriverConfirmations(
      environment.targetDigest,
    ),
    original: Object.freeze({
      state: original.sourceState,
      pauseRequested: original.pauseRequested,
      queuedOrRunningRuns: original.activeRunCount,
      ready: originalReady,
    }),
    target: Object.freeze({
      stage,
      profileState: target.profiles[0]!.state,
      sourceState: source.state,
      requestLimit: target.profiles[0]!.requestLimit,
      cursorGeneration: target.cursors[0]!.generation.toString(),
      cursorAtFeedStart: target.cursors[0]!.fingerprint === null,
      currentCursorGenerationImportRuns:
        target.currentCursorGenerationImportRunCount,
      lineageRows: clutchpacksV3CanaryLineageCount(target),
      latestRunState: target.latestRun?.state ?? null,
      latestRunReachedProviderHead:
        target.latestRun?.reachedProviderHead ?? false,
      latestRunExactSucceededHead:
        clutchpacksV3CanaryHasExactSucceededHeadRun(target),
      queuedOrRunningRuns: target.queuedOrRunningRunCount,
      ...targetWideSafety,
    }),
    supervisor: Object.freeze({
      ready: supervisorReady,
      liveEpochCount: supervisor.liveEpochCount,
      epochState: supervisor.epochState,
      executionSlots: supervisor.maximumExecutionSlots,
      capacityState: supervisor.capacityState,
    }),
    providerCallMadeDirectly: false,
  });
}

async function pauseOriginal(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
  original: OriginalClutchpacksV1Evidence,
) {
  const services = sourceServices(database, environment);
  const alreadyPaused = original.sourceState === "paused" &&
    !original.pauseRequested;
  try {
    await services.lifecycle.pause(
      { organizationId: environment.sourceOrganizationId, actorKey: ACTOR_KEY },
      original.providerId,
      original.sourceInstanceId,
      { expectedSourceRevisionId: original.sourceRevisionId },
    );
  } catch {
    refuse("ORIGINAL_CLUTCHPACKS_PAUSE_FAILED");
  }
  const after = assertOriginalClutchpacksV1IsExact(
    await readOriginalEvidence(database, environment.sourceOrganizationId),
  );
  const draining = after.sourceState !== "paused" ||
    after.pauseRequested ||
    after.activeRunCount !== 0;
  return Object.freeze({
    ok: true as const,
    operation: WORKFLOW,
    mode: "pause_original" as const,
    outcome: draining
      ? "draining"
      : alreadyPaused
      ? "already_paused"
      : "paused",
    sourceDatabase: environment.sourceDatabaseName,
    targetDatabase: environment.targetDatabaseName,
    targetDigest: environment.targetDigest,
    original: Object.freeze({
      state: after.sourceState,
      pauseRequested: after.pauseRequested,
      queuedOrRunningRuns: after.activeRunCount,
      ready: !draining,
    }),
    siblingSourcesChanged: false,
    providerCallMadeDirectly: false,
  });
}

export interface ClutchpacksV3CanaryTargetPauseDependencies {
  readonly pauseSource: (input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
  }>) => Promise<void>;
  readonly readTarget: () => Promise<Readonly<{
    snapshot: ClutchpacksV3CanaryTargetEvidence;
    supervisor: ClutchpacksV3CanarySupervisorEvidence;
  }>>;
}

export async function pauseClutchpacksV3CanaryTarget(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
  before: ClutchpacksV3CanaryTargetEvidence,
  supervisorBefore: ClutchpacksV3CanarySupervisorEvidence,
  providedDependencies?: ClutchpacksV3CanaryTargetPauseDependencies,
): Promise<Readonly<Record<string, unknown>>> {
  assertClutchpacksV3CanaryTargetCanPause(before);
  assertClutchpacksV3CanarySupervisorStopped(supervisorBefore);
  const provider = before.providers[0]!;
  const source = before.sources[0]!;
  const sourceRevision = before.sourceRevisions[0]!;
  if (
    !["active", "paused"].includes(source.state) ||
    source.pauseRequested
  ) refuse("TARGET_PAUSE_STATE_INVALID");
  const alreadyPaused = source.state === "paused";
  const dependencies = providedDependencies ?? Object.freeze({
    pauseSource: async (input: Readonly<{
      organizationId: string;
      providerId: string;
      sourceInstanceId: string;
      sourceRevisionId: string;
    }>) => {
      await sourceServices(database, environment).lifecycle.pause(
        { organizationId: input.organizationId, actorKey: ACTOR_KEY },
        input.providerId,
        input.sourceInstanceId,
        { expectedSourceRevisionId: input.sourceRevisionId },
      );
    },
    readTarget: () => readTargetEvidence(database, environment),
  });
  try {
    await dependencies.pauseSource({
      organizationId: environment.targetOrganizationId,
      providerId: provider.id,
      sourceInstanceId: source.id,
      sourceRevisionId: sourceRevision.id,
    });
  } catch {
    refuse("TARGET_PAUSE_FAILED");
  }
  const after = await dependencies.readTarget().catch(() =>
    refuse("TARGET_PAUSE_EVIDENCE_READ_FAILED")
  );
  assertClutchpacksV3CanaryTargetIsExact(after.snapshot, environment);
  assertClutchpacksV3CanaryTargetCanPause(after.snapshot);
  assertClutchpacksV3CanarySupervisorStopped(after.supervisor);
  const pausedSource = after.snapshot.sources[0];
  if (
    pausedSource?.state !== "paused" ||
    pausedSource.pauseRequested ||
    after.snapshot.queuedOrRunningRunCount !== 0
  ) refuse("TARGET_PAUSE_PROOF_FAILED");
  const targetWideSafety = clutchpacksV3CanaryTargetWideSafetyEvidence(
    after.snapshot,
  );
  return Object.freeze({
    ok: true,
    operation: WORKFLOW,
    mode: "pause_target",
    outcome: alreadyPaused ? "already_paused" : "paused",
    sourceDatabase: environment.sourceDatabaseName,
    targetDatabase: environment.targetDatabaseName,
    targetDigest: environment.targetDigest,
    target: Object.freeze({
      state: pausedSource.state,
      queuedOrRunningRuns: after.snapshot.queuedOrRunningRunCount,
      latestRunState: after.snapshot.latestRun?.state ?? null,
      latestRunReachedProviderHead:
        after.snapshot.latestRun?.reachedProviderHead ?? false,
      latestRunExactSucceededHead:
        clutchpacksV3CanaryHasExactSucceededHeadRun(after.snapshot),
      ...targetWideSafety,
    }),
    supervisorLiveEpochCount: after.supervisor.liveEpochCount,
    providerCallMadeDirectly: false,
  });
}

interface ClutchpacksV3CanaryCursorResetPreview {
  readonly providerId: string;
  readonly provider: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceState: string;
  readonly cursorGeneration: string;
  readonly cursorFingerprint: string | null;
  readonly confirmation: string;
}

export interface ClutchpacksV3CanaryTargetCursorResetDependencies {
  readonly previewCursorReset: (input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
  }>) => Promise<ClutchpacksV3CanaryCursorResetPreview>;
  readonly resetCursor: (input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    expectedCursorGeneration: string;
    expectedCursorFingerprint: string | null;
    confirmation: string;
  }>) => Promise<Readonly<{
    cursorGeneration: string;
    cursorFingerprint: null;
  }>>;
  readonly readTarget: () => Promise<Readonly<{
    snapshot: ClutchpacksV3CanaryTargetEvidence;
    supervisor: ClutchpacksV3CanarySupervisorEvidence;
  }>>;
}

export async function resetClutchpacksV3CanaryTargetCursor(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
  before: ClutchpacksV3CanaryTargetEvidence,
  supervisorBefore: ClutchpacksV3CanarySupervisorEvidence,
  providedDependencies?: ClutchpacksV3CanaryTargetCursorResetDependencies,
): Promise<Readonly<Record<string, unknown>>> {
  assertClutchpacksV3CanaryTargetCanPause(before);
  assertClutchpacksV3CanarySupervisorStopped(supervisorBefore);
  const provider = before.providers[0]!;
  const source = before.sources[0]!;
  const sourceRevision = before.sourceRevisions[0]!;
  const cursor = before.cursors[0]!;
  if (source.state !== "paused" || source.pauseRequested) {
    refuse("TARGET_CURSOR_RESET_REQUIRES_PAUSED_SOURCE");
  }
  const dependencies = providedDependencies ?? (() => {
    const lifecycle = sourceServices(database, environment).lifecycle;
    return Object.freeze({
      previewCursorReset: async (input: Readonly<{
        organizationId: string;
        providerId: string;
        sourceInstanceId: string;
        sourceRevisionId: string;
      }>) => lifecycle.previewCursorReset(
        { organizationId: input.organizationId, actorKey: ACTOR_KEY },
        input.providerId,
        input.sourceInstanceId,
        { expectedSourceRevisionId: input.sourceRevisionId },
      ),
      resetCursor: async (input: Readonly<{
        organizationId: string;
        providerId: string;
        sourceInstanceId: string;
        sourceRevisionId: string;
        expectedCursorGeneration: string;
        expectedCursorFingerprint: string | null;
        confirmation: string;
      }>) => lifecycle.resetCursor(
        { organizationId: input.organizationId, actorKey: ACTOR_KEY },
        input.providerId,
        input.sourceInstanceId,
        {
          expectedSourceRevisionId: input.sourceRevisionId,
          expectedCursorGeneration: input.expectedCursorGeneration,
          expectedCursorFingerprint: input.expectedCursorFingerprint,
          confirmation: input.confirmation,
        },
      ),
      readTarget: () => readTargetEvidence(database, environment),
    });
  })();
  const resetPins = Object.freeze({
    organizationId: environment.targetOrganizationId,
    providerId: provider.id,
    sourceInstanceId: source.id,
    sourceRevisionId: sourceRevision.id,
  });
  const preview = await dependencies.previewCursorReset(resetPins).catch(() =>
    refuse("TARGET_CURSOR_RESET_PREVIEW_FAILED")
  );
  if (
    preview.providerId !== provider.id ||
    preview.provider !== "clutchpacks" ||
    preview.sourceInstanceId !== source.id ||
    preview.sourceRevisionId !== sourceRevision.id ||
    preview.sourceState !== "paused" ||
    preview.cursorGeneration !== cursor.generation.toString() ||
    preview.cursorFingerprint !== cursor.fingerprint ||
    preview.confirmation !== SERVICE_CURSOR_RESET_CONFIRMATION
  ) refuse("TARGET_CURSOR_RESET_PREVIEW_CHANGED");
  const expectedNextGeneration = cursor.generation + 1n;
  const reset = await dependencies.resetCursor({
    ...resetPins,
    expectedCursorGeneration: preview.cursorGeneration,
    expectedCursorFingerprint: preview.cursorFingerprint,
    confirmation: preview.confirmation,
  }).catch(() => refuse("TARGET_CURSOR_RESET_FAILED"));
  if (
    reset.cursorGeneration !== expectedNextGeneration.toString() ||
    reset.cursorFingerprint !== null
  ) refuse("TARGET_CURSOR_RESET_RECEIPT_INVALID");
  const after = await dependencies.readTarget().catch(() =>
    refuse("TARGET_CURSOR_RESET_EVIDENCE_READ_FAILED")
  );
  assertClutchpacksV3CanaryTargetIsExact(after.snapshot, environment);
  assertClutchpacksV3CanarySupervisorStopped(after.supervisor);
  assertClutchpacksV3CanaryResetGenerationAtFeedStart(after.snapshot);
  const afterSource = after.snapshot.sources[0];
  const afterCursor = after.snapshot.cursors[0];
  if (
    afterSource?.state !== "paused" ||
    afterSource.pauseRequested ||
    afterCursor?.generation !== expectedNextGeneration ||
    clutchpacksV3CanaryLineageCount(after.snapshot) !==
      clutchpacksV3CanaryLineageCount(before)
  ) refuse("TARGET_CURSOR_RESET_PROOF_FAILED");
  return Object.freeze({
    ok: true,
    operation: WORKFLOW,
    mode: "reset_target_cursor",
    outcome: "cursor_reset",
    sourceDatabase: environment.sourceDatabaseName,
    targetDatabase: environment.targetDatabaseName,
    targetDigest: environment.targetDigest,
    target: Object.freeze({
      state: afterSource.state,
      previousCursorGeneration: cursor.generation.toString(),
      cursorGeneration: afterCursor.generation.toString(),
      cursorAtFeedStart: true,
      currentCursorGenerationImportRuns:
        after.snapshot.currentCursorGenerationImportRunCount,
      queuedOrRunningRuns: after.snapshot.queuedOrRunningRunCount,
      quarantineRecords: after.snapshot.quarantineRecordCount,
      warningErrorCriticalDiagnostics:
        after.snapshot.warningErrorCriticalDiagnosticCount,
      unresolvedCurrentCursorGenerationDiagnostics:
        after.snapshot.unresolvedCurrentCursorGenerationDiagnosticCount,
    }),
    supervisorLiveEpochCount: after.supervisor.liveEpochCount,
    providerCallMadeDirectly: false,
  });
}

async function advanceOneStep(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
  before: ClutchpacksV3CanaryTargetEvidence,
) {
  const stage = determineClutchpacksV3CanaryQualificationStage(before);
  if (stage === "connection_test_failed") {
    refuse("TARGET_CONNECTION_TEST_FAILED");
  }
  if (stage === "source_test_failed") refuse("TARGET_SOURCE_TEST_FAILED");
  if (
    stage === "wait_connection_test" ||
    stage === "wait_source_test" ||
    stage === "ready_to_resume" ||
    stage === "replay_active" ||
    stage === "replay_paused"
  ) {
    return Object.freeze({ outcome: "no_change" as const, previousStage: stage });
  }
  const profile = before.profiles[0]!;
  const connectionRevision = before.connectionRevisions[0]!;
  const provider = before.providers[0]!;
  const source = before.sources[0]!;
  const sourceRevision = before.sourceRevisions[0]!;
  const services = sourceServices(database, environment);
  const context = {
    organizationId: environment.targetOrganizationId,
    actorKey: ACTOR_KEY,
  };
  try {
    switch (stage) {
      case "queue_connection_test":
        await services.connections.requestTest(context, profile.id, {
          expectedRevisionId: connectionRevision.id,
        });
        break;
      case "activate_connection":
        await services.connections.activateRevision(context, profile.id, {
          expectedRevisionId: connectionRevision.id,
        });
        break;
      case "queue_source_test":
        await services.lifecycle.requestTest(
          context,
          provider.id,
          source.id,
          {
            expectedSourceRevisionId: sourceRevision.id,
            expectedConnectionRevisionId: connectionRevision.id,
          },
        );
        break;
      case "activate_source_paused":
        await services.lifecycle.activatePaused(
          context,
          provider.id,
          source.id,
          {
            expectedSourceRevisionId: sourceRevision.id,
            expectedConnectionRevisionId: connectionRevision.id,
          },
        );
        break;
    }
  } catch {
    refuse("TARGET_QUALIFICATION_STEP_FAILED");
  }
  return Object.freeze({ outcome: "advanced" as const, previousStage: stage });
}

export function clutchpacksV3CanaryResumeMode(
  before: ClutchpacksV3CanaryTargetEvidence,
): "initial" | "reset" | "refresh" | "already_active" {
  const stage = determineClutchpacksV3CanaryQualificationStage(before);
  if (stage === "replay_active") return "already_active";
  if (stage === "ready_to_resume") {
    const cursor = before.cursors[0];
    if (cursor?.generation === 1n) {
      assertClutchpacksV3CanaryTargetIsPristine(before);
      return "initial";
    }
    assertClutchpacksV3CanaryResetGenerationAtFeedStart(before);
    return "reset";
  } else if (stage === "replay_paused") {
    // A completed one-shot canary may be resumed for a new provider-head
    // refresh only from its exact, clean, drained succeeded-head proof. This
    // preserves the original pristine first-run gate while avoiding a bulk
    // reimport merely to refresh source-native evidence.
    assertClutchpacksV3CanaryTargetCanPause(before);
    return "refresh";
  } else {
    refuse("TARGET_NOT_READY_TO_RESUME");
  }
}

async function resumeCanary(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
  before: ClutchpacksV3CanaryTargetEvidence,
): Promise<
  "resumed" | "reset_replay_started" | "refreshed" | "already_resumed"
> {
  const mode = clutchpacksV3CanaryResumeMode(before);
  if (mode === "already_active") return "already_resumed";
  const provider = before.providers[0]!;
  const source = before.sources[0]!;
  const sourceRevision = before.sourceRevisions[0]!;
  try {
    await sourceServices(database, environment).lifecycle.resume(
      { organizationId: environment.targetOrganizationId, actorKey: ACTOR_KEY },
      provider.id,
      source.id,
      { expectedSourceRevisionId: sourceRevision.id },
    );
  } catch {
    refuse("TARGET_RESUME_FAILED");
  }
  return mode === "refresh"
    ? "refreshed"
    : mode === "reset"
    ? "reset_replay_started"
    : "resumed";
}

export function safeClutchpacksV3CanaryDriverFailure(error: unknown) {
  return Object.freeze({
    ok: false as const,
    operation: WORKFLOW,
    code: error instanceof ClutchpacksV3CanaryDriverError
      ? error.code
      : "UNEXPECTED_CANARY_DRIVER_FAILURE",
  });
}

export function clutchpacksV3CanaryDriverUsage(): string {
  return `Usage:
  npm run advance:clutchpacks-v3-canary:local -- --status
  npm run advance:clutchpacks-v3-canary:local -- --plan

  npm run advance:clutchpacks-v3-canary:local -- \\
    --pause-original --confirmation "${PAUSE_CONFIRMATION_PREFIX} <digest>"

  npm run advance:clutchpacks-v3-canary:local -- \\
    --advance --expected-stage <targetStage> \\
    --confirmation "${ADVANCE_CONFIRMATION_PREFIX} <digest>"

  npm run advance:clutchpacks-v3-canary:local -- \\
    --resume --confirmation "${RESUME_CONFIRMATION_PREFIX} <digest>"

  npm run advance:clutchpacks-v3-canary:local -- \\
    --pause-target \\
    --confirmation "${PAUSE_TARGET_CONFIRMATION_PREFIX} <digest>"

  npm run advance:clutchpacks-v3-canary:local -- \\
    --reset-target-cursor \\
    --confirmation "${RESET_TARGET_CURSOR_CONFIRMATION_PREFIX} <digest>"

This driver requires the protected local bootstrap environment. It never starts
a worker and never calls DataForrest directly. Start the target-only supervisor
separately with PACKSCOUT_SOURCE_EXECUTION_SLOTS=1. The target profile retains
the governed requestLimit of 2, while the one execution slot keeps the canary at
one provider request at a time. Every action first proves the exact 91-table
current-composite migration set. Status and plan are read-only. Each --advance
invocation performs at most one transition and queues tests for that supervisor.
The required expected stage fences a retry after a transition already committed.
Every advance and resume fails closed until the original adapter-v1 ClutchPacks
source is paused and has no queued or running import runs. Stop the target
supervisor after a succeeded provider-head run and before --pause-target; that
command requires no live target supervisor and zero target-wide quarantine,
and proves the canary paused and drained after the service transition.
Historical processor diagnostics remain visible but do not defeat a terminal
succeeded-head proof. --reset-target-cursor additionally requires the target
already paused and drained with the supervisor stopped, then binds the service
preview's source revision, cursor generation, fingerprint, and typed ClutchPacks
confirmation before it clears the cursor into the next generation at Feed
start.`;
}

async function connectedIdentity(
  database: PackscoutPrismaClient,
): Promise<Readonly<{ databaseName: string; serverAddress: string | null }>> {
  const rows = await database.$queryRaw<Array<{
    databaseName: string;
    serverAddress: string | null;
  }>>`
    select current_database() as "databaseName",
           inet_server_addr()::text as "serverAddress"
  `;
  const row = rows[0];
  if (!row) refuse("CONNECTED_DATABASE_IDENTITY_NOT_LOCAL");
  return row;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`${clutchpacksV3CanaryDriverUsage()}\n`);
    return;
  }
  const environment = readClutchpacksV3CanaryBootstrapEnvironment(process.env);
  let sourceDatabase: PrismaClient | null = null;
  let targetDatabase: ReturnType<typeof createPrismaClientLifecycle> | null =
    null;
  try {
    const command = parseClutchpacksV3CanaryDriverCommand(
      argv,
      clutchpacksV3CanaryDriverConfirmations(environment.targetDigest),
    );
    sourceDatabase = new PrismaClient({
      datasources: { db: { url: environment.sourceDatabaseUrl } },
    });
    targetDatabase = createPrismaClientLifecycle({
      databaseUrl: environment.targetDatabaseUrl,
    });
    const [sourceStart, targetStart] = await Promise.allSettled([
      sourceDatabase.$connect(),
      targetDatabase.start(),
    ]);
    if (sourceStart.status === "rejected") {
      refuse("ORIGINAL_DATABASE_START_FAILED");
    }
    if (targetStart.status === "rejected") {
      refuse("TARGET_DATABASE_START_FAILED");
    }
    const [sourceIdentity, targetIdentity] = await Promise.all([
      connectedIdentity(sourceDatabase),
      connectedIdentity(targetDatabase.client),
    ]);
    try {
      assertConnectedLocalDatabaseIdentity(
        sourceIdentity,
        environment.sourceDatabaseName,
      );
      assertConnectedLocalDatabaseIdentity(
        targetIdentity,
        environment.targetDatabaseName,
      );
    } catch {
      refuse("CONNECTED_DATABASE_IDENTITY_NOT_LOCAL");
    }
    await assertOriginalClutchpacksV1DatabaseReady(() =>
      readClutchpacksV3ActiveSourceMigrationEvidence(sourceDatabase!)
    );
    const [originalResult, targetResult] = await Promise.allSettled([
      readOriginalEvidence(
        sourceDatabase,
        environment.sourceOrganizationId,
      ),
      readTargetEvidence(targetDatabase.client, environment),
    ]);
    if (originalResult.status === "rejected") {
      refuse("ORIGINAL_EVIDENCE_READ_FAILED");
    }
    if (targetResult.status === "rejected") {
      refuse("TARGET_EVIDENCE_READ_FAILED");
    }
    const originalRows = originalResult.value;
    const targetRead = targetResult.value;
    const original = assertOriginalClutchpacksV1IsExact(originalRows);
    assertClutchpacksV3CanaryTargetIsExact(targetRead.snapshot, environment);
    const stage = determineClutchpacksV3CanaryQualificationStage(
      targetRead.snapshot,
    );
    if (stage === "ready_to_resume") {
      const cursor = targetRead.snapshot.cursors[0];
      if (cursor?.generation === 1n) {
        assertClutchpacksV3CanaryTargetIsPristine(targetRead.snapshot);
      } else {
        assertClutchpacksV3CanaryResetGenerationAtFeedStart(
          targetRead.snapshot,
        );
      }
    } else if (stage !== "replay_active" && stage !== "replay_paused") {
      assertClutchpacksV3CanaryTargetIsPristine(targetRead.snapshot);
    }
    if (command.action === "status" || command.action === "plan") {
      process.stdout.write(`${JSON.stringify(publicStatus(
        command.action,
        environment,
        original,
        targetRead.snapshot,
        targetRead.supervisor,
      ))}\n`);
      return;
    }
    if (command.action === "pause_original") {
      process.stdout.write(`${JSON.stringify(await pauseOriginal(
        sourceDatabase,
        environment,
        original,
      ))}\n`);
      return;
    }
    if (command.action === "pause_target") {
      assertClutchpacksV3CanaryTargetCanPause(targetRead.snapshot);
      assertClutchpacksV3CanarySupervisorStopped(targetRead.supervisor);
      process.stdout.write(`${JSON.stringify(await pauseClutchpacksV3CanaryTarget(
        targetDatabase.client,
        environment,
        targetRead.snapshot,
        targetRead.supervisor,
      ))}\n`);
      return;
    }
    if (command.action === "reset_target_cursor") {
      assertOriginalClutchpacksV1PausedAndDrained(original);
      assertClutchpacksV3CanarySupervisorStopped(targetRead.supervisor);
      process.stdout.write(`${JSON.stringify(
        await resetClutchpacksV3CanaryTargetCursor(
          targetDatabase.client,
          environment,
          targetRead.snapshot,
          targetRead.supervisor,
        ),
      )}\n`);
      return;
    }
    assertOriginalClutchpacksV1PausedAndDrained(original);
    assertClutchpacksV3CanaryOneSlotSupervisor(targetRead.supervisor);
    if (command.action === "resume") {
      const resumeOutcome = await resumeCanary(
        targetDatabase.client,
        environment,
        targetRead.snapshot,
      );
      const after = await readTargetEvidence(targetDatabase.client, environment);
      assertClutchpacksV3CanaryTargetIsExact(after.snapshot, environment);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        operation: WORKFLOW,
        mode: "resume",
        outcome: resumeOutcome === "resumed"
          ? "replay_started"
          : resumeOutcome === "refreshed"
          ? "replay_refresh_started"
          : resumeOutcome === "reset_replay_started"
          ? "replay_reset_started"
          : "already_resumed",
        sourceDatabase: environment.sourceDatabaseName,
        targetDatabase: environment.targetDatabaseName,
        targetDigest: environment.targetDigest,
        targetStage: determineClutchpacksV3CanaryQualificationStage(
          after.snapshot,
        ),
        providerCallMadeDirectly: false,
      })}\n`);
      return;
    }
    if (command.action !== "advance") refuse("COMMAND_INVALID");
    assertClutchpacksV3CanaryExpectedStage(command.expectedStage, stage);
    const advanced = await advanceOneStep(
      targetDatabase.client,
      environment,
      targetRead.snapshot,
    );
    const after = await readTargetEvidence(targetDatabase.client, environment);
    assertClutchpacksV3CanaryTargetIsExact(after.snapshot, environment);
    const afterStage = determineClutchpacksV3CanaryQualificationStage(
      after.snapshot,
    );
    if (afterStage === "ready_to_resume") {
      const cursor = after.snapshot.cursors[0];
      if (cursor?.generation === 1n) {
        assertClutchpacksV3CanaryTargetIsPristine(after.snapshot);
      } else {
        assertClutchpacksV3CanaryResetGenerationAtFeedStart(after.snapshot);
      }
    } else if (
      afterStage !== "replay_active" && afterStage !== "replay_paused"
    ) {
      assertClutchpacksV3CanaryTargetIsPristine(after.snapshot);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      operation: WORKFLOW,
      mode: "advance",
      outcome: advanced.outcome,
      previousStage: advanced.previousStage,
      targetStage: afterStage,
      sourceDatabase: environment.sourceDatabaseName,
      targetDatabase: environment.targetDatabaseName,
      targetDigest: environment.targetDigest,
      providerCallMadeDirectly: false,
    })}\n`);
  } finally {
    environment.connectionKey.fill(0);
    await Promise.all([
      sourceDatabase?.$disconnect().catch(() => undefined),
      targetDatabase?.close().catch(() => undefined),
    ]);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(
      safeClutchpacksV3CanaryDriverFailure(error),
    )}\n`);
    process.exitCode = 1;
  });
}
