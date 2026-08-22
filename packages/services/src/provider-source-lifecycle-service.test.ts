import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import { ProviderSourceActivationService } from "./provider-source-activation-service.ts";
import type {
  ProviderSourceLifecycleAdminRepository,
  ProviderSourceLifecycleSnapshot,
} from "./provider-source-lifecycle-admin-repository.ts";
import {
  ProviderSourceLifecycleService,
} from "./provider-source-lifecycle-service.ts";
import {
  createProductionSourceAdminConfigurationCodecRegistry,
  createProductionSourceAdapterRegistry,
} from "./production-source-adapter-registry.ts";
import { SourceMapperDescriptorRegistry } from "./source-mapper-descriptors.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const providerId = "00000000-0000-4000-8000-000000000002";
const profileId = "00000000-0000-4000-8000-000000000003";
const connectionRevisionId = "00000000-0000-4000-8000-000000000004";
const sourceId = "00000000-0000-4000-8000-000000000005";
const sourceRevisionId = "00000000-0000-4000-8000-000000000006";
const oldSourceId = "00000000-0000-4000-8000-000000000007";
const scheduleRevisionId = "00000000-0000-4000-8000-000000000008";
const now = new Date("2026-08-21T12:00:00.000Z");

function snapshot(
  overrides: Partial<ProviderSourceLifecycleSnapshot> = {},
): ProviderSourceLifecycleSnapshot {
  return {
    organizationId,
    providerId,
    provider: "courtyard",
    sourceInstanceId: sourceId,
    sourceRevisionId,
    connectionProfileId: profileId,
    connectionRevisionId,
    sourceTypeKey: "dataforrest-events-v1",
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    state: "paused",
    pauseRequested: false,
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
    scheduleRevisionId,
    intervalSeconds: 60,
    checkpointGeneration: 3n,
    checkpointFingerprint: "a".repeat(64),
    hasActiveRun: false,
    ...overrides,
  };
}

class MemoryLifecycleRepository
  implements ProviderSourceLifecycleAdminRepository {
  source = snapshot();
  createInput: Parameters<ProviderSourceLifecycleAdminRepository["createSource"]>[0] | null = null;
  resetInput: Parameters<ProviderSourceLifecycleAdminRepository["resetCheckpoint"]>[0] | null = null;

  async loadProvider(input: { organizationId: string; providerId: string }) {
    return input.organizationId === organizationId && input.providerId === providerId
      ? { organizationId, providerId, provider: "courtyard" }
      : null;
  }

  async loadConnectionProfile(input: {
    organizationId: string;
    connectionProfileId: string;
  }) {
    return input.organizationId === organizationId &&
        input.connectionProfileId === profileId
      ? {
          organizationId,
          connectionProfileId: profileId,
          sourceTypeKey: "dataforrest-events-v1",
          state: "active" as const,
          activeRevisionId: connectionRevisionId,
        }
      : null;
  }

  async createSource(input: Parameters<
    ProviderSourceLifecycleAdminRepository["createSource"]
  >[0]) {
    this.createInput = input;
    return { sourceInstanceId: sourceId, sourceRevisionId };
  }

  async loadSource(input: {
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
  }) {
    if (
      input.organizationId !== organizationId ||
      input.providerId !== providerId ||
      ![sourceId, oldSourceId].includes(input.sourceInstanceId)
    ) return null;
    return { ...this.source, sourceInstanceId: input.sourceInstanceId };
  }

  async requestSourceTest() {
    return { jobId: "00000000-0000-4000-8000-000000000009" };
  }

  async reviseInterval() {
    return { scheduleRevisionId: "00000000-0000-4000-8000-000000000010" };
  }

  async requestPause() {
    return { state: "paused" as const };
  }

  async resume() {}
  async disable() {}

  async resetCheckpoint(input: Parameters<
    ProviderSourceLifecycleAdminRepository["resetCheckpoint"]
  >[0]) {
    this.resetInput = input;
    return input.expectedGeneration + 1n;
  }
}

function fixture() {
  const repository = new MemoryLifecycleRepository();
  let activationInput: unknown = null;
  const activation = {
    async activatePaused(input: unknown) {
      activationInput = input;
      return {};
    },
  } as ProviderSourceActivationService;
  const sourceAdapters = createProductionSourceAdapterRegistry();
  const service = new ProviderSourceLifecycleService({
    repository,
    activation,
    sourceAdapters,
    adminConfigurationCodecs:
      createProductionSourceAdminConfigurationCodecRegistry(sourceAdapters),
    mapperDescriptors: new SourceMapperDescriptorRegistry(),
    clock: { now: () => now },
  });
  return {
    repository,
    service,
    activationInput: () => activationInput,
  };
}

