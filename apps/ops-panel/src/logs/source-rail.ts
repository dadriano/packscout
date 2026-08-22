import type { LogSource } from "../api/panel-types.ts";
import type { LogSeverity } from "./severity.ts";

/**
 * What each service is doing, measured rather than assumed.
 *
 * The rail answers "who is erroring right now?" — which is only worth asking if
 * the answer is true. So every number here comes from one of two places: the
 * filesystem, via the source poller (size, last write), or lines this panel
 * actually saw arrive (counts, rates, recent errors).
 *
 * Nothing is inferred about the time before the panel attached. A service that
 * logged ten thousand errors an hour ago and has been silent since shows zero,
 * because that is what this panel observed; guessing at file history to make the
 * chip look informed would produce a number nobody could act on. For the same
 * reason a rate is withheld — `null`, not `0` — until the observation window is
 * long enough for the division to mean anything.
 *
 * Liveness comes from the file rather than from arrivals, because a service can
 * be perfectly healthy and simply quiet, and mtime distinguishes "not writing"
 * from "not running" better than a line counter can.
 */

export type ServiceLiveness = "writing" | "quiet" | "stale";

/** Written within this long: actively producing output. */
export const WRITING_WITHIN_MS = 15_000;
/** Written within this long: alive, just not saying much. */
export const QUIET_WITHIN_MS = 5 * 60_000;

/** Below this much observation, a per-minute rate is noise. */
export const MIN_RATE_WINDOW_MS = 10_000;

/** How far back the error chip looks. */
export const DEFAULT_RECENT_WINDOW_MS = 5 * 60_000;
/** Error timestamps retained per service, so the ledger stays bounded. */
export const DEFAULT_ERROR_SAMPLE_LIMIT = 500;

export interface ServiceObservation {
  service: string;
  lines: number;
  errors: number;
  /** Errors inside the recent window at the moment of the snapshot. */
  recentErrors: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
}

export interface ObservationLedgerOptions {
  recentWindowMs?: number;
  errorSampleLimit?: number;
}

export interface ObservationLedger {
  /** When the panel attached: the earliest instant any figure can speak for. */
  openedAtMs(): number;
  record(service: string, severity: LogSeverity, atMs: number): void;
  snapshot(nowMs: number): Map<string, ServiceObservation>;
  reset(openedAtMs: number): void;
}

interface ServiceCounters {
  lines: number;
  errors: number;
  errorTimes: number[];
  firstObservedAtMs: number;
  lastObservedAtMs: number;
}

/**
 * `openedAt` defaults to now because the ledger's opening instant is its own
 * business: a caller that had to read a clock to build one could accidentally
 * pass a time from before the panel attached, which is exactly the history this
 * module refuses to invent.
 */
export function createObservationLedger(
  openedAt: number = Date.now(),
  {
    recentWindowMs = DEFAULT_RECENT_WINDOW_MS,
    errorSampleLimit = DEFAULT_ERROR_SAMPLE_LIMIT,
  }: ObservationLedgerOptions = {},
): ObservationLedger {
  let opened = openedAt;
  const counters = new Map<string, ServiceCounters>();

  function counterFor(service: string, atMs: number): ServiceCounters {
    const existing = counters.get(service);
    if (existing) return existing;
    const created: ServiceCounters = {
      lines: 0,
      errors: 0,
      errorTimes: [],
      firstObservedAtMs: atMs,
      lastObservedAtMs: atMs,
    };
    counters.set(service, created);
    return created;
  }

  return {
    openedAtMs: () => opened,

    record(service, severity, atMs) {
      const counter = counterFor(service, atMs);
      counter.lines += 1;
      counter.lastObservedAtMs = Math.max(counter.lastObservedAtMs, atMs);
      if (severity !== "error") return;
      counter.errors += 1;
      counter.errorTimes.push(atMs);
      if (counter.errorTimes.length > errorSampleLimit) {
        counter.errorTimes.splice(0, counter.errorTimes.length - errorSampleLimit);
      }
    },

    snapshot(nowMs) {
      const cutoff = nowMs - recentWindowMs;
      const result = new Map<string, ServiceObservation>();
      for (const [service, counter] of counters) {
        // Pruning here rather than only on write is what makes a chip fall back
        // to zero when a service stops erroring, instead of freezing.
        const firstFresh = counter.errorTimes.findIndex((at) => at >= cutoff);
        if (firstFresh > 0) counter.errorTimes.splice(0, firstFresh);
        else if (firstFresh === -1) counter.errorTimes.length = 0;
        result.set(service, {
          service,
          lines: counter.lines,
          errors: counter.errors,
          recentErrors: counter.errorTimes.length,
          firstObservedAtMs: counter.firstObservedAtMs,
          lastObservedAtMs: counter.lastObservedAtMs,
        });
      }
      return result;
    },

    reset(nextOpenedAt) {
      opened = nextOpenedAt;
      counters.clear();
    },
  };
}

export interface SourceRailEntry {
  service: string;
  /** False when hidden by a checkbox, or when another service holds focus. */
  visible: boolean;
  focused: boolean;
  /** From the poller; `null` when the panel has not seen the file. */
  sizeBytes: number | null;
  modifiedAt: string | null;
  liveness: ServiceLiveness;
  /** `null` until the observation window is long enough to divide by. */
  linesPerMinute: number | null;
  recentErrors: number;
  observedLines: number;
}

export function livenessFor(modifiedAt: string | null, nowMs: number): ServiceLiveness {
  if (!modifiedAt) return "stale";
  const written = Date.parse(modifiedAt);
  if (!Number.isFinite(written)) return "stale";
  const age = nowMs - written;
  if (age <= WRITING_WITHIN_MS) return "writing";
  if (age <= QUIET_WITHIN_MS) return "quiet";
  return "stale";
}

export interface SourceRailInput {
  sources: readonly LogSource[];
  observations: ReadonlyMap<string, ServiceObservation>;
  hidden: ReadonlySet<string>;
  focusedService: string | null;
  openedAtMs: number;
  nowMs: number;
}

export function buildSourceRail({
  sources,
  observations,
  hidden,
  focusedService,
  openedAtMs,
  nowMs,
}: SourceRailInput): SourceRailEntry[] {
  const names = new Set<string>([
    ...sources.map((source) => source.service),
    ...observations.keys(),
  ]);
  const byService = new Map(sources.map((source) => [source.service, source]));

  return [...names]
    .sort((left, right) => left.localeCompare(right, "en-US"))
    .map((service) => {
      const source = byService.get(service);
      const observed = observations.get(service);
      // The window opens when the panel first saw the service, never earlier:
      // a service discovered late has no history here to average over.
      const since = Math.max(openedAtMs, observed?.firstObservedAtMs ?? openedAtMs);
      const window = nowMs - since;
      const measurable = observed !== undefined && window >= MIN_RATE_WINDOW_MS;
      return {
        service,
        visible: focusedService === null ? !hidden.has(service) : focusedService === service,
        focused: focusedService === service,
        sizeBytes: source?.sizeBytes ?? null,
        modifiedAt: source?.modifiedAt ?? null,
        liveness: livenessFor(source?.modifiedAt ?? null, nowMs),
        linesPerMinute: measurable
          ? Math.round((observed.lines / window) * 60_000 * 10) / 10
          : null,
        recentErrors: observed?.recentErrors ?? 0,
        observedLines: observed?.lines ?? 0,
      };
    });
}
