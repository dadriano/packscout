import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../../hooks/useNow.ts";
import {
  TEXT_SIZE_ROW_HEIGHT,
  type LogDisplayPreferences,
} from "../../logs/display-preferences.ts";
import type { HighlightRange } from "../../logs/highlight.ts";
import type { FactsLookup, LogDisplayItem } from "../../logs/line-groups.ts";
import {
  anchoredScrollTop,
  captureScrollAnchor,
  shouldLoadOlder,
  type ScrollAnchor,
} from "../../logs/scroll-anchor.ts";
import {
  computeFixedWindow,
  computeMeasuredWindow,
  createRowMetrics,
  isAtBottom,
} from "../../logs/virtual-window.ts";
import { LogRowView } from "./LogRowView.tsx";

/**
 * The scrolling log pane.
 *
 * Bottom-anchored: while the reader is following, new output pins the view to
 * the newest line. Following is *inferred* from scroll position rather than
 * toggled, because that is what the gesture already means — scrolling up is how
 * a person says "hold still", and no separate control should be required to say
 * it again.
 *
 * The reader's top visible row is reported upwards as the anchor so the buffer
 * knows which text must not be evicted out from under them.
 *
 * That same row does a second job when history (admin-tools/012) prepends older
 * output above it. Inserting rows moves everything on screen down by whatever
 * they happen to be tall, so the pane re-scrolls to keep the anchored row under
 * the reader's eye. Without it, scrolling up would throw the text away exactly
 * when someone is concentrating on it.
 */

export interface LogViewportProps {
  /** The rendered rows: standalone lines, fold heads, and revealed members. */
  items: readonly LogDisplayItem[];
  /** Changes whenever the buffer mutates. */
  version: number;
  preferences: LogDisplayPreferences;
  following: boolean;
  onFollowingChange: (following: boolean) => void;
  onAnchorChange: (id: string | null) => void;
  facts: FactsLookup;
  highlight: (text: string) => HighlightRange[];
  onToggleGroup: (groupId: string) => void;
  /** Copy one group whole, folded members included. */
  onCopyRow: (groupId: string) => void;
  /** Called when the reader nears the top and older output should load. */
  onReachTop: () => void;
  /** A row to centre and mark, e.g. the search result being read in context. */
  focusedId: string | null;
  emptyMessage: string;
}

