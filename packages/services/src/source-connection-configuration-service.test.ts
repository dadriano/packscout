import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
} from "@packscout/contracts";
import {
  createProductionSourceAdminConfigurationCodecRegistry,
  createProductionSourceAdapterRegistry,
} from "./production-source-adapter-registry.ts";
import {
  AesGcmSourceConnectionConfigurationCipher,
} from "./source-connection-configuration-cipher.ts";
import {
  SourceConnectionConfigurationService,
} from "./source-connection-configuration-service.ts";
import { ProviderSourceAdminServiceError } from
  "./provider-source-admin-service-types.ts";
import type {
  SourceConnectionConfigurationAdminRepository,
  SourceConnectionRevisionSecretRecord,
} from "./source-connection-configuration-admin-repository.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const profileId = "00000000-0000-4000-8000-000000000002";
const revisionOneId = "00000000-0000-4000-8000-000000000003";
const revisionTwoId = "00000000-0000-4000-8000-000000000004";
const testJobId = "00000000-0000-4000-8000-000000000005";
const now = new Date("2026-08-21T12:00:00.000Z");

class MemoryConnectionRepository
  implements SourceConnectionConfigurationAdminRepository {
  readonly revisions = new Map<string, SourceConnectionRevisionSecretRecord>();
  incompatibleSourcePins = false;
  createInput: Parameters<
    SourceConnectionConfigurationAdminRepository["createConnectionProfile"]
  >[0] | null = null;
  activationInput: Parameters<
    SourceConnectionConfigurationAdminRepository["activateTestedConnectionRevision"]
  >[0] | null = null;
  recoveryRevisionInput: Parameters<
    SourceConnectionConfigurationAdminRepository["addRecoveryConnectionRevision"]
  >[0] | null = null;
  adapterRevisionInput: Parameters<
    SourceConnectionConfigurationAdminRepository["addConnectionAdapterRevision"]
  >[0] | null = null;
  recoveryTestInput: Parameters<
    SourceConnectionConfigurationAdminRepository["requestConnectionRecoveryTest"]
  >[0] | null = null;
  recoveryActivationInput: Parameters<
    SourceConnectionConfigurationAdminRepository["activateTestedConnectionRecovery"]
  >[0] | null = null;

  async createConnectionProfile(input: Parameters<
    SourceConnectionConfigurationAdminRepository["createConnectionProfile"]
  >[0]) {
    this.createInput = input;
    this.revisions.set(input.revisionId, {
      organizationId: input.organizationId,
      connectionProfileId: input.profileId,
      connectionRevisionId: input.revisionId,
      sourceTypeKey: input.sourceTypeKey,
      sourceAdapterVersion: input.sourceAdapterVersion,
      revisionNumber: 1,
      state: "candidate",
      healthGeneration: 0n,
      configurationFingerprint: input.configurationFingerprint,
      encryptedConfiguration: input.encryptedConfiguration,
    });
  }

  async loadConnectionRevision(input: Parameters<
    SourceConnectionConfigurationAdminRepository["loadConnectionRevision"]
  >[0]) {
    const revision = input.connectionRevisionId
      ? this.revisions.get(input.connectionRevisionId)
      : [...this.revisions.values()].at(-1);
    return revision?.organizationId === input.organizationId &&
        revision.connectionProfileId === input.connectionProfileId
      ? revision
      : null;
  }

  async hasIncompatibleSourceAdapterPins() {
    return this.incompatibleSourcePins;
  }

  async addConnectionRevision(input: Parameters<
    SourceConnectionConfigurationAdminRepository["addConnectionRevision"]
  >[0]) {
    this.revisions.set(input.revisionId, {
      organizationId: input.organizationId,
      connectionProfileId: input.connectionProfileId,
      connectionRevisionId: input.revisionId,
      sourceTypeKey: input.sourceTypeKey,
      sourceAdapterVersion: input.sourceAdapterVersion,
      revisionNumber: input.revisionNumber,
      state: "candidate",
      healthGeneration: 0n,
      configurationFingerprint: input.configurationFingerprint,
      encryptedConfiguration: input.encryptedConfiguration,
    });
  }

  async addConnectionAdapterRevision(input: Parameters<
    SourceConnectionConfigurationAdminRepository["addConnectionAdapterRevision"]
  >[0]) {
    this.adapterRevisionInput = input;
    this.revisions.set(input.revisionId, {
      organizationId: input.organizationId,
      connectionProfileId: input.connectionProfileId,
      connectionRevisionId: input.revisionId,
      sourceTypeKey: input.sourceTypeKey,
      sourceAdapterVersion: input.sourceAdapterVersion,
      revisionNumber: input.revisionNumber,
      state: "candidate",
      healthGeneration: 0n,
      configurationFingerprint: input.configurationFingerprint,
      encryptedConfiguration: input.encryptedConfiguration,
    });
  }

  async addRecoveryConnectionRevision(input: Parameters<
    SourceConnectionConfigurationAdminRepository["addRecoveryConnectionRevision"]
  >[0]) {
    this.recoveryRevisionInput = input;
    this.revisions.set(input.revisionId, {
      organizationId: input.organizationId,
      connectionProfileId: input.connectionProfileId,
      connectionRevisionId: input.revisionId,
      sourceTypeKey: input.sourceTypeKey,
      sourceAdapterVersion: input.sourceAdapterVersion,
      revisionNumber: input.revisionNumber,
      state: "candidate",
      healthGeneration: 0n,
      configurationFingerprint: input.configurationFingerprint,
      encryptedConfiguration: input.encryptedConfiguration,
    });
  }

  async requestConnectionTest() {
    return { jobId: testJobId };
  }

  async requestConnectionRecoveryTest(input: Parameters<
    SourceConnectionConfigurationAdminRepository["requestConnectionRecoveryTest"]
  >[0]) {
    this.recoveryTestInput = input;
    return { jobId: testJobId };
  }

  async activateTestedConnectionRevision(input: Parameters<
    SourceConnectionConfigurationAdminRepository["activateTestedConnectionRevision"]
  >[0]) {
    this.activationInput = input;
  }

  async activateTestedConnectionRecovery(input: Parameters<
    SourceConnectionConfigurationAdminRepository["activateTestedConnectionRecovery"]
  >[0]) {
    this.recoveryActivationInput = input;
    return { runIds: [] };
  }

  async revokeConnectionRevision() {}
}

