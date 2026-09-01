import type { DataReleaseStatusValue } from "./data-release-status.client";
import type { DataReleaseV3Identity } from "@packscout/contracts";
import type { GetPublicShellStatusV3Result } from "./public-repacks-v3";

/**
 * The shell reports the completion time of the active public record set.
 * Provider-health observations describe source quality and must not replace
 * this release clock.
 */
export function dataReleaseStatusFromRelease(
  release: DataReleaseV3Identity,
  evaluatedAt: string,
): DataReleaseStatusValue {
  return {
    state: "available",
    updatedAt: release.completedAt,
    evaluatedAt,
  };
}

export function dataReleaseStatusFromPublicResult(
  result: GetPublicShellStatusV3Result,
): DataReleaseStatusValue {
  if (!result.ok) return { state: "unavailable" };
  return dataReleaseStatusFromRelease(
    result.data.release,
    result.data.providerHealthEvaluatedAt,
  );
}
