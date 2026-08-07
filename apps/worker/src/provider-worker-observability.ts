import type {
  OperationalLog,
  OperationalMetric,
  OperationalMetricName,
  OperationalObservability,
} from "@packscout/services";

type OperationalLogLevel = OperationalLog["level"];

export interface ProviderWorkerJsonSink {
  write(level: OperationalLogLevel, serialized: string): void;
}

const metricNames = new Set<OperationalMetricName>([
  "calculation_availability_total",
  "cursor_lag_proxy",
  "freshness_age_seconds",
  "notification_state_total",
  "page_count",
  "quarantine_age_seconds",
  "quarantine_count",
  "record_count",
  "retention_already_expired_total",
  "retention_duration_ms",
  "retention_expired_total",
  "retention_failed_total",
  "retention_remaining_total",
  "retention_selected_total",
  "retry_outcome_total",
  "run_duration_ms",
  "run_outcome_total",
]);

const logEvents = new Set<OperationalLog["event"]>([
  "notification",
  "pipeline_measurement",
  "retention",
]);
const logLevels = new Set<OperationalLogLevel>(["error", "info", "warning"]);
const safeIdentifierPattern = /^[A-Za-z0-9._:-]{1,256}$/;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const invalidTimestamp = "1970-01-01T00:00:00.000Z";

const consoleJsonSink: ProviderWorkerJsonSink = {
  write(level, serialized) {
    if (level === "error") {
      console.error(serialized);
    } else if (level === "warning") {
      console.warn(serialized);
    } else {
      console.info(serialized);
    }
  },
};

function safeIdentifier(value: string): string {
  return safeIdentifierPattern.test(value) ? value : "invalid";
}

function safeNullableIdentifier(value: string | null): string | null {
  return value === null ? null : safeIdentifier(value);
}

function safeCode(value: string | null): string | null {
  if (value === null) return null;
  return safeCodePattern.test(value) ? value : "INVALID_CODE";
}

function safeMetricValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

function safeTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return invalidTimestamp;
  return parsed.toISOString() === value ? value : invalidTimestamp;
}

export class JsonConsoleProviderWorkerObservability
  implements OperationalObservability
{
  private readonly workerId: string;

  constructor(
    workerId: string,
    private readonly sink: ProviderWorkerJsonSink = consoleJsonSink,
  ) {
    this.workerId = safeIdentifier(workerId);
  }

  metric(metric: OperationalMetric): void {
    const name = metricNames.has(metric.name) ? metric.name : "invalid_metric";
    this.sink.write(
      "info",
      JSON.stringify({
        level: "info",
        event: "provider_worker_metric",
        workerId: this.workerId,
        name,
        value: safeMetricValue(metric.value),
        organizationId: safeIdentifier(metric.organizationId),
        providerId: safeNullableIdentifier(metric.providerId),
        outcomeCode: safeCode(metric.outcomeCode),
      }),
    );
  }

  log(entry: OperationalLog): void {
    const level = logLevels.has(entry.level) ? entry.level : "error";
    const kind = logEvents.has(entry.event) ? entry.event : "invalid";
    this.sink.write(
      level,
      JSON.stringify({
        level,
        event: "provider_worker_operational_log",
        workerId: this.workerId,
        kind,
        organizationId: safeIdentifier(entry.organizationId),
        providerId: safeNullableIdentifier(entry.providerId),
        code: safeCode(entry.code) ?? "INVALID_CODE",
        occurredAt: safeTimestamp(entry.occurredAt),
      }),
    );
  }
}
