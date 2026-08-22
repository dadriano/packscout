import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { getImportRun, type ImportRunDetail, type ImportRunState } from "../api/import-operations";
import { EmptyState } from "../components/EmptyState";
import { QuarantineStatus, RunStatus, dateTime, duration, humanize } from "../components/operations/OperationStatus";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

function stateGuidance(state: ImportRunState): string {
  if (state === "queued") return "Waiting for a worker. Another run cannot start for this provider.";
  if (state === "running") return "Import in progress. Only committed page progress is shown.";
  if (state === "succeeded") return "The import reached its terminal outcome. Historical counts are immutable.";
  if (state === "incomplete") return "Progress was saved, but the feed did not finish. Recovery starts a separate run.";
  return "The import stopped and cannot retry automatically. Review the bounded failure guidance.";
}

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const [run, setRun] = useState<ImportRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [refreshIndex, setRefreshIndex] = useState(0);
  const priorState = useRef<ImportRunState | null>(null);
  useDocumentTitle(run ? `${run.providerName} Run` : "Import Run");

  useEffect(() => {
    let active = true;
    void getImportRun(runId)
      .then(({ run: nextRun }) => {
        if (!active) return;
        if (priorState.current && priorState.current !== nextRun.state) {
          setAnnouncement(`Import state changed to ${humanize(nextRun.state)}.`);
        }
        priorState.current = nextRun.state;
        setRun(nextRun);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof AdminApiError && reason.status === 404
          ? "Import run not found."
          : reason instanceof AdminApiError && reason.status === 403
            ? "Your role no longer permits access to this run."
            : reason instanceof AdminApiError && reason.status === 429
              ? "Too many operation requests. Live refresh is paused; wait before trying again."
              : "Run evidence is temporarily unavailable. Prior safe results remain visible.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshIndex, runId]);

  useEffect(() => {
    if (run?.state !== "queued" && run?.state !== "running") return;
    const poll = () => {
      if (document.visibilityState === "visible") setRefreshIndex((value) => value + 1);
    };
    const intervalId = window.setInterval(poll, 5_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [run?.state]);

  if (loading && !run) return <div className="ops-loading" aria-busy="true">Loading durable run evidence…</div>;
  if (!run) {
    return <div className="ops-error" role="alert"><p>{error ?? "Import run not found."}</p><Link className="admin-button admin-button--secondary" to="/runs">Return to runs</Link></div>;
  }

  const recordTotal = run.counters.catalog + run.counters.pulls + run.counters.trades;
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow={`Import run / ${run.platformKey}`}
        title={run.providerName}
        description={`Revision ${run.configurationVersion} · ${humanize(run.trigger)} · Requested ${dateTime(run.requestedAt)}`}
        actions={<><Link className="admin-button admin-button--secondary" to={`/providers/${run.providerId}`}>Provider</Link><Link className="admin-button admin-button--secondary" to={`/runs?providerId=${run.providerId}`}>Run history</Link></>}
      />
      <p className="admin-visually-hidden" aria-live="polite">{announcement}</p>
      {error ? <div className="ops-error" role="alert"><p>{error}</p><button type="button" className="admin-button admin-button--secondary" onClick={() => { setLoading(true); setRefreshIndex((value) => value + 1); }}>Refresh</button></div> : null}

      <section className="ops-run-lead" aria-labelledby="run-state-title">
        <div><span className="admin-eyebrow">Immutable outcome</span><h2 id="run-state-title">{humanize(run.state)}</h2><p>{stateGuidance(run.state)}</p></div>
        <RunStatus state={run.state} />
      </section>

      <section className="ops-metrics" aria-label="Run metrics">
        <div><span>Pages committed</span><strong>{run.counters.pages}</strong></div>
        <div><span>Records seen</span><strong>{recordTotal}</strong><small>{run.counters.catalog} catalog · {run.counters.pulls} pulls · {run.counters.trades} trades</small></div>
        <div><span>Accepted</span><strong>{run.counters.accepted}</strong><small>{run.counters.unchanged} unchanged · {run.counters.revised} revised</small></div>
        <div><span>Quarantined then / now</span><strong>{run.counters.quarantined} / {Math.max(0, run.counters.quarantined - run.counters.resolvedQuarantines)}</strong><small>{run.counters.resolvedQuarantines} resolved separately</small></div>
      </section>

      {run.failure ? (
        <section className="ops-diagnostic" aria-labelledby="run-failure-title">
          <span className="admin-eyebrow">Bounded failure</span>
          <h2 id="run-failure-title">{humanize(run.failure.class)}</h2>
          <p>{run.failure.summary}</p>
          <code>{run.failure.code}</code>
        </section>
      ) : null}

      <div className="ops-detail-grid">
        <section className="ops-detail" aria-labelledby="run-timing-title">
          <header><span className="admin-eyebrow">Lifecycle</span><h2 id="run-timing-title">Timing and cursor</h2></header>
          <dl>
            <div><dt>Requested</dt><dd>{dateTime(run.requestedAt)}</dd></div>
            <div><dt>Started</dt><dd>{dateTime(run.startedAt)}</dd></div>
            <div><dt>Last progress</dt><dd>{dateTime(run.lastProgressAt)}</dd></div>
            <div><dt>Finished</dt><dd>{dateTime(run.finishedAt)}</dd></div>
            <div><dt>Duration</dt><dd>{duration(run.startedAt, run.finishedAt)}</dd></div>
            <div><dt>Provider head</dt><dd>{run.reachedProviderHead ? "Reached" : "Not reached"}</dd></div>
            <div><dt>Starting cursor</dt><dd className="ops-cursor">{run.cursor.requestedPreview ?? "Feed start"}</dd></div>
            <div><dt>Final cursor</dt><dd className="ops-cursor">{run.cursor.finalPreview ?? "Not committed"}</dd></div>
          </dl>
        </section>
        <section className="ops-detail" aria-labelledby="run-timeline-title">
          <header><span className="admin-eyebrow">State transitions</span><h2 id="run-timeline-title">Timeline</h2></header>
          <ol className="ops-timeline">
            {run.timeline.map((event, index) => <li key={`${event.occurredAt}-${index}`}><RunStatus state={event.state} /><div><strong>{event.summary}</strong><span>{dateTime(event.occurredAt)}</span></div></li>)}
          </ol>
        </section>
      </div>

      <section className="ops-pages" aria-labelledby="run-pages-title">
        <header className="admin-section-heading"><div><span className="admin-eyebrow">Durable page commits</span><h2 id="run-pages-title">Page progress</h2></div><span className="admin-section-count">{run.pages.length} shown</span></header>
        {run.pages.length === 0 ? <EmptyState title="No pages committed" description="A queued run or a failure before the first durable commit has no page progress." /> : <div>{run.pages.map((page) => <article key={page.pageNumber}><strong>Page {page.pageNumber}</strong><span>{dateTime(page.committedAt)}</span><dl><div><dt>Records</dt><dd>{page.catalog} catalog · {page.pulls} pulls · {page.trades} trades</dd></div><div><dt>Outcomes</dt><dd>{page.accepted} accepted · {page.unchanged} unchanged · {page.revised} revised · {page.quarantined} quarantined</dd></div><div><dt>Cursor in</dt><dd className="ops-cursor">{page.requestedCursorPreview ?? "Feed start"}</dd></div><div><dt>Cursor out</dt><dd className="ops-cursor">{page.nextCursorPreview ?? "Provider head"}</dd></div></dl></article>)}</div>}
      </section>

      <section className="ops-related" aria-labelledby="run-quarantine-title">
        <header className="admin-section-heading"><div><span className="admin-eyebrow">Current quality resolution</span><h2 id="run-quarantine-title">Related quarantine</h2></div><Link to={`/quarantine?runId=${run.id}`}>View all for run</Link></header>
        {run.relatedQuarantines.length === 0 ? <p>No records from this run need review.</p> : <ul>{run.relatedQuarantines.map((entry) => <li key={entry.id}><Link to={`/quarantine/${entry.id}`}>{entry.externalId ?? `${humanize(entry.recordKind)} record ${entry.recordIndex + 1}`}</Link><QuarantineStatus state={entry.state} /><span>{entry.reasonCode}</span></li>)}</ul>}
      </section>
    </div>
  );
}
