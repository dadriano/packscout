import { importRunDetailPath, type ProviderSourceMeasurements, type ProviderSourceOperationsSource } from "@packscout/contracts";
import { Link } from "react-router-dom";
import { IndicatorTooltip } from "../IndicatorTooltip";
import { age, dateTime, humanize, interval } from "./OperationStatus";
import {
  SourceOperationControls,
  sourceRequestSettingsUnavailable,
  type SourceOperationControlsProps,
} from "./SourceOperationControls";
import { count, isDatabaseUnavailable, isUnsupportedSource, measuredAge, metricDescriptions } from "./provider-pulse-presentation";

const entityLabels = {
  categories: "Categories", packs: "Packs", collectibles: "Collectibles", aliases: "Aliases",
  instances: "Instances", packContents: "Pack contents", accounts: "Accounts", pulls: "Pulls",
  pullItems: "Pull items", marketEvents: "Market events",
} as const;

type Activity = Extract<ProviderSourceMeasurements["activity"], { state: "available" }>;

function LeaseEvidence({ name, lease }: { name: string; lease: Activity["importLease"] }) {
  const label = lease.state === "active" ? "Valid lease" : lease.state === "expired" ? "Expired lease" : "No lease";
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <IndicatorTooltip label={label} tone={lease.state === "expired" ? "pending" : "neutral"}
          description={lease.state === "active" ? "A database lease is owned and has not expired at measurement time. It does not prove the worker process is alive or making progress."
            : lease.state === "expired" ? "The recorded database lease expired. It is not evidence of an active worker."
              : "No database lease is currently owned. This may be expected between runs or while paused; it does not inspect operating-system processes."} />
        {lease.heartbeatAt ? <span className="provider-pulse__subtext">Heartbeat {dateTime(lease.heartbeatAt)}</span> : null}
        {lease.expiresAt ? <span className="provider-pulse__subtext">Expires {dateTime(lease.expiresAt)}</span> : null}
      </dd>
    </div>
  );
}

function QualityEvidence({ source }: { source: ProviderSourceOperationsSource }) {
  const databaseUnavailable = isDatabaseUnavailable(source);
  return (
    <div className="provider-pulse__indicators">
      <IndicatorTooltip label={`${humanize(source.freshness.state)} freshness`}
        tone={source.freshness.state === "fresh" ? "ready" : source.freshness.state === "stale" ? "danger" : "neutral"}
        description={source.freshness.state === "fresh" ? "The recorded source freshness is within its configured schedule and grace window. This is independent of worker and data-quality state."
          : source.freshness.state === "stale" ? "The source freshness is outside its configured schedule and grace window. This can coexist with a running or intentionally paused processor."
            : "There is not enough source evidence to determine freshness."} />
      <IndicatorTooltip label={databaseUnavailable ? "Quality unavailable" : `${humanize(source.quality.state)} quality`}
        tone={databaseUnavailable ? "neutral" : source.quality.state === "healthy" ? "ready" : source.quality.state === "degraded" ? "danger" : source.quality.state === "warning" ? "pending" : "neutral"}
        description={databaseUnavailable ? "Data quality cannot be assessed while the provider database is unavailable."
          : source.quality.state === "healthy" ? "The source reports healthy quality based on its recorded failures and quarantine evidence. This does not certify every stored record."
          : source.quality.state === "unknown" ? "There is not enough evidence to assess this provider's data quality."
            : "The source reports quality concerns from failure or quarantine evidence. Review the failure code and open quarantine separately from freshness."} />
    </div>
  );
}

