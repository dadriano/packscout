import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceSupervisorWorkRepository } from
  "./provider-source-supervisor-work-repository.ts";

test("an unavailable elapsed continuation is isolated from later queue work", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "continuation-unavailable-isolated",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, {
      platformKey: "courtyard",
      displayName: "Courtyard",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      intervalSeconds: 60,
      hashCharacter: "b",
    });
    const [{ now }] = await fixture.database.$queryRaw<Array<{ now: Date }>>`
      select clock_timestamp() as "now"
    `;
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);
    const ownerKey = "continuation-unavailable-owner";
    const leaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(fixture.database)
      .acquire({
        environmentKey: "continuation-unavailable-environment",
        ownerKey,
        leaseToken,
        now,
      });
    const claimToken = randomUUID();
    const claimLeaseId = randomUUID();
    const run = await createPinnedSourceRun(
      fixture.database,
      fixture,
      source,
      {
        state: "running",
        createdAt: new Date(now.getTime() - 16 * 60_000),
        requestedCursor: null,
        requestedCursorFingerprint: null,
        leaseOwner: ownerKey,
        leaseToken: claimToken,
        claimLeaseId,
        leaseExpiresAt: new Date(now.getTime() + 30_000),
      },
    );
    const requestAttemptId = randomUUID();
    const pageId = randomUUID();
    const nextCursor = "unavailable-continuation-cursor";
    const nextFingerprint = "9".repeat(64);
    await fixture.database.compact_source_request_attempts.create({
      data: {
        request_attempt_id: requestAttemptId,
        organization_id: fixture.organizationId,
        operation_kind: "page_read",
        terminal_state: "captured",
        outcome_class: "response_captured",
        safe_outcome_hash: "8".repeat(64),
        request_lease_id: randomUUID(),
        claim_owner: ownerKey,
        claim_token: claimToken,
        supervisor_epoch_id: epoch.epochId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        run_id: run.id,
        page_number: 1,
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        started_at: now,
        terminal_at: now,
      },
    });
    await fixture.database.import_pages.create({
      data: {
        id: pageId,
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        run_id: run.id,
        page_number: 1,
        payload_json: { protectedEvidenceRef: `page:${pageId}` },
        payload_hash: "a".repeat(64),
        record_counts_json: { records: 1 },
        committed_at: now,
        expires_at: new Date(now.getTime() + 7 * 86_400_000),
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
        connection_health_generation: 0n,
        request_attempt_id: requestAttemptId,
        run_claim_lease_id: claimLeaseId,
        supervisor_epoch_id: epoch.epochId,
        cursor_codec_version: ACCEPTANCE_CURSOR_CODEC_VERSION,
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        next_cursor: nextCursor,
        next_cursor_fingerprint: nextFingerprint,
        continuation_kind: "continue",
        protected_raw_response: new TextEncoder().encode("protected-page"),
        protected_raw_response_sha256: "a".repeat(64),
        normalized_commit_hash: "b".repeat(64),
      },
    });
    await fixture.database.provider_source_cursor_fingerprints.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        cursor_generation: 1n,
        source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        cursor_codec_version: ACCEPTANCE_CURSOR_CODEC_VERSION,
        cursor_fingerprint: nextFingerprint,
        first_committed_run_id: run.id,
        first_committed_page_id: pageId,
        committed_at: now,
      },
    });
    await Promise.all([
      fixture.database.provider_source_cursors.update({
        where: { source_instance_id: source.sourceInstanceId },
        data: {
          cursor: nextCursor,
          cursor_fingerprint: nextFingerprint,
          advanced_by_run_id: run.id,
          advanced_by_page_id: pageId,
          updated_at: now,
        },
      }),
      fixture.database.import_runs.update({
        where: { id: run.id },
        data: {
          state: "queued",
          lease_owner: null,
          lease_token: null,
          claim_lease_id: null,
          lease_expires_at: null,
          heartbeat_at: null,
          current_cursor: nextCursor,
          current_cursor_fingerprint: nextFingerprint,
          current_cursor_key: nextFingerprint,
          next_page_number: 2,
          counters_json: { pages: 1, records: 1 },
        },
      }),
      fixture.database.provider_source_runtime_states.update({
        where: { source_instance_id: source.sourceInstanceId },
        data: {
          current_run_id: run.id,
          phase: "queued",
          activity: "queued",
          queued_at: now,
          updated_at: now,
        },
      }),
    ]);
    await fixture.database.provider_sources.update({
      where: { id: source.providerId },
      data: { state: "disabled", updated_at: now },
    });
    const laterJob = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        requested_by_actor_key: "operator-admin",
        queued_at: new Date(now.getTime() + 1_000),
      },
    });

    const claimed = await new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    ).claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });

    assert.equal(claimed?.kind, "connection_test");
    assert.equal(claimed?.id, laterJob.id);
    const [storedRun, runtime] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({ where: { id: run.id } }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(storedRun.state, "incomplete");
    assert.equal(runtime.phase, "action_required");
    assert.equal(runtime.activity, "action_required");
    assert.equal(
      runtime.action_required_code,
      "SOURCE_CONTINUATION_UNAVAILABLE",
    );
    assert.equal(runtime.current_run_id, null);
  } finally {
    await fixture.close();
  }
});
