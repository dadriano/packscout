import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
  type AcceptanceSource,
  type ProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { PersistenceError } from "./persistence-error.ts";
import { ProviderSourceAdminLifecycleRepository } from "./provider-source-admin-lifecycle-repository.ts";
import { ProviderSourceAdminFailureAuditRepository } from "./provider-source-admin-failure-audit-repository.ts";
import { ProviderSourceCheckpointRepository } from "./provider-source-checkpoint-repository.ts";
import { ProviderSourceImportRunRepository } from "./provider-source-import-run-repository.ts";
import { ProviderSourceRequestRepository } from "./provider-source-request-repository.ts";
import { ProviderSourceSupervisorRepository } from "./provider-source-supervisor-repository.ts";
import { ProviderSourceTestResultRepository } from "./provider-source-test-result-repository.ts";
import { SourceConnectionAdminRepository } from "./source-connection-admin-repository.ts";

let fixture: ProviderSourceAcceptanceFixture;
let source: AcceptanceSource;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function assertPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 50);
    }),
  ]);
  assert.equal(state, "pending");
}

before(async () => {
  fixture = await createProviderSourceAcceptanceFixture("admin-lifecycle");
  source = await createAcceptanceProviderSource(fixture, {
    platformKey: "courtyard",
    displayName: "Courtyard",
    mapperKey: "courtyard-provider-observation",
    identityNamespaceKey: "courtyard-v1",
    intervalSeconds: 60,
    hashCharacter: "a",
  });
});

after(async () => {
  await fixture.close();
});

test("domain failure audit returns the exact durable safe receipt", async () => {
  const receipt = await new ProviderSourceAdminFailureAuditRepository(
    fixture.database,
  ).recordFailure({
    organizationId: fixture.organizationId,
    actorKey: "operator-admin",
    action: "source_resumed",
    subjectType: "provider_source",
    subjectId: source.sourceInstanceId,
    revisionId: source.sourceRevisionId,
    safeCode: "SOURCE_CONFLICT",
  });
  assert.equal(receipt.outcome, "failure");
  if (receipt.outcome !== "failure") assert.fail("expected failure receipt");
  assert.equal(receipt.safeCode, "SOURCE_CONFLICT");
  const durable = await fixture.database.audit_events.findFirstOrThrow({
    where: {
      organization_id: fixture.organizationId,
      actor_key: "operator-admin",
      action: "source_resumed",
      subject_id: source.sourceInstanceId,
      outcome: "failure",
    },
    orderBy: [{ occurred_at: "desc" }, { id: "desc" }],
  });
  assert.equal(durable.occurred_at.toISOString(), receipt.occurredAt);
  assert.deepEqual(durable.metadata_json, {
    revisionId: source.sourceRevisionId,
    safeCode: "SOURCE_CONFLICT",
  });
});

test("simultaneous connection and source test requests coalesce to one durable pending job", async () => {
  const other = await fixture.createIndependentClient();
  try {
    const connections = [
      new SourceConnectionAdminRepository(fixture.database),
      new SourceConnectionAdminRepository(other),
    ];
    const connectionJobs = await Promise.all(connections.map((repository) =>
      repository.requestConnectionTest({
        organizationId: fixture.organizationId,
        connectionProfileId: fixture.connectionProfileId,
        connectionRevisionId: fixture.connectionRevisionId,
        expectedHealthGeneration: 0n,
        requestedByActorKey: "operator-admin",
        requestedAt: ACCEPTANCE_CREATED_AT,
      })
    ));
    assert.equal(connectionJobs[0]!.jobId, connectionJobs[1]!.jobId);
    assert.equal(await fixture.database.source_connection_test_jobs.count({
      where: {
        organization_id: fixture.organizationId,
        connection_revision_id: fixture.connectionRevisionId,
        state: "queued",
      },
    }), 1);

    await fixture.database.$transaction(async (transaction) => {
      await transaction.source_connection_revisions.update({
        where: { id: fixture.connectionRevisionId },
        data: { state: "active", activated_at: ACCEPTANCE_CREATED_AT },
      });
      await transaction.source_connection_profiles.update({
        where: { id: fixture.connectionProfileId },
        data: {
          state: "active",
          active_revision_id: fixture.connectionRevisionId,
        },
      });
    });
    const sources = [
      new ProviderSourceAdminLifecycleRepository(fixture.database),
      new ProviderSourceAdminLifecycleRepository(other),
    ];
    const sourceJobs = await Promise.all(sources.map((repository) =>
      repository.requestSourceTest({
        organizationId: fixture.organizationId,
        providerId: source.providerId,
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        connectionProfileId: fixture.connectionProfileId,
        connectionRevisionId: fixture.connectionRevisionId,
        requestedByActorKey: "operator-admin",
        requestedAt: ACCEPTANCE_CREATED_AT,
      })
    ));
    assert.equal(sourceJobs[0]!.jobId, sourceJobs[1]!.jobId);
    assert.equal(await fixture.database.provider_source_test_jobs.count({
      where: {
        organization_id: fixture.organizationId,
        source_instance_id: source.sourceInstanceId,
        state: "queued",
      },
    }), 1);
  } finally {
    await other.$disconnect();
  }
});

test("connection activation rejects a tested-or-untested revision once a newer candidate exists", async () => {
  const isolated = await createProviderSourceAcceptanceFixture("latest-candidate");
  try {
    const connections = new SourceConnectionAdminRepository(isolated.database);
    const supersededCandidateId = randomUUID();
    await connections.addConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      expectedRevisionId: isolated.connectionRevisionId,
      revisionId: supersededCandidateId,
      revisionNumber: 2,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      encryptedConfiguration: {
        ciphertext: new Uint8Array(32).fill(2),
        nonce: new Uint8Array(12).fill(3),
        authTag: new Uint8Array(16).fill(4),
        keyVersion: 1,
      },
      configurationFingerprint: "2".repeat(64),
      actorKey: "operator-admin",
      createdAt: new Date("2026-08-21T12:10:00.000Z"),
    });
    const latestCandidateId = randomUUID();
    await connections.addConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      expectedRevisionId: supersededCandidateId,
      revisionId: latestCandidateId,
      revisionNumber: 3,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      encryptedConfiguration: {
        ciphertext: new Uint8Array(32).fill(5),
        nonce: new Uint8Array(12).fill(6),
        authTag: new Uint8Array(16).fill(7),
        keyVersion: 1,
      },
      configurationFingerprint: "3".repeat(64),
      actorKey: "operator-admin",
      createdAt: new Date("2026-08-21T12:10:01.000Z"),
    });
    await assert.rejects(
      connections.activateTestedConnectionRevision({
        organizationId: isolated.organizationId,
        connectionProfileId: isolated.connectionProfileId,
        connectionRevisionId: supersededCandidateId,
        expectedHealthGeneration: 0n,
        preservePinnedWork: true,
        actorKey: "operator-admin",
        activatedAt: new Date("2026-08-21T12:10:02.000Z"),
      }),
      (error) => error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
  } finally {
    await isolated.close();
  }
});

