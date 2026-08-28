import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { LogLineRecord } from "../api/panel-types.ts";
import { PanelPageHeader } from "../components/PanelShell.tsx";
import { LogFilterBar } from "../components/logs/LogFilterBar.tsx";
import { LogHistoryBar } from "../components/logs/LogHistoryBar.tsx";
import { LogSearchPanel } from "../components/logs/LogSearchPanel.tsx";
import { LogSourceRail } from "../components/logs/LogSourceRail.tsx";
import { LogToolbar } from "../components/logs/LogToolbar.tsx";
import { LogViewport } from "../components/logs/LogViewport.tsx";
import { ShortcutHelpDialog } from "../components/logs/ShortcutHelpDialog.tsx";
import { useHistorySearch } from "../hooks/useHistorySearch.ts";
import { useLogExport } from "../hooks/useLogExport.ts";
import { useLogFilterActions } from "../hooks/useLogFilterActions.ts";
import { useLogHistory } from "../hooks/useLogHistory.ts";
import { useLogPreferences } from "../hooks/useLogPreferences.ts";
import { useLogSources } from "../hooks/useLogSources.ts";
import { useLogStream } from "../hooks/useLogStream.ts";
import { usePanelViewState } from "../hooks/usePanelViewState.ts";
import { useServiceRail } from "../hooks/useServiceRail.ts";
import { useShortcutRegistry, useShortcuts } from "../hooks/useShortcuts.ts";
import { compileFilter, EMPTY_FILTER, ERRORS_PRESET } from "../logs/filter.ts";
import { createLineFactsCache } from "../logs/line-facts.ts";
import { logShortcutBindings } from "../logs/log-shortcuts.ts";
import { buildLogView } from "../logs/log-view.ts";

/**
 * The log surface: live output, its past, and a way to take either away.
 *
 * Everything here reads one buffer fed by one connection. Which services are
 * shown, what matches, how lines are grouped and coloured — all of it is applied
 * to that buffer on the way to the screen, never by asking the server for
 * something different. That is what makes filtering instant and reversible, and
 * what lets a shared link reproduce the view without replaying anything.
 *
 * History is the one thing the server must be asked for, because the buffer is
 * bounded and yesterday is not in it. Those reads are bounded too, and they
 * produce records with the same byte-derived identity the live tail produces,
 * so prepended history and live output merge into one timeline rather than two
 * that have to be reconciled.
 *
 * This module composes; it decides almost nothing. The filter semantics, the
 * grouping, the paging cursors, the search accounting, and the URL codec all
 * live in framework-free modules beside it, so the page can be read as an
 * assembly and the reasoning can be tested without a browser.
 */

