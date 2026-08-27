import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContentSchema,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import type { PackscoutPrismaClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import {
  hashNormalizedObservationSemanticContent,
  ProviderSourceObservationRepository,
} from "./provider-source-observation-repository.ts";
import { ProviderSourceRequestRepository } from "./provider-source-request-repository.ts";
import { ProviderSourceSupervisorRepository } from "./provider-source-supervisor-repository.ts";
import { ProviderSourceTestResultRepository } from "./provider-source-test-result-repository.ts";

const sourceDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
  intervalSeconds: 60,
  hashCharacter: "b",
} as const;

async function databaseClock(database: PackscoutPrismaClient): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return rows[0]!.now;
}

test("provider-source history and diagnostic retention are enforced by PostgreSQL", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "history-immutability",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      sourceDefinition,
    );
    const scheduleRevision =
      await fixture.database.provider_source_schedule_revisions.findFirstOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      });

    await fixture.database.provider_source_schedule_revisions.update({
      where: { id: scheduleRevision.id },
      data: { interval_seconds: scheduleRevision.interval_seconds },
    });
    await assert.rejects(
      fixture.database.provider_source_schedule_revisions.update({
        where: { id: scheduleRevision.id },
        data: { interval_seconds: scheduleRevision.interval_seconds + 1 },
      }),
      /append-only/u,
    );
    await assert.rejects(
      fixture.database.provider_source_schedule_revisions.update({
        where: { id: scheduleRevision.id },
        data: { records_per_request: scheduleRevision.records_per_request + 1 },
      }),
      /append-only/u,
    );
    await assert.rejects(
      fixture.database.provider_source_schedule_revisions.delete({
        where: { id: scheduleRevision.id },
      }),
      /append-only/u,
    );

    const effectiveAt = ACCEPTANCE_CREATED_AT.toISOString();
    const semanticContent = normalizedObservationSemanticContentSchema.parse({
      kind: "catalog",
      entity: "pack",
      providerRecordIdentity: {
        recordIdScopeKey: "catalog-pack-v1",
        providerRecordId: "immutable-pack-1",
      },
      effectiveAt,
      firstSeenAt: effectiveAt,
      availability: "available",
      providerFacts: emptyNormalizedProviderFacts("pack"),
      relationships: [],
    });
    const observations = new ProviderSourceObservationRepository();
    const observation = await fixture.database.$transaction((transaction) =>
      observations.upsertSemanticObservationInTransaction(transaction, {
        organizationId: fixture.organizationId,
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        recordIdScopeKey: "catalog-pack-v1",
        providerRecordId: "immutable-pack-1",
        recordKind: "catalog",
        recordDiscriminator: "catalog_pack",
        effectiveSourceTime: ACCEPTANCE_CREATED_AT,
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
        hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
        normalizedContentHash:
          hashNormalizedObservationSemanticContent(semanticContent),
        normalizedContent: semanticContent,
      }),
    );
    assert.equal(observation.kind, "ready");
    if (observation.kind !== "ready") return;

    await fixture.database.source_record_identities.update({
      where: { id: observation.sourceRecordId },
      data: { provider_record_id: "immutable-pack-1" },
    });
    await assert.rejects(
      fixture.database.source_record_identities.update({
        where: { id: observation.sourceRecordId },
        data: { provider_record_id: "rewritten-pack" },
      }),
      /append-only/u,
    );
    await assert.rejects(
      fixture.database.source_record_identities.delete({
        where: { id: observation.sourceRecordId },
      }),
      /append-only/u,
    );
    await assert.rejects(
      fixture.database.source_semantic_observations.update({
        where: { id: observation.semanticObservationId },
        data: { normalized_content_hash: "f".repeat(64) },
      }),
      /append-only/u,
    );
    await assert.rejects(
      fixture.database.source_semantic_observations.delete({
        where: { id: observation.semanticObservationId },
      }),
      /append-only/u,
    );

    const ownerKey = "history-worker";
    const supervisorLeaseToken = randomUUID();
    const supervisor = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "history-immutability",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: ACCEPTANCE_CREATED_AT,
    });
    const committedAt = await databaseClock(fixture.database);
    const runLeaseToken = randomUUID();
    const run = await createPinnedSourceRun(
      fixture.database,
      fixture,
      source,
      {
        state: "running",
        createdAt: committedAt,
        requestedCursor: null,
        requestedCursorFingerprint: null,
        leaseOwner: ownerKey,
        leaseToken: runLeaseToken,
        leaseExpiresAt: supervisor.leaseExpiresAt,
      },
    );
    const requestAttemptId = randomUUID();
    const pageId = randomUUID();
    const cursorFingerprint = "c".repeat(64);
    await fixture.database.compact_source_request_attempts.create({
      data: {
        request_attempt_id: requestAttemptId,
        organization_id: fixture.organizationId,
        operation_kind: "page_read",
        terminal_state: "captured",
        outcome_class: "response_captured",
        safe_outcome_hash: "d".repeat(64),
        request_lease_id: randomUUID(),
        claim_owner: ownerKey,
        claim_token: runLeaseToken,
        supervisor_epoch_id: supervisor.epochId,
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
        started_at: committedAt,
        terminal_at: committedAt,
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
        payload_hash: "e".repeat(64),
        record_counts_json: { records: 1 },
        committed_at: committedAt,
        expires_at: new Date(committedAt.getTime() + 7 * 86_400_000),
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
        supervisor_epoch_id: supervisor.epochId,
        cursor_codec_version: ACCEPTANCE_CURSOR_CODEC_VERSION,
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        next_cursor: "cursor-1",
        next_cursor_fingerprint: cursorFingerprint,
        continuation_kind: "continue",
        protected_raw_response: new TextEncoder().encode("protected-page"),
        protected_raw_response_sha256: "e".repeat(64),
        normalized_commit_hash: "f".repeat(64),
      },
    });
    const fingerprint =
      await fixture.database.provider_source_cursor_fingerprints.create({
        data: {
          organization_id: fixture.organizationId,
          provider_id: source.providerId,
          source_instance_id: source.sourceInstanceId,
          source_revision_id: source.sourceRevisionId,
          cursor_generation: 1n,
          source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
          cursor_codec_version: ACCEPTANCE_CURSOR_CODEC_VERSION,
          cursor_fingerprint: cursorFingerprint,
          first_committed_run_id: run.id,
          first_committed_page_id: pageId,
          committed_at: committedAt,
        },
      });
    const occurrence = await fixture.database.source_delivery_occurrences.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        run_id: run.id,
        page_id: pageId,
        record_index: 0,
        request_attempt_id: requestAttemptId,
        source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
        source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        mapper_key: source.mapperKey,
        mapper_version: "1",
        identity_namespace_key: source.identityNamespaceKey,
        cursor_codec_version: ACCEPTANCE_CURSOR_CODEC_VERSION,
        cursor_generation: 1n,
        connection_health_generation: 0n,
        supervisor_epoch_id: supervisor.epochId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        collected_at: committedAt,
        native_evidence_reference: `page:${pageId}:record:0`,
        disposition: "quarantined",
        reason_code: "fixture_quarantine",
      },
    });
    for (const mutation of [
      fixture.database.provider_source_cursor_fingerprints.update({
        where: { id: fingerprint.id },
        data: { committed_at: new Date(committedAt.getTime() + 1) },
      }),
      fixture.database.provider_source_cursor_fingerprints.delete({
        where: { id: fingerprint.id },
      }),
      fixture.database.source_delivery_occurrences.update({
        where: { id: occurrence.id },
        data: { reason_code: "rewritten_quarantine" },
      }),
      fixture.database.source_delivery_occurrences.delete({
        where: { id: occurrence.id },
      }),
    ]) {
      await assert.rejects(mutation, /append-only/u);
    }

    const diagnosticRepository = new ProviderSourceDiagnosticRepository(
      fixture.database,
    );
    const appendLifecycleDiagnostic = async (occurredAt: Date, key: string) => {
      const audit = await fixture.database.audit_events.create({
        data: {
          organization_id: fixture.organizationId,
          actor_key: "operator-admin",
          action: `provider_source.${key}`,
          subject_type: "provider_source",
          subject_id: source.sourceInstanceId,
          outcome: "success",
          occurred_at: occurredAt,
        },
      });
      return diagnosticRepository.append({
        organizationId: fixture.organizationId,
        scope: "source",
        correlationKind: "lifecycle",
        eventKind: "source_lifecycle",
        severity: "info",
        phase: "lifecycle",
        safeCode: "SOURCE_STATE_RECORDED",
        occurredAt,
        sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
        sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        connectionProfileId: fixture.connectionProfileId,
        connectionRevisionId: fixture.connectionRevisionId,
        auditEventId: audit.id,
      });
    };
    const currentDiagnosticId = await appendLifecycleDiagnostic(
      committedAt,
      "current-diagnostic",
    );
    await assert.rejects(
      fixture.database.source_processor_diagnostic_events.update({
        where: { id: currentDiagnosticId },
        data: { phase: "rewritten" },
      }),
      /immutable until retention expiry/u,
    );
    await assert.rejects(
      fixture.database.source_processor_diagnostic_events.delete({
        where: { id: currentDiagnosticId },
      }),
      /immutable until retention expiry/u,
    );
    const expiredDiagnosticId = await appendLifecycleDiagnostic(
      new Date(committedAt.getTime() - 31 * 86_400_000),
      "expired-diagnostic",
    );
    await fixture.database.source_processor_diagnostic_events.delete({
      where: { id: expiredDiagnosticId },
    });
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: { id: expiredDiagnosticId },
      }),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("request attempts and connection episodes permit only proven lifecycle transitions", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "attempt-episode-lifecycle",
  );
  try {
    const ownerKey = "lifecycle-worker";
    const supervisorLeaseToken = randomUUID();
    const supervisor = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "attempt-episode-lifecycle",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: ACCEPTANCE_CREATED_AT,
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const testResults = new ProviderSourceTestResultRepository(fixture.database);
    const createJob = async (
      expectedHealthGeneration: bigint,
      blockingEpisodeId: string | null = null,
    ) => {
      const claimToken = randomUUID();
      const job = await fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.connectionProfileId,
          connection_revision_id: fixture.connectionRevisionId,
          blocking_episode_id: blockingEpisodeId,
          recovery_blocked_revision_id: blockingEpisodeId
            ? fixture.connectionRevisionId
            : null,
          expected_health_generation: expectedHealthGeneration,
          state: "running",
          requested_by_actor_key: "operator-admin",
          claim_owner: ownerKey,
          claim_token: claimToken,
          claim_expires_at: supervisor.leaseExpiresAt,
          supervisor_epoch_id: supervisor.epochId,
          started_at: await databaseClock(fixture.database),
        },
      });
      return { job, claimToken };
    };
    const beginConnectionAttempt = async (
      jobId: string,
      claimToken: string,
      expectedHealthGeneration: bigint,
      blockingEpisodeId: string | null = null,
    ) => requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: supervisor.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration,
      operation: {
        kind: "connection_test",
        connectionTestJobId: jobId,
        blockingEpisodeId,
      },
      startedAt: ACCEPTANCE_CREATED_AT,
    });
    const terminalizeCaptured = async (
      attemptId: string,
      hashCharacter: string,
    ) => requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: supervisor.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: hashCharacter.repeat(64),
      terminalAt: ACCEPTANCE_CREATED_AT,
    });

    const initial = await createJob(0n);
    const directTerminalAt = await databaseClock(fixture.database);
    await assert.rejects(
      fixture.database.source_request_attempts.create({
        data: {
          organization_id: fixture.organizationId,
          operation_kind: "connection_test",
          state: "captured",
          request_lease_id: randomUUID(),
          claim_owner: ownerKey,
          claim_token: initial.claimToken,
          supervisor_epoch_id: supervisor.epochId,
          connection_profile_id: fixture.connectionProfileId,
          connection_revision_id: fixture.connectionRevisionId,
          expected_health_generation: 0n,
          connection_test_job_id: initial.job.id,
          outcome_class: "response_captured",
          safe_outcome_hash: "0".repeat(64),
          started_at: directTerminalAt,
          terminal_at: directTerminalAt,
          expires_at: new Date(
            directTerminalAt.getTime() + 30 * 86_400_000,
          ),
        },
      }),
      /must begin in flight without terminal evidence/u,
    );
    const initialAttemptId = await beginConnectionAttempt(
      initial.job.id,
      initial.claimToken,
      0n,
    );
    await assert.rejects(
      fixture.database.source_request_attempts.update({
        where: { id: initialAttemptId },
        data: { claim_owner: "rewritten-owner" },
      }),
      /durable proof/u,
    );
    await assert.rejects(
      fixture.database.source_request_attempts.delete({
        where: { id: initialAttemptId },
      }),
      /durable retention expiry/u,
    );
    const invalidTerminalAt = await databaseClock(fixture.database);
    await assert.rejects(
      fixture.database.source_request_attempts.update({
        where: { id: initialAttemptId },
        data: {
          state: "captured",
          outcome_class: "response_captured",
          safe_outcome_hash: "1".repeat(64),
          terminal_at: invalidTerminalAt,
          expires_at: new Date(
            invalidTerminalAt.getTime() + 30 * 86_400_000,
          ),
        },
      }),
      /does not match durable proof/u,
    );
    await terminalizeCaptured(initialAttemptId, "1");
    await assert.rejects(
      fixture.database.source_request_attempts.update({
        where: { id: initialAttemptId },
        data: { safe_code: "rewritten_code" },
      }),
      /immutable outside retention compaction/u,
    );
    await assert.rejects(
      fixture.database.source_request_attempts.update({
        where: { id: initialAttemptId },
        data: { compacted_at: await databaseClock(fixture.database) },
      }),
      /immutable outside retention compaction/u,
    );
    await assert.rejects(
      fixture.database.source_request_attempts.delete({
        where: { id: initialAttemptId },
      }),
      /durable retention expiry/u,
    );
    const initialResult = await testResults.completeConnectionTest({
      organizationId: fixture.organizationId,
      jobId: initial.job.id,
      requestAttemptId: initialAttemptId,
      claimOwner: ownerKey,
      claimToken: initial.claimToken,
      supervisorEpochId: supervisor.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_test_succeeded",
      completedAt: ACCEPTANCE_CREATED_AT,
    });
    assert.deepEqual(
      await testResults.completeConnectionTest({
        organizationId: fixture.organizationId,
        jobId: initial.job.id,
        requestAttemptId: initialAttemptId,
        claimOwner: ownerKey,
        claimToken: initial.claimToken,
        supervisorEpochId: supervisor.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        outcome: "success",
        safeCode: "connection_test_succeeded",
        completedAt: new Date(0),
      }),
      initialResult,
    );
    await assert.rejects(
      testResults.completeConnectionTest({
        organizationId: fixture.organizationId,
        jobId: initial.job.id,
        requestAttemptId: initialAttemptId,
        claimOwner: ownerKey,
        claimToken: initial.claimToken,
        supervisorEpochId: supervisor.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        outcome: "success",
        safeCode: "connection_test_succeeded",
        measurements: { response_bytes: 1 },
        completedAt: ACCEPTANCE_CREATED_AT,
      }),
      (error: unknown) => error instanceof PersistenceError &&
        error.code === "SOURCE_FENCED",
    );

    const assertEpisodeOpeningRejected = async (
      openedByRequestAttemptId: string | null,
    ): Promise<void> => {
      await assert.rejects(
        fixture.database.$transaction(async (transaction) => {
          await transaction.source_connection_health_episodes.create({
            data: {
              organization_id: fixture.organizationId,
              connection_profile_id: fixture.connectionProfileId,
              connection_revision_id: fixture.connectionRevisionId,
              opened_health_generation: 1n,
              failure_class: "authentication_failed",
              safe_code: "authentication_failed",
              opened_by_request_attempt_id: openedByRequestAttemptId,
              opened_at: await databaseClock(fixture.database),
            },
          });
        }),
        /opening lacks exact request proof/u,
      );
    };
    await assertEpisodeOpeningRejected(null);
    await assertEpisodeOpeningRejected(initialAttemptId);

    const blocking = await createJob(0n);
    const blockingAttemptId = await beginConnectionAttempt(
      blocking.job.id,
      blocking.claimToken,
      0n,
    );
    const blocked = await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: blockingAttemptId,
      supervisorEpochId: supervisor.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "failed",
      outcomeClass: "authentication_failed",
      safeCode: "authentication_failed",
      safeOutcomeHash: "2".repeat(64),
      terminalAt: ACCEPTANCE_CREATED_AT,
      blockingFailure: {
        failureClass: "authentication_failed",
        safeCode: "authentication_failed",
      },
    });
    assert.ok(blocked.blockingEpisodeId);
    const episodeId = blocked.blockingEpisodeId!;
    const openEpisode =
      await fixture.database.source_connection_health_episodes.findUniqueOrThrow({
        where: { id: episodeId },
      });
    assert.equal(openEpisode.opened_by_request_attempt_id, blockingAttemptId);
    await assert.rejects(
      fixture.database.source_connection_health_episodes.update({
        where: { id: episodeId },
        data: { safe_code: "rewritten_failure" },
      }),
      /lacks correlated lifecycle proof/u,
    );
    await assert.rejects(
      fixture.database.source_connection_health_episodes.delete({
        where: { id: episodeId },
      }),
      /permanent lifecycle evidence/u,
    );
    await assert.rejects(
      fixture.database.source_connection_health_episodes.update({
        where: { id: episodeId },
        data: {
          closed_health_generation: 2n,
          closed_by_test_result_id: initialResult.resultId,
          closed_at: await databaseClock(fixture.database),
        },
      }),
      /lacks correlated lifecycle proof/u,
    );

    const recovery = await createJob(1n, episodeId);
    const recoveryAttemptId = await beginConnectionAttempt(
      recovery.job.id,
      recovery.claimToken,
      1n,
      episodeId,
    );
    await terminalizeCaptured(recoveryAttemptId, "3");
    const recovered = await testResults.completeConnectionTest({
      organizationId: fixture.organizationId,
      jobId: recovery.job.id,
      requestAttemptId: recoveryAttemptId,
      claimOwner: ownerKey,
      claimToken: recovery.claimToken,
      supervisorEpochId: supervisor.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_test_succeeded",
      completedAt: ACCEPTANCE_CREATED_AT,
    });
    assert.equal(recovered.episodeClosed, true);
    assert.deepEqual(
      await testResults.completeConnectionTest({
        organizationId: fixture.organizationId,
        jobId: recovery.job.id,
        requestAttemptId: recoveryAttemptId,
        claimOwner: ownerKey,
        claimToken: recovery.claimToken,
        supervisorEpochId: supervisor.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        outcome: "success",
        safeCode: "connection_test_succeeded",
        completedAt: new Date(0),
      }),
      recovered,
    );
    const closedEpisode =
      await fixture.database.source_connection_health_episodes.findUniqueOrThrow({
        where: { id: episodeId },
      });
    assert.equal(closedEpisode.closed_health_generation, 2n);
    assert.equal(closedEpisode.closed_by_test_result_id, recovered.resultId);
    await assert.rejects(
      fixture.database.source_connection_health_episodes.update({
        where: { id: episodeId },
        data: { closed_at: new Date(closedEpisode.closed_at!.getTime() + 1) },
      }),
      /lacks correlated lifecycle proof/u,
    );

    const retained = await createJob(2n);
    const terminalAt = new Date(
      (await databaseClock(fixture.database)).getTime() - 31 * 86_400_000,
    );
    const startedAt = new Date(terminalAt.getTime() - 1_000);
    const retainedAttemptId = randomUUID();
    const retainedLeaseId = randomUUID();
    await fixture.database.source_request_attempts.create({
      data: {
        id: retainedAttemptId,
        organization_id: fixture.organizationId,
        operation_kind: "connection_test",
        request_lease_id: retainedLeaseId,
        claim_owner: ownerKey,
        claim_token: retained.claimToken,
        supervisor_epoch_id: supervisor.epochId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 2n,
        connection_test_job_id: retained.job.id,
        started_at: startedAt,
      },
    });
    await fixture.database.compact_source_request_attempts.create({
      data: {
        request_attempt_id: retainedAttemptId,
        organization_id: fixture.organizationId,
        operation_kind: "connection_test",
        terminal_state: "captured",
        outcome_class: "response_captured",
        safe_outcome_hash: "4".repeat(64),
        request_lease_id: retainedLeaseId,
        claim_owner: ownerKey,
        claim_token: retained.claimToken,
        supervisor_epoch_id: supervisor.epochId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 2n,
        connection_test_job_id: retained.job.id,
        started_at: startedAt,
        terminal_at: terminalAt,
      },
    });
    await fixture.database.source_request_attempts.update({
      where: { id: retainedAttemptId },
      data: {
        state: "captured",
        outcome_class: "response_captured",
        safe_outcome_hash: "4".repeat(64),
        terminal_at: terminalAt,
        expires_at: new Date(terminalAt.getTime() + 30 * 86_400_000),
      },
    });
    const compactedAt = await databaseClock(fixture.database);
    await fixture.database.source_request_attempts.update({
      where: { id: retainedAttemptId },
      data: { compacted_at: compactedAt },
    });
    await fixture.database.compact_source_request_attempts.update({
      where: { request_attempt_id: retainedAttemptId },
      data: { compacted_at: compactedAt },
    });
    await fixture.database.source_request_attempts.delete({
      where: { id: retainedAttemptId },
    });
    assert.equal(
      await fixture.database.source_request_attempts.count({
        where: { id: retainedAttemptId },
      }),
      0,
    );
  } finally {
    await fixture.close();
  }
});
