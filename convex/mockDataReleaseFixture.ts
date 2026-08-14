import {
  DATA_RELEASE_SCHEMA_VERSION,
  REPACK_SEARCH_VERSION,
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  parseDataReleaseManifestV2,
  type DataReleaseManifestV2,
  type PackScoutEv,
  type PublicCategory,
  type PublicCollectible,
  type PublicCollectibleDisplay,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
  type VendorReportedEv,
} from "@packscout/contracts";

export const MOCK_DATA_RELEASE_FIXTURE_VERSION =
  "packscout_mock_data_release_v2" as const;
export const MOCK_DATA_RELEASE_PUBLIC_ID =
  "90000000-0000-4000-8000-000000000002" as const;
export const MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION =
  "packscout_mock_confidence_v1" as const;
export const MOCK_DATA_RELEASE_SEED_IDEMPOTENCY_KEY =
  "packscout-mock-data-release-v2" as const;
export const MOCK_DATA_RELEASE_SEED_OPERATION_ID =
  "packscout-mock-data-release-seed-v2" as const;

export const MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH =
  "e19e2372aab40a66a23eb6b65dc8da3acd3f24c2b13322b4d4f23b2e9a9bff48" as const;
export const MOCK_DATA_RELEASE_ORIGIN_SET_HASH =
  "5f1fb126e865e933af8ce480ffd76c1ecdd7427ddb13681bebe69eb51474c902" as const;
export const MOCK_DATA_RELEASE_MANIFEST_FINGERPRINT =
  "6dfc22527c62382443911af48654cab7fd3b860b929c1a46b4fa26342dab3a1b" as const;
export const MOCK_DATA_RELEASE_CONTENT_HASH =
  "11db838a03262821f115f07a1f2986feface45494da1b72d5de489f6266bfd72" as const;
export const MOCK_REPACK_SEARCH_SHARD_HASH =
  "baef9cc7ca84d532dc3b1ebf38a373fb0a3b03536e8d8efa8bc4fec540bc4622" as const;
export const MOCK_REPACK_SEARCH_INDEX_HASH =
  "f3e3fb9409d04b862c6fd04422e6e03e3bbab5caa74c5ec66bcc8dc88935ceb5" as const;

const observedAt = "2026-08-11T12:00:00Z";
const calculatedAt = "2026-08-11T12:01:00Z";

const vendorIds = {
  collectorCrypt: "10000000-0000-5000-8000-000000000001",
  courtyard: "10000000-0000-5000-8000-000000000002",
} as const;

const categoryIds = {
  tradingCards: "20000000-0000-5000-8000-000000000001",
  pokemon: "20000000-0000-5000-8000-000000000002",
  sports: "20000000-0000-5000-8000-000000000003",
  basketball: "20000000-0000-5000-8000-000000000004",
  watches: "20000000-0000-5000-8000-000000000005",
  nba: "20000000-0000-5000-8000-000000000006",
} as const;

const collectibleIds = {
  charizard: "30000000-0000-5000-8000-000000000001",
  umbreon: "30000000-0000-5000-8000-000000000002",
  lebron: "30000000-0000-5000-8000-000000000003",
  rolex: "30000000-0000-5000-8000-000000000004",
  pikachu: "30000000-0000-5000-8000-000000000005",
  jordan: "30000000-0000-5000-8000-000000000006",
} as const;

const repackIds = {
  mythicPokemon: "40000000-0000-5000-8000-000000000001",
  pokemonMaster: "40000000-0000-5000-8000-000000000002",
  legendsMixed: "40000000-0000-5000-8000-000000000003",
  hallOfFame: "40000000-0000-5000-8000-000000000004",
  vintagePokemon: "40000000-0000-5000-8000-000000000005",
  soldOutSports: "40000000-0000-5000-8000-000000000006",
} as const;

