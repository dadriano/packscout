import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { ProviderSourceLifecycleRepository } from "./provider-source-lifecycle-repository.ts";
import { ProviderSourceRequestRepository } from "./provider-source-request-repository.ts";
import { ProviderSourceSupervisorRepository } from "./provider-source-supervisor-repository.ts";
import { ProviderSourceTestResultRepository } from "./provider-source-test-result-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { SourceConnectionAdminRepository } from "./source-connection-admin-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const base = new Date("2026-08-21T12:00:00.000Z");
const sourceTypeKey = "dataforrest-events-v1";
const sourceAdapterVersion = "dataforrest-events-adapter-v1";

async function databaseClock(database: PackscoutPrismaClient): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return rows[0]!.now;
}

async function futureDatabaseTime(
  database: PackscoutPrismaClient,
  milliseconds = 60_000,
): Promise<Date> {
  return new Date((await databaseClock(database)).getTime() + milliseconds);
}

async function nextTurn(milliseconds = 75): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function connectionFixture(slug: string) {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  const organizationId = await setup.createOrganization({
    slug,
    name: slug,
    createdAt: base,
  });
  const lifecycle = new ProviderSourceLifecycleRepository(harness.database);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId,
    sourceTypeKey,
    connectionTypeKey: "dataforrest-events-connection-v1",
    displayName: "DataForrest shared",
    requestLimit: 2,
    sourceAdapterVersion,
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator-admin",
    createdAt: base,
  });
  return { ...harness, organizationId, ...connection };
}

test("supervisor release is serialized with request lifecycle and refuses in-flight work", async () => {
  const fixture = await connectionFixture("source-release-hardening");
  try {
    const ownerKey = "release-worker";
    const supervisorLeaseToken = "00000000-0000-4000-8000-000000000201";
    const claimToken = "00000000-0000-4000-8000-000000000202";
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisors.acquire({
      environmentKey: "release-hardening",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: base,
    });
    const job = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: epoch.epochId,
        started_at: base,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000203",
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: job.id },
      startedAt: new Date(base.getTime() + 1_000),
    });

    await assert.rejects(
      requests.terminalize({
        organizationId: fixture.organizationId,
        requestAttemptId: attemptId,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        state: "connection_outcome_uncertain" as never,
        outcomeClass: "connection_outcome_uncertain",
        safeOutcomeHash: "f".repeat(64),
        terminalAt: new Date(base.getTime() + 2_000),
      }),
      /must be terminalized by predecessor reconciliation/u,
    );

    await assert.rejects(
      supervisors.release({
        epochId: epoch.epochId,
        ownerKey,
        leaseToken: supervisorLeaseToken,
        releasedAt: new Date(base.getTime() + 2_000),
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SUPERVISOR_OWNERSHIP_LOST"
        && /requests are in flight/u.test(error.message),
    );
    assert.equal((await fixture.database.source_supervisor_epochs.findUniqueOrThrow({
      where: { id: epoch.epochId },
    })).state, "active");

    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "b".repeat(64),
      terminalAt: new Date(base.getTime() + 3_000),
    });
    await supervisors.release({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken: supervisorLeaseToken,
      releasedAt: new Date(base.getTime() + 4_000),
    });
    assert.equal((await fixture.database.source_supervisor_epochs.findUniqueOrThrow({
      where: { id: epoch.epochId },
    })).state, "released");
  } finally {
    await fixture.close();
  }
});

