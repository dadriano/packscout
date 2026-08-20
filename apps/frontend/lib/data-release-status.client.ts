import type { DataReleaseMetadata } from "@packscout/contracts";

export type DataReleaseStatusValue =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | {
      readonly state: "fresh" | "delayed";
      readonly updatedAt: string;
      readonly staleAt: string;
      readonly dataSource: DataReleaseMetadata["dataSource"];
    };

export type DataReleaseStatusPresentation = Readonly<{
  exactLabel: string;
  state: DataReleaseStatusValue["state"];
  visibleLabel: string;
}>;

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

  return `${Math.min(1, Math.floor(elapsedHours / 24))}d ago`;
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
      exactLabel: "Repack data is unavailable",
      state: status.state,
      visibleLabel: "Repack data unavailable",
    };
  }

  const staleAt = Date.parse(status.staleAt);
  const effectiveState =
    status.state === "delayed" ||
      (Number.isFinite(staleAt) && now >= staleAt)
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
        ? `Some data is delayed. Last updated ${exactTime}`
        : `Repack data updated ${exactTime}`,
    state: effectiveState,
    visibleLabel:
      effectiveState === "delayed"
        ? `Some data delayed · Updated ${relativeTime}`
        : `Updated ${relativeTime}`,
  };
}
