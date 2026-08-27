#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
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
  type ClutchpacksV2CanaryBootstrapEnvironment,
  readClutchpacksV2CanaryBootstrapEnvironment,
} from "./bootstrap-clutchpacks-v2-canary-tenant.mts";
import { assertConnectedLocalDatabaseIdentity } from
  "./bootstrap-postgres-development-first-admin.mts";

const WORKFLOW = "advance_clutchpacks_v2_canary";
const ACTOR_KEY = "system:clutchpacks-v2-canary-qualification";
const TARGET_SLUG = "packscout-clutchpacks-v2-canary";
const TARGET_NAME = "PackScout ClutchPacks V2 Canary";
const ADVANCE_CONFIRMATION_PREFIX = "ADVANCE CLUTCHPACKS V2 LOCAL";
const PAUSE_CONFIRMATION_PREFIX = "PAUSE ORIGINAL CLUTCHPACKS V1 LOCAL";
const RESUME_CONFIRMATION_PREFIX = "RESUME CLUTCHPACKS V2 LOCAL";

export class ClutchpacksV2CanaryDriverError extends Error {
  override readonly name = "ClutchpacksV2CanaryDriverError";

  constructor(readonly code: string) {
    super(code);
  }
}

function refuse(code: string): never {
  throw new ClutchpacksV2CanaryDriverError(code);
}

export interface ClutchpacksV2CanaryDriverConfirmations {
  readonly advance: string;
  readonly pauseOriginal: string;
  readonly resume: string;
}

export function clutchpacksV2CanaryDriverConfirmations(
  targetDigest: string,
): ClutchpacksV2CanaryDriverConfirmations {
  const binding = targetDigest.slice(0, 16);
  return Object.freeze({
    advance: `${ADVANCE_CONFIRMATION_PREFIX} ${binding}`,
    pauseOriginal: `${PAUSE_CONFIRMATION_PREFIX} ${binding}`,
    resume: `${RESUME_CONFIRMATION_PREFIX} ${binding}`,
  });
}

export type ClutchpacksV2CanaryDriverCommand = Readonly<
  | { action: "status" | "plan"; confirmation: null }
  | {
      action: "advance";
      confirmation: string;
      expectedStage: string;
    }
  | {
      action: "pause_original" | "resume";
      confirmation: string;
    }
>;