function fixture(
  ids = [profileId, revisionOneId, revisionTwoId],
) {
  const repository = new MemoryConnectionRepository();
  const sourceAdapters = createProductionSourceAdapterRegistry();
  const cipher = new AesGcmSourceConnectionConfigurationCipher({
    primaryVersion: 7,
    keys: new Map([[7, new Uint8Array(32).fill(7)]]),
  });
  const service = new SourceConnectionConfigurationService({
    repository,
    cipher,
    sourceAdapters,
    adminConfigurationCodecs:
      createProductionSourceAdminConfigurationCodecRegistry(sourceAdapters),
    clock: { now: () => now },
    ids: { id: () => ids.shift()! },
  });
  return { cipher, repository, service };
}

test("one shared credential is encrypted under exact organization/profile/revision AAD and never echoed", async () => {
  const { repository, service } = fixture();
  const secret = "dataforrest-secret";
  const result = await service.createProfile(
    { organizationId, actorKey: "operator-admin" },
    {
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Shared DataForrest",
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerCredential: secret,
      requestLimit: 2,
    },
  );
  assert.equal(result.profileId, profileId);
  assert.equal(result.revisionId, revisionOneId);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(
    Buffer.from(
      repository.createInput!.encryptedConfiguration.ciphertext,
    ).includes(Buffer.from(secret)),
    false,
  );
  const resolved = await service.resolveSourceConnectionConfiguration({
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionOneId,
    configurationFingerprint: repository.createInput!.configurationFingerprint,
  });
  assert.deepEqual(resolved.configuration, {
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken: secret,
  });
  await assert.rejects(
    service.resolveSourceConnectionConfiguration({
      organizationId: "00000000-0000-4000-8000-000000000099",
      connectionProfileId: profileId,
      connectionRevisionId: revisionOneId,
      configurationFingerprint: repository.createInput!.configurationFingerprint,
    }),
    /connection_not_found/u,
  );
});

