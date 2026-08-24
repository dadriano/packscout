import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import {
  listImportRuns,
  type ImportRunState,
  type ImportRunSummary,
  type ImportRunTrigger,
} from "../api/import-operations";
import { getProviderSourceOperationsOverview } from "../api/provider-source-operations";
import { EmptyState } from "../components/EmptyState";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { RunLedger } from "../components/operations/RunLedger";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function RunsPage() {
  useDocumentTitle("Import Runs");
  const [searchParams, setSearchParams] = useSearchParams();
  const [runs, setRuns] = useState<ImportRunSummary[]>([]);
  const [providers, setProviders] = useState<Array<{
    providerId: string;
    displayName: string;
  }>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryIndex, setRetryIndex] = useState(0);
  const [providerId, setProviderId] = useState(searchParams.get("providerId") ?? "");
  const [state, setState] = useState(searchParams.get("state") ?? "");
  const [trigger, setTrigger] = useState(searchParams.get("trigger") ?? "");
  const cursor = searchParams.get("cursor") ?? undefined;

  useEffect(() => {
    let active = true;
    void getProviderSourceOperationsOverview().then((result) => {
      if (active) setProviders(result.sources.map(({ providerId, displayName }) => ({
        providerId,
        displayName,
      })));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void listImportRuns({
      providerId: searchParams.get("providerId") || undefined,
      state: (searchParams.get("state") || undefined) as ImportRunState | undefined,
      trigger: (searchParams.get("trigger") || undefined) as ImportRunTrigger | undefined,
      cursor,
      limit: 25,
    })
      .then((result) => {
        if (!active) return;
        setRuns(result.items);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof AdminApiError && reason.status === 403
          ? "Your role no longer permits import history access."
          : reason instanceof AdminApiError && reason.status === 429
            ? "Too many operation requests. Wait before refreshing import history."
            : "Import history is temporarily unavailable. Prior safe results remain visible.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cursor, retryIndex, searchParams]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (providerId) next.set("providerId", providerId);
    if (state) next.set("state", state);
    if (trigger) next.set("trigger", trigger);
    setCursorStack([]);
    setLoading(true);
    setSearchParams(next);
  }

  const filtersActive = Boolean(searchParams.get("providerId") || searchParams.get("state") || searchParams.get("trigger"));
  return (
    <div className="admin-page">
      <PageHeader eyebrow="Data pipeline / Runs" title="Import runs" description="Inspect immutable import outcomes, durable page progress, and the current resolution state of related quarantines." />
      <form className="ops-filters" aria-label="Filter import runs" onSubmit={applyFilters}>
        <div className="admin-field"><label htmlFor="runs-provider">Provider</label><select id="runs-provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">All providers</option>{providers.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}</select></div>
        <div className="admin-field"><label htmlFor="runs-state">State</label><select id="runs-state" value={state} onChange={(event) => setState(event.target.value)}><option value="">All states</option><option value="queued">Queued</option><option value="running">Running</option><option value="succeeded">Succeeded</option><option value="incomplete">Incomplete</option><option value="failed">Failed</option></select></div>
        <div className="admin-field"><label htmlFor="runs-trigger">Trigger</label><select id="runs-trigger" value={trigger} onChange={(event) => setTrigger(event.target.value)}><option value="">All triggers</option><option value="scheduled">Scheduled</option><option value="manual">Manual</option><option value="continuation">Continuation</option><option value="recovery">Recovery</option></select></div>
        <button type="submit" className="admin-button admin-button-secondary">Apply filters</button>
        {filtersActive ? <button type="button" className="admin-button admin-button-secondary" onClick={() => { setProviderId(""); setState(""); setTrigger(""); setCursorStack([]); setLoading(true); setSearchParams({}); }}>Clear</button> : null}
      </form>
      {loading ? <div className="ops-loading" aria-live="polite" aria-busy="true">Loading import history…</div> : null}
      {error ? <div className="ops-error" role="alert"><p>{error}</p><button type="button" className="admin-button admin-button-secondary" onClick={() => { setLoading(true); setRetryIndex((value) => value + 1); }}>Try again</button></div> : null}
      {!loading && !error && runs.length === 0 ? <EmptyState title={filtersActive ? "No runs match these filters" : "No import history yet"} description={filtersActive ? "Change or clear the filters to return to import history." : "A run appears here after a scheduled or manual import is requested."} /> : null}
      {runs.length > 0 ? <RunLedger runs={runs} /> : null}
      <KeysetPagination
        page={cursorStack.length + 1}
        hasPrevious={cursorStack.length > 0}
        hasNext={Boolean(nextCursor)}
        onPrevious={() => {
          const previous = cursorStack.at(-1);
          setCursorStack((values) => values.slice(0, -1));
          const next = new URLSearchParams(searchParams);
          if (previous) next.set("cursor", previous); else next.delete("cursor");
          setLoading(true);
          setSearchParams(next);
        }}
        onNext={() => {
          if (!nextCursor) return;
          setCursorStack((values) => [...values, cursor ?? ""]);
          const next = new URLSearchParams(searchParams);
          next.set("cursor", nextCursor);
          setLoading(true);
          setSearchParams(next);
        }}
      />
    </div>
  );
}
