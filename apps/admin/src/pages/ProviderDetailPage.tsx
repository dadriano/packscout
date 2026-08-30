import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  importRunDetailPath,
  type ProviderSourceDiagnosticFilter,
  type ProviderSourceDiagnosticHistory,
  type ProviderSourceOperationsDetail,
  type ProviderSourceOperationsSource,
} from "@packscout/contracts";
import { Link, useParams } from "react-router-dom";
import { AdminApiError } from "../api/client";
import { requestManualImport } from "../api/import-operations";
import {
  getProviderSourceDiagnostics,
  getProviderSourceOperationsDetail,
} from "../api/provider-source-operations";
import {
  commandProviderSource,
  reviseProviderSourceInterval,
} from "../api/provider-sources";
import { EmptyState } from "../components/EmptyState";
import { SourceDiagnosticFeed } from "../components/operations/SourceDiagnosticFeed";
import {
  ConnectionOperationsSummary,
  ProviderSourceOperationsLedger,
  sourceOperationalLabel,
  type SourceOperationCommand,
} from "../components/operations/SourceOperationsViews";
import { dateTime, humanize, insertRevisionCounts, interval } from "../components/operations/OperationStatus";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSession } from "../providers/session";
import { useToast } from "../providers/toast";

const REFRESH_INTERVAL_MS = 5_000;

function readError(error: unknown, subject: "detail" | "diagnostics"): string {
  const fallback = subject === "detail"
    ? "Processor detail is temporarily unavailable. Prior safe evidence remains visible."
    : "Recent diagnostics are temporarily unavailable.";
  if (!(error instanceof AdminApiError)) return fallback;
  if (error.status === 403) {
    return "Your role no longer permits access to this provider source.";
  }
  if (error.status === 404) {
    return "This provider does not have a current registered source.";
  }
  if (error.status === 429) {
    return "Too many operation requests. Display refresh is waiting before it tries again.";
  }
  if (error.code === "INVALID_DIAGNOSTIC_CURSOR") {
    return "Older diagnostic history changed or expired. Reload the current bounded history.";
  }
  if (error.code === "SOURCE_OPERATIONS_UNAVAILABLE") return fallback;
  return error.message || fallback;
}

function mutationError(error: unknown): string {
  if (!(error instanceof AdminApiError)) {
    return "The selected provider command could not be completed. Current evidence and form values remain unchanged.";
  }
  if (error.status === 403) {
    return "Your role cannot perform this command. The selected provider was not changed.";
  }
  if (error.code === "SOURCE_CONFLICT" || error.code === "SOURCE_REVISION_CONFLICT") {
    return "This source or schedule changed in another session. Refresh before using its current revision.";
  }
  if (error.code === "SOURCE_DEPENDENCY_REQUIRED") {
    return "The shared connection must recover before this selected provider can continue.";
  }
  if (error.code === "SOURCE_TEST_REQUIRED") {
    return "A current successful test is required before this source can continue.";
  }
  return error.message || "The selected provider command could not be completed.";
}

