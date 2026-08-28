import { createLogLineSplitter } from "./log-line-splitter.ts";
import type { LogLineRecord } from "./log-records.ts";
import { alignWindowStart, planBackwardScan, type ByteRange } from "./log-window.ts";

/**
 * Reading a log's past, one bounded chunk at a time.
 *
 * The live tail (admin-tools/011) only ever moves forward from where a viewer
 * attached, so diagnosing last night's failure means reading bytes nobody was
 * watching when they were written. Two rules make that safe:
 *
 *  - *every read is bounded twice* — by a byte budget and by a line count — so
 *    no request can pull a gigabyte of log into the process, however the client
 *    asks;
 *  - *every cursor progresses* — a page always returns a cursor strictly closer
 *    to the boundary it is walking toward, so a client loop terminates even
 *    when the file contains a single line larger than the whole budget. Such a
 *    line comes back as a bounded *fragment* flagged `partial`, not as an
 *    unbounded payload and not as a stall.
 *
 * Line identity is unchanged from the tail's: records are produced by the same
 * splitter, from the same byte offsets, in the same generation, so a history
 * page and a live batch name the same line the same way. That is what lets a
 * client merge prepended history, the live buffer, and forward pages by id
 * alone — an overlap deduplicates exactly and a gap cannot hide.
 *
 * Framework-free: callers supply the bytes, this module decides what they mean.
 */

export type HistoryDirection = "backward" | "forward";

/** Bytes one history request may read before it must return what it has. */
export const DEFAULT_HISTORY_BUDGET_BYTES = 256 * 1024;

/** Small enough to page finely, large enough to hold a realistic line. */
export const MIN_HISTORY_BUDGET_BYTES = 4 * 1024;

/** Hard ceiling on a caller-requested budget. */
export const MAX_HISTORY_BUDGET_BYTES = 1024 * 1024;

/** Lines one history page returns when the caller does not say. */
export const DEFAULT_HISTORY_LINES = 300;

export function clampHistoryBudget(
  requested: unknown,
  fallback = DEFAULT_HISTORY_BUDGET_BYTES,
): number {
  const value = Number(requested);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(
    MAX_HISTORY_BUDGET_BYTES,
    Math.max(MIN_HISTORY_BUDGET_BYTES, Math.floor(value)),
  );
}

export interface HistoryChunkInput {
  direction: HistoryDirection;
  /** Backward: read up to here. Forward: read from here. */
  cursor: number;
  fileSize: number;
  budgetBytes: number;
}

/** The byte range one page is allowed to read. Never the whole file. */
export function planHistoryChunk({
  direction,
  cursor,
  fileSize,
  budgetBytes,
}: HistoryChunkInput): ByteRange {
  const size = Math.max(0, fileSize);
  const budget = Math.max(0, budgetBytes);
  const bounded = Math.max(0, Math.min(cursor, size));
  if (direction === "backward") return planBackwardScan(bounded, budget);
  return { offset: bounded, length: Math.min(budget, size - bounded) };
}

export interface HistoryPage {
  direction: HistoryDirection;
  /** Offset of the first byte the page accounts for. */
  startOffset: number;
  /** Offset just past the last byte the page accounts for. */
  endOffset: number;
  /**
   * Where the next page in the same direction resumes. Strictly closer to the
   * boundary than the cursor that produced it whenever any byte was read.
   */
  nextCursor: number;
  /** True when the page reaches the first byte of the generation. */
  atStart: boolean;
  /** True when the page reaches the last byte the file had when it was read. */
  atEnd: boolean;
  /** True when a line longer than the budget came back as a bounded fragment. */
  fragmented: boolean;
  bytesRead: number;
  lines: LogLineRecord[];
}

export interface HistoryPageInput {
  service: string;
  generation: number;
  /** The range the caller planned; only `offset` is trusted for placement. */
  chunk: ByteRange;
  /** The bytes actually read, which may be shorter than the plan. */
  bytes: Uint8Array;
  fileSize: number;
  maxLines: number;
  readAtMs: number;
}

function backfill(lines: readonly LogLineRecord[]): LogLineRecord[] {
  // A history line's timestamp is a read time, never an arrival time, and the
  // record says so rather than letting the panel imply it watched this happen.
  return lines.map((line) => ({ ...line, backfilled: true }));
}

