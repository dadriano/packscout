import type { DataReleaseStatusValue } from "./data-release-status.client";
import type {
  GetPublicShellStatusV3Result,
  PublicShellStatusV3,
} from "./public-repacks-v3";

/**
 * Maps the independently refreshed provider-health summary to the shell
 * status. Immutable release age and per-estimate evidence age are deliberately
 * not provider-health proxies.
 */
export function dataReleaseStatusFromProviderHealth(
  health: PublicShellStatusV3["providerHealthSummary"],
  providerHealthEvaluatedAt: string,
): DataReleaseStatusValue {
  if (
    health.state === "unavailable" ||
    health.observedAt === null ||
    health.freshThrough === null
  ) {
    return health.nextHealthEvaluationAt === null
      ? { state: "unavailable" }
      : {
          state: "unavailable",
          evaluatedAt: providerHealthEvaluatedAt,
          nextHealthEvaluationAt: health.nextHealthEvaluationAt,
        };
  }
  return {
    state: health.state === "healthy" ? "fresh" : "delayed",
    updatedAt: health.observedAt,
    freshThrough: health.freshThrough,
    evaluatedAt: providerHealthEvaluatedAt,
    nextHealthEvaluationAt: health.nextHealthEvaluationAt,
    totalProviderCount: health.totalProviderCount,
    delayedProviderCount: health.delayedProviderCount,
  };
}

export function dataReleaseStatusFromPublicResult(
  result: GetPublicShellStatusV3Result,
): DataReleaseStatusValue {
  if (!result.ok) return { state: "unavailable" };
  return dataReleaseStatusFromProviderHealth(
    result.data.providerHealthSummary,
    result.data.providerHealthEvaluatedAt,
  );
}
