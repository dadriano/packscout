import {
  DrizzleAdminNotificationPublisher,
} from "@packscout/database";
import {
  createOperationalRuntime,
  type OperationalObservability,
  type ProviderClock,
  type ProviderIdSource,
} from "@packscout/services";

type OperationalDatabase = ConstructorParameters<
  typeof DrizzleAdminNotificationPublisher
>[0];

export interface ProviderWorkerOperationalRuntimeInput {
  readonly database: OperationalDatabase;
  readonly ids: ProviderIdSource;
  readonly clock: ProviderClock;
  readonly observability: OperationalObservability;
}

export function createProviderWorkerOperationalRuntime(
  input: ProviderWorkerOperationalRuntimeInput,
) {
  return createOperationalRuntime({
    durableAdminPublisher: new DrizzleAdminNotificationPublisher(input.database),
    ids: input.ids,
    clock: input.clock,
    observability: input.observability,
  });
}
