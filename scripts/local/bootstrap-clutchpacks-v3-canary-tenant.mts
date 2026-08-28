#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestIdentityNamespaceByProvider,
  dataforrestEventsConnectionConfigurationV1Schema,
} from "@packscout/contracts";
import {
  createPrismaClientLifecycle,
  PipelineSetupRepository,
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
import { readSourceAdministrationSettings } from
  "../../apps/admin/server/runtime-config.ts";
import { assertConnectedLocalDatabaseIdentity } from
  "./bootstrap-postgres-development-first-admin.mts";
import { classifyLocalDatabaseTarget } from "./local-database-target.mjs";

const WORKFLOW = "bootstrap_clutchpacks_v3_canary_tenant";
const SYSTEM_DATABASE_NAMES = new Set(["postgres", "template0", "template1"]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TARGET_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THE_TARGET_MUST_BE_A_FRESH_LOCAL_DATABASE";
const TARGET_SLUG = "packscout-clutchpacks-v3-canary";
const TARGET_NAME = "PackScout ClutchPacks V3 Canary";
const PROVIDER_DISPLAY_NAME = "ClutchPacks V3 Canary";
const PROFILE_DISPLAY_NAME = "DataForrest V3 ClutchPacks Canary";
const ACTOR_KEY = "system:clutchpacks-v3-canary-bootstrap";
const CONFIRMATION_PREFIX = "BOOTSTRAP CLUTCHPACKS V3 LOCAL";
const PLATFORM_REQUEST_LANES_MIGRATION =
  "20260827010000_provider_source_platform_request_lanes";
const PLATFORM_REQUEST_LANES_MIGRATION_CHECKSUM =
  "e1832b7d15630efe544dc2d282aa5b221aac52be9fa648fa4b66b856ac84dbb7";
const TARGET_COMPOSITE_MIGRATIONS = Object.freeze([
  Object.freeze({
    name: "20260819010000_buyback_ev_revisions",
    checksum:
      "71afde6ae913c32a5c7f017da5035775ed5f1fba7d1b48e0b7be4a86e4d825b0",
  }),
  Object.freeze({
    name: "20260826005000_source_relationship_confirmations",
    checksum:
      "19cfc4cdae5fc3615159c5ead740fdc3e3e83945bf6c9ec2176ce36067ce9a21",
  }),
  Object.freeze({
    name: "20260826010000_heat_relationship_causality",
    checksum:
      "5ac08e4eb77bc83838d94796ace095c93dbdfab2344a2658cb87b46e3397193d",
  }),
  Object.freeze({
    name: PLATFORM_REQUEST_LANES_MIGRATION,
    checksum: PLATFORM_REQUEST_LANES_MIGRATION_CHECKSUM,
  }),
  Object.freeze({
    name: "20260827020000_buyback_ev_provider_source_origin",
    checksum:
      "10ae3670f6fbafb0ed529154ac7aad227b60bab735630e1079e805ddf8e7b24e",
  }),
]);
const ACTIVE_SOURCE_APPLICATION_TABLE_COUNT = 84;
const TARGET_APPLICATION_TABLE_COUNT = 91;

export class ClutchpacksV3CanaryBootstrapError extends Error {
  override readonly name = "ClutchpacksV3CanaryBootstrapError";

  constructor(readonly code: string) {
    super(code);
  }
}

function refuse(code: string): never {
  throw new ClutchpacksV3CanaryBootstrapError(code);
}

const clutchpacksMapperDescriptor = launchSourceMapperDescriptors.find(
  (descriptor) => descriptor.provider === "clutchpacks",
);
if (!clutchpacksMapperDescriptor) refuse("CLUTCHPACKS_MAPPER_PINS_MISSING");

export const CLUTCHPACKS_V3_CANARY_SOURCE_PINS = Object.freeze({
  sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  adapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
  mapperKey: clutchpacksMapperDescriptor.mapperKey,
  mapperVersion: clutchpacksMapperDescriptor.mapperVersion,
  identityNamespaceKey: dataforrestIdentityNamespaceByProvider.clutchpacks,
  cursorCodecVersion: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
});

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) refuse("ENVIRONMENT_INVALID");
  return value;
}

function localDatabase(
  environment: NodeJS.ProcessEnv,
  variableName: string,
): Readonly<{ url: string; name: string; target: string }> {
  const value = required(environment, variableName);
  const classification = classifyLocalDatabaseTarget({
    PACKSCOUT_DATABASE_URL: value,
  });
  if (!classification.local || !classification.database) {
    refuse("DATABASE_TARGET_NOT_LOCAL");
  }
  const parsed = new URL(value);
  if (
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0 ||
    SYSTEM_DATABASE_NAMES.has(classification.database)
  ) refuse("DATABASE_TARGET_AMBIGUOUS");
  const port = parsed.port || "5432";
  return Object.freeze({
    url: value,
    name: classification.database,
    target:
      `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}/${
        classification.database
      }`,
  });
}

