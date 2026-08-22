import { useCallback, useMemo, useRef, useState } from "react";
import {
  CONTEXT_LINES,
  fetchHistoryPage,
  HISTORY_PAGE_LINES,
  isGenerationChanged,
} from "../api/log-history-client.ts";
import type {
  LogHistoryPayload,
  LogLineRecord,
  LogRow,
} from "../api/panel-types.ts";
import type { ClientMarkerFactory } from "../logs/client-markers.ts";
import {
  advanceDetachedBrowse,
  beginDetachedBrowse,
  browsedGenerations,
  describeDetachedBrowse,
  describeGenerationBreak,
  describeStartOfLog,
  detectGenerationBreak,
  oldestHeldByService,
  planBackwardReads,
  planContextRead,
  planStartRead,
  type DetachedBrowse,
  type DetachedRead,
} from "../logs/history-session.ts";
import type { LogBuffer } from "../logs/log-buffer.ts";

/**
 * Moving through a log's past without ever losing the thread.
 *
 * Three modes share one buffer. *Following* is the live tail. *Scrollback* is
 * the same buffer grown upwards a bounded page at a time, with live output
 * still arriving below. *Detached* browsing reads one service from a chosen
 * point — the start of its log, or the context around a search hit — and holds
 * live output aside rather than interleaving it, because bytes read from two
 * places in a file have no shared order to be interleaved by.
 *
 * The invariant every mode obeys: a byte offset only means something inside one
 * generation. So the moment a browsed service restarts, browsing ends. It is
 * noticed twice over — from live arrivals carrying a newer generation, and from
 * the server refusing a page whose generation no longer exists — and both paths
 * lead to the same place: back to live, with a marker where the seam is.
 */

export interface LogHistoryState {
  /** True while an older page is on its way. */
  loadingOlder: boolean;
  /** Services that have reported the beginning of their log. */
  atStart: ReadonlySet<string>;
  /** What the top of the pane says when there is nothing above it. */
  startNotice: string | null;
  error: string | null;
  dismissError: () => void;
  loadOlder: () => void;
  /** Hand live lines here so a generation change ends browsing promptly. */
  observeLive: (lines: readonly LogLineRecord[]) => void;
  detached: DetachedBrowse | null;
  detachedNotice: string | null;
  /** True while showing unfiltered context, so the pane stops filtering. */
  unfiltered: boolean;
  focusedId: string | null;
  jumpToStart: (service: string | null) => void;
  openContext: (line: LogLineRecord) => void;
  loadMoreForward: () => void;
  returnToLive: () => void;
}

export interface UseLogHistoryOptions {
  buffer: LogBuffer;
  /** Visible services, in rail order. */
  services: readonly string[];
  isVisible: (service: string) => boolean;
  following: boolean;
  setFollowing: (following: boolean) => void;
  setPaused: (paused: boolean) => void;
  refreshWindows: () => Promise<void>;
  createMarker: ClientMarkerFactory;
  sync: () => void;
}

