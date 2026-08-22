import assert from "node:assert/strict";
import { test } from "node:test";
import { providerIdentityNamespaceByLaunchProvider } from "@packscout/contracts";
import type { Prisma } from "@prisma/client";
import {
  ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";

const sourceDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
  intervalSeconds: 60,
  hashCharacter: "b",
} as const;

test("source-owned run pins survive queued and running progress without repinning", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "run-pin-immutability",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      sourceDefinition,
    );
    const revisionTwo = await fixture.database.provider_source_revisions.create(
      {
        data: {
          organization_id: fixture.organizationId,
          provider_id: source.providerId,
          source_instance_id: source.sourceInstanceId,
          connection_profile_id: fixture.connectionProfileId,
          revision_number: 2,
          source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
          source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
          normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
          mapper_key: source.mapperKey,
          mapper_version: "2",
          identity_namespace_key: source.identityNamespaceKey,
          checkpoint_codec_version: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
          configuration_json: { provider: "courtyard", revision: 2 },
          configuration_hash: "c".repeat(64),
          record_id_scopes_json: [
            "catalog-pack-v1",
            "catalog-card-v1",
            "pull-v1",
            "trade-v1",
          ],
          created_by_actor_key: "operator-admin",
          created_at: new Date(ACCEPTANCE_CREATED_AT.getTime() + 1_000),
        },
      },
    );
    await assert.rejects(
      fixture.database.provider_source_revisions.delete({
        where: { id: revisionTwo.id },
      }),
      /provider source revisions are insert-only/u,
    );
    const run = await fixture.database.import_runs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        config_revision_id: null,
        trigger: "scheduled",
        state: "queued",
        created_at: ACCEPTANCE_CREATED_AT,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
        source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        mapper_key: source.mapperKey,
        mapper_version: "1",
        identity_namespace_key: source.identityNamespaceKey,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        checkpoint_codec_version: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
        checkpoint_generation: 1n,
        requested_checkpoint: null,
        requested_checkpoint_fingerprint: null,
        requested_checkpoint_key: "initial",
        current_checkpoint: null,
        current_checkpoint_fingerprint: null,
        current_checkpoint_key: "initial",
        next_page_number: 1,
      },
    });

    const revisionTwoPins = {
      source_revision_id: revisionTwo.id,
      normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      mapper_version: "2",
    } as const;
    const assertRepinRejected = async (
      data: Prisma.import_runsUncheckedUpdateInput,
    ): Promise<void> => {
      await assert.rejects(
        fixture.database.import_runs.update({
          where: { id: run.id },
          data,
        }),
        /source-owned import run pins are immutable/u,
      );
    };

    await assertRepinRejected(revisionTwoPins);

    const startedAt = new Date(ACCEPTANCE_CREATED_AT.getTime() + 2_000);
    const leaseToken = "75000000-0000-4000-8000-000000000001";
    const claimed = await fixture.database.import_runs.update({
      where: { id: run.id },
      data: {
        trigger: "continuation",
        state: "running",
        started_at: startedAt,
        heartbeat_at: startedAt,
        counters_json: {
          pages: 1,
          records: 2,
          accepted: 2,
          duplicate: 0,
          quarantined: 0,
          requestAttempts: 1,
          transientRetries: 0,
        },
        lease_owner: "worker-a",
        lease_token: leaseToken,
        lease_expires_at: new Date(startedAt.getTime() + 30_000),
        attempt: 1,
      },
    });
    assert.equal(claimed.trigger, "continuation");
    assert.equal(claimed.state, "running");
    assert.equal(claimed.lease_token, leaseToken);
    assert.equal(claimed.attempt, 1);

    await assertRepinRejected(revisionTwoPins);

    const requestedCheckpoint = new Uint8Array(new ArrayBuffer(12));
    requestedCheckpoint.set(new TextEncoder().encode("checkpoint-a"));
    await assertRepinRejected({
      requested_checkpoint: requestedCheckpoint,
      requested_checkpoint_fingerprint: "d".repeat(64),
      requested_checkpoint_key: "d".repeat(64),
    });

    const progressedAt = new Date(startedAt.getTime() + 5_000);
    const progressed = await fixture.database.import_runs.update({
      where: { id: run.id },
      data: {
        heartbeat_at: progressedAt,
        counters_json: {
          pages: 2,
          records: 4,
          accepted: 3,
          duplicate: 1,
          quarantined: 0,
          requestAttempts: 2,
          transientRetries: 0,
        },
        lease_expires_at: new Date(progressedAt.getTime() + 30_000),
        attempt: { increment: 1 },
        reached_provider_head: true,
      },
    });
    assert.equal(progressed.state, "running");
    assert.equal(progressed.attempt, 2);
    assert.equal(progressed.reached_provider_head, true);
    assert.deepEqual(progressed.counters_json, {
      pages: 2,
      records: 4,
      accepted: 3,
      duplicate: 1,
      quarantined: 0,
      requestAttempts: 2,
      transientRetries: 0,
    });

    const finishedAt = new Date(progressedAt.getTime() + 1_000);
    const finished = await fixture.database.import_runs.update({
      where: { id: run.id },
      data: {
        state: "succeeded",
        finished_at: finishedAt,
        heartbeat_at: finishedAt,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      },
    });
    assert.equal(finished.state, "succeeded");
    assert.equal(finished.lease_owner, null);
    assert.equal(finished.source_revision_id, source.sourceRevisionId);
    assert.equal(
      finished.normalized_contract_version,
      ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
    );
    assert.equal(finished.requested_checkpoint_key, "initial");

    const pinFunction = await fixture.database.$queryRaw<
      Array<{ definition: string }>
    >`
      select pg_get_functiondef(oid) as definition
      from pg_proc
      where proname = 'enforce_import_run_source_pin_immutability'
    `;
    for (const pin of [
      "organization_id",
      "provider_id",
      "source_instance_id",
      "source_revision_id",
      "source_type_key",
      "source_adapter_version",
      "normalized_contract_version",
      "mapper_key",
      "mapper_version",
      "identity_namespace_key",
      "connection_profile_id",
      "connection_revision_id",
      "checkpoint_codec_version",
      "checkpoint_generation",
      "requested_checkpoint",
      "requested_checkpoint_fingerprint",
      "requested_checkpoint_key",
    ]) {
      assert.match(
        pinFunction[0]?.definition ?? "",
        new RegExp(`"${pin}"`, "u"),
      );
    }

    const resultSafety = await fixture.database.$queryRaw<
      Array<{ definition: string }>
    >`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'source_connection_test_results_generation_check'
    `;
    assert.match(
      resultSafety[0]?.definition ?? "",
      /response_status.*100.*599/su,
    );
    assert.match(resultSafety[0]?.definition ?? "", /latency_ms.*>= 0/su);
  } finally {
    await fixture.close();
  }
});
