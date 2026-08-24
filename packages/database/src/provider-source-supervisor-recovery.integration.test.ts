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
import { ProviderSourceRequestRepository } from
  "./provider-source-request-repository.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import { ProviderSourceAdminLifecycleRepository } from
  "./provider-source-admin-lifecycle-repository.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceTestResultRepository } from
  "./provider-source-test-result-repository.ts";
import { SourceConnectionAdminRepository } from
  "./source-connection-admin-repository.ts";
import { ProviderSourceSupervisorWorkRepository } from
  "./provider-source-supervisor-work-repository.ts";

async function databaseNow(
  database: Awaited<ReturnType<typeof createProviderSourceAcceptanceFixture>>["database"],
): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return rows[0]!.now;
}

async function recoveryFixture(testKey: string) {
  const fixture = await createProviderSourceAcceptanceFixture(testKey);
  const source = await createAcceptanceProviderSource(fixture, {
    platformKey: "courtyard",
    displayName: "Courtyard",
    mapperKey: "courtyard-provider-observation",
    identityNamespaceKey: "dataforrest-courtyard-records-v1",
    intervalSeconds: 60,
    hashCharacter: "b",
  });
  const now = await databaseNow(fixture.database);
  await activateAcceptanceRuntime(fixture.database, fixture, source, now);
  const ownerKey = `${testKey}-owner`;
  const leaseToken = randomUUID();
  const epoch = await new ProviderSourceSupervisorRepository(fixture.database)
    .acquire({
      environmentKey: `${testKey}-environment`,
      ownerKey,
      leaseToken,
      now,
    });
  return { fixture, source, ownerKey, leaseToken, epoch };
}

test("an initial draft connection profile can claim its required test", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "initial-draft-connection-test",
  );
  try {
    const now = await databaseNow(fixture.database);
    const ownerKey = "initial-draft-connection-test-owner";
    const leaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "initial-draft-connection-test-environment",
      ownerKey,
      leaseToken,
      now,
    });
    const profile = await fixture.database.source_connection_profiles
      .findUniqueOrThrow({
        where: { id: fixture.connectionProfileId },
        select: { state: true, active_revision_id: true },
      });
    const revision = await fixture.database.source_connection_revisions
      .findUniqueOrThrow({
        where: { id: fixture.connectionRevisionId },
        select: { state: true },
      });
    assert.deepEqual(profile, { state: "draft", active_revision_id: null });
    assert.equal(revision.state, "candidate");

    const requested = await new SourceConnectionAdminRepository(
      fixture.database,
    ).requestConnectionTest({
      organizationId: fixture.organizationId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: now,
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
    assert.equal(claimed?.id, requested.jobId);
    assert.equal(
      (await fixture.database.source_connection_test_jobs.findUniqueOrThrow({
        where: { id: requested.jobId },
      })).state,
      "running",
    );
  } finally {
    await fixture.close();
  }
});

test("takeover fences a terminal source-test/result gap without another claim", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("terminal-source-test-gap");
  try {
    const now = await databaseNow(fixture.database);
    const claimToken = randomUUID();
    const job = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    await fixture.database.provider_source_runtime_states.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: {
        supervisor_epoch_id: epoch.epochId,
        phase: "claimed",
        activity: "running",
        run_lease_acquired_at: now,
        run_lease_expires_at: new Date(now.getTime() + 20_000),
        updated_at: now,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "source_test",
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceTestJobId: job.id,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "failed",
      outcomeClass: "source_action_required",
      safeCode: "invalid_response",
      safeOutcomeHash: "a".repeat(64),
      terminalAt: now,
    });
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: {
          request_attempt_id: attemptId,
          phase: "adapter_request_started",
        },
      }),
      1,
    );
    await fixture.database.provider_source_test_jobs.update({
      where: { id: job.id },
      data: { claim_expires_at: new Date(now.getTime() - 1_000) },
    });

    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    const recoverable = await work.listRecoverableClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    assert.deepEqual(recoverable, [{ kind: "source_test", id: job.id }]);
    await work.recoverClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claim: recoverable[0]!,
    });

    const [storedJob, runtime] = await Promise.all([
      fixture.database.provider_source_test_jobs.findUniqueOrThrow({
        where: { id: job.id },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(storedJob.state, "failed");
    assert.equal(runtime.activity, "action_required");
    assert.equal(runtime.action_required_code, "TEST_RESULT_PUBLICATION_INCOMPLETE");
    const recoveredResult = await fixture.database.provider_source_test_results
      .findUniqueOrThrow({ where: { job_id: job.id } });
    assert.equal(recoveredResult.request_attempt_id, attemptId);
    assert.equal(recoveredResult.request_terminal_state, "failed");
    assert.equal(recoveredResult.outcome, "failure");
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: { source_test_job_id: job.id, phase: "work_recovered" },
      }),
      1,
    );
    assert.equal(await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    }), null);
  } finally {
    await fixture.close();
  }
});

