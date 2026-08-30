import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { Pool } from "pg";
import { endPoolFully } from "./postgres-test-support.ts";

const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
  ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
const priorMigrationNames = [
  "20260812000000_clean_baseline",
  "20260815010000_public_change_settlement",
  "20260815020000_approved_public_catalog_configuration",
  "20260815030000_normalized_heat_observations",
  "20260815040000_catalog_promotion_ledger",
  "20260815050000_promotion_operational_readiness",
  "20260816010000_provider_catalog_settlement",
  "20260816020000_provider_manifest_promotion",
  "20260816030000_heat_manifest_alignment",
  "20260816040000_catalog_promotion_retention",
  "20260819000000_worker_presence",
  "20260819010000_buyback_ev_revisions",
  "20260820000000_machinery_alerts",
  "20260820010000_provider_source_persistence",
  "20260821010000_provider_source_admin_lifecycle",
  "20260821020000_provider_source_atomic_import",
  "20260821030000_provider_source_supervisor_runtime",
  "20260821040000_provider_source_page_plan_digest",
  "20260822000000_email_message_outbox",
  "20260823010000_email_link_tokens",
  "20260824000000_operator_invitations",
  "20260824100000_canonical_inspection_recency",
  "20260824223000_fix_normalized_text_vertical_tab",
  "20260825041000_raise_provider_source_raw_response_limit",
] as const;
const recordsPerRequestMigrationName =
  "20260826010000_provider_source_records_per_request";
let databaseSequence = 0;

const ids = {
  organization: "56000000-0000-4000-8000-000000000001",
  provider: "56000000-0000-4000-8000-000000000010",
  runningProvider: "56000000-0000-4000-8000-000000000011",
  providerConfigRevision: "56000000-0000-4000-8000-000000000012",
  connectionProfile: "56000000-0000-4000-8000-000000000020",
  connectionRevision: "56000000-0000-4000-8000-000000000021",
  source: "56000000-0000-4000-8000-000000000030",
  runningSource: "56000000-0000-4000-8000-000000000031",
  sourceRevision: "56000000-0000-4000-8000-000000000032",
  runningSourceRevision: "56000000-0000-4000-8000-000000000033",
  legacyScheduleRevision: "56000000-0000-4000-8000-000000000040",
  newScheduleRevision: "56000000-0000-4000-8000-000000000041",
  sourceTestJob: "56000000-0000-4000-8000-000000000050",
  queuedSourceRun: "56000000-0000-4000-8000-000000000060",
  runningSourceRun: "56000000-0000-4000-8000-000000000061",
  configOwnedRun: "56000000-0000-4000-8000-000000000062",
} as const;

function migrationUrl(migrationName: string): URL {
  return new URL(`./migrations/${migrationName}/migration.sql`, import.meta.url);
}

async function applyMigration(database: Pool, migrationName: string): Promise<void> {
  await database.query(await readFile(migrationUrl(migrationName), "utf8"));
}

async function createPreRecordsPerRequestDatabase(): Promise<{
  database: Pool;
  close(): Promise<void>;
}> {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  const databaseName =
    `packscout_records_per_request_${process.pid}_${++databaseSequence}`;
  if (!/^packscout_records_per_request_[0-9]+_[0-9]+$/.test(databaseName)) {
    throw new Error("refusing to create an unscoped test database");
  }
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const database = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
  try {
    for (const migrationName of priorMigrationNames) {
      await applyMigration(database, migrationName);
    }
  } catch (error) {
    try {
      await endPoolFully(database);
      await admin.query(`drop database if exists "${databaseName}" with (force)`);
    } finally {
      await endPoolFully(admin);
    }
    throw error;
  }
  return {
    database,
    close: async () => {
      try {
        await endPoolFully(database);
        await admin.query(`drop database if exists "${databaseName}" with (force)`);
      } finally {
        await endPoolFully(admin);
      }
    },
  };
}

