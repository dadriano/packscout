import type {
  ProviderLifecycleState,
  ProviderSourceRootSummary,
} from "@packscout/contracts";
import {
  CentralAdminProviderRepository,
  type CentralQueryClient,
} from "@packscout/database";
import type {
  ProvidersRouterDependencies,
} from "./routes/providers.ts";

interface ProviderSourceRootRecord {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly state: ProviderLifecycleState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ProviderCatalogRepository {
  listProviders(
    organizationId: string,
  ): Promise<readonly ProviderSourceRootRecord[]>;
  getProvider(
    organizationId: string,
    providerId: string,
  ): Promise<ProviderSourceRootRecord | null>;
}

export interface ProviderAdminRuntimeInput {
  readonly repository: ProviderCatalogRepository;
}

function providerSummary(
  provider: ProviderSourceRootRecord,
): ProviderSourceRootSummary {
  return {
    id: provider.id,
    platformKey: provider.provider,
    displayName: provider.displayName,
    state: provider.state,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

export function createProviderAdminRuntime(
  input: ProviderAdminRuntimeInput,
): Omit<ProvidersRouterDependencies, "auth" | "cookiePolicy" | "sameOrigin"> {
  return {
    catalog: {
      async getProvider(organizationId, providerId) {
        const provider = await input.repository.getProvider(
          organizationId,
          providerId,
        );
        return provider === null ? null : providerSummary(provider);
      },
      async listProviders(organizationId) {
        const providers = await input.repository.listProviders(organizationId);
        return providers.map(providerSummary);
      },
    },
  };
}

/** Central-only composition used by the distributed admin runtime. */
export function createCentralProviderAdminRuntime(
  central: CentralQueryClient,
): ReturnType<typeof createProviderAdminRuntime> {
  return createProviderAdminRuntime({
    repository: new CentralAdminProviderRepository(central),
  });
}