test("takeover reconciliation blocks queued profile work for recovery", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("reconcile-blocks-queued-work");
  try {
    const now = await databaseNow(fixture.database);
    const claimToken = randomUUID();
    const detector = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: detector.id },
      startedAt: now,
    });
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    if (requested.kind !== "created") throw new Error("Expected queued run.");

    const takeoverAt = await databaseNow(fixture.database);
    await fixture.database.source_supervisor_epochs.update({
      where: { id: epoch.epochId },
      data: {
        acquired_at: new Date(takeoverAt.getTime() - 60_000),
        last_renewed_at: new Date(takeoverAt.getTime() - 60_000),
        lease_expires_at: new Date(takeoverAt.getTime() - 30_000),
        takeover_not_before: new Date(takeoverAt.getTime() - 15_000),
      },
    });
    const replacementOwner = `${ownerKey}-replacement`;
    const replacementLeaseToken = randomUUID();
    const replacement = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "reconcile-blocks-queued-work-environment",
      ownerKey: replacementOwner,
      leaseToken: replacementLeaseToken,
      now: takeoverAt,
    });
    const reconciled = await requests.reconcilePredecessorAttempt({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      currentSupervisorEpochId: replacement.epochId,
      currentSupervisorOwnerKey: replacementOwner,
      currentSupervisorLeaseToken: replacementLeaseToken,
      safeOutcomeHash: "e".repeat(64),
      reconciledAt: takeoverAt,
    });

    // The queued run keeps its recovery lineage instead of being claimed and
    // terminally fenced as STALE_QUEUED_WORK by the replacement supervisor.
    const [run, runtime] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({
        where: { id: requested.run.id },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(run.state, "incomplete");
    assert.equal(run.failure_code, "CONNECTION_BLOCKED");
    assert.equal(run.lease_owner, null);
    assert.equal(runtime.activity, "waiting");
    assert.equal(runtime.wait_reason, "connection_blocked");
    assert.equal(runtime.blocking_episode_id, reconciled.blockingEpisodeId);
    assert.equal(await new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    ).claimNext({
      epochId: replacement.epochId,
      ownerKey: replacementOwner,
      leaseToken: replacementLeaseToken,
      claimOwner: replacementOwner,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    }), null);
  } finally {
    await fixture.close();
  }
});

test("paired-capacity wait and grant are durable exact-claim lane states", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("durable-admission-wait");
  try {
    const now = await databaseNow(fixture.database);
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(requested.kind, "created");
    const repository = new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    );
    const claimed = await repository.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimed?.kind, "page_read");
    if (!claimed || claimed.kind !== "page_read") {
      throw new Error("Expected a claimed page read.");
    }

    await repository.markAdmissionWaiting({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
      reason: "profile_capacity",
    });
    let runtime = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      });
    assert.equal(runtime.phase, "waiting");
    assert.equal(runtime.activity, "waiting");
    assert.equal(runtime.wait_reason, "profile_capacity");
    assert.equal(runtime.current_run_id, claimed.runId);
    assert.equal(runtime.connection_profile_id, claimed.connectionProfileId);
    assert.equal(runtime.connection_revision_id, claimed.connectionRevisionId);

    await repository.markAdmissionGranted({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
    });
    runtime = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      });
    assert.equal(runtime.phase, "claimed");
    assert.equal(runtime.activity, "running");
    assert.equal(runtime.wait_reason, null);
    assert.equal(runtime.current_run_id, claimed.runId);
  } finally {
    await fixture.close();
  }
});

test("an exact terminal request proof acknowledges a late claim renewal", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("terminal-renewal-ack");
  try {
    const now = await databaseNow(fixture.database);
    const job = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        requested_by_actor_key: "operator-admin",
        queued_at: now,
      },
    });
    const repository = new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    );
    const claimed = await repository.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimed?.kind, "source_test");
    assert.equal(claimed?.id, job.id);
    if (!claimed || claimed.kind !== "source_test") {
      throw new Error("Expected a claimed source test.");
    }
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = randomUUID();
    const requestLeaseId = randomUUID();
    const beginInput = {
      id: attemptId,
      organizationId: fixture.organizationId,
      requestLeaseId,
      claimOwner: ownerKey,
      claimToken: claimed.claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: claimed.connectionProfileId,
      connectionRevisionId: claimed.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "source_test",
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceTestJobId: claimed.id,
      },
      startedAt: now,
    } as const;
    assert.equal(await requests.begin(beginInput), attemptId);
    assert.equal(await requests.begin(beginInput), attemptId);
    assert.equal(await fixture.database.source_request_attempts.count({
      where: { id: attemptId },
    }), 1);
    const terminalInput = {
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "failed",
      outcomeClass: "source_action_required",
      safeCode: "invalid_response",
      safeOutcomeHash: "8".repeat(64),
      terminalAt: now,
    } as const;
    const firstReceipt = await requests.terminalize(terminalInput);
    assert.deepEqual(await requests.terminalize(terminalInput), firstReceipt);
    await assert.rejects(
      requests.terminalize({
        ...terminalInput,
        safeOutcomeHash: "9".repeat(64),
      }),
      /conflicts with its permanent proof/u,
    );
    await repository.finishTestClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
      outcome: "failed",
      safeCode: "INVALID_RESPONSE",
    });

    const acknowledgedAt = await repository.renewClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
    });
    assert.ok(acknowledgedAt instanceof Date);
    assert.equal(
      (await fixture.database.provider_source_test_jobs.findUniqueOrThrow({
        where: { id: claimed.id },
      })).state,
      "failed",
    );
  } finally {
    await fixture.close();
  }
});

