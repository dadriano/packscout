import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ProviderLifecycleState } from "@packscout/contracts";
import { AdminApiError } from "../api/client";
import { listProviders, type ProviderAdminListItem } from "../api/providers";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { ProviderLedger } from "../components/providers/ProviderLedger";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSession } from "../providers/session";

function message(error: unknown): string {
  return error instanceof AdminApiError
    ? error.message
    : "Provider operations are temporarily unavailable. No configuration was changed.";
}

export function ProvidersPage() {
  useDocumentTitle("Data Providers");
  const { status } = useSession();
  const canManage = status.phase === "authenticated" && status.session.permissions.includes("providers:manage");
  const [items, setItems] = useState<ProviderAdminListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [state, setState] = useState<ProviderLifecycleState | "">("");

  useEffect(() => {
    let active = true;
    void listProviders()
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(message(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [retry]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter(({ provider }) =>
      (!state || provider.state === state) &&
      (!query || `${provider.displayName} ${provider.platformKey} ${provider.latestRevision.adapterKey}`.toLowerCase().includes(query)),
    );
  }, [items, search, state]);

  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Data pipeline / Providers"
        title="Data providers"
        description="Configure each source, verify its connection, and monitor whether imports are current and healthy."
        actions={canManage ? <Link className="admin-button admin-button-primary" to="/providers/new">Add provider</Link> : undefined}
      />

      {!canManage ? (
        <aside className="provider-read-only-note">
          <strong>Read-only access</strong>
          <p>You can inspect masked settings and health. Provider configuration and lifecycle controls require administrator access.</p>
        </aside>
      ) : null}

      <section className="provider-filters" aria-label="Filter providers">
        <div className="admin-field">
          <label htmlFor="provider-search">Search providers</label>
          <input id="provider-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, platform, or adapter" />
        </div>
        <div className="admin-field">
          <label htmlFor="provider-state-filter">Lifecycle state</label>
          <select id="provider-state-filter" value={state} onChange={(event) => setState(event.target.value as ProviderLifecycleState | "")}>
            <option value="">All states</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </section>

      {loading ? <div className="provider-loading" aria-live="polite" aria-busy="true">Loading provider health…</div> : null}
      {error ? (
        <div className="provider-load-error" role="alert">
          <p>{error}</p>
          <button className="admin-button admin-button-secondary" type="button" onClick={() => { setLoading(true); setRetry((value) => value + 1); }}>Try again</button>
        </div>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <EmptyState title="No data providers yet" description="Create a draft provider to define the first source. It will not run until an administrator tests and enables it." action={canManage ? <Link className="admin-button admin-button-primary" to="/providers/new">Create provider</Link> : undefined} />
      ) : null}
      {!loading && !error && items.length > 0 && visible.length === 0 ? (
        <EmptyState title="No providers match" description="Clear or change the filters to return to the provider ledger." />
      ) : null}
      {!loading && !error && visible.length > 0 ? <ProviderLedger items={visible} /> : null}
    </div>
  );
}
