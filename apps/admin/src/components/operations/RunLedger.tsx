import { Link } from "react-router-dom";
import type { ImportRunSummary } from "../../api/import-operations";
import { RunStatus, dateTime, duration, humanize } from "./OperationStatus";

export function RunLedger({ runs }: { runs: ImportRunSummary[] }) {
  return (
    <section className="ops-ledger" aria-labelledby="run-ledger-title">
      <header className="admin-section-header">
        <div><span className="admin-kicker">Immutable run history</span><h2 id="run-ledger-title">Import attempts</h2></div>
        <span className="admin-section-count">{String(runs.length).padStart(2, "0")} on page</span>
      </header>
      <div className="ops-ledger__rows">
        {runs.map((run) => (
          <article key={run.id}>
            <div className="ops-ledger__identity">
              <Link to={`/runs/${run.id}`}>{run.providerName}</Link>
              <span>{run.platformKey} · Revision {run.configurationVersion} · {humanize(run.trigger)}</span>
            </div>
            <RunStatus state={run.state} />
            <dl className="ops-ledger__facts">
              <div><dt>Started</dt><dd>{dateTime(run.startedAt ?? run.requestedAt)}</dd></div>
              <div><dt>Progress</dt><dd>{run.counters.pages} pages · {run.counters.catalog + run.counters.pulls + run.counters.sales} records</dd></div>
              <div><dt>Outcomes</dt><dd>{run.counters.accepted} accepted · {run.counters.unchanged} unchanged · {run.counters.revised} revised</dd></div>
              <div><dt>Quarantine</dt><dd>{run.counters.quarantined} created · {run.counters.resolvedQuarantines} now resolved</dd></div>
              <div><dt>Duration</dt><dd>{duration(run.startedAt, run.finishedAt)}</dd></div>
              <div><dt>Provider head</dt><dd>{run.reachedProviderHead ? "Reached" : "Not reached"}</dd></div>
            </dl>
            {run.failure ? <p className="ops-ledger__diagnostic"><strong>{humanize(run.failure.class)}:</strong> {run.failure.summary}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
