import {
  parseCatalogSnapshotV1,
  publicPackSummarySchema,
  type CatalogSnapshotV1,
  type PublicPackDetail,
  type PublicPackSummary,
} from "../catalog-snapshot-v1.ts";

function available<T>(value: T) {
  return { status: "available" as const, value, reason: null, nullRank: 0 as const };
}

function unavailable<TReason extends string>(reason: TReason) {
  return {
    status: "unavailable" as const,
    value: null,
    reason,
    nullRank: 1 as const,
  };
}

const collectorConfig = {
  platformKey: "collector_crypt",
  revision: 2,
  contentHash: "1".repeat(64),
  displayName: "Collector Crypt",
  logoUrl: "https://assets.collector.example/logo.svg",
  listingHosts: ["collector.example"],
  imageOrigins: ["https://assets.collector.example"],
  referralParameters: [{ name: "ref", value: "packscout" }],
  publicPromo: { code: "SCOUT", label: "PackScout promo" },
} as const;

const courtyardConfig = {
  platformKey: "courtyard",
  revision: 4,
  contentHash: "2".repeat(64),
  displayName: "Courtyard",
  logoUrl: "https://assets.courtyard.example/logo.svg",
  listingHosts: ["courtyard.example"],
  imageOrigins: ["https://assets.courtyard.example"],
  referralParameters: [{ name: "utm_source", value: "packscout" }],
  publicPromo: null,
} as const;

const estimatedPack = {
  publicPackId: "00000000-0000-5000-8000-000000000001",
  platformKey: "collector_crypt",
  platformDisplayName: "Collector Crypt",
  platformLogoUrl: "https://assets.collector.example/logo.svg",
  category: "Pokemon",
  name: "Mythic Pokemon Gacha",
  availability: "active",
  price: {
    displayMoney: { minorUnits: 250_000, currency: "USD" },
    usdComparison: available({ minorUnits: 250_000, currency: "USD" as const }),
  },
  estimatedEv: {
    grossEv: available({ minorUnits: 268_455, currency: "USD" as const }),
    grossReturn: available({ basisPoints: 10_738 }),
    evDollars: available({ minorUnits: 18_455, currency: "USD" as const }),
    evPercent: available({ basisPoints: 738 }),
    calculatedAt: "2026-08-11T11:55:00Z",
    coverage: {
      evidenceCompleteness: "complete",
      probabilityCoverageBasisPoints: 10_000,
    },
    limitations: ["Estimated outcomes are not guaranteed."],
  },
  buyback: available({ basisPoints: 9_300, sourceKind: "direct" as const }),
  primaryImage: {
    url: "https://assets.collector.example/packs/mythic.webp",
    alt: "Mythic Pokemon Gacha pack",
  },
  topChase: available({
    publicChaseId: "10000000-0000-5000-8000-000000000001",
    name: "Celestial Nexus",
    displayMoney: { minorUnits: 8_500_000, currency: "USD" },
    usdComparison: available({ minorUnits: 8_500_000, currency: "USD" as const }),
    primaryImage: {
      url: "https://assets.collector.example/chases/celestial.webp",
      alt: "Celestial Nexus collectible",
    },
    evidenceKind: "canonical_asset_value" as const,
    observedAt: "2026-08-11T11:50:00Z",
  }),
  actionAvailability: { promo: true, packLink: true },
  sourceFirstSeenAt: "2026-08-01T12:00:00Z",
  sourceCollectedAt: "2026-08-11T11:50:00Z",
  description: "A Pokemon repack with one collectible outcome.",
  actions: {
    promo: { code: "SCOUT", label: "PackScout promo" },
    packLink: {
      listingUrl: "https://collector.example/packs/mythic?edition=launch",
      listingHost: "collector.example",
      referralParameters: [{ name: "ref", value: "packscout" }],
    },
  },
} as const;

const unavailableMissingImagePack = {
  publicPackId: "00000000-0000-5000-8000-000000000002",
  platformKey: "courtyard",
  platformDisplayName: "Courtyard",
  platformLogoUrl: "https://assets.courtyard.example/logo.svg",
  category: "Uncategorized",
  name: "Mystery Vault Pack",
  availability: "active",
  price: {
    displayMoney: { minorUnits: 10_000, currency: "USD" },
    usdComparison: available({ minorUnits: 10_000, currency: "USD" as const }),
  },
  estimatedEv: {
    grossEv: unavailable("ESTIMATE_INPUT_INCOMPLETE"),
    grossReturn: unavailable("ESTIMATE_INPUT_INCOMPLETE"),
    evDollars: unavailable("ESTIMATE_INPUT_INCOMPLETE"),
    evPercent: unavailable("ESTIMATE_INPUT_INCOMPLETE"),
    calculatedAt: null,
    coverage: {
      evidenceCompleteness: "unknown",
      probabilityCoverageBasisPoints: null,
    },
    limitations: ["Estimate inputs are incomplete."],
  },
  buyback: unavailable("BUYBACK_UNAVAILABLE"),
  primaryImage: null,
  topChase: unavailable("CHASE_UNAVAILABLE"),
  actionAvailability: { promo: false, packLink: true },
  sourceFirstSeenAt: "2026-08-02T12:00:00Z",
  sourceCollectedAt: "2026-08-11T11:51:00Z",
  description: null,
  actions: {
    packLink: {
      listingUrl: "https://courtyard.example/packs/mystery",
      listingHost: "courtyard.example",
      referralParameters: [{ name: "utm_source", value: "packscout" }],
    },
  },
} as const;

