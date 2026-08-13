import {
  buildPublicCollectibleSearchText,
  parseDataReleaseManifestV2,
  type DataReleaseManifestV2,
  type PublicRepackChase,
} from "../data-release-v2.ts";

export const SYNTHETIC_VENDOR_ID =
  "00000000-0000-5000-8000-000000000001";
export const SYNTHETIC_CARDS_CATEGORY_ID =
  "00000000-0000-5000-8000-000000000101";
export const SYNTHETIC_POKEMON_CATEGORY_ID =
  "00000000-0000-5000-8000-000000000102";
export const SYNTHETIC_WATCHES_CATEGORY_ID =
  "00000000-0000-5000-8000-000000000103";
export const SYNTHETIC_CHARIZARD_ID =
  "00000000-0000-5000-8000-000000000201";
export const SYNTHETIC_ROLEX_ID =
  "00000000-0000-5000-8000-000000000202";
export const SYNTHETIC_FOCUSED_REPACK_ID =
  "00000000-0000-5000-8000-000000000301";
export const SYNTHETIC_MIXED_REPACK_ID =
  "00000000-0000-5000-8000-000000000302";

const observedAt = "2026-08-11T08:30:02Z";
const calculatedAt = "2026-08-11T08:31:00Z";

function usd(minorUnits: number) {
  return { minorUnits, currency: "USD" as const };
}

function valuation(minorUnits: number) {
  return {
    displayMoney: usd(minorUnits),
    usdComparison: { status: "available" as const, value: usd(minorUnits) },
    valuationType: "market_estimate" as const,
    observedAt,
  };
}

const charizardDisplay = {
  publicCollectibleId: SYNTHETIC_CHARIZARD_ID,
  name: "Charizard ex #199",
  collectibleType: "card" as const,
  publicCategoryIds: [
    SYNTHETIC_CARDS_CATEGORY_ID,
    SYNTHETIC_POKEMON_CATEGORY_ID,
  ],
  primaryImage: {
    url: "https://assets.vendor.example/collectibles/charizard.webp",
    alt: "Charizard ex card",
  },
  valuation: valuation(85_000),
};

const rolexDisplay = {
  publicCollectibleId: SYNTHETIC_ROLEX_ID,
  name: "Rolex Submariner 16610",
  collectibleType: "watch" as const,
  publicCategoryIds: [SYNTHETIC_WATCHES_CATEGORY_ID],
  primaryImage: {
    url: "https://assets.vendor.example/collectibles/rolex.webp",
    alt: "Rolex Submariner watch",
  },
  valuation: valuation(1_250_000),
};

const focusedTopChase: PublicRepackChase = {
  publicRepackId: SYNTHETIC_FOCUSED_REPACK_ID,
  publicCollectibleId: SYNTHETIC_CHARIZARD_ID,
  role: "top_chase",
  evidenceKinds: ["vendor_inventory", "vendor_odds"],
  probabilityBasisPoints: 50,
  collectible: charizardDisplay,
  matchConfidence: { scoreBasisPoints: 9_500, band: "high" },
  observedAt,
  displayOrder: 0,
};

const mixedCharizardChase: PublicRepackChase = {
  publicRepackId: SYNTHETIC_MIXED_REPACK_ID,
  publicCollectibleId: SYNTHETIC_CHARIZARD_ID,
  role: "possible_outcome",
  evidenceKinds: ["historical_pull_inference"],
  probabilityBasisPoints: null,
  collectible: charizardDisplay,
  matchConfidence: { scoreBasisPoints: 6_500, band: "medium" },
  observedAt,
  displayOrder: 1,
};

const mixedTopChase: PublicRepackChase = {
  publicRepackId: SYNTHETIC_MIXED_REPACK_ID,
  publicCollectibleId: SYNTHETIC_ROLEX_ID,
  role: "top_chase",
  evidenceKinds: ["vendor_featured_chase"],
  probabilityBasisPoints: 10,
  collectible: rolexDisplay,
  matchConfidence: { scoreBasisPoints: 8_800, band: "high" },
  observedAt,
  displayOrder: 0,
};

const vendorReportedAvailable = {
  status: "available" as const,
  displayMoney: usd(8_500),
  metrics: {
    grossEv: usd(8_500),
    grossReturnBasisPoints: 8_500,
    evDollars: { minorUnits: -1_500, currency: "USD" as const },
    evPercentBasisPoints: -1_500,
  },
  observedAt,
};

const packScoutAvailable = {
  status: "available" as const,
  metrics: {
    grossEv: usd(12_000),
    grossReturnBasisPoints: 12_000,
    evDollars: { minorUnits: 2_000, currency: "USD" as const },
    evPercentBasisPoints: 2_000,
  },
  confidence: {
    scoreBasisPoints: 7_000,
    band: "medium" as const,
    limitationCodes: ["partial_probability_coverage" as const],
  },
  modelVersion: "packscout-ev-v2",
  confidencePolicyVersion: "confidence-v1",
  dataAsOf: observedAt,
  calculatedAt,
};

