import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "./database.ts";
import { PACKSCOUT_TRANSACTION_OPTIONS } from "./database.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const ids = Object.freeze({
  organization: "66000000-0000-4000-8000-000000000001",
  legacyAttempt: "66000000-0000-4000-8000-000000000010",
  providerAttempt: "66000000-0000-4000-8000-000000000020",
  manifestAttempt: "66000000-0000-4000-8000-000000000030",
  publicProviderRelease: "66000000-0000-4000-8000-000000000041",
  acknowledgement: "66000000-0000-4000-8000-000000000050",
  barrier: "66000000-0000-4000-8000-000000000060",
});

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function expectConstraintRejection(
  client: PackscoutPrismaClient,
  sql: string,
  constraintName: string,
): Promise<void> {
  await assert.rejects(
    client.$executeRawUnsafe(sql),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const metadata = "meta" in error
        ? JSON.stringify((error as Error & { meta?: unknown }).meta)
        : "";
      assert.match(`${error.message}\n${metadata}`, new RegExp(constraintName));
      return true;
    },
  );
}

async function seedPromotionGraph(client: PackscoutPrismaClient): Promise<void> {
  await client.$executeRawUnsafe(`
    do $promotion_seed$
    begin
    insert into public.organizations (id, slug, name)
    values ('${ids.organization}', 'promotion-hardening', 'Promotion Hardening');

    insert into public.public_change_causes (
      organization_id, sequence, change_kind, entity_key, source_key,
      source_revision_key, occurred_at, authoritative_transaction_id
    ) values (
      '${ids.organization}', 1, 'manual_correction', 'hardening:test',
      'hardening', 'revision-1', current_timestamp, 'hardening-test'
    );

    insert into public.public_change_catalog_impacts (
      organization_id, cause_sequence, provider_platform_keys
    ) values ('${ids.organization}', 1, array[]::text[]);

    insert into public.promotion_lanes (
      organization_id, deployment_key, lane_key
    ) values ('${ids.organization}', 'dev', 'heat');

    insert into public.promotion_attempts (
      id, organization_id, deployment_key, lane_key, target_watermark
    ) values (
      '${ids.legacyAttempt}', '${ids.organization}', 'dev', 'heat', 1
    );

    insert into public.manifest_promotion_lanes (
      organization_id, deployment_key
    ) values ('${ids.organization}', 'dev');

    insert into public.catalog_promotion_bootstrap_proofs (
      organization_id, deployment_key, proof_revision, proof_kind,
      active_state_request_body, active_state_request_sha256,
      active_state_receipt_body, active_state_receipt_sha256,
      active_state_body, active_state_sha256, verified_at
    ) values (
      '${ids.organization}', 'dev', 1, 'empty',
      '{}', '${hashA}', '{}', '${hashA}', '{}', '${hashA}', current_timestamp
    );

    insert into public.provider_promotion_lanes (
      organization_id, deployment_key, platform_key
    ) values ('${ids.organization}', 'dev', 'collector_crypt');

    insert into public.provider_promotion_evaluations (
      organization_id, deployment_key, platform_key, evaluation_sequence,
      checkpoint_body, checkpoint_sha256, settled_checkpoint,
      source_head_checkpoint, requested_at
    ) values (
      '${ids.organization}', 'dev', 'collector_crypt', 1,
      '{}', '${hashA}', 0, 0, current_timestamp
    );

    insert into public.provider_promotion_attempts (
      id, organization_id, deployment_key, platform_key, evaluation_sequence,
      bootstrap_proof_revision, bootstrap_provider_set_sha256, target_checkpoint
    ) values (
      '${ids.providerAttempt}', '${ids.organization}', 'dev', 'collector_crypt',
      1, 1, '${hashA}', 0
    );

    insert into public.manifest_promotion_evaluations (
      organization_id, deployment_key, evaluation_sequence, cause,
      cause_identity, cause_sha256, requested_at
    ) values (
      '${ids.organization}', 'dev', 1, 'bootstrap_reconcile',
      'bootstrap:1', '${hashB}', current_timestamp
    );

    insert into public.manifest_promotion_attempts (
      id, organization_id, deployment_key, evaluation_sequence,
      bootstrap_proof_revision, bootstrap_provider_set_sha256
    ) values (
      '${ids.manifestAttempt}', '${ids.organization}', 'dev', 1, 1, '${hashA}'
    );

    insert into public.catalog_promotion_retention_barriers (
      organization_id, deployment_key
    ) values ('${ids.organization}', 'dev');
    end;
    $promotion_seed$;
  `);
}