function deterministicUuid(organizationId: string, purpose: string): string {
  const bytes = createHash("sha256")
    .update("packscout.clutchpacks-v3-canary-local-identity.v1")
    .update("\0")
    .update(organizationId)
    .update("\0")
    .update(purpose)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export interface ClutchpacksV3CanaryBootstrapEnvironment {
  readonly sourceDatabaseUrl: string;
  readonly sourceDatabaseName: string;
  readonly targetDatabaseUrl: string;
  readonly targetDatabaseName: string;
  readonly sourceOrganizationId: string;
  readonly targetOrganizationId: string;
  readonly connectionKey: Uint8Array;
  readonly connectionKeyVersion: number;
  readonly providerId: string;
  readonly profileId: string;
  readonly connectionRevisionId: string;
  readonly targetDigest: string;
  readonly confirmation: string;
}

export function readClutchpacksV3CanaryBootstrapEnvironment(
  environment: NodeJS.ProcessEnv,
): ClutchpacksV3CanaryBootstrapEnvironment {
  if (
    environment.NODE_ENV !== "development" ||
    environment.PACKSCOUT_RUNTIME_ENVIRONMENT?.trim() !== "local"
  ) refuse("LOCAL_DEVELOPMENT_ENVIRONMENT_REQUIRED");
  if (
    environment.PACKSCOUT_CLUTCHPACKS_V3_TARGET_ACK?.trim() !==
      TARGET_ACKNOWLEDGEMENT
  ) refuse("FRESH_TARGET_ACKNOWLEDGEMENT_REQUIRED");

  const sourceDatabase = localDatabase(
    environment,
    "PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL",
  );
  const targetDatabase = localDatabase(environment, "PACKSCOUT_DATABASE_URL");
  if (
    sourceDatabase.target === targetDatabase.target ||
    sourceDatabase.name === targetDatabase.name
  ) {
    refuse("SEPARATE_TARGET_DATABASE_REQUIRED");
  }
  const sourceOrganizationId = required(
    environment,
    "PACKSCOUT_CLUTCHPACKS_V1_ORGANIZATION_ID",
  ).toLowerCase();
  const targetOrganizationId = required(
    environment,
    "PACKSCOUT_CLUTCHPACKS_V3_CANARY_ORGANIZATION_ID",
  ).toLowerCase();
  if (
    !UUID_PATTERN.test(sourceOrganizationId) ||
    !UUID_PATTERN.test(targetOrganizationId) ||
    sourceOrganizationId === targetOrganizationId
  ) refuse("ORGANIZATION_BINDING_INVALID");

  let sourceAdministration;
  try {
    sourceAdministration = readSourceAdministrationSettings({
      key: environment.PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64,
      keyVersion: environment.PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION,
    });
  } catch {
    refuse("CONNECTION_KEY_INVALID");
  }
  if (!sourceAdministration) refuse("CONNECTION_KEY_INVALID");

  const targetDigest = createHash("sha256").update([
    "packscout.clutchpacks-v3-canary-separate-local-target.v1",
    sourceDatabase.target,
    targetDatabase.target,
    sourceOrganizationId,
    targetOrganizationId,
    TARGET_SLUG,
    CLUTCHPACKS_V3_CANARY_SOURCE_PINS.sourceTypeKey,
    CLUTCHPACKS_V3_CANARY_SOURCE_PINS.adapterVersion,
    CLUTCHPACKS_V3_CANARY_SOURCE_PINS.normalizedContractVersion,
    CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperKey,
    CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperVersion,
    CLUTCHPACKS_V3_CANARY_SOURCE_PINS.identityNamespaceKey,
    CLUTCHPACKS_V3_CANARY_SOURCE_PINS.cursorCodecVersion,
  ].join("\n")).digest("hex");
  return Object.freeze({
    sourceDatabaseUrl: sourceDatabase.url,
    sourceDatabaseName: sourceDatabase.name,
    targetDatabaseUrl: targetDatabase.url,
    targetDatabaseName: targetDatabase.name,
    sourceOrganizationId,
    targetOrganizationId,
    connectionKey: sourceAdministration.connectionConfigurationKey,
    connectionKeyVersion:
      sourceAdministration.connectionConfigurationKeyVersion,
    providerId: deterministicUuid(targetOrganizationId, "provider"),
    profileId: deterministicUuid(targetOrganizationId, "connection-profile"),
    connectionRevisionId: deterministicUuid(
      targetOrganizationId,
      "connection-revision-1",
    ),
    targetDigest,
    confirmation: `${CONFIRMATION_PREFIX} ${targetDigest.slice(0, 16)}`,
  });
}

export function parseClutchpacksV3CanaryBootstrapCommand(
  argv: readonly string[],
  expectedConfirmation: string,
): Readonly<{ execute: boolean; confirmation: string }> {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--dry-run")) {
    return Object.freeze({ execute: false, confirmation: expectedConfirmation });
  }
  if (
    argv.length !== 3 ||
    argv[0] !== "--execute" ||
    argv[1] !== "--confirmation" ||
    argv[2] !== expectedConfirmation
  ) refuse("CONFIRMATION_INVALID");
  return Object.freeze({ execute: true, confirmation: expectedConfirmation });
}

