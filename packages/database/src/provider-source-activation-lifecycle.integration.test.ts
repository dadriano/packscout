import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { providerSourceLaunchBounds } from "@packscout/contracts";
import type { PackscoutPrismaClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { ProviderSourceAdminLifecycleRepository } from
  "./provider-source-admin-lifecycle-repository.ts";
import {
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
  type AcceptanceSource,
} from "./provider-source-acceptance-test-support.ts";
import {
  ProviderSourceLifecycleRepository,
  type ActivateProviderSourcePausedExactInput,
} from "./provider-source-lifecycle-repository.ts";
import { ProviderSourceRequestRepository } from
  "./provider-source-request-repository.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceTestResultRepository } from
  "./provider-source-test-result-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { SourceConnectionAdminRepository } from
  "./source-connection-admin-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const createdAt = new Date("2026-08-21T12:00:00.000Z");
const sourceTypeKey = "dataforrest-events-v1";
const sourceAdapterVersion = "dataforrest-events-adapter-v1";
const normalizedContractVersion = "packscout.provider-observation.v1";
const cursorCodecVersion = "dataforrest-cursor-v1";
const connectionTypeKey = "dataforrest-events-connection-v1";
const sourceConfigurationHash = "b".repeat(64);
const connectionConfigurationFingerprint = "a".repeat(64);
const recordIdScopes = [
  "catalog-pack-v1",
  "catalog-card-v1",
  "pull-v1",
  "trade-v1",
] as const;

interface SuccessfulTestFence {
  readonly database: PackscoutPrismaClient;
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly ownerKey: string;
  readonly supervisorLeaseToken: string;
  readonly supervisorEpochId: string;
  readonly claimExpiresAt: Date;
}

async function completeSuccessfulConnectionTest(
  input: SuccessfulTestFence & Readonly<{ requestedAt: Date }>,
): Promise<void> {
  const job = await new SourceConnectionAdminRepository(input.database)
    .requestConnectionTest({
      organizationId: input.organizationId,
      connectionProfileId: input.connectionProfileId,
      connectionRevisionId: input.connectionRevisionId,
      expectedHealthGeneration: 0n,
      requestedByActorKey: "operator-admin",
      requestedAt: input.requestedAt,
    });
  const claimToken = randomUUID();
  await input.database.source_connection_test_jobs.update({
    where: { id: job.jobId },
    data: {
      state: "running",
      claim_owner: input.ownerKey,
      claim_token: claimToken,
      claim_expires_at: input.claimExpiresAt,
      supervisor_epoch_id: input.supervisorEpochId,
      started_at: input.requestedAt,
    },
  });
  const requests = new ProviderSourceRequestRepository(input.database);
  const requestAttemptId = await requests.begin({
    organizationId: input.organizationId,
    requestLeaseId: randomUUID(),
    claimOwner: input.ownerKey,
    claimToken,
    supervisorEpochId: input.supervisorEpochId,
    supervisorOwnerKey: input.ownerKey,
    supervisorLeaseToken: input.supervisorLeaseToken,
    connectionProfileId: input.connectionProfileId,
    connectionRevisionId: input.connectionRevisionId,
    expectedHealthGeneration: 0n,
    operation: { kind: "connection_test", connectionTestJobId: job.jobId },
    startedAt: input.requestedAt,
  });
  await requests.terminalize({
    organizationId: input.organizationId,
    requestAttemptId,
    supervisorEpochId: input.supervisorEpochId,
    supervisorOwnerKey: input.ownerKey,
    supervisorLeaseToken: input.supervisorLeaseToken,
    state: "captured",
    outcomeClass: "response_captured",
    safeCode: "request_captured",
    safeOutcomeHash: "1".repeat(64),
    terminalAt: input.requestedAt,
  });
  await new ProviderSourceTestResultRepository(input.database)
    .completeConnectionTest({
      organizationId: input.organizationId,
      jobId: job.jobId,
      requestAttemptId,
      claimOwner: input.ownerKey,
      claimToken,
      supervisorEpochId: input.supervisorEpochId,
      supervisorOwnerKey: input.ownerKey,
      supervisorLeaseToken: input.supervisorLeaseToken,
      outcome: "success",
      safeCode: "connection_valid",
      completedAt: input.requestedAt,
    });
}

async function completeSuccessfulSourceTest(
  input: SuccessfulTestFence & Readonly<{
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    requestedAt: Date;
  }>,
): Promise<number> {
  const job = await new ProviderSourceAdminLifecycleRepository(input.database)
    .requestSourceTest({
      organizationId: input.organizationId,
      providerId: input.providerId,
      sourceInstanceId: input.sourceInstanceId,
      sourceRevisionId: input.sourceRevisionId,
      connectionProfileId: input.connectionProfileId,
      connectionRevisionId: input.connectionRevisionId,
      requestedByActorKey: "operator-admin",
      requestedAt: input.requestedAt,
    });
  const claimToken = randomUUID();
  const claimed = await input.database.provider_source_test_jobs.update({
    where: { id: job.jobId },
    data: {
      state: "running",
      claim_owner: input.ownerKey,
      claim_token: claimToken,
      claim_expires_at: input.claimExpiresAt,
      supervisor_epoch_id: input.supervisorEpochId,
      started_at: input.requestedAt,
    },
  });
  const requests = new ProviderSourceRequestRepository(input.database);
  const requestAttemptId = await requests.begin({
    organizationId: input.organizationId,
    requestLeaseId: randomUUID(),
    claimOwner: input.ownerKey,
    claimToken,
    supervisorEpochId: input.supervisorEpochId,
    supervisorOwnerKey: input.ownerKey,
    supervisorLeaseToken: input.supervisorLeaseToken,
    connectionProfileId: input.connectionProfileId,
    connectionRevisionId: input.connectionRevisionId,
    expectedHealthGeneration: 0n,
    operation: {
      kind: "source_test",
      providerId: input.providerId,
      sourceInstanceId: input.sourceInstanceId,
      sourceRevisionId: input.sourceRevisionId,
      sourceTestJobId: job.jobId,
    },
    startedAt: input.requestedAt,
  });
  await requests.terminalize({
    organizationId: input.organizationId,
    requestAttemptId,
    supervisorEpochId: input.supervisorEpochId,
    supervisorOwnerKey: input.ownerKey,
    supervisorLeaseToken: input.supervisorLeaseToken,
    state: "captured",
    outcomeClass: "response_captured",
    safeCode: "request_captured",
    safeOutcomeHash: "2".repeat(64),
    terminalAt: input.requestedAt,
  });
  await new ProviderSourceTestResultRepository(input.database)
    .completeSourceTest({
      organizationId: input.organizationId,
      jobId: job.jobId,
      requestAttemptId,
      claimOwner: input.ownerKey,
      claimToken,
      supervisorEpochId: input.supervisorEpochId,
      supervisorOwnerKey: input.ownerKey,
      supervisorLeaseToken: input.supervisorLeaseToken,
      outcome: "success",
      safeCode: "source_valid",
      completedAt: input.requestedAt,
    });
  return claimed.records_per_request;
}

function exactActivationInput(
  fixture: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
  }>,
  source: AcceptanceSource,
  hashCharacter: string,
  activatedAt: Date,
): ActivateProviderSourcePausedExactInput {
  return {
    organizationId: fixture.organizationId,
    providerId: source.providerId,
    providerKey: source.platformKey,
    sourceInstanceId: source.sourceInstanceId,
    sourceRevisionId: source.sourceRevisionId,
    sourceTypeKey,
    sourceAdapterVersion,
    normalizedContractVersion,
    mapperKey: source.mapperKey,
    mapperVersion: "1",
    identityNamespaceKey: source.identityNamespaceKey,
    cursorCodecVersion,
    sourceConfiguration: { provider: source.platformKey },
    sourceConfigurationHash: hashCharacter.repeat(64),
    recordIdScopes,
    connectionProfileId: fixture.connectionProfileId,
    connectionTypeKey,
    connectionRequestLimit: providerSourceLaunchBounds.stablePlatformRequestCap,
    connectionRevisionId: fixture.connectionRevisionId,
    connectionConfigurationFingerprint,
    cursorGeneration: 1n,
    actorKey: "operator-admin",
    activatedAt,
  };
}

