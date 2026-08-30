import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { ProviderSourceLifecycleRepository } from
  "../src/provider-source-lifecycle-repository.ts";
import { PipelineSetupRepository } from "../src/setup-repository.ts";
import { endPoolFully } from "./postgres-test-support.ts";

const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
  ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
const migrationName = "20260827010000_provider_source_platform_request_lanes";
const migrationsRoot = new URL("./migrations/", import.meta.url);
let databaseSequence = 0;

const ids = {
  organization: "57000000-0000-4000-8000-000000000001",
  provider: "57000000-0000-4000-8000-000000000002",
  epoch: "57000000-0000-4000-8000-000000000003",
  epochLease: "57000000-0000-4000-8000-000000000004",
  run: "57000000-0000-4000-8000-000000000005",
  runLease: "57000000-0000-4000-8000-000000000006",
  runClaimLease: "57000000-0000-4000-8000-000000000007",
  request: "57000000-0000-4000-8000-000000000008",
  requestLease: "57000000-0000-4000-8000-000000000009",
  snapshot: "57000000-0000-4000-8000-000000000010",
} as const;

async function migrationSql(name: string): Promise<string> {
  return readFile(new URL(`${name}/migration.sql`, migrationsRoot), "utf8");
}

async function createPreMigrationDatabase(): Promise<{
  database: Pool;
  prisma: PrismaClient;
  close(): Promise<void>;
}> {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  const databaseName =
    `packscout_request_lane_migration_${process.pid}_${++databaseSequence}`;
  if (!/^packscout_request_lane_migration_[0-9]+_[0-9]+$/.test(databaseName)) {
    throw new Error("refusing to create an unscoped test database");
  }

  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const socketHost = databaseUrl.searchParams.get("host");
  databaseUrl.search = "";
  if (socketHost?.startsWith("/")) databaseUrl.searchParams.set("host", socketHost);
  databaseUrl.hash = "";
  const database = new Pool({ connectionString: databaseUrl.toString(), max: 2 });
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl.toString() } },
  });

  try {
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < migrationName)
      .map((entry) => entry.name)
      .sort();
    for (const priorMigration of migrations) {
      await database.query(await migrationSql(priorMigration));
    }
    await prisma.$connect();
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    await endPoolFully(database).catch(() => undefined);
    await admin
      .query(`drop database if exists "${databaseName}" with (force)`)
      .catch(() => undefined);
    await endPoolFully(admin).catch(() => undefined);
    throw error;
  }

  return {
    database,
    prisma,
    close: async () => {
      await prisma.$disconnect();
      try {
        await endPoolFully(database);
        await admin.query(`drop database if exists "${databaseName}" with (force)`);
      } finally {
        await endPoolFully(admin);
      }
    },
  };
}

