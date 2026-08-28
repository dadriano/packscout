import { useCallback, useEffect, useState } from "react";
import { panelFetch } from "../api/panel-client.ts";
import {
  DATABASE_EVENT,
  DATABASE_PATH,
  DATABASE_STREAM_PATH,
  ROW_BROWSER_PATH,
  type DatabaseStatusPayload,
} from "../api/panel-types.ts";
import { subscribeToPanelStream } from "../streams/panel-stream.ts";

/**
 * The database surface's state: one snapshot fetch, then live updates through
 * the panel's shared stream budget, so a status page open beside the log tail
 * cannot exhaust the browser's per-origin connection cap.
 *
 * The row-browser actions post to guarded routes and adopt the snapshot the
 * server returns. The client never decides whether an action is allowed — it
 * renders the server's answer, including its refusals.
 */

export type DatabaseStatusPhase = "loading" | "ready" | "error";

export interface DatabaseStatusState {
  phase: DatabaseStatusPhase;
  status: DatabaseStatusPayload | null;
  live: boolean;
  error: string | null;
  pending: boolean;
  refresh: () => void;
  startRowBrowser: () => void;
  stopRowBrowser: () => void;
}

export function useDatabaseStatus(): DatabaseStatusState {
  const [status, setStatus] = useState<DatabaseStatusPayload | null>(null);
  const [phase, setPhase] = useState<DatabaseStatusPhase>("loading");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const apply = useCallback((next: DatabaseStatusPayload) => {
    setStatus(next);
    setPhase("ready");
    setError(null);
  }, []);

  const fail = useCallback((cause: unknown, fallback: string) => {
    setError(cause instanceof Error ? cause.message : fallback);
  }, []);

  useEffect(() => {
    let cancelled = false;
    panelFetch<DatabaseStatusPayload>(DATABASE_PATH)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPhase("error");
        fail(cause, "The panel could not read the database status.");
      });
    return () => {
      cancelled = true;
    };
  }, [apply, fail, reloadToken]);

  useEffect(() => {
    const unsubscribe = subscribeToPanelStream<DatabaseStatusPayload>({
      name: "database-status",
      path: DATABASE_STREAM_PATH,
      event: DATABASE_EVENT,
      onMessage: apply,
      onOpen: () => setLive(true),
      onError: () => setLive(false),
    });
    return () => {
      setLive(false);
      unsubscribe();
    };
  }, [apply]);

  const act = useCallback(
    (method: "POST" | "DELETE", fallback: string) => {
      setPending(true);
      panelFetch<DatabaseStatusPayload>(ROW_BROWSER_PATH, { method })
        .then(apply)
        .catch((cause: unknown) => fail(cause, fallback))
        .finally(() => setPending(false));
    },
    [apply, fail],
  );

  return {
    phase,
    status,
    live,
    error,
    pending,
    refresh: () => setReloadToken((token) => token + 1),
    startRowBrowser: () => act("POST", "The row browser could not be started."),
    stopRowBrowser: () => act("DELETE", "The row browser could not be stopped."),
  };
}
