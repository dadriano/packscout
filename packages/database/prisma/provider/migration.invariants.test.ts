import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const baselineMigrationPath = fileURLToPath(new URL(
  "./migrations/20260829000000_distributed_provider_baseline/migration.sql",
  import.meta.url,
));
const deferredRelationshipsMigrationPath = fileURLToPath(new URL(
  "./migrations/20260829120000_provider_fact_deferred_relationships/migration.sql",
  import.meta.url,
));
const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
  ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
const providerId = "92000000-0000-4000-8000-000000000001";
const categoryId = "92000000-0000-4000-8000-000000000002";
const releaseId = "92000000-0000-4000-8000-000000000003";
const badReleaseId = "92000000-0000-4000-8000-000000000004";
const staleOperationId = "92000000-0000-4000-8000-000000000005";
const finalizeOperationId = "92000000-0000-4000-8000-000000000006";
const receiptId = "92000000-0000-4000-8000-000000000007";
const runId = "92000000-0000-4000-8000-000000000008";
const configVersionId = "92000000-0000-4000-8000-000000000009";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

async function expectDatabaseError(
  action: Promise<unknown>,
  expectedMessage: RegExp,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.match(error instanceof Error ? error.message : String(error), expectedMessage);
    return true;
  });
}

async function createMigratedProviderDatabase(
  through: "baseline" | "latest" = "latest",
): Promise<{
  db: Client;
  providerKey: string;
  stop(): Promise<void>;
}> {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  const providerKey = `provider_inv_${process.pid}_${randomBytes(5).toString("hex")}`;
  const databaseName = `packscout_${providerKey}`;
  if (!/^packscout_provider_inv_[0-9]+_[0-9a-f]{10}$/.test(databaseName)) {
    throw new Error("refusing to create an unscoped provider test database");
  }
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`create database "${databaseName}"`);
    created = true;
  } catch (error) {
    await admin.end();
    throw error;
  }
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const db = new Client({ connectionString: databaseUrl.toString() });
  try {
    await db.connect();
    await db.query(await readFile(baselineMigrationPath, "utf8"));
    if (through === "latest") {
      await db.query(await readFile(deferredRelationshipsMigrationPath, "utf8"));
    }
  } catch (error) {
    await db.end().catch(() => undefined);
    if (created) await admin.query(`drop database "${databaseName}"`);
    await admin.end();
    throw error;
  }
  return {
    db,
    providerKey,
    stop: async () => {
      await db.end();
      if (created) {
        await admin.query(`drop database "${databaseName}"`);
        created = false;
      }
      await admin.end();
    },
  };
}

async function assertHeadPageMayRetainSourceCheckpoint(db: Client): Promise<void> {
  const constraint = await db.query<{ convalidated: boolean }>(`
    select convalidated
    from pg_constraint
    where conrelid = 'provider_run_pages'::regclass
      and conname = 'provider_run_pages_continuation_check'
  `);
  assert.deepEqual(constraint.rows, [{ convalidated: true }]);

  await db.query(`
    create temporary table provider_run_pages_continuation_probe
      (like provider_run_pages including constraints including defaults)
  `);
  await db.query(`
    insert into provider_run_pages_continuation_probe (
      id, provider_run_id, page_number, contract_version,
      next_cursor, next_cursor_hash, continuation, response_digest,
      record_count, catalog_record_count, pull_record_count,
      market_event_record_count, accepted_count, duplicate_count,
      quarantined_count, material_change_count, committed_at
    ) values (
      '90000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000002',
      1, 'v1', '{"checkpoint":"retained-at-head"}'::jsonb, '${hashA}',
      'head', '${hashA}', 0, 0, 0, 0, 0, 0, 0, 0, now()
    )
  `);
  await expectDatabaseError(
    db.query(`
      insert into provider_run_pages_continuation_probe (
        id, provider_run_id, page_number, contract_version,
        continuation, response_digest, record_count, catalog_record_count,
        pull_record_count, market_event_record_count, accepted_count,
        duplicate_count, quarantined_count, material_change_count, committed_at
      ) values (
        '90000000-0000-4000-8000-000000000003',
        '90000000-0000-4000-8000-000000000004',
        2, 'v1', 'more', '${hashB}', 0, 0, 0, 0, 0, 0, 0, 0, now()
      )
    `),
    /provider_run_pages_continuation_check/,
  );
  await db.query("drop table provider_run_pages_continuation_probe");
}

async function expectDeferredRelationshipMigrationRejectedBeforeFactDdl(
  db: Client,
  expectedMessage: RegExp,
): Promise<void> {
  // Removing the first fact-table trigger is a tripwire: if the migration
  // reaches its first fact DDL before evaluating the publication gate, PostgreSQL
  // reports the missing trigger instead of the expected precondition error.
  await db.query("drop trigger pulls_append_only_trigger on pulls");
  await expectDatabaseError(
    db.query(await readFile(deferredRelationshipsMigrationPath, "utf8")),
    expectedMessage,
  );
  await db.query("rollback");

  const addedFactColumns = await db.query<{ column_name: string }>(`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'pulls' and column_name in ('pack_key', 'item_count', 'row_version', 'updated_at'))
        or (table_name = 'pull_items' and column_name in ('collectible_key', 'row_version', 'updated_at'))
        or (table_name = 'market_events' and column_name in ('pack_key', 'collectible_key', 'row_version', 'updated_at'))
      )
    order by table_name, column_name
  `);
  assert.deepEqual(addedFactColumns.rows, []);
}

test("latest provider install permits a head page to retain its source checkpoint", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase();
  try {
    await assertHeadPageMayRetainSourceCheckpoint(harness.db);
  } finally {
    await harness.stop();
  }
});

