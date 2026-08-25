import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceAdminLifecycleRepository } from
  "./provider-source-admin-lifecycle-repository.ts";
import { ProviderSourceRequestRepository } from
  "./provider-source-request-repository.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceTestResultRepository } from
  "./provider-source-test-result-repository.ts";
import { SourceConnectionAdminRepository } from
  "./source-connection-admin-repository.ts";

test("same-revision recovery restores a paused lane after closing its connection episode", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "paused-same-revision-recovery",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, {
      platformKey: "phygitals",
      displayName: "Phygitals paused recovery",
      mapperKey: "phygitals-provider-observation",
      identityNamespaceKey: "dataforrest-phygitals-records-v1",
      intervalSeconds: 60,
      hashCharacter: "b",
    });
    await activateAcceptanceRuntime(
      fixture.database,
      fixture,
      source,
      ACCEPTANCE_CREATED_AT,
    );
    await new ProviderSourceAdminLifecycleRepository(fixture.database).requestPause({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      actorKey: "operator-admin",
      requestedAt: ACCEPTANCE_CREATED_AT,
    });

    const ownerKey = "paused-same-revision-recovery-owner";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(fixture.database)
      .acquire({
        environmentKey: "paused-same-revision-recovery",
        ownerKey,
        leaseToken: supervisorLeaseToken,
        now: ACCEPTANCE_CREATED_AT,
      });
    const requests = new ProviderSourceRequestRepository(fixture.database);

    const detectorClaimToken = randomUUID();
    const detector = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: detectorClaimToken,
        claim_expires_at: epoch.leaseExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: ACCEPTANCE_CREATED_AT,
      },
    });
    const detectorAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: detectorClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: detector.id },
      startedAt: ACCEPTANCE_CREATED_AT,
    });
    const blocked = await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: detectorAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "failed",
      outcomeClass: "authentication_failed",
      safeCode: "authentication_failed",
      safeOutcomeHash: "c".repeat(64),
      terminalAt: ACCEPTANCE_CREATED_AT,
      blockingFailure: {
        failureClass: "authentication_failed",
        safeCode: "authentication_failed",
      },
    });
    assert.ok(blocked.blockingEpisodeId);

    const blockedLane = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({ where: { source_instance_id: source.sourceInstanceId } });
    assert.equal(blockedLane.wait_reason, "connection_blocked");
    assert.equal(blockedLane.blocking_episode_id, blocked.blockingEpisodeId);

    const recoveryClaimToken = randomUUID();
    const recoveryJob = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        blocking_episode_id: blocked.blockingEpisodeId,
        recovery_blocked_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 1n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: recoveryClaimToken,
        claim_expires_at: epoch.leaseExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: ACCEPTANCE_CREATED_AT,
      },
    });
    const recoveryAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: recoveryClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 1n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: recoveryJob.id,
        blockingEpisodeId: blocked.blockingEpisodeId,
      },
      startedAt: ACCEPTANCE_CREATED_AT,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: recoveryAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "d".repeat(64),
      terminalAt: ACCEPTANCE_CREATED_AT,
    });
    const recovered = await new ProviderSourceTestResultRepository(
      fixture.database,
    ).completeConnectionTest({
      organizationId: fixture.organizationId,
      jobId: recoveryJob.id,
      requestAttemptId: recoveryAttemptId,
      claimOwner: ownerKey,
      claimToken: recoveryClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_valid",
      completedAt: ACCEPTANCE_CREATED_AT,
    });

    assert.equal(recovered.episodeClosed, true);
    assert.deepEqual(recovered.resumedRunIds, []);
    const restoredLane = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({ where: { source_instance_id: source.sourceInstanceId } });
    assert.equal(restoredLane.phase, "paused");
    assert.equal(restoredLane.activity, "paused");
    assert.equal(restoredLane.wait_reason, null);
    assert.equal(restoredLane.blocking_episode_id, null);
    assert.equal(restoredLane.blocking_health_generation, null);

    const closedEpisode = await fixture.database.source_connection_health_episodes
      .findUniqueOrThrow({ where: { id: blocked.blockingEpisodeId } });
    assert.ok(closedEpisode.closed_at);
    assert.equal(closedEpisode.connection_revision_id, fixture.connectionRevisionId);
    assert.equal(closedEpisode.closed_health_generation, 2n);
    assert.equal(
      (await fixture.database.source_connection_revisions.findUniqueOrThrow({
        where: { id: fixture.connectionRevisionId },
      })).source_adapter_version,
      ACCEPTANCE_SOURCE_ADAPTER_VERSION,
    );
    assert.equal(
      (await fixture.database.source_connection_profiles.findUniqueOrThrow({
        where: { id: fixture.connectionProfileId },
      })).source_type_key,
      ACCEPTANCE_SOURCE_TYPE_KEY,
    );

    // Reproduce the pre-fix deployed state: the episode is closed, but an idle
    // paused lane still carries its old fence. A normal connection rotation
    // must clear that stale runtime proof before the profile trigger advances
    // the lane's connection revision.
    await fixture.database.provider_source_runtime_states.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: {
        phase: "waiting",
        activity: "waiting",
        wait_reason: "connection_blocked",
        blocking_episode_id: blocked.blockingEpisodeId,
        blocking_health_generation: 1n,
      },
    });

    const connections = new SourceConnectionAdminRepository(fixture.database);
    const candidateRevisionId = randomUUID();
    await connections.addConnectionRevision({
      organizationId: fixture.organizationId,
      connectionProfileId: fixture.connectionProfileId,
      expectedRevisionId: fixture.connectionRevisionId,
      revisionId: candidateRevisionId,
      revisionNumber: 2,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      encryptedConfiguration: {
        ciphertext: new Uint8Array(32).fill(4),
        nonce: new Uint8Array(12).fill(5),
        authTag: new Uint8Array(16).fill(6),
        keyVersion: 1,
      },
      configurationFingerprint: "e".repeat(64),
      actorKey: "operator-admin",
      createdAt: ACCEPTANCE_CREATED_AT,
    });
    const candidateJob = await connections.requestConnectionTest({
      organizationId: fixture.organizationId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: ACCEPTANCE_CREATED_AT,
    });
    const candidateClaimToken = randomUUID();
    await fixture.database.source_connection_test_jobs.update({
      where: { id: candidateJob.jobId },
      data: {
        state: "running",
        claim_owner: ownerKey,
        claim_token: candidateClaimToken,
        claim_expires_at: epoch.leaseExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: ACCEPTANCE_CREATED_AT,
      },
    });
    const candidateAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: candidateClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: candidateJob.jobId,
      },
      startedAt: ACCEPTANCE_CREATED_AT,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: candidateAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "f".repeat(64),
      terminalAt: ACCEPTANCE_CREATED_AT,
    });
    await new ProviderSourceTestResultRepository(fixture.database)
      .completeConnectionTest({
        organizationId: fixture.organizationId,
        jobId: candidateJob.jobId,
        requestAttemptId: candidateAttemptId,
        claimOwner: ownerKey,
        claimToken: candidateClaimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        outcome: "success",
        safeCode: "connection_valid",
        completedAt: ACCEPTANCE_CREATED_AT,
      });
    await connections.activateTestedConnectionRevision({
      organizationId: fixture.organizationId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      preservePinnedWork: true,
      actorKey: "operator-admin",
      activatedAt: ACCEPTANCE_CREATED_AT,
    });

    const rotatedLane = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({ where: { source_instance_id: source.sourceInstanceId } });
    assert.equal(rotatedLane.connection_revision_id, candidateRevisionId);
    assert.equal(rotatedLane.phase, "paused");
    assert.equal(rotatedLane.activity, "paused");
    assert.equal(rotatedLane.wait_reason, null);
    assert.equal(rotatedLane.blocking_episode_id, null);
  } finally {
    await fixture.close();
  }
});