const vendors: readonly PublicVendor[] = [
  {
    publicVendorId: vendorIds.collectorCrypt,
    vendorKey: "collector_crypt",
    displayName: "Collector Crypt",
    logoUrl: null,
    websiteUrl: "https://collector.example",
    listingHosts: ["collector.example"],
    imageOrigins: [],
    referralParameters: [{ name: "ref", value: "packscout" }],
    publicPromo: { code: "SCOUT", label: "PackScout promo" },
  },
  {
    publicVendorId: vendorIds.courtyard,
    vendorKey: "courtyard",
    displayName: "Courtyard",
    logoUrl: null,
    websiteUrl: "https://courtyard.example",
    listingHosts: ["courtyard.example"],
    imageOrigins: [],
    referralParameters: [{ name: "utm_source", value: "packscout" }],
    publicPromo: null,
  },
];

const categories: readonly PublicCategory[] = [
  {
    publicCategoryId: categoryIds.tradingCards,
    parentPublicCategoryId: null,
    categoryKey: "trading_cards",
    name: "Trading Cards",
    kind: "vertical",
    depth: 0,
    pathPublicCategoryIds: [categoryIds.tradingCards],
    displayOrder: 10,
  },
  {
    publicCategoryId: categoryIds.pokemon,
    parentPublicCategoryId: categoryIds.tradingCards,
    categoryKey: "pokemon",
    name: "Pokemon",
    kind: "franchise",
    depth: 1,
    pathPublicCategoryIds: [categoryIds.tradingCards, categoryIds.pokemon],
    displayOrder: 20,
  },
  {
    publicCategoryId: categoryIds.sports,
    parentPublicCategoryId: categoryIds.tradingCards,
    categoryKey: "sports",
    name: "Sports",
    kind: "other",
    depth: 1,
    pathPublicCategoryIds: [categoryIds.tradingCards, categoryIds.sports],
    displayOrder: 30,
  },
  {
    publicCategoryId: categoryIds.basketball,
    parentPublicCategoryId: categoryIds.sports,
    categoryKey: "basketball",
    name: "Basketball",
    kind: "sport",
    depth: 2,
    pathPublicCategoryIds: [
      categoryIds.tradingCards,
      categoryIds.sports,
      categoryIds.basketball,
    ],
    displayOrder: 40,
  },
  {
    publicCategoryId: categoryIds.watches,
    parentPublicCategoryId: null,
    categoryKey: "watches",
    name: "Watches",
    kind: "vertical",
    depth: 0,
    pathPublicCategoryIds: [categoryIds.watches],
    displayOrder: 50,
  },
  {
    publicCategoryId: categoryIds.nba,
    parentPublicCategoryId: categoryIds.basketball,
    categoryKey: "nba",
    name: "NBA",
    kind: "league",
    depth: 3,
    pathPublicCategoryIds: [
      categoryIds.tradingCards,
      categoryIds.sports,
      categoryIds.basketball,
      categoryIds.nba,
    ],
    displayOrder: 60,
  },
];

function valuation(minorUnits: number) {
  return {
    displayMoney: { minorUnits, currency: "USD" },
    usdComparison: {
      status: "available" as const,
      value: { minorUnits, currency: "USD" as const },
    },
    valuationType: "market_estimate" as const,
    observedAt,
  };
}

type CollectibleInput = Readonly<{
  id: string;
  name: string;
  aliases?: readonly string[];
  collectibleType: PublicCollectible["collectibleType"];
  publicCategoryIds: readonly string[];
  year: number | null;
  brand: string | null;
  setOrSeries: string | null;
  cardNumber?: string | null;
  referenceNumber?: string | null;
  subject: string | null;
  grade?: string | null;
  grader?: string | null;
  valuationMinor: number | null;
}>;

