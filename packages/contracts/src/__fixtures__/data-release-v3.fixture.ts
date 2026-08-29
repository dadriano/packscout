import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1,
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
  type PackScoutBuybackEvPublicReasonCodeV1,
} from "../buyback-adjusted-ev-v1.ts";
import type { PublicPackAvailability } from "../public-pack-availability-v1.ts";
import { unavailableRepackHeat } from "../repack-heat.ts";
import {
  dataReleaseV3IdentitySchema,
  desiredCollectibleRepackResultsV3Schema,
  packScoutPublicEvV3Schema,
  publicBuybackSummaryV3Schema,
  publicDashboardBundleV3Schema,
  publicEvEstimatesV3Schema,
  publicRepackDetailV3Schema,
  publicRepackListPageV3Schema,
  publicRepackViewDetailV3Schema,
  publicRepackViewSummaryV3FromDetail,
  safePresentPackScoutPublicEvV3,
  vendorReportedEvV3Schema,
  PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  type DataReleaseV3Identity,
  type DesiredCollectibleRepackResultsV3,
  type PackScoutPublicEvV3,
  type PublicBuybackSummaryV3,
  type PublicDashboardBundleV3,
  type PublicEvEstimatesV3,
  type PublicRepackDetailV3,
  type PublicRepackListPageV3,
  type PublicRepackViewDetailV3,
  type PublicProviderHealthV1,
  type PublicProviderHealthSummaryV1,
  type PublicShellStatusV3,
  type VendorReportedEvV3,
} from "../data-release-v3.ts";

export const DATA_RELEASE_V3_OBSERVED_AT = "2026-08-19T18:00:00.000Z" as const;
export const DATA_RELEASE_V3_EXPIRES_AT = "2026-08-19T19:00:00.000Z" as const;
export const DATA_RELEASE_V3_SOLD_OUT_AT = "2026-08-19T18:30:00.000Z" as const;
export const DATA_RELEASE_V3_PACK_PRICE_MINOR_UNITS = 10_000 as const;

export const DATA_RELEASE_V3_VENDOR_ID =
  "00000000-0000-5000-8000-000000000001";
export const DATA_RELEASE_V3_CARDS_CATEGORY_ID =
  "00000000-0000-5000-8000-000000000101";
export const DATA_RELEASE_V3_CHASE_COLLECTIBLE_ID =
  "00000000-0000-5000-8000-000000000201";
export const DATA_RELEASE_V3_PRIMARY_REPACK_ID =
  "00000000-0000-5000-8000-000000000301";
export const DATA_RELEASE_V3_SECONDARY_REPACK_ID =
  "00000000-0000-5000-8000-000000000302";
export const DATA_RELEASE_V3_UNAVAILABLE_REPACK_ID =
  "00000000-0000-5000-8000-000000000303";
export const DATA_RELEASE_V3_UNKNOWN_REPACK_ID =
  "00000000-0000-5000-8000-000000000304";

function usd(minorUnits: number) {
  return { minorUnits, currency: "USD" as const };
}

function halfUpReturnBasisPoints(
  grossMinorUnits: number,
  packPriceMinorUnits: number,
): number {
  return Number(
    (BigInt(grossMinorUnits) * 10_000n * 2n + BigInt(packPriceMinorUnits)) /
      (BigInt(packPriceMinorUnits) * 2n),
  );
}

export function buildPackScoutPublicEvMetricsV3(
  grossMinorUnits: number,
  packPriceMinorUnits: number = DATA_RELEASE_V3_PACK_PRICE_MINOR_UNITS,
) {
  const grossReturnBasisPoints = halfUpReturnBasisPoints(
    grossMinorUnits,
    packPriceMinorUnits,
  );
  return {
    grossEvMoney: usd(grossMinorUnits),
    grossReturnBasisPoints,
    evDollars: {
      minorUnits: grossMinorUnits - packPriceMinorUnits,
      currency: "USD" as const,
    },
    evPercentBasisPoints: grossReturnBasisPoints - 10_000,
  };
}

const confidencePenaltyByLimitation: Readonly<
  Record<PackScoutBuybackEvConfidenceLimitationCodeV1, number>
> = Object.freeze({
  closed_range_midpoint:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.closedRangeMidpoint,
  platform_published_odds:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.platformPublishedOdds,
  source_age_over_15_through_30_minutes:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.sourceAgeOver15Through30Minutes,
  source_age_over_30_through_60_minutes:
    PACKSCOUT_BUYBACK_EV_CONFIDENCE_PENALTIES_V1.sourceAgeOver30Through60Minutes,
});

