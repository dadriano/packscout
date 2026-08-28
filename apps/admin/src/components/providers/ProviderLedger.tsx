import { Link } from "react-router-dom";
import type { ProviderSourceRootSummary } from "@packscout/contracts";
import { StatusBadge, type StatusTone } from "../StatusBadge";

interface ProviderLedgerProps {
  items: ProviderSourceRootSummary[];
}

function dateTime(value: string): string {
  return new Date(value).toLocaleString();
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
        {items.map((provider, index) => (
          <article key={provider.id}>
            <span className="provider-ledger__index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="provider-ledger__identity">
              <Link to={`/providers/${provider.id}`}>{provider.displayName}</Link>
              <span>{provider.platformKey}</span>
            </div>
            <div className="provider-ledger__status">
              <StatusBadge
                label={label(provider.state)}
                tone={tone(provider.state)}
              />
            </div>
            <dl className="provider-ledger__facts">
              <div><dt>Created</dt><dd>{dateTime(provider.createdAt)}</dd></div>
              <div><dt>Updated</dt><dd>{dateTime(provider.updatedAt)}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
