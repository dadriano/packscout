import {
  createProviderRequestSchema,
  replaceProviderRevisionRequestSchema,
  type CreateProviderRequest,
  type NormalizedCreateProviderRequest,
  type NormalizedReplaceProviderRevisionRequest,
  type ProviderConfigurationErrorCode,
  type ProviderConfigurationSummary,
  type ProviderConnectionTestSummary,
  type ReplaceProviderRevisionRequest,
} from "@packscout/contracts";
import {
  ProviderAdapterRegistryError,
  ProviderTransportAdapterRegistry,
} from "./provider-adapter-registry.ts";
import type {
  NormalizedProviderTransportFailure,
  ProviderConnectionTestResult,
} from "./provider-adapter.ts";
import type {
  EncryptedProviderCredential,
  ProviderCredentialCipher,
  ProviderCredentialScope,
} from "./provider-credential-cipher.ts";
import {
  ProviderEndpointPolicyError,
  validateProviderEndpoint,
  type ProviderRuntimeEnvironment,
} from "./provider-endpoint-policy.ts";

export interface ProviderActor {
  readonly operatorId: string;
  readonly organizationId: string;
  readonly role: "admin" | "data_operator";
}

export interface ProviderClock {
  now(): Date;
}

export interface ProviderIdSource {
  id(): string;
}

export interface ProviderActorKeyer {
  keyFor(input: { organizationId: string; operatorId: string }): string;
}

export interface InternalProviderRevision {
  readonly providerId: string;
  readonly revisionId: string;
  readonly organizationId: string;
  readonly platformKey: string;
  readonly adapterKey: string;
  readonly endpoint: string;
  readonly authMode: "none" | "bearer";
  readonly scheduleSeconds: number;
  readonly encryptedCredential: EncryptedProviderCredential | null;
}

export interface PersistProviderRevisionInput {
  readonly providerId: string;
  readonly revisionId: string;
  readonly organizationId: string;
  readonly displayName?: string;
  readonly adapterKey: string;
  readonly endpoint: string;
  readonly authMode: "none" | "bearer";
  readonly scheduleSeconds: number;
  readonly staleAfterSeconds: number;
  readonly encryptedCredential: EncryptedProviderCredential | null;
  readonly actorKey: string;
  readonly now: Date;
}

export type ProviderCreateRepositoryResult =
  | { readonly kind: "created"; readonly provider: ProviderConfigurationSummary }
  | { readonly kind: "platform_conflict" };

export type ProviderMutationRepositoryResult =
  | { readonly kind: "updated"; readonly provider: ProviderConfigurationSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict"; readonly current: ProviderConfigurationSummary }
  | { readonly kind: "connection_required" }
  | { readonly kind: "lifecycle_conflict" };

export type ProviderRevisionLookupResult =
  | { readonly kind: "found"; readonly revision: InternalProviderRevision }
  | { readonly kind: "not_found" }
  | { readonly kind: "revision_conflict"; readonly current: ProviderConfigurationSummary }
  | { readonly kind: "lifecycle_conflict" };

export interface ProviderConnectionTestPersistenceInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly revisionId: string;
  readonly actorKey: string;
  readonly test: ProviderConnectionTestSummary;
  readonly testedAt: Date;
}

