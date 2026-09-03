/**
 * Which lines are not really lines of their own.
 *
 * A stack trace is one event that a text log is forced to spell across twenty
 * rows. Treated as twenty rows it drowns everything else in the pane and, worse,
 * a filter matching the message hides the frames that explain it. Recognising
 * continuations is what lets the panel fold the whole thing back into the one
 * event it always was.
 *
 * Detection is shape-based and conservative. Indentation is the near-universal
 * convention across Node, Java, Python, and Go, and the named forms below are
 * the cases that break it — `Caused by:` and `... 12 more` sit flush left in
 * plenty of formatters. A line that is merely *related* to the one above is not
 * a continuation: only lines that are unreadable on their own qualify, because
 * folding anything else would hide real events.
 */

const NAMED_CONTINUATIONS: readonly RegExp[] = [
  /^\s*Caused by:/u,
  /^\s*Suppressed:/u,
  /^\s*\.\.\.\s*\d+\s+more\b/u,
  // A flush-left stack frame, recognised by its source location rather than by
  // the word "at" — "at least three items" is prose, not a frame.
  /^\s*at\s+\S.*:\d+(?::\d+)?\)?\s*$/u,
  /^\s*File\s+".+",\s+line\s+\d+/u,
  /^\s*\^+\s*$/u,
];

/** Two columns of indent: enough to be deliberate, not an accident of prose. */
const INDENTED = /^[ \t]{2,}\S/u;
/** One tab, or one space before a frame-like token. */
const SHALLOW_FRAME = /^[ \t](?:at\s+\S|\.\.\.|Caused by:)/u;

export function isContinuationText(text: string): boolean {
  if (text.trim().length === 0) return false;
  if (INDENTED.test(text) || SHALLOW_FRAME.test(text)) return true;
  return NAMED_CONTINUATIONS.some((pattern) => pattern.test(text));
}
