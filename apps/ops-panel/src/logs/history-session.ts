import type { LogHistoryPayload, LogLineRecord, LogRow } from "../api/panel-types.ts";

/**
 * Where the reader is in a log's past, and when they must be brought back.
 *
 * Backward paging resumes from what is already on screen rather than from a
 * cursor the client invents: the oldest line held for a service *is* the edge
 * of the known past, and asking for the page that ends there is what makes
 * history and the live buffer merge without a gap or a duplicate. Identity does
 * the rest — a line that arrives twice is recognised as the same line.
 *
 * The other half of this module is the one rule history browsing cannot bend.
 * Byte offsets only mean something inside one generation, so the moment the
 * file behind a browsed name restarts, every cursor the reader is holding
 * describes bytes that are gone. Continuing would splice two files together and
 * present the result as one story. So a generation change ends browsing: the
 * view returns to live and says why, inline, where the seam is.
 */

/** What is known about one service's past, from what is on screen. */
export interface HeldEdge {
  generation: number;
  offset: number;
}

/** One backward page to ask for. */
export interface HistoryRead {
  service: string;
  /** Null when nothing is held yet: the server starts from the tail cursor. */
  generation: number | null;
  before: number | null;
}

/**
 * The oldest line held per service.
 *
 * Ordered by `(generation, offset)` rather than by position, because the buffer
 * interleaves services and because a restart puts a lower offset *after* a
 * higher one on screen. Markers are skipped: their offset is wherever the tail
 * happened to be, which is not a line start and would misplace the next page.
 */
export function oldestHeldByService(
  rows: readonly LogRow[],
  isVisible: (service: string) => boolean,
): Map<string, HeldEdge> {
  const edges = new Map<string, HeldEdge>();
  for (const row of rows) {
    if (row.type !== "line") continue;
    if (!isVisible(row.service)) continue;
    const current = edges.get(row.service);
    if (
      current === undefined ||
      row.generation < current.generation ||
      (row.generation === current.generation && row.offset < current.offset)
    ) {
      edges.set(row.service, { generation: row.generation, offset: row.offset });
    }
  }
  return edges;
}

/**
 * The reads that would extend the past for every visible service.
 *
 * A service whose earlier page already reported the start of its log is left
 * out entirely, so "there is nothing above this" costs no request and the pane
 * stops asking rather than spinning.
 */
export function planBackwardReads(
  services: readonly string[],
  edges: ReadonlyMap<string, HeldEdge>,
  exhausted: ReadonlySet<string>,
): HistoryRead[] {
  const reads: HistoryRead[] = [];
  for (const service of services) {
    if (exhausted.has(service)) continue;
    const edge = edges.get(service);
    reads.push({
      service,
      generation: edge?.generation ?? null,
      before: edge?.offset ?? null,
    });
  }
  return reads;
}

/** The generations a reader is currently browsing, by service. */
export function browsedGenerations(
  edges: ReadonlyMap<string, HeldEdge>,
): Map<string, number> {
  return new Map(
    [...edges].map(([service, edge]) => [service, edge.generation] as const),
  );
}

export interface GenerationBreak {
  service: string;
  from: number;
  to: number;
}

/**
 * The first live line that proves a browsed service has started over.
 *
 * Live arrivals are the earliest honest signal: the tail publishes them under a
 * new generation number the instant it notices a truncation or a rotation, well
 * before the reader scrolls far enough to ask for another page.
 */
export function detectGenerationBreak(
  browsed: ReadonlyMap<string, number>,
  lines: readonly LogLineRecord[],
): GenerationBreak | null {
  for (const line of lines) {
    const generation = browsed.get(line.service);
    if (generation === undefined || line.generation <= generation) continue;
    return { service: line.service, from: generation, to: line.generation };
  }
  return null;
}

export function describeGenerationBreak(service: string): string {
  return `${service} started a new log while you were reading its past — the view returned to live rather than mixing two files together.`;
}

/** Why a detached read was opened; the two read very differently on screen. */
export type DetachedOrigin = "start" | "context";

/** A detached read to open: one service, one point, one generation. */
export interface DetachedRead {
  direction: "forward" | "around";
  /** Null means the far edge; for a context read it is the match's offset. */
  cursor: number | null;
  /**
   * The generation those offsets belong to, or null when there is none to
   * name — reading from the first byte of whatever is behind the name now.
   */
  generation: number | null;
}

/**
 * The read that opens the context around a search result.
 *
 * The generation travels with the offset, and it is the more important half. A
 * search hit is a *past* observation: the file can rotate between the results
 * coming back and the operator clicking one, and an offset alone gives the
 * server nothing to refuse with — it would answer with whatever bytes now live
 * at that position in the replacement file and present them as the context of
 * the old match. Naming the generation is what turns that into a refusal, and a
 * refusal is what returns the reader to live with a marker.
 */
export function planContextRead(line: {
  offset: number;
  generation: number;
}): DetachedRead {
  return { direction: "around", cursor: line.offset, generation: line.generation };
}

/** Reading a service from the first byte of whatever it is writing now. */
export function planStartRead(): DetachedRead {
  return { direction: "forward", cursor: 0, generation: null };
}

/** Forward browsing: detached from the tail, reading one service onwards. */
export interface DetachedBrowse {
  service: string;
  generation: number;
  origin: DetachedOrigin;
  /** Where the next forward page begins. */
  next: number;
  atStart: boolean;
  atEnd: boolean;
  linesRead: number;
}

export function beginDetachedBrowse(
  service: string,
  generation: number,
  origin: DetachedOrigin = "start",
): DetachedBrowse {
  return {
    service,
    generation,
    origin,
    next: 0,
    atStart: true,
    atEnd: false,
    linesRead: 0,
  };
}

/**
 * Move a detached browse forward by one page.
 *
 * A page that returns nothing and does not claim the end of the file leaves the
 * cursor alone; the next attempt reads the same bytes, which is correct when a
 * service is simply quiet, and cannot loop because nothing drives it but the
 * operator asking for more.
 */
export function advanceDetachedBrowse(
  browse: DetachedBrowse,
  page: LogHistoryPayload,
): DetachedBrowse {
  if (page.service !== browse.service || page.generation !== browse.generation) {
    return browse;
  }
  return {
    ...browse,
    next: Math.max(browse.next, page.endCursor),
    atEnd: page.atEnd,
    linesRead: browse.linesRead + page.lines.length,
  };
}

export function describeDetachedBrowse(browse: DetachedBrowse): string {
  const lines = browse.linesRead.toLocaleString("en-US");
  const noun = browse.linesRead === 1 ? "line" : "lines";
  const what =
    browse.origin === "start"
      ? `Read ${lines} ${noun} from the start of ${browse.service}`
      : `Showing ${lines} ${noun} of context in ${browse.service}`;
  return browse.atEnd
    ? `${what} — this is the end of the file.`
    : `${what}. Live output is held until you return to live.`;
}

/** What the pane says when a service can page no further back. */
export function describeStartOfLog(services: readonly string[]): string {
  if (services.length === 0) return "";
  if (services.length === 1) {
    return `This is the beginning of ${services[0]}'s log.`;
  }
  return `This is the beginning of the log for ${services.join(", ")}.`;
}
