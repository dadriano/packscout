"use client";

import { useReducer, useRef } from "react";
import styles from "./CatalogState.module.css";
import {
  CATALOG_STATE_COPY,
  type CatalogConstraint,
  reduceRecoverableActionState,
  recoveryMessage,
  usableConstraints,
} from "./catalog-state";

type RecoverableAction = () => void | Promise<void>;

function useRecoverableAction(action: RecoverableAction) {
  const pendingRef = useRef(false);
  const [state, dispatch] = useReducer(reduceRecoverableActionState, "idle");

  async function run() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    dispatch("start");

    try {
      await action();
      dispatch("succeed");
    } catch {
      dispatch("fail");
    } finally {
      pendingRef.current = false;
    }
  }

  return { run, state } as const;
}

function StateMark({ kind }: { kind: "unavailable" | "empty" | "no-matches" }) {
  return (
    <span aria-hidden="true" className={styles.stateMark} data-kind={kind}>
      <span />
      <span />
      <span />
    </span>
  );
}

export function DataReleaseUnavailable({
  onRetry,
}: {
  onRetry: RecoverableAction;
}) {
  const retry = useRecoverableAction(onRetry);
  const feedback = recoveryMessage(retry.state, {
    pending: CATALOG_STATE_COPY.retryPending,
    succeeded: CATALOG_STATE_COPY.retrySucceeded,
    failed: CATALOG_STATE_COPY.retryFailed,
  });

  return (
    <section
      aria-labelledby="data-release-unavailable-title"
      className={styles.pageState}
      data-state="data-release-unavailable"
    >
      <StateMark kind="unavailable" />
      <div className={styles.pageStateCopy}>
        <p className={styles.stateEyebrow}>Catalog unavailable</p>
        <h2 id="data-release-unavailable-title">
          {CATALOG_STATE_COPY.unavailable}
        </h2>
        <p>
          Try again without changing your theme, filters, or catalog position.
        </p>
        <button
          aria-disabled={retry.state === "pending"}
          className={styles.primaryAction}
          onClick={retry.run}
          type="button"
        >
          {retry.state === "pending" ? "Retrying…" : CATALOG_STATE_COPY.retry}
        </button>
        <p
          aria-atomic="true"
          aria-live="polite"
          className={styles.liveFeedback}
          role="status"
        >
          {feedback}
        </p>
      </div>
    </section>
  );
}

export function EmptyCatalog() {
  return (
    <section
      aria-labelledby="empty-catalog-title"
      className={styles.pageState}
      data-state="empty-catalog"
      role="status"
    >
      <StateMark kind="empty" />
      <div className={styles.pageStateCopy}>
        <p className={styles.stateEyebrow}>Catalog empty</p>
        <h2 id="empty-catalog-title">{CATALOG_STATE_COPY.empty}</h2>
        <p>
          PackScout will show comparison details after a complete public catalog
          is available.
        </p>
      </div>
    </section>
  );
}

export function NoMatches({
  constraints,
  onClearFilters,
}: {
  constraints: readonly CatalogConstraint[];
  onClearFilters: RecoverableAction;
}) {
  const clear = useRecoverableAction(onClearFilters);
  const visibleConstraints = usableConstraints(constraints);
  const feedback = recoveryMessage(clear.state, {
    pending: CATALOG_STATE_COPY.clearPending,
    succeeded: CATALOG_STATE_COPY.clearSucceeded,
    failed: CATALOG_STATE_COPY.clearFailed,
  });

  return (
    <section
      aria-labelledby="no-matches-title"
      className={styles.pageState}
      data-state="no-matches"
    >
      <StateMark kind="no-matches" />
      <div className={styles.pageStateCopy}>
        <p className={styles.stateEyebrow}>No matching results</p>
        <h2 id="no-matches-title">{CATALOG_STATE_COPY.noMatches}</h2>
        {visibleConstraints.length > 0 ? (
          <div className={styles.constraintSummary}>
            <p>Active constraints</p>
            <ul>
              {visibleConstraints.map(({ label, value }) => (
                <li key={`${label}:${value}`}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>Your current search or filters returned no repacks.</p>
        )}
        <button
          aria-disabled={clear.state === "pending"}
          className={styles.secondaryAction}
          onClick={clear.run}
          type="button"
        >
          {clear.state === "pending"
            ? "Clearing…"
            : CATALOG_STATE_COPY.clearFilters}
        </button>
        <p
          aria-atomic="true"
          aria-live="polite"
          className={styles.liveFeedback}
          role="status"
        >
          {feedback}
        </p>
      </div>
    </section>
  );
}
