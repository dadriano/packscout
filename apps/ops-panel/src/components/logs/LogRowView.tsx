import { memo } from "react";
import type { LogRow } from "../../api/panel-types.ts";
import { formatAge, formatClockTime } from "../../format.ts";
import { parseAnsi, type AnsiStyle } from "../../logs/ansi.ts";
import type { TimestampMode } from "../../logs/display-preferences.ts";
import { serviceBadgeVariables } from "../../logs/service-badge.ts";

/**
 * One row: either a line of output or an inline marker.
 *
 * Markers render in the flow rather than as a banner, because their meaning is
 * positional — "the log restarted *here*" is the whole point. Severity badges
 * are deliberately absent; classification arrives with admin-tools/013.
 */

function styleFor(style: AnsiStyle): React.CSSProperties {
  return {
    color: style.inverse ? style.background : style.foreground,
    background: style.inverse ? style.foreground : style.background,
    fontWeight: style.bold ? 600 : undefined,
    opacity: style.dim ? 0.7 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined,
  };
}

function LineText({ text, ansi }: { text: string; ansi: boolean }) {
  const parsed = parseAnsi(text);
  if (!ansi || !parsed.styled) {
    // The canonical plain form: the same characters copy, filter, and export use.
    return <span className="panel-log-text">{parsed.plainText}</span>;
  }
  return (
    <span className="panel-log-text">
      {parsed.spans.map((span, index) => (
        <span key={index} style={styleFor(span.style)}>
          {span.text}
        </span>
      ))}
    </span>
  );
}

function timestampText(value: string, mode: TimestampMode, now: number): string {
  if (mode === "absolute") return formatClockTime(value);
  return formatAge(value, now);
}

export interface LogRowViewProps {
  row: LogRow;
  timestamps: TimestampMode;
  ansi: boolean;
  now: number;
}

function LogRowViewComponent({ row, timestamps, ansi, now }: LogRowViewProps) {
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

  return (
    <div className="panel-log-line" style={serviceBadgeVariables(row.service)}>
      <span className="panel-log-service" title={`Service: ${row.service}`}>
        {row.service}
      </span>
      {timestamps === "off" ? null : (
        <span className="panel-log-time" title={row.observedAt}>
          {row.backfilled ? "~" : ""}
          {timestampText(row.observedAt, timestamps, now)}
        </span>
      )}
      <LineText text={row.text} ansi={ansi} />
      {row.partial ? (
        <span className="panel-log-partial" title="Published before its newline arrived">
          &#8230;
        </span>
      ) : null}
    </div>
  );
}

export const LogRowView = memo(LogRowViewComponent);
