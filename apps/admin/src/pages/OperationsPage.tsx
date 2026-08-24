import { useEffect, useState } from "react";
import { AdminApiError } from "../api/client";
import { listProviderOperations, type ProviderOperationSummary } from "../api/import-operations";
import { EmptyState } from "../components/EmptyState";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { ProviderOperationsLedger } from "../components/operations/ProviderOperationsLedger";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function OperationsPage() {
  useDocumentTitle("Pipeline Status");
  const [providers, setProviders] = useState<ProviderOperationSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryIndex, setRetryIndex] = useState(0);

  useEffect(() => {
    let active = true;
    void listProviderOperations({ cursor, limit: 25 })
      .then((result) => {
        if (!active) return;
        setProviders(result.items);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof AdminApiError && reason.status === 403
          ? "Your role no longer permits provider operations access."
          : reason instanceof AdminApiError && reason.status === 429
            ? "Too many operation requests. Wait before refreshing pipeline status."
            : "Pipeline status is temporarily unavailable. Prior safe results remain visible.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cursor, retryIndex]);

  return (
    <div className="admin-page">
      <PageHeader eyebrow="Data pipeline / Status" title="Pipeline status" description="Per provider: whether the feed is current, and whether its records are clean." />
      {loading ? <div className="ops-loading" aria-live="polite" aria-busy="true">Loading provider operations…</div> : null}
      {error ? <div className="ops-error" role="alert"><p>{error}</p><button type="button" className="admin-button admin-button-secondary" onClick={() => { setLoading(true); setRetryIndex((value) => value + 1); }}>Try again</button></div> : null}
      {!loading && !error && providers.length === 0 ? <EmptyState title="No provider operations yet" description="Enable a tested provider to begin scheduled or manual imports." /> : null}
      {providers.length > 0 ? <ProviderOperationsLedger providers={providers} /> : null}
      <KeysetPagination
        page={cursorStack.length + 1}
        hasPrevious={cursorStack.length > 0}
        hasNext={Boolean(nextCursor)}
        onPrevious={() => {
          const previous = cursorStack.at(-1);
          setCursorStack((values) => values.slice(0, -1));
          setCursor(previous);
          setLoading(true);
        }}
        onNext={() => {
          if (!nextCursor) return;
          setCursorStack((values) => [...values, cursor]);
          setCursor(nextCursor);
          setLoading(true);
        }}
      />
    </div>
  );
}