export function LogViewport({
  items,
  version,
  preferences,
  following,
  onFollowingChange,
  onAnchorChange,
  facts,
  highlight,
  onToggleGroup,
  onCopyRow,
  onReachTop,
  focusedId,
  emptyMessage,
}: LogViewportProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sliceRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ height: 480, width: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [measuredVersion, setMeasuredVersion] = useState(0);
  const viewportHeight = viewport.height;

  const rowHeight = TEXT_SIZE_ROW_HEIGHT[preferences.textSize];
  // Measurements are only valid for the layout that produced them, so a wrap,
  // size, or width change gets a fresh set rather than a cleared one — there is
  // then no moment where stale heights could be read.
  const metrics = useMemo(
    () => createRowMetrics(rowHeight),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowHeight, preferences.wrap, viewport.width],
  );

  // `measuredVersion` is a dependency rather than an input: a new measurement
  // changes the layout even though none of the other arguments moved.
  const virtual = useMemo(
    () =>
      preferences.wrap
        ? computeMeasuredWindow({
            scrollTop,
            viewportHeight,
            metrics,
            rowCount: items.length,
          })
        : computeFixedWindow({
            scrollTop,
            viewportHeight,
            rowHeight,
            rowCount: items.length,
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      measuredVersion,
      metrics,
      preferences.wrap,
      rowHeight,
      items.length,
      scrollTop,
      version,
      viewportHeight,
    ],
  );

  const visible = items.slice(virtual.startIndex, virtual.endIndex);

  /** Where a row's top edge sits inside the canvas, measured or arithmetic. */
  const offsetOf = useCallback(
    (index: number) =>
      preferences.wrap ? metrics.offsetOf(index) : index * rowHeight,
    [metrics, preferences.wrap, rowHeight],
  );
  const indexAt = useCallback(
    (top: number) =>
      preferences.wrap
        ? metrics.indexAt(top)
        : Math.max(0, Math.floor(top / rowHeight)),
    [metrics, preferences.wrap, rowHeight],
  );

  const anchorRef = useRef<ScrollAnchor | null>(null);
  const anchorIndexRef = useRef(-1);
  const centredFor = useRef<string | null>(null);

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.scrollTop;
    setScrollTop(top);
    const atBottom = isAtBottom(top, scroller.clientHeight, scroller.scrollHeight);
    if (atBottom !== following) onFollowingChange(atBottom);

    // Remember the row under the reader's eye before anything can be inserted
    // above it, so the correction below has something true to restore.
    const index = Math.min(indexAt(top), Math.max(0, items.length - 1));
    anchorRef.current = atBottom
      ? null
      : captureScrollAnchor(items[index]?.id, offsetOf(index), top);
    anchorIndexRef.current = atBottom ? -1 : index;

    if (shouldLoadOlder({ scrollTop: top, following: atBottom, rowCount: items.length })) {
      onReachTop();
    }
  }, [following, indexAt, items, offsetOf, onFollowingChange, onReachTop]);

  // Older output arrived above: put the anchored row back where it was.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const anchor = anchorRef.current;
    if (!scroller || !anchor || following) return;
    const index = items.findIndex((item) => item.id === anchor.id);
    // A row evicted while the page was in flight cannot be restored to; leaving
    // the view alone is better than scrolling somewhere arbitrary.
    if (index < 0 || index === anchorIndexRef.current) return;
    anchorIndexRef.current = index;
    const next = anchoredScrollTop(anchor, offsetOf(index));
    if (Math.abs(next - scroller.scrollTop) < 1) return;
    scroller.scrollTop = next;
    setScrollTop(next);
  }, [following, items, offsetOf]);

  // A search result opens centred, so the match is read in its context rather
  // than at the edge of the pane.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || focusedId === null || centredFor.current === focusedId) return;
    const index = items.findIndex((item) => item.id === focusedId);
    if (index < 0) return;
    centredFor.current = focusedId;
    const next = Math.max(0, offsetOf(index) - scroller.clientHeight / 2);
    scroller.scrollTop = next;
    setScrollTop(next);
  }, [focusedId, items, offsetOf]);

  // Report the top visible row so eviction can be kept away from it.
  useEffect(() => {
    if (following) {
      onAnchorChange(null);
      return;
    }
    onAnchorChange(items[virtual.startIndex]?.row.id ?? null);
  }, [following, onAnchorChange, items, virtual.startIndex]);

  // The pane's own size is an external system: subscribe to it, and let the
  // width feed the measurement identity above.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const record = () => {
      setViewport((current) =>
        current.height === scroller.clientHeight &&
        current.width === scroller.clientWidth
          ? current
          : { height: scroller.clientHeight, width: scroller.clientWidth },
      );
    };
    const observer = new ResizeObserver(record);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Measure what was actually rendered, so wrapped rows stop being estimates.
  useLayoutEffect(() => {
    if (!preferences.wrap) return;
    const slice = sliceRef.current;
    if (!slice) return;
    let changed = false;
    for (const [index, element] of [...slice.children].entries()) {
      if (metrics.measure(virtual.startIndex + index, element.clientHeight)) {
        changed = true;
      }
    }
    if (changed) setMeasuredVersion((value) => value + 1);
  }, [metrics, preferences.wrap, version, virtual.startIndex, visible.length]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !following) return;
    scroller.scrollTop = scroller.scrollHeight;
    setScrollTop(scroller.scrollTop);
  }, [following, version, viewportHeight, preferences.wrap, preferences.textSize]);

  const now = useNow(1_000, preferences.timestamps === "relative");

  return (
    <div
      className="panel-log-viewport"
      data-wrap={preferences.wrap ? "on" : "off"}
      data-size={preferences.textSize}
      ref={scrollerRef}
      onScroll={handleScroll}
      tabIndex={0}
      role="log"
      aria-label="Service output"
      aria-live="off"
    >
      {items.length === 0 ? (
        <p className="panel-log-empty">{emptyMessage}</p>
      ) : (
        <div
          className="panel-log-canvas"
          style={{ height: `${virtual.totalHeight}px` }}
        >
          <div
            className="panel-log-slice"
            ref={sliceRef}
            style={{ transform: `translateY(${virtual.offsetTop}px)` }}
          >
            {visible.map((item) => (
              <LogRowView
                key={item.id}
                item={item}
                facts={facts}
                highlight={highlight}
                onToggleGroup={onToggleGroup}
                onCopyRow={onCopyRow}
                focused={item.id === focusedId}
                timestamps={preferences.timestamps}
                ansi={preferences.ansi}
                now={now}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
