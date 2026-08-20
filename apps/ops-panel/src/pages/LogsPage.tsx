import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { LogRow } from "../api/panel-types.ts";
import { LogToolbar } from "../components/logs/LogToolbar.tsx";
import { LogViewport } from "../components/logs/LogViewport.tsx";
import { PanelPageHeader } from "../components/PanelShell.tsx";
import { useLogSources } from "../hooks/useLogSources.ts";
import { useLogStream } from "../hooks/useLogStream.ts";
import { stripAnsi } from "../logs/ansi.ts";
import {
  readLogDisplayPreferences,
  writeLogDisplayPreferences,
  type LogDisplayPreferences,
} from "../logs/display-preferences.ts";

/**
 * The live log surface.
 *
 * Everything on this page reads one buffer fed by one connection. Which
 * services are shown, whether colour is rendered, and how timestamps are
 * written are all decisions applied to that buffer on the way to the screen —
 * never by asking the server for something different.
 */

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** The plain-text form of a row: the one form copy and export both use. */
export function logRowPlainText(row: LogRow): string {
  return row.type === "line" ? stripAnsi(row.text) : `--- ${row.detail} ---`;
}

export function LogsPage() {
  const { sources, logDirectory } = useLogSources();
  const stream = useLogStream();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [preferences, setPreferences] = useState<LogDisplayPreferences>(() =>
    readLogDisplayPreferences(browserStorage()),
  );

  const services = useMemo(
    () => sources.map((source) => source.service),
    [sources],
  );

  const updatePreferences = useCallback(
    (patch: Partial<LogDisplayPreferences>) => {
      setPreferences((current) => {
        const next = { ...current, ...patch };
        writeLogDisplayPreferences(browserStorage(), next);
        return next;
      });
    },
    [],
  );

  const toggleService = useCallback((service: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(service)) next.delete(service);
      else next.add(service);
      return next;
    });
  }, []);

  const focusService = useCallback(
    (service: string | null) => {
      setHidden(
        service === null
          ? new Set()
          : new Set(services.filter((name) => name !== service)),
      );
    },
    [services],
  );

  const { buffer, version } = stream;
  const visibleRows = useMemo(() => {
    const rows = buffer.rows();
    if (hidden.size === 0) return rows;
    return rows.filter((row) => !hidden.has(row.service));
    // `version` is the signal that the (mutable) row array changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, hidden, version]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copyVisible = useCallback(() => {
    const text = visibleRows.map(logRowPlainText).join("\n");
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopyState("failed");
      return;
    }
    clipboard.writeText(text).then(
      () => setCopyState("copied"),
      () => setCopyState("failed"),
    );
  }, [visibleRows]);

  return (
    <>
      <PanelPageHeader
        eyebrow="Logs"
        title="Live output"
        description="Every PackScout service on this machine, interleaved. Restarts, rotations, and gaps are called out inline rather than papered over."
      />

      {stream.error ? (
        <p className="panel-notice" role="alert">
          {stream.error}
        </p>
      ) : null}

      <LogToolbar
        status={stream.status}
        following={stream.following}
        services={services}
        hidden={hidden}
        onToggleService={toggleService}
        onFocusService={focusService}
        preferences={preferences}
        onPreferenceChange={updatePreferences}
        paused={stream.paused}
        onPausedChange={stream.setPaused}
        heldCount={stream.heldCount}
        bufferedCount={buffer.size()}
        onCopyVisible={copyVisible}
        copyState={copyState}
      />

      <div className="panel-log-frame">
        <LogViewport
          rows={visibleRows}
          version={version}
          preferences={preferences}
          following={stream.following}
          onFollowingChange={stream.setFollowing}
          onAnchorChange={stream.setAnchor}
          emptyMessage={
            services.length === 0
              ? `No service is writing to ${logDirectory || "the log directory"} yet.`
              : "Waiting for output. Nothing has been written since the panel attached."
          }
        />

        {stream.following ? null : (
          <button
            type="button"
            className="panel-log-pill"
            onClick={() => stream.setFollowing(true)}
          >
            {stream.pendingCount > 0
              ? `${stream.pendingCount.toLocaleString("en-US")} new ${
                  stream.pendingCount === 1 ? "line" : "lines"
                } — jump to live`
              : "Jump to live"}
          </button>
        )}
      </div>

      <p className="panel-log-footnote">
        Showing the last {stream.windowLines} lines per service on attach.{" "}
        <Link to="/logs/sources">Inspect the discovered log files</Link>.
      </p>
    </>
  );
}
