import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { QuarantineEntrySummary, QuarantineRetryOutcome } from "@packscout/contracts";
import { useSearchParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { listProviderOperations, listQuarantines, retryQuarantines, type ProviderOperationSummary } from "../api/import-operations";
import { EmptyState } from "../components/EmptyState";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { QuarantineLedger } from "../components/operations/QuarantineLedger";
import { humanize } from "../components/operations/OperationStatus";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useToast } from "../providers/toast";

export function QuarantinePage() {
  useDocumentTitle("Quarantine");
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [entries, setEntries] = useState<QuarantineEntrySummary[]>([]);
  const [providers, setProviders] = useState<ProviderOperationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<QuarantineRetryOutcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryIndex, setRetryIndex] = useState(0);
  const [providerId, setProviderId] = useState(searchParams.get("providerId") ?? "");
  const [runId, setRunId] = useState(searchParams.get("runId") ?? "");
  const [state, setState] = useState(searchParams.get("state") ?? "open");
  const [recordKind, setRecordKind] = useState(searchParams.get("recordKind") ?? "");
  const [reasonCode, setReasonCode] = useState(searchParams.get("reasonCode") ?? "");
  const cursor = searchParams.get("cursor") ?? undefined;

  useEffect(() => {
    let active = true;
    void listProviderOperations({ limit: 50 }).then((result) => { if (active) setProviders(result.items); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void listQuarantines({
      providerId: searchParams.get("providerId") || undefined,
      runId: searchParams.get("runId") || undefined,
      state: (searchParams.get("state") || undefined) as QuarantineEntrySummary["state"] | undefined,
      recordKind: (searchParams.get("recordKind") || undefined) as QuarantineEntrySummary["recordKind"] | undefined,
      reasonCode: searchParams.get("reasonCode") || undefined,
      cursor,
      limit: 25,
    })
      .then((result) => {
        if (!active) return;
        setEntries(result.items);
        setNextCursor(result.nextCursor);
        setSelected(new Set());
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof AdminApiError && reason.status === 403
          ? "Your role no longer permits quarantine access."
          : reason instanceof AdminApiError && reason.status === 429
            ? "Too many operation requests. Wait before refreshing quarantine history."
            : "Quarantine history is temporarily unavailable. Prior safe results remain visible.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cursor, retryIndex, searchParams]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = new URLSearchParams();
    if (providerId) next.set("providerId", providerId);
    if (runId) next.set("runId", runId);
    if (state) next.set("state", state);
    if (recordKind) next.set("recordKind", recordKind);
    if (reasonCode) next.set("reasonCode", reasonCode.toUpperCase());
    setCursorStack([]);
    setLoading(true);
    setSearchParams(next);
  }

  function mergeOutcomes(results: QuarantineRetryOutcome[]) {
    setEntries((current) => current.map((entry) => results.find((result) => result.quarantineId === entry.id)?.entry ?? entry));
    setOutcomes(results);
    setSelected(new Set());
  }

  async function retrySelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    await confirm({
      title: `Retry ${ids.length} quarantined ${ids.length === 1 ? "record" : "records"}?`,
      description: "Retries process only the selected retained records. They do not rewind the provider cursor or change the originating run's historical state.",
      confirmLabel: ids.length === 1 ? "Retry record" : "Retry selected records",
      action: async () => {
        const result = await retryQuarantines(ids);
        mergeOutcomes(result.outcomes);
        const resolved = result.outcomes.filter((outcome) => outcome.outcome === "resolved").length;
        const needsReview = result.outcomes.filter(
          (outcome) =>
            outcome.outcome === "failed" || outcome.outcome === "non_retryable",
        ).length;
        showToast(
          `${resolved} resolved${needsReview ? `; ${needsReview} still need review` : ""}.`,
          needsReview ? "error" : "success",
        );
      },
    });
  }

  const filterCount = useMemo(() => [searchParams.get("providerId"), searchParams.get("runId"), searchParams.get("state"), searchParams.get("recordKind"), searchParams.get("reasonCode")].filter(Boolean).length, [searchParams]);
  return (
    <div className="admin-page">
      <PageHeader eyebrow="Data pipeline / Recovery" title="Quarantine" description="Review bounded record diagnostics and retry retained records independently from provider cursor progress." actions={selected.size > 0 ? <button type="button" className="admin-button admin-button--primary" onClick={() => void retrySelected()}>Retry selected ({selected.size})</button> : undefined} />
      <aside className="ops-independence-note"><strong>Retries do not rewind imports.</strong><p>The original run keeps its immutable outcome. A resolved record updates current quality separately.</p></aside>
      <form className="ops-filters ops-filters--quarantine" aria-label="Filter quarantine" onSubmit={applyFilters}>
        <div className="admin-field"><label htmlFor="quarantine-provider">Provider</label><select id="quarantine-provider" value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">All providers</option>{providers.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}</select></div>
        <div className="admin-field"><label htmlFor="quarantine-run">Run ID</label><input id="quarantine-run" value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="UUID" /></div>
        <div className="admin-field"><label htmlFor="quarantine-state">State</label><select id="quarantine-state" value={state} onChange={(event) => setState(event.target.value)}><option value="">All states</option><option value="open">Open</option><option value="retrying">Retrying</option><option value="resolved">Resolved</option><option value="expired">Expired</option></select></div>
        <div className="admin-field"><label htmlFor="quarantine-kind">Record kind</label><select id="quarantine-kind" value={recordKind} onChange={(event) => setRecordKind(event.target.value)}><option value="">All kinds</option><option value="catalog">Catalog</option><option value="pull">Pull</option><option value="trade">Trade</option></select></div>
        <div className="admin-field"><label htmlFor="quarantine-reason">Reason code</label><input id="quarantine-reason" pattern="[A-Za-z][A-Za-z0-9_]*" maxLength={128} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} /></div>
        <button type="submit" className="admin-button admin-button--secondary">Apply filters</button>
        {filterCount > 0 ? <button type="button" className="admin-button admin-button--secondary" onClick={() => { setProviderId(""); setRunId(""); setState(""); setRecordKind(""); setReasonCode(""); setCursorStack([]); setLoading(true); setSearchParams({}); }}>Clear</button> : null}
      </form>
      {outcomes.length > 0 ? <section className="ops-outcomes" aria-live="polite" aria-labelledby="retry-outcomes-title"><h2 id="retry-outcomes-title">Latest retry outcomes</h2><ul>{outcomes.map((outcome) => <li key={outcome.quarantineId}><span>{outcome.quarantineId.slice(0, 8)}</span><strong>{humanize(outcome.outcome)}</strong></li>)}</ul></section> : null}
      {loading ? <div className="ops-loading" aria-live="polite" aria-busy="true">Loading quarantine records…</div> : null}
      {error ? <div className="ops-error" role="alert"><p>{error}</p><button type="button" className="admin-button admin-button--secondary" onClick={() => { setLoading(true); setRetryIndex((value) => value + 1); }}>Try again</button></div> : null}
      {!loading && !error && entries.length === 0 ? <EmptyState title={filterCount ? "No quarantine records match" : "No records need review"} description={filterCount ? "Change or clear the filters to inspect other quarantine history." : "Current provider quality has no quarantined records."} /> : null}
      {entries.length > 0 ? <QuarantineLedger entries={entries} selectable selected={selected} onSelectionChange={(entryId, checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(entryId); else next.delete(entryId); return next; })} /> : null}
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
