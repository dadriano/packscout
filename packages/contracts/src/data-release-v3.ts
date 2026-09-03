import { z } from "zod";
import {
  packScoutBuybackEvConfidencePolicyVersionV1Schema,
  packScoutBuybackEvMethodVersionV1Schema,
  packScoutBuybackEvTimestampV1Schema,
} from "./buyback-adjusted-ev-v1-common.ts";
import {
  publicCollectibleDisplaySchema,
  publicRepackChaseSchema,
} from "./data-release-v2-entities.ts";
import { publicRepackIdSchema } from "./data-release-v2-values.ts";
import {
  publicRepackHeatSchema,
  type PublicRepackHeat,
} from "./repack-heat.ts";
import {
  DATA_RELEASE_V3_SCHEMA_VERSION,
  packScoutPublicEvPolicyVersionV3Schema,
} from "./data-release-v3-ev-estimates.ts";
import {
  publicEvPresentationResponseContextV1Schema,
  publicProviderHealthResponseContextV1Schema,
  publicProviderHealthSummaryV1Schema,
  publicProviderHealthV1Schema,
  type PublicProviderHealthV1,
} from "./public-ev-presentation-v1.ts";
import {
  packAvailabilityIsPurchasableV3,
  packScoutEvProjectionsAreByteEquivalentV3,
  publicRepackDetailDisplayedV3Schema,
  publicRepackSummaryDisplayedV3Schema,
  type PublicRepackDetailDisplayedV3,
  type PublicRepackSummaryDisplayedV3,
} from "./data-release-v3-entities.ts";

export * from "./data-release-v3-ev-estimates.ts";
export * from "./data-release-v3-entities.ts";
export * from "./data-release-v3-search.ts";
export * from "./data-release-v3-last-known-ev.ts";
export * from "./public-ev-presentation-v1.ts";

/**
 * The active release identity carried by every data_release_v3 result
 * envelope. The exact buyback-adjusted calculation and confidence-policy
 * versions and the public nonpositive-EV policy are required; no other EV
 * interpretation can enter this release.
 */
export const dataReleaseV3IdentitySchema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION),
    publicReleaseId: z.uuid(),
    methodVersion: packScoutBuybackEvMethodVersionV1Schema,
    confidencePolicyVersion: packScoutBuybackEvConfidencePolicyVersionV1Schema,
    publicEvPolicyVersion: packScoutPublicEvPolicyVersionV3Schema,
    dataAsOf: packScoutBuybackEvTimestampV1Schema,
    completedAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict()
  .refine(
    ({ dataAsOf, completedAt }) =>
      Date.parse(dataAsOf) <= Date.parse(completedAt),
    { path: ["dataAsOf"], message: "data_release_v3.data_after_completion" },
  );

export type DataReleaseV3Identity = z.infer<typeof dataReleaseV3IdentitySchema>;

export type PublicRepackViewSummaryV3 = PublicRepackSummaryDisplayedV3 &
  Readonly<{ heat: PublicRepackHeat; providerHealth: PublicProviderHealthV1 }>;
export type PublicRepackViewDetailV3 = PublicRepackDetailDisplayedV3 &
  Readonly<{ heat: PublicRepackHeat; providerHealth: PublicProviderHealthV1 }>;

/**
 * Heat travels beside EV and stays independent of EV confidence: any heat
 * state may pair with any PackScout EV state.
 */
export const publicRepackViewSummaryV3Schema: z.ZodType<PublicRepackViewSummaryV3> =
  publicRepackSummaryDisplayedV3Schema.safeExtend({
    heat: publicRepackHeatSchema, providerHealth: publicProviderHealthV1Schema,
  });
export const publicRepackViewDetailV3Schema: z.ZodType<PublicRepackViewDetailV3> =
  publicRepackDetailDisplayedV3Schema.safeExtend({
    heat: publicRepackHeatSchema, providerHealth: publicProviderHealthV1Schema,
  });

export function publicRepackViewSummaryV3FromDetail(
  detail: PublicRepackViewDetailV3,
): PublicRepackViewSummaryV3 {
  return publicRepackViewSummaryV3Schema.parse(Object.fromEntries(
    Object.entries(detail).filter(([key]) => key !== "description" && key !== "actions"),
  ));
}

