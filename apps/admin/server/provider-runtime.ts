import { createHmac, randomUUID } from "node:crypto";
import type { ProviderConfigurationSummary } from "@packscout/contracts";
import {
  AesGcmProviderCredentialCipher,
  HttpCursorAdapter,
  ProviderConfigurationService,
  ProviderHealthService,
  ProviderTransportAdapterRegistry,
  type ProviderConfigurationRepository,
  type ProviderHealthDto,
  type ProviderHealthRepository,
  type ProviderFreshnessOperationalHooks,
  type ProviderRuntimeEnvironment,
} from "@packscout/services";
import type {
  ProviderAdminListItem,
  ProviderHealthView,
  ProvidersRouterDependencies,
} from "./routes/providers.ts";

interface ProviderCatalogRepository extends ProviderConfigurationRepository {
  listProviders(
    organizationId: string,
  ): Promise<readonly ProviderConfigurationSummary[]>;
}

export interface ProviderAdminRuntimeInput {
  readonly repository: ProviderCatalogRepository;
  readonly healthRepository: ProviderHealthRepository;
  readonly credentialKey: Uint8Array;
  readonly actorPseudonymKey: Uint8Array;
  readonly environment: ProviderRuntimeEnvironment;
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
  const configuration = new ProviderConfigurationService({
    repository: input.repository,
    adapters: new ProviderTransportAdapterRegistry([new HttpCursorAdapter()]),
    credentialCipher: new AesGcmProviderCredentialCipher({
      primaryVersion: 1,
      keys: new Map([[1, input.credentialKey]]),
    }),
    actorKeyer: {
      keyFor({ organizationId, operatorId }) {
        return `actor:v1:${createHmac(
          "sha256",
          Buffer.from(input.actorPseudonymKey),
        )
          .update(`${organizationId}\u0000${operatorId}`)
          .digest("hex")}`;
      },
    },
    clock,
    ids: { id: randomUUID },
    environment: input.environment,
  });

  return {
    configuration,
    health: {
      async getHealth(request) {
        return healthView(await health.getHealth(request));
      },
    },
    catalog: {
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
