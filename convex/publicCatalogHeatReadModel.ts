import {
  unavailableRepackHeat,
  type PublicRepackDetail,
  type PublicRepackViewDetail,
} from "@packscout/contracts";

/**
 * Heat remains release-bound to the superseded single-release catalog until
 * the manifest-aware Heat publication cutover. Keep the public DTO stable and
 * fail the attachment closed instead of reading through the legacy pointer.
 */
export function attachHeatToCatalogManifestDetails(
  details: readonly PublicRepackDetail[],
): PublicRepackViewDetail[] {
  return details.map((detail) => ({
    ...detail,
    heat: unavailableRepackHeat("RELEASE_MISMATCH"),
  }));
}
