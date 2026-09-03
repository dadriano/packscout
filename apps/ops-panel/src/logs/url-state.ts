import {
  ALL_SEVERITIES,
  createFilterTerm,
  EMPTY_FILTER,
  type FilterSpec,
  type FilterTerm,
  type SeverityFacet,
} from "./filter.ts";
import { MAX_PATTERN_LENGTH } from "./regex-guard.ts";
import { LOG_SEVERITIES, type LogSeverity } from "./severity.ts";

/**
 * The view, written down so it can be pasted into a chat window.
 *
 * "Look at this" is the most common thing an operator wants to say about a log
 * pane, and it is worthless if the other person has to be told which service to
 * focus and what to type. So surface, focus, and the entire filter live in the
 * address bar, and opening the link reconstructs the view exactly.
 *
 * Which also means the address bar is untrusted input. Links are truncated by
 * chat clients, hand-edited, and carried across versions of the panel, so
 * decoding is strict and *fails to unfiltered* rather than to a half-applied
 * filter: showing everything with a notice is recoverable, while silently
 * dropping one exclude chip is a wrong answer that looks right.
 *
 * Run state — pause, scroll position, which groups are expanded — is deliberately
 * absent. Those describe what one person is doing right now, not what they are
 * looking at, and reproducing them for someone else would be meaningless.
 */

export type PanelSurface = "live" | "history";

export const PANEL_SURFACES: readonly PanelSurface[] = ["live", "history"];

export interface PanelViewState {
  surface: PanelSurface;
  /** The single service in focus, or `null` for all of them. */
  service: string | null;
  filter: FilterSpec;
}

export interface DecodedPanelViewState {
  state: PanelViewState;
  /** True when a filter was present in the URL and could not be read. */
  degraded: boolean;
  notice: string | null;
}

export const DEFAULT_PANEL_VIEW: PanelViewState = Object.freeze({
  surface: "live" as PanelSurface,
  service: null,
  filter: EMPTY_FILTER,
});

/** A link carrying more chips than this is corrupt, not ambitious. */
export const MAX_ENCODED_TERMS = 12;
const MAX_SERVICE_LENGTH = 64;

const SURFACE_KEY = "view";
const SERVICE_KEY = "service";
const DRAFT_KEY = "q";
const TERMS_KEY = "f";
const SEVERITY_KEY = "sev";

export const UNDECODABLE_FILTER_NOTICE =
  "The filter in that link could not be read, so the view opened unfiltered.";

const TOKEN = /^([ix])([rc]{0,2}):(.*)$/u;

/**
 * A term as one URL-safe token.
 *
 * `i`/`x` rather than `+`/`-` because a literal `+` in a query string means a
 * space to every form decoder in existence. The text is percent-encoded inside
 * the token so the separators can never appear in it.
 */
export function encodeFilterTerm(term: FilterTerm): string {
  const flags = `${term.negated ? "x" : "i"}${term.regex ? "r" : ""}${term.caseSensitive ? "c" : ""}`;
  return `${flags}:${encodeURIComponent(term.text)}`;
}

export function decodeFilterTerm(token: string): FilterTerm | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, sigil, flags, encoded] = match;
  if (new Set(flags).size !== flags.length) return null;

  let text: string;
  try {
    text = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_PATTERN_LENGTH) return null;

  return createFilterTerm(text, {
    negated: sigil === "x",
    regex: flags.includes("r"),
    caseSensitive: flags.includes("c"),
  });
}

function encodeSeverities(facet: SeverityFacet): string | null {
  const enabled = LOG_SEVERITIES.filter((level) => facet[level] !== false);
  return enabled.length === LOG_SEVERITIES.length ? null : enabled.join(",");
}

function decodeSeverities(raw: string): SeverityFacet | null {
  const requested = raw.split(",").map((entry) => entry.trim());
  if (requested.length === 0 || requested.some((entry) => entry.length === 0)) {
    return null;
  }
  const known = new Set<string>(LOG_SEVERITIES);
  if (requested.some((entry) => !known.has(entry))) return null;
  const enabled = new Set(requested as LogSeverity[]);
  return Object.fromEntries(
    LOG_SEVERITIES.map((level) => [level, enabled.has(level)]),
  ) as SeverityFacet;
}

export function encodePanelViewState(state: PanelViewState): string {
  const params = new URLSearchParams();
  if (state.surface !== "live") params.set(SURFACE_KEY, state.surface);
  if (state.service) params.set(SERVICE_KEY, state.service);

  const chips = state.filter.terms.filter((term) => term.text.length > 0);
  if (chips.length > 0) params.set(TERMS_KEY, chips.map(encodeFilterTerm).join(","));

  const draft = state.filter.draft;
  if (draft && draft.text.length > 0) params.set(DRAFT_KEY, encodeFilterTerm(draft));

  const severities = encodeSeverities(state.filter.severities);
  if (severities) params.set(SEVERITY_KEY, severities);

  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

function unfiltered(surface: PanelSurface, service: string | null): DecodedPanelViewState {
  return {
    state: { surface, service, filter: EMPTY_FILTER },
    degraded: true,
    notice: UNDECODABLE_FILTER_NOTICE,
  };
}

export function decodePanelViewState(search: string): DecodedPanelViewState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);

  const requestedSurface = params.get(SURFACE_KEY);
  // An unrecognised surface is a link from another version of the panel, not a
  // corrupt filter: fall back to the live view without shouting about it.
  const surface: PanelSurface = PANEL_SURFACES.includes(
    requestedSurface as PanelSurface,
  )
    ? (requestedSurface as PanelSurface)
    : "live";

  const requestedService = params.get(SERVICE_KEY)?.trim() ?? "";
  const service =
    requestedService.length > 0 && requestedService.length <= MAX_SERVICE_LENGTH
      ? requestedService
      : null;

  const rawTerms = params.get(TERMS_KEY);
  const rawDraft = params.get(DRAFT_KEY);
  const rawSeverities = params.get(SEVERITY_KEY);
  if (rawTerms === null && rawDraft === null && rawSeverities === null) {
    return { state: { surface, service, filter: EMPTY_FILTER }, degraded: false, notice: null };
  }

  const terms: FilterTerm[] = [];
  if (rawTerms !== null) {
    const tokens = rawTerms.split(",");
    if (tokens.length > MAX_ENCODED_TERMS) return unfiltered(surface, service);
    for (const token of tokens) {
      const term = decodeFilterTerm(token);
      if (!term) return unfiltered(surface, service);
      terms.push(term);
    }
  }

  let draft: FilterTerm | null = null;
  if (rawDraft !== null) {
    draft = decodeFilterTerm(rawDraft);
    if (!draft) return unfiltered(surface, service);
  }

  let severities = ALL_SEVERITIES;
  if (rawSeverities !== null) {
    const decoded = decodeSeverities(rawSeverities);
    if (!decoded) return unfiltered(surface, service);
    severities = decoded;
  }

  return {
    state: { surface, service, filter: { draft, terms, severities } },
    degraded: false,
    notice: null,
  };
}

/**
 * Whether moving between two views should add a history entry.
 *
 * Changing what you are looking at is a navigation and belongs in the back
 * button. Editing the filter is a refinement of the same look, and pushing an
 * entry per keystroke would bury the previous view under fifty of them.
 */
export function panelHistoryMode(
  previous: PanelViewState,
  next: PanelViewState,
): "push" | "replace" {
  return previous.surface !== next.surface || previous.service !== next.service
    ? "push"
    : "replace";
}
