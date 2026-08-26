import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
  DATAFORREST_EVENTS_V1_CONNECTION_TYPE_KEY,
  DATAFORREST_EVENTS_V1_ENDPOINT,
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  launchRecordIdScopeDeclarations,
  providerIdentityNamespaceByLaunchProvider,
  type LaunchProviderKey,
  type SourceAdapterManifestV1,
} from "@packscout/contracts";
import { DataforrestEventsSourceAdapter } from "./dataforrest-events-source-adapter.ts";
import {
  ProviderSourceActivationError,
  ProviderSourceActivationService,
  hashProviderSourceConfiguration,
  type ActivateProviderSourcePausedExactInput,
  type ActivateProviderSourceRequest,
  type ProviderSourceActivationCandidate,
  type ProviderSourceActivationRepository,
  type ResolvedSourceConnectionConfiguration,
  type SourceConnectionConfigurationResolver,
} from "./provider-source-activation-service.ts";
import {
  SourceAdapterRegistry,
  SourceAdapterRegistryError,
} from "./source-adapter-registry.ts";
import type { SourceAdapter } from "./source-adapter.ts";
import {
  SourceMapperDescriptorError,
  SourceMapperDescriptorRegistry,
  launchSourceMapperDescriptors,
  type SourceMapperDescriptor,
} from "./source-mapper-descriptors.ts";

const activatedAt = new Date("2026-08-21T12:00:00.000Z");
const providerId = "00000000-0000-4000-8000-000000000001";
const sourceInstanceId = "00000000-0000-4000-8000-000000000002";
const sourceRevisionId = "00000000-0000-4000-8000-000000000003";
const connectionProfileId = "00000000-0000-4000-8000-000000000004";
const connectionRevisionId = "00000000-0000-4000-8000-000000000005";
const organizationId = "00000000-0000-4000-8000-000000000006";
const connectionFingerprint = "a".repeat(64);

const mapperKeyByProvider = Object.freeze({
  courtyard: "courtyard-provider-observation",
  collector_crypt: "collector-crypt-provider-observation",
  phygitals: "phygitals-provider-observation",
  clutchpacks: "clutchpacks-provider-observation",
} as const);

function sourceConfiguration(provider: LaunchProviderKey) {
  return { platform: provider } as const;
}

function validCandidate(
  provider: LaunchProviderKey = "courtyard",
): ProviderSourceActivationCandidate {
  const configuration = sourceConfiguration(provider);
  return {
    organizationId,
    provider: { id: providerId, platformKey: provider },
    sourceInstance: {
      id: sourceInstanceId,
      state: "draft",
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      connectionProfileId,
      activeRevisionId: sourceRevisionId,
    },
    sourceRevision: {
      id: sourceRevisionId,
      providerId,
      connectionProfileId,
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      mapperKey: mapperKeyByProvider[provider],
      mapperVersion: "1",
      identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
      cursorCodecVersion: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
      configuration,
      configurationHash: hashProviderSourceConfiguration(configuration),
      recordIdScopes: launchRecordIdScopeDeclarations.map(
        ({ recordIdScopeKey }) => recordIdScopeKey,
      ),
    },
    connectionProfile: {
      id: connectionProfileId,
      state: "active",
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      connectionTypeKey: DATAFORREST_EVENTS_V1_CONNECTION_TYPE_KEY,
      requestLimit: 2,
      activeRevisionId: connectionRevisionId,
    },
    connectionRevision: {
      id: connectionRevisionId,
      state: "active",
      sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
      sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      configurationFingerprint: connectionFingerprint,
      revokedAt: null,
    },
    cursor: {
      sourceRevisionId,
      sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      cursorCodecVersion: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
      cursorGeneration: 1n,
      cursorFingerprint: null,
      hasCursor: false,
      advancedByRunId: null,
      advancedByPageId: null,
    },
  };
}

const request: ActivateProviderSourceRequest = {
  organizationId,
  providerId,
  sourceInstanceId,
  sourceRevisionId,
  connectionRevisionId,
  actorKey: "operator-admin",
  activatedAt,
};

class RecordingRepository implements ProviderSourceActivationRepository {
  readonly activations: ActivateProviderSourcePausedExactInput[] = [];

  constructor(readonly candidate: ProviderSourceActivationCandidate | null) {}