function collectible(input: CollectibleInput): PublicCollectible {
  const aliases = [...(input.aliases ?? [])].sort();
  const normalizedAliases = aliases
    .map((alias) => normalizePublicSearchText(alias))
    .sort();
  const normalizedName = normalizePublicSearchText(input.name);
  return {
    publicCollectibleId: input.id,
    name: input.name,
    normalizedName,
    aliases,
    normalizedAliases,
    collectibleType: input.collectibleType,
    publicCategoryIds: [...input.publicCategoryIds].sort(),
    year: input.year,
    brand: input.brand,
    setOrSeries: input.setOrSeries,
    cardNumber: input.cardNumber ?? null,
    referenceNumber: input.referenceNumber ?? null,
    subject: input.subject,
    grade: input.grade ?? null,
    grader: input.grader ?? null,
    primaryImage: null,
    valuation:
      input.valuationMinor === null ? null : valuation(input.valuationMinor),
    searchText: buildPublicCollectibleSearchText({
      name: input.name,
      aliases,
      year: input.year,
      brand: input.brand,
      setOrSeries: input.setOrSeries,
      cardNumber: input.cardNumber ?? null,
      referenceNumber: input.referenceNumber ?? null,
      subject: input.subject,
      grade: input.grade ?? null,
      grader: input.grader ?? null,
    }),
    dataAsOf: observedAt,
  };
}

const collectibles: readonly PublicCollectible[] = [
  collectible({
    id: collectibleIds.charizard,
    name: "1999 Pokemon Base Set Charizard Holo PSA 10",
    aliases: ["Base Set Charizard", "Charizard PSA 10"],
    collectibleType: "card",
    publicCategoryIds: [categoryIds.pokemon],
    year: 1999,
    brand: "Pokemon",
    setOrSeries: "Base Set",
    cardNumber: "4/102",
    subject: "Charizard",
    grade: "10",
    grader: "PSA",
    valuationMinor: 8_500_000,
  }),
  collectible({
    id: collectibleIds.umbreon,
    name: "2021 Umbreon VMAX Alternate Art PSA 10",
    aliases: ["Moonbreon"],
    collectibleType: "card",
    publicCategoryIds: [categoryIds.pokemon],
    year: 2021,
    brand: "Pokemon",
    setOrSeries: "Evolving Skies",
    cardNumber: "215/203",
    subject: "Umbreon",
    grade: "10",
    grader: "PSA",
    valuationMinor: 155_200,
  }),
  collectible({
    id: collectibleIds.lebron,
    name: "2003 Topps Chrome LeBron James Rookie PSA 10",
    aliases: ["LeBron Chrome Rookie"],
    collectibleType: "card",
    publicCategoryIds: [categoryIds.nba],
    year: 2003,
    brand: "Topps Chrome",
    setOrSeries: "Topps Chrome Basketball",
    cardNumber: "111",
    subject: "LeBron James",
    grade: "10",
    grader: "PSA",
    valuationMinor: 240_000,
  }),
  collectible({
    id: collectibleIds.rolex,
    name: "Rolex Submariner Date 126610LN",
    aliases: ["Submariner Date"],
    collectibleType: "watch",
    publicCategoryIds: [categoryIds.watches],
    year: 2024,
    brand: "Rolex",
    setOrSeries: "Submariner",
    referenceNumber: "126610LN",
    subject: "Submariner Date",
    valuationMinor: 1_550_000,
  }),
  collectible({
    id: collectibleIds.pikachu,
    name: "Rainbow Pikachu VMAX PSA 10",
    aliases: ["Pikachu VMAX"],
    collectibleType: "card",
    publicCategoryIds: [categoryIds.pokemon],
    year: 2020,
    brand: "Pokemon",
    setOrSeries: "Vivid Voltage",
    cardNumber: "188/185",
    subject: "Pikachu",
    grade: "10",
    grader: "PSA",
    valuationMinor: 67_500,
  }),
  collectible({
    id: collectibleIds.jordan,
    name: "1986 Fleer Michael Jordan Rookie PSA 9",
    aliases: ["Jordan Rookie"],
    collectibleType: "card",
    publicCategoryIds: [categoryIds.nba],
    year: 1986,
    brand: "Fleer",
    setOrSeries: "1986 Fleer Basketball",
    cardNumber: "57",
    subject: "Michael Jordan",
    grade: "9",
    grader: "PSA",
    valuationMinor: 2_150_000,
  }),
];

const collectibleById = new Map(
  collectibles.map((item) => [item.publicCollectibleId, item]),
);

