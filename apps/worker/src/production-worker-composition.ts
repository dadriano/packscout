import {
  PrismaCatalogPromotionRepository,
  PrismaCatalogReleaseSourceRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  CatalogReleaseAssembler,
  type OperationalObservability,
} from "@packscout/services";
import {
  createCatalogPromotionWorkerRuntime,
} from "./catalog-promotion-worker-composition.ts";
import type {
  CatalogPromotionWorkerConfiguration,
} from "./catalog-promotion-worker-config.ts";
import {
  CatalogPromotionWorkerTerminalAlertLogger,
  type CatalogPromotionWorkerLogger,
} from "./catalog-promotion-worker-runtime.ts";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import { createProviderWorkerPublicSettlementReader } from "./provider-worker-public-settlement.ts";
import type { ProviderWorkerLogger } from "./provider-worker-runtime.ts";
import type { ProviderWorkerConfiguration } from "./runtime-config.ts";

export interface ProductionWorkerCompositionInput {
  readonly provider: ProviderWorkerConfiguration;
  readonly catalog: CatalogPromotionWorkerConfiguration;
  readonly database: PackscoutPrismaClient;
  readonly providerLogger: ProviderWorkerLogger;
  readonly catalogLogger: CatalogPromotionWorkerLogger;
  readonly observability: OperationalObservability;
  readonly fetch?: typeof fetch;
}

/** Wires the approved tenant to both independent worker loops server-side. */
export function createProductionWorkerRuntime(
  input: ProductionWorkerCompositionInput,
) {
  const settlement = createProviderWorkerPublicSettlementReader({
    database: input.database,
    publicOrganizationId: input.provider.publicOrganizationId,
  });
  const ledger = new PrismaCatalogPromotionRepository(input.database, {
    organizationId: input.provider.publicOrganizationId,
    deploymentKey: input.catalog.deploymentKey,
  });
  const catalogPromotion = createCatalogPromotionWorkerRuntime({
    configuration: input.catalog,
    organizationId: input.provider.publicOrganizationId,
    workerId: input.provider.workerId,
    ledger,
    bootstrapLedger: ledger,
    settlement,
    assembler: new CatalogReleaseAssembler(
      settlement,
      new PrismaCatalogReleaseSourceRepository(
        input.database,
        input.provider.publicOrganizationId,
      ),
    ),
    alerts: new CatalogPromotionWorkerTerminalAlertLogger(
      input.catalogLogger,
      input.provider.workerId,
    ),
    logger: input.catalogLogger,
    fetch: input.fetch,
  });
  return createProviderWorkerRuntime({
    configuration: input.provider,
    database: input.database,
    logger: input.providerLogger,
    observability: input.observability,
    catalogPromotion,
  });
}