test("source activation candidate is coherent and exact persistence pins fail closed", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    const organizationId = await setup.createOrganization({
      slug: "source-activation-seam",
      name: "Source activation seam",
      createdAt,
    });
    const providerId = await setup.createProviderSource({
      organizationId,
      platformKey: "courtyard",
      displayName: "Courtyard",
      createdAt,
    });
    const lifecycle = new ProviderSourceLifecycleRepository(harness.database);
    const connection = await lifecycle.createConnectionProfileRevision({
      organizationId,
      sourceTypeKey,
      connectionTypeKey,
      displayName: "DataForrest shared",
      requestLimit: providerSourceLaunchBounds.stablePlatformRequestCap,
      sourceAdapterVersion,
      revisionNumber: 1,
      configurationCiphertext: new Uint8Array(32).fill(1),
      configurationNonce: new Uint8Array(12).fill(2),
      configurationAuthTag: new Uint8Array(16).fill(3),
      encryptionKeyVersion: 1,
      configurationFingerprint: connectionConfigurationFingerprint,
      actorKey: "operator-admin",
      createdAt,
    });
    const sourceConfiguration = { platform: "courtyard" } as const;
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
      configuration: sourceConfiguration,
      configurationHash: sourceConfigurationHash,
      recordIdScopes,
      actorKey: "operator-admin",
      createdAt,
    });
    await harness.database.$transaction([
      harness.database.source_connection_revisions.update({
        where: { id: connection.revisionId },
        data: { state: "active", activated_at: createdAt },
      }),
      harness.database.source_connection_profiles.update({
        where: { id: connection.profileId },
        data: {
          state: "active",
          active_revision_id: connection.revisionId,
          updated_at: createdAt,
        },
      }),
    ]);

    const candidate = await lifecycle.loadSourceActivationCandidate({
      organizationId,
      providerId,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionRevisionId: connection.revisionId,
    });
    assert.ok(candidate);
    assert.equal(candidate.provider.platformKey, "courtyard");
    assert.equal(candidate.sourceInstance.state, "draft");
    assert.equal(candidate.connectionProfile.activeRevisionId, connection.revisionId);
    assert.equal(candidate.connectionRevision.configurationFingerprint,
      connectionConfigurationFingerprint);
    assert.deepEqual(candidate.sourceRevision.configuration, sourceConfiguration);
    assert.deepEqual(candidate.sourceRevision.recordIdScopes, recordIdScopes);
    assert.deepEqual(candidate.cursor, {
      sourceRevisionId: source.sourceRevisionId,
      sourceAdapterVersion,
      cursorCodecVersion,
      cursorGeneration: 1n,
      cursorFingerprint: null,
      hasCursor: false,
      advancedByRunId: null,
      advancedByPageId: null,
    });

    const exactInput: ActivateProviderSourcePausedExactInput = {
      organizationId,
      providerId,
      providerKey: "courtyard",
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      mapperKey: "courtyard-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      cursorCodecVersion,
      sourceConfiguration,
      sourceConfigurationHash,
      recordIdScopes,
      connectionProfileId: connection.profileId,
      connectionTypeKey,
      connectionRequestLimit: providerSourceLaunchBounds.stablePlatformRequestCap,
      connectionRevisionId: connection.revisionId,
      connectionConfigurationFingerprint,
      cursorGeneration: 1n,
      actorKey: "operator-admin",
      activatedAt: createdAt,
    };
    await assert.rejects(
      lifecycle.activateSourcePausedExact({
        ...exactInput,
        sourceConfigurationHash: "c".repeat(64),
      }),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "SOURCE_FENCED",
    );
    await assert.rejects(
      lifecycle.activateSourcePausedExact(exactInput),
      (error: unknown) => error instanceof PersistenceError
        && error.code === "CONFIG_REVISION_UNTESTED",
    );
    assert.equal((await harness.database.provider_source_instances.findUniqueOrThrow({
      where: { id: source.sourceInstanceId },
    })).state, "draft");
  } finally {
    await harness.close();
  }
});