export interface ClutchpacksV3ReplayCapacitySnapshot {
  readonly clutchSourceState: string;
  readonly clutchActiveRunCount: number;
}

export function assessClutchpacksV3ReplayCapacity(
  snapshot: ClutchpacksV3ReplayCapacitySnapshot,
): Readonly<{
  ready: boolean;
  reason:
    | "ready"
    | "clutch_not_paused"
    | "clutch_work_not_drained";
}> {
  if (snapshot.clutchSourceState !== "paused") {
    return Object.freeze({ ready: false, reason: "clutch_not_paused" });
  }
  if (snapshot.clutchActiveRunCount !== 0) {
    return Object.freeze({
      ready: false,
      reason: "clutch_work_not_drained",
    });
  }
  return Object.freeze({ ready: true, reason: "ready" });
}

export interface ClutchpacksV3MigrationEvidence {
  readonly migrationName: string;
  readonly checksum: string;
  readonly finishedAt: Date | null;
  readonly rolledBackAt: Date | null;
  readonly tableCount: number;
}

export function assertClutchpacksV3ActiveSourceMigrationReadiness(
  evidence: readonly ClutchpacksV3MigrationEvidence[],
): void {
  if (
    evidence.length !== 1 ||
    evidence[0]?.migrationName !== PLATFORM_REQUEST_LANES_MIGRATION ||
    evidence[0]?.checksum !== PLATFORM_REQUEST_LANES_MIGRATION_CHECKSUM ||
    evidence[0]?.finishedAt === null ||
    evidence[0]?.rolledBackAt !== null ||
    evidence[0]?.tableCount !== ACTIVE_SOURCE_APPLICATION_TABLE_COUNT
  ) refuse("ACTIVE_SOURCE_MIGRATION_READINESS_REQUIRED");
}

export function assertClutchpacksV3TargetCompositeMigrations(
  evidence: readonly ClutchpacksV3MigrationEvidence[],
): void {
  if (evidence.length !== TARGET_COMPOSITE_MIGRATIONS.length) {
    refuse("TARGET_COMPOSITE_MIGRATIONS_REQUIRED");
  }
  for (const expected of TARGET_COMPOSITE_MIGRATIONS) {
    const row = evidence.find((candidate) =>
      candidate.migrationName === expected.name
    );
    if (
      !row ||
      row.checksum !== expected.checksum ||
      row.finishedAt === null ||
      row.rolledBackAt !== null ||
      row.tableCount !== TARGET_APPLICATION_TABLE_COUNT
    ) refuse("TARGET_COMPOSITE_MIGRATIONS_REQUIRED");
  }
}

export interface ClutchpacksV3CanaryTargetSnapshot {
  readonly organizationCount: number;
  readonly organization: Readonly<{
    id: string;
    slug: string;
    name: string;
  }> | null;
  readonly providers: readonly Readonly<{
    id: string;
    platformKey: string;
    state: string;
    activeRevisionId: string | null;
    nextRunAt: Date | null;
  }>[];
  readonly profiles: readonly Readonly<{
    id: string;
    sourceTypeKey: string;
    state: string;
    requestLimit: number;
  }>[];
  readonly connectionRevisions: readonly Readonly<{
    id: string;
    profileId: string;
    adapterVersion: string;
  }>[];
  readonly sources: readonly Readonly<{
    id: string;
    providerId: string;
    profileId: string;
    sourceTypeKey: string;
    state: string;
  }>[];
  readonly sourceRevisions: readonly Readonly<{
    sourceInstanceId: string;
    adapterVersion: string;
    normalizedContractVersion: string;
    mapperKey: string;
    mapperVersion: string;
    identityNamespaceKey: string;
    cursorCodecVersion: string;
  }>[];
  readonly cursors: readonly Readonly<{
    sourceInstanceId: string;
    generation: bigint;
    fingerprint: string | null;
  }>[];
  readonly importRunCount: number;
  readonly importPageCount: number;
  readonly canonicalEntityCount: number;
  readonly legacyProviderConfigurationCount: number;
  readonly legacyProviderSecretCount: number;
  readonly legacyProviderConnectionTestCount: number;
  readonly legacyProviderCursorCount: number;
}

