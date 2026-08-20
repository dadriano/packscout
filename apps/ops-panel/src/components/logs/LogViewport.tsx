import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogRow } from "../../api/panel-types.ts";
import {
  TEXT_SIZE_ROW_HEIGHT,
  type LogDisplayPreferences,
} from "../../logs/display-preferences.ts";
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
 */

/**
 * The clock, as a subscription rather than a render-time read.
 *
 * Relative timestamps are only true for an instant, so they advance on their
 * own second rather than whenever the component happens to re-render.
 */
function useTickingClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export interface LogViewportProps {
  rows: readonly LogRow[];
  /** Changes whenever the buffer mutates. */
  version: number;
  preferences: LogDisplayPreferences;
  following: boolean;
  onFollowingChange: (following: boolean) => void;
  onAnchorChange: (id: string | null) => void;
  emptyMessage: string;
}

export function LogViewport({
  rows,
  version,
  preferences,
  following,
  onFollowingChange,
  onAnchorChange,
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
            rowCount: rows.length,
          })
        : computeFixedWindow({
            scrollTop,
            viewportHeight,
            rowHeight,
            rowCount: rows.length,
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      measuredVersion,
      metrics,
      preferences.wrap,
      rowHeight,
      rows.length,
      scrollTop,
      version,
      viewportHeight,
    ],
  );

  const visible = rows.slice(virtual.startIndex, virtual.endIndex);

  const handleScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setScrollTop(scroller.scrollTop);
    const atBottom = isAtBottom(
      scroller.scrollTop,
      scroller.clientHeight,
      scroller.scrollHeight,
    );
    if (atBottom !== following) onFollowingChange(atBottom);
  }, [following, onFollowingChange]);

  // Report the top visible row so eviction can be kept away from it.
  useEffect(() => {
    if (following) {
      onAnchorChange(null);
      return;
    }
    onAnchorChange(rows[virtual.startIndex]?.id ?? null);
  }, [following, onAnchorChange, rows, virtual.startIndex]);

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

  const now = useTickingClock(preferences.timestamps === "relative");

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
      {rows.length === 0 ? (
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
            {visible.map((row) => (
              <LogRowView
                key={row.id}
                row={row}
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
