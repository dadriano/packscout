import type {
  ProviderSourceOperationsConnection,
  ProviderSourceOperationsSource,
} from "@packscout/contracts";
import { Link } from "react-router-dom";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { dateTime, humanize, interval } from "./OperationStatus";

export type SourceOperationCommand = "run" | "pause" | "resume";

function elapsed(milliseconds: number): string {
  if (milliseconds === 0) return "Not started";
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusTone(label: string): StatusTone {
  if (["Running", "Reached head", "Fresh", "Healthy", "Active"].includes(label)) {
    return "ready";
  }
  if ([
    "Failed",
    "Action required",
    "Connection transition uncertain",
    "No live worker",
    "Stale",
  ].includes(label)) return "danger";
  if ([
    "Queued",
    "Retrying",
    "Pause requested",
    "Waiting for capacity",
    "Waiting on connection recovery",
    "Reconnecting",
  ].includes(label)) return "pending";
  return "neutral";
}

export function sourceOperationalLabel(
  source: ProviderSourceOperationsSource,
): string {
  if (!source.configured) return "Not configured";
  if (source.connectionImpact.state === "uncertain") {
    return "Connection transition uncertain";
  }
  if (source.connectionImpact.state === "reconnecting") {
    return "Waiting on connection recovery";
  }
  if (source.source?.pauseRequested) return "Pause requested";
  if (!source.processor) return "No live worker";
  if (source.processor.retryCount > 0 && source.processor.activity !== "inactive") {
    return "Retrying";
  }
  if (source.processor.activity === "queued") return "Queued";
  if (source.processor.activity === "running") return "Running";
  if (source.processor.activity === "paused") return "Paused";
  if (source.processor.activity === "action_required") return "Action required";
  if (
    source.processor.waitReason === "profile_capacity" ||
    source.processor.waitReason === "execution_capacity" ||
    source.processor.waitReason === "capacity_blocked"
  ) return "Waiting for capacity";
  if (source.processor.waitReason === "connection_blocked") {
    return "Waiting on connection recovery";
  }
  if (source.latestRun?.state === "failed") return "Failed";
  if (source.processor.phase === "reached_head") return "Reached head";
  return source.processor.activity === "waiting" ? "Waiting" : "Idle";
}

export function ConnectionOperationsSummary({
  connection,
}: {
  connection: ProviderSourceOperationsConnection | null;
}) {
  if (!connection) {
    return (
      <section className="source-connection-band is-empty" aria-labelledby="connection-title">
        <div>
          <span className="admin-kicker">Shared connection</span>
          <h2 id="connection-title">Not configured</h2>
          <p>Add the registered source connection before activating a processor.</p>
        </div>
        <Link className="admin-button admin-button-secondary" to="/source-configuration">
          Configure connection
        </Link>
      </section>
    );
  }
  const healthLabel = connection.health.state === "reconnecting"
    ? "Reconnecting"
    : humanize(connection.health.state);
  return (
    <section className={`source-connection-band is-${connection.health.state}`} aria-labelledby="connection-title">
      <header>
        <div>
          <span className="admin-kicker">Shared connection · {connection.sourceType.label}</span>
          <h2 id="connection-title">{connection.displayName}</h2>
          <p>{connection.endpointHost} · Credential {connection.credential.mask} configured</p>
        </div>
        <div className="source-connection-band__badges">
          <StatusBadge label={healthLabel} tone={statusTone(healthLabel)} />
          <StatusBadge label={`Supervisor ${humanize(connection.supervisor.state)}`}
            tone={connection.supervisor.state === "active" ? "ready" : "danger"} />
        </div>
      </header>
      <dl className="source-connection-band__facts">
        <div><dt>Connection test</dt><dd>{humanize(connection.test.state)} · {dateTime(connection.test.testedAt ?? connection.test.requestedAt)}</dd></div>
        <div><dt>Health generation</dt><dd>{connection.health.generation}{connection.health.blocking ? ` · ${connection.health.blocking.safeCode}` : " · clear"}</dd></div>
        <div><dt>Supervisor renewal</dt><dd>{dateTime(connection.supervisor.lastRenewedAt)}</dd></div>
        <div><dt>Execution slots</dt><dd>{connection.capacity.executionSlots.used} / {connection.capacity.executionSlots.maximum}<progress aria-label="Execution slots used" value={connection.capacity.executionSlots.used} max={connection.capacity.executionSlots.maximum} /></dd></div>
        <div><dt>Request permits</dt><dd>{connection.capacity.requestPermits.used} / {connection.capacity.requestPermits.maximum}<progress aria-label="Request permits used" value={connection.capacity.requestPermits.used} max={connection.capacity.requestPermits.maximum} /></dd></div>
        <div><dt>Capacity queue</dt><dd>{connection.capacity.requestPermits.waiting} waiting · {humanize(connection.capacity.state)}</dd></div>
      </dl>
      {connection.health.blocking ? (
        <p className="source-connection-band__impact" role="status">
          Shared connection impact began {dateTime(connection.health.blocking.openedAt)}. Each processor retains its own cursor, lifecycle, and quality evidence.
        </p>
      ) : null}
    </section>
  );
}

export function ProviderSourceOperationsLedger({
  sources,
  canOperate,
  pendingKey,
  onCommand,
}: {
  sources: readonly ProviderSourceOperationsSource[];
  canOperate: boolean;
  pendingKey: string | null;
  onCommand: (
    source: ProviderSourceOperationsSource,
    command: SourceOperationCommand,
  ) => void;
}) {
  return (
    <section className="source-lanes" aria-labelledby="source-lanes-title">
      <header className="admin-section-header">
        <div><span className="admin-kicker">Independent processor lanes</span><h2 className="admin-section-title" id="source-lanes-title">Platform processors</h2></div>
        <span className="admin-section-count">{sources.length.toString().padStart(2, "0")} registered</span>
      </header>
      <div className="source-lanes__list">
        {sources.map((source) => {
          const operational = sourceOperationalLabel(source);
          const isPending = pendingKey?.startsWith(`${source.providerId}:`) ?? false;
          const actionRequired = source.processor?.activity === "action_required";
          const runLabel = actionRequired
            ? "Resolve before run"
            : source.latestRun?.state === "failed"
              ? "Retry source"
              : "Run now";
          return (
            <article key={source.providerId} className={`source-lane is-${source.processor?.activity ?? "unconfigured"}`}>
              <div className="source-lane__rail" aria-hidden="true"><span /></div>
              <header className="source-lane__header">
                <div>
                  <Link to={source.configured ? `/providers/${source.providerId}` : "/source-configuration"}>{source.displayName}</Link>
                  <p>{source.source ? `${source.source.sourceTypeKey} · adapter ${source.source.sourceAdapterVersion} · mapper ${source.source.mapperVersion}` : "Awaiting source configuration"}</p>
                </div>
                <div className="source-lane__badges">
                  <StatusBadge label={operational} tone={statusTone(operational)} />
                  <StatusBadge label={humanize(source.freshness.state)} tone={statusTone(humanize(source.freshness.state))} />
                  <StatusBadge label={`${humanize(source.quality.state)} quality`} tone={source.quality.state === "healthy" ? "ready" : source.quality.state === "unknown" ? "neutral" : source.quality.state === "warning" ? "pending" : "danger"} />
                </div>
              </header>
              {source.connectionImpact.state !== "none" ? (
                <p className="source-lane__connection" role="status">
                  Shared connection: {humanize(source.connectionImpact.state)}{source.connectionImpact.safeCode ? ` · ${source.connectionImpact.safeCode}` : ""}. Local evidence below is preserved.
                </p>
              ) : null}
              <dl className="source-lane__facts">
                <div><dt>Lifecycle / phase</dt><dd>{source.source ? humanize(source.source.lifecycle) : "Not configured"} / {source.processor ? humanize(source.processor.phase) : "No worker state"}</dd></div>
                <div><dt>Continuation / wait</dt><dd>{source.processor?.continuation ? humanize(source.processor.continuation.kind) : "Not established"} / {source.processor?.waitReason ? humanize(source.processor.waitReason) : "None"}</dd></div>
                <div><dt>Schedule / next due</dt><dd>{source.schedule ? `${interval(source.schedule.intervalSeconds)} / ${dateTime(source.schedule.nextDueAt)}` : "Not scheduled"}</dd></div>
                <div><dt>Progress / head</dt><dd>{dateTime(source.freshness.lastProgressAt)} / {dateTime(source.freshness.lastHeadReachedAt)}</dd></div>
                <div><dt>Pages / records</dt><dd>{source.progress.pages} / {source.progress.records.total} · {source.progress.total.label}</dd></div>
                <div><dt>Streams</dt><dd>{source.progress.records.catalog} catalog · {source.progress.records.pulls} pulls · {source.progress.records.trades} trades</dd></div>
                <div><dt>Dispositions</dt><dd>{source.progress.dispositions.inserted} inserted · {source.progress.dispositions.revised} revised · {source.progress.dispositions.duplicate} duplicate · {source.progress.dispositions.quarantined} quarantined</dd></div>
                <div><dt>Throughput / elapsed</dt><dd>{source.progress.throughputRecordsPerSecond === null ? "Not available" : `${source.progress.throughputRecordsPerSecond}/s`} / {elapsed(source.progress.elapsedMilliseconds)}</dd></div>
                <div><dt>Retry / quarantine</dt><dd>{source.processor?.retryCount ?? 0} retries · {source.progress.openQuarantine} open</dd></div>
                <div><dt>Run / lease age</dt><dd>{source.activeRun ? <Link to={`/runs/${source.activeRun.id}`}>{humanize(source.activeRun.state)}</Link> : "No active run"} / {source.processor?.runLeaseAgeMilliseconds === null || source.processor?.runLeaseAgeMilliseconds === undefined ? "No lease" : elapsed(source.processor.runLeaseAgeMilliseconds)}</dd></div>
              </dl>
              {actionRequired ? (
                <aside className="admin-note admin-note-warning source-recovery-guidance" role="note">
                  <strong>Administrator recovery required.</strong>{" "}
                  Disable this source, correct the reported cause, run Test source while disabled, Activate paused, then Resume. Run now and Resume cannot clear Action required.
                </aside>
              ) : null}
              <footer className="source-lane__actions">
                {source.configured ? <Link to={`/providers/${source.providerId}`}>Diagnostics</Link> : <Link to="/source-configuration">Configure source</Link>}
                <Link to={`/runs?providerId=${source.providerId}`}>Run history</Link>
                {source.progress.openQuarantine > 0 ? <Link to={`/quarantine?providerId=${source.providerId}&state=open`}>Quarantine</Link> : null}
                {canOperate && source.source ? (
                  <div>
                    <button type="button" className="admin-button admin-button-secondary" disabled={isPending || source.source.lifecycle !== "active" || actionRequired} onClick={() => onCommand(source, "run")}>{isPending ? "Working…" : runLabel}</button>
                    {source.source.lifecycle === "active" ? <button type="button" className="admin-button admin-button-secondary" disabled={isPending || source.source.pauseRequested} onClick={() => onCommand(source, "pause")}>Pause</button> : null}
                    {source.source.lifecycle === "paused" || source.source.pauseRequested ? <button type="button" className="admin-button admin-button-primary" disabled={isPending || actionRequired} onClick={() => onCommand(source, "resume")}>Resume</button> : null}
                  </div>
                ) : null}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
