import { useMemo, useState, type ReactNode } from "react";
import {
  promotionJobHistoryQuerySchema,
  promotionJobTerminalOutcomes,
  promotionJobTriggerKinds,
  type PromotionJobHistoryQuery,
} from "@packscout/contracts";
import { useSearchParams } from "react-router-dom";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { PromotionHistory } from "../components/promotion-jobs/PromotionHistory";
import { PromotionOverview } from "../components/promotion-jobs/PromotionOverview";
import { PageHeader } from "../components/PageHeader";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  PROMOTION_JOB_REFRESH_MS,
  usePromotionJobHistory,
  usePromotionJobOverview,
  type PromotionJobLiveRead,
} from "../hooks/promotion-jobs/usePromotionJobs";

const ALLOWED_QUERY_KEYS = new Set(["filter", "trigger", "outcome", "cursor"]);

interface ParsedHistoryLocation {
  readonly query: PromotionJobHistoryQuery | null;
  readonly invalid: readonly string[];
}

export function parsePromotionHistoryLocation(
  searchParams: URLSearchParams,
): ParsedHistoryLocation {
  const invalid: string[] = [];
  for (const key of new Set(searchParams.keys())) {
    if (!ALLOWED_QUERY_KEYS.has(key)) invalid.push(`${key} is not supported`);
    if (searchParams.getAll(key).length > 1) invalid.push(`${key} appears more than once`);
  }
  const raw = {
    filter: searchParams.get("filter") || undefined,
    trigger: searchParams.get("trigger") || undefined,
    outcome: searchParams.get("outcome") || undefined,
    cursor: searchParams.get("cursor") || undefined,
    limit: 25,
  };
  const parsed = promotionJobHistoryQuerySchema.safeParse(raw);
  if (!parsed.success) {
    invalid.push(...parsed.error.issues.map((issue) => {
      const path = issue.path.join(".") || "query";
      return `${path}: ${issue.message}`;
    }));
  }
  return {
    query: invalid.length === 0 && parsed.success ? parsed.data : null,
    invalid,
  };
}

function SectionState<T>({
  state,
  loadingLabel,
  children,
}: {
  state: PromotionJobLiveRead<T>;
  loadingLabel: string;
  children: (data: T) => ReactNode;
}) {
  if (state.loading && state.data === null) {
    return <div className="ops-loading" aria-live="polite" aria-busy="true">{loadingLabel}</div>;
  }
  return (
    <>
      {state.error ? (
        <div className="ops-error" role="alert">
          <p>
            {state.error}
            {state.stale ? " Last safe evidence for this exact view remains below and is marked stale." : ""}
          </p>
          <button type="button" className="admin-button admin-button-secondary" onClick={state.reload}>Try again</button>
        </div>
      ) : null}
      {state.refreshing ? <span className="promotion-refreshing" role="status">Refreshing…</span> : null}
      {state.data ? children(state.data) : null}
    </>
  );
}

function invalidOption(value: string, valid: readonly string[]) {
  return value && !valid.includes(value)
    ? <option value={value}>Invalid: {value}</option>
    : null;
}

