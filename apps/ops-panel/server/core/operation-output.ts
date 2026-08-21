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
  let produced = 0;

  function accept(raw: string): OperationOutputLine | null {
    produced += 1;
    if (retained.length >= lineLimit) return null;
    const sanitized = sanitize(raw.replace(/\r$/u, ""));
    const text =
      sanitized.length > maxLineLength
        ? `${sanitized.slice(0, maxLineLength - 1)}…`
        : sanitized;
    const line = { index: produced, text };
    retained.push(line);
    return line;
  }

  function drain(chunk: string, includeRemainder: boolean): OperationOutputLine[] {
    const emitted: OperationOutputLine[] = [];
    pending += chunk;
    const parts = pending.split("\n");
    pending = includeRemainder ? "" : (parts.pop() ?? "");
    for (const part of parts) {
      const line = accept(part);
      if (line) emitted.push(line);
    }
    return emitted;
  }

  return {
    append(chunk) {
      return chunk.length === 0 ? [] : drain(chunk, false);
    },
    flush() {
      if (pending.length === 0) return [];
      const remainder = pending;
      pending = "";
      const line = accept(remainder);
      return line ? [line] : [];
    },
    note(text) {
      const line = accept(text);
      return line ? [line] : [];
    },
    lines: () => retained,
    produced: () => produced,
    truncated: () => produced > retained.length,
    describeTruncation() {
      const dropped = produced - retained.length;
      if (dropped <= 0) return null;
      return `Output stopped being recorded after ${retained.length} lines; ${dropped} further line${dropped === 1 ? "" : "s"} were produced and are not shown. The operation itself was not interrupted.`;
    },
  };
}
