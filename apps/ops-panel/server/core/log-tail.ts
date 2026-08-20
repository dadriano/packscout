import {
  createLogLineSplitter,
  type LogLineSplitter,
} from "./log-line-splitter.ts";
import {
  createLogMarkerRecord,
  type LogLineRecord,
  type LogMarkerRecord,
} from "./log-records.ts";
import type { ByteRange } from "./log-window.ts";

/**
 * One service's tail: a state machine over what the filesystem reports, with no
 * filesystem access of its own.
 *
 * Dev processes restart, editors truncate, rotation replaces a file behind its
 * name, and a service can vanish for a while. A tail that ignores any of those
 * either silently repeats bytes it already published or silently drops bytes it
 * never read. This machine never does either: every discontinuity ends the
 * current generation, restarts offsets at zero, and publishes a marker saying
 * what happened.
 *
 * Bounded work is a design constraint, not an optimisation:
 *
 *  - `observe` returns at most `readCapBytes` of work per tick, so a burst
 *    cannot monopolise the process;
 *  - a tail that has fallen further behind than `catchUpLimitBytes` jumps
 *    forward and *says so*, rather than spending minutes replaying history a
 *    live viewer did not ask for;
 *  - with no viewer attached the machine tracks identity and size only, and
 *    returns no read plan at all, so an idle panel reads no file content.
 *
 * Known bound of the polling approach: a truncation is detected by the file
 * shrinking. If a process truncates and then writes *past* the previous size
 * between two ticks, no signal remains — no polling tailer can see that, and
 * the panel does not pretend otherwise. Inode changes (rotation) are caught
 * regardless of timing.
 */

/** Maximum bytes one tick may read from one file. */
export const DEFAULT_READ_CAP_BYTES = 256 * 1024;

/** Falling further behind than this is reported and skipped, not replayed. */
export const DEFAULT_CATCH_UP_LIMIT_BYTES = 4 * 1024 * 1024;

export type LogFileObservation =
  | { present: false }
  | { present: true; fileId: string; sizeBytes: number };

export interface TailEmission {
  lines: LogLineRecord[];
  markers: LogMarkerRecord[];
}

export interface TailObservation extends TailEmission {
  /** Bytes the caller should read and hand back to `ingest`, if any. */
  read: ByteRange | null;
  /** Set when the tail must align before it can stream. */
  align: ByteRange | null;
}

export interface LogTailerOptions {
  service: string;
  /** Allocates marker sequence numbers; shared across every tailer. */
  nextSequence: () => number;
  readCapBytes?: number;
  catchUpLimitBytes?: number;
  alignmentScanBytes?: number;
  maxLineBytes?: number;
  holdMs?: number;
}

export interface LogTailer {
  readonly service: string;
  generation(): number;
  /** Read position within the current generation, or null before alignment. */
  cursor(): number | null;
  isPresent(): boolean;
  fileId(): string | null;
  sizeBytes(): number;
  viewerCount(): number;
  isActive(): boolean;
  /** Reference-counted attach; the returned function detaches exactly once. */
  attach(): () => void;
  observe(observation: LogFileObservation, nowMs: number): TailObservation;
  /** Hand back the bytes an `align` range asked for. */
  adoptAlignment(range: ByteRange, bytes: Uint8Array): void;
  /** Hand back the bytes a `read` range asked for. */
  ingest(range: ByteRange, bytes: Uint8Array, nowMs: number): TailEmission;
  /** Timer-driven: publishes a held partial line whose hold has expired. */
  tick(nowMs: number): TailEmission;
}

const MARKER_DETAIL: Record<string, string> = {
  truncated: "Log restarted — the file was truncated in place.",
  replaced: "Log restarted — a new file took over this name.",
  missing: "File disappeared — waiting for it to come back.",
  discovered: "File appeared.",
};

