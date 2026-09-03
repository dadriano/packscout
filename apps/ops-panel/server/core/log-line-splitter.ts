import {
  createLogLineRecord,
  type LogLineRecord,
} from "./log-records.ts";

/**
 * Byte-accurate line splitting for one file generation.
 *
 * A tail reads whatever bytes happen to be on disk at the moment it looks, so
 * the last line of a read is routinely half-written. Splitting on it would
 * publish two rows for one line and corrupt every subsequent offset, so an
 * unterminated tail is *held* until its terminator arrives. Holding forever is
 * equally dishonest — a process that logs a long progress line without a
 * newline would look silent — so the hold is bounded twice over: by size and by
 * a wall-clock timer. A forced flush is published with `partial: true` and the
 * continuation arrives as its own record, which is visible rather than silent.
 *
 * Offsets are counted in bytes, never in string length, because identity is
 * shared with reads that address the file by byte offset. Decoding happens per
 * line, after the boundary is known.
 */

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** Beyond this, an unterminated line is published rather than held. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

/** How long an unterminated line may be held before it is published. */
export const DEFAULT_LINE_HOLD_MS = 250;

const decoder = new TextDecoder("utf-8", { fatal: false });

export interface LogLineSplitterOptions {
  service: string;
  generation?: number;
  offset?: number;
  maxLineBytes?: number;
  holdMs?: number;
}

export interface LogLineSplitter {
  readonly service: string;
  generation(): number;
  /** Offset the next emitted line will start at. */
  pendingOffset(): number;
  pendingBytes(): number;
  /**
   * Start a new generation (or reposition within one). `dropLeadingPartial`
   * discards bytes up to the first terminator, which is how a cursor that
   * jumped into the middle of a line re-aligns.
   */
  reset(
    generation: number,
    offset: number,
    options?: { dropLeadingPartial?: boolean },
  ): void;
  append(bytes: Uint8Array, nowMs: number): LogLineRecord[];
  /** Publish a held line when its hold expired, or unconditionally when forced. */
  flush(nowMs: number, options?: { force?: boolean }): LogLineRecord[];
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const merged = new Uint8Array(total);
  let written = 0;
  for (const chunk of chunks) {
    merged.set(chunk, written);
    written += chunk.length;
  }
  return merged;
}

function decodeLine(bytes: Uint8Array): string {
  const end =
    bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN
      ? bytes.length - 1
      : bytes.length;
  return decoder.decode(bytes.subarray(0, end));
}

export function createLogLineSplitter({
  service,
  generation: initialGeneration = 1,
  offset: initialOffset = 0,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  holdMs = DEFAULT_LINE_HOLD_MS,
}: LogLineSplitterOptions): LogLineSplitter {
  let generation = initialGeneration;
  let pendingOffset = initialOffset;
  let held: Uint8Array[] = [];
  let heldLength = 0;
  let heldSinceMs: number | null = null;
  let awaitingLineStart = false;

  function clearHold(): void {
    held = [];
    heldLength = 0;
    heldSinceMs = null;
  }

  function publishHeld(nowMs: number, partial: boolean): LogLineRecord {
    const bytes = concat(held, heldLength);
    const record = createLogLineRecord({
      service,
      generation,
      offset: pendingOffset,
      endOffset: pendingOffset + heldLength,
      text: decodeLine(bytes),
      observedAt: new Date(nowMs).toISOString(),
      partial,
    });
    pendingOffset += heldLength;
    clearHold();
    return record;
  }

  return {
    service,
    generation: () => generation,
    pendingOffset: () => pendingOffset,
    pendingBytes: () => heldLength,

    reset(nextGeneration, offset, options = {}) {
      generation = nextGeneration;
      pendingOffset = offset;
      awaitingLineStart = options.dropLeadingPartial ?? false;
      clearHold();
    },

    append(bytes, nowMs) {
      if (bytes.length === 0) return [];
      const records: LogLineRecord[] = [];
      let cursor = 0;

      if (awaitingLineStart) {
        const boundary = bytes.indexOf(LINE_FEED, cursor);
        if (boundary === -1) {
          // The whole chunk is the remainder of a line the tail never saw the
          // start of. Dropping it is the only honest option; the marker that
          // caused the jump already said bytes were skipped.
          pendingOffset += bytes.length;
          return records;
        }
        pendingOffset += boundary + 1 - cursor;
        cursor = boundary + 1;
        awaitingLineStart = false;
      }

      while (cursor < bytes.length) {
        const boundary = bytes.indexOf(LINE_FEED, cursor);
        if (boundary === -1) {
          const rest = bytes.subarray(cursor);
          held.push(rest);
          heldLength += rest.length;
          heldSinceMs ??= nowMs;
          break;
        }

        const segment = bytes.subarray(cursor, boundary);
        held.push(segment);
        heldLength += segment.length;
        const lineBytes = concat(held, heldLength);
        records.push(
          createLogLineRecord({
            service,
            generation,
            offset: pendingOffset,
            endOffset: pendingOffset + heldLength + 1,
            text: decodeLine(lineBytes),
            observedAt: new Date(nowMs).toISOString(),
          }),
        );
        pendingOffset += heldLength + 1;
        clearHold();
        cursor = boundary + 1;
      }

      // A single line longer than the cap is published rather than buffered
      // without bound.
      while (heldLength >= maxLineBytes) {
        const bytesToPublish = concat(held, heldLength);
        const slice = bytesToPublish.subarray(0, maxLineBytes);
        const remainder = bytesToPublish.subarray(maxLineBytes);
        records.push(
          createLogLineRecord({
            service,
            generation,
            offset: pendingOffset,
            endOffset: pendingOffset + slice.length,
            text: decodeLine(slice),
            observedAt: new Date(nowMs).toISOString(),
            partial: true,
          }),
        );
        pendingOffset += slice.length;
        clearHold();
        if (remainder.length > 0) {
          held.push(remainder);
          heldLength = remainder.length;
          heldSinceMs = nowMs;
        }
      }

      return records;
    },

    flush(nowMs, options = {}) {
      if (heldLength === 0) return [];
      const expired =
        heldSinceMs !== null && nowMs - heldSinceMs >= holdMs;
      if (!options.force && !expired) return [];
      return [publishHeld(nowMs, true)];
    },
  };
}