export function buildPackScoutPublicEvConfidenceV3(
  limitationCodes: readonly PackScoutBuybackEvConfidenceLimitationCodeV1[] = [],
) {
  const scoreBasisPoints = Math.max(
    0,
    10_000 -
      limitationCodes.reduce(
        (total, code) => total + confidencePenaltyByLimitation[code],
        0,
      ),
  );
  return {
    policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    scoreBasisPoints,
    band:
      scoreBasisPoints <= 4_999
        ? ("low" as const)
        : scoreBasisPoints <= 7_999
          ? ("medium" as const)
          : ("high" as const),
    limitationCodes: [...limitationCodes],
  };
}

export function buildPackScoutPublicEvCurrentV3(
  grossMinorUnits: number,
): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "current",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildPackScoutPublicEvMetricsV3(grossMinorUnits),
    confidence: buildPackScoutPublicEvConfidenceV3(),
    calculatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: DATA_RELEASE_V3_OBSERVED_AT },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    expiresAt: DATA_RELEASE_V3_EXPIRES_AT,
  });
}

/** Gross EV $100 on a $100 pack: signed EV is exactly $0 and 0%. */
export function buildPackScoutPublicEvNeutralV3(): PackScoutPublicEvV3 {
  return buildPackScoutPublicEvCurrentV3(10_000);
}

/** The golden $100/85% example: $85 gross, 85%, -$15 EV, -15%. */
export function buildPackScoutPublicEvNegativeV3(): PackScoutPublicEvV3 {
  return buildPackScoutPublicEvCurrentV3(8_500);
}

/** Valid zero Gross EV: $0 gross is an available estimate, not unavailable. */
export function buildPackScoutPublicEvZeroV3(): PackScoutPublicEvV3 {
  return buildPackScoutPublicEvCurrentV3(0);
}

/** A delayed current estimate: 20-minute-old evidence with its penalty. */
export function buildPackScoutPublicEvDelayedV3(): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "current",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildPackScoutPublicEvMetricsV3(8_500),
    confidence: buildPackScoutPublicEvConfidenceV3([
      "source_age_over_15_through_30_minutes",
    ]),
    calculatedAt: "2026-08-19T18:20:00.000Z",
    dataAsOf: { state: "known", observedAt: DATA_RELEASE_V3_OBSERVED_AT },
    sourceAge: {
      milliseconds: 20 * 60_000,
      state: "delayed_over_15_through_30_minutes",
    },
    expiresAt: DATA_RELEASE_V3_EXPIRES_AT,
  });
}

export function buildPackScoutPublicEvUnavailableV3(
  reason: PackScoutBuybackEvPublicReasonCodeV1 = "BUYBACK_UNAVAILABLE",
): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: DATA_RELEASE_V3_OBSERVED_AT },
    reason,
  });
}

/** Evidence one millisecond past the deadline: unavailable, never zero. */
export function buildPackScoutPublicEvExpiredV3(): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: "2026-08-19T19:00:00.001Z",
    dataAsOf: { state: "known", observedAt: DATA_RELEASE_V3_OBSERVED_AT },
    reason: "SOURCE_DATA_STALE",
  });
}

/** No usable source observation time: an explicit unknown-time state. */
export function buildPackScoutPublicEvUnknownTimeV3(): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    dataAsOf: { state: "unknown_source_time", observedAt: null },
    reason: "SOURCE_EVIDENCE_UNAVAILABLE",
  });
}

/** The last estimate that was current at sellout, frozen and labeled. */
export function buildPackScoutPublicEvSoldOutHistoricalV3(): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "sold_out_historical",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildPackScoutPublicEvMetricsV3(8_500),
    confidence: buildPackScoutPublicEvConfidenceV3(),
    calculatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: DATA_RELEASE_V3_OBSERVED_AT },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    soldOutAt: DATA_RELEASE_V3_SOLD_OUT_AT,
    expiresAt: null,
  });
}

export function buildVendorReportedEvAvailableV3(): VendorReportedEvV3 {
  return vendorReportedEvV3Schema.parse({
    status: "available",
    sourceMoney: { minorUnits: 8_500, currency: "USD" },
    usdComparison: { status: "available", value: usd(8_500) },
    observedAt: DATA_RELEASE_V3_OBSERVED_AT,
  });
}

