import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  publicRepackViewDetailV3Schema,
  publicRepackViewSummaryV3FromDetail,
  packScoutPublicEvV3Schema,
  presentLastKnownPackScoutEvV3,
  type PackScoutDisplayedEvV3,
  unavailableRepackHeat,
  type PackScoutPublicEvV3,
  type PublicRepackChase,
  type PublicRepackViewDetailV3,
  type PublicRepackViewSummaryV3,
} from "@packscout/contracts";
import {
  parseListPublicRepacksV3Result,
  type ListPublicRepacksPageV3,
} from "./public-repacks-v3";

/**
 * Deterministic, contract-parsed data_release_v3 fixtures for frontend
 * tests. Every builder round-trips through the strict public schemas so a
 * fixture can never drift from what the release boundary may actually
 * serve.
 */

export const FIXTURE_OBSERVED_AT = "2026-08-19T10:00:00.000Z";
export const FIXTURE_EXPIRES_AT = "2026-08-19T11:00:00.000Z";
export const FIXTURE_SOLD_OUT_AT = "2026-08-19T10:05:00.000Z";
export const FIXTURE_PACK_PRICE_MINOR = 10_000;

export const FIXTURE_VENDOR_ID = "00000000-0000-5000-8000-000000000001";
export const FIXTURE_CATEGORY_ID = "00000000-0000-5000-8000-000000000101";
export const FIXTURE_COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000201";
export const FIXTURE_REPACK_ID = "00000000-0000-5000-8000-000000000301";
export const FIXTURE_RELEASE_ID = "00000000-0000-4000-8000-000000000401";

function usd(minorUnits: number) {
  return { minorUnits, currency: "USD" as const };
}

function halfUpReturnBasisPoints(gross: number, price: number): number {
  return Number(
    (BigInt(gross) * 10_000n * 2n + BigInt(price)) / (BigInt(price) * 2n),
  );
}

export function buildV3Metrics(
  gross: number,
  price = FIXTURE_PACK_PRICE_MINOR,
) {
  const grossReturnBasisPoints = halfUpReturnBasisPoints(gross, price);
  return {
    grossEvMoney: usd(gross),
    grossReturnBasisPoints,
    evDollars: { minorUnits: gross - price, currency: "USD" as const },
    evPercentBasisPoints: grossReturnBasisPoints - 10_000,
  };
}

const FRESH_CONFIDENCE = {
  policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  scoreBasisPoints: 10_000,
  band: "high" as const,
  limitationCodes: [],
};

export function buildV3CurrentEv(
  gross: number,
  options: Readonly<{ price?: number }> = {},
): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "current",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildV3Metrics(gross, options.price ?? FIXTURE_PACK_PRICE_MINOR),
    confidence: FRESH_CONFIDENCE,
    calculatedAt: FIXTURE_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: FIXTURE_OBSERVED_AT },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    expiresAt: FIXTURE_EXPIRES_AT,
  });
}

/**
 * A structurally valid current estimate whose public deadline is firmly in
 * the past relative to any real test clock — for proving that server
 * rendering keeps the served values and the post-hydration clock
 * ages confidence without removing those values.
 */
export function buildV3PastDeadlineCurrentEv(gross = 8_500): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "current",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildV3Metrics(gross),
    confidence: FRESH_CONFIDENCE,
    calculatedAt: "2026-08-18T10:00:00.000Z",
    dataAsOf: { state: "known", observedAt: "2026-08-18T10:00:00.000Z" },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    expiresAt: "2026-08-18T11:00:00.000Z",
  });
}

/** A current estimate whose evidence is 20 minutes old (delayed band). */
export function buildV3DelayedEv(gross: number): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "current",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildV3Metrics(gross),
    confidence: {
      policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      scoreBasisPoints: 9_000,
      band: "high",
      limitationCodes: ["source_age_over_15_through_30_minutes"],
    },
    calculatedAt: "2026-08-19T10:20:00.000Z",
    dataAsOf: { state: "known", observedAt: FIXTURE_OBSERVED_AT },
    sourceAge: {
      milliseconds: 20 * 60_000,
      state: "delayed_over_15_through_30_minutes",
    },
    expiresAt: FIXTURE_EXPIRES_AT,
  });
}