function milliseconds(value: number): string {
  const seconds = Math.floor(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type DiagnosticEvent = ProviderSourceDiagnosticHistory["events"][number];

function sameDiagnosticEvent(a: DiagnosticEvent, b: DiagnosticEvent): boolean {
  return a.occurredAt === b.occurredAt &&
    a.scope === b.scope &&
    a.eventKind === b.eventKind &&
    a.safeCode === b.safeCode;
}

function mergeRefreshedDiagnostics(
  current: readonly ProviderSourceDiagnosticHistory[],
  refreshed: ProviderSourceDiagnosticHistory,
): ProviderSourceDiagnosticHistory[] {
  // Older pages are keyset-anchored strictly below the previous newest page's
  // last event. Keep them only while the refreshed newest page still contains
  // that anchor; otherwise new events slid the window and the stitched feed
  // would silently skip events, so drop the stale older pages instead.
  const anchor = current[0]?.events.at(-1);
  const connected = anchor !== undefined &&
    refreshed.events.some((event) => sameDiagnosticEvent(event, anchor));
  return connected ? [refreshed, ...current.slice(1)] : [refreshed];
}

export function ProviderDetailPage() {
  const { providerId = "" } = useParams();
  const { status } = useSession();
  const { showToast } = useToast();
  const canOperate = status.phase === "authenticated" &&
    status.session.permissions.includes("imports:start");
  const canConfigure = status.phase === "authenticated" &&
    status.session.permissions.includes("providers:manage");
  const [detail, setDetail] = useState<ProviderSourceOperationsDetail | null>(null);
  const [diagnosticPages, setDiagnosticPages] = useState<ProviderSourceDiagnosticHistory[]>([]);
  const [diagnosticFilter, setDiagnosticFilter] = useState<ProviderSourceDiagnosticFilter>({});
  const [loading, setLoading] = useState(true);
  const [diagnosticLoading, setDiagnosticLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [detailFailure, setDetailFailure] = useState<string | null>(null);
  const [diagnosticFailure, setDiagnosticFailure] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [displayPaused, setDisplayPaused] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [intervalDraft, setIntervalDraft] = useState("");
  const priorOperationalState = useRef<string | null>(null);
  const intervalOwner = useRef<string | null>(null);
  const diagnosticGeneration = useRef(0);
  useDocumentTitle(detail?.source.displayName ?? "Provider Processor");

  const refresh = useCallback(() => {
    setRefreshIndex((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    void getProviderSourceOperationsDetail(providerId)
      .then((result) => {
        if (!active) return;
        const nextState = sourceOperationalLabel(result.source);
        if (priorOperationalState.current && priorOperationalState.current !== nextState) {
          setAnnouncement(`${result.source.displayName} changed from ${priorOperationalState.current} to ${nextState}.`);
        }
        priorOperationalState.current = nextState;
        if (result.source.source && intervalOwner.current !== result.source.source.sourceInstanceId) {
          intervalOwner.current = result.source.source.sourceInstanceId;
          setIntervalDraft(String(result.source.schedule?.intervalSeconds ?? ""));
        }
        setDetail(result);
        setDetailFailure(null);
      })
      .catch((error: unknown) => {
        if (active) setDetailFailure(readError(error, "detail"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [providerId, refreshIndex]);

  useEffect(() => {
    let active = true;
    void getProviderSourceDiagnostics(providerId, {
      filter: diagnosticFilter,
      limit: 25,
    })
      .then((result) => {
        if (!active) return;
        setDiagnosticPages((current) => mergeRefreshedDiagnostics(current, result));
        setDiagnosticFailure(null);
      })
      .catch((error: unknown) => {
        if (active) setDiagnosticFailure(readError(error, "diagnostics"));
      })
      .finally(() => {
        if (active) setDiagnosticLoading(false);
      });
    return () => { active = false; };
  }, [
    providerId,
    refreshIndex,
    diagnosticFilter,
  ]);

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

  useEffect(() => () => {
    // Invalidate any in-flight load-older request once this page unmounts.
    diagnosticGeneration.current += 1;
  }, []);

  function changeFilter(next: ProviderSourceDiagnosticFilter): void {
    diagnosticGeneration.current += 1;
    setDiagnosticPages([]);
    setDiagnosticFailure(null);
    setDiagnosticLoading(true);
    setDiagnosticFilter(next);
    setAnnouncement("Diagnostic filters updated.");
  }

  async function loadOlder(): Promise<void> {
    const cursor = diagnosticPages.at(-1)?.nextCursor;
    if (!cursor) return;
    const generation = diagnosticGeneration.current;
    setLoadingOlder(true);
    setDiagnosticFailure(null);
    try {
      const page = await getProviderSourceDiagnostics(providerId, {
        filter: diagnosticFilter,
        cursor,
        limit: 25,
      });
      // Discard responses that resolved after the filter changed or the page
      // unmounted; append only while the requested cursor still ends the feed.
      if (generation !== diagnosticGeneration.current) return;
      setDiagnosticPages((current) => current.at(-1)?.nextCursor === cursor
        ? [...current, page]
        : current);
      setAnnouncement(page.history.state === "expired"
        ? page.history.message
        : `${page.events.length} older diagnostic events loaded.`);
    } catch (error) {
      if (generation !== diagnosticGeneration.current) return;
      setDiagnosticFailure(readError(error, "diagnostics"));
    } finally {
      setLoadingOlder(false);
    }
  }

  async function operate(
    source: ProviderSourceOperationsSource,
    command: SourceOperationCommand,
  ): Promise<void> {
    if (!source.source) return;
    setPendingKey(`${source.providerId}:${command}`);
    setActionFailure(null);
    try {
      let message: string;
      if (command === "run") {
        const result = await requestManualImport(source.providerId, source.source.sourceRevisionId);
        message = result.outcome === "coalesced"
          ? `${source.displayName}: request coalesced into the existing ${result.run.state} run.`
          : `${source.displayName}: manual run created and queued.`;
      } else {
        const result = await commandProviderSource(
          source.providerId,
          source.source.sourceInstanceId,
          command,
          source.source.sourceRevisionId,
        );
        message = result.state === "pause_requested"
          ? `${source.displayName}: pause requested; the current page may commit.`
          : result.state === "paused"
            ? `${source.displayName}: paused before another page began.`
            : `${source.displayName}: resumed from ${source.cursor?.resumeLabel ?? "the committed cursor"}.`;
      }
      setAnnouncement(message);
      showToast(message, "success");
      refresh();
    } catch (error) {
      const message = mutationError(error);
      setActionFailure(message);
      setAnnouncement(message);
    } finally {
      setPendingKey(null);
    }
  }

  async function requestSourceTest(): Promise<void> {
    const source = detail?.source.source;
    if (!source) return;
    setPendingKey(`${detail.source.providerId}:test`);
    setActionFailure(null);
    try {
      const result = await commandProviderSource(
        detail.source.providerId,
        source.sourceInstanceId,
        "test",
        source.sourceRevisionId,
      );
      const message = `${detail.source.displayName}: source test ${result.state ?? "pending"}.`;
      setAnnouncement(message);
      showToast(message, "success");
      refresh();
    } catch (error) {
      setActionFailure(mutationError(error));
    } finally {
      setPendingKey(null);
    }
  }

  async function reviseInterval(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const source = detail?.source.source;
    const schedule = detail?.source.schedule;
    if (!source || !schedule) return;
    const seconds = Number(intervalDraft);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) {
      setActionFailure("Enter an interval from 60 through 86,400 seconds. Your value remains available to edit.");
      return;
    }
    setPendingKey(`${detail.source.providerId}:interval`);
    setActionFailure(null);
    try {
      await reviseProviderSourceInterval(
        detail.source.providerId,
        source.sourceInstanceId,
        {
          expectedSourceRevisionId: source.sourceRevisionId,
          expectedScheduleRevisionId: schedule.scheduleRevisionId,
          intervalSeconds: seconds,
        },
      );
      const message = `${detail.source.displayName}: interval changed to ${interval(seconds)}; current work and cursor were preserved.`;
      setAnnouncement(message);
      showToast(message, "success");
      refresh();
    } catch (error) {
      setActionFailure(mutationError(error));
    } finally {
      setPendingKey(null);
    }
  }

  if (loading && !detail) {
    return <div className="ops-loading" aria-busy="true">Loading current provider-source evidence…</div>;
  }
  if (!detail) {
    return (
      <div className="ops-error" role="alert">
        <p>{detailFailure ?? "Provider source not found."}</p>
        <Link className="admin-button admin-button-secondary" to="/operations">Return to operations</Link>
      </div>
    );
  }

  const source = detail.source;
  const sourceRevision = source.source;
  const sourceTestAvailable = sourceRevision?.lifecycle === "draft" ||
    sourceRevision?.lifecycle === "disabled";
  const sourceActionRequired = source.processor?.activity === "action_required";
  const staleDisplay = displayPaused || detailFailure !== null || diagnosticFailure !== null;
  return (
    <div className="admin-page source-operations-page">
      <PageHeader
        eyebrow={`Platform processor / ${humanize(source.provider)}`}
        title={source.displayName}
        description={sourceRevision
          ? `${sourceRevision.sourceTypeKey} · adapter ${sourceRevision.sourceAdapterVersion} · normalized contract ${sourceRevision.normalizedContractVersion}`
          : "No current source revision"}
        actions={
          <>
            <Link className="admin-button admin-button-secondary" to="/operations">All processors</Link>
            {canConfigure ? <Link className="admin-button admin-button-secondary" to="/source-configuration">Configuration</Link> : null}
            <button
              type="button"
              className="admin-button admin-button-secondary"
              aria-pressed={displayPaused}
              onClick={() => {
                setDisplayPaused((paused) => {
                  const next = !paused;
                  setAnnouncement(next
                    ? "Display refresh paused. This provider continues ingesting."
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

      <p className="admin-visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>
      <section className="source-refresh-strip" aria-label="Display refresh status">
        <div>
          <StatusBadge label={staleDisplay ? "Stale display" : "Live display"} tone={staleDisplay ? "pending" : "ready"} />
          <span>{displayPaused
            ? "Display paused only; ingestion, retries, leases, and scheduling continue."
            : `Visible-page refresh every 5 seconds · evidence time ${dateTime(detail.refreshedAt)}`}</span>
        </div>
        <span>{canConfigure ? "Administrator configuration enabled" : canOperate ? "Data operator · operation controls only" : "Read-only access"}</span>
      </section>
      {detailFailure ? <div className="ops-error" role="alert"><p>{detailFailure}</p><button type="button" className="admin-button admin-button-secondary" onClick={refresh}>Refresh current state</button></div> : null}
      {actionFailure ? <div className="ops-error" role="alert"><p>{actionFailure}</p><button type="button" className="admin-button admin-button-secondary" onClick={() => setActionFailure(null)}>Dismiss</button></div> : null}

      <ConnectionOperationsSummary
        connection={detail.connection}
        mode={detail.connection === null ? "none" : "shared"}
      />
      <ProviderSourceOperationsLedger
        sources={[source]}
        canOperate={canOperate}
        pendingKey={pendingKey}
        onCommand={(selected, command) => { void operate(selected, command); }}
      />

      {!canConfigure ? (
        <aside className="source-operator-boundary">
          <strong>{canOperate ? "Operation access, not configuration access" : "Read-only provider evidence"}</strong>
          <p>{canOperate
            ? "You may run, pause, resume, and retry authorized quarantine records. Credential, binding, interval, activation, disable, and cursor controls remain administrator-only."
            : "Your role can inspect current safe processor, run, page, and diagnostic evidence but cannot operate or configure this source."}</p>
        </aside>
      ) : (
        <section className="source-admin-inline" aria-labelledby="source-admin-inline-title">
          <div>
            <span className="admin-kicker">Selected provider only</span>
            <h2 id="source-admin-inline-title">Test and timing</h2>
            <p>These controls affect {source.displayName} only. Shared credential and destructive lifecycle controls remain in Source configuration.</p>
            {sourceActionRequired ? (
              <aside className="admin-note admin-note-warning source-recovery-guidance" role="note">
                <strong>Disable → Test source → Activate paused → Resume.</strong>{" "}
                Correct the reported cause before testing. Run now, Test source while active, and Resume cannot clear Action required.
              </aside>
            ) : null}
          </div>
          <div className="source-admin-inline__actions">
            {sourceTestAvailable ? (
              <button type="button" className="admin-button admin-button-secondary" disabled={pendingKey !== null} onClick={() => { void requestSourceTest(); }}>
                {pendingKey?.endsWith(":test") ? "Requesting test…" : "Test source"}
              </button>
            ) : null}
            <form onSubmit={(event) => { void reviseInterval(event); }}>
              <div className="admin-field">
                <label htmlFor="provider-source-interval">Interval seconds</label>
                <input id="provider-source-interval" type="number" min="60" max="86400" required value={intervalDraft} onChange={(event) => setIntervalDraft(event.target.value)} />
              </div>
              <button type="submit" className="admin-button admin-button-secondary" disabled={pendingKey !== null}>
                {pendingKey?.endsWith(":interval") ? "Saving timing…" : "Save timing"}
              </button>
            </form>
          </div>
        </section>
      )}

      {sourceRevision ? (
        <div className="source-detail-grid">
          <section className="source-detail-panel" aria-labelledby="source-contract-title">
            <header><span className="admin-kicker">Immutable source ownership</span><h2 id="source-contract-title">Source contract</h2></header>
            <dl>
              <div><dt>Source type</dt><dd>{sourceRevision.sourceTypeKey}</dd></div>
              <div><dt>Adapter revision</dt><dd>{sourceRevision.sourceAdapterVersion}</dd></div>
              <div><dt>Normalized contract</dt><dd>{sourceRevision.normalizedContractVersion}</dd></div>
              <div><dt>Mapper</dt><dd>{sourceRevision.mapperKey} @ {sourceRevision.mapperVersion}</dd></div>
              <div><dt>Identity namespace</dt><dd>{sourceRevision.identityNamespaceKey}</dd></div>
              <div><dt>Record-ID scopes</dt><dd>{sourceRevision.recordIdScopes.join(" · ")}</dd></div>
              <div><dt>Capabilities</dt><dd>{detail.connection ? Object.entries(detail.connection.sourceType.capabilities).filter(([, enabled]) => enabled).map(([name]) => humanize(name)).join(" · ") : "Unavailable"}</dd></div>
            </dl>
          </section>
          <section className="source-detail-panel" aria-labelledby="source-cursor-title">
            <header><span className="admin-kicker">Durable committed position</span><h2 id="source-cursor-title">Cursor and schedule</h2></header>
            <dl>
              <div><dt>Source instance</dt><dd>{sourceRevision.sourceInstanceId}</dd></div>
              <div><dt>Generation</dt><dd>{source.cursor?.generation ?? "Not established"}</dd></div>
              <div><dt>Safe fingerprint</dt><dd className="ops-cursor">{source.cursor?.fingerprint ?? "Feed start"}</dd></div>
              <div><dt>Resume</dt><dd>{source.cursor?.resumeLabel ?? "Feed start"}</dd></div>
              <div><dt>Interval / grace</dt><dd>{source.schedule ? `${interval(source.schedule.intervalSeconds)} / ${interval(source.schedule.freshnessGraceSeconds)}` : "Not scheduled"}</dd></div>
              <div><dt>Next due</dt><dd>{dateTime(source.schedule?.nextDueAt ?? null)}</dd></div>
            </dl>
          </section>
          <section className="source-detail-panel" aria-labelledby="source-config-summary-title">
            <header><span className="admin-kicker">Adapter-validated safe summary</span><h2 id="source-config-summary-title">Masked configuration</h2></header>
            <dl>{sourceRevision.configuration.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}{field.masked ? " · masked" : ""}</dd></div>)}</dl>
          </section>
          <section className="source-detail-panel" aria-labelledby="source-test-title">
            <header><span className="admin-kicker">Current revision evidence</span><h2 id="source-test-title">Source test and quality</h2></header>
            <dl>
              <div><dt>Test state</dt><dd>{detail.sourceTest ? humanize(detail.sourceTest.state) : "Not recorded"}</dd></div>
              <div><dt>Test outcome</dt><dd>{detail.sourceTest?.outcome ? humanize(detail.sourceTest.outcome) : "Not recorded"}</dd></div>
              <div><dt>Safe code</dt><dd>{detail.sourceTest?.safeCode ?? "None"}</dd></div>
              <div><dt>Tested</dt><dd>{dateTime(detail.sourceTest?.testedAt ?? null)}</dd></div>
              <div><dt>Quality</dt><dd>{humanize(source.quality.state)} · {source.quality.consecutiveFailures} consecutive failures</dd></div>
              <div><dt>Quarantine</dt><dd><Link to={`/quarantine?providerId=${source.providerId}&state=open`}>{source.progress.openQuarantine} open records</Link></dd></div>
            </dl>
          </section>
        </div>
      ) : null}

      <section className="source-run-history" aria-labelledby="source-run-history-title">
        <header className="admin-section-header"><div><span className="admin-kicker">Selected source only</span><h2 id="source-run-history-title">Run history</h2></div><Link to={`/runs?providerId=${source.providerId}`}>All runs</Link></header>
        {detail.runHistory.length === 0 ? <EmptyState title="No runs recorded" description="Run now or wait for the next scheduled interval. A queued run may wait for worker or connection capacity." /> : <div className="source-run-history__rows">{detail.runHistory.map((run) => <article key={run.id}><div><Link to={importRunDetailPath({ providerId: detail.source.providerId, runId: run.id })}>{humanize(run.trigger)} run</Link><span>{dateTime(run.requestedAt)}</span></div><StatusBadge label={humanize(run.state)} tone={run.state === "failed" ? "danger" : run.state === "succeeded" ? "ready" : "pending"} /><dl><div><dt>Progress</dt><dd>{dateTime(run.lastProgressAt)}</dd></div><div><dt>Elapsed</dt><dd>{run.startedAt ? milliseconds(Math.max(0, Date.parse(run.finishedAt ?? detail.refreshedAt) - Date.parse(run.startedAt))) : "Not started"}</dd></div><div><dt>Provider head</dt><dd>{run.reachedHead ? "Reached" : "Not reached"}</dd></div><div><dt>Failure</dt><dd>{run.failureCode ?? "None"}</dd></div></dl></article>)}</div>}
      </section>

      <section className="source-page-progress" aria-labelledby="source-page-progress-title">
        <header className="admin-section-header"><div><span className="admin-kicker">Atomic committed pages</span><h2 id="source-page-progress-title">Page progress</h2></div><span className="admin-section-count">{detail.pageProgress.length} shown</span></header>
        {detail.pageProgress.length === 0 ? <EmptyState title="No committed pages" description="A queued run, no live worker, or a failure before commit has no page progress." /> : <div className="source-page-progress__rows">{detail.pageProgress.map((page) => <article key={`${page.runId}:${page.pageNumber}`}><header><strong>Page {page.pageNumber}</strong><Link to={importRunDetailPath({ providerId: detail.source.providerId, runId: page.runId })}>Open run</Link><time dateTime={page.committedAt}>{dateTime(page.committedAt)}</time></header><dl><div><dt>Streams</dt><dd>{page.records.catalog} catalog · {page.records.pulls} pulls · {page.records.trades} trades · {page.records.total} total</dd></div><div><dt>Dispositions</dt><dd>{insertRevisionCounts(page.dispositions.inserted, page.dispositions.revised)} · {page.dispositions.duplicate} duplicate · {page.dispositions.quarantined} quarantined</dd></div><div><dt>Continuation</dt><dd>{page.continuation ? humanize(page.continuation.kind) : "Provider head"}</dd></div><div><dt>Cursor</dt><dd className="ops-cursor">{page.cursorFingerprint ?? "Not attached"}</dd></div></dl></article>)}</div>}
      </section>

      <SourceDiagnosticFeed
        pages={diagnosticPages}
        filter={diagnosticFilter}
        runs={detail.runHistory}
        loading={diagnosticLoading}
        loadingOlder={loadingOlder}
        error={diagnosticFailure}
        onFilterChange={changeFilter}
        onLoadOlder={() => { void loadOlder(); }}
        onRetry={refresh}
      />
    </div>
  );
}