export function buildVendorReportedEvUnavailableV3(): VendorReportedEvV3 {
  return vendorReportedEvV3Schema.parse({
    status: "unavailable",
    sourceMoney: null,
    usdComparison: null,
    observedAt: null,
    reason: "NOT_REPORTED",
  });
}

export function buildPublicBuybackSummaryV3(
  kind: PublicBuybackSummaryV3["kind"] = "uniform_rate",
): PublicBuybackSummaryV3 {
  return publicBuybackSummaryV3Schema.parse(
    kind === "uniform_rate" ? { kind, rateBasisPoints: 8_500 } : { kind },
  );
}

export function buildPublicEvEstimatesV3(
  overrides: Partial<PublicEvEstimatesV3> = {},
): PublicEvEstimatesV3 {
  return publicEvEstimatesV3Schema.parse({
    packScout: buildPackScoutPublicEvNegativeV3(),
    vendorReported: buildVendorReportedEvAvailableV3(),
    ...overrides,
  });
}

const chaseCollectibleDisplay = {
  publicCollectibleId: DATA_RELEASE_V3_CHASE_COLLECTIBLE_ID,
  name: "Charizard ex #199",
  collectibleType: "card" as const,
  publicCategoryIds: [DATA_RELEASE_V3_CARDS_CATEGORY_ID],
  primaryImage: {
    url: "https://assets.vendor.example/collectibles/charizard.webp",
    alt: "Charizard ex card",
  },
  valuation: {
    displayMoney: usd(85_000),
    usdComparison: { status: "available" as const, value: usd(85_000) },
    valuationType: "market_estimate" as const,
    observedAt: DATA_RELEASE_V3_OBSERVED_AT,
  },
};

export function buildPublicRepackChaseV3(
  publicRepackId: string = DATA_RELEASE_V3_PRIMARY_REPACK_ID,
) {
  return {
    publicRepackId,
    publicCollectibleId: DATA_RELEASE_V3_CHASE_COLLECTIBLE_ID,
    role: "top_chase" as const,
    evidenceKinds: ["vendor_inventory" as const, "vendor_odds" as const],
    probabilityBasisPoints: 50,
    collectible: chaseCollectibleDisplay,
    matchConfidence: { scoreBasisPoints: 9_500, band: "high" as const },
    observedAt: DATA_RELEASE_V3_OBSERVED_AT,
    displayOrder: 0,
  };
}

export function buildPublicRepackDetailV3(
  overrides: Partial<PublicRepackDetailV3> = {},
): PublicRepackDetailV3 {
  const publicRepackId =
    overrides.publicRepackId ?? DATA_RELEASE_V3_PRIMARY_REPACK_ID;
  return publicRepackDetailV3Schema.parse({
    publicRepackId,
    publicVendorId: DATA_RELEASE_V3_VENDOR_ID,
    vendorKey: "collector_example",
    vendorDisplayName: "Collector Example",
    vendorLogoUrl: "https://assets.vendor.example/logo.webp",
    name: "Pokémon Grail Gacha",
    format: "gacha",
    contentMode: "focused",
    categories: [
      { publicCategoryId: DATA_RELEASE_V3_CARDS_CATEGORY_ID, label: "Cards" },
    ],
    collectibleTypes: ["card"],
    availability: "available",
    price: {
      displayMoney: usd(DATA_RELEASE_V3_PACK_PRICE_MINOR_UNITS),
      usdComparison: {
        status: "available",
        value: usd(DATA_RELEASE_V3_PACK_PRICE_MINOR_UNITS),
      },
    },
    buyback: buildPublicBuybackSummaryV3(),
    primaryImage: {
      url: "https://assets.vendor.example/repacks/pokemon.webp",
      alt: "Pokémon Grail Gacha",
    },
    evEstimates: buildPublicEvEstimatesV3(),
    topChase: buildPublicRepackChaseV3(publicRepackId),
    contentSummary: {
      knownCollectibleCount: 1,
      chaseCount: 1,
      categoryCount: 1,
      collectibleTypeCount: 1,
      evidenceCompleteness: "complete",
      probabilityCoverageBasisPoints: 10_000,
    },
    actionAvailability: { promo: true, repackLink: true },
    sourceUpdatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    description: "A focused Pokémon gacha.",
    actions: {
      promo: { code: "SCOUT", label: "Use SCOUT" },
      repackLink: {
        listingUrl: "https://vendor.example/repacks/pokemon",
        listingHost: "vendor.example",
        referralParameters: [{ name: "utm_source", value: "packscout" }],
      },
    },
    ...overrides,
  });
}

