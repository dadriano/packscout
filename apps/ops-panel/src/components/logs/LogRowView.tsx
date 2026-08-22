import { memo } from "react";
import { formatAge, formatClockTime } from "../../format.ts";
import type { TimestampMode } from "../../logs/display-preferences.ts";
import type { HighlightRange } from "../../logs/highlight.ts";
import type { FactsLookup, LogDisplayItem } from "../../logs/line-groups.ts";
import { serviceBadgeVariables } from "../../logs/service-badge.ts";
import type { LogSeverity } from "../../logs/severity.ts";
import { LineText } from "./LineText.tsx";

/**
 * One row: a line of output, a folded group's head, or an inline marker.
 *
 * Markers render in the flow rather than as a banner, because their meaning is
 * positional — "the log restarted *here*" is the whole point.
 *
 * A head shows what it is hiding: how many lines it folded, and how many of
 * them matched. Without the second number, expanding a group would be a guess,
 * and a search that matched deep inside a trace would look like a false hit.
 *
 * Copying a row copies its whole group for the same reason: the row on screen
 * is the event, not the first line of it, and pasting a message with no trace
 * under it helps nobody.
 */

const SEVERITY_LABEL: Readonly<Record<LogSeverity, string>> = Object.freeze({
  error: "ERR",
  warn: "WRN",
  info: "INF",
  debug: "DBG",
  unknown: "",
});

function timestampText(value: string, mode: TimestampMode, now: number): string {
  if (mode === "absolute") return formatClockTime(value);
  return formatAge(value, now);
}

export interface LogRowViewProps {
  item: LogDisplayItem;
  facts: FactsLookup;
  highlight: (text: string) => HighlightRange[];
  timestamps: TimestampMode;
  ansi: boolean;
  now: number;
  onToggleGroup: (groupId: string) => void;
  onCopyRow: (groupId: string) => void;
  /** The row a search result opened on, marked so it can be found instantly. */
  focused: boolean;
}

function LogRowViewComponent({
  item,
  facts,
  highlight,
  timestamps,
  ansi,
  now,
  onToggleGroup,
  onCopyRow,
  focused,
}: LogRowViewProps) {
  const { row } = item;
  const { plainText, time } = facts(row);

  if (row.type === "marker") {
    return (
      <div className="panel-log-marker" data-kind={row.kind} role="note">
        <span className="panel-log-marker-service">
          {row.service === "*" ? "panel" : row.service}
        </span>
        <span className="panel-log-marker-detail">{row.detail}</span>
        {timestamps === "off" ? null : (
          <span className="panel-log-marker-time">
            {timestampText(row.observedAt, timestamps, now)}
          </span>
        )}
      </div>
    );
  }

  const severityLabel = SEVERITY_LABEL[item.severity];

  return (
    <div
      className="panel-log-line"
      data-severity={item.severity}
      data-role={item.role}
      data-matched={item.matched ? "yes" : "no"}
      data-focused={focused ? "yes" : "no"}
      style={serviceBadgeVariables(row.service)}
    >
      {item.role === "head" ? (
        <button
          type="button"
          className="panel-log-fold"
          aria-expanded={item.expanded}
          onClick={() => onToggleGroup(item.groupId)}
          title={
            item.expanded
              ? "Collapse this group"
              : `Expand ${item.memberCount} folded ${item.memberCount === 1 ? "line" : "lines"}`
          }
        >
          <span aria-hidden="true">{item.expanded ? "▾" : "▸"}</span>
          <span className="panel-log-fold-count">
            {item.memberCount}
            {item.matchedMembers > 0 ? `·${item.matchedMembers}` : ""}
          </span>
        </button>
      ) : (
        <span className="panel-log-fold-spacer" aria-hidden="true" />
      )}

      <span className="panel-log-service" title={`Service: ${row.service}`}>
        {row.service}
      </span>

      <span
        className="panel-log-severity"
        data-severity={item.severity}
        title={`Severity: ${item.severity}`}
      >
        {severityLabel}
      </span>

      {timestamps === "off" ? null : (
        <span
          className="panel-log-time"
          title={
            time.approximate
              ? `${time.at} (when the panel read it, not when it was written)`
              : time.at
          }
        >
          {time.approximate ? "~" : ""}
          {timestampText(time.at, timestamps, now)}
        </span>
      )}

      <LineText text={row.text} ansi={ansi} ranges={highlight(plainText)} />

      {row.partial ? (
        <span className="panel-log-partial" title="Published before its newline arrived">
          &#8230;
        </span>
      ) : null}

      <button
        type="button"
        className="panel-log-copy-row"
        onClick={() => onCopyRow(item.groupId)}
        title={
          item.memberCount > 0
            ? `Copy this line and its ${item.memberCount} folded ${
                item.memberCount === 1 ? "line" : "lines"
              }`
            : "Copy this line"
        }
      >
        Copy
      </button>
    </div>
  );
}

export const LogRowView = memo(LogRowViewComponent);