function toRows(page: LogHistoryPayload): LogRow[] {
  return page.lines.map((line): LogRow => ({ type: "line", ...line }));
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useLogHistory({
  buffer,
  services,
  isVisible,
  following,
  setFollowing,
  setPaused,
  refreshWindows,
  createMarker,
  sync,
}: UseLogHistoryOptions): LogHistoryState {
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atStart, setAtStart] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [detached, setDetached] = useState<DetachedBrowse | null>(null);
  const [unfiltered, setUnfiltered] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // The generations currently on screen, kept in a ref so a live batch can be
  // judged without re-rendering on every arrival.
  const browsed = useRef<Map<string, number>>(new Map());
  const inFlight = useRef(false);
  // Mirrored in a ref so an event handler can read the current mode without
  // being rebuilt — and so a page that lands late cannot act on a stale copy.
  const detachedRef = useRef<DetachedBrowse | null>(null);
  const applyDetached = useCallback((next: DetachedBrowse | null) => {
    detachedRef.current = next;
    setDetached(next);
  }, []);

  const markerRow = useCallback(
    (detail: string, kind: "restarted" | "skipped", service?: string): LogRow => ({
      type: "marker",
      ...createMarker({ kind, reason: "browsing", detail, service }),
    }),
    [createMarker],
  );

  const returnToLive = useCallback(
    (detail?: string) => {
      setPaused(false);
      buffer.reset();
      applyDetached(null);
      setUnfiltered(false);
      setFocusedId(null);
      setAtStart(new Set());
      browsed.current = new Map();
      setFollowing(true);
      const seal = () => {
        buffer.appendHistory([
          markerRow(
            detail ??
              "Returned to live. What was written between the part of the log you were reading and here was not read.",
            "restarted",
          ),
        ]);
        sync();
      };
      void refreshWindows().then(seal, seal);
    },
    [applyDetached, buffer, markerRow, refreshWindows, setFollowing, setPaused, sync],
  );

  /** Every browsing path funnels a generation change through one door. */
  const breakBrowsing = useCallback(
    (service: string) => returnToLive(describeGenerationBreak(service)),
    [returnToLive],
  );

  const loadOlder = useCallback(() => {
    if (inFlight.current) return;
    const edges = oldestHeldByService(buffer.rows(), isVisible);
    const scope = detachedRef.current ? [detachedRef.current.service] : services;
    const reads = planBackwardReads(scope, edges, atStart);
    if (reads.length === 0) return;

    inFlight.current = true;
    setLoadingOlder(true);
    browsed.current = browsedGenerations(edges);

    void Promise.all(
      reads.map(async (read) => {
        try {
          const page = await fetchHistoryPage({
            service: read.service,
            direction: "backward",
            cursor: read.before,
            generation: read.generation,
            lines: HISTORY_PAGE_LINES,
          });
          return { read, page, broke: false };
        } catch (cause) {
          if (isGenerationChanged(cause)) return { read, page: null, broke: true };
          setError(messageOf(cause, "The panel could not read further back."));
          return { read, page: null, broke: false };
        }
      }),
    )
      .then((results) => {
        const broken = results.find((result) => result.broke);
        if (broken) {
          breakBrowsing(broken.read.service);
          return;
        }
        const exhausted = new Set(atStart);
        for (const { read, page } of results) {
          if (!page) continue;
          // Older lines belong above everything already held; identity keeps an
          // overlap from doubling up and makes a gap impossible to hide.
          buffer.prepend(toRows(page));
          if (page.atStart || !page.present) exhausted.add(read.service);
          browsed.current.set(read.service, page.generation);
        }
        setAtStart(exhausted);
        sync();
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [atStart, breakBrowsing, buffer, isVisible, services, sync]);

  const observeLive = useCallback(
    (lines: readonly LogLineRecord[]) => {
      if (following && detachedRef.current === null) return;
      const change = detectGenerationBreak(browsed.current, lines);
      if (change) breakBrowsing(change.service);
    },
    [breakBrowsing, following],
  );

  /** Enter a detached read: one service, one starting point, live held aside. */
  const detach = useCallback(
    async (
      service: string,
      request: DetachedRead,
      notice: string,
      focus: string | null,
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setLoadingOlder(true);
      try {
        const page = await fetchHistoryPage({
          service,
          direction: request.direction,
          cursor: request.cursor,
          // Carried, not dropped: without it the server has nothing to refuse
          // with when the file rotated since this point was chosen.
          generation: request.generation,
          lines: request.direction === "around" ? CONTEXT_LINES : HISTORY_PAGE_LINES,
        });
        if (!page.present) {
          setError(`No log file is being written for ${service} right now.`);
          return;
        }
        // Live output is held rather than shown: bytes read from the middle of
        // a file and bytes arriving at its end have no shared order.
        setPaused(true);
        setFollowing(false);
        buffer.reset();
        // A context read that already reaches the first byte has nothing above
        // it, so scrolling up says so instead of asking for another page.
        setAtStart(page.atStart ? new Set([service]) : new Set());
        buffer.appendHistory([markerRow(notice, "skipped", service), ...toRows(page)]);
        const browse = advanceDetachedBrowse(
          {
            ...beginDetachedBrowse(
              service,
              page.generation,
              request.direction === "around" ? "context" : "start",
            ),
            next: page.startCursor,
            atStart: page.atStart,
          },
          page,
        );
        applyDetached(browse);
        setUnfiltered(request.direction === "around");
        setFocusedId(focus);
        browsed.current = new Map([[service, page.generation]]);
        setError(null);
        sync();
      } catch (cause) {
        if (isGenerationChanged(cause)) {
          breakBrowsing(service);
          return;
        }
        setError(messageOf(cause, "The panel could not read that part of the log."));
      } finally {
        inFlight.current = false;
        setLoadingOlder(false);
      }
    },
    [applyDetached, breakBrowsing, buffer, markerRow, setFollowing, setPaused, sync],
  );

  const jumpToStart = useCallback(
    (service: string | null) => {
      if (service === null) {
        setError("Focus a single service before reading its log from the start.");
        return;
      }
      void detach(
        service,
        planStartRead(),
        `Reading ${service} from the first byte of its log. Live output is held until you return to live.`,
        null,
      );
    },
    [detach],
  );

  const openContext = useCallback(
    (line: LogLineRecord) => {
      void detach(
        line.service,
        planContextRead(line),
        `Unfiltered context around a search result in ${line.service}. Live output is held until you return to live.`,
        line.id,
      );
    },
    [detach],
  );

  const loadMoreForward = useCallback(() => {
    const browse = detachedRef.current;
    if (!browse || browse.atEnd || inFlight.current) return;
    inFlight.current = true;
    setLoadingOlder(true);
    void fetchHistoryPage({
      service: browse.service,
      direction: "forward",
      cursor: browse.next,
      generation: browse.generation,
      lines: HISTORY_PAGE_LINES,
    })
      .then((page) => {
        buffer.appendHistory(toRows(page));
        applyDetached(advanceDetachedBrowse(browse, page));
        sync();
      })
      .catch((cause: unknown) => {
        if (isGenerationChanged(cause)) {
          breakBrowsing(browse.service);
          return;
        }
        setError(messageOf(cause, "The panel could not read the next page."));
      })
      .finally(() => {
        inFlight.current = false;
        setLoadingOlder(false);
      });
  }, [applyDetached, breakBrowsing, buffer, sync]);

  const startNotice = useMemo(() => {
    const reached = services.filter((service) => atStart.has(service));
    return reached.length === 0 ? null : describeStartOfLog(reached);
  }, [atStart, services]);

  return {
    loadingOlder,
    atStart,
    startNotice,
    error,
    dismissError: () => setError(null),
    loadOlder,
    observeLive,
    detached,
    detachedNotice: detached ? describeDetachedBrowse(detached) : null,
    unfiltered,
    focusedId,
    jumpToStart,
    openContext,
    loadMoreForward,
    returnToLive: () => returnToLive(),
  };
}
