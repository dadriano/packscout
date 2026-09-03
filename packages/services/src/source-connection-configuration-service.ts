import { createHash, randomUUID } from "node:crypto";
import {
  createSourceConnectionProfileRequestSchema,
  createSourceConnectionRecoveryRevisionRequestSchema,
  requestSourceConnectionRecoveryTestSchema,
  activateSourceConnectionRecoveryRequestSchema,
  rotateSourceConnectionCredentialRequestSchema,
  sourceConnectionRevisionCommandSchema,
  revokeSourceConnectionRevisionRequestSchema,
  type CreateSourceConnectionProfileRequest,
  type CreateSourceConnectionRecoveryRevisionRequest,
  type ProviderSourceAdminAuditReceipt,
  type RotateSourceConnectionCredentialRequest,
} from "@packscout/contracts";
import { SourceAdapterRegistry } from "./source-adapter-registry.ts";
import {
  type EncryptedSourceConnectionConfiguration,
  type SourceConnectionConfigurationCipher,
  type SourceConnectionConfigurationScope,
} from "./source-connection-configuration-cipher.ts";
import type {
  ResolvedSourceConnectionConfiguration,
  SourceConnectionConfigurationResolver,
} from "./provider-source-activation-service.ts";
import {
  providerSourceAdminAuditReceipt,
  type ProviderSourceAdminCommandContext,
  ProviderSourceAdminServiceError,
  requireProviderSourceAdminContext,
} from "./provider-source-admin-service-types.ts";
import type {
  SourceConnectionConfigurationAdminRepository,
  SourceConnectionConfigurationServiceDependencies,
  SourceConnectionRevisionSecretRecord,
} from "./source-connection-configuration-admin-repository.ts";

function configurationFingerprint(
  encrypted: EncryptedSourceConnectionConfiguration,
): string {
  return createHash("sha256")
    .update("packscout.source-connection-configuration-ciphertext.v1")
    .update("\0")
    .update(String(encrypted.keyVersion))
    .update("\0")
    .update(encrypted.nonce)
    .update(encrypted.authTag)
    .update(encrypted.ciphertext)
    .digest("hex");
}

function encodedConfiguration(configuration: unknown): string {
  return JSON.stringify(configuration);
}

function decodedConfiguration(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new ProviderSourceAdminServiceError(
      "SOURCE_UPSTREAM_UNAVAILABLE",
      503,
    );
  }
}