function collectibleDisplay(publicCollectibleId: string): PublicCollectibleDisplay {
  const item = collectibleById.get(publicCollectibleId);
  if (item === undefined) throw new Error("Mock collectible is missing.");
  return {
    publicCollectibleId: item.publicCollectibleId,
    name: item.name,
    collectibleType: item.collectibleType,
    publicCategoryIds: item.publicCategoryIds,
    primaryImage: item.primaryImage,
    valuation: item.valuation,
  };
}

function chase(input: {
  repackId: string;
  collectibleId: string;
  role: PublicRepackChase["role"];
  probabilityBasisPoints: number | null;
  confidence: number;
  displayOrder: number;
  evidenceKinds?: PublicRepackChase["evidenceKinds"];
}): PublicRepackChase {
  const band =
    input.confidence >= 8_000
      ? "high"
      : input.confidence >= 5_000
        ? "medium"
        : "low";
  return {
    publicRepackId: input.repackId,
    publicCollectibleId: input.collectibleId,
    role: input.role,
    evidenceKinds: input.evidenceKinds ?? [
      "packscout_resolved",
      "vendor_featured_chase",
    ],
    probabilityBasisPoints: input.probabilityBasisPoints,
    collectible: collectibleDisplay(input.collectibleId),
    matchConfidence: { scoreBasisPoints: input.confidence, band },
    observedAt,
    displayOrder: input.displayOrder,
  };
}

const repackChases: readonly PublicRepackChase[] = [
  chase({
    repackId: repackIds.mythicPokemon,
    collectibleId: collectibleIds.charizard,
    role: "top_chase",
    probabilityBasisPoints: 20,
    confidence: 9_700,
    displayOrder: 0,
  }),
  chase({
    repackId: repackIds.mythicPokemon,
    collectibleId: collectibleIds.pikachu,
    role: "featured_chase",
    probabilityBasisPoints: 100,
    confidence: 8_900,
    displayOrder: 1,
  }),
  chase({
    repackId: repackIds.pokemonMaster,
    collectibleId: collectibleIds.charizard,
    role: "top_chase",
    probabilityBasisPoints: 5,
    confidence: 8_200,
    displayOrder: 0,
  }),
  chase({
    repackId: repackIds.pokemonMaster,
    collectibleId: collectibleIds.umbreon,
    role: "featured_chase",
    probabilityBasisPoints: 80,
    confidence: 9_100,
    displayOrder: 1,
  }),
  chase({
    repackId: repackIds.legendsMixed,
    collectibleId: collectibleIds.charizard,
    role: "top_chase",
    probabilityBasisPoints: null,
    confidence: 4_300,
    displayOrder: 0,
    evidenceKinds: ["historical_pull_inference", "name_only"],
  }),
  chase({
    repackId: repackIds.legendsMixed,
    collectibleId: collectibleIds.rolex,
    role: "possible_outcome",
    probabilityBasisPoints: null,
    confidence: 7_200,
    displayOrder: 1,
    evidenceKinds: ["name_only", "packscout_resolved"],
  }),
  chase({
    repackId: repackIds.hallOfFame,
    collectibleId: collectibleIds.lebron,
    role: "top_chase",
    probabilityBasisPoints: 45,
    confidence: 9_400,
    displayOrder: 0,
  }),
  chase({
    repackId: repackIds.vintagePokemon,
    collectibleId: collectibleIds.charizard,
    role: "top_chase",
    probabilityBasisPoints: 12,
    confidence: 9_800,
    displayOrder: 0,
  }),
  chase({
    repackId: repackIds.soldOutSports,
    collectibleId: collectibleIds.jordan,
    role: "top_chase",
    probabilityBasisPoints: 10,
    confidence: 9_600,
    displayOrder: 0,
  }),
];

function evMetrics(priceMinor: number, grossMinor: number) {
  const grossReturnBasisPoints = Math.round(
    (grossMinor * 10_000) / priceMinor,
  );
  return {
    grossEv: { minorUnits: grossMinor, currency: "USD" as const },
    grossReturnBasisPoints,
    evDollars: {
      minorUnits: grossMinor - priceMinor,
      currency: "USD" as const,
    },
    evPercentBasisPoints: grossReturnBasisPoints - 10_000,
  };
}