/** A sold-out repack with the frozen historical estimate and no action. */
export function buildSoldOutPublicRepackDetailV3(
  overrides: Partial<PublicRepackDetailV3> = {},
): PublicRepackDetailV3 {
  return buildPublicRepackDetailV3({
    availability: "sold_out",
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvSoldOutHistoricalV3(),
    }),
    actionAvailability: { promo: true, repackLink: false },
    actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    ...overrides,
  });
}

/**
 * A discoverable pack outside both `available` and `sold_out`.
 *
 * It deliberately keeps the default current PackScout estimate:
 * pack availability and PackScout EV availability are independent axes, so
 * this is a legal projection that must still never rank or carry an outbound
 * purchase link.
 */
export function buildNonPurchasablePublicRepackDetailV3(
  availability: Exclude<PublicPackAvailability, "available" | "sold_out">,
  overrides: Partial<PublicRepackDetailV3> = {},
): PublicRepackDetailV3 {
  return buildPublicRepackDetailV3({
    availability,
    actionAvailability: { promo: true, repackLink: false },
    actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    ...overrides,
  });
}

export function buildPublicRepackViewDetailV3(
  overrides: Partial<PublicRepackDetailV3> = {},
  options: Readonly<{
    confidenceEvaluatedAt?: string;
    providerHealth?: PublicProviderHealthV1;
  }> = {},
): PublicRepackViewDetailV3 {
  const detail = buildPublicRepackDetailV3(overrides);
  const confidenceEvaluatedAt =
    options.confidenceEvaluatedAt ??
    (detail.evEstimates.packScout.status === "sold_out_historical"
      ? detail.evEstimates.packScout.soldOutAt
      : detail.evEstimates.packScout.calculatedAt);
  const presented = safePresentPackScoutPublicEvV3(
    detail.evEstimates.packScout,
    confidenceEvaluatedAt,
  );
  if (!presented.success) {
    throw new Error(`fixture EV presentation failed: ${presented.reason}`);
  }
  return publicRepackViewDetailV3Schema.parse({
    ...detail,
    heat: unavailableRepackHeat(),
    packScoutEvPresentation: presented.presentation,
    providerHealth:
      options.providerHealth ?? buildHealthyPublicProviderHealthV1(),
  });
}

export function buildHealthyPublicProviderHealthV1(): PublicProviderHealthV1 {
  return {
    state: "healthy",
    observedAt: DATA_RELEASE_V3_OBSERVED_AT,
    rankingEligible: true,
    rankingIneligibilityReason: null,
  };
}

export function buildHealthyPublicProviderHealthSummaryV1(): PublicProviderHealthSummaryV1 {
  return {
    state: "healthy",
    observedAt: DATA_RELEASE_V3_OBSERVED_AT,
    freshThrough: DATA_RELEASE_V3_EXPIRES_AT,
    totalProviderCount: 1,
    delayedProviderCount: 0,
    nextHealthEvaluationAt: DATA_RELEASE_V3_EXPIRES_AT,
  };
}

export function buildPublicShellStatusV3(): PublicShellStatusV3 {
  return {
    release: buildDataReleaseV3Identity(),
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
    confidenceEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    providerHealthEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    providerHealthSummary: buildHealthyPublicProviderHealthSummaryV1(),
  };
}

export function buildDataReleaseV3Identity(): DataReleaseV3Identity {
  return dataReleaseV3IdentitySchema.parse({
    schemaVersion: "data_release_v3",
    publicReleaseId: "20000000-0000-4000-8000-000000000003",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
    dataAsOf: DATA_RELEASE_V3_OBSERVED_AT,
    completedAt: "2026-08-19T18:05:00.000Z",
  });
}

