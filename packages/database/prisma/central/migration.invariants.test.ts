import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const baselineMigrationPath = fileURLToPath(new URL(
  "./migrations/20260829000000_distributed_central_baseline/migration.sql",
  import.meta.url,
));
const catalogBudgetMigrationPath = fileURLToPath(new URL(
  "./migrations/20260902130000_provider_promotion_catalog_budget/migration.sql",
  import.meta.url,
));
const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL
  ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;

const ids = {
  organization: "91000000-0000-4000-8000-000000000001",
  provider: "91000000-0000-4000-8000-000000000002",
  catalogVersion: "91000000-0000-4000-8000-000000000003",
  incompleteCatalogVersion: "91000000-0000-4000-8000-000000000004",
  finalizeOperation: "91000000-0000-4000-8000-000000000005",
  staleOperation: "91000000-0000-4000-8000-000000000006",
  manifestOperation: "91000000-0000-4000-8000-000000000007",
  providerRelease: "91000000-0000-4000-8000-000000000008",
  badReceiptOperation: "91000000-0000-4000-8000-000000000009",
} as const;
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

async function createMigratedDatabase(): Promise<{
  db: Client;
  stop(): Promise<void>;
}> {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be a PostgreSQL URL");
  }
  const databaseName = `packscout_central_inv_${process.pid}_${randomBytes(6).toString("hex")}`;
  if (!/^packscout_central_inv_[0-9]+_[0-9a-f]{12}$/.test(databaseName)) {
    throw new Error("refusing to create an unscoped test database");
  }
  const admin = new Client({ connectionString: adminUrl.toString() });
  let created = false;
  await admin.connect();
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
    await db.query(await readFile(catalogBudgetMigrationPath, "utf8"));
  } catch (error) {
    await db.end().catch(() => undefined);
    if (created) await admin.query(`drop database "${databaseName}"`);
    await admin.end();
    throw error;
  }
  return {
    db,
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

test("central publication invariants are monotonic, receipt-gated, and lease-fenced", { concurrency: false }, async () => {
  const harness = await createMigratedDatabase();
  const { db } = harness;
  try {
    await db.query(`
      insert into organizations (id, slug, name)
      values ('${ids.organization}', 'publication-test', 'Publication Test');
      insert into providers (id, organization_id, provider_key, display_name)
      values ('${ids.provider}', '${ids.organization}', 'publication_test', 'Publication Test');
    `);

    await db.query("begin");
    await db.query(`
      update catalog_ledger
      set last_sequence = 3, updated_at = updated_at + interval '1 second'
      where singleton_key;
      insert into catalog_decision_events
        (sequence, event_type, actor_type, actor_id, reason, occurred_at)
      values
        (1, 'fixture', 'worker', 'fixture', 'fixture', now()),
        (2, 'fixture', 'worker', 'fixture', 'fixture', now()),
        (3, 'fixture', 'worker', 'fixture', 'fixture', now());
    `);
    await db.query("commit");

    await db.query("begin");
    await db.query(`
      update catalog_ledger
      set last_sequence = 5, updated_at = updated_at + interval '1 second'
      where singleton_key;
      insert into catalog_decision_events
        (sequence, event_type, actor_type, actor_id, reason, occurred_at)
      values (4, 'fixture', 'worker', 'fixture', 'fixture', now());
    `);
    await expectDatabaseError(
      db.query("commit"),
      /allocation must be contiguous and fully materialized/,
    );
    await db.query("rollback");
    await db.query(`
      begin;
      update catalog_ledger
      set last_sequence = 5, updated_at = updated_at + interval '1 second'
      where singleton_key;
      insert into catalog_decision_events
        (sequence, event_type, actor_type, actor_id, reason, occurred_at)
      values
        (4, 'fixture', 'worker', 'fixture', 'fixture', now()),
        (5, 'fixture', 'worker', 'fixture', 'fixture', now());
      commit;
    `);

    await db.query(`
      update catalog_consumer_checkpoints
      set lease_owner = 'catalog-worker',
          lease_fence = 1,
          lease_expires_at = now() + interval '10 minutes',
          row_version = row_version + 1,
          updated_at = updated_at + interval '1 second'
      where consumer_key = 'catalog_publication';
      insert into catalog_versions (
        id, through_change_sequence, schema_version, lifecycle,
        category_count, collectible_count, alias_count, content_hash
      ) values (
        '${ids.catalogVersion}', 5, 'public-v1', 'building', 0, 0, 0, '${hashA}'
      );
      insert into catalog_version_batches (
        catalog_version_id, batch_kind, batch_index, payload,
        record_count, byte_count, body_hash
      ) values
        ('${ids.catalogVersion}', 'categories', 0, '[]', 0, 2, '${hashA}'),
        ('${ids.catalogVersion}', 'collectibles', 0, '[]', 0, 2, '${hashA}'),
        ('${ids.catalogVersion}', 'aliases', 0, '[]', 0, 2, '${hashA}');
      update catalog_versions
      set lifecycle = 'assembled', assembled_at = now()
      where id = '${ids.catalogVersion}';
      update catalog_versions
      set lifecycle = 'publishing'
      where id = '${ids.catalogVersion}';
    `);

    await db.query(`
      insert into catalog_versions (
        id, through_change_sequence, schema_version, lifecycle,
        category_count, collectible_count, alias_count, content_hash
      ) values (
        '${ids.incompleteCatalogVersion}', 5, 'public-v1', 'building', 0, 0, 0, '${hashB}'
      );
      insert into catalog_version_batches (
        catalog_version_id, batch_kind, batch_index, payload,
        record_count, byte_count, body_hash
      ) values
        ('${ids.incompleteCatalogVersion}', 'categories', 0, '[]', 0, 2, '${hashA}'),
        ('${ids.incompleteCatalogVersion}', 'collectibles', 0, '[]', 0, 2, '${hashA}');
    `);
    await expectDatabaseError(
      db.query(`
        update catalog_versions
        set lifecycle = 'assembled', assembled_at = now()
        where id = '${ids.incompleteCatalogVersion}'
      `),
      /include every required kind/,
    );

    const finalizeRequest = Buffer.from('{"operation":"finalize"}');
    await db.query(`
      insert into catalog_publication_operations (
        id, catalog_version_id, operation_kind, idempotency_key,
        request_digest, request_bytes, lease_fence, requested_at
      ) values (
        '${ids.finalizeOperation}', '${ids.catalogVersion}', 'finalize', 'catalog-finalize-1',
        encode(digest($1::bytea, 'sha256'), 'hex'), $1, 1, now()
      )
    `, [finalizeRequest]);
    await expectDatabaseError(
      db.query(`
        update catalog_versions
        set lifecycle = 'complete', completed_at = now()
        where id = '${ids.catalogVersion}'
      `),
      /requires an accepted finalize or reuse receipt/,
    );

    await db.query(`
      update catalog_publication_operations
      set state = 'accepted',
          convex_receipt_id = 'catalog-receipt-1',
          receipt = '{"outcome":"accepted","receiptId":"catalog-receipt-1"}',
          receipt_hash = encode(digest(convert_to('{"outcome":"accepted","receiptId":"catalog-receipt-1"}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
          completed_at = now()
      where id = '${ids.finalizeOperation}';
      update catalog_versions
      set lifecycle = 'complete', completed_at = now()
      where id = '${ids.catalogVersion}';
    `);
    await expectDatabaseError(
      db.query(`
        update catalog_consumer_checkpoints
        set last_confirmed_sequence = 5,
            confirmation_id = 'missing-receipt',
            row_version = row_version + 1,
            updated_at = updated_at + interval '1 second'
        where consumer_key = 'catalog_publication'
      `),
      /requires its exact accepted completion receipt/,
    );
    await db.query(`
      update catalog_consumer_checkpoints
      set last_confirmed_sequence = 5,
          confirmation_id = 'catalog-receipt-1',
          row_version = row_version + 1,
          updated_at = updated_at + interval '1 second'
      where consumer_key = 'catalog_publication';
    `);
    await expectDatabaseError(
      db.query(`
        update catalog_consumer_checkpoints
        set last_confirmed_sequence = 4,
            row_version = row_version + 1,
            updated_at = updated_at + interval '1 second'
        where consumer_key = 'catalog_publication'
      `),
      /checkpoint and lease fence are monotonic/,
    );

    const badReceiptRequest = Buffer.from('{"operation":"status","case":"bad-receipt"}');
    await db.query(`
      insert into catalog_publication_operations (
        id, catalog_version_id, operation_kind, idempotency_key,
        request_digest, request_bytes, lease_fence, requested_at
      ) values (
        '${ids.badReceiptOperation}', '${ids.catalogVersion}', 'status', 'catalog-status-bad-receipt',
        encode(digest($1::bytea, 'sha256'), 'hex'), $1, 1, now()
      )
    `, [badReceiptRequest]);
    await expectDatabaseError(
      db.query(`
        update catalog_publication_operations
        set state = 'accepted',
            convex_receipt_id = 'bad-receipt',
            receipt = '{"outcome":"accepted"}',
            receipt_hash = '${hashA}',
            completed_at = now()
        where id = '${ids.badReceiptOperation}'
      `),
      /catalog_publication_operations_terminal_evidence_check/,
    );

    const staleRequest = Buffer.from('{"operation":"status"}');
    await db.query(`
      insert into catalog_publication_operations (
        id, catalog_version_id, operation_kind, idempotency_key,
        request_digest, request_bytes, lease_fence, requested_at
      ) values (
        '${ids.staleOperation}', '${ids.catalogVersion}', 'status', 'catalog-status-stale',
        encode(digest($1::bytea, 'sha256'), 'hex'), $1, 1, now()
      )
    `, [staleRequest]);
    await db.query(`
      update catalog_consumer_checkpoints
      set lease_owner = 'replacement-worker',
          lease_fence = 2,
          lease_expires_at = now() + interval '10 minutes',
          row_version = row_version + 1,
          updated_at = updated_at + interval '1 second'
      where consumer_key = 'catalog_publication';
    `);
    await expectDatabaseError(
      db.query(`
        update catalog_publication_operations
        set state = 'failed', failure_code = 'REMOTE_REJECTED', completed_at = now()
        where id = '${ids.staleOperation}'
      `),
      /stale or inactive lease fence/,
    );

    await db.query(`
      update manifest_activation_state
      set lease_owner = 'manifest-worker',
          lease_fence = 1,
          lease_expires_at = now() + interval '10 minutes',
          row_version = row_version + 1,
          updated_at = updated_at + interval '1 second'
      where singleton_key;
      insert into manifest_activation_operations (
        id, provider_id, operation, expected_manifest_id,
        target_provider_release_id, target_catalog_version_id,
        new_manifest_fingerprint, idempotency_key, request_digest,
        lease_fence, requested_at
      ) values (
        '${ids.manifestOperation}', '${ids.provider}', 'add', null,
        '${ids.providerRelease}', '${ids.catalogVersion}',
        '${hashB}', 'manifest-add-1', '${hashA}', 1, now()
      );
      update manifest_activation_operations
      set state = 'accepted',
          convex_receipt_id = 'manifest-receipt-1',
          receipt = '{"outcome":"accepted","receiptId":"manifest-receipt-1"}',
          receipt_hash = encode(digest(convert_to('{"outcome":"accepted","receiptId":"manifest-receipt-1"}'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
          completed_at = now()
      where id = '${ids.manifestOperation}';
      update manifest_activation_state
      set active_manifest_id = 'manifest-1',
          active_manifest_fingerprint = '${hashB}',
          last_receipt_id = 'manifest-receipt-1',
          row_version = row_version + 1,
          updated_at = updated_at + interval '1 second'
      where singleton_key;
    `);
    await expectDatabaseError(
      db.query(`
        update manifest_activation_state
        set lease_fence = 0,
            row_version = row_version + 1,
            updated_at = updated_at + interval '1 second'
        where singleton_key
      `),
      /lease fence is monotonic/,
    );
    await expectDatabaseError(
      db.query(`
        update manifest_activation_state
        set active_manifest_id = 'manifest-unproven',
            active_manifest_fingerprint = '${hashA}',
            previous_manifest_id = 'manifest-1',
            previous_manifest_fingerprint = '${hashB}',
            last_receipt_id = 'missing-receipt',
            row_version = row_version + 1,
            updated_at = updated_at + interval '1 second'
        where singleton_key
      `),
      /requires its exact accepted activation receipt/,
    );
  } finally {
    await harness.stop();
  }
});

test("central admin support state preserves lifecycle, delivery, presence, and global activity invariants", { concurrency: false }, async () => {
  const harness = await createMigratedDatabase();
  const { db } = harness;
  const organizationId = "92000000-0000-4000-8000-000000000001";
  const operatorId = "92000000-0000-4000-8000-000000000002";
  const cancelledOperatorId = "92000000-0000-4000-8000-000000000003";
  const intentId = "92000000-0000-4000-8000-000000000004";
  const attemptId = "92000000-0000-4000-8000-000000000005";
  const linkId = "92000000-0000-4000-8000-000000000006";
  const secondLinkId = "92000000-0000-4000-8000-000000000007";
  const activityId = "92000000-0000-4000-8000-000000000008";
  const claimToken = "92000000-0000-4000-8000-000000000009";
  const at = "2026-08-29T12:00:00.000Z";
  try {
    await db.query(`
      insert into organizations (id, slug, name, created_at)
      values ('${organizationId}', 'admin-support', 'Admin Support', '${at}');

      insert into operators (
        id, email_normalized, display_name, password_hash, state,
        row_version, created_at, updated_at
      ) values (
        '${operatorId}', 'invited@packscout.test', 'Invited Operator', null,
        'pending', 1, '${at}', '${at}'
      );
    `);
    await expectDatabaseError(
      db.query(`
        insert into operators (
          email_normalized, display_name, password_hash, state
        ) values ('invalid@packscout.test', 'Invalid Active', null, 'active')
      `),
      /operators_credential_lifecycle_check/,
    );
    await db.query(`
      update operators
      set state = 'active', password_hash = 'argon2id$fixture',
          row_version = 2, updated_at = '${at}'::timestamptz + interval '1 second'
      where id = '${operatorId}';

      insert into operators (
        id, email_normalized, display_name, password_hash, state,
        row_version, created_at, updated_at
      ) values (
        '${cancelledOperatorId}', 'cancelled@packscout.test', 'Cancelled Operator',
        null, 'pending', 1, '${at}', '${at}'
      );
      update operators
      set state = 'cancelled', row_version = 2,
          updated_at = '${at}'::timestamptz + interval '1 second'
      where id = '${cancelledOperatorId}';
    `);
    await expectDatabaseError(
      db.query(`
        update operators
        set state = 'active', password_hash = 'argon2id$forbidden',
            row_version = 3,
            updated_at = '${at}'::timestamptz + interval '2 seconds'
        where id = '${cancelledOperatorId}'
      `),
      /cancelled operator is immutable/,
    );

    await db.query(`
      insert into worker_instances (
        instance_id, state, version, host, runtime_version,
        started_at, last_heartbeat_at, activity_kind,
        heartbeat_interval_ms, presence_stale_after_ms,
        run_heartbeat_stale_after_ms, schedule_claim_lease_ms,
        import_run_lease_ms, protected_payload_retention_days,
        presence_retention_days, row_version, created_at, updated_at
      ) values (
        'worker:admin-support:1', 'running', '1.0.0', 'worker-host', 'v22',
        '${at}', '${at}', 'idle', 10000, 30000, 60000, 30000,
        60000, 90, 30, 1, '${at}', '${at}'
      );
      update worker_instances
      set last_heartbeat_at = '${at}'::timestamptz + interval '1 second',
          row_version = 2,
          updated_at = '${at}'::timestamptz + interval '1 second'
      where instance_id = 'worker:admin-support:1';
    `);
    await expectDatabaseError(
      db.query(`
        update worker_instances
        set last_heartbeat_at = '${at}'::timestamptz + interval '2 seconds',
            updated_at = '${at}'::timestamptz + interval '2 seconds'
        where instance_id = 'worker:admin-support:1'
      `),
      /material update must increment row_version once/,
    );
    await db.query(`
      update worker_instances
      set state = 'stopped', stopped_at = '${at}'::timestamptz + interval '2 seconds',
          last_heartbeat_at = '${at}'::timestamptz + interval '2 seconds',
          row_version = 3,
          updated_at = '${at}'::timestamptz + interval '2 seconds'
      where instance_id = 'worker:admin-support:1';
      update worker_instances
      set state = 'running', stopped_at = null,
          started_at = '${at}'::timestamptz + interval '3 seconds',
          last_heartbeat_at = '${at}'::timestamptz + interval '3 seconds',
          activity_kind = 'idle', activity_organization_id = null,
          activity_provider_id = null, activity_run_id = null,
          activity_started_at = null, row_version = 4,
          updated_at = '${at}'::timestamptz + interval '3 seconds'
      where instance_id = 'worker:admin-support:1';
    `);

    await db.query(`
      insert into email_message_intents (
        id, kind, input_json, recipient, idempotency_key, source,
        state, due_at, row_version, created_at, updated_at
      ) values (
        '${intentId}', 'operator_invitation', 'null', 'invited@packscout.test',
        'operator-invitation:${operatorId}', 'operator_invitations',
        'pending', '${at}', 1, '${at}', '${at}'
      );
      update email_message_intents
      set claim_owner = 'worker:admin-support:1', claim_token = '${claimToken}',
          claim_expires_at = '${at}'::timestamptz + interval '1 minute',
          attempt_count = 1, row_version = 2,
          updated_at = '${at}'::timestamptz + interval '1 second'
      where id = '${intentId}';
      update email_message_intents
      set state = 'sent', claim_owner = null, claim_token = null,
          claim_expires_at = null, last_provider = 'fixture',
          last_attempted_at = '${at}'::timestamptz + interval '2 seconds',
          finalized_at = '${at}'::timestamptz + interval '2 seconds',
          row_version = 3,
          updated_at = '${at}'::timestamptz + interval '2 seconds'
      where id = '${intentId}';
      insert into email_message_attempts (
        id, intent_id, attempt_number, attempted_at, outcome, provider,
        provider_message_id, created_at
      ) values (
        '${attemptId}', '${intentId}', 1,
        '${at}'::timestamptz + interval '2 seconds', 'sent', 'fixture',
        'message-1', '${at}'::timestamptz + interval '2 seconds'
      );
    `);
    await expectDatabaseError(
      db.query(`update email_message_attempts set provider = 'changed' where id = '${attemptId}'`),
      /append-only/,
    );

    await db.query(`
      insert into email_link_tokens (
        id, purpose, selector, verifier_hash, subject_id, address_normalized,
        issued_at, expires_at, row_version, created_at, updated_at
      ) values (
        '${linkId}', 'operator_password_reset', 'abcdefghijklmnopqrstuv',
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', '${operatorId}',
        'invited@packscout.test', '${at}',
        '${at}'::timestamptz + interval '1 hour', 1, '${at}', '${at}'
      );
    `);
    await expectDatabaseError(
      db.query(`
        insert into email_link_tokens (
          id, purpose, selector, verifier_hash, subject_id, address_normalized,
          issued_at, expires_at, row_version, created_at, updated_at
        ) values (
          '${secondLinkId}', 'operator_password_reset', '1234567890123456789012',
          '1234567890123456789012345678901234567890123', '${operatorId}',
          'invited@packscout.test', '${at}',
          '${at}'::timestamptz + interval '1 hour', 1, '${at}', '${at}'
        )
      `),
      /email_link_tokens_one_outstanding_unique/,
    );
    await db.query(`
      update email_link_tokens
      set redeemed_at = '${at}'::timestamptz + interval '1 minute',
          row_version = 2,
          updated_at = '${at}'::timestamptz + interval '1 minute'
      where id = '${linkId}';
    `);

    await db.query(`
      insert into global_activity_events (
        id, organization_id, event_digest, event_type, severity,
        dedupe_key, recovery_key, title, summary, evidence,
        event_at, received_at, created_at
      ) values (
        '${activityId}', '${organizationId}', '${hashA}', 'worker_fleet_unavailable',
        'critical', 'worker-fleet', 'worker-fleet', 'No live workers',
        'No centralized worker has a fresh heartbeat.', '{"liveWorkerCount":0}',
        '${at}', '${at}', '${at}'
      );
    `);
    await expectDatabaseError(
      db.query(`update global_activity_events set title = 'Changed' where id = '${activityId}'`),
      /append-only/,
    );
    await expectDatabaseError(
      db.query(`
        insert into global_activity_events (
          organization_id, event_digest, event_type, severity, dedupe_key,
          recovery_key, title, summary, event_at, received_at, created_at
        ) values (
          '${organizationId}', '${hashA}', 'worker_fleet_unavailable', 'critical',
          'worker-fleet', 'worker-fleet', 'Duplicate', 'Duplicate relay',
          '${at}', '${at}', '${at}'
        )
      `),
      /global_activity_events_organization_digest_unique/,
    );

    const rows = await db.query<{
      state: string;
      row_version: string;
    }>(`select state::text, row_version::text from operators where id = '${operatorId}'`);
    assert.deepEqual(rows.rows, [{ state: "active", row_version: "2" }]);
  } finally {
    await harness.stop();
  }
});