test("claim renewal loss atomically records one exact diagnostic before fencing", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("claim-renewal-loss-diagnostic");
  try {
    const now = await databaseNow(fixture.database);
    const job = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        requested_by_actor_key: "operator-admin",
        queued_at: now,
      },
    });
    const repository = new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    );
    const claimed = await repository.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimed?.kind, "source_test");
    assert.equal(claimed?.id, job.id);
    if (!claimed || claimed.kind !== "source_test") {
      throw new Error("Expected a claimed source test.");
    }
    await fixture.database.provider_source_test_jobs.update({
      where: { id: job.id },
      data: { claim_token: randomUUID() },
    });

    assert.equal(await repository.renewClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
    }), null);
    assert.equal(await repository.renewClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
    }), null);
    const events = await fixture.database.source_processor_diagnostic_events
      .findMany({
        where: {
          source_test_job_id: job.id,
          phase: "lease_lost",
          safe_code: "WORK_CLAIM_RENEWAL_LOST",
        },
      });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.correlation_kind, "source_test");
    assert.equal(events[0]!.request_attempt_id, null);
  } finally {
    await fixture.close();
  }
});

test("a terminal source-test capture/result gap is fenced once after lease expiry", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("captured-source-test-gap");
  try {
    const now = await databaseNow(fixture.database);
    const claimToken = randomUUID();
    const job = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    await fixture.database.provider_source_runtime_states.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: {
        supervisor_epoch_id: epoch.epochId,
        phase: "validating",
        activity: "running",
        run_lease_acquired_at: now,
        run_lease_expires_at: new Date(now.getTime() + 20_000),
        updated_at: now,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "source_test",
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceTestJobId: job.id,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "captured",
      outcomeClass: "captured",
      safeOutcomeHash: "c".repeat(64),
      terminalAt: now,
    });
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    assert.equal((await fixture.database.provider_source_test_jobs
      .findUniqueOrThrow({ where: { id: job.id } })).state, "running");

    await fixture.database.provider_source_test_jobs.update({
      where: { id: job.id },
      data: { claim_expires_at: new Date(now.getTime() - 1_000) },
    });
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    const [storedJob, runtime, result] = await Promise.all([
      fixture.database.provider_source_test_jobs.findUniqueOrThrow({
        where: { id: job.id },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
      fixture.database.provider_source_test_results.findUniqueOrThrow({
        where: { job_id: job.id },
      }),
    ]);
    assert.equal(storedJob.state, "fenced");
    assert.equal(runtime.phase, "action_required");
    assert.equal(runtime.activity, "action_required");
    assert.equal(result.request_attempt_id, attemptId);
    assert.equal(result.request_terminal_state, "captured");
    assert.equal(result.outcome, "failure");
    assert.equal(result.safe_code, "TEST_RESULT_PUBLICATION_INCOMPLETE");
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: { source_test_job_id: job.id, phase: "work_recovered" },
      }),
      1,
    );
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    assert.equal(
      await fixture.database.provider_source_test_results.count({
        where: { job_id: job.id },
      }),
      1,
    );
    const reclaimed = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(reclaimed, null);
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: {
          request_attempt_id: attemptId,
          phase: "adapter_request_started",
        },
      }),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("a terminal connection-test capture/result gap is fenced idempotently", async () => {
  const { fixture, ownerKey, leaseToken, epoch } =
    await recoveryFixture("captured-connection-test-gap");
  try {
    const now = await databaseNow(fixture.database);
    const claimToken = randomUUID();
    const job = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: job.id },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "captured",
      outcomeClass: "captured",
      safeOutcomeHash: "d".repeat(64),
      responseBytes: 12,
      durationMs: 4,
      terminalAt: now,
    });
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    assert.equal(
      await fixture.database.source_connection_test_results.count({
        where: { job_id: job.id },
      }),
      0,
    );

    await fixture.database.source_connection_test_jobs.update({
      where: { id: job.id },
      data: { claim_expires_at: new Date(now.getTime() - 1_000) },
    });
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    const [storedJob, result, recoveredEvents] = await Promise.all([
      fixture.database.source_connection_test_jobs.findUniqueOrThrow({
        where: { id: job.id },
      }),
      fixture.database.source_connection_test_results.findUniqueOrThrow({
        where: { job_id: job.id },
      }),
      fixture.database.source_processor_diagnostic_events.count({
        where: { connection_test_job_id: job.id, phase: "work_recovered" },
      }),
    ]);
    assert.equal(storedJob.state, "fenced");
    assert.equal(result.request_attempt_id, attemptId);
    assert.equal(result.request_terminal_state, "captured");
    assert.equal(result.outcome, "failure");
    assert.equal(result.safe_code, "TEST_RESULT_PUBLICATION_INCOMPLETE");
    assert.deepEqual(result.measurements_json, {
      duration_ms: 4,
      response_bytes: 12,
    });
    assert.equal(recoveredEvents, 1);
    assert.equal(
      await fixture.database.source_connection_test_results.count({
        where: { job_id: job.id },
      }),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("a terminal page capture refetches the same cursor only after expiry", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("terminal-page-gap");
  try {
    const now = await databaseNow(fixture.database);
    const claimToken = randomUUID();
    const claimLeaseId = randomUUID();
    const run = await createPinnedSourceRun(
      fixture.database,
      fixture,
      source,
      {
        state: "running",
        createdAt: now,
        requestedCursor: null,
        requestedCursorFingerprint: null,
        leaseOwner: ownerKey,
        leaseToken: claimToken,
        claimLeaseId,
        leaseExpiresAt: new Date(now.getTime() + 20_000),
      },
    );
    await fixture.database.provider_source_runtime_states.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: {
        supervisor_epoch_id: epoch.epochId,
        phase: "requesting",
        activity: "running",
        current_run_id: run.id,
        run_lease_acquired_at: now,
        run_lease_expires_at: new Date(now.getTime() + 20_000),
        updated_at: now,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "page_read",
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        runId: run.id,
        pageNumber: 1,
        cursorGeneration: 1n,
        requestedCursorFingerprint: null,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "captured",
      outcomeClass: "captured",
      safeOutcomeHash: "b".repeat(64),
      terminalAt: now,
    });
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: {
          request_attempt_id: attemptId,
          phase: "adapter_request_started",
        },
      }),
      1,
    );
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });
    assert.equal((await fixture.database.import_runs.findUniqueOrThrow({
      where: { id: run.id },
    })).state, "running");

    await fixture.database.import_runs.update({
      where: { id: run.id },
      data: { lease_expires_at: new Date(now.getTime() - 1_000) },
    });
    await work.recoverExpiredClaims({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
    });

    const [storedRun, runtime, cursor] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({ where: { id: run.id } }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
      fixture.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(storedRun.state, "queued");
    assert.equal(storedRun.failure_code, null);
    assert.equal(storedRun.lease_owner, null);
    assert.equal(runtime.activity, "queued");
    assert.equal(runtime.current_run_id, run.id);
    assert.equal(cursor.cursor_generation, 1n);
    assert.equal(cursor.cursor_fingerprint, null);
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: { run_id: run.id, phase: "work_recovered" },
      }),
      1,
    );
    const reclaimed = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(reclaimed?.kind, "page_read");
    if (!reclaimed || reclaimed.kind !== "page_read") {
      throw new Error("Expected the captured page gap to be reclaimed.");
    }
    assert.equal(reclaimed.runId, run.id);
    assert.equal(reclaimed.pageNumber, 1);
    assert.equal(reclaimed.cursorGeneration, 1n);
    assert.equal(reclaimed.requestedCursorFingerprint, null);
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: {
          request_attempt_id: attemptId,
          phase: "adapter_request_started",
        },
      }),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("a source already paused by page commit overrides a stale continuation", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("pause-after-page-commit");
  try {
    const now = await databaseNow(fixture.database);
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(requested.kind, "created");
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    const claimed = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimed?.kind, "page_read");
    if (!claimed || claimed.kind !== "page_read") {
      throw new Error("Expected a claimed page read.");
    }
    const cursorFingerprint = "d".repeat(64);
    await fixture.database.$transaction([
      fixture.database.import_runs.update({
        where: { id: claimed.runId },
        data: {
          counters_json: { pages: 1, records: 2 },
          current_cursor: "stale-cursor",
          current_cursor_fingerprint: cursorFingerprint,
          current_cursor_key: cursorFingerprint,
          next_page_number: 2,
        },
      }),
      fixture.database.provider_source_instances.update({
        where: { id: source.sourceInstanceId },
        data: {
          state: "paused",
          pause_requested_at: null,
          paused_at: now,
          updated_at: now,
        },
      }),
    ]);

    const applied = await work.finishPageTurn({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
      decision: {
        kind: "continued",
        continuationRunId: randomUUID(),
        cursorFingerprint,
        pagesCommitted: 1,
        recordsCommitted: 2,
      },
    });
    assert.deepEqual(applied, { kind: "paused" });
    const [run, runtime] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({
        where: { id: claimed.runId },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(run.state, "incomplete");
    assert.equal(run.lease_owner, null);
    assert.equal(runtime.phase, "paused");
    assert.equal(runtime.activity, "paused");
    assert.equal(await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    }), null);
  } finally {
    await fixture.close();
  }
});

