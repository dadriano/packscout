import { randomUUID } from "node:crypto";
import {
  IngestionPersistenceRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  type OperationalObservability,
} from "@packscout/services";
import {
  createProviderSourceImportComposition,
  type ProviderSourceImportComposition,
} from "./provider-source-import-composition.ts";

export {
  createProviderSourceImportComposition,
  type ProviderSourceImportComposition,
} from "./provider-source-import-composition.ts";
import { createProviderWorkerOperationalRuntime } from "./provider-worker-operational-runtime.ts";
import { createProviderWorkerEstimatedEvProcessor } from "./provider-worker-estimated-ev.ts";
import { createProviderWorkerRetentionCoordinator } from "./provider-worker-retention.ts";
import type { PromotionV2WorkerRuntimePort } from
  "./promotion-v2-worker-runtime.ts";
import type {
  HeatPromotionWorkerRuntimePort,
} from "./heat-promotion-worker-runtime.ts";
import type { CatalogRetentionWorkerRuntimePort } from
  "./catalog-retention-worker-runtime.ts";
import type { ProviderWorkerConfiguration } from "./runtime-config.ts";
import {
  ProviderWorkerRuntime,
  type ProviderWorkerLogger,
} from "./provider-worker-runtime.ts";

type RuntimeConfiguration = Pick<
  ProviderWorkerConfiguration,
  | "actorPseudonymKey"
  | "credentialKey"
  | "credentialKeyVersion"
  | "environment"
  | "estimatedEvVerifiedUsdStablecoins"
  | "maximumClaimsPerCycle"
  | "pollIntervalMilliseconds"
  | "retentionBatchSize"
  | "retentionMaximumBatchesPerCycle"
  | "retentionOrganizationDiscoveryLimit"
  | "workerId"
>;

export interface ProviderWorkerCompositionInput {
  readonly configuration: RuntimeConfiguration;
  readonly database: PackscoutPrismaClient;
  readonly logger: ProviderWorkerLogger;
  readonly observability: OperationalObservability;
  readonly promotion?: PromotionV2WorkerRuntimePort;
  readonly heatPromotion?: HeatPromotionWorkerRuntimePort;
  readonly catalogRetention?: CatalogRetentionWorkerRuntimePort;
  readonly sourceSupervisor?: Readonly<{
    start(): Promise<void>;
    stop(): Promise<void> | void;
  }>;
}

export function createProviderWorkerRuntime(
  input: ProviderWorkerCompositionInput,
): ProviderWorkerRuntime & {
  readonly sourceImports: ProviderSourceImportComposition;
} {
  const clock = { now: () => new Date() };
  const ids = { id: randomUUID };
  const operational = createProviderWorkerOperationalRuntime({
    database: input.database,
    ids,
    clock,
    observability: input.observability,
  });
  const retention = createProviderWorkerRetentionCoordinator({
    database: input.database,
    ids,
    clock,
    events: operational.events,
    observability: input.observability,
    config: {
      batchSize: input.configuration.retentionBatchSize,
      maxBatchesPerCycle:
        input.configuration.retentionMaximumBatchesPerCycle,
      organizationDiscoveryLimit:
        input.configuration.retentionOrganizationDiscoveryLimit,
    },
  });
  const pages = new IngestionPersistenceRepository(input.database, {
    retentionDays: 90,
    actorPseudonymKey: input.configuration.actorPseudonymKey,
  });
  const sourceImports = createProviderSourceImportComposition({
    database: input.database,
    actorPseudonymKey: input.configuration.actorPseudonymKey,
  });
  const runtime = new ProviderWorkerRuntime({
    // Task 007 owns durable source schedule claims and execution. Keeping this
    // lane idle makes Task 006 request-only and prevents a legacy feed fallback.
    scheduler: { async runOnce() { return { kind: "idle" }; } },
    imports: {
      async executeImport() {
        throw new Error("Provider source execution requires the Task 007 supervisor.");
      },
      async executeNextImport() { return { kind: "idle" }; },
    },
    estimatedEv: createProviderWorkerEstimatedEvProcessor({
      database: input.database,
      canonical: pages,
      reporter: operational.reporter,
      clock,
      workerId: input.configuration.workerId,
      verifiedUsdStablecoins:
        input.configuration.estimatedEvVerifiedUsdStablecoins,
    }),
    promotion: input.promotion,
    heatPromotion: input.heatPromotion,
    catalogRetention: input.catalogRetention,
    sourceSupervisor: input.sourceSupervisor,
    retention,
    logger: input.logger,
    workerId: input.configuration.workerId,
    pollIntervalMilliseconds: input.configuration.pollIntervalMilliseconds,
    maximumClaimsPerCycle: input.configuration.maximumClaimsPerCycle,
  });
  return Object.assign(runtime, { sourceImports });
}
