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
} from "./repack-heat.ts";
import {
  DATA_RELEASE_V3_SCHEMA_VERSION,
  packScoutPublicEvPolicyVersionV3Schema,
} from "./data-release-v3-ev-estimates.ts";
import {
  packScoutPublicEvPresentationV1Schema,
  publicEvPresentationResponseContextV1Schema,
  publicProviderHealthResponseContextV1Schema,
  publicProviderHealthSummaryV1Schema,
  publicProviderHealthV1Schema,
  safePresentPackScoutPublicEvV3,
} from "./public-ev-presentation-v1.ts";
import {
  packAvailabilityIsPurchasableV3,
  packScoutEvProjectionsAreByteEquivalentV3,
  publicRepackDetailV3Schema,
  publicRepackSummaryV3FromDetail,
  publicRepackSummaryV3Schema,
  type PublicRepackSummaryV3,
} from "./data-release-v3-entities.ts";

export * from "./data-release-v3-ev-estimates.ts";
export * from "./data-release-v3-entities.ts";
export * from "./data-release-v3-search.ts";
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

function validatePublicRepackPresentationV3(
  view: {
    readonly evEstimates: PublicRepackSummaryV3["evEstimates"];
    readonly packScoutEvPresentation: z.infer<
      typeof packScoutPublicEvPresentationV1Schema
    >;
  },
  context: z.RefinementCtx,
): void {
  const expected = safePresentPackScoutPublicEvV3(
    view.evEstimates.packScout,
    view.packScoutEvPresentation.confidenceEvaluatedAt,
  );
  if (
    !expected.success ||
    JSON.stringify(expected.presentation) !==
      JSON.stringify(view.packScoutEvPresentation)
  ) {
    context.addIssue({
      code: "custom",
      path: ["packScoutEvPresentation"],
      message: "data_release_v3.presentation_overlay_mismatch",
    });
  }
}

/**
 * Heat travels beside EV and stays independent of EV confidence: any heat
 * state may pair with any PackScout EV state.
 */
export const publicRepackViewSummaryV3Schema = publicRepackSummaryV3Schema
  .safeExtend({
    heat: publicRepackHeatSchema,
    packScoutEvPresentation: packScoutPublicEvPresentationV1Schema,
    providerHealth: publicProviderHealthV1Schema,
  })
  .superRefine(validatePublicRepackPresentationV3);
export const publicRepackViewDetailV3Schema = publicRepackDetailV3Schema
  .safeExtend({
    heat: publicRepackHeatSchema,
    packScoutEvPresentation: packScoutPublicEvPresentationV1Schema,
    providerHealth: publicProviderHealthV1Schema,
  })
  .superRefine(validatePublicRepackPresentationV3);

export type PublicRepackViewSummaryV3 = z.infer<
  typeof publicRepackViewSummaryV3Schema
>;
export type PublicRepackViewDetailV3 = z.infer<
  typeof publicRepackViewDetailV3Schema
>;

export function publicRepackViewSummaryV3FromDetail(
  detail: PublicRepackViewDetailV3,
): PublicRepackViewSummaryV3 {
  const {
    heat,
    packScoutEvPresentation,
    providerHealth,
    ...baseDetail
  } = detail;
  return publicRepackViewSummaryV3Schema.parse({
    ...publicRepackSummaryV3FromDetail(baseDetail),
    heat,
    packScoutEvPresentation,
    providerHealth,
  });
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
    JSON.stringify(selectedRepack.packScoutEvPresentation) !==
      JSON.stringify(matching.packScoutEvPresentation) ||
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

export const publicDashboardOpportunityEligibilityV1Schema = z
  .object({
    rankingEligibleRepackCount: z.number().int().safe().min(0),
    providerIneligibleRepackCount: z.number().int().safe().min(0),
  })
  .strict();

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
  const responseMilliseconds = Date.parse(confidenceEvaluatedAt);
  views.forEach((view, index) => {
    const presentation = view.packScoutEvPresentation;
    const presentationMilliseconds = Date.parse(
      presentation.confidenceEvaluatedAt,
    );
    const clockMatches =
      presentation.status === "historical"
        ? presentationMilliseconds <= responseMilliseconds
        : presentationMilliseconds === responseMilliseconds;
    if (!clockMatches) {
      context.addIssue({
        code: "custom",
        path: ["details", index, "packScoutEvPresentation", "confidenceEvaluatedAt"],
        message: "data_release_v3.presentation_clock_mismatch",
      });
    }
  });
}

/**
 * The dashboard opportunity projection. Opportunities carry the byte-
 * equivalent PackScout projection of their details, admit only purchasable
 * repacks with a current or last-known estimate from a ranking-eligible
 * provider, and rank by signed EV dollars.
 */
export const publicDashboardBundleV3Schema = z
  .object({
    release: dataReleaseV3IdentitySchema,
    ...publicEvPresentationResponseContextV1Schema.shape,
    ...publicProviderHealthResponseContextV1Schema.shape,
    providerHealthSummary: publicProviderHealthSummaryV1Schema,
    opportunityEligibility: publicDashboardOpportunityEligibilityV1Schema,
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
      // Eligibility keeps its exact original intent under the wider enum:
      // both axes must hold. The pack must be purchasable (`available`
      // alone, so `unavailable` and `unknown` are excluded beside
      // `sold_out`) and its PackScout estimate must remain calculable.
      if (
        !packAvailabilityIsPurchasableV3(repack.availability) ||
        (repack.packScoutEvPresentation.status !== "current" &&
          repack.packScoutEvPresentation.status !== "last_known") ||
        !repack.providerHealth.rankingEligible
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
        previous.packScoutEvPresentation.status !== "unavailable" &&
        previous.packScoutEvPresentation.status !== "historical" &&
        repack.packScoutEvPresentation.status !== "unavailable" &&
        repack.packScoutEvPresentation.status !== "historical" &&
        (previous.packScoutEvPresentation.metrics.evDollars.minorUnits <
          repack.packScoutEvPresentation.metrics.evDollars.minorUnits ||
          (previous.packScoutEvPresentation.metrics.evDollars.minorUnits ===
            repack.packScoutEvPresentation.metrics.evDollars.minorUnits &&
            previous.publicRepackId >= repack.publicRepackId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["opportunities", index],
          message: "data_release_v3.opportunities_not_ranked_by_ev_dollars",
        });
      }
    });
    if (
      bundle.opportunityEligibility.rankingEligibleRepackCount <
      bundle.opportunities.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["opportunityEligibility", "rankingEligibleRepackCount"],
        message: "data_release_v3.opportunity_eligibility_count_invalid",
      });
    }
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
export type PublicDashboardOpportunityEligibilityV1 = z.infer<
  typeof publicDashboardOpportunityEligibilityV1Schema
>;
export type PublicShellStatusV3 = z.infer<typeof publicShellStatusV3Schema>;
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