  loadSourceActivationCandidate(): Promise<ProviderSourceActivationCandidate | null> {
    return Promise.resolve(this.candidate);
  }

  activateSourcePausedExact(
    input: ActivateProviderSourcePausedExactInput,
  ): Promise<void> {
    this.activations.push(input);
    return Promise.resolve();
  }
}

class RecordingConnectionResolver
implements SourceConnectionConfigurationResolver {
  readonly requests: Array<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    configurationFingerprint: string;
  }> = [];

  constructor(readonly result: ResolvedSourceConnectionConfiguration) {}

  resolveSourceConnectionConfiguration(input: {
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    configurationFingerprint: string;
  }): Promise<ResolvedSourceConnectionConfiguration> {
    this.requests.push(input);
    return Promise.resolve(this.result);
  }
}

function validResolvedConnection(
  overrides: Partial<ResolvedSourceConnectionConfiguration> = {},
): ResolvedSourceConnectionConfiguration {
  return {
    organizationId,
    connectionProfileId,
    connectionRevisionId,
    configurationFingerprint: connectionFingerprint,
    configuration: {
      endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
      bearerToken: "fixture-secret-never-persisted",
    },
    ...overrides,
  };
}

function adapterWithManifest(manifest: SourceAdapterManifestV1): SourceAdapter {
  const delegate = new DataforrestEventsSourceAdapter();
  return {
    manifest,
    validateConnectionConfiguration:
      delegate.validateConnectionConfiguration.bind(delegate),
    validateSourceConfiguration: delegate.validateSourceConfiguration.bind(delegate),
    captureUnboundRequest: delegate.captureUnboundRequest.bind(delegate),
    interpretConnectionTest: delegate.interpretConnectionTest.bind(delegate),
    interpretSourceTest: delegate.interpretSourceTest.bind(delegate),
    interpretPage: delegate.interpretPage.bind(delegate),
    cancelRequest: delegate.cancelRequest.bind(delegate),
  };
}

function buildService(input: Readonly<{
  candidate?: ProviderSourceActivationCandidate | null;
  resolvedConnection?: ResolvedSourceConnectionConfiguration;
  sourceAdapters?: SourceAdapterRegistry;
  mapperDescriptors?: SourceMapperDescriptorRegistry;
}> = {}) {
  const repository = new RecordingRepository(
    input.candidate === undefined ? validCandidate() : input.candidate,
  );
  const connectionConfigurations = new RecordingConnectionResolver(
    input.resolvedConnection ?? validResolvedConnection(),
  );
  const service = new ProviderSourceActivationService({
    repository,
    connectionConfigurations,
    sourceAdapters: input.sourceAdapters ?? new SourceAdapterRegistry([
      new DataforrestEventsSourceAdapter(),
    ]),
    mapperDescriptors: input.mapperDescriptors ??
      new SourceMapperDescriptorRegistry(),
  });
  return { service, repository, connectionConfigurations };
}

function withSourceConfiguration(
  candidate: ProviderSourceActivationCandidate,
  configuration: Readonly<Record<string, unknown>>,
): ProviderSourceActivationCandidate {
  return {
    ...candidate,
    sourceRevision: {
      ...candidate.sourceRevision,
      configuration,
      configurationHash: hashProviderSourceConfiguration(configuration),
    },
  };
}

test("activation resolves production pins and persists only the exact safe candidate", async () => {
  const { service, repository, connectionConfigurations } = buildService();
  const activated = await service.activatePaused(request);

  assert.equal(repository.activations.length, 1);
  assert.deepEqual(repository.activations[0], {
    organizationId,
    providerId,
    providerKey: "courtyard",
    sourceInstanceId,
    sourceRevisionId,
    sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
    sourceAdapterVersion: DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey:
      providerIdentityNamespaceByLaunchProvider.courtyard,
    cursorCodecVersion: DATAFORREST_EVENTS_V1_CURSOR_CODEC_KEY,
    sourceConfiguration: { platform: "courtyard" },
    sourceConfigurationHash: hashProviderSourceConfiguration({
      platform: "courtyard",
    }),
    recordIdScopes: launchRecordIdScopeDeclarations.map(
      ({ recordIdScopeKey }) => recordIdScopeKey,
    ),
    connectionProfileId,
    connectionTypeKey: DATAFORREST_EVENTS_V1_CONNECTION_TYPE_KEY,
    connectionRequestLimit: 2,
    connectionRevisionId,
    connectionConfigurationFingerprint: connectionFingerprint,
    cursorGeneration: 1n,
    actorKey: "operator-admin",
    activatedAt,
  });
  assert.deepEqual(connectionConfigurations.requests, [{
    organizationId,
    connectionProfileId,
    connectionRevisionId,
    configurationFingerprint: connectionFingerprint,
  }]);
  assert.deepEqual(activated.requestBounds,
    dataforrestEventsV1SourceAdapterManifest.requestBounds);
  assert.equal(activated.approvedAggregateRequestCap, 2);
  assert.equal(
    Object.hasOwn(repository.activations[0]!, "connectionConfiguration"),
    false,
  );
});