function vendorReported(
  priceMinor: number,
  grossMinor: number | null,
): VendorReportedEv {
  return grossMinor === null
    ? {
        status: "unavailable",
        displayMoney: null,
        metrics: null,
        observedAt,
        reason: "NOT_REPORTED",
      }
    : {
        status: "available",
        displayMoney: { minorUnits: grossMinor, currency: "USD" },
        metrics: evMetrics(priceMinor, grossMinor),
        observedAt,
      };
}

function packScout(
  priceMinor: number,
  grossMinor: number | null,
  confidence: number | null,
): PackScoutEv {
  if (grossMinor === null || confidence === null) {
    return {
      status: "unavailable",
      metrics: null,
      confidence: null,
      modelVersion: "packscout_mock_ev_v1",
      confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
      dataAsOf: observedAt,
      calculatedAt,
      reason: "ESTIMATE_INPUT_INCOMPLETE",
    };
  }
  const band = confidence >= 8_000 ? "high" : confidence >= 5_000 ? "medium" : "low";
  const limitationCodes =
    band === "high"
      ? []
      : band === "medium"
        ? ["partial_probability_coverage" as const]
        : [
            "incomplete_outcome_pool" as const,
            "sparse_valuation_data" as const,
          ];
  return {
    status: "available",
    metrics: evMetrics(priceMinor, grossMinor),
    confidence: { scoreBasisPoints: confidence, band, limitationCodes },
    modelVersion: "packscout_mock_ev_v1",
    confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
    dataAsOf: observedAt,
    calculatedAt,
  };
}

type RepackInput = Readonly<{
  id: string;
  vendor: PublicVendor;
  name: string;
  format: PublicRepackDetail["format"];
  categoryIds: readonly string[];
  categoryLabels: readonly string[];
  categoryKeys: readonly string[];
  collectibleTypes: PublicRepackDetail["collectibleTypes"];
  priceMinor: number;
  vendorGrossMinor: number | null;
  packScoutGrossMinor: number | null;
  confidence: number | null;
  buybackBasisPoints: number | null;
  knownCollectibleCount: number;
  evidenceCompleteness: "complete" | "partial" | "unknown";
  probabilityCoverageBasisPoints: number | null;
  soldOut?: boolean;
}>;

const categoryById = new Map(
  categories.map((category) => [category.publicCategoryId, category]),
);

