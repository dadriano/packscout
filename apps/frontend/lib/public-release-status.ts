import type {
  DataReleaseMetadata,
  GetPublicShellStatusResult,
} from "@packscout/contracts";
import type { DataReleaseStatusValue } from "./data-release-status.client";

export function dataReleaseStatusFromMetadata(
  metadata: DataReleaseMetadata,
  now: number = Date.now(),
): DataReleaseStatusValue {
  const staleAt = Date.parse(metadata.staleAt);
  return {
    state:
      metadata.freshness === "delayed" ||
        (Number.isFinite(staleAt) && now >= staleAt)
        ? "delayed"
        : "fresh",
    updatedAt: metadata.lastSuccessfulObservationAt,
    staleAt: metadata.staleAt,
    dataSource: metadata.dataSource,
  };
}

export function dataReleaseStatusFromPublicResult(
  result: GetPublicShellStatusResult,
): DataReleaseStatusValue {
  if (!result.ok) return { state: "unavailable" };
  return dataReleaseStatusFromMetadata(result.data.metadata);
}