test("source configuration hashing is canonical and domain separated", () => {
  assert.equal(
    hashProviderSourceConfiguration({
      platform: "courtyard",
      nested: { second: 2, first: 1 },
    }),
    hashProviderSourceConfiguration({
      nested: { first: 1, second: 2 },
      platform: "courtyard",
    }),
  );
  assert.notEqual(
    hashProviderSourceConfiguration({ platform: "courtyard" }),
    hashProviderSourceConfiguration({ platform: "collector_crypt" }),
  );
});

test("activation rejects source hash, source schema, scope, connection type, cap, and cursor drift", async () => {
  const baseline = validCandidate();
  const invalidSource = withSourceConfiguration(baseline, {
    platform: "collector_crypt",
  });
  const cases = [
    {
      name: "source hash",
      candidate: {
        ...baseline,
        sourceRevision: {
          ...baseline.sourceRevision,
          configurationHash: "b".repeat(64),
        },
      },
      code: "source_configuration_invalid",
    },
    { name: "source schema", candidate: invalidSource,
      code: "source_configuration_invalid" },
    {
      name: "scope",
      candidate: {
        ...baseline,
        sourceRevision: {
          ...baseline.sourceRevision,
          recordIdScopes: ["catalog-pack-v1", "catalog-card-v1", "pull-v1"],
        },
      },
      code: "adapter_manifest_mismatch",
    },
    {
      name: "connection type",
      candidate: {
        ...baseline,
        connectionProfile: {
          ...baseline.connectionProfile,
          connectionTypeKey: "wrong-connection-v1",
        },
      },
      code: "adapter_manifest_mismatch",
    },
    {
      name: "connection cap above the frozen manifest cap",
      candidate: {
        ...baseline,
        connectionProfile: { ...baseline.connectionProfile, requestLimit: 3 },
      },
      code: "adapter_manifest_mismatch",
    },
    {
      name: "connection cap below the frozen manifest cap",
      candidate: {
        ...baseline,
        connectionProfile: { ...baseline.connectionProfile, requestLimit: 1 },
      },
      code: "adapter_manifest_mismatch",
    },
    {
      name: "cursor",
      candidate: {
        ...baseline,
        cursor: { ...baseline.cursor, cursorGeneration: 2n },
      },
      code: "adapter_manifest_mismatch",
    },
  ] as const;
  for (const fixture of cases) {
    const { service } = buildService({ candidate: fixture.candidate });
    await assert.rejects(
      service.activatePaused(request),
      (error: unknown) => error instanceof ProviderSourceActivationError
        && error.code === fixture.code,
      fixture.name,
    );
  }
});

test("activation rejects invalid or incorrectly bound resolved connection configuration", async () => {
  const cases = [
    {
      result: validResolvedConnection({
        connectionRevisionId: "00000000-0000-4000-8000-000000000099",
      }),
      code: "connection_configuration_resolution_mismatch",
    },
    {
      result: validResolvedConnection({
        configurationFingerprint: "b".repeat(64),
      }),
      code: "connection_configuration_resolution_mismatch",
    },
    {
      result: validResolvedConnection({
        configuration: {
          endpoint: DATAFORREST_EVENTS_V1_ENDPOINT,
          bearerToken: "",
        },
      }),
      code: "connection_configuration_invalid",
    },
  ] as const;
  for (const fixture of cases) {
    const { service, repository } = buildService({
      resolvedConnection: fixture.result,
    });
    await assert.rejects(
      service.activatePaused(request),
      (error: unknown) => error instanceof ProviderSourceActivationError
        && error.code === fixture.code,
    );
    assert.equal(repository.activations.length, 0);
  }
});

