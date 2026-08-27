import { createHash } from "node:crypto";
import {
  launchProviderKeySchema,
  providerSourceLaunchBounds,
  type LaunchProviderKey,
  type ProviderSourceRequestBounds,
} from "@packscout/contracts";
import { SourceAdapterRegistry } from "./source-adapter-registry.ts";
import {
  SourceMapperDescriptorRegistry,
  type SourceMapperDescriptor,
} from "./source-mapper-descriptors.ts";

const SHA_256_PATTERN = /^[0-9a-f]{64}$/u;
export const PROVIDER_SOURCE_CONFIGURATION_HASH_DOMAIN =
  "packscout.provider-source-configuration.v1" as const;

export interface ProviderSourceActivationCandidate {
  readonly organizationId: string;
  readonly provider: Readonly<{ id: string; platformKey: string }>;
  readonly sourceInstance: Readonly<{
    id: string;
    state: string;
    sourceTypeKey: string;
    connectionProfileId: string;
    activeRevisionId: string;
  }>;
  readonly sourceRevision: Readonly<{
    id: string;
    providerId: string;
    connectionProfileId: string;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    normalizedContractVersion: string;
    mapperKey: string;
    mapperVersion: string;
    identityNamespaceKey: string;
    cursorCodecVersion: string;
    configuration: unknown;
    configurationHash: string;
    recordIdScopes: unknown;
  }>;
  readonly connectionProfile: Readonly<{
    id: string;
    state: string;
    sourceTypeKey: string;
    connectionTypeKey: string;
    requestLimit: number;
    activeRevisionId: string;
  }>;
  readonly connectionRevision: Readonly<{
    id: string;
    state: string;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    configurationFingerprint: string;
    revokedAt: Date | null;
  }>;
  readonly cursor: Readonly<{
    sourceRevisionId: string;
    sourceAdapterVersion: string;
    cursorCodecVersion: string;
    cursorGeneration: bigint;
    cursorFingerprint: string | null;
    hasCursor: boolean;
    advancedByRunId: string | null;
    advancedByPageId: string | null;
  }>;
}

export interface ActivateProviderSourcePausedExactInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly cursorCodecVersion: string;
  readonly sourceConfiguration: Readonly<Record<string, unknown>>;
  readonly sourceConfigurationHash: string;
  readonly recordIdScopes: readonly string[];
  readonly connectionProfileId: string;
  readonly connectionTypeKey: string;
  readonly connectionRequestLimit: number;
  readonly connectionRevisionId: string;
  readonly connectionConfigurationFingerprint: string;
  readonly cursorGeneration: bigint;
  readonly actorKey: string;
  readonly activatedAt: Date;
}

export interface ProviderSourceActivationRepository {
  loadSourceActivationCandidate(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    connectionRevisionId: string;
  }>): Promise<ProviderSourceActivationCandidate | null>;
  activateSourcePausedExact(
    input: ActivateProviderSourcePausedExactInput,
  ): Promise<void>;
}

export interface ResolvedSourceConnectionConfiguration {
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly configurationFingerprint: string;
  readonly configuration: unknown;
}

export interface SourceConnectionConfigurationResolver {
  resolveSourceConnectionConfiguration(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    configurationFingerprint: string;
  }>): Promise<ResolvedSourceConnectionConfiguration>;
}

export type ProviderSourceActivationErrorCode =
  | "activation_candidate_invalid"
  | "activation_candidate_not_found"
  | "adapter_manifest_mismatch"
  | "connection_configuration_invalid"
  | "connection_configuration_resolution_mismatch"
  | "source_configuration_invalid";

export class ProviderSourceActivationError extends Error {
  constructor(readonly code: ProviderSourceActivationErrorCode) {
    super(`provider_source_activation.${code}`);
    this.name = "ProviderSourceActivationError";
  }
}

export interface ActivatedProviderSourceContract {
  readonly provider: LaunchProviderKey;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapper: SourceMapperDescriptor;
  readonly identityNamespaceKey: string;
  readonly cursorCodecVersion: string;
  readonly requestBounds: ProviderSourceRequestBounds;
  readonly approvedAggregateRequestCap: number;
}

export interface ProviderSourceActivationServiceDependencies {
  readonly repository: ProviderSourceActivationRepository;
  readonly connectionConfigurations: SourceConnectionConfigurationResolver;
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly mapperDescriptors: SourceMapperDescriptorRegistry;
}

export interface ActivateProviderSourceRequest {
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly connectionRevisionId: string;
  readonly actorKey: string;
  readonly activatedAt: Date;
}

function refuse(code: ProviderSourceActivationErrorCode): never {
  throw new ProviderSourceActivationError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isPlainRecord(value)) refuse("activation_candidate_invalid");
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function canonicalConfiguration(value: unknown): Readonly<Record<string, unknown>> {
  const canonical = canonicalJsonValue(value);
  if (!isPlainRecord(canonical)) refuse("activation_candidate_invalid");
  return deepFreezeJson(canonical);
}

