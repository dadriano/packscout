import {
  PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3,
  type DataReleaseV3Identity,
} from "@packscout/contracts";
import type { DataReleaseStatusValue } from "./data-release-status.client";
import type { GetPublicShellStatusV3Result } from "./public-repacks-v3";

/**
 * Maps the active data_release_v3 identity to the shell freshness status.
 * The release carries no separate staleness policy, so the approved public
 * EV freshness window (60 minutes from the release data-as-of time) is the
 * one honest delay boundary.
 */
export function dataReleaseStatusFromRelease(
  release: DataReleaseV3Identity,
  now: number = Date.now(),
): DataReleaseStatusValue {
  const dataAsOfMillis = Date.parse(release.dataAsOf);
  const staleAtMillis =
    dataAsOfMillis + PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3;
  return {
    state:
      Number.isFinite(staleAtMillis) && now < staleAtMillis
        ? "fresh"
        : "delayed",
    updatedAt: release.dataAsOf,
    staleAt: new Date(staleAtMillis).toISOString(),
  };
}

export function dataReleaseStatusFromPublicResult(
  result: GetPublicShellStatusV3Result,
): DataReleaseStatusValue {
  if (!result.ok) return { state: "unavailable" };
  return dataReleaseStatusFromRelease(result.data.release);
}
