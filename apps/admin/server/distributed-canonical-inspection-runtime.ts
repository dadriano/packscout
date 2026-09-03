import {
  ProviderCanonicalInspectionRepository,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
} from "@packscout/database";
import {
  CanonicalInspectionError,
  CanonicalInspectionService,
} from "@packscout/services";

type CanonicalRuntime = Pick<
  CanonicalInspectionService,
  "listProviders" | "summarizeProvider" | "listEntities" | "readEntity"
>;

interface ProviderDirectoryRow {
  readonly id: string;
  readonly provider_key: string;
  readonly display_name: string;
  readonly lifecycle: string;
}

type RoutedSettlement<T> =
  | { readonly state: "succeeded"; readonly value: T }
  | { readonly state: "failed"; readonly reason: unknown };

function unavailable(): CanonicalInspectionError {
  return new CanonicalInspectionError(
    "CANONICAL_STORE_UNAVAILABLE",
    "Canonical data is temporarily unavailable.",
    503,
  );
}

function unknownProvider(): CanonicalInspectionError {
  return new CanonicalInspectionError(
    "CANONICAL_PROVIDER_UNKNOWN",
    "That provider is not configured in this workspace.",
    404,
  );
}

/**
 * Preserves the current Canonical Data service while enforcing distributed
 * ownership: provider discovery is central, and every provider-data read goes
 * through the bounded admin gateway using the centrally resolved provider ID.
 */
export function createDistributedCanonicalInspectionRuntime(input: {
  readonly central: CentralPrismaClient;
  readonly gateway: Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
}): CanonicalRuntime {
  async function providerFor(
    organizationId: string,
    platformKey: string,
  ): Promise<ProviderDirectoryRow> {
    let provider: ProviderDirectoryRow | null;
    try {
      provider = await input.central.providers.findFirst({
        where: {
          organization_id: organizationId,
          provider_key: platformKey,
        },
        select: {
          id: true,
          provider_key: true,
          display_name: true,
          lifecycle: true,
        },
      });
    } catch {
      throw unavailable();
    }
    if (provider === null) throw unknownProvider();
    return provider;
  }

  async function throughProvider<T>(
    scope: { readonly organizationId: string; readonly platformKey: string },
    operation: (service: CanonicalInspectionService) => Promise<T>,
  ): Promise<T> {
    const provider = await providerFor(scope.organizationId, scope.platformKey);
    const routed = await input.gateway.runWithAdminProviderDatabase(
      {
        organizationId: scope.organizationId,
        providerId: provider.id,
      },
      async (database): Promise<RoutedSettlement<T>> => {
        const service = new CanonicalInspectionService(
          new ProviderCanonicalInspectionRepository(database, {
            organizationId: scope.organizationId,
            platformKey: provider.provider_key,
            displayName: provider.display_name,
            state: provider.lifecycle,
          }),
        );
        // The database gateway deliberately collapses a rejected operation to
        // a reachability outcome. Settle classified service failures inside the
        // callback so request-validation and not-found codes survive routing.
        try {
          return { state: "succeeded", value: await operation(service) };
        } catch (reason) {
          return { state: "failed", reason };
        }
      },
    );
    if (routed.state === "unreachable") throw unavailable();
    if (routed.value.state === "failed") throw routed.value.reason;
    return routed.value.value;
  }

  return {
    async listProviders(organizationId) {
      try {
        const providers = await input.central.providers.findMany({
          where: { organization_id: organizationId },
          select: {
            provider_key: true,
            display_name: true,
            lifecycle: true,
          },
          orderBy: [{ display_name: "asc" }, { provider_key: "asc" }],
        });
        // This list intentionally performs no provider-database read. A broken
        // lane remains visible with its central lifecycle instead of taking the
        // roster (and every Data page) down with it.
        return providers.map((provider) => ({
          platformKey: provider.provider_key,
          displayName: provider.display_name,
          state: provider.lifecycle,
        }));
      } catch {
        throw unavailable();
      }
    },

    summarizeProvider(request) {
      return throughProvider(request, (service) =>
        service.summarizeProvider(request));
    },

    listEntities(request) {
      return throughProvider(request, (service) => service.listEntities(request));
    },

    readEntity(request) {
      return throughProvider(request, (service) => service.readEntity(request));
    },
  };
}