/** Two available nonpositive-EV repacks ranked by signed EV dollars descending. */
export function buildPublicDashboardBundleV3(): PublicDashboardBundleV3 {
  const primary = buildPublicRepackViewDetailV3();
  const secondary = buildPublicRepackViewDetailV3({
    publicRepackId: DATA_RELEASE_V3_SECONDARY_REPACK_ID,
    name: "Pokémon Value Gacha",
    evEstimates: buildPublicEvEstimatesV3({
      packScout: buildPackScoutPublicEvCurrentV3(9_500),
    }),
  });
  return publicDashboardBundleV3Schema.parse({
    release: buildDataReleaseV3Identity(),
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
    confidenceEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    providerHealthEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    providerHealthSummary: buildHealthyPublicProviderHealthSummaryV1(),
    opportunityEligibility: {
      rankingEligibleRepackCount: 2,
      providerIneligibleRepackCount: 0,
    },
    opportunities: [
      publicRepackViewSummaryV3FromDetail(secondary),
      publicRepackViewSummaryV3FromDetail(primary),
    ],
    details: [secondary, primary],
    selectedRepack: secondary,
  });
}

export function buildPublicRepackListPageV3(): PublicRepackListPageV3 {
  const primary = buildPublicRepackViewDetailV3(
    {},
    { confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT },
  );
  const soldOut = buildPublicRepackViewDetailV3(
    buildSoldOutPublicRepackDetailV3({
      publicRepackId: DATA_RELEASE_V3_SECONDARY_REPACK_ID,
      name: "Pokémon Vault Repack",
    }),
  );
  return publicRepackListPageV3Schema.parse({
    release: buildDataReleaseV3Identity(),
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
    confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT,
    providerHealthEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT,
    providerHealthSummary: buildHealthyPublicProviderHealthSummaryV1(),
    rows: [
      publicRepackViewSummaryV3FromDetail(primary),
      publicRepackViewSummaryV3FromDetail(soldOut),
    ],
    details: [primary, soldOut],
    selectedRepack: primary,
    selectedRepackEligible: true,
    desiredCollectible: null,
    desiredChaseMatches: [],
  });
}

/**
 * One list page carrying every public pack availability state. All four
 * states stay discoverable as rows; only the `available` row is purchasable,
 * so it is the only legal selection for a purchase-oriented flow.
 */
export function buildAllAvailabilityStatesPublicRepackListPageV3(): PublicRepackListPageV3 {
  const available = buildPublicRepackViewDetailV3(
    {},
    { confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT },
  );
  const soldOut = buildPublicRepackViewDetailV3(
    buildSoldOutPublicRepackDetailV3({
      publicRepackId: DATA_RELEASE_V3_SECONDARY_REPACK_ID,
      name: "Pokémon Vault Repack",
    }),
  );
  const unavailable = buildPublicRepackViewDetailV3(
    buildNonPurchasablePublicRepackDetailV3("unavailable", {
      publicRepackId: DATA_RELEASE_V3_UNAVAILABLE_REPACK_ID,
      name: "Pokémon Withdrawn Gacha",
    }),
    { confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT },
  );
  const unknown = buildPublicRepackViewDetailV3(
    buildNonPurchasablePublicRepackDetailV3("unknown", {
      publicRepackId: DATA_RELEASE_V3_UNKNOWN_REPACK_ID,
      name: "Pokémon Unverified Gacha",
    }),
    { confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT },
  );
  const details = [available, soldOut, unavailable, unknown];
  return publicRepackListPageV3Schema.parse({
    release: buildDataReleaseV3Identity(),
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
    confidenceEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT,
    providerHealthEvaluatedAt: DATA_RELEASE_V3_SOLD_OUT_AT,
    providerHealthSummary: buildHealthyPublicProviderHealthSummaryV1(),
    rows: details.map(publicRepackViewSummaryV3FromDetail),
    details,
    selectedRepack: available,
    selectedRepackEligible: true,
    desiredCollectible: null,
    desiredChaseMatches: [],
  });
}

export function buildDesiredCollectibleRepackResultsV3(): DesiredCollectibleRepackResultsV3 {
  const primary = buildPublicRepackViewDetailV3();
  return desiredCollectibleRepackResultsV3Schema.parse({
    release: buildDataReleaseV3Identity(),
    publicFreshnessPolicyVersion:
      PACKSCOUT_PUBLIC_EV_CONFIDENCE_DECAY_POLICY_VERSION_V1,
    confidenceEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    providerHealthEvaluatedAt: DATA_RELEASE_V3_OBSERVED_AT,
    desiredCollectible: chaseCollectibleDisplay,
    matches: [
      {
        repack: publicRepackViewSummaryV3FromDetail(primary),
        chase: buildPublicRepackChaseV3(),
      },
    ],
    total: 1,
  });
}