test("work claim and its required diagnostic roll back as one transition", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("atomic-work-claim-diagnostic");
  try {
    const now = await databaseNow(fixture.database);
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    if (requested.kind !== "created") throw new Error("Expected queued run.");
    await fixture.database.$executeRawUnsafe(`
      create function public.reject_task007_work_claim_diagnostic()
      returns trigger language plpgsql as $$
      begin
        if new.safe_code = 'WORK_CLAIMED' then
          raise exception 'forced diagnostic write failure';
        end if;
        return new;
      end $$
    `);
    await fixture.database.$executeRawUnsafe(`
      create trigger reject_task007_work_claim_diagnostic
      before insert on public.source_processor_diagnostic_events
      for each row execute function public.reject_task007_work_claim_diagnostic()
    `);
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    await assert.rejects(work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    }), /forced diagnostic write failure/u);
    const stored = await fixture.database.import_runs.findUniqueOrThrow({
      where: { id: requested.run.id },
    });
    assert.equal(stored.state, "queued");
    assert.equal(stored.lease_owner, null);
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: { run_id: requested.run.id, phase: "work_claimed" },
      }),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("a shared episode terminalizes a permit waiter and preserves a fenced test lane", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("shared-episode-waiter-race");
  try {
    const sibling = await createAcceptanceProviderSource(fixture, {
      platformKey: "collector_crypt",
      displayName: "Collector Crypt",
      mapperKey: "collector-crypt-provider-observation",
      identityNamespaceKey: "dataforrest-collector-crypt-records-v1",
      intervalSeconds: 60,
      hashCharacter: "e",
    });
    const now = await databaseNow(fixture.database);
    await activateAcceptanceRuntime(fixture.database, fixture, sibling, now);
    const sourceTest = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: sibling.providerId,
        source_instance_id: sibling.sourceInstanceId,
        source_revision_id: sibling.sourceRevisionId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        requested_by_actor_key: "operator-admin",
        queued_at: new Date(now.getTime() - 1_000),
      },
    });
    const repository = new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    );
    const claimedTest = await repository.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimedTest?.kind, "source_test");
    assert.equal(claimedTest?.id, sourceTest.id);
    if (!claimedTest || claimedTest.kind !== "source_test") {
      throw new Error("Expected a claimed source test.");
    }
    const runRequest = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(runRequest.kind, "created");
    const claimedPage = await repository.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimedPage?.kind, "page_read");
    if (!claimedPage || claimedPage.kind !== "page_read") {
      throw new Error("Expected a claimed page read.");
    }

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
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const detectorAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: detectorClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: detector.id,
      },
      startedAt: now,
    });
    const blockingTerminalization = {
      organizationId: fixture.organizationId,
      requestAttemptId: detectorAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "failed",
      outcomeClass: "authentication_failed",
      safeCode: "authentication_failed",
      safeOutcomeHash: "f".repeat(64),
      terminalAt: now,
      blockingFailure: {
        failureClass: "authentication_failed",
        safeCode: "authentication_failed",
      },
    } as const;
    const blocked = await requests.terminalize(blockingTerminalization);
    assert.deepEqual(
      await requests.terminalize(blockingTerminalization),
      blocked,
    );
    assert.equal(blocked.blockingEpisodeOpened, true);
    assert.ok(blocked.blockingEpisodeId);

    await repository.releaseUnstartedClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimedPage,
      waitReason: "capacity_blocked",
      releasedAt: now,
    });
    await repository.finishTestClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimedTest,
      outcome: "fenced",
      safeCode: "STALE_WORK_FENCED",
    });

    const [run, testJob, pageLane, testLane, episodeEvents] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({
        where: { id: claimedPage.runId },
      }),
      fixture.database.provider_source_test_jobs.findUniqueOrThrow({
        where: { id: claimedTest.id },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: sibling.sourceInstanceId },
      }),
      fixture.database.source_processor_diagnostic_events.findMany({
        where: {
          blocking_episode_id: blocked.blockingEpisodeId,
          phase: "episode_opened",
        },
      }),
    ]);
    assert.equal(run.state, "incomplete");
    assert.equal(run.failure_code, "CONNECTION_BLOCKED");
    assert.equal(run.lease_owner, null);
    assert.equal(testJob.state, "fenced");
    for (const lane of [pageLane, testLane]) {
      assert.equal(lane.activity, "waiting");
      assert.equal(lane.wait_reason, "connection_blocked");
      assert.equal(lane.blocking_episode_id, blocked.blockingEpisodeId);
    }
    assert.equal(episodeEvents.length, 1);
  } finally {
    await fixture.close();
  }
});

