import type { QuarantineEntrySummary } from "@packscout/contracts";
import { Link } from "react-router-dom";
import { QuarantineStatus, dateTime, humanize } from "./OperationStatus";

interface QuarantineLedgerProps {
  entries: QuarantineEntrySummary[];
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectionChange?: (entryId: string, selected: boolean) => void;
}

export function QuarantineLedger({ entries, selectable, selected, onSelectionChange }: QuarantineLedgerProps) {
  return (
    <section className="ops-ledger" aria-labelledby="quarantine-ledger-title">
      <header className="admin-section-heading">
        <div><span className="admin-eyebrow">Record-scoped recovery</span><h2 id="quarantine-ledger-title">Quarantined records</h2></div>
        <span className="admin-section-count">{String(entries.length).padStart(2, "0")} on page</span>
      </header>
      <div className="ops-ledger__rows">
        {entries.map((entry) => {
          const retryable = entry.state === "open";
          return (
            <article key={entry.id}>
              {selectable ? (
                <label className="ops-ledger__select">
                  <input type="checkbox" disabled={!retryable} checked={selected?.has(entry.id) ?? false} onChange={(event) => onSelectionChange?.(entry.id, event.target.checked)} />
                  <span className="admin-visually-hidden">Select {entry.recordKind} record {entry.externalId ?? entry.recordIndex}</span>
                </label>
              ) : null}
              <div className="ops-ledger__identity">
                <Link to={`/quarantine/${entry.id}`}>{entry.externalId ?? `${humanize(entry.recordKind)} record ${entry.recordIndex + 1}`}</Link>
                <span>{entry.platformKey} · {humanize(entry.recordKind)} · {entry.reasonCode}</span>
              </div>
              <QuarantineStatus state={entry.state} />
              <dl className="ops-ledger__facts">
                <div><dt>Field</dt><dd>{entry.fieldPath ?? "Record-level"}</dd></div>
                <div><dt>Attempts</dt><dd>{entry.attemptCount}</dd></div>
                <div><dt>First failure</dt><dd>{dateTime(entry.firstFailureAt)}</dd></div>
                <div><dt>Latest failure</dt><dd>{dateTime(entry.latestFailureAt)}</dd></div>
                <div><dt>Evidence</dt><dd>{retryable ? `Retained until ${dateTime(entry.rawExpiresAt)}` : "Unavailable for retry"}</dd></div>
                <div><dt>Origin run</dt><dd><Link to={`/runs/${entry.runId}`}>Open run</Link></dd></div>
              </dl>
              <p className="ops-ledger__diagnostic">{entry.sanitizedSummary}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