export function ProviderPulseDetails(props: SourceOperationControlsProps & { observedAt: string }) {
  const { source, observedAt } = props;
  const { storage, records, activity } = source.measurements;
  const unsupportedSource = isUnsupportedSource(source);
  const databaseUnavailable = isDatabaseUnavailable(source);
  const runtimeUnavailable = unsupportedSource || databaseUnavailable;
  const nextDue = runtimeUnavailable && !source.schedule?.nextDueAt ? "Unavailable"
    : source.schedule ? dateTime(source.schedule.nextDueAt) : "Not scheduled";
  const run = source.activeRun ?? source.latestRun;
  const runScope = source.activeRun ? "Current run" : "Latest run";
  const failure = source.processor?.actionRequiredCode ?? run?.failureCode ?? source.quality.latestFailureCode;
  const requestSettingsUnavailable = sourceRequestSettingsUnavailable(source);
  return (
    <details className="provider-pulse__details">
      <summary>Details<span className="provider-pulse__details-hint">Counts, runs & controls</span></summary>
      <div className="provider-pulse__details-body">
        <QualityEvidence source={source} />
        <section>
          <h3><IndicatorTooltip label="Stored entities" description={metricDescriptions.stored} /></h3>
          <table className="provider-pulse__entity-table">
            <caption className="admin-visually-hidden">{source.displayName} canonical entity counts</caption>
            <thead><tr><th scope="col">Entity</th><th scope="col">Rows</th></tr></thead>
            <tbody>{Object.entries(entityLabels).map(([key, label]) => (
              <tr key={key}><th scope="row">{label}</th><td>{count(storage.state === "available" ? storage.counts[key as keyof typeof entityLabels] : null)}</td></tr>
            ))}</tbody>
          </table>
          <p className="provider-pulse__subtext">{storage.state === "available" ? `Counted ${dateTime(storage.measuredAt)} · ${measuredAge(storage.measuredAt, observedAt)}` : `Counts unavailable: ${humanize(storage.reason).toLowerCase()}.`}</p>
        </section>
        <section>
          <h3>Run & schedule</h3>
          <dl className="provider-pulse__detail-facts">
            <div><dt>Source lifecycle</dt><dd>{source.source ? <IndicatorTooltip label={humanize(source.source.lifecycle)}
              description="Active allows ingestion. Paused retains the cursor without starting another page. Disabled prevents ingestion. Draft has not been activated. Replaced belongs to an older source revision. Lifecycle is separate from the latest run state." /> : unsupportedSource ? "Unavailable" : "Not configured"}</dd></div>
            <div><dt><IndicatorTooltip label="Accepted operations" description="Accepted source operations across all retained runs. They may insert or update existing entities, so this is not a unique entity or stored-row count." /></dt><dd>{count(records.state === "available" ? records.accepted : null)}<span className="provider-pulse__subtext">All retained runs</span></dd></div>
            <div><dt>{runScope}</dt><dd>{run ? <Link to={importRunDetailPath({ providerId: source.providerId, runId: run.id })}>{humanize(run.state)}</Link> : runtimeUnavailable ? "Unavailable" : "Not recorded"}</dd></div>
            <div><dt>{runScope} processed</dt><dd>{run ? count(source.progress.records.total) : "Unavailable"}<span className="provider-pulse__subtext">Source total unknown</span></dd></div>
            <div><dt><IndicatorTooltip label="Average throughput" description="Processed records divided by elapsed time for the displayed current or latest run. This is a run average, not a live rate measured between refreshes." /></dt><dd>{run && source.progress.throughputRecordsPerSecond !== null ? `${source.progress.throughputRecordsPerSecond.toLocaleString("en-US", { maximumFractionDigits: 1 })}/sec` : "Unavailable"}</dd></div>
            <div><dt>Committed pages</dt><dd>{run ? count(source.progress.pages) : "Unavailable"}</dd></div>
            <div><dt>Run elapsed</dt><dd>{run ? age(source.progress.elapsedMilliseconds) : "Unavailable"}</dd></div>
            <div><dt>Last committed page</dt><dd>{activity.state === "available" ? dateTime(activity.lastCommittedPageAt) : "Unavailable"}</dd></div>
            <div><dt>Schedule</dt><dd>{source.schedule ? `Every ${interval(source.schedule.intervalSeconds)}` : runtimeUnavailable ? "Unavailable" : "Not scheduled"}</dd></div>
            <div><dt>Next due</dt><dd>{nextDue}</dd></div>
            <div><dt>Phase / wait</dt><dd>{source.processor && !runtimeUnavailable ? humanize(source.processor.phase) : "Unavailable"}{source.processor?.waitReason && !runtimeUnavailable ? ` / ${humanize(source.processor.waitReason)}` : ""}</dd></div>
            <div><dt>Retries / failures</dt><dd>{source.processor && !runtimeUnavailable ? count(source.processor.retryCount) : "Unavailable"} / {runtimeUnavailable ? "Unavailable" : count(source.quality.consecutiveFailures)}</dd></div>
            {failure ? <div><dt>Failure code</dt><dd><code>{failure}</code></dd></div> : null}
          </dl>
          <p className="provider-pulse__subtext">{records.state === "available" ? `Retained-run totals measured ${dateTime(records.measuredAt)}.` : `Retained-run totals unavailable: ${humanize(records.reason).toLowerCase()}.`}</p>
        </section>
        <section>
          <h3>Worker & quarantine</h3>
          <dl className="provider-pulse__detail-facts">
            {activity.state === "available" ? <>
              <LeaseEvidence name="Import worker" lease={activity.importLease} />
              <LeaseEvidence name="Promotion worker" lease={activity.promotionLease} />
              <div><dt>Quarantine retained</dt><dd>{count(activity.quarantine.retained)}</dd></div>
              <div><dt>Open / resolved / expired</dt><dd>{count(activity.quarantine.open)} / {count(activity.quarantine.resolved)} / {count(activity.quarantine.expired)}</dd></div>
            </> : <div><dt>Worker / quarantine evidence</dt><dd>Unavailable<span className="provider-pulse__subtext">{humanize(activity.reason)}</span></dd></div>}
            <div><dt>{runScope} quarantined</dt><dd>{run ? count(source.progress.dispositions.quarantined) : "Unavailable"}</dd></div>
          </dl>
          {activity.state === "available" ? <>
            <p className="provider-pulse__subtext">Page & quarantine checked <time dateTime={activity.historyMeasuredAt}>{dateTime(activity.historyMeasuredAt)}</time> · cached up to 60s.</p>
            <p className="provider-pulse__subtext">Leases checked <time dateTime={activity.measuredAt}>{dateTime(activity.measuredAt)}</time>. Process liveness is unverified.</p>
          </> : null}
        </section>
        {source.processor?.activity === "action_required" && !databaseUnavailable ? (
          <aside className="admin-note admin-note-warning" role="note">
            <strong>Administrator recovery required.</strong>{" "}
            {source.source?.requestSizePolicy === "schedule_revision"
              ? "Disable this source, correct the cause, run Test source, Activate paused, then Resume."
              : "Review the recorded failure and correct its cause before an authorized recovery. Changing request size does not restart work or clear the failure."}
          </aside>
        ) : null}
        {requestSettingsUnavailable ? (
          <p className="source-config-field-help" role="note">
            Run now requires verified request settings and an authorized worker handoff. No new run can be requested from this page yet.
          </p>
        ) : null}
        <footer className="provider-pulse__actions">
          <nav aria-label={`${source.displayName} data links`}>
            <Link to={source.configured ? `/providers/${source.providerId}` : "/source-configuration"}>{source.configured ? "Provider" : unsupportedSource ? "Source settings" : "Configure source"}</Link>
            <Link to={`/runs?providerId=${source.providerId}`}>Run history</Link>
            <Link to={`/data/canonical?provider=${source.provider}`}>Canonical data</Link>
            <Link to={`/quarantine?providerId=${source.providerId}&state=open`}>Open quarantine</Link>
          </nav>
          <SourceOperationControls {...props} />
        </footer>
      </div>
    </details>
  );
}