test("an elapsed queued continuation rolls over before any old-run request", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("queued-elapsed-rollover");
  try {
    const now = await databaseNow(fixture.database);
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    if (requested.kind !== "created") throw new Error("Expected queued run.");
    const runLeaseToken = randomUUID();
    const runClaimLeaseId = randomUUID();
    const requestAttemptId = randomUUID();
    const pageId = randomUUID();
    const nextCursor = "rollover-cursor-1";
    const nextFingerprint = "9".repeat(64);
    await fixture.database.import_runs.update({
      where: { id: requested.run.id },
      data: {
        state: "running",
        lease_owner: ownerKey,
        lease_token: runLeaseToken,
        claim_lease_id: runClaimLeaseId,
        lease_expires_at: new Date(now.getTime() + 30_000),
        started_at: new Date(now.getTime() - 16 * 60_000),
      },
    });
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
        claim_token: runLeaseToken,
        supervisor_epoch_id: epoch.epochId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        run_id: requested.run.id,
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
        run_id: requested.run.id,
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
        run_claim_lease_id: runClaimLeaseId,
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
        first_committed_run_id: requested.run.id,
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
          advanced_by_run_id: requested.run.id,
          advanced_by_page_id: pageId,
          updated_at: now,
        },
      }),
      fixture.database.import_runs.update({
        where: { id: requested.run.id },
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
          current_run_id: requested.run.id,
          phase: "queued",
          activity: "queued",
          queued_at: now,
          updated_at: now,
        },
      }),
    ]);
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    assert.equal(await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    }), null);
    const [oldRun, continuations, attempts] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({
        where: { id: requested.run.id },
      }),
      fixture.database.import_runs.findMany({
        where: {
          source_instance_id: source.sourceInstanceId,
          trigger: "continuation",
        },
      }),
      fixture.database.source_request_attempts.count({
        where: { run_id: requested.run.id },
      }),
    ]);
    assert.equal(oldRun.state, "incomplete");
    assert.equal(attempts, 0);
    assert.equal(continuations.length, 1);
    assert.equal(continuations[0]?.state, "queued");
    assert.equal(
      continuations[0]?.requested_cursor_key,
      oldRun.current_cursor_key,
    );
    const next = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(next?.kind, "page_read");
    if (!next || next.kind !== "page_read") {
      throw new Error("Expected the rollover continuation.");
    }
    assert.equal(next.runId, continuations[0]?.id);
  } finally {
    await fixture.close();
  }
});

