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
  connectionProfile: "56000000-0000-4000-8000-000000000020",
  source: "56000000-0000-4000-8000-000000000030",
  legacyScheduleRevision: "56000000-0000-4000-8000-000000000040",
  newScheduleRevision: "56000000-0000-4000-8000-000000000041",
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

async function seedLegacyScheduleRevision(database: Pool): Promise<void> {
  await database.query(`
    insert into public.organizations (id, slug, name)
    values ('${ids.organization}', 'records-per-request', 'Records Per Request');

    insert into public.provider_sources (
      id, organization_id, platform_key, display_name
    ) values (
      '${ids.provider}', '${ids.organization}', 'migration-test', 'Migration Test'
    );

    insert into public.source_connection_profiles (
      id, organization_id, source_type_key, connection_type_key, display_name,
      request_limit, created_by_actor_key
    ) values (
      '${ids.connectionProfile}', '${ids.organization}', 'http-feed-v1',
      'http-bearer-v1', 'Migration Test Connection', 1, 'operator:test'
    );

    insert into public.provider_source_instances (
      id, organization_id, provider_id, source_type_key,
      connection_profile_id, created_by_actor_key
    ) values (
      '${ids.source}', '${ids.organization}', '${ids.provider}', 'http-feed-v1',
      '${ids.connectionProfile}', 'operator:test'
    );

    insert into public.provider_source_schedule_revisions (
      id, organization_id, provider_id, source_instance_id, revision_number,
      created_by_actor_key, effective_at
    ) values (
      '${ids.legacyScheduleRevision}', '${ids.organization}', '${ids.provider}',
      '${ids.source}', 1, 'operator:test', '2026-08-26T08:00:00.000Z'
    );
  `);
}

test(
  "records-per-request migration preserves the legacy 250 limit and defaults new schedules to 500",
  { concurrency: false },
  async () => {
    const supported = await createPreRecordsPerRequestDatabase();
    try {
      await seedLegacyScheduleRevision(supported.database);
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
        { id: ids.legacyScheduleRevision, recordsPerRequest: 250 },
        { id: ids.newScheduleRevision, recordsPerRequest: 500 },
      ]);
    } finally {
      await supported.close();
    }
  },
);
