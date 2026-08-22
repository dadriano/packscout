import {
  LOG_DISPLAY_PREFERENCES_KEY,
  type PreferenceStore,
} from "./display-preferences.ts";
import { RECENT_SEARCHES_KEY } from "./recent-searches.ts";

/**
 * Everything the panel remembers about you, in one place.
 *
 * The panel has no account system by design, so "remember this" means the
 * browser's local storage. That is fine for reading preferences and terrible as
 * a place for state to accumulate unnoticed — which is why every key the panel
 * writes is declared here, and why the reset clears the declared list rather
 * than the keys some component happened to think of. A reset that misses one
 * key is worse than no reset: it convinces the operator the panel is clean when
 * it is not.
 *
 * What is deliberately *not* here: pause, scroll position, expanded groups,
 * connection state. Those describe a moment, not a preference, and restoring
 * them on reload would resurrect a view the operator had already moved on from.
 */

export const HIDDEN_SERVICES_KEY = "packscout.ops-panel.logs.hidden-services";

/** More hidden services than any machine plausibly runs. */
export const MAX_HIDDEN_SERVICES = 64;

/** The full set of keys the panel writes; the reset is defined as clearing it. */
export const PANEL_PREFERENCE_KEYS: readonly string[] = Object.freeze([
  LOG_DISPLAY_PREFERENCES_KEY,
  HIDDEN_SERVICES_KEY,
  RECENT_SEARCHES_KEY,
]);

export interface MutablePreferenceStore extends PreferenceStore {
  removeItem(key: string): void;
}

export function parseHiddenServices(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const names = parsed.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return [...new Set(names)].slice(0, MAX_HIDDEN_SERVICES);
}

export function readHiddenServices(store: PreferenceStore | undefined): string[] {
  if (!store) return [];
  try {
    return parseHiddenServices(store.getItem(HIDDEN_SERVICES_KEY));
  } catch {
    return [];
  }
}

export function writeHiddenServices(
  store: PreferenceStore | undefined,
  services: Iterable<string>,
): void {
  if (!store) return;
  try {
    const bounded = [...new Set(services)].slice(0, MAX_HIDDEN_SERVICES);
    store.setItem(HIDDEN_SERVICES_KEY, JSON.stringify(bounded));
  } catch {
    // A preference that cannot be saved is not worth failing the view over.
  }
}

/** Forget everything, in one operation, so nothing can be left behind. */
export function resetPanelPreferences(
  store: MutablePreferenceStore | undefined,
): void {
  if (!store) return;
  for (const key of PANEL_PREFERENCE_KEYS) {
    try {
      store.removeItem(key);
    } catch {
      // Keep clearing the rest: a partial reset is better than an abandoned one.
    }
  }
}
