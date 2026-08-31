import { randomUUID } from "node:crypto";
import { reviseDistributedProviderRequestSettingsRequestSchema } from "@packscout/contracts";
import {
  PrismaProviderRequestSettingsRepository,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type ProviderPrismaClient,
} from "@packscout/database";
import type { ProviderSourceIntegrationCapabilityRegistry } from "@packscout/services";
import {
  DistributedProviderRequestSettingsError,
  type DistributedProviderRequestSettingsRouterDependencies,
} from "./routes/distributed-provider-request-settings.ts";

/** Organization-owned central authority routes this command to one isolated database. */
export function createDistributedProviderRequestSettingsRuntime(input: Readonly<{
  central: CentralPrismaClient;
  gateway: Pick<BoundedProviderDatabaseGateway, "runWithAdminProviderDatabase">;
  sourceIntegrations: Pick<ProviderSourceIntegrationCapabilityRegistry, "resolve">;
  repository?: (database: ProviderPrismaClient) => Pick<
    PrismaProviderRequestSettingsRepository, "current" | "revise"
  >;
  correlationId?: () => string;
  now?: () => Date;
}>): Pick<DistributedProviderRequestSettingsRouterDependencies, "requestSettings"> {
  const repository = input.repository ?? ((database) => new PrismaProviderRequestSettingsRepository(database));
  const now = input.now ?? (() => new Date());
  // Shorter than the concrete gateway's 15s envelope, including acquisition.
  const writeBudgetMilliseconds = 10_000;
  async function authority(organizationId: string, providerId: string) {
    const provider = await input.central.providers.findFirst({
      where: { id: providerId, organization_id: organizationId, lifecycle: { not: "archived" } },
      select: {
        id: true,
        provider_key: true,
        active_config_version: {
          select: { id: true, version_number: true, adapter_key: true, expires_at: true },
        },
      },
    });
    if (!provider) throw new DistributedProviderRequestSettingsError("SOURCE_NOT_FOUND", 404);
    const config = provider.active_config_version;
    if (!config || !input.sourceIntegrations.resolve(provider.provider_key, config.adapter_key) ||
        (config.expires_at !== null && config.expires_at.getTime() <= now().getTime())) {
      throw new DistributedProviderRequestSettingsError("SOURCE_OPERATIONS_UNAVAILABLE", 503);
    }
    return { provider, config };
  }
  return {
    requestSettings: {
      async revise(command) {
        const request = reviseDistributedProviderRequestSettingsRequestSchema.parse(command.request);
        const writeDeadline = new Date(now().getTime() + writeBudgetMilliseconds);
        let authorizationActive = true;
        const assertWriteAuthorized = () => {
          if (!authorizationActive || now().getTime() >= writeDeadline.getTime()) {
            throw new DistributedProviderRequestSettingsError("SOURCE_OPERATIONS_UNAVAILABLE", 503);
          }
        };
        const initial = await authority(command.organizationId, command.providerId);
        assertWriteAuthorized();
        if (initial.config.id !== request.expectedConfigVersionId) {
          throw new DistributedProviderRequestSettingsError("SOURCE_REVISION_CONFLICT", 409);
        }
        const operation = async (database: ProviderPrismaClient) => {
            assertWriteAuthorized();
            const current = await authority(command.organizationId, command.providerId);
            assertWriteAuthorized();
            if (current.config.id !== initial.config.id ||
                current.config.version_number !== initial.config.version_number ||
                current.config.adapter_key !== initial.config.adapter_key ||
                current.provider.provider_key !== initial.provider.provider_key) {
              return { kind: "configuration_conflict" as const };
            }
            const settings = repository(database);
            // Read-only uninitialized providers must not be silently initialized by this UI.
            if (await settings.current({ providerId: command.providerId }) === null) {
              return { kind: "uninitialized" as const };
            }
            assertWriteAuthorized();
            return settings.revise({
              providerId: command.providerId,
              expectedRevisionId: request.expectedRequestSettingsRevisionId,
              recordsPerRequest: request.recordsPerRequest,
              actorOperatorId: command.operatorId,
              correlationId: (input.correlationId ?? randomUUID)(),
              expectedConfigVersionId: current.config.id,
              expectedConfigVersionNumber: current.config.version_number,
              adapterKey: current.config.adapter_key,
              writeDeadline,
            });
        };
        let pending: ReturnType<typeof operation> | undefined;
        let result: Awaited<ReturnType<typeof operation>>;
        try {
          const outcome = await input.gateway.runWithAdminProviderDatabase(
            { organizationId: command.organizationId, providerId: command.providerId },
            (database) => {
              // Acquisition may consume the entire budget before this callback.
              assertWriteAuthorized();
              pending = operation(database);
              return pending;
            },
          );
          if (outcome.state === "reachable") {
            result = outcome.value;
          } else {
            authorizationActive = false;
            // Gateway timeout does not cancel its callback. Do not send a
            // response while a started write could still commit afterward.
            const settled = pending ? await pending.catch(() => null) : null;
            if (settled?.kind !== "updated" && settled?.kind !== "unchanged") {
              throw new DistributedProviderRequestSettingsError("SOURCE_OPERATIONS_UNAVAILABLE", 503);
            }
            // The mutation's own deadline/CAS governs admission and commit.
            // A definitive drained commit deserves a truthful acknowledgement.
            result = settled;
          }
        } finally {
          authorizationActive = false;
          if (pending) await pending.catch(() => undefined);
        }
        if (result.kind === "updated" || result.kind === "unchanged") {
          return {
            requestSettingsRevisionId: result.revision.id,
            recordsPerRequest: result.revision.recordsPerRequest,
          };
        }
        if (result.kind === "revision_conflict") {
          throw new DistributedProviderRequestSettingsError("SOURCE_CONFLICT", 409);
        }
        if (result.kind === "configuration_conflict" || result.kind === "configuration_expired") {
          throw new DistributedProviderRequestSettingsError("SOURCE_REVISION_CONFLICT", 409);
        }
        throw new DistributedProviderRequestSettingsError("SOURCE_OPERATIONS_UNAVAILABLE", 503);
      },
    },
  };
}