export function LogsPage() {
  const { sources, logDirectory } = useLogSources();
  const view = usePanelViewState();
  const filter = view.state.filter;
  const focusedService = view.state.service;

  const factsCache = useMemo(() => createLineFactsCache(), []);
  const facts = factsCache.facts;

  const settings = useLogPreferences();
  const rail = useServiceRail({
    sources,
    hidden: settings.hidden,
    focusedService,
    facts,
  });

  // History has to be told about live arrivals to notice a rotation, and it is
  // built from the stream it would be observing. A ref breaks the knot without
  // making the connection depend on a callback that changes every render.
  const liveObserver = useRef<((lines: readonly LogLineRecord[]) => void) | null>(
    null,
  );
  const railObserve = rail.observe;
  const onLines = useCallback(
    (lines: readonly LogLineRecord[]) => {
      railObserve(lines);
      liveObserver.current?.(lines);
    },
    [railObserve],
  );

  const stream = useLogStream({ onLines });
  const { buffer, version, paused, setPaused, setFollowing } = stream;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [helpOpen, setHelpOpen] = useState(false);
  // The element itself rather than a ref: the shortcut that focuses it is built
  // during render, and a callback ref keeps that out of ref territory entirely.
  const [filterInput, setFilterInput] = useState<HTMLInputElement | null>(null);

  const actions = useLogFilterActions(filter, view.setFilter, settings.rememberSearch);
  const compiled = useMemo(() => compileFilter(filter), [filter]);
  const unfiltered = useMemo(() => compileFilter(EMPTY_FILTER), []);

  const isVisible = useCallback(
    (service: string) =>
      focusedService === null
        ? !settings.hidden.has(service)
        : service === focusedService,
    [focusedService, settings.hidden],
  );

  // The rail is rebuilt on every clock tick, so the *names* are derived through
  // a value that only changes when a service appears or disappears. Without it
  // the bindings would be re-registered twice a second, shuffling the order the
  // help dialog lists them in.
  const serviceList = rail.entries.map((entry) => entry.service).join("\n");
  const serviceNames = useMemo(
    () => (serviceList === "" ? [] : serviceList.split("\n")),
    [serviceList],
  );
  const visibleServices = useMemo(
    () => serviceNames.filter(isVisible),
    [isVisible, serviceNames],
  );

  const history = useLogHistory({
    buffer,
    services: visibleServices,
    isVisible,
    following: stream.following,
    setFollowing,
    setPaused,
    refreshWindows: stream.refreshWindows,
    createMarker: stream.createMarker,
    sync: stream.sync,
  });
  const observeLive = history.observeLive;
  useEffect(() => {
    liveObserver.current = observeLive;
    return () => {
      liveObserver.current = null;
    };
  }, [observeLive]);

  const search = useHistorySearch({ filter: compiled, services: visibleServices });

  // Context around a search result is deliberately unfiltered: the point of
  // opening a match is to read what surrounds it, and the filter that found it
  // would hide most of that.
  const { items, groups, matched, total } = useMemo(
    () =>
      buildLogView({
        rows: buffer.rows(),
        isVisible,
        filter: history.unfiltered ? unfiltered : compiled,
        facts,
        expanded,
      }),
    // `version` is the signal that the (mutable) row array changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffer, compiled, expanded, facts, history.unfiltered, isVisible, unfiltered, version],
  );

  const exports = useLogExport({
    groups,
    facts,
    scope: focusedService,
    filterActive: compiled.active,
    matched,
    total,
  });

  const setFilter = view.setFilter;
  const setService = view.setService;
  const showServiceErrors = useCallback(
    (service: string) => {
      setService(service);
      setFilter((current) => ({ ...current, severities: ERRORS_PRESET }));
    },
    [setFilter, setService],
  );

  const toggleGroup = useCallback((groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const focusFilter = useCallback(() => filterInput?.focus(), [filterInput]);
  const dismiss = useCallback(() => {
    setHelpOpen(false);
    filterInput?.blur();
  }, [filterInput]);

  const detached = history.detached !== null;
  const returnToLive = history.returnToLive;
  const jumpToLive = useCallback(() => {
    if (detached) returnToLive();
    else setFollowing(true);
  }, [detached, returnToLive, setFollowing]);

  const jumpToStart = history.jumpToStart;
  const { updatePreferences, preferences } = settings;
  const registry = useShortcutRegistry();
  const bindings = useMemo(
    () =>
      logShortcutBindings({
        services: serviceNames,
        focusedService,
        focusFilter,
        togglePause: () => setPaused(!paused),
        jumpToLive,
        focusService: setService,
        jumpToStart: () => jumpToStart(focusedService),
        toggleWrap: () => updatePreferences({ wrap: !preferences.wrap }),
        openHelp: () => setHelpOpen(true),
        dismiss,
      }),
    [
      dismiss,
      focusFilter,
      focusedService,
      jumpToLive,
      jumpToStart,
      paused,
      preferences.wrap,
      serviceNames,
      setPaused,
      setService,
      updatePreferences,
    ],
  );
  useShortcuts(registry, bindings);

  const rawSizeBytes =
    sources.find((source) => source.service === focusedService)?.sizeBytes ?? null;

  return (
    <>
      <PanelPageHeader
        eyebrow="Logs"
        title="Live output"
        description="Every PackScout service on this machine, interleaved. Restarts, rotations, and gaps are called out inline rather than papered over."
      />

      {view.notice ? (
        <p className="panel-notice" role="status">
          {view.notice}{" "}
          <button type="button" className="panel-button" onClick={view.dismissNotice}>
            Dismiss
          </button>
        </p>
      ) : null}

      {stream.error ? (
        <p className="panel-notice" role="alert">
          {stream.error}
        </p>
      ) : null}

      <LogToolbar
        status={stream.status}
        following={stream.following}
        browsing={detached}
        preferences={preferences}
        onPreferenceChange={updatePreferences}
        paused={paused}
        onPausedChange={(next) => (detached ? returnToLive() : setPaused(next))}
        heldCount={stream.heldCount}
        bufferedCount={buffer.size()}
        onCopyVisible={exports.copyVisible}
        copyState={exports.copyState}
        onShowShortcuts={() => setHelpOpen(true)}
        resetArmed={settings.resetArmed}
        onResetPreferences={settings.requestReset}
      />

      <LogFilterBar
        draftText={actions.draftText}
        draftFlags={actions.draftFlags}
        onDraftTextChange={actions.setDraftText}
        onDraftFlagsChange={actions.setDraftFlags}
        onCommitDraft={actions.commitDraft}
        terms={filter.terms}
        onRemoveTerm={actions.removeTerm}
        onToggleTermFlag={actions.toggleTermFlag}
        onClearTerms={actions.clearTerms}
        severities={filter.severities}
        onSeveritiesChange={actions.setSeverities}
        compiled={compiled}
        matched={matched}
        total={total}
        recentSearches={settings.recentSearches}
        onUseRecentSearch={actions.useRecentSearch}
        inputRef={setFilterInput}
      />

      <LogHistoryBar
        loading={history.loadingOlder}
        startNotice={history.startNotice}
        detachedNotice={history.detachedNotice}
        detached={detached}
        atEnd={history.detached?.atEnd ?? false}
        focusedService={focusedService}
        rawSizeBytes={rawSizeBytes}
        onJumpToStart={() => jumpToStart(focusedService)}
        onLoadMore={history.loadMoreForward}
        onReturnToLive={returnToLive}
        onExportVisible={exports.exportVisible}
        onDownloadRaw={() => focusedService && exports.downloadRaw(focusedService)}
        downloadState={exports.downloadState}
        downloadError={exports.downloadError}
        error={history.error}
        onDismissError={history.dismissError}
      />

      <LogSearchPanel
        filterActive={compiled.active}
        services={visibleServices}
        running={search.running}
        progress={search.progress}
        outcome={search.outcome}
        onStart={search.start}
        onCancel={search.cancel}
        onClear={search.clear}
        onOpenMatch={history.openContext}
      />

      <div className="panel-log-workspace">
        <LogSourceRail
          entries={rail.entries}
          now={rail.now}
          onToggleService={settings.toggleService}
          onFocusService={setService}
          onShowServiceErrors={showServiceErrors}
          logDirectory={logDirectory}
        />

        <div className="panel-log-frame">
          <LogViewport
            items={items}
            version={version}
            preferences={preferences}
            following={stream.following}
            onFollowingChange={setFollowing}
            onAnchorChange={stream.setAnchor}
            facts={facts}
            highlight={history.unfiltered ? unfiltered.highlight : compiled.highlight}
            onToggleGroup={toggleGroup}
            onCopyRow={exports.copyGroup}
            onReachTop={history.loadOlder}
            focusedId={history.focusedId}
            emptyMessage={
              compiled.active && buffer.size() > 0
                ? "No line in the buffer matches this filter."
                : rail.entries.length === 0
                  ? `No service is writing to ${logDirectory || "the log directory"} yet.`
                  : "Waiting for output. Nothing has been written since the panel attached."
            }
          />

          {stream.following ? null : (
            <button type="button" className="panel-log-pill" onClick={jumpToLive}>
              {stream.pendingCount > 0
                ? `${stream.pendingCount.toLocaleString("en-US")} new ${
                    stream.pendingCount === 1 ? "line" : "lines"
                  } — jump to live`
                : "Jump to live"}
            </button>
          )}
        </div>
      </div>

      <p className="panel-log-footnote">
        Showing the last {stream.windowLines} lines per service on attach; scroll up
        to read further back.{" "}
        <Link to="/logs/sources">Inspect the discovered log files</Link>.
      </p>

      <ShortcutHelpDialog
        open={helpOpen}
        bindings={registry.bindings()}
        onClose={() => setHelpOpen(false)}
      />
    </>
  );
}
