import { createHmac, randomUUID } from "node:crypto";
import {
  PrismaImportRunRepository,
  PrismaProviderConfigurationRepository,
  PrismaProviderHealthRepository,
  PrismaProviderScheduleRepository,
  IngestionPersistenceRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CatalogProjectionService,
  createProviderMappingAdapterRegistryFromManifest,
  DefaultProviderImportPagePlanner,
  EventProjectionService,
  HmacProviderActorPseudonymizer,
  ProviderImportService,
  ProviderImportWorkerService,
  ProviderProjectionService,
  ProviderSchedulerService,
  ProviderTransportAdapterRegistry,
  type OperationalObservability,
  type ProviderActorKeyer,
} from "@packscout/services";
import { createProviderWorkerOperationalRuntime } from "./provider-worker-operational-runtime.ts";
import { createProviderWorkerEstimatedEvProcessor } from "./provider-worker-estimated-ev.ts";
import { createProviderWorkerRetentionCoordinator } from "./provider-worker-retention.ts";
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
  /**
   * Live transports are registered only after their provider response decoder
   * is known. The default is intentionally empty so production cannot pretend
   * the archive-derived V2 record contract proves the live API page wrapper.
   */
  readonly transportAdapters?: ProviderTransportAdapterRegistry;
}

function createActorKeyer(key: Uint8Array): ProviderActorKeyer {
  const secret = Buffer.from(key);
  if (secret.byteLength < 32) {
    throw new Error("Provider actor key must be at least 32 bytes.");
  }
  return {
    keyFor({ organizationId, operatorId }) {
      return `actor:v1:${createHmac("sha256", secret)
        .update(
          `packscout-provider-request:v1\u0000${organizationId}\u0000${operatorId}`,
        )
        .digest("hex")}`;
    },
  };
}

export function createProviderWorkerRuntime(
  input: ProviderWorkerCompositionInput,
): ProviderWorkerRuntime {
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
  const runs = new PrismaImportRunRepository(input.database);
  const pages = new IngestionPersistenceRepository(input.database, {
    retentionDays: 90,
    actorPseudonymKey: input.configuration.actorPseudonymKey,
  });
  const imports = new ProviderImportService({
    runs,
    revisions: new PrismaProviderConfigurationRepository(input.database),
    pages,
    transportAdapters:
      input.transportAdapters ?? new ProviderTransportAdapterRegistry(),
    pagePlanner: new DefaultProviderImportPagePlanner(
      createProviderMappingAdapterRegistryFromManifest(),
      new ProviderProjectionService(
        new CatalogProjectionService(),
        new EventProjectionService(
          new HmacProviderActorPseudonymizer(
            input.configuration.actorPseudonymKey,
          ),
        ),
      ),
    ),
    credentialCipher: new AesGcmProviderCredentialCipher({
      primaryVersion: input.configuration.credentialKeyVersion,
      keys: new Map([
        [
          input.configuration.credentialKeyVersion,
          input.configuration.credentialKey,
        ],
      ]),
    }),
    actorKeyer: createActorKeyer(input.configuration.actorPseudonymKey),
    clock,
    ids,
    environment: input.configuration.environment,
  });
  return new ProviderWorkerRuntime({
    scheduler: new ProviderSchedulerService({
      schedules: new PrismaProviderScheduleRepository(input.database),
      imports,
      clock,
    }),
    imports: new ProviderImportWorkerService(
      imports,
      new PrismaProviderHealthRepository(input.database),
      {
        events: operational.events,
        reporter: operational.reporter,
      },
    ),
    estimatedEv: createProviderWorkerEstimatedEvProcessor({
      database: input.database,
      canonical: pages,
      reporter: operational.reporter,
      clock,
      workerId: input.configuration.workerId,
      verifiedUsdStablecoins:
        input.configuration.estimatedEvVerifiedUsdStablecoins,
    }),
    retention,
    logger: input.logger,
    workerId: input.configuration.workerId,
    pollIntervalMilliseconds: input.configuration.pollIntervalMilliseconds,
    maximumClaimsPerCycle: input.configuration.maximumClaimsPerCycle,
  });
}