function repack(input: RepackInput): PublicRepackDetail {
  const topChase =
    repackChases.find(
      (candidate) =>
        candidate.publicRepackId === input.id && candidate.role === "top_chase",
    ) ?? null;
  const repackLink = input.soldOut
    ? undefined
    : {
        listingUrl: `https://${input.vendor.listingHosts[0]}/packs/${input.id}`,
        listingHost: input.vendor.listingHosts[0]!,
        referralParameters: input.vendor.referralParameters,
      };
  const promo = input.vendor.publicPromo ?? undefined;
  return {
    publicRepackId: input.id,
    publicVendorId: input.vendor.publicVendorId,
    vendorKey: input.vendor.vendorKey,
    vendorDisplayName: input.vendor.displayName,
    vendorLogoUrl: input.vendor.logoUrl,
    name: input.name,
    format: input.format,
    contentMode: (() => {
      const independentCategoryCount = input.categoryIds.filter(
        (candidateId) =>
          !input.categoryIds.some(
            (otherId) =>
              otherId !== candidateId &&
              categoryById
                .get(otherId)
                ?.pathPublicCategoryIds.includes(candidateId),
          ),
      ).length;
      return independentCategoryCount > 1 || input.collectibleTypes.length > 1
        ? "mixed"
        : independentCategoryCount > 0 || input.collectibleTypes.length > 0
          ? "focused"
          : "unknown";
    })(),
    categories: input.categoryIds
      .map((publicCategoryId, index) => ({
        publicCategoryId,
        label: input.categoryLabels[index]!,
      }))
      .sort((left, right) =>
        left.publicCategoryId.localeCompare(right.publicCategoryId),
      ),
    collectibleTypes: [...input.collectibleTypes].sort(),
    availability: input.soldOut ? "sold_out" : "active",
    price: {
      displayMoney: { minorUnits: input.priceMinor, currency: "USD" },
      usdComparison: {
        status: "available",
        value: { minorUnits: input.priceMinor, currency: "USD" },
      },
    },
    buyback:
      input.buybackBasisPoints === null
        ? {
            status: "unavailable",
            value: null,
            reason: "BUYBACK_UNAVAILABLE",
          }
        : {
            status: "available",
            value: {
              basisPoints: input.buybackBasisPoints,
              sourceKind: "vendor_reported",
            },
          },
    primaryImage: null,
    evEstimates: {
      vendorReported: vendorReported(input.priceMinor, input.vendorGrossMinor),
      packScout: packScout(
        input.priceMinor,
        input.packScoutGrossMinor,
        input.confidence,
      ),
    },
    topChase,
    contentSummary: {
      knownCollectibleCount: input.knownCollectibleCount,
      chaseCount: repackChases.filter(
        (candidate) => candidate.publicRepackId === input.id,
      ).length,
      categoryCount: input.categoryIds.length,
      collectibleTypeCount: input.collectibleTypes.length,
      evidenceCompleteness: input.evidenceCompleteness,
      probabilityCoverageBasisPoints: input.probabilityCoverageBasisPoints,
    },
    actionAvailability: {
      promo: promo !== undefined,
      repackLink: repackLink !== undefined,
    },
    sourceUpdatedAt: observedAt,
    description: `${input.name} is deterministic mock data for local UI development.`,
    actions: {
      ...(promo === undefined ? {} : { promo }),
      ...(repackLink === undefined ? {} : { repackLink }),
    },
  };
}