test("an ambiguously acknowledged claim command replays one exact work item", async () => {
  const { fixture, ownerKey, leaseToken, epoch } =
    await recoveryFixture("claim-command-replay");
  try {
    const now = await databaseNow(fixture.database);
    const [oldest, later] = await Promise.all([
      fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.connectionProfileId,
          connection_revision_id: fixture.connectionRevisionId,
          expected_health_generation: 0n,
          requested_by_actor_key: "operator-admin",
          queued_at: new Date(now.getTime() - 2_000),
        },
      }),
      fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.connectionProfileId,
          connection_revision_id: fixture.connectionRevisionId,
          expected_health_generation: 0n,
          requested_by_actor_key: "operator-admin",
          queued_at: new Date(now.getTime() - 1_000),
        },
      }),
    ]);
    const repository = new ProviderSourceSupervisorWorkRepository(
      fixture.database,
    );
    const command = {
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    } as const;
    const first = await repository.claimNext(command);
    const replayed = await repository.claimNext(command);
    assert.equal(first?.id, oldest.id);
    assert.deepEqual(replayed, first);
    assert.equal(
      await fixture.database.source_connection_test_jobs.count({
        where: { state: "running" },
      }),
      1,
    );
    assert.equal(
      (await fixture.database.source_connection_test_jobs.findUniqueOrThrow({
        where: { id: later.id },
      })).state,
      "queued",
    );
    assert.equal(
      await fixture.database.source_processor_diagnostic_events.count({
        where: { connection_test_job_id: oldest.id, phase: "work_claimed" },
      }),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("same-revision profile recovery preserves a retained nonrevoked connection pin", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("same-revision-preserved-pin");
  try {
    const now = await databaseNow(fixture.database);
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    if (requested.kind !== "created") throw new Error("Expected retained A run.");

    const revisionB = randomUUID();
    await fixture.database.$transaction(async (transaction) => {
      await transaction.source_connection_revisions.update({
        where: { id: fixture.connectionRevisionId },
        data: { state: "retired", retired_at: now },
      });
      await transaction.source_connection_revisions.create({
        data: {
          id: revisionB,
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.connectionProfileId,
          revision_number: 2,
          source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
          source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
          configuration_ciphertext: new Uint8Array(32).fill(4),
          configuration_nonce: new Uint8Array(12).fill(5),
          configuration_auth_tag: new Uint8Array(16).fill(6),
          encryption_key_version: 1,
          configuration_fingerprint: "c".repeat(64),
          state: "active",
          created_by_actor_key: "operator-admin",
          created_at: now,
          activated_at: now,
        },
      });
      await transaction.source_connection_profiles.update({
        where: { id: fixture.connectionProfileId },
        data: { active_revision_id: revisionB, updated_at: now },
      });
    });

    const requests = new ProviderSourceRequestRepository(fixture.database);
    const detectorToken = randomUUID();
    const detector = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: revisionB,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: detectorToken,
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const detectorAttempt = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: detectorToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: revisionB,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: detector.id },
      startedAt: now,
    });
    const blocked = await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: detectorAttempt,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "failed",
      outcomeClass: "authentication_failed",
      safeCode: "authentication_failed",
      safeOutcomeHash: "d".repeat(64),
      terminalAt: now,
      blockingFailure: {
        failureClass: "authentication_failed",
        safeCode: "authentication_failed",
      },
    });
    assert.ok(blocked.blockingEpisodeId);
    const blockedRun = await fixture.database.import_runs.findUniqueOrThrow({
      where: { id: requested.run.id },
    });
    assert.equal(blockedRun.state, "incomplete");
    assert.equal(blockedRun.connection_revision_id, fixture.connectionRevisionId);

    const recoveryToken = randomUUID();
    const recoveryJob = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: revisionB,
        blocking_episode_id: blocked.blockingEpisodeId,
        recovery_blocked_revision_id: revisionB,
        expected_health_generation: 1n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: recoveryToken,
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const recoveryAttempt = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: recoveryToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: revisionB,
      expectedHealthGeneration: 1n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: recoveryJob.id,
        blockingEpisodeId: blocked.blockingEpisodeId,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: recoveryAttempt,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "e".repeat(64),
      terminalAt: now,
    });
    const recovered = await new ProviderSourceTestResultRepository(
      fixture.database,
    ).completeConnectionTest({
      organizationId: fixture.organizationId,
      jobId: recoveryJob.id,
      requestAttemptId: recoveryAttempt,
      claimOwner: ownerKey,
      claimToken: recoveryToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      outcome: "success",
      safeCode: "connection_valid",
      completedAt: now,
    });
    assert.equal(recovered.episodeClosed, true);
    assert.equal(recovered.resumedRunIds.length, 1);
    const resumed = await fixture.database.import_runs.findUniqueOrThrow({
      where: { id: recovered.resumedRunIds[0]! },
    });
    assert.equal(resumed.trigger, "recovery");
    assert.equal(resumed.state, "queued");
    assert.equal(resumed.connection_revision_id, fixture.connectionRevisionId);
    assert.equal(resumed.requested_cursor_key, blockedRun.current_cursor_key);
    assert.equal(
      await fixture.database.import_runs.count({
        where: {
          source_instance_id: source.sourceInstanceId,
          state: "queued",
          connection_revision_id: revisionB,
        },
      }),
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("a profile episode fences a terminal source-test capture before result publication", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("profile-episode-result-race");
  try {
    const now = await databaseNow(fixture.database);
    const sourceJob = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: source.providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        requested_by_actor_key: "operator-admin",
        queued_at: new Date(now.getTime() - 1_000),
      },
    });
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    const claimed = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimed?.kind, "source_test");
    if (!claimed || claimed.kind !== "source_test") {
      throw new Error("Expected source-test claim.");
    }
    assert.equal(claimed.id, sourceJob.id);
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const sourceAttempt = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: claimed.claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "source_test",
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceTestJobId: claimed.id,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: sourceAttempt,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "4".repeat(64),
      terminalAt: now,
    });

    const detectorToken = randomUUID();
    const detector = await fixture.database.source_connection_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: detectorToken,
        claim_expires_at: new Date(now.getTime() + 20_000),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const detectorAttempt = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: ownerKey,
      claimToken: detectorToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: detector.id },
      startedAt: now,
    });
    const blocked = await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: detectorAttempt,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "failed",
      outcomeClass: "authentication_failed",
      safeCode: "authentication_failed",
      safeOutcomeHash: "5".repeat(64),
      terminalAt: now,
      blockingFailure: {
        failureClass: "authentication_failed",
        safeCode: "authentication_failed",
      },
    });
    await assert.rejects(
      new ProviderSourceTestResultRepository(fixture.database).completeSourceTest({
        organizationId: fixture.organizationId,
        jobId: claimed.id,
        requestAttemptId: sourceAttempt,
        claimOwner: ownerKey,
        claimToken: claimed.claimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken: leaseToken,
        outcome: "success",
        safeCode: "source_test_succeeded",
        completedAt: now,
      }),
      (error: unknown) => error instanceof Error &&
        "code" in error && error.code === "CONNECTION_BLOCKED",
    );
    await work.finishTestClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
      outcome: "fenced",
      safeCode: "STALE_WORK_FENCED",
    });
    const [storedJob, runtime] = await Promise.all([
      fixture.database.provider_source_test_jobs.findUniqueOrThrow({
        where: { id: claimed.id },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(storedJob.state, "fenced");
    assert.equal(
      await fixture.database.provider_source_test_results.count({
        where: { job_id: claimed.id },
      }),
      0,
    );
    assert.equal(runtime.activity, "waiting");
    assert.equal(runtime.wait_reason, "connection_blocked");
    assert.equal(runtime.blocking_episode_id, blocked.blockingEpisodeId);
  } finally {
    await fixture.close();
  }
});

test("pause after claim and graceful release completes at the unchanged cursor", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("pause-claimed-unstarted");
  try {
    const now = await databaseNow(fixture.database);
    const runs = new ProviderSourceImportRunRepository(fixture.database);
    const requested = await runs.requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    if (requested.kind !== "created") throw new Error("Expected pause run.");
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    const claimed = await work.claimNext({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    });
    assert.equal(claimed?.kind, "page_read");
    if (!claimed || claimed.kind !== "page_read") {
      throw new Error("Expected claimed page.");
    }
    const admin = new ProviderSourceAdminLifecycleRepository(fixture.database);
    assert.deepEqual(await admin.requestPause({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      actorKey: "operator-admin",
      requestedAt: now,
    }), { state: "pause_requested" });
    await work.releaseUnstartedClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
      waitReason: "graceful_shutdown",
      releasedAt: now,
    });
    const [pausedSource, pausedRun, pausedLane, cursor] = await Promise.all([
      fixture.database.provider_source_instances.findUniqueOrThrow({
        where: { id: source.sourceInstanceId },
      }),
      fixture.database.import_runs.findUniqueOrThrow({
        where: { id: requested.run.id },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
      fixture.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(pausedSource.state, "paused");
    assert.equal(pausedSource.pause_requested_at, null);
    assert.equal(pausedRun.state, "incomplete");
    assert.equal(pausedRun.failure_code, "SOURCE_PAUSED");
    assert.equal(pausedLane.activity, "paused");
    assert.equal(pausedLane.current_run_id, null);
    assert.equal(cursor.cursor_fingerprint, null);
    assert.equal(
      await fixture.database.source_request_attempts.count({
        where: { run_id: requested.run.id },
      }),
      0,
    );

    await admin.resume({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      actorKey: "operator-admin",
      resumedAt: now,
    });
    const resumed = await runs.requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    if (resumed.kind !== "created") throw new Error("Expected resumed run.");
    assert.equal(resumed.run.requestedCursorFingerprint, null);
    assert.equal(
      (await fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      })).activity,
      "inactive",
    );
  } finally {
    await fixture.close();
  }
});

