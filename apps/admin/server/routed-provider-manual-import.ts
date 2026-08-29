import { randomUUID } from "node:crypto";
import {
  PrismaAdminProviderRuntimeRepository,
  PrismaProviderRuntimeRepository,
  type BoundedProviderDatabaseGateway,
  type CanonicalJsonObject,
} from "@packscout/database";
import {
  ProviderSourceImportRequestError,
  type ProviderSourceImportRunSummary,
  type ProviderSourceManualImportDelegate,
} from "@packscout/services";

export interface RoutedProviderManualImportIds {
  id(): string;
}

function localConfiguration(input: {
  readonly adapterKey: string;
  readonly configuration: Readonly<Record<string, unknown>>;
}): CanonicalJsonObject {
  return {
    adapterKey: input.adapterKey,
    settings: input.configuration as CanonicalJsonObject,
  };
}

function unavailable(): never {
  throw new ProviderSourceImportRequestError(
    "PROVIDER_DATABASE_UNREACHABLE",
    503,
  );
}

/**
 * Provider-local half of current-admin Run now. Central admission has already
 * proved organization ownership and installed capability before this delegate
 * resolves or mutates a provider database.
 */
export class RoutedProviderManualImportDelegate
implements ProviderSourceManualImportDelegate {
  readonly #ids: RoutedProviderManualImportIds;
  readonly #now: () => Date;

  constructor(private readonly dependencies: Readonly<{
    gateway: Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
    ids?: RoutedProviderManualImportIds;
    now?: () => Date;
  }>) {
    this.#ids = dependencies.ids ?? { id: randomUUID };
    this.#now = dependencies.now ?? (() => new Date());
  }

  async requestManual(
    input: Parameters<ProviderSourceManualImportDelegate["requestManual"]>[0],
  ): Promise<Readonly<{
    run: ProviderSourceImportRunSummary;
    coalesced: boolean;
  }>> {
    const operation = await this.dependencies.gateway.runWithAdminProviderDatabase(
      {
        organizationId: input.actor.organizationId,
        providerId: input.providerId,
      },
      async (database) => {
        const synchronized = await new PrismaProviderRuntimeRepository(database)
          .synchronizeConfiguration({
            centralProviderId: input.providerId,
            providerKey: input.authority.providerKey,
            configVersionId: input.authority.configVersionId,
            configVersionNumber: input.authority.configVersionNumber,
            configuration: localConfiguration(input.authority),
            expiresAt: input.authority.configExpiresAt,
            scheduleSeconds: input.authority.scheduleSeconds,
            nextDueAt: null,
            synchronizedAt: this.#now(),
          });
        if (
          synchronized.kind === "identity_mismatch"
          || synchronized.kind === "version_conflict"
        ) {
          throw new ProviderSourceImportRequestError(
            "SOURCE_REVISION_CONFLICT",
            409,
          );
        }

        const commandId = this.#ids.id();
        const result = await new PrismaAdminProviderRuntimeRepository(database)
          .requestRunNow({
            providerId: input.providerId,
            operatorId: input.actor.operatorId,
            expectedConfigVersionId: input.authority.configVersionId,
            expectedConfigVersionNumber: input.authority.configVersionNumber,
            expectedGeneration: synchronized.runtime.generation,
            idempotencyKey: "manual/" + commandId,
            commandId,
            runId: this.#ids.id(),
            correlationId: this.#ids.id(),
          });
        if (result.kind !== "created" && result.kind !== "deduplicated") {
          if (
            result.kind === "configuration_conflict"
            || result.kind === "configuration_expired"
          ) {
            throw new ProviderSourceImportRequestError(
              "SOURCE_REVISION_CONFLICT",
              409,
            );
          }
          throw new ProviderSourceImportRequestError(
            "SOURCE_NOT_IMPORTABLE",
            409,
          );
        }
        return result;
      },
    );
    if (operation.state === "unreachable") unavailable();
    const local = operation.value;
    return {
      run: {
        id: local.run.id,
        organizationId: input.actor.organizationId,
        providerId: input.providerId,
        sourceInstanceId: input.providerId,
        sourceRevisionId: local.run.configVersionId,
        trigger: local.run.trigger,
        state: local.run.state,
        requestedCursorFingerprint: local.run.requestedCursorHash,
        createdAt: local.run.requestedAt,
      },
      coalesced: local.kind === "deduplicated",
    };
  }
}

export function createRoutedProviderManualImportDelegate(input: Readonly<{
  gateway: Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  ids?: RoutedProviderManualImportIds;
  now?: () => Date;
}>): ProviderSourceManualImportDelegate {
  return new RoutedProviderManualImportDelegate(input);
}
