/**
 * Regular expressions, admitted only if they are safe to run per line.
 *
 * A filter pattern is evaluated against every line in the buffer on every
 * keystroke — tens of thousands of times a second in the worst case. A pattern
 * that backtracks catastrophically does not merely feel slow: it freezes the tab
 * that the operator is using to find out why something else is broken. The panel
 * therefore refuses such patterns at compile time and says so, rather than
 * accepting them and hanging.
 *
 * Two guards, because neither alone is enough:
 *
 *  - a *structural* one, which recognises the classic exponential shape — an
 *    unbounded quantifier wrapped around another — and can name what is wrong;
 *  - a *measured* one, which runs the compiled pattern against adversarial input
 *    of growing length and stops as soon as the cost stops looking linear. It
 *    catches the shapes no structural rule enumerates, and the ladder is what
 *    keeps the probe itself cheap: an exponential pattern blows the budget at a
 *    short rung, long before a long rung could cost anything.
 *
 * Length is bounded first, because both guards are cheapest when there is less
 * to inspect, and no honest log filter needs two hundred characters.
 */

export const MAX_PATTERN_LENGTH = 200;

/** Total time a pattern may spend on the probe ladder before it is refused. */
export const DEFAULT_PROBE_BUDGET_MS = 25;

/** Input lengths the probe walks, shortest first. */
export const DEFAULT_PROBE_LENGTHS: readonly number[] = [8, 12, 16, 20, 24];

/** Compiled patterns retained so repeated keystrokes do not re-probe. */
const GUARD_CACHE_LIMIT = 64;

export type RegexGuardOutcome =
  | { ok: true; expression: RegExp }
  | { ok: false; message: string };

export interface RegexGuardOptions {
  caseSensitive?: boolean;
  budgetMs?: number;
  probeLengths?: readonly number[];
  /** Injected in tests so the measured guard is deterministic. */
  now?: () => number;
}

interface Quantifier {
  /** Characters the quantifier occupies. */
  length: number;
  unbounded: boolean;
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** Read a quantifier at `at`, including any lazy or possessive modifier. */
function readQuantifier(pattern: string, at: number): Quantifier | null {
  const char = pattern[at];
  if (char === "*" || char === "+") {
    const modifier = pattern[at + 1] === "?" || pattern[at + 1] === "+" ? 1 : 0;
    return { length: 1 + modifier, unbounded: true };
  }
  if (char !== "{") return null;
  const close = pattern.indexOf("}", at);
  if (close === -1) return null;
  const body = pattern.slice(at + 1, close);
  if (!/^\d+(?:,\d*)?$/u.test(body)) return null;
  const modifier = pattern[close + 1] === "?" ? 1 : 0;
  return { length: close + 1 - at + modifier, unbounded: /,\s*$/u.test(body) };
}

/** Any unbounded repetition inside a fragment, ignoring escapes and classes. */
function hasUnboundedQuantifier(fragment: string): boolean {
  let inClass = false;
  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (readQuantifier(fragment, index)?.unbounded) return true;
  }
  return false;
}