const soldOutPack = {
  publicPackId: "00000000-0000-5000-8000-000000000003",
  platformKey: "courtyard",
  platformDisplayName: "Courtyard",
  platformLogoUrl: "https://assets.courtyard.example/logo.svg",
  category: "Pokemon",
  name: "Pokemon Master Pack",
  availability: "sold_out",
  price: {
    displayMoney: { minorUnits: 8_900, currency: "USD" },
    usdComparison: available({ minorUnits: 8_900, currency: "USD" as const }),
  },
  estimatedEv: {
    grossEv: available({ minorUnits: 8_953, currency: "USD" as const }),
    grossReturn: available({ basisPoints: 10_060 }),
    evDollars: available({ minorUnits: 53, currency: "USD" as const }),
    evPercent: available({ basisPoints: 60 }),
    calculatedAt: "2026-08-11T11:55:00Z",
    coverage: {
      evidenceCompleteness: "partial",
      probabilityCoverageBasisPoints: 9_800,
    },
    limitations: ["Estimate coverage is partial."],
  },
  buyback: available({ basisPoints: 7_800, sourceKind: "derived" as const }),
  primaryImage: {
    url: "https://assets.courtyard.example/packs/master.webp",
    alt: "Pokemon Master Pack",
  },
  topChase: available({
    publicChaseId: "10000000-0000-5000-8000-000000000003",
    name: "Rare Vault Card",
    displayMoney: { minorUnits: 50_000, currency: "USDC" },
    usdComparison: unavailable("CURRENCY_UNSUPPORTED"),
    primaryImage: null,
    evidenceKind: "canonical_asset_identity" as const,
    observedAt: "2026-08-11T11:45:00Z",
  }),
  actionAvailability: { promo: false, packLink: false },
  sourceFirstSeenAt: "2026-08-03T12:00:00Z",
  sourceCollectedAt: "2026-08-11T11:52:00Z",
  description: "A sold-out Pokemon pack retained for comparison.",
  actions: {},
} as const;

export function buildSyntheticCatalogSnapshotV1(): CatalogSnapshotV1 {
  return parseCatalogSnapshotV1({
    metadata: {
      schemaVersion: "catalog_snapshot_v1",
      publicationId: "20000000-0000-4000-8000-000000000001",
      sourceWatermark: "catalog.42-pulls.17-trades.9",
      manifestFingerprint: "4".repeat(64),
      contentHash: "5".repeat(64),
      publicConfigRevision: 6,
      publicConfigHash: "6".repeat(64),
      originSetHash: "7".repeat(64),
      createdAt: "2026-08-11T11:57:00Z",
      completedAt: "2026-08-11T11:58:00Z",
      dataAsOf: "2026-08-11T11:52:00Z",
      lastSuccessfulObservationAt: "2026-08-11T12:00:00Z",
      staleAt: "2026-08-11T12:15:00Z",
      freshness: "fresh",
      delayedSourceCount: 0,
      platformConfigCount: 2,
      packCount: 3,
      searchAlgorithmVersion: "packscout_relevance_v1",
    },
    platformConfigs: [collectorConfig, courtyardConfig],
    packs: [estimatedPack, unavailableMissingImagePack, soldOutPack],
    facets: {
      platforms: [
        { key: "collector_crypt", label: "Collector Crypt", packCount: 1 },
        { key: "courtyard", label: "Courtyard", packCount: 2 },
      ],
      categories: [
        { key: "pokemon", label: "Pokemon", packCount: 2 },
        { key: "uncategorized", label: "Uncategorized", packCount: 1 },
      ],
    },
  });
}

export function publicPackSummaryFromDetail(
  pack: PublicPackDetail,
): PublicPackSummary {
  const { topChase } = pack;
  const summaryTopChase =
    topChase.status === "unavailable"
      ? topChase
      : {
          ...topChase,
          value: {
            publicChaseId: topChase.value.publicChaseId,
            name: topChase.value.name,
            displayMoney: topChase.value.displayMoney,
            usdComparison: topChase.value.usdComparison,
            primaryImage: topChase.value.primaryImage,
          },
        };
  return publicPackSummarySchema.parse({
    publicPackId: pack.publicPackId,
    platformKey: pack.platformKey,
    platformDisplayName: pack.platformDisplayName,
    platformLogoUrl: pack.platformLogoUrl,
    category: pack.category,
    name: pack.name,
    availability: pack.availability,
    price: pack.price,
    estimatedEv: {
      grossEv: pack.estimatedEv.grossEv,
      grossReturn: pack.estimatedEv.grossReturn,
      evDollars: pack.estimatedEv.evDollars,
      evPercent: pack.estimatedEv.evPercent,
      calculatedAt: pack.estimatedEv.calculatedAt,
    },
    buyback: pack.buyback,
    primaryImage: pack.primaryImage,
    topChase: summaryTopChase,
    actionAvailability: pack.actionAvailability,
    sourceFirstSeenAt: pack.sourceFirstSeenAt,
    sourceCollectedAt: pack.sourceCollectedAt,
  });
}
