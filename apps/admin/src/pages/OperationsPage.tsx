import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderSourceOperationsOverview,
  ProviderSourceOperationsSource,
} from "@packscout/contracts";
import { Link } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { requestManualImport } from "../api/import-operations";
import { getProviderSourceOperationsOverview } from "../api/provider-source-operations";
import { commandProviderSource } from "../api/provider-sources";
import { EmptyState } from "../components/EmptyState";
import { IndicatorTooltip } from "../components/IndicatorTooltip";
import { ProviderPulseOverview } from "../components/operations/ProviderPulseOverview";
import { pulseState } from "../components/operations/provider-pulse-presentation";
import {
  ConnectionOperationsSummary,
  ProviderSourceOperationsLedger,
  sourceOperationalLabel,
  type SourceOperationCommand,
} from "../components/operations/SourceOperationsViews";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

const REFRESH_INTERVAL_MS = 5_000;

function readError(error: unknown): string {
  if (!(error instanceof AdminApiError)) {
    return "Processor status is temporarily unavailable. Prior safe evidence remains visible.";
  }
  if (error.status === 403) {
    return "Your role no longer permits processor status access.";
  }
  if (error.status === 429) {
    return "Too many operation requests. Live refresh is waiting before it tries again.";
  }
  return error.message ||
    "Processor status is temporarily unavailable. Prior safe evidence remains visible.";
}

function commandError(error: unknown): string {
  if (!(error instanceof AdminApiError)) {
    return "The processor command could not be completed. Current safe evidence has not been discarded.";
  }
  if (error.status === 403) {
    return "Your role cannot operate this processor. No source state was changed.";
  }
  if (error.code === "SOURCE_CONFLICT" || error.code === "SOURCE_REVISION_CONFLICT") {
    return "The selected source changed before the command completed. Refresh and try its current revision.";
  }
  if (error.code === "SOURCE_DEPENDENCY_REQUIRED") {
    return "The shared connection must recover before this processor can continue.";
  }
  return error.message || "The processor command could not be completed.";
}

