import {
  launchProviderKeySchema,
  providerSourceAdminCatalogSchema,
  type ProviderSourceAdminCatalog,
} from "@packscout/contracts";
import type {
  SourceConnectionConfigurationResolver,
} from "./provider-source-activation-service.ts";
import {
  type ProviderSourceAdminCommandContext,
  ProviderSourceAdminServiceError,
  requireProviderSourceAdminContext,
} from "./provider-source-admin-service-types.ts";
import type { SourceAdminConfigurationCodecRegistry } from "./source-admin-configuration-codec.ts";
import type { SourceAdapterRegistry } from "./source-adapter-registry.ts";
import type { SourceMapperDescriptorRegistry } from "./source-mapper-descriptors.ts";

type SourceTestJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "fenced";

interface TestRecord {
  readonly jobId: string | null;
  readonly connectionRevisionId: string | null;
  readonly expectedHealthGeneration: bigint | null;
  readonly resultingHealthGeneration: bigint | null;
  readonly state: SourceTestJobState | null;
  readonly outcome: string | null;
  readonly safeCode: string | null;
  readonly requestedAt: Date | null;
  readonly testedAt: Date | null;
}

export interface ProviderSourceAdminConnectionRecord {
  readonly id: string;
  readonly displayName: string;
  readonly sourceTypeKey: string;
  readonly connectionTypeKey: string;
  readonly state: "draft" | "active" | "disabled";
  readonly requestLimit: number;
  readonly activeRevisionId: string | null;
  readonly recoveryFence: Readonly<{
    blockedRevisionId: string;
    blockingEpisodeId: string | null;
  }> | null;
  readonly revision: Readonly<{
    id: string;
    revisionNumber: number;
    sourceAdapterVersion: string;
    state: "candidate" | "active" | "retired" | "revoked";
    configurationFingerprint: string;
    encryptionKeyVersion: number;
    healthGeneration: bigint;
    revokedAt: Date | null;
    createdAt: Date;
  }>;
  readonly test: TestRecord;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProviderSourceAdminSourceRecord {
  readonly providerId: string;
  readonly provider: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string | null;
  readonly connectionHealthGeneration: bigint | null;
  readonly state: "draft" | "paused" | "active" | "disabled" | "replaced";
  readonly pauseRequested: boolean;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly recordIdScopes: readonly string[];
  readonly intervalSeconds: number;
  readonly freshnessGraceSeconds: number;
  readonly scheduleRevisionId: string;
  readonly checkpointGeneration: bigint;
  readonly checkpointFingerprint: string | null;
  readonly test: TestRecord;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProviderSourceAdminCatalogRepository {
  listProviders(organizationId: string): Promise<readonly Readonly<{
    id: string;
    provider: string;
  }>[]>;
  listConnections(
    organizationId: string,
  ): Promise<readonly ProviderSourceAdminConnectionRecord[]>;
  listSources(
    organizationId: string,
  ): Promise<readonly ProviderSourceAdminSourceRecord[]>;
}

export interface ProviderSourceAdminCatalogServiceDependencies {
  readonly repository: ProviderSourceAdminCatalogRepository;
  readonly connectionConfigurations: SourceConnectionConfigurationResolver;
  readonly availableSourceTypes: readonly Readonly<{
    sourceTypeKey: string;
    label: string;
  }>[];
  readonly adminConfigurationCodecs: SourceAdminConfigurationCodecRegistry;
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly mapperDescriptors: SourceMapperDescriptorRegistry;
}

function testSummary(
  test: TestRecord,
  currentConnectionRevisionId: string | null,
  currentHealthGeneration: bigint | null,
) {
  const generationIsCurrent = currentHealthGeneration !== null &&
    test.expectedHealthGeneration === currentHealthGeneration &&
    (test.state !== "succeeded" ||
      test.resultingHealthGeneration === currentHealthGeneration);
  return {
    jobId: test.jobId,
    connectionRevisionId: test.connectionRevisionId,
    current: test.jobId !== null &&
      test.connectionRevisionId === currentConnectionRevisionId &&
      generationIsCurrent,
    state: test.state === null
      ? "not_requested" as const
      : test.state === "queued"
        ? "pending" as const
        : test.state,
    outcome: test.outcome,
    safeCode: test.safeCode,
    requestedAt: test.requestedAt?.toISOString() ?? null,
    testedAt: test.testedAt?.toISOString() ?? null,
  };
}

function upstreamFailure(): never {
  throw new ProviderSourceAdminServiceError("SOURCE_UPSTREAM_UNAVAILABLE", 503);
}

export class ProviderSourceAdminCatalogService {
  readonly #repository: ProviderSourceAdminCatalogRepository;
  readonly #configurations: SourceConnectionConfigurationResolver;
  readonly #availableSourceTypes: ProviderSourceAdminCatalogServiceDependencies[
    "availableSourceTypes"
  ];
  readonly #adminConfigurationCodecs: SourceAdminConfigurationCodecRegistry;
  readonly #sourceAdapters: SourceAdapterRegistry;
  readonly #mapperDescriptors: SourceMapperDescriptorRegistry;

  constructor(dependencies: ProviderSourceAdminCatalogServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#configurations = dependencies.connectionConfigurations;
    this.#availableSourceTypes = dependencies.availableSourceTypes;
    this.#adminConfigurationCodecs = dependencies.adminConfigurationCodecs;
    this.#sourceAdapters = dependencies.sourceAdapters;
    this.#mapperDescriptors = dependencies.mapperDescriptors;
  }

  async getCatalog(
    context: ProviderSourceAdminCommandContext,
  ): Promise<ProviderSourceAdminCatalog> {
    requireProviderSourceAdminContext(context);
    const [providers, connections, sources] = await Promise.all([
      this.#repository.listProviders(context.organizationId),
      this.#repository.listConnections(context.organizationId),
      this.#repository.listSources(context.organizationId),
    ]);
    const productionSourceTypes = new Set(
      this.#availableSourceTypes.map(({ sourceTypeKey }) => sourceTypeKey),
    );
    const visibleConnections = connections.filter(
      ({ sourceTypeKey }) => productionSourceTypes.has(sourceTypeKey),
    );
    const availableSourceType = this.#availableSourceTypes[0];
    if (!availableSourceType || this.#availableSourceTypes.length !== 1) {
      upstreamFailure();
    }
    let sourceAdapter;
    try {
      sourceAdapter = this.#sourceAdapters.resolveOnlyVersion(
        availableSourceType.sourceTypeKey,
      );
    } catch {
      upstreamFailure();
    }
    const visibleProviders = providers.flatMap((record) => {
      const parsedProvider = launchProviderKeySchema.safeParse(record.provider);
      if (!parsedProvider.success) return [];
      const provider = parsedProvider.data;
      const declaration = sourceAdapter.manifest.supportedProviders.find(
        (candidate) => candidate.provider === provider,
      );
      if (!declaration) return [];
      const descriptors = this.#mapperDescriptors.descriptors().filter(
        (candidate) =>
          candidate.provider === provider &&
          candidate.normalizedContractVersion ===
            sourceAdapter.manifest.normalizedContractVersion &&
          candidate.identityNamespaceKey === declaration.identityNamespaceKey,
      );
      if (descriptors.length !== 1) return [];
      const descriptor = descriptors[0]!;
      try {
        this.#mapperDescriptors.requireCompatible({
          mapperKey: descriptor.mapperKey,
          mapperVersion: descriptor.mapperVersion,
          provider,
          normalizedContractVersion:
            sourceAdapter.manifest.normalizedContractVersion,
          identityNamespaceKey: declaration.identityNamespaceKey,
          sourceTypeKey: sourceAdapter.manifest.sourceTypeKey,
        });
      } catch {
        return [];
      }
      return [{
        id: record.id,
        provider,
        sourceRegistration: {
          sourceTypeKey: sourceAdapter.manifest.sourceTypeKey,
          sourceAdapterVersion: sourceAdapter.manifest.adapterVersion,
          normalizedContractVersion:
            sourceAdapter.manifest.normalizedContractVersion,
          mapperKey: descriptor.mapperKey,
          mapperVersion: descriptor.mapperVersion,
          identityNamespaceKey: declaration.identityNamespaceKey,
          recordIdScopes: declaration.recordIdScopes.map(
            ({ recordIdScopeKey }) => recordIdScopeKey,
          ),
        },
      }];
    });
    const visibleProviderIds = new Set(visibleProviders.map(({ id }) => id));
    const visibleProviderById = new Map(
      visibleProviders.map((provider) => [provider.id, provider]),
    );
    const visibleSources = sources.filter((source) => {
      const visibleProvider = visibleProviderById.get(source.providerId);
      const registration = visibleProvider?.sourceRegistration;
      return productionSourceTypes.has(source.sourceTypeKey) &&
        visibleProviderIds.has(source.providerId) &&
        source.provider === visibleProvider?.provider &&
        registration?.sourceTypeKey === source.sourceTypeKey &&
        registration.sourceAdapterVersion === source.sourceAdapterVersion &&
        registration.normalizedContractVersion ===
          source.normalizedContractVersion &&
        registration.mapperKey === source.mapperKey &&
        registration.mapperVersion === source.mapperVersion &&
        registration.identityNamespaceKey === source.identityNamespaceKey &&
        registration.recordIdScopes.length === source.recordIdScopes.length &&
        registration.recordIdScopes.every(
          (scope, index) => scope === source.recordIdScopes[index],
        );
    });
    const connectionSummaries = await Promise.all(visibleConnections.map(async (record) => {
      const resolved = await this.#configurations.resolveSourceConnectionConfiguration({
        organizationId: context.organizationId,
        connectionProfileId: record.id,
        connectionRevisionId: record.revision.id,
        configurationFingerprint: record.revision.configurationFingerprint,
      });
      const configuration = resolved.configuration;
      if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) {
        upstreamFailure();
      }
      const description = this.#adminConfigurationCodecs.resolve(
        record.sourceTypeKey,
        record.revision.sourceAdapterVersion,
      ).describeConnection(configuration as Readonly<Record<string, unknown>>);
      if (!description) upstreamFailure();
      return {
        id: record.id,
        displayName: record.displayName,
        sourceTypeKey: record.sourceTypeKey,
        connectionTypeKey: record.connectionTypeKey,
        state: record.state,
        requestLimit: record.requestLimit,
        activeRevisionId: record.activeRevisionId,
        recoveryFence: record.recoveryFence,
        latestRevision: {
          id: record.revision.id,
          revisionNumber: record.revision.revisionNumber,
          sourceAdapterVersion: record.revision.sourceAdapterVersion,
          state: record.revision.state,
          endpointHost: description.endpointHost,
          credentialConfigured: true as const,
          credentialMask: "••••••••" as const,
          encryptionKeyVersion: record.revision.encryptionKeyVersion,
          healthGeneration: record.revision.healthGeneration.toString(),
          revokedAt: record.revision.revokedAt?.toISOString() ?? null,
          test: testSummary(
            record.test,
            record.revision.id,
            record.revision.healthGeneration,
          ),
          createdAt: record.revision.createdAt.toISOString(),
        },
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
    }));
    const candidate = {
      availableSourceTypes: this.#availableSourceTypes,
      providers: visibleProviders,
      connections: connectionSummaries,
      sources: visibleSources.map((record) => ({
        providerId: record.providerId,
        provider: record.provider,
        sourceInstanceId: record.sourceInstanceId,
        sourceRevisionId: record.sourceRevisionId,
        sourceTypeKey: record.sourceTypeKey,
        sourceAdapterVersion: record.sourceAdapterVersion,
        connectionProfileId: record.connectionProfileId,
        connectionRevisionId: record.connectionRevisionId,
        state: record.state,
        pauseRequested: record.pauseRequested,
        normalizedContractVersion: record.normalizedContractVersion,
        mapperKey: record.mapperKey,
        mapperVersion: record.mapperVersion,
        identityNamespaceKey: record.identityNamespaceKey,
        recordIdScopes: record.recordIdScopes,
        intervalSeconds: record.intervalSeconds,
        freshnessGraceSeconds: record.freshnessGraceSeconds,
        scheduleRevisionId: record.scheduleRevisionId,
        checkpoint: {
          generation: record.checkpointGeneration.toString(),
          fingerprint: record.checkpointFingerprint,
          resumeLabel: record.checkpointFingerprint === null
            ? "Feed start" as const
            : "Saved checkpoint" as const,
        },
        test: testSummary(
          record.test,
          record.connectionRevisionId,
          record.connectionHealthGeneration,
        ),
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      })),
    };
    const parsed = providerSourceAdminCatalogSchema.safeParse(candidate);
    if (!parsed.success) upstreamFailure();
    return parsed.data;
  }
}
