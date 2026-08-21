import {
  PANEL_MARKER_SCOPE,
  type LogLineRecord,
  type LogMarkerRecord,
  type LogRow,
} from "../api/panel-types.ts";

/**
 * The client-side log buffer.
 *
 * Three sources feed one buffer — the initial window, the live stream, and
 * (admin-tools/012) history reads — and they overlap by design, because an
 * overlap is the only way to guarantee there is no gap. Deduplication is by
 * identity, never by position or content, so a line that arrives twice is
 * recognised as the same line rather than printed twice.
 *
 * Eviction has two tiers, because the cost of dropping a line depends entirely
 * on where the reader is looking:
 *
 *  - *following* — the reader is pinned to the newest output and never sees the
 *    top of the buffer, so trimming the head is free and the limit is applied
 *    freely;
 *  - *scrolled back* — the reader is reading specific text, and trimming the
 *    head would slide that text out from under them. Eviction there is strictly
 *    guarded: it never removes the anchor row or anything after it. Memory is
 *    still bounded, so when the guard blocks eviction the buffer refuses new
 *    rows instead — and says how many it refused, rather than quietly losing
 *    them.
 *
 * Pausing works the same way: bounded holding, and an explicit count when the
 * bound is exceeded.
 *
 * Rows are held in one array that is mutated in place; `version()` changes on
 * every mutation so a renderer can subscribe without copying tens of thousands
 * of rows per frame.
 */

/** Rows kept while the reader is following the tail. */
export const DEFAULT_FOLLOWING_LIMIT = 20_000;

/** Hard ceiling while the reader is scrolled back. */
export const DEFAULT_BROWSING_LIMIT = 50_000;

/** Rows held while paused before the oldest held rows are dropped. */
export const DEFAULT_PAUSE_LIMIT = 5_000;

export type InjectedMarkerReason = "paused" | "browsing";

export interface LogBufferOptions {
  followingLimit?: number;
  browsingLimit?: number;
  pauseLimit?: number;
  /** Supplies the marker rows the buffer injects on the reader's behalf. */
  createMarker: (input: {
    reason: InjectedMarkerReason;
    detail: string;
    skippedLines: number;
  }) => LogMarkerRecord;
}

export interface LogBufferChange {
  /** Rows actually added to the buffer. */
  admitted: number;
  /** Rows recognised as already present. */
  duplicates: number;
  /** Rows removed from the head to stay inside a limit. */
  evicted: number;
  /** Rows refused because eviction was blocked by the reader's anchor. */
  refused: number;
  /** Rows currently held aside because the buffer is paused. */
  held: number;
}

export interface LogBuffer {
  /** The live row array. Treat as read-only; use `version()` to detect change. */
  rows(): readonly LogRow[];
  version(): number;
  size(): number;
  has(id: string): boolean;
  append(rows: readonly LogRow[]): LogBufferChange;
  /**
   * Rows the reader asked for by browsing (admin-tools/012), added at the tail.
   *
   * A pause holds *live* output so the reader's place is not disturbed by
   * arrivals they did not ask for. History is the opposite: it is the thing
   * they asked for, and holding it would leave the pane empty while the panel
   * pretends to be busy. So it lands immediately, pause or no pause.
   */
  appendHistory(rows: readonly LogRow[]): LogBufferChange;
  /** Older rows, for admin-tools/012's backwards paging. */
  prepend(rows: readonly LogRow[]): LogBufferChange;
  isFollowing(): boolean;
  /** Returning to the tail flushes any accounting the reader is owed. */
  setFollowing(following: boolean): void;
  /** The row the reader is looking at; eviction will not pass it. */
  setAnchor(id: string | null): void;
  anchor(): string | null;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  heldCount(): number;
  skippedWhilePaused(): number;
  reset(): void;
}

function emptyChange(): LogBufferChange {
  return { admitted: 0, duplicates: 0, evicted: 0, refused: 0, held: 0 };
}