export function buildV3SoldOutEv(gross = 8_500): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "sold_out_historical",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildV3Metrics(gross),
    confidence: FRESH_CONFIDENCE,
    calculatedAt: FIXTURE_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: FIXTURE_OBSERVED_AT },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    soldOutAt: FIXTURE_SOLD_OUT_AT,
    expiresAt: null,
  });
}


/** A retained supported estimate evaluated at an explicit display clock. */
export function buildV3LastKnownEv(
  gross = 8_500,
  options: Readonly<{
    price?: number;
    referenceTimeIso?: string;
    latestUnavailableReason?: "BUYBACK_UNAVAILABLE" | "ODDS_UNAVAILABLE";
    soldOut?: boolean;
  }> = {},
): PackScoutDisplayedEvV3 {
  return presentLastKnownPackScoutEvV3({
    estimate: options.soldOut ? buildV3SoldOutEv(gross)
      : buildV3CurrentEv(gross, { price: options.price }),
    calculationPriceUsdMinor: options.price ?? FIXTURE_PACK_PRICE_MINOR,
    referenceTimeIso: options.referenceTimeIso ?? "2026-08-19T12:00:00.000Z",
    ...(options.latestUnavailableReason ? { latestUnavailableReason: options.latestUnavailableReason } : {}),
  });
}

export function buildV3UnavailableEv(
  reason:
    | "SOURCE_EVIDENCE_UNAVAILABLE"
    | "PRICE_UNAVAILABLE"
    | "CURRENCY_UNSUPPORTED"
    | "ODDS_UNAVAILABLE"
    | "VALUE_UNAVAILABLE"
    | "BUYBACK_UNAVAILABLE"
    | "CALCULATION_UNAVAILABLE" = "BUYBACK_UNAVAILABLE",
): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: FIXTURE_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: FIXTURE_OBSERVED_AT },
    reason,
  });
}

export function buildV3ExpiredEv(): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: "2026-08-19T11:10:00.000Z",
    dataAsOf: { state: "known", observedAt: FIXTURE_OBSERVED_AT },
    reason: "SOURCE_DATA_STALE",
  });
}

export function buildV3UnknownTimeUnavailableEv(): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: FIXTURE_OBSERVED_AT,
    dataAsOf: { state: "unknown_source_time", observedAt: null },
    reason: "SOURCE_EVIDENCE_UNAVAILABLE",
  });
}

export function buildV3Price(
  minorUnits: number | null = FIXTURE_PACK_PRICE_MINOR,
) {
  if (minorUnits === null) {
    return {
      displayMoney: null,
      usdComparison: {
        status: "unavailable" as const,
        value: null,
        reason: "PRICE_UNAVAILABLE" as const,
      },
    };
  }
  return {
    displayMoney: usd(minorUnits),
    usdComparison: { status: "available" as const, value: usd(minorUnits) },
  };
}

export function buildV3Chase(publicRepackId: string): PublicRepackChase {
  return {
    publicRepackId,
    publicCollectibleId: FIXTURE_COLLECTIBLE_ID,
    role: "top_chase",
    evidenceKinds: ["vendor_inventory", "vendor_odds"],
    probabilityBasisPoints: 50,
    collectible: {
      publicCollectibleId: FIXTURE_COLLECTIBLE_ID,
      name: "Charizard ex #199",
      collectibleType: "card",
      publicCategoryIds: [FIXTURE_CATEGORY_ID],
      primaryImage: {
        url: "https://assets.vendor.example/collectibles/charizard.webp",
        alt: "Charizard ex card",
      },
      valuation: {
        displayMoney: usd(85_000),
        usdComparison: { status: "available", value: usd(85_000) },
        valuationType: "market_estimate",
        observedAt: FIXTURE_OBSERVED_AT,
      },
    },
    matchConfidence: { scoreBasisPoints: 9_500, band: "high" },
    observedAt: FIXTURE_OBSERVED_AT,
    displayOrder: 0,
  } as PublicRepackChase;
}

type DetailOverrides = Partial<PublicRepackViewDetailV3>;