test("PostgreSQL rejects NULL-incomplete terminal and bootstrap state families", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedPromotionGraph(harness.client);

    await expectConstraintRejection(
      harness.client,
      `insert into public.public_derivation_obligations (
         organization_id, cause_sequence, derivation_kind, derivation_key,
         state, acknowledged_claim_token, outcome_at
       ) values (
         '${ids.organization}', 1, 'estimated_ev', 'hardening:ev', 'succeeded',
         '${ids.acknowledgement}', current_timestamp
       )`,
      "public_derivation_obligations_outcome_consistency",
    );

    await expectConstraintRejection(
      harness.client,
      `insert into public.promotion_lanes (
         organization_id, deployment_key, lane_key, bootstrap_state,
         bootstrap_verified_at, confirmed_watermark,
         confirmed_publication_identity
       ) values (
         '${ids.organization}', 'dev', 'heat-null-bootstrap', 'verified_local',
         current_timestamp, 1, 'publication:1'
       )`,
      "promotion_lanes_bootstrap_shape_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.promotion_attempts
       set failure_class = 'technical', failure_code = null
       where id = '${ids.legacyAttempt}'`,
      "promotion_attempts_failure_shape_check",
    );

    await expectConstraintRejection(
      harness.client,
      `insert into public.provider_promotion_lanes (
         organization_id, deployment_key, platform_key,
         settled_checkpoint, settled_at, source_head_checkpoint, source_head_at,
         completed_checkpoint, completed_at, completed_public_provider_release_id
       ) values (
         '${ids.organization}', 'dev', 'null_completed',
         1, current_timestamp, 1, current_timestamp,
         1, current_timestamp, '${ids.publicProviderRelease}'
       )`,
      "provider_promotion_lanes_completed_shape_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.provider_promotion_attempts
       set prepared_classification = 'publish',
           public_provider_release_id = '${ids.publicProviderRelease}',
           prepared_at = current_timestamp
       where id = '${ids.providerAttempt}'`,
      "provider_promotion_attempts_prepared_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.provider_promotion_attempts
       set claim_token = '${ids.acknowledgement}',
           claim_expires_at = current_timestamp + interval '1 minute',
           last_heartbeat_at = current_timestamp,
           claim_count = 1
       where id = '${ids.providerAttempt}'`,
      "provider_promotion_attempts_claim_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.provider_promotion_attempts
       set failure_class = 'technical', failure_code = null
       where id = '${ids.providerAttempt}'`,
      "provider_promotion_attempts_failure_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.manifest_promotion_lanes
       set bootstrap_state = 'verified_empty',
           bootstrap_verified_at = current_timestamp,
           current_bootstrap_proof_revision = 1,
           active_state_body = '{}', active_state_sha256 = '${hashA}',
           active_state_receipt_body = '{}',
           active_state_receipt_sha256 = '${hashA}',
           last_reconciled_at = current_timestamp
       where organization_id = '${ids.organization}' and deployment_key = 'dev'`,
      "manifest_promotion_lanes_bootstrap_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.manifest_promotion_lanes
       set bootstrap_state = 'verified_empty',
           bootstrap_verified_at = current_timestamp,
           bootstrap_provider_set_body = '{}',
           bootstrap_provider_set_sha256 = '${hashA}',
           current_bootstrap_proof_revision = 1,
           last_reconciled_at = current_timestamp
       where organization_id = '${ids.organization}' and deployment_key = 'dev'`,
      "manifest_promotion_lanes_active_shape_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.manifest_promotion_attempts
       set prepared_operation_kind = 'activateManifest',
           prepared_at = current_timestamp
       where id = '${ids.manifestAttempt}'`,
      "manifest_promotion_attempts_prepared_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.manifest_promotion_attempts
       set claim_token = '${ids.acknowledgement}',
           claim_expires_at = current_timestamp + interval '1 minute',
           last_heartbeat_at = current_timestamp,
           claim_count = 1
       where id = '${ids.manifestAttempt}'`,
      "manifest_promotion_attempts_claim_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.manifest_promotion_attempts
       set failure_class = 'technical', failure_code = null
       where id = '${ids.manifestAttempt}'`,
      "manifest_promotion_attempts_failure_check",
    );
  } finally {
    await harness.close();
  }
});

test("PostgreSQL rejects NULL-incomplete acknowledgement and proof families", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedPromotionGraph(harness.client);

    await expectConstraintRejection(
      harness.client,
      `insert into public.promotion_operations (
         attempt_id, organization_id, deployment_key, lane_key,
         operation_index, operation_id, operation_kind, request_path,
         canonical_request_body, request_sha256, state, send_count,
         last_sent_at, acknowledged_at, receipt_body
       ) values (
         '${ids.legacyAttempt}', '${ids.organization}', 'dev', 'heat',
         0, 'legacy-ack', 'publish', '/promotion', '{}', '${hashA}',
         'acknowledged', 1, current_timestamp, current_timestamp, '{}'
       )`,
      "promotion_operations_delivery_shape_check",
    );

    await expectConstraintRejection(
      harness.client,
      `insert into public.provider_promotion_operations (
         attempt_id, organization_id, deployment_key, platform_key,
         operation_index, operation_id, operation_kind, request_path,
         canonical_request_body, request_sha256, state, send_count,
         last_sent_at, acknowledged_at
       ) values (
         '${ids.providerAttempt}', '${ids.organization}', 'dev',
         'collector_crypt', 0, 'provider-ack', 'start', '/provider',
         '{}', '${hashA}', 'acknowledged', 1,
         current_timestamp, current_timestamp
       )`,
      "provider_promotion_operations_delivery_check",
    );

    await expectConstraintRejection(
      harness.client,
      `insert into public.manifest_promotion_operations (
         attempt_id, organization_id, deployment_key, operation_index,
         operation_id, operation_kind, request_path, canonical_request_body,
         request_sha256, state, send_count, last_sent_at, acknowledged_at
       ) values (
         '${ids.manifestAttempt}', '${ids.organization}', 'dev', 0,
         'manifest-ack', 'activateManifest', '/manifest', '{}', '${hashA}',
         'acknowledged', 1, current_timestamp, current_timestamp
       )`,
      "manifest_promotion_operations_delivery_check",
    );

    await expectConstraintRejection(
      harness.client,
      `insert into public.catalog_promotion_bootstrap_proofs (
         organization_id, deployment_key, proof_revision, proof_kind,
         active_state_request_body, active_state_request_sha256,
         active_state_receipt_body, active_state_receipt_sha256,
         active_state_body, active_state_sha256, verified_at
       ) values (
         '${ids.organization}', 'dev', 2, 'active',
         '{}', '${hashA}', '{}', '${hashA}', '{}', '${hashA}', current_timestamp
       )`,
      "catalog_promotion_bootstrap_proofs_manifest_shape_check",
    );

    await expectConstraintRejection(
      harness.client,
      `insert into public.catalog_promotion_bootstrap_provider_proofs (
         organization_id, deployment_key, proof_revision, platform_key, ordinal,
         public_provider_release_id, completed_head_request_body,
         completed_head_request_sha256, completed_head_receipt_body,
         completed_head_receipt_sha256, remote_completed_head_body,
         remote_completed_head_sha256
       ) values (
         '${ids.organization}', 'dev', 1, 'collector_crypt', 0,
         '${ids.publicProviderRelease}', '{}', '${hashA}', '{}', '${hashA}',
         '{}', '${hashA}'
       )`,
      "catalog_promotion_bootstrap_provider_proofs_value_check",
    );

    await expectConstraintRejection(
      harness.client,
      `update public.catalog_promotion_retention_barriers
       set state = 'active', barrier_generation = 1,
           barrier_token = '${ids.barrier}', activated_at = current_timestamp
       where organization_id = '${ids.organization}' and deployment_key = 'dev'`,
      "catalog_promotion_retention_barriers_state_check",
    );

    await expectConstraintRejection(
      harness.client,
      `insert into public.catalog_promotion_retention_operations (
         organization_id, deployment_key, barrier_generation, operation_index,
         operation_id, idempotency_key, operation_kind, phase,
         expected_retention_generation, canonical_request_body, request_sha256,
         state, send_count, last_sent_at, acknowledged_at, terminal_state,
         has_more, postgres_cleanup_complete
       ) values (
         '${ids.organization}', 'dev', 1, 0, 'retention-ack', 'retention-ack',
         'retainManifests', 'manifests', 1, '{}', '${hashA}', 'acknowledged',
         1, current_timestamp, current_timestamp, 'complete', false, true
       )`,
      "catalog_promotion_retention_operations_state_check",
    );
  } finally {
    await harness.close();
  }
});

async function waitForLockWait(
  client: PackscoutPrismaClient,
  processId: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await client.$queryRawUnsafe<Array<{
      waitEventType: string | null;
    }>>(`
      select wait_event_type as "waitEventType"
      from pg_stat_activity
      where pid = ${processId}
    `);
    if (rows[0]?.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("retention barrier activation did not wait on the organization lock");
}

test("retention activation serializes with an in-flight guarded write", async () => {
  const harness = await createMigratedTestDatabase();
  const activationClient = await harness.createIndependentClient();
  const writerReady = deferred<void>();
  const releaseWriter = deferred<void>();
  const activationReady = deferred<number>();
  try {
    await harness.client.$executeRawUnsafe(`
      do $retention_seed$
      begin
      insert into public.organizations (id, slug, name)
      values ('${ids.organization}', 'retention-lock', 'Retention Lock');
      insert into public.catalog_promotion_retention_barriers (
        organization_id, deployment_key
      ) values ('${ids.organization}', 'dev');
      end;
      $retention_seed$;
    `);

    const writer = harness.client.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(`
        insert into public.promotion_lanes (
          organization_id, deployment_key, lane_key
        ) values ('${ids.organization}', 'dev', 'heat')
      `);
      writerReady.resolve();
      await releaseWriter.promise;
    }, PACKSCOUT_TRANSACTION_OPTIONS);
    await writerReady.promise;

    const activation = activationClient.$transaction(async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<Array<{ pid: number }>>(
        "select pg_backend_pid()::integer as pid",
      );
      activationReady.resolve(rows[0]!.pid);
      await transaction.$executeRawUnsafe(`
        update public.catalog_promotion_retention_barriers
        set state = 'active', barrier_generation = 1,
            barrier_token = '${ids.barrier}', snapshot_body = '{}',
            snapshot_digest = '${hashA}', activated_at = current_timestamp,
            updated_at = current_timestamp
        where organization_id = '${ids.organization}' and deployment_key = 'dev'
      `);
    }, PACKSCOUT_TRANSACTION_OPTIONS);

    const activationProcessId = await activationReady.promise;
    await waitForLockWait(harness.client, activationProcessId);
    const stateWhileWriterHeld = await harness.client.$queryRawUnsafe<
      Array<{ state: string }>
    >(`
      select state from public.catalog_promotion_retention_barriers
      where organization_id = '${ids.organization}' and deployment_key = 'dev'
    `);
    assert.equal(stateWhileWriterHeld[0]?.state, "inactive");

    releaseWriter.resolve();
    await Promise.all([writer, activation]);
    const activated = await harness.client.$queryRawUnsafe<Array<{ state: string }>>(`
      select state from public.catalog_promotion_retention_barriers
      where organization_id = '${ids.organization}' and deployment_key = 'dev'
    `);
    assert.equal(activated[0]?.state, "active");

    await assert.rejects(
      harness.client.$executeRawUnsafe(`
        insert into public.promotion_lanes (
          organization_id, deployment_key, lane_key
        ) values ('${ids.organization}', 'dev', 'catalog')
      `),
      /catalog promotion retention barrier is active/,
    );
  } finally {
    releaseWriter.resolve();
    await harness.close();
  }
});
