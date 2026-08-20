import {
  PrismaCatalogPromotionRetentionRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  CatalogPromotionRetentionRunner,
  SignedConvexCatalogRetentionClient,
} from "@packscout/services";
import type { CatalogRetentionWorkerConfiguration } from
  "./catalog-retention-worker-config.ts";
import {
  CatalogRetentionWorkerRuntime,
  type CatalogRetentionWorkerLogger,
  type CatalogRetentionWorkerSleeper,
} from "./catalog-retention-worker-runtime.ts";

export interface CatalogRetentionWorkerCompositionInput {
  readonly configuration: CatalogRetentionWorkerConfiguration;
  readonly organizationId: string;
  readonly workerId: string;
  readonly database: PackscoutPrismaClient;
  readonly logger: CatalogRetentionWorkerLogger;
  readonly clock?: Readonly<{ now(): Date }>;
  readonly fetch?: typeof fetch;
  readonly nonce?: () => string;
  readonly sleeper?: CatalogRetentionWorkerSleeper;
}

export function createCatalogRetentionWorkerRuntime(
  input: CatalogRetentionWorkerCompositionInput,
): CatalogRetentionWorkerRuntime {
  const clock = input.clock ?? { now: () => new Date() };
  const repository = new PrismaCatalogPromotionRetentionRepository(
    input.database,
    {
      organizationId: input.organizationId,
      deploymentKey: input.configuration.deploymentKey,
    },
  );
  const transport = new SignedConvexCatalogRetentionClient({
    baseUrl: input.configuration.convexBaseUrl,
    keyId: input.configuration.keyId,
    secret: input.configuration.secret,
    timeoutMilliseconds: input.configuration.requestTimeoutMilliseconds,
    now: () => clock.now(),
    fetch: input.fetch,
    nonce: input.nonce,
  });
  const runner = new CatalogPromotionRetentionRunner({
    repository,
    transport,
    maximumDocuments: input.configuration.maximumDocuments,
    maximumPostgresRowsPerStep:
      input.configuration.maximumPostgresRowsPerStep,
    maximumStepsPerCycle: input.configuration.maximumStepsPerCycle,
    clock,
  });
  return new CatalogRetentionWorkerRuntime({
    runner,
    logger: input.logger,
    workerId: input.workerId,
    intervalMilliseconds: input.configuration.intervalMilliseconds,
    continuationIntervalMilliseconds:
      input.configuration.continuationIntervalMilliseconds,
    sleeper: input.sleeper,
  });
}