export function parseClutchpacksV2CanaryDriverCommand(
  argv: readonly string[],
  confirmations: ClutchpacksV2CanaryDriverConfirmations,
): ClutchpacksV2CanaryDriverCommand {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--status")) {
    return Object.freeze({ action: "status", confirmation: null });
  }
  if (argv.length === 1 && argv[0] === "--plan") {
    return Object.freeze({ action: "plan", confirmation: null });
  }
  const declared = new Map<string, Readonly<{
    action: "advance" | "pause_original" | "resume";
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
    ["--resume", Object.freeze({
      action: "resume" as const,
      confirmation: confirmations.resume,
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

export interface CanaryTestEvidence {
  readonly state: string;
  readonly hasSuccessfulResult: boolean;
}

export interface ClutchpacksV2CanaryTargetEvidence {
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
  readonly legacyProviderConfigRevisionCount: number;
  readonly legacyProviderSecretVersionCount: number;
  readonly legacyProviderCursorCheckpointCount: number;
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

export function assertClutchpacksV2CanaryTargetIsExact(
  snapshot: ClutchpacksV2CanaryTargetEvidence,
  environment: Pick<
    ClutchpacksV2CanaryBootstrapEnvironment,
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
    profile.sourceTypeKey !== DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY ||
    !["draft", "active"].includes(profile.state) ||
    profile.requestLimit !== 2 ||
    snapshot.connectionRevisions.length !== 1 ||
    !connectionRevision ||
    connectionRevision.id !== environment.connectionRevisionId ||
    connectionRevision.organizationId !== environment.targetOrganizationId ||
    connectionRevision.profileId !== profile.id ||
    connectionRevision.sourceTypeKey !== DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY ||
    connectionRevision.adapterVersion !==
      DATAFORREST_EVENTS_V1_ADAPTER_VERSION ||
    !["candidate", "active"].includes(connectionRevision.state) ||
    connectionRevision.healthGeneration < 0n ||
    snapshot.sources.length !== 1 ||
    !source ||
    source.organizationId !== environment.targetOrganizationId ||
    source.providerId !== provider.id ||
    source.profileId !== profile.id ||
    source.sourceTypeKey !== DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY ||
    !["draft", "paused", "active"].includes(source.state) ||
    snapshot.sourceRevisions.length !== 1 ||
    !sourceRevision ||
    sourceRevision.organizationId !== environment.targetOrganizationId ||
    sourceRevision.providerId !== provider.id ||
    sourceRevision.sourceInstanceId !== source.id ||
    sourceRevision.profileId !== profile.id ||
    sourceRevision.sourceTypeKey !== DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY ||
    sourceRevision.adapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_VERSION ||
    !isClutchpacksConfiguration(sourceRevision.configuration) ||
    source.activeRevisionId !== sourceRevision.id ||
    snapshot.cursors.length !== 1 ||
    !cursor ||
    cursor.sourceInstanceId !== source.id ||
    cursor.sourceRevisionId !== sourceRevision.id ||
    cursor.generation !== 1n ||
    cursor.adapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_VERSION ||
    snapshot.legacyProviderConfigRevisionCount !== 0 ||
    snapshot.legacyProviderSecretVersionCount !== 0 ||
    snapshot.legacyProviderCursorCheckpointCount !== 0
  ) refuse("TARGET_V2_TOPOLOGY_NOT_EXACT");
  if (
    (profile.state === "draft" &&
      (profile.activeRevisionId !== null ||
        connectionRevision.state !== "candidate")) ||
    (profile.state === "active" &&
      (profile.activeRevisionId !== connectionRevision.id ||
        connectionRevision.state !== "active")) ||
    (source.state !== "draft" && profile.state !== "active")
  ) refuse("TARGET_V2_LIFECYCLE_NOT_EXACT");
}

export function clutchpacksV2CanaryLineageCount(
  snapshot: ClutchpacksV2CanaryTargetEvidence,
): number {
  return snapshot.importRunCount +
    snapshot.importPageCount +
    snapshot.pageReadAttemptCount +
    snapshot.sourceRecordIdentityCount +
    snapshot.semanticObservationCount +
    snapshot.deliveryOccurrenceCount +
    snapshot.canonicalEntityCount;
}

export function assertClutchpacksV2CanaryTargetIsPristine(
  snapshot: ClutchpacksV2CanaryTargetEvidence,
): void {
  const cursor = snapshot.cursors[0];
  if (
    !cursor ||
    cursor.fingerprint !== null ||
    cursor.advancedByRunId !== null ||
    cursor.advancedByPageId !== null ||
    clutchpacksV2CanaryLineageCount(snapshot) !== 0
  ) refuse("TARGET_NOT_PRISTINE_FOR_RESUME");
}

export interface ClutchpacksV2CanarySupervisorEvidence {
  readonly liveEpochCount: number;
  readonly maximumExecutionSlots: number | null;
  readonly capacityState: string | null;
  readonly snapshotPublished: boolean;
}

export function assertClutchpacksV2CanaryOneSlotSupervisor(
  evidence: ClutchpacksV2CanarySupervisorEvidence,
): void {
  if (
    evidence.liveEpochCount !== 1 ||
    evidence.maximumExecutionSlots !== 1 ||
    evidence.capacityState !== "available" ||
    !evidence.snapshotPublished
  ) refuse("TARGET_ONE_SLOT_SUPERVISOR_REQUIRED");
}

export type ClutchpacksV2CanaryQualificationStage =
  | "queue_connection_test"
  | "wait_connection_test"
  | "connection_test_failed"
  | "activate_connection"
  | "queue_source_test"
  | "wait_source_test"
  | "source_test_failed"
  | "activate_source_paused"
  | "ready_to_resume"
  | "replay_active";

function testStage(
  evidence: CanaryTestEvidence | null,
  absent: ClutchpacksV2CanaryQualificationStage,
  waiting: ClutchpacksV2CanaryQualificationStage,
  failed: ClutchpacksV2CanaryQualificationStage,
  succeeded: ClutchpacksV2CanaryQualificationStage,
): ClutchpacksV2CanaryQualificationStage {
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

export function determineClutchpacksV2CanaryQualificationStage(
  snapshot: ClutchpacksV2CanaryTargetEvidence,
): ClutchpacksV2CanaryQualificationStage {
  const profile = snapshot.profiles[0];
  const source = snapshot.sources[0];
  if (!profile || !source) refuse("TARGET_V2_TOPOLOGY_NOT_EXACT");
  if (source.state === "active") return "replay_active";
  if (source.state === "paused") {
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

export function assertClutchpacksV2CanaryExpectedStage(
  expectedStage: string,
  currentStage: ClutchpacksV2CanaryQualificationStage,
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
  environment: ClutchpacksV2CanaryBootstrapEnvironment,
): Promise<Readonly<{
  snapshot: ClutchpacksV2CanaryTargetEvidence;
  supervisor: ClutchpacksV2CanarySupervisorEvidence;
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
      legacyProviderConfigRevisionCount,
      legacyProviderSecretVersionCount,
      legacyProviderCursorCheckpointCount,
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
      transaction.provider_config_revisions.count(),
      transaction.provider_secret_versions.count(),
      transaction.provider_cursor_checkpoints.count(),
      transaction.$queryRaw<Array<{
        maximumExecutionSlots: number;
        capacityState: string;
        snapshotUpdatedAt: Date | null;
      }>>(Prisma.sql`
        select maximum_execution_slots as "maximumExecutionSlots",
               capacity_state as "capacityState",
               snapshot_updated_at as "snapshotUpdatedAt"
        from public.source_supervisor_epochs
        where state = 'active'
          and lease_expires_at > clock_timestamp()
        order by epoch_number desc
      `),
    ]);
    const source = sources[0];
    const sourceRevision = sourceRevisions[0];
    const connectionRevision = connectionRevisions[0];
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
        legacyProviderConfigRevisionCount,
        legacyProviderSecretVersionCount,
        legacyProviderCursorCheckpointCount,
        connectionTest,
        sourceTest,
      }),
      supervisor: Object.freeze({
        liveEpochCount: liveEpochs.length,
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
  environment: ClutchpacksV2CanaryBootstrapEnvironment,
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
  environment: ClutchpacksV2CanaryBootstrapEnvironment,
  original: OriginalClutchpacksV1Evidence,
  target: ClutchpacksV2CanaryTargetEvidence,
  supervisor: ClutchpacksV2CanarySupervisorEvidence,
) {
  const stage = determineClutchpacksV2CanaryQualificationStage(target);
  const source = target.sources[0]!;
  let originalReady = true;
  try {
    assertOriginalClutchpacksV1PausedAndDrained(original);
  } catch {
    originalReady = false;
  }
  let supervisorReady = true;
  try {
    assertClutchpacksV2CanaryOneSlotSupervisor(supervisor);
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
    confirmations: clutchpacksV2CanaryDriverConfirmations(
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
      lineageRows: clutchpacksV2CanaryLineageCount(target),
    }),
    supervisor: Object.freeze({
      ready: supervisorReady,
      liveEpochCount: supervisor.liveEpochCount,
      executionSlots: supervisor.maximumExecutionSlots,
      capacityState: supervisor.capacityState,
    }),
    providerCallMadeDirectly: false,
  });
}

async function pauseOriginal(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV2CanaryBootstrapEnvironment,
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

async function advanceOneStep(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV2CanaryBootstrapEnvironment,
  before: ClutchpacksV2CanaryTargetEvidence,
) {
  const stage = determineClutchpacksV2CanaryQualificationStage(before);
  if (stage === "connection_test_failed") {
    refuse("TARGET_CONNECTION_TEST_FAILED");
  }
  if (stage === "source_test_failed") refuse("TARGET_SOURCE_TEST_FAILED");
  if (
    stage === "wait_connection_test" ||
    stage === "wait_source_test" ||
    stage === "ready_to_resume" ||
    stage === "replay_active"
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

async function resumeCanary(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV2CanaryBootstrapEnvironment,
  before: ClutchpacksV2CanaryTargetEvidence,
): Promise<"resumed" | "already_resumed"> {
  const stage = determineClutchpacksV2CanaryQualificationStage(before);
  if (stage === "replay_active") return "already_resumed";
  if (stage !== "ready_to_resume") {
    refuse("TARGET_NOT_READY_TO_RESUME");
  }
  assertClutchpacksV2CanaryTargetIsPristine(before);
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
  return "resumed";
}

export function safeClutchpacksV2CanaryDriverFailure(error: unknown) {
  return Object.freeze({
    ok: false as const,
    operation: WORKFLOW,
    code: error instanceof ClutchpacksV2CanaryDriverError
      ? error.code
      : "UNEXPECTED_CANARY_DRIVER_FAILURE",
  });
}

export function clutchpacksV2CanaryDriverUsage(): string {
  return `Usage:
  npm run advance:clutchpacks-v2-canary:local -- --status
  npm run advance:clutchpacks-v2-canary:local -- --plan

  npm run advance:clutchpacks-v2-canary:local -- \\
    --pause-original --confirmation "${PAUSE_CONFIRMATION_PREFIX} <digest>"

  npm run advance:clutchpacks-v2-canary:local -- \\
    --advance --expected-stage <targetStage> \\
    --confirmation "${ADVANCE_CONFIRMATION_PREFIX} <digest>"

  npm run advance:clutchpacks-v2-canary:local -- \\
    --resume --confirmation "${RESUME_CONFIRMATION_PREFIX} <digest>"

This driver requires the protected local bootstrap environment. It never starts
a worker and never calls DataForrest directly. Start the target-only supervisor
separately with PACKSCOUT_SOURCE_EXECUTION_SLOTS=1. The target profile retains
the governed requestLimit of 2, while the one execution slot keeps the canary at
one provider request at a time. Status and plan are read-only. Each --advance
invocation performs at most one transition and queues tests for that supervisor.
The required expected stage fences a retry after a transition already committed.
Every advance and resume fails closed until the original adapter-v1 ClutchPacks
source is paused and has no queued or running import runs.`;
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
    process.stdout.write(`${clutchpacksV2CanaryDriverUsage()}\n`);
    return;
  }
  const environment = readClutchpacksV2CanaryBootstrapEnvironment(process.env);
  let sourceDatabase: ReturnType<typeof createPrismaClientLifecycle> | null =
    null;
  let targetDatabase: ReturnType<typeof createPrismaClientLifecycle> | null =
    null;
  try {
    const command = parseClutchpacksV2CanaryDriverCommand(
      argv,
      clutchpacksV2CanaryDriverConfirmations(environment.targetDigest),
    );
    sourceDatabase = createPrismaClientLifecycle({
      databaseUrl: environment.sourceDatabaseUrl,
    });
    targetDatabase = createPrismaClientLifecycle({
      databaseUrl: environment.targetDatabaseUrl,
    });
    await Promise.all([sourceDatabase.start(), targetDatabase.start()]);
    const [sourceIdentity, targetIdentity] = await Promise.all([
      connectedIdentity(sourceDatabase.client),
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
    const [originalRows, targetRead] = await Promise.all([
      readOriginalEvidence(
        sourceDatabase.client,
        environment.sourceOrganizationId,
      ),
      readTargetEvidence(targetDatabase.client, environment),
    ]);
    const original = assertOriginalClutchpacksV1IsExact(originalRows);
    assertClutchpacksV2CanaryTargetIsExact(targetRead.snapshot, environment);
    const stage = determineClutchpacksV2CanaryQualificationStage(
      targetRead.snapshot,
    );
    if (stage !== "replay_active") {
      assertClutchpacksV2CanaryTargetIsPristine(targetRead.snapshot);
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
        sourceDatabase.client,
        environment,
        original,
      ))}\n`);
      return;
    }
    assertOriginalClutchpacksV1PausedAndDrained(original);
    assertClutchpacksV2CanaryOneSlotSupervisor(targetRead.supervisor);
    if (command.action === "resume") {
      const resumeOutcome = await resumeCanary(
        targetDatabase.client,
        environment,
        targetRead.snapshot,
      );
      const after = await readTargetEvidence(targetDatabase.client, environment);
      assertClutchpacksV2CanaryTargetIsExact(after.snapshot, environment);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        operation: WORKFLOW,
        mode: "resume",
        outcome: resumeOutcome === "resumed"
          ? "replay_started"
          : "already_resumed",
        sourceDatabase: environment.sourceDatabaseName,
        targetDatabase: environment.targetDatabaseName,
        targetDigest: environment.targetDigest,
        targetStage: determineClutchpacksV2CanaryQualificationStage(
          after.snapshot,
        ),
        providerCallMadeDirectly: false,
      })}\n`);
      return;
    }
    if (command.action !== "advance") refuse("COMMAND_INVALID");
    assertClutchpacksV2CanaryExpectedStage(command.expectedStage, stage);
    const advanced = await advanceOneStep(
      targetDatabase.client,
      environment,
      targetRead.snapshot,
    );
    const after = await readTargetEvidence(targetDatabase.client, environment);
    assertClutchpacksV2CanaryTargetIsExact(after.snapshot, environment);
    assertClutchpacksV2CanaryTargetIsPristine(after.snapshot);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      operation: WORKFLOW,
      mode: "advance",
      outcome: advanced.outcome,
      previousStage: advanced.previousStage,
      targetStage: determineClutchpacksV2CanaryQualificationStage(
        after.snapshot,
      ),
      sourceDatabase: environment.sourceDatabaseName,
      targetDatabase: environment.targetDatabaseName,
      targetDigest: environment.targetDigest,
      providerCallMadeDirectly: false,
    })}\n`);
  } finally {
    environment.connectionKey.fill(0);
    await Promise.all([
      sourceDatabase?.close().catch(() => undefined),
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
      safeClutchpacksV2CanaryDriverFailure(error),
    )}\n`);
    process.exitCode = 1;
  });
}