test("fence and release acknowledge exact ambiguous committed retries", async () => {
  const fixture = await connectionFixture("source-ambiguous-supervisor-cas");
  try {
    const ownerKey = "ambiguous-cas-worker";
    const leaseToken = "00000000-0000-4000-8000-000000000211";
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisors.acquire({
      environmentKey: "ambiguous-supervisor-cas",
      ownerKey,
      leaseToken,
      now: base,
    });
    const fenceInput = {
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      safeReasonCode: "AMBIGUOUS_FENCE_TEST",
      fencedAt: base,
    } as const;
    await supervisors.fence(fenceInput);
    const fencedAt = (await fixture.database.source_supervisor_epochs
      .findUniqueOrThrow({ where: { id: epoch.epochId } })).fenced_at;
    await supervisors.fence({
      ...fenceInput,
      fencedAt: new Date(base.getTime() + 60_000),
    });
    assert.equal(
      (await fixture.database.source_supervisor_epochs.findUniqueOrThrow({
        where: { id: epoch.epochId },
      })).fenced_at?.getTime(),
      fencedAt?.getTime(),
    );
    await assert.rejects(supervisors.fence({
      ...fenceInput,
      safeReasonCode: "DIFFERENT_REASON",
    }), (error: unknown) => error instanceof PersistenceError &&
      error.code === "SUPERVISOR_OWNERSHIP_LOST");

    const releaseInput = {
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      releasedAt: base,
    } as const;
    await supervisors.release(releaseInput);
    const releasedAt = (await fixture.database.source_supervisor_epochs
      .findUniqueOrThrow({ where: { id: epoch.epochId } })).released_at;
    await supervisors.release({
      ...releaseInput,
      releasedAt: new Date(base.getTime() + 60_000),
    });
    assert.equal(
      (await fixture.database.source_supervisor_epochs.findUniqueOrThrow({
        where: { id: epoch.epochId },
      })).released_at?.getTime(),
      releasedAt?.getTime(),
    );
    await assert.rejects(supervisors.release({
      ...releaseInput,
      ownerKey: "different-owner",
    }), (error: unknown) => error instanceof PersistenceError &&
      error.code === "SUPERVISOR_OWNERSHIP_LOST");
  } finally {
    await fixture.close();
  }
});

