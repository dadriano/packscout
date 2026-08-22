import { useCallback } from "react";
import {
  createFilterTerm,
  draftTermFlags,
  withDraftTerm,
  type FilterSpec,
  type FilterTerm,
  type FilterTermFlags,
  type SeverityFacet,
} from "../logs/filter.ts";
import type { RecentSearch } from "../logs/recent-searches.ts";

/**
 * Editing a filter, as the small set of moves an operator actually makes.
 *
 * Every move is expressed as a whole-filter replacement rather than as a
 * mutation, because the filter is also the URL and the URL has to be written
 * from one value. Committing the draft is the only move that reaches outside:
 * it is the moment a search becomes worth remembering, and it is worth
 * remembering precisely because the operator thought it was worth keeping.
 */

export type FilterUpdate = (current: FilterSpec) => FilterSpec;

export interface LogFilterActions {
  draftText: string;
  draftFlags: FilterTermFlags;
  setDraftText: (text: string) => void;
  setDraftFlags: (flags: FilterTermFlags) => void;
  commitDraft: () => void;
  removeTerm: (id: string) => void;
  toggleTermFlag: (id: string, flag: keyof FilterTermFlags) => void;
  clearTerms: () => void;
  setSeverities: (severities: SeverityFacet) => void;
  useRecentSearch: (search: RecentSearch) => void;
}

export function useLogFilterActions(
  filter: FilterSpec,
  setFilter: (update: FilterUpdate) => void,
  rememberSearch: (term: FilterTerm) => void,
): LogFilterActions {
  const setDraftText = useCallback(
    (text: string) =>
      setFilter((current) => withDraftTerm(current, text, draftTermFlags(current.draft))),
    [setFilter],
  );

  const setDraftFlags = useCallback(
    (flags: FilterTermFlags) =>
      setFilter((current) => withDraftTerm(current, current.draft?.text ?? "", flags)),
    [setFilter],
  );

  const commitDraft = useCallback(() => {
    const draft = filter.draft;
    if (!draft || draft.text.trim().length === 0) return;
    const committed = createFilterTerm(draft.text, draft);
    rememberSearch(committed);
    setFilter((current) => ({
      ...current,
      draft: null,
      terms: [...current.terms, committed],
    }));
  }, [filter.draft, rememberSearch, setFilter]);

  const removeTerm = useCallback(
    (id: string) =>
      setFilter((current) => ({
        ...current,
        terms: current.terms.filter((term) => term.id !== id),
      })),
    [setFilter],
  );

  const toggleTermFlag = useCallback(
    (id: string, flag: keyof FilterTermFlags) =>
      setFilter((current) => ({
        ...current,
        terms: current.terms.map((term) =>
          term.id === id ? { ...term, [flag]: !term[flag] } : term,
        ),
      })),
    [setFilter],
  );

  const clearTerms = useCallback(
    () => setFilter((current) => ({ ...current, draft: null, terms: [] })),
    [setFilter],
  );

  const setSeverities = useCallback(
    (severities: SeverityFacet) => setFilter((current) => ({ ...current, severities })),
    [setFilter],
  );

  const useRecentSearch = useCallback(
    (search: RecentSearch) =>
      setFilter((current) =>
        withDraftTerm(current, search.text, {
          negated: search.negated,
          regex: search.regex,
          caseSensitive: search.caseSensitive,
        }),
      ),
    [setFilter],
  );

  return {
    draftText: filter.draft?.text ?? "",
    draftFlags: draftTermFlags(filter.draft),
    setDraftText,
    setDraftFlags,
    commitDraft,
    removeTerm,
    toggleTermFlag,
    clearTerms,
    setSeverities,
    useRecentSearch,
  };
}
