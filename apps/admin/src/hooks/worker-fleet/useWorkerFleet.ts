import { useCallback, useEffect, useState } from "react";
import type {
  ScheduleHealthView,
  StalledRunView,
  WorkerFleetEvaluation,
  WorkerFleetSettingsResolution,
  WorkerInstanceView,
} from "@packscout/contracts";
import { AdminApiError } from "../../api/client";
import {
  getWorkerSettings,
  listScheduleHealth,
  listStalledRuns,
  listWorkerInstances,
} from "../../api/worker-fleet";

/**
 * Live worker status without unbounded polling: one bounded interval per
 * section, paused whenever the tab is hidden, matching the admin's existing
 * live-run refresh behavior. A background refresh never re-enters the loading
 * state, so a healthy fleet does not flicker every cadence.
 */
export const WORKER_FLEET_REFRESH_MS = 15_000;

const PAGE_LIMIT = 25;

function describe(reason: unknown, subject: string): string {
  if (reason instanceof AdminApiError && reason.status === 403) {
    return `Your role no longer permits ${subject} access.`;
  }
  if (reason instanceof AdminApiError && reason.status === 429) {
    return `Too many operation requests. Live refresh is paused; wait before refreshing ${subject}.`;
  }
  return `${subject} is temporarily unavailable. Prior safe results remain visible.`;
}

function useBoundedRefresh(onTick: () => void): void {
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "visible") onTick();
    };
    const intervalId = window.setInterval(poll, WORKER_FLEET_REFRESH_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [onTick]);
}

export interface KeysetPage {
  readonly page: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly goPrevious: () => void;
  readonly goNext: () => void;
}

export interface WorkerInstancesView {
  readonly instances: WorkerInstanceView[];
  readonly fleet: WorkerFleetEvaluation | null;
  readonly settings: WorkerFleetSettingsResolution | null;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

export function useWorkerInstances(): WorkerInstancesView {
  const [instances, setInstances] = useState<WorkerInstanceView[]>([]);
  const [fleet, setFleet] = useState<WorkerFleetEvaluation | null>(null);
  const [settings, setSettings] =
    useState<WorkerFleetSettingsResolution | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void listWorkerInstances({ limit: PAGE_LIMIT })
      .then((result) => {
        if (!active) return;
        setInstances(result.instances);
        setFleet(result.fleet);
        setSettings(result.settings);
        setHasMore(result.hasMore);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(describe(reason, "worker fleet status"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useBoundedRefresh(refresh);

  return {
    instances,
    fleet,
    settings,
    hasMore,
    loading,
    error,
    reload: useCallback(() => {
      setLoading(true);
      setAttempt((value) => value + 1);
    }, []),
  };
}

export interface StalledRunsView {
  readonly items: StalledRunView[];
  readonly staleAfterMs: number | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  readonly pagination: KeysetPage;
}

export function useStalledRuns(): StalledRunsView {
  const [cursor, setCursor] = useState<string | undefined>();
  const [stack, setStack] = useState<(string | undefined)[]>([]);
  const [items, setItems] = useState<StalledRunView[]>([]);
  const [staleAfterMs, setStaleAfterMs] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void listStalledRuns({ cursor, limit: PAGE_LIMIT })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setStaleAfterMs(result.staleAfterMs);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(describe(reason, "stalled run detection"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, cursor]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useBoundedRefresh(refresh);

  return {
    items,
    staleAfterMs,
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

export interface ScheduleHealthListView {
  readonly items: ScheduleHealthView[];
  readonly overdueAfterMs: number | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
  readonly pagination: KeysetPage;
}

export function useScheduleHealth(): ScheduleHealthListView {
  const [cursor, setCursor] = useState<string | undefined>();
  const [stack, setStack] = useState<(string | undefined)[]>([]);
  const [items, setItems] = useState<ScheduleHealthView[]>([]);
  const [overdueAfterMs, setOverdueAfterMs] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void listScheduleHealth({ cursor, limit: PAGE_LIMIT })
      .then((result) => {
        if (!active) return;
        setItems(result.items);
        setOverdueAfterMs(result.overdueAfterMs);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(describe(reason, "schedule health"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, cursor]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useBoundedRefresh(refresh);

  return {
    items,
    overdueAfterMs,
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

export interface WorkerSettingsPanelView {
  readonly settings: WorkerFleetSettingsResolution | null;
  readonly observedAt: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/**
 * Effective settings change only when a worker restarts, so they are read once
 * per visit rather than polled alongside live status.
 */
export function useWorkerSettings(): WorkerSettingsPanelView {
  const [settings, setSettings] =
    useState<WorkerFleetSettingsResolution | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void getWorkerSettings()
      .then((result) => {
        if (!active) return;
        setSettings(result.settings);
        setObservedAt(result.observedAt);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(describe(reason, "worker operating settings"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  return {
    settings,
    observedAt,
    loading,
    error,
    reload: useCallback(() => {
      setLoading(true);
      setAttempt((value) => value + 1);
    }, []),
  };
}