test("provider runtime accepts safe nested configuration and rejects protected keys", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase();
  const { db, providerKey } = harness;
  const localProviderId = "91000000-0000-4000-8000-000000000001";
  const localConfigVersionId = "91000000-0000-4000-8000-000000000002";
  try {
    await db.query(
      "select initialize_provider_database_identity($1::uuid, $2::text)",
      [localProviderId, providerKey],
    );
    const safeConfiguration = {
      adapterKey: "local-capture-clutchpacks-v1",
      settings: {
        captureDirectory: "clutchpacks",
        lanes: [{ name: "catalog", enabled: true }],
      },
    };
    const updated = await db.query<{ cached_configuration: unknown }>(`
      update provider_runtime
      set cached_config_version_id = $1::uuid,
          cached_config_version_number = 1,
          cached_configuration = $2::jsonb,
          last_control_sync_at = now(),
          schedule_seconds = 300,
          row_version = row_version + 1
      where singleton_key = true
      returning cached_configuration
    `, [localConfigVersionId, JSON.stringify(safeConfiguration)]);
    assert.deepEqual(updated.rows[0]?.cached_configuration, safeConfiguration);

    await expectDatabaseError(
      db.query(`
        update provider_runtime
        set cached_configuration = $1::jsonb,
            row_version = row_version + 1
        where singleton_key = true
      `, [JSON.stringify({ settings: [{ token: "must-not-persist" }] })]),
      /provider_runtime_config_group_check/,
    );

    const commandId = "91000000-0000-4000-8000-000000000003";
    const localRunId = "91000000-0000-4000-8000-000000000004";
    await db.query(`
      begin;
      insert into control_commands (
        id, idempotency_key, command_type, expected_generation,
        requested_by_operator_id, correlation_id, requested_at
      ) values (
        '${commandId}', 'migration-link-regression', 'run', 0,
        '91000000-0000-4000-8000-000000000005',
        '91000000-0000-4000-8000-000000000006', now()
      );
      insert into provider_runs (
        id, control_command_id, idempotency_key, trigger, state,
        requested_by_operator_id, config_version_id,
        config_version_number, worker_fence, requested_at
      ) values (
        '${localRunId}', '${commandId}', 'command/${commandId}', 'manual',
        'queued', '91000000-0000-4000-8000-000000000005',
        '${localConfigVersionId}', 1, 0, now()
      );
      update control_commands
      set state = 'accepted', result = '{"outcome":"accepted"}'::jsonb,
          resulting_run_id = '${localRunId}', acknowledged_at = now(),
          row_version = row_version + 1
      where id = '${commandId}';
      commit;
    `);
    assert.equal((await db.query<{ linked: boolean }>(`
      select exists (
        select 1
        from control_commands command
        join provider_runs run
          on run.control_command_id = command.id
         and command.resulting_run_id = run.id
        where command.id = '${commandId}'
      ) as linked
    `)).rows[0]?.linked, true);
    await db.query(`
      update provider_runs
      set state = 'running', worker_fence = 1, started_at = now(),
          heartbeat_at = now(), last_progress_at = now(),
          row_version = row_version + 1
      where id = '${localRunId}'
    `);
    await expectDatabaseError(
      db.query(`
        update provider_runs
        set worker_fence = 2, row_version = row_version + 1
        where id = '${localRunId}'
      `),
      /provider_run_worker_fence_immutable/,
    );
  } finally {
    await harness.stop();
  }
});

