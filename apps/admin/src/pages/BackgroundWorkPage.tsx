import { useMemo, useState, type ReactNode } from "react";
import {
  RECOMPUTATION_RECOVERY_SELECTION_LIMIT,
  type RecomputationQueueEntry,
  type RecomputationQueueState,
  type RecomputationRecoveryAction,
  type RecomputationRecoveryResult,
} from "@packscout/contracts";
import {
  recoverRecomputation,
  recoverRecomputations,
} from "../api/background-work";
import { EmptyState } from "../components/EmptyState";
import {
  BacklogStatus,
  CadenceStatus,
  recoveryOutcomeLabel,
} from "../components/operations/BackgroundWorkStatus";
import { KeysetPagination } from "../components/operations/KeysetPagination";
import { age } from "../components/operations/OperationStatus";
import { RecomputationQueueLedger } from "../components/operations/RecomputationQueueLedger";
import { RetentionExecutionLedger } from "../components/operations/RetentionExecutionLedger";
import { PageHeader } from "../components/PageHeader";
import {
  useRecomputationQueue,
  useRetentionExecutions,
  type KeysetPage,
} from "../hooks/background-work/useBackgroundWork";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useConfirm } from "../providers/confirm";
import { useToast } from "../providers/toast";

const actionCopy: Record<
  RecomputationRecoveryAction,
  { verb: string; description: string }
> = {
  release: {
    verb: "Release",
    description:
      "Releasing returns the request to the queue so any worker can claim it again. A worker that finishes the request first keeps its result — the release then reports an already-resolved outcome instead of running it twice.",
  },
  requeue: {
    verb: "Re-queue",
    description:
      "Re-queuing gives an exhausted request one more worker attempt. The attempt history is kept, so a request that fails again returns to the failed state.",
  },
};