async function seedPreMigrationPins(database: Pool): Promise<void> {
  await database.query(`
    insert into public.organizations (id, slug, name)
    values ('${ids.organization}', 'records-per-request', 'Records Per Request');

    insert into public.provider_sources (
      id, organization_id, platform_key, display_name
    ) values
      (
        '${ids.provider}', '${ids.organization}', 'migration-test',
        'Migration Test'
      ),
      (
        '${ids.runningProvider}', '${ids.organization}', 'migration-running',
        'Migration Running'
      );

    insert into public.provider_config_revisions (
      id, organization_id, provider_id, version, adapter_key, endpoint_url,
      auth_mode, created_by_actor_key
    ) values (
      '${ids.providerConfigRevision}', '${ids.organization}', '${ids.provider}',
      1, 'http-cursor-v1', 'https://legacy.example.test/feed', 'none',
      'operator:test'
    );

    insert into public.source_connection_profiles (
      id, organization_id, source_type_key, connection_type_key, display_name,
      request_limit, created_by_actor_key
    ) values (
      '${ids.connectionProfile}', '${ids.organization}', 'http-feed-v1',
      'http-bearer-v1', 'Migration Test Connection', 1, 'operator:test'
    );

    insert into public.source_connection_revisions (
      id, organization_id, connection_profile_id, revision_number,
      source_type_key, source_adapter_version, configuration_ciphertext,
      configuration_nonce, configuration_auth_tag, encryption_key_version,
      configuration_fingerprint, created_by_actor_key
    ) values (
      '${ids.connectionRevision}', '${ids.organization}',
      '${ids.connectionProfile}', 1, 'http-feed-v1', 'http-feed-adapter-v1',
      '\\x01', '\\x02', '\\x03', 1, repeat('a', 64), 'operator:test'
    );

    insert into public.provider_source_instances (
      id, organization_id, provider_id, source_type_key,
      connection_profile_id, created_by_actor_key
    ) values
      (
        '${ids.source}', '${ids.organization}', '${ids.provider}',
        'http-feed-v1', '${ids.connectionProfile}', 'operator:test'
      ),
      (
        '${ids.runningSource}', '${ids.organization}', '${ids.runningProvider}',
        'http-feed-v1', '${ids.connectionProfile}', 'operator:test'
      );

    insert into public.provider_source_revisions (
      id, organization_id, provider_id, source_instance_id,
      connection_profile_id, revision_number, source_type_key,
      source_adapter_version, normalized_contract_version, mapper_key,
      mapper_version, identity_namespace_key, cursor_codec_version,
      configuration_json, configuration_hash, record_id_scopes_json,
      created_by_actor_key
    ) values
      (
        '${ids.sourceRevision}', '${ids.organization}', '${ids.provider}',
        '${ids.source}', '${ids.connectionProfile}', 1, 'http-feed-v1',
        'http-feed-adapter-v1', 'packscout.provider-observation.v1',
        'migration-mapper', '1', 'migration-provider', 'http-cursor-v1',
        '{"provider":"migration-test"}', repeat('b', 64),
        '["catalog-pack-v1"]', 'operator:test'
      ),
      (
        '${ids.runningSourceRevision}', '${ids.organization}',
        '${ids.runningProvider}', '${ids.runningSource}',
        '${ids.connectionProfile}', 1, 'http-feed-v1',
        'http-feed-adapter-v1', 'packscout.provider-observation.v1',
        'migration-running-mapper', '1', 'migration-running-provider',
        'http-cursor-v1', '{"provider":"migration-running"}',
        repeat('c', 64), '["catalog-pack-v1"]', 'operator:test'
      );

    insert into public.provider_source_schedule_revisions (
      id, organization_id, provider_id, source_instance_id, revision_number,
      created_by_actor_key, effective_at
    ) values (
      '${ids.legacyScheduleRevision}', '${ids.organization}', '${ids.provider}',
      '${ids.source}', 1, 'operator:test', '2026-08-26T08:00:00.000Z'
    );

    insert into public.provider_source_test_jobs (
      id, organization_id, provider_id, source_instance_id,
      source_revision_id, connection_profile_id, connection_revision_id,
      expected_health_generation, requested_by_actor_key
    ) values (
      '${ids.sourceTestJob}', '${ids.organization}', '${ids.provider}',
      '${ids.source}', '${ids.sourceRevision}', '${ids.connectionProfile}',
      '${ids.connectionRevision}', 0, 'operator:test'
    );

    insert into public.import_runs (
      id, organization_id, provider_id, config_revision_id, trigger, state,
      started_at, finished_at, source_instance_id, source_revision_id,
      source_type_key, source_adapter_version, normalized_contract_version,
      mapper_key, mapper_version, identity_namespace_key,
      connection_profile_id, connection_revision_id, cursor_codec_version,
      cursor_generation, requested_cursor_key, current_cursor_key,
      next_page_number
    ) values
      (
        '${ids.queuedSourceRun}', '${ids.organization}', '${ids.provider}', null,
        'scheduled', 'queued', null, null, '${ids.source}',
        '${ids.sourceRevision}', 'http-feed-v1', 'http-feed-adapter-v1',
        'packscout.provider-observation.v1', 'migration-mapper', '1',
        'migration-provider', '${ids.connectionProfile}',
        '${ids.connectionRevision}', 'http-cursor-v1', 1, 'initial', 'initial', 1
      ),
      (
        '${ids.runningSourceRun}', '${ids.organization}',
        '${ids.runningProvider}', null, 'scheduled', 'running',
        '2026-08-26T08:05:00.000Z', null, '${ids.runningSource}',
        '${ids.runningSourceRevision}', 'http-feed-v1',
        'http-feed-adapter-v1', 'packscout.provider-observation.v1',
        'migration-running-mapper', '1', 'migration-running-provider',
        '${ids.connectionProfile}', '${ids.connectionRevision}',
        'http-cursor-v1', 1, 'initial', 'initial', 1
      ),
      (
        '${ids.configOwnedRun}', '${ids.organization}', '${ids.provider}',
        '${ids.providerConfigRevision}', 'scheduled', 'succeeded',
        '2026-08-26T07:00:00.000Z', '2026-08-26T07:01:00.000Z',
        null, null, null, null, null, null, null, null, null, null, null,
        null, null, null, null
      );
  `);
}

