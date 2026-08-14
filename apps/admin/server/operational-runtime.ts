import { createHmac, randomUUID } from "node:crypto";
import {
  PrismaAdminNotificationPublisher,
  PrismaOperationalHealthRepository,
} from "@packscout/database";
import {
  OperationalAlertService,
  OperationalHealthService,
  createOperationalRuntime,
  type OperationalObservability,
  type ProviderActorKeyer,
} from "@packscout/services";

type OperationalDatabase = ConstructorParameters<
  typeof PrismaAdminNotificationPublisher
>[0];

export interface AdminOperationalRuntimeInput {
  readonly database: OperationalDatabase;
  readonly actorPseudonymKey: Uint8Array;
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

export function createAdminOperationalRuntime(
  input: AdminOperationalRuntimeInput,
) {
  const clock = { now: () => new Date() };
  const publisher = new PrismaAdminNotificationPublisher(input.database);
  const pipeline = createOperationalRuntime({
    durableAdminPublisher: publisher,
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
    health: new OperationalHealthService(
      new PrismaOperationalHealthRepository(input.database),
      clock,
    ),
    ...pipeline,
  };
}
