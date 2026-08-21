/**
 * What a line is trying to say, guessed from how it is written.
 *
 * The panel is deliberately not JSON-log-aware: every service here writes
 * whatever its own logger felt like writing, so severity cannot be read from a
 * field. It has to be inferred, and inference that is confidently wrong is worse
 * than inference that abstains — so the vocabulary includes `unknown`, and an
 * unrecognised line lands there rather than being rounded to `info`.
 *
 * Recognition works in stages, most-trustworthy first, because *where* a level
 * word appears says more than the word itself. A line beginning `warn:` is
 * declaring its level; a line mentioning "error" in the middle of a sentence is
 * describing something. The stages are ordered so the declaring forms win.
 *
 * Prefixes are stripped rather than matched around: real output arrives wrapped
 * in timestamps, service tags, and decorative glyphs, in every combination, and
 * peeling them off one layer at a time handles combinations no single pattern
 * could enumerate.
 */

export type LogSeverity = "error" | "warn" | "info" | "debug" | "unknown";

export const LOG_SEVERITIES: readonly LogSeverity[] = [
  "error",
  "warn",
  "info",
  "debug",
  "unknown",
];

/** Higher is louder. Used to give a folded group its worst member's level. */
export const SEVERITY_RANK: Readonly<Record<LogSeverity, number>> = Object.freeze(
  { error: 4, warn: 3, info: 2, debug: 1, unknown: 0 },
);

export function maxSeverity(left: LogSeverity, right: LogSeverity): LogSeverity {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

/** Words that name a level when they lead a line or sit inside a tag. */
const LEVEL_WORDS: Readonly<Record<string, LogSeverity>> = Object.freeze({
  fatal: "error",
  panic: "error",
  critical: "error",
  crit: "error",
  severe: "error",
  error: "error",
  err: "error",
  exception: "error",
  failure: "error",
  failed: "error",
  fail: "error",
  warn: "warn",
  warning: "warn",
  deprecated: "warn",
  info: "info",
  notice: "info",
  success: "info",
  ready: "info",
  debug: "debug",
  dbg: "debug",
  trace: "debug",
  verbose: "debug",
  silly: "debug",
});

const LEVEL_WORD_PATTERN = new RegExp(
  `^(?:${Object.keys(LEVEL_WORDS).join("|")})$`,
  "iu",
);

/** How far into a line a level tag is still considered a prefix. */
const TAG_WINDOW = 80;

const LEADING_WORD = /^([A-Za-z]{2,9})\b/u;
const BRACKETED_PREFIX = /^([[(<])([^\])>]{0,64})([\])>])[\s:|-]*/u;
const CLOCK_PREFIX =
  /^(?:\d{4}-\d{2}-\d{2}[T ])?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,6})?(?:\s?[AaPp]\.?[Mm]\.?)?(?:Z|[+-]\d{2}:?\d{2})?[\s|-]*/u;
const DATE_PREFIX = /^\d{4}[-/]\d{2}[-/]\d{2}[\s|-]*/u;
const GLYPH_PREFIX = /^[^\p{L}\p{N}[(<"'\\/]+/u;
/** `worker | warn | ...`: a pipe-delimited field, which loggers love. */
const PIPED_FIELD = /^([A-Za-z][\w.:-]{0,31})\s*\|\s*/u;

/** Level tags such as `[warn]`, `(DEBUG)`, or `level=error`. */
const TAGGED_LEVEL = /[[(<]\s*([A-Za-z]{2,9})\s*[\])>]/u;
const ASSIGNED_LEVEL = /\blevel"?\s*[=:]\s*"?([A-Za-z]{2,9})\b/iu;

/** Shapes that mean trouble wherever they appear on the line. */
const ERROR_SIGNALS: readonly RegExp[] = [
  /\b(?:un)?(?:caught|handled)\s+(?:\w+\s+){0,2}(?:error|exception|rejection)/iu,
  /\bERR!/u,
  /\bERR_[A-Z][A-Z0-9_]{2,}\b/u,
  /\bTraceback \(most recent call last\)/u,
  /\bpanic:/iu,
  /\b[A-Za-z]*Error\b\s*:/u,
  /\b[A-Za-z]*Exception\b\s*:/u,
  /\bFATAL\b/u,
  /\bstack\s*trace\b/iu,
];

const WARN_SIGNALS: readonly RegExp[] = [
  /\b[A-Za-z]*Warning\b\s*:/u,
  /\bWARN\b/u,
  /\bdeprecated\b/iu,
];

/** Glyph prefixes conventional loggers use instead of a word. */
const GLYPH_SEVERITY: readonly (readonly [RegExp, LogSeverity])[] = [
  [/[✖✗✘❌⛔\u{1f534}]/u, "error"],
  [/[⚠‼\u{1f7e1}]/u, "warn"],
  [/[✔✓✅ℹ]/u, "info"],
];

function levelFor(word: string | undefined): LogSeverity | null {
  if (!word) return null;
  const level = LEVEL_WORDS[word.toLowerCase()];
  return level ?? null;
}

/**
 * Peel one layer of prefix decoration, or return the text unchanged.
 *
 * A bracketed run that *is* a level tag is left in place: it is the answer, not
 * noise, and stripping it would hide what the next stage is looking for.
 */
function stripOnce(text: string): string {
  const head = text.replace(/^\s+/u, "");
  const bracketed = BRACKETED_PREFIX.exec(head);
  if (bracketed && !LEVEL_WORD_PATTERN.test((bracketed[2] ?? "").trim())) {
    return head.slice(bracketed[0].length);
  }
  const clock = CLOCK_PREFIX.exec(head);
  if (clock) return head.slice(clock[0].length);
  const date = DATE_PREFIX.exec(head);
  if (date) return head.slice(date[0].length);
  const piped = PIPED_FIELD.exec(head);
  if (piped && !LEVEL_WORD_PATTERN.test(piped[1] ?? "")) {
    return head.slice(piped[0].length);
  }
  const glyphs = GLYPH_PREFIX.exec(head);
  if (glyphs) return head.slice(glyphs[0].length);
  return head;
}

/** The line with timestamps, service tags, and glyphs peeled away. */
export function stripLinePrefixes(text: string): string {
  let head = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = stripOnce(head);
    if (next === head) break;
    head = next;
  }
  return head;
}

export function classifySeverity(text: string): LogSeverity {
  if (text.trim().length === 0) return "unknown";

  const head = stripLinePrefixes(text);
  const window = head.slice(0, TAG_WINDOW);

  // Stage one: the line names its own level before saying anything else.
  const leading = levelFor(LEADING_WORD.exec(head)?.[1]);
  if (leading) return leading;

  // Stage two: the level travels in a tag or a `level=` field near the front.
  const tagged =
    levelFor(TAGGED_LEVEL.exec(window)?.[1]) ??
    levelFor(ASSIGNED_LEVEL.exec(window)?.[1]);
  if (tagged) return tagged;

  // Stage three: shapes that mean trouble wherever they sit on the line.
  for (const signal of ERROR_SIGNALS) if (signal.test(text)) return "error";
  for (const signal of WARN_SIGNALS) if (signal.test(text)) return "warn";

  // Stage four: the glyph a logger printed instead of a word.
  const glyphs = text.slice(0, 8);
  for (const [pattern, severity] of GLYPH_SEVERITY) {
    if (pattern.test(glyphs)) return severity;
  }

  return "unknown";
}
