import assert from "node:assert/strict";
import { test } from "node:test";
import { providerIdentityNamespaceByLaunchProvider } from "@packscout/contracts";
import { PrismaAdminImportRunRepository } from "./admin-import-run-repository.ts";
import type { PackscoutPrismaClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { ProviderSourceCursorRepository } from "./provider-source-cursor-repository.ts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import { ProviderSourceLifecycleRepository } from "./provider-source-lifecycle-repository.ts";
import { ProviderSourceRequestRepository } from "./provider-source-request-repository.ts";
import { ProviderSourceRetentionRepository } from "./provider-source-retention-repository.ts";
import { ProviderSourceSupervisorRepository } from "./provider-source-supervisor-repository.ts";
import { ProviderSourceTestResultRepository } from "./provider-source-test-result-repository.ts";
import {
  createAcceptanceProviderSource,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const base = new Date("2026-08-20T12:00:00.000Z");
const sourceTypeKey = "dataforrest-events-v1";
const sourceAdapterVersion = "dataforrest-events-adapter-v1";
const normalizedContractVersion = "packscout.provider-observation.v1";
const cursorCodecVersion = "dataforrest-cursor-v1";

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

async function sourceFixture() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  const organizationId = await setup.createOrganization({
    slug: "source-persistence",
    name: "Source persistence",
    createdAt: base,
  });
  const providerId = await setup.createProviderSource({
    organizationId,
    platformKey: "courtyard",
    displayName: "Courtyard",
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
    cursorCodecVersion,
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
    createdAt: base,
  });
  return {
    ...harness,
    lifecycle,
    organizationId,
    providerId,
    ...connection,
    ...source,
  };
}

test("four provider sources share one profile while schedules, cursors, and health stay isolated", async () => {
  const fixture = await sourceFixture();
  try {
    const setup = new PipelineSetupRepository(fixture.database);
    const definitions = [
      {
        platformKey: "collector_crypt",
        displayName: "Collector Crypt",
        mapperKey: "collector-crypt-provider-observation",
        namespaceKey: providerIdentityNamespaceByLaunchProvider.collector_crypt,
        intervalSeconds: 120,
        hashCharacter: "c",
      },
      {
        platformKey: "phygitals",
        displayName: "Phygitals",
        mapperKey: "phygitals-provider-observation",
        namespaceKey: "dataforrest-phygitals-records-v1",
        intervalSeconds: 180,
        hashCharacter: "d",
      },
      {
        platformKey: "clutchpacks",
        displayName: "ClutchPacks",
        mapperKey: "clutchpacks-provider-observation",
        namespaceKey: "dataforrest-clutchpacks-records-v1",
        intervalSeconds: 240,
        hashCharacter: "e",
      },
    ] as const;

    for (const definition of definitions) {
      const providerId = await setup.createProviderSource({
        organizationId: fixture.organizationId,
        platformKey: definition.platformKey,
        displayName: definition.displayName,
        createdAt: base,
      });
      await fixture.lifecycle.createSourceInstanceRevision({
        organizationId: fixture.organizationId,
        providerId,
        connectionProfileId: fixture.profileId,
        sourceTypeKey,
        sourceAdapterVersion,
        normalizedContractVersion,
        mapperKey: definition.mapperKey,
        mapperVersion: "1",
        identityNamespaceKey: definition.namespaceKey,
        cursorCodecVersion,
        revisionNumber: 1,
        intervalSeconds: definition.intervalSeconds,
        configuration: { provider: definition.platformKey },
        configurationHash: definition.hashCharacter.repeat(64),
        recordIdScopes: [
          "catalog-pack-v1",
          "catalog-card-v1",
          "pull-v1",
          "trade-v1",
        ],
        actorKey: "operator-admin",
        createdAt: base,
      });
    }

    const sources = await fixture.database.provider_source_instances.findMany({
      where: {
        organization_id: fixture.organizationId,
        connection_profile_id: fixture.profileId,
      },
      orderBy: { created_at: "asc" },
    });
    assert.equal(sources.length, 4);
    assert.equal(new Set(sources.map((source) => source.provider_id)).size, 4);
    assert.equal(new Set(sources.map((source) => source.id)).size, 4);

    const sourceIds = sources.map((source) => source.id);
    const [schedules, cursors, healthStates] = await Promise.all([
      fixture.database.provider_source_schedules.findMany({
        where: { source_instance_id: { in: sourceIds } },
        orderBy: { source_instance_id: "asc" },
      }),
      fixture.database.provider_source_cursors.findMany({
        where: { source_instance_id: { in: sourceIds } },
        orderBy: { source_instance_id: "asc" },
      }),
      fixture.database.provider_source_health_states.findMany({
        where: { source_instance_id: { in: sourceIds } },
        orderBy: { source_instance_id: "asc" },
      }),
    ]);
    assert.equal(schedules.length, 4);
    assert.equal(cursors.length, 4);
    assert.equal(healthStates.length, 4);
    assert.deepEqual(
      cursors.map((cursor) => ({
        source: cursor.source_instance_id,
        generation: cursor.cursor_generation,
        fingerprint: cursor.cursor_fingerprint,
      })),
      sourceIds.toSorted().map((source) => ({
        source,
        generation: 1n,
        fingerprint: null,
      })),
    );

    const isolatedSourceId = sources[0]!.id;
    const isolatedDueAt = new Date(base.getTime() + 86_400_000);
    await fixture.database.$transaction([
      fixture.database.provider_source_schedules.update({
        where: { source_instance_id: isolatedSourceId },
        data: { next_due_at: isolatedDueAt, last_outcome: "retryable_failure" },
      }),
      fixture.database.provider_source_health_states.update({
        where: { source_instance_id: isolatedSourceId },
        data: {
          consecutive_failures: 1,
          latest_failure_code: "source_fixture_failure",
        },
      }),
    ]);
    assert.equal(
      await fixture.database.provider_source_schedules.count({
        where: {
          source_instance_id: {
            in: sourceIds.filter((id) => id !== isolatedSourceId),
          },
          next_due_at: base,
          last_outcome: null,
        },
      }),
      3,
    );
    assert.equal(
      await fixture.database.provider_source_health_states.count({
        where: {
          source_instance_id: {
            in: sourceIds.filter((id) => id !== isolatedSourceId),
          },
          consecutive_failures: 0,
          latest_failure_code: null,
        },
      }),
      3,
    );

    await fixture.database.provider_source_instances.update({
      where: { id: fixture.sourceInstanceId },
      data: { state: "paused", activated_at: base, paused_at: base },
    });
    const replacement = await fixture.lifecycle.createSourceInstanceRevision({
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      connectionProfileId: fixture.profileId,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      mapperKey: "courtyard-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      cursorCodecVersion,
      revisionNumber: 1,
      intervalSeconds: 60,
      configuration: { provider: "courtyard", replacement: true },
      configurationHash: "9".repeat(64),
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
      actorKey: "operator-admin",
      createdAt: new Date(base.getTime() + 1_000),
    });
    await assert.rejects(
      fixture.database.provider_source_instances.update({
        where: { id: replacement.sourceInstanceId },
        data: {
          state: "paused",
          activated_at: new Date(base.getTime() + 1_000),
          paused_at: new Date(base.getTime() + 1_000),
        },
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("source cursors retain durable cycle history and reject unowned advancement", async () => {
  const fixture = await sourceFixture();
  try {
    const cursors = new ProviderSourceCursorRepository(
      fixture.database,
    );
    const cycleIndex = await fixture.database.$queryRaw<
      Array<{ indexdef: string }>
    >`
      select indexdef
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'provider_source_cursor_fingerprints_cycle_unique'
    `;
    assert.match(
      cycleIndex[0]?.indexdef ?? "",
      /UNIQUE.*source_instance_id.*cursor_generation.*cursor_fingerprint/u,
    );

    await assert.rejects(
      fixture.database.$transaction((transaction) =>
        cursors.advanceInTransaction(transaction, {
          organizationId: fixture.organizationId,
          providerId: fixture.providerId,
          sourceInstanceId: fixture.sourceInstanceId,
          sourceRevisionId: fixture.sourceRevisionId,
          sourceAdapterVersion,
          cursorCodecVersion,
          cursorGeneration: 1n,
          expectedCursorFingerprint: null,
          nextCursor: "cursor-b",
          nextCursorFingerprint: "2".repeat(64),
          continuation: { kind: "continue" },
          runId: "00000000-0000-4000-8000-000000000131",
          pageId: "00000000-0000-4000-8000-000000000132",
          pageNumber: 1,
          requestAttemptId: "00000000-0000-4000-8000-000000000133",
          connectionProfileId: fixture.profileId,
          connectionRevisionId: fixture.revisionId,
          expectedHealthGeneration: 0n,
          supervisorEpochId: "00000000-0000-4000-8000-000000000134",
          supervisorOwnerKey: "worker-a",
          supervisorLeaseToken: "00000000-0000-4000-8000-000000000135",
          runLeaseOwner: "worker-a",
          runLeaseToken: "00000000-0000-4000-8000-000000000136",
          committedAt: new Date(base.getTime() + 2_000),
        }),
      ),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "SUPERVISOR_OWNERSHIP_LOST" &&
        error.message === "Cursor commit epoch is no longer active.",
    );

    const supervisors = new ProviderSourceSupervisorRepository(
      fixture.database,
    );
    const firstOwner = await supervisors.acquire({
      environmentKey: "local-source-import",
      ownerKey: "worker-a",
      leaseToken: "00000000-0000-4000-8000-000000000101",
      now: base,
    });
    await assert.rejects(
      supervisors.acquire({
        environmentKey: "local-source-import",
        ownerKey: "worker-b",
        leaseToken: "00000000-0000-4000-8000-000000000102",
        now: new Date(firstOwner.leaseExpiresAt.getTime() + 14_000),
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "SUPERVISOR_OWNERSHIP_LOST",
    );
    const databaseNow = await databaseClock(fixture.database);
    await fixture.database.source_supervisor_epochs.update({
      where: { id: firstOwner.epochId },
      data: {
        acquired_at: new Date(databaseNow.getTime() - 60_000),
        last_renewed_at: new Date(databaseNow.getTime() - 60_000),
        lease_expires_at: new Date(databaseNow.getTime() - 30_000),
        takeover_not_before: new Date(databaseNow.getTime() - 15_000),
      },
    });
    const takeover = await supervisors.acquire({
      environmentKey: "local-source-import",
      ownerKey: "worker-b",
      leaseToken: "00000000-0000-4000-8000-000000000102",
      now: new Date(0),
    });
    assert.equal(takeover.epochNumber, firstOwner.epochNumber + 1n);
  } finally {
    await fixture.close();
  }
});

test("terminal request proof compacts permanently and diagnostic feeds expire safely", async () => {
  const fixture = await sourceFixture();
  try {
    const supervisors = new ProviderSourceSupervisorRepository(
      fixture.database,
    );
    const ownerKey = "worker-a";
    const leaseToken = "00000000-0000-4000-8000-000000000111";
    const epoch = await supervisors.acquire({
      environmentKey: "local-source-import",
      ownerKey,
      leaseToken,
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
        claim_token: "00000000-0000-4000-8000-000000000112",
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: epoch.epochId,
        started_at: base,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const attemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000113",
      claimOwner: ownerKey,
      claimToken: "00000000-0000-4000-8000-000000000112",
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: job.id },
      startedAt: new Date(base.getTime() + 1_000),
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: attemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken: leaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "c".repeat(64),
      responseStatus: 200,
      responseBytes: 512,
      durationMs: 25,
      terminalAt: new Date(base.getTime() + 2_000),
    });
    const retentionNow = await databaseClock(fixture.database);
    const terminalPast = new Date(retentionNow.getTime() - 31 * 86_400_000);
    const startedPast = new Date(terminalPast.getTime() - 1_000);
    const expiresPast = new Date(terminalPast.getTime() + 30 * 86_400_000);
    await fixture.database.$transaction(async (transaction) => {
      // Age immutable evidence only inside this disposable fixture; the new
      // direct-DB lifecycle suite proves production callers cannot do this.
      await transaction.$executeRaw`
        alter table public.source_request_attempts
        disable trigger source_request_attempts_lifecycle_guard
      `;
      await transaction.source_request_attempts.update({
        where: { id: attemptId },
        data: {
          started_at: startedPast,
          terminal_at: terminalPast,
          expires_at: expiresPast,
        },
      });
      await transaction.$executeRaw`
        alter table public.source_request_attempts
        enable trigger source_request_attempts_lifecycle_guard
      `;
      await transaction.$executeRaw`
        alter table public.compact_source_request_attempts
        disable trigger compact_source_request_attempts_immutable_guard
      `;
      await transaction.compact_source_request_attempts.update({
        where: { request_attempt_id: attemptId },
        data: { started_at: startedPast, terminal_at: terminalPast },
      });
      await transaction.$executeRaw`
        alter table public.compact_source_request_attempts
        enable trigger compact_source_request_attempts_immutable_guard
      `;
    });
    const retention = new ProviderSourceRetentionRepository(fixture.database);
    const retained = await retention.runBatch({
      organizationId: fixture.organizationId,
      batchSize: 10,
      now: new Date(base.getTime() + 31 * 86_400_000),
    });
    assert.equal(retained.attemptsCompacted, 1);
    assert.equal(retained.attemptsDeleted, 1);
    assert.equal(
      await fixture.database.source_request_attempts.count({
        where: { id: attemptId },
      }),
      0,
    );
    const compact =
      await fixture.database.compact_source_request_attempts.findUniqueOrThrow({
        where: { request_attempt_id: attemptId },
      });
    assert.equal(compact.outcome_class, "response_captured");
    assert.equal(compact.claim_token, "00000000-0000-4000-8000-000000000112");
    await assert.rejects(
      fixture.database.compact_source_request_attempts.update({
        where: { request_attempt_id: attemptId },
        data: { safe_outcome_hash: "f".repeat(64) },
      }),
    );

    const audit = await fixture.database.audit_events.create({
      data: {
        organization_id: fixture.organizationId,
        actor_key: "operator-admin",
        action: "provider_source.created",
        subject_type: "provider_source",
        subject_id: fixture.sourceInstanceId,
        outcome: "success",
        occurred_at: base,
      },
    });
    const diagnostics = new ProviderSourceDiagnosticRepository(
      fixture.database,
    );
    await diagnostics.append({
      organizationId: fixture.organizationId,
      scope: "source",
      correlationKind: "lifecycle",
      eventKind: "source_lifecycle",
      severity: "info",
      phase: "lifecycle",
      safeCode: "SOURCE_CREATED",
      occurredAt: base,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      providerId: fixture.providerId,
      sourceInstanceId: fixture.sourceInstanceId,
      sourceRevisionId: fixture.sourceRevisionId,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      auditEventId: audit.id,
      evidence: { lifecycle_state: "draft" },
    });
    const currentDiagnostics = await diagnostics.listForSource({
      organizationId: fixture.organizationId,
      sourceInstanceId: fixture.sourceInstanceId,
      limit: 10,
      asOf: new Date(base.getTime() + 1_000),
    });
    assert.deepEqual(
      currentDiagnostics.map((event) => ({
        scope: event.scope,
        eventKind: event.eventKind,
        safeCode: event.safeCode,
      })),
      [
        {
          scope: "connection",
          eventKind: "connection_test",
          safeCode: "ADAPTER_REQUEST_STARTED",
        },
        {
          scope: "source",
          eventKind: "source_lifecycle",
          safeCode: "SOURCE_CREATED",
        },
      ],
    );
    assert.equal(
      (
        await diagnostics.listForSource({
          organizationId: fixture.organizationId,
          sourceInstanceId: fixture.sourceInstanceId,
          limit: 10,
          asOf: new Date(retentionNow.getTime() + 31 * 86_400_000),
        })
      ).length,
      0,
    );
    await assert.rejects(
      diagnostics.append({
        organizationId: fixture.organizationId,
        scope: "source",
        correlationKind: "lifecycle",
        eventKind: "source_lifecycle",
        severity: "warning",
        phase: "lifecycle",
        safeCode: "SOURCE_FAILED",
        occurredAt: base,
        sourceTypeKey,
        sourceAdapterVersion,
        normalizedContractVersion,
        providerId: fixture.providerId,
        sourceInstanceId: fixture.sourceInstanceId,
        sourceRevisionId: fixture.sourceRevisionId,
        connectionProfileId: fixture.profileId,
        connectionRevisionId: fixture.revisionId,
        auditEventId: audit.id,
        evidence: { authorization: "Bearer reusable-secret" },
      }),
      /evidence key/u,
    );
  } finally {
    await fixture.close();
  }
});

test("replacement source lineage rejects cross-tenant profile and audit references", async () => {
  const fixture = await sourceFixture();
  try {
    const unrelatedConnection =
      await fixture.lifecycle.createConnectionProfileRevision({
        organizationId: fixture.organizationId,
        sourceTypeKey,
        connectionTypeKey: "dataforrest-events-connection-v1",
        displayName: "Unrelated DataForrest profile",
        requestLimit: 2,
        sourceAdapterVersion,
        revisionNumber: 1,
        configurationCiphertext: new Uint8Array(32).fill(4),
        configurationNonce: new Uint8Array(12).fill(5),
        configurationAuthTag: new Uint8Array(16).fill(6),
        encryptionKeyVersion: 1,
        configurationFingerprint: "f".repeat(64),
        actorKey: "operator-admin",
        createdAt: base,
      });
    await assert.rejects(
      fixture.database.provider_source_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          provider_id: fixture.providerId,
          source_instance_id: fixture.sourceInstanceId,
          source_revision_id: fixture.sourceRevisionId,
          connection_profile_id: unrelatedConnection.profileId,
          connection_revision_id: unrelatedConnection.revisionId,
          expected_health_generation: 0n,
          requested_by_actor_key: "operator-admin",
          created_at: base,
        },
      }),
    );

    const setup = new PipelineSetupRepository(fixture.database);
    const otherOrganizationId = await setup.createOrganization({
      slug: "source-persistence-other",
      name: "Other source persistence",
      createdAt: base,
    });
    const otherProviderId = await setup.createProviderSource({
      organizationId: otherOrganizationId,
      platformKey: "other-courtyard",
      displayName: "Other Courtyard",
      createdAt: base,
    });
    await assert.rejects(
      fixture.database.provider_source_instances.create({
        data: {
          organization_id: otherOrganizationId,
          provider_id: otherProviderId,
          source_type_key: sourceTypeKey,
          connection_profile_id: fixture.profileId,
          created_by_actor_key: "operator-other",
          created_at: base,
          updated_at: base,
        },
      }),
    );

    const otherAudit = await fixture.database.audit_events.create({
      data: {
        organization_id: otherOrganizationId,
        actor_key: "operator-other",
        action: "provider_source.created",
        subject_type: "provider_source",
        outcome: "success",
        occurred_at: base,
      },
    });
    const diagnostics = new ProviderSourceDiagnosticRepository(
      fixture.database,
    );
    await assert.rejects(
      diagnostics.append({
        organizationId: fixture.organizationId,
        scope: "source",
        correlationKind: "lifecycle",
        eventKind: "source_lifecycle",
        severity: "warning",
        phase: "lifecycle",
        safeCode: "SOURCE_REJECTED",
        occurredAt: base,
        sourceTypeKey,
        sourceAdapterVersion,
        normalizedContractVersion,
        providerId: fixture.providerId,
        sourceInstanceId: fixture.sourceInstanceId,
        sourceRevisionId: fixture.sourceRevisionId,
        connectionProfileId: fixture.profileId,
        connectionRevisionId: fixture.revisionId,
        auditEventId: otherAudit.id,
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("blocking test failure and correlated recovery transition health atomically", async () => {
  const fixture = await sourceFixture();
  try {
    const ownerKey = "worker-recovery";
    const supervisorLeaseToken = "00000000-0000-4000-8000-000000000121";
    const supervisor = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisor.acquire({
      environmentKey: "local-source-recovery",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: base,
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const failedClaimToken = "00000000-0000-4000-8000-000000000122";
    const failedJob = await fixture.database.source_connection_test_jobs.create(
      {
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: fixture.revisionId,
          expected_health_generation: 0n,
          state: "running",
          requested_by_actor_key: "operator-admin",
          claim_owner: ownerKey,
          claim_token: failedClaimToken,
          claim_expires_at: await futureDatabaseTime(fixture.database),
          supervisor_epoch_id: epoch.epochId,
          started_at: base,
        },
      },
    );
    const failedAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000123",
      claimOwner: ownerKey,
      claimToken: failedClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 0n,
      operation: { kind: "connection_test", connectionTestJobId: failedJob.id },
      startedAt: new Date(base.getTime() + 1_000),
    });
    const failed = await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId: failedAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "failed",
      outcomeClass: "authentication_failed",
      safeCode: "authentication_failed",
      safeOutcomeHash: "d".repeat(64),
      terminalAt: new Date(base.getTime() + 2_000),
      blockingFailure: {
        failureClass: "authentication_failed",
        safeCode: "authentication_failed",
      },
    });
    assert.ok(failed.blockingEpisodeId);
    assert.equal(failed.resultingHealthGeneration, 1n);
    assert.equal(
      await fixture.database.source_connection_test_results.count({
        where: { job_id: failedJob.id, outcome: "failure" },
      }),
      1,
    );
    const immutableFailedResult =
      await fixture.database.source_connection_test_results.findUniqueOrThrow({
        where: { job_id: failedJob.id },
      });
    await assert.rejects(
      fixture.database.source_connection_test_results.update({
        where: { id: immutableFailedResult.id },
        data: { outcome: "success" },
      }),
    );
    await assert.rejects(
      fixture.database.source_connection_test_results.delete({
        where: { id: immutableFailedResult.id },
      }),
    );
    const results = new ProviderSourceTestResultRepository(fixture.database);
    await assert.rejects(
      results.completeConnectionTest({
        organizationId: fixture.organizationId,
        jobId: failedJob.id,
        requestAttemptId: failedAttemptId,
        claimOwner: ownerKey,
        claimToken: failedClaimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        outcome: "success",
        safeCode: "invalid_success_reuse",
        completedAt: new Date(base.getTime() + 2_500),
      }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );

    const retiredAt = await databaseClock(fixture.database);
    const retiredRevision =
      await fixture.database.source_connection_revisions.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          revision_number: 2,
          source_type_key: sourceTypeKey,
          source_adapter_version: sourceAdapterVersion,
          configuration_ciphertext: new Uint8Array(32).fill(7),
          configuration_nonce: new Uint8Array(12).fill(8),
          configuration_auth_tag: new Uint8Array(16).fill(9),
          encryption_key_version: 1,
          configuration_fingerprint: "f".repeat(64),
          state: "retired",
          health_generation: 0n,
          created_by_actor_key: "operator-admin",
          created_at: retiredAt,
          activated_at: retiredAt,
          retired_at: retiredAt,
        },
      });
    const retiredClaimToken = "00000000-0000-4000-8000-000000000126";
    const retiredJob =
      await fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: retiredRevision.id,
          blocking_episode_id: failed.blockingEpisodeId,
          expected_health_generation: 0n,
          state: "running",
          requested_by_actor_key: "operator-admin",
          claim_owner: ownerKey,
          claim_token: retiredClaimToken,
          claim_expires_at: await futureDatabaseTime(fixture.database),
          supervisor_epoch_id: epoch.epochId,
          started_at: retiredAt,
        },
      });
    const retiredRequestLeaseId =
      "00000000-0000-4000-8000-000000000127";
    await assert.rejects(
      requests.begin({
        organizationId: fixture.organizationId,
        requestLeaseId: retiredRequestLeaseId,
        claimOwner: ownerKey,
        claimToken: retiredClaimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        connectionProfileId: fixture.profileId,
        connectionRevisionId: retiredRevision.id,
        expectedHealthGeneration: 0n,
        operation: {
          kind: "connection_test",
          connectionTestJobId: retiredJob.id,
          blockingEpisodeId: failed.blockingEpisodeId,
        },
        startedAt: retiredAt,
      }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
    assert.equal(
      await fixture.database.source_request_attempts.count({
        where: { request_lease_id: retiredRequestLeaseId },
      }),
      0,
    );
    await fixture.database.source_connection_test_jobs.update({
      where: { id: retiredJob.id },
      data: { state: "fenced", finished_at: await databaseClock(fixture.database) },
    });

    const recoveryClaimToken = "00000000-0000-4000-8000-000000000124";
    const recoveryJob =
      await fixture.database.source_connection_test_jobs.create({
        data: {
          organization_id: fixture.organizationId,
          connection_profile_id: fixture.profileId,
          connection_revision_id: fixture.revisionId,
          blocking_episode_id: failed.blockingEpisodeId,
          recovery_blocked_revision_id: fixture.revisionId,
          expected_health_generation: 1n,
          state: "running",
          requested_by_actor_key: "operator-admin",
          claim_owner: ownerKey,
          claim_token: recoveryClaimToken,
          claim_expires_at: await futureDatabaseTime(fixture.database),
          supervisor_epoch_id: epoch.epochId,
          started_at: new Date(base.getTime() + 3_000),
        },
      });
    const recoveryAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000125",
      claimOwner: ownerKey,
      claimToken: recoveryClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      connectionProfileId: fixture.profileId,
      connectionRevisionId: fixture.revisionId,
      expectedHealthGeneration: 1n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: recoveryJob.id,
        blockingEpisodeId: failed.blockingEpisodeId,
      },
      startedAt: new Date(base.getTime() + 3_000),
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
      safeOutcomeHash: "e".repeat(64),
      terminalAt: new Date(base.getTime() + 4_000),
    });
    const recovered = await results.completeConnectionTest({
      organizationId: fixture.organizationId,
      jobId: recoveryJob.id,
      requestAttemptId: recoveryAttemptId,
      claimOwner: ownerKey,
      claimToken: recoveryClaimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_recovered",
      completedAt: new Date(base.getTime() + 5_000),
    });
    assert.equal(recovered.resultingHealthGeneration, 2n);
    assert.equal(recovered.episodeClosed, true);
    assert.equal(
      await fixture.database.source_connection_health_episodes.count({
        where: { id: failed.blockingEpisodeId, closed_at: { not: null } },
      }),
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("source-test results and compact request proof are immutable", async () => {
  const fixture = await sourceFixture();
  try {
    const now = await databaseClock(fixture.database);
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
    const ownerKey = "worker-source-result";
    const supervisorLeaseToken = "00000000-0000-4000-8000-000000000128";
    const supervisor = new ProviderSourceSupervisorRepository(fixture.database);
    const epoch = await supervisor.acquire({
      environmentKey: "local-source-result",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now,
    });
    const claimToken = "00000000-0000-4000-8000-000000000129";
    const job = await fixture.database.provider_source_test_jobs.create({
      data: {
        organization_id: fixture.organizationId,
        provider_id: fixture.providerId,
        source_instance_id: fixture.sourceInstanceId,
        source_revision_id: fixture.sourceRevisionId,
        connection_profile_id: fixture.profileId,
        connection_revision_id: fixture.revisionId,
        expected_health_generation: 0n,
        state: "running",
        requested_by_actor_key: "operator-admin",
        claim_owner: ownerKey,
        claim_token: claimToken,
        claim_expires_at: await futureDatabaseTime(fixture.database),
        supervisor_epoch_id: epoch.epochId,
        started_at: now,
      },
    });
    const requests = new ProviderSourceRequestRepository(fixture.database);
    const requestAttemptId = await requests.begin({
      organizationId: fixture.organizationId,
      requestLeaseId: "00000000-0000-4000-8000-000000000130",
      claimOwner: ownerKey,
      claimToken,
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
        sourceTestJobId: job.id,
      },
      startedAt: now,
    });
    await requests.terminalize({
      organizationId: fixture.organizationId,
      requestAttemptId,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "9".repeat(64),
      terminalAt: now,
    });
    const results = new ProviderSourceTestResultRepository(fixture.database);
    const completed = await results.completeSourceTest({
      organizationId: fixture.organizationId,
      jobId: job.id,
      requestAttemptId,
      claimOwner: ownerKey,
      claimToken,
      supervisorEpochId: epoch.epochId,
      supervisorOwnerKey: ownerKey,
      supervisorLeaseToken,
      outcome: "success",
      safeCode: "source_test_succeeded",
      completedAt: now,
    });
    assert.deepEqual(
      await results.completeSourceTest({
        organizationId: fixture.organizationId,
        jobId: job.id,
        requestAttemptId,
        claimOwner: ownerKey,
        claimToken,
        supervisorEpochId: epoch.epochId,
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        outcome: "success",
        safeCode: "source_test_succeeded",
        completedAt: new Date(0),
      }),
      completed,
    );
    const runtime = await fixture.database.provider_source_runtime_states
      .findUniqueOrThrow({ where: { source_instance_id: fixture.sourceInstanceId } });
    assert.equal(runtime.phase, "idle");
    assert.equal(runtime.activity, "inactive");
    assert.equal(runtime.current_run_id, null);
    assert.equal(runtime.run_lease_acquired_at, null);
    assert.equal(runtime.run_lease_expires_at, null);

    await assert.rejects(
      fixture.database.provider_source_test_results.update({
        where: { id: completed.resultId },
        data: { outcome: "failure" },
      }),
    );
    await assert.rejects(
      fixture.database.provider_source_test_results.delete({
        where: { id: completed.resultId },
      }),
    );
    await assert.rejects(
      fixture.database.compact_source_request_attempts.update({
        where: { request_attempt_id: requestAttemptId },
        data: { safe_outcome_hash: "8".repeat(64) },
      }),
    );
    await assert.rejects(
      fixture.database.compact_source_request_attempts.delete({
        where: { request_attempt_id: requestAttemptId },
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("admin run reads expose source cursor fingerprints without exposing raw cursors", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "admin-cursor-redaction",
  );
  try {
    const source = await createAcceptanceProviderSource(fixture, {
      platformKey: "courtyard",
      displayName: "Courtyard",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      intervalSeconds: 60,
      hashCharacter: "d",
    });
    const rawCursor = "provider-secret-cursor-value";
    const cursorFingerprint = "e".repeat(64);
    const run = await createPinnedSourceRun(
      fixture.database,
      fixture,
      source,
      {
        state: "succeeded",
        createdAt: base,
        requestedCursor: rawCursor,
        requestedCursorFingerprint: cursorFingerprint,
      },
    );
    const record = await new PrismaAdminImportRunRepository(
      fixture.database,
    ).get({
      organizationId: fixture.organizationId,
      runId: run.id,
    });
    assert.equal(record?.requestedCursor, cursorFingerprint);
    assert.equal(record?.finalCursor, null);
    assert.doesNotMatch(JSON.stringify(record), new RegExp(rawCursor));
  } finally {
    await fixture.close();
  }
});
