import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  NotificationPublishResult,
  OperationalNotification,
} from "@packscout/contracts";
import {
  CompositeNotificationPublisher,
  OperationalEventService,
  PipelineOperationalReporter,
  type NotificationPublisher,
  type OperationalLog,
  type OperationalMetric,
} from "./operational-events.ts";

const organizationId = "50000000-0000-4000-8000-000000000001";
const providerId = "50000000-0000-4000-8000-000000000002";
const runId = "50000000-0000-4000-8000-000000000003";
const quarantineId = "50000000-0000-4000-8000-000000000004";
const occurredAt = new Date("2026-08-06T12:00:00.000Z");
const sensitive = "Bearer secret-token username=private 0xraw-wallet";

class CapturePublisher implements NotificationPublisher {
  readonly events: OperationalNotification[] = [];

  publish(event: OperationalNotification): Promise<NotificationPublishResult> {
    this.events.push(event);
    return Promise.resolve({
      status: "accepted",
      alertId: "50000000-0000-4000-8000-000000000099",
      failureCode: null,
    });
  }
}

function ids() {
  let value = 10;
  return {
    id: () =>
      `50000000-0000-4000-8000-${String(value++).padStart(12, "0")}`,
  };
}

test("all required events use bounded templates and allowlisted evidence", async () => {
  const sink = new CapturePublisher();
  const metrics: OperationalMetric[] = [];
  const logs: OperationalLog[] = [];
  const service = new OperationalEventService(
    sink,
    ids(),
    { now: () => new Date(occurredAt) },
    { metric: (metric) => metrics.push(metric), log: (entry) => logs.push(entry) },
  );
  await service.runFailed({ organizationId, providerId, runId, failureCode: sensitive });
  await service.runIncomplete({ organizationId, providerId, runId, failureCode: null });
  await service.providerStale({ organizationId, providerId, ageSeconds: 901 });
  await service.providerRecovered({ organizationId, providerId });
  await service.quarantineResolved({ organizationId, providerId, quarantineId });
  await service.quarantineExpired({
    organizationId,
    providerId,
    quarantineId,
    reasonCode: sensitive,
  });
  await service.retentionFailed({ organizationId, failureCode: sensitive });
  await service.retentionRecovered({ organizationId, expiredCount: 3, durationMs: 12 });

  assert.deepEqual(
    sink.events.map(({ kind }) => kind),
    [
      "run_failed",
      "run_incomplete",
      "provider_stale",
      "provider_recovered",
      "quarantine_resolved",
      "quarantine_expired",
      "retention_failed",
      "retention_recovered",
    ],
  );
  const rendered = JSON.stringify({ events: sink.events, metrics, logs });
  assert.equal(rendered.includes(sensitive), false);
  assert.equal(rendered.includes("secret-token"), false);
  assert.equal(sink.events[0]?.evidence.failureCode, "PROVIDER_IMPORT_FAILED");
  assert.equal(sink.events[5]?.evidence.reasonCode, "QUARANTINE_EXPIRED");
  assert.equal(metrics.every(({ name }) => name === "notification_state_total"), true);
});

test("adding a test sink requires only composition and no pipeline branch", async () => {
  const adminSink = new CapturePublisher();
  const testSink = new CapturePublisher();
  const service = new OperationalEventService(
    new CompositeNotificationPublisher([adminSink, testSink]),
    ids(),
    { now: () => new Date(occurredAt) },
  );
  const result = await service.providerStale({
    organizationId,
    providerId,
    ageSeconds: 1_000,
  });
  assert.equal(result.status, "accepted");
  assert.equal(adminSink.events.length, 1);
  assert.deepEqual(testSink.events, adminSink.events);
});

test("sink failures are isolated from the event caller", async () => {
  const service = new OperationalEventService(
    { publish: () => Promise.reject(new Error(sensitive)) },
    ids(),
    { now: () => new Date(occurredAt) },
  );
  assert.deepEqual(
    await service.retentionFailed({ organizationId, failureCode: "RETENTION_FAILED" }),
    {
      status: "failed",
      alertId: null,
      failureCode: "NOTIFICATION_PUBLISH_FAILED",
    },
  );
});

test("pipeline metrics construct fixed safe dimensions from runtime evidence", () => {
  const metrics: OperationalMetric[] = [];
  const logs: OperationalLog[] = [];
  const reporter = new PipelineOperationalReporter(
    { metric: (metric) => metrics.push(metric), log: (entry) => logs.push(entry) },
    { now: () => new Date(occurredAt) },
  );
  reporter.run({
    organizationId,
    providerId,
    outcome: "FAILED",
    durationMs: 100,
    pages: 2,
    records: 7,
    rawPayload: sensitive,
  } as Parameters<PipelineOperationalReporter["run"]>[0]);
  reporter.cursorLag({ organizationId, providerId, pagesBehindProxy: 4 });
  reporter.freshness({ organizationId, providerId, ageSeconds: 901, state: "STALE" });
  reporter.quarantine({ organizationId, providerId, count: 2, oldestAgeSeconds: 80 });
  reporter.retry({ organizationId, providerId, outcome: "EXPIRED" });
  reporter.calculation({ organizationId, providerId, availability: "LIMITED" });
  const rendered = JSON.stringify({ metrics, logs });
  assert.equal(rendered.includes(sensitive), false);
  assert.deepEqual(
    new Set(metrics.map(({ name }) => name)),
    new Set([
      "run_duration_ms",
      "run_outcome_total",
      "page_count",
      "record_count",
      "cursor_lag_proxy",
      "freshness_age_seconds",
      "quarantine_count",
      "quarantine_age_seconds",
      "retry_outcome_total",
      "calculation_availability_total",
    ]),
  );
});