test("same-endpoint rotation creates a tested candidate and normal activation preserves pinned work", async () => {
  const { repository, service } = fixture();
  await service.createProfile(
    { organizationId, actorKey: "operator-admin" },
    {
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Shared DataForrest",
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerCredential: "old-secret",
      requestLimit: 2,
    },
  );
  const rotated = await service.rotateCredential(
    { organizationId, actorKey: "operator-admin" },
    profileId,
    { expectedRevisionId: revisionOneId, bearerCredential: "new-secret" },
  );
  assert.equal(rotated.revisionId, revisionTwoId);
  const candidate = repository.revisions.get(revisionTwoId)!;
  const resolved = await service.resolveSourceConnectionConfiguration({
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionTwoId,
    configurationFingerprint: candidate.configurationFingerprint,
  });
  assert.deepEqual(resolved.configuration, {
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken: "new-secret",
  });
  const pending = await service.requestTest(
    { organizationId, actorKey: "operator-admin" },
    profileId,
    { expectedRevisionId: revisionTwoId },
  );
  assert.equal(pending.state, "pending");
  await service.activateRevision(
    { organizationId, actorKey: "operator-admin" },
    profileId,
    { expectedRevisionId: revisionTwoId },
  );
  assert.equal(repository.activationInput?.preservePinnedWork, true);
  assert.equal(repository.activationInput?.connectionRevisionId, revisionTwoId);
});