export interface ProviderConfigurationRepository {
  createProvider(
    input: PersistProviderRevisionInput & {
      readonly platformKey: string;
      readonly displayName: string;
    },
  ): Promise<ProviderCreateRepositoryResult>;
  replaceRevision(
    input: PersistProviderRevisionInput & {
      readonly expectedRevisionId: string;
    },
  ): Promise<ProviderMutationRepositoryResult>;
  getProvider(
    organizationId: string,
    providerId: string,
  ): Promise<ProviderConfigurationSummary | null>;
  getRevisionForConnectionTest(input: {
    organizationId: string;
    providerId: string;
    expectedRevisionId: string;
  }): Promise<ProviderRevisionLookupResult>;
  recordConnectionTest(
    input: ProviderConnectionTestPersistenceInput,
  ): Promise<ProviderConnectionTestSummary>;
  activateRevision(input: {
    organizationId: string;
    providerId: string;
    expectedRevisionId: string;
    actorKey: string;
    activatedAt: Date;
    nextRunAt: Date;
  }): Promise<ProviderMutationRepositoryResult>;
  transitionState(input: {
    organizationId: string;
    providerId: string;
    expectedRevisionId: string;
    targetState: "disabled" | "archived";
    actorKey: string;
    changedAt: Date;
  }): Promise<ProviderMutationRepositoryResult>;
}

export interface ProviderConfigurationServiceDependencies {
  readonly repository: ProviderConfigurationRepository;
  readonly adapters: ProviderTransportAdapterRegistry;
  readonly credentialCipher: ProviderCredentialCipher;
  readonly actorKeyer: ProviderActorKeyer;
  readonly clock: ProviderClock;
  readonly ids: ProviderIdSource;
  readonly environment: ProviderRuntimeEnvironment;
  readonly connectionTimeoutMs?: number;
  readonly maximumConnectionResponseBytes?: number;
}

export class ProviderConfigurationServiceError extends Error {
  constructor(
    readonly code: ProviderConfigurationErrorCode,
    message: string,
    readonly status: number,
    readonly current?: ProviderConfigurationSummary,
  ) {
    super(message);
    this.name = "ProviderConfigurationServiceError";
  }
}

function actorKey(
  actor: ProviderActor,
  keyer: ProviderActorKeyer,
): string {
  return keyer.keyFor({
    organizationId: actor.organizationId,
    operatorId: actor.operatorId,
  });
}

function requireAdmin(actor: ProviderActor): void {
  if (actor.role !== "admin") {
    throw new ProviderConfigurationServiceError(
      "FORBIDDEN",
      "You do not have permission to change provider configuration.",
      403,
    );
  }
}

function stableConfigurationError(): ProviderConfigurationServiceError {
  return new ProviderConfigurationServiceError(
    "INVALID_PROVIDER_CONFIGURATION",
    "Provider configuration is invalid.",
    422,
  );
}

function mapRepositoryFailure(
  result: Exclude<ProviderMutationRepositoryResult, { kind: "updated" }>,
): never {
  if (result.kind === "revision_conflict") {
    throw new ProviderConfigurationServiceError(
      "CONFIG_REVISION_CONFLICT",
      "Provider configuration changed. Refresh and review the current revision.",
      409,
      result.current,
    );
  }
  if (result.kind === "not_found") {
    throw new ProviderConfigurationServiceError(
      "PROVIDER_NOT_FOUND",
      "Provider not found.",
      404,
    );
  }
  if (result.kind === "connection_required") {
    throw new ProviderConfigurationServiceError(
      "PROVIDER_CONNECTION_FAILED",
      "A successful connection test is required for this revision.",
      409,
    );
  }
  throw new ProviderConfigurationServiceError(
    "PROVIDER_LIFECYCLE_CONFLICT",
    "Provider lifecycle does not allow this action.",
    409,
  );
}

function connectionVerdict(
  failure: NormalizedProviderTransportFailure,
): ProviderConnectionTestSummary["verdict"] {
  if (failure.code === "timeout") return "timeout";
  if (failure.code === "invalid_json" || failure.code === "invalid_response") {
    return "contract_failure";
  }
  if (failure.code === "http_error" && [401, 403].includes(failure.httpStatus ?? 0)) {
    return "authentication_failure";
  }
  return "unreachable";
}