function summaryMatchesDetailV3(
  summary: PublicRepackViewSummaryV3,
  detail: PublicRepackViewDetailV3 | undefined,
): boolean {
  return (
    detail !== undefined &&
    JSON.stringify(summary) ===
      JSON.stringify(publicRepackViewSummaryV3FromDetail(detail))
  );
}

function validateSummaryDetailPairsV3(
  summaries: readonly PublicRepackViewSummaryV3[],
  details: readonly PublicRepackViewDetailV3[],
  context: z.RefinementCtx,
): void {
  if (
    summaries.length !== details.length ||
    summaries.some(
      (summary, index) => !summaryMatchesDetailV3(summary, details[index]),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["details"],
      message: "data_release_v3.summary_detail_divergence",
    });
  }
}

function validateSelectedRepackV3(
  selectedRepack: PublicRepackViewDetailV3 | null,
  details: readonly PublicRepackViewDetailV3[],
  context: z.RefinementCtx,
): void {
  if (selectedRepack === null) return;
  const matching = details.find(
    ({ publicRepackId }) => publicRepackId === selectedRepack.publicRepackId,
  );
  if (
    matching === undefined ||
    !packScoutEvProjectionsAreByteEquivalentV3(selectedRepack, matching) ||
    JSON.stringify(selectedRepack.providerHealth) !==
      JSON.stringify(matching.providerHealth)
  ) {
    context.addIssue({
      code: "custom",
      path: ["selectedRepack"],
      message: "data_release_v3.selected_item_divergence",
    });
  }
}

export const publicShellStatusV3Schema = z
  .object({
    release: dataReleaseV3IdentitySchema,
    ...publicEvPresentationResponseContextV1Schema.shape,
    ...publicProviderHealthResponseContextV1Schema.shape,
    providerHealthSummary: publicProviderHealthSummaryV1Schema,
  })
  .strict()
  .superRefine((status, context) => {
    validateProviderHealthResponseClockV3(status, context);
  });

/**
 * The newest source timestamp carried by any timestamped record in the active
 * public catalog. This is deliberately separate from release identity: a
 * publisher completion clock describes when Convex accepted a release, while
 * this value describes when the underlying catalog records last changed.
 */
export const publicCatalogRecordUpdateStatusV3Schema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_V3_SCHEMA_VERSION),
    publicReleaseId: z.uuid(),
    latestCatalogRecordUpdatedAt: packScoutBuybackEvTimestampV1Schema,
    evaluatedAt: packScoutBuybackEvTimestampV1Schema,
  })
  .strict()
  .refine(
    ({ latestCatalogRecordUpdatedAt, evaluatedAt }) =>
      Date.parse(latestCatalogRecordUpdatedAt) <= Date.parse(evaluatedAt),
    {
      path: ["latestCatalogRecordUpdatedAt"],
      message: "data_release_v3.record_update_after_evaluation",
    },
  );

function validateProviderHealthResponseClockV3(
  response: {
    readonly confidenceEvaluatedAt: string;
    readonly providerHealthEvaluatedAt: string;
    readonly providerHealthSummary?: z.infer<
      typeof publicProviderHealthSummaryV1Schema
    >;
  },
  context: z.RefinementCtx,
): void {
  const confidenceEvaluatedAt = Date.parse(response.confidenceEvaluatedAt);
  const providerHealthEvaluatedAt = Date.parse(
    response.providerHealthEvaluatedAt,
  );
  if (providerHealthEvaluatedAt < confidenceEvaluatedAt) {
    context.addIssue({
      code: "custom",
      path: ["providerHealthEvaluatedAt"],
      message: "data_release_v3.provider_health_clock_precedes_confidence",
    });
  }
  const nextHealthEvaluationAt =
    response.providerHealthSummary?.nextHealthEvaluationAt ?? null;
  if (
    nextHealthEvaluationAt !== null &&
    Date.parse(nextHealthEvaluationAt) <= providerHealthEvaluatedAt
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerHealthSummary", "nextHealthEvaluationAt"],
      message: "data_release_v3.provider_health_deadline_not_future",
    });
  }
}

