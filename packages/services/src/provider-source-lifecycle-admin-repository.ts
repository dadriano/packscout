import type { ProviderSourceActivationService } from "./provider-source-activation-service.ts";
import type { SourceAdapterRegistry } from "./source-adapter-registry.ts";
import type { SourceMapperDescriptorRegistry } from "./source-mapper-descriptors.ts";
import type { SourceAdminConfigurationCodecRegistry } from "./source-admin-configuration-codec.ts";

export interface ProviderSourceLifecycleSnapshot {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string | null;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly state: "draft" | "paused" | "active" | "disabled" | "replaced";
  readonly pauseRequested: boolean;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly normalizedContractVersion: string;
  readonly identityNamespaceKey: string;
  readonly recordIdScopes: readonly string[];
  readonly scheduleRevisionId: string;
  readonly intervalSeconds: number;
  readonly cursorGeneration: bigint;
  readonly cursorFingerprint: string | null;
  readonly hasActiveRun: boolean;
}

export interface ProviderSourceProfileBinding {
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly sourceTypeKey: string;
  readonly state: "draft" | "active" | "disabled";
  readonly activeRevisionId: string | null;
}

export interface ProviderSourceProviderRecord {
  readonly organizationId: string;
  readonly providerId: string;
  readonly provider: string;
}

export interface ProviderSourceLifecycleAdminRepository {
  loadProvider(input: Readonly<{ organizationId: string; providerId: string }>):
    Promise<ProviderSourceProviderRecord | null>;
  loadConnectionProfile(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
  }>): Promise<ProviderSourceProfileBinding | null>;
  createSource(input: Readonly<{
    organizationId: string;
    providerId: string;
    connectionProfileId: string;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    normalizedContractVersion: string;
    mapperKey: string;
    mapperVersion: string;
    identityNamespaceKey: string;
    cursorCodecVersion: string;
    configuration: Readonly<Record<string, unknown>>;
    configurationHash: string;
    recordIdScopes: readonly string[];
    intervalSeconds: number;
    replacesSourceInstanceId: string | null;
    replacementPredecessor: Readonly<{
      mapperKey: string;
      mapperVersion: string;
      normalizedContractVersion: string;
    }> | null;
    actorKey: string;
    createdAt: Date;
  }>): Promise<Readonly<{ sourceInstanceId: string; sourceRevisionId: string }>>;
  loadSource(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
  }>): Promise<ProviderSourceLifecycleSnapshot | null>;
  requestSourceTest(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    requestedByActorKey: string;
    requestedAt: Date;
  }>): Promise<{ readonly jobId: string }>;
  reviseInterval(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    expectedScheduleRevisionId: string;
    intervalSeconds: number;
    actorKey: string;
    effectiveAt: Date;
  }>): Promise<{ readonly scheduleRevisionId: string }>;
  requestPause(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    actorKey: string;
    requestedAt: Date;
  }>): Promise<{ readonly state: "paused" | "pause_requested" }>;
  resume(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    actorKey: string;
    resumedAt: Date;
  }>): Promise<void>;
  disable(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    actorKey: string;
    disabledAt: Date;
  }>): Promise<void>;
  resetCursor(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    expectedGeneration: bigint;
    expectedFingerprint: string | null;
    actorKey: string;
    resetAt: Date;
  }>): Promise<bigint>;
}

export interface ProviderSourceLifecycleServiceDependencies {
  readonly repository: ProviderSourceLifecycleAdminRepository;
  readonly activation: ProviderSourceActivationService;
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly mapperDescriptors: SourceMapperDescriptorRegistry;
  readonly adminConfigurationCodecs: SourceAdminConfigurationCodecRegistry;
  readonly clock?: Readonly<{ now(): Date }>;
}