export function OperationsPage({
  presentation = "status",
}: {
  readonly presentation?: "status" | "providers";
} = {}) {
  const providerCatalog = presentation === "providers";
  useDocumentTitle(providerCatalog ? "Data Providers" : "Pipeline Status");
  const { status } = useSession();
  const { showToast } = useToast();
  const canOperate = status.phase === "authenticated" &&
    status.session.permissions.includes("imports:start");
  const canConfigure = status.phase === "authenticated" &&
    status.session.permissions.includes("providers:manage");
  const [overview, setOverview] = useState<ProviderSourceOperationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [displayPaused, setDisplayPaused] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const priorStates = useRef(new Map<string, string>());
  const readInFlight = useRef(false);
  const refreshAfterRead = useRef(false);

  const refresh = useCallback((reason: "explicit" | "poll" = "explicit") => {
    if (readInFlight.current) {
      if (reason === "explicit") refreshAfterRead.current = true;
      return;
    }
    setRefreshIndex((value) => value + 1);
  }, []);

  useEffect(() => {
    if (displayPaused) return;
    let active = true;
    readInFlight.current = true;
    void getProviderSourceOperationsOverview()
      .then((result) => {
        if (!active || refreshAfterRead.current) return;
        const changes = result.sources.flatMap((source) => {
          const next = providerCatalog ? sourceOperationalLabel(source) : pulseState(source).label;
          const previous = priorStates.current.get(source.providerId);
          priorStates.current.set(source.providerId, next);
          return previous && previous !== next
            ? [`${source.displayName} changed from ${previous} to ${next}.`]
            : [];
        });
        if (changes.length > 0) setAnnouncement(changes.join(" "));
        setOverview(result);
        setReadFailure(null);
      })
      .catch((error: unknown) => {
        if (active && !refreshAfterRead.current) setReadFailure(readError(error));
      })
      .finally(() => {
        if (active) {
          readInFlight.current = false;
          setLoading(false);
          if (refreshAfterRead.current) {
            refreshAfterRead.current = false;
            setRefreshIndex((value) => value + 1);
          }
        }
      });
    return () => {
      active = false;
      readInFlight.current = false;
      refreshAfterRead.current = false;
    };
  }, [refreshIndex, displayPaused, providerCatalog]);

  useEffect(() => {
    if (displayPaused) return;
    const poll = () => {
      if (document.visibilityState === "visible") refresh("poll");
    };
    const intervalId = window.setInterval(poll, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [displayPaused, refresh]);

  async function operate(
    source: ProviderSourceOperationsSource,
    command: SourceOperationCommand,
  ): Promise<void> {
    if (!source.source) return;
    setPendingKey(`${source.providerId}:${command}`);
    setActionFailure(null);
    try {
      if (command === "run") {
        const result = await requestManualImport(
          source.providerId,
          source.source.sourceRevisionId,
        );
        const message = result.outcome === "coalesced"
          ? `${source.displayName}: request coalesced into the existing ${result.run.state} run.`
          : `${source.displayName}: manual run created and queued.`;
        setAnnouncement(message);
        showToast(message, "success");
      } else {
        const result = await commandProviderSource(
          source.providerId,
          source.source.sourceInstanceId,
          command,
          source.source.sourceRevisionId,
        );
        const outcome = result.state === "pause_requested"
          ? "pause requested; the current page may commit"
          : result.state === "paused"
            ? "paused before another page began"
            : "resumed from the committed cursor";
        const message = `${source.displayName}: ${outcome}.`;
        setAnnouncement(message);
        showToast(message, "success");
      }
      refresh();
    } catch (error) {
      const message = commandError(error);
      setActionFailure(message);
      setAnnouncement(message);
    } finally {
      setPendingKey(null);
    }
  }

  const staleDisplay = displayPaused || readFailure !== null;
  return (
    <div className={`admin-page source-operations-page${providerCatalog ? "" : " provider-pulse-page"}`}>
      <PageHeader
        eyebrow={providerCatalog ? "Data pipeline / Providers" : "Data pipeline / Status"}
        title={providerCatalog ? "Data providers" : "Pipeline status"}
        description={providerCatalog
          ? "Canonical provider roots and their isolated source lanes. Platforms may share one connection while retaining independent cursors, runs, freshness, and quality."
          : "All providers. Problems first."}
        actions={
          <>
            {canConfigure ? (
              <Link className="admin-button admin-button-secondary" to="/source-configuration">
                Configure sources
              </Link>
            ) : null}
            <button
              type="button"
              className="admin-button admin-button-secondary"
              aria-pressed={displayPaused}
              onClick={() => {
                setDisplayPaused((paused) => {
                  const next = !paused;
                  setAnnouncement(next
                    ? "Display refresh paused. Ingestion continues."
                    : "Display refresh resumed.");
                  if (paused) refresh();
                  return next;
                });
              }}
            >
              {displayPaused ? "Resume display" : "Pause display"}
            </button>
          </>
        }
      />

      {providerCatalog && !canConfigure ? (
        <aside className="provider-read-only-note">
          <strong>Read-only access to provider configuration</strong>
          <p>You can inspect canonical source health and use any separately authorized run controls. Changing connection or source configuration requires administrator access.</p>
        </aside>
      ) : null}

      <p className="admin-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <section className={providerCatalog ? "source-refresh-strip" : "provider-pulse__refresh"} aria-label="Display refresh status">
        <div>
          {providerCatalog ? <StatusBadge label={staleDisplay ? "Stale display" : "Live display"} tone={staleDisplay ? "pending" : "ready"} /> : (
            <IndicatorTooltip label={displayPaused ? "Display paused" : readFailure ? "Refresh failed" : "Auto-refresh"}
              tone={staleDisplay ? "pending" : "neutral"}
              description={displayPaused ? "The displayed snapshot is frozen. Ingestion and scheduling continue. Resume display to fetch current evidence."
                : readFailure ? "The latest refresh failed. Previously loaded evidence is retained and its displayed measurement times have not changed."
                  : "Status refreshes every 5 seconds while this page is visible. Stored-row and retained-run totals are cached for up to 60 seconds. This does not imply that a worker is running."} />
          )}
          <span>
            {providerCatalog ? displayPaused
              ? "Display updates are paused; ingestion and scheduling continue."
              : overview
                ? `Visible-page refresh every 5 seconds · evidence time ${new Date(overview.refreshedAt).toLocaleString()}`
                : "Visible-page refresh every 5 seconds"
              : displayPaused ? "Snapshot paused · ingestion continues"
                : overview ? `Updated ${new Date(overview.refreshedAt).toLocaleTimeString()} · every 5s` : "Every 5 seconds"}
          </span>
        </div>
        {!canOperate ? <span>{providerCatalog ? "Read-only: processor commands require data-operator access." : "Read-only access"}</span> : null}
      </section>

      {loading && !overview ? (
        <div className="ops-loading" aria-live="polite" aria-busy="true">
          {providerCatalog ? "Loading registered connection and processor state…" : "Loading providers…"}
        </div>
      ) : null}
      {readFailure ? (
        <div className="ops-error" role="alert">
          <p>{readFailure}</p>
          <button type="button" className="admin-button admin-button-secondary" onClick={() => {
            setDisplayPaused(false);
            setLoading(true);
            refresh();
          }}>Refresh safe evidence</button>
        </div>
      ) : null}
      {actionFailure ? (
        <div className="ops-error" role="alert">
          <p>{actionFailure}</p>
          <button type="button" className="admin-button admin-button-secondary" onClick={() => setActionFailure(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {overview && !providerCatalog ? <ProviderPulseOverview overview={overview} canOperate={canOperate} pendingKey={pendingKey}
        onCommand={(source, command) => { void operate(source, command); }} /> : null}
      {overview && providerCatalog ? (
        <>
          <ConnectionOperationsSummary
            connection={overview.connection}
            mode={overview.connectionMode}
          />
          {providerCatalog && overview.sources.length === 0 ? (
            <EmptyState
              title="No stable providers are available"
              description="Seed the canonical provider roots before binding source lanes. No legacy provider revision is required."
            />
          ) : (
            <ProviderSourceOperationsLedger
              sources={overview.sources}
              canOperate={canOperate}
              pendingKey={pendingKey}
              onCommand={(source, command) => { void operate(source, command); }}
            />
          )}
        </>
      ) : null}
    </div>
  );
}
