import { canonicalJson } from "./data-release-v2-canonical.ts";
import {
  providerSourceExpectedCanonicalRelationships,
  type ProviderSourceCanonicalProjectionPlan,
  type ProviderSourceCanonicalRelationshipPlan,
  type ProviderSourceMapperWarningPlan,
  type ProviderSourcePagePlan,
  type ProviderSourcePlannedOutcome,
} from "./provider-source-import-v1.ts";
import type {
  NormalizedObservationSemanticContentV2,
  NormalizedProviderObservationPageV2,
  NormalizedProviderObservationV2,
} from "./provider-source-observation-v2.ts";

export const PROVIDER_SOURCE_PAGE_COMMIT_DIGEST_VERSION_V2 =
  "packscout.provider-source-page-commit.v2" as const;

/**
 * Observation-v2 relationship projection. The dedicated entry point prevents
 * v2 callers from silently falling back to a v1 validation/hash path.
 */
export function providerSourceExpectedCanonicalRelationshipsV2(
  input: Readonly<{
    semanticContent: NormalizedObservationSemanticContentV2;
    projectionKind: "primary" | "derived_ev_input";
  }>,
): readonly ProviderSourceCanonicalRelationshipPlan[] {
  return providerSourceExpectedCanonicalRelationships(input);
}

type ProviderSourceAdapterInvalidOutcome = Extract<
  ProviderSourcePlannedOutcome,
  Readonly<{ kind: "adapter_invalid" }>
>;

export type ProviderSourcePlannedOutcomeV2 =
  | ProviderSourceAdapterInvalidOutcome
  | Readonly<{
      kind: "semantic";
      recordIndex: number;
      observation: NormalizedProviderObservationV2;
      semanticContent: NormalizedObservationSemanticContentV2;
      normalizedContentHash: string;
      protectedNativeEvidenceRef: string;
      protectedTransactionEvidenceRef: string | null;
      warnings: readonly ProviderSourceMapperWarningPlan[];
      mapping:
        | Readonly<{
            status: "mapped";
            projections: readonly ProviderSourceCanonicalProjectionPlan[];
          }>
        | Readonly<{
            status: "quarantined";
            reasonCode: string;
          }>;
    }>;

export interface ProviderSourcePagePlanV2 {
  readonly normalizedPage: NormalizedProviderObservationPageV2;
  readonly outcomes: readonly ProviderSourcePlannedOutcomeV2[];
  readonly counts: ProviderSourcePagePlan["counts"];
}

export type VersionedProviderSourcePlannedOutcome =
  | ProviderSourcePlannedOutcome
  | ProviderSourcePlannedOutcomeV2;
export type VersionedProviderSourcePagePlan =
  | ProviderSourcePagePlan
  | ProviderSourcePagePlanV2;

/**
 * Retained replay preimage for observation-v2 normalized effects. Its domain
 * is deliberately distinct from v1 even when a page contains only v1-shaped
 * catalog or trade observations.
 */
export function providerSourcePageCommitCanonicalJsonV2(input: Readonly<{
  plan: ProviderSourcePagePlanV2;
  protectedNativeEvidence: readonly Readonly<{
    reference: string;
    value: Readonly<Record<string, unknown>>;
  }>[];
}>): string {
  return canonicalJson({
    digestVersion: PROVIDER_SOURCE_PAGE_COMMIT_DIGEST_VERSION_V2,
    plan: input.plan,
    protectedNativeEvidence: input.protectedNativeEvidence,
  });
}
