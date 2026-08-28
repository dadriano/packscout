/**
 * Keeping the reader's place while content arrives above it.
 *
 * Prepending older lines moves every row on screen down by the height of what
 * was inserted. Without a correction the text someone is reading jumps away
 * mid-sentence, which is exactly the moment they were concentrating hardest —
 * so infinite scrollback that does not anchor is worse than no scrollback.
 *
 * The correction is expressed as a *row* and a *gap* rather than as a pixel
 * delta, because the inserted rows are not all the same height when wrapping is
 * on and because rows can also be evicted from the head between two frames. A
 * row identity survives both; a delta does not.
 *
 * Pure arithmetic on purpose: the viewport supplies the offsets it measured and
 * this module decides where to scroll, so the reasoning is provable without a
 * layout engine.
 */

export interface ScrollAnchor {
  /** The row being held still. */
  id: string;
  /** Pixels between the top of that row and the top of the viewport. */
  gap: number;
}

/** How close to the top of the buffer starts fetching the page above. */
export const HISTORY_TRIGGER_PX = 400;

export function captureScrollAnchor(
  id: string | undefined,
  rowTop: number,
  scrollTop: number,
): ScrollAnchor | null {
  if (id === undefined) return null;
  return { id, gap: rowTop - scrollTop };
}

/** Where to scroll so the anchored row sits exactly where it did before. */
export function anchoredScrollTop(anchor: ScrollAnchor, rowTop: number): number {
  return Math.max(0, rowTop - anchor.gap);
}

/**
 * True when the reader is close enough to the top that the page above should
 * already be loading. Following the tail is excluded: the top of the buffer is
 * nowhere near the viewport, and a stream that fetched history on every frame
 * would never stop.
 */
export function shouldLoadOlder({
  scrollTop,
  following,
  rowCount,
  threshold = HISTORY_TRIGGER_PX,
}: {
  scrollTop: number;
  following: boolean;
  rowCount: number;
  threshold?: number;
}): boolean {
  if (following || rowCount === 0) return false;
  return scrollTop <= threshold;
}

/** The index of a row id, or -1. Kept here so the viewport stays declarative. */
export function indexOfRow(ids: readonly string[], id: string): number {
  return ids.indexOf(id);
}