test("activation fails closed for unknown adapters and unsupported providers", async () => {
  const baseline = validCandidate();
  const unknownAdapterCandidate: ProviderSourceActivationCandidate = {
    ...baseline,
    sourceInstance: { ...baseline.sourceInstance, sourceTypeKey: "missing-source-v1" },
    sourceRevision: { ...baseline.sourceRevision, sourceTypeKey: "missing-source-v1" },
    connectionProfile: {
      ...baseline.connectionProfile,
      sourceTypeKey: "missing-source-v1",
    },
    connectionRevision: {
      ...baseline.connectionRevision,
      sourceTypeKey: "missing-source-v1",
    },
  };
  await assert.rejects(
    buildService({ candidate: unknownAdapterCandidate }).service.activatePaused(request),
    (error: unknown) => error instanceof SourceAdapterRegistryError
      && error.code === "unknown_source_type",
  );

  const courtyardOnlyManifest: SourceAdapterManifestV1 = {
    ...dataforrestEventsV1SourceAdapterManifest,
    supportedProviders:
      dataforrestEventsV1SourceAdapterManifest.supportedProviders.filter(
        ({ provider }) => provider === "courtyard",
      ),
  };
  const collectorCandidate = validCandidate("collector_crypt");
  await assert.rejects(
    buildService({
      candidate: collectorCandidate,
      sourceAdapters: new SourceAdapterRegistry([
        adapterWithManifest(courtyardOnlyManifest),
      ]),
    }).service.activatePaused(request),
    (error: unknown) => error instanceof SourceAdapterRegistryError
      && error.code === "unsupported_provider",
  );
});

test("activation requires the exact registered mapper provider, contract, and namespace", async () => {
  const baseline = validCandidate();
  const descriptor = launchSourceMapperDescriptors.find(
    ({ provider }) => provider === "courtyard",
  )!;
  const cases: Array<{
    descriptor: SourceMapperDescriptor;
    code: "provider_mismatch" | "normalized_contract_mismatch" |
      "identity_namespace_mismatch";
  }> = [
    {
      descriptor: { ...descriptor, provider: "collector_crypt" },
      code: "provider_mismatch",
    },
    {
      descriptor: {
        ...descriptor,
        normalizedContractVersion: "packscout.provider-observation.v2",
      } as unknown as SourceMapperDescriptor,
      code: "normalized_contract_mismatch",
    },
    {
      descriptor: { ...descriptor, identityNamespaceKey: "wrong-namespace-v1" },
      code: "identity_namespace_mismatch",
    },
  ];
  for (const fixture of cases) {
    const mapperDescriptors = new SourceMapperDescriptorRegistry([
      fixture.descriptor,
    ]);
    await assert.rejects(
      buildService({ candidate: baseline, mapperDescriptors }).service
        .activatePaused(request),
      (error: unknown) => error instanceof SourceMapperDescriptorError
        && error.code === fixture.code,
    );
  }

  await assert.rejects(
    buildService({
      candidate: {
        ...baseline,
        sourceRevision: {
          ...baseline.sourceRevision,
          mapperKey: "missing-mapper-v1",
        },
      },
    }).service.activatePaused(request),
    (error: unknown) => error instanceof SourceMapperDescriptorError
      && error.code === "unknown_mapper_descriptor",
  );
});

test("activation rejects adapter request bounds outside the launch envelope", async () => {
  const oversizedManifest: SourceAdapterManifestV1 = {
    ...dataforrestEventsV1SourceAdapterManifest,
    requestBounds: {
      ...dataforrestEventsV1SourceAdapterManifest.requestBounds,
      pageLimit:
        dataforrestEventsV1SourceAdapterManifest.requestBounds.pageLimit + 1,
    },
  };
  const { service } = buildService({
    sourceAdapters: new SourceAdapterRegistry([
      adapterWithManifest(oversizedManifest),
    ]),
  });
  await assert.rejects(
    service.activatePaused(request),
    (error: unknown) => error instanceof ProviderSourceActivationError
      && error.code === "adapter_manifest_mismatch",
  );
});
