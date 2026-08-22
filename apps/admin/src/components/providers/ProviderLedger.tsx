import { Link } from "react-router-dom";
import type { ProviderAdminListItem } from "../../api/providers";
import { StatusBadge, type StatusTone } from "../StatusBadge";

interface ProviderLedgerProps {
  items: ProviderAdminListItem[];
}

function duration(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function tone(value: string): StatusTone {
  if (["active", "fresh", "healthy", "succeeded", "success"].includes(value)) {
    return "ready";
  }
  if (["draft", "warning", "queued", "running"].includes(value)) return "pending";
  if (["disabled", "stale", "degraded", "failed"].includes(value)) return "danger";
  return "neutral";
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function ProviderLedger({ items }: ProviderLedgerProps) {
  return (
    <section className="provider-ledger" aria-labelledby="providers-ledger-title">
      <header className="admin-section-header">
        <div>
          <span className="admin-kicker">Provider ledger</span>
          <h2 id="providers-ledger-title">Configured data sources</h2>
        </div>
        <span className="admin-section-count">
          {String(items.length).padStart(2, "0")} providers
        </span>
      </header>
      <div className="provider-ledger__rows">
        {items.map(({ provider, health }, index) => {
          const test = provider.latestRevision.lastConnectionTest;
          return (
            <article key={provider.id}>
              <span className="provider-ledger__index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="provider-ledger__identity">
                <Link to={`/providers/${provider.id}`}>{provider.displayName}</Link>
                <span>{provider.platformKey} / {provider.latestRevision.adapterKey}</span>
              </div>
              <div className="provider-ledger__status">
                <StatusBadge label={label(provider.state)} tone={tone(provider.state)} />
                <StatusBadge label={label(health.freshnessState)} tone={tone(health.freshnessState)} />
                <StatusBadge label={label(health.qualityState)} tone={tone(health.qualityState)} />
              </div>
              <dl className="provider-ledger__facts">
                <div><dt>Authentication</dt><dd>{provider.latestRevision.authMode === "bearer" ? (provider.latestRevision.hasBearerSecret ? "Bearer · configured" : "Bearer · missing") : "None"}</dd></div>
                <div><dt>Schedule / stale</dt><dd>{duration(provider.latestRevision.scheduleSeconds)} / {duration(provider.latestRevision.staleAfterSeconds)}</dd></div>
                <div><dt>Connection test</dt><dd>{test ? `${label(test.verdict)} · ${dateTime(test.checkedAt)}` : "Not tested"}</dd></div>
                <div><dt>Run state</dt><dd>{health.activeRun ? label(health.activeRun.state) : health.latestRun ? `Last ${label(health.latestRun.state)}` : "No runs"}</dd></div>
                <div><dt>Last provider head</dt><dd>{dateTime(health.lastHeadReachedAt)}</dd></div>
                <div><dt>Next due</dt><dd>{dateTime(health.nextDueAt)}</dd></div>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}
