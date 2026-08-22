import type { LogLineRecord } from "../api/panel-types.ts";
import { formatByteSize } from "../format.ts";
import type { CompiledFilter } from "./filter.ts";
import { readLineFacts } from "./line-facts.ts";

/**
 * Searching a log's past with the filter that is already on screen.
 *
 * There is deliberately no second matcher. The filter the operator built —
 * chips, negations, regular expressions, the severity facet — is compiled once
 * by `filter.ts`, and this search asks that same compiled value about every
 * line it reads, through the same `line-facts` derivation the pane uses. A
 * search that could disagree with the view about what matches would be worse
 * than no search at all, so the possibility is removed rather than tested for.
 *
 * Scanning runs backwards, newest first, one bounded page per service in turn,
 * because that is the order an operator reads an incident in and because it
 * means the first results are the relevant ones. Three limits keep it from ever
 * becoming a runaway:
 *
 *  - a match cap, so a pattern that matches everything cannot fill memory;
 *  - a byte cap, so scanning a multi-gigabyte log ends in seconds rather than
 *    minutes;
 *  - cancellation, checked between pages, because the honest answer to "this is
 *    taking too long" is to stop rather than to keep going quietly.
 *
 * Whichever limit ends the run, the outcome says *where* the scan had reached
 * and *why* it stopped. "No matches" and "no matches in the last 24 MB" are
 * completely different answers, and only one of them is true.
 */

/** Matches held before the search stops and says it stopped. */
export const DEFAULT_SEARCH_MATCH_CAP = 400;

/** Bytes one search may read across every service it covers. */
export const DEFAULT_SEARCH_BYTE_CAP = 24 * 1024 * 1024;

export type SearchStopReason =
  | "start_of_logs"
  | "match_cap"
  | "byte_cap"
  | "canceled"
  | "no_query"
  | "failed";

/** One service to scan, and where its scan begins. */
export interface SearchScope {
  service: string;
  /** Null when nothing is held yet: the server starts from the tail cursor. */
  generation: number | null;
  before: number | null;
}

export interface SearchPageRequest {
  service: string;
  generation: number | null;
  before: number | null;
}

export interface SearchPageReply {
  service: string;
  generation: number;
  lines: readonly LogLineRecord[];
  /** Where the next older page ends. */
  startCursor: number;
  atStart: boolean;
  bytesRead: number;
}

export type SearchPageFetcher = (
  request: SearchPageRequest,
) => Promise<SearchPageReply>;

export interface SearchProgress {
  bytesScanned: number;
  linesScanned: number;
  matches: number;
  /** The service the scan is reading right now, for a live progress line. */
  service: string | null;
  running: boolean;
}

/** Where one service's scan stopped. */
export interface SearchFrontier {
  service: string;
  offset: number;
  atStart: boolean;
}

export interface SearchOutcome {
  matches: LogLineRecord[];
  bytesScanned: number;
  linesScanned: number;
  stopReason: SearchStopReason;
  /** One sentence saying where the scan reached and why it ended there. */
  note: string;
  frontier: SearchFrontier[];
}

export interface AbortLike {
  readonly aborted: boolean;
}

export interface HistorySearchInput {
  scopes: readonly SearchScope[];
  filter: CompiledFilter;
  fetchPage: SearchPageFetcher;
  onProgress?: (progress: SearchProgress) => void;
  signal?: AbortLike;
  matchCap?: number;
  byteCap?: number;
}

interface Frontier extends SearchFrontier {
  generation: number | null;
  before: number | null;
}

function serviceList(frontier: readonly SearchFrontier[]): string {
  return frontier.map((entry) => entry.service).join(", ");
}

function unfinished(frontier: readonly SearchFrontier[]): SearchFrontier[] {
  return frontier.filter((entry) => !entry.atStart);
}

/**
 * The sentence the results end with. It is assembled rather than chosen so
 * every stop reason carries the same three facts: how much was read, what was
 * found, and what was left unread.
 */
