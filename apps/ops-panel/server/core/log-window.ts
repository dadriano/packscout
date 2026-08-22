/**
 * Bounded backward alignment.
 *
 * Two operations need to start reading a file somewhere other than its
 * beginning, and both must land on a line boundary or every offset after them
 * is wrong:
 *
 *  - *attach alignment* — a viewer arrives and the tail must begin at the last
 *    complete line rather than mid-line at end-of-file;
 *  - *initial window* — the panel shows the last N lines that precede the tail
 *    cursor, so the operator has context instead of an empty pane.
 *
 * Both scan backwards, and both are bounded: they read a fixed trailing slice
 * and never walk the whole file. When the bound is hit before the requested
 * number of lines is found, the result says so (`complete: false`) rather than
 * implying the window reaches the start of the generation.
 */

const LINE_FEED = 0x0a;

/** How far back an attach may scan to find the last line boundary. */
export const DEFAULT_ALIGNMENT_SCAN_BYTES = 64 * 1024;

/** How far back an initial window may read. */
export const DEFAULT_WINDOW_SCAN_BYTES = 512 * 1024;

/** Default number of lines an initial window asks for. */
export const DEFAULT_WINDOW_LINES = 500;

/** Hard ceiling on a caller-requested window size. */
export const MAX_WINDOW_LINES = 5_000;

export interface ByteRange {
  offset: number;
  length: number;
}

export function clampWindowLines(
  requested: unknown,
  fallback = DEFAULT_WINDOW_LINES,
): number {
  const value = Number(requested);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_WINDOW_LINES, Math.max(1, Math.floor(value)));
}

/** The trailing slice to read when looking backwards from `endOffset`. */
export function planBackwardScan(
  endOffset: number,
  maxBytes: number,
): ByteRange {
  const bounded = Math.max(0, Math.min(endOffset, maxBytes));
  return { offset: Math.max(0, endOffset - bounded), length: bounded };
}

export interface AlignmentResult {
  /** Offset of the first byte after the last terminator in the slice. */
  offset: number;
  /** False when no terminator was found inside the bounded slice. */
  found: boolean;
}

/**
 * Where a tail should start so it never publishes the tail half of a line that
 * was already partly written when the viewer arrived.
 */
export function alignToLastLineStart(
  bytes: Uint8Array,
  chunkOffset: number,
): AlignmentResult {
  const boundary = bytes.lastIndexOf(LINE_FEED);
  if (boundary === -1) {
    // No terminator inside the bound. Starting at the slice start is the
    // furthest back the panel is willing to look; when the slice covers the
    // whole generation that is also exactly right.
    return { offset: chunkOffset, found: chunkOffset === 0 };
  }
  return { offset: chunkOffset + boundary + 1, found: true };
}

export interface WindowAlignment {
  /** Offset the window's first line starts at. */
  offset: number;
  /** True when the window reaches the true start of the generation. */
  complete: boolean;
  /** Lines the slice actually contains, capped at the request. */
  lineCount: number;
}

/**
 * Walk backwards through a trailing slice counting terminators until `maxLines`
 * line starts have been found, and report where that window begins.
 *
 * The slice is assumed to end on a line boundary: callers read up to the tail
 * cursor, which is itself aligned.
 */
export function alignWindowStart(
  bytes: Uint8Array,
  chunkOffset: number,
  maxLines: number,
): WindowAlignment {
  if (maxLines <= 0 || bytes.length === 0) {
    return {
      offset: chunkOffset + bytes.length,
      complete: chunkOffset === 0 && bytes.length === 0,
      lineCount: 0,
    };
  }

  let index = bytes.length - 1;
  // A terminator in the final position closes the last line rather than opening
  // a new one.
  if (bytes[index] === LINE_FEED) index -= 1;

  let lines = 0;
  while (index >= 0) {
    if (bytes[index] === LINE_FEED) {
      lines += 1;
      if (lines === maxLines) {
        return {
          offset: chunkOffset + index + 1,
          complete: false,
          lineCount: lines,
        };
      }
    }
    index -= 1;
  }

  // The scan reached the slice start. That is the generation start only when
  // the slice itself began there; otherwise the window is bounded by the scan
  // and its first partial line is dropped rather than published half-written.
  if (chunkOffset === 0) {
    return { offset: 0, complete: true, lineCount: lines + 1 };
  }
  const firstBoundary = bytes.indexOf(LINE_FEED);
  return {
    offset:
      firstBoundary === -1
        ? chunkOffset + bytes.length
        : chunkOffset + firstBoundary + 1,
    complete: false,
    lineCount: firstBoundary === -1 ? 0 : lines,
  };
}