test("adapter upgrade revalidates and re-encrypts a v1 credential as an untested current v3 candidate", async () => {
  const { cipher, repository, service } = fixture([revisionTwoId]);
  const secret = "stored-v1-secret";
  repository.revisions.set(revisionOneId, {
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionOneId,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    revisionNumber: 1,
    state: "active",
    healthGeneration: 15n,
    configurationFingerprint: "a".repeat(64),
    encryptedConfiguration: cipher.encrypt(
      JSON.stringify({
        endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
        bearerToken: secret,
      }),
      { organizationId, connectionProfileId: profileId, connectionRevisionId: revisionOneId },
    ),
  });

  const result = await service.upgradeAdapter(
    { organizationId, actorKey: "operator-admin" },
    profileId,
    {
      expectedRevisionId: revisionOneId,
      expectedSourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      targetSourceAdapterVersion: DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
      confirmation: "UPGRADE_ADAPTER",
    },
  );
  assert.equal(result.revisionId, revisionTwoId);
  assert.equal(
    result.sourceAdapterVersion,
    DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(
    repository.adapterRevisionInput?.expectedSourceAdapterVersion,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
  assert.equal(
    repository.adapterRevisionInput?.sourceAdapterVersion,
    DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
  );
  const candidate = repository.revisions.get(revisionTwoId)!;
  assert.equal(
    Buffer.from(candidate.encryptedConfiguration.ciphertext).includes(
      Buffer.from(secret),
    ),
    false,
  );
  const resolved = await service.resolveSourceConnectionConfiguration({
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionTwoId,
    configurationFingerprint: candidate.configurationFingerprint,
  });
  assert.deepEqual(resolved.configuration, {
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken: secret,
  });

  await assert.rejects(
    service.upgradeAdapter(
      { organizationId, actorKey: "operator-admin" },
      profileId,
      {
        expectedRevisionId: revisionTwoId,
        expectedSourceAdapterVersion: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
        targetSourceAdapterVersion: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
        confirmation: "UPGRADE_ADAPTER",
      },
    ),
    /invalid_source_configuration/u,
  );
});

test("adapter upgrade rejects a revoked latest revision before decrypting it", async () => {
  const { repository, service } = fixture([revisionTwoId]);
  repository.revisions.set(revisionOneId, {
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionOneId,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    revisionNumber: 1,
    state: "revoked",
    healthGeneration: 1n,
    configurationFingerprint: "a".repeat(64),
    encryptedConfiguration: {
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
      keyVersion: 7,
    },
  });

  await assert.rejects(
    service.upgradeAdapter(
      { organizationId, actorKey: "operator-admin" },
      profileId,
      {
        expectedRevisionId: revisionOneId,
        expectedSourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
        targetSourceAdapterVersion: DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
        confirmation: "UPGRADE_ADAPTER",
      },
    ),
    (error) => error instanceof ProviderSourceAdminServiceError &&
      error.code === "SOURCE_CONFLICT" && error.status === 409,
  );
  assert.equal(repository.adapterRevisionInput, null);
});

test("adapter upgrade rejects an incompatible draft source pin before decrypting", async () => {
  const { repository, service } = fixture([revisionTwoId]);
  repository.incompatibleSourcePins = true;
  repository.revisions.set(revisionOneId, {
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionOneId,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    revisionNumber: 1,
    state: "active",
    healthGeneration: 1n,
    configurationFingerprint: "a".repeat(64),
    encryptedConfiguration: {
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
      keyVersion: 7,
    },
  });

  await assert.rejects(
    service.upgradeAdapter(
      { organizationId, actorKey: "operator-admin" },
      profileId,
      {
        expectedRevisionId: revisionOneId,
        expectedSourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
        targetSourceAdapterVersion: DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
        confirmation: "UPGRADE_ADAPTER",
      },
    ),
    (error) => error instanceof ProviderSourceAdminServiceError &&
      error.code === "SOURCE_CONFLICT" && error.status === 409,
  );
  assert.equal(repository.adapterRevisionInput, null);
});

test("connection activation rejects an incompatible draft source pin", async () => {
  const { repository, service } = fixture();
  await service.createProfile(
    { organizationId, actorKey: "operator-admin" },
    {
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Shared DataForrest",
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerCredential: "secret",
      requestLimit: 2,
    },
  );
  repository.incompatibleSourcePins = true;

  await assert.rejects(
    service.activateRevision(
      { organizationId, actorKey: "operator-admin" },
      profileId,
      { expectedRevisionId: revisionOneId },
    ),
    (error) => error instanceof ProviderSourceAdminServiceError &&
      error.code === "SOURCE_CONFLICT" && error.status === 409,
  );
  assert.equal(repository.activationInput, null);
});

test("recovery commands retain the exact blocked revision, episode, generation, and candidate pins", async () => {
  const { repository, service } = fixture();
  await service.createProfile(
    { organizationId, actorKey: "operator-admin" },
    {
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Shared DataForrest",
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerCredential: "blocked-secret",
      requestLimit: 2,
    },
  );
  const episodeId = "00000000-0000-4000-8000-000000000006";
  const candidate = await service.createRecoveryRevision(
    { organizationId, actorKey: "operator-admin" },
    profileId,
    {
      expectedBlockedRevisionId: revisionOneId,
      expectedLatestRevisionId: revisionOneId,
      blockingEpisodeId: episodeId,
      bearerCredential: "recovery-secret",
    },
  );
  assert.equal(candidate.revisionId, revisionTwoId);
  assert.equal(repository.recoveryRevisionInput?.blockedRevisionId, revisionOneId);
  assert.equal(repository.recoveryRevisionInput?.latestRevisionId, revisionOneId);
  assert.equal(repository.recoveryRevisionInput?.blockingEpisodeId, episodeId);
  const resolved = await service.resolveSourceConnectionConfiguration({
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionTwoId,
    configurationFingerprint:
      repository.recoveryRevisionInput!.configurationFingerprint,
  });
  assert.deepEqual(resolved.configuration, {
    endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
    bearerToken: "recovery-secret",
  });
  const request = {
    expectedRevisionId: revisionTwoId,
    expectedHealthGeneration: "0",
    blockedRevisionId: revisionOneId,
    blockingEpisodeId: episodeId,
  } as const;
  await service.requestRecoveryTest(
    { organizationId, actorKey: "operator-admin" },
    profileId,
    request,
  );
  await service.activateRecovery(
    { organizationId, actorKey: "operator-admin" },
    profileId,
    request,
  );
  assert.deepEqual(repository.recoveryTestInput, {
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId: revisionTwoId,
    expectedHealthGeneration: 0n,
    blockedRevisionId: revisionOneId,
    blockingEpisodeId: episodeId,
    requestedByActorKey: "operator-admin",
    requestedAt: now,
  });
  assert.equal(
    repository.recoveryActivationInput?.connectionRevisionId,
    revisionTwoId,
  );
  assert.equal(repository.recoveryActivationInput?.blockedRevisionId, revisionOneId);
  assert.equal(repository.recoveryActivationInput?.blockingEpisodeId, episodeId);
});

test("adapter validation rejects endpoint changes, invalid caps, and unregistered source types before persistence", async () => {
  const { repository, service } = fixture();
  for (const request of [
    {
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Wrong endpoint",
      endpoint: "https://different.example/v1/events",
      bearerCredential: "secret",
      requestLimit: 2,
    },
    {
      sourceTypeKey: "dataforrest-events-v1",
      displayName: "Wrong cap",
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerCredential: "secret",
      requestLimit: 3,
    },
    {
      sourceTypeKey: "alternate-bookmark-v1",
      displayName: "Alternate",
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerCredential: "secret",
      requestLimit: 2,
    },
  ]) {
    await assert.rejects(
      service.createProfile(
        { organizationId, actorKey: "operator-admin" },
        request as never,
      ),
      /invalid_source_configuration/u,
    );
  }
  assert.equal(repository.createInput, null);
});