test("provider writes are promotion-coupled, immutable, receipt-gated, and lease-fenced", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase();
  const { db, providerKey } = harness;
  try {
    await db.query(
      "select initialize_provider_database_identity($1::uuid, $2::text)",
      [providerId, providerKey],
    );
    const functionPrivileges = await db.query<{ owner_can_execute: boolean; public_revoked: boolean }>(`
      select
        has_function_privilege(
          current_user,
          'public.initialize_provider_database_identity(uuid,text)',
          'EXECUTE'
        ) as owner_can_execute,
        not exists (
          select 1
          from pg_proc function
          join pg_namespace namespace on namespace.oid = function.pronamespace
          cross join lateral aclexplode(
            coalesce(function.proacl, acldefault('f', function.proowner))
          ) privilege
          where namespace.nspname = 'public'
            and function.proname = 'initialize_provider_database_identity'
            and privilege.grantee = 0
            and privilege.privilege_type = 'EXECUTE'
        ) as public_revoked
    `);
    assert.deepEqual(functionPrivileges.rows[0], {
      owner_can_execute: true,
      public_revoked: true,
    });

    await db.query("begin");
    await db.query(`
      insert into categories (id, category_key, display_name)
      values ('${categoryId}', 'cards', 'Cards')
    `);
    await expectDatabaseError(
      db.query("commit"),
      /canonical_write_requires_promotion_change/,
    );
    await db.query("rollback");

    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 1 where singleton_key;
      insert into categories (id, category_key, display_name)
      values ('${categoryId}', 'cards', 'Cards');
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values (1, 'category', '${categoryId}', 1, 'upsert', now());
      commit;
    `);
    await expectDatabaseError(
      db.query(`delete from categories where id = '${categoryId}'`),
      /categories_delete_forbidden/,
    );

    await db.query("begin");
    await db.query(`
      update promotion_ledger set last_sequence = 2 where singleton_key;
      update categories
      set lifecycle = 'retired', retired_at = now(), row_version = 2
      where id = '${categoryId}';
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values (2, 'category', '${categoryId}', 2, 'retire', now());
    `);
    await db.query("commit");
    await expectDatabaseError(
      db.query(`
        update categories
        set lifecycle = 'active', retired_at = null, row_version = 3
        where id = '${categoryId}'
      `),
      /categories_retired_immutable/,
    );

    await db.query(`
      update provider_worker_states
      set lease_owner = 'import-worker-a',
          lease_fence = 1,
          heartbeat_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          row_version = 2
      where worker_role = 'import';
      insert into provider_runs (
        id, idempotency_key, trigger, state, config_version_id,
        config_version_number, worker_fence, requested_at, started_at
      ) values (
        '${runId}', 'stale-run', 'manual', 'running', '${configVersionId}',
        1, 1, now(), now()
      );
      update provider_worker_states
      set lease_owner = 'import-worker-b',
          lease_fence = 2,
          heartbeat_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          row_version = 3
      where worker_role = 'import';
    `);
    await expectDatabaseError(
      db.query(`
        insert into provider_run_pages (
          provider_run_id, page_number, contract_version, continuation,
          response_digest, record_count, catalog_record_count,
          pull_record_count, market_event_record_count, accepted_count,
          duplicate_count, quarantined_count, material_change_count, committed_at
        ) values (
          '${runId}', 1, 'v1', 'head', '${hashA}', 0, 0, 0, 0, 0, 0, 0, 0, now()
        )
      `),
      /stale_import_worker_fence/,
    );

    await db.query(`
      update provider_worker_states
      set lease_owner = 'promotion-worker-a',
          lease_fence = 1,
          heartbeat_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          row_version = 2
      where worker_role = 'promotion'
    `);
    await db.query(`
      insert into provider_releases (
        id, provider_id, provider_key, public_provider_id,
        through_change_sequence, catalog_version_id, catalog_content_hash,
        central_schema_version, correlation_event_sequence,
        correlation_snapshot_hash, public_profile_version_id,
        public_profile_hash, provider_schema_version, public_schema_version,
        category_count, repack_count, collectible_reference_count, chase_count,
        retired_repack_count, batch_count, content_hash, index_hash,
        last_successful_observation_at, data_as_of, stale_at, freshness
      ) values (
        '${badReleaseId}', '${providerId}', '${providerKey}', gen_random_uuid(),
        2, gen_random_uuid(), '${hashA}', 'distributed-central-v1', 1,
        '${hashA}', gen_random_uuid(), '${hashA}',
        'distributed-provider-v1', 'public-v1',
        1, 0, 0, 0, 0, 1, '${hashA}', '${hashB}',
        now() - interval '2 minutes', now() - interval '1 minute',
        now() + interval '1 hour', 'fresh'
      );
      insert into provider_release_batches (
        provider_release_id, batch_kind, batch_index, payload,
        record_count, byte_count, body_hash
      ) values ('${badReleaseId}', 'provider', 0, '{}', 1, 2, '${hashA}');
    `);
    await db.query("begin");
    await db.query(`
      update provider_releases
      set lifecycle = 'assembled', assembled_at = now()
      where id = '${badReleaseId}'
    `);
    await expectDatabaseError(
      db.query("commit"),
      /provider_release_batch_set_incomplete/,
    );
    await db.query("rollback");

    await db.query(`
      insert into provider_releases (
        id, provider_id, provider_key, public_provider_id,
        through_change_sequence, catalog_version_id, catalog_content_hash,
        central_schema_version, correlation_event_sequence,
        correlation_snapshot_hash, public_profile_version_id,
        public_profile_hash, provider_schema_version, public_schema_version,
        category_count, repack_count, collectible_reference_count, chase_count,
        retired_repack_count, batch_count, content_hash, index_hash,
        last_successful_observation_at, data_as_of, stale_at, freshness
      ) values (
        '${releaseId}', '${providerId}', '${providerKey}', gen_random_uuid(),
        2, gen_random_uuid(), '${hashB}', 'distributed-central-v1', 1,
        '${hashB}', gen_random_uuid(), '${hashB}',
        'distributed-provider-v1', 'public-v1',
        0, 0, 0, 0, 0, 1, '${hashB}', '${hashA}',
        now() - interval '2 minutes', now() - interval '1 minute',
        now() + interval '1 hour', 'fresh'
      );
      insert into provider_release_batches (
        provider_release_id, batch_kind, batch_index, payload,
        record_count, byte_count, body_hash
      ) values ('${releaseId}', 'provider', 0, '{}', 1, 2, '${hashA}');
      update provider_releases
      set lifecycle = 'assembled', assembled_at = now()
      where id = '${releaseId}';
      update provider_releases set lifecycle = 'publishing' where id = '${releaseId}';
    `);
    await db.query("begin");
    await db.query(`
      update provider_releases
      set lifecycle = 'complete', completed_at = now()
      where id = '${releaseId}'
    `);
    await expectDatabaseError(
      db.query("commit"),
      /provider_release_completion_receipt_missing/,
    );
    await db.query("rollback");

    await db.query(`
      insert into provider_publication_operations (
        id, provider_release_id, operation_kind, idempotency_key,
        request_digest, request_bytes, lease_fence, requested_at
      ) values (
        '${staleOperationId}', '${releaseId}', 'finalize', 'stale-finalize',
        '${hashA}', '{}'::bytea, 1, now()
      );
      update provider_worker_states
      set lease_owner = 'promotion-worker-b',
          lease_fence = 2,
          heartbeat_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          row_version = 3
      where worker_role = 'promotion';
    `);
    await expectDatabaseError(
      db.query(`
        update provider_publication_operations
        set state = 'accepted', attempt_count = 1,
            last_attempted_at = now(), completed_at = now()
        where id = '${staleOperationId}'
      `),
      /stale_promotion_worker_fence/,
    );

    await db.query(`
      insert into provider_publication_operations (
        id, provider_release_id, operation_kind, idempotency_key,
        request_digest, request_bytes, lease_fence, requested_at
      ) values (
        '${finalizeOperationId}', '${releaseId}', 'finalize', 'exact-finalize',
        '${hashB}', '{}'::bytea, 2, now()
      )
    `);
    await db.query("begin");
    await db.query(`
      update provider_publication_operations
      set state = 'accepted', attempt_count = 1,
          last_attempted_at = now(), completed_at = now()
      where id = '${finalizeOperationId}';
      insert into provider_publication_receipts (
        id, operation_id, provider_release_id, remote_receipt_id, outcome,
        response_digest, response_bytes, accepted_content_hash,
        accepted_record_count, received_at
      ) values (
        '${receiptId}', '${finalizeOperationId}', '${releaseId}',
        'exact-receipt', 'accepted', '${hashA}', '{}'::bytea,
        '${hashB}', 1, now()
      );
      update provider_releases
      set lifecycle = 'complete', completed_at = now()
      where id = '${releaseId}';
      update provider_publication_state
      set completed_release_id = '${releaseId}',
          completed_through_change_sequence = 2,
          completion_receipt_id = '${receiptId}',
          completed_at = now(), row_version = 2
      where singleton_key;
      update provider_change_consumers
      set last_confirmed_sequence = 2,
          confirmation_kind = 'provider_publication_receipt',
          confirmation_id = '${receiptId}', row_version = 2
      where consumer_key = 'provider_release';
    `);
    await db.query("commit");

    const completed = await db.query<{
      completed_release_id: string;
      last_confirmed_sequence: string;
      lifecycle: string;
    }>(`
      select release.lifecycle, state.completed_release_id,
             consumer.last_confirmed_sequence
      from provider_releases release
      cross join provider_publication_state state
      cross join provider_change_consumers consumer
      where release.id = '${releaseId}'
        and consumer.consumer_key = 'provider_release'
    `);
    assert.deepEqual(completed.rows[0], {
      lifecycle: "complete",
      completed_release_id: releaseId,
      last_confirmed_sequence: "2",
    });

    const fenceFunctions = await db.query<{ definition: string }>(`
      select pg_get_functiondef(oid) as definition
      from pg_proc
      where proname in (
        'packscout_assert_run_page_fence',
        'packscout_guard_publication_operation'
      )
    `);
    assert.equal(fenceFunctions.rowCount, 2);
    for (const row of fenceFunctions.rows) assert.match(row.definition, /FOR UPDATE/i);
  } finally {
    await harness.stop();
  }
});

test("provider deferred-relationship migration rejects an advanced change-consumer checkpoint before fact DDL", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase("baseline");
  try {
    await harness.db.query(`
      update provider_change_consumers
      set last_confirmed_sequence = 1,
          confirmation_kind = 'catalog_snapshot',
          confirmation_id = 'catalog-snapshot-1',
          row_version = row_version + 1
      where consumer_key = 'catalog_correlation'
    `);
    await expectDeferredRelationshipMigrationRejectedBeforeFactDdl(
      harness.db,
      /provider_fact_deferred_relationships_consumer_checkpoint_advanced/,
    );
  } finally {
    await harness.stop();
  }
});

test("provider deferred-relationship migration rejects an advanced publication checkpoint before fact DDL", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase("baseline");
  const { db, providerKey } = harness;
  try {
    await db.query(
      "select initialize_provider_database_identity($1::uuid, $2::text)",
      [providerId, providerKey],
    );
    await db.query(`
      update provider_worker_states
      set lease_owner = 'migration-gate-promotion-worker',
          lease_fence = 1,
          heartbeat_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          row_version = 2
      where worker_role = 'promotion';
      insert into provider_releases (
        id, provider_id, provider_key, public_provider_id,
        through_change_sequence, catalog_version_id, catalog_content_hash,
        central_schema_version, correlation_event_sequence,
        correlation_snapshot_hash, public_profile_version_id,
        public_profile_hash, provider_schema_version, public_schema_version,
        category_count, repack_count, collectible_reference_count, chase_count,
        retired_repack_count, batch_count, content_hash, index_hash,
        last_successful_observation_at, data_as_of, stale_at, freshness
      ) values (
        '${releaseId}', '${providerId}', '${providerKey}', gen_random_uuid(),
        1, gen_random_uuid(), '${hashB}', 'distributed-central-v1', 1,
        '${hashB}', gen_random_uuid(), '${hashB}',
        'distributed-provider-v1', 'public-v1',
        0, 0, 0, 0, 0, 1, '${hashB}', '${hashA}',
        now() - interval '2 minutes', now() - interval '1 minute',
        now() + interval '1 hour', 'fresh'
      );
      insert into provider_release_batches (
        provider_release_id, batch_kind, batch_index, payload,
        record_count, byte_count, body_hash
      ) values ('${releaseId}', 'provider', 0, '{}', 1, 2, '${hashA}');
      update provider_releases
      set lifecycle = 'assembled', assembled_at = now()
      where id = '${releaseId}';
      update provider_releases
      set lifecycle = 'publishing'
      where id = '${releaseId}';
      insert into provider_publication_operations (
        id, provider_release_id, operation_kind, idempotency_key,
        request_digest, request_bytes, lease_fence, requested_at
      ) values (
        '${finalizeOperationId}', '${releaseId}', 'finalize',
        'migration-gate-finalize', '${hashB}', '{}'::bytea, 1, now()
      )
    `);
    await db.query(`
      begin;
      update provider_publication_operations
      set state = 'accepted', attempt_count = 1,
          last_attempted_at = now(), completed_at = now()
      where id = '${finalizeOperationId}';
      insert into provider_publication_receipts (
        id, operation_id, provider_release_id, remote_receipt_id, outcome,
        response_digest, response_bytes, accepted_content_hash,
        accepted_record_count, received_at
      ) values (
        '${receiptId}', '${finalizeOperationId}', '${releaseId}',
        'migration-gate-receipt', 'accepted', '${hashA}', '{}'::bytea,
        '${hashB}', 1, now()
      );
      update provider_releases
      set lifecycle = 'complete', completed_at = now()
      where id = '${releaseId}';
      update provider_publication_state
      set completed_release_id = '${releaseId}',
          completed_through_change_sequence = 1,
          completion_receipt_id = '${receiptId}',
          completed_at = now(), row_version = 2
      where singleton_key;
      commit;
    `);
    await expectDeferredRelationshipMigrationRejectedBeforeFactDdl(
      db,
      /provider_fact_deferred_relationships_publication_checkpoint_advanced/,
    );
  } finally {
    await harness.stop();
  }
});

test("provider deferred-relationship migration rejects an existing release before fact DDL", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase("baseline");
  const { db, providerKey } = harness;
  try {
    await db.query(
      "select initialize_provider_database_identity($1::uuid, $2::text)",
      [providerId, providerKey],
    );
    await db.query(`
      insert into provider_releases (
        id, provider_id, provider_key, public_provider_id,
        through_change_sequence, catalog_version_id, catalog_content_hash,
        central_schema_version, correlation_event_sequence,
        correlation_snapshot_hash, public_profile_version_id,
        public_profile_hash, provider_schema_version, public_schema_version,
        category_count, repack_count, collectible_reference_count, chase_count,
        retired_repack_count, batch_count, content_hash, index_hash,
        last_successful_observation_at, data_as_of, stale_at, freshness
      ) values (
        '${badReleaseId}', '${providerId}', '${providerKey}', gen_random_uuid(),
        0, gen_random_uuid(), '${hashA}', 'distributed-central-v1', 0,
        '${hashA}', gen_random_uuid(), '${hashA}',
        'distributed-provider-v1', 'public-v1',
        0, 0, 0, 0, 0, 0, '${hashA}', '${hashB}',
        now() - interval '2 minutes', now() - interval '1 minute',
        now() + interval '1 hour', 'fresh'
      )
    `);
    await expectDeferredRelationshipMigrationRejectedBeforeFactDdl(
      db,
      /provider_fact_deferred_relationships_release_exists/,
    );
  } finally {
    await harness.stop();
  }
});

test("provider deferred-relationship migration preserves existing facts at zero downstream checkpoints", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase("baseline");
  const { db, providerKey } = harness;
  const localProviderId = "93000000-0000-4000-8000-000000000010";
  const packId = "93000000-0000-4000-8000-000000000001";
  const collectibleId = "93000000-0000-4000-8000-000000000002";
  const pullId = "93000000-0000-4000-8000-000000000003";
  const pullItemId = "93000000-0000-4000-8000-000000000004";
  const marketEventId = "93000000-0000-4000-8000-000000000005";
  const unresolvedPullId = "93000000-0000-4000-8000-000000000006";
  const unresolvedItemAId = "93000000-0000-4000-8000-000000000007";
  const unresolvedItemBId = "93000000-0000-4000-8000-000000000008";
  const providerRunId = "93000000-0000-4000-8000-000000000011";
  const providerRunPageId = "93000000-0000-4000-8000-000000000012";
  try {
    await db.query(
      "select initialize_provider_database_identity($1::uuid, $2::text)",
      [localProviderId, providerKey],
    );
    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 5 where singleton_key;
      insert into packs (
        id, pack_key, display_name, pack_format, availability,
        content_evidence, packscout_ev_model_version,
        packscout_ev_confidence_policy_version, source_updated_at
      ) values (
        '${packId}', 'upgrade-pack', 'Upgrade Pack', 'repack', 'available',
        'complete', 'model-v1', 'policy-v1', now()
      );
      insert into collectibles (
        id, collectible_key, collectible_type, display_name,
        normalized_name, data_as_of
      ) values (
        '${collectibleId}', 'upgrade-card', 'card',
        'Upgrade Card', 'upgrade card', now()
      );
      insert into pulls (
        id, pull_key, fact_digest, pack_id, occurred_at
      ) values (
        '${pullId}', 'upgrade-pull', '${hashA}', '${packId}', now()
      );
      insert into pull_items (
        id, pull_id, ordinal, collectible_id, quantity
      ) values (
        '${pullItemId}', '${pullId}', 1, '${collectibleId}', 1
      );
      insert into market_events (
        id, event_key, fact_digest, event_type, collectible_id, occurred_at
      ) values (
        '${marketEventId}', 'upgrade-event', '${hashB}', 'sale',
        '${collectibleId}', now()
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (1, 'pack', '${packId}', 1, 'upsert', now()),
        (2, 'collectible', '${collectibleId}', 1, 'upsert', now()),
        (3, 'pull', '${pullId}', 1, 'upsert', now()),
        (4, 'pull_item', '${pullItemId}', 1, 'upsert', now()),
        (5, 'market_event', '${marketEventId}', 1, 'upsert', now());
      commit;
    `);

    // The named review database received this check ahead of the migration;
    // the additive upgrade deliberately accepts that predecessor shape too.
    await db.query(`
      alter table pull_items
      add constraint pull_items_instance_collectible_check
      check (collectible_instance_id is null or collectible_id is not null)
    `);

    await db.query(`
      update provider_worker_states
      set lease_owner = 'upgrade-import-worker', lease_fence = 1,
          heartbeat_at = now(), lease_expires_at = now() + interval '10 minutes',
          row_version = 2
      where worker_role = 'import';
      insert into provider_runs (
        id, idempotency_key, trigger, state, config_version_id,
        config_version_number, worker_fence, requested_at, started_at
      ) values (
        '${providerRunId}', 'upgrade-quarantine-run', 'manual', 'running',
        '93000000-0000-4000-8000-000000000013', 1, 1, now(), now()
      );
    `);
    await db.query(`
      begin;
      insert into provider_run_pages (
        id, provider_run_id, page_number, contract_version, continuation,
        response_digest, record_count, catalog_record_count,
        pull_record_count, market_event_record_count, accepted_count,
        duplicate_count, quarantined_count, material_change_count, committed_at
      ) values (
        '${providerRunPageId}', '${providerRunId}', 1, 'v1', 'head',
        '${hashA}', 3, 0, 3, 0, 0, 0, 3, 0, now()
      );
      update provider_runs
      set reached_source_head = true, page_count = 1,
          pull_record_count = 3, quarantined_count = 3,
          heartbeat_at = now(), last_progress_at = now(), row_version = 2
      where id = '${providerRunId}';
      commit;
    `);
    await db.query(`
      insert into quarantine_records (
        provider_run_id, provider_run_page_id, record_index, record_kind,
        source_record_key, reason_code, sanitized_summary,
        candidate_schema_version
      ) values
        (
          '${providerRunId}', '${providerRunPageId}', 0, 'pull', null,
          'LEGACY_INVALID', 'Legacy quarantine one', 'v1'
        ),
        (
          '${providerRunId}', '${providerRunPageId}', 1, 'pull', null,
          'LEGACY_INVALID', 'Legacy quarantine two', 'v1'
        ),
        (
          '${providerRunId}', '${providerRunPageId}', 2, 'pull',
          'source:${hashA}', 'SOURCE_INVALID', 'Legacy source quarantine', 'v1'
        )
    `);

    const migrationBoundary = await db.query<{
      consumer_checkpoint: string;
      publication_checkpoint: string;
      release_count: number;
      promotion_head: string;
    }>(`
      select
        (select max(last_confirmed_sequence) from provider_change_consumers) as consumer_checkpoint,
        (
          select completed_through_change_sequence
          from provider_publication_state
          where singleton_key
        ) as publication_checkpoint,
        (select count(*)::int from provider_releases) as release_count,
        (select last_sequence from promotion_ledger where singleton_key) as promotion_head
    `);
    assert.deepEqual(migrationBoundary.rows[0], {
      consumer_checkpoint: "0",
      publication_checkpoint: "0",
      release_count: 0,
      promotion_head: "5",
    });

    await db.query(await readFile(deferredRelationshipsMigrationPath, "utf8"));
    await assertHeadPageMayRetainSourceCheckpoint(db);

    const preserved = await db.query<{
      pull_count: number;
      item_count: number;
      event_count: number;
      quarantine_count: number;
      null_quarantine_count: number;
      source_quarantine_terminal: boolean;
      pull_backfilled: boolean;
      item_backfilled: boolean;
      event_backfilled: boolean;
    }>(`
      select
        (select count(*)::int from pulls) as pull_count,
        (select count(*)::int from pull_items) as item_count,
        (select count(*)::int from market_events) as event_count,
        (select count(*)::int from quarantine_records) as quarantine_count,
        (
          select count(*)::int from quarantine_records
          where source_record_key is null
        ) as null_quarantine_count,
        exists (
          select 1 from quarantine_records
          where source_record_key = 'source:${hashA}'
            and state = 'expired' and evidence_expired_at is not null
            and normalized_candidate is null and protected_evidence is null
            and row_version = 2
        ) as source_quarantine_terminal,
        exists (
          select 1 from pulls
          where id = '${pullId}' and pack_id = '${packId}'
            and pack_key = 'upgrade-pack' and item_count = 1 and row_version = 1
            and updated_at = created_at
        ) as pull_backfilled,
        exists (
          select 1 from pull_items
          where id = '${pullItemId}' and collectible_id = '${collectibleId}'
            and collectible_key = 'upgrade-card' and row_version = 1
            and updated_at = created_at
        ) as item_backfilled,
        exists (
          select 1 from market_events
          where id = '${marketEventId}' and collectible_id = '${collectibleId}'
            and collectible_key = 'upgrade-card' and row_version = 1
            and updated_at = created_at
        ) as event_backfilled
    `);
    assert.deepEqual(preserved.rows[0], {
      pull_count: 1,
      item_count: 1,
      event_count: 1,
      quarantine_count: 3,
      null_quarantine_count: 2,
      source_quarantine_terminal: true,
      pull_backfilled: true,
      item_backfilled: true,
      event_backfilled: true,
    });

    await expectDatabaseError(
      db.query(`
        insert into quarantine_records (
          provider_run_id, provider_run_page_id, record_index, record_kind,
          source_record_key, reason_code, sanitized_summary,
          candidate_schema_version
        ) values (
          '${providerRunId}', '${providerRunPageId}', 3, 'pull',
          'source:${hashA}', 'SOURCE_INVALID', 'Repeated source quarantine', 'v1'
        )
      `),
      /quarantine_records_source_record_key_key/,
    );

    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 8 where singleton_key;
      savepoint provider_record;
      insert into pulls (
        id, pull_key, fact_digest, pack_key, item_count, occurred_at
      ) values (
        '${unresolvedPullId}', 'new-unresolved-pull', '${hashA}',
        'future-pack', 2, now()
      );
      insert into pull_items (
        id, pull_id, ordinal, collectible_key, quantity
      ) values
        ('${unresolvedItemAId}', '${unresolvedPullId}', 1, 'future-card', 1),
        ('${unresolvedItemBId}', '${unresolvedPullId}', 2, null, 1);
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (6, 'pull', '${unresolvedPullId}', 1, 'upsert', now()),
        (7, 'pull_item', '${unresolvedItemAId}', 1, 'upsert', now()),
        (8, 'pull_item', '${unresolvedItemBId}', 1, 'upsert', now());
      release savepoint provider_record;
      commit;
    `);
    assert.equal((await db.query<{ count: number }>(`
      select count(*)::int as count
      from pull_items where pull_id = '${unresolvedPullId}'
    `)).rows[0]?.count, 2);

    await expectDatabaseError(
      db.query(`
        insert into pull_items (
          id, pull_id, ordinal, collectible_key, quantity
        ) values (
          '93000000-0000-4000-8000-000000000009',
          '${unresolvedPullId}', 3, 'late-card', 1
        )
      `),
      /pull_item_count_mismatch/,
    );
  } finally {
    await harness.stop();
  }
});

test("provider deferred-relationship migration normalizes the already-relaxed predecessor", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase("baseline");
  try {
    await harness.db.query(`
      alter table provider_run_pages
        drop constraint provider_run_pages_continuation_check;
      alter table provider_run_pages
        add constraint provider_run_pages_continuation_check check (
          continuation = 'head'
          or (continuation = 'more' and next_cursor is not null)
        );
    `);
    await harness.db.query(
      await readFile(deferredRelationshipsMigrationPath, "utf8"),
    );
    await assertHeadPageMayRetainSourceCheckpoint(harness.db);
  } finally {
    await harness.stop();
  }
});

test("provider fact source relationships stay valid while local references resolve monotonically", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase();
  const { db, providerKey } = harness;
  const localProviderId = "94000000-0000-4000-8000-000000000001";
  const packId = "94000000-0000-4000-8000-000000000002";
  const otherPackId = "94000000-0000-4000-8000-000000000003";
  const collectibleId = "94000000-0000-4000-8000-000000000004";
  const otherCollectibleId = "94000000-0000-4000-8000-000000000005";
  const keyedPullId = "94000000-0000-4000-8000-000000000006";
  const keyedPullItemId = "94000000-0000-4000-8000-000000000007";
  const unreportedPullId = "94000000-0000-4000-8000-000000000008";
  const unreportedPullItemId = "94000000-0000-4000-8000-000000000009";
  const marketEventId = "94000000-0000-4000-8000-000000000010";
  const itemKeyOnlyPullId = "94000000-0000-4000-8000-000000000015";
  const itemKeyOnlyPullItemId = "94000000-0000-4000-8000-000000000016";
  try {
    await db.query(
      "select initialize_provider_database_identity($1::uuid, $2::text)",
      [localProviderId, providerKey],
    );
    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 4 where singleton_key;
      insert into packs (
        id, pack_key, display_name, pack_format, availability,
        content_evidence, packscout_ev_model_version,
        packscout_ev_confidence_policy_version, source_updated_at
      ) values
        (
          '${packId}', 'deferred-pack', 'Deferred Pack', 'repack', 'available',
          'complete', 'model-v1', 'policy-v1', now()
        ),
        (
          '${otherPackId}', 'other-pack', 'Other Pack', 'repack', 'available',
          'complete', 'model-v1', 'policy-v1', now()
        );
      insert into collectibles (
        id, collectible_key, collectible_type, display_name,
        normalized_name, data_as_of
      ) values
        ('${collectibleId}', 'deferred-card', 'card', 'Deferred Card', 'deferred card', now()),
        ('${otherCollectibleId}', 'other-card', 'card', 'Other Card', 'other card', now());
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (1, 'pack', '${packId}', 1, 'upsert', now()),
        (2, 'pack', '${otherPackId}', 1, 'upsert', now()),
        (3, 'collectible', '${collectibleId}', 1, 'upsert', now()),
        (4, 'collectible', '${otherCollectibleId}', 1, 'upsert', now());
      commit;
    `);

    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 9 where singleton_key;
      insert into pulls (
        id, pull_key, fact_digest, pack_key, item_count, occurred_at
      ) values
        ('${keyedPullId}', 'keyed-unresolved-pull', '${hashA}', 'deferred-pack', 1, now()),
        ('${unreportedPullId}', 'source-unreported-card-pull', '${hashB}', 'deferred-pack', 1, now());
      insert into pull_items (
        id, pull_id, ordinal, collectible_key, quantity
      ) values
        ('${keyedPullItemId}', '${keyedPullId}', 1, 'deferred-card', 1),
        ('${unreportedPullItemId}', '${unreportedPullId}', 1, null, 1);
      insert into market_events (
        id, event_key, fact_digest, event_type, collectible_key,
        quantity, occurred_at, details
      ) values (
        '${marketEventId}', 'keyed-unresolved-market-event', '${hashA}',
        'sale', 'deferred-card', 1, now(), '{"relationship":"deferred"}'
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (5, 'pull', '${keyedPullId}', 1, 'upsert', now()),
        (6, 'pull_item', '${keyedPullItemId}', 1, 'upsert', now()),
        (7, 'pull', '${unreportedPullId}', 1, 'upsert', now()),
        (8, 'pull_item', '${unreportedPullItemId}', 1, 'upsert', now()),
        (9, 'market_event', '${marketEventId}', 1, 'upsert', now());
      commit;
    `);

    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 11 where singleton_key;
      insert into pulls (
        id, pull_key, fact_digest, pack_key, item_count, occurred_at
      ) values (
        '${itemKeyOnlyPullId}', 'item-key-only-pull', '${hashA}', null, 1, now()
      );
      insert into pull_items (
        id, pull_id, ordinal, collectible_key, quantity
      ) values (
        '${itemKeyOnlyPullItemId}', '${itemKeyOnlyPullId}', 1, 'deferred-card', 1
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (10, 'pull', '${itemKeyOnlyPullId}', 1, 'upsert', now()),
        (11, 'pull_item', '${itemKeyOnlyPullItemId}', 1, 'upsert', now());
      commit;
    `);

    const unresolved = await db.query<{
      keyed_pull: boolean;
      keyed_item: boolean;
      keyed_event: boolean;
      source_unreported_item: boolean;
      item_key_only_source: boolean;
    }>(`
      select
        exists (
          select 1 from pulls
          where id = '${keyedPullId}' and pack_key = 'deferred-pack'
            and pack_id is null and row_version = 1
        ) as keyed_pull,
        exists (
          select 1 from pull_items
          where id = '${keyedPullItemId}' and collectible_key = 'deferred-card'
            and collectible_id is null and row_version = 1
        ) as keyed_item,
        exists (
          select 1 from market_events
          where id = '${marketEventId}' and collectible_key = 'deferred-card'
            and collectible_id is null and row_version = 1
        ) as keyed_event,
        exists (
          select 1 from pull_items
          where id = '${unreportedPullItemId}' and collectible_key is null
            and collectible_id is null
        ) as source_unreported_item,
        exists (
          select 1 from pulls pull
          join pull_items item on item.pull_id = pull.id
          where pull.id = '${itemKeyOnlyPullId}' and pull.pack_key is null
            and item.collectible_key = 'deferred-card'
        ) as item_key_only_source
    `);
    assert.deepEqual(unresolved.rows[0], {
      keyed_pull: true,
      keyed_item: true,
      keyed_event: true,
      source_unreported_item: true,
      item_key_only_source: true,
    });

    await db.query("begin");
    await db.query(`
      update promotion_ledger set last_sequence = 12 where singleton_key;
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values (12, 'pack', '${packId}', 2, 'upsert', now())
    `);
    await expectDatabaseError(
      db.query(`
        update packs
        set pack_key = 'renamed-deferred-pack', row_version = 2
        where id = '${packId}'
      `),
      /packs_stable_key_immutable/,
    );
    await db.query("rollback");

    await db.query("begin");
    await db.query(`
      update promotion_ledger set last_sequence = 12 where singleton_key;
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values (12, 'collectible', '${collectibleId}', 2, 'upsert', now())
    `);
    await expectDatabaseError(
      db.query(`
        update collectibles
        set collectible_key = 'renamed-deferred-card', row_version = 2
        where id = '${collectibleId}'
      `),
      /collectibles_stable_key_immutable/,
    );
    await db.query("rollback");

    await expectDatabaseError(
      db.query(`
        update pulls
        set pack_id = '${otherPackId}', row_version = 2
        where id = '${keyedPullId}'
      `),
      /pulls_pack_id_key_fkey/,
    );
    await expectDatabaseError(
      db.query(`
        update pull_items
        set collectible_id = '${otherCollectibleId}', row_version = 2
        where id = '${keyedPullItemId}'
      `),
      /pull_items_collectible_id_key_fkey/,
    );
    await expectDatabaseError(
      db.query(`
        insert into pulls (
          id, pull_key, fact_digest, pack_id, item_count, occurred_at
        ) values (
          '94000000-0000-4000-8000-000000000011',
          'resolved-without-source-key', '${hashA}', '${packId}', 1, now()
        )
      `),
      /pulls_pack_resolution_check/,
    );
    await expectDatabaseError(
      db.query(`
        insert into market_events (
          id, event_key, fact_digest, event_type, occurred_at
        ) values (
          '94000000-0000-4000-8000-000000000012',
          'event-without-source-subject', '${hashA}', 'sale', now()
        )
      `),
      /market_events_subject_check/,
    );

    await db.query("begin");
    await db.query(`
      update pulls
      set pack_id = '${packId}', row_version = 2
      where id = '${keyedPullId}'
    `);
    await expectDatabaseError(
      db.query("commit"),
      /fact_write_requires_promotion_change/,
    );
    await db.query("rollback");

    await db.query("begin");
    await db.query(`
      update promotion_ledger set last_sequence = 15 where singleton_key;
      update pulls
      set pack_id = '${packId}', row_version = 2
      where id = '${keyedPullId}';
      update pull_items
      set collectible_id = '${collectibleId}', row_version = 2
      where id = '${keyedPullItemId}';
      update market_events
      set collectible_id = '${collectibleId}', row_version = 2
      where id = '${marketEventId}';
      insert into pull_items (
        id, pull_id, ordinal, collectible_key, quantity
      ) values (
        '94000000-0000-4000-8000-000000000019',
        '${keyedPullId}', 2, 'late-after-parent-resolution', 1
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (12, 'pull', '${keyedPullId}', 2, 'upsert', now()),
        (13, 'pull_item', '${keyedPullItemId}', 2, 'upsert', now()),
        (14, 'market_event', '${marketEventId}', 2, 'upsert', now()),
        (
          15, 'pull_item', '94000000-0000-4000-8000-000000000019',
          1, 'upsert', now()
        )
    `);
    await expectDatabaseError(db.query("commit"), /pull_item_count_mismatch/);
    await db.query("rollback");

    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 14 where singleton_key;
      update pulls
      set pack_id = '${packId}', row_version = 2
      where id = '${keyedPullId}';
      update pull_items
      set collectible_id = '${collectibleId}', row_version = 2
      where id = '${keyedPullItemId}';
      update market_events
      set collectible_id = '${collectibleId}', row_version = 2
      where id = '${marketEventId}';
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (12, 'pull', '${keyedPullId}', 2, 'upsert', now()),
        (13, 'pull_item', '${keyedPullItemId}', 2, 'upsert', now()),
        (14, 'market_event', '${marketEventId}', 2, 'upsert', now());
      commit;
    `);

    const resolved = await db.query<{
      pulls_resolved: boolean;
      pull_items_resolved: boolean;
      market_events_resolved: boolean;
      promoted_version_twos: number;
    }>(`
      select
        exists (
          select 1 from pulls
          where id = '${keyedPullId}' and pack_key = 'deferred-pack'
            and pack_id = '${packId}' and row_version = 2
            and updated_at > created_at
        ) as pulls_resolved,
        exists (
          select 1 from pull_items
          where id = '${keyedPullItemId}' and collectible_key = 'deferred-card'
            and collectible_id = '${collectibleId}' and row_version = 2
            and updated_at > created_at
        ) as pull_items_resolved,
        exists (
          select 1 from market_events
          where id = '${marketEventId}' and collectible_key = 'deferred-card'
            and collectible_id = '${collectibleId}' and row_version = 2
            and updated_at > created_at
        ) as market_events_resolved,
        (
          select count(*)::int from promotion_changes
          where entity_id in ('${keyedPullId}', '${keyedPullItemId}', '${marketEventId}')
            and entity_version = 2 and operation = 'upsert'
        ) as promoted_version_twos
    `);
    assert.deepEqual(resolved.rows[0], {
      pulls_resolved: true,
      pull_items_resolved: true,
      market_events_resolved: true,
      promoted_version_twos: 3,
    });

    await expectDatabaseError(
      db.query(`
        update pulls set pack_id = null, row_version = 3
        where id = '${keyedPullId}'
      `),
      /pulls_relationship_resolution_not_monotonic/,
    );
    await expectDatabaseError(
      db.query(`
        update market_events
        set collectible_id = '${otherCollectibleId}', row_version = 3
        where id = '${marketEventId}'
      `),
      /market_events_relationship_resolution_not_monotonic/,
    );
    await expectDatabaseError(
      db.query(`
        update pull_items
        set collectible_key = 'mutated-source-key', row_version = 3
        where id = '${keyedPullItemId}'
      `),
      /pull_items_source_fact_immutable/,
    );

    await db.query("begin");
    await db.query(`
      update promotion_ledger set last_sequence = 16 where singleton_key;
      insert into pulls (
        id, pull_key, fact_digest, pack_key, item_count, occurred_at
      ) values (
        '94000000-0000-4000-8000-000000000017',
        'pull-without-source-relationship', '${hashA}', null, 1, now()
      );
      insert into pull_items (
        id, pull_id, ordinal, collectible_key, quantity
      ) values (
        '94000000-0000-4000-8000-000000000018',
        '94000000-0000-4000-8000-000000000017', 1, null, 1
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (
          15, 'pull', '94000000-0000-4000-8000-000000000017',
          1, 'upsert', now()
        ),
        (
          16, 'pull_item', '94000000-0000-4000-8000-000000000018',
          1, 'upsert', now()
        );
    `);
    await expectDatabaseError(
      db.query("commit"),
      /pull_requires_source_relationship/,
    );
    await db.query("rollback");

    await db.query("begin");
    await db.query(`
      update promotion_ledger set last_sequence = 15 where singleton_key;
      insert into pulls (
        id, pull_key, fact_digest, pack_key, item_count, occurred_at
      ) values (
        '94000000-0000-4000-8000-000000000013',
        'pull-with-zero-items', '${hashA}', 'deferred-pack', 1, now()
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values (
        15, 'pull', '94000000-0000-4000-8000-000000000013', 1, 'upsert', now()
      );
    `);
    await expectDatabaseError(db.query("commit"), /pull_requires_item/);
    await db.query("rollback");

    await db.query("begin");
    await db.query(`
      update promotion_ledger set last_sequence = 16 where singleton_key;
      insert into market_events (
        id, event_key, fact_digest, event_type, collectible_key,
        occurred_at, row_version
      ) values (
        '94000000-0000-4000-8000-000000000014',
        'fact-starting-at-version-two', '${hashA}', 'sale',
        'deferred-card', now(), 2
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values
        (
          15, 'market_event', '94000000-0000-4000-8000-000000000014',
          1, 'upsert', now()
        ),
        (
          16, 'market_event', '94000000-0000-4000-8000-000000000014',
          2, 'upsert', now()
        );
    `);
    await expectDatabaseError(
      db.query("commit"),
      /promotion_fact_initial_version_invalid/,
    );
    await db.query("rollback");
  } finally {
    await harness.stop();
  }
});

test("provider EV recomputation requests are local, claimable, versioned, and one-way", { concurrency: false }, async () => {
  const harness = await createMigratedProviderDatabase();
  const { db, providerKey } = harness;
  const localProviderId = "93000000-0000-4000-8000-000000000001";
  const packId = "93000000-0000-4000-8000-000000000002";
  const requestId = "93000000-0000-4000-8000-000000000003";
  const invalidRequestId = "93000000-0000-4000-8000-000000000004";
  const firstClaimToken = "93000000-0000-4000-8000-000000000005";
  const secondClaimToken = "93000000-0000-4000-8000-000000000006";
  try {
    await db.query(
      "select initialize_provider_database_identity($1::uuid, $2::text)",
      [localProviderId, providerKey],
    );
    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 1 where singleton_key;
      insert into packs (
        id, pack_key, display_name, pack_format, availability,
        content_evidence, packscout_ev_model_version,
        packscout_ev_confidence_policy_version, source_updated_at
      ) values (
        '${packId}', 'fixture-pack', 'Fixture Pack', 'repack', 'available',
        'complete', 'ev-v1', 'confidence-v1', now()
      );
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values (1, 'pack', '${packId}', 1, 'upsert', now());
      commit;
    `);

    await db.query(`
      insert into pack_ev_recomputation_requests (
        id, request_key, pack_id, trigger_change_sequence, input_hash
      ) values ('${requestId}', '${hashA}', '${packId}', 1, '${hashB}')
    `);
    await expectDatabaseError(
      db.query(`
        insert into pack_ev_recomputation_requests (
          id, request_key, pack_id, trigger_change_sequence, input_hash,
          state, attempt_count
        ) values (
          '${invalidRequestId}', '${"c".repeat(64)}', '${packId}', 1,
          '${hashA}', 'running', 1
        )
      `),
      /pack_ev_recomputation_requests_state_check/,
    );

    await db.query(`
      update pack_ev_recomputation_requests
      set state = 'running', attempt_count = 1,
          claim_owner = 'worker:ev:1', claim_token = '${firstClaimToken}',
          claim_expires_at = now() + interval '1 minute', row_version = 2
      where id = '${requestId}'
    `);
    await expectDatabaseError(
      db.query(`
        update pack_ev_recomputation_requests
        set claim_expires_at = now() + interval '2 minutes'
        where id = '${requestId}'
      `),
      /row_version_conflict/,
    );

    await db.query(`
      update pack_ev_recomputation_requests
      set state = 'queued', claim_owner = null, claim_token = null,
          claim_expires_at = null, failure_code = 'TEMPORARY_FAILURE',
          available_at = now() + interval '1 minute', row_version = 3
      where id = '${requestId}';
      update pack_ev_recomputation_requests
      set state = 'running', attempt_count = 2,
          claim_owner = 'worker:ev:2', claim_token = '${secondClaimToken}',
          claim_expires_at = now() + interval '1 minute',
          failure_code = null, row_version = 4
      where id = '${requestId}';
    `);
    await expectDatabaseError(
      db.query(`
        update pack_ev_recomputation_requests
        set state = 'queued', attempt_count = 0, row_version = 5
        where id = '${requestId}'
      `),
      /pack_ev_recomputation_attempt_count_regression/,
    );

    await db.query(`
      begin;
      update promotion_ledger set last_sequence = 2 where singleton_key;
      update packs
      set packscout_ev_amount = 25,
          packscout_ev_currency = 'USD',
          packscout_ev_data_as_of = now(),
          packscout_ev_calculated_at = now(),
          row_version = 2
      where id = '${packId}';
      insert into promotion_changes (
        sequence, entity_type, entity_id, entity_version, operation, changed_at
      ) values (2, 'pack', '${packId}', 2, 'upsert', now());
      update pack_ev_recomputation_requests
      set state = 'completed', result_status = 'estimated',
          result_pack_version = 2, claim_owner = null, claim_token = null,
          claim_expires_at = null, completed_at = now(), row_version = 5
      where id = '${requestId}';
      commit;
    `);

    await expectDatabaseError(
      db.query(`delete from pack_ev_recomputation_requests where id = '${requestId}'`),
      /pack_ev_recomputation_request_delete_forbidden/,
    );
    await expectDatabaseError(
      db.query(`
        update pack_ev_recomputation_requests
        set state = 'queued', result_status = null, result_pack_version = null,
            completed_at = null, row_version = 6
        where id = '${requestId}'
      `),
      /completed_immutable|transition_invalid/,
    );

    const result = await db.query<{
      state: string;
      result_status: string;
      result_pack_version: string;
      attempt_count: number;
      row_version: string;
    }>(`
      select state::text, result_status::text, result_pack_version::text,
             attempt_count, row_version::text
      from pack_ev_recomputation_requests
      where id = '${requestId}'
    `);
    assert.deepEqual(result.rows, [{
      state: "completed",
      result_status: "estimated",
      result_pack_version: "2",
      attempt_count: 2,
      row_version: "5",
    }]);
  } finally {
    await harness.stop();
  }
});