const sourceRequest = {
  providerId,
  connectionProfileId: profileId,
  sourceTypeKey: "dataforrest-events-v1" as const,
  mapperKey: "courtyard-provider-observation",
  mapperVersion: "1",
  intervalSeconds: 60,
};

test("source creation derives the immutable platform filter and contract-only mapper pins", async () => {
  const { repository, service } = fixture();
  const created = await service.createSource(
    { organizationId, actorKey: "operator-admin" },
    sourceRequest,
  );
  assert.equal(created.sourceInstanceId, sourceId);
  assert.deepEqual(repository.createInput?.configuration, {
    platform: "courtyard",
  });
  assert.equal(
    repository.createInput?.normalizedContractVersion,
    PROVIDER_OBSERVATION_CONTRACT_VERSION,
  );
  assert.equal(
    repository.createInput?.identityNamespaceKey,
    providerIdentityNamespaceByLaunchProvider.courtyard,
  );
  assert.deepEqual(repository.createInput?.recordIdScopes, [
    "catalog-pack-v1",
    "catalog-card-v1",
    "pull-v1",
    "trade-v1",
  ]);

  await assert.rejects(
    service.createSource(
      { organizationId, actorKey: "operator-admin" },
      { ...sourceRequest, mapperKey: "collector-crypt-provider-observation" },
    ),
    /invalid_source_configuration/u,
  );
});

test("a replacement requires an idle paused or disabled compatible predecessor and always creates a fresh source", async () => {
  const { repository, service } = fixture();
  repository.source = snapshot({
    sourceInstanceId: oldSourceId,
    state: "active",
    hasActiveRun: true,
  });
  await assert.rejects(
    service.createReplacement(
      { organizationId, actorKey: "operator-admin" },
      { ...sourceRequest, replacesSourceInstanceId: oldSourceId },
    ),
    /source_conflict/u,
  );
  repository.source = snapshot({
    sourceInstanceId: oldSourceId,
    state: "disabled",
    hasActiveRun: false,
  });
  const replacement = await service.createReplacement(
    { organizationId, actorKey: "operator-admin" },
    { ...sourceRequest, replacesSourceInstanceId: oldSourceId },
  );
  assert.equal(replacement.sourceInstanceId, sourceId);
  assert.equal(repository.createInput?.replacesSourceInstanceId, oldSourceId);
  assert.notEqual(replacement.sourceInstanceId, oldSourceId);
});

test("activation delegates exact tested pins and checkpoint reset binds preview generation, fingerprint, and typed provider", async () => {
  const { repository, service, activationInput } = fixture();
  await service.activatePaused(
    { organizationId, actorKey: "operator-admin" },
    providerId,
    sourceId,
    {
      expectedSourceRevisionId: sourceRevisionId,
      expectedConnectionRevisionId: connectionRevisionId,
    },
  );
  assert.deepEqual(activationInput(), {
    organizationId,
    providerId,
    sourceInstanceId: sourceId,
    sourceRevisionId,
    connectionRevisionId,
    actorKey: "operator-admin",
    activatedAt: now,
  });
  const preview = await service.previewCheckpointReset(
    { organizationId, actorKey: "operator-admin" },
    providerId,
    sourceId,
    { expectedSourceRevisionId: sourceRevisionId },
  );
  assert.equal(preview.confirmation, "RESET COURTYARD");
  await assert.rejects(
    service.resetCheckpoint(
      { organizationId, actorKey: "operator-admin" },
      providerId,
      sourceId,
      {
        expectedSourceRevisionId: sourceRevisionId,
        expectedCheckpointGeneration: "3",
        expectedCheckpointFingerprint: "b".repeat(64),
        confirmation: preview.confirmation,
      },
    ),
    /reset_confirmation_required/u,
  );
  const reset = await service.resetCheckpoint(
    { organizationId, actorKey: "operator-admin" },
    providerId,
    sourceId,
    {
      expectedSourceRevisionId: sourceRevisionId,
      expectedCheckpointGeneration: preview.checkpointGeneration,
      expectedCheckpointFingerprint: preview.checkpointFingerprint,
      confirmation: preview.confirmation,
    },
  );
  assert.equal(reset.checkpointGeneration, "4");
  assert.equal(repository.resetInput?.expectedFingerprint, "a".repeat(64));
});