export function assertClutchpacksV3CanaryTargetIsSafe(
  snapshot: ClutchpacksV3CanaryTargetSnapshot,
  environment: Pick<
    ClutchpacksV3CanaryBootstrapEnvironment,
    | "targetOrganizationId"
    | "providerId"
    | "profileId"
    | "connectionRevisionId"
  >,
): void {
  if (
    snapshot.organizationCount > 1 ||
    (snapshot.organizationCount === 1 && snapshot.organization === null) ||
    (
      snapshot.organization !== null &&
      (
        snapshot.organization.id !== environment.targetOrganizationId ||
        snapshot.organization.slug !== TARGET_SLUG ||
        snapshot.organization.name !== TARGET_NAME
      )
    )
  ) refuse("FRESH_TARGET_DATABASE_REQUIRED");
  if (
    snapshot.providers.length > 1 ||
    snapshot.providers.some((provider) =>
      provider.id !== environment.providerId ||
      provider.platformKey !== "clutchpacks" ||
      !["draft", "active"].includes(provider.state) ||
      provider.activeRevisionId !== null ||
      provider.nextRunAt !== null
    ) ||
    snapshot.profiles.length > 1 ||
    snapshot.profiles.some((profile) =>
      profile.id !== environment.profileId ||
      profile.sourceTypeKey !== DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY ||
      profile.requestLimit !== 2 ||
      !["draft", "active"].includes(profile.state)
    ) ||
    snapshot.connectionRevisions.length > 1 ||
    snapshot.connectionRevisions.some((revision) =>
      revision.id !== environment.connectionRevisionId ||
      revision.profileId !== environment.profileId ||
      revision.adapterVersion !== DATAFORREST_EVENTS_V1_ADAPTER_VERSION
    ) ||
    snapshot.sources.length > 1 ||
    snapshot.sources.some((source) =>
      source.providerId !== environment.providerId ||
      source.profileId !== environment.profileId ||
      source.sourceTypeKey !== DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY ||
      !["draft", "paused", "active"].includes(source.state)
    ) ||
    snapshot.sourceRevisions.length > 1 ||
    snapshot.sourceRevisions.some((revision) =>
      revision.adapterVersion !==
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.adapterVersion ||
      revision.normalizedContractVersion !==
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.normalizedContractVersion ||
      revision.mapperKey !== CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperKey ||
      revision.mapperVersion !==
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperVersion ||
      revision.identityNamespaceKey !==
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.identityNamespaceKey ||
      revision.cursorCodecVersion !==
        CLUTCHPACKS_V3_CANARY_SOURCE_PINS.cursorCodecVersion
    )
  ) refuse("TARGET_TOPOLOGY_INVALID");
  const sourceId = snapshot.sources[0]?.id;
  if (
    snapshot.sourceRevisions.some((revision) =>
      revision.sourceInstanceId !== sourceId
    ) ||
    snapshot.cursors.length > 1 ||
    snapshot.cursors.some((cursor) =>
      cursor.sourceInstanceId !== sourceId ||
      cursor.generation !== 1n ||
      cursor.fingerprint !== null
    )
  ) refuse("TARGET_TOPOLOGY_INVALID");
  if (
    snapshot.importRunCount !== 0 ||
    snapshot.importPageCount !== 0 ||
    snapshot.canonicalEntityCount !== 0 ||
    snapshot.legacyProviderConfigurationCount !== 0 ||
    snapshot.legacyProviderSecretCount !== 0 ||
    snapshot.legacyProviderConnectionTestCount !== 0 ||
    snapshot.legacyProviderCursorCount !== 0
  ) refuse("TARGET_ALREADY_CONTAINS_LINEAGE");
}

interface OriginalConnectionEvidence {
  readonly configuration: Readonly<{ endpoint: string; bearerToken: string }>;
  readonly capacity: ClutchpacksV3ReplayCapacitySnapshot;
}

function sourceConnectionResolver(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
) {
  const adapters = createProductionSourceAdapterRegistry();
  return new SourceConnectionConfigurationService({
    repository: new SourceConnectionAdminRepository(database),
    cipher: new AesGcmSourceConnectionConfigurationCipher({
      primaryVersion: environment.connectionKeyVersion,
      keys: new Map([[
        environment.connectionKeyVersion,
        environment.connectionKey,
      ]]),
    }),
    sourceAdapters: adapters,
    adminConfigurationCodecs:
      createProductionSourceAdminConfigurationCodecRegistry(adapters),
  });
}

