import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  NotificationPublishResult,
  OperationalNotification,
  RetentionBatchResult,
} from "@packscout/contracts";
import {
  OperationalEventService,
  type OperationalLog,
  type OperationalMetric,
} from "./operational-events.ts";
import {
  ProtectedPayloadRetentionService,
  type ProtectedPayloadRetentionRepository,
} from "./protected-payload-retention-service.ts";

const organizationId = "51000000-0000-4000-8000-000000000001";
const executionId = "51000000-0000-4000-8000-000000000002";
const providerId = "51000000-0000-4000-8000-000000000003";
const quarantineId = "51000000-0000-4000-8000-000000000004";
const now = new Date("2026-11-05T12:00:00.000Z");
const sensitive = "Bearer retention-secret private-user 0xwallet";

function result(overrides: Partial<RetentionBatchResult> = {}): RetentionBatchResult {
  return {
    executionId,
    selected: 3,
    expired: 3,
    alreadyExpired: 1,
    failed: 0,
    remaining: 2,
    pagesExpired: 1,
    sourceRecordsExpired: 1,
    quarantinesExpired: 1,
    startedAt: "2026-11-05T11:59:59.990Z",
    finishedAt: now.toISOString(),
    durationMs: 10,
    replayed: false,
    ...overrides,
  };
}

function eventsSink() {
  const events: OperationalNotification[] = [];
  const service = new OperationalEventService(
    {
      publish(event): Promise<NotificationPublishResult> {
        events.push(event);
        return Promise.resolve({ status: "accepted", alertId: null, failureCode: null });
      },
    },
    { id: () => "51000000-0000-4000-8000-000000000099" },
    { now: () => new Date(now) },
  );
  return { events, service };
}

test("successful retention reports bounded work and emits expiry plus recovery", async () => {
  const { events, service: eventService } = eventsSink();
  const metrics: OperationalMetric[] = [];
  const logs: OperationalLog[] = [];
  const repository: ProtectedPayloadRetentionRepository = {
    expireBatch: () => Promise.resolve({
      result: result(),
      recovered: true,
      expiredQuarantines: [{
        id: quarantineId,
        providerId,
        reasonCode: "MAPPING_REJECTED",
      }],
    }),
    recordFailure: () => Promise.reject(new Error("not expected")),
  };
  const service = new ProtectedPayloadRetentionService(
    repository,
    eventService,
    { metric: (metric) => metrics.push(metric), log: (entry) => logs.push(entry) },
    { now: () => new Date(now) },
  );
  const output = await service.run({
    executionId,
    organizationId,
    cutoffAt: now,
    batchSize: 100,
  });
  assert.equal(output.expired, 3);
  assert.deepEqual(events.map(({ kind }) => kind), [
    "quarantine_expired",
    "retention_recovered",
  ]);
  assert.equal(metrics.length, 6);
  assert.equal(logs[0]?.code, "RETENTION_SUCCEEDED");
});

test("retention persistence failures become durable sanitized outcomes", async () => {
  const { events, service: eventService } = eventsSink();
  const metrics: OperationalMetric[] = [];
  let recordedFailureCode: string | null = null;
  const repository: ProtectedPayloadRetentionRepository = {
    expireBatch: () => Promise.reject(new Error(sensitive)),
    recordFailure(input) {
      recordedFailureCode = input.failureCode;
      return Promise.resolve(result({
        selected: 0,
        expired: 0,
        alreadyExpired: 0,
        failed: 1,
        remaining: 0,
        pagesExpired: 0,
        sourceRecordsExpired: 0,
        quarantinesExpired: 0,
      }));
    },
  };
  const service = new ProtectedPayloadRetentionService(
    repository,
    eventService,
    { metric: (metric) => metrics.push(metric), log() {} },
    { now: () => new Date(now) },
  );
  const output = await service.run({
    executionId,
    organizationId,
    cutoffAt: now,
    batchSize: 100,
  });
  assert.equal(output.failed, 1);
  assert.equal(recordedFailureCode, "RETENTION_BATCH_FAILED");
  assert.equal(events[0]?.kind, "retention_failed");
  assert.equal(JSON.stringify({ output, events, metrics }).includes(sensitive), false);
});

test("a total persistence outage still returns safe failure telemetry", async () => {
  const { events, service: eventService } = eventsSink();
  const repository: ProtectedPayloadRetentionRepository = {
    expireBatch: () => Promise.reject(new Error(sensitive)),
    recordFailure: () => Promise.reject(new Error(sensitive)),
  };
  const service = new ProtectedPayloadRetentionService(
    repository,
    eventService,
    { metric() {}, log() {} },
    { now: () => new Date(now) },
  );
  const output = await service.run({
    executionId,
    organizationId,
    cutoffAt: now,
    batchSize: 100,
  });
  assert.equal(output.failed, 1);
  assert.equal(events[0]?.kind, "retention_failed");
  assert.equal(JSON.stringify({ output, events }).includes(sensitive), false);
});

test("notification and observability outages cannot rewrite successful cleanup", async () => {
  let failureWrites = 0;
  const eventService = new OperationalEventService(
    {
      publish: async () => {
        throw new Error("notification unavailable");
      },
    },
    {
      id: () => {
        throw new Error("identifier source unavailable");
      },
    },
    { now: () => new Date(now) },
  );
  const service = new ProtectedPayloadRetentionService(
    {
      expireBatch: async () => ({
        result: result(),
        recovered: true,
        expiredQuarantines: [{
          id: quarantineId,
          providerId,
          reasonCode: "SOURCE_RETENTION_EXPIRED",
        }],
      }),
      recordFailure: async () => {
        failureWrites += 1;
        return result({ failed: 1 });
      },
    },
    eventService,
    {
      metric() {
        throw new Error("metrics unavailable");
      },
      log() {
        throw new Error("logs unavailable");
      },
    },
    { now: () => new Date(now) },
  );

  const output = await service.run({
    executionId,
    organizationId,
    cutoffAt: now,
    batchSize: 100,
  });

  assert.equal(output.expired, 3);
  assert.equal(output.failed, 0);
  assert.equal(failureWrites, 0);
});
