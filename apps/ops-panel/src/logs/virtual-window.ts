/**
 * Which rows to actually render.
 *
 * A full buffer is tens of thousands of rows and no browser will lay that out
 * at sixty frames a second, so only the slice under the viewport is mounted and
 * the rest is represented by spacer height.
 *
 * There are two modes because wrapping changes what is knowable. With wrapping
 * off, every row is exactly one line tall, so the visible slice is arithmetic —
 * no measurement, no layout thrash. With wrapping on, a row's height depends on
 * its text and the pane's width, so heights are measured as rows are mounted
 * and remembered; unmeasured rows fall back to the single-line height, which is
 * a floor rather than a guess and settles as soon as they scroll into view.
 *
 * Both are pure functions over numbers, so scroll maths is testable without a
 * layout engine.
 */

export interface VirtualWindow {
  startIndex: number;
  /** Exclusive. */
  endIndex: number;
  /** Height of the unrendered rows above the slice. */
  offsetTop: number;
  /** Height of every row, rendered or not. */
  totalHeight: number;
}

export interface FixedWindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
}

export function computeFixedWindow({
  scrollTop,
  viewportHeight,
  rowHeight,
  rowCount,
  overscan = 12,
}: FixedWindowInput): VirtualWindow {
  const totalHeight = rowCount * rowHeight;
  if (rowCount === 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 };
  }
  const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rowCount, firstVisible + visibleCount + overscan);
  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * rowHeight,
    totalHeight,
  };
}

/**
 * Row heights for wrapped mode: measured where known, estimated where not, with
 * running offsets maintained incrementally so a scroll is a binary search
 * rather than a sum over the whole buffer.
 */
export interface RowMetrics {
  /** Record a measured height; returns true when it changed the layout. */
  measure(index: number, height: number): boolean;
  /** Forget every measurement, e.g. after a width change or a wrap toggle. */
  clear(): void;
  /** Drop measurements for rows evicted from the head of the buffer. */
  shift(count: number): void;
  setRowCount(count: number): void;
  heightAt(index: number): number;
  offsetOf(index: number): number;
  totalHeight(): number;
  indexAt(scrollTop: number): number;
}

export function createRowMetrics(estimatedHeight: number): RowMetrics {
  let heights: number[] = [];
  let offsets: number[] = [0];
  let dirtyFrom = 0;
  let rowCount = 0;

  function rebuild(): void {
    if (dirtyFrom >= offsets.length) dirtyFrom = Math.max(0, offsets.length - 1);
    for (let index = dirtyFrom; index < rowCount; index += 1) {
      offsets[index + 1] =
        (offsets[index] ?? 0) + (heights[index] ?? estimatedHeight);
    }
    offsets.length = rowCount + 1;
    dirtyFrom = rowCount;
  }

  return {
    measure(index, height) {
      if (index < 0 || index >= rowCount) return false;
      const rounded = Math.max(1, Math.round(height));
      if (heights[index] === rounded) return false;
      heights[index] = rounded;
      dirtyFrom = Math.min(dirtyFrom, index);
      return true;
    },
    clear() {
      heights = [];
      offsets = [0];
      dirtyFrom = 0;
    },
    shift(count) {
      if (count <= 0) return;
      heights = heights.slice(count);
      dirtyFrom = 0;
    },
    setRowCount(count) {
      if (count === rowCount) return;
      dirtyFrom = Math.min(dirtyFrom, Math.max(0, Math.min(count, rowCount)));
      rowCount = count;
    },
    heightAt: (index) => heights[index] ?? estimatedHeight,
    offsetOf(index) {
      rebuild();
      return offsets[Math.max(0, Math.min(index, rowCount))] ?? 0;
    },
    totalHeight() {
      rebuild();
      return offsets[rowCount] ?? 0;
    },
    indexAt(scrollTop) {
      rebuild();
      const target = Math.max(0, scrollTop);
      let low = 0;
      let high = rowCount;
      while (low < high) {
        const middle = (low + high) >> 1;
        if ((offsets[middle + 1] ?? 0) <= target) low = middle + 1;
        else high = middle;
      }
      return Math.min(low, Math.max(0, rowCount - 1));
    },
  };
}

export interface MeasuredWindowInput {
  scrollTop: number;
  viewportHeight: number;
  metrics: RowMetrics;
  rowCount: number;
  overscan?: number;
}

export function computeMeasuredWindow({
  scrollTop,
  viewportHeight,
  metrics,
  rowCount,
  overscan = 12,
}: MeasuredWindowInput): VirtualWindow {
  metrics.setRowCount(rowCount);
  if (rowCount === 0) {
    return { startIndex: 0, endIndex: 0, offsetTop: 0, totalHeight: 0 };
  }
  const first = metrics.indexAt(scrollTop);
  const startIndex = Math.max(0, first - overscan);

  let endIndex = first;
  let consumed = metrics.offsetOf(first) - scrollTop;
  while (endIndex < rowCount && consumed < viewportHeight) {
    consumed += metrics.heightAt(endIndex);
    endIndex += 1;
  }
  endIndex = Math.min(rowCount, endIndex + overscan);

  return {
    startIndex,
    endIndex,
    offsetTop: metrics.offsetOf(startIndex),
    totalHeight: metrics.totalHeight(),
  };
}

/** How close to the bottom still counts as following the tail. */
export const FOLLOW_THRESHOLD_PX = 24;

export function isAtBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = FOLLOW_THRESHOLD_PX,
): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
