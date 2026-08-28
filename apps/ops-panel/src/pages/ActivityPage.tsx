import { PanelPageHeader } from "../components/PanelShell.tsx";
import { formatAge, formatTimestamp } from "../format.ts";
import { useActivity } from "../hooks/useActivity.ts";

export function ActivityPage() {
  const { status, payload, error, reload } = useActivity();
  const entries = payload?.entries ?? [];

  return (
    <>
      <PanelPageHeader
        eyebrow="Audit"
        title="Recent privileged activity"
        description="Every privileged attempt the panel handled — succeeded, failed, or rejected at the guard. The trail is bounded and survives a panel restart."
      />

      <div className="panel-toolbar">
        <button type="button" className="panel-button" onClick={reload}>
          Refresh
        </button>
        <span className="panel-status">
          {payload ? `${payload.total} of ${payload.capacity} kept` : "—"}
        </span>
      </div>

      {error ? (
        <p className="panel-notice" role="alert">
          {error}
        </p>
      ) : null}

      {status === "loading" ? <p>Reading the activity trail…</p> : null}

      {status !== "loading" && entries.length === 0 ? (
        <div className="panel-empty-state">
          <h2>No privileged activity yet</h2>
          <p>
            Mutations and raw log downloads are recorded here as soon as the panel
            handles one, including attempts the origin guard rejects.
          </p>
        </div>
      ) : null}

      {entries.length > 0 ? (
        <div className="panel-table-scroll">
          <table>
            <caption>Newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Outcome</th>
                <th scope="col">Action</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <span title={formatTimestamp(entry.recordedAt)}>
                      {formatAge(entry.recordedAt)}
                    </span>
                  </td>
                  <td>
                    <span className="panel-status" data-tone={entry.outcome}>
                      {entry.outcome}
                    </span>
                  </td>
                  <td className="panel-mono">{entry.action}</td>
                  <td>{entry.reason ?? entry.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
