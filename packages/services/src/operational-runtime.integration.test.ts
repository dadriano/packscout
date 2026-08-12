import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  NotificationPublishResult,
  OperationalNotification,
} from "@packscout/contracts";
import { DrizzleAdminNotificationPublisher } from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { createOperationalRuntime } from "./operational-runtime.ts";
import type {
  NotificationPublisher,
  OperationalLog,
  OperationalMetric,
} from "./operational-events.ts";

const organizationId = "76000000-0000-4000-8000-000000000001";
const occurredAt = new Date("2026-08-06T12:00:00.000Z");

class CapturePublisher implements NotificationPublisher {
  readonly events: OperationalNotification[] = [];

  publish(event: OperationalNotification): Promise<NotificationPublishResult> {
    this.events.push(event);
    return Promise.resolve({ status: "accepted", alertId: null, failureCode: null });
  }
}

test("runtime composition persists durable alerts and adds sinks without pipeline branches", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.database.organizations.create({
      data: {
        id: organizationId,
        slug: "operational-runtime",
        name: "Operational Runtime",
        created_at: occurredAt,
      },
    });
    const durable = new DrizzleAdminNotificationPublisher(harness.database);
    const capture = new CapturePublisher();
    const metrics: OperationalMetric[] = [];
    const logs: OperationalLog[] = [];
    let id = 0;
    const runtime = createOperationalRuntime({
      durableAdminPublisher: durable,
      additionalPublishers: [capture],
      ids: {
        id: () =>
          `76000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      },
      clock: { now: () => new Date(occurredAt.getTime() + id * 1_000) },
      observability: {
        metric: (metric) => metrics.push(metric),
        log: (entry) => logs.push(entry),
      },
    });

    await runtime.events.retentionFailed({
      organizationId,
      failureCode: "Bearer raw-provider-secret",
    });
    await runtime.events.retentionFailed({
      organizationId,
      failureCode: "RETENTION_BATCH_FAILED",
    });
    await runtime.events.retentionRecovered({
      organizationId,
      expiredCount: 3,
      durationMs: 25,
    });
    await runtime.events.retentionRecovered({
      organizationId,
      expiredCount: 0,
      durationMs: 5,
    });

    const alerts = await durable.listAlerts({ organizationId, limit: 10 });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.state, "resolved");
    assert.equal(alerts[0]?.occurrenceCount, 3);
    assert.deepEqual(
      capture.events.map(({ kind }) => kind),
      [
        "retention_failed",
        "retention_failed",
        "retention_recovered",
        "retention_recovered",
      ],
    );
    assert.equal(metrics.length, 4);
    assert.equal(logs.length, 4);
    assert.equal(
      JSON.stringify({ alerts, capture: capture.events, metrics, logs }).includes(
        "raw-provider-secret",
      ),
      false,
    );
  } finally {
    await harness.close();
  }
});
