import type { GetPublicShellStatusResult } from "@packscout/contracts";
import type { SnapshotStatusValue } from "./snapshot-status.client";

export function snapshotStatusFromPublicResult(
  result: GetPublicShellStatusResult,
): SnapshotStatusValue {
  if (!result.ok) return { state: "unavailable" };
  return {
    state: result.data.metadata.freshness,
    updatedAt: result.data.metadata.lastSuccessfulObservationAt,
  };
}
