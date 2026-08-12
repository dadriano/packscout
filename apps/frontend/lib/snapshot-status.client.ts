import type { SnapshotMetadata } from "@packscout/contracts";

export type SnapshotStatusValue =
  | { readonly state: "loading" }
  | { readonly state: "unavailable" }
  | {
      readonly state: "fresh" | "delayed";
      readonly updatedAt: string;
      readonly dataSource: SnapshotMetadata["dataSource"];
    };

export type SnapshotStatusPresentation = Readonly<{
  exactLabel: string;
  state: SnapshotStatusValue["state"];
  visibleLabel: string;
}>;

export function formatRelativeSnapshotTime(
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

export function presentSnapshotStatus(
  status: SnapshotStatusValue,
  now: number = Date.now(),
): SnapshotStatusPresentation {
  if (status.state === "loading") {
    return {
      exactLabel: "Catalog freshness is loading",
      state: status.state,
      visibleLabel: "Checking catalog status",
    };
  }

  if (status.state === "unavailable") {
    return {
      exactLabel: "Pack data is unavailable",
      state: status.state,
      visibleLabel: "Pack data unavailable",
    };
  }

  const relativeTime = formatRelativeSnapshotTime(status.updatedAt, now);
  const exactTime = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date(status.updatedAt));

  if (status.dataSource === "mock") {
    return {
      exactLabel:
        status.state === "delayed"
          ? `Mock catalog data is delayed. Last updated ${exactTime}`
          : `Mock catalog data updated ${exactTime}`,
      state: status.state,
      visibleLabel:
        status.state === "delayed"
          ? `Mock data delayed · ${relativeTime}`
          : `Mock data · Updated ${relativeTime}`,
    };
  }

  return {
    exactLabel:
      status.state === "delayed"
        ? `Some data is delayed. Last updated ${exactTime}`
        : `Catalog updated ${exactTime}`,
    state: status.state,
    visibleLabel:
      status.state === "delayed"
        ? `Some data delayed · Updated ${relativeTime}`
        : `Updated ${relativeTime}`,
  };
}
