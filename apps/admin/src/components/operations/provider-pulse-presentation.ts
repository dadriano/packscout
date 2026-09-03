import type { ProviderCanonicalEntityKey, ProviderSourceOperationsSource } from "@packscout/contracts";
import type { StatusTone } from "../StatusBadge";
import { age } from "./OperationStatus";
import { sourceOperationalLabel } from "./SourceOperationsViews";

interface PulseState {
  label: string;
  description: string;
  tone: StatusTone;
}

const states: Record<string, PulseState> = {
  "Not configured": { label: "Not configured", description: "This provider has no configured source. Configure it before importing.", tone: "pending" },
  "Unsupported adapter": { label: "Unsupported adapter", description: "This provider has a configuration, but its adapter is not supported by this admin runtime. Review the adapter in source settings; measurements are unavailable.", tone: "pending" },
  "Database unavailable": { label: "Database unavailable", description: "The provider database could not be read. Worker state and progress are unverified; ingestion may still be running. Restore database access or retry the status refresh.", tone: "danger" },
  "Connection transition uncertain": { label: "Connection uncertain", description: "The source connection is changing and its current state cannot be confirmed. Local run and storage evidence remain separate.", tone: "danger" },
  "Waiting on connection recovery": { label: "Connection blocked", description: "The processor is waiting for its source connection to recover before it can continue.", tone: "danger" },
  "Pause requested": { label: "Pause requested", description: "A pause was requested. The current page may still commit before ingestion pauses.", tone: "pending" },
  "No live worker": { label: "No processor state", description: "No processor state is recorded. This does not prove whether an operating-system process is running.", tone: "pending" },
  Retrying: { label: "Retrying", description: "The processor has recorded a retry and has not become inactive. Its next attempt may be waiting for backoff or capacity.", tone: "pending" },
  Queued: { label: "Queued", description: "A run is queued but has not started processing.", tone: "pending" },
  Running: { label: "Running", description: "The processor reports a running activity. Check Last page for committed progress; this state alone does not verify a live worker process.", tone: "ready" },
  Paused: { label: "Paused", description: "Ingestion is paused for this source. Stored data and its committed cursor are retained.", tone: "neutral" },
  Disabled: { label: "Disabled", description: "This source is disabled and cannot ingest. Stored data and the latest run remain available for inspection.", tone: "neutral" },
  Draft: { label: "Draft", description: "This source has been configured but has not been activated for ingestion.", tone: "pending" },
  Replaced: { label: "Replaced", description: "This source revision was replaced. Its historical runs do not describe current ingestion.", tone: "neutral" },
  "Action required": { label: "Action required", description: "The processor cannot recover automatically. An administrator must correct the reported cause before resuming.", tone: "danger" },
  "Waiting for capacity": { label: "Waiting for capacity", description: "The processor is waiting for an execution slot or request permit. It is not currently processing a page.", tone: "pending" },
  Failed: { label: "Failed", description: "The latest run failed and no newer run is reported as running. Open its details for the failure code.", tone: "danger" },
  "Reached head": { label: "Reached head", description: "The processor recorded reaching the end of available source data. This does not verify that a resident poller is still running or that new data has arrived.", tone: "neutral" },
  Waiting: { label: "Waiting", description: "The processor is waiting. Expand Details for its recorded wait reason and next scheduled run.", tone: "neutral" },
  Idle: { label: "Idle", description: "The processor is not reporting active work. Check its schedule and last committed page before assuming it is caught up.", tone: "neutral" },
};

/**
 * The three measurements an operator is shown. Rows left uncounted because
 * counting would exceed its budget are still reported, through the estimate,
 * so that case is evidence rather than missing evidence.
 */
function measurementEvidence(source: ProviderSourceOperationsSource) {
  const { storage, storageEstimate, records, activity } = source.measurements;
  const measured = storage.state === "unavailable"
    && storage.reason === "count_exceeds_budget" && storageEstimate !== null;
  return [measured ? ({ state: "available" } as const) : storage, records, activity];
}

export function isUnsupportedSource(source: ProviderSourceOperationsSource): boolean {
  return !source.configured && measurementEvidence(source).some(
    (measurement) => measurement.state === "unavailable" && measurement.reason === "unsupported",
  );
}