async function readOriginalConnectionEvidence(
  sourceDatabase: PrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
): Promise<OriginalConnectionEvidence> {
  return sourceDatabase.$transaction(async (transaction) => {
    await transaction.$executeRaw(Prisma.sql`set transaction read only`);
    const rows = await transaction.$queryRaw<Array<{
      sourceState: string;
      profileId: string;
      revisionId: string;
      sourceAdapterVersion: string;
      configurationFingerprint: string;
      encryptionKeyVersion: number;
      clutchActiveRunCount: number;
    }>>(Prisma.sql`
      select source.state::text as "sourceState",
             profile.id as "profileId",
             connection_revision.id as "revisionId",
             source_revision.source_adapter_version as "sourceAdapterVersion",
             connection_revision.configuration_fingerprint
               as "configurationFingerprint",
             connection_revision.encryption_key_version
               as "encryptionKeyVersion",
             (
               select count(*)::integer
               from public.import_runs as run
               where run.organization_id = source.organization_id
                 and run.source_instance_id = source.id
                 and run.state in ('queued', 'running')
             ) as "clutchActiveRunCount"
      from public.provider_sources as provider
      join public.provider_source_instances as source
        on source.organization_id = provider.organization_id
       and source.provider_id = provider.id
      join public.provider_source_revisions as source_revision
        on source_revision.organization_id = source.organization_id
       and source_revision.provider_id = source.provider_id
       and source_revision.source_instance_id = source.id
       and source_revision.id = source.active_revision_id
      join public.source_connection_profiles as profile
        on profile.organization_id = source.organization_id
       and profile.id = source.connection_profile_id
      join public.source_connection_revisions as connection_revision
        on connection_revision.organization_id = profile.organization_id
       and connection_revision.connection_profile_id = profile.id
       and connection_revision.id = profile.active_revision_id
      where provider.organization_id =
        ${environment.sourceOrganizationId}::uuid
        and provider.platform_key = 'clutchpacks'
        and source.state in ('active', 'paused')
        and profile.state = 'active'
        and connection_revision.state = 'active'
        and connection_revision.revoked_at is null
    `);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.sourceAdapterVersion !==
        DATAFORREST_EVENTS_V1_LEGACY_ADAPTER_VERSION ||
      row.encryptionKeyVersion !== environment.connectionKeyVersion
    ) refuse("SOURCE_V1_CONNECTION_NOT_EXACT");
    const resolver = sourceConnectionResolver(
      transaction as unknown as PackscoutPrismaClient,
      environment,
    );
    const resolved = await resolver.resolveSourceConnectionConfiguration({
      organizationId: environment.sourceOrganizationId,
      connectionProfileId: row.profileId,
      connectionRevisionId: row.revisionId,
      configurationFingerprint: row.configurationFingerprint,
    });
    const parsed = dataforrestEventsConnectionConfigurationV1Schema.safeParse(
      resolved.configuration,
    );
    if (!parsed.success) refuse("SOURCE_V1_CONNECTION_NOT_EXACT");
    return Object.freeze({
      configuration: parsed.data,
      capacity: Object.freeze({
        clutchSourceState: row.sourceState,
        clutchActiveRunCount: row.clutchActiveRunCount,
      }),
    });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 5_000,
    timeout: 30_000,
  });
}

async function readMigrationEvidence(
  database: PrismaClient,
  migrationNames: readonly string[],
): Promise<readonly ClutchpacksV3MigrationEvidence[]> {
  return database.$queryRaw<ClutchpacksV3MigrationEvidence[]>(
    Prisma.sql`
      select migration_name as "migrationName",
             checksum,
             finished_at as "finishedAt",
             rolled_back_at as "rolledBackAt",
             (
               select count(*)::integer
               from pg_class as table_class
               join pg_namespace as table_schema
                 on table_schema.oid = table_class.relnamespace
               where table_schema.nspname = 'public'
                 and table_class.relkind = 'r'
                 and table_class.relname <> '_prisma_migrations'
             ) as "tableCount"
      from public."_prisma_migrations"
      where migration_name in (${Prisma.join(migrationNames)})
    `,
  );
}

export function readClutchpacksV3ActiveSourceMigrationEvidence(
  database: PrismaClient,
): Promise<readonly ClutchpacksV3MigrationEvidence[]> {
  return readMigrationEvidence(database, [PLATFORM_REQUEST_LANES_MIGRATION]);
}

