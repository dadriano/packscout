import type {
  ProviderActor,
  ProviderClock,
} from "./provider-configuration-service.ts";
import type { ProviderSourceIntegrationCapabilityRegistry } from
  "./provider-source-integration-capability.ts";
import {
  ProviderSourceImportRequestError,
  type ProviderSourceImportRunSummary,
} from "./provider-source-import-request-service.ts";

export interface ProviderSourceImportAdmissionRepository {
  resolveImportAdmission(input: Readonly<{
    organizationId: string;
    providerId: string;
    expectedConfigVersionId: string;
    now: Date;
  }>): Promise<
    | Readonly<{ kind: "not_found" }>
    | Readonly<{ kind: "source_unavailable" }>
    | Readonly<{
        kind: "revision_conflict";
        activeConfigVersionId: string;
      }>
    | Readonly<{
        kind: "ready";
        providerId: string;
        providerKey: string;
        adapterKey: string;
        configVersionId: string;
        configVersionNumber: bigint;
        configuration: Readonly<Record<string, unknown>>;
        configExpiresAt: Date | null;
        scheduleSeconds: number;
      }>
  >;
}

export interface ProviderSourceManualImportDelegate {
  requestManual(input: Readonly<{
    actor: ProviderActor;
    providerId: string;
    expectedSourceRevisionId: string;
    authority: Readonly<{
      providerKey: string;
      adapterKey: string;
      configVersionId: string;
      configVersionNumber: bigint;
      configuration: Readonly<Record<string, unknown>>;
      configExpiresAt: Date | null;
      scheduleSeconds: number;
    }>;
  }>): Promise<Readonly<{
    run: ProviderSourceImportRunSummary;
    coalesced: boolean;
  }>>;
}

/**
 * Admission boundary for the authoritative admin's provider-level Run now
 * command. Central ownership and installed execution capability are proven
 * before the provider-local delegate can create a command or run.
 */
export class ProviderSourceImportAdmissionService {
  constructor(private readonly dependencies: Readonly<{
    providers: ProviderSourceImportAdmissionRepository;
    sourceIntegrations: Pick<
      ProviderSourceIntegrationCapabilityRegistry,
      "resolve"
    >;
    delegate: ProviderSourceManualImportDelegate;
    clock: ProviderClock;
  }>) {}

  async requestManual(input: Readonly<{
    actor: ProviderActor;
    providerId: string;
    expectedSourceRevisionId: string;
  }>): ReturnType<ProviderSourceManualImportDelegate["requestManual"]> {
    const admission = await this.dependencies.providers.resolveImportAdmission({
      organizationId: input.actor.organizationId,
      providerId: input.providerId,
      expectedConfigVersionId: input.expectedSourceRevisionId,
      now: this.dependencies.clock.now(),
    });
    if (admission.kind === "not_found") {
      throw new ProviderSourceImportRequestError("PROVIDER_NOT_FOUND", 404);
    }
    if (admission.kind === "revision_conflict") {
      throw new ProviderSourceImportRequestError(
        "SOURCE_REVISION_CONFLICT",
        409,
      );
    }
    if (admission.kind === "source_unavailable") {
      throw new ProviderSourceImportRequestError("SOURCE_NOT_IMPORTABLE", 409);
    }
    if (this.dependencies.sourceIntegrations.resolve(
      admission.providerKey,
      admission.adapterKey,
    ) === null) {
      throw new ProviderSourceImportRequestError(
        "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
        503,
      );
    }
    return this.dependencies.delegate.requestManual({
      ...input,
      authority: {
        providerKey: admission.providerKey,
        adapterKey: admission.adapterKey,
        configVersionId: admission.configVersionId,
        configVersionNumber: admission.configVersionNumber,
        configuration: admission.configuration,
        configExpiresAt: admission.configExpiresAt,
        scheduleSeconds: admission.scheduleSeconds,
      },
    });
  }
}
