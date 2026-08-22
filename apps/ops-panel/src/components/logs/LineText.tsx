import { parseAnsi, type AnsiStyle } from "../../logs/ansi.ts";
import { applyHighlights, type HighlightRange } from "../../logs/highlight.ts";

/**
 * A line of output, with the matches shown inside whatever colour it arrived in.
 *
 * Both facts have to survive: the author's emphasis, and where the search hit.
 * Splitting the styled spans at the match boundaries is what allows that —
 * a highlight drawn over the colour would lose one, and a highlight skipped
 * inside coloured text would lose the other.
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

export interface LineTextProps {
  text: string;
  /** Render terminal colour rather than the canonical plain text. */
  ansi: boolean;
  /** Ranges into the plain text; never into the raw bytes. */
  ranges: readonly HighlightRange[];
}

export function LineText({ text, ansi, ranges }: LineTextProps) {
  const parsed = parseAnsi(text);
  const showColour = ansi && parsed.styled;
  const spans = showColour ? parsed.spans : [{ text: parsed.plainText, style: {} }];

  if (ranges.length === 0) {
    return (
      <span className="panel-log-text">
        {showColour
          ? spans.map((span, index) => (
              <span key={index} style={styleFor(span.style)}>
                {span.text}
              </span>
            ))
          : parsed.plainText}
      </span>
    );
  }

  return (
    <span className="panel-log-text">
      {applyHighlights(spans, ranges).map((span, index) =>
        span.highlighted ? (
          <mark key={index} className="panel-log-match" style={styleFor(span.style)}>
            {span.text}
          </mark>
        ) : (
          <span key={index} style={showColour ? styleFor(span.style) : undefined}>
            {span.text}
          </span>
        ),
      )}
    </span>
  );
}
