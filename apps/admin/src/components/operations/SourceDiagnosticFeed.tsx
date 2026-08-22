import type {
  ProviderSourceDiagnosticFilter,
  ProviderSourceDiagnosticHistory,
  ProviderSourceOperationsDetail,
} from "@packscout/contracts";
import { Link } from "react-router-dom";
import { EmptyState } from "../EmptyState";
import { StatusBadge, type StatusTone } from "../StatusBadge";
import { dateTime, humanize } from "./OperationStatus";

function severityTone(severity: "info" | "warning" | "critical"): StatusTone {
  return severity === "critical" ? "danger" : severity === "warning" ? "pending" : "neutral";
}

function milliseconds(value: number | null): string {
  if (value === null) return "Not recorded";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(1)} s`;
}

function eventKey(
  event: ProviderSourceDiagnosticHistory["events"][number],
  pageIndex: number,
  eventIndex: number,
): string {
  return [pageIndex, eventIndex, event.occurredAt, event.scope, event.eventKind, event.safeCode].join(":");
}

export function SourceDiagnosticFeed({
  pages,
  filter,
  runs,
  loading,
  loadingOlder,
  error,
  onFilterChange,
  onLoadOlder,
  onRetry,
}: {
  pages: readonly ProviderSourceDiagnosticHistory[];
  filter: ProviderSourceDiagnosticFilter;
  runs: ProviderSourceOperationsDetail["runHistory"];
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  onFilterChange: (filter: ProviderSourceDiagnosticFilter) => void;
  onLoadOlder: () => void;
  onRetry: () => void;
}) {
  const newest = pages[0] ?? null;
  const lastPage = pages.at(-1) ?? null;
  const eventCount = pages.reduce((total, page) => total + page.events.length, 0);
  const hasFilter = Boolean(filter.severity || filter.phase || filter.runId);
  return (
    <section className="source-diagnostics" aria-labelledby="source-diagnostics-title">
      <header className="admin-section-heading">
        <div>
          <span className="admin-eyebrow">Bounded safe history · newest first</span>
          <h2 id="source-diagnostics-title">Processor diagnostics</h2>
        </div>
        <span className="admin-section-count">{eventCount} shown</span>
      </header>

      <div className="source-diagnostic-filters" aria-label="Diagnostic filters">
        <div className="admin-field">
          <label htmlFor="diagnostic-severity">Severity</label>
          <select
            id="diagnostic-severity"
            value={filter.severity ?? ""}
            onChange={(event) => onFilterChange({
              ...filter,
              severity: event.target.value
                ? event.target.value as NonNullable<ProviderSourceDiagnosticFilter["severity"]>
                : undefined,
            })}
          >
            <option value="">All severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="diagnostic-phase">Phase</label>
          <select
            id="diagnostic-phase"
            value={filter.phase ?? ""}
            onChange={(event) => onFilterChange({
              ...filter,
              phase: event.target.value || undefined,
            })}
          >
            <option value="">All phases</option>
            {(newest?.availablePhases ?? []).map((phase) => (
              <option key={phase} value={phase}>{humanize(phase)}</option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="diagnostic-run">Run</label>
          <select
            id="diagnostic-run"
            value={filter.runId ?? ""}
            onChange={(event) => onFilterChange({
              ...filter,
              runId: event.target.value || undefined,
            })}
          >
            <option value="">All source context</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {humanize(run.trigger)} · {humanize(run.state)} · {run.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="admin-button admin-button--secondary"
          disabled={!hasFilter}
          onClick={() => onFilterChange({})}
        >
          Clear filters
        </button>
      </div>

      {newest?.filter.contextEventsHidden ? (
        <p className="source-diagnostic-context-note" role="status">
          Run filter active: only matching run and page events are shown. Lifecycle, test, and shared connection context is hidden until the run filter is cleared.
        </p>
      ) : null}
      {error ? (
        <div className="ops-error" role="alert">
          <p>{error} Previously loaded safe diagnostics remain visible.</p>
          <button type="button" className="admin-button admin-button--secondary" onClick={onRetry}>
            Retry diagnostics
          </button>
        </div>
      ) : null}
      {loading && pages.length === 0 ? (
        <div className="ops-loading" aria-busy="true" aria-live="polite">
          Loading bounded diagnostic history…
        </div>
      ) : null}

      {pages.map((page, pageIndex) => (
        <div className="source-diagnostic-page" key={`diagnostic-page-${pageIndex}`}>
          {page.history.state === "expired" ? (
            <div className="source-history-gap" role="status">
              <strong>History gap</strong>
              <p>{page.history.message}</p>
            </div>
          ) : null}
          {page.events.map((event, eventIndex) => (
            <article
              className={`source-diagnostic-event is-${event.scope} is-${event.severity}`}
              key={eventKey(event, pageIndex, eventIndex)}
            >
              <div className="source-diagnostic-event__marker" aria-hidden="true" />
              <header>
                <div>
                  <span>{event.scopeLabel}</span>
                  <h3>{humanize(event.eventKind)}</h3>
                </div>
                <div>
                  <StatusBadge label={humanize(event.severity)} tone={severityTone(event.severity)} />
                  <StatusBadge label={humanize(event.phase)} tone="neutral" />
                </div>
              </header>
              <div className="source-diagnostic-event__code">
                <code>{event.safeCode}</code>
                <time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time>
              </div>
              <dl>
                <div><dt>Duration</dt><dd>{milliseconds(event.durationMilliseconds)}</dd></div>
                <div><dt>Response</dt><dd>{event.responseBytes === null ? "Not recorded" : `${event.responseBytes.toLocaleString()} bytes`}</dd></div>
                <div><dt>Retry delay</dt><dd>{milliseconds(event.retryDelayMilliseconds)}</dd></div>
                <div><dt>Continuation</dt><dd>{event.continuation ? humanize(event.continuation.kind) : "None"}</dd></div>
                <div><dt>Checkpoint</dt><dd className="ops-cursor">{event.checkpointFingerprint ?? "Not attached"}</dd></div>
                <div><dt>Counters</dt><dd>{Object.entries(event.counters).length === 0 ? "None" : Object.entries(event.counters).map(([key, value]) => `${humanize(key)} ${value}`).join(" · ")}</dd></div>
              </dl>
              {event.references.length > 0 ? (
                <footer>
                  {event.references.map((reference) => (
                    <Link key={`${reference.kind}:${reference.href}`} to={reference.href}>
                      {reference.label}
                    </Link>
                  ))}
                </footer>
              ) : null}
            </article>
          ))}
        </div>
      ))}

      {!loading && !error && eventCount === 0 && !pages.some((page) => page.history.state === "expired") ? (
        <EmptyState
          eyebrow={hasFilter ? "No filter matches" : "No processor events"}
          title={hasFilter ? "No diagnostics match these filters" : "No diagnostics have been retained"}
          description={hasFilter
            ? "Clear or adjust the bounded severity, phase, and run filters."
            : "Current processor state remains available above. Events will appear after lifecycle, run, test, or page activity."}
        />
      ) : null}
      {lastPage?.nextCursor ? (
        <div className="source-diagnostic-pagination">
          <button
            type="button"
            className="admin-button admin-button--secondary"
            disabled={loadingOlder}
            onClick={onLoadOlder}
          >
            {loadingOlder ? "Loading older…" : "Load older events"}
          </button>
          <span>Bounded keyset history · no raw log download</span>
        </div>
      ) : null}
    </section>
  );
}
