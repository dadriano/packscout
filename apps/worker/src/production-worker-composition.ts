import { randomUUID } from "node:crypto";
import {
  PrismaAdminNotificationPublisher,
  PrismaHeatPromotionManifestRepository,
  PrismaHeatPromotionRepository,
  PrismaNormalizedHeatObservationRepository,
  PrismaNormalizedHeatRelationshipBackfillRepository,
  PrismaNormalizedHeatRetentionRepository,
  PrismaPromotionReadinessRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  NormalizedHeatObservationService,
  OperationalEventService,
  PromotionOperationalReadinessService,
  type OperationalObservability,
} from "@packscout/services";
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
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import { createProviderWorkerPublicSettlementReader } from "./provider-worker-public-settlement.ts";
import type { ProviderWorkerLogger } from "./provider-worker-runtime.ts";
import { runPromotionObservabilityFanout } from "./promotion-observability-fanout.ts";
import type { ProviderWorkerConfiguration } from "./runtime-config.ts";
import { createProviderSourceSupervisorRuntime } from
  "./provider-source-supervisor-composition.ts";
import { createCatalogRetentionWorkerRuntime } from
  "./catalog-retention-worker-composition.ts";
import {
  assertCatalogRetentionCredentialRoleIsolation,
  type CatalogRetentionWorkerConfiguration,
} from "./catalog-retention-worker-config.ts";
import type { CatalogRetentionWorkerLogger } from
  "./catalog-retention-worker-runtime.ts";
import { createSourceRelationshipConfirmationBackfillRunner } from
  "./source-relationship-confirmation-backfill-composition.ts";

export interface ProductionWorkerCompositionInput {
  readonly provider: ProviderWorkerConfiguration;
  readonly heat: HeatPromotionWorkerConfiguration;
  readonly retention: CatalogRetentionWorkerConfiguration;
  readonly database: PackscoutPrismaClient;
  readonly providerLogger: ProviderWorkerLogger;
  readonly heatLogger: HeatPromotionWorkerLogger;
  readonly retentionLogger: CatalogRetentionWorkerLogger;
  readonly observability: OperationalObservability;
  readonly fetch?: typeof fetch;
}

/** Wires the provider base worker, Heat, and catalog retention loops. */
export function createProductionWorkerRuntime(
  input: ProductionWorkerCompositionInput,
) {
  assertCatalogRetentionCredentialRoleIsolation({
    heat: input.heat,
    retention: input.retention,
  });
  const settlement = createProviderWorkerPublicSettlementReader({
    database: input.database,
    publicOrganizationId: input.provider.publicOrganizationId,
  });
  const clock = { now: () => new Date() };
  const operationalEvents = new OperationalEventService(
    new PrismaAdminNotificationPublisher(input.database),
    { id: randomUUID },
    clock,
  );
  const heatProofs = new PrismaHeatPromotionManifestRepository(input.database, {
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
    manifests: heatProofs,
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
  const catalogRetention = createCatalogRetentionWorkerRuntime({
    configuration: input.retention,
    organizationId: input.provider.publicOrganizationId,
    workerId: input.provider.workerId,
    database: input.database,
    logger: input.retentionLogger,
    fetch: input.fetch,
  });
  // The source-supervisor lane only exists when its settings do; the
  // combined worker's other lanes never depend on it.
  const sourceSupervisor = input.provider.sourceSupervisor === undefined
    ? undefined
    : createProviderSourceSupervisorRuntime({
      configuration: input.provider.sourceSupervisor,
      database: input.database,
    });
  return createProviderWorkerRuntime({
    configuration: input.provider,
    database: input.database,
    logger: input.providerLogger,
    observability: input.observability,
    heatPromotion,
    catalogRetention,
    sourceSupervisor,
    startupPrerequisite: {
      async run(signal) {
        await createSourceRelationshipConfirmationBackfillRunner({
          database: input.database,
          organizationId: input.provider.publicOrganizationId,
          actorPseudonymKey: input.provider.actorPseudonymKey,
          clock,
        }).runToCompletion({ signal });
        await new PrismaNormalizedHeatRelationshipBackfillRepository(
          input.database,
          {
            organizationId: input.provider.publicOrganizationId,
            clock,
          },
        ).runToCompletion({ signal });
      },
    },
  });
}
