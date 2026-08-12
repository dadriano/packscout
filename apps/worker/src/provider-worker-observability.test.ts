import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  OperationalLog,
  OperationalMetric,
} from "@packscout/services";
import {
  JsonConsoleProviderWorkerObservability,
  type ProviderWorkerJsonSink,
} from "./provider-worker-observability.ts";

interface CapturedJsonLine {
  readonly level: OperationalLog["level"];
  readonly serialized: string;
}

test("worker observability emits bounded structured JSON", () => {
  const captured: CapturedJsonLine[] = [];
  const sink: ProviderWorkerJsonSink = {
    write: (level, serialized) => void captured.push({ level, serialized }),
  };
  const observability = new JsonConsoleProviderWorkerObservability(
    "worker-1",
    sink,
  );

  observability.metric({
    name: "run_duration_ms",
    value: 2_500,
    organizationId: "organization-1",
    providerId: "provider-1",
    outcomeCode: "FAILED",
  });
  observability.log({
    event: "pipeline_measurement",
    level: "warning",
    organizationId: "organization-1",
    providerId: "provider-1",
    code: "RUN_OUTCOME_TOTAL",
    occurredAt: "2026-08-06T12:00:00.000Z",
  });

  assert.deepEqual(captured.map(({ level }) => level), ["info", "warning"]);
  assert.deepEqual(JSON.parse(captured[0]?.serialized ?? "{}"), {
    level: "info",
    event: "provider_worker_metric",
    workerId: "worker-1",
    name: "run_duration_ms",
    value: 2_500,
    organizationId: "organization-1",
    providerId: "provider-1",
    outcomeCode: "FAILED",
  });
  assert.deepEqual(JSON.parse(captured[1]?.serialized ?? "{}"), {
    level: "warning",
    event: "provider_worker_operational_log",
    workerId: "worker-1",
    kind: "pipeline_measurement",
    organizationId: "organization-1",
    providerId: "provider-1",
    code: "RUN_OUTCOME_TOTAL",
    occurredAt: "2026-08-06T12:00:00.000Z",
  });
});

test("worker observability never forwards malformed or secret-bearing values", () => {
  const sensitive = "Bearer raw-provider-secret";
  const serialized: string[] = [];
  const observability = new JsonConsoleProviderWorkerObservability(
    sensitive,
    {
      write: (_level, line) => void serialized.push(line),
    },
  );

  observability.metric({
    name: sensitive,
    value: Number.POSITIVE_INFINITY,
    organizationId: sensitive,
    providerId: sensitive,
    outcomeCode: sensitive,
  } as unknown as OperationalMetric);
  observability.log({
    event: sensitive,
    level: sensitive,
    organizationId: sensitive,
    providerId: sensitive,
    code: sensitive,
    occurredAt: sensitive,
  } as unknown as OperationalLog);

  assert.equal(serialized.join("\n").includes(sensitive), false);
  assert.deepEqual(JSON.parse(serialized[0] ?? "{}"), {
    level: "info",
    event: "provider_worker_metric",
    workerId: "invalid",
    name: "invalid_metric",
    value: 0,
    organizationId: "invalid",
    providerId: "invalid",
    outcomeCode: "INVALID_CODE",
  });
  assert.deepEqual(JSON.parse(serialized[1] ?? "{}"), {
    level: "error",
    event: "provider_worker_operational_log",
    workerId: "invalid",
    kind: "invalid",
    organizationId: "invalid",
    providerId: "invalid",
    code: "INVALID_CODE",
    occurredAt: "1970-01-01T00:00:00.000Z",
  });
});
