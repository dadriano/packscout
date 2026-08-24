import {
  confirmProviderSourceCursorResetRequestSchema,
  createProviderSourceRequestSchema,
  previewProviderSourceCursorResetRequestSchema,
  providerSourceRevisionCommandSchema,
  replaceProviderSourceRequestSchema,
  reviseProviderSourceIntervalRequestSchema,
  type CreateProviderSourceRequest,
  type ProviderSourceAdminAuditReceipt,
  type ProviderSourceCursorResetPreview,
  type ReplaceProviderSourceRequest,
} from "@packscout/contracts";
import {
  hashProviderSourceConfiguration,
  ProviderSourceActivationService,
} from "./provider-source-activation-service.ts";
import {
  providerSourceAdminAuditReceipt,
  type ProviderSourceAdminCommandContext,
  ProviderSourceAdminServiceError,
  requireProviderSourceAdminContext,
} from "./provider-source-admin-service-types.ts";
import type {
  ProviderSourceLifecycleAdminRepository,
  ProviderSourceLifecycleServiceDependencies,
  ProviderSourceLifecycleSnapshot,
} from "./provider-source-lifecycle-admin-repository.ts";
import { SourceAdapterRegistry } from "./source-adapter-registry.ts";
import { SourceAdminConfigurationCodecRegistry } from "./source-admin-configuration-codec.ts";
import { SourceMapperDescriptorRegistry } from "./source-mapper-descriptors.ts";

function commandReceipt(
  action: ProviderSourceAdminAuditReceipt["action"],
  subjectId: string,
  revisionId: string | null,
  occurredAt: Date,
): ProviderSourceAdminAuditReceipt {
  return providerSourceAdminAuditReceipt(
    action,
    "provider_source",
    subjectId,
    revisionId,
    occurredAt,
  );
}

export class ProviderSourceLifecycleService {
  readonly #repository: ProviderSourceLifecycleAdminRepository;
  readonly #activation: ProviderSourceActivationService;
  readonly #sourceAdapters: SourceAdapterRegistry;
  readonly #mapperDescriptors: SourceMapperDescriptorRegistry;
  readonly #adminConfigurationCodecs: SourceAdminConfigurationCodecRegistry;
  readonly #clock: Readonly<{ now(): Date }>;

  constructor(dependencies: ProviderSourceLifecycleServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#activation = dependencies.activation;
    this.#sourceAdapters = dependencies.sourceAdapters;
    this.#mapperDescriptors = dependencies.mapperDescriptors;
    this.#adminConfigurationCodecs = dependencies.adminConfigurationCodecs;
    this.#clock = dependencies.clock ?? { now: () => new Date() };
  }

  createSource(
    context: ProviderSourceAdminCommandContext,
    request: CreateProviderSourceRequest,
  ) {
    return this.#create(context, request, null);
  }

  createReplacement(
    context: ProviderSourceAdminCommandContext,
    request: ReplaceProviderSourceRequest,
  ) {
    return this.#create(context, request, request.replacesSourceInstanceId);
  }