export function buildV3ViewDetail(
  overrides: DetailOverrides = {},
): PublicRepackViewDetailV3 {
  const publicRepackId = overrides.publicRepackId ?? FIXTURE_REPACK_ID;
  return publicRepackViewDetailV3Schema.parse({
    publicRepackId,
    publicVendorId: FIXTURE_VENDOR_ID,
    vendorKey: "collector_example",
    vendorDisplayName: "Collector Example",
    vendorLogoUrl: "https://assets.vendor.example/logo.webp",
    name: "Pokemon Grail Gacha",
    format: "gacha",
    contentMode: "focused",
    categories: [{ publicCategoryId: FIXTURE_CATEGORY_ID, label: "Cards" }],
    collectibleTypes: ["card"],
    availability: "available",
    price: buildV3Price(),
    buyback: { kind: "uniform_rate", rateBasisPoints: 8_500 },
    primaryImage: {
      url: "https://assets.vendor.example/repacks/pokemon.webp",
      alt: "Pokemon Grail Gacha",
    },
    evEstimates: {
      packScout: buildV3CurrentEv(8_500),
      vendorReported: {
        status: "available",
        sourceMoney: { minorUnits: 9_000, currency: "USD" },
        usdComparison: { status: "available", value: usd(9_000) },
        observedAt: FIXTURE_OBSERVED_AT,
      },
    },
    topChase: buildV3Chase(publicRepackId),
    contentSummary: {
      knownCollectibleCount: 1,
      chaseCount: 1,
      categoryCount: 1,
      collectibleTypeCount: 1,
      evidenceCompleteness: "complete",
      probabilityCoverageBasisPoints: 10_000,
    },
    actionAvailability: { promo: true, repackLink: true },
    sourceUpdatedAt: FIXTURE_OBSERVED_AT,
    description: "A focused Pokemon gacha.",
    actions: {
      promo: { code: "SCOUT", label: "Use SCOUT" },
      repackLink: {
        listingUrl: "https://vendor.example/repacks/pokemon",
        listingHost: "vendor.example",
        referralParameters: [{ name: "utm_source", value: "packscout" }],
      },
    },
    heat: unavailableRepackHeat(),
    ...overrides,
  });
}

export function buildV3SoldOutViewDetail(
  overrides: DetailOverrides = {},
): PublicRepackViewDetailV3 {
  return buildV3ViewDetail({
    availability: "sold_out",
    evEstimates: {
      packScout: buildV3SoldOutEv(8_500),
      vendorReported: {
        status: "unavailable",
        sourceMoney: null,
        usdComparison: null,
        observedAt: null,
        reason: "NOT_REPORTED",
      },
    },
    actionAvailability: { promo: false, repackLink: false },
    actions: {},
    ...overrides,
  });
}

export function buildV3ViewSummary(
  overrides: DetailOverrides = {},
): PublicRepackViewSummaryV3 {
  return publicRepackViewSummaryV3FromDetail(buildV3ViewDetail(overrides));
}

export function buildV3ReleaseIdentity() {
  return {
    schemaVersion: "data_release_v3" as const,
    publicReleaseId: FIXTURE_RELEASE_ID,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
    dataAsOf: FIXTURE_OBSERVED_AT,
    completedAt: FIXTURE_OBSERVED_AT,
  };
}

/**
 * Builds a fully validated All Repacks page from view details by passing the
 * exact result envelope through the same fail-closed parser the data layer
 * uses in production.
 */
export function buildV3ListPage(
  details: readonly PublicRepackViewDetailV3[],
): ListPublicRepacksPageV3 {
  const payload = {
    ok: true,
    data: {
      release: buildV3ReleaseIdentity(),
      rows: details.map(publicRepackViewSummaryV3FromDetail),
      details,
      selectedRepack: details[0] ?? null,
      selectedRepackEligible: details.length > 0,
      desiredCollectible: null,
      desiredChaseMatches: [],
      facets: { vendors: [], categories: [], collectibleTypes: [] },
      activeQuery: {
        search: "",
        filters: {
          vendors: [],
          categories: [],
          collectibleTypes: [],
          availability: "all",
          price: { mode: "full", minMinor: 1_000, maxMinor: 1_200_000 },
        },
        sort: "packscout_ev_dollars",
        direction: "desc",
        pageSize: 25,
        desiredPublicCollectibleId: null,
      },
      queryFingerprint: "a".repeat(64),
      nextCursor: null,
      hasPrevious: false,
      range:
        details.length === 0
          ? { start: 0, end: 0, total: 0 }
          : { start: 1, end: details.length, total: details.length },
      paginationReset: null,
    },
  };
  const parsed = parseListPublicRepacksV3Result(payload);
  if (!parsed.ok) {
    throw new Error("buildV3ListPage produced an invalid page fixture");
  }
  return parsed.data;
}
