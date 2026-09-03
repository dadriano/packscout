export type DataReleaseStatusValue =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | {
      readonly state: "available";
      readonly updatedAt: string;
      readonly evaluatedAt: string;
      readonly dataSource?: "canonical" | "mock";
    };

export type DataReleaseStatusPresentation = Readonly<{
  exactLabel: string;
  state: DataReleaseStatusValue["state"];
  visibleLabel: string;
}>;

const RECORD_UPDATE_REFRESH_INTERVAL_MILLISECONDS = 60_000;

export function recordUpdateRefreshIntervalMilliseconds(
  status: DataReleaseStatusValue,
): number | null {
  return status.state === "available" || status.state === "unavailable"
    ? RECORD_UPDATE_REFRESH_INTERVAL_MILLISECONDS
    : null;
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
      exactLabel: "Latest catalog record update time is loading",
      state: status.state,
      visibleLabel: "Checking latest record update",
    };
  }

  if (status.state === "unavailable") {
    return {
      exactLabel: "Latest catalog record update time is unavailable",
      state: status.state,
      visibleLabel: "Latest record update unavailable",
    };
  }

  const relativeTime = formatRelativeReleaseTime(status.updatedAt, now);
  const updatedAt = Date.parse(status.updatedAt);
  const exactTime = Number.isFinite(updatedAt)
    ? new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "long",
      }).format(new Date(updatedAt))
    : "recently";

  if (status.dataSource === "mock") {
    return {
      exactLabel: `Latest mock catalog record update ${exactTime}`,
      state: status.state,
      visibleLabel: `Latest mock record update · ${relativeTime}`,
    };
  }

  return {
    exactLabel: `Latest catalog record update ${exactTime}`,
    state: status.state,
    visibleLabel: `Latest record update · ${relativeTime}`,
  };
}