  async #create(
    context: ProviderSourceAdminCommandContext,
    request: CreateProviderSourceRequest | ReplaceProviderSourceRequest,
    replacesSourceInstanceId: string | null,
  ): Promise<Readonly<{
    sourceInstanceId: string;
    sourceRevisionId: string;
    audit: ProviderSourceAdminAuditReceipt;
  }>> {
    requireProviderSourceAdminContext(context);
    const parsed = (replacesSourceInstanceId === null
      ? createProviderSourceRequestSchema
      : replaceProviderSourceRequestSchema).safeParse(request);
    if (!parsed.success) this.#invalid();
    const [provider, profile] = await Promise.all([
      this.#repository.loadProvider({
        organizationId: context.organizationId,
        providerId: parsed.data.providerId,
      }),
      this.#repository.loadConnectionProfile({
        organizationId: context.organizationId,
        connectionProfileId: parsed.data.connectionProfileId,
      }),
    ]);
    if (!provider) this.#sourceNotFound();
    if (!profile) this.#connectionNotFound();
    if (
      profile.sourceTypeKey !== parsed.data.sourceTypeKey ||
      profile.state === "disabled"
    ) this.#dependency();

    let adapter;
    try {
      adapter = this.#sourceAdapters.resolveOnlyVersion(parsed.data.sourceTypeKey);
    } catch {
      return this.#invalid();
    }
    let providerAdapter;
    try {
      providerAdapter = this.#sourceAdapters.resolve(
        adapter.manifest.sourceTypeKey,
        adapter.manifest.adapterVersion,
        provider.provider as never,
      );
    } catch {
      return this.#invalid();
    }
    const declaration = providerAdapter.manifest.supportedProviders.find(
      (candidate) => candidate.provider === provider.provider,
    );
    if (!declaration) this.#invalid();
    const validated = this.#adminConfigurationCodecs.resolve(
      providerAdapter.manifest.sourceTypeKey,
      providerAdapter.manifest.adapterVersion,
    ).createSource(provider.provider as never);
    if (!validated.ok) this.#invalid();
    let mapper;
    try {
      mapper = this.#mapperDescriptors.requireCompatible({
        mapperKey: parsed.data.mapperKey,
        mapperVersion: parsed.data.mapperVersion,
        provider: provider.provider as never,
        normalizedContractVersion: providerAdapter.manifest.normalizedContractVersion,
        identityNamespaceKey: declaration.identityNamespaceKey,
        sourceTypeKey: providerAdapter.manifest.sourceTypeKey,
      });
    } catch {
      return this.#invalid();
    }
    const recordIdScopes = declaration.recordIdScopes.map(
      (scope) => scope.recordIdScopeKey,
    );
    if (replacesSourceInstanceId !== null) {
      const previous = await this.#repository.loadSource({
        organizationId: context.organizationId,
        providerId: provider.providerId,
        sourceInstanceId: replacesSourceInstanceId,
      });
      if (!previous) this.#sourceNotFound();
      if (
        !["paused", "disabled"].includes(previous.state) ||
        previous.hasActiveRun ||
        previous.identityNamespaceKey !== mapper.identityNamespaceKey ||
        previous.normalizedContractVersion !==
          providerAdapter.manifest.normalizedContractVersion ||
        previous.recordIdScopes.length !== recordIdScopes.length ||
        !previous.recordIdScopes.every(
          (scope, index) => scope === recordIdScopes[index],
        )
      ) this.#conflict();
    }
    const createdAt = this.#clock.now();
    const created = await this.#repository.createSource({
      organizationId: context.organizationId,
      providerId: provider.providerId,
      connectionProfileId: profile.connectionProfileId,
      sourceTypeKey: providerAdapter.manifest.sourceTypeKey,
      sourceAdapterVersion: providerAdapter.manifest.adapterVersion,
      normalizedContractVersion: providerAdapter.manifest.normalizedContractVersion,
      mapperKey: mapper.mapperKey,
      mapperVersion: mapper.mapperVersion,
      identityNamespaceKey: mapper.identityNamespaceKey,
      cursorCodecVersion: providerAdapter.manifest.cursorCodecKey,
      configuration: validated.value,
      configurationHash: hashProviderSourceConfiguration(validated.value),
      recordIdScopes,
      intervalSeconds: parsed.data.intervalSeconds,
      replacesSourceInstanceId,
      actorKey: context.actorKey,
      createdAt,
    });
    return Object.freeze({
      ...created,
      audit: commandReceipt(
        replacesSourceInstanceId === null
          ? "source_created"
          : "source_replacement_created",
        created.sourceInstanceId,
        created.sourceRevisionId,
        createdAt,
      ),
    });
  }

  async requestTest(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = providerSourceRevisionCommandSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const source = await this.#load(context, providerId, sourceInstanceId);
    if (
      source.sourceRevisionId !== parsed.data.expectedSourceRevisionId ||
      !source.connectionRevisionId ||
      (parsed.data.expectedConnectionRevisionId !== undefined &&
        parsed.data.expectedConnectionRevisionId !== source.connectionRevisionId)
    ) this.#conflict();
    const requestedAt = this.#clock.now();
    const queued = await this.#repository.requestSourceTest({
      organizationId: context.organizationId,
      providerId,
      sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      connectionProfileId: source.connectionProfileId,
      connectionRevisionId: source.connectionRevisionId,
      requestedByActorKey: context.actorKey,
      requestedAt,
    });
    return Object.freeze({
      jobId: queued.jobId,
      state: "pending" as const,
      audit: commandReceipt(
        "source_test_requested",
        sourceInstanceId,
        source.sourceRevisionId,
        requestedAt,
      ),
    });
  }

  async activatePaused(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ): Promise<ProviderSourceAdminAuditReceipt> {
    requireProviderSourceAdminContext(context);
    const parsed = providerSourceRevisionCommandSchema.safeParse(request);
    if (!parsed.success || !parsed.data.expectedConnectionRevisionId) this.#invalid();
    const activatedAt = this.#clock.now();
    await this.#activation.activatePaused({
      organizationId: context.organizationId,
      providerId,
      sourceInstanceId,
      sourceRevisionId: parsed.data.expectedSourceRevisionId,
      connectionRevisionId: parsed.data.expectedConnectionRevisionId,
      actorKey: context.actorKey,
      activatedAt,
    });
    return commandReceipt(
      "source_activated_paused",
      sourceInstanceId,
      parsed.data.expectedSourceRevisionId,
      activatedAt,
    );
  }

  async reviseInterval(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = reviseProviderSourceIntervalRequestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const effectiveAt = this.#clock.now();
    const revised = await this.#repository.reviseInterval({
      organizationId: context.organizationId,
      providerId,
      sourceInstanceId,
      expectedSourceRevisionId: parsed.data.expectedSourceRevisionId,
      expectedScheduleRevisionId: parsed.data.expectedScheduleRevisionId,
      intervalSeconds: parsed.data.intervalSeconds,
      actorKey: context.actorKey,
      effectiveAt,
    });
    return Object.freeze({
      scheduleRevisionId: revised.scheduleRevisionId,
      audit: commandReceipt(
        "source_interval_revised",
        sourceInstanceId,
        parsed.data.expectedSourceRevisionId,
        effectiveAt,
      ),
    });
  }

  async pause(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = providerSourceRevisionCommandSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const requestedAt = this.#clock.now();
    const paused = await this.#repository.requestPause({
      organizationId: context.organizationId,
      providerId,
      sourceInstanceId,
      expectedSourceRevisionId: parsed.data.expectedSourceRevisionId,
      actorKey: context.actorKey,
      requestedAt,
    });
    return Object.freeze({
      state: paused.state,
      audit: commandReceipt(
        paused.state === "paused" ? "source_paused" : "source_pause_requested",
        sourceInstanceId,
        parsed.data.expectedSourceRevisionId,
        requestedAt,
      ),
    });
  }

  async resume(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ) {
    return this.#simpleCommand(
      context,
      providerId,
      sourceInstanceId,
      request,
      "resume",
    );
  }

  async disable(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ) {
    return this.#simpleCommand(
      context,
      providerId,
      sourceInstanceId,
      request,
      "disable",
    );
  }

  async #simpleCommand(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
    command: "resume" | "disable",
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = providerSourceRevisionCommandSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const occurredAt = this.#clock.now();
    await this.#repository[command]({
      organizationId: context.organizationId,
      providerId,
      sourceInstanceId,
      expectedSourceRevisionId: parsed.data.expectedSourceRevisionId,
      actorKey: context.actorKey,
      ...(command === "resume"
        ? { resumedAt: occurredAt }
        : { disabledAt: occurredAt }),
    } as never);
    return commandReceipt(
      command === "resume" ? "source_resumed" : "source_disabled",
      sourceInstanceId,
      parsed.data.expectedSourceRevisionId,
      occurredAt,
    );
  }

  async previewCursorReset(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ): Promise<ProviderSourceCursorResetPreview> {
    requireProviderSourceAdminContext(context);
    const parsed = previewProviderSourceCursorResetRequestSchema.safeParse(request);
    if (!parsed.success) this.#invalid();
    const source = await this.#load(context, providerId, sourceInstanceId);
    if (
      source.sourceRevisionId !== parsed.data.expectedSourceRevisionId ||
      !["paused", "disabled"].includes(source.state) ||
      source.hasActiveRun
    ) this.#conflict();
    return Object.freeze({
      providerId: source.providerId,
      provider: source.provider as never,
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      sourceState: source.state as "paused" | "disabled",
      cursorGeneration: source.cursorGeneration.toString(),
      cursorFingerprint: source.cursorFingerprint,
      confirmation: `RESET ${source.provider.toUpperCase()}`,
      consequence:
        "The saved cursor will be cleared and the next resume will start from Feed start.",
    });
  }

  async resetCursor(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
    request: unknown,
  ) {
    requireProviderSourceAdminContext(context);
    const parsed = confirmProviderSourceCursorResetRequestSchema.safeParse(request);
    if (!parsed.success) this.#resetConfirmation();
    const preview = await this.previewCursorReset(
      context,
      providerId,
      sourceInstanceId,
      { expectedSourceRevisionId: parsed.data.expectedSourceRevisionId },
    );
    if (
      parsed.data.confirmation !== preview.confirmation ||
      parsed.data.expectedCursorGeneration !== preview.cursorGeneration ||
      parsed.data.expectedCursorFingerprint !== preview.cursorFingerprint
    ) this.#resetConfirmation();
    const resetAt = this.#clock.now();
    const generation = await this.#repository.resetCursor({
      organizationId: context.organizationId,
      providerId,
      sourceInstanceId,
      expectedSourceRevisionId: preview.sourceRevisionId,
      expectedGeneration: BigInt(preview.cursorGeneration),
      expectedFingerprint: preview.cursorFingerprint,
      actorKey: context.actorKey,
      resetAt,
    });
    return Object.freeze({
      cursorGeneration: generation.toString(),
      cursorFingerprint: null,
      audit: commandReceipt(
        "source_cursor_reset",
        sourceInstanceId,
        preview.sourceRevisionId,
        resetAt,
      ),
    });
  }

  async #load(
    context: ProviderSourceAdminCommandContext,
    providerId: string,
    sourceInstanceId: string,
  ): Promise<ProviderSourceLifecycleSnapshot> {
    const source = await this.#repository.loadSource({
      organizationId: context.organizationId,
      providerId,
      sourceInstanceId,
    });
    if (!source) this.#sourceNotFound();
    return source;
  }

  #invalid(): never {
    throw new ProviderSourceAdminServiceError(
      "INVALID_SOURCE_CONFIGURATION",
      422,
    );
  }

  #sourceNotFound(): never {
    throw new ProviderSourceAdminServiceError("SOURCE_NOT_FOUND", 404);
  }

  #connectionNotFound(): never {
    throw new ProviderSourceAdminServiceError("CONNECTION_NOT_FOUND", 404);
  }

  #conflict(): never {
    throw new ProviderSourceAdminServiceError("SOURCE_CONFLICT", 409);
  }

  #dependency(): never {
    throw new ProviderSourceAdminServiceError(
      "SOURCE_DEPENDENCY_REQUIRED",
      424,
    );
  }

  #resetConfirmation(): never {
    throw new ProviderSourceAdminServiceError(
      "RESET_CONFIRMATION_REQUIRED",
      422,
    );
  }
}