function validateResponsePresentationClockV3(
  confidenceEvaluatedAt: string,
  views: readonly PublicRepackViewSummaryV3[],
  context: z.RefinementCtx,
): void {
  views.forEach((view, index) => {
    const presentation = view.evEstimates.packScout;
    // Raw snapshots are admitted only during the existing one-time migration;
    // retained displayed values (including sold-out history) share one clock.
    if (presentation.status === "last_known" &&
        presentation.confidenceEvaluatedAt !== confidenceEvaluatedAt) {
      context.addIssue({
        code: "custom",
        path: ["details", index, "evEstimates", "packScout", "confidenceEvaluatedAt"],
        message: "data_release_v3.presentation_clock_mismatch",
      });
    }
  });
}

/**
 * The dashboard opportunity projection. Opportunities carry the byte-
 * equivalent PackScout projection of their details, admit only purchasable
 * repacks with a last validated estimate, and rank by signed EV dollars.
 */
export const publicDashboardBundleV3Schema = z
  .object({
    release: dataReleaseV3IdentitySchema,
    ...publicEvPresentationResponseContextV1Schema.shape,
    ...publicProviderHealthResponseContextV1Schema.shape,
    providerHealthSummary: publicProviderHealthSummaryV1Schema,
    opportunities: z.array(publicRepackViewSummaryV3Schema).max(6),
    details: z.array(publicRepackViewDetailV3Schema).max(6),
    selectedRepack: publicRepackViewDetailV3Schema.nullable(),
  })
  .strict()
  .superRefine((bundle, context) => {
    validateProviderHealthResponseClockV3(bundle, context);
    validateSummaryDetailPairsV3(bundle.opportunities, bundle.details, context);
    validateResponsePresentationClockV3(
      bundle.confidenceEvaluatedAt,
      bundle.details,
      context,
    );
    bundle.opportunities.forEach((repack, index) => {
      // The listing must still be purchasable. A validated last-known
      // estimate remains eligible even after its confidence reaches zero.
      if (
        !packAvailabilityIsPurchasableV3(repack.availability) ||
        (repack.evEstimates.packScout.status !== "current" &&
          repack.evEstimates.packScout.status !== "last_known") ||
        (repack.evEstimates.packScout.status === "last_known" &&
          repack.evEstimates.packScout.historicalSoldOutAt !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", index],
          message: "data_release_v3.opportunity_ineligible",
        });
      }
      const previous = bundle.opportunities[index - 1];
      if (
        previous !== undefined &&
        previous.evEstimates.packScout.status !== "unavailable" &&
        repack.evEstimates.packScout.status !== "unavailable" &&
        (previous.evEstimates.packScout.metrics.evDollars.minorUnits <
          repack.evEstimates.packScout.metrics.evDollars.minorUnits ||
          (previous.evEstimates.packScout.metrics.evDollars.minorUnits ===
            repack.evEstimates.packScout.metrics.evDollars.minorUnits &&
            previous.publicRepackId >= repack.publicRepackId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", index],
          message: "data_release_v3.opportunities_not_ranked_by_ev_dollars",
        });
      }
    });
    if ((bundle.opportunities.length === 0) !== (bundle.selectedRepack === null)) {
      context.addIssue({
        code: "custom",
        path: ["selectedRepack"],
        message: "data_release_v3.selection_mismatch",
      });
    }
    validateSelectedRepackV3(bundle.selectedRepack, bundle.details, context);
  });

export const desiredChasePageMatchV3Schema = z
  .object({
    publicRepackId: publicRepackIdSchema,
    chase: publicRepackChaseSchema,
  })
  .strict()
  .refine(
    ({ publicRepackId, chase }) => publicRepackId === chase.publicRepackId,
    { path: ["chase"], message: "data_release_v3.desired_chase_repack_mismatch" },
  );

/**
 * The list projection for All Repacks. Rows and details carry byte-
 * equivalent PackScout projections; a desired-collectible filter binds
 * every row to a chase match for the same collectible identity.
 */
