import { createHmac } from "node:crypto";
import { readFile, realpath, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Client, type PoolClient, type QueryResultRow } from "pg";
import {
  buildProviderSourceCapacityForecast,
  evaluateProviderSourceCapacityPreflight,
  type ProviderSourceCapacityForecast,
  type ProviderSourceCapacityModelInput,
} from "@packscout/services";
import {
  TASK010_BOOTSTRAP_ACTION,
  TASK010_PROVIDER_IDENTITIES,
  TASK010_REQUIRED_MIGRATION,
  TASK010_SAFETY_VERSION,
  Task010SafetyError,
  assertTask010BootstrapSnapshot,
  assertTask010BackfillTopologySnapshot,
  assertTask010DatabaseIdentity,
  assertTask010MigratedSchema,
  assertTask010VolumeBinding,
} from "./provider-source-task010-safety.mjs";

export interface Task010Environment {
  readonly databaseUrl: string;
  readonly expectedDatabaseName: string;
  readonly expectedDatabaseIdentity: string | null;
  readonly databaseVolumePath: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly administratorId: string;
  readonly administratorEmail: string;
  readonly administratorDisplayName: string;
  readonly sessionSecret: string;
  readonly actorKeyBase64: string;
  readonly sourceConnectionKeyBase64: string;
  readonly sourceConnectionKeyVersion: number;
  readonly administratorPassword?: string;
}

interface CapacityArtifact {
  readonly version: string;
  readonly forecastInput: ProviderSourceCapacityModelInput;
  readonly forecast: ProviderSourceCapacityForecast;
}

interface DatabaseIdentityRow extends QueryResultRow {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly systemIdentifier: string;
  readonly serverAddress: string | null;
  readonly serverPort: number | null;
  readonly serverVersion: string;
  readonly dataDirectory: string;
}

export interface Task010DatabaseIdentity {
  readonly databaseName: string;
  readonly databaseOid: string;
  readonly systemIdentifier: string;
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly serverVersion: string;
  readonly dataDirectory: string;
}

export interface Task010CapacityReceipt {
  readonly version: "packscout.provider-source-task010-capacity-receipt.v1";
  readonly capacityArtifactVersion: string;
  readonly databaseIdentity: string;
  readonly volumePath: string;
  readonly databaseDataDirectory: string;
  readonly volumeDevice: string;
  readonly measuredAt: string;
  readonly input: Readonly<{
    volumeCapacityBytes: number;
    volumeAvailableBytes: number;
    unreconciledNonterminalAttemptCount: number;
  }>;
  readonly decision: ReturnType<typeof evaluateProviderSourceCapacityPreflight>;
}

function safeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
    throw new Task010SafetyError("CAPACITY_EXACT_BYTES_UNSUPPORTED");
  }
  return Number(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function loadCapacityArtifact(): Promise<CapacityArtifact> {
  let artifact: CapacityArtifact;
  try {
    artifact = JSON.parse(
      await readFile(
        new URL(
          "../../docs/provider-source-capacity-measurement-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as CapacityArtifact;
  } catch {
    throw new Task010SafetyError("CAPACITY_ARTIFACT_UNREADABLE");
  }
  const forecast = buildProviderSourceCapacityForecast(artifact.forecastInput);
  if (
    artifact.version !== "provider-source-capacity-measurement-v1" ||
    JSON.stringify(forecast) !== JSON.stringify(artifact.forecast)
  ) {
    throw new Task010SafetyError("CAPACITY_ARTIFACT_INVALID");
  }
  return artifact;
}

export async function openTask010Database(
  environment: Task010Environment,
): Promise<Client> {
  const client = new Client({ connectionString: environment.databaseUrl });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => undefined);
    throw new Task010SafetyError("DATABASE_CONNECTION_FAILED");
  }
}

export async function readTask010DatabaseIdentity(
  client: Client | PoolClient,
): Promise<Task010DatabaseIdentity> {
  const result = await client.query<DatabaseIdentityRow>(`
    select current_database() as "databaseName",
           database.oid::text as "databaseOid",
           control.system_identifier::text as "systemIdentifier",
           inet_server_addr()::text as "serverAddress",
           inet_server_port() as "serverPort",
           current_setting('server_version') as "serverVersion",
           current_setting('data_directory') as "dataDirectory"
    from pg_database as database
    cross join pg_control_system() as control
    where database.datname = current_database()
  `);
  const row = result.rows[0];
  if (
    !row ||
    row.serverAddress === null ||
    row.serverPort === null ||
    !Number.isInteger(row.serverPort)
  ) {
    throw new Task010SafetyError("DATABASE_IDENTITY_UNAVAILABLE");
  }
  return {
    databaseName: row.databaseName,
    databaseOid: row.databaseOid,
    systemIdentifier: row.systemIdentifier,
    serverAddress: row.serverAddress,
    serverPort: row.serverPort,
    serverVersion: row.serverVersion,
    dataDirectory: row.dataDirectory,
  };
}

export async function verifyTask010DatabaseIdentity(
  client: Client | PoolClient,
  environment: Task010Environment,
): Promise<
  Readonly<{
    identity: Task010DatabaseIdentity;
    fingerprint: string;
  }>
> {
  let identity: Task010DatabaseIdentity;
  try {
    identity = await readTask010DatabaseIdentity(client);
  } catch (error) {
    if (error instanceof Task010SafetyError) throw error;
    throw new Task010SafetyError("DATABASE_IDENTITY_UNAVAILABLE");
  }
  return {
    identity,
    fingerprint: assertTask010DatabaseIdentity(identity, environment),
  };
}

export async function listTask010UserRelations(
  client: Client | PoolClient,
): Promise<readonly string[]> {
  const result = await client.query<{ relationName: string }>(`
    select namespace.nspname || '.' || relation.relname as "relationName"
    from pg_class as relation
    join pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname not in ('pg_catalog', 'information_schema')
      and namespace.nspname !~ '^pg_toast'
      and relation.relkind in ('r', 'p', 'v', 'm', 'f')
    order by namespace.nspname, relation.relname
  `);
  return result.rows.map(({ relationName }) => relationName);
}

export async function assertTask010TargetEmpty(
  client: Client | PoolClient,
): Promise<void> {
  const relations = await listTask010UserRelations(client);
  if (relations.length !== 0) {
    throw new Task010SafetyError("DATABASE_TARGET_NOT_EMPTY");
  }
}

export async function verifyTask010MigratedSchema(
  client: Client | PoolClient,
): Promise<void> {
  try {
    const result = await client.query<{
      migrationName: string;
      checksum: string;
      finishedAt: Date | null;
      rolledBackAt: Date | null;
      tableCount: number;
    }>(
      `
      select migration.migration_name as "migrationName",
             migration.checksum,
             migration.finished_at as "finishedAt",
             migration.rolled_back_at as "rolledBackAt",
             (
               select count(*)::integer
               from pg_class as relation
               join pg_namespace as namespace
                 on namespace.oid = relation.relnamespace
               where namespace.nspname = 'public'
                 and relation.relkind = 'r'
                 and relation.relname <> '_prisma_migrations'
             ) as "tableCount"
      from public."_prisma_migrations" as migration
      where migration.migration_name = $1
      order by migration.started_at desc
      limit 1
    `,
      [TASK010_REQUIRED_MIGRATION.name],
    );
    assertTask010MigratedSchema(result.rows[0]);
  } catch (error) {
    if (error instanceof Task010SafetyError) throw error;
    throw new Task010SafetyError("SCHEMA_NOT_READY");
  }
}

async function countUnreconciledAttempts(
  client: Client | PoolClient,
  schemaReady: boolean,
): Promise<number> {
  if (!schemaReady) return 0;
  const result = await client.query<{ count: string }>(`
    select count(*)::text as count
    from public.source_request_attempts
    where state = 'in_flight'
  `);
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Task010SafetyError("UNRECONCILED_ATTEMPT_COUNT_INVALID");
  }
  return count;
}

export async function createTask010CapacityReceipt(
  input: Readonly<{
    client: Client | PoolClient;
    environment: Task010Environment;
    databaseIdentity: string;
    databaseDataDirectory: string;
    schemaReady: boolean;
  }>,
): Promise<Task010CapacityReceipt> {
  const artifact = await loadCapacityArtifact();
  let volumePath: string;
  let databaseDataDirectory: string;
  let volumeEntry;
  let databaseDirectoryEntry;
  try {
    volumePath = await realpath(input.environment.databaseVolumePath);
    databaseDataDirectory = await realpath(input.databaseDataDirectory);
    volumeEntry = await stat(volumePath, { bigint: true });
    databaseDirectoryEntry = await stat(databaseDataDirectory, {
      bigint: true,
    });
    if (
      !volumeEntry.isDirectory() ||
      volumePath === path.parse(volumePath).root
    ) {
      throw new Error("invalid");
    }
    if (!databaseDirectoryEntry.isDirectory()) throw new Error("invalid");
  } catch {
    throw new Task010SafetyError("CAPACITY_VOLUME_PATH_INVALID");
  }
  assertTask010VolumeBinding({
    configuredPath: volumePath,
    dataDirectoryPath: databaseDataDirectory,
    configuredDevice: volumeEntry.dev.toString(),
    dataDirectoryDevice: databaseDirectoryEntry.dev.toString(),
    separator: path.sep,
  });
  let filesystem;
  try {
    filesystem = await statfs(databaseDataDirectory, { bigint: true });
  } catch {
    throw new Task010SafetyError("CAPACITY_VOLUME_PROBE_FAILED");
  }
  const blockSize = safeInteger(filesystem.bsize);
  const capacityBytes = safeInteger(filesystem.blocks * BigInt(blockSize));
  const availableBytes = safeInteger(filesystem.bavail * BigInt(blockSize));
  const unreconciledAttemptCount = await countUnreconciledAttempts(
    input.client,
    input.schemaReady,
  );
  const decision = evaluateProviderSourceCapacityPreflight(artifact.forecast, {
    volumeCapacityBytes: capacityBytes,
    volumeAvailableBytes: availableBytes,
    unreconciledNonterminalAttemptCount: unreconciledAttemptCount,
  });
  return {
    version: "packscout.provider-source-task010-capacity-receipt.v1",
    capacityArtifactVersion: artifact.version,
    databaseIdentity: input.databaseIdentity,
    volumePath,
    databaseDataDirectory,
    volumeDevice: databaseDirectoryEntry.dev.toString(),
    measuredAt: new Date().toISOString(),
    input: {
      volumeCapacityBytes: capacityBytes,
      volumeAvailableBytes: availableBytes,
      unreconciledNonterminalAttemptCount: unreconciledAttemptCount,
    },
    decision,
  };
}

export function assertTask010CapacityApproved(
  receipt: Task010CapacityReceipt,
): void {
  if (receipt.decision.decision !== "approved") {
    throw new Task010SafetyError("CAPACITY_PREFLIGHT_REJECTED");
  }
}

async function exactTableCounts(
  client: Client | PoolClient,
): Promise<Readonly<Record<string, number>>> {
  const tables = await client.query<{ tableName: string }>(`
    select table_name as "tableName"
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
      and table_name <> '_prisma_migrations'
    order by table_name
  `);
  const counts: Record<string, number> = {};
  for (const { tableName } of tables.rows) {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from public.${quoteIdentifier(tableName)}`,
    );
    const count = Number(result.rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Task010SafetyError("DATABASE_ROW_COUNT_INVALID");
    }
    counts[tableName] = count;
  }
  return counts;
}

export async function readTask010BootstrapSnapshot(
  client: Client | PoolClient,
  environment: Task010Environment,
) {
  const [organizations, administrators, providers, marker] = await Promise.all([
    client.query<{ id: string; slug: string }>(`
      select id::text, slug from public.organizations order by id
    `),
    client.query<{
      id: string;
      organizationId: string;
      email: string;
      role: string;
      state: string;
    }>(`
      select operator.id::text,
             membership.organization_id::text as "organizationId",
             operator.email_normalized as email,
             membership.role::text,
             operator.state::text
      from public.operators as operator
      join public.operator_memberships as membership
        on membership.operator_id = operator.id
      order by operator.id
    `),
    client.query<{
      id: string;
      organizationId: string;
      platformKey: string;
      displayName: string;
      state: string;
      activeRevisionId: string | null;
      nextRunAt: Date | null;
    }>(`
      select id::text,
             organization_id::text as "organizationId",
             platform_key as "platformKey",
             display_name as "displayName",
             state::text,
             active_revision_id::text as "activeRevisionId",
             next_run_at as "nextRunAt"
      from public.provider_sources
      order by platform_key
    `),
    client.query<{ metadata: unknown }>(
      `
      select metadata_json as metadata
      from public.audit_events
      where organization_id = $1::uuid
        and action = $2
        and subject_type = 'organization'
        and subject_id = $1::uuid
        and outcome = 'success'
      order by occurred_at, id
    `,
      [environment.organizationId, TASK010_BOOTSTRAP_ACTION],
    ),
  ]);
  return {
    organizations: organizations.rows,
    administrators: administrators.rows,
    providers: providers.rows,
    markerCount: marker.rowCount ?? 0,
    markerMetadata: marker.rows[0]?.metadata,
  };
}

export async function verifyTask010Bootstrap(
  client: Client | PoolClient,
  environment: Task010Environment,
  databaseIdentity: string,
  capacityReceipt?: Task010CapacityReceipt,
): Promise<void> {
  const snapshot = await readTask010BootstrapSnapshot(client, environment);
  assertTask010BootstrapSnapshot(snapshot, {
    ...environment,
    databaseIdentity,
    capacityReceipt,
  });
}

export async function bootstrapTask010Target(
  input: Readonly<{
    client: Client;
    environment: Task010Environment;
    passwordHash?: string;
    databaseIdentity: string;
    capacityReceipt: Task010CapacityReceipt;
  }>,
): Promise<"created" | "already_present"> {
  await input.client.query("begin isolation level serializable");
  try {
    await input.client.query("select pg_advisory_xact_lock(hashtext($1))", [
      TASK010_BOOTSTRAP_ACTION,
    ]);
    const marker = await input.client.query<{ count: string }>(
      `
      select count(*)::text as count
      from public.audit_events
      where organization_id = $1::uuid
        and action = $2
        and subject_type = 'organization'
        and subject_id = $1::uuid
        and outcome = 'success'
    `,
      [input.environment.organizationId, TASK010_BOOTSTRAP_ACTION],
    );
    if (Number(marker.rows[0]?.count) > 0) {
      await verifyTask010Bootstrap(
        input.client,
        input.environment,
        input.databaseIdentity,
        input.capacityReceipt,
      );
      await input.client.query("commit");
      return "already_present";
    }

    const counts = await exactTableCounts(input.client);
    const populated = Object.entries(counts).filter(([, count]) => count !== 0);
    if (populated.length !== 0) {
      throw new Task010SafetyError("MIGRATED_DATABASE_NOT_EMPTY");
    }
    if (!input.passwordHash) {
      throw new Task010SafetyError(
        "ADMIN_PASSWORD_REQUIRED_FOR_FIRST_BOOTSTRAP",
      );
    }

    await input.client.query(
      `
      insert into public.organizations (id, slug, name)
      values ($1::uuid, $2, $3)
    `,
      [
        input.environment.organizationId,
        input.environment.organizationSlug,
        input.environment.organizationName,
      ],
    );
    await input.client.query(
      `
      insert into public.operators
        (id, email_normalized, display_name, password_hash, state)
      values ($1::uuid, $2, $3, $4, 'active')
    `,
      [
        input.environment.administratorId,
        input.environment.administratorEmail,
        input.environment.administratorDisplayName,
        input.passwordHash,
      ],
    );
    await input.client.query(
      `
      insert into public.operator_memberships
        (organization_id, operator_id, role)
      values ($1::uuid, $2::uuid, 'admin')
    `,
      [input.environment.organizationId, input.environment.administratorId],
    );
    for (const provider of TASK010_PROVIDER_IDENTITIES) {
      await input.client.query(
        `
        insert into public.provider_sources
          (id, organization_id, platform_key, display_name, state)
        values ($1::uuid, $2::uuid, $3, $4, 'draft')
      `,
        [
          provider.id,
          input.environment.organizationId,
          provider.platformKey,
          provider.displayName,
        ],
      );
    }
    const actorKey = `actor:v1:${createHmac(
      "sha256",
      Buffer.from(input.environment.actorKeyBase64, "base64"),
    )
      .update(
        `${TASK010_SAFETY_VERSION}\0${input.environment.organizationId}\0${input.environment.administratorId}`,
      )
      .digest("hex")}`;
    await input.client.query(
      `
      insert into public.audit_events
        (organization_id, actor_key, action, subject_type, subject_id,
         outcome, metadata_json)
      values ($1::uuid, $2, $3, 'organization', $1::uuid,
              'success', $4::jsonb)
    `,
      [
        input.environment.organizationId,
        actorKey,
        TASK010_BOOTSTRAP_ACTION,
        JSON.stringify({
          version: TASK010_SAFETY_VERSION,
          databaseIdentity: input.databaseIdentity,
          migrationName: TASK010_REQUIRED_MIGRATION.name,
          migrationChecksum: TASK010_REQUIRED_MIGRATION.checksum,
          capacityArtifactVersion:
            input.capacityReceipt.capacityArtifactVersion,
          capacityDecision: input.capacityReceipt.decision.decision,
          capacityMeasuredAt: input.capacityReceipt.measuredAt,
          capacityVolumeDevice: input.capacityReceipt.volumeDevice,
          capacityVolumePath: input.capacityReceipt.volumePath,
          capacityDatabaseDataDirectory:
            input.capacityReceipt.databaseDataDirectory,
          capacityRequiredAvailableBytes:
            input.capacityReceipt.decision.requiredAvailableBytes,
          capacityMeasuredAvailableBytes:
            input.capacityReceipt.input.volumeAvailableBytes,
        }),
      ],
    );
    await verifyTask010Bootstrap(
      input.client,
      input.environment,
      input.databaseIdentity,
      input.capacityReceipt,
    );
    await input.client.query("commit");
    return "created";
  } catch (error) {
    await input.client.query("rollback").catch(() => undefined);
    if (error instanceof Task010SafetyError) throw error;
    throw new Task010SafetyError("BOOTSTRAP_TRANSACTION_FAILED");
  }
}

const legacyRuntimeTables = [
  "provider_config_revisions",
  "provider_connection_tests",
  "provider_cursor_checkpoints",
  "provider_health_states",
  "provider_schedules",
  "provider_secret_versions",
] as const;

export async function verifyTask010SourceTopology(
  client: Client | PoolClient,
  environment: Task010Environment,
  options: Readonly<{ requireBackfillReady?: boolean }> = {},
): Promise<void> {
  for (const tableName of legacyRuntimeTables) {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from public.${quoteIdentifier(tableName)}`,
    );
    if (Number(result.rows[0]?.count) !== 0) {
      throw new Task010SafetyError("LEGACY_PROVIDER_RUNTIME_PRESENT");
    }
  }
  const profiles = await client.query<{
    id: string;
    sourceTypeKey: string;
    requestLimit: number;
    state: string;
    activeRevisionId: string | null;
  }>(
    `
    select id::text, source_type_key as "sourceTypeKey",
           request_limit as "requestLimit", state::text,
           active_revision_id::text as "activeRevisionId"
    from public.source_connection_profiles
    where organization_id = $1::uuid
  `,
    [environment.organizationId],
  );
  if (
    profiles.rows.length > 1 ||
    profiles.rows.some(
      (profile) =>
        profile.sourceTypeKey !== "dataforrest-events-v1" ||
        profile.requestLimit !== 2,
    )
  ) {
    throw new Task010SafetyError("SOURCE_CONNECTION_TOPOLOGY_INVALID");
  }
  const profile = profiles.rows[0];
  if (
    options.requireBackfillReady &&
    (profiles.rows.length !== 1 ||
      profile?.state !== "active" ||
      profile.activeRevisionId === null)
  ) {
    throw new Task010SafetyError("SOURCE_CONNECTION_NOT_BACKFILL_READY");
  }
  const foreignProfiles = await client.query<{ count: string }>(
    `
    select count(*)::text as count
    from public.source_connection_profiles
    where organization_id <> $1::uuid
  `,
    [environment.organizationId],
  );
  if (Number(foreignProfiles.rows[0]?.count) !== 0) {
    throw new Task010SafetyError("SOURCE_CONNECTION_TENANT_INVALID");
  }
  const keyVersions = await client.query<{ keyVersion: number }>(`
    select distinct encryption_key_version as "keyVersion"
    from public.source_connection_revisions
  `);
  if (
    keyVersions.rows.some(
      ({ keyVersion }) => keyVersion !== environment.sourceConnectionKeyVersion,
    )
  ) {
    throw new Task010SafetyError("SOURCE_CONNECTION_KEY_VERSION_MISMATCH");
  }
  if (options.requireBackfillReady) {
    const activeConnections = await client.query<{ count: string }>(
      `
      select count(*)::text as count
      from public.source_connection_profiles as profile
      join public.source_connection_revisions as revision
        on revision.id = profile.active_revision_id
       and revision.organization_id = profile.organization_id
       and revision.connection_profile_id = profile.id
      where profile.organization_id = $1::uuid
        and profile.state = 'active'
        and profile.source_type_key = 'dataforrest-events-v1'
        and profile.request_limit = 2
        and revision.state = 'active'
        and revision.source_type_key = 'dataforrest-events-v1'
        and revision.encryption_key_version = $2
    `,
      [environment.organizationId, environment.sourceConnectionKeyVersion],
    );
    if (Number(activeConnections.rows[0]?.count) !== 1) {
      throw new Task010SafetyError("SOURCE_CONNECTION_NOT_BACKFILL_READY");
    }
  }
  const sources = await client.query<{
    providerId: string;
    sourceTypeKey: string;
    sourceInstanceId: string;
    connectionProfileId: string;
    state: string;
    activeRevisionId: string | null;
  }>(`
    select provider_id::text as "providerId",
           source_type_key as "sourceTypeKey",
           id::text as "sourceInstanceId",
           connection_profile_id::text as "connectionProfileId",
           state::text,
           active_revision_id::text as "activeRevisionId"
    from public.provider_source_instances
    where state <> 'replaced'
  `);
  if (sources.rows.length > TASK010_PROVIDER_IDENTITIES.length) {
    throw new Task010SafetyError("PROVIDER_SOURCE_TOPOLOGY_INVALID");
  }
  const seenProviders = new Set<string>();
  for (const source of sources.rows) {
    if (
      source.sourceTypeKey !== "dataforrest-events-v1" ||
      !TASK010_PROVIDER_IDENTITIES.some(({ id }) => id === source.providerId) ||
      seenProviders.has(source.providerId)
    ) {
      throw new Task010SafetyError("PROVIDER_SOURCE_TOPOLOGY_INVALID");
    }
    seenProviders.add(source.providerId);
  }
  if (options.requireBackfillReady) {
    const readySources = await client.query<{ count: string }>(
      `
      select count(*)::text as count
      from public.provider_source_instances as source
      join public.provider_source_revisions as revision
        on revision.id = source.active_revision_id
       and revision.organization_id = source.organization_id
       and revision.provider_id = source.provider_id
       and revision.source_instance_id = source.id
      join public.provider_source_checkpoints as checkpoint
        on checkpoint.source_instance_id = source.id
       and checkpoint.organization_id = source.organization_id
       and checkpoint.provider_id = source.provider_id
       and checkpoint.source_revision_id = revision.id
      join public.provider_source_schedules as schedule
        on schedule.source_instance_id = source.id
       and schedule.organization_id = source.organization_id
       and schedule.provider_id = source.provider_id
      join public.provider_source_schedule_revisions as schedule_revision
        on schedule_revision.id = schedule.active_schedule_revision_id
       and schedule_revision.organization_id = source.organization_id
       and schedule_revision.source_instance_id = source.id
      where source.organization_id = $1::uuid
        and source.state in ('paused', 'active')
        and source.source_type_key = 'dataforrest-events-v1'
        and source.connection_profile_id = $2::uuid
        and revision.connection_profile_id = source.connection_profile_id
        and revision.source_type_key = source.source_type_key
        and schedule_revision.interval_seconds between 60 and 86400
        and schedule_revision.freshness_grace_seconds = 900
        and checkpoint.checkpoint_generation >= 1
    `,
      [environment.organizationId, profile?.id],
    );
    assertTask010BackfillTopologySnapshot({
      profileCount: profiles.rows.length,
      activeProfileCount: 1,
      sourceCount: sources.rows.length,
      readySourceCount: Number(readySources.rows[0]?.count),
      sources: sources.rows.map((source) => ({
        state: source.state,
        activeRevisionId: source.activeRevisionId,
        connectionProfileMatches: source.connectionProfileId === profile?.id,
      })),
    });
  }
  const invalidPins = await client.query<{ count: string }>(`
    with expected(provider_id, mapper_key, namespace_key) as (
      values
        ('9c2ef352-161a-4e5f-9d7d-6ff46755a101'::uuid,
         'courtyard-provider-observation', 'dataforrest-courtyard-records-v1'),
        ('9c2ef352-161a-4e5f-9d7d-6ff46755a102'::uuid,
         'collector-crypt-provider-observation', 'dataforrest-collector_crypt-records-v1'),
        ('9c2ef352-161a-4e5f-9d7d-6ff46755a103'::uuid,
         'phygitals-provider-observation', 'dataforrest-phygitals-records-v1'),
        ('9c2ef352-161a-4e5f-9d7d-6ff46755a104'::uuid,
         'clutchpacks-provider-observation', 'dataforrest-clutchpacks-records-v1')
    )
    select count(*)::text as count
    from public.provider_source_revisions as revision
    left join expected on expected.provider_id = revision.provider_id
    where expected.provider_id is null
       or revision.source_type_key <> 'dataforrest-events-v1'
       or revision.mapper_key <> expected.mapper_key
       or revision.mapper_version <> '1'
       or revision.identity_namespace_key <> expected.namespace_key
       or revision.normalized_contract_version <>
          'packscout.provider-observation.v1'
  `);
  if (Number(invalidPins.rows[0]?.count) !== 0) {
    throw new Task010SafetyError("PROVIDER_SOURCE_PINS_INVALID");
  }
}
