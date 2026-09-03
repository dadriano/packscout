import { PanelPageHeader } from "../components/PanelShell.tsx";
import { formatAge, formatByteSize, formatTimestamp } from "../format.ts";
import { useLogSources } from "../hooks/useLogSources.ts";

export function LogSourcesPage() {
  const { status, live, sources, logDirectory, pollIntervalMs, error, reload } =
    useLogSources();

  return (
    <>
      <PanelPageHeader
        eyebrow="Logs"
        title="Log sources"
        description="Every PackScout service writing a per-service log file on this machine. The list updates as files appear, change, or disappear."
      />

      <div className="panel-toolbar">
        <span
          className="panel-status"
          data-tone={live ? "live" : "idle"}
          aria-live="polite"
        >
          {live ? "Live updates connected" : "Live updates reconnecting"}
        </span>
        <button type="button" className="panel-button" onClick={reload}>
          Refresh now
        </button>
      </div>

      <ul className="panel-meta">
        <li>
          Directory: <code>{logDirectory || "resolving…"}</code>
        </li>
        <li>Poll interval: {pollIntervalMs ? `${pollIntervalMs} ms` : "—"}</li>
        <li>Discovered services: {sources.length}</li>
      </ul>

      {error ? (
        <p className="panel-notice" role="alert">
          {error}
        </p>
      ) : null}

      {status === "loading" ? <p>Reading the log directory…</p> : null}

      {status !== "loading" && sources.length === 0 ? (
        <div className="panel-empty-state">
          <h2>No service logs yet</h2>
          <p>
            Start a PackScout service through its logged local command, or through
            the supervised restart workflow. Each service writes{" "}
            <span className="panel-mono">&lt;service&gt;.log</span> into the
            directory above, and it appears here without restarting the panel.
          </p>
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="panel-table-scroll">
          <table>
            <caption>Discovered service log files</caption>
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">File</th>
                <th scope="col">Size</th>
                <th scope="col">Last write</th>
                <th scope="col">Identity</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.service}>
                  <th scope="row">{source.service}</th>
                  <td className="panel-mono">{source.fileName}</td>
                  <td>{formatByteSize(source.sizeBytes)}</td>
                  <td>
                    <span title={formatTimestamp(source.modifiedAt)}>
                      {formatAge(source.modifiedAt)}
                    </span>
                  </td>
                  <td className="panel-mono">{source.fileId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
