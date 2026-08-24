import {
  PrismaAdminNotificationPublisher,
  PrismaAlertEmailReadRepository,
} from "@packscout/database";
import {
  AlertEmailNotificationPublisher,
  createOperationalRuntime,
  EmailMessageOutboxService,
  type EmailMessageOutboxEnqueueQueue,
  type OperationalObservability,
  type ProviderClock,
  type ProviderIdSource,
} from "@packscout/services";

type OperationalDatabase = ConstructorParameters<
  typeof PrismaAdminNotificationPublisher
>[0];

export interface ProviderWorkerOperationalRuntimeInput {
  readonly database: OperationalDatabase;
  readonly ids: ProviderIdSource;
  readonly clock: ProviderClock;
  readonly observability: OperationalObservability;
  /**
   * When present, operational alerts are additionally routed to operator
   * email through the durable message outbox, composed beside the durable
   * admin publisher. Absent, behavior is exactly the durable-only path.
   */
  readonly alertEmail?: {
    /** Routing settings are resolved from here at publish time. */
    readonly env: NodeJS.ProcessEnv;
    readonly queue: EmailMessageOutboxEnqueueQueue;
  };
}

export function createProviderWorkerOperationalRuntime(
  input: ProviderWorkerOperationalRuntimeInput,
) {
  return createOperationalRuntime({
    durableAdminPublisher: new PrismaAdminNotificationPublisher(input.database),
    additionalPublishers: input.alertEmail
      ? [
          new AlertEmailNotificationPublisher({
            reader: new PrismaAlertEmailReadRepository(input.database),
            outbox: new EmailMessageOutboxService({
              queue: input.alertEmail.queue,
              clock: input.clock,
            }),
            env: input.alertEmail.env,
            observability: input.observability,
          }),
        ]
      : [],
    ids: input.ids,
    clock: input.clock,
    observability: input.observability,
  });
}
