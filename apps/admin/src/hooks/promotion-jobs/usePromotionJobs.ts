import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PromotionJobHistoryPage,
  PromotionJobHistoryQuery,
  PromotionJobInvocationDetail,
  PromotionJobMonitoringOverview,
} from "@packscout/contracts";
import { AdminApiError } from "../../api/client";
import {
  getPromotionJobDetail,
  getPromotionJobOverview,
  listPromotionJobHistory,
} from "../../api/promotion-jobs";

export const PROMOTION_JOB_REFRESH_MS = 15_000;
export const PROMOTION_JOB_RATE_LIMIT_BACKOFF_MS = 60_000;

interface LiveReadState<T> {
  readonly scope: string;
  readonly data: T | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly error: string | null;
  readonly rateLimitedUntil: number | null;
}

export interface PromotionJobLiveRead<T> extends LiveReadState<T> {
  readonly reload: () => void;
}

function describeFailure(reason: unknown, subject: string): string {
  if (reason instanceof AdminApiError && reason.status === 403) {
    return `Your role no longer permits ${subject} access.`;
  }
  if (reason instanceof AdminApiError && reason.status === 404) {
    return `This ${subject} record no longer exists.`;
  }
  if (reason instanceof AdminApiError && reason.status === 422) {
    return `The ${subject} request is invalid. Reset the filters and try again.`;
  }
  if (reason instanceof AdminApiError && reason.status === 429) {
    return `Too many monitoring requests. Automatic ${subject} refresh is paused for one minute.`;
  }
  return `${subject} is temporarily unavailable.`;
}

/**
 * A bounded, visibility-aware reader. Evidence is retained after a failure
 * only while the exact scope key is unchanged. Every new request aborts and
 * supersedes the previous one, so a slow old filter cannot replace a newer
 * result.
 */
function useLiveRead<T>(
  scope: string,
  subject: string,
  read: (signal: AbortSignal) => Promise<T>,
): PromotionJobLiveRead<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LiveReadState<T>>({
    scope,
    data: null,
    loading: true,
    refreshing: false,
    stale: false,
    error: null,
    rateLimitedUntil: null,
  });
  const requestSequence = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    void read(controller.signal)
      .then((data) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) {
          return;
        }
        setState({
          scope,
          data,
          loading: false,
          refreshing: false,
          stale: false,
          error: null,
          rateLimitedUntil: null,
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) {
          return;
        }
        const rateLimited =
          reason instanceof AdminApiError && reason.status === 429;
        setState((current) => {
          if (current.scope !== scope) {
            return {
              scope,
              data: null,
              loading: false,
              refreshing: false,
              stale: false,
              error: describeFailure(reason, subject),
              rateLimitedUntil: rateLimited
                ? Date.now() + PROMOTION_JOB_RATE_LIMIT_BACKOFF_MS
                : null,
            };
          }
          return {
            ...current,
            loading: false,
            refreshing: false,
            stale: current.data !== null,
            error: describeFailure(reason, subject),
            rateLimitedUntil: rateLimited
              ? Date.now() + PROMOTION_JOB_RATE_LIMIT_BACKOFF_MS
              : null,
          };
        });
      });

    return () => controller.abort();
  }, [attempt, read, scope, subject]);

  const queueRefresh = useCallback((clearRateLimit: boolean) => {
    setState((current) => current.scope === scope
      ? {
          ...current,
          loading: current.data === null,
          refreshing: current.data !== null,
          rateLimitedUntil: clearRateLimit ? null : current.rateLimitedUntil,
        }
      : {
          scope,
          data: null,
          loading: true,
          refreshing: false,
          stale: false,
          error: null,
          rateLimitedUntil: null,
        });
    setAttempt((value) => value + 1);
  }, [scope]);

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      if (
        state.rateLimitedUntil !== null
        && Date.now() < state.rateLimitedUntil
      ) return;
      queueRefresh(false);
    };
    const intervalId = window.setInterval(poll, PROMOTION_JOB_REFRESH_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [queueRefresh, scope, state.rateLimitedUntil]);

  const reload = useCallback(() => queueRefresh(true), [queueRefresh]);

  const visibleState: LiveReadState<T> = state.scope === scope
    ? state
    : {
        scope,
        data: null,
        loading: true,
        refreshing: false,
        stale: false,
        error: null,
        rateLimitedUntil: null,
      };
  return { ...visibleState, reload };
}

export function usePromotionJobOverview(): PromotionJobLiveRead<PromotionJobMonitoringOverview> {
  const read = useCallback(
    (signal: AbortSignal) => getPromotionJobOverview(signal),
    [],
  );
  return useLiveRead("overview", "promotion overview", read);
}

export function usePromotionJobHistory(
  query: PromotionJobHistoryQuery | null,
): PromotionJobLiveRead<PromotionJobHistoryPage> | null {
  const scope = query === null ? "invalid" : JSON.stringify(query);
  const read = useCallback(
    (signal: AbortSignal) => {
      if (query === null) return Promise.reject(new Error("Invalid query"));
      return listPromotionJobHistory(query, signal);
    },
    [query],
  );
  const result = useLiveRead(scope, "promotion history", read);
  return query === null ? null : result;
}

export function usePromotionJobDetail(
  monitoringId: string,
): PromotionJobLiveRead<PromotionJobInvocationDetail> {
  const read = useCallback(
    (signal: AbortSignal) => getPromotionJobDetail(monitoringId, signal),
    [monitoringId],
  );
  return useLiveRead(monitoringId, "promotion job", read);
}
