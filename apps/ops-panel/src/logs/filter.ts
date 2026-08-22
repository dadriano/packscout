import { mergeHighlightRanges, type HighlightRange } from "./highlight.ts";
import { compileGuardedRegExp, type RegexGuardOptions } from "./regex-guard.ts";
import { LOG_SEVERITIES, type LogSeverity } from "./severity.ts";

/**
 * What "show me this" means, compiled once and answered per line.
 *
 * The whole filter is one value — draft term, committed chips, severity facet —
 * so there is exactly one definition of what matches. Live tailing and deep
 * history search (admin-tools/012) both compile the same spec through this
 * module, which is the only way the two can be guaranteed never to disagree
 * about the same line.
 *
 * The semantics are chosen to be predictable rather than clever:
 *
 *  - every include must match (terms narrow, they do not accumulate results);
 *  - any exclude vetoes (a veto is absolute, so "hide the poller" always hides
 *    the poller);
 *  - the severity facet must admit the line, independently of the terms.
 *
 * A term that cannot be compiled is *skipped*, not fatal. Half of a regular
 * expression is typed at some point during typing all of it, and a pane that
 * blanks on every intermediate keystroke is unusable; the error is reported
 * beside the term instead, and the rest of the filter keeps working.
 */

export interface FilterTerm {
  /** Stable within a session; the key for errors and for React lists. */
  id: string;
  text: string;
  /** Exclude rather than include: a match vetoes the line. */
  negated: boolean;
  /** Interpret `text` as a regular expression rather than as literal text. */
  regex: boolean;
  caseSensitive: boolean;
}

/** A term's behaviour, without its text: what the chip toggles switch. */
export type FilterTermFlags = Omit<FilterTerm, "id" | "text">;

export type SeverityFacet = Readonly<Record<LogSeverity, boolean>>;

export const ALL_SEVERITIES: SeverityFacet = Object.freeze({
  error: true,
  warn: true,
  info: true,
  debug: true,
  unknown: true,
});

/** The one-click preset: what is going wrong, and what is about to. */
export const ERRORS_PRESET: SeverityFacet = Object.freeze({
  error: true,
  warn: true,
  info: false,
  debug: false,
  unknown: false,
});

export interface FilterSpec {
  /** Matches as it is typed, before it is committed to a chip. */
  draft: FilterTerm | null;
  terms: readonly FilterTerm[];
  severities: SeverityFacet;
}

export const EMPTY_FILTER: FilterSpec = Object.freeze({
  draft: null,
  terms: Object.freeze([]) as readonly FilterTerm[],
  severities: ALL_SEVERITIES,
});

export interface FilterTermError {
  termId: string;
  message: string;
}

/** The two things a filter needs to know about a line. */
export interface FilterCandidate {
  /** Canonical plain text: `stripAnsi(row.text)`, never the raw form. */
  text: string;
  severity: LogSeverity;
}

export interface CompiledFilter {
  readonly spec: FilterSpec;
  /** True when the filter excludes anything at all. */
  readonly active: boolean;
  /** Terms that could not be compiled, reported rather than applied. */
  readonly errors: readonly FilterTermError[];
  admitsSeverity(severity: LogSeverity): boolean;
  /** Terms only, ignoring severity: what a group member has to satisfy. */
  matchesText(text: string): boolean;
  test(candidate: FilterCandidate): boolean;
  /** Where the include terms matched, merged and ordered. */
  highlight(text: string): HighlightRange[];
}

/** Highlight ranges collected per line, so one pathological line cannot stall. */
const MAX_MATCHES_PER_LINE = 128;

interface TermMatcher {
  term: FilterTerm;
  test(text: string): boolean;
  ranges(text: string): HighlightRange[];
}

export function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectRanges(expression: RegExp, text: string): HighlightRange[] {
  expression.lastIndex = 0;
  const ranges: HighlightRange[] = [];
  let match = expression.exec(text);
  while (match !== null && ranges.length < MAX_MATCHES_PER_LINE) {
    if (match[0].length > 0) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    } else {
      // A zero-width match would loop forever on its own index.
      expression.lastIndex += 1;
    }
    match = expression.exec(text);
  }
  return ranges;
}

function matcherFor(expression: RegExp, term: FilterTerm): TermMatcher {
  return {
    term,
    test(text) {
      expression.lastIndex = 0;
      return expression.test(text);
    },
    ranges: (text) => collectRanges(expression, text),
  };
}

type MatcherOutcome = { ok: true; matcher: TermMatcher } | { ok: false; message: string };

