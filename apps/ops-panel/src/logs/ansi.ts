/**
 * Terminal colour, rendered honestly.
 *
 * Dev servers write SGR escape sequences, and a log viewer that prints them
 * literally is unreadable while one that strips them silently loses the
 * emphasis the author intended. This parser does neither: it turns sequences
 * into styled spans and, in the same pass, produces the *canonical plain text*
 * for the line.
 *
 * That plain text is the single source for copying, filtering (admin-tools/013)
 * and export. Deriving it here — rather than re-stripping escapes at each call
 * site — is what keeps "what I searched" and "what I copied" identical to what
 * was rendered.
 *
 * Malformed input is normal, not exceptional: a line can be cut mid-escape by a
 * read boundary or a forced flush. An unterminated or unrecognised sequence is
 * treated as ordinary text rather than swallowed, so nothing visible is lost.
 */

const ESCAPE = "\u001b";

/** Basic and bright SGR colour names, in code order. */
const COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

export interface AnsiStyle {
  foreground?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

export interface AnsiParseResult {
  spans: AnsiSpan[];
  /** The line with every escape removed: the canonical form. */
  plainText: string;
  /** True when at least one recognised sequence was applied. */
  styled: boolean;
}

function paletteColor(code: number): string {
  if (code < 8) return `var(--panel-ansi-${COLOR_NAMES[code]})`;
  if (code < 16) return `var(--panel-ansi-bright-${COLOR_NAMES[code - 8]})`;
  if (code < 232) {
    const index = code - 16;
    const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    const red = level(Math.floor(index / 36) % 6);
    const green = level(Math.floor(index / 6) % 6);
    const blue = level(index % 6);
    return `rgb(${red} ${green} ${blue})`;
  }
  const grey = 8 + (code - 232) * 10;
  return `rgb(${grey} ${grey} ${grey})`;
}

/** Apply one SGR parameter run, returning the next style. */
function applySgr(style: AnsiStyle, parameters: number[]): AnsiStyle {
  const next: AnsiStyle = { ...style };
  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index] as number;
    if (code === 0) {
      for (const key of Object.keys(next)) delete next[key as keyof AnsiStyle];
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code >= 30 && code <= 37) {
      next.foreground = `var(--panel-ansi-${COLOR_NAMES[code - 30]})`;
    } else if (code >= 90 && code <= 97) {
      next.foreground = `var(--panel-ansi-bright-${COLOR_NAMES[code - 90]})`;
    } else if (code >= 40 && code <= 47) {
      next.background = `var(--panel-ansi-${COLOR_NAMES[code - 40]})`;
    } else if (code >= 100 && code <= 107) {
      next.background = `var(--panel-ansi-bright-${COLOR_NAMES[code - 100]})`;
    } else if (code === 39) delete next.foreground;
    else if (code === 49) delete next.background;
    else if (code === 38 || code === 48) {
      const mode = parameters[index + 1];
      const target = code === 38 ? "foreground" : "background";
      if (mode === 5 && parameters.length > index + 2) {
        next[target] = paletteColor(parameters[index + 2] as number);
        index += 2;
      } else if (mode === 2 && parameters.length > index + 4) {
        const [red, green, blue] = parameters.slice(index + 2, index + 5);
        next[target] = `rgb(${red} ${green} ${blue})`;
        index += 4;
      } else {
        // Truncated extended colour: nothing sensible to apply, and the rest of
        // the run is not trustworthy either.
        break;
      }
    }
  }
  return next;
}

function isEmptyStyle(style: AnsiStyle): boolean {
  return Object.keys(style).length === 0;
}

interface ControlSequence {
  parameters: string;
  finalByte: string;
  /** Characters consumed, escape included. */
  length: number;
}

/**
 * Read one Control Sequence Introducer starting at an escape, or refuse.
 *
 * Scanning by byte class rather than matching a pattern is what makes the
 * refusal precise: an unterminated sequence at the end of a flushed line is
 * distinguishable from a complete one, so it can be shown as text instead of
 * swallowing whatever follows it.
 */
function readControlSequence(text: string, start: number): ControlSequence | null {
  if (text[start + 1] !== "[") return null;
  let index = start + 2;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    // Parameter bytes (0x30-0x3F) and intermediate bytes (0x20-0x2F) continue
    // the sequence; a final byte (0x40-0x7E) closes it.
    if (code >= 0x20 && code <= 0x3f) {
      index += 1;
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) {
      return {
        parameters: text.slice(start + 2, index),
        finalByte: text[index] as string,
        length: index + 1 - start,
      };
    }
    return null;
  }
  return null;
}

export function parseAnsi(text: string): AnsiParseResult {
  if (!text.includes(ESCAPE)) {
    return {
      spans: text.length > 0 ? [{ text, style: {} }] : [],
      plainText: text,
      styled: false,
    };
  }

  const spans: AnsiSpan[] = [];
  const plain: string[] = [];
  let style: AnsiStyle = {};
  let pending = "";
  let styled = false;
  let cursor = 0;

  function closeSpan(): void {
    if (pending.length === 0) return;
    spans.push({ text: pending, style: { ...style } });
    plain.push(pending);
    pending = "";
  }

  while (cursor < text.length) {
    const escapeAt = text.indexOf(ESCAPE, cursor);
    if (escapeAt === -1) {
      pending += text.slice(cursor);
      break;
    }
    pending += text.slice(cursor, escapeAt);

    const sequence = readControlSequence(text, escapeAt);
    if (!sequence) {
      // Not a sequence this panel understands, or one cut short — keep it
      // visible rather than guessing at how much to swallow.
      pending += ESCAPE;
      cursor = escapeAt + 1;
      continue;
    }

    if (sequence.finalByte === "m") {
      closeSpan();
      const parameters = sequence.parameters
        .split(/[;:]/u)
        .map((part) => (part === "" ? 0 : Number(part)))
        .filter((value) => Number.isFinite(value));
      style = applySgr(style, parameters.length === 0 ? [0] : parameters);
      styled = true;
    }
    // Cursor movement, erasure and the like have no meaning in a log pane; they
    // are dropped from the rendering and from the canonical text alike.
    cursor = escapeAt + sequence.length;
  }

  closeSpan();
  const plainText = plain.join("");
  return {
    spans: spans.filter((span) => span.text.length > 0),
    plainText,
    styled: styled && spans.some((span) => !isEmptyStyle(span.style)),
  };
}

/** The canonical plain form of a line: what copy, filter, and export all use. */
export function stripAnsi(text: string): string {
  return text.includes(ESCAPE) ? parseAnsi(text).plainText : text;
}
