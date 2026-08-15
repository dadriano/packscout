import { randomUUID } from "node:crypto";
import {
  PrismaAdminNotificationPublisher,
  PrismaCatalogPromotionRepository,
  PrismaCatalogReleaseSourceRepository,
  PrismaHeatPromotionReleaseRepository,
  PrismaHeatPromotionRepository,
  PrismaNormalizedHeatObservationRepository,
  PrismaNormalizedHeatRetentionRepository,
  PrismaPromotionReadinessRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  CatalogReleaseAssembler,
  NormalizedHeatObservationService,
  OperationalEventService,
  PromotionOperationalReadinessService,
  type OperationalObservability,
} from "@packscout/services";
import {
  createCatalogPromotionWorkerRuntime,
} from "./catalog-promotion-worker-composition.ts";
import {
  CatalogPromotionOperationalReadinessSink,
} from "./catalog-promotion-operational-readiness.ts";
import type {
  CatalogPromotionWorkerConfiguration,
} from "./catalog-promotion-worker-config.ts";
import {
  createHeatPromotionWorkerRuntime,
} from "./heat-promotion-worker-composition.ts";
import type {
  HeatPromotionWorkerConfiguration,
} from "./heat-promotion-worker-config.ts";
import {
  HeatPromotionOperationalReadinessSink,
} from "./heat-promotion-operational-readiness.ts";
import {
  HeatPromotionRetentionCoordinator,
} from "./heat-promotion-retention.ts";
import {
  HeatPromotionWorkerTerminalAlertLogger,
  type HeatPromotionWorkerLogger,
} from "./heat-promotion-worker-runtime.ts";
import {
  CatalogPromotionWorkerTerminalAlertLogger,
  type CatalogPromotionWorkerLogger,
} from "./catalog-promotion-worker-runtime.ts";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import { createProviderWorkerPublicSettlementReader } from "./provider-worker-public-settlement.ts";
import type { ProviderWorkerLogger } from "./provider-worker-runtime.ts";
import { runPromotionObservabilityFanout } from "./promotion-observability-fanout.ts";
import type { ProviderWorkerConfiguration } from "./runtime-config.ts";

export interface ProductionWorkerCompositionInput {
  readonly provider: ProviderWorkerConfiguration;
  readonly catalog: CatalogPromotionWorkerConfiguration;
  readonly heat: HeatPromotionWorkerConfiguration;
  readonly database: PackscoutPrismaClient;
  readonly providerLogger: ProviderWorkerLogger;
  readonly catalogLogger: CatalogPromotionWorkerLogger;
  readonly heatLogger: HeatPromotionWorkerLogger;
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
  const clock = { now: () => new Date() };
  const operationalEvents = new OperationalEventService(
    new PrismaAdminNotificationPublisher(input.database),
    { id: randomUUID },
    clock,
  );
  const readinessRepository = new PrismaPromotionReadinessRepository(
    input.database,
    {
      organizationId: input.provider.publicOrganizationId,
      deploymentKey: input.catalog.deploymentKey,
      lane: "catalog",
    },
  );
  const readiness = new CatalogPromotionOperationalReadinessSink(
    new PromotionOperationalReadinessService(
      operationalEvents,
      readinessRepository,
      clock,
      {
        organizationId: input.provider.publicOrganizationId,
        deploymentScopeDigest: readinessRepository.deploymentScopeDigest,
        lane: "catalog",
        targetSource: "canonical_settlement",
        monitorTechnicalSettlement: true,
      },
    ),
  );
  const terminalLogger = new CatalogPromotionWorkerTerminalAlertLogger(
    input.catalogLogger,
    input.provider.workerId,
  );
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
    alerts: {
      async notify(alert) {
        await runPromotionObservabilityFanout(
          () => readiness.notify(alert),
          () => terminalLogger.notify(alert),
        );
      },
    },
    health: readiness,
    logger: input.catalogLogger,
    fetch: input.fetch,
  });
  const heatProofs = new PrismaHeatPromotionReleaseRepository(input.database, {
    organizationId: input.provider.publicOrganizationId,
    deploymentKey: input.heat.deploymentKey,
  });
  const heatLedger = new PrismaHeatPromotionRepository(input.database, {
    organizationId: input.provider.publicOrganizationId,
    deploymentKey: input.heat.deploymentKey,
  });
  const heatReadinessRepository = new PrismaPromotionReadinessRepository(
    input.database,
    {
      organizationId: input.provider.publicOrganizationId,
      deploymentKey: input.heat.deploymentKey,
      lane: "heat",
    },
  );
  const heatReadiness = new HeatPromotionOperationalReadinessSink(
    new PromotionOperationalReadinessService(
      operationalEvents,
      heatReadinessRepository,
      clock,
      {
        organizationId: input.provider.publicOrganizationId,
        deploymentScopeDigest:
          heatReadinessRepository.deploymentScopeDigest,
        lane: "heat",
        targetSource: "promotion_lane",
        monitorTechnicalSettlement: false,
      },
    ),
  );
  const heatTerminalLogger = new HeatPromotionWorkerTerminalAlertLogger(
    input.heatLogger,
    input.provider.workerId,
  );
  const heatPromotion = createHeatPromotionWorkerRuntime({
    configuration: input.heat,
    workerId: input.provider.workerId,
    ledger: heatLedger,
    settlement,
    releases: heatProofs,
    observations: new NormalizedHeatObservationService(
      new PrismaNormalizedHeatObservationRepository(input.database, {
        organizationId: input.provider.publicOrganizationId,
      }),
      { organizationId: input.provider.publicOrganizationId },
    ),
    retention: new HeatPromotionRetentionCoordinator(
      new PrismaNormalizedHeatRetentionRepository(input.database, {
        organizationId: input.provider.publicOrganizationId,
      }),
      input.heat.retentionBatchSize,
      input.heat.retentionMaximumBatchesPerCycle,
    ),
    alerts: {
      async notify(alert) {
        await runPromotionObservabilityFanout(
          () => heatReadiness.notify(alert),
          () => heatTerminalLogger.notify(alert),
        );
      },
    },
    health: heatReadiness,
    logger: input.heatLogger,
    fetch: input.fetch,
  });
  return createProviderWorkerRuntime({
    configuration: input.provider,
    database: input.database,
    logger: input.providerLogger,
    observability: input.observability,
    catalogPromotion,
    heatPromotion,
  });
}
