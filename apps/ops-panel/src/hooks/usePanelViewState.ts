import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { FilterSpec } from "../logs/filter.ts";
import {
  decodePanelViewState,
  encodePanelViewState,
  panelHistoryMode,
  type PanelSurface,
  type PanelViewState,
} from "../logs/url-state.ts";

/**
 * The address bar and the view, kept in step in both directions.
 *
 * React state is the source of truth while the panel is open, and the URL is
 * its written form. Decoding on every render instead would be simpler and
 * wrong: chips would be rebuilt — with new identities — on every keystroke,
 * remounting the controls the operator is typing into.
 *
 * A back or forward navigation is the one case where the URL leads, and it
 * arrives as `popstate` — a genuine external event rather than something to be
 * inferred by diffing strings, so returning to an identical view still
 * re-applies it. The re-application is marked so the write-back below stands
 * down instead of bouncing a second entry into the history.
 */

export interface PanelViewController {
  state: PanelViewState;
  /** Set when a pasted link carried a filter that could not be read. */
  notice: string | null;
  dismissNotice: () => void;
  setFilter: (update: FilterSpec | ((current: FilterSpec) => FilterSpec)) => void;
  setService: (service: string | null) => void;
  setSurface: (surface: PanelSurface) => void;
}

export function usePanelViewState(): PanelViewController {
  const location = useLocation();
  const navigate = useNavigate();

  const initial = useMemo(
    () => decodePanelViewState(location.search),
    // Only the view the panel opened with; later reads are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [state, setState] = useState<PanelViewState>(initial.state);
  const [notice, setNotice] = useState<string | null>(initial.notice);
  const previous = useRef<PanelViewState>(initial.state);
  const applyingHistory = useRef(false);

  // Back and forward: the URL leads, and the write-back below stands down.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = () => {
      // Read from the document rather than from the router: `popstate` may
      // reach this listener before the router has re-rendered, and the address
      // bar is already correct either way.
      const decoded = decodePanelViewState(window.location.search);
      applyingHistory.current = true;
      previous.current = decoded.state;
      setState(decoded.state);
      setNotice(decoded.notice);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Everything else: the view leads, and the URL follows it.
  useEffect(() => {
    if (applyingHistory.current) {
      applyingHistory.current = false;
      return;
    }
    const mode = panelHistoryMode(previous.current, state);
    previous.current = state;
    const search = encodePanelViewState(state);
    if (search === location.search || (search === "" && location.search === "")) {
      return;
    }
    navigate(
      { pathname: location.pathname, search },
      { replace: mode === "replace" },
    );
    // The location is read, not depended on: a URL change of its own is either
    // a history navigation, handled above, or another page entirely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const setFilter = useCallback(
    (update: FilterSpec | ((current: FilterSpec) => FilterSpec)) => {
      setState((current) => ({
        ...current,
        filter: typeof update === "function" ? update(current.filter) : update,
      }));
    },
    [],
  );

  const setService = useCallback((service: string | null) => {
    setState((current) =>
      current.service === service ? current : { ...current, service },
    );
  }, []);

  const setSurface = useCallback((surface: PanelSurface) => {
    setState((current) =>
      current.surface === surface ? current : { ...current, surface },
    );
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { state, notice, dismissNotice, setFilter, setService, setSurface };
}