export function isDatabaseUnavailable(source: ProviderSourceOperationsSource): boolean {
  return source.measurements.activity.state === "unavailable"
    && source.measurements.activity.reason === "database_unreachable";
}

export function pulseState(source: ProviderSourceOperationsSource): PulseState {
  const activity = source.measurements.activity;
  if (isUnsupportedSource(source)) return states["Unsupported adapter"]!;
  if (!source.configured) return states["Not configured"]!;
  if (source.source?.lifecycle === "disabled") return states.Disabled!;
  if (source.source?.lifecycle === "draft") return states.Draft!;
  if (source.source?.lifecycle === "replaced") return states.Replaced!;
  if (isDatabaseUnavailable(source)) return states["Database unavailable"]!;
  if (source.processor?.activity === "action_required") return states["Action required"]!;
  if (source.source?.pauseRequested) return states["Pause requested"]!;
  if (source.source?.lifecycle === "paused" || source.processor?.activity === "paused") return states.Paused!;
  if (source.configured && source.connectionImpact.state === "blocked") {
    return states["Waiting on connection recovery"]!;
  }
  if (source.activeRun?.state === "running" || source.processor?.activity === "running") {
    if (activity.state === "unavailable") return { label: "Activity unverified", description: "Running is reported, but current database activity and lease evidence are unavailable. Do not assume that a worker is live or making progress.", tone: "pending" };
    if (activity.importLease.state !== "active") {
      return { label: activity.importLease.state === "expired" ? "Lease expired" : "No import lease", description: "The run reports running, but it has no valid database import lease. Current worker activity is unverified; inspect the provider before restarting.", tone: "danger" };
    }
  }
  return states[sourceOperationalLabel(source)] ?? states.Idle!;
}

export function pulseNeedsAttention(source: ProviderSourceOperationsSource): boolean {
  const status = pulseState(source);
  return status.tone === "danger"
    || ["Not configured", "Draft", "No processor state", "Retrying"].includes(status.label)
    || (source.freshness.state === "stale" && source.source?.lifecycle === "active" && !source.source.pauseRequested && source.processor?.activity !== "paused")
    || source.quality.state === "warning" || source.quality.state === "degraded"
    || measurementEvidence(source).some((measurement) => measurement.state === "unavailable")
    || (source.measurements.activity.state === "available" && source.measurements.activity.quarantine.open > 0);
}

export function pulseIssue(source: ProviderSourceOperationsSource): string | null {
  const status = pulseState(source);
  if (status.label === "Database unavailable") return "Restore database access or retry the status refresh.";
  if (status.label === "Action required") return "Administrator recovery required.";
  if (status.label === "Failed") return "Latest run failed. Review the failure in Details.";
  if (status.label === "Lease expired") return "Running is reported, but the import lease has expired.";
  if (status.label === "No import lease") return "Running is reported without an owned import lease.";
  if (status.label === "Activity unverified") return "Running is reported; current activity cannot be verified.";
  if (status.label === "Connection blocked") return "Waiting for the source connection to recover.";
  if (status.label === "Connection uncertain") return "Connection state cannot be confirmed.";
  if (status.label === "Unsupported adapter") return "Review the configured adapter in source settings.";
  if (status.label === "Not configured") return "Configure this provider to begin importing.";
  if (status.label === "No processor state") return "Processor activity is unavailable.";
  if (source.freshness.state === "stale" && source.source?.lifecycle === "active" && !source.source.pauseRequested && source.processor?.activity !== "paused") return "Source freshness is outside its configured window.";
  if (measurementEvidence(source).some((measurement) => measurement.state === "unavailable")) return "Some measurements are unavailable.";
  if (source.quality.state === "degraded") return "Repeated failures have degraded data quality.";
  if (source.quality.state === "warning") return "Data quality needs review.";
  return null;
}

export function sortPulseSources(sources: readonly ProviderSourceOperationsSource[]): ProviderSourceOperationsSource[] {
  const priority = (source: ProviderSourceOperationsSource) => pulseState(source).tone === "danger" ? 0 : pulseNeedsAttention(source) ? 1 : 2;
  return [...sources].sort((left, right) => priority(left) - priority(right) || left.displayName.localeCompare(right.displayName));
}

