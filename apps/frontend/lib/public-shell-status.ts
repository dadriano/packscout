import type {
  GetPublicShellStatusResult,
  SnapshotMetadata,
} from "@packscout/contracts";
import type { SnapshotStatusValue } from "./snapshot-status.client";

export function snapshotStatusFromMetadata(
  metadata: SnapshotMetadata,
): SnapshotStatusValue {
  return {
    state: metadata.freshness,
    updatedAt: metadata.lastSuccessfulObservationAt,
    dataSource: metadata.dataSource,
  };
}

export function snapshotStatusFromPublicResult(
  result: GetPublicShellStatusResult,
): SnapshotStatusValue {
  if (!result.ok) return { state: "unavailable" };
  return snapshotStatusFromMetadata(result.data.metadata);
}
