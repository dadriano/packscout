import {
  operationalNotificationSchema,
  type MachineryCondition,
  type MachineryConditionKind,
  type NotificationPublishResult,
  type OperationalNotification,
  type OperationalSeverity,
  type PromotionLane,
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

function safeWatermark(value: bigint): string {
  return value >= 0n && value <= 9_999_999_999_999_999_999n
    ? String(value)
    : "0";
}

function laneLabel(lane: PromotionLane): "Provider" | "Manifest" | "Heat" {
  return lane === "provider"
    ? "Provider" : lane === "manifest" ? "Manifest" : "Heat";
}

function promotionAlertScope(
  deploymentScopeDigest: string,
  lane: PromotionLane,
  platformKey?: string,
): string | null {
  if (!/^[0-9a-f]{64}$/u.test(deploymentScopeDigest) ||
      (lane === "provider") !== (platformKey !== undefined) ||
      platformKey !== undefined &&
        !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(platformKey)) return null;
  return `promotion:${deploymentScopeDigest}:${lane}${
    platformKey === undefined ? "" : `:${platformKey}`
  }`;
}

interface MachineryCopy {
  readonly severity: OperationalSeverity;
  readonly title: string;
  readonly summary: string;
  readonly recoveredTitle: string;
  readonly recoveredSummary: string;
}

/**
 * Operator-facing wording for the machinery conditions. The measures stay in
 * bounded evidence; these sentences only say what broke and why it matters, so
 * a condition reads the same wherever it is surfaced.
 */
const machineryCopy: Record<MachineryConditionKind, MachineryCopy> = {
  worker_fleet_silent: {
    severity: "critical",
    title: "No worker is alive",
    summary:
      "No worker instance has reported inside the liveness window the fleet published, so nothing is importing, recalculating, or expiring evidence.",
    recoveredTitle: "Worker fleet recovered",
    recoveredSummary:
      "A worker instance is reporting inside its published liveness window again.",
  },
  import_run_stalled: {
    severity: "critical",
    title: "Import run is stalled",
    summary:
      "A running import run has not advanced its heartbeat within the window the fleet published; the worker holding it may be gone.",
    recoveredTitle: "Import run recovered",
    recoveredSummary:
      "The import run is beating again, or it reached a terminal outcome.",
  },
  provider_schedule_overdue: {
    severity: "warning",
    title: "Provider schedule is overdue",
    summary:
      "A provider is past its next-due time by more than the fleet's own liveness window, or is held behind a claim that outlived its expiry.",
    recoveredTitle: "Provider schedule recovered",
    recoveredSummary:
      "The provider schedule is inside its due tolerance and holds no expired claim.",
  },
  recomputation_backlogged: {
    severity: "warning",
    title: "Recomputation queue is backing up",
    summary:
      "Estimated-EV recomputation work is past a configured queue threshold, or is stuck behind expired claims and failed entries.",
    recoveredTitle: "Recomputation queue recovered",
    recoveredSummary:
      "The recomputation queue is inside its thresholds with no stuck work.",
  },
  retention_overdue: {
    severity: "warning",
    title: "Protected-data retention is overdue",
    summary:
      "No protected-data cleanup has started within its expected interval while evidence is still known to be waiting.",
    recoveredTitle: "Protected-data retention resumed",
    recoveredSummary:
      "A protected-data cleanup started inside its expected interval again.",
  },
};

/** A fleet that never reported has no silence to describe, only an absence. */
const NEVER_REPORTED_SUMMARY =
  "No worker instance has reported at all inside the retained presence window, so how long the fleet has been quiet cannot be measured.";

function machineryEvidence(
  condition: MachineryCondition,
): OperationalNotification["evidence"] {
  return {
    outcome: condition.outcome,
    ...(condition.threshold === null ? {} : { reasonCode: condition.threshold }),
    ...(condition.observedMs === null
      ? {}
      : { durationMs: condition.observedMs }),
    ...(condition.thresholdMs === null
      ? {}
      : { thresholdMs: condition.thresholdMs }),
    ...(condition.observedCount === null
      ? {}
      : { count: condition.observedCount }),
    ...(condition.thresholdCount === null
      ? {}
      : { thresholdCount: condition.thresholdCount }),
  };
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

  /**
   * Raises one machinery condition. The condition arrives already decided by
   * the shared evaluations, so this only publishes it; the durable alert path
   * groups repeat occurrences onto the single alert its dedupe key names.
   */
  machineryConditionRaised(input: {
    organizationId: string;
    condition: MachineryCondition;
  }): Promise<NotificationPublishResult> {
    const { condition } = input;
    const copy = machineryCopy[condition.kind];
    return this.emit({
      organizationId: input.organizationId,
      kind: condition.kind,
      severity: copy.severity,
      providerId: condition.providerId,
      runId: condition.runId,
      quarantineId: null,
      dedupeKey: condition.dedupeKey,
      recoveryKey: condition.recoveryKey,
      title: copy.title,
      summary:
        condition.outcome === "WORKER_FLEET_NEVER_REPORTED"
          ? NEVER_REPORTED_SUMMARY
          : copy.summary,
      evidence: machineryEvidence(condition),
    });
  }

  /**
   * Closes a machinery condition that no longer holds. One recovery kind serves
   * every condition because the recovery key already names which one cleared,
   * and a recurrence reopens through the ordinary alert lifecycle.
   */
  machineryConditionCleared(input: {
    organizationId: string;
    kind: MachineryConditionKind;
    recoveryKey: string;
    providerId: string | null;
    runId: string | null;
  }): Promise<NotificationPublishResult> {
    const copy = machineryCopy[input.kind];
    return this.emit({
      organizationId: input.organizationId,
      kind: "machinery_recovered",
      severity: "info",
      providerId: input.providerId,
      runId: input.runId,
      quarantineId: null,
      dedupeKey: `${input.recoveryKey}:recovered`,
      recoveryKey: input.recoveryKey,
      title: copy.recoveredTitle,
      summary: copy.recoveredSummary,
      evidence: { outcome: "MACHINERY_RECOVERED" },
    });
  }

  promotionActivationDelayed(input: {
    organizationId: string;
    deploymentScopeDigest: string;
    lane: PromotionLane;
    platformKey?: string;
    targetWatermark: bigint;
    confirmedWatermark: bigint;
    durationMs: number;
  }): Promise<NotificationPublishResult> {
    const alertScope = promotionAlertScope(
      input.deploymentScopeDigest,
      input.lane,
      input.platformKey,
    );
    if (alertScope === null) return Promise.resolve(failedNotification());
    return this.emit({
      organizationId: input.organizationId,
      kind: "promotion_activation_delayed",
      severity: "warning",
      providerId: null,
      runId: null,
      quarantineId: null,
      dedupeKey: `${alertScope}:activation-delayed`,
      recoveryKey: `${alertScope}:health`,
      title: `${laneLabel(input.lane)} publication is delayed`,
      summary: "A ready public watermark has not been confirmed within its activation target.",
      evidence: {
        lane: input.lane,
        ...(input.platformKey === undefined ? {} : {
          platformKey: input.platformKey,
        }),
        condition: "activation_lag",
        targetWatermark: safeWatermark(input.targetWatermark),
        confirmedWatermark: safeWatermark(input.confirmedWatermark),
        durationMs: Math.max(0, Math.floor(input.durationMs)),
      },
    });
  }

  promotionSettlementBlocked(input: {
    organizationId: string;
    deploymentScopeDigest: string;
    lane: PromotionLane;
    platformKey?: string;
    sourceHeadWatermark: bigint;
    settledWatermark: bigint;
    technicalFailureCount: number;
  }): Promise<NotificationPublishResult> {
    const alertScope = promotionAlertScope(
      input.deploymentScopeDigest,
      input.lane,
      input.platformKey,
    );
    if (alertScope === null) return Promise.resolve(failedNotification());
    return this.emit({
      organizationId: input.organizationId,
      kind: "promotion_settlement_blocked",
      severity: "critical",
      providerId: null,
      runId: null,
      quarantineId: null,
      dedupeKey: `${alertScope}:settlement-blocked`,
      recoveryKey: `${alertScope}:health`,
      title: `${laneLabel(input.lane)} settlement is blocked`,
      summary: "A technical derivation outcome is preventing the public watermark from settling.",
      evidence: {
        lane: input.lane,
        ...(input.platformKey === undefined ? {} : {
          platformKey: input.platformKey,
        }),
        condition: "settlement_blocked",
        targetWatermark: safeWatermark(input.sourceHeadWatermark),
        confirmedWatermark: safeWatermark(input.settledWatermark),
        count: Math.max(1, Math.floor(input.technicalFailureCount)),
      },
    });
  }

  promotionFailed(input: {
    organizationId: string;
    deploymentScopeDigest: string;
    lane: PromotionLane;
    platformKey?: string;
    attemptId: string;
    targetWatermark: bigint;
    confirmedWatermark: bigint;
    failureCode: string;
    reconciliation: boolean;
  }): Promise<NotificationPublishResult> {
    const alertScope = promotionAlertScope(
      input.deploymentScopeDigest,
      input.lane,
      input.platformKey,
    );
    if (alertScope === null) return Promise.resolve(failedNotification());
    return this.emit({
      organizationId: input.organizationId,
      kind: "promotion_failed",
      severity: "critical",
      providerId: null,
      runId: null,
      quarantineId: null,
      dedupeKey: `${alertScope}:failed`,
      recoveryKey: `${alertScope}:health`,
      title: `${laneLabel(input.lane)} publication failed`,
      summary: input.reconciliation
        ? "Publication reconciliation reached a safe terminal failure."
        : "Publication reached a safe terminal failure before confirmation.",
      evidence: {
        lane: input.lane,
        ...(input.platformKey === undefined ? {} : {
          platformKey: input.platformKey,
        }),
        condition: input.reconciliation
          ? "reconciliation_failure"
          : "terminal_failure",
        targetWatermark: safeWatermark(input.targetWatermark),
        confirmedWatermark: safeWatermark(input.confirmedWatermark),
        attemptId: input.attemptId,
        failureCode: safeCode(
          input.failureCode,
          "PROMOTION_PUBLICATION_FAILED",
        ),
      },
    });
  }

  promotionRecovered(input: {
    organizationId: string;
    deploymentScopeDigest: string;
    lane: PromotionLane;
    platformKey?: string;
    targetWatermark: bigint;
    confirmedWatermark: bigint;
  }): Promise<NotificationPublishResult> {
    const alertScope = promotionAlertScope(
      input.deploymentScopeDigest,
      input.lane,
      input.platformKey,
    );
    if (alertScope === null) return Promise.resolve(failedNotification());
    return this.emit({
      organizationId: input.organizationId,
      kind: "promotion_recovered",
      severity: "info",
      providerId: null,
      runId: null,
      quarantineId: null,
      dedupeKey: `${alertScope}:recovered`,
      recoveryKey: `${alertScope}:health`,
      title: `${laneLabel(input.lane)} publication recovered`,
      summary: "The public lane is fully confirmed and has no technical settlement block.",
      evidence: {
        lane: input.lane,
        ...(input.platformKey === undefined ? {} : {
          platformKey: input.platformKey,
        }),
        condition: "recovered",
        targetWatermark: safeWatermark(input.targetWatermark),
        confirmedWatermark: safeWatermark(input.confirmedWatermark),
        outcome: "PROMOTION_RECOVERED",
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
