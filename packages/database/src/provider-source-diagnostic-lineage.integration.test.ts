import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import { ProviderSourceLifecycleRepository } from "./provider-source-lifecycle-repository.ts";
import { ProviderSourceRequestRepository } from "./provider-source-request-repository.ts";
import { ProviderSourceSupervisorRepository } from "./provider-source-supervisor-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const sourceTypeKey = "dataforrest-events-v1";
const sourceAdapterVersion = "dataforrest-events-adapter-v1";
const normalizedContractVersion = "packscout.provider-observation.v1";

async function sourceFixture(now: Date) {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  const organizationId = await setup.createOrganization({
    slug: "diagnostic-lineage",
    name: "Diagnostic lineage",
    createdAt: now,
  });
  const providerId = await setup.createProviderSource({
    organizationId,
    platformKey: "courtyard-diagnostic-lineage",
    displayName: "Courtyard diagnostic lineage",
    createdAt: now,
  });
  const lifecycle = new ProviderSourceLifecycleRepository(harness.database);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId,
    sourceTypeKey,
    connectionTypeKey: "dataforrest-events-connection-v1",
    displayName: "DataForrest diagnostic lineage",
    requestLimit: 2,
    sourceAdapterVersion,
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator-admin",
    createdAt: now,
  });
  const source = await lifecycle.createSourceInstanceRevision({
    organizationId,
    providerId,
    connectionProfileId: connection.profileId,
    sourceTypeKey,
    sourceAdapterVersion,
    normalizedContractVersion,
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-courtyard-records-v1",
    cursorCodecVersion: "dataforrest-cursor-v1",
    revisionNumber: 1,
    intervalSeconds: 60,
    configuration: { provider: "courtyard" },
    configurationHash: "b".repeat(64),
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
    actorKey: "operator-admin",
    createdAt: now,
  });
  return {
    ...harness,
    organizationId,
    providerId,
    ...connection,
    ...source,
  };
}