test("an ambiguous page claim replay survives a later pause and closes locally", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("claim-replay-pause");
  try {
    const now = await databaseNow(fixture.database);
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: now,
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    if (requested.kind !== "created") throw new Error("Expected replay run.");
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    const command = {
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      claimOwner: ownerKey,
      claimToken: randomUUID(),
      claimLeaseId: randomUUID(),
    } as const;
    const claimed = await work.claimNext(command);
    assert.equal(claimed?.kind, "page_read");
    if (!claimed || claimed.kind !== "page_read") {
      throw new Error("Expected page claim.");
    }
    await new ProviderSourceAdminLifecycleRepository(fixture.database).requestPause({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      actorKey: "operator-admin",
      requestedAt: now,
    });
    const replay = await work.claimNext(command);
    assert.equal(replay?.kind, "page_read");
    assert.equal(replay?.id, claimed.id);
    assert.equal(
      await fixture.database.import_runs.count({ where: { state: "running" } }),
      1,
    );
    await work.finishFencedPageClaim({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      work: claimed,
    });
    const [run, lane, storedSource] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({
        where: { id: requested.run.id },
      }),
      fixture.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: source.sourceInstanceId },
      }),
      fixture.database.provider_source_instances.findUniqueOrThrow({
        where: { id: source.sourceInstanceId },
      }),
    ]);
    assert.equal(run.state, "incomplete");
    assert.equal(run.failure_code, "SOURCE_PAUSED");
    assert.equal(lane.activity, "paused");
    assert.equal(storedSource.state, "paused");
    assert.equal(storedSource.pause_requested_at, null);
  } finally {
    await fixture.close();
  }
});

