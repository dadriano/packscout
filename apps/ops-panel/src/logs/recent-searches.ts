import type { FilterTerm } from "./filter.ts";
import { MAX_PATTERN_LENGTH } from "./regex-guard.ts";
import type { PreferenceStore } from "./display-preferences.ts";

/**
 * The searches an operator already ran, offered back.
 *
 * Investigations repeat: the same three patterns get retyped every time a
 * service misbehaves, usually from memory and usually with a typo. Remembering
 * them costs a few hundred bytes and removes that whole step.
 *
 * A remembered search keeps its flags, not just its text — a case-sensitive
 * regular expression restored as a literal would quietly match different lines,
 * which is worse than not remembering it at all.
 *
 * The list is bounded, most-recent-first, and de-duplicated by meaning rather
 * than by string, so re-running a search promotes it instead of stacking copies.
 */

export const RECENT_SEARCHES_KEY = "packscout.ops-panel.logs.recent-searches";

export const MAX_RECENT_SEARCHES = 12;

export type RecentSearch = Omit<FilterTerm, "id">;

function isRecentSearch(value: unknown): value is RecentSearch {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof RecentSearch, unknown>>;
  return (
    typeof candidate.text === "string" &&
    candidate.text.length > 0 &&
    candidate.text.length <= MAX_PATTERN_LENGTH &&
    typeof candidate.negated === "boolean" &&
    typeof candidate.regex === "boolean" &&
    typeof candidate.caseSensitive === "boolean"
  );
}

export function sameSearch(left: RecentSearch, right: RecentSearch): boolean {
  return (
    left.text === right.text &&
    left.negated === right.negated &&
    left.regex === right.regex &&
    left.caseSensitive === right.caseSensitive
  );
}

/** Stored entries are untrusted: anything malformed is dropped, not repaired. */
export function parseRecentSearches(raw: string | null): RecentSearch[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isRecentSearch)
    .map(({ text, negated, regex, caseSensitive }) => ({
      text,
      negated,
      regex,
      caseSensitive,
    }))
    .slice(0, MAX_RECENT_SEARCHES);
}

/** Promote a search to the front, bounded. Pure, so the ordering is testable. */
export function recentSearchesWith(
  current: readonly RecentSearch[],
  entry: RecentSearch,
): RecentSearch[] {
  return [entry, ...current.filter((existing) => !sameSearch(existing, entry))].slice(
    0,
    MAX_RECENT_SEARCHES,
  );
}

export function readRecentSearches(store: PreferenceStore | undefined): RecentSearch[] {
  if (!store) return [];
  try {
    return parseRecentSearches(store.getItem(RECENT_SEARCHES_KEY));
  } catch {
    // Private browsing modes can throw on access; an empty list is still usable.
    return [];
  }
}

export function rememberRecentSearch(
  store: PreferenceStore | undefined,
  term: FilterTerm,
): RecentSearch[] {
  const entry: RecentSearch = {
    text: term.text,
    negated: term.negated,
    regex: term.regex,
    caseSensitive: term.caseSensitive,
  };
  if (entry.text.length === 0 || entry.text.length > MAX_PATTERN_LENGTH) {
    return readRecentSearches(store);
  }
  const next = recentSearchesWith(readRecentSearches(store), entry);
  try {
    store?.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    // A search that cannot be remembered is not worth failing the view over.
  }
  return next;
}
