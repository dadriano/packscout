import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const migrationPath = fileURLToPath(new URL(
  "./migrations/20260829000000_distributed_provider_baseline/migration.sql",
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

async function createMigratedProviderDatabase(): Promise<{
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
    await db.query(await readFile(migrationPath, "utf8"));
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