export function measurementTotal(sources: readonly ProviderSourceOperationsSource[], metric: "storage" | "records") {
  const readings = sources.map((source) => storedReading(source, metric));
  const values = readings.flatMap((reading) => reading.value === null ? [] : [reading.value]);
  // A total that mixes counted and estimated providers is itself an estimate.
  const estimated = readings.some((reading) => reading.value !== null && reading.estimated);
  const total = values.reduce((sum, value) => sum + value, 0);
  const safeTotal = Number.isSafeInteger(total);
  return {
    value: values.length > 0 && safeTotal ? total : null,
    estimated: estimated && values.length > 0 && safeTotal,
    coverage: !safeTotal ? "Total exceeds safe numeric range" : values.length === sources.length && sources.length > 0
      ? `All ${sources.length} providers`
      : `${values.length > 0 ? "Partial · " : ""}${values.length}/${sources.length} providers`,
  };
}

/**
 * Resolves the one storage answer to show. An exact count is preferred; the
 * estimate is used only where the server left the count unavailable because
 * counting would exceed its budget, and is always flagged as an estimate.
 */
export function storedReading(
  source: ProviderSourceOperationsSource,
  metric: "storage" | "records" = "storage",
): { value: number | null; estimated: boolean; measuredAt: string | null } {
  if (metric === "records") {
    const records = source.measurements.records;
    return { value: records.state === "available" ? records.processed : null,
      estimated: false, measuredAt: records.state === "available" ? records.measuredAt : null };
  }
  const { storage, storageEstimate } = source.measurements;
  if (storage.state === "available") {
    return { value: storage.counts.total, estimated: false, measuredAt: storage.measuredAt };
  }
  if (storageEstimate) {
    return { value: storageEstimate.counts.total, estimated: true, measuredAt: storageEstimate.measuredAt };
  }
  return { value: null, estimated: false, measuredAt: null };
}

export interface EntityReading {
  readonly state: "measured" | "unavailable";
  readonly value: number | null;
  readonly estimated: boolean;
  readonly measuredAt: string | null;
}

/**
 * Resolves one entity's stored-row reading on its own. Entities are decided
 * separately because table sizes differ by orders of magnitude inside a single
 * provider: the server counts what it can afford and estimates only the rest,
 * so an entity that was counted is never shown as an estimate merely because a
 * larger table beside it could not be.
 */
export function storedEntityReading(
  source: ProviderSourceOperationsSource,
  entity: ProviderCanonicalEntityKey,
): EntityReading {
  const { storage, storageEstimate } = source.measurements;
  if (storage.state === "available") {
    return { state: "measured", value: storage.counts[entity], estimated: false,
      measuredAt: storage.measuredAt };
  }
  if (storageEstimate) {
    return { state: "measured", value: storageEstimate.counts[entity],
      estimated: storageEstimate.estimatedEntities.includes(entity),
      measuredAt: storageEstimate.measuredAt };
  }
  return { state: "unavailable", value: null, estimated: false, measuredAt: null };
}

/**
 * Estimated rows are marked so a reader never mistakes a statistics estimate
 * for a count. Unavailable stays unavailable; only measured values are marked.
 */
export function storedCount(value: number | null, estimated: boolean): string {
  const rendered = count(value);
  return value !== null && estimated ? `≈${rendered}` : rendered;
}

export function count(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString("en-US");
}

export function measuredAge(value: string | null, observedAt: string): string {
  return value === null ? "Not recorded" : `${age(Math.max(0, Date.parse(observedAt) - Date.parse(value)))} ago`;
}

export const metricDescriptions = {
  stored: "Rows in canonical entity tables, including child and relationship rows. These are not unique source records. Values marked \u2248 are the database's live-tuple estimate, used where an exact count would cost more than its measurement budget; unmarked values are exact. Cached for up to 60 seconds; precision and measurement times are in Details.",
  processed: "Source records processed across all retained runs. Repeat processing is counted again; this is not the number of unique stored entities. Cached for up to 60 seconds.",
  page: "Time since the last durably committed page found by the history check, relative to the displayed status time. History is cached for up to 60 seconds; newer pages may exist. A heartbeat is not committed progress.",
  quarantine: "Open quarantine entries across retained runs, excluding resolved and expired entries. History is cached for up to 60 seconds; newer changes may exist. This is separate from the current run's quarantine count.",
  attention: "Providers with failed or uncertain state, stale data, quality warnings, open quarantine, retries, missing configuration, or unavailable measurements. A running provider may also need attention.",
} as const;
