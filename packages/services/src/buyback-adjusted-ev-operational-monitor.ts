import {
  operationalNotificationSchema,
  type NotificationPublishResult,
  type OperationalEventKind,
  type OperationalNotification,
  type OperationalSeverity,
} from "@packscout/contracts";
import type {
  NotificationPublisher,
  OperationalObservability,
} from "./operational-events.ts";
import type {
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";
import type { PackScoutBuybackEvBackfillLedgerV1 } from "./buyback-adjusted-ev-backfill-reconciliation.ts";

/**
 * Bounded operational monitoring and Engineering alerting for the
 * buyback-adjusted EV path (task buyback-adjusted-ev/012).
 *
 * Every emission is bounded: outcome labels, stable codes, counts, and ages
 * only. Money values, raw source data, provider payloads, credentials, user
 * identities, and protected evidence are structurally absent, and one final
 * string-scan tripwire re-proves that before anything leaves this module.
 * Telemetry failures never change a pipeline outcome.
 *
 * The alert mapping reuses the existing operational notification kinds (the
 * durable admin alert channel) with buyback-EV-scoped dedupe keys, so each
 * condition deduplicates independently of provider-import alerts and recovers
 * through its own recovery key.
 */

export const PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1 = Object.freeze([
  "recomputation_backlog",
  "method_mismatch",
  "publication_rejected",
  "freshness_expired",
] as const);

export type PackScoutBuybackEvAlertConditionV1 =
  (typeof PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1)[number];

export interface PackScoutBuybackEvAlertMappingEntryV1 {
  readonly condition: PackScoutBuybackEvAlertConditionV1;
  /** Existing operational notification kind carrying the alert. */
  readonly kind: OperationalEventKind;
  readonly severity: OperationalSeverity;
  /** Deduplication key pattern; `<scope>` is the provider id or organization id. */
  readonly dedupeKeyPattern: string;
  readonly recoveryKeyPattern: string;
  /** Bounded evidence keys the emitted event may carry. */
  readonly evidenceKeys: readonly ("failureCode" | "reasonCode" | "outcome" | "count" | "durationMs")[];
}

/** The documented condition-to-alert mapping, one entry per required alert. */
export const PACKSCOUT_BUYBACK_EV_ALERT_MAPPING_V1: readonly PackScoutBuybackEvAlertMappingEntryV1[] =
  Object.freeze([
    Object.freeze({
      condition: "recomputation_backlog",
      kind: "provider_stale",
      severity: "warning",
      dedupeKeyPattern: "buyback-ev:backlog:<scope>",
      recoveryKeyPattern: "buyback-ev:recomputation:<scope>",
      evidenceKeys: ["count", "durationMs"],
    } as const),
    Object.freeze({
      condition: "method_mismatch",
      kind: "run_failed",
      severity: "critical",
      dedupeKeyPattern: "buyback-ev:method-mismatch:<scope>",
      recoveryKeyPattern: "buyback-ev:method:<scope>",
      evidenceKeys: ["failureCode"],
    } as const),
    Object.freeze({
      condition: "publication_rejected",
      kind: "run_failed",
      severity: "critical",
      dedupeKeyPattern: "buyback-ev:publication:<scope>",
      recoveryKeyPattern: "buyback-ev:publication:<scope>",
      evidenceKeys: ["failureCode"],
    } as const),
    Object.freeze({
      condition: "freshness_expired",
      kind: "provider_stale",
      severity: "warning",
      dedupeKeyPattern: "buyback-ev:freshness:<scope>",
      recoveryKeyPattern: "buyback-ev:freshness:<scope>",
      evidenceKeys: ["count", "durationMs", "reasonCode"],
    } as const),
  ]);

const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Field names and value shapes that must never appear in an operational
 * event: money spellings, raw payload markers, credentials, and personal
 * identity markers. The tripwire scans the serialized event bytes.
 */
const FORBIDDEN_EVENT_TEXT: readonly RegExp[] = Object.freeze([
  /minorUnits/i,
  /grossEv/i,
  /evDollars/i,
  /packPrice/i,
  /underlyingOutcome/i,
  /drawMultiplier/i,
  /statedValue/i,
  /payload/i,
  /rawSource/i,
  /authorization/i,
  /bearer\s/i,
  /credential/i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /wallet/i,
  /userId/i,
  /email/i,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /\$\s?\d/,
  /0x[0-9a-f]{16,}/i,
]);

export class PackScoutBuybackEvOperationalEventLeakError extends Error {
  constructor() {
    super(
      "A buyback EV operational event would carry protected content and was refused.",
    );
    this.name = "PackScoutBuybackEvOperationalEventLeakError";
  }
}

/**
 * Final tripwire before an event leaves the boundary: any protected spelling
 * anywhere in the serialized event fails closed. Exported so tests can prove
 * the scan against representative leak attempts.
 */
export function assertPackScoutBuybackEvOperationalEventSanitizedV1(
  event: unknown,
): void {
  const serialized = JSON.stringify(event) ?? "";
  for (const pattern of FORBIDDEN_EVENT_TEXT) {
    if (pattern.test(serialized)) {
      throw new PackScoutBuybackEvOperationalEventLeakError();
    }
  }
}

function safeCode(code: string, fallback: string): string {
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

/** Uppercased stable code for a bounded version label. */
export function packScoutBuybackEvVersionCodeV1(version: string): string {
  const upper = version.toUpperCase().replaceAll(/[^A-Z0-9]+/g, "_");
  const trimmed = upper.replaceAll(/^_+|_+$/g, "").slice(0, 96);
  return safeCode(
    trimmed === "" ? "UNKNOWN_VERSION" : trimmed,
    "UNKNOWN_VERSION",
  );
}

function boundedCount(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Math.max(0, Math.floor(value)), Number.MAX_SAFE_INTEGER)
    : 0;
}

interface AlertDraft {
  readonly condition: PackScoutBuybackEvAlertConditionV1;
  readonly organizationId: string;
  readonly providerId: string | null;
  readonly scope: string;
  readonly title: string;
  readonly summary: string;
  readonly evidence: OperationalNotification["evidence"];
}

function failedResult(): NotificationPublishResult {
  return {
    status: "failed",
    alertId: null,
    failureCode: "NOTIFICATION_PUBLISH_FAILED",
  };
}

export interface PackScoutBuybackEvMonitorDependenciesV1 {
  readonly publisher: NotificationPublisher;
  readonly ids: ProviderIdSource;
  readonly clock: ProviderClock;
  readonly observability?: OperationalObservability;
}

export class PackScoutBuybackEvOperationalMonitorV1 {
  constructor(
    private readonly dependencies: PackScoutBuybackEvMonitorDependenciesV1,
  ) {}

  /** Recomputation backlog: queued work exceeded its processing target. */
  recomputationBacklog(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly queuedCount: number;
    readonly oldestQueuedAgeSeconds: number;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      condition: "recomputation_backlog",
      organizationId: input.organizationId,
      providerId: input.providerId,
      scope: input.providerId,
      title: "Buyback EV recomputation backlog",
      summary:
        "Queued buyback EV recomputation work has not drained within its processing target.",
      evidence: {
        count: boundedCount(input.queuedCount),
        durationMs: boundedCount(input.oldestQueuedAgeSeconds * 1_000),
      },
    });
  }

  /** A completed revision or release carried an unapproved method version. */
  methodMismatch(input: {
    readonly organizationId: string;
    readonly observedMethodVersion: string;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      condition: "method_mismatch",
      organizationId: input.organizationId,
      providerId: null,
      scope: input.organizationId,
      title: "Buyback EV method version mismatch",
      summary:
        "A calculation or release surfaced a method version other than the approved buyback-adjusted version.",
      evidence: {
        failureCode: packScoutBuybackEvVersionCodeV1(
          input.observedMethodVersion,
        ),
      },
    });
  }

  /** The data_release_v3 lifecycle refused a staged or activating release. */
  publicationRejected(input: {
    readonly organizationId: string;
    readonly stage: string;
    readonly code: string;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      condition: "publication_rejected",
      organizationId: input.organizationId,
      providerId: null,
      scope: input.organizationId,
      title: "Buyback EV publication rejected",
      summary:
        "The public release lifecycle refused a staged buyback EV release before activation.",
      evidence: {
        failureCode: safeCode(
          `${input.stage}_${input.code}`.toUpperCase().replaceAll(/[^A-Z0-9_]+/g, "_"),
          "PUBLICATION_REJECTED",
        ),
      },
    });
  }

  /** Active estimates crossed the 60-minute freshness boundary. */
  freshnessExpired(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly expiredCount: number;
    readonly oldestSourceAgeSeconds: number;
  }): Promise<NotificationPublishResult> {
    return this.emit({
      condition: "freshness_expired",
      organizationId: input.organizationId,
      providerId: input.providerId,
      scope: input.providerId,
      title: "Buyback EV freshness expired",
      summary:
        "Active buyback EV estimates crossed the freshness boundary and left the rankings.",
      evidence: {
        count: boundedCount(input.expiredCount),
        durationMs: boundedCount(input.oldestSourceAgeSeconds * 1_000),
        reasonCode: "SOURCE_DATA_STALE",
      },
    });
  }

  /**
   * Bounded backfill telemetry: method-version distribution, availability,
   * unavailable reasons, confidence bands, source conflicts, source-age
   * distribution, and staging outcome — counts and labels only.
   */
  reportBackfillLedger(ledger: PackScoutBuybackEvBackfillLedgerV1): void {
    const organizationId = ledger.organizationId;
    for (const version of ledger.methodVersions) {
      this.metric({
        name: "record_count",
        value: ledger.rows.length,
        organizationId,
        providerId: null,
        outcomeCode: packScoutBuybackEvVersionCodeV1(version),
      });
    }
    this.metric({
      name: "calculation_availability_total",
      value: ledger.counts.recomputedAvailable,
      organizationId,
      providerId: null,
      outcomeCode: "AVAILABLE",
    });
    this.metric({
      name: "calculation_availability_total",
      value: ledger.counts.deterministicUnavailable,
      organizationId,
      providerId: null,
      outcomeCode: "UNAVAILABLE",
    });
    for (const [reason, count] of Object.entries(ledger.counts.byPublicReason)) {
      this.metric({
        name: "record_count",
        value: count,
        organizationId,
        providerId: null,
        outcomeCode: safeCode(reason, "UNAVAILABLE_REASON_INVALID"),
      });
    }
    for (const [band, count] of Object.entries(ledger.counts.byConfidenceBand)) {
      this.metric({
        name: "record_count",
        value: count,
        organizationId,
        providerId: null,
        outcomeCode: safeCode(
          `CONFIDENCE_BAND_${band.toUpperCase()}`,
          "CONFIDENCE_BAND_INVALID",
        ),
      });
    }
    this.metric({
      name: "record_count",
      value: ledger.recomputation.rejected,
      organizationId,
      providerId: null,
      outcomeCode: "SOURCE_CONFLICT",
    });
    for (const [bucket, count] of Object.entries(ledger.counts.bySourceAge)) {
      this.metric({
        name: "record_count",
        value: count,
        organizationId,
        providerId: null,
        outcomeCode: safeCode(
          `SOURCE_AGE_${bucket.toUpperCase()}`,
          "SOURCE_AGE_INVALID",
        ),
      });
    }
    this.metric({
      name: "run_outcome_total",
      value: 1,
      organizationId,
      providerId: null,
      outcomeCode:
        ledger.classification === "ready" ? "STAGED" : "PUBLICATION_BLOCKED",
    });
  }

  /** Queue lag proxy: oldest queued age in seconds for one provider lane. */
  reportQueueLag(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly oldestQueuedAgeSeconds: number;
  }): void {
    this.metric({
      name: "cursor_lag_proxy",
      value: boundedCount(input.oldestQueuedAgeSeconds),
      organizationId: input.organizationId,
      providerId: input.providerId,
      outcomeCode: "BUYBACK_EV_QUEUE",
    });
  }

  /** Recomputation age: seconds between essential source time and now. */
  reportRecomputationAge(input: {
    readonly organizationId: string;
    readonly providerId: string;
    readonly sourceAgeSeconds: number;
  }): void {
    this.metric({
      name: "freshness_age_seconds",
      value: boundedCount(input.sourceAgeSeconds),
      organizationId: input.organizationId,
      providerId: input.providerId,
      outcomeCode: "BUYBACK_ADJUSTED_EV",
    });
  }

  private async emit(draft: AlertDraft): Promise<NotificationPublishResult> {
    const mapping = PACKSCOUT_BUYBACK_EV_ALERT_MAPPING_V1.find(
      (entry) => entry.condition === draft.condition,
    );
    if (mapping === undefined || !SCOPE_PATTERN.test(draft.scope)) {
      return failedResult();
    }
    const occurredAt = this.dependencies.clock.now().toISOString();
    const candidate = {
      id: this.dependencies.ids.id(),
      organizationId: draft.organizationId,
      kind: mapping.kind,
      severity: mapping.severity,
      providerId: draft.providerId,
      runId: null,
      quarantineId: null,
      dedupeKey: mapping.dedupeKeyPattern.replace("<scope>", draft.scope),
      recoveryKey: mapping.recoveryKeyPattern.replace("<scope>", draft.scope),
      title: draft.title,
      summary: draft.summary,
      evidence: draft.evidence,
      occurredAt,
    };
    const parsed = operationalNotificationSchema.safeParse(candidate);
    if (!parsed.success) {
      this.recordAlertState("failed", draft, occurredAt);
      return {
        status: "failed",
        alertId: null,
        failureCode: "INVALID_OPERATIONAL_EVENT",
      };
    }
    try {
      assertPackScoutBuybackEvOperationalEventSanitizedV1(parsed.data);
    } catch {
      this.recordAlertState("failed", draft, occurredAt);
      return {
        status: "failed",
        alertId: null,
        failureCode: "INVALID_OPERATIONAL_EVENT",
      };
    }
    let result: NotificationPublishResult;
    try {
      result = await this.dependencies.publisher.publish(parsed.data);
    } catch {
      result = failedResult();
    }
    this.recordAlertState(result.status, draft, occurredAt);
    return result;
  }

  private recordAlertState(
    status: NotificationPublishResult["status"],
    draft: AlertDraft,
    occurredAt: string,
  ): void {
    this.metric({
      name: "notification_state_total",
      value: 1,
      organizationId: draft.organizationId,
      providerId: draft.providerId,
      outcomeCode: status.toUpperCase(),
    });
    this.log(draft, status === "failed" ? "error" : "info", occurredAt);
  }

  private metric(
    metric: Parameters<OperationalObservability["metric"]>[0],
  ): void {
    const observability = this.dependencies.observability;
    if (!observability) return;
    try {
      assertPackScoutBuybackEvOperationalEventSanitizedV1(metric);
      observability.metric(metric);
    } catch {
      // Monitoring must never change a pipeline outcome.
    }
  }

  private log(
    draft: AlertDraft,
    level: "info" | "error",
    occurredAt: string,
  ): void {
    const observability = this.dependencies.observability;
    if (!observability) return;
    try {
      const entry = {
        event: "pipeline_measurement" as const,
        level,
        organizationId: draft.organizationId,
        providerId: draft.providerId,
        code: safeCode(
          `BUYBACK_EV_ALERT_${draft.condition.toUpperCase()}`,
          "BUYBACK_EV_ALERT",
        ),
        occurredAt,
      };
      assertPackScoutBuybackEvOperationalEventSanitizedV1(entry);
      observability.log(entry);
    } catch {
      // Monitoring must never change a pipeline outcome.
    }
  }
}

export function packScoutBuybackEvAlertMappingForConditionV1(
  condition: PackScoutBuybackEvAlertConditionV1,
): PackScoutBuybackEvAlertMappingEntryV1 {
  const entry = PACKSCOUT_BUYBACK_EV_ALERT_MAPPING_V1.find(
    (candidate) => candidate.condition === condition,
  );
  if (entry === undefined) {
    throw new Error("Every buyback EV alert condition must be mapped.");
  }
  return entry;
}