const repacks: readonly PublicRepackDetail[] = [
  repack({
    id: repackIds.mythicPokemon,
    vendor: vendors[0]!,
    name: "Mythic Pokemon Gacha",
    format: "gacha",
    categoryIds: [categoryIds.tradingCards, categoryIds.pokemon],
    categoryLabels: ["Trading Cards", "Pokemon"],
    categoryKeys: ["pokemon"],
    collectibleTypes: ["card"],
    priceMinor: 250_000,
    vendorGrossMinor: 268_455,
    packScoutGrossMinor: 262_500,
    confidence: 9_100,
    buybackBasisPoints: 9_300,
    knownCollectibleCount: 120,
    evidenceCompleteness: "complete",
    probabilityCoverageBasisPoints: 10_000,
  }),
  repack({
    id: repackIds.pokemonMaster,
    vendor: vendors[1]!,
    name: "Pokemon Master Pack",
    format: "repack",
    categoryIds: [categoryIds.tradingCards, categoryIds.pokemon],
    categoryLabels: ["Trading Cards", "Pokemon"],
    categoryKeys: ["pokemon"],
    collectibleTypes: ["card"],
    priceMinor: 10_000,
    vendorGrossMinor: 9_700,
    packScoutGrossMinor: 10_400,
    confidence: 7_200,
    buybackBasisPoints: 8_500,
    knownCollectibleCount: 80,
    evidenceCompleteness: "partial",
    probabilityCoverageBasisPoints: 8_500,
  }),
  repack({
    id: repackIds.legendsMixed,
    vendor: vendors[0]!,
    name: "Legends Cards and Watches Vault",
    format: "gacha",
    categoryIds: [
      categoryIds.tradingCards,
      categoryIds.pokemon,
      categoryIds.watches,
    ],
    categoryLabels: ["Trading Cards", "Pokemon", "Watches"],
    categoryKeys: ["pokemon", "watches"],
    collectibleTypes: ["card", "watch"],
    priceMinor: 29_900,
    vendorGrossMinor: null,
    packScoutGrossMinor: 31_200,
    confidence: 4_500,
    buybackBasisPoints: 8_800,
    knownCollectibleCount: 35,
    evidenceCompleteness: "partial",
    probabilityCoverageBasisPoints: null,
  }),
  repack({
    id: repackIds.hallOfFame,
    vendor: vendors[1]!,
    name: "Basketball Hall of Fame Hits",
    format: "repack",
    categoryIds: [
      categoryIds.tradingCards,
      categoryIds.sports,
      categoryIds.basketball,
      categoryIds.nba,
    ],
    categoryLabels: ["Trading Cards", "Sports", "Basketball", "NBA"],
    categoryKeys: ["nba"],
    collectibleTypes: ["card"],
    priceMinor: 24_900,
    vendorGrossMinor: 25_349,
    packScoutGrossMinor: null,
    confidence: null,
    buybackBasisPoints: 8_200,
    knownCollectibleCount: 60,
    evidenceCompleteness: "unknown",
    probabilityCoverageBasisPoints: null,
  }),
  repack({
    id: repackIds.vintagePokemon,
    vendor: vendors[0]!,
    name: "Vintage Pokemon Chase Pack",
    format: "repack",
    categoryIds: [categoryIds.tradingCards, categoryIds.pokemon],
    categoryLabels: ["Trading Cards", "Pokemon"],
    categoryKeys: ["pokemon"],
    collectibleTypes: ["card"],
    priceMinor: 8_900,
    vendorGrossMinor: 8_953,
    packScoutGrossMinor: 9_200,
    confidence: 6_500,
    buybackBasisPoints: 7_800,
    knownCollectibleCount: 48,
    evidenceCompleteness: "partial",
    probabilityCoverageBasisPoints: 7_800,
  }),
  repack({
    id: repackIds.soldOutSports,
    vendor: vendors[1]!,
    name: "Sold Out Basketball Grails",
    format: "gacha",
    categoryIds: [
      categoryIds.tradingCards,
      categoryIds.sports,
      categoryIds.basketball,
      categoryIds.nba,
    ],
    categoryLabels: ["Trading Cards", "Sports", "Basketball", "NBA"],
    categoryKeys: ["nba"],
    collectibleTypes: ["card"],
    priceMinor: 6_900,
    vendorGrossMinor: 6_914,
    packScoutGrossMinor: 6_750,
    confidence: 8_500,
    buybackBasisPoints: null,
    knownCollectibleCount: 20,
    evidenceCompleteness: "complete",
    probabilityCoverageBasisPoints: 10_000,
    soldOut: true,
  }),
];

export function buildMockDataReleaseV2(): DataReleaseManifestV2 {
  return parseDataReleaseManifestV2({
    metadata: {
      schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
      dataSource: "mock",
      publicReleaseId: MOCK_DATA_RELEASE_PUBLIC_ID,
      sourceWatermark: MOCK_DATA_RELEASE_FIXTURE_VERSION,
      manifestFingerprint: MOCK_DATA_RELEASE_MANIFEST_FINGERPRINT,
      contentHash: MOCK_DATA_RELEASE_CONTENT_HASH,
      publicConfigRevision: 1,
      publicConfigHash: MOCK_DATA_RELEASE_PUBLIC_CONFIG_HASH,
      originSetHash: MOCK_DATA_RELEASE_ORIGIN_SET_HASH,
      searchAlgorithmVersion: REPACK_SEARCH_VERSION,
      repackSearchIndexHash: MOCK_REPACK_SEARCH_INDEX_HASH,
      confidencePolicyVersion: MOCK_DATA_RELEASE_CONFIDENCE_POLICY_VERSION,
      createdAt: observedAt,
      completedAt: calculatedAt,
      dataAsOf: observedAt,
      lastSuccessfulObservationAt: observedAt,
      staleAt: "2026-08-11T12:15:00Z",
      freshness: "fresh",
      delayedVendorCount: 0,
      vendorCount: vendors.length,
      categoryCount: categories.length,
      repackCount: repacks.length,
      collectibleCount: collectibles.length,
      repackChaseCount: repackChases.length,
    },
    publicAssetOrigins: [],
    vendors,
    categories,
    repacks,
    collectibles,
    repackChases,
  });
}
