import { formatByteSize, formatClockTime } from "../../format.ts";
import type { LogLineRecord } from "../../api/panel-types.ts";
import { stripAnsi } from "../../logs/ansi.ts";
import type { SearchOutcome, SearchProgress } from "../../logs/history-search.ts";
import { serviceBadgeVariables } from "../../logs/service-badge.ts";

/**
 * Searching what is no longer in the buffer.
 *
 * The panel holds a bounded number of lines; a question about yesterday is a
 * question about the file. This region runs the filter that is already on
 * screen across that file, so there is no second query language to learn and no
 * way for the two to disagree about what matches.
 *
 * While it runs it says what it has read and what it has found, and it can be
 * stopped. When it finishes it says *why* it finished — "no matches" and "no
 * matches in the last 24 MB" are different answers, and only one of them is
 * true of a capped scan.
 */

export interface LogSearchPanelProps {
  filterActive: boolean;
  services: readonly string[];
  running: boolean;
  progress: SearchProgress;
  outcome: SearchOutcome | null;
  onStart: () => void;
  onCancel: () => void;
  onClear: () => void;
  onOpenMatch: (line: LogLineRecord) => void;
}

function scopeLabel(services: readonly string[]): string {
  if (services.length === 0) return "no services are visible";
  if (services.length === 1) return services[0] ?? "";
  return `${services.length} services`;
}

export function LogSearchPanel({
  filterActive,
  services,
  running,
  progress,
  outcome,
  onStart,
  onCancel,
  onClear,
  onOpenMatch,
}: LogSearchPanelProps) {
  return (
    <section className="panel-log-search-history" aria-label="Search log history">
      <div className="panel-log-toolbar-row">
        <button
          type="button"
          className="panel-button"
          onClick={onStart}
          disabled={running || !filterActive || services.length === 0}
          title={
            filterActive
              ? `Scan ${scopeLabel(services)} backwards for the current filter`
              : "Add a filter term or narrow the severity first"
          }
        >
          Search history
        </button>

        {running ? (
          <button type="button" className="panel-button" onClick={onCancel}>
            Cancel
          </button>
        ) : null}

        {outcome && !running ? (
          <button type="button" className="panel-button" onClick={onClear}>
            Clear results
          </button>
        ) : null}

        <span className="panel-log-count" role="status">
          {running
            ? `Scanned ${formatByteSize(progress.bytesScanned)}${
                progress.service ? ` · ${progress.service}` : ""
              } · ${progress.matches.toLocaleString("en-US")} ${
                progress.matches === 1 ? "match" : "matches"
              }`
            : filterActive
              ? `Ready to scan ${scopeLabel(services)}.`
              : "Add a filter term or a severity to search for."}
        </span>
      </div>

      {outcome ? (
        <>
          <p className="panel-log-search-note" role="status">
            {outcome.note}
          </p>
          {outcome.matches.length > 0 ? (
            <ol className="panel-log-search-results">
              {outcome.matches.map((line) => (
                <li key={line.id}>
                  <button
                    type="button"
                    className="panel-log-search-result"
                    onClick={() => onOpenMatch(line)}
                    style={serviceBadgeVariables(line.service)}
                    title="Open this line with its surrounding, unfiltered context"
                  >
                    <span className="panel-log-service">{line.service}</span>
                    <span className="panel-log-time">
                      {formatClockTime(line.observedAt)}
                    </span>
                    <span className="panel-log-text">{stripAnsi(line.text)}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
