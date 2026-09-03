import { Link } from "react-router-dom";
import { importRunDetailPath, type StalledRunView } from "@packscout/contracts";
import { age, dateTime, humanize } from "../operations/OperationStatus";

function attribution(run: StalledRunView): string {
  if (run.leaseOwner === null) {
    return "No worker instance holds this run's lease, so nothing is advancing it.";
  }
  return run.leaseOwnerPresent
    ? `Held by ${run.leaseOwner}, which is still a known instance.`
    : `Held by ${run.leaseOwner}, which no longer has a presence record.`;
}

export function StalledRunLedger({ runs }: { runs: StalledRunView[] }) {
  return (
    <section className="ops-ledger" aria-labelledby="stalled-run-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Runs past their heartbeat window</span>
          <h2 id="stalled-run-title">Stalled import runs</h2>
        </div>
        <span className="admin-section-count">
          {String(runs.length).padStart(2, "0")} on page
        </span>
      </header>
      <div className="ops-ledger__rows">
        {runs.map((run) => (
          <article key={run.runId}>
            <div className="ops-ledger__identity">
              <Link to={importRunDetailPath({ providerId: run.providerId, runId: run.runId })}>{run.providerName}</Link>
              <span>
                {run.platformKey} · {humanize(run.trigger)} ·{" "}
                {run.runId.slice(0, 8)}
              </span>
            </div>
            <dl className="ops-ledger__facts">
              <div>
                <dt>Heartbeat age</dt>
                <dd>{age(run.stall.heartbeatAgeMs)}</dd>
              </div>
              <div>
                <dt>Stale after</dt>
                <dd>{age(run.stall.staleAfterMs)}</dd>
              </div>
              <div>
                <dt>Past the window by</dt>
                <dd>{age(run.stall.overdueByMs)}</dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{dateTime(run.startedAt)}</dd>
              </div>
              <div>
                <dt>Last heartbeat</dt>
                <dd>{dateTime(run.lastHeartbeatAt)}</dd>
              </div>
              <div>
                <dt>Owning instance</dt>
                <dd>{run.leaseOwner ?? "Unclaimed"}</dd>
              </div>
              <div>
                <dt>Lease expires</dt>
                <dd>{dateTime(run.leaseExpiresAt)}</dd>
              </div>
            </dl>
            <p className="ops-ledger__links">
              <Link to={importRunDetailPath({ providerId: run.providerId, runId: run.runId })}>Open run detail</Link>
              <Link to={`/providers/${run.providerId}`}>Open provider</Link>
            </p>
            <p className="ops-ledger__diagnostic">
              {attribution(run)}
              {run.leaseExpired
                ? " Its lease has also expired, so recovery can restart the work."
                : ""}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
