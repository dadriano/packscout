import { useEffect, useState } from "react";
import {
  isQuarantineReasonRetryable,
  type QuarantineEntryDetail,
  type QuarantineRetryOutcome,
} from "@packscout/contracts";
import { Link, useParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { getQuarantineEntry, retryQuarantine } from "../api/import-operations";
import { QuarantineStatus, dateTime, humanize } from "../components/operations/OperationStatus";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useToast } from "../providers/toast";

function outcomeMessage(outcome: QuarantineRetryOutcome["outcome"]): string {
  if (outcome === "resolved") return "The record was accepted and current quality resolution was updated.";
  if (outcome === "failed") return "The retry finished, but the record still needs review.";
  if (outcome === "non_retryable") return "This source identity or facts conflict cannot be retried; review the provider data manually.";
  if (outcome === "already_retrying") return "A retry is already in progress for this record.";
  if (outcome === "already_resolved") return "This record was already resolved. No duplicate retry was created.";
  if (outcome === "expired") return "Source evidence expired; this record cannot be retried.";
  return "The quarantine entry no longer exists in this workspace.";
}

export function QuarantineDetailPage() {
  const { quarantineId = "" } = useParams();
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const [entry, setEntry] = useState<QuarantineEntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<QuarantineRetryOutcome | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  useDocumentTitle(entry ? `${humanize(entry.recordKind)} Quarantine` : "Quarantine Entry");

  useEffect(() => {
    let active = true;
    void getQuarantineEntry(quarantineId)
      .then((result) => {
        if (!active) return;
        setEntry(result.entry);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof AdminApiError && reason.status === 404
          ? "Quarantine entry not found."
          : reason instanceof AdminApiError && reason.status === 403
            ? "Your role no longer permits quarantine access."
            : reason instanceof AdminApiError && reason.status === 429
              ? "Too many operation requests. Wait before refreshing this record."
              : "Quarantine evidence is temporarily unavailable.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [quarantineId, refreshIndex]);

  async function retry() {
    if (!entry) return;
    await confirm({
      title: `Retry ${humanize(entry.recordKind).toLowerCase()} record?`,
      description: `${entry.reasonCode}. This retry uses retained evidence for this record only; it does not rewind the provider cursor or change run ${entry.runId.slice(0, 8)}'s historical outcome.`,
      confirmLabel: "Retry record",
      action: async () => {
        const result = await retryQuarantine(entry.id);
        setOutcome(result.outcome);
        if (result.outcome.entry) setEntry((current) => current ? { ...current, ...result.outcome.entry } : current);
        const message = outcomeMessage(result.outcome.outcome);
        showToast(message, result.outcome.outcome === "resolved" || result.outcome.outcome === "already_resolved" ? "success" : "error");
      },
    });
  }

  if (loading && !entry) return <div className="ops-loading" aria-busy="true">Loading safe quarantine evidence…</div>;
  if (!entry) return <div className="ops-error" role="alert"><p>{error ?? "Quarantine entry not found."}</p><Link className="admin-button admin-button--secondary" to="/quarantine">Return to quarantine</Link></div>;

  const sourceConflict = !isQuarantineReasonRetryable(entry.reasonCode);
  const retryable = entry.state === "open" && !sourceConflict;
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow={`Quarantine / ${entry.platformKey}`}
        title={entry.externalId ?? `${humanize(entry.recordKind)} record ${entry.recordIndex + 1}`}
        description={`${entry.reasonCode} · ${entry.fieldPath ?? "Record-level failure"}`}
        actions={<><Link className="admin-button admin-button--secondary" to={`/runs/${entry.runId}`}>Origin run</Link>{retryable ? <button type="button" className="admin-button admin-button--primary" onClick={() => void retry()}>Retry record</button> : null}</>}
      />
      {error ? <div className="ops-error" role="alert"><p>{error}</p><button type="button" className="admin-button admin-button--secondary" onClick={() => { setLoading(true); setRefreshIndex((value) => value + 1); }}>Try again</button></div> : null}
      {outcome ? <section className={`ops-retry-result${outcome.outcome === "failed" || outcome.outcome === "expired" || outcome.outcome === "non_retryable" ? " is-failure" : ""}`} aria-live={outcome.outcome === "failed" || outcome.outcome === "non_retryable" ? "assertive" : "polite"}><strong>{humanize(outcome.outcome)}</strong><p>{outcomeMessage(outcome.outcome)}</p></section> : null}

      <section className="ops-run-lead" aria-labelledby="quarantine-state-title">
        <div><span className="admin-eyebrow">Current quality state</span><h2 id="quarantine-state-title">{humanize(entry.state)}</h2><p>{entry.state === "resolved" ? entry.resolutionSummary ?? "The record is resolved." : entry.state === "expired" ? "Source evidence expired; this record cannot be retried. Expired does not mean corrected." : sourceConflict ? "This source identity or event facts conflict with protected data already stored. Retry is disabled; review the provider data manually." : entry.sanitizedSummary}</p></div>
        <QuarantineStatus state={entry.state} />
      </section>

      <div className="ops-detail-grid">
        <section className="ops-detail" aria-labelledby="quarantine-evidence-title">
          <header><span className="admin-eyebrow">Sanitized evidence</span><h2 id="quarantine-evidence-title">Record context</h2></header>
          <dl>
            <div><dt>Platform</dt><dd>{entry.platformKey}</dd></div>
            <div><dt>Record kind</dt><dd>{humanize(entry.recordKind)}</dd></div>
            <div><dt>Source identity</dt><dd>{entry.externalId ?? `Index ${entry.recordIndex}`}</dd></div>
            <div><dt>Reason</dt><dd>{entry.reasonCode}</dd></div>
            <div><dt>Field path</dt><dd>{entry.fieldPath ?? "Record-level"}</dd></div>
            <div><dt>Safe summary</dt><dd>{entry.sanitizedSummary}</dd></div>
          </dl>
        </section>
        <section className="ops-detail" aria-labelledby="quarantine-lifetime-title">
          <header><span className="admin-eyebrow">Evidence lifetime</span><h2 id="quarantine-lifetime-title">Retry availability</h2></header>
          <dl>
            <div><dt>First failure</dt><dd>{dateTime(entry.firstFailureAt)}</dd></div>
            <div><dt>Latest failure</dt><dd>{dateTime(entry.latestFailureAt)}</dd></div>
            <div><dt>Evidence expires</dt><dd>{dateTime(entry.rawExpiresAt)}</dd></div>
            <div><dt>Retry</dt><dd>{sourceConflict ? "Disabled for source conflicts" : retryable ? "Available" : "Unavailable"}</dd></div>
            <div><dt>Attempts</dt><dd>{entry.attemptCount}</dd></div>
            <div><dt>Resolved</dt><dd>{dateTime(entry.resolvedAt)}</dd></div>
            <div><dt>Origin run</dt><dd><Link to={`/runs/${entry.runId}`}>{entry.runId.slice(0, 12)}</Link></dd></div>
          </dl>
        </section>
      </div>

      <section className="ops-attempts" aria-labelledby="retry-history-title">
        <header className="admin-section-heading"><div><span className="admin-eyebrow">Independent attempts</span><h2 id="retry-history-title">Retry history</h2></div><span className="admin-section-count">{entry.attempts.length} attempts</span></header>
        {entry.attempts.length === 0 ? <p>No retry attempts have been recorded.</p> : <ol>{entry.attempts.map((attempt) => <li key={attempt.id}><span>{dateTime(attempt.startedAt)}</span><strong>{humanize(attempt.state)}</strong><p>{attempt.sanitizedSummary ?? (attempt.state === "running" ? "Retry in progress." : "No additional diagnostic summary.")}</p>{attempt.failureCode ? <code>{attempt.failureCode}</code> : null}{attempt.canonicalRevisionCount !== null ? <small>{attempt.canonicalRevisionCount} canonical revisions written</small> : null}</li>)}</ol>}
      </section>
    </div>
  );
}
