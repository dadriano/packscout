import { useEffect, useState, type FormEvent } from "react";
import type { AdminAlertState, AdminAlertSummary } from "@packscout/contracts";
import { Link, useSearchParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { listOperationalAlerts } from "../api/operational-alerts";
import { EmptyState } from "../components/EmptyState";
import {
  AlertSeverity,
  AlertState,
} from "../components/operations/AlertStatus";
import { dateTime } from "../components/operations/OperationStatus";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function AlertsPage() {
  useDocumentTitle("Operational Alerts");
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState(searchParams.get("state") ?? "");
  const [alerts, setAlerts] = useState<AdminAlertSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryIndex, setRetryIndex] = useState(0);
  const stateFilter = (searchParams.get("state") || undefined) as
    | AdminAlertState
    | undefined;

  useEffect(() => {
    let active = true;
    void listOperationalAlerts({ state: stateFilter, limit: 100 })
      .then(({ items }) => {
        if (!active) return;
        setAlerts(items);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(
          reason instanceof AdminApiError && reason.status === 403
            ? "Your role no longer permits operational alert access."
            : "Operational alerts are temporarily unavailable. Prior safe results remain visible.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [retryIndex, stateFilter]);

  function applyFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setSearchParams(state ? { state } : {});
  }

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Data pipeline / Attention"
        title="Operational alerts"
        description="Conditions that need attention, grouped so a repeating problem counts once."
      />
      <form className="alerts-filter" aria-label="Filter operational alerts" onSubmit={applyFilter}>
        <div className="admin-field">
          <label htmlFor="alert-state">State</label>
          <select id="alert-state" value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">All states</option>
            <option value="active">Active</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <button type="submit" className="admin-button admin-button-secondary">Apply filter</button>
      </form>
      {loading ? <div className="ops-loading" aria-live="polite" aria-busy="true">Loading operational alerts…</div> : null}
      {error ? (
        <div className="ops-error" role="alert">
          <p>{error}</p>
          <button type="button" className="admin-button admin-button-secondary" onClick={() => { setLoading(true); setRetryIndex((value) => value + 1); }}>Try again</button>
        </div>
      ) : null}
      {!loading && !error && alerts.length === 0 ? (
        <EmptyState
          title={stateFilter ? "No alerts match this state" : "No active alerts"}
          description={stateFilter ? "Choose another state to review operational history." : "The pipeline has no grouped conditions that need attention."}
        />
      ) : null}
      {alerts.length > 0 ? (
        <div className="alerts-ledger" role="region" aria-label="Operational alert history" tabIndex={0}>
          <table>
            <thead><tr><th>Severity</th><th>Condition</th><th>State</th><th>Last seen</th><th>Count</th></tr></thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id}>
                  <td><AlertSeverity severity={alert.severity} /></td>
                  <td><Link to={`/alerts/${alert.id}`}>{alert.title}</Link><span>{alert.summary}</span></td>
                  <td><AlertState state={alert.state} /></td>
                  <td>{dateTime(alert.lastSeenAt)}</td>
                  <td>{alert.occurrenceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