function toConnectionSummary(
  result: ProviderConnectionTestResult,
  checkedAt: Date,
): ProviderConnectionTestSummary {
  return result.ok
    ? {
        verdict: "success",
        checkedAt: checkedAt.toISOString(),
        latencyMs: result.latencyMs,
        responseStatus: result.responseStatus,
        recordCounts: result.recordCounts,
        hasMore: result.hasMore,
        nextCursorPresent: result.nextCursorPresent,
        sanitizedCode: null,
      }
    : {
        verdict: connectionVerdict(result.failure),
        checkedAt: checkedAt.toISOString(),
        latencyMs: result.latencyMs,
        responseStatus: result.failure.httpStatus ?? null,
        recordCounts: null,
        hasMore: null,
        nextCursorPresent: null,
        sanitizedCode: result.failure.code,
      };
}

export class ProviderConfigurationService {
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;

  constructor(
    private readonly dependencies: ProviderConfigurationServiceDependencies,
  ) {
    this.#timeoutMs = dependencies.connectionTimeoutMs ?? 10_000;
    this.#maximumResponseBytes =
      dependencies.maximumConnectionResponseBytes ?? 2 * 1024 * 1024;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 60_000 ||
      !Number.isInteger(this.#maximumResponseBytes) ||
      this.#maximumResponseBytes < 1 ||
      this.#maximumResponseBytes > 10 * 1024 * 1024
    ) {
      throw new Error("Provider connection test bounds are invalid.");
    }
  }

  async getProvider(
    actor: ProviderActor,
    providerId: string,
  ): Promise<ProviderConfigurationSummary> {
    const provider = await this.dependencies.repository.getProvider(
      actor.organizationId,
      providerId,
    );
    if (!provider) {
      throw new ProviderConfigurationServiceError(
        "PROVIDER_NOT_FOUND",
        "Provider not found.",
        404,
      );
    }
    return provider;
  }

  async createProvider(
    actor: ProviderActor,
    request: CreateProviderRequest,
  ): Promise<ProviderConfigurationSummary> {
    requireAdmin(actor);
    const parsed = createProviderRequestSchema.safeParse(request);
    if (!parsed.success) throw stableConfigurationError();
    this.resolveAdapter(parsed.data.adapterKey, parsed.data.platformKey);
    const endpoint = this.validateEndpoint(parsed.data.endpoint);
    const now = this.dependencies.clock.now();
    const providerId = this.dependencies.ids.id();
    const revisionId = this.dependencies.ids.id();
    const encryptedCredential = this.encryptCreateCredential(
      parsed.data,
      { organizationId: actor.organizationId, providerId, revisionId },
    );
    const result = await this.dependencies.repository.createProvider({
      providerId,
      revisionId,
      organizationId: actor.organizationId,
      platformKey: parsed.data.platformKey,
      displayName: parsed.data.displayName,
      adapterKey: parsed.data.adapterKey,
      endpoint: endpoint.endpoint,
      authMode: parsed.data.auth.mode,
      scheduleSeconds: parsed.data.scheduleSeconds,
      staleAfterSeconds: parsed.data.staleAfterSeconds,
      encryptedCredential,
      actorKey: actorKey(actor, this.dependencies.actorKeyer),
      now,
    });
    if (result.kind === "platform_conflict") {
      throw new ProviderConfigurationServiceError(
        "PROVIDER_PLATFORM_CONFLICT",
        "A provider already owns this platform.",
        409,
      );
    }
    return result.provider;
  }

