/**
 * The output of one supervised operation, collected under a hard bound.
 *
 * A migration that loops, or a seed that prints a row per insert, must not be
 * able to grow the panel's memory without limit — but silently dropping the
 * tail would be worse than the leak, because the operator would read a truncated
 * log as a complete one. So the collector counts everything it is given and
 * retains only the first `lineLimit` lines, reporting both numbers. The pane
 * says how many lines it is not showing rather than pretending they never
 * existed.
 *
 * Sanitising is injected rather than assumed: child output routinely quotes the
 * connection string back on failure, and every line passes through the caller's
 * redaction before it is retained, streamed, or counted.
 *
 * The bound has to hold *before* a terminator arrives, not only after one. A
 * child that writes a progress bar, or a stack trace with no newline in it, or
 * simply crashes mid-line, would otherwise let the unterminated fragment grow
 * for the whole operation timeout — the one place in this module where nothing
 * is counted yet and nothing has been capped. So the fragment is capped as it
 * accumulates and remembers that it was cut, which is what lets the line it
 * eventually becomes carry the same ellipsis a long complete line does.
 */

/** Retained lines per run. Beyond this the run keeps going; the log does not. */
export const DEFAULT_OPERATION_LINE_LIMIT = 2_000;

/** A single line longer than this is cut: one line is never a payload. */
export const DEFAULT_OPERATION_LINE_LENGTH = 2_000;

export interface OperationOutputLine {
  /** Position in the run's output, counted from 1 across the whole run. */
  readonly index: number;
  readonly text: string;
}

export interface OperationOutputCollector {
  /** Consume a chunk, returning the lines it completed. */
  append(chunk: string): OperationOutputLine[];
  /** Publish a trailing line the child never terminated. */
  flush(): OperationOutputLine[];
  /** Append one line the panel itself wrote, such as a timeout notice. */
  note(text: string): OperationOutputLine[];
  lines(): readonly OperationOutputLine[];
  /** Lines produced, including the ones the cap dropped. */
  produced(): number;
  /**
   * Characters currently held for a line the child has not terminated. Never
   * more than one line's worth, however much newline-free output arrives.
   */
  pendingLength(): number;
  truncated(): boolean;
  describeTruncation(): string | null;
}

export interface OperationOutputOptions {
  readonly lineLimit?: number;
  readonly maxLineLength?: number;
  /** Applied to every line before it is retained. Redaction lives here. */
  readonly sanitize?: (text: string) => string;
}

export function createOperationOutputCollector({
  lineLimit = DEFAULT_OPERATION_LINE_LIMIT,
  maxLineLength = DEFAULT_OPERATION_LINE_LENGTH,
  sanitize = (value) => value,
}: OperationOutputOptions = {}): OperationOutputCollector {
  if (!Number.isInteger(lineLimit) || lineLimit < 1) {
    throw new Error("An operation output line limit must be a positive integer.");
  }

  const retained: OperationOutputLine[] = [];
  let pending = "";
  // Set once the fragment stopped accepting characters, so the line it becomes
  // is published as cut rather than as a complete line that happens to be short.
  let pendingCut = false;
  let produced = 0;

  function accept(raw: string, cut = false): OperationOutputLine | null {
    produced += 1;
    if (retained.length >= lineLimit) return null;
    const sanitized = sanitize(raw.replace(/\r$/u, ""));
    const text =
      cut || sanitized.length > maxLineLength
        ? `${sanitized.slice(0, maxLineLength - 1)}…`
        : sanitized;
    const line = { index: produced, text };
    retained.push(line);
    return line;
  }

  /** Grow the unterminated fragment, but never past one line's worth. */
  function hold(text: string): void {
    if (text.length === 0) return;
    const room = maxLineLength - pending.length;
    if (room <= 0) {
      pendingCut = true;
      return;
    }
    if (text.length <= room) {
      pending += text;
      return;
    }
    pending += text.slice(0, room);
    pendingCut = true;
  }

  function takeHeld(): { text: string; cut: boolean } {
    const held = { text: pending, cut: pendingCut };
    pending = "";
    pendingCut = false;
    return held;
  }

  /**
   * Scan the chunk itself for terminators rather than re-splitting everything
   * held so far: the fragment is bounded above, so the work one chunk costs
   * stays proportional to that chunk.
   */
  function drain(chunk: string): OperationOutputLine[] {
    const emitted: OperationOutputLine[] = [];
    let start = 0;
    for (;;) {
      const boundary = chunk.indexOf("\n", start);
      if (boundary === -1) break;
      hold(chunk.slice(start, boundary));
      const held = takeHeld();
      const line = accept(held.text, held.cut);
      if (line) emitted.push(line);
      start = boundary + 1;
    }
    hold(chunk.slice(start));
    return emitted;
  }

  return {
    append(chunk) {
      return chunk.length === 0 ? [] : drain(chunk);
    },
    flush() {
      if (pending.length === 0) return [];
      const held = takeHeld();
      const line = accept(held.text, held.cut);
      return line ? [line] : [];
    },
    note(text) {
      const line = accept(text);
      return line ? [line] : [];
    },
    lines: () => retained,
    produced: () => produced,
    pendingLength: () => pending.length,
    truncated: () => produced > retained.length,
    describeTruncation() {
      const dropped = produced - retained.length;
      if (dropped <= 0) return null;
      return `Output stopped being recorded after ${retained.length} lines; ${dropped} further line${dropped === 1 ? "" : "s"} were produced and are not shown. The operation itself was not interrupted.`;
    },
  };
}