const unavailableEstimates = {
  vendorReported: {
    status: "unavailable" as const,
    displayMoney: null,
    metrics: null,
    observedAt: null,
    reason: "NOT_REPORTED" as const,
  },
  packScout: {
    status: "unavailable" as const,
    metrics: null,
    confidence: null,
    modelVersion: "packscout-ev-v2",
    confidencePolicyVersion: "confidence-v1",
    dataAsOf: null,
    calculatedAt: null,
    reason: "ESTIMATE_INPUT_INCOMPLETE" as const,
  },
};

export function buildSyntheticDataReleaseV2(): DataReleaseManifestV2 {
  return parseDataReleaseManifestV2({
    metadata: {
      schemaVersion: "data_release_v2",
      dataSource: "canonical",
      publicReleaseId: "20000000-0000-4000-8000-000000000002",
      sourceWatermark: "aggregate.42",
      manifestFingerprint: "1".repeat(64),
      contentHash: "2".repeat(64),
      publicConfigRevision: 7,
      publicConfigHash: "3".repeat(64),
      originSetHash: "4".repeat(64),
      searchAlgorithmVersion: "repack_search_v2",
      repackSearchIndexHash: "5".repeat(64),
      confidencePolicyVersion: "confidence-v1",
      createdAt: "2026-08-11T08:30:00Z",
      completedAt: "2026-08-11T08:32:00Z",
      dataAsOf: observedAt,
      lastSuccessfulObservationAt: observedAt,
      staleAt: "2026-08-11T09:30:02Z",
      freshness: "fresh",
      delayedVendorCount: 0,
      vendorCount: 1,
      categoryCount: 3,
      repackCount: 2,
      collectibleCount: 2,
      repackChaseCount: 3,
    },
    publicAssetOrigins: ["https://assets.vendor.example"],
    vendors: [
      {
        publicVendorId: SYNTHETIC_VENDOR_ID,
        vendorKey: "collector_example",
        displayName: "Collector Example",
        logoUrl: "https://assets.vendor.example/logo.webp",
        websiteUrl: "https://vendor.example",
        listingHosts: ["vendor.example"],
        imageOrigins: ["https://assets.vendor.example"],
        referralParameters: [{ name: "utm_source", value: "packscout" }],
        publicPromo: { code: "SCOUT", label: "Use SCOUT" },
      },
    ],
    categories: [
      {
        publicCategoryId: SYNTHETIC_CARDS_CATEGORY_ID,
        parentPublicCategoryId: null,
        categoryKey: "cards",
        name: "Cards",
        kind: "vertical",
        depth: 0,
        pathPublicCategoryIds: [SYNTHETIC_CARDS_CATEGORY_ID],
        displayOrder: 0,
      },
      {
        publicCategoryId: SYNTHETIC_POKEMON_CATEGORY_ID,
        parentPublicCategoryId: SYNTHETIC_CARDS_CATEGORY_ID,
        categoryKey: "pokemon",
        name: "Pokémon",
        kind: "franchise",
        depth: 1,
        pathPublicCategoryIds: [
          SYNTHETIC_CARDS_CATEGORY_ID,
          SYNTHETIC_POKEMON_CATEGORY_ID,
        ],
        displayOrder: 1,
      },
      {
        publicCategoryId: SYNTHETIC_WATCHES_CATEGORY_ID,
        parentPublicCategoryId: null,
        categoryKey: "watches",
        name: "Watches",
        kind: "vertical",
        depth: 0,
        pathPublicCategoryIds: [SYNTHETIC_WATCHES_CATEGORY_ID],
        displayOrder: 2,
      },
    ],
    repacks: [
      {
        publicRepackId: SYNTHETIC_FOCUSED_REPACK_ID,
        publicVendorId: SYNTHETIC_VENDOR_ID,
        vendorKey: "collector_example",
        vendorDisplayName: "Collector Example",
        vendorLogoUrl: "https://assets.vendor.example/logo.webp",
        name: "Pokémon Grail Gacha",
        format: "gacha",
        contentMode: "focused",
        categories: [
          { publicCategoryId: SYNTHETIC_CARDS_CATEGORY_ID, label: "Cards" },
          {
            publicCategoryId: SYNTHETIC_POKEMON_CATEGORY_ID,
            label: "Pokémon",
          },
        ],
        collectibleTypes: ["card"],
        availability: "active",
        price: {
          displayMoney: usd(10_000),
          usdComparison: { status: "available", value: usd(10_000) },
        },
        buyback: {
          status: "available",
          value: { basisPoints: 8_500, sourceKind: "vendor_reported" },
        },
        primaryImage: {
          url: "https://assets.vendor.example/repacks/pokemon.webp",
          alt: "Pokémon Grail Gacha",
        },
        evEstimates: {
          vendorReported: vendorReportedAvailable,
          packScout: packScoutAvailable,
        },
        topChase: focusedTopChase,
        contentSummary: {
          knownCollectibleCount: 1,
          chaseCount: 1,
          categoryCount: 2,
          collectibleTypeCount: 1,
          evidenceCompleteness: "partial",
          probabilityCoverageBasisPoints: 7_500,
        },
        actionAvailability: { promo: true, repackLink: true },
        sourceUpdatedAt: observedAt,
        description: "A focused Pokémon gacha.",
        actions: {
          promo: { code: "SCOUT", label: "Use SCOUT" },
          repackLink: {
            listingUrl: "https://vendor.example/repacks/pokemon",
            listingHost: "vendor.example",
            referralParameters: [{ name: "utm_source", value: "packscout" }],
          },
        },
      },
      {
        publicRepackId: SYNTHETIC_MIXED_REPACK_ID,
        publicVendorId: SYNTHETIC_VENDOR_ID,
        vendorKey: "collector_example",
        vendorDisplayName: "Collector Example",
        vendorLogoUrl: "https://assets.vendor.example/logo.webp",
        name: "Cards and Watches Mystery Box",
        format: "repack",
        contentMode: "mixed",
        categories: [
          {
            publicCategoryId: SYNTHETIC_CARDS_CATEGORY_ID,
            label: "Cards",
          },
          {
            publicCategoryId: SYNTHETIC_POKEMON_CATEGORY_ID,
            label: "Pokémon",
          },
          {
            publicCategoryId: SYNTHETIC_WATCHES_CATEGORY_ID,
            label: "Watches",
          },
        ],
        collectibleTypes: ["card", "watch"],
        availability: "active",
        price: {
          displayMoney: usd(50_000),
          usdComparison: { status: "available", value: usd(50_000) },
        },
        buyback: {
          status: "unavailable",
          value: null,
          reason: "BUYBACK_UNAVAILABLE",
        },
        primaryImage: null,
        evEstimates: unavailableEstimates,
        topChase: mixedTopChase,
        contentSummary: {
          knownCollectibleCount: 2,
          chaseCount: 2,
          categoryCount: 3,
          collectibleTypeCount: 2,
          evidenceCompleteness: "unknown",
          probabilityCoverageBasisPoints: null,
        },
        actionAvailability: { promo: true, repackLink: true },
        sourceUpdatedAt: observedAt,
        description: "A mixed cards and watches repack.",
        actions: {
          promo: { code: "SCOUT", label: "Use SCOUT" },
          repackLink: {
            listingUrl: "https://vendor.example/repacks/mixed",
            listingHost: "vendor.example",
            referralParameters: [{ name: "utm_source", value: "packscout" }],
          },
        },
      },
    ],
    collectibles: [
      {
        ...charizardDisplay,
        normalizedName: "charizard ex 199",
        aliases: ["charizard 199", "sv151 charizard"],
        normalizedAliases: ["charizard 199", "sv151 charizard"],
        year: 2023,
        brand: "Pokémon",
        setOrSeries: "151",
        cardNumber: "199/165",
        referenceNumber: null,
        subject: "Charizard",
        grade: "10",
        grader: "PSA",
        searchText: buildPublicCollectibleSearchText({
          name: charizardDisplay.name,
          aliases: ["charizard 199", "sv151 charizard"],
          year: 2023,
          brand: "Pokémon",
          setOrSeries: "151",
          cardNumber: "199/165",
          referenceNumber: null,
          subject: "Charizard",
          grade: "10",
          grader: "PSA",
        }),
        dataAsOf: observedAt,
      },
      {
        ...rolexDisplay,
        normalizedName: "rolex submariner 16610",
        aliases: ["submariner 16610"],
        normalizedAliases: ["submariner 16610"],
        year: 2008,
        brand: "Rolex",
        setOrSeries: null,
        cardNumber: null,
        referenceNumber: "16610",
        subject: "Submariner",
        grade: null,
        grader: null,
        searchText: buildPublicCollectibleSearchText({
          name: rolexDisplay.name,
          aliases: ["submariner 16610"],
          year: 2008,
          brand: "Rolex",
          setOrSeries: null,
          cardNumber: null,
          referenceNumber: "16610",
          subject: "Submariner",
          grade: null,
          grader: null,
        }),
        dataAsOf: observedAt,
      },
    ],
    repackChases: [focusedTopChase, mixedTopChase, mixedCharizardChase],
  });
}