function emptyPage(
  direction: HistoryDirection,
  offset: number,
  fileSize: number,
): HistoryPage {
  return {
    direction,
    startOffset: offset,
    endOffset: offset,
    nextCursor: offset,
    atStart: offset <= 0,
    atEnd: offset >= fileSize,
    fragmented: false,
    bytesRead: 0,
    lines: [],
  };
}

/**
 * Older lines, ending at the chunk's far edge.
 *
 * The slice is walked backwards to find where the page's first *whole* line
 * begins, then split forward from there by the ordinary splitter, so the
 * records are byte-identical to the ones the tail would have produced.
 *
 * Sometimes the budget cannot prove where a line begins: the slice holds one
 * enormous line with no terminator in it at all, or only the tail of a line
 * that started before the slice did. Aligning then reports the cursor it was
 * given, and a client loop would ask for the same page forever. So the page
 * falls back to the chunk's own start and publishes what it finds as bounded
 * *fragments*, flagged `partial` because the panel cannot prove they are whole
 * lines — one full budget closer to the beginning of the file, which is the
 * property that makes the loop terminate.
 */
export function readBackwardPage({
  service,
  generation,
  chunk,
  bytes,
  fileSize,
  maxLines,
  readAtMs,
}: HistoryPageInput): HistoryPage {
  const chunkOffset = Math.max(0, chunk.offset);
  if (bytes.length === 0) return emptyPage("backward", chunkOffset, fileSize);

  const endOffset = chunkOffset + bytes.length;
  const alignment = alignWindowStart(bytes, chunkOffset, maxLines);
  const fragmented = alignment.offset >= endOffset;
  const startOffset = fragmented ? chunkOffset : alignment.offset;

  const splitter = createLogLineSplitter({ service, generation, offset: startOffset });
  const lines = splitter.append(bytes.subarray(startOffset - chunkOffset), readAtMs);
  // Trailing bytes with no terminator belong to this page: dropping them would
  // lose content the next page will never look at again.
  lines.push(...splitter.flush(readAtMs, { force: true }));

  return {
    direction: "backward",
    startOffset,
    endOffset,
    nextCursor: startOffset,
    atStart: startOffset <= 0,
    atEnd: endOffset >= fileSize,
    fragmented,
    bytesRead: bytes.length,
    lines: backfill(fragmented ? lines.map((line) => ({ ...line, partial: true })) : lines),
  };
}

/**
 * Newer lines, starting at the chunk's near edge.
 *
 * A trailing unterminated line is held rather than published, because the bytes
 * that finish it are simply the next page — unless the read reached the end of
 * the file, where holding it would hide the most recent thing written, or
 * unless the whole budget produced no terminator, where holding it would stall
 * the cursor.
 */
export function readForwardPage({
  service,
  generation,
  chunk,
  bytes,
  fileSize,
  maxLines,
  readAtMs,
}: HistoryPageInput): HistoryPage {
  const startOffset = Math.max(0, chunk.offset);
  if (bytes.length === 0) return emptyPage("forward", startOffset, fileSize);

  const endOffset = startOffset + bytes.length;
  const reachedEnd = endOffset >= fileSize;
  const splitter = createLogLineSplitter({ service, generation, offset: startOffset });
  const produced = splitter.append(bytes, readAtMs);

  const oversized = produced.length === 0 && splitter.pendingBytes() > 0;
  if (reachedEnd || oversized) {
    produced.push(...splitter.flush(readAtMs, { force: true }));
  }

  const kept = produced.length > maxLines ? produced.slice(0, maxLines) : produced;
  const cappedByLines = kept.length < produced.length;
  const nextCursor = cappedByLines
    ? (kept[kept.length - 1]?.endOffset ?? startOffset)
    : splitter.pendingOffset();

  return {
    direction: "forward",
    startOffset,
    endOffset: nextCursor,
    nextCursor,
    atStart: startOffset <= 0,
    atEnd: !cappedByLines && reachedEnd,
    fragmented: oversized && !reachedEnd,
    bytesRead: bytes.length,
    lines: backfill(kept),
  };
}

/**
 * How a page's two halves are split when a search result is opened in place.
 *
 * The match must be readable *in situ*, so the context is centred on it: rather
 * more above than below, because what led to a failure is usually what is being
 * looked for.
 */
export function planContextHalves(lines: number): { before: number; after: number } {
  const total = Math.max(2, Math.floor(lines));
  const before = Math.ceil(total / 2);
  return { before, after: Math.max(1, total - before) };
}