async function readTargetSnapshot(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
): Promise<ClutchpacksV3CanaryTargetSnapshot> {
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
    canonicalEntityCount,
    legacyProviderConfigurationCount,
    legacyProviderSecretCount,
    legacyProviderConnectionTestCount,
    legacyProviderCursorCount,
  ] = await Promise.all([
    database.organizations.count(),
    database.organizations.findUnique({
      where: { id: environment.targetOrganizationId },
      select: { id: true, slug: true, name: true },
    }),
    database.provider_sources.findMany({
      select: {
        id: true,
        platform_key: true,
        state: true,
        active_revision_id: true,
        next_run_at: true,
      },
    }),
    database.source_connection_profiles.findMany({
      select: {
        id: true,
        source_type_key: true,
        state: true,
        request_limit: true,
      },
    }),
    database.source_connection_revisions.findMany({
      select: {
        id: true,
        connection_profile_id: true,
        source_adapter_version: true,
      },
    }),
    database.provider_source_instances.findMany({
      select: {
        id: true,
        provider_id: true,
        connection_profile_id: true,
        source_type_key: true,
        state: true,
      },
    }),
    database.provider_source_revisions.findMany({
      select: {
        source_instance_id: true,
        source_adapter_version: true,
        normalized_contract_version: true,
        mapper_key: true,
        mapper_version: true,
        identity_namespace_key: true,
        cursor_codec_version: true,
      },
    }),
    database.provider_source_cursors.findMany({
      select: {
        source_instance_id: true,
        cursor_generation: true,
        cursor_fingerprint: true,
      },
    }),
    database.import_runs.count(),
    database.import_pages.count(),
    database.canonical_entities.count(),
    database.provider_config_revisions.count(),
    database.provider_secret_versions.count(),
    database.provider_connection_tests.count(),
    database.provider_cursor_checkpoints.count(),
  ]);
  return {
    organizationCount,
    organization,
    providers: providers.map((provider) => ({
      id: provider.id,
      platformKey: provider.platform_key,
      state: provider.state,
      activeRevisionId: provider.active_revision_id,
      nextRunAt: provider.next_run_at,
    })),
    profiles: profiles.map((profile) => ({
      id: profile.id,
      sourceTypeKey: profile.source_type_key,
      state: profile.state,
      requestLimit: profile.request_limit,
    })),
    connectionRevisions: connectionRevisions.map((revision) => ({
      id: revision.id,
      profileId: revision.connection_profile_id,
      adapterVersion: revision.source_adapter_version,
    })),
    sources: sources.map((source) => ({
      id: source.id,
      providerId: source.provider_id,
      profileId: source.connection_profile_id,
      sourceTypeKey: source.source_type_key,
      state: source.state,
    })),
    sourceRevisions: sourceRevisions.map((revision) => ({
      sourceInstanceId: revision.source_instance_id,
      adapterVersion: revision.source_adapter_version,
      normalizedContractVersion: revision.normalized_contract_version,
      mapperKey: revision.mapper_key,
      mapperVersion: revision.mapper_version,
      identityNamespaceKey: revision.identity_namespace_key,
      cursorCodecVersion: revision.cursor_codec_version,
    })),
    cursors: cursors.map((cursor) => ({
      sourceInstanceId: cursor.source_instance_id,
      generation: cursor.cursor_generation,
      fingerprint: cursor.cursor_fingerprint,
    })),
    importRunCount,
    importPageCount,
    canonicalEntityCount,
    legacyProviderConfigurationCount,
    legacyProviderSecretCount,
    legacyProviderConnectionTestCount,
    legacyProviderCursorCount,
  };
}

function targetSourceServices(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
) {
  const adapters = createProductionSourceAdapterRegistry();
  const codecs = createProductionSourceAdminConfigurationCodecRegistry(adapters);
  const mapperDescriptors = new SourceMapperDescriptorRegistry(
    launchSourceMapperDescriptors,
  );
  const connectionConfigurations = new SourceConnectionConfigurationService({
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
    ids: {
      id: (() => {
        const ids = [environment.profileId, environment.connectionRevisionId];
        return () => {
          const id = ids.shift();
          if (!id) throw new Error("canary connection identity exhausted");
          return id;
        };
      })(),
    },
  });
  const activation = new ProviderSourceActivationService({
    repository: new ProviderSourceLifecycleRepository(database),
    connectionConfigurations,
    sourceAdapters: adapters,
    mapperDescriptors,
  });
  return {
    connectionConfigurations,
    sourceLifecycle: new ProviderSourceLifecycleService({
      repository: new ProviderSourceAdminLifecycleRepository(database),
      activation,
      sourceAdapters: adapters,
      mapperDescriptors,
      adminConfigurationCodecs: codecs,
    }),
  };
}