  async replaceRevision(
    actor: ProviderActor,
    providerId: string,
    request: ReplaceProviderRevisionRequest,
  ): Promise<ProviderConfigurationSummary> {
    requireAdmin(actor);
    const parsed = replaceProviderRevisionRequestSchema.safeParse(request);
    if (!parsed.success) throw stableConfigurationError();
    const current = await this.dependencies.repository.getRevisionForConnectionTest({
      organizationId: actor.organizationId,
      providerId,
      expectedRevisionId: parsed.data.expectedRevisionId,
    });
    if (current.kind !== "found") this.mapRevisionLookupFailure(current);
    this.resolveAdapter(parsed.data.adapterKey, current.revision.platformKey);
    const endpoint = this.validateEndpoint(parsed.data.endpoint);
    const revisionId = this.dependencies.ids.id();
    const encryptedCredential = this.encryptReplacementCredential(
      parsed.data,
      current.revision,
      { organizationId: actor.organizationId, providerId, revisionId },
    );
    const result = await this.dependencies.repository.replaceRevision({
      providerId,
      revisionId,
      expectedRevisionId: parsed.data.expectedRevisionId,
      organizationId: actor.organizationId,
      displayName: parsed.data.displayName,
      adapterKey: parsed.data.adapterKey,
      endpoint: endpoint.endpoint,
      authMode: parsed.data.auth.mode,
      scheduleSeconds: parsed.data.scheduleSeconds,
      staleAfterSeconds: parsed.data.staleAfterSeconds,
      encryptedCredential,
      actorKey: actorKey(actor, this.dependencies.actorKeyer),
      now: this.dependencies.clock.now(),
    });
    if (result.kind !== "updated") mapRepositoryFailure(result);
    return result.provider;
  }

  async testConnection(
    actor: ProviderActor,
    providerId: string,
    expectedRevisionId: string,
  ): Promise<ProviderConnectionTestSummary> {
    requireAdmin(actor);
    const lookup = await this.dependencies.repository.getRevisionForConnectionTest({
      organizationId: actor.organizationId,
      providerId,
      expectedRevisionId,
    });
    if (lookup.kind !== "found") this.mapRevisionLookupFailure(lookup);
    const endpoint = this.validateEndpoint(lookup.revision.endpoint);
    const adapter = this.resolveAdapter(
      lookup.revision.adapterKey,
      lookup.revision.platformKey,
    );
    const auth =
      lookup.revision.authMode === "none"
        ? ({ mode: "none" } as const)
        : ({
            mode: "bearer",
            token: this.decryptCredential(lookup.revision),
          } as const);
    const result = await adapter.testConnection({
      endpoint: endpoint.endpoint,
      allowedHosts: endpoint.allowedHosts,
      platform: lookup.revision.platformKey,
      auth,
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: this.#maximumResponseBytes,
      allowLocalHttp: this.dependencies.environment === "local",
    });
    const testedAt = this.dependencies.clock.now();
    return this.dependencies.repository.recordConnectionTest({
      organizationId: actor.organizationId,
      providerId,
      revisionId: lookup.revision.revisionId,
      actorKey: actorKey(actor, this.dependencies.actorKeyer),
      test: toConnectionSummary(result, testedAt),
      testedAt,
    });
  }

  async activateRevision(
    actor: ProviderActor,
    providerId: string,
    expectedRevisionId: string,
  ): Promise<ProviderConfigurationSummary> {
    requireAdmin(actor);
    const now = this.dependencies.clock.now();
    const lookup = await this.dependencies.repository.getRevisionForConnectionTest({
      organizationId: actor.organizationId,
      providerId,
      expectedRevisionId,
    });
    if (lookup.kind !== "found") this.mapRevisionLookupFailure(lookup);
    const result = await this.dependencies.repository.activateRevision({
      organizationId: actor.organizationId,
      providerId,
      expectedRevisionId,
      actorKey: actorKey(actor, this.dependencies.actorKeyer),
      activatedAt: now,
      nextRunAt: new Date(now.getTime() + lookup.revision.scheduleSeconds * 1_000),
    });
    if (result.kind !== "updated") mapRepositoryFailure(result);
    return result.provider;
  }

  async disableProvider(
    actor: ProviderActor,
    providerId: string,
    expectedRevisionId: string,
  ): Promise<ProviderConfigurationSummary> {
    return this.transition(actor, providerId, expectedRevisionId, "disabled");
  }

  async archiveProvider(
    actor: ProviderActor,
    providerId: string,
    expectedRevisionId: string,
  ): Promise<ProviderConfigurationSummary> {
    return this.transition(actor, providerId, expectedRevisionId, "archived");
  }

