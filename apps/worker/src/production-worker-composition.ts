import { randomUUID } from "node:crypto";
import {
  PrismaAdminNotificationPublisher,
  PrismaHeatPromotionManifestRepository,
  PrismaHeatPromotionRepository,
  PrismaNormalizedHeatObservationRepository,
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
import {
  assertPromotionV2CredentialRoleIsolation,
  type PromotionV2WorkerConfiguration,
} from "./promotion-v2-worker-config.ts";
import { createPromotionV2WorkerRuntime } from
  "./promotion-v2-worker-composition.ts";
import type { PromotionV2WorkerLogger } from
  "./promotion-v2-worker-runtime.ts";
import { createCatalogRetentionWorkerRuntime } from
  "./catalog-retention-worker-composition.ts";
import {
  assertCatalogRetentionCredentialRoleIsolation,
  type CatalogRetentionWorkerConfiguration,
} from "./catalog-retention-worker-config.ts";
import type { CatalogRetentionWorkerLogger } from
  "./catalog-retention-worker-runtime.ts";

export interface ProductionWorkerCompositionInput {
  readonly provider: ProviderWorkerConfiguration;
  readonly promotion: PromotionV2WorkerConfiguration;
  readonly heat: HeatPromotionWorkerConfiguration;
  readonly retention: CatalogRetentionWorkerConfiguration;
  readonly database: PackscoutPrismaClient;
  readonly providerLogger: ProviderWorkerLogger;
  readonly promotionLogger: PromotionV2WorkerLogger;
  readonly heatLogger: HeatPromotionWorkerLogger;
  readonly retentionLogger: CatalogRetentionWorkerLogger;
  readonly observability: OperationalObservability;
  readonly fetch?: typeof fetch;
}

/** Wires provider+manifest promotion and Heat as independent worker loops. */
export function createProductionWorkerRuntime(
  input: ProductionWorkerCompositionInput,
) {
  assertPromotionV2CredentialRoleIsolation(input.promotion, [
    input.heat.keyId,
    input.retention.keyId,
  ]);
  assertCatalogRetentionCredentialRoleIsolation({
    promotion: input.promotion,
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
  const promotion = createPromotionV2WorkerRuntime({
    configuration: input.promotion,
    organizationId: input.provider.publicOrganizationId,
    workerId: input.provider.workerId,
    database: input.database,
    logger: input.promotionLogger,
    operationalEvents,
    fetch: input.fetch,
  });
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
  const sourceSupervisor = createProviderSourceSupervisorRuntime({
    configuration: input.provider,
    database: input.database,
  });
  return createProviderWorkerRuntime({
    configuration: input.provider,
    database: input.database,
    logger: input.providerLogger,
    observability: input.observability,
    promotion,
    heatPromotion,
    catalogRetention,
    sourceSupervisor,
  });
}
