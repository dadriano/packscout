/**
 * The log record contract: what a tailed line is, how it is identified, and the
 * vocabulary of inline markers that keep the stream honest.
 *
 * Line identity is the load-bearing decision here. An identity is derived
 * purely from `(service, generation, byte offset)`, so every producer computes
 * the same id for the same bytes without coordinating:
 *
 *  - the live tail computes it while reading forward;
 *  - the initial-window read computes it while reading backward from the tail
 *    cursor (admin-tools/011);
 *  - history reads compute it for the same file generation (admin-tools/012).
 *
 * That is what lets a client merge those three sources by id alone: an overlap
 * deduplicates exactly, and a gap is impossible to hide because offsets are
 * contiguous within a generation.
 *
 * A *generation* is one continuous run of bytes behind a service's log name. It
 * increments whenever the bytes behind the name stop being an append of what
 * came before: truncation, replacement by a new file, or a disappear/reappear
 * cycle. Offsets restart at zero in a new generation, so `(generation, offset)`
 * stays unique and, within a generation, monotonically increasing.
 *
 * Framework-free on purpose: the panel server, the panel UI, and the tests all
 * derive from this one definition.
 */

export const LOG_LINE_ID_PREFIX = "line";
export const LOG_MARKER_ID_PREFIX = "marker";

/**
 * Marker scope for events that belong to the panel rather than to one service
 * (a restored connection, for instance). `*` is deliberately not a legal
 * service name, so it can never collide with a real log file.
 */
export const PANEL_MARKER_SCOPE = "*";

/** One log line, exactly as it was written. */
export interface LogLineRecord {
  /** `line:<service>:<generation>:<offset>` — deterministic, never invented. */
  id: string;
  service: string;
  /** Monotonic per service: a new generation means new bytes behind the name. */
  generation: number;
  /** Byte offset of the line's first byte within its generation. */
  offset: number;
  /** Byte offset just past what this record consumed, terminator included. */
  endOffset: number;
  /** Line text with the terminator stripped; ANSI sequences left intact. */
  text: string;
  /** When the panel observed the line, ISO-8601. */
  observedAt: string;
  /** True when `observedAt` is a read time rather than an arrival time. */
  backfilled: boolean;
  /** True when the line was flushed without ever seeing its terminator. */
  partial: boolean;
}

/**
 * Inline markers. Each one is an admission that the stream is not a plain
 * continuation, rendered in the log body rather than hidden in a status area.
 */
export type LogMarkerKind =
  | "restarted"
  | "disappeared"
  | "appeared"
  | "skipped"
  | "reconnected";

/** Machine-readable cause, so filtering (admin-tools/013) never parses prose. */
export type LogMarkerReason =
  | "truncated"
  | "replaced"
  | "missing"
  | "discovered"
  | "catch_up"
  | "paused"
  | "browsing"
  | "evicted"
  | "restored";

export interface LogMarkerRecord {
  /** `marker:<scope>:<generation>:<offset>:<kind>:<sequence>`. */
  id: string;
  kind: LogMarkerKind;
  reason: LogMarkerReason;
  /** The owning service, or `PANEL_MARKER_SCOPE` for panel-wide events. */
  service: string;
  generation: number;
  offset: number;
  observedAt: string;
  /** One human sentence; the UI renders it verbatim. */
  detail: string;
  /** Set when the marker accounts for content the panel could not deliver. */
  skippedLines?: number;
  skippedBytes?: number;
}

/**
 * The row model every log surface shares. admin-tools/012 (history) and
 * admin-tools/013 (filtering) operate on this union, not on lines alone.
 */
export type LogRow =
  | ({ type: "line" } & LogLineRecord)
  | ({ type: "marker" } & LogMarkerRecord);

export function logLineId(
  service: string,
  generation: number,
  offset: number,
): string {
  return `${LOG_LINE_ID_PREFIX}:${service}:${generation}:${offset}`;
}

export function logMarkerId(
  service: string,
  generation: number,
  offset: number,
  kind: LogMarkerKind,
  sequence: number,
): string {
  return `${LOG_MARKER_ID_PREFIX}:${service}:${generation}:${offset}:${kind}:${sequence}`;
}

/**
 * Recover the coordinates behind a line id. Service names cannot contain `:`
 * (the log-file convention forbids it), so the split is unambiguous.
 */
export function parseLogLineId(
  id: string,
): { service: string; generation: number; offset: number } | null {
  const parts = id.split(":");
  if (parts.length !== 4 || parts[0] !== LOG_LINE_ID_PREFIX) return null;
  const [, service, generationText, offsetText] = parts;
  const generation = Number(generationText);
  const offset = Number(offsetText);
  if (!service) return null;
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { service, generation, offset };
}

export interface LogLineInput {
  service: string;
  generation: number;
  offset: number;
  endOffset: number;
  text: string;
  observedAt: string;
  backfilled?: boolean;
  partial?: boolean;
}

export function createLogLineRecord(input: LogLineInput): LogLineRecord {
  return {
    id: logLineId(input.service, input.generation, input.offset),
    service: input.service,
    generation: input.generation,
    offset: input.offset,
    endOffset: input.endOffset,
    text: input.text,
    observedAt: input.observedAt,
    backfilled: input.backfilled ?? false,
    partial: input.partial ?? false,
  };
}

export interface LogMarkerInput {
  kind: LogMarkerKind;
  reason: LogMarkerReason;
  service: string;
  generation: number;
  offset: number;
  observedAt: string;
  detail: string;
  sequence: number;
  skippedLines?: number;
  skippedBytes?: number;
}

export function createLogMarkerRecord(input: LogMarkerInput): LogMarkerRecord {
  const record: LogMarkerRecord = {
    id: logMarkerId(
      input.service,
      input.generation,
      input.offset,
      input.kind,
      input.sequence,
    ),
    kind: input.kind,
    reason: input.reason,
    service: input.service,
    generation: input.generation,
    offset: input.offset,
    observedAt: input.observedAt,
    detail: input.detail,
  };
  if (input.skippedLines !== undefined) record.skippedLines = input.skippedLines;
  if (input.skippedBytes !== undefined) record.skippedBytes = input.skippedBytes;
  return record;
}

export function lineRow(line: LogLineRecord): LogRow {
  return { type: "line", ...line };
}

export function markerRow(marker: LogMarkerRecord): LogRow {
  return { type: "marker", ...marker };
}