test("revoked connection recovery is fenced, tested, atomically queues exact checkpoint runs, and retries coalesce", async () => {
  const isolated = await createProviderSourceAcceptanceFixture("admin-recovery");
  try {
    const recoverySource = await createAcceptanceProviderSource(isolated, {
      platformKey: "courtyard",
      displayName: "Courtyard recovery",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "courtyard-v1",
      intervalSeconds: 60,
      hashCharacter: "b",
    });
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      recoverySource,
      ACCEPTANCE_CREATED_AT,
    );
    const connections = new SourceConnectionAdminRepository(isolated.database);
    await connections.revokeConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      expectedHealthGeneration: 0n,
      actorKey: "operator-admin",
      revokedAt: new Date("2026-08-21T13:00:00.000Z"),
    });
    const failedCandidateId = randomUUID();
    await connections.addRecoveryConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      blockedRevisionId: isolated.connectionRevisionId,
      latestRevisionId: isolated.connectionRevisionId,
      blockingEpisodeId: null,
      revisionId: failedCandidateId,
      revisionNumber: 2,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      encryptedConfiguration: {
        ciphertext: new Uint8Array(32).fill(7),
        nonce: new Uint8Array(12).fill(8),
        authTag: new Uint8Array(16).fill(9),
        keyVersion: 1,
      },
      configurationFingerprint: "c".repeat(64),
      actorKey: "operator-admin",
      createdAt: new Date("2026-08-21T13:00:01.000Z"),
    });
    await connections.revokeConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: failedCandidateId,
      expectedHealthGeneration: 0n,
      actorKey: "operator-admin",
      revokedAt: new Date("2026-08-21T13:00:01.500Z"),
    });
    const candidateId = randomUUID();
    await connections.addRecoveryConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      blockedRevisionId: failedCandidateId,
      latestRevisionId: failedCandidateId,
      blockingEpisodeId: null,
      revisionId: candidateId,
      revisionNumber: 3,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      encryptedConfiguration: {
        ciphertext: new Uint8Array(32).fill(10),
        nonce: new Uint8Array(12).fill(11),
        authTag: new Uint8Array(16).fill(12),
        keyVersion: 1,
      },
      configurationFingerprint: "e".repeat(64),
      actorKey: "operator-admin",
      createdAt: new Date("2026-08-21T13:00:01.750Z"),
    });
    const job = await connections.requestConnectionRecoveryTest({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateId,
      expectedHealthGeneration: 0n,
      blockedRevisionId: failedCandidateId,
      blockingEpisodeId: null,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date("2026-08-21T13:00:02.000Z"),
    });
    const supervisorOwner = "worker-admin-recovery";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      isolated.database,
    ).acquire({
      environmentKey: "admin-recovery",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now: new Date("2026-08-21T13:00:03.000Z"),
    });
    const claimToken = randomUUID();
    await isolated.database.source_connection_test_jobs.update({
      where: { id: job.jobId },
      data: {
        state: "running",
        claim_owner: supervisorOwner,
        claim_token: claimToken,
        claim_expires_at: epoch.leaseExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: new Date("2026-08-21T13:00:04.000Z"),
      },
    });
    const requests = new ProviderSourceRequestRepository(isolated.database);
    const attemptId = await requests.begin({
      organizationId: isolated.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: supervisorOwner,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: job.jobId },
      startedAt: new Date("2026-08-21T13:00:05.000Z"),
    });
    await requests.terminalize({
      organizationId: isolated.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "d".repeat(64),
      terminalAt: new Date("2026-08-21T13:00:06.000Z"),
    });
    await new ProviderSourceTestResultRepository(
      isolated.database,
    ).completeConnectionTest({
      organizationId: isolated.organizationId,
      jobId: job.jobId,
      requestAttemptId: attemptId,
      claimOwner: supervisorOwner,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_recovered",
      completedAt: new Date("2026-08-21T13:00:07.000Z"),
    });
    const activation = {
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateId,
      expectedHealthGeneration: 0n,
      blockedRevisionId: failedCandidateId,
      blockingEpisodeId: null,
      actorKey: "operator-admin",
      activatedAt: new Date("2026-08-21T13:00:08.000Z"),
    } as const;
    await assert.rejects(
      connections.activateTestedConnectionRecovery({
        ...activation,
        blockedRevisionId: isolated.connectionRevisionId,
      }),
      (error) => error instanceof PersistenceError &&
        error.code === "CONFIG_REVISION_UNTESTED",
    );
    const other = await isolated.createIndependentClient();
    const manualLocked = deferred();
    const releaseManual = deferred();
    const manual = other.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        select provider.id
        from public.provider_sources provider
        join public.provider_source_instances source
          on source.provider_id = provider.id
         and source.organization_id = provider.organization_id
        where provider.id = ${recoverySource.providerId}::uuid
          and provider.organization_id = ${isolated.organizationId}::uuid
        for update of provider, source
      `;
      manualLocked.resolve();
      await releaseManual.promise;
      return new ProviderSourceImportRunRepository(other)
        .requestRunInTransaction(transaction, {
          organizationId: isolated.organizationId,
          providerId: recoverySource.providerId,
          runId: randomUUID(),
          trigger: "manual",
          requestedByActorKey: "operator-admin",
          requestedAt: new Date("2026-08-21T13:00:07.500Z"),
          expectedSourceRevisionId: recoverySource.sourceRevisionId,
        });
    });
    await manualLocked.promise;
    const activating = connections.activateTestedConnectionRecovery(activation);
    await assertPending(activating);
    releaseManual.resolve();
    const [manualResult, first] = await Promise.all([manual, activating]);
    await other.$disconnect();
    assert.equal(manualResult.kind, "source_unavailable");
    const second = await connections.activateTestedConnectionRecovery({
      ...activation,
      activatedAt: new Date("2026-08-21T13:00:09.000Z"),
    });
    assert.deepEqual(second.runIds, first.runIds);
    assert.equal(first.runIds.length, 1);
    const run = await isolated.database.import_runs.findUniqueOrThrow({
      where: { id: first.runIds[0]! },
    });
    assert.equal(run.trigger, "recovery");
    assert.equal(run.source_instance_id, recoverySource.sourceInstanceId);
    assert.equal(run.source_revision_id, recoverySource.sourceRevisionId);
    assert.equal(run.connection_revision_id, candidateId);
    assert.equal(run.checkpoint_generation, 1n);
    assert.equal(run.requested_checkpoint_fingerprint, null);
    assert.equal(await isolated.database.import_runs.count({
      where: {
        source_instance_id: recoverySource.sourceInstanceId,
        trigger: "recovery",
      },
    }), 1);
  } finally {
    await isolated.close();
  }
});

test("timing revisions allow draft, paused, and active sources but reject disabled and replaced history", async () => {
  const repository = new ProviderSourceAdminLifecycleRepository(fixture.database);
  const current = await repository.loadSource({
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    sourceInstanceId: source.sourceInstanceId,
  });
  assert.equal(current?.state, "draft");
  const draft = await repository.reviseInterval({
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    sourceInstanceId: source.sourceInstanceId,
    expectedSourceRevisionId: source.sourceRevisionId,
    expectedScheduleRevisionId: current!.scheduleRevisionId,
    intervalSeconds: 120,
    actorKey: "operator-admin",
    effectiveAt: new Date("2026-08-21T12:01:00.000Z"),
  });
  await fixture.database.provider_source_instances.update({
    where: { id: source.sourceInstanceId },
    data: {
      state: "paused",
      activated_at: ACCEPTANCE_CREATED_AT,
      paused_at: ACCEPTANCE_CREATED_AT,
    },
  });
  const paused = await repository.reviseInterval({
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    sourceInstanceId: source.sourceInstanceId,
    expectedSourceRevisionId: source.sourceRevisionId,
    expectedScheduleRevisionId: draft.scheduleRevisionId,
    intervalSeconds: 180,
    actorKey: "operator-admin",
    effectiveAt: new Date("2026-08-21T12:02:00.000Z"),
  });
  await repository.resume({
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    sourceInstanceId: source.sourceInstanceId,
    expectedSourceRevisionId: source.sourceRevisionId,
    actorKey: "operator-admin",
    resumedAt: new Date("2026-08-21T12:03:00.000Z"),
  });
  const active = await repository.reviseInterval({
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    sourceInstanceId: source.sourceInstanceId,
    expectedSourceRevisionId: source.sourceRevisionId,
    expectedScheduleRevisionId: paused.scheduleRevisionId,
    intervalSeconds: 240,
    actorKey: "operator-admin",
    effectiveAt: new Date("2026-08-21T12:04:00.000Z"),
  });
  const idleNextDueAt = await fixture.database.provider_source_schedules
    .findUniqueOrThrow({
      where: { source_instance_id: source.sourceInstanceId },
      select: { next_due_at: true },
    });
  assert.equal(
    idleNextDueAt.next_due_at.toISOString(),
    "2026-08-21T12:08:00.000Z",
  );
  const timingOwner = "admin-timing-worker";
  const timingLeaseToken = randomUUID();
  const timingEpoch = await new ProviderSourceSupervisorRepository(
    fixture.database,
  ).acquire({
    environmentKey: "admin-timing",
    ownerKey: timingOwner,
    leaseToken: timingLeaseToken,
    now: new Date("2026-08-21T12:04:10.000Z"),
  });
  await createPinnedSourceRun(fixture.database, fixture, source, {
    state: "running",
    createdAt: new Date("2026-08-21T12:04:11.000Z"),
    requestedCheckpoint: null,
    requestedCheckpointFingerprint: null,
    leaseOwner: timingOwner,
    leaseToken: randomUUID(),
    leaseExpiresAt: timingEpoch.leaseExpiresAt,
  });
  const activeWithWork = await repository.reviseInterval({
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    sourceInstanceId: source.sourceInstanceId,
    expectedSourceRevisionId: source.sourceRevisionId,
    expectedScheduleRevisionId: active.scheduleRevisionId,
    intervalSeconds: 300,
    actorKey: "operator-admin",
    effectiveAt: new Date("2026-08-21T12:04:30.000Z"),
  });
  const deferredNextDueAt = await fixture.database.provider_source_schedules
    .findUniqueOrThrow({
      where: { source_instance_id: source.sourceInstanceId },
      select: { next_due_at: true },
    });
  assert.equal(
    deferredNextDueAt.next_due_at.toISOString(),
    "2026-08-21T12:08:00.000Z",
    "running work retains its current due marker so the latest interval is applied at its safe boundary",
  );
  await repository.disable({
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    sourceInstanceId: source.sourceInstanceId,
    expectedSourceRevisionId: source.sourceRevisionId,
    actorKey: "operator-admin",
    disabledAt: new Date("2026-08-21T12:05:00.000Z"),
  });
  await assert.rejects(
    repository.reviseInterval({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: activeWithWork.scheduleRevisionId,
      intervalSeconds: 300,
      actorKey: "operator-admin",
      effectiveAt: new Date("2026-08-21T12:06:00.000Z"),
    }),
    (error) => error instanceof PersistenceError && error.code === "SOURCE_FENCED",
  );
  await fixture.database.provider_source_instances.update({
    where: { id: source.sourceInstanceId },
    data: { state: "replaced", replaced_at: new Date("2026-08-21T12:07:00.000Z") },
  });
  await assert.rejects(
    repository.reviseInterval({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      sourceInstanceId: source.sourceInstanceId,
      expectedSourceRevisionId: source.sourceRevisionId,
      expectedScheduleRevisionId: activeWithWork.scheduleRevisionId,
      intervalSeconds: 300,
      actorKey: "operator-admin",
      effectiveAt: new Date("2026-08-21T12:08:00.000Z"),
    }),
    (error) => error instanceof PersistenceError && error.code === "SOURCE_FENCED",
  );
});

test("repeat pause and resume commands coalesce with DB-time lifecycle diagnostics", async () => {
  const isolated = await createProviderSourceAcceptanceFixture("repeat-lifecycle");
  try {
    const isolatedSource = await createAcceptanceProviderSource(isolated, {
      platformKey: "courtyard",
      displayName: "Courtyard repeat",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "courtyard-v1",
      intervalSeconds: 60,
      hashCharacter: "b",
    });
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      isolatedSource,
      ACCEPTANCE_CREATED_AT,
    );
    const repository = new ProviderSourceAdminLifecycleRepository(isolated.database);
    const pauseInput = {
      organizationId: isolated.organizationId,
      providerId: isolatedSource.providerId,
      sourceInstanceId: isolatedSource.sourceInstanceId,
      expectedSourceRevisionId: isolatedSource.sourceRevisionId,
      actorKey: "operator-admin",
      requestedAt: new Date("2099-08-21T13:00:00.000Z"),
    };
    assert.equal((await repository.requestPause(pauseInput)).state, "paused");
    assert.equal((await repository.requestPause(pauseInput)).state, "paused");
    const resumeInput = {
      organizationId: isolated.organizationId,
      providerId: isolatedSource.providerId,
      sourceInstanceId: isolatedSource.sourceInstanceId,
      expectedSourceRevisionId: isolatedSource.sourceRevisionId,
      actorKey: "operator-admin",
      resumedAt: new Date("1999-08-21T13:01:00.000Z"),
    };
    await repository.resume(resumeInput);
    await repository.resume(resumeInput);
    assert.equal(await isolated.database.audit_events.count({
      where: {
        organization_id: isolated.organizationId,
        subject_id: isolatedSource.sourceInstanceId,
        action: "provider_source.pause",
      },
    }), 1);
    assert.equal(await isolated.database.audit_events.count({
      where: {
        organization_id: isolated.organizationId,
        subject_id: isolatedSource.sourceInstanceId,
        action: "provider_source.resume",
      },
    }), 1);
    const [diagnostics, runtime] = await Promise.all([
      isolated.database.source_processor_diagnostic_events.findMany({
        where: {
          organization_id: isolated.organizationId,
          source_instance_id: isolatedSource.sourceInstanceId,
          correlation_kind: "lifecycle",
          safe_code: { in: ["SOURCE_PAUSED", "SOURCE_RESUMED"] },
        },
        orderBy: [{ occurred_at: "asc" }, { id: "asc" }],
      }),
      isolated.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: isolatedSource.sourceInstanceId },
      }),
    ]);
    assert.deepEqual(
      diagnostics.map(({ phase, safe_code }) => ({ phase, safe_code })),
      [
        { phase: "pause_completed", safe_code: "SOURCE_PAUSED" },
        { phase: "resume", safe_code: "SOURCE_RESUMED" },
      ],
    );
    assert.ok(diagnostics.every(({ audit_event_id }) => audit_event_id !== null));
    assert.ok(diagnostics.every(({ occurred_at, expires_at }) =>
      expires_at.getTime() - occurred_at.getTime() === 30 * 86_400_000
    ));
    assert.notEqual(
      diagnostics[0]!.occurred_at.getTime(),
      pauseInput.requestedAt.getTime(),
    );
    assert.notEqual(
      diagnostics[1]!.occurred_at.getTime(),
      resumeInput.resumedAt.getTime(),
    );
    assert.equal(runtime.phase, "idle");
    assert.equal(runtime.activity, "inactive");
    assert.equal(runtime.retry_not_before, null);
  } finally {
    await isolated.close();
  }
});

test("pause preserves an unresolved source action-required fence and resume rejects", async () => {
  const isolated = await createProviderSourceAcceptanceFixture(
    "action-required-lifecycle",
  );
  try {
    const isolatedSource = await createAcceptanceProviderSource(isolated, {
      platformKey: "courtyard",
      displayName: "Courtyard action required",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "courtyard-v1",
      intervalSeconds: 60,
      hashCharacter: "c",
    });
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      isolatedSource,
      ACCEPTANCE_CREATED_AT,
    );
    await isolated.database.provider_source_runtime_states.update({
      where: { source_instance_id: isolatedSource.sourceInstanceId },
      data: {
        phase: "action_required",
        activity: "action_required",
        action_required_code: "MAPPER_PIN_UNAVAILABLE",
      },
    });
    const repository = new ProviderSourceAdminLifecycleRepository(
      isolated.database,
    );
    const common = {
      organizationId: isolated.organizationId,
      providerId: isolatedSource.providerId,
      sourceInstanceId: isolatedSource.sourceInstanceId,
      expectedSourceRevisionId: isolatedSource.sourceRevisionId,
      actorKey: "operator-admin",
    } as const;
    await repository.requestPause({
      ...common,
      requestedAt: new Date("2026-08-21T13:05:00.000Z"),
    });
    await assert.rejects(
      repository.resume({
        ...common,
        resumedAt: new Date("2026-08-21T13:06:00.000Z"),
      }),
      (error) => error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
    const [persistedSource, runtime] = await Promise.all([
      isolated.database.provider_source_instances.findUniqueOrThrow({
        where: { id: isolatedSource.sourceInstanceId },
      }),
      isolated.database.provider_source_runtime_states.findUniqueOrThrow({
        where: { source_instance_id: isolatedSource.sourceInstanceId },
      }),
    ]);
    assert.equal(persistedSource.state, "paused");
    assert.equal(runtime.phase, "action_required");
    assert.equal(runtime.activity, "action_required");
    assert.equal(runtime.action_required_code, "MAPPER_PIN_UNAVAILABLE");
  } finally {
    await isolated.close();
  }
});

test("manual import fails closed while the exact current source requires action", async () => {
  const isolated = await createProviderSourceAcceptanceFixture(
    "action-required-manual-run",
  );
  try {
    const isolatedSource = await createAcceptanceProviderSource(isolated, {
      platformKey: "courtyard",
      displayName: "Courtyard action-required manual run",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "courtyard-v1",
      intervalSeconds: 60,
      hashCharacter: "d",
    });
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      isolatedSource,
      ACCEPTANCE_CREATED_AT,
    );
    await isolated.database.provider_source_runtime_states.update({
      where: { source_instance_id: isolatedSource.sourceInstanceId },
      data: {
        phase: "action_required",
        activity: "action_required",
        action_required_code: "MAPPER_PIN_UNAVAILABLE",
      },
    });

    const result = await new ProviderSourceImportRunRepository(
      isolated.database,
    ).requestRun({
      organizationId: isolated.organizationId,
      providerId: isolatedSource.providerId,
      runId: randomUUID(),
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: new Date("2026-08-21T13:07:00.000Z"),
      expectedSourceRevisionId: isolatedSource.sourceRevisionId,
    });

    assert.deepEqual(result, { kind: "source_unavailable" });
    assert.equal(
      await isolated.database.import_runs.count({
        where: { source_instance_id: isolatedSource.sourceInstanceId },
      }),
      0,
    );
    const runtime = await isolated.database.provider_source_runtime_states
      .findUniqueOrThrow({
        where: { source_instance_id: isolatedSource.sourceInstanceId },
      });
    assert.equal(runtime.activity, "action_required");
    assert.equal(runtime.action_required_code, "MAPPER_PIN_UNAVAILABLE");
  } finally {
    await isolated.close();
  }
});

test("a disabled source requires a fresh exact test and reactivates paused from its preserved checkpoint", async () => {
  const isolated = await createProviderSourceAcceptanceFixture("disabled-reactivation");
  try {
    const disabledSource = await createAcceptanceProviderSource(isolated, {
      platformKey: "courtyard",
      displayName: "Courtyard disabled reactivation",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "courtyard-v1",
      intervalSeconds: 60,
      hashCharacter: "f",
    });
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      disabledSource,
      ACCEPTANCE_CREATED_AT,
    );
    const [{ now }] = await isolated.database.$queryRaw<Array<{ now: Date }>>`
      select clock_timestamp() as "now"
    `;
    const checkpointBytes = new TextEncoder().encode("saved-cursor");
    const checkpointFingerprint = "9".repeat(64);
    await isolated.database.provider_source_checkpoints.update({
      where: { source_instance_id: disabledSource.sourceInstanceId },
      data: {
        checkpoint_bytes: checkpointBytes,
        checkpoint_fingerprint: checkpointFingerprint,
        updated_at: now,
      },
    });
    const admin = new ProviderSourceAdminLifecycleRepository(isolated.database);
    await admin.disable({
      organizationId: isolated.organizationId,
      providerId: disabledSource.providerId,
      sourceInstanceId: disabledSource.sourceInstanceId,
      expectedSourceRevisionId: disabledSource.sourceRevisionId,
      actorKey: "operator-admin",
      disabledAt: now,
    });
    const connections = new SourceConnectionAdminRepository(isolated.database);
    const connectionJob = await connections.requestConnectionTest({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(now.getTime() + 1),
    });
    const job = await admin.requestSourceTest({
      organizationId: isolated.organizationId,
      providerId: disabledSource.providerId,
      sourceInstanceId: disabledSource.sourceInstanceId,
      sourceRevisionId: disabledSource.sourceRevisionId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(now.getTime() + 2),
    });
    const supervisorOwner = "disabled-reactivation-worker";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      isolated.database,
    ).acquire({
      environmentKey: "disabled-reactivation",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const requests = new ProviderSourceRequestRepository(isolated.database);
    const testResults = new ProviderSourceTestResultRepository(isolated.database);
    let connectionTestSequence = 0;
    const completeConnectionTest = async (
      jobId: string,
      outcome: "success" | "failure",
      startedOffset: number,
    ): Promise<void> => {
      connectionTestSequence += 1;
      const sequence = connectionTestSequence;
      const connectionClaimToken = randomUUID();
      await isolated.database.source_connection_test_jobs.update({
        where: { id: jobId },
        data: {
          state: "running",
          claim_owner: supervisorOwner,
          claim_token: connectionClaimToken,
          claim_expires_at: epoch.leaseExpiresAt,
          supervisor_epoch_id: epoch.epochId,
          started_at: new Date(now.getTime() + startedOffset),
        },
      });
      const connectionAttemptId = await requests.begin({
        organizationId: isolated.organizationId,
        requestLeaseId: randomUUID(),
        claimOwner: supervisorOwner,
        claimToken: connectionClaimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: supervisorOwner,
        supervisorLeaseToken,
        connectionProfileId: isolated.connectionProfileId,
        connectionRevisionId: isolated.connectionRevisionId,
        expectedHealthGeneration: 0n,
        operation: { kind: "connection_test", connectionTestJobId: jobId },
        startedAt: new Date(now.getTime() + startedOffset + 1),
      });
      await requests.terminalize({
        organizationId: isolated.organizationId,
        requestAttemptId: connectionAttemptId,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: supervisorOwner,
        supervisorLeaseToken,
        state: "captured",
        outcomeClass: "response_captured",
        safeCode: "request_captured",
        safeOutcomeHash: sequence.toString(16).repeat(64),
        terminalAt: new Date(now.getTime() + startedOffset + 2),
      });
      await testResults.completeConnectionTest({
        organizationId: isolated.organizationId,
        jobId,
        requestAttemptId: connectionAttemptId,
        claimOwner: supervisorOwner,
        claimToken: connectionClaimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: supervisorOwner,
        supervisorLeaseToken,
        outcome,
        safeCode: outcome === "success" ? "connection_valid" : "connection_invalid",
        completedAt: new Date(now.getTime() + startedOffset + 3),
      });
    };
    await completeConnectionTest(connectionJob.jobId, "success", 3);
    const claimToken = randomUUID();
    await isolated.database.provider_source_test_jobs.update({
      where: { id: job.jobId },
      data: {
        state: "running",
        claim_owner: supervisorOwner,
        claim_token: claimToken,
        claim_expires_at: epoch.leaseExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: new Date(now.getTime() + 34),
      },
    });
    const attemptId = await requests.begin({
      organizationId: isolated.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: supervisorOwner,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "source_test",
        providerId: disabledSource.providerId,
        sourceInstanceId: disabledSource.sourceInstanceId,
        sourceRevisionId: disabledSource.sourceRevisionId,
        sourceTestJobId: job.jobId,
      },
      startedAt: new Date(now.getTime() + 35),
    });
    await requests.terminalize({
      organizationId: isolated.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "8".repeat(64),
      terminalAt: new Date(now.getTime() + 36),
    });
    await testResults.completeSourceTest({
      organizationId: isolated.organizationId,
      jobId: job.jobId,
      requestAttemptId: attemptId,
      claimOwner: supervisorOwner,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "source_valid",
      completedAt: new Date(now.getTime() + 37),
    });
    const activate = (activatedAt: Date) => isolated.lifecycle.activateSourcePausedExact({
      organizationId: isolated.organizationId,
      providerId: disabledSource.providerId,
      providerKey: "courtyard",
      sourceInstanceId: disabledSource.sourceInstanceId,
      sourceRevisionId: disabledSource.sourceRevisionId,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      mapperKey: disabledSource.mapperKey,
      mapperVersion: "1",
      identityNamespaceKey: disabledSource.identityNamespaceKey,
      checkpointCodecVersion: ACCEPTANCE_CHECKPOINT_CODEC_VERSION,
      sourceConfiguration: { provider: "courtyard" },
      sourceConfigurationHash: "f".repeat(64),
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
      connectionProfileId: isolated.connectionProfileId,
      connectionTypeKey: "dataforrest-events-connection-v1",
      connectionRequestLimit: 2,
      connectionRevisionId: isolated.connectionRevisionId,
      connectionConfigurationFingerprint: "a".repeat(64),
      checkpointGeneration: 1n,
      actorKey: "operator-admin",
      activatedAt,
    });
    const pendingConnectionJob = await connections.requestConnectionTest({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(now.getTime() + 38),
    });
    await assert.rejects(
      activate(new Date(now.getTime() + 39)),
      (error) => error instanceof PersistenceError &&
        error.code === "CONFIG_REVISION_UNTESTED",
      "a newer pending connection test invalidates the historical success",
    );
    await completeConnectionTest(pendingConnectionJob.jobId, "failure", 40);
    await assert.rejects(
      activate(new Date(now.getTime() + 50)),
      (error) => error instanceof PersistenceError &&
        error.code === "CONFIG_REVISION_UNTESTED",
      "a latest failed connection test blocks source activation",
    );
    const currentConnectionJob = await connections.requestConnectionTest({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date(now.getTime() + 51),
    });
    await completeConnectionTest(currentConnectionJob.jobId, "success", 52);
    await activate(new Date(now.getTime() + 70));
    const [reactivated, checkpoint] = await Promise.all([
      isolated.database.provider_source_instances.findUniqueOrThrow({
        where: { id: disabledSource.sourceInstanceId },
      }),
      isolated.database.provider_source_checkpoints.findUniqueOrThrow({
        where: { source_instance_id: disabledSource.sourceInstanceId },
      }),
    ]);
    assert.equal(reactivated.state, "paused");
    assert.equal(reactivated.disabled_at, null);
    assert.deepEqual(new Uint8Array(checkpoint.checkpoint_bytes!), checkpointBytes);
    assert.equal(checkpoint.checkpoint_fingerprint, checkpointFingerprint);
    assert.equal(checkpoint.checkpoint_generation, 1n);
  } finally {
    await isolated.close();
  }
});

test("disable cannot make checkpoint reset overlook an in-flight request lease", async () => {
  const isolated = await createProviderSourceAcceptanceFixture("reset-lease");
  try {
    const isolatedSource = await createAcceptanceProviderSource(isolated, {
      platformKey: "courtyard",
      displayName: "Courtyard reset",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "courtyard-v1",
      intervalSeconds: 60,
      hashCharacter: "c",
    });
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      isolatedSource,
      ACCEPTANCE_CREATED_AT,
    );
    const leaseToken = randomUUID();
    const run = await createPinnedSourceRun(
      isolated.database,
      isolated,
      isolatedSource,
      {
        state: "running",
        createdAt: ACCEPTANCE_CREATED_AT,
        requestedCheckpoint: null,
        requestedCheckpointFingerprint: null,
        leaseOwner: "worker-one",
        leaseToken,
        leaseExpiresAt: new Date("2026-08-21T14:00:00.000Z"),
      },
    );
    const epoch = await isolated.database.source_supervisor_epochs.create({
      data: {
        environment_key: "test-reset-lease",
        epoch_number: 1n,
        owner_key: "worker-one",
        lease_token: randomUUID(),
        acquired_at: ACCEPTANCE_CREATED_AT,
        last_renewed_at: ACCEPTANCE_CREATED_AT,
        lease_expires_at: new Date("2026-08-21T13:00:00.000Z"),
        takeover_not_before: new Date("2026-08-21T13:00:15.000Z"),
      },
    });
    await isolated.database.source_request_attempts.create({
      data: {
        organization_id: isolated.organizationId,
        operation_kind: "page_read",
        request_lease_id: randomUUID(),
        claim_owner: "worker-one",
        claim_token: leaseToken,
        supervisor_epoch_id: epoch.id,
        connection_profile_id: isolated.connectionProfileId,
        connection_revision_id: isolated.connectionRevisionId,
        expected_health_generation: 0n,
        provider_id: isolatedSource.providerId,
        source_instance_id: isolatedSource.sourceInstanceId,
        source_revision_id: isolatedSource.sourceRevisionId,
        run_id: run.id,
        page_number: 1,
        checkpoint_generation: 1n,
        requested_checkpoint_fingerprint: null,
        requested_checkpoint_key: "initial",
        started_at: ACCEPTANCE_CREATED_AT,
      },
    });
    const lifecycle = new ProviderSourceAdminLifecycleRepository(isolated.database);
    await lifecycle.disable({
      organizationId: isolated.organizationId,
      providerId: isolatedSource.providerId,
      sourceInstanceId: isolatedSource.sourceInstanceId,
      expectedSourceRevisionId: isolatedSource.sourceRevisionId,
      actorKey: "operator-admin",
      disabledAt: new Date("2026-08-21T12:30:00.000Z"),
    });
    const checkpoints = new ProviderSourceCheckpointRepository(isolated.database);
    await assert.rejects(
      checkpoints.reset({
        organizationId: isolated.organizationId,
        providerId: isolatedSource.providerId,
        sourceInstanceId: isolatedSource.sourceInstanceId,
        expectedSourceRevisionId: isolatedSource.sourceRevisionId,
        expectedGeneration: 1n,
        expectedFingerprint: null,
        actorKey: "operator-admin",
        resetAt: new Date("2026-08-21T12:31:00.000Z"),
      }),
      (error) => error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
  } finally {
    await isolated.close();
  }
});

test("normal credential rotation preserves old-revision queued, running, historical, and checkpoint pins", async () => {
  const isolated = await createProviderSourceAcceptanceFixture("normal-rotation");
  try {
    const runningSource = await createAcceptanceProviderSource(isolated, {
      platformKey: "courtyard",
      displayName: "Courtyard rotation",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "courtyard-v1",
      intervalSeconds: 60,
      hashCharacter: "d",
    });
    const queuedSource = await createAcceptanceProviderSource(isolated, {
      platformKey: "phygitals",
      displayName: "Phygitals rotation",
      mapperKey: "phygitals-provider-observation",
      identityNamespaceKey: "phygitals-v1",
      intervalSeconds: 60,
      hashCharacter: "e",
    });
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      runningSource,
      ACCEPTANCE_CREATED_AT,
    );
    await activateAcceptanceRuntime(
      isolated.database,
      isolated,
      queuedSource,
      ACCEPTANCE_CREATED_AT,
    );
    const supervisorOwner = "normal-rotation-worker";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      isolated.database,
    ).acquire({
      environmentKey: "normal-rotation",
      ownerKey: supervisorOwner,
      leaseToken: supervisorLeaseToken,
      now: ACCEPTANCE_CREATED_AT,
    });
    const runningClaimToken = randomUUID();
    const running = await createPinnedSourceRun(
      isolated.database,
      isolated,
      runningSource,
      {
        state: "running",
        createdAt: ACCEPTANCE_CREATED_AT,
        requestedCheckpoint: null,
        requestedCheckpointFingerprint: null,
        leaseOwner: supervisorOwner,
        leaseToken: runningClaimToken,
        leaseExpiresAt: epoch.leaseExpiresAt,
      },
    );
    const historical = await createPinnedSourceRun(
      isolated.database,
      isolated,
      runningSource,
      {
        state: "succeeded",
        createdAt: new Date("2026-08-20T12:00:01.000Z"),
        requestedCheckpoint: null,
        requestedCheckpointFingerprint: null,
      },
    );
    const queued = await isolated.database.import_runs.create({
      data: {
        organization_id: isolated.organizationId,
        provider_id: queuedSource.providerId,
        config_revision_id: null,
        trigger: "scheduled",
        state: "queued",
        created_at: ACCEPTANCE_CREATED_AT,
        source_instance_id: queuedSource.sourceInstanceId,
        source_revision_id: queuedSource.sourceRevisionId,
        source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
        source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        mapper_key: queuedSource.mapperKey,
        mapper_version: "1",
        identity_namespace_key: queuedSource.identityNamespaceKey,
        connection_profile_id: isolated.connectionProfileId,
        connection_revision_id: isolated.connectionRevisionId,
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

    const connections = new SourceConnectionAdminRepository(isolated.database);
    const candidateRevisionId = randomUUID();
    await connections.addConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      expectedRevisionId: isolated.connectionRevisionId,
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
      configurationFingerprint: "f".repeat(64),
      actorKey: "operator-admin",
      createdAt: new Date("2026-08-20T12:00:02.000Z"),
    });
    const testJob = await connections.requestConnectionTest({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date("2026-08-20T12:00:03.000Z"),
    });
    const testClaimToken = randomUUID();
    await isolated.database.source_connection_test_jobs.update({
      where: { id: testJob.jobId },
      data: {
        state: "running",
        claim_owner: supervisorOwner,
        claim_token: testClaimToken,
        claim_expires_at: epoch.leaseExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: new Date("2026-08-20T12:00:04.000Z"),
      },
    });
    const requests = new ProviderSourceRequestRepository(isolated.database);
    const testAttemptId = await requests.begin({
      organizationId: isolated.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: supervisorOwner,
      claimToken: testClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: testJob.jobId },
      startedAt: new Date("2026-08-20T12:00:05.000Z"),
    });
    await requests.terminalize({
      organizationId: isolated.organizationId,
      requestAttemptId: testAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "1".repeat(64),
      terminalAt: new Date("2026-08-20T12:00:06.000Z"),
    });
    await new ProviderSourceTestResultRepository(
      isolated.database,
    ).completeConnectionTest({
      organizationId: isolated.organizationId,
      jobId: testJob.jobId,
      requestAttemptId: testAttemptId,
      claimOwner: supervisorOwner,
      claimToken: testClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_valid",
      completedAt: new Date("2026-08-20T12:00:07.000Z"),
    });
    const currentTestJob = await connections.requestConnectionTest({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: new Date("2026-08-20T12:00:07.100Z"),
    });
    await assert.rejects(
      connections.activateTestedConnectionRevision({
        organizationId: isolated.organizationId,
        connectionProfileId: isolated.connectionProfileId,
        connectionRevisionId: candidateRevisionId,
        expectedHealthGeneration: 0n,
        preservePinnedWork: true,
        actorKey: "operator-admin",
        activatedAt: new Date("2026-08-20T12:00:07.200Z"),
      }),
      (error) => error instanceof PersistenceError &&
        error.code === "CONFIG_REVISION_UNTESTED",
      "a newer pending job must invalidate the historical success at the same generation",
    );
    const currentTestClaimToken = randomUUID();
    await isolated.database.source_connection_test_jobs.update({
      where: { id: currentTestJob.jobId },
      data: {
        state: "running",
        claim_owner: supervisorOwner,
        claim_token: currentTestClaimToken,
        claim_expires_at: epoch.leaseExpiresAt,
        supervisor_epoch_id: epoch.epochId,
        started_at: new Date("2026-08-20T12:00:07.300Z"),
      },
    });
    const currentTestAttemptId = await requests.begin({
      organizationId: isolated.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: supervisorOwner,
      claimToken: currentTestClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: currentTestJob.jobId,
      },
      startedAt: new Date("2026-08-20T12:00:07.400Z"),
    });
    await requests.terminalize({
      organizationId: isolated.organizationId,
      requestAttemptId: currentTestAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "3".repeat(64),
      terminalAt: new Date("2026-08-20T12:00:07.500Z"),
    });
    await new ProviderSourceTestResultRepository(
      isolated.database,
    ).completeConnectionTest({
      organizationId: isolated.organizationId,
      jobId: currentTestJob.jobId,
      requestAttemptId: currentTestAttemptId,
      claimOwner: supervisorOwner,
      claimToken: currentTestClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_valid",
      completedAt: new Date("2026-08-20T12:00:07.600Z"),
    });
    await connections.activateTestedConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      preservePinnedWork: true,
      actorKey: "operator-admin",
      activatedAt: new Date("2026-08-20T12:00:08.000Z"),
    });

    const [profile, oldRevision, activeRuns, checkpoints] = await Promise.all([
      isolated.database.source_connection_profiles.findUniqueOrThrow({
        where: { id: isolated.connectionProfileId },
      }),
      isolated.database.source_connection_revisions.findUniqueOrThrow({
        where: { id: isolated.connectionRevisionId },
      }),
      isolated.database.import_runs.findMany({
        where: { id: { in: [running.id, queued.id, historical.id] } },
        orderBy: { id: "asc" },
      }),
      isolated.database.provider_source_checkpoints.findMany({
        where: {
          source_instance_id: {
            in: [runningSource.sourceInstanceId, queuedSource.sourceInstanceId],
          },
        },
      }),
    ]);
    assert.equal(profile.active_revision_id, candidateRevisionId);
    assert.equal(oldRevision.state, "retired");
    assert.deepEqual(activeRuns.map((run) => run.state).sort(), [
      "queued",
      "running",
      "succeeded",
    ]);
    assert.ok(activeRuns.every((run) =>
      run.connection_revision_id === isolated.connectionRevisionId
    ));
    assert.ok(checkpoints.every((checkpoint) =>
      checkpoint.checkpoint_generation === 1n &&
      checkpoint.checkpoint_fingerprint === null
    ));

    const oldAttemptId = await requests.begin({
      organizationId: isolated.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: supervisorOwner,
      claimToken: runningClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "page_read",
        providerId: runningSource.providerId,
        sourceInstanceId: runningSource.sourceInstanceId,
        sourceRevisionId: runningSource.sourceRevisionId,
        runId: running.id,
        pageNumber: 1,
        checkpointGeneration: 1n,
        requestedCheckpointFingerprint: null,
      },
      startedAt: new Date("2026-08-20T12:00:09.000Z"),
    });
    await requests.terminalize({
      organizationId: isolated.organizationId,
      requestAttemptId: oldAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "2".repeat(64),
      terminalAt: new Date("2026-08-20T12:00:10.000Z"),
    });

    await isolated.database.import_runs.update({
      where: { id: queued.id },
      data: {
        state: "succeeded",
        finished_at: new Date("2026-08-20T12:00:11.000Z"),
      },
    });
    const candidateClaimToken = randomUUID();
    const candidateRun = await isolated.database.import_runs.create({
      data: {
        organization_id: isolated.organizationId,
        provider_id: queuedSource.providerId,
        config_revision_id: null,
        trigger: "scheduled",
        state: "running",
        started_at: new Date("2026-08-20T12:00:12.000Z"),
        created_at: new Date("2026-08-20T12:00:12.000Z"),
        lease_owner: supervisorOwner,
        lease_token: candidateClaimToken,
        lease_expires_at: epoch.leaseExpiresAt,
        source_instance_id: queuedSource.sourceInstanceId,
        source_revision_id: queuedSource.sourceRevisionId,
        source_type_key: ACCEPTANCE_SOURCE_TYPE_KEY,
        source_adapter_version: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalized_contract_version: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
        mapper_key: queuedSource.mapperKey,
        mapper_version: "1",
        identity_namespace_key: queuedSource.identityNamespaceKey,
        connection_profile_id: isolated.connectionProfileId,
        connection_revision_id: candidateRevisionId,
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
    await connections.revokeConnectionRevision({
      organizationId: isolated.organizationId,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: candidateRevisionId,
      expectedHealthGeneration: 0n,
      actorKey: "operator-admin",
      revokedAt: new Date("2026-08-20T12:00:13.000Z"),
    });
    const [disabledProfile, preservedOldRun, fencedCandidateRun] =
      await Promise.all([
        isolated.database.source_connection_profiles.findUniqueOrThrow({
          where: { id: isolated.connectionProfileId },
        }),
        isolated.database.import_runs.findUniqueOrThrow({
          where: { id: running.id },
        }),
        isolated.database.import_runs.findUniqueOrThrow({
          where: { id: candidateRun.id },
        }),
      ]);
    assert.equal(disabledProfile.state, "disabled");
    assert.equal(preservedOldRun.state, "running");
    assert.equal(fencedCandidateRun.state, "failed");
    assert.equal(fencedCandidateRun.failure_code, "CONNECTION_REVISION_REVOKED");

    await requests.begin({
      organizationId: isolated.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: supervisorOwner,
      claimToken: runningClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: supervisorOwner,
      supervisorLeaseToken,
      connectionProfileId: isolated.connectionProfileId,
      connectionRevisionId: isolated.connectionRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "page_read",
        providerId: runningSource.providerId,
        sourceInstanceId: runningSource.sourceInstanceId,
        sourceRevisionId: runningSource.sourceRevisionId,
        runId: running.id,
        pageNumber: 1,
        checkpointGeneration: 1n,
        requestedCheckpointFingerprint: null,
      },
      startedAt: new Date("2026-08-20T12:00:14.000Z"),
    });
    await assert.rejects(
      requests.begin({
        organizationId: isolated.organizationId,
        requestLeaseId: randomUUID(),
        claimOwner: supervisorOwner,
        claimToken: candidateClaimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: supervisorOwner,
        supervisorLeaseToken,
        connectionProfileId: isolated.connectionProfileId,
        connectionRevisionId: candidateRevisionId,
        expectedHealthGeneration: 0n,
        operation: {
          kind: "page_read",
          providerId: queuedSource.providerId,
          sourceInstanceId: queuedSource.sourceInstanceId,
          sourceRevisionId: queuedSource.sourceRevisionId,
          runId: candidateRun.id,
          pageNumber: 1,
          checkpointGeneration: 1n,
          requestedCheckpointFingerprint: null,
        },
        startedAt: new Date("2026-08-20T12:00:14.000Z"),
      }),
      (error) => error instanceof PersistenceError &&
        ["HEALTH_GENERATION_STALE", "SOURCE_FENCED"].includes(error.code),
    );
    assert.equal(await isolated.database.provider_source_checkpoints.count({
      where: {
        source_instance_id: {
          in: [runningSource.sourceInstanceId, queuedSource.sourceInstanceId],
        },
        checkpoint_generation: 1n,
        checkpoint_fingerprint: null,
      },
    }), 2);
  } finally {
    await isolated.close();
  }
});
