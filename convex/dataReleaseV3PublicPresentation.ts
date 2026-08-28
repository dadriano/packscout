import {
  PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
  PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1,
  safeEvaluatePackScoutPublicConfidenceV1,
  type PackScoutPublicEvPresentationV1,
} from "@packscout/contracts";
import type { DataReleaseV3SearchRow } from "./dataReleaseV3Search";

export function dataReleaseV3PresentationContext(evaluationTime: number) {
  return {
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
    confidenceEvaluatedAt: new Date(evaluationTime).toISOString(),
  } as const;
}

export function dataReleaseV3ProviderHealthContext(evaluationTime: number) {
  return {
    providerHealthEvaluatedAt: new Date(evaluationTime).toISOString(),
  } as const;
}

/** Re-evaluates confidence without erasing any immutable search-row metric. */
export function presentDataReleaseV3SearchRowFromStaticMetadata(
  row: DataReleaseV3SearchRow,
  evaluationTime: number,
): DataReleaseV3SearchRow | null {
  if (row.packScoutExpiresAtMillis === null) return row;
  if (row.packScoutStaticConfidencePenaltyBasisPoints === undefined) return row;
  if (row.packScoutStaticConfidencePenaltyBasisPoints === null) return null;
  const observedAt = new Date(
    row.packScoutExpiresAtMillis -
      PACKSCOUT_PUBLIC_EV_CURRENT_WINDOW_MILLISECONDS_V1,
  ).toISOString();
  const evaluated = safeEvaluatePackScoutPublicConfidenceV1(
    {
      staticPenaltyBasisPoints:
        row.packScoutStaticConfidencePenaltyBasisPoints,
      observedAt,
    },
    new Date(evaluationTime).toISOString(),
  );
  if (!evaluated.success) return null;
  return {
    ...row,
    packScoutConfidenceBasisPoints:
      evaluated.evaluation.confidence.scoreBasisPoints,
    packScoutConfidenceNullRank: 0,
    packScoutConfidenceBand: evaluated.evaluation.confidence.band,
  };
}

export function dataReleaseV3SearchRowWithPresentationConfidence(
  row: DataReleaseV3SearchRow,
  presentation: PackScoutPublicEvPresentationV1,
): DataReleaseV3SearchRow {
  if (
    presentation.status === "unavailable" ||
    presentation.status === "historical"
  ) {
    return row;
  }
  return {
    ...row,
    packScoutConfidenceBasisPoints:
      presentation.confidence.scoreBasisPoints,
    packScoutConfidenceNullRank: 0,
    packScoutConfidenceBand: presentation.confidence.band,
  };
}
