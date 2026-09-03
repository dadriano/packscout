import type { DataReleaseStatusValue } from "./data-release-status.client";
import type { GetPublicCatalogRecordUpdateStatusV3Result } from "./public-repacks-v3";

/**
 * The shell reports the maximum source timestamp among every timestamped
 * collectible, repack, and chase in the active public catalog.
 */
export function dataReleaseStatusFromRecordUpdateResult(
  result: GetPublicCatalogRecordUpdateStatusV3Result,
  expectedPublicReleaseId?: string,
): DataReleaseStatusValue {
  if (
    !result.ok ||
    (expectedPublicReleaseId !== undefined &&
      result.data.publicReleaseId !== expectedPublicReleaseId)
  ) {
    return { state: "unavailable" };
  }
  return {
    state: "available",
    updatedAt: result.data.latestCatalogRecordUpdatedAt,
    evaluatedAt: result.data.evaluatedAt,
  };
}