async function seedUpgradeFixture(
  database: Pool,
  prisma: PrismaClient,
): Promise<{
  connectionProfileId: string;
  connectionRevisionId: string;
  sourceInstanceId: string;
  sourceRevisionId: string;
}> {
  const setup = new PipelineSetupRepository(prisma);
  const lifecycle = new ProviderSourceLifecycleRepository(prisma);
  const createdAt = new Date("2026-08-27T01:00:00.000Z");
  await setup.createOrganization({
    id: ids.organization,
    slug: "request-lane-migration",
    name: "Request Lane Migration",
    createdAt,
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: "courtyard",
    displayName: "Courtyard",
    createdAt,
  });
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId: ids.organization,
    sourceTypeKey: "dataforrest-events-v1",
    connectionTypeKey: "dataforrest-events-connection-v1",
    displayName: "DataForrest",
    requestLimit: 2,
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array([1]),
    configurationNonce: new Uint8Array([2]),
    configurationAuthTag: new Uint8Array([3]),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator:test",
    createdAt,
  });
  const source = await lifecycle.createSourceInstanceRevision({
    organizationId: ids.organization,
    providerId: ids.provider,
    connectionProfileId: connection.profileId,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    normalizedContractVersion: "packscout.provider-observation.v1",
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-courtyard-records-v1",
    cursorCodecVersion: "dataforrest-cursor-v1",
    revisionNumber: 1,
    intervalSeconds: 60,
    configuration: { provider: "courtyard" },
    configurationHash: "b".repeat(64),
    recordIdScopes: ["catalog-pack-v1", "catalog-card-v1", "pull-v1", "trade-v1"],
    actorKey: "operator:test",
    createdAt,
  });

  const leaseExpiresAt = new Date("2026-08-27T02:00:00.000Z");
  await prisma.source_supervisor_epochs.create({
    data: {
      id: ids.epoch,
      environment_key: "request-lane-migration",
      epoch_number: 1n,
      owner_key: "migration-worker",
      lease_token: ids.epochLease,
      acquired_at: createdAt,
      last_renewed_at: createdAt,
      lease_expires_at: leaseExpiresAt,
      takeover_not_before: new Date("2026-08-27T02:00:15.000Z"),
    },
  });
  await prisma.import_runs.create({
    data: {
      id: ids.run,
      organization_id: ids.organization,
      provider_id: ids.provider,
      config_revision_id: null,
      trigger: "scheduled",
      state: "running",
      started_at: createdAt,
      heartbeat_at: createdAt,
      lease_owner: "migration-worker",
      lease_token: ids.runLease,
      claim_lease_id: ids.runClaimLease,
      lease_expires_at: leaseExpiresAt,
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      source_type_key: "dataforrest-events-v1",
      source_adapter_version: "dataforrest-events-adapter-v1",
      normalized_contract_version: "packscout.provider-observation.v1",
      mapper_key: "courtyard-provider-observation",
      mapper_version: "1",
      identity_namespace_key: "dataforrest-courtyard-records-v1",
      connection_profile_id: connection.profileId,
      connection_revision_id: connection.revisionId,
      cursor_codec_version: "dataforrest-cursor-v1",
      cursor_generation: 1n,
      requested_cursor: null,
      requested_cursor_fingerprint: null,
      requested_cursor_key: "initial",
      current_cursor: null,
      current_cursor_fingerprint: null,
      current_cursor_key: "initial",
      next_page_number: 1,
      created_at: createdAt,
    },
  });
  await prisma.provider_source_schedules.update({
    where: { source_instance_id: source.sourceInstanceId },
    data: {
      claim_owner: "migration-worker",
      claim_token: ids.runLease,
      claim_expires_at: leaseExpiresAt,
      last_claimed_at: createdAt,
      last_run_id: ids.run,
      updated_at: createdAt,
    },
  });
  await prisma.source_request_attempts.create({
    data: {
      id: ids.request,
      organization_id: ids.organization,
      operation_kind: "page_read",
      request_lease_id: ids.requestLease,
      claim_owner: "migration-worker",
      claim_token: ids.runLease,
      supervisor_epoch_id: ids.epoch,
      connection_profile_id: connection.profileId,
      connection_revision_id: connection.revisionId,
      expected_health_generation: 0n,
      provider_id: ids.provider,
      source_instance_id: source.sourceInstanceId,
      source_revision_id: source.sourceRevisionId,
      run_id: ids.run,
      page_number: 1,
      cursor_generation: 1n,
      requested_cursor_key: "initial",
      started_at: createdAt,
    },
  });
  await prisma.provider_source_runtime_states.update({
    where: { source_instance_id: source.sourceInstanceId },
    data: {
      supervisor_epoch_id: ids.epoch,
      phase: "waiting",
      activity: "waiting",
      wait_reason: "profile_capacity",
      current_run_id: ids.run,
      run_lease_acquired_at: createdAt,
      run_lease_expires_at: leaseExpiresAt,
      retry_attempt: 2,
      pages_committed: 3,
      records_committed: 750,
      run_started_at: createdAt,
      last_progress_at: createdAt,
      queued_at: createdAt,
      updated_at: createdAt,
    },
  });
  await database.query(`
    insert into public.source_supervisor_profile_states (
      id, supervisor_epoch_id, organization_id, connection_profile_id,
      approved_request_limit, active_request_permits, waiting_operations,
      updated_at
    ) values ($1, $2, $3, $4, 2, 1, 1, $5)
  `, [
    ids.snapshot,
    ids.epoch,
    ids.organization,
    connection.profileId,
    createdAt,
  ]);

  return {
    connectionProfileId: connection.profileId,
    connectionRevisionId: connection.revisionId,
    sourceInstanceId: source.sourceInstanceId,
    sourceRevisionId: source.sourceRevisionId,
  };
}