test("durable fencing serializes after admitted work and wins before stale work", async () => {
  const fixture = await connectionFixture("source-fence-lock-order");
  try {
    const ownerKey = "fence-worker";
    const supervisorLeaseToken = "00000000-0000-4000-8000-000000000211";
    const claimToken = "00000000-0000-4000-8000-000000000212";
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisors.acquire({
      environmentKey: "fence-lock-order",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: base,
    });
    const job = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: epoch.epochId,
        started_at: await databaseClock(fixture.database),
      },
    });
    const lockClient = await fixture.createIndependentClient();
    let releaseProfileLock: (() => void) | undefined;
    let profileLockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      profileLockAcquired = resolve;
    });
    const holdProfile = new Promise<void>((resolve) => {
      releaseProfileLock = resolve;
    });
    const blockingTransaction = lockClient.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        select id
        from public.source_connection_profiles
        where id = cast(${fixture.profileId} as uuid)
        for update
      `;
      profileLockAcquired();
      await holdProfile;
    });
    await acquired;

    const requests = new ProviderSourceRequestRepository(fixture.database);
    let beginSettled = false;
    const begin = requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000213",
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: job.id },
      startedAt: base,
    }).finally(() => {
      beginSettled = true;
    });
    await nextTurn();
    assert.equal(beginSettled, false, "begin must wait on the locked profile");

    let fenceSettled = false;
    const fence = supervisors.fence({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken: supervisorLeaseToken,
      safeReasonCode: "CONTROL_PLANE_FAILURE",
      fencedAt: base,
    }).finally(() => {
      fenceSettled = true;
    });
    await nextTurn();
    assert.equal(fenceSettled, false, "fence must wait for the admitted epoch reader");

    releaseProfileLock?.();
    const attemptId = await begin;
    await blockingTransaction;
    await fence;
    assert.ok(attemptId);
    assert.equal((await fixture.database.source_supervisor_epochs.findUniqueOrThrow({
      where: { id: epoch.epochId },
    })).state, "fenced_draining");

    await assert.rejects(
      requests.begin({
        organizationId: fixture.organizationId,
        requestLeaseId: "00000000-0000-4000-8000-000000000214",
        claimOwner: ownerKey,
        claimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        connectionProfileId: fixture.profileId,
        connectionRevisionId: fixture.revisionId,
        expectedHealthGeneration: 0n,
        operation: { kind: "connection_test", connectionTestJobId: job.id },
        startedAt: base,
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SUPERVISOR_OWNERSHIP_LOST",
    );
  } finally {
    await fixture.close();
  }
});

test("database time fences expired owners regardless of caller event timestamps", async () => {
  const fixture = await connectionFixture("source-database-clock-hardening");
  try {
    const ownerKey = "clock-worker";
    const supervisorLeaseToken = "00000000-0000-4000-8000-000000000231";
    const claimToken = "00000000-0000-4000-8000-000000000232";
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisors.acquire({
      environmentKey: "clock-hardening",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: new Date("2999-01-01T00:00:00.000Z"),
    });
    await assert.rejects(
      supervisors.acquire({
        environmentKey: "clock-hardening",
        ownerKey: "future-attacker",
        leaseToken: "00000000-0000-4000-8000-000000000233",
        now: new Date("2999-01-01T00:00:00.000Z"),
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SUPERVISOR_OWNERSHIP_LOST",
    );

    const job = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: epoch.epochId,
        started_at: await databaseClock(fixture.database),
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000234",
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: job.id },
      startedAt: new Date("2999-01-01T00:00:00.000Z"),
    });
    const databaseNow = await databaseClock(fixture.database);
    await fixture.database.source_supervisor_epochs.update({
      where: { id: epoch.epochId },
      data: {
        acquired_at: new Date(databaseNow.getTime() - 60_000),
        last_renewed_at: new Date(databaseNow.getTime() - 60_000),
        lease_expires_at: new Date(databaseNow.getTime() - 30_000),
        takeover_not_before: new Date(databaseNow.getTime() - 15_000),
      },
    });

    await assert.rejects(
      requests.terminalize({
        organizationId: fixture.organizationId,
        requestAttemptId: attemptId,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        state: "captured",
        outcomeClass: "response_captured",
        safeOutcomeHash: "a".repeat(64),
        terminalAt: new Date("2000-01-01T00:00:00.000Z"),
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SUPERVISOR_OWNERSHIP_LOST",
    );
    assert.equal((await fixture.database.source_request_attempts.findUniqueOrThrow({
      where: { id: attemptId },
    })).state, "in_flight");
  } finally {
    await fixture.close();
  }
});

test("normal connection rotation preserves admitted calls and their old-revision test publication", async () => {
  const fixture = await connectionFixture("source-connection-rotation");
  try {
    const now = await databaseClock(fixture.database);
    await fixture.database.$transaction(async (transaction) => {
      await transaction.source_connection_revisions.update({
        where: { id: fixture.revisionId },
        data: { state: "active", activated_at: now },
      });
      await transaction.source_connection_profiles.update({
        where: { id: fixture.profileId },
        data: {
          state: "active",
          active_revision_id: fixture.revisionId,
          updated_at: now,
        },
      });
    });
    const candidate = await fixture.database.source_connection_revisions.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        revision_number: 2,
        source_type_key: sourceTypeKey,
        source_adapter_version: sourceAdapterVersion,
        configuration_ciphertext: new Uint8Array(32).fill(4),
        configuration_nonce: new Uint8Array(12).fill(5),
        configuration_auth_tag: new Uint8Array(16).fill(6),
        encryption_key_version: 1,
        configuration_fingerprint: "c".repeat(64),
        created_by_actor_key: "operator-admin",
        created_at: now,
      },
    });
    const ownerKey = "rotation-worker";
    const supervisorLeaseToken = "00000000-0000-4000-8000-000000000241";
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisors.acquire({
      environmentKey: "connection-rotation",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const results = new ProviderSourceTestResultRepository(fixture.database);

    const candidateClaimToken = "00000000-0000-4000-8000-000000000242";
    const candidateJob = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: candidate.id,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: candidateClaimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const candidateAttempt = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000243",
      claimOwner: ownerKey,
      claimToken: candidateClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: candidate.id,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: candidateJob.id },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: candidateAttempt,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "d".repeat(64),
      terminalAt: now,
    });
    await results.completeConnectionTest({
      organizationId: fixture.organizationId,
      jobId: candidateJob.id,
      requestAttemptId: candidateAttempt,
      claimOwner: ownerKey,
      claimToken: candidateClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_test_succeeded",
      completedAt: now,
    });

    const oldClaimToken = "00000000-0000-4000-8000-000000000244";
    const oldJob = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: oldClaimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const oldAttempt = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000245",
      claimOwner: ownerKey,
      claimToken: oldClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: oldJob.id },
      startedAt: now,
    });
    const connections = new SourceConnectionAdminRepository(fixture.database);
    await connections.activateTestedConnectionRevision({
      organizationId: fixture.organizationId,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: candidate.id,
      expectedHealthGeneration: 0n,
      preservePinnedWork: true,
      actorKey: "operator-admin",
      activatedAt: now,
    });
    assert.equal((await fixture.database.source_connection_profiles.findUniqueOrThrow({
      where: { id: fixture.profileId },
    })).active_revision_id, candidate.id);

    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: oldAttempt,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "e".repeat(64),
      terminalAt: now,
    });
    await results.completeConnectionTest({
      organizationId: fixture.organizationId,
      jobId: oldJob.id,
      requestAttemptId: oldAttempt,
      claimOwner: ownerKey,
      claimToken: oldClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "old_revision_test_completed",
      completedAt: now,
    });

    const [profile, oldRevision, completedJob] = await Promise.all([
      fixture.database.source_connection_profiles.findUniqueOrThrow({
        where: { id: fixture.profileId },
      }),
      fixture.database.source_connection_revisions.findUniqueOrThrow({
        where: { id: fixture.revisionId },
      }),
      fixture.database.source_connection_test_jobs.findUniqueOrThrow({
        where: { id: oldJob.id },
      }),
    ]);
    assert.equal(profile.active_revision_id, candidate.id);
    assert.equal(oldRevision.state, "retired");
    assert.equal(oldRevision.health_generation, 0n);
    assert.equal(completedJob.state, "succeeded");
  } finally {
    await fixture.close();
  }
});

test("simultaneous connection failures coalesce while known sibling capture still terminalizes", async () => {
  const fixture = await connectionFixture("source-simultaneous-connection-failure");
  try {
    const ownerKey = "parallel-worker";
    const supervisorLeaseToken = "00000000-0000-4000-8000-000000000241";
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisors.acquire({
      environmentKey: "parallel-failure-hardening",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: base,
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);

    const attempts = await Promise.all([0, 1, 2].map(async (index) => {
      const claimToken = `00000000-0000-4000-8000-00000000024${index + 2}`;
      const job = await fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: fixture.revisionId,
          expected_health_generation: 0n,
          state: "running",
          requested_by_actor_key: "operator-admin",
          claim_owner: ownerKey,
          claim_token: claimToken,
          claim_expires_at: await futureDatabaseTime(fixture.database),
          supervisor_epoch_id: epoch.epochId,
          started_at: await databaseClock(fixture.database),
        },
      });
      const attemptId = await requests.begin({
        organizationId: fixture.organizationId,
        requestLeaseId: `00000000-0000-4000-8000-00000000025${index + 1}`,
        claimOwner: ownerKey,
        claimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        connectionProfileId: fixture.profileId,
        connectionRevisionId: fixture.revisionId,
        expectedHealthGeneration: 0n,
        operation: { kind: "connection_test", connectionTestJobId: job.id },
        startedAt: base,
      });
      return { attemptId, claimToken, jobId: job.id };
    }));

    const blockingResults = await Promise.all(attempts.slice(0, 2).map((attempt, index) =>
      requests.terminalize({
        organizationId: fixture.organizationId,
        requestAttemptId: attempt.attemptId,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        state: "failed",
        outcomeClass: "authentication_failed",
        safeCode: "authentication_failed",
        safeOutcomeHash: String(index + 1).repeat(64),
        terminalAt: base,
        blockingFailure: {
          failureClass: "authentication_failed",
          safeCode: "authentication_failed",
        },
      })));
    assert.ok(blockingResults[0]!.blockingEpisodeId);
    assert.equal(
      blockingResults[0]!.blockingEpisodeId,
      blockingResults[1]!.blockingEpisodeId,
    );

    const sibling = attempts[2]!;
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: sibling.attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "3".repeat(64),
      terminalAt: base,
    });

    assert.equal(await fixture.database.source_connection_health_episodes.count({
      where: { connection_profile_id: fixture.profileId, closed_at: null },
    }), 1);
    assert.equal((await fixture.database.source_connection_revisions.findUniqueOrThrow({
      where: { id: fixture.revisionId },
    })).health_generation, 1n);
    assert.equal(await fixture.database.source_request_attempts.count({
      where: {
        id: { in: attempts.map(({ attemptId }) => attemptId) },
        state: { in: ["captured", "failed"] },
      },
    }), 3);
    assert.equal(await fixture.database.compact_source_request_attempts.count({
      where: { request_attempt_id: { in: attempts.map(({ attemptId }) => attemptId) } },
    }), 3);

    const results = new ProviderSourceTestResultRepository(fixture.database);
    await assert.rejects(
      results.completeConnectionTest({
        organizationId: fixture.organizationId,
        jobId: sibling.jobId,
        requestAttemptId: sibling.attemptId,
        claimOwner: ownerKey,
        claimToken: sibling.claimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        outcome: "success",
        safeCode: "stale_success",
        completedAt: base,
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "CONNECTION_BLOCKED",
    );
  } finally {
    await fixture.close();
  }
});

test("takeover reconciles an in-flight request after emergency credential revocation", async () => {
  const fixture = await connectionFixture("source-revoked-takeover");
  try {
    const predecessorOwner = "revoked-predecessor";
    const predecessorLeaseToken = "00000000-0000-4000-8000-000000000261";
    const claimToken = "00000000-0000-4000-8000-000000000262";
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const predecessor = await supervisors.acquire({
      environmentKey: "revoked-takeover",
      ownerKey: predecessorOwner,
      leaseToken: predecessorLeaseToken,
      now: base,
    });
    const job = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: predecessorOwner,
        claim_token: claimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: predecessor.epochId,
        started_at: await databaseClock(fixture.database),
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000263",
      claimOwner: predecessorOwner,
      claimToken,
      supervisorEpochId: predecessor.epochId,
      supervisorOwnerKey: predecessorOwner,
      supervisorLeaseToken: predecessorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: job.id },
      startedAt: base,
    });
    const databaseNow = await databaseClock(fixture.database);
    await fixture.database.$transaction([
      fixture.database.source_connection_revisions.update({
        where: { id: fixture.revisionId },
        data: {
          state: "revoked",
          revoked_at: databaseNow,
          revoked_by_actor_key: "operator-admin",
        },
      }),
      fixture.database.source_supervisor_epochs.update({
        where: { id: predecessor.epochId },
        data: {
          acquired_at: new Date(databaseNow.getTime() - 60_000),
          last_renewed_at: new Date(databaseNow.getTime() - 60_000),
          lease_expires_at: new Date(databaseNow.getTime() - 30_000),
          takeover_not_before: new Date(databaseNow.getTime() - 15_000),
        },
      }),
    ]);
    const currentOwner = "revoked-replacement";
    const currentLeaseToken = "00000000-0000-4000-8000-000000000264";
    const current = await supervisors.acquire({
      environmentKey: "revoked-takeover",
      ownerKey: currentOwner,
      leaseToken: currentLeaseToken,
      now: new Date(0),
    });
    const reconciled = await requests.reconcilePredecessorAttempt({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      currentSupervisorEpochId: current.epochId,
      currentSupervisorOwnerKey: currentOwner,
      currentSupervisorLeaseToken: currentLeaseToken,
      safeOutcomeHash: "4".repeat(64),
      reconciledAt: new Date(0),
    });
    const [attempt, episode] = await Promise.all([
      fixture.database.source_request_attempts.findUniqueOrThrow({ where: { id: attemptId } }),
      fixture.database.source_connection_health_episodes.findUniqueOrThrow({
        where: { id: reconciled.blockingEpisodeId },
      }),
    ]);
    assert.equal(attempt.state, "connection_outcome_uncertain");
    assert.equal(episode.connection_revision_id, fixture.revisionId);
    assert.equal(episode.failure_class, "connection_outcome_uncertain");
  } finally {
    await fixture.close();
  }
});

test("takeover reconciles only its environment and blocks new calls until uncertain proof is complete", async () => {
  const fixture = await connectionFixture("source-takeover-hardening");
  try {
    const supervisors = new ProviderSourceSupervisorRepository(fixture.database);
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const predecessorOwner = "predecessor-worker";
    const predecessorLeaseToken = "00000000-0000-4000-8000-000000000211";
    const predecessorClaimToken = "00000000-0000-4000-8000-000000000212";
    const predecessor = await supervisors.acquire({
      environmentKey: "takeover-hardening",
      ownerKey: predecessorOwner,
      leaseToken: predecessorLeaseToken,
      now: base,
    });
    const predecessorJob = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: predecessorOwner,
        claim_token: predecessorClaimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: predecessor.epochId,
        started_at: base,
      },
    });
    const predecessorAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000213",
      claimOwner: predecessorOwner,
      claimToken: predecessorClaimToken,
      supervisorEpochId: predecessor.epochId,
      supervisorOwnerKey: predecessorOwner,
      supervisorLeaseToken: predecessorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: predecessorJob.id },
      startedAt: new Date(base.getTime() + 1_000),
    });

    const takeoverAt = await databaseClock(fixture.database);
    await fixture.database.source_supervisor_epochs.update({
      where: { id: predecessor.epochId },
      data: {
        acquired_at: new Date(takeoverAt.getTime() - 60_000),
        last_renewed_at: new Date(takeoverAt.getTime() - 60_000),
        lease_expires_at: new Date(takeoverAt.getTime() - 30_000),
        takeover_not_before: new Date(takeoverAt.getTime() - 15_000),
      },
    });
    const currentOwner = "replacement-worker";
    const currentLeaseToken = "00000000-0000-4000-8000-000000000214";
    const current = await supervisors.acquire({
      environmentKey: "takeover-hardening",
      ownerKey: currentOwner,
      leaseToken: currentLeaseToken,
      now: takeoverAt,
    });
    const wrongEnvironment = await fixture.database.source_supervisor_epochs.create({
      data: {
        environment_key: "another-environment",
        epoch_number: 2n,
        owner_key: "wrong-environment-worker",
        lease_token: "00000000-0000-4000-8000-000000000215",
        acquired_at: takeoverAt,
        last_renewed_at: takeoverAt,
        lease_expires_at: new Date(takeoverAt.getTime() + 90_000),
        takeover_not_before: new Date(takeoverAt.getTime() + 105_000),
      },
    });
    const reconciledAt = new Date(base.getTime() + 47_000);

    await assert.rejects(
      requests.reconcilePredecessorAttempt({
        organizationId: fixture.organizationId,
        requestAttemptId: predecessorAttemptId,
        currentSupervisorEpochId: wrongEnvironment.id,
        currentSupervisorOwnerKey: "wrong-environment-worker",
        currentSupervisorLeaseToken: "00000000-0000-4000-8000-000000000215",
        safeOutcomeHash: "c".repeat(64),
        reconciledAt,
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SUPERVISOR_OWNERSHIP_LOST",
    );
    await assert.rejects(
      requests.begin({
        organizationId: fixture.organizationId,
        requestLeaseId: "00000000-0000-4000-8000-000000000216",
        claimOwner: currentOwner,
        claimToken: "00000000-0000-4000-8000-000000000217",
        supervisorEpochId: current.epochId,
        supervisorOwnerKey: currentOwner,
        supervisorLeaseToken: currentLeaseToken,
        connectionProfileId: fixture.profileId,
        connectionRevisionId: fixture.revisionId,
        expectedHealthGeneration: 0n,
        operation: {
          kind: "connection_test",
          connectionTestJobId: "00000000-0000-4000-8000-000000000218",
        },
        startedAt: reconciledAt,
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SUPERVISOR_OWNERSHIP_LOST"
        && /must be reconciled/u.test(error.message),
    );

    const reconciled = await requests.reconcilePredecessorAttempt({
      organizationId: fixture.organizationId,
      requestAttemptId: predecessorAttemptId,
      currentSupervisorEpochId: current.epochId,
      currentSupervisorOwnerKey: currentOwner,
      currentSupervisorLeaseToken: currentLeaseToken,
      safeOutcomeHash: "d".repeat(64),
      reconciledAt: new Date(base.getTime() + 48_000),
    });
    const [attempt, compact, episode, revision] = await Promise.all([
      fixture.database.source_request_attempts.findUniqueOrThrow({
        where: { id: predecessorAttemptId },
      }),
      fixture.database.compact_source_request_attempts.findUniqueOrThrow({
        where: { request_attempt_id: predecessorAttemptId },
      }),
      fixture.database.source_connection_health_episodes.findUniqueOrThrow({
        where: { id: reconciled.blockingEpisodeId },
      }),
      fixture.database.source_connection_revisions.findUniqueOrThrow({
        where: { id: fixture.revisionId },
      }),
    ]);
    assert.equal(attempt.state, "connection_outcome_uncertain");
    assert.equal(compact.terminal_state, "connection_outcome_uncertain");
    assert.equal(attempt.blocking_episode_id, reconciled.blockingEpisodeId);
    assert.equal(compact.blocking_episode_id, reconciled.blockingEpisodeId);
    assert.equal(episode.opened_by_request_attempt_id, predecessorAttemptId);
    assert.equal(revision.health_generation, 1n);

    const recoveryClaimToken = "00000000-0000-4000-8000-000000000219";
    const recoveryJob = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        blocking_episode_id: reconciled.blockingEpisodeId,
        recovery_blocked_revision_id: fixture.revisionId,
        expected_health_generation: 1n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: currentOwner,
        claim_token: recoveryClaimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: current.epochId,
        started_at: new Date(base.getTime() + 49_000),
      },
    });
    const recoveryAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000220",
      claimOwner: currentOwner,
      claimToken: recoveryClaimToken,
      supervisorEpochId: current.epochId,
      supervisorOwnerKey: currentOwner,
      supervisorLeaseToken: currentLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 1n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: recoveryJob.id,
        blockingEpisodeId: reconciled.blockingEpisodeId,
      },
      startedAt: new Date(base.getTime() + 50_000),
    });
    assert.equal((await fixture.database.source_request_attempts.findUniqueOrThrow({
      where: { id: recoveryAttemptId },
    })).state, "in_flight");
  } finally {
    await fixture.close();
  }
});
