import type { AnsiSpan, AnsiStyle } from "./ansi.ts";

/**
 * Where a match sits, and how to show it without losing colour.
 *
 * Matches are found against the canonical plain text, because that is what the
 * operator typed against. The pane, however, renders styled spans — so a match
 * that straddles a colour change has to be split at the boundary rather than
 * drawn over it. Anything else would either drop the author's emphasis or drop
 * the highlight, and both are the kind of small lie that makes a log viewer
 * untrustworthy.
 *
 * The spans out of `parseAnsi` concatenate exactly to that plain text, which is
 * what makes the split arithmetic reliable: one running offset is enough.
 */

export interface HighlightRange {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface HighlightedSpan {
  text: string;
  style: AnsiStyle;
  highlighted: boolean;
}

/**
 * Sort and coalesce ranges so overlapping matches from different terms render
 * as one continuous highlight instead of stacking on top of each other.
 */
export function mergeHighlightRanges(
  ranges: readonly HighlightRange[],
): HighlightRange[] {
  const usable = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) =>
      left.start === right.start ? left.end - right.end : left.start - right.start,
    );
  const merged: HighlightRange[] = [];
  for (const range of usable) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** True when `offset` falls inside one of the (merged, ordered) ranges. */
function rangeAt(
  ranges: readonly HighlightRange[],
  offset: number,
): HighlightRange | null {
  for (const range of ranges) {
    if (offset < range.start) return null;
    if (offset < range.end) return range;
  }
  return null;
}

/**
 * Split styled spans at every highlight boundary.
 *
 * The result still concatenates to the original text, so nothing is added,
 * dropped, or reordered — only cut.
 */
export function applyHighlights(
  spans: readonly AnsiSpan[],
  ranges: readonly HighlightRange[],
): HighlightedSpan[] {
  const merged = mergeHighlightRanges(ranges);
  if (merged.length === 0) {
    return spans.map((span) => ({ ...span, highlighted: false }));
  }

  const result: HighlightedSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    let cursor = 0;
    while (cursor < span.text.length) {
      const absolute = offset + cursor;
      const range = rangeAt(merged, absolute);
      const boundary = range
        ? Math.min(range.end, offset + span.text.length)
        : Math.min(
            merged.find((candidate) => candidate.start > absolute)?.start ??
              offset + span.text.length,
            offset + span.text.length,
          );
      const text = span.text.slice(cursor, boundary - offset);
      if (text.length > 0) {
        result.push({ text, style: span.style, highlighted: range !== null });
      }
      cursor = boundary - offset;
    }
    offset += span.text.length;
  }
  return result;
}