test("diagnostic request attempts cannot borrow another test job or blocking episode", async () => {
  const now = new Date();
  const fixture = await sourceFixture(now);
  try {
    const ownerKey = "diagnostic-worker";
    const supervisorLeaseToken = "73000000-0000-4000-8000-000000000001";
    const supervisor = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisor.acquire({
      environmentKey: "diagnostic-lineage-test",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const diagnostics = new ProviderSourceDiagnosticRepository(
      fixture.database,
    );
    const claimExpiresAt = new Date(now.getTime() + 120_000);

    const connectionClaimToken = "73000000-0000-4000-8000-000000000002";
    const connectionJob =
      await fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: fixture.revisionId,
          expected_health_generation: 0n,
          state: "running",
          requested_by_actor_key: "operator-admin",
          claim_owner: ownerKey,
          claim_token: connectionClaimToken,
          claim_expires_at: claimExpiresAt,
          supervisor_epoch_id: epoch.epochId,
          started_at: now,
        },
      });
    const otherConnectionJob =
      await fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: fixture.revisionId,
          expected_health_generation: 0n,
          requested_by_actor_key: "operator-admin",
        },
      });
    const connectionAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "73000000-0000-4000-8000-000000000003",
      claimOwner: ownerKey,
      claimToken: connectionClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: connectionJob.id,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: connectionAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeOutcomeHash: "c".repeat(64),
      terminalAt: now,
    });

    const connectionDiagnostic = {
      organizationId: fixture.organizationId,
      scope: "connection" as const,
      correlationKind: "connection_test" as const,
      eventKind: "connection_test" as const,
      severity: "info" as const,
      phase: "request",
      safeCode: "REQUEST_CAPTURED",
      occurredAt: now,
      sourceTypeKey,
      sourceAdapterVersion,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      requestAttemptId: connectionAttemptId,
    };
    await assert.rejects(
      diagnostics.append({
        ...connectionDiagnostic,
        connectionTestJobId: otherConnectionJob.id,
      }),
    );
    await diagnostics.append({
      ...connectionDiagnostic,
      connectionTestJobId: connectionJob.id,
    });

    await fixture.database.$transaction([
      fixture.database.source_connection_revisions.update({
        where: { id: fixture.revisionId },
        data: { state: "active", activated_at: now },
      }),
      fixture.database.source_connection_profiles.update({
        where: { id: fixture.profileId },
        data: {
          state: "active",
          active_revision_id: fixture.revisionId,
          updated_at: now,
        },
      }),
    ]);

    const sourceClaimToken = "73000000-0000-4000-8000-000000000004";
    const sourceJob = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: fixture.providerId,
        source_instance_id: fixture.sourceInstanceId,
        source_revision_id: fixture.sourceRevisionId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        records_per_request: 250,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: sourceClaimToken,
        claim_expires_at: claimExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const otherSourceJob =
      await fixture.database.provider_source_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          provider_id: fixture.providerId,
          source_instance_id: fixture.sourceInstanceId,
          source_revision_id: fixture.sourceRevisionId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: fixture.revisionId,
          expected_health_generation: 0n,
          records_per_request: 250,
          requested_by_actor_key: "operator-admin",
        },
      });
    const sourceAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "73000000-0000-4000-8000-000000000005",
      claimOwner: ownerKey,
      claimToken: sourceClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "source_test",
        providerId: fixture.providerId,
        sourceInstanceId: fixture.sourceInstanceId,
        sourceRevisionId: fixture.sourceRevisionId,
        sourceTestJobId: sourceJob.id,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: sourceAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeOutcomeHash: "d".repeat(64),
      terminalAt: now,
    });

    const sourceDiagnostic = {
      organizationId: fixture.organizationId,
      scope: "source" as const,
      correlationKind: "source_test" as const,
      eventKind: "source_test" as const,
      severity: "info" as const,
      phase: "request",
      safeCode: "REQUEST_CAPTURED",
      occurredAt: now,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      providerId: fixture.providerId,
      sourceInstanceId: fixture.sourceInstanceId,
      sourceRevisionId: fixture.sourceRevisionId,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      requestAttemptId: sourceAttemptId,
    };
    await assert.rejects(
      diagnostics.append({
        ...sourceDiagnostic,
        sourceTestJobId: otherSourceJob.id,
      }),
    );
    await diagnostics.append({
      ...sourceDiagnostic,
      sourceTestJobId: sourceJob.id,
    });

    const blockingClaimToken = "73000000-0000-4000-8000-000000000006";
    const blockingJob =
      await fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: fixture.revisionId,
          expected_health_generation: 0n,
          state: "running",
          requested_by_actor_key: "operator-admin",
          claim_owner: ownerKey,
          claim_token: blockingClaimToken,
          claim_expires_at: claimExpiresAt,
          supervisor_epoch_id: epoch.epochId,
          started_at: now,
        },
      });
    const blockingAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "73000000-0000-4000-8000-000000000007",
      claimOwner: ownerKey,
      claimToken: blockingClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: blockingJob.id,
      },
      startedAt: now,
    });
    const blocked = await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: blockingAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "failed",
      outcomeClass: "authentication_failed",
      safeOutcomeHash: "e".repeat(64),
      responseBytes: 321,
      durationMs: 45,
      terminalAt: now,
      blockingFailure: {
        failureClass: "authentication_failed",
        safeCode: "authentication_failed",
      },
    });
    assert.ok(blocked.blockingEpisodeId);
    assert.equal(blocked.blockingEpisodeOpened, true);

    const episodeDiagnostic = {
      organizationId: fixture.organizationId,
      scope: "connection" as const,
      correlationKind: "connection_episode" as const,
      eventKind: "connection_episode" as const,
      severity: "critical" as const,
      phase: "health",
      safeCode: "CONNECTION_BLOCKED",
      occurredAt: now,
      sourceTypeKey,
      sourceAdapterVersion,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      blockingEpisodeId: blocked.blockingEpisodeId,
    };
    await assert.rejects(
      diagnostics.append({
        ...episodeDiagnostic,
        requestAttemptId: connectionAttemptId,
      }),
    );
    const opened = await fixture.database.source_processor_diagnostic_events
      .findMany({
        where: {
          correlation_kind: "connection_episode",
          blocking_episode_id: blocked.blockingEpisodeId,
        },
      });
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.request_attempt_id, blockingAttemptId);
    assert.equal(opened[0]?.duration_ms, 45);
    assert.equal(opened[0]?.response_bytes, 321);
    assert.equal(opened[0]?.scope, "connection");

    const events = await fixture.database.source_processor_diagnostic_events
      .findMany({
        select: {
          phase: true,
          correlation_kind: true,
          request_attempt_id: true,
          blocking_episode_id: true,
        },
      });
    assert.equal(events.length, 6);
    assert.deepEqual(
      events.filter(({ phase }) => phase === "adapter_request_started")
        .map(({ request_attempt_id }) => request_attempt_id)
        .sort(),
      [blockingAttemptId, connectionAttemptId, sourceAttemptId].sort(),
    );
    assert.equal(
      events.filter(({ phase }) => phase === "request").length,
      2,
    );
    assert.equal(
      events.filter(({ correlation_kind, blocking_episode_id }) =>
        correlation_kind === "connection_episode" &&
        blocking_episode_id === blocked.blockingEpisodeId
      ).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});