/** `(a|a)*` and friends: branches that can consume the same input. */
function hasAmbiguousAlternation(fragment: string): boolean {
  const branches: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";
  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index];
    if (char === "\\") {
      current += char + (fragment[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (inClass) {
      current += char;
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "|" && depth === 0) {
      branches.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  branches.push(current);
  if (branches.length < 2) return false;
  return new Set(branches.map((branch) => branch.trim())).size < branches.length;
}

/**
 * The exponential shape, if the pattern has one: an unbounded quantifier applied
 * to a group that can already repeat or match a branch two ways.
 */
export function findNestedQuantifier(pattern: string): string | null {
  const stack: number[] = [];
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      stack.push(index);
      continue;
    }
    if (char !== ")") continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const quantifier = readQuantifier(pattern, index + 1);
    if (!quantifier?.unbounded) continue;
    const body = pattern.slice(start + 1, index);
    if (hasUnboundedQuantifier(body) || hasAmbiguousAlternation(body)) {
      return pattern.slice(start, index + 1 + quantifier.length);
    }
  }
  return null;
}

/** A byte no realistic log line contains, so the probe always ends in failure. */
const PROBE_SENTINEL = "\u0001";

/**
 * Adversarial input for a pattern: a run of something it wants to consume,
 * followed by a byte it almost certainly does not, so a backtracking engine has
 * to exhaust every split before failing.
 */
function probeText(pattern: string, length: number): string {
  const literal = /(?:^|[^\\])([A-Za-z0-9])/u.exec(pattern)?.[1] ?? "a";
  return literal.repeat(length) + PROBE_SENTINEL;
}

export interface RegexProbeResult {
  withinBudget: boolean;
  elapsedMs: number;
  /** The rung the probe stopped on. */
  probeLength: number;
}

export function probeRegexCost(
  expression: RegExp,
  { budgetMs = DEFAULT_PROBE_BUDGET_MS, probeLengths = DEFAULT_PROBE_LENGTHS, now = defaultNow }:
    Pick<RegexGuardOptions, "budgetMs" | "probeLengths" | "now"> = {},
): RegexProbeResult {
  // A stateless copy: `lastIndex` on a global expression would make repeated
  // probes measure different work each time.
  const probe = new RegExp(expression.source, expression.flags.replace(/[gy]/gu, ""));
  const started = now();
  let elapsed = 0;
  let probeLength = 0;
  for (const length of probeLengths) {
    probeLength = length;
    probe.test(probeText(expression.source, length));
    elapsed = now() - started;
    if (elapsed > budgetMs) return { withinBudget: false, elapsedMs: elapsed, probeLength };
  }
  return { withinBudget: true, elapsedMs: elapsed, probeLength };
}

function syntaxMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const trimmed = detail.replace(/^Invalid regular expression:.*?:\s*/u, "");
  return `Not a valid pattern — ${trimmed.trim() || "check the syntax"}.`;
}

const cache = new Map<string, RegexGuardOutcome>();

function remember(key: string, outcome: RegexGuardOutcome): RegexGuardOutcome {
  if (cache.size >= GUARD_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, outcome);
  return outcome;
}

/**
 * Compile a filter pattern, or explain why it was refused.
 *
 * The returned expression carries `g` so the same object can both test and
 * enumerate matches; callers reset `lastIndex` before each use.
 */
export function compileGuardedRegExp(
  pattern: string,
  options: RegexGuardOptions = {},
): RegexGuardOutcome {
  const flags = options.caseSensitive ? "gu" : "giu";
  const key = `${flags}\u0000${pattern}`;
  const cached = cache.get(key);
  // A probe with an injected clock is a test asking a specific question; it must
  // not be answered from, or written to, the shared cache.
  if (cached && !options.now) return cached;

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return remember(key, {
      ok: false,
      message: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters. Shorten it.`,
    });
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern, flags);
  } catch (cause) {
    return remember(key, { ok: false, message: syntaxMessage(cause) });
  }

  const nested = findNestedQuantifier(pattern);
  if (nested) {
    return remember(key, {
      ok: false,
      message: `\`${nested}\` repeats a group that already repeats, which can take effectively forever on a long line. Simplify the repetition.`,
    });
  }

  const probe = probeRegexCost(expression, options);
  if (!probe.withinBudget) {
    return remember(key, {
      ok: false,
      message: `This pattern took too long on a ${probe.probeLength}-character probe, so it is not safe to run against every line. Simplify it.`,
    });
  }

  const outcome: RegexGuardOutcome = { ok: true, expression };
  return options.now ? outcome : remember(key, outcome);
}

/** Test seam: forget everything memoised so a probe can be observed again. */
export function clearRegexGuardCache(): void {
  cache.clear();
}
