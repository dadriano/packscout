import { useEffect, useRef } from "react";
import type {
  OperationOutputLine,
  OperationRunSnapshot,
} from "../../api/panel-types.ts";
import { readOperationPane } from "../../database/operation-presentation.ts";

/**
 * The operation pane: what the running — or most recent — operation printed.
 *
 * Three behaviours are deliberate. Colour codes arrive stripped, because a pane
 * that printed raw escapes would be unreadable and one that dropped them at
 * render time would disagree with what a copy produced. It follows the tail
 * while a run is in flight, because the interesting line is always the last one.
 * And it cannot be closed while a run is going, because hiding live output is
 * how an operator ends up believing a migration finished.
 */
export function OperationPane({
  run,
  output,
  onClose,
}: {
  run: OperationRunSnapshot | null;
  output: readonly OperationOutputLine[];
  onClose: () => void;
}) {
  const reading = readOperationPane(run);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!reading.running) return;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output, reading.running]);

  if (!reading.present) return null;

  return (
    <section className="panel-card" aria-labelledby="database-operation-pane-heading">
      <div className="panel-card-header">
        <h2 id="database-operation-pane-heading">{reading.title}</h2>
        <span className="panel-status" data-tone={reading.tone}>
          {reading.label}
        </span>
      </div>

      {reading.message ? (
        <p
          className="panel-notice"
          data-tone={reading.tone === "danger" ? "danger" : "warning"}
          role={reading.tone === "danger" ? "alert" : "status"}
        >
          {reading.message}
        </p>
      ) : null}

      {reading.notices.map((notice) => (
        <p key={notice} className="panel-notice" data-tone="warning" role="alert">
          {notice}
        </p>
      ))}

      <div
        className="panel-operation-output"
        ref={viewport}
        role="log"
        aria-live={reading.running ? "polite" : "off"}
        aria-label="Operation output"
        tabIndex={0}
      >
        {output.length === 0 ? (
          <p className="panel-log-empty">
            {reading.running
              ? "Waiting for the first line of output…"
              : "This operation produced no output."}
          </p>
        ) : (
          output.map((line) => (
            <p key={line.index} className="panel-operation-line">
              {line.text === "" ? " " : line.text}
            </p>
          ))
        )}
      </div>

      <div className="panel-toolbar">
        <button
          type="button"
          className="panel-button"
          disabled={!reading.closable}
          onClick={onClose}
        >
          Close
        </button>
        {reading.running ? (
          <span className="panel-card-note">
            The pane stays open until the operation finishes.
          </span>
        ) : null}
      </div>
    </section>
  );
}
