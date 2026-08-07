import { Link } from "react-router-dom";
import type { ProviderOperationSummary } from "../../api/import-operations";
import { HealthStatus, RunStatus, dateTime, humanize, interval } from "./OperationStatus";

export function ProviderOperationsLedger({ providers }: { providers: ProviderOperationSummary[] }) {
  return (
    <section className="ops-ledger" aria-labelledby="provider-operations-title">
      <header className="admin-section-heading">
        <div><span className="admin-eyebrow">Operational status</span><h2 id="provider-operations-title">Provider feeds</h2></div>
        <span className="admin-section-count">{String(providers.length).padStart(2, "0")} on page</span>
      </header>
      <div className="ops-ledger__rows">
        {providers.map((provider) => (
          <article key={provider.providerId}>
            <div className="ops-ledger__identity">
              <Link to={`/providers/${provider.providerId}`}>{provider.displayName}</Link>
              <span>{provider.platformKey} · Revision {provider.configurationVersion} · {humanize(provider.lifecycleState)}</span>
            </div>
            <div className="ops-ledger__badges">
              <HealthStatus value={provider.freshnessState} />
              <HealthStatus value={provider.qualityState} />
              {provider.activeRun ? <RunStatus state={provider.activeRun.state} /> : null}
            </div>
            <dl className="ops-ledger__facts">
              <div><dt>Schedule / stale</dt><dd>{interval(provider.scheduleSeconds)} / {interval(provider.staleAfterSeconds)}</dd></div>
              <div><dt>Next due</dt><dd>{dateTime(provider.nextDueAt)}</dd></div>
              <div><dt>Last attempt</dt><dd>{dateTime(provider.lastAttemptedAt)}</dd></div>
              <div><dt>Last provider head</dt><dd>{dateTime(provider.lastHeadReachedAt)}</dd></div>
              <div><dt>Open quarantine</dt><dd>{provider.openQuarantineCount}</dd></div>
              <div><dt>Consecutive failures</dt><dd>{provider.consecutiveFailures}</dd></div>
            </dl>
            <div className="ops-ledger__links">
              {provider.activeRun ? <Link to={`/runs/${provider.activeRun.id}`}>Open active run</Link> : provider.latestRun ? <Link to={`/runs/${provider.latestRun.id}`}>Open latest run</Link> : <span>No run history</span>}
              <Link to={`/runs?providerId=${provider.providerId}`}>All runs</Link>
              {provider.openQuarantineCount > 0 ? <Link to={`/quarantine?providerId=${provider.providerId}&state=open`}>Review quarantine</Link> : null}
            </div>
            <p className="ops-ledger__diagnostic">
              {provider.recoveredAt ? `Freshness recovered ${dateTime(provider.recoveredAt)}. ` : ""}
              {provider.recoveryHint}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