test("request-lane migration replaces only ephemeral capacity state", { concurrency: false }, async () => {
  const harness = await createPreMigrationDatabase();
  try {
    const fixture = await seedUpgradeFixture(harness.database, harness.prisma);
    const before = await Promise.all([
      harness.prisma.import_runs.findUniqueOrThrow({ where: { id: ids.run } }),
      harness.prisma.provider_source_schedules.findUniqueOrThrow({
        where: { source_instance_id: fixture.sourceInstanceId },
      }),
      harness.prisma.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: fixture.sourceInstanceId },
      }),
      harness.prisma.source_request_attempts.findUniqueOrThrow({
        where: { id: ids.request },
      }),
      harness.prisma.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: fixture.sourceInstanceId },
      }),
    ]);
    assert.equal((await harness.database.query(
      "select count(*)::integer as count from public.source_supervisor_profile_states",
    )).rows[0]?.count, 1);

    await harness.database.query(await migrationSql(migrationName));

    const after = await Promise.all([
      harness.prisma.import_runs.findUniqueOrThrow({ where: { id: ids.run } }),
      harness.prisma.provider_source_schedules.findUniqueOrThrow({
        where: { source_instance_id: fixture.sourceInstanceId },
      }),
      harness.prisma.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: fixture.sourceInstanceId },
      }),
      harness.prisma.source_request_attempts.findUniqueOrThrow({
        where: { id: ids.request },
      }),
      harness.prisma.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: fixture.sourceInstanceId },
      }),
    ]);
    assert.deepEqual(after.slice(0, 4), before.slice(0, 4));
    assert.deepEqual(
      { ...after[4], wait_reason: "profile_capacity" },
      before[4],
    );
    assert.equal(after[4].wait_reason, "request_lane_capacity");

    const tables = await harness.database.query<{
      oldTable: string | null;
      newTable: string | null;
      snapshotCount: number;
    }>(`
      select to_regclass('public.source_supervisor_profile_states')::text as "oldTable",
             to_regclass('public.source_supervisor_request_lane_states')::text as "newTable",
             (select count(*)::integer
              from public.source_supervisor_request_lane_states) as "snapshotCount"
    `);
    assert.deepEqual(tables.rows, [{
      oldTable: null,
      newTable: "source_supervisor_request_lane_states",
      snapshotCount: 0,
    }]);

    const constraints = await harness.database.query<{
      name: string;
      definition: string;
    }>(`
      select constraint_record.conname as name,
             pg_get_constraintdef(constraint_record.oid) as definition
      from pg_catalog.pg_constraint as constraint_record
      join pg_catalog.pg_class as table_record
        on table_record.oid = constraint_record.conrelid
      join pg_catalog.pg_namespace as namespace_record
        on namespace_record.oid = table_record.relnamespace
      where namespace_record.nspname = 'public'
        and table_record.relname = 'source_supervisor_request_lane_states'
      order by constraint_record.conname
    `);
    assert.deepEqual(constraints.rows.map((constraint) => constraint.name), [
      "source_supervisor_request_lane_states_capacity_check",
      "source_supervisor_request_lane_states_epoch_fk",
      "source_supervisor_request_lane_states_identity_check",
      "source_supervisor_request_lane_states_pkey",
      "source_supervisor_request_lane_states_profile_fk",
      "source_supervisor_request_lane_states_provider_fk",
      "source_supervisor_request_lane_states_scope_unique",
    ]);
    const definition = Object.fromEntries(
      constraints.rows.map((constraint) => [constraint.name, constraint.definition]),
    );
    assert.match(
      definition.source_supervisor_request_lane_states_capacity_check ?? "",
      /approved_request_limit >= 1.*approved_request_limit <= 2/s,
    );
    assert.match(
      definition.source_supervisor_request_lane_states_identity_check ?? "",
      /request_scope = 'platform'.*lane_key = \(provider_id\)::text.*request_scope = 'connection_test'.*lane_key = 'connection_test'/s,
    );
    assert.match(
      definition.source_supervisor_request_lane_states_provider_fk ?? "",
      /FOREIGN KEY \(provider_id, organization_id\) REFERENCES provider_sources\(id, organization_id\)/,
    );
    assert.match(
      definition.source_supervisor_request_lane_states_scope_unique ?? "",
      /UNIQUE \(supervisor_epoch_id, organization_id, connection_profile_id, lane_key\)/,
    );

    const indexes = await harness.database.query<{ name: string }>(`
      select indexname as name
      from pg_catalog.pg_indexes
      where schemaname = 'public'
        and tablename = 'source_supervisor_request_lane_states'
      order by indexname
    `);
    assert.deepEqual(indexes.rows.map((index) => index.name), [
      "source_supervisor_request_lane_states_pkey",
      "source_supervisor_request_lane_states_profile_idx",
      "source_supervisor_request_lane_states_scope_unique",
    ]);

    await assert.rejects(
      harness.database.query(`
        insert into public.source_supervisor_request_lane_states (
          supervisor_epoch_id, organization_id, connection_profile_id,
          request_scope, provider_id, lane_key, approved_request_limit,
          updated_at
        ) values ($1, $2, $3, 'platform', $4::uuid, ($4::uuid)::text, 3,
                  clock_timestamp())
      `, [ids.epoch, ids.organization, fixture.connectionProfileId, ids.provider]),
      /capacity_check|check constraint/i,
    );
    await harness.database.query(`
      insert into public.source_supervisor_request_lane_states (
        supervisor_epoch_id, organization_id, connection_profile_id,
        request_scope, provider_id, lane_key, approved_request_limit,
        active_request_permits, waiting_operations, updated_at
      ) values
        ($1, $2, $3, 'platform', $4::uuid, ($4::uuid)::text, 1, 1, 0,
         clock_timestamp()),
        ($1, $2, $3, 'connection_test', null, 'connection_test', 2, 0, 1,
         clock_timestamp())
    `, [ids.epoch, ids.organization, fixture.connectionProfileId, ids.provider]);
    await assert.rejects(
      harness.database.query(`
        insert into public.source_supervisor_request_lane_states (
          supervisor_epoch_id, organization_id, connection_profile_id,
          request_scope, provider_id, lane_key, approved_request_limit,
          updated_at
        ) values ($1, $2, $3, 'platform', $4::uuid, 'wrong-lane', 2,
                  clock_timestamp())
      `, [ids.epoch, ids.organization, fixture.connectionProfileId, ids.provider]),
      /identity_check|check constraint/i,
    );
  } finally {
    await harness.close();
  }
});
