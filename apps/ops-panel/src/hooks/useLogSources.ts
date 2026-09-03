import { useCallback, useEffect, useRef, useState } from "react";
import { panelFetch } from "../api/panel-client.ts";
import {
  LOG_SOURCES_EVENT,
  LOG_SOURCES_PATH,
  LOG_SOURCES_STREAM_PATH,
  type LogSource,
  type LogSourcesPayload,
} from "../api/panel-types.ts";
import { subscribeToPanelStream } from "../streams/panel-stream.ts";

export type LogSourcesStatus = "loading" | "ready" | "error";

export interface LogSourcesState {
  status: LogSourcesStatus;
  live: boolean;
  sources: LogSource[];
  logDirectory: string;
  pollIntervalMs: number;
  error: string | null;
  reload: () => void;
}

/**
 * Source discovery for the UI: one snapshot fetch, then live updates. The
 * stream is the source of truth once connected, so files that appear or vanish
 * mid-session show up without a reload.
 */
export function useLogSources(): LogSourcesState {
  const [payload, setPayload] = useState<LogSourcesPayload | null>(null);
  const [status, setStatus] = useState<LogSourcesStatus>("loading");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const revision = useRef(-1);

  const apply = useCallback((next: LogSourcesPayload) => {
    if (next.revision < revision.current) return;
    revision.current = next.revision;
    setPayload(next);
    setStatus("ready");
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    panelFetch<LogSourcesPayload>(LOG_SOURCES_PATH)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(
          cause instanceof Error
            ? cause.message
            : "The panel could not read its log directory.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [apply, reloadToken]);

  useEffect(() => {
    const unsubscribe = subscribeToPanelStream<LogSourcesPayload>({
      name: "log-sources",
      path: LOG_SOURCES_STREAM_PATH,
      event: LOG_SOURCES_EVENT,
      onMessage: apply,
      onOpen: () => setLive(true),
      onError: () => setLive(false),
    });
    return () => {
      setLive(false);
      unsubscribe();
    };
  }, [apply, reloadToken]);

  return {
    status,
    live,
    sources: payload?.sources ?? [],
    logDirectory: payload?.logDirectory ?? "",
    pollIntervalMs: payload?.pollIntervalMs ?? 0,
    error,
    reload: () => setReloadToken((token) => token + 1),
  };
}