async function executeBootstrap(
  database: PackscoutPrismaClient,
  environment: ClutchpacksV3CanaryBootstrapEnvironment,
  sourceConfiguration: Readonly<{ endpoint: string; bearerToken: string }>,
  before: ClutchpacksV3CanaryTargetSnapshot,
): Promise<"created" | "already_staged"> {
  const setup = new PipelineSetupRepository(database);
  if (!before.organization) {
    try {
      await setup.createOrganization({
        id: environment.targetOrganizationId,
        slug: TARGET_SLUG,
        name: TARGET_NAME,
      });
    } catch {
      refuse("TARGET_ORGANIZATION_STAGE_FAILED");
    }
  }
  if (before.providers.length === 0) {
    try {
      await setup.createProviderSource({
        id: environment.providerId,
        organizationId: environment.targetOrganizationId,
        platformKey: "clutchpacks",
        displayName: PROVIDER_DISPLAY_NAME,
        state: "active",
      });
    } catch {
      refuse("TARGET_PROVIDER_STAGE_FAILED");
    }
  } else if (before.providers[0]?.state === "draft") {
    try {
      const promoted = await database.$executeRaw(Prisma.sql`
        update public.provider_sources as provider
        set state = 'active'::public.provider_state,
            updated_at = ${new Date()}
        where provider.id = ${environment.providerId}::uuid
          and provider.organization_id =
            ${environment.targetOrganizationId}::uuid
          and provider.platform_key = 'clutchpacks'
          and provider.state = 'draft'::public.provider_state
          and provider.active_revision_id is null
          and provider.next_run_at is null
          and not exists (
            select 1
            from public.provider_config_revisions as revision
            where revision.organization_id = provider.organization_id
              and revision.provider_id = provider.id
          )
      `);
      if (promoted !== 1) refuse("TARGET_PROVIDER_STAGE_FAILED");
    } catch (error) {
      if (error instanceof ClutchpacksV3CanaryBootstrapError) throw error;
      refuse("TARGET_PROVIDER_STAGE_FAILED");
    }
  }
  const services = targetSourceServices(database, environment);
  if (before.profiles.length === 0) {
    try {
      await services.connectionConfigurations.createProfile(
        { organizationId: environment.targetOrganizationId, actorKey: ACTOR_KEY },
        {
          sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
          displayName: PROFILE_DISPLAY_NAME,
          endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
          bearerCredential: sourceConfiguration.bearerToken,
          requestLimit: 2,
        },
      );
    } catch {
      refuse("TARGET_CONNECTION_PROFILE_STAGE_FAILED");
    }
  }
  if (before.sources.length === 0) {
    try {
      await services.sourceLifecycle.createSource(
        { organizationId: environment.targetOrganizationId, actorKey: ACTOR_KEY },
        {
          providerId: environment.providerId,
          connectionProfileId: environment.profileId,
          sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
          mapperKey: CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperKey,
          mapperVersion: CLUTCHPACKS_V3_CANARY_SOURCE_PINS.mapperVersion,
          intervalSeconds: 60,
        },
      );
    } catch {
      refuse("TARGET_SOURCE_STAGE_FAILED");
    }
  }
  return before.organization && before.providers[0]?.state === "active" &&
      before.profiles.length === 1 && before.sources.length === 1
    ? "already_staged"
    : "created";
}

export function safeClutchpacksV3CanaryBootstrapFailure(error: unknown) {
  return Object.freeze({
    ok: false as const,
    operation: WORKFLOW,
    code: error instanceof ClutchpacksV3CanaryBootstrapError
      ? error.code
      : "UNEXPECTED_BOOTSTRAP_FAILURE",
  });
}