export class SourceConnectionConfigurationService
  implements SourceConnectionConfigurationResolver {
  readonly #repository: SourceConnectionConfigurationAdminRepository;
  readonly #cipher: SourceConnectionConfigurationCipher;
  readonly #sourceAdapters: SourceAdapterRegistry;
  readonly #adminConfigurationCodecs: SourceConnectionConfigurationServiceDependencies[
    "adminConfigurationCodecs"
  ];
  readonly #clock: Readonly<{ now(): Date }>;
  readonly #ids: Readonly<{ id(): string }>;

  constructor(dependencies: SourceConnectionConfigurationServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#cipher = dependencies.cipher;
    this.#sourceAdapters = dependencies.sourceAdapters;
    this.#adminConfigurationCodecs = dependencies.adminConfigurationCodecs;
    this.#clock = dependencies.clock ?? { now: () => new Date() };
    this.#ids = dependencies.ids ?? { id: randomUUID };
  }

  async createProfile(
    context: ProviderSourceAdminCommandContext,
    request: CreateSourceConnectionProfileRequest,
  ): Promise<Readonly<{
    profileId: string;
    revisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>> {
    requireProviderSourceAdminContext(context);
    const parsed = createSourceConnectionProfileRequestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const adapter = this.#resolveSourceType(parsed.data.sourceTypeKey);
    const codec = this.#adminConfigurationCodecs.resolve(
      adapter.manifest.sourceTypeKey,
      adapter.manifest.adapterVersion,
    );
    const validated = codec.createConnection({
      endpoint: parsed.data.endpoint,
      credential: parsed.data.bearerCredential,
    });
    if (!validated.ok) this.#invalid();

    const profileId = this.#ids.id();
    const revisionId = this.#ids.id();
    const createdAt = this.#clock.now();
    const scope = this.#scope(context.organizationId, profileId, revisionId);
    const encryptedConfiguration = this.#cipher.encrypt(
      encodedConfiguration(validated.value),
      scope,
    );
    await this.#repository.createConnectionProfile({
      organizationId: context.organizationId,
      profileId,
      revisionId,
      sourceTypeKey: adapter.manifest.sourceTypeKey,
      connectionTypeKey: adapter.manifest.compatibleConnectionTypeKey,
      displayName: parsed.data.displayName,
      requestLimit: parsed.data.requestLimit,
      sourceAdapterVersion: adapter.manifest.adapterVersion,
      encryptedConfiguration,
      configurationFingerprint: configurationFingerprint(encryptedConfiguration),
      actorKey: context.actorKey,
      createdAt,
    });
    return Object.freeze({
      profileId,
      revisionId,
      audit: providerSourceAdminAuditReceipt(
        "connection_profile_created",
        "source_connection_profile",
        profileId,
        revisionId,
        createdAt,
      ),
    });
  }

  async rotateCredential(
    context: ProviderSourceAdminCommandContext,
    connectionProfileId: string,
    request: RotateSourceConnectionCredentialRequest,
  ): Promise<Readonly<{
    profileId: string;
    revisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>> {
    requireProviderSourceAdminContext(context);
    const parsed = rotateSourceConnectionCredentialRequestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const current = await this.#repository.loadConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: parsed.data.expectedRevisionId,
    });
    if (!current) this.#connectionNotFound();
    const adapter = this.#resolveSourceType(
      current.sourceTypeKey,
      current.sourceAdapterVersion,
    );
    const existing = await this.#decryptRecord(current);
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      this.#invalid();
    }
    const codec = this.#adminConfigurationCodecs.resolve(
      adapter.manifest.sourceTypeKey,
      adapter.manifest.adapterVersion,
    );
    const validated = codec.rotateCredential(
      existing as Readonly<Record<string, unknown>>,
      { credential: parsed.data.bearerCredential },
    );
    if (!validated.ok) this.#invalid();

    const revisionId = this.#ids.id();
    const createdAt = this.#clock.now();
    const encryptedConfiguration = this.#cipher.encrypt(
      encodedConfiguration(validated.value),
      this.#scope(context.organizationId, connectionProfileId, revisionId),
    );
    await this.#repository.addConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      expectedRevisionId: current.connectionRevisionId,
      revisionId,
      revisionNumber: current.revisionNumber + 1,
      sourceTypeKey: current.sourceTypeKey,
      sourceAdapterVersion: current.sourceAdapterVersion,
      encryptedConfiguration,
      configurationFingerprint: configurationFingerprint(encryptedConfiguration),
      actorKey: context.actorKey,
      createdAt,
    });
    return Object.freeze({
      profileId: connectionProfileId,
      revisionId,
      audit: providerSourceAdminAuditReceipt(
        "connection_credential_rotated",
        "source_connection_profile",
        connectionProfileId,
        revisionId,
        createdAt,
      ),
    });
  }

  async requestTest(
    context: ProviderSourceAdminCommandContext,
    connectionProfileId: string,
    request: unknown,
  ): Promise<Readonly<{
    jobId: string;
    state: "pending";
    audit: ProviderSourceAdminAuditReceipt;
  }>> {
    requireProviderSourceAdminContext(context);
    const parsed = sourceConnectionRevisionCommandSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const revision = await this.#repository.loadConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: parsed.data.expectedRevisionId,
    });
    if (!revision) this.#connectionNotFound();
    const requestedAt = this.#clock.now();
    const queued = await this.#repository.requestConnectionTest({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: revision.connectionRevisionId,
      expectedHealthGeneration: revision.healthGeneration,
      requestedByActorKey: context.actorKey,
      requestedAt,
    });
    return Object.freeze({
      jobId: queued.jobId,
      state: "pending",
      audit: providerSourceAdminAuditReceipt(
        "connection_test_requested",
        "source_connection_profile",
        connectionProfileId,
        revision.connectionRevisionId,
        requestedAt,
      ),
    });
  }

  async createRecoveryRevision(
    context: ProviderSourceAdminCommandContext,
    connectionProfileId: string,
    request: CreateSourceConnectionRecoveryRevisionRequest,
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = createSourceConnectionRecoveryRevisionRequestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const [blocked, latest] = await Promise.all([
      this.#repository.loadConnectionRevision({
        organizationId: context.organizationId,
        connectionProfileId,
        connectionRevisionId: parsed.data.expectedBlockedRevisionId,
      }),
      this.#repository.loadConnectionRevision({
        organizationId: context.organizationId,
        connectionProfileId,
        connectionRevisionId: parsed.data.expectedLatestRevisionId,
      }),
    ]);
    if (!blocked || !latest) this.#connectionNotFound();
    if (
      blocked.sourceTypeKey !== latest.sourceTypeKey ||
      blocked.sourceAdapterVersion !== latest.sourceAdapterVersion
    ) this.#invalid();
    const adapter = this.#resolveSourceType(
      latest.sourceTypeKey,
      latest.sourceAdapterVersion,
    );
    const current = await this.#decryptRecord(latest);
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      this.#invalid();
    }
    const validated = this.#adminConfigurationCodecs.resolve(
      adapter.manifest.sourceTypeKey,
      adapter.manifest.adapterVersion,
    ).rotateCredential(current as Readonly<Record<string, unknown>>, {
      credential: parsed.data.bearerCredential,
    });
    if (!validated.ok) this.#invalid();
    const revisionId = this.#ids.id();
    const createdAt = this.#clock.now();
    const encryptedConfiguration = this.#cipher.encrypt(
      encodedConfiguration(validated.value),
      this.#scope(context.organizationId, connectionProfileId, revisionId),
    );
    await this.#repository.addRecoveryConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      blockedRevisionId: blocked.connectionRevisionId,
      latestRevisionId: latest.connectionRevisionId,
      blockingEpisodeId: parsed.data.blockingEpisodeId,
      revisionId,
      revisionNumber: latest.revisionNumber + 1,
      sourceTypeKey: latest.sourceTypeKey,
      sourceAdapterVersion: latest.sourceAdapterVersion,
      encryptedConfiguration,
      configurationFingerprint: configurationFingerprint(encryptedConfiguration),
      actorKey: context.actorKey,
      createdAt,
    });
    return Object.freeze({
      profileId: connectionProfileId,
      revisionId,
      audit: providerSourceAdminAuditReceipt(
        "connection_recovery_revision_created",
        "source_connection_profile",
        connectionProfileId,
        revisionId,
        createdAt,
      ),
    });
  }

  async requestRecoveryTest(
    context: ProviderSourceAdminCommandContext,
    connectionProfileId: string,
    request: unknown,
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = requestSourceConnectionRecoveryTestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const requestedAt = this.#clock.now();
    const queued = await this.#repository.requestConnectionRecoveryTest({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: parsed.data.expectedRevisionId,
      expectedHealthGeneration: BigInt(parsed.data.expectedHealthGeneration),
      blockedRevisionId: parsed.data.blockedRevisionId,
      blockingEpisodeId: parsed.data.blockingEpisodeId,
      requestedByActorKey: context.actorKey,
      requestedAt,
    });
    return Object.freeze({
      jobId: queued.jobId,
      state: "pending" as const,
      audit: providerSourceAdminAuditReceipt(
        "connection_recovery_test_requested",
        "source_connection_profile",
        connectionProfileId,
        parsed.data.expectedRevisionId,
        requestedAt,
      ),
    });
  }

  async activateRecovery(
    context: ProviderSourceAdminCommandContext,
    connectionProfileId: string,
    request: unknown,
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = activateSourceConnectionRecoveryRequestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const activatedAt = this.#clock.now();
    const activated = await this.#repository.activateTestedConnectionRecovery({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: parsed.data.expectedRevisionId,
      expectedHealthGeneration: BigInt(parsed.data.expectedHealthGeneration),
      blockedRevisionId: parsed.data.blockedRevisionId,
      blockingEpisodeId: parsed.data.blockingEpisodeId,
      actorKey: context.actorKey,
      activatedAt,
    });
    return Object.freeze({
      runIds: activated.runIds,
      audit: providerSourceAdminAuditReceipt(
        "connection_recovery_activated",
        "source_connection_profile",
        connectionProfileId,
        parsed.data.expectedRevisionId,
        activatedAt,
      ),
    });
  }

  async activateRevision(
    context: ProviderSourceAdminCommandContext,
    connectionProfileId: string,
    request: unknown,
  ): Promise<ProviderSourceAdminAuditReceipt> {
    requireProviderSourceAdminContext(context);
    const parsed = sourceConnectionRevisionCommandSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const revision = await this.#repository.loadConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: parsed.data.expectedRevisionId,
    });
    if (!revision) this.#connectionNotFound();
    const activatedAt = this.#clock.now();
    await this.#repository.activateTestedConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: revision.connectionRevisionId,
      expectedHealthGeneration: revision.healthGeneration,
      preservePinnedWork: true,
      actorKey: context.actorKey,
      activatedAt,
    });
    return providerSourceAdminAuditReceipt(
      "connection_revision_activated",
      "source_connection_profile",
      connectionProfileId,
      revision.connectionRevisionId,
      activatedAt,
    );
  }

  async revokeRevision(
    context: ProviderSourceAdminCommandContext,
    connectionProfileId: string,
    request: unknown,
  ): Promise<ProviderSourceAdminAuditReceipt> {
    requireProviderSourceAdminContext(context);
    const parsed = revokeSourceConnectionRevisionRequestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const revision = await this.#repository.loadConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: parsed.data.expectedRevisionId,
    });
    if (!revision) this.#connectionNotFound();
    const revokedAt = this.#clock.now();
    await this.#repository.revokeConnectionRevision({
      organizationId: context.organizationId,
      connectionProfileId,
      connectionRevisionId: revision.connectionRevisionId,
      expectedHealthGeneration: revision.healthGeneration,
      actorKey: context.actorKey,
      revokedAt,
    });
    return providerSourceAdminAuditReceipt(
      "connection_revision_revoked",
      "source_connection_profile",
      connectionProfileId,
      revision.connectionRevisionId,
      revokedAt,
    );
  }

  async resolveSourceConnectionConfiguration(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    configurationFingerprint: string;
  }>): Promise<ResolvedSourceConnectionConfiguration> {
    const revision = await this.#repository.loadConnectionRevision(input);
    if (!revision || revision.configurationFingerprint !== input.configurationFingerprint) {
      throw new ProviderSourceAdminServiceError(
        "CONNECTION_NOT_FOUND",
        404,
      );
    }
    if (
      configurationFingerprint(revision.encryptedConfiguration) !==
      revision.configurationFingerprint
    ) {
      throw new ProviderSourceAdminServiceError(
        "SOURCE_UPSTREAM_UNAVAILABLE",
        503,
      );
    }
    return Object.freeze({
      organizationId: input.organizationId,
      connectionProfileId: input.connectionProfileId,
      connectionRevisionId: input.connectionRevisionId,
      configurationFingerprint: revision.configurationFingerprint,
      configuration: await this.#decryptRecord(revision),
    });
  }

  async #decryptRecord(record: SourceConnectionRevisionSecretRecord): Promise<unknown> {
    try {
      return decodedConfiguration(this.#cipher.decrypt(
        record.encryptedConfiguration,
        this.#scope(
          record.organizationId,
          record.connectionProfileId,
          record.connectionRevisionId,
        ),
      ));
    } catch (error) {
      if (error instanceof ProviderSourceAdminServiceError) throw error;
      throw new ProviderSourceAdminServiceError(
        "SOURCE_UPSTREAM_UNAVAILABLE",
        503,
      );
    }
  }

  #resolveSourceType(sourceTypeKey: string, adapterVersion?: string) {
    try {
      if (adapterVersion) {
        return this.#sourceAdapters.resolveSourceType(sourceTypeKey, adapterVersion);
      }
      return this.#sourceAdapters.resolveCurrentVersion(sourceTypeKey);
    } catch {
      return this.#invalid();
    }
  }

  #scope(
    organizationId: string,
    connectionProfileId: string,
    connectionRevisionId: string,
  ): SourceConnectionConfigurationScope {
    return { organizationId, connectionProfileId, connectionRevisionId };
  }

  #invalid(): never {
    throw new ProviderSourceAdminServiceError(
      "INVALID_SOURCE_CONFIGURATION",
      422,
    );
  }

  #connectionNotFound(): never {
    throw new ProviderSourceAdminServiceError("CONNECTION_NOT_FOUND", 404);
  }

}
