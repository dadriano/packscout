import { formatAge, formatByteSize, formatTimestamp } from "../../format.ts";
import { serviceBadgeVariables } from "../../logs/service-badge.ts";
import type { ServiceLiveness, SourceRailEntry } from "../../logs/source-rail.ts";

/**
 * Which services exist, and which of them is in trouble.
 *
 * The rail is the panel's answer to "where do I look first". Everything on it
 * is either a fact from the filesystem or a count of lines this panel saw, and
 * the error chip is a control rather than an ornament: seeing that the worker
 * has twelve errors is useless if getting to them takes three more clicks.
 *
 * The rate is shown only when it has been measured; a blank is honest, and a
 * confident "0/min" for a service discovered four seconds ago is not.
 */

const LIVENESS_LABEL: Readonly<Record<ServiceLiveness, string>> = Object.freeze({
  writing: "Writing",
  quiet: "Quiet",
  stale: "Stale",
});

const LIVENESS_TITLE: Readonly<Record<ServiceLiveness, string>> = Object.freeze({
  writing: "Wrote to its log within the last few seconds",
  quiet: "Running, but has not written in the last few minutes",
  stale: "Nothing has been written for a long time",
});

export interface LogSourceRailProps {
  entries: readonly SourceRailEntry[];
  now: number;
  onToggleService: (service: string) => void;
  onFocusService: (service: string | null) => void;
  onShowServiceErrors: (service: string) => void;
  logDirectory: string;
}

export function LogSourceRail({
  entries,
  now,
  onToggleService,
  onFocusService,
  onShowServiceErrors,
  logDirectory,
}: LogSourceRailProps) {
  return (
    <aside className="panel-log-rail" aria-label="Services">
      <div className="panel-log-rail-head">
        <h2>Services</h2>
        <button type="button" className="panel-button" onClick={() => onFocusService(null)}>
          All services
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="panel-log-count">
          Nothing is writing to {logDirectory || "the log directory"} yet.
        </p>
      ) : null}

      <ul className="panel-log-rail-list">
        {entries.map((entry) => (
          <li
            key={entry.service}
            className="panel-log-rail-item"
            data-focused={entry.focused ? "yes" : "no"}
            style={serviceBadgeVariables(entry.service)}
          >
            <div className="panel-log-rail-row">
              <label className="panel-log-control">
                <input
                  type="checkbox"
                  checked={entry.visible}
                  onChange={() => onToggleService(entry.service)}
                />
                <span className="panel-log-service">{entry.service}</span>
              </label>

              <span
                className="panel-log-liveness"
                data-liveness={entry.liveness}
                title={LIVENESS_TITLE[entry.liveness]}
              >
                {LIVENESS_LABEL[entry.liveness]}
              </span>

              {entry.recentErrors > 0 ? (
                <button
                  type="button"
                  className="panel-log-error-chip"
                  onClick={() => onShowServiceErrors(entry.service)}
                  title={`Show ${entry.service} errors and warnings`}
                >
                  {entry.recentErrors} {entry.recentErrors === 1 ? "error" : "errors"}
                </button>
              ) : null}
            </div>

            <dl className="panel-log-rail-facts">
              <div>
                <dt>Size</dt>
                <dd>{entry.sizeBytes === null ? "—" : formatByteSize(entry.sizeBytes)}</dd>
              </div>
              <div>
                <dt>Last write</dt>
                <dd title={entry.modifiedAt ? formatTimestamp(entry.modifiedAt) : undefined}>
                  {entry.modifiedAt ? formatAge(entry.modifiedAt, now) : "—"}
                </dd>
              </div>
              <div>
                <dt>Rate</dt>
                <dd title="Lines per minute, measured since the panel attached">
                  {entry.linesPerMinute === null
                    ? "measuring…"
                    : `${entry.linesPerMinute.toLocaleString("en-US")}/min`}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              className="panel-log-focus"
              onClick={() => onFocusService(entry.focused ? null : entry.service)}
            >
              {entry.focused ? "clear focus" : "only"}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