export const publicRepackListPageV3Schema = z
  .object({
    release: dataReleaseV3IdentitySchema,
    ...publicEvPresentationResponseContextV1Schema.shape,
    ...publicProviderHealthResponseContextV1Schema.shape,
    providerHealthSummary: publicProviderHealthSummaryV1Schema,
    rows: z.array(publicRepackViewSummaryV3Schema).max(50),
    details: z.array(publicRepackViewDetailV3Schema).max(50),
    selectedRepack: publicRepackViewDetailV3Schema.nullable(),
    selectedRepackEligible: z.boolean(),
    desiredCollectible: publicCollectibleDisplaySchema.nullable(),
    desiredChaseMatches: z.array(desiredChasePageMatchV3Schema).max(50),
  })
  .strict()
  .superRefine((page, context) => {
    validateProviderHealthResponseClockV3(page, context);
    validateSummaryDetailPairsV3(page.rows, page.details, context);
    validateResponsePresentationClockV3(
      page.confidenceEvaluatedAt,
      page.details,
      context,
    );
    if (
      page.selectedRepackEligible !== (page.selectedRepack !== null) ||
      (page.selectedRepack !== null &&
        !page.rows.some(
          ({ publicRepackId }) =>
            publicRepackId === page.selectedRepack?.publicRepackId,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedRepackEligible"],
        message: "data_release_v3.selection_mismatch",
      });
    }
    validateSelectedRepackV3(page.selectedRepack, page.details, context);
    if (page.desiredCollectible === null) {
      if (page.desiredChaseMatches.length !== 0) {
        context.addIssue({
          code: "custom",
          path: ["desiredChaseMatches"],
          message: "data_release_v3.inactive_desired_has_matches",
        });
      }
      return;
    }
    const desiredId = page.desiredCollectible.publicCollectibleId;
    const desiredBytes = JSON.stringify(page.desiredCollectible);
    const rowIds = page.rows.map(({ publicRepackId }) => publicRepackId);
    const matchIds = page.desiredChaseMatches.map(
      ({ publicRepackId }) => publicRepackId,
    );
    if (
      !page.desiredChaseMatches.every(
        ({ chase }) =>
          chase.publicCollectibleId === desiredId &&
          JSON.stringify(chase.collectible) === desiredBytes,
      ) ||
      new Set(matchIds).size !== matchIds.length ||
      rowIds.length !== matchIds.length ||
      rowIds.some((rowId) => !matchIds.includes(rowId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["desiredChaseMatches"],
        message: "data_release_v3.desired_matches_incomplete",
      });
    }
  });

export const desiredCollectibleRepackMatchV3Schema = z
  .object({
    repack: publicRepackViewSummaryV3Schema,
    chase: publicRepackChaseSchema,
  })
  .strict()
  .refine(
    ({ repack, chase }) => repack.publicRepackId === chase.publicRepackId,
    { path: ["chase"], message: "data_release_v3.desired_match_repack_mismatch" },
  );

/** The desired-collectible projection carrying the same repack EV shape. */
export const desiredCollectibleRepackResultsV3Schema = z
  .object({
    release: dataReleaseV3IdentitySchema,
    ...publicEvPresentationResponseContextV1Schema.shape,
    ...publicProviderHealthResponseContextV1Schema.shape,
    desiredCollectible: publicCollectibleDisplaySchema,
    matches: z.array(desiredCollectibleRepackMatchV3Schema).max(50),
    total: z.number().int().safe().min(0),
  })
  .strict()
  .superRefine((result, context) => {
    validateProviderHealthResponseClockV3(result, context);
    validateResponsePresentationClockV3(
      result.confidenceEvaluatedAt,
      result.matches.map(({ repack }) => repack),
      context,
    );
    if (result.total < result.matches.length) {
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "data_release_v3.total_invalid",
      });
    }
    const desiredBytes = JSON.stringify(result.desiredCollectible);
    if (
      result.matches.some(
        ({ chase }) =>
          chase.publicCollectibleId !==
            result.desiredCollectible.publicCollectibleId ||
          JSON.stringify(chase.collectible) !== desiredBytes,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["matches"],
        message: "data_release_v3.desired_identity_mismatch",
      });
    }
  });

export type PublicDashboardBundleV3 = z.infer<
  typeof publicDashboardBundleV3Schema
>;
export type PublicShellStatusV3 = z.infer<typeof publicShellStatusV3Schema>;
export type PublicCatalogRecordUpdateStatusV3 = z.infer<
  typeof publicCatalogRecordUpdateStatusV3Schema
>;
export type PublicRepackListPageV3 = z.infer<
  typeof publicRepackListPageV3Schema
>;
export type DesiredChasePageMatchV3 = z.infer<
  typeof desiredChasePageMatchV3Schema
>;
export type DesiredCollectibleRepackMatchV3 = z.infer<
  typeof desiredCollectibleRepackMatchV3Schema
>;
export type DesiredCollectibleRepackResultsV3 = z.infer<
  typeof desiredCollectibleRepackResultsV3Schema
>;
