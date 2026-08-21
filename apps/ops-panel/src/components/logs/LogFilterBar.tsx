import { useId, type Ref } from "react";
import {
  describeFilterTerm,
  DRAFT_TERM_ID,
  type CompiledFilter,
  type FilterTerm,
  type FilterTermFlags,
  type SeverityFacet,
} from "../../logs/filter.ts";
import type { RecentSearch } from "../../logs/recent-searches.ts";
import { LogSeverityFacet } from "./LogSeverityFacet.tsx";

/**
 * The filter, as an object an operator can see and edit.
 *
 * The draft term matches while it is being typed, so the pane answers before
 * the question is finished — which is how you find out you meant "quarantined"
 * rather than "quarantine". Committing it to a chip is what makes it stackable:
 * chips accumulate, each with its own include/exclude, literal/pattern, and
 * case rules, and each removable on its own.
 *
 * Errors sit beside the term that caused them and never replace the pane. A
 * half-typed pattern is the normal state of a pattern being typed, and blanking
 * the view on every intermediate keystroke would make the box unusable.
 */

export interface LogFilterBarProps {
  draftText: string;
  draftFlags: FilterTermFlags;
  onDraftTextChange: (text: string) => void;
  onDraftFlagsChange: (flags: FilterTermFlags) => void;
  onCommitDraft: () => void;
  terms: readonly FilterTerm[];
  onRemoveTerm: (id: string) => void;
  onToggleTermFlag: (id: string, flag: keyof FilterTermFlags) => void;
  onClearTerms: () => void;
  severities: SeverityFacet;
  onSeveritiesChange: (facet: SeverityFacet) => void;
  compiled: CompiledFilter;
  matched: number;
  total: number;
  recentSearches: readonly RecentSearch[];
  onUseRecentSearch: (search: RecentSearch) => void;
  inputRef: Ref<HTMLInputElement>;
}

const FLAG_LABEL: Readonly<Record<keyof FilterTermFlags, string>> = Object.freeze({
  negated: "Exclude",
  regex: "Pattern",
  caseSensitive: "Aa",
});

function FlagToggle({
  flag,
  active,
  onToggle,
  title,
}: {
  flag: keyof FilterTermFlags;
  active: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      className="panel-log-flag"
      aria-pressed={active}
      onClick={onToggle}
      title={title}
    >
      {FLAG_LABEL[flag]}
    </button>
  );
}

export function LogFilterBar({
  draftText,
  draftFlags,
  onDraftTextChange,
  onDraftFlagsChange,
  onCommitDraft,
  terms,
  onRemoveTerm,
  onToggleTermFlag,
  onClearTerms,
  severities,
  onSeveritiesChange,
  compiled,
  matched,
  total,
  recentSearches,
  onUseRecentSearch,
  inputRef,
}: LogFilterBarProps) {
  const inputId = useId();
  const errorFor = (termId: string) =>
    compiled.errors.find((error) => error.termId === termId)?.message ?? null;
  const draftError = errorFor(DRAFT_TERM_ID);

  return (
    <div className="panel-log-filter">
      <div className="panel-log-toolbar-row">
        <label className="panel-log-control panel-log-search" htmlFor={inputId}>
          Filter
          <input
            id={inputId}
            ref={inputRef}
            type="search"
            value={draftText}
            placeholder="Match as you type"
            aria-invalid={draftError !== null}
            aria-describedby={draftError ? `${inputId}-error` : undefined}
            onChange={(event) => onDraftTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onCommitDraft();
            }}
          />
        </label>

        {(Object.keys(FLAG_LABEL) as (keyof FilterTermFlags)[]).map((flag) => (
          <FlagToggle
            key={flag}
            flag={flag}
            active={draftFlags[flag]}
            title={
              flag === "negated"
                ? "Hide lines that match instead of showing them"
                : flag === "regex"
                  ? "Read the term as a regular expression"
                  : "Match upper and lower case exactly"
            }
            onToggle={() =>
              onDraftFlagsChange({ ...draftFlags, [flag]: !draftFlags[flag] })
            }
          />
        ))}

        <button
          type="button"
          className="panel-button"
          onClick={onCommitDraft}
          disabled={draftText.trim().length === 0}
        >
          Add filter
        </button>

        <span className="panel-log-count" role="status">
          {compiled.active
            ? `${matched.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} lines`
            : `${total.toLocaleString("en-US")} lines`}
        </span>
      </div>

      {draftError ? (
        <p className="panel-notice" id={`${inputId}-error`} role="alert">
          {draftError}
        </p>
      ) : null}

      {terms.length > 0 ? (
        <ul className="panel-log-chips" aria-label="Applied filters">
          {terms.map((term) => {
            const error = errorFor(term.id);
            return (
              <li
                key={term.id}
                className="panel-log-chip"
                data-negated={term.negated ? "yes" : "no"}
                data-invalid={error ? "yes" : "no"}
              >
                <span className="panel-log-chip-text" title={describeFilterTerm(term)}>
                  {term.negated ? "−" : "+"} {term.text}
                </span>
                {(Object.keys(FLAG_LABEL) as (keyof FilterTermFlags)[]).map((flag) => (
                  <FlagToggle
                    key={flag}
                    flag={flag}
                    active={term[flag]}
                    title={`${FLAG_LABEL[flag]} for "${term.text}"`}
                    onToggle={() => onToggleTermFlag(term.id, flag)}
                  />
                ))}
                <button
                  type="button"
                  className="panel-log-chip-remove"
                  onClick={() => onRemoveTerm(term.id)}
                  aria-label={`Remove filter ${term.text}`}
                >
                  ×
                </button>
                {error ? (
                  <span className="panel-log-chip-error" role="alert">
                    {error}
                  </span>
                ) : null}
              </li>
            );
          })}
          <li>
            <button type="button" className="panel-button" onClick={onClearTerms}>
              Clear filters
            </button>
          </li>
        </ul>
      ) : null}

      <LogSeverityFacet facet={severities} onChange={onSeveritiesChange} />

      {recentSearches.length > 0 ? (
        <div className="panel-log-toolbar-row panel-log-recent">
          <span className="panel-log-count">Recent</span>
          {recentSearches.map((search) => (
            <button
              key={`${search.text}|${search.regex}|${search.caseSensitive}|${search.negated}`}
              type="button"
              className="panel-log-recent-item"
              onClick={() => onUseRecentSearch(search)}
              title={describeFilterTerm({ id: "recent", ...search })}
            >
              {search.negated ? "−" : "+"} {search.text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
