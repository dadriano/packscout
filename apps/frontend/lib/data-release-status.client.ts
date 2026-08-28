export type DataReleaseStatusValue =
  | { readonly state: "loading" }
  | {
      readonly state: "unavailable";
      readonly evaluatedAt?: string;
      readonly nextHealthEvaluationAt?: string | null;
    }
  | {
      readonly state: "fresh" | "delayed";
      readonly updatedAt: string;
      readonly freshThrough: string;
      readonly evaluatedAt: string;
      readonly nextHealthEvaluationAt: string | null;
      readonly totalProviderCount?: number;
      readonly delayedProviderCount?: number;
      readonly dataSource?: "canonical" | "mock";
    };

export type DataReleaseStatusPresentation = Readonly<{
  exactLabel: string;
  state: DataReleaseStatusValue["state"];
  visibleLabel: string;
}>;

/**
 * Uses two timestamps minted by the same trusted backend response so browser
 * clock skew cannot move the next ranking-health refresh boundary. Aggregate
 * health may already be delayed while another provider is still eligible.
 */
export function providerHealthRefreshDelayMilliseconds(
  status: DataReleaseStatusValue,
): number | null {
  if (
    !("evaluatedAt" in status) ||
    !("nextHealthEvaluationAt" in status) ||
    status.evaluatedAt === undefined ||
    status.nextHealthEvaluationAt === undefined ||
    status.nextHealthEvaluationAt === null
  ) return null;
  const evaluatedAt = Date.parse(status.evaluatedAt);
  const nextHealthEvaluationAt = Date.parse(status.nextHealthEvaluationAt);
  if (!Number.isFinite(evaluatedAt) || !Number.isFinite(nextHealthEvaluationAt)) {
    return null;
  }
  return Math.max(0, nextHealthEvaluationAt - evaluatedAt);
}

export function formatRelativeReleaseTime(
  updatedAt: string,
  now: number = Date.now(),
): string {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "recently";

  const elapsedSeconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

export function presentDataReleaseStatus(
  status: DataReleaseStatusValue,
  now: number = Date.now(),
): DataReleaseStatusPresentation {
  if (status.state === "loading") {
    return {
      exactLabel: "Repack data freshness is loading",
      state: status.state,
      visibleLabel: "Checking repack data",
    };
  }

  if (status.state === "unavailable") {
    return {
      exactLabel: "Provider feed status is unavailable",
      state: status.state,
      visibleLabel: "Provider feed status unavailable",
    };
  }

  const freshThrough = Date.parse(status.freshThrough);
  const effectiveState =
    status.state === "delayed" ||
      (Number.isFinite(freshThrough) && now >= freshThrough)
      ? "delayed"
      : "fresh";
  const relativeTime = formatRelativeReleaseTime(status.updatedAt, now);
  const exactTime = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(status.updatedAt));

  if (status.dataSource === "mock") {
    return {
      exactLabel:
        effectiveState === "delayed"
          ? `Mock repack data is delayed. Last updated ${exactTime}`
          : `Mock repack data updated ${exactTime}`,
      state: effectiveState,
      visibleLabel:
        effectiveState === "delayed"
          ? `Mock data delayed · ${relativeTime}`
          : `Mock data · Updated ${relativeTime}`,
    };
  }

  return {
    exactLabel:
      effectiveState === "delayed"
        ? `Provider feeds are delayed. Last checked ${exactTime}`
        : `Provider feeds are healthy. Last checked ${exactTime}`,
    state: effectiveState,
    visibleLabel:
      effectiveState === "delayed"
        ? `Provider feeds delayed · Checked ${relativeTime}`
        : `Provider feeds healthy · Checked ${relativeTime}`,
  };
}
