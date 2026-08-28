import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_LOG_DISPLAY_PREFERENCES,
  readLogDisplayPreferences,
  writeLogDisplayPreferences,
  type LogDisplayPreferences,
} from "../logs/display-preferences.ts";
import type { FilterTerm } from "../logs/filter.ts";
import {
  readHiddenServices,
  resetPanelPreferences,
  writeHiddenServices,
  type MutablePreferenceStore,
} from "../logs/panel-preferences.ts";
import {
  readRecentSearches,
  rememberRecentSearch,
  type RecentSearch,
} from "../logs/recent-searches.ts";

/**
 * Everything the panel remembers, owned in one place.
 *
 * Storage access lives here and nowhere else, which is what makes the reset
 * trustworthy: there is no second component quietly writing a key the reset does
 * not know about.
 *
 * The reset is armed rather than confirmed through a dialog. It discards a
 * session's worth of accumulated setup, so it should take two presses — and the
 * second press should be able to say what it is about to throw away, which a
 * modal cannot do as well as the button itself.
 */

/** How long the armed reset waits before deciding it was a misclick. */
const RESET_ARMED_MS = 6_000;

function browserStorage(): MutablePreferenceStore | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export interface LogPreferencesController {
  preferences: LogDisplayPreferences;
  updatePreferences: (patch: Partial<LogDisplayPreferences>) => void;
  hidden: ReadonlySet<string>;
  toggleService: (service: string) => void;
  recentSearches: readonly RecentSearch[];
  rememberSearch: (term: FilterTerm) => void;
  /** True once the reset has been asked for and is awaiting confirmation. */
  resetArmed: boolean;
  requestReset: () => void;
}

export function useLogPreferences(): LogPreferencesController {
  const [preferences, setPreferences] = useState<LogDisplayPreferences>(() =>
    readLogDisplayPreferences(browserStorage()),
  );
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(readHiddenServices(browserStorage())),
  );
  const [recentSearches, setRecentSearches] = useState<readonly RecentSearch[]>(() =>
    readRecentSearches(browserStorage()),
  );
  const [resetArmed, setResetArmed] = useState(false);

  const updatePreferences = useCallback((patch: Partial<LogDisplayPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      writeLogDisplayPreferences(browserStorage(), next);
      return next;
    });
  }, []);

  const toggleService = useCallback((service: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(service)) next.delete(service);
      else next.add(service);
      writeHiddenServices(browserStorage(), next);
      return next;
    });
  }, []);

  const rememberSearch = useCallback((term: FilterTerm) => {
    setRecentSearches(rememberRecentSearch(browserStorage(), term));
  }, []);

  const requestReset = useCallback(() => {
    setResetArmed((armed) => {
      if (!armed) return true;
      resetPanelPreferences(browserStorage());
      setPreferences({ ...DEFAULT_LOG_DISPLAY_PREFERENCES });
      setHidden(new Set());
      setRecentSearches([]);
      return false;
    });
  }, []);

  useEffect(() => {
    if (!resetArmed) return;
    const timer = setTimeout(() => setResetArmed(false), RESET_ARMED_MS);
    return () => clearTimeout(timer);
  }, [resetArmed]);

  return {
    preferences,
    updatePreferences,
    hidden,
    toggleService,
    recentSearches,
    rememberSearch,
    resetArmed,
    requestReset,
  };
}