export function describeSearchStop(
  reason: SearchStopReason,
  outcome: Pick<SearchOutcome, "bytesScanned" | "matches" | "frontier">,
): string {
  const scanned = formatByteSize(outcome.bytesScanned);
  const found = outcome.matches.length.toLocaleString("en-US");
  const noun = outcome.matches.length === 1 ? "match" : "matches";
  const remaining = unfinished(outcome.frontier);
  const unread =
    remaining.length === 0
      ? ""
      : ` ${serviceList(remaining)} still ${remaining.length === 1 ? "has" : "have"} older output that was not read.`;

  switch (reason) {
    case "no_query":
      return "Add a filter term or a severity to search history for.";
    case "start_of_logs":
      return `Searched ${scanned} back to the beginning of ${serviceList(outcome.frontier) || "the log"} and found ${found} ${noun}.`;
    case "match_cap":
      return `Stopped at ${found} ${noun}, the most one search collects. ${scanned} scanned.${unread}`;
    case "byte_cap":
      return `Stopped after scanning ${scanned}, the most one search reads. ${found} ${noun}.${unread}`;
    case "canceled":
      return `Canceled after scanning ${scanned}. ${found} ${noun} so far.${unread}`;
    case "failed":
      return `The search stopped early because a page could not be read. ${found} ${noun} in ${scanned}.${unread}`;
  }
}

/**
 * Scan backwards for the active filter, one bounded page at a time.
 *
 * Pages are taken from each service in turn rather than one service at a time,
 * so a shared byte budget is spent fairly and the results stay roughly in the
 * order the incident happened rather than grouped by whichever log is largest.
 */
export async function runHistorySearch({
  scopes,
  filter,
  fetchPage,
  onProgress,
  signal,
  matchCap = DEFAULT_SEARCH_MATCH_CAP,
  byteCap = DEFAULT_SEARCH_BYTE_CAP,
}: HistorySearchInput): Promise<SearchOutcome> {
  const frontier: Frontier[] = scopes.map((scope) => ({
    service: scope.service,
    generation: scope.generation,
    before: scope.before,
    offset: scope.before ?? 0,
    atStart: false,
  }));

  const matches: LogLineRecord[] = [];
  let bytesScanned = 0;
  let linesScanned = 0;

  const settle = (reason: SearchStopReason): SearchOutcome => {
    const visible = frontier.map(
      ({ service, offset, atStart }): SearchFrontier => ({ service, offset, atStart }),
    );
    const outcome: SearchOutcome = {
      matches,
      bytesScanned,
      linesScanned,
      stopReason: reason,
      note: describeSearchStop(reason, { bytesScanned, matches, frontier: visible }),
      frontier: visible,
    };
    onProgress?.({
      bytesScanned,
      linesScanned,
      matches: matches.length,
      service: null,
      running: false,
    });
    return outcome;
  };

  // An inactive filter would admit every line in every file; refusing is the
  // only answer that is not a lie about what was searched for.
  if (!filter.active || scopes.length === 0) return settle("no_query");

  while (frontier.some((entry) => !entry.atStart)) {
    for (const entry of frontier) {
      if (entry.atStart) continue;
      if (signal?.aborted) return settle("canceled");
      if (bytesScanned >= byteCap) return settle("byte_cap");

      let page: SearchPageReply;
      try {
        page = await fetchPage({
          service: entry.service,
          generation: entry.generation,
          before: entry.before,
        });
      } catch {
        return settle("failed");
      }

      bytesScanned += page.bytesRead;
      linesScanned += page.lines.length;
      entry.generation = page.generation;
      entry.before = page.startCursor;
      entry.offset = page.startCursor;
      // A page that reads nothing has nothing left to give, whatever it claims.
      entry.atStart = page.atStart || page.bytesRead === 0;

      // Newest first inside the page, so results read in the order an operator
      // scrolls: most recent occurrence at the top.
      for (let index = page.lines.length - 1; index >= 0; index -= 1) {
        const line = page.lines[index];
        if (line === undefined) continue;
        const { plainText, severity } = readLineFacts({ type: "line", ...line });
        if (!filter.test({ text: plainText, severity })) continue;
        matches.push(line);
        if (matches.length >= matchCap) return settle("match_cap");
      }

      onProgress?.({
        bytesScanned,
        linesScanned,
        matches: matches.length,
        service: entry.service,
        running: true,
      });
      // Checked after the page is accounted for: a page already read is a page
      // already paid for, and throwing its matches away would under-report what
      // the search actually saw.
      if (signal?.aborted) return settle("canceled");
    }
  }

  return settle(signal?.aborted === true ? "canceled" : "start_of_logs");
}