function deepFreezeJson<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreezeJson(nested);
  return Object.freeze(value);
}

export function hashProviderSourceConfiguration(
  value: Readonly<Record<string, unknown>>,
): string {
  const canonical = canonicalConfiguration(value);
  return createHash("sha256")
    .update(PROVIDER_SOURCE_CONFIGURATION_HASH_DOMAIN)
    .update("\0")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(canonicalJsonValue(left)) ===
      JSON.stringify(canonicalJsonValue(right));
  } catch {
    return false;
  }
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requireCandidateScope(
  candidate: ProviderSourceActivationCandidate,
  input: ActivateProviderSourceRequest,
): void {
  if (
    candidate.organizationId !== input.organizationId
    || candidate.provider.id !== input.providerId
    || candidate.sourceInstance.id !== input.sourceInstanceId
    || candidate.sourceInstance.activeRevisionId !== input.sourceRevisionId
    || candidate.sourceRevision.id !== input.sourceRevisionId
    || candidate.connectionRevision.id !== input.connectionRevisionId
    || !["draft", "disabled"].includes(candidate.sourceInstance.state)
    || candidate.connectionProfile.state !== "active"
    || candidate.connectionRevision.state !== "active"
    || candidate.connectionRevision.revokedAt !== null
  ) refuse("activation_candidate_invalid");
}

function requireRelationalPins(candidate: ProviderSourceActivationCandidate): void {
  const { sourceInstance, sourceRevision, connectionProfile, connectionRevision } =
    candidate;
  if (
    sourceRevision.providerId !== candidate.provider.id
    || sourceRevision.connectionProfileId !== sourceInstance.connectionProfileId
    || connectionProfile.id !== sourceInstance.connectionProfileId
    || connectionRevision.id !== connectionProfile.activeRevisionId
    || sourceInstance.sourceTypeKey !== sourceRevision.sourceTypeKey
    || connectionProfile.sourceTypeKey !== sourceRevision.sourceTypeKey
    || connectionRevision.sourceTypeKey !== sourceRevision.sourceTypeKey
    || connectionRevision.sourceAdapterVersion !==
      sourceRevision.sourceAdapterVersion
    || !SHA_256_PATTERN.test(sourceRevision.configurationHash)
    || !SHA_256_PATTERN.test(connectionRevision.configurationFingerprint)
  ) refuse("activation_candidate_invalid");
}

function requireActivationCursor(candidate: ProviderSourceActivationCandidate): void {
  const { cursor, sourceRevision } = candidate;
  if (
    cursor.sourceRevisionId !== sourceRevision.id
    || cursor.sourceAdapterVersion !== sourceRevision.sourceAdapterVersion
    || cursor.cursorCodecVersion !== sourceRevision.cursorCodecVersion
  ) refuse("adapter_manifest_mismatch");
  if (
    candidate.sourceInstance.state === "draft" &&
    (cursor.cursorGeneration !== 1n
      || cursor.cursorFingerprint !== null
      || cursor.hasCursor
      || cursor.advancedByRunId !== null
      || cursor.advancedByPageId !== null)
  ) refuse("adapter_manifest_mismatch");
}

function requireRequestBoundsWithinLaunchEnvelope(
  requestBounds: ProviderSourceRequestBounds,
): void {
  if (
    requestBounds.pageLimit >
      providerSourceLaunchBounds.recordsPerRequest.maximum
    || requestBounds.maximumResponseBytes >
      providerSourceLaunchBounds.maximumResponseBytes
    || requestBounds.timeoutMilliseconds >
      providerSourceLaunchBounds.requestTimeoutMilliseconds
  ) refuse("adapter_manifest_mismatch");
}

export class ProviderSourceActivationService {
  readonly #repository: ProviderSourceActivationRepository;
  readonly #connectionConfigurations: SourceConnectionConfigurationResolver;
  readonly #sourceAdapters: SourceAdapterRegistry;
  readonly #mapperDescriptors: SourceMapperDescriptorRegistry;

  constructor(dependencies: ProviderSourceActivationServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#connectionConfigurations = dependencies.connectionConfigurations;
    this.#sourceAdapters = dependencies.sourceAdapters;
    this.#mapperDescriptors = dependencies.mapperDescriptors;
  }

  async activatePaused(
    input: ActivateProviderSourceRequest,
  ): Promise<ActivatedProviderSourceContract> {
    const candidate = await this.#repository.loadSourceActivationCandidate(input);
    if (!candidate) refuse("activation_candidate_not_found");
    requireCandidateScope(candidate, input);
    requireRelationalPins(candidate);

    const providerResult = launchProviderKeySchema.safeParse(
      candidate.provider.platformKey,
    );
    if (!providerResult.success) refuse("activation_candidate_invalid");
    const provider = providerResult.data;
    const revision = candidate.sourceRevision;
    const adapter = this.#sourceAdapters.resolve(
      revision.sourceTypeKey,
      revision.sourceAdapterVersion,
      provider,
    );
    const declaration = adapter.manifest.supportedProviders.find(
      (supported) => supported.provider === provider,
    );
    if (!declaration) refuse("adapter_manifest_mismatch");

