import { createHmac, randomUUID } from "node:crypto";
import {
  CentralAdminNotificationPublisher,
  CentralAlertEmailReadRepository,
  CentralEmailMessageOutboxRepository,
  type CentralPrismaClient,
} from "@packscout/database";
import {
  AlertEmailNotificationPublisher,
  EmailMessageOutboxService,
  OperationalAlertService,
  OperationalHealthService,
  createOperationalRuntime,
  type OperationalObservability,
  type ProviderActorKeyer,
} from "@packscout/services";

type OperationalHealthRepository = ConstructorParameters<
  typeof OperationalHealthService
>[0];

export interface AdminCentralOperationalRuntimeInput {
  readonly database: CentralPrismaClient;
  readonly actorPseudonymKey: Uint8Array;
  /** Provider-local health evidence is aggregated outside the central client. */
  readonly healthRepository?: OperationalHealthRepository;
  readonly alertEmail?: {
    readonly env: NodeJS.ProcessEnv;
  };
}

const observability: OperationalObservability = {
  metric(metric) {
    console.info(JSON.stringify({
      level: "info",
      event: "admin_operational_metric",
      name: metric.name,
      value: metric.value,
      organizationId: metric.organizationId,
      providerId: metric.providerId,
      outcomeCode: metric.outcomeCode,
    }));
  },
  log(entry) {
    const output = JSON.stringify({
      level: entry.level,
      event: "admin_operational_log",
      kind: entry.event,
      organizationId: entry.organizationId,
      providerId: entry.providerId,
      code: entry.code,
      occurredAt: entry.occurredAt,
    });
    if (entry.level === "error") console.error(output);
    else if (entry.level === "warning") console.warn(output);
    else console.info(output);
  },
};

function actorKeyer(key: Uint8Array): ProviderActorKeyer {
  const secret = Buffer.from(key);
  if (secret.byteLength < 32) {
    throw new Error("Operational actor key must be at least 32 bytes.");
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

/** Central half of operational composition; provider health is an explicit seam. */
export function createAdminCentralOperationalRuntime(
  input: AdminCentralOperationalRuntimeInput,
) {
  const clock = { now: () => new Date() };
  const publisher = new CentralAdminNotificationPublisher(input.database);
  const pipeline = createOperationalRuntime({
    durableAdminPublisher: publisher,
    additionalPublishers: input.alertEmail
      ? [
          new AlertEmailNotificationPublisher({
            reader: new CentralAlertEmailReadRepository(input.database),
            outbox: new EmailMessageOutboxService({
              queue: new CentralEmailMessageOutboxRepository(input.database),
              clock,
            }),
            env: input.alertEmail.env,
            observability,
          }),
        ]
      : [],
    ids: { id: randomUUID },
    clock,
    observability,
  });
  return {
    alerts: new OperationalAlertService(
      publisher,
      actorKeyer(input.actorPseudonymKey),
      clock,
    ),
    health: input.healthRepository === undefined
      ? undefined
      : new OperationalHealthService(input.healthRepository, clock),
    ...pipeline,
  };
}
