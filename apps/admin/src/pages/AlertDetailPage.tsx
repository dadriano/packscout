import { useEffect, useState } from "react";
import type { AdminAlertDetail, AdminAlertSummary } from "@packscout/contracts";
import { Link, useParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import {
  acknowledgeOperationalAlert,
  getOperationalAlert,
  resolveOperationalAlert,
} from "../api/operational-alerts";
import {
  AlertSeverity,
  AlertState,
} from "../components/operations/AlertStatus";
import { dateTime, humanize } from "../components/operations/OperationStatus";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useToast } from "../providers/toast";

function evidenceEntries(evidence: AdminAlertDetail["occurrences"][number]["evidence"]) {
  return Object.entries(evidence).filter((entry): entry is [string, string | number] =>
    typeof entry[1] === "string" || typeof entry[1] === "number",
  );
}

interface AlertTarget {
  readonly href: string;
  readonly label: string;
}

/**
 * Machinery conditions are about the pipeline itself, so they carry no
 * provider, run, or quarantine to open. Their kind names the monitoring view
 * that shows the same condition in context.
 */
const machineryTargets: Partial<Record<AdminAlertSummary["kind"], AlertTarget>> = {
  worker_fleet_silent: { href: "/workers", label: "Review worker fleet" },
  recomputation_backlogged: {
    href: "/background-work",
    label: "Review background work",
  },
  retention_overdue: {
    href: "/background-work",
    label: "Review retention runs",
  },
};

function alertTarget(alert: AdminAlertSummary): AlertTarget | null {
  if (alert.quarantineId) {
    return { href: `/quarantine/${alert.quarantineId}`, label: "Review quarantine" };
  }
  if (alert.runId) return { href: `/runs/${alert.runId}`, label: "Review import run" };
  if (alert.providerId) {
    return { href: `/providers/${alert.providerId}`, label: "Review provider" };
  }
  return machineryTargets[alert.kind] ?? null;
}

export function AlertDetailPage() {
  const { alertId = "" } = useParams();
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const [alert, setAlert] = useState<AdminAlertDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);
  useDocumentTitle(alert?.title ?? "Operational Alert");

  useEffect(() => {
    let active = true;
    void getOperationalAlert(alertId)
      .then(({ alert: nextAlert }) => {
        if (!active) return;
        setAlert(nextAlert);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof AdminApiError && reason.status === 404
            ? "Operational alert not found."
            : reason instanceof AdminApiError && reason.status === 403
              ? "Your role no longer permits access to this alert."
              : "Alert evidence is temporarily unavailable.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [alertId, refreshIndex]);

  function mergeSummary(summary: AdminAlertSummary) {
    setAlert((current) => current ? { ...current, ...summary } : current);
  }

  async function acknowledge() {
    try {
      const result = await acknowledgeOperationalAlert(alertId);
      mergeSummary(result.alert);
      showToast("Alert acknowledged.", "success");
    } catch {
      showToast("The alert could not be acknowledged. Try again.", "error");
    }
  }

  async function resolve() {
    await confirm({
      title: "Resolve this operational alert?",
      description: "This closes the grouped condition without deleting its occurrence history. New matching evidence can reopen it.",
      confirmLabel: "Resolve alert",
      action: async () => {
        const result = await resolveOperationalAlert(alertId);
        mergeSummary(result.alert);
        showToast("Alert resolved. Its history remains available.", "success");
      },
    });
  }

  if (loading && !alert) return <div className="ops-loading" aria-busy="true">Loading alert evidence…</div>;
  if (!alert) {
    return <div className="ops-error" role="alert"><p>{error ?? "Operational alert not found."}</p><Link className="admin-button admin-button-secondary" to="/alerts">Return to alerts</Link></div>;
  }

  const target = alertTarget(alert);

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow={`Operational alert / ${humanize(alert.kind)}`}
        title={alert.title}
        description={alert.summary}
        actions={
          <>
            {target ? <Link className="admin-button admin-button-secondary" to={target.href}>{target.label}</Link> : null}
            {alert.state === "active" ? <button type="button" className="admin-button admin-button-secondary" onClick={() => void acknowledge()}>Acknowledge</button> : null}
            {alert.state !== "resolved" ? <button type="button" className="admin-button admin-button-primary" onClick={() => void resolve()}>Resolve alert</button> : null}
          </>
        }
      />
      {error ? <div className="ops-error" role="alert"><p>{error}</p><button type="button" className="admin-button admin-button-secondary" onClick={() => { setLoading(true); setRefreshIndex((value) => value + 1); }}>Refresh</button></div> : null}
      <section className="alerts-summary" aria-labelledby="alert-state-heading">
        <div><span className="admin-kicker">Current condition</span><h2 id="alert-state-heading">{humanize(alert.state)}</h2></div>
        <div className="alerts-summary__badges"><AlertSeverity severity={alert.severity} /><AlertState state={alert.state} /></div>
        <dl>
          <div><dt>First seen</dt><dd>{dateTime(alert.firstSeenAt)}</dd></div>
          <div><dt>Last seen</dt><dd>{dateTime(alert.lastSeenAt)}</dd></div>
          <div><dt>Occurrences</dt><dd>{alert.occurrenceCount}</dd></div>
          <div><dt>Reopened</dt><dd>{alert.reopenedCount}</dd></div>
          <div><dt>Acknowledged</dt><dd>{dateTime(alert.acknowledgedAt)}</dd></div>
          <div><dt>Resolved</dt><dd>{dateTime(alert.resolvedAt)}</dd></div>
        </dl>
      </section>
      <section className="alerts-occurrences" aria-labelledby="alert-occurrences-heading">
        <header className="admin-section-header"><div><span className="admin-kicker">Safe evidence</span><h2 id="alert-occurrences-heading">Occurrence history</h2></div><span className="admin-section-count">{alert.occurrences.length} shown</span></header>
        <ol>
          {alert.occurrences.map((occurrence) => (
            <li key={occurrence.id}>
              <div><AlertSeverity severity={occurrence.severity} /><strong>{humanize(occurrence.kind)}</strong><time dateTime={occurrence.occurredAt}>{dateTime(occurrence.occurredAt)}</time></div>
              {evidenceEntries(occurrence.evidence).length > 0 ? (
                <dl>{evidenceEntries(occurrence.evidence).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{value}</dd></div>)}</dl>
              ) : <p>No additional bounded evidence was recorded.</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
