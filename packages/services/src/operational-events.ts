import {
  operationalNotificationSchema,
  type NotificationPublishResult,
  type OperationalNotification,
} from "@packscout/contracts";
import type {
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";

export interface NotificationPublisher {
  publish(
    event: OperationalNotification,
  ): Promise<NotificationPublishResult>;
}

export type OperationalMetricName =
  | "calculation_availability_total"
  | "cursor_lag_proxy"
  | "freshness_age_seconds"
  | "notification_state_total"
  | "page_count"
  | "quarantine_age_seconds"
  | "quarantine_count"
  | "record_count"
  | "retention_already_expired_total"
  | "retention_duration_ms"
  | "retention_expired_total"
  | "retention_failed_total"
  | "retention_remaining_total"
  | "retention_selected_total"
  | "retry_outcome_total"
  | "run_duration_ms"
  | "run_outcome_total";

export interface OperationalMetric {
  readonly name: OperationalMetricName;
  readonly value: number;
  readonly organizationId: string;
  readonly providerId: string | null;
  readonly outcomeCode: string | null;
}

export interface OperationalLog {
  readonly event: "notification" | "retention" | "pipeline_measurement";
  readonly level: "info" | "warning" | "error";
  readonly organizationId: string;
  readonly providerId: string | null;
  readonly code: string;
  readonly occurredAt: string;
}

export interface OperationalObservability {
  metric(metric: OperationalMetric): void;
  log(entry: OperationalLog): void;
}

const noopObservability: OperationalObservability = {
  metric() {},
  log() {},
};

function safeCode(code: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : fallback;
}

function failedNotification(): NotificationPublishResult {
  return {
    status: "failed",
    alertId: null,
    failureCode: "NOTIFICATION_PUBLISH_FAILED",
  };
}

export class CompositeNotificationPublisher implements NotificationPublisher {
  constructor(private readonly publishers: readonly NotificationPublisher[]) {}

  async publish(event: OperationalNotification): Promise<NotificationPublishResult> {
    if (this.publishers.length === 0) return failedNotification();
    const results: NotificationPublishResult[] = [];
    for (const publisher of this.publishers) {
      try {
        results.push(await publisher.publish(event));
      } catch {
        results.push(failedNotification());
      }
    }
    const failed = results.find(({ status }) => status === "failed");
    if (failed) return failed;
    return results[0] ?? failedNotification();
  }
}

type EventDraft = Omit<OperationalNotification, "id" | "occurredAt">;

export class OperationalEventService {
  constructor(
    private readonly publisher: NotificationPublisher,
    private readonly ids: ProviderIdSource,
    private readonly clock: ProviderClock,
    private readonly observability: OperationalObservability = noopObservability,
  ) {}

  runFailed(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    failureCode: string;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "run_failed",
      severity: "critical",
      providerId: input.providerId,
      runId: input.runId,
      quarantineId: null,
      dedupeKey: `provider:run-failed:${input.providerId}`,
      recoveryKey: `provider:health:${input.providerId}`,
      title: "Provider import failed",
      summary: "The provider import stopped with a sanitized failure code.",
      evidence: {
        failureCode: safeCode(input.failureCode, "PROVIDER_IMPORT_FAILED"),
      },
    });
  }

  runIncomplete(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    failureCode: string | null;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "run_incomplete",
      severity: "warning",
      providerId: input.providerId,
      runId: input.runId,
      quarantineId: null,
      dedupeKey: `provider:run-incomplete:${input.providerId}`,
      recoveryKey: `provider:health:${input.providerId}`,
      title: "Provider import is incomplete",
      summary: "Durable progress exists, but the provider head was not reached.",
      evidence: {
        failureCode: safeCode(
          input.failureCode ?? "IMPORT_INCOMPLETE",
          "IMPORT_INCOMPLETE",
        ),
      },
    });
  }

  providerStale(input: {
    organizationId: string;
    providerId: string;
    ageSeconds: number;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "provider_stale",
      severity: "warning",
      providerId: input.providerId,
      runId: null,
      quarantineId: null,
      dedupeKey: `provider:stale:${input.providerId}`,
      recoveryKey: `provider:health:${input.providerId}`,
      title: "Provider data is stale",
      summary: "The provider has not reached its freshness target.",
      evidence: { durationMs: Math.max(0, Math.floor(input.ageSeconds * 1_000)) },
    });
  }

  providerRecovered(input: {
    organizationId: string;
    providerId: string;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "provider_recovered",
      severity: "info",
      providerId: input.providerId,
      runId: null,
      quarantineId: null,
      dedupeKey: `provider:recovered:${input.providerId}`,
      recoveryKey: `provider:health:${input.providerId}`,
      title: "Provider recovered",
      summary: "The provider reached its configured health target.",
      evidence: { outcome: "PROVIDER_RECOVERED" },
    });
  }

  quarantineResolved(input: {
    organizationId: string;
    providerId: string;
    quarantineId: string;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "quarantine_resolved",
      severity: "info",
      providerId: input.providerId,
      runId: null,
      quarantineId: input.quarantineId,
      dedupeKey: `quarantine:resolved:${input.quarantineId}`,
      recoveryKey: `quarantine:${input.quarantineId}`,
      title: "Quarantine resolved",
      summary: "The retained source record passed retry and projection.",
      evidence: { outcome: "QUARANTINE_RESOLVED" },
    });
  }

  quarantineExpired(input: {
    organizationId: string;
    providerId: string;
    quarantineId: string;
    reasonCode: string;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "quarantine_expired",
      severity: "warning",
      providerId: input.providerId,
      runId: null,
      quarantineId: input.quarantineId,
      dedupeKey: `quarantine:expired:${input.quarantineId}`,
      recoveryKey: `quarantine:${input.quarantineId}`,
      title: "Quarantine source evidence expired",
      summary: "Retry is unavailable because protected source retention ended.",
      evidence: { reasonCode: safeCode(input.reasonCode, "QUARANTINE_EXPIRED") },
    });
  }

  retentionFailed(input: {
    organizationId: string;
    failureCode: string;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "retention_failed",
      severity: "critical",
      providerId: null,
      runId: null,
      quarantineId: null,
      dedupeKey: `retention:failed:${input.organizationId}`,
      recoveryKey: `retention:${input.organizationId}`,
      title: "Protected-data retention failed",
      summary: "A bounded protected-data cleanup did not complete.",
      evidence: { failureCode: safeCode(input.failureCode, "RETENTION_FAILED") },
    });
  }

  retentionRecovered(input: {
    organizationId: string;
    expiredCount: number;
    durationMs: number;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      organizationId: input.organizationId,
      kind: "retention_recovered",
      severity: "info",
      providerId: null,
      runId: null,
      quarantineId: null,
      dedupeKey: `retention:recovered:${input.organizationId}`,
      recoveryKey: `retention:${input.organizationId}`,
      title: "Protected-data retention recovered",
      summary: "The latest bounded protected-data cleanup completed.",
      evidence: {
        outcome: "RETENTION_RECOVERED",
        count: Math.max(0, Math.floor(input.expiredCount)),
        durationMs: Math.max(0, Math.floor(input.durationMs)),
      },
    });
  }

  private async emit(draft: EventDraft): Promise<NotificationPublishResult> {
    const occurredAt = this.clock.now();
    const parsed = operationalNotificationSchema.safeParse({
      ...draft,
      id: this.ids.id(),
      occurredAt: occurredAt.toISOString(),
    });
    if (!parsed.success) {
      this.recordNotification("failed", draft.organizationId, draft.providerId, occurredAt);
      return {
        status: "failed",
        alertId: null,
        failureCode: "INVALID_OPERATIONAL_EVENT",
      };
    }
    let result: NotificationPublishResult;
    try {
      result = await this.publisher.publish(parsed.data);
    } catch {
      result = failedNotification();
    }
    this.recordNotification(
      result.status,
      parsed.data.organizationId,
      parsed.data.providerId,
      occurredAt,
    );
    return result;
  }

  private recordNotification(
    status: NotificationPublishResult["status"],
    organizationId: string,
    providerId: string | null,
    occurredAt: Date,
  ): void {
    try {
      this.observability.metric({
        name: "notification_state_total",
        value: 1,
        organizationId,
        providerId,
        outcomeCode: status.toUpperCase(),
      });
    } catch {
      // Notification delivery must not depend on metrics availability.
    }
    try {
      this.observability.log({
        event: "notification",
        level: status === "failed" ? "error" : "info",
        organizationId,
        providerId,
        code: `NOTIFICATION_${status.toUpperCase()}`,
        occurredAt: occurredAt.toISOString(),
      });
    } catch {
      // Observability is intentionally best-effort and never changes pipeline outcomes.
    }
  }
}

