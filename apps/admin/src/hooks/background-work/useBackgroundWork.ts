import { useCallback, useEffect, useState } from "react";
import type {
  RecomputationBacklogEvaluation,
  RecomputationQueueEntry,
  RecomputationQueueState,
  RetentionCadenceEvaluation,
  RetentionExecutionSummary,
} from "@packscout/contracts";
import { AdminApiError } from "../../api/client";
import {
  listRecomputations,
  listRetentionExecutions,
} from "../../api/background-work";

export interface KeysetPage {
  readonly page: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly goPrevious: () => void;
  readonly goNext: () => void;
}

function describe(reason: unknown, subject: string): string {
  if (reason instanceof AdminApiError && reason.status === 403) {
    return `Your role no longer permits ${subject} access.`;
  }
  if (reason instanceof AdminApiError && reason.status === 429) {
    return `Too many operation requests. Wait before refreshing ${subject}.`;
  }
  return `${subject} is temporarily unavailable. Prior safe results remain visible.`;
}

export interface RecomputationQueueView {
  readonly items: RecomputationQueueEntry[];
  readonly backlog: RecomputationBacklogEvaluation | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly state: RecomputationQueueState | "";
  readonly reload: () => void;
  readonly changeState: (next: RecomputationQueueState | "") => void;
  readonly replace: (entries: readonly RecomputationQueueEntry[]) => void;
  readonly pagination: KeysetPage;
}

export function useRecomputationQueue(): RecomputationQueueView {
  const [state, setState] = useState<RecomputationQueueState | "">("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [stack, setStack] = useState<(string | undefined)[]>([]);
  const [items, setItems] = useState<RecomputationQueueEntry[]>([]);
  const [backlog, setBacklog] = useState<RecomputationBacklogEvaluation | null>(
    null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void listRecomputations({ cursor, limit: 25, ...(state ? { state } : {}) })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setBacklog(result.backlog);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(describe(reason, "the recomputation queue"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, cursor, state]);

  return {
    items,
    backlog,
    loading,
    error,
    state,
    reload: useCallback(() => {
      setLoading(true);
      setAttempt((value) => value + 1);
    }, []),
    changeState: useCallback((next: RecomputationQueueState | "") => {
      setLoading(true);
      setCursor(undefined);
      setStack([]);
      setState(next);
    }, []),
    replace: useCallback(
      (updated: readonly RecomputationQueueEntry[]) =>
        setItems((current) =>
          current.map(
            (entry) => updated.find((next) => next.id === entry.id) ?? entry,
          ),
        ),
      [],
    ),
    pagination: {
      page: stack.length + 1,
      hasPrevious: stack.length > 0,
      hasNext: Boolean(nextCursor),
      goPrevious() {
        setLoading(true);
        setCursor(stack.at(-1));
        setStack((values) => values.slice(0, -1));
      },
      goNext() {
        if (!nextCursor) return;
        setLoading(true);
        setStack((values) => [...values, cursor]);
        setCursor(nextCursor);
      },
    },
  };
}

export interface RetentionExecutionsView {
  readonly items: RetentionExecutionSummary[];
  readonly cadence: RetentionCadenceEvaluation | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  readonly pagination: KeysetPage;
}

export function useRetentionExecutions(): RetentionExecutionsView {
  const [cursor, setCursor] = useState<string | undefined>();
  const [stack, setStack] = useState<(string | undefined)[]>([]);
  const [items, setItems] = useState<RetentionExecutionSummary[]>([]);
  const [cadence, setCadence] = useState<RetentionCadenceEvaluation | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void listRetentionExecutions({ cursor, limit: 25 })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setCadence(result.cadence);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(describe(reason, "retention history"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, cursor]);

  return {
    items,
    cadence,
    loading,
    error,
    reload: useCallback(() => {
      setLoading(true);
      setAttempt((value) => value + 1);
    }, []),
    pagination: {
      page: stack.length + 1,
      hasPrevious: stack.length > 0,
      hasNext: Boolean(nextCursor),
      goPrevious() {
        setLoading(true);
        setCursor(stack.at(-1));
        setStack((values) => values.slice(0, -1));
      },
      goNext() {
        if (!nextCursor) return;
        setLoading(true);
        setStack((values) => [...values, cursor]);
        setCursor(nextCursor);
      },
    },
  };
}