export function clutchpacksV3CanaryBootstrapUsage(): string {
  return `Usage:
  npm run bootstrap:clutchpacks-v3-canary:local -- --dry-run

  npm run bootstrap:clutchpacks-v3-canary:local -- \\
    --execute --confirmation "${CONFIRMATION_PREFIX} <digest>"

Required protected environment:
  NODE_ENV=development
  PACKSCOUT_RUNTIME_ENVIRONMENT=local
  PACKSCOUT_CLUTCHPACKS_V1_DATABASE_URL
  PACKSCOUT_DATABASE_URL
  PACKSCOUT_CLUTCHPACKS_V1_ORGANIZATION_ID
  PACKSCOUT_CLUTCHPACKS_V3_CANARY_ORGANIZATION_ID
  PACKSCOUT_CLUTCHPACKS_V3_TARGET_ACK=${TARGET_ACKNOWLEDGEMENT}
  PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64
  PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION

The source database is read in a read-only transaction and must prove the exact
84-table active-source migration subset. The target must be a different, fresh,
fully migrated local database containing the 91-table composite schema. Execute
stages one ClutchPacks adapter-v3 draft at Feed start; it does not queue tests,
call DataForrest, pause the original source, activate anything, or start replay.`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(`${clutchpacksV3CanaryBootstrapUsage()}\n`);
    return;
  }
  const environment = readClutchpacksV3CanaryBootstrapEnvironment(process.env);
  const command = parseClutchpacksV3CanaryBootstrapCommand(
    argv,
    environment.confirmation,
  );
  const sourceDatabase = new PrismaClient({
    datasources: { db: { url: environment.sourceDatabaseUrl } },
  });
  const targetLifecycle = createPrismaClientLifecycle({
    databaseUrl: environment.targetDatabaseUrl,
  });
  try {
    await sourceDatabase.$connect();
    await targetLifecycle.start();
    const [sourceIdentity, targetIdentity] = await Promise.all([
      sourceDatabase.$queryRaw<Array<{
        databaseName: string;
        serverAddress: string | null;
      }>>`
        select current_database() as "databaseName",
               inet_server_addr()::text as "serverAddress"
      `,
      targetLifecycle.client.$queryRaw<Array<{
        databaseName: string;
        serverAddress: string | null;
      }>>`
        select current_database() as "databaseName",
               inet_server_addr()::text as "serverAddress"
      `,
    ]);
    try {
      assertConnectedLocalDatabaseIdentity(
        sourceIdentity[0],
        environment.sourceDatabaseName,
      );
      assertConnectedLocalDatabaseIdentity(
        targetIdentity[0],
        environment.targetDatabaseName,
      );
    } catch {
      refuse("CONNECTED_DATABASE_IDENTITY_NOT_LOCAL");
    }
    const [sourceMigration, targetMigration] = await Promise.all([
      readClutchpacksV3ActiveSourceMigrationEvidence(sourceDatabase),
      readMigrationEvidence(
        targetLifecycle.client,
        TARGET_COMPOSITE_MIGRATIONS.map(({ name }) => name),
      ),
    ]);
    assertClutchpacksV3ActiveSourceMigrationReadiness(sourceMigration);
    assertClutchpacksV3TargetCompositeMigrations(targetMigration);
    const original = await readOriginalConnectionEvidence(
      sourceDatabase,
      environment,
    );
    const capacity = assessClutchpacksV3ReplayCapacity(original.capacity);
    const before = await readTargetSnapshot(targetLifecycle.client, environment);
    assertClutchpacksV3CanaryTargetIsSafe(before, environment);
    if (!command.execute) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        operation: WORKFLOW,
        mode: "dry_run",
        sourceDatabase: environment.sourceDatabaseName,
        targetDatabase: environment.targetDatabaseName,
        targetDigest: environment.targetDigest,
        confirmation: environment.confirmation,
        targetOrganizationExists: before.organization !== null,
        replayCapacityReady: capacity.ready,
        replayCapacityReason: capacity.reason,
        willCallProvider: false,
        willStartReplay: false,
      })}\n`);
      return;
    }
    const outcome = await executeBootstrap(
      targetLifecycle.client,
      environment,
      original.configuration,
      before,
    );
    const after = await readTargetSnapshot(targetLifecycle.client, environment);
    assertClutchpacksV3CanaryTargetIsSafe(after, environment);
    if (
      !after.organization ||
      after.providers.length !== 1 ||
      after.providers[0]?.state !== "active" ||
      after.providers[0]?.activeRevisionId !== null ||
      after.providers[0]?.nextRunAt !== null ||
      after.profiles.length !== 1 ||
      after.connectionRevisions.length !== 1 ||
      after.sources.length !== 1 ||
      after.sourceRevisions.length !== 1 ||
      after.cursors.length !== 1
    ) refuse("TARGET_TOPOLOGY_INVALID");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      operation: WORKFLOW,
      mode: "execute",
      outcome,
      sourceDatabase: environment.sourceDatabaseName,
      targetDatabase: environment.targetDatabaseName,
      targetDigest: environment.targetDigest,
      sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      cursor: "Feed start",
      state: "draft",
      replayCapacityReady: capacity.ready,
      replayCapacityReason: capacity.reason,
      providerCallsQueued: 0,
      replayStarted: false,
    })}\n`);
  } finally {
    environment.connectionKey.fill(0);
    await sourceDatabase.$disconnect().catch(() => undefined);
    await targetLifecycle.close().catch(() => undefined);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(
      safeClutchpacksV3CanaryBootstrapFailure(error),
    )}\n`);
    process.exitCode = 1;
  });
}