    const persistedScopes = Array.isArray(revision.recordIdScopes)
      && revision.recordIdScopes.every((scope) => typeof scope === "string")
      ? revision.recordIdScopes
      : null;
    const manifestScopes = declaration.recordIdScopes.map(
      ({ recordIdScopeKey }) => recordIdScopeKey,
    );
    if (
      adapter.manifest.sourceTypeKey !== revision.sourceTypeKey
      || adapter.manifest.adapterVersion !== revision.sourceAdapterVersion
      || adapter.manifest.normalizedContractVersion !==
        revision.normalizedContractVersion
      || adapter.manifest.compatibleConnectionTypeKey !==
        candidate.connectionProfile.connectionTypeKey
      || adapter.manifest.cursorCodecKey !== revision.cursorCodecVersion
      || declaration.identityNamespaceKey !== revision.identityNamespaceKey
      || !persistedScopes
      || !sameSequence(persistedScopes, manifestScopes)
      || !Number.isInteger(candidate.connectionProfile.requestLimit)
      || candidate.connectionProfile.requestLimit !==
        adapter.manifest.maximumConnectionRequestCap
    ) refuse("adapter_manifest_mismatch");
    requireRequestBoundsWithinLaunchEnvelope(adapter.manifest.requestBounds);
    requireActivationCursor(candidate);

    const mapper = this.#mapperDescriptors.requireCompatible({
      mapperKey: revision.mapperKey,
      mapperVersion: revision.mapperVersion,
      provider,
      normalizedContractVersion: revision.normalizedContractVersion,
      identityNamespaceKey: revision.identityNamespaceKey,
      sourceTypeKey: revision.sourceTypeKey,
    });
    const sourceConfiguration = canonicalConfiguration(revision.configuration);
    if (
      hashProviderSourceConfiguration(sourceConfiguration) !==
        revision.configurationHash
    ) refuse("source_configuration_invalid");
    const validatedSource = adapter.validateSourceConfiguration(
      provider,
      sourceConfiguration,
    );
    if (!validatedSource.ok ||
        !sameJson(validatedSource.value, sourceConfiguration)) {
      refuse("source_configuration_invalid");
    }

    const resolvedConnection =
      await this.#connectionConfigurations.resolveSourceConnectionConfiguration({
        organizationId: input.organizationId,
        connectionProfileId: candidate.connectionProfile.id,
        connectionRevisionId: candidate.connectionRevision.id,
        configurationFingerprint:
          candidate.connectionRevision.configurationFingerprint,
      });
    if (
      resolvedConnection.organizationId !== input.organizationId
      || resolvedConnection.connectionProfileId !== candidate.connectionProfile.id
      || resolvedConnection.connectionRevisionId !== candidate.connectionRevision.id
      || resolvedConnection.configurationFingerprint !==
        candidate.connectionRevision.configurationFingerprint
    ) refuse("connection_configuration_resolution_mismatch");
    if (!adapter.validateConnectionConfiguration(
      resolvedConnection.configuration,
    ).ok) refuse("connection_configuration_invalid");

    await this.#repository.activateSourcePausedExact({
      organizationId: input.organizationId,
      providerId: input.providerId,
      providerKey: provider,
      sourceInstanceId: input.sourceInstanceId,
      sourceRevisionId: input.sourceRevisionId,
      sourceTypeKey: revision.sourceTypeKey,
      sourceAdapterVersion: revision.sourceAdapterVersion,
      normalizedContractVersion: revision.normalizedContractVersion,
      mapperKey: revision.mapperKey,
      mapperVersion: revision.mapperVersion,
      identityNamespaceKey: revision.identityNamespaceKey,
      cursorCodecVersion: revision.cursorCodecVersion,
      sourceConfiguration,
      sourceConfigurationHash: revision.configurationHash,
      recordIdScopes: persistedScopes,
      connectionProfileId: candidate.connectionProfile.id,
      connectionTypeKey: candidate.connectionProfile.connectionTypeKey,
      connectionRequestLimit: candidate.connectionProfile.requestLimit,
      connectionRevisionId: candidate.connectionRevision.id,
      connectionConfigurationFingerprint:
        candidate.connectionRevision.configurationFingerprint,
      cursorGeneration: candidate.cursor.cursorGeneration,
      actorKey: input.actorKey,
      activatedAt: input.activatedAt,
    });

    return Object.freeze({
      provider,
      sourceTypeKey: revision.sourceTypeKey,
      sourceAdapterVersion: revision.sourceAdapterVersion,
      normalizedContractVersion: revision.normalizedContractVersion,
      mapper,
      identityNamespaceKey: revision.identityNamespaceKey,
      cursorCodecVersion: revision.cursorCodecVersion,
      requestBounds: adapter.manifest.requestBounds,
      approvedAggregateRequestCap: candidate.connectionProfile.requestLimit,
    });
  }
}