export class PipelineOperationalReporter {
  constructor(
    private readonly observability: OperationalObservability,
    private readonly clock: ProviderClock,
  ) {}

  run(input: {
    organizationId: string;
    providerId: string;
    outcome: "SUCCEEDED" | "INCOMPLETE" | "FAILED";
    durationMs: number;
    pages: number;
    records: number;
  }): void {
    this.measure("run_duration_ms", input.durationMs, input, input.outcome);
    this.measure("run_outcome_total", 1, input, input.outcome);
    this.measure("page_count", input.pages, input, input.outcome);
    this.measure("record_count", input.records, input, input.outcome);
  }

  cursorLag(input: {
    organizationId: string;
    providerId: string;
    pagesBehindProxy: number;
  }): void {
    this.measure("cursor_lag_proxy", input.pagesBehindProxy, input, null);
  }

  freshness(input: {
    organizationId: string;
    providerId: string;
    ageSeconds: number;
    state: "FRESH" | "STALE";
  }): void {
    this.measure("freshness_age_seconds", input.ageSeconds, input, input.state);
  }

  quarantine(input: {
    organizationId: string;
    providerId: string;
    count: number;
    oldestAgeSeconds: number;
  }): void {
    this.measure("quarantine_count", input.count, input, null);
    this.measure("quarantine_age_seconds", input.oldestAgeSeconds, input, null);
  }

  retry(input: {
    organizationId: string;
    providerId: string;
    outcome: "RESOLVED" | "FAILED" | "EXPIRED" | "CONFLICT";
  }): void {
    this.measure("retry_outcome_total", 1, input, input.outcome);
  }

  calculation(input: {
    organizationId: string;
    providerId: string;
    availability: "AVAILABLE" | "LIMITED" | "UNAVAILABLE";
  }): void {
    this.measure(
      "calculation_availability_total",
      1,
      input,
      input.availability,
    );
  }

  private measure(
    name: OperationalMetricName,
    value: number,
    input: { organizationId: string; providerId: string },
    outcomeCode: string | null,
  ): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    try {
      this.observability.metric({
        name,
        value: safeValue,
        organizationId: input.organizationId,
        providerId: input.providerId,
        outcomeCode,
      });
    } catch {
      // Pipeline behavior must not depend on metrics availability.
    }
    try {
      this.observability.log({
        event: "pipeline_measurement",
        level: "info",
        organizationId: input.organizationId,
        providerId: input.providerId,
        code: name.toUpperCase(),
        occurredAt: this.clock.now().toISOString(),
      });
    } catch {
      // Metrics and logs must not become a pipeline dependency.
    }
  }
}