/**
 * Literals bypass the regex guards deliberately: they are escaped before
 * compilation, so no user input can reach the engine as syntax and the search is
 * linear by construction.
 */
function buildMatcher(term: FilterTerm, options: RegexGuardOptions): MatcherOutcome {
  if (!term.regex) {
    const flags = term.caseSensitive ? "g" : "gi";
    return { ok: true, matcher: matcherFor(new RegExp(escapeLiteral(term.text), flags), term) };
  }
  const guarded = compileGuardedRegExp(term.text, {
    ...options,
    caseSensitive: term.caseSensitive,
  });
  return guarded.ok
    ? { ok: true, matcher: matcherFor(guarded.expression, term) }
    : { ok: false, message: guarded.message };
}

/** Draft last, so a chip's error is reported before the one being typed. */
export function filterTerms(spec: FilterSpec): FilterTerm[] {
  return spec.draft ? [...spec.terms, spec.draft] : [...spec.terms];
}

export function compileFilter(
  spec: FilterSpec,
  options: RegexGuardOptions = {},
): CompiledFilter {
  const errors: FilterTermError[] = [];
  const includes: TermMatcher[] = [];
  const excludes: TermMatcher[] = [];

  for (const term of filterTerms(spec)) {
    if (term.text.length === 0) continue;
    const outcome = buildMatcher(term, options);
    if (!outcome.ok) {
      errors.push({ termId: term.id, message: outcome.message });
      continue;
    }
    (term.negated ? excludes : includes).push(outcome.matcher);
  }

  const severities = spec.severities;
  const severityNarrows = LOG_SEVERITIES.some((level) => severities[level] === false);

  function matchesText(text: string): boolean {
    for (const matcher of includes) if (!matcher.test(text)) return false;
    for (const matcher of excludes) if (matcher.test(text)) return false;
    return true;
  }

  return {
    spec,
    active: severityNarrows || includes.length > 0 || excludes.length > 0,
    errors,
    // A facet missing a level admits it: a malformed facet must not hide output.
    admitsSeverity: (severity) => severities[severity] !== false,
    matchesText,
    test: (candidate) =>
      severities[candidate.severity] !== false && matchesText(candidate.text),
    highlight: (text) =>
      mergeHighlightRanges(includes.flatMap((matcher) => matcher.ranges(text))),
  };
}

let termSequence = 0;

/** A committed chip or a draft, with an id nothing else will reuse. */
export function createFilterTerm(
  text: string,
  overrides: Partial<Omit<FilterTerm, "id" | "text">> = {},
): FilterTerm {
  termSequence += 1;
  return {
    id: `term-${termSequence}`,
    text,
    negated: overrides.negated ?? false,
    regex: overrides.regex ?? false,
    caseSensitive: overrides.caseSensitive ?? false,
  };
}

/** How a chip reads on screen, and in a screen reader. */
export function describeFilterTerm(term: FilterTerm): string {
  const parts = [term.negated ? "Exclude" : "Include"];
  parts.push(term.regex ? "pattern" : "text");
  parts.push(`"${term.text}"`);
  if (term.caseSensitive) parts.push("(case-sensitive)");
  return parts.join(" ");
}

/**
 * The draft's id is fixed rather than generated.
 *
 * There is only ever one draft, and its error has to be findable while the text
 * under it changes on every keystroke — a fresh id per character would make the
 * error impossible to attach to anything.
 */
export const DRAFT_TERM_ID = "draft";

export function draftTermFlags(draft: FilterTerm | null): FilterTermFlags {
  return {
    negated: draft?.negated ?? false,
    regex: draft?.regex ?? false,
    caseSensitive: draft?.caseSensitive ?? false,
  };
}

/** Replace the draft, dropping it entirely once its text is gone. */
export function withDraftTerm(
  filter: FilterSpec,
  text: string,
  flags: FilterTermFlags,
): FilterSpec {
  return {
    ...filter,
    draft: text.length === 0 ? null : { id: DRAFT_TERM_ID, text, ...flags },
  };
}

export function severityFacetWith(
  facet: SeverityFacet,
  severity: LogSeverity,
  enabled: boolean,
): SeverityFacet {
  return { ...facet, [severity]: enabled };
}

export function isErrorsPreset(facet: SeverityFacet): boolean {
  return LOG_SEVERITIES.every((level) => facet[level] === ERRORS_PRESET[level]);
}

export function isAllSeverities(facet: SeverityFacet): boolean {
  return LOG_SEVERITIES.every((level) => facet[level] !== false);
}