export function createLogBuffer({
  followingLimit = DEFAULT_FOLLOWING_LIMIT,
  browsingLimit = DEFAULT_BROWSING_LIMIT,
  pauseLimit = DEFAULT_PAUSE_LIMIT,
  createMarker,
}: LogBufferOptions): LogBuffer {
  const rows: LogRow[] = [];
  let identities = new Set<string>();
  let version = 0;
  let following = true;
  let paused = false;
  let anchorId: string | null = null;
  const held: LogRow[] = [];
  let skippedWhilePaused = 0;
  let refusedWhileBrowsing = 0;

  function anchorIndex(): number {
    if (anchorId === null) return -1;
    return rows.findIndex((row) => row.id === anchorId);
  }

  /** Trim the head, never past the anchor. Returns how many rows went. */
  function evict(limit: number): number {
    if (rows.length <= limit) return 0;
    let removable = rows.length - limit;
    if (!following) {
      const index = anchorIndex();
      if (index >= 0) removable = Math.min(removable, index);
    }
    if (removable <= 0) return 0;
    for (const row of rows.splice(0, removable)) identities.delete(row.id);
    return removable;
  }

  function admit(incoming: readonly LogRow[], atHead: boolean): LogBufferChange {
    const change = emptyChange();
    const fresh: LogRow[] = [];
    for (const row of incoming) {
      if (identities.has(row.id)) {
        change.duplicates += 1;
        continue;
      }
      identities.add(row.id);
      fresh.push(row);
    }
    if (fresh.length === 0) return change;

    if (atHead) rows.unshift(...fresh);
    else for (const row of fresh) rows.push(row);
    change.admitted = fresh.length;
    version += 1;

    change.evicted = evict(following ? followingLimit : browsingLimit);

    if (!following && rows.length > browsingLimit) {
      // Eviction is blocked by the anchor, so the excess is refused from the
      // tail instead of letting the buffer grow without bound.
      const excess = rows.length - browsingLimit;
      for (const row of rows.splice(rows.length - excess, excess)) {
        identities.delete(row.id);
      }
      change.admitted -= excess;
      change.refused = excess;
      refusedWhileBrowsing += excess;
    }
    return change;
  }

  function injectMarker(reason: InjectedMarkerReason, count: number): void {
    const noun = count === 1 ? "line" : "lines";
    const detail =
      reason === "paused"
        ? `${count} ${noun} skipped while paused.`
        : `${count} ${noun} skipped while scrolled back — the buffer was full.`;
    const marker = createMarker({ reason, detail, skippedLines: count });
    admit([{ type: "marker", ...marker }], false);
  }

  function drainHeld(): void {
    if (held.length > 0) {
      const pending = held.splice(0, held.length);
      admit(pending, false);
    }
    if (skippedWhilePaused > 0) {
      const skipped = skippedWhilePaused;
      skippedWhilePaused = 0;
      injectMarker("paused", skipped);
    }
  }

  return {
    rows: () => rows,
    version: () => version,
    size: () => rows.length,
    has: (id) => identities.has(id),
    skippedWhilePaused: () => skippedWhilePaused,

    append(incoming) {
      if (!paused) return admit(incoming, false);
      const change = emptyChange();
      for (const row of incoming) {
        if (identities.has(row.id)) {
          change.duplicates += 1;
          continue;
        }
        held.push(row);
      }
      if (held.length > pauseLimit) {
        const excess = held.length - pauseLimit;
        held.splice(0, excess);
        skippedWhilePaused += excess;
      }
      change.held = held.length;
      return change;
    },

    appendHistory(incoming) {
      return admit(incoming, false);
    },

    prepend(incoming) {
      return admit(incoming, true);
    },

    isFollowing: () => following,

    setFollowing(next) {
      if (following === next) return;
      following = next;
      if (!following) return;
      if (refusedWhileBrowsing > 0) {
        const refused = refusedWhileBrowsing;
        refusedWhileBrowsing = 0;
        injectMarker("browsing", refused);
      }
      if (evict(followingLimit) > 0) version += 1;
    },

    setAnchor(id) {
      anchorId = id;
    },
    anchor: () => anchorId,

    isPaused: () => paused,
    setPaused(next) {
      if (paused === next) return;
      paused = next;
      if (!paused) drainHeld();
    },
    heldCount: () => held.length,

    reset() {
      rows.length = 0;
      held.length = 0;
      identities = new Set();
      skippedWhilePaused = 0;
      refusedWhileBrowsing = 0;
      anchorId = null;
      version += 1;
    },
  };
}

/**
 * Order one service's stream batch into rows.
 *
 * The wire keeps lines and markers apart because they are different shapes, but
 * their relative order carries meaning: a half-written line flushed by a
 * restart belongs *before* the restart marker, and the new generation's output
 * belongs after it. `(generation, offset)` reconstructs that exactly, with
 * markers winning ties so a marker introduces the lines it explains.
 */
export function toLogRows(
  lines: readonly LogLineRecord[],
  markers: readonly LogMarkerRecord[],
): LogRow[] {
  const rows: LogRow[] = [
    ...markers.map((marker): LogRow => ({ type: "marker", ...marker })),
    ...lines.map((line): LogRow => ({ type: "line", ...line })),
  ];
  return rows.sort((left, right) => {
    if (left.service !== right.service) {
      return left.service.localeCompare(right.service, "en-US");
    }
    if (left.generation !== right.generation) {
      return left.generation - right.generation;
    }
    if (left.offset !== right.offset) return left.offset - right.offset;
    if (left.type === right.type) return 0;
    return left.type === "marker" ? -1 : 1;
  });
}

/** Markers that belong to the panel rather than to any one service. */
export function isPanelMarker(row: LogRow): boolean {
  return row.type === "marker" && row.service === PANEL_MARKER_SCOPE;
}