  private async transition(
    actor: ProviderActor,
    providerId: string,
    expectedRevisionId: string,
    targetState: "disabled" | "archived",
  ): Promise<ProviderConfigurationSummary> {
    requireAdmin(actor);
    const result = await this.dependencies.repository.transitionState({
      organizationId: actor.organizationId,
      providerId,
      expectedRevisionId,
      targetState,
      actorKey: actorKey(actor, this.dependencies.actorKeyer),
      changedAt: this.dependencies.clock.now(),
    });
    if (result.kind !== "updated") mapRepositoryFailure(result);
    return result.provider;
  }

  private resolveAdapter(adapterKey: string, platformKey: string) {
    try {
      return this.dependencies.adapters.resolve(adapterKey, platformKey);
    } catch (error) {
      if (error instanceof ProviderAdapterRegistryError) {
        throw new ProviderConfigurationServiceError(
          "UNKNOWN_ADAPTER",
          "Provider adapter is unavailable for this platform.",
          422,
        );
      }
      throw error;
    }
  }

  private validateEndpoint(value: string) {
    try {
      return validateProviderEndpoint(value, this.dependencies.environment);
    } catch (error) {
      if (error instanceof ProviderEndpointPolicyError) {
        throw stableConfigurationError();
      }
      throw error;
    }
  }

  private encryptCreateCredential(
    input: NormalizedCreateProviderRequest,
    scope: ProviderCredentialScope,
  ): EncryptedProviderCredential | null {
    return input.auth.mode === "bearer"
      ? this.dependencies.credentialCipher.encrypt(input.auth.bearerSecret, scope)
      : null;
  }

  private encryptReplacementCredential(
    input: NormalizedReplaceProviderRevisionRequest,
    current: InternalProviderRevision,
    scope: ProviderCredentialScope,
  ): EncryptedProviderCredential | null {
    if (input.auth.mode === "none") return null;
    if (input.auth.bearerSecret !== undefined) {
      return this.dependencies.credentialCipher.encrypt(input.auth.bearerSecret, scope);
    }
    if (!current.encryptedCredential) {
      throw new ProviderConfigurationServiceError(
        "BEARER_SECRET_REQUIRED",
        "A bearer secret is required.",
        422,
      );
    }
    const plaintext = this.dependencies.credentialCipher.decrypt(
      current.encryptedCredential,
      {
        organizationId: scope.organizationId,
        providerId: scope.providerId,
        revisionId: current.revisionId,
      },
    );
    return this.dependencies.credentialCipher.encrypt(plaintext, scope);
  }

  private decryptCredential(revision: InternalProviderRevision): string {
    if (!revision.encryptedCredential) {
      throw new ProviderConfigurationServiceError(
        "BEARER_SECRET_REQUIRED",
        "A bearer secret is required.",
        422,
      );
    }
    return this.dependencies.credentialCipher.decrypt(
      revision.encryptedCredential,
      {
        organizationId: revision.organizationId,
        providerId: revision.providerId,
        revisionId: revision.revisionId,
      },
    );
  }

  private mapRevisionLookupFailure(
    result: Exclude<ProviderRevisionLookupResult, { kind: "found" }>,
  ): never {
    if (result.kind === "revision_conflict") {
      throw new ProviderConfigurationServiceError(
        "CONFIG_REVISION_CONFLICT",
        "Provider configuration changed. Refresh and review the current revision.",
        409,
        result.current,
      );
    }
    if (result.kind === "lifecycle_conflict") {
      throw new ProviderConfigurationServiceError(
        "PROVIDER_LIFECYCLE_CONFLICT",
        "Provider lifecycle does not allow this action.",
        409,
      );
    }
    throw new ProviderConfigurationServiceError(
      "PROVIDER_NOT_FOUND",
      "Provider not found.",
      404,
    );
  }
}
