import type { ProviderConfigurationSummary } from "@packscout/contracts";
import {
  ProviderHealthService,
  type ProviderConfigurationRepository,
  type ProviderHealthDto,
  type ProviderHealthRepository,
  type ProviderFreshnessOperationalHooks,
} from "@packscout/services";
import type {
  ProviderAdminListItem,
  ProviderHealthView,
  ProvidersRouterDependencies,
} from "./routes/providers.ts";

interface ProviderCatalogRepository extends Pick<
  ProviderConfigurationRepository,
  "getProvider"
> {
  listProviders(
    organizationId: string,
  ): Promise<readonly ProviderConfigurationSummary[]>;
}

export interface ProviderAdminRuntimeInput {
  readonly repository: ProviderCatalogRepository;
  readonly healthRepository: ProviderHealthRepository;
  readonly operational?: ProviderFreshnessOperationalHooks;
}

function healthView(health: ProviderHealthDto): ProviderHealthView {
  return {
    providerId: health.providerId,
    freshnessState: health.freshnessState,
    qualityState: health.qualityState,
    activeRun: health.activeRun,
    latestRun: health.latestRun,
    lastHeadReachedAt: health.lastHeadReachedAt,
    nextDueAt: health.nextDueAt,
    openQuarantineCount: health.openQuarantineCount,
    consecutiveFailures: health.consecutiveFailures,
    latestFailureClass: health.latestFailureClass,
    recoveryHint: health.recoveryHint,
  };
}

export function createProviderAdminRuntime(
  input: ProviderAdminRuntimeInput,
): Omit<ProvidersRouterDependencies, "auth" | "cookiePolicy" | "sameOrigin"> {
  const clock = { now: () => new Date() };
  const health = new ProviderHealthService(
    input.healthRepository,
    clock,
    input.operational,
  );
  return {
    health: {
      async getHealth(request) {
        return healthView(await health.getHealth(request));
      },
    },
    catalog: {
      getProvider(organizationId, providerId) {
        return input.repository.getProvider(organizationId, providerId);
      },
      async listProviders(organizationId): Promise<readonly ProviderAdminListItem[]> {
        const providers = await input.repository.listProviders(organizationId);
        return Promise.all(
          providers.map(async (provider) => ({
            provider,
            health: healthView(await health.getHealth({
              organizationId,
              providerId: provider.id,
            })),
          })),
        );
      },
    },
  };
}
