import type { DatabaseStatusPayload } from "../../api/panel-types.ts";
import { readRowBrowser } from "../../database/status-presentation.ts";

/**
 * The embedded row browser: the ORM's own studio, run as a supervised child and
 * framed here.
 *
 * It is labelled for what it is. Inside that frame there is no locality gate, no
 * origin guard, and no audit trail — it is a full read/write editor on the live
 * database, and the banner says so every time it is open.
 */
export function RowBrowserCard({
  status,
  pending,
  onStart,
  onStop,
}: {
  status: DatabaseStatusPayload;
  pending: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const reading = readRowBrowser(status.rowBrowser);
  const timeoutSeconds = Math.round(status.rowBrowser.startupTimeoutMs / 1_000);

  return (
    <section className="panel-card" aria-labelledby="database-row-browser-heading">
      <div className="panel-card-header">
        <h2 id="database-row-browser-heading">Row browser</h2>
        <span className="panel-status" data-tone={reading.tone}>
          {reading.label}
        </span>
      </div>

      <p className="panel-card-headline">
        Browse and edit rows with the ORM&rsquo;s own studio, started here as a
        supervised child process bound to loopback.
      </p>

      <div className="panel-toolbar">
        <button
          type="button"
          className="panel-button"
          onClick={onStart}
          disabled={!reading.canStart || pending}
        >
          Start row browser
        </button>
        <button
          type="button"
          className="panel-button"
          onClick={onStop}
          disabled={!reading.canStop || pending}
        >
          Stop
        </button>
        {reading.embedUrl ? (
          <a
            className="panel-button"
            href={reading.embedUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open in a new tab
          </a>
        ) : null}
      </div>

      {reading.message ? (
        <p
          className="panel-notice"
          data-tone={reading.tone === "danger" ? "danger" : "warning"}
          role={reading.tone === "danger" ? "alert" : undefined}
        >
          {reading.message}
        </p>
      ) : null}

      {status.rowBrowser.phase === "starting" ? (
        <p className="panel-card-detail" role="status">
          Starting the row browser… the panel gives it {timeoutSeconds}s to report
          readiness before stopping it.
        </p>
      ) : null}

      {reading.embedUrl ? (
        <div className="panel-embed">
          <p className="panel-embed-warning" role="note">
            <strong>Full read/write editor.</strong> Everything inside this frame
            writes straight to the live database. None of the panel&rsquo;s
            guardrails apply in there: no confirmation, no audit entry, and no
            undo.
          </p>
          <iframe
            className="panel-embed-frame"
            title="Database row browser"
            src={reading.embedUrl}
          />
          <p className="panel-card-note">
            The child listens on {reading.embedUrl}, a loopback address the panel
            verified before embedding it. If the frame stays blank, open it in a
            new tab.
          </p>
        </div>
      ) : null}
    </section>
  );
}
