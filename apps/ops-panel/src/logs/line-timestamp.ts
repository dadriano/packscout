/**
 * When a line actually happened, as opposed to when the panel noticed it.
 *
 * Arrival time is always available and always slightly wrong: it is when a tail
 * read reached the browser, which for backfilled output can be minutes or hours
 * after the fact. Most services already stamp their own lines, so the honest
 * thing is to prefer the line's own time and to say plainly when we could not
 * find one — hence `approximate`, which the pane renders rather than hides.
 *
 * Extraction is bounded in two ways, because a wrong timestamp is worse than no
 * timestamp:
 *
 *  - *positionally*, by only looking at the head of the line, so an elapsed
 *    "12:30" in the middle of a sentence is never mistaken for a clock;
 *  - *plausibly*, by refusing an instant that sits impossibly far from arrival.
 *    A line cannot have been written next year, and a tail cannot deliver one
 *    from a decade ago.
 *
 * Formats without a date or zone are completed from arrival, in local time,
 * since that is the clock the service was reading when it wrote the line.
 */

export interface LineTime {
  /** The instant to show the row at, as an ISO string. */
  at: string;
  /** True when `at` is arrival rather than the line's own stamp. */
  approximate: boolean;
  source: "line" | "arrival";
}

/** How far into the line a timestamp is still a prefix. */
const HEAD_WINDOW = 64;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A tail can replay old files, but not an unbounded amount of history. */
export const MAX_BACKDATE_MS = 400 * DAY_MS;
/** Clock skew and timezone confusion, generously; beyond this it is a misread. */
export const MAX_POSTDATE_MS = 25 * HOUR_MS;

const ISO_LIKE =
  /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?/u;
const SYSLOG =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/iu;
/**
 * A bare clock only counts as a stamp when it leads the line. Anchoring it
 * behind a short run of non-digits admits `[09:45:30]` and `worker | 09:45:30`
 * while refusing an elapsed `01:02:03` reported mid-sentence.
 */
const CLOCK = /^[^\d]{0,24}?(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?(?!\d)/u;

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function fractionMs(raw: string | undefined): number {
  if (!raw) return 0;
  return Math.round(Number(`0.${raw}`) * 1000);
}

/** An absolute instant, or `null` when the pieces do not form a real date. */
function isoInstant(match: RegExpExecArray): number | null {
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  if (zone) {
    const normalized = zone === "Z" ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/u, "$1:$2");
    const parsed = Date.parse(
      `${year}-${month}-${day}T${hour}:${minute}:${second}.${String(fractionMs(fraction)).padStart(3, "0")}${normalized}`,
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  const local = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    fractionMs(fraction),
  );
  const value = local.getTime();
  return Number.isFinite(value) && local.getMonth() === Number(month) - 1 ? value : null;
}

/** A date-less clock, completed from arrival and rolled back over midnight. */
function clockInstant(match: RegExpExecArray, arrivalMs: number): number | null {
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const arrival = new Date(arrivalMs);
  const candidate = new Date(
    arrival.getFullYear(),
    arrival.getMonth(),
    arrival.getDate(),
    hour,
    minute,
    second,
    fractionMs(match[4]),
  ).getTime();
  // A line stamped 23:59 delivered at 00:01 belongs to yesterday, not tomorrow.
  return candidate - arrivalMs > 12 * HOUR_MS ? candidate - DAY_MS : candidate;
}

/** A syslog stamp carries no year; arrival supplies it, rolling back if needed. */
function syslogInstant(match: RegExpExecArray, arrivalMs: number): number | null {
  const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
  if (month === -1) return null;
  const arrival = new Date(arrivalMs);
  const candidate = new Date(
    arrival.getFullYear(),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
  return candidate - arrivalMs > MAX_POSTDATE_MS
    ? new Date(arrival.getFullYear() - 1, month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])).getTime()
    : candidate;
}

function plausible(candidate: number, arrivalMs: number): boolean {
  if (!Number.isFinite(candidate)) return false;
  const delta = candidate - arrivalMs;
  return delta <= MAX_POSTDATE_MS && -delta <= MAX_BACKDATE_MS;
}

export function extractLineTimestamp(text: string, arrivalAt: string): LineTime {
  const arrivalMs = Date.parse(arrivalAt);
  const fallback: LineTime = { at: arrivalAt, approximate: true, source: "arrival" };
  if (!Number.isFinite(arrivalMs)) return fallback;

  const head = text.slice(0, HEAD_WINDOW);
  const iso = ISO_LIKE.exec(head);
  const syslog = iso ? null : SYSLOG.exec(head);
  const clock = iso || syslog ? null : CLOCK.exec(head);

  const candidate = iso
    ? isoInstant(iso)
    : syslog
      ? syslogInstant(syslog, arrivalMs)
      : clock
        ? clockInstant(clock, arrivalMs)
        : null;

  if (candidate === null || !plausible(candidate, arrivalMs)) return fallback;
  return { at: new Date(candidate).toISOString(), approximate: false, source: "line" };
}