function SectionState({
  loading,
  error,
  onRetry,
  loadingLabel,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  loadingLabel: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="ops-loading" aria-live="polite" aria-busy="true">
        {loadingLabel}
      </div>
    );
  }
  if (error) {
    return (
      <div className="ops-error" role="alert">
        <p>{error}</p>
        <button
          type="button"
          className="admin-button admin-button-secondary"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

function Pagination({ pagination }: { pagination: KeysetPage }) {
  return (
    <KeysetPagination
      page={pagination.page}
      hasPrevious={pagination.hasPrevious}
      hasNext={pagination.hasNext}
      onPrevious={pagination.goPrevious}
      onNext={pagination.goNext}
    />
  );
}

export function BackgroundWorkPage() {
  useDocumentTitle("Background Work");
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<RecomputationRecoveryResult[]>([]);
  const queue = useRecomputationQueue();
  const retention = useRetentionExecutions();

  const selectable = useMemo(
    () => queue.items.filter((entry) => selected.has(entry.id)),
    [queue.items, selected],
  );
  const stuck = selectable.filter((entry) => entry.claimExpired);
  const failed = selectable.filter((entry) => entry.state === "failed");
  const atLimit = selected.size >= RECOMPUTATION_RECOVERY_SELECTION_LIMIT;

  /**
   * A recovery acts on the rows the operator is looking at. Paging replaces
   * those rows, so the selection goes with them: an identifier left selected
   * from a page that is no longer shown would still consume the selection limit
   * while offering nothing on screen to release or re-queue.
   */
  function clearSelection() {
    setSelected(new Set());
    setResults([]);
  }

  const queuePagination: KeysetPage = {
    ...queue.pagination,
    goPrevious() {
      if (!queue.pagination.hasPrevious) return;
      clearSelection();
      queue.pagination.goPrevious();
    },
    goNext() {
      if (!queue.pagination.hasNext) return;
      clearSelection();
      queue.pagination.goNext();
    },
  };

  function toggle(requestId: string, isSelected: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (isSelected) {
        if (next.size >= RECOMPUTATION_RECOVERY_SELECTION_LIMIT) return current;
        next.add(requestId);
      } else {
        next.delete(requestId);
      }
      return next;
    });
  }

  async function run(
    action: RecomputationRecoveryAction,
    entries: RecomputationQueueEntry[],
  ) {
    const ids = entries.map((entry) => entry.id);
    if (ids.length === 0) return;
    const copy = actionCopy[action];
    const noun = ids.length === 1 ? "request" : "requests";
    await confirm({
      title: `${copy.verb} ${ids.length} recomputation ${noun}?`,
      description: copy.description,
      confirmLabel: `${copy.verb} ${noun}`,
      action: async () => {
        const outcomes =
          ids.length === 1 && ids[0] !== undefined
            ? [(await recoverRecomputation(ids[0], action)).result]
            : (await recoverRecomputations(ids, action)).results;
        setResults(outcomes);
        setSelected(new Set());
        queue.replace(
          outcomes
            .map((outcome) => outcome.entry)
            .filter((entry): entry is RecomputationQueueEntry => entry !== null),
        );
        const recovered = outcomes.filter(
          (outcome) =>
            outcome.outcome === "released" || outcome.outcome === "requeued",
        ).length;
        const conflicts = outcomes.length - recovered;
        showToast(
          `${recovered} returned to the queue${conflicts ? `; ${conflicts} already resolved` : ""}.`,
          conflicts ? "error" : "success",
        );
      },
    });
  }

  const backlog = queue.backlog;
  const cadence = retention.cadence;
  return (
    <div className="admin-page">
      <PageHeader
        eyebrow="Data pipeline / Background work"
        title="Background work"
        description="Estimated-EV recomputation backlog and protected-payload cleanup runs, with recovery for claims a departed worker left behind."
      />

      <section className="ops-metrics" aria-label="Recomputation backlog">
        <div>
          <span>Queue depth</span>
          <strong>{backlog ? backlog.depth : "—"}</strong>
          <small>
            {backlog
              ? `${backlog.pending} pending · ${backlog.claimed} in flight`
              : "Loading"}
          </small>
        </div>
        <div>
          <span>Oldest pending</span>
          <strong>{backlog ? age(backlog.oldestPendingAgeMs) : "—"}</strong>
          <small>
            {backlog?.timelyAfterMs
              ? `Timely within ${age(backlog.timelyAfterMs)}`
              : "No published worker settings"}
          </small>
        </div>
        <div>
          <span>Stuck claims</span>
          <strong>{backlog ? backlog.expiredClaims : "—"}</strong>
          <small>Claims held past their expiry</small>
        </div>
        <div>
          <span>Failed entries</span>
          <strong>{backlog ? backlog.failed : "—"}</strong>
          <small>Attempts exhausted</small>
        </div>
        <div>
          <span>Backlog</span>
          {backlog ? <BacklogStatus state={backlog.state} /> : <strong>—</strong>}
          <small>Derived from the settings workers published</small>
        </div>
      </section>

      <form
        className="ops-filters"
        aria-label="Filter recomputation queue"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="admin-field">
          <label htmlFor="recomputation-state">State</label>
          <select
            id="recomputation-state"
            value={queue.state}
            onChange={(event) => {
              clearSelection();
              queue.changeState(
                event.target.value as RecomputationQueueState | "",
              );
            }}
          >
            <option value="">All states</option>
            <option value="pending">Pending</option>
            <option value="claimed">Claimed</option>
            <option value="failed">Failed</option>
            <option value="completed">Completed</option>
          </select>
        </div>
        {stuck.length > 0 ? (
          <button
            type="button"
            className="admin-button admin-button-primary"
            onClick={() => void run("release", stuck)}
          >
            Release stuck claims ({stuck.length})
          </button>
        ) : null}
        {failed.length > 0 ? (
          <button
            type="button"
            className="admin-button admin-button-primary"
            onClick={() => void run("requeue", failed)}
          >
            Re-queue failed ({failed.length})
          </button>
        ) : null}
      </form>

      {atLimit ? (
        <aside className="ops-independence-note">
          <strong>Selection limit reached.</strong>
          <p>
            One recovery acts on at most{" "}
            {RECOMPUTATION_RECOVERY_SELECTION_LIMIT} requests so the queue stays
            predictable. Recover this set, then select more.
          </p>
        </aside>
      ) : null}

      {results.length > 0 ? (
        <section
          className="ops-outcomes"
          aria-live="polite"
          aria-labelledby="recovery-outcomes-title"
        >
          <h2 id="recovery-outcomes-title">Latest recovery outcomes</h2>
          <ul>
            {results.map((result) => (
              <li key={result.requestId}>
                <span>{result.requestId.slice(0, 8)}</span>
                <strong>{recoveryOutcomeLabel(result.outcome)}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <SectionState
        loading={queue.loading}
        error={queue.error}
        onRetry={queue.reload}
        loadingLabel="Loading recomputation queue…"
      >
        {queue.items.length === 0 ? (
          <EmptyState
            title={queue.state ? "No entries in that state" : "The queue is empty"}
            description={
              queue.state
                ? "Change or clear the state filter to inspect other queue entries."
                : "Every estimated-EV recomputation request has been processed."
            }
          />
        ) : (
          <RecomputationQueueLedger
            entries={queue.items}
            selected={selected}
            onSelectionChange={toggle}
          />
        )}
        <Pagination pagination={queuePagination} />
      </SectionState>

      {cadence ? (
        <aside
          className={`ops-independence-note${cadence.state === "overdue" ? " is-warning" : ""}`}
          aria-label="Retention cadence"
        >
          <strong>Retention cadence</strong>{" "}
          <CadenceStatus state={cadence.state} />
          <p>
            {cadence.state === "overdue"
              ? `Retention last started ${age(cadence.sinceLastStartMs)} ago — ${age(cadence.overdueByMs)} past its expected interval, with ${cadence.knownRemaining ?? 0} payloads still to clear.`
              : cadence.state === "never_observed"
                ? "No retention execution has been recorded for this workspace yet."
                : cadence.state === "unknown"
                  ? "No worker has published its operating settings, so the expected retention interval is unknown."
                  : cadence.state === "idle"
                    ? `Retention last started ${age(cadence.sinceLastStartMs)} ago and left nothing behind, so no run is due.`
                    : `Retention last started ${age(cadence.sinceLastStartMs)} ago, inside its expected ${age(cadence.expectedIntervalMs)} interval.`}
          </p>
        </aside>
      ) : null}

      <SectionState
        loading={retention.loading}
        error={retention.error}
        onRetry={retention.reload}
        loadingLabel="Loading retention history…"
      >
        {retention.items.length === 0 ? (
          <EmptyState
            title="No retention executions yet"
            description="Retention records an execution only when protected payloads have reached their expiry."
          />
        ) : (
          <RetentionExecutionLedger executions={retention.items} />
        )}
        <Pagination pagination={retention.pagination} />
      </SectionState>
    </div>
  );
}