test("source activation matches the tested request size across schedule revisions", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "activation-request-size",
  );
  try {
    const stableSource = await createAcceptanceProviderSource(fixture, {
      platformKey: "courtyard",
      displayName: "Courtyard stable request size",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      intervalSeconds: 60,
      hashCharacter: "b",
    });
    const revisedSource = await createAcceptanceProviderSource(fixture, {
      platformKey: "phygitals",
      displayName: "Phygitals revised request size",
      mapperKey: "phygitals-provider-observation",
      identityNamespaceKey: "dataforrest-phygitals-records-v1",
      intervalSeconds: 60,
      hashCharacter: "c",
    });
    await fixture.database.$transaction([
      fixture.database.source_connection_revisions.update({
        where: { id: fixture.connectionRevisionId },
        data: { state: "active", activated_at: createdAt },
      }),
      fixture.database.source_connection_profiles.update({
        where: { id: fixture.connectionProfileId },
        data: {
          state: "active",
          active_revision_id: fixture.connectionRevisionId,
          updated_at: createdAt,
        },
      }),
    ]);

    const ownerKey = "worker-activation-request-size";
    const supervisorLeaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(fixture.database)
      .acquire({
        environmentKey: "local-activation-request-size",
        ownerKey,
        leaseToken: supervisorLeaseToken,
        now: createdAt,
      });
    const testFence = {
      database: fixture.database,
      organizationId: fixture.organizationId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      ownerKey,
      supervisorLeaseToken,
      supervisorEpochId: epoch.epochId,
      claimExpiresAt: epoch.leaseExpiresAt,
    } as const;
    await completeSuccessfulConnectionTest({
      ...testFence,
      requestedAt: new Date(createdAt.getTime() + 1_000),
    });
    assert.equal(await completeSuccessfulSourceTest({
      ...testFence,
      providerId: stableSource.providerId,
      sourceInstanceId: stableSource.sourceInstanceId,
      sourceRevisionId: stableSource.sourceRevisionId,
      requestedAt: new Date(createdAt.getTime() + 2_000),
    }), 500);
    assert.equal(await completeSuccessfulSourceTest({
      ...testFence,
      providerId: revisedSource.providerId,
      sourceInstanceId: revisedSource.sourceInstanceId,
      sourceRevisionId: revisedSource.sourceRevisionId,
      requestedAt: new Date(createdAt.getTime() + 3_000),
    }), 500);

    const admin = new ProviderSourceAdminLifecycleRepository(fixture.database);
    const stableBefore = await admin.loadSource({
      organizationId: fixture.organizationId,
      providerId: stableSource.providerId,
      sourceInstanceId: stableSource.sourceInstanceId,
    });
    assert.ok(stableBefore);
    const intervalRevision = await admin.reviseInterval({
      organizationId: fixture.organizationId,
      providerId: stableSource.providerId,
      sourceInstanceId: stableSource.sourceInstanceId,
      expectedSourceRevisionId: stableSource.sourceRevisionId,
      expectedScheduleRevisionId: stableBefore.scheduleRevisionId,
      intervalSeconds: 120,
      actorKey: "operator-admin",
      effectiveAt: new Date(createdAt.getTime() + 4_000),
    });
    const sameValueRevision = await admin.reviseRecordsPerRequest({
      organizationId: fixture.organizationId,
      providerId: stableSource.providerId,
      sourceInstanceId: stableSource.sourceInstanceId,
      expectedSourceRevisionId: stableSource.sourceRevisionId,
      expectedScheduleRevisionId: intervalRevision.scheduleRevisionId,
      recordsPerRequest: 500,
      actorKey: "operator-admin",
      effectiveAt: new Date(createdAt.getTime() + 5_000),
    });
    assert.notEqual(
      sameValueRevision.scheduleRevisionId,
      stableBefore.scheduleRevisionId,
    );
    await fixture.lifecycle.activateSourcePausedExact(exactActivationInput(
      fixture,
      stableSource,
      "b",
      new Date(createdAt.getTime() + 6_000),
    ));
    assert.equal((await fixture.database.provider_source_instances.findUniqueOrThrow({
      where: { id: stableSource.sourceInstanceId },
    })).state, "paused");

    const revisedBefore = await admin.loadSource({
      organizationId: fixture.organizationId,
      providerId: revisedSource.providerId,
      sourceInstanceId: revisedSource.sourceInstanceId,
    });
    assert.ok(revisedBefore);
    await admin.reviseRecordsPerRequest({
      organizationId: fixture.organizationId,
      providerId: revisedSource.providerId,
      sourceInstanceId: revisedSource.sourceInstanceId,
      expectedSourceRevisionId: revisedSource.sourceRevisionId,
      expectedScheduleRevisionId: revisedBefore.scheduleRevisionId,
      recordsPerRequest: 725,
      actorKey: "operator-admin",
      effectiveAt: new Date(createdAt.getTime() + 7_000),
    });
    const revisedActivation = exactActivationInput(
      fixture,
      revisedSource,
      "c",
      new Date(createdAt.getTime() + 8_000),
    );
    await assert.rejects(
      fixture.lifecycle.activateSourcePausedExact(revisedActivation),
      (error: unknown) => error instanceof PersistenceError &&
        error.code === "CONFIG_REVISION_UNTESTED",
    );
    assert.equal((await fixture.database.provider_source_instances.findUniqueOrThrow({
      where: { id: revisedSource.sourceInstanceId },
    })).state, "draft");

    assert.equal(await completeSuccessfulSourceTest({
      ...testFence,
      providerId: revisedSource.providerId,
      sourceInstanceId: revisedSource.sourceInstanceId,
      sourceRevisionId: revisedSource.sourceRevisionId,
      requestedAt: new Date(createdAt.getTime() + 9_000),
    }), 725);
    await fixture.lifecycle.activateSourcePausedExact({
      ...revisedActivation,
      activatedAt: new Date(createdAt.getTime() + 10_000),
    });
    assert.equal((await fixture.database.provider_source_instances.findUniqueOrThrow({
      where: { id: revisedSource.sourceInstanceId },
    })).state, "paused");
  } finally {
    await fixture.close();
  }
});

test("the exact activation method is the only lifecycle activation authority", () => {
  const prototype = ProviderSourceLifecycleRepository.prototype as unknown as
    Record<string, unknown>;
  assert.equal(prototype.activateConnectionRevision, undefined);
  assert.equal(prototype.activateSourcePaused, undefined);
  assert.equal(typeof prototype.activateSourcePausedExact, "function");
});
