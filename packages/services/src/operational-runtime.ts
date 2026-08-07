import type {
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";
import {
  CompositeNotificationPublisher,
  OperationalEventService,
  PipelineOperationalReporter,
  type NotificationPublisher,
  type OperationalObservability,
} from "./operational-events.ts";

export interface OperationalRuntime {
  readonly events: OperationalEventService;
  readonly reporter: PipelineOperationalReporter;
}

export interface OperationalRuntimeDependencies {
  /** The durable in-admin sink is always first and is required for V1 delivery. */
  readonly durableAdminPublisher: NotificationPublisher;
  readonly additionalPublishers?: readonly NotificationPublisher[];
  readonly ids: ProviderIdSource;
  readonly clock: ProviderClock;
  readonly observability: OperationalObservability;
}

export function createOperationalRuntime(
  dependencies: OperationalRuntimeDependencies,
): OperationalRuntime {
  const publisher = new CompositeNotificationPublisher([
    dependencies.durableAdminPublisher,
    ...(dependencies.additionalPublishers ?? []),
  ]);
  return {
    events: new OperationalEventService(
      publisher,
      dependencies.ids,
      dependencies.clock,
      dependencies.observability,
    ),
    reporter: new PipelineOperationalReporter(
      dependencies.observability,
      dependencies.clock,
    ),
  };
}
