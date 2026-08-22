import type { LogRow } from "../api/panel-types.ts";
import { stripAnsi } from "./ansi.ts";
import { isContinuationText } from "./continuation.ts";
import { extractLineTimestamp, type LineTime } from "./line-timestamp.ts";
import { classifySeverity, type LogSeverity } from "./severity.ts";

/**
 * Everything the panel infers about a row, derived once and remembered.
 *
 * Classification, timestamp extraction, and continuation detection are pure
 * functions of a row's bytes, and a row's bytes never change — its identity is
 * derived from them. That makes the results cacheable by id, which matters:
 * without it, every keystroke in the filter box would re-classify the entire
 * buffer, and the buffer holds tens of thousands of rows.
 *
 * The cache is bounded and evicts oldest-first, so a long-running panel cannot
 * grow a second copy of the buffer in facts.
 */

export interface LogLineFacts {
  /** The canonical plain form: what filtering, copying, and export all use. */
  plainText: string;
  severity: LogSeverity;
  /** True when the row cannot stand alone — a stack frame, a `Caused by:`. */
  continuation: boolean;
  time: LineTime;
}

/** The plain-text form of a row, markers included. */
export function logRowPlainText(row: LogRow): string {
  return row.type === "line" ? stripAnsi(row.text) : `--- ${row.detail} ---`;
}

/**
 * Markers describe the stream rather than report from a service, so they carry
 * no severity of their own and can never be continuations.
 */
export function readLineFacts(row: LogRow): LogLineFacts {
  const plainText = logRowPlainText(row);
  if (row.type === "marker") {
    return {
      plainText,
      severity: "unknown",
      continuation: false,
      time: { at: row.observedAt, approximate: false, source: "line" },
    };
  }
  return {
    plainText,
    severity: classifySeverity(plainText),
    continuation: isContinuationText(plainText),
    time: extractLineTimestamp(plainText, row.observedAt),
  };
}

export const DEFAULT_FACTS_CACHE_LIMIT = 60_000;

export interface LineFactsCache {
  facts(row: LogRow): LogLineFacts;
  size(): number;
  clear(): void;
}

export function createLineFactsCache(
  limit: number = DEFAULT_FACTS_CACHE_LIMIT,
): LineFactsCache {
  const entries = new Map<string, LogLineFacts>();
  return {
    facts(row) {
      const cached = entries.get(row.id);
      if (cached) return cached;
      const facts = readLineFacts(row);
      if (entries.size >= limit) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(row.id, facts);
      return facts;
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}