export function PromotionJobsPage() {
  useDocumentTitle("Convex Promotion Jobs");
  const [searchParams, setSearchParams] = useSearchParams();
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const locationKey = searchParams.toString();
  const parsed = useMemo(
    () => parsePromotionHistoryLocation(new URLSearchParams(locationKey)),
    [locationKey],
  );
  const overview = usePromotionJobOverview();
  const history = usePromotionJobHistory(parsed.query);
  const filter = searchParams.get("filter") ?? "";
  const trigger = searchParams.get("trigger") ?? "";
  const outcome = searchParams.get("outcome") ?? "";
  const cursor = searchParams.get("cursor") ?? "";
  const providerFilters = overview.data?.providers.map(({ providerKey }) => `provider:${providerKey}`) ?? [];
  const validFilters = ["", "manifest", ...providerFilters];

  function changeFilter(key: "filter" | "trigger" | "outcome", value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("cursor");
    setCursorStack([]);
    setSearchParams(next);
  }

  function resetFilters() {
    setCursorStack([]);
    setSearchParams({});
  }

  function refreshAll() {
    overview.reload();
    history?.reload();
  }

  return (
    <div className="admin-page promotion-page">
      <PageHeader
        eyebrow="Data pipeline / Promotion jobs"
        title="Convex promotion jobs"
        description="Provider PostgreSQL-to-Convex publication and central manifest activation. This view observes the scheduler; it does not control it."
        actions={
          <button type="button" className="admin-button admin-button-secondary" onClick={refreshAll}>
            Refresh status
          </button>
        }
      />

      <aside className="promotion-readonly-note">
        <strong>Independent by design</strong>
        <p>
          Each provider publishes on its own. Central activates only that
          provider, so a delayed provider does not block a healthy one.
          Live sections refresh every {PROMOTION_JOB_REFRESH_MS / 1_000} seconds while this tab is visible.
        </p>
      </aside>

      <SectionState state={overview} loadingLabel="Loading current promotion status…">
        {(data) => <PromotionOverview overview={data} />}
      </SectionState>

      <section className="promotion-history" aria-labelledby="promotion-history-title">
        <header>
          <div>
            <span className="admin-kicker">Newest first</span>
            <h2 id="promotion-history-title">Invocation history</h2>
            <p>Bounded safe evidence for provider and central jobs.</p>
          </div>
          {history?.data ? <strong>{history.data.items.length} shown</strong> : null}
        </header>

        <form className="promotion-filters" aria-label="Filter promotion job history" onSubmit={(event) => event.preventDefault()}>
          <div className="admin-field">
            <label htmlFor="promotion-filter">Job</label>
            <select id="promotion-filter" value={filter} onChange={(event) => changeFilter("filter", event.target.value)}>
              {invalidOption(filter, validFilters)}
              <option value="">All jobs</option>
              <option value="manifest">Central manifest</option>
              {providerFilters.map((value) => <option key={value} value={value}>{value.slice(9)}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="promotion-trigger">Trigger</label>
            <select id="promotion-trigger" value={trigger} onChange={(event) => changeFilter("trigger", event.target.value)}>
              {invalidOption(trigger, ["", ...promotionJobTriggerKinds])}
              <option value="">All triggers</option>
              {promotionJobTriggerKinds.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="promotion-outcome">Outcome</label>
            <select id="promotion-outcome" value={outcome} onChange={(event) => changeFilter("outcome", event.target.value)}>
              {invalidOption(outcome, ["", ...promotionJobTerminalOutcomes])}
              <option value="">All outcomes</option>
              {promotionJobTerminalOutcomes.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
            </select>
          </div>
          {(filter || trigger || outcome || cursor || parsed.invalid.length > 0) ? (
            <button type="button" className="admin-button admin-button-secondary" onClick={resetFilters}>Reset filters</button>
          ) : null}
        </form>

        {parsed.invalid.length > 0 ? (
          <div className="promotion-invalid-filter" role="alert">
            <div>
              <strong>These URL filters are invalid</strong>
              <ul>{parsed.invalid.map((message) => <li key={message}>{message}</li>)}</ul>
              <p>No broader history query was sent.</p>
            </div>
            <button type="button" className="admin-button admin-button-secondary" onClick={resetFilters}>Reset filters</button>
          </div>
        ) : history ? (
          <SectionState state={history} loadingLabel="Loading promotion job history…">
            {(data) => <PromotionHistory page={data} />}
          </SectionState>
        ) : null}

        {history?.data ? (
          <KeysetPagination
            page={cursorStack.length + 1}
            hasPrevious={cursorStack.length > 0}
            hasNext={Boolean(history.data.nextCursor)}
            onPrevious={() => {
              const previous = cursorStack.at(-1) ?? "";
              const next = new URLSearchParams(searchParams);
              if (previous) next.set("cursor", previous);
              else next.delete("cursor");
              setCursorStack((values) => values.slice(0, -1));
              setSearchParams(next);
            }}
            onNext={() => {
              if (!history.data?.nextCursor) return;
              setCursorStack((values) => [...values, cursor]);
              const next = new URLSearchParams(searchParams);
              next.set("cursor", history.data.nextCursor);
              setSearchParams(next);
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
