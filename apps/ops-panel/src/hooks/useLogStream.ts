import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { panelFetch } from "../api/panel-client.ts";
import {
  LOG_STREAM_EVENT,
  LOG_STREAM_PATH,
  LOG_WINDOW_PATH,
  type LogRow,
  type LogStreamPayload,
  type LogWindowsPayload,
} from "../api/panel-types.ts";
import {
  createClientMarkerFactory,
  RECONNECTED_DETAIL,
} from "../logs/client-markers.ts";
import { createLogBuffer, toLogRows, type LogBuffer } from "../logs/log-buffer.ts";
import {
  createLogStreamSession,
  type LogStreamPhase,
} from "../logs/stream-session.ts";
import { subscribeToPanelStream } from "../streams/panel-stream.ts";

/**
 * One connection, one buffer, and an honest story about both.
 *
 * The stream is opened first and the initial window is fetched only once it is
 * live. That ordering is not incidental: the server aligns a service's tail
 * cursor the moment a viewer attaches, and the window read is defined to end at
 * that cursor. Fetching first would leave whatever was written in between
 * belonging to neither read — a gap nobody would ever see.
 *
 * A dropped connection is treated as a real loss of continuity. Rather than
 * appending new lines onto a buffer whose tail is now stale, the buffer is
 * reset, the windows are refetched, and a marker is placed at the seam saying
 * so. Silently resuming would be the one failure mode a log viewer must not
 * have.
 */

export type LogConnectionStatus = LogStreamPhase | "paused";

export interface LogStreamState {
  buffer: LogBuffer;
  /** Increments on every buffer mutation; drives rendering. */
  version: number;
  status: LogConnectionStatus;
  error: string | null;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  following: boolean;
  setFollowing: (following: boolean) => void;
  setAnchor: (id: string | null) => void;
  /** Lines that arrived since the reader stopped following. */
  pendingCount: number;
  heldCount: number;
  clearPending: () => void;
  windowLines: number;
}

export interface UseLogStreamOptions {
  windowLines?: number;
  followingLimit?: number;
  browsingLimit?: number;
  pauseLimit?: number;
}

export function useLogStream({
  windowLines = 500,
  followingLimit,
  browsingLimit,
  pauseLimit,
}: UseLogStreamOptions = {}): LogStreamState {
  const createMarker = useMemo(() => createClientMarkerFactory(), []);
  const buffer = useMemo(
    () =>
      createLogBuffer({
        followingLimit,
        browsingLimit,
        pauseLimit,
        createMarker: (input) =>
          createMarker({
            reason: input.reason,
            detail: input.detail,
            skippedLines: input.skippedLines,
          }),
      }),
    [createMarker, followingLimit, browsingLimit, pauseLimit],
  );

  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<LogConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPausedState] = useState(false);
  const [following, setFollowingState] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [heldCount, setHeldCount] = useState(0);

  const followingRef = useRef(true);
  const windowToken = useRef(0);

  const sync = useCallback(() => {
    setVersion(buffer.version());
    setHeldCount(buffer.heldCount());
  }, [buffer]);

  const loadWindows = useCallback(
    async (markSeam: boolean) => {
      const token = (windowToken.current += 1);
      const payload = await panelFetch<LogWindowsPayload>(
        `${LOG_WINDOW_PATH}?lines=${windowLines}`,
      );
      if (token !== windowToken.current) return;

      if (markSeam) {
        buffer.append([
          {
            type: "marker",
            ...createMarker({
              kind: "reconnected",
              reason: "restored",
              detail: RECONNECTED_DETAIL,
            }),
          },
        ]);
      }
      // Window lines precede everything the live stream has delivered, so they
      // go in at the head; identity keeps any overlap from doubling up.
      const rows: LogRow[] = payload.windows.flatMap((entry) =>
        entry.lines.map((line): LogRow => ({ type: "line", ...line })),
      );
      buffer.prepend(rows);
      sync();
    },
    [buffer, createMarker, sync, windowLines],
  );

  useEffect(() => {
    let cancelled = false;
    const session = createLogStreamSession();

    const unsubscribe = subscribeToPanelStream<LogStreamPayload>({
      name: "logs",
      path: LOG_STREAM_PATH,
      event: LOG_STREAM_EVENT,
      onOpen: () => {
        if (cancelled) return;
        const transition = session.opened();
        setStatus(transition.phase);
        setError(null);
        if (transition.action === "none") return;
        if (transition.action === "reset-and-refetch") {
          // The buffer's tail is no longer trustworthy: what was written while
          // the connection was down was never delivered to anyone.
          buffer.reset();
          setPendingCount(0);
        }
        void loadWindows(transition.markSeam).catch((cause: unknown) => {
          if (cancelled) return;
          setError(
            cause instanceof Error
              ? cause.message
              : "The panel could not read the current log window.",
          );
        });
      },
      onMessage: (payload) => {
        if (cancelled) return;
        const rows = toLogRows(payload.lines, payload.markers);
        if (rows.length === 0) return;
        const change = buffer.append(rows);
        if (!followingRef.current && change.admitted > 0) {
          setPendingCount((count) => count + change.admitted);
        }
        sync();
      },
      onError: () => {
        if (cancelled) return;
        setStatus(session.failed().phase);
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [buffer, loadWindows, sync]);

  const setPaused = useCallback(
    (next: boolean) => {
      buffer.setPaused(next);
      setPausedState(next);
      sync();
    },
    [buffer, sync],
  );

  const setFollowing = useCallback(
    (next: boolean) => {
      followingRef.current = next;
      buffer.setFollowing(next);
      setFollowingState(next);
      if (next) setPendingCount(0);
      sync();
    },
    [buffer, sync],
  );

  const setAnchor = useCallback(
    (id: string | null) => {
      buffer.setAnchor(id);
    },
    [buffer],
  );

  return {
    buffer,
    version,
    status: paused ? "paused" : status,
    error,
    paused,
    setPaused,
    following,
    setFollowing,
    setAnchor,
    pendingCount,
    heldCount,
    clearPending: () => setPendingCount(0),
    windowLines,
  };
}
