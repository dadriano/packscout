import type { ProviderSourceOperationsOverview, ProviderSourceOperationsSource } from "@packscout/contracts";

const WINDOW_MS = 60_000;
const MINIMUM_WINDOW_MS = 5_000;
const MAXIMUM_GAP_MS = 15_000;
const MAXIMUM_SAMPLES = 32;

interface RateSample {
  readonly observedAt: number;
  readonly receivedAt: number;
  readonly processed: number;
}

interface RateSeries {
  readonly scope: string;
  readonly samples: readonly RateSample[];
}

export type RecentRateHistory = Readonly<Record<string, RateSeries>>;
export type RecentRateReading =
  | { readonly state: "measuring" | "unavailable" }
  | { readonly state: "available"; readonly recordsPerSecond: number; readonly windowMilliseconds: number; readonly sampleCount: number };

export function isRecentRateEligible(source: ProviderSourceOperationsSource): boolean {
  return source.configured && source.source?.lifecycle === "active" && !source.source.pauseRequested
    && source.activeRun?.state === "running" && source.processor?.activity === "running"
    && source.measurements.activity.state === "available" && source.measurements.activity.importLease.state === "active";
}

function sourceScope(source: ProviderSourceOperationsSource, organizationId: string): string {
  return JSON.stringify([organizationId, source.providerId, source.source?.sourceRevisionId,
    source.activeRun?.id, source.activeRun?.startedAt]);
}

function advanceSeries(previous: RateSeries | undefined, scope: string, sample: RateSample): RateSeries {
  const last = previous?.samples.at(-1);
  if (!last || previous?.scope !== scope
    || sample.observedAt < last.observedAt || sample.processed < last.processed
    || sample.receivedAt < last.receivedAt || sample.receivedAt - last.receivedAt > MAXIMUM_GAP_MS
    || sample.observedAt - last.observedAt > MAXIMUM_GAP_MS) {
    return { scope, samples: [sample] };
  }
  // Repeated responses and StrictMode replays cannot add time or renew freshness.
  if (sample.observedAt === last.observedAt) {
    return sample.processed === last.processed ? previous : { scope, samples: [sample] };
  }
  return {
    scope,
    samples: [...previous.samples.filter((point) => point.observedAt >= sample.observedAt - WINDOW_MS), sample].slice(-MAXIMUM_SAMPLES),
  };
}

/** Call only for newly accepted, visible status responses, never retained UI state. */
export function observeRecentRates(
  history: RecentRateHistory,
  overview: ProviderSourceOperationsOverview,
  organizationId: string,
  receivedAt: number,
): RecentRateHistory {
  const observedAt = Date.parse(overview.refreshedAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(receivedAt)) return {};
  return Object.fromEntries(overview.sources.flatMap((source) => {
    const processed = source.progress.records.total;
    if (!isRecentRateEligible(source) || !Number.isSafeInteger(processed) || processed < 0) return [];
    return [[source.providerId, advanceSeries(history[source.providerId], sourceScope(source, organizationId), {
      observedAt, receivedAt, processed,
    })]];
  }));
}

/** Uses a monotonic browser receipt clock, so a stalled request cannot look live. */
export function expireRecentRates(history: RecentRateHistory, receivedAt: number): RecentRateHistory {
  const retained = Object.entries(history).filter(([, series]) => {
    const elapsed = receivedAt - series.samples.at(-1)!.receivedAt;
    return elapsed >= 0 && elapsed <= MAXIMUM_GAP_MS;
  });
  return retained.length === Object.keys(history).length ? history : Object.fromEntries(retained);
}

export function readRecentRate(history: RecentRateHistory, source: ProviderSourceOperationsSource, organizationId: string): RecentRateReading {
  const series = history[source.providerId];
  if (!isRecentRateEligible(source) || !series || series.scope !== sourceScope(source, organizationId)) return { state: "unavailable" };
  const first = series.samples[0]!;
  const last = series.samples.at(-1)!;
  const windowMilliseconds = last.observedAt - first.observedAt;
  if (windowMilliseconds < MINIMUM_WINDOW_MS) return { state: "measuring" };
  return {
    state: "available",
    recordsPerSecond: (last.processed - first.processed) / (windowMilliseconds / 1_000),
    windowMilliseconds,
    sampleCount: series.samples.length,
  };
}

export function recentRateValue(reading: RecentRateReading): string {
  if (reading.state !== "available") return reading.state === "measuring" ? "Measuring…" : "Unavailable";
  if (reading.recordsPerSecond > 0 && reading.recordsPerSecond < 0.1) return "<0.1";
  return reading.recordsPerSecond.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export function recentRateDescription(reading: RecentRateReading): string {
  const window = reading.state === "available"
    ? `Observed over ${(reading.windowMilliseconds / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })} seconds from ${reading.sampleCount} status samples.`
    : reading.state === "measuring" ? "Collecting at least 5 seconds of distinct status samples."
      : "Fresh samples are unavailable. Resume visible updates to measure again.";
  return `${window} Rate is the change in this active run's processed-record counter, not newly stored rows. Uses up to 60 seconds of recent samples; request timing makes it approximate.`;
}
