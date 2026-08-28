import { useCallback, useRef, useState } from "react";
import { fetchHistoryPage, SEARCH_PAGE_LINES } from "../api/log-history-client.ts";
import type { CompiledFilter } from "../logs/filter.ts";
import {
  runHistorySearch,
  type SearchOutcome,
  type SearchProgress,
} from "../logs/history-search.ts";

/**
 * The deep-search run, and the operator's ability to stop it.
 *
 * The reasoning lives in `logs/history-search.ts`; this hook only carries it to
 * the screen. Progress is state rather than a log line because the two numbers
 * that matter while waiting — how much has been read, how much has been found —
 * are the ones that tell an operator whether to keep waiting or to narrow the
 * filter and try again.
 *
 * Cancellation is a plain flag the driver checks between pages, not an aborted
 * request: a page already in flight has already been paid for, and its matches
 * are kept rather than thrown away.
 */

const IDLE: SearchProgress = {
  bytesScanned: 0,
  linesScanned: 0,
  matches: 0,
  service: null,
  running: false,
};

export interface HistorySearchState {
  running: boolean;
  progress: SearchProgress;
  outcome: SearchOutcome | null;
  start: () => void;
  cancel: () => void;
  clear: () => void;
}

export interface UseHistorySearchOptions {
  filter: CompiledFilter;
  /** Services to scan, in the order they appear on screen. */
  services: readonly string[];
}

export function useHistorySearch({
  filter,
  services,
}: UseHistorySearchOptions): HistorySearchState {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SearchProgress>(IDLE);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const control = useRef({ aborted: false });

  const start = useCallback(() => {
    if (running) return;
    const signal = { aborted: false };
    control.current = signal;
    setRunning(true);
    setOutcome(null);
    setProgress({ ...IDLE, running: true });

    void runHistorySearch({
      // Every scan begins at the tail and walks back, so a search finds the
      // most recent occurrence first however far the reader has scrolled.
      scopes: services.map((service) => ({ service, generation: null, before: null })),
      filter,
      signal,
      fetchPage: async (request) => {
        const page = await fetchHistoryPage({
          service: request.service,
          direction: "backward",
          cursor: request.before,
          generation: request.generation,
          lines: SEARCH_PAGE_LINES,
        });
        return {
          service: page.service,
          generation: page.generation,
          lines: page.lines,
          startCursor: page.startCursor,
          atStart: page.atStart || !page.present,
          bytesRead: page.bytesRead,
        };
      },
      onProgress: setProgress,
    })
      .then(setOutcome)
      .finally(() => setRunning(false));
  }, [filter, running, services]);

  const cancel = useCallback(() => {
    control.current.aborted = true;
  }, []);

  const clear = useCallback(() => {
    control.current.aborted = true;
    setOutcome(null);
    setProgress(IDLE);
  }, []);

  return { running, progress, outcome, start, cancel, clear };
}
