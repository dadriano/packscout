import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { Pool } from "pg";
import { endPoolFully } from "./postgres-test-support.ts";

const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
  ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
const migrationName = "20260827020000_buyback_ev_provider_source_origin";
const migrationsRoot = new URL("./migrations/", import.meta.url);
let databaseSequence = 0;

async function migrationSql(name: string): Promise<string> {
  return readFile(new URL(`${name}/migration.sql`, migrationsRoot), "utf8");
}

async function createPreMigrationDatabase(): Promise<{
  database: Pool;
  close(): Promise<void>;
}> {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  const databaseName =
    `packscout_buyback_source_origin_${process.pid}_${++databaseSequence}`;
  if (!/^packscout_buyback_source_origin_[0-9]+_[0-9]+$/.test(databaseName)) {
    throw new Error("refusing to create an unscoped test database");
  }
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`create database "${databaseName}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  databaseUrl.search = "";
  databaseUrl.hash = "";
  const database = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
  try {
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < migrationName)
      .map((entry) => entry.name)
      .sort();
    for (const priorMigration of migrations) {
      await database.query(await migrationSql(priorMigration));
    }
  } catch (error) {
    await endPoolFully(database).catch(() => undefined);
    await admin
      .query(`drop database if exists "${databaseName}" with (force)`)
      .catch(() => undefined);
    await endPoolFully(admin).catch(() => undefined);
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

test("the source-native EV origin migration refuses an ambiguous legacy row", async () => {
  const harness = await createPreMigrationDatabase();
  try {
    await harness.database.query(`
      insert into public.organizations (id, slug, name)
      values ('58000000-0000-4000-8000-000000000001', 'ev-origin', 'EV Origin');
      insert into public.provider_sources (
        id, organization_id, platform_key, display_name
      ) values (
        '58000000-0000-4000-8000-000000000002',
        '58000000-0000-4000-8000-000000000001',
        'clutchpacks', 'ClutchPacks'
      );
      insert into public.provider_config_revisions (
        id, organization_id, provider_id, version, adapter_key,
        endpoint_url, auth_mode, created_by_actor_key
      ) values (
        '58000000-0000-4000-8000-000000000003',
        '58000000-0000-4000-8000-000000000001',
        '58000000-0000-4000-8000-000000000002',
        1, 'legacy-v1', 'https://provider.example/feed', 'none', 'operator:test'
      );
      insert into public.buyback_ev_revisions (
        organization_id, provider_id, configuration_revision_id,
        platform_key, product_key, product_revision_id,
        method_version, confidence_policy_version, lifecycle, status,
        revision_number, calculation_key, effective_fingerprint, result_hash,
        source_revision_id, observation_coherence, odds_source,
        used_closed_range_midpoint, calculated_at, data_as_of_state,
        freshness_state, internal_reasons, public_primary_reason
      ) values (
        '58000000-0000-4000-8000-000000000001',
        '58000000-0000-4000-8000-000000000002',
        '58000000-0000-4000-8000-000000000003',
        'clutchpacks', 'clutchpacks-pack-1', 'catalog-revision-1',
        'packscout-buyback-adjusted-ev-v1',
        'packscout-buyback-adjusted-ev-confidence-v1',
        'completed', 'unavailable', 1,
        repeat('a', 64), repeat('b', 64), repeat('c', 64),
        'catalog-revision-1', 'provider_revision', 'platform_published', false,
        '2026-08-27T12:00:00.000Z', 'unknown_source_time',
        'unknown_source_time', array['MISSING_SOURCE_TIME']::text[],
        'SOURCE_EVIDENCE_UNAVAILABLE'
      );
    `);
    await assert.rejects(
      harness.database.query(await migrationSql(migrationName)),
      (error: unknown) =>
        typeof error === "object" && error !== null &&
        "code" in error && error.code === "55000" &&
        "message" in error &&
        String(error.message).includes("buyback_ev_revisions must be empty"),
    );
    const columns = await harness.database.query<{ column_name: string }>(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'buyback_ev_revisions'
    `);
    const names = new Set(columns.rows.map(({ column_name }) => column_name));
    assert.equal(names.has("configuration_revision_id"), true);
    assert.equal(names.has("provider_source_revision_id"), false);
    assert.equal(
      Number((await harness.database.query(
        "select count(*)::integer as count from public.buyback_ev_revisions",
      )).rows[0]?.count),
      1,
    );
  } finally {
    await harness.close();
  }
});