test("due materialization atomically orders WORK_DUE before the queued run", async () => {
  const { fixture, source, ownerKey, leaseToken, epoch } =
    await recoveryFixture("atomic-work-due");
  try {
    const now = await databaseNow(fixture.database);
    const dueAt = new Date(now.getTime() - 2_000);
    await fixture.database.provider_source_schedules.update({
      where: { source_instance_id: source.sourceInstanceId },
      data: { next_due_at: dueAt, updated_at: now },
    });
    const work = new ProviderSourceSupervisorWorkRepository(fixture.database);
    const due = await work.listDueSources({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      limit: 10,
    });
    assert.equal(due.length, 1);
    const runId = randomUUID();
    assert.equal(await work.materializeScheduledRun({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      ...due[0]!,
      runId,
    }), "created");
    assert.equal(await work.materializeScheduledRun({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      ...due[0]!,
      runId,
    }), "coalesced");
    const [run, events] = await Promise.all([
      fixture.database.import_runs.findUniqueOrThrow({ where: { id: runId } }),
      fixture.database.source_processor_diagnostic_events.findMany({
        where: { run_id: runId },
        orderBy: [{ occurred_at: "asc" }, { id: "asc" }],
      }),
    ]);
    assert.equal(run.created_at.getTime(), dueAt.getTime());
    assert.equal(events.filter(({ phase }) => phase === "work_due").length, 1);
    assert.equal(events[0]?.phase, "work_due");
    assert.equal(events[0]?.safe_code, "WORK_DUE");
    assert.equal(events[0]?.occurred_at.getTime(), dueAt.getTime());
    assert.ok(events.some(({ safe_code }) => safe_code === "RUN_QUEUED"));
  } finally {
    await fixture.close();
  }
});