test(
  "records-per-request migration backfills the current execution pins without pinning config-owned runs",
  { concurrency: false },
  async () => {
    const supported = await createPreRecordsPerRequestDatabase();
    try {
      await seedPreMigrationPins(supported.database);
      await applyMigration(supported.database, recordsPerRequestMigrationName);

      await supported.database.query(`
        insert into public.provider_source_schedule_revisions (
          id, organization_id, provider_id, source_instance_id, revision_number,
          created_by_actor_key, effective_at
        ) values (
          '${ids.newScheduleRevision}', '${ids.organization}', '${ids.provider}',
          '${ids.source}', 2, 'operator:test', '2026-08-26T09:00:00.000Z'
        )
      `);

      const scheduleRevisions = await supported.database.query<{
        id: string;
        recordsPerRequest: number;
      }>(`
        select id::text, records_per_request as "recordsPerRequest"
        from public.provider_source_schedule_revisions
        where id in ('${ids.legacyScheduleRevision}', '${ids.newScheduleRevision}')
        order by revision_number
      `);

      assert.deepEqual(scheduleRevisions.rows, [
        { id: ids.legacyScheduleRevision, recordsPerRequest: 500 },
        { id: ids.newScheduleRevision, recordsPerRequest: 500 },
      ]);

      const sourceTest = await supported.database.query<{
        id: string;
        recordsPerRequest: number;
      }>(`
        select id::text, records_per_request as "recordsPerRequest"
        from public.provider_source_test_jobs
        where id = '${ids.sourceTestJob}'
      `);
      assert.deepEqual(sourceTest.rows, [
        { id: ids.sourceTestJob, recordsPerRequest: 500 },
      ]);

      const importRuns = await supported.database.query<{
        id: string;
        state: string;
        sourceInstanceId: string | null;
        recordsPerRequest: number | null;
      }>(`
        select
          id::text,
          state::text,
          source_instance_id::text as "sourceInstanceId",
          records_per_request as "recordsPerRequest"
        from public.import_runs
        where id in (
          '${ids.queuedSourceRun}',
          '${ids.runningSourceRun}',
          '${ids.configOwnedRun}'
        )
        order by id
      `);
      assert.deepEqual(importRuns.rows, [
        {
          id: ids.queuedSourceRun,
          state: "queued",
          sourceInstanceId: ids.source,
          recordsPerRequest: 500,
        },
        {
          id: ids.runningSourceRun,
          state: "running",
          sourceInstanceId: ids.runningSource,
          recordsPerRequest: 500,
        },
        {
          id: ids.configOwnedRun,
          state: "succeeded",
          sourceInstanceId: null,
          recordsPerRequest: null,
        },
      ]);

      await assert.rejects(
        supported.database.query(`
          update public.provider_source_test_jobs
          set records_per_request = 251
          where id = '${ids.sourceTestJob}'
        `),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(
            error.message,
            /source-test records-per-request pin is immutable/u,
          );
          assert.equal((error as { code?: unknown }).code, "23514");
          assert.equal(
            (error as { constraint?: unknown }).constraint,
            "provider_source_test_jobs_records_per_request_immutable_guard",
          );
          return true;
        },
      );
      for (const runId of [ids.queuedSourceRun, ids.runningSourceRun]) {
        await assert.rejects(
          supported.database.query(`
            update public.import_runs
            set records_per_request = 251
            where id = '${runId}'
          `),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /source-owned import run pins are immutable/u);
            assert.equal((error as { code?: unknown }).code, "23514");
            assert.equal(
              (error as { constraint?: unknown }).constraint,
              "import_runs_source_pins_immutable_guard",
            );
            return true;
          },
        );
      }

      const preservedPins = await supported.database.query<{
        sourceTest: number;
        queuedRun: number;
        runningRun: number;
      }>(`
        select
          (select records_per_request
           from public.provider_source_test_jobs
           where id = '${ids.sourceTestJob}') as "sourceTest",
          (select records_per_request
           from public.import_runs
           where id = '${ids.queuedSourceRun}') as "queuedRun",
          (select records_per_request
           from public.import_runs
           where id = '${ids.runningSourceRun}') as "runningRun"
      `);
      assert.deepEqual(preservedPins.rows, [
        { sourceTest: 500, queuedRun: 500, runningRun: 500 },
      ]);
    } finally {
      await supported.close();
    }
  },
);
