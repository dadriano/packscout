import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { Pool } from "pg";

const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
  ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
const priorMigrationNames = [
  "20260812000000_clean_baseline",
  "20260815010000_public_change_settlement",
  "20260815020000_approved_public_catalog_configuration",
  "20260815030000_normalized_heat_observations",
  "20260815040000_catalog_promotion_ledger",
  "20260815050000_promotion_operational_readiness",
] as const;
const providerSettlementMigrationName =
  "20260816010000_provider_catalog_settlement";
let databaseSequence = 0;

function migrationUrl(migrationName: string): URL {
  return new URL(`./migrations/${migrationName}/migration.sql`, import.meta.url);
}

async function applyMigration(database: Pool, migrationName: string): Promise<void> {
  await database.query(await readFile(migrationUrl(migrationName), "utf8"));
}

async function createPreProviderSettlementDatabase(): Promise<{
  database: Pool;
  close(): Promise<void>;
}> {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  const databaseName =
    `packscout_provider_settlement_${process.pid}_${++databaseSequence}`;
  if (!/^packscout_provider_settlement_[0-9]+_[0-9]+$/.test(databaseName)) {
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
    await database.end();
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
    throw error;
  }
  return {
    database,
    close: async () => {
      await database.end();
      await admin.query(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    },
  };
}

const organizationId = "54000000-0000-4000-8000-000000000001";
const alphaProviderId = "54000000-0000-4000-8000-000000000010";
const betaProviderId = "54000000-0000-4000-8000-000000000011";
const alphaRevisionId = "54000000-0000-4000-8000-000000000020";
const betaRevisionId = "54000000-0000-4000-8000-000000000021";
const runId = "54000000-0000-4000-8000-000000000030";
const pageId = "54000000-0000-4000-8000-000000000031";
const sourceRecordIds = [
  "54000000-0000-4000-8000-000000000040",
  "54000000-0000-4000-8000-000000000041",
  "54000000-0000-4000-8000-000000000042",
] as const;
const entityIds = [
  "54000000-0000-4000-8000-000000000050",
  "54000000-0000-4000-8000-000000000051",
  "54000000-0000-4000-8000-000000000052",
] as const;
const canonicalRevisionIds = [
  "54000000-0000-4000-8000-000000000060",
  "54000000-0000-4000-8000-000000000061",
  "54000000-0000-4000-8000-000000000062",
] as const;

const approvedConfiguration = {
  schemaVersion: "approved_public_catalog_v1",
  configurationKey: "catalog-r1",
  revision: 1,
  approvedAt: "2026-08-16T03:05:00.000Z",
  staleAfterSeconds: 900,
  confidencePolicy: {
    version: "confidence-v1",
    completeScoreBasisPoints: 9_000,
    partialScoreBasisPoints: 6_000,
    unknownScoreBasisPoints: 3_000,
    limitationPenaltyBasisPoints: 500,
  },
  publicAssetOrigins: ["https://alpha.example", "https://beta.example"],
  verifiedUsdStablecoins: [],
  categories: [],
  platforms: ["alpha", "beta"].map((platformKey, index) => ({
    platformKey,
    vendor: {
      publicVendorId: `55000000-0000-5000-8000-00000000000${index + 1}`,
      vendorKey: platformKey,
      displayName: platformKey.toUpperCase(),
      logoUrl: null,
      websiteUrl: `https://${platformKey}.example`,
      listingHosts: [`${platformKey}.example`],
      imageOrigins: [`https://${platformKey}.example`],
      referralParameters: [],
      publicPromo: null,
    },
    format: "repack",
    defaultPublicCategoryIds: [],
    categoryMappings: [],
    collectibleTypeMappings: [],
  })),
  repacks: [],
  collectibles: [],
};

async function seedAuthoritativeHistoricalCauses(database: Pool): Promise<void> {
  await database.query(`
    insert into public.organizations (id, slug, name)
    values ('${organizationId}', 'provider-upgrade', 'Provider Upgrade');

    insert into public.provider_sources (
      id, organization_id, platform_key, display_name, state, updated_at
    ) values
      ('${alphaProviderId}', '${organizationId}', 'alpha', 'Alpha', 'active',
       '2026-08-16T03:03:00.000Z'),
      ('${betaProviderId}', '${organizationId}', 'beta', 'Beta', 'disabled',
       '2026-08-16T03:04:00.000Z');

    insert into public.provider_config_revisions (
      id, organization_id, provider_id, version, adapter_key, endpoint_url,
      auth_mode, created_by_actor_key
    ) values
      ('${alphaRevisionId}', '${organizationId}', '${alphaProviderId}', 1,
       'http-cursor-v1', 'https://alpha.example/feed', 'bearer', 'operator:test'),
      ('${betaRevisionId}', '${organizationId}', '${betaProviderId}', 1,
       'http-cursor-v1', 'https://beta.example/feed', 'bearer', 'operator:test');

    update public.provider_sources
    set active_revision_id = case platform_key
      when 'alpha' then '${alphaRevisionId}'::uuid
      else '${betaRevisionId}'::uuid
    end
    where organization_id = '${organizationId}';

    insert into public.import_runs (
      id, organization_id, provider_id, config_revision_id, trigger
    ) values (
      '${runId}', '${organizationId}', '${alphaProviderId}',
      '${alphaRevisionId}', 'scheduled'
    );
    insert into public.import_pages (
      id, organization_id, provider_id, run_id, page_number, has_more,
      payload_hash, record_counts_json, expires_at
    ) values (
      '${pageId}', '${organizationId}', '${alphaProviderId}', '${runId}',
      1, false, 'page-hash', '{}', '2026-11-16T03:00:00.000Z'
    );
    insert into public.source_records (
      id, organization_id, provider_id, first_run_id, first_page_id,
      record_kind, external_id, source_time, collected_at, content_hash,
      expires_at
    ) values
      ('${sourceRecordIds[0]}', '${organizationId}', '${alphaProviderId}',
       '${runId}', '${pageId}', 'catalog', 'pack-1',
       '2026-08-16T03:00:00.000Z', '2026-08-16T03:00:00.000Z',
       'pack-hash', '2026-11-16T03:00:00.000Z'),
      ('${sourceRecordIds[1]}', '${organizationId}', '${alphaProviderId}',
       '${runId}', '${pageId}', 'pull', 'pull-1',
       '2026-08-16T03:01:00.000Z', '2026-08-16T03:01:00.000Z',
       'pull-hash', '2026-11-16T03:00:00.000Z'),
      ('${sourceRecordIds[2]}', '${organizationId}', '${alphaProviderId}',
       '${runId}', '${pageId}', 'catalog', 'asset-1',
       '2026-08-16T03:02:00.000Z', '2026-08-16T03:02:00.000Z',
       'asset-hash', '2026-11-16T03:00:00.000Z');

    insert into public.settled_public_watermarks (
      organization_id, next_sequence, settled_sequence, source_head_sequence,
      settled_at, source_head_at
    ) values (
      '${organizationId}', 7, 6, 6,
      '2026-08-16T03:05:00.000Z', '2026-08-16T03:05:00.000Z'
    );
    insert into public.public_change_causes (
      organization_id, sequence, change_kind, entity_key, source_key,
      source_revision_key, metadata_json, occurred_at,
      authoritative_transaction_id
    ) values
      ('${organizationId}', 1, 'provider_projection',
       'canonical:v1:${entityIds[0]}', 'alpha', '${alphaRevisionId}', '{}',
       '2026-08-16T03:00:00.000Z', 'historical-upgrade'),
      ('${organizationId}', 2, 'provider_projection',
       'canonical:v1:${entityIds[1]}', 'alpha', '${alphaRevisionId}', '{}',
       '2026-08-16T03:01:00.000Z', 'historical-upgrade'),
      ('${organizationId}', 3, 'relationship_resolution',
       'relationship:v1:cross-provider', 'alpha', '${alphaRevisionId}', '{}',
       '2026-08-16T03:02:00.000Z', 'historical-upgrade'),
      ('${organizationId}', 4, 'provider_lifecycle',
       'provider:v1:${alphaProviderId}', 'alpha', '${alphaRevisionId}',
       '{"providerId":"${alphaProviderId}","platformKey":"alpha","state":"active"}',
       '2026-08-16T03:03:00.000Z', 'historical-upgrade'),
      ('${organizationId}', 5, 'provider_lifecycle',
       'provider:v1:${betaProviderId}', 'beta', '${betaRevisionId}',
       '{"providerId":"${betaProviderId}","platformKey":"beta","state":"disabled"}',
       '2026-08-16T03:04:00.000Z', 'historical-upgrade'),
      ('${organizationId}', 6, 'public_configuration',
       'configuration:v1:catalog-r1', null, null, '{}',
       '2026-08-16T03:05:00.000Z', 'historical-upgrade');

    insert into public.canonical_entities (
      id, organization_id, platform_key, record_kind, external_id
    ) values
      ('${entityIds[0]}', '${organizationId}', 'alpha', 'pack', 'pack-1'),
      ('${entityIds[1]}', '${organizationId}', 'alpha', 'pull', 'pull-1'),
      ('${entityIds[2]}', '${organizationId}', 'alpha', 'catalog_asset', 'asset-1');
    insert into public.canonical_revisions (
      id, organization_id, entity_id, revision_number, source_record_id,
      content_json, content_hash, provenance_json, provenance_hash,
      source_updated_at, source_collected_at, public_change_sequence
    ) values
      ('${canonicalRevisionIds[0]}', '${organizationId}', '${entityIds[0]}', 1,
       '${sourceRecordIds[0]}', '{}', 'pack-hash', '{}', 'provenance-pack',
       '2026-08-16T03:00:00.000Z', '2026-08-16T03:00:00.000Z', 1),
      ('${canonicalRevisionIds[1]}', '${organizationId}', '${entityIds[1]}', 1,
       '${sourceRecordIds[1]}', '{}', 'pull-hash', '{}', 'provenance-pull',
       '2026-08-16T03:01:00.000Z', '2026-08-16T03:01:00.000Z', 2),
      ('${canonicalRevisionIds[2]}', '${organizationId}', '${entityIds[2]}', 1,
       '${sourceRecordIds[2]}', '{}', 'asset-hash', '{}', 'provenance-asset',
       '2026-08-16T03:02:00.000Z', '2026-08-16T03:02:00.000Z', 3);
    update public.canonical_entities as entity
    set current_revision_id = revision.id
    from public.canonical_revisions as revision
    where revision.entity_id = entity.id;

    insert into public.canonical_relationships (
      organization_id, source_entity_id, relationship_kind,
      target_platform_key, target_record_kind, target_external_id,
      created_public_change_sequence
    ) values (
      '${organizationId}', '${entityIds[2]}', 'references_pack',
      'beta', 'pack', 'beta-pack-1', 3
    );
  `);
  await database.query(`
    insert into public.approved_public_catalog_configurations (
      organization_id, configuration_key, revision, configuration_json,
      configuration_hash, approved_at, public_change_sequence
    ) values ($1, 'catalog-r1', 1, $2::jsonb, $3,
      '2026-08-16T03:05:00.000Z', 6)
  `, [organizationId, JSON.stringify(approvedConfiguration), "a".repeat(64)]);
}

test("provider settlement migration backfills authoritative historical impacts and rejects ambiguity", { concurrency: false }, async () => {
  const supported = await createPreProviderSettlementDatabase();
  try {
    await seedAuthoritativeHistoricalCauses(supported.database);
    await applyMigration(supported.database, providerSettlementMigrationName);
    const impacts = await supported.database.query<{
      sequence: number;
      providerKeys: string[];
      epochKey: string | null;
      lifecycleKey: string | null;
      lifecycleState: string | null;
    }>(`
      select cause_sequence::integer as sequence,
             provider_platform_keys as "providerKeys",
             shared_configuration_key as "epochKey",
             lifecycle_platform_key as "lifecycleKey",
             lifecycle_state::text as "lifecycleState"
      from public.public_change_catalog_impacts
      where organization_id = '${organizationId}'
      order by cause_sequence
    `);
    assert.deepEqual(impacts.rows, [
      { sequence: 1, providerKeys: ["alpha"], epochKey: null, lifecycleKey: null, lifecycleState: null },
      { sequence: 2, providerKeys: [], epochKey: null, lifecycleKey: null, lifecycleState: null },
      { sequence: 3, providerKeys: ["alpha", "beta"], epochKey: null, lifecycleKey: null, lifecycleState: null },
      { sequence: 4, providerKeys: ["alpha"], epochKey: null, lifecycleKey: "alpha", lifecycleState: "active" },
      { sequence: 5, providerKeys: [], epochKey: null, lifecycleKey: "beta", lifecycleState: "disabled" },
      { sequence: 6, providerKeys: ["alpha", "beta"], epochKey: "catalog-r1", lifecycleKey: null, lifecycleState: null },
    ]);
    const providerCheckpoints = await supported.database.query<{
      platformKey: string;
      settledSequence: number;
      sourceHeadSequence: number;
    }>(`
      select platform_key as "platformKey",
             settled_sequence::integer as "settledSequence",
             source_head_sequence::integer as "sourceHeadSequence"
      from public.provider_catalog_checkpoints
      where organization_id = '${organizationId}'
      order by platform_key
    `);
    assert.deepEqual(providerCheckpoints.rows, [
      { platformKey: "alpha", settledSequence: 6, sourceHeadSequence: 6 },
      { platformKey: "beta", settledSequence: 6, sourceHeadSequence: 6 },
    ]);
    const manifestCheckpoint = await supported.database.query<{
      settledSequence: number;
      sourceHeadSequence: number;
    }>(`
      select settled_sequence::integer as "settledSequence",
             source_head_sequence::integer as "sourceHeadSequence"
      from public.catalog_manifest_lifecycle_checkpoints
      where organization_id = '${organizationId}'
    `);
    assert.deepEqual(manifestCheckpoint.rows, [{
      settledSequence: 6,
      sourceHeadSequence: 6,
    }]);
  } finally {
    await supported.close();
  }

  const ambiguous = await createPreProviderSettlementDatabase();
  try {
    await ambiguous.database.query(`
      insert into public.organizations (id, slug, name)
      values ('${organizationId}', 'ambiguous-upgrade', 'Ambiguous Upgrade');
      insert into public.provider_sources (
        id, organization_id, platform_key, display_name, state
      ) values (
        '${alphaProviderId}', '${organizationId}', 'alpha', 'Alpha', 'active'
      );
      insert into public.settled_public_watermarks (
        organization_id, next_sequence, settled_sequence, source_head_sequence,
        settled_at, source_head_at
      ) values (
        '${organizationId}', 2, 1, 1,
        '2026-08-16T04:00:00.000Z', '2026-08-16T04:00:00.000Z'
      );
      insert into public.public_change_causes (
        organization_id, sequence, change_kind, entity_key, source_key,
        metadata_json, occurred_at, authoritative_transaction_id
      ) values (
        '${organizationId}', 1, 'manual_correction',
        'canonical:v1:ambiguous', 'alpha', '{}',
        '2026-08-16T04:00:00.000Z', 'ambiguous-upgrade'
      );
    `);
    await assert.rejects(
      applyMigration(ambiguous.database, providerSettlementMigrationName),
      /no authoritative catalog impact classification/i,
    );
    const migrationTable = await ambiguous.database.query<{ tableName: string | null }>(`
      select to_regclass('public.public_change_catalog_impacts')::text as "tableName"
    `);
    assert.equal(migrationTable.rows[0]?.tableName, null);
  } finally {
    await ambiguous.close();
  }
});
