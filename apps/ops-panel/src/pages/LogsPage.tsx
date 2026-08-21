import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PanelPageHeader } from "../components/PanelShell.tsx";
import { LogFilterBar } from "../components/logs/LogFilterBar.tsx";
import { LogSourceRail } from "../components/logs/LogSourceRail.tsx";
import { LogToolbar } from "../components/logs/LogToolbar.tsx";
import { LogViewport } from "../components/logs/LogViewport.tsx";
import { ShortcutHelpDialog } from "../components/logs/ShortcutHelpDialog.tsx";
import { useLogFilterActions } from "../hooks/useLogFilterActions.ts";
import { useLogPreferences } from "../hooks/useLogPreferences.ts";
import { useLogSources } from "../hooks/useLogSources.ts";
import { useLogStream } from "../hooks/useLogStream.ts";
import { usePanelViewState } from "../hooks/usePanelViewState.ts";
import { useServiceRail } from "../hooks/useServiceRail.ts";
import { useShortcutRegistry, useShortcuts } from "../hooks/useShortcuts.ts";
import { compileFilter, ERRORS_PRESET } from "../logs/filter.ts";
import { createLineFactsCache } from "../logs/line-facts.ts";
import { logShortcutBindings } from "../logs/log-shortcuts.ts";
import { buildLogView } from "../logs/log-view.ts";

/**
 * The live log surface.
 *
 * Everything here reads one buffer fed by one connection. Which services are
 * shown, what matches, how lines are grouped and coloured — all of it is applied
 * to that buffer on the way to the screen, never by asking the server for
 * something different. That is what makes filtering instant and reversible, and
 * what lets a shared link reproduce the view without replaying anything.
 *
 * This module composes; it decides almost nothing. The filter semantics, the
 * grouping, the rail's arithmetic, and the URL codec all live in framework-free
 * modules beside it, so the page can be read as an assembly and the reasoning
 * can be tested without a browser.
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

  const stream = useLogStream({ onLines: rail.observe });
  const { buffer, version, paused, setPaused, setFollowing } = stream;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [helpOpen, setHelpOpen] = useState(false);
  // The element itself rather than a ref: the shortcut that focuses it is built
  // during render, and a callback ref keeps that out of ref territory entirely.
  const [filterInput, setFilterInput] = useState<HTMLInputElement | null>(null);

  const actions = useLogFilterActions(filter, view.setFilter, settings.rememberSearch);
  const compiled = useMemo(() => compileFilter(filter), [filter]);

  const isVisible = useCallback(
    (service: string) =>
      focusedService === null
        ? !settings.hidden.has(service)
        : service === focusedService,
    [focusedService, settings.hidden],
  );

  const { items, groups, matched, total } = useMemo(
    () => buildLogView({ rows: buffer.rows(), isVisible, filter: compiled, facts, expanded }),
    // `version` is the signal that the (mutable) row array changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffer, compiled, expanded, facts, isVisible, version],
  );

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

  const copyVisible = useCallback(() => {
    // Whole groups, not the rendered rows: a folded stack trace copies as the
    // event it is rather than as its first line.
    const text = groups
      .flatMap((group) => [group.head, ...group.members])
      .map((row) => facts(row).plainText)
      .join("\n");
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopyState("failed");
      return;
    }
    clipboard.writeText(text).then(
      () => setCopyState("copied"),
      () => setCopyState("failed"),
    );
  }, [facts, groups]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [copyState]);

  const focusFilter = useCallback(() => filterInput?.focus(), [filterInput]);
  const dismiss = useCallback(() => {
    setHelpOpen(false);
    filterInput?.blur();
  }, [filterInput]);

  // The rail is rebuilt on every clock tick, so the *names* are derived through
  // a value that only changes when a service appears or disappears. Without it
  // the bindings would be re-registered twice a second, shuffling the order that
  // later surfaces (admin-tools/012) register into.
  const serviceList = rail.entries.map((entry) => entry.service).join("\n");
  const serviceNames = useMemo(
    () => (serviceList === "" ? [] : serviceList.split("\n")),
    [serviceList],
  );

  const { updatePreferences, preferences } = settings;
  const registry = useShortcutRegistry();
  const bindings = useMemo(
    () =>
      logShortcutBindings({
        services: serviceNames,
        focusedService,
        focusFilter,
        togglePause: () => setPaused(!paused),
        jumpToLive: () => setFollowing(true),
        focusService: setService,
        toggleWrap: () => updatePreferences({ wrap: !preferences.wrap }),
        openHelp: () => setHelpOpen(true),
        dismiss,
      }),
    [
      dismiss,
      focusFilter,
      focusedService,
      paused,
      preferences.wrap,
      serviceNames,
      setFollowing,
      setPaused,
      setService,
      updatePreferences,
    ],
  );
  useShortcuts(registry, bindings);

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
        preferences={preferences}
        onPreferenceChange={updatePreferences}
        paused={paused}
        onPausedChange={setPaused}
        heldCount={stream.heldCount}
        bufferedCount={buffer.size()}
        onCopyVisible={copyVisible}
        copyState={copyState}
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
            highlight={compiled.highlight}
            onToggleGroup={toggleGroup}
            emptyMessage={
              compiled.active && buffer.size() > 0
                ? "No line in the buffer matches this filter."
                : rail.entries.length === 0
                  ? `No service is writing to ${logDirectory || "the log directory"} yet.`
                  : "Waiting for output. Nothing has been written since the panel attached."
            }
          />

          {stream.following ? null : (
            <button
              type="button"
              className="panel-log-pill"
              onClick={() => setFollowing(true)}
            >
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
        Showing the last {stream.windowLines} lines per service on attach.{" "}
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
