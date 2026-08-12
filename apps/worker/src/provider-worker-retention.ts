import { DrizzleProtectedPayloadRetentionRepository } from "@packscout/database";
import {
  ProtectedPayloadRetentionCoordinator,
  ProtectedPayloadRetentionService,
  type OperationalEventService,
  type OperationalObservability,
  type ProtectedPayloadRetentionCycleConfig,
  type ProviderClock,
  type ProviderIdSource,
} from "@packscout/services";

type RetentionDatabase = ConstructorParameters<
  typeof DrizzleProtectedPayloadRetentionRepository
>[0];

export interface ProviderWorkerRetentionInput {
  readonly database: RetentionDatabase;
  readonly ids: ProviderIdSource;
  readonly clock: ProviderClock;
  readonly events: OperationalEventService;
  readonly observability: OperationalObservability;
  readonly config: ProtectedPayloadRetentionCycleConfig;
}

export function createProviderWorkerRetentionCoordinator(
  input: ProviderWorkerRetentionInput,
): ProtectedPayloadRetentionCoordinator {
  const repository = new DrizzleProtectedPayloadRetentionRepository(
    input.database,
    input.clock,
  );
  const service = new ProtectedPayloadRetentionService(
    repository,
    input.events,
    input.observability,
    input.clock,
  );
  return new ProtectedPayloadRetentionCoordinator(
    repository,
    service,
    input.ids,
    input.clock,
    input.config,
  );
}
