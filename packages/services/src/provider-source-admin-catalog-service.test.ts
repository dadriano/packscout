import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
} from "@packscout/contracts";
import {
  ProviderSourceAdminCatalogService,
  type ProviderSourceAdminCatalogRepository,
} from "./provider-source-admin-catalog-service.ts";
import {
  createProductionSourceAdapterRegistry,
  createProductionSourceAdminConfigurationCodecRegistry,
} from "./production-source-adapter-registry.ts";
import { SourceMapperDescriptorRegistry } from "./source-mapper-descriptors.ts";

function sourceRegistries(
  mapperDescriptors = new SourceMapperDescriptorRegistry(),
) {
  const adapters = createProductionSourceAdapterRegistry();
  return {
    sourceAdapters: adapters,
    adminConfigurationCodecs:
      createProductionSourceAdminConfigurationCodecRegistry(adapters),
    mapperDescriptors,
  };
}

const organizationId = "00000000-0000-4000-8000-000000000001";
const providerId = "00000000-0000-4000-8000-000000000002";
const profileId = "00000000-0000-4000-8000-000000000003";
const connectionRevisionId = "00000000-0000-4000-8000-000000000004";
const sourceId = "00000000-0000-4000-8000-000000000005";
const sourceRevisionId = "00000000-0000-4000-8000-000000000006";
const scheduleRevisionId = "00000000-0000-4000-8000-000000000007";
const now = new Date("2026-08-21T12:00:00.000Z");

function repository(
  sourceTypeKey: string = DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
) {
  const requestedScopes: string[] = [];
  const value: ProviderSourceAdminCatalogRepository = {
    async listProviders(scope) {
      requestedScopes.push(scope);
      return [{ id: providerId, provider: "courtyard" }];
    },
    async listConnections(scope) {
      requestedScopes.push(scope);
      return [{
        id: profileId,
        displayName: "Shared DataForrest",
        sourceTypeKey,
        connectionTypeKey: "dataforrest-events-connection-v1",
        state: "active",
        requestLimit: 2,
        activeRevisionId: connectionRevisionId,
        recoveryFence: null,
        revision: {
          id: connectionRevisionId,
          revisionNumber: 1,
          sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
          state: "active",
          configurationFingerprint: "a".repeat(64),
          encryptionKeyVersion: 1,
          healthGeneration: 0n,
          revokedAt: null,
          createdAt: now,
        },
        test: {
          jobId: null,
          connectionRevisionId: null,
          expectedHealthGeneration: null,
          resultingHealthGeneration: null,
          state: null,
          outcome: null,
          safeCode: null,
          requestedAt: null,
          testedAt: null,
        },
        createdAt: now,
        updatedAt: now,
      }];
    },
    async listSources(scope) {
      requestedScopes.push(scope);
      return [{
        providerId,
        provider: "courtyard",
        sourceInstanceId: sourceId,
        sourceRevisionId,
        sourceTypeKey,
        sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
        connectionProfileId: profileId,
        connectionRevisionId,
        connectionHealthGeneration: 0n,
        state: "paused",
        pauseRequested: false,
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
        mapperKey: "courtyard-provider-observation",
        mapperVersion: "1",
        identityNamespaceKey: "dataforrest-courtyard-records-v1",
        recordIdScopes: [
          "catalog-pack-v1",
          "catalog-card-v1",
          "pull-v1",
          "trade-v1",
        ],
        intervalSeconds: 60,
        freshnessGraceSeconds: 900,
        scheduleRevisionId,
        cursorGeneration: 1n,
        cursorFingerprint: null,
        test: {
          jobId: connectionRevisionId,
          connectionRevisionId,
          expectedHealthGeneration: 0n,
          resultingHealthGeneration: null,
          state: "queued",
          outcome: null,
          safeCode: null,
          requestedAt: now,
          testedAt: null,
        },
        createdAt: now,
        updatedAt: now,
      }];
    },
  };
  return { value, requestedScopes };
}