export function createLogTailer({
  service,
  nextSequence,
  readCapBytes = DEFAULT_READ_CAP_BYTES,
  catchUpLimitBytes = DEFAULT_CATCH_UP_LIMIT_BYTES,
  alignmentScanBytes = 64 * 1024,
  maxLineBytes,
  holdMs,
}: LogTailerOptions): LogTailer {
  let generation = 0;
  let cursor: number | null = null;
  let present = false;
  let observed = false;
  let fileId: string | null = null;
  let sizeBytes = 0;
  let viewers = 0;
  let splitter: LogLineSplitter | null = null;

  function marker(
    kind: "restarted" | "disappeared" | "appeared" | "skipped",
    reason: "truncated" | "replaced" | "missing" | "discovered" | "catch_up",
    nowMs: number,
    extra: { detail?: string; skippedBytes?: number } = {},
  ): LogMarkerRecord {
    return createLogMarkerRecord({
      kind,
      reason,
      service,
      generation,
      offset: cursor ?? 0,
      observedAt: new Date(nowMs).toISOString(),
      detail: extra.detail ?? MARKER_DETAIL[reason] ?? reason,
      sequence: nextSequence(),
      ...(extra.skippedBytes === undefined
        ? {}
        : { skippedBytes: extra.skippedBytes }),
    });
  }

  function startGeneration(): void {
    generation += 1;
    cursor = 0;
    splitter = createLogLineSplitter({
      service,
      generation,
      offset: 0,
      maxLineBytes,
      holdMs,
    });
  }

  function forceFlush(nowMs: number): LogLineRecord[] {
    return splitter?.flush(nowMs, { force: true }) ?? [];
  }

  const tailer: LogTailer = {
    service,
    generation: () => generation,
    cursor: () => cursor,
    isPresent: () => present,
    fileId: () => fileId,
    sizeBytes: () => sizeBytes,
    viewerCount: () => viewers,
    isActive: () => viewers > 0,

    attach() {
      viewers += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        viewers = Math.max(0, viewers - 1);
        if (viewers === 0) {
          // Passive again: forget the read position so the next viewer
          // re-aligns against the file as it is then, rather than replaying
          // everything written while nobody was watching.
          cursor = null;
          splitter = null;
        }
      };
    },

    observe(observation, nowMs) {
      const lines: LogLineRecord[] = [];
      const markers: LogMarkerRecord[] = [];

      if (!observation.present) {
        if (present || !observed) {
          if (present) {
            lines.push(...forceFlush(nowMs));
            markers.push(marker("disappeared", "missing", nowMs));
          }
          present = false;
          fileId = null;
          sizeBytes = 0;
          cursor = null;
          splitter = null;
        }
        observed = true;
        return { lines, markers, read: null, align: null };
      }

      const reappeared = observed && !present;
      const replaced = present && fileId !== null && fileId !== observation.fileId;
      // Shrinking is the only signal a truncation leaves behind, and it is
      // compared against the last observed size rather than the read cursor so
      // a passive tailer notices it too.
      const truncated =
        present &&
        fileId === observation.fileId &&
        observation.sizeBytes < sizeBytes;

      if (replaced || truncated) {
        lines.push(...forceFlush(nowMs));
        startGeneration();
        markers.push(
          marker("restarted", replaced ? "replaced" : "truncated", nowMs),
        );
      } else if (reappeared) {
        startGeneration();
        markers.push(marker("appeared", "discovered", nowMs));
      } else if (!observed) {
        // First sight of a file that was already there when the panel started
        // is not an event; it is simply where the story begins.
        generation += 1;
      }

      present = true;
      observed = true;
      fileId = observation.fileId;
      sizeBytes = observation.sizeBytes;

      if (viewers === 0) {
        // Passive: identity and size only. No content is read, and no cursor is
        // kept, so attaching later starts from the file as it is then.
        cursor = null;
        splitter = null;
        return { lines, markers, read: null, align: null };
      }

      if (cursor === null) {
        // A viewer just arrived. Align to the last complete line before
        // end-of-file with one bounded backward read.
        const bounded = Math.max(0, Math.min(sizeBytes, alignmentScanBytes));
        return {
          lines,
          markers,
          read: null,
          align: { offset: sizeBytes - bounded, length: bounded },
        };
      }

      if (sizeBytes <= cursor) {
        return { lines, markers, read: null, align: null };
      }

      const behind = sizeBytes - cursor;
      if (behind > catchUpLimitBytes) {
        const target = sizeBytes - readCapBytes;
        const skippedBytes = target - cursor;
        lines.push(...forceFlush(nowMs));
        splitter?.reset(generation, target, { dropLeadingPartial: true });
        cursor = target;
        markers.push(
          marker("skipped", "catch_up", nowMs, {
            skippedBytes,
            detail: `Skipped ${skippedBytes} bytes — this log grew faster than the panel reads it.`,
          }),
        );
      }

      const length = Math.min(readCapBytes, sizeBytes - (cursor as number));
      return {
        lines,
        markers,
        read: { offset: cursor as number, length },
        align: null,
      };
    },

    adoptAlignment(range, bytes) {
      if (cursor !== null) return;
      if (viewers === 0) return;
      const boundary = bytes.lastIndexOf(0x0a);
      const aligned =
        boundary === -1 ? range.offset : range.offset + boundary + 1;
      cursor = aligned;
      splitter = createLogLineSplitter({
        service,
        generation,
        offset: aligned,
        maxLineBytes,
        holdMs,
      });
    },

    ingest(range, bytes, nowMs) {
      // A range that no longer matches the cursor belongs to a generation that
      // has since ended; publishing it would fabricate offsets.
      if (cursor === null || range.offset !== cursor || splitter === null) {
        return { lines: [], markers: [] };
      }
      const lines = splitter.append(bytes, nowMs);
      cursor = range.offset + bytes.length;
      return { lines, markers: [] };
    },

    tick(nowMs) {
      return { lines: splitter?.flush(nowMs) ?? [], markers: [] };
    },
  };

  return tailer;
}
