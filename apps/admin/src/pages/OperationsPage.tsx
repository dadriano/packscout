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

export function OperationsPage() {
  useDocumentTitle("Platform Processors");
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

  const refresh = useCallback(() => {
    setRefreshIndex((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    void getProviderSourceOperationsOverview()
      .then((result) => {
        if (!active) return;
        const changes = result.sources.flatMap((source) => {
          const next = sourceOperationalLabel(source);
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
        if (active) setReadFailure(readError(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refreshIndex]);

  useEffect(() => {
    if (displayPaused) return;
    const poll = () => {
      if (document.visibilityState === "visible") refresh();
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
            : "resumed from the committed checkpoint";
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
    <div className="admin-page source-operations-page">
      <PageHeader
        eyebrow="Data pipeline / Operations"
        title="Platform processors"
        description="One shared source connection feeds four isolated processor lanes. Local checkpoints, lifecycle, freshness, and quality remain distinct when the connection is affected."
        actions={
          <>
            {canConfigure ? (
              <Link className="admin-button admin-button--secondary" to="/source-configuration">
                Configure sources
              </Link>
            ) : null}
            <button
              type="button"
              className="admin-button admin-button--secondary"
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

      <p className="admin-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <section className="source-refresh-strip" aria-label="Display refresh status">
        <div>
          <StatusBadge
            label={staleDisplay ? "Stale display" : "Live display"}
            tone={staleDisplay ? "pending" : "ready"}
          />
          <span>
            {displayPaused
              ? "Display updates are paused; ingestion and scheduling continue."
              : overview
                ? `Visible-page refresh every 5 seconds · evidence time ${new Date(overview.refreshedAt).toLocaleString()}`
                : "Visible-page refresh every 5 seconds"}
          </span>
        </div>
        {!canOperate ? <span>Read-only: processor commands require data-operator access.</span> : null}
      </section>

      {loading && !overview ? (
        <div className="ops-loading" aria-live="polite" aria-busy="true">
          Loading registered connection and processor state…
        </div>
      ) : null}
      {readFailure ? (
        <div className="ops-error" role="alert">
          <p>{readFailure}</p>
          <button type="button" className="admin-button admin-button--secondary" onClick={() => {
            setLoading(true);
            refresh();
          }}>Refresh safe evidence</button>
        </div>
      ) : null}
      {actionFailure ? (
        <div className="ops-error" role="alert">
          <p>{actionFailure}</p>
          <button type="button" className="admin-button admin-button--secondary" onClick={() => setActionFailure(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {overview ? (
        <>
          <ConnectionOperationsSummary connection={overview.connection} />
          <ProviderSourceOperationsLedger
            sources={overview.sources}
            canOperate={canOperate}
            pendingKey={pendingKey}
            onCommand={(source, command) => { void operate(source, command); }}
          />
        </>
      ) : null}
    </div>
  );
}
