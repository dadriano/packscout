import {
  PrismaProviderSourceRequestAuditRepository,
  locateProviderDatabase,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
} from "@packscout/database";
import type { AesGcmProviderCredentialCipher } from "@packscout/services";
import { CentralDataforrestSourceAuthorityResolver } from
  "../../apps/worker/src/dataforrest-source-authority-resolver.ts";
import { providerDataforrestLiveIntegrationRegistry } from
  "../../apps/worker/src/provider-dataforrest-live-integration.ts";
import { ProviderCatalogIdentityCensusSession, ProviderDataforrestMixedPageSource } from
  "../../apps/worker/src/provider-dataforrest-mixed-page-source.ts";
import { createProviderDataforrestRequestTerminalizer } from
  "../../apps/worker/src/provider-dataforrest-request-terminalizer.ts";
import { createProviderManualImportExecutor } from
  "../../apps/worker/src/provider-manual-import-executor.ts";
import { providerManualImportExecutionBudget } from
  "../../apps/worker/src/provider-manual-import-execution-budget.ts";
import { runProviderManualImportOnce } from
  "../../apps/worker/src/provider-manual-import-local-runtime.ts";
import { refuseCatalogBridge } from "./dataforrest-catalog-bridge-plan.mts";

export function createCatalogBridgeCatalogOneShotExecutor(input: Readonly<{
  central: CentralPrismaClient;
  gateway: BoundedProviderDatabaseGateway;
  credentialCipher: AesGcmProviderCredentialCipher;
  timeoutMilliseconds: number;
}>) {
  const authorityResolver = new CentralDataforrestSourceAuthorityResolver({
    central: input.central, credentialCipher: input.credentialCipher,
  });
  return async (execution: Readonly<{ providerId: string; providerKey: string;
    workerId: string; runId: string }>) => {
    // One process owns the whole one-shot census even though the routed runtime
    // deliberately constructs a fresh page executor for every database step.
    const catalogIdentityCensusSession = new ProviderCatalogIdentityCensusSession();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), input.timeoutMilliseconds);
    try {
      const result = await runProviderManualImportOnce({
        environment: { PACKSCOUT_PROVIDER_ID: execution.providerId,
          PACKSCOUT_PROVIDER_KEY: execution.providerKey,
          PACKSCOUT_PROVIDER_WORKER_ID: execution.workerId },
        fallbackWorkerId: execution.workerId, signal: abort.signal,
        dependencies: {
          async bootstrapProvider(request) {
            if (request.providerId !== execution.providerId ||
              request.providerKey !== execution.providerKey) return null;
            const provider = await input.central.providers.findUnique({
              where: { id: request.providerId },
              select: { id: true, organization_id: true, provider_key: true,
                lifecycle: true, active_config_version_id: true,
                active_config_version: { select: { id: true, version_number: true,
                  adapter_key: true } } },
            });
            if (!provider || provider.lifecycle !== "active" ||
              provider.provider_key !== request.providerKey ||
              !provider.active_config_version_id || !provider.active_config_version ||
              provider.active_config_version.id !== provider.active_config_version_id) return null;
            const integration = providerDataforrestLiveIntegrationRegistry.resolve(
              request.providerKey, provider.active_config_version.adapter_key);
            if (!integration) return null;
            const located = await locateProviderDatabase(input.central, {
              organizationId: provider.organization_id, providerId: provider.id,
            });
            if (located.state !== "ready" ||
              located.route.configVersionId !== provider.active_config_version.id) return null;
            const sourceAuthority = await authorityResolver.resolve({
              providerId: provider.id, providerKey: request.providerKey,
              configVersionId: provider.active_config_version.id,
              configVersionNumber: provider.active_config_version.version_number,
              adapterKey: provider.active_config_version.adapter_key,
            });
            return Object.freeze({ organizationId: provider.organization_id,
              providerId: provider.id, providerKey: request.providerKey,
              databaseRoute: located.route, sourceAuthority, integration });
          },
          runWithCachedProviderDatabase: (route, operation) =>
            input.gateway.runWithCachedProviderDatabase(route, operation),
          createExecutor(value) {
            const audit = new PrismaProviderSourceRequestAuditRepository(value.database);
            const source = new ProviderDataforrestMixedPageSource({
              authorityResolver: value.sourceAuthorityResolver,
              integration: value.integration, workerId: value.workerId,
              catalogIdentityCensusSession,
              maximumPageRecords: providerManualImportExecutionBudget("remote").maximumPageRecords,
              translationRecorder: audit,
              terminalizeRequest: createProviderDataforrestRequestTerminalizer({
                audit, workerId: value.workerId,
              }),
            });
            return createProviderManualImportExecutor({ database: value.database,
              captureRoot: null, actorHmacKey: null, workerId: value.workerId,
              liveSource: source, executionMode: "remote" });
          },
        },
      });
      if (result.kind === "completed" && result.runId === execution.runId) {
        return Object.freeze({ kind: "completed" as const, runId: result.runId });
      }
      if (result.kind === "blocked" || result.kind === "failed") {
        return Object.freeze({ kind: result.kind, runId: result.runId,
          failureCode: result.failureCode });
      }
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ONE_SHOT_NOT_TERMINAL");
    } finally {
      clearTimeout(timeout);
    }
  };
}