test("catalog advertises current v2 while retaining masked v1 connection and source history", async () => {
  const records = repository();
  const resolutionInputs: unknown[] = [];
  const service = new ProviderSourceAdminCatalogService({
    ...sourceRegistries(),
    repository: records.value,
    availableSourceTypes: [{
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      label: "DataForrest events",
    }],
    connectionConfigurations: {
      async resolveSourceConnectionConfiguration(input) {
        resolutionInputs.push(input);
        return {
          ...input,
          configuration: {
            endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
            bearerToken: "must-never-leave-the-service",
          },
        };
      },
    },
  });

  const catalog = await service.getCatalog({
    organizationId,
    actorKey: "actor:v1:safe",
  });
  assert.deepEqual(records.requestedScopes, [organizationId, organizationId, organizationId]);
  assert.deepEqual(resolutionInputs, [{
    organizationId,
    connectionProfileId: profileId,
    connectionRevisionId,
    configurationFingerprint: "a".repeat(64),
  }]);
  assert.deepEqual(catalog.availableSourceTypes, [{
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    sourceAdapterVersion: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
    label: "DataForrest events",
  }]);
  assert.deepEqual(catalog.providers[0]?.sourceRegistration, {
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    sourceAdapterVersion: DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: "dataforrest-courtyard-records-v1",
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
  });
  assert.equal(catalog.connections[0]?.latestRevision.endpointHost,
    "198.204.245.26.sslip.io");
  assert.equal(catalog.connections[0]?.latestRevision.credentialMask, "••••••••");
  assert.equal(catalog.sources[0]?.test.state, "pending");
  assert.equal(
    catalog.sources[0]?.sourceAdapterVersion,
    DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  );
  assert.equal(catalog.sources[0]?.cursor.resumeLabel, "Feed start");
  assert.equal(JSON.stringify(catalog).includes("must-never-leave"), false);
  assert.equal(JSON.stringify(catalog).includes("/v1/events"), false);
});

test("catalog filters non-production source evidence without letting it poison the production response", async () => {
  const records = repository("test-only-source");
  const service = new ProviderSourceAdminCatalogService({
    ...sourceRegistries(),
    repository: records.value,
    availableSourceTypes: [{
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      label: "DataForrest events",
    }],
    connectionConfigurations: {
      async resolveSourceConnectionConfiguration(input) {
        return {
          ...input,
          configuration: {
            endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
            bearerToken: "secret",
          },
        };
      },
    },
  });

  const catalog = await service.getCatalog({
    organizationId,
    actorKey: "actor:v1:safe",
  });
  assert.deepEqual(catalog.connections, []);
  assert.deepEqual(catalog.sources, []);
});

test("catalog marks a successful source test stale after the exact connection health generation changes", async () => {
  const records = repository();
  const staleRepository: ProviderSourceAdminCatalogRepository = {
    ...records.value,
    async listSources(scope) {
      return (await records.value.listSources(scope)).map((source) => ({
        ...source,
        connectionHealthGeneration: 1n,
        test: {
          ...source.test,
          state: "succeeded" as const,
          outcome: "success",
          expectedHealthGeneration: 0n,
          resultingHealthGeneration: 0n,
          testedAt: now,
        },
      }));
    },
  };
  const service = new ProviderSourceAdminCatalogService({
    ...sourceRegistries(),
    repository: staleRepository,
    availableSourceTypes: [{
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      label: "DataForrest events",
    }],
    connectionConfigurations: {
      async resolveSourceConnectionConfiguration(input) {
        return {
          ...input,
          configuration: {
            endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
            bearerToken: "secret",
          },
        };
      },
    },
  });

  const catalog = await service.getCatalog({
    organizationId,
    actorKey: "actor:v1:safe",
  });
  assert.equal(catalog.sources[0]?.test.state, "succeeded");
  assert.equal(catalog.sources[0]?.test.current, false);
});

test("catalog omits providers and sources without an authoritative compatible mapper descriptor", async () => {
  const records = repository();
  const service = new ProviderSourceAdminCatalogService({
    ...sourceRegistries(new SourceMapperDescriptorRegistry([])),
    repository: records.value,
    availableSourceTypes: [{
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      label: "DataForrest events",
    }],
    connectionConfigurations: {
      async resolveSourceConnectionConfiguration(input) {
        return {
          ...input,
          configuration: {
            endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
            bearerToken: "secret",
          },
        };
      },
    },
  });

  const catalog = await service.getCatalog({
    organizationId,
    actorKey: "actor:v1:safe",
  });
  assert.deepEqual(catalog.providers, []);
  assert.deepEqual(catalog.sources, []);
});
