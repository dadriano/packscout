import {
  parseCatalogSnapshotV1,
  type CatalogSnapshotV1,
  type PublicPackDetail,
} from "@packscout/contracts";
import { sha256CanonicalJson } from "./catalogCanonicalHash";
import {
  queryRowFromPack,
  type CatalogQueryRow,
} from "./publicCatalogValidation";

export const MOCK_CATALOG_FIXTURE_VERSION = "packscout_mock_catalog_v1" as const;
export const MOCK_CATALOG_PUBLICATION_ID =
  "90000000-0000-4000-8000-000000000001" as const;
export const MOCK_COLLECTOR_CONFIG_HASH =
  "079ad15087ed64ebfec2b718814acb26eed0fd50c3665edc5f565b45cd0f5136" as const;
export const MOCK_COURTYARD_CONFIG_HASH =
  "2a168719ddf8bf140cbfcd4448688d60813d36bececb980d82de7456b3da04c3" as const;
export const MOCK_CATALOG_PUBLIC_CONFIG_HASH =
  "16f08a4cafadbf3060485bee2bdaa70699e10b2e349ba3075e610106f137f438" as const;
export const MOCK_CATALOG_ORIGIN_SET_HASH =
  "6142033aa5ddec65358e4a6a4f05c2fdfbebfe82a283378c52ca1df43bb02e68" as const;
export const MOCK_CATALOG_MANIFEST_FINGERPRINT =
  "6fc9fb6f28f83d390f6ef7c8ab9060281e435d9df1b6e13787382d6b97dc0caf" as const;
export const MOCK_CATALOG_CONTENT_HASH =
  "db25d16dc1bcb4bd34fb612fd526757a723dc40ef362bf02b4b2211003a45636" as const;
export const MOCK_CATALOG_QUERY_SHARD_HASH =
  "3a0129cca0d5a9775893e56a99a98c3b759a523a7f17f9131575c5bce335dc86" as const;
export const MOCK_CATALOG_SEED_IDEMPOTENCY_KEY =
  "packscout-mock-catalog-v1" as const;
export const MOCK_CATALOG_SEED_OPERATION_ID =
  "packscout-mock-catalog-seed-v1" as const;

export const MOCK_CATALOG_HASH_DOMAINS = Object.freeze({
  platformConfig: "packscout.mock.platform-config.v1",
  publicConfig: "packscout.mock.public-config.v1",
  originSet: "packscout.mock.origin-set.v1",
  manifest: "packscout.mock.manifest.v1",
  snapshotContent: "packscout.mock.snapshot-content.v1",
  queryShard: "packscout.mock.query-shard.v1",
});

const observedAt = "2026-08-11T12:00:00Z";

function available<T>(value: T) {
  return {
    status: "available" as const,
    value,
    reason: null,
    nullRank: 0 as const,
  };
}

type MockPackInput = Readonly<{
  id: number;
  name: string;
  platform: "collector_crypt" | "courtyard";
  category: "Pokemon" | "One Piece" | "Magic" | "Sports";
  priceMinor: number;
  grossMinor: number;
  buybackBasisPoints: number;
  chaseName: string;
  chaseMinor: number;
  promo?: boolean;
  soldOut?: boolean;
}>;

function mockPack(input: MockPackInput): PublicPackDetail {
  const collector = input.platform === "collector_crypt";
  const grossReturnBasisPoints = Math.round(
    (input.grossMinor * 10_000) / input.priceMinor,
  );
  const packLink = input.soldOut
    ? undefined
    : {
        listingUrl: collector
          ? `https://collector.example/packs/mock-${input.id}`
          : `https://courtyard.example/packs/mock-${input.id}`,
        listingHost: collector ? "collector.example" : "courtyard.example",
        referralParameters: [
          collector
            ? { name: "ref", value: "packscout" }
            : { name: "utm_source", value: "packscout" },
        ],
      };
  const promo =
    collector && input.promo
      ? { code: "SCOUT", label: "PackScout promo" }
      : undefined;
  const suffix = String(input.id).padStart(12, "0");
  return {
    publicPackId: `00000000-0000-5000-8000-${suffix}`,
    platformKey: input.platform,
    platformDisplayName: collector ? "Collector Crypt" : "Courtyard",
    platformLogoUrl: null,
    category: input.category,
    name: input.name,
    availability: input.soldOut ? "sold_out" : "active",
    price: {
      displayMoney: { minorUnits: input.priceMinor, currency: "USD" },
      usdComparison: available({
        minorUnits: input.priceMinor,
        currency: "USD" as const,
      }),
    },
    estimatedEv: {
      grossEv: available({
        minorUnits: input.grossMinor,
        currency: "USD" as const,
      }),
      grossReturn: available({ basisPoints: grossReturnBasisPoints }),
      evDollars: available({
        minorUnits: input.grossMinor - input.priceMinor,
        currency: "USD" as const,
      }),
      evPercent: available({ basisPoints: grossReturnBasisPoints - 10_000 }),
      calculatedAt: observedAt,
      coverage: {
        evidenceCompleteness: "complete",
        probabilityCoverageBasisPoints: 10_000,
      },
      limitations: ["Mock data for non-production interface development."],
    },
    buyback: available({
      basisPoints: input.buybackBasisPoints,
      sourceKind: collector ? ("direct" as const) : ("derived" as const),
    }),
    primaryImage: null,
    topChase: available({
      publicChaseId: `10000000-0000-5000-8000-${suffix}`,
      name: input.chaseName,
      displayMoney: { minorUnits: input.chaseMinor, currency: "USD" },
      usdComparison: available({
        minorUnits: input.chaseMinor,
        currency: "USD" as const,
      }),
      primaryImage: null,
      evidenceKind: "canonical_asset_value" as const,
      observedAt,
    }),
    actionAvailability: {
      promo: promo !== undefined,
      packLink: packLink !== undefined,
    },
    sourceFirstSeenAt: "2026-08-01T12:00:00Z",
    sourceCollectedAt: observedAt,
    description: `${input.name} is a deterministic mock catalog record.`,
    actions: {
      ...(promo ? { promo } : {}),
      ...(packLink ? { packLink } : {}),
    },
  };
}

const mockPacks = [
  mockPack({
    id: 1,
    name: "Mythic Pokemon Gacha",
    platform: "collector_crypt",
    category: "Pokemon",
    priceMinor: 250_000,
    grossMinor: 268_455,
    buybackBasisPoints: 9_300,
    chaseName: "Celestial Nexus",
    chaseMinor: 8_500_000,
    promo: true,
  }),
  mockPack({
    id: 2,
    name: "Pokemon Master Pack",
    platform: "courtyard",
    category: "Pokemon",
    priceMinor: 10_000,
    grossMinor: 9_700,
    buybackBasisPoints: 8_500,
    chaseName: "Moonbreon",
    chaseMinor: 155_200,
  }),
  mockPack({
    id: 3,
    name: "Legends Booster Box",
    platform: "collector_crypt",
    category: "Pokemon",
    priceMinor: 29_900,
    grossMinor: 30_579,
    buybackBasisPoints: 8_800,
    chaseName: "First Edition Legend",
    chaseMinor: 325_000,
    promo: true,
  }),
  mockPack({
    id: 4,
    name: "Vintage Gym Heroes Pack",
    platform: "courtyard",
    category: "Pokemon",
    priceMinor: 24_900,
    grossMinor: 25_349,
    buybackBasisPoints: 8_200,
    chaseName: "Vintage Holo Dragon",
    chaseMinor: 215_000,
  }),
  mockPack({
    id: 5,
    name: "Elite Trainer Box",
    platform: "collector_crypt",
    category: "Pokemon",
    priceMinor: 8_900,
    grossMinor: 8_953,
    buybackBasisPoints: 7_800,
    chaseName: "Evolving Skies Alt Art",
    chaseMinor: 89_000,
    promo: true,
  }),
  mockPack({
    id: 6,
    name: "Pikachu VMAX Special Box",
    platform: "courtyard",
    category: "Pokemon",
    priceMinor: 6_900,
    grossMinor: 6_914,
    buybackBasisPoints: 7_600,
    chaseName: "Rainbow Pikachu",
    chaseMinor: 67_500,
  }),
  mockPack({
    id: 7,
    name: "Grand Line Treasure",
    platform: "collector_crypt",
    category: "One Piece",
    priceMinor: 15_000,
    grossMinor: 15_480,
    buybackBasisPoints: 8_000,
    chaseName: "Manga Rare Captain",
    chaseMinor: 190_000,
    promo: true,
    soldOut: true,
  }),
  mockPack({
    id: 8,
    name: "Arcane Vault",
    platform: "courtyard",
    category: "Magic",
    priceMinor: 12_500,
    grossMinor: 12_750,
    buybackBasisPoints: 7_500,
    chaseName: "Serialized Relic",
    chaseMinor: 120_000,
  }),
  mockPack({
    id: 9,
    name: "Hall of Fame Hits",
    platform: "collector_crypt",
    category: "Sports",
    priceMinor: 20_000,
    grossMinor: 20_700,
    buybackBasisPoints: 8_100,
    chaseName: "Rookie Signature",
    chaseMinor: 240_000,
    promo: true,
  }),
] as const;

const platformConfigBodies = [
  {
    platformKey: "collector_crypt",
    revision: 1,
    displayName: "Collector Crypt",
    logoUrl: null,
    listingHosts: ["collector.example"],
    imageOrigins: [],
    referralParameters: [{ name: "ref", value: "packscout" }],
    publicPromo: { code: "SCOUT", label: "PackScout promo" },
  },
  {
    platformKey: "courtyard",
    revision: 1,
    displayName: "Courtyard",
    logoUrl: null,
    listingHosts: ["courtyard.example"],
    imageOrigins: [],
    referralParameters: [{ name: "utm_source", value: "packscout" }],
    publicPromo: null,
  },
] as const;

const mockPlatformConfigs = [
  {
    ...platformConfigBodies[0],
    contentHash: MOCK_COLLECTOR_CONFIG_HASH,
  },
  {
    ...platformConfigBodies[1],
    contentHash: MOCK_COURTYARD_CONFIG_HASH,
  },
] as const;

const mockFacets = {
  platforms: [
    { key: "collector_crypt", label: "Collector Crypt", packCount: 5 },
    { key: "courtyard", label: "Courtyard", packCount: 4 },
  ],
  categories: [
    { key: "magic", label: "Magic", packCount: 1 },
    { key: "one_piece", label: "One Piece", packCount: 1 },
    { key: "pokemon", label: "Pokemon", packCount: 6 },
    { key: "sports", label: "Sports", packCount: 1 },
  ],
} as const;

export function buildMockCatalogSnapshotV1(): CatalogSnapshotV1 {
  return parseCatalogSnapshotV1({
    metadata: {
      schemaVersion: "catalog_snapshot_v1",
      dataSource: "mock",
      publicationId: MOCK_CATALOG_PUBLICATION_ID,
      sourceWatermark: MOCK_CATALOG_FIXTURE_VERSION,
      manifestFingerprint: MOCK_CATALOG_MANIFEST_FINGERPRINT,
      contentHash: MOCK_CATALOG_CONTENT_HASH,
      publicConfigRevision: 1,
      publicConfigHash: MOCK_CATALOG_PUBLIC_CONFIG_HASH,
      originSetHash: MOCK_CATALOG_ORIGIN_SET_HASH,
      createdAt: "2026-08-11T12:00:00Z",
      completedAt: "2026-08-11T12:00:01Z",
      dataAsOf: "2026-08-11T12:00:00Z",
      lastSuccessfulObservationAt: "2026-08-11T12:00:00Z",
      staleAt: "2026-08-11T12:15:00Z",
      freshness: "fresh",
      delayedSourceCount: 0,
      platformConfigCount: 2,
      packCount: mockPacks.length,
      searchAlgorithmVersion: "packscout_relevance_v1",
    },
    platformConfigs: mockPlatformConfigs,
    packs: mockPacks,
    facets: mockFacets,
  });
}

export function buildMockCatalogQueryRows(
  snapshot = buildMockCatalogSnapshotV1(),
): CatalogQueryRow[] {
  return snapshot.packs.map((pack) =>
    queryRowFromPack({
      publicPackId: pack.publicPackId,
      platformKey: pack.platformKey,
      platformDisplayName: pack.platformDisplayName,
      category: pack.category,
      name: pack.name,
      availability: pack.availability,
      priceMinor:
        pack.price.usdComparison.status === "available"
          ? pack.price.usdComparison.value.minorUnits
          : null,
      grossEvMinor:
        pack.estimatedEv.grossEv.status === "available"
          ? pack.estimatedEv.grossEv.value.minorUnits
          : null,
      evDollarsMinor:
        pack.estimatedEv.evDollars.status === "available"
          ? pack.estimatedEv.evDollars.value.minorUnits
          : null,
      evPercentBasisPoints:
        pack.estimatedEv.evPercent.status === "available"
          ? pack.estimatedEv.evPercent.value.basisPoints
          : null,
      buybackBasisPoints:
        pack.buyback.status === "available"
          ? pack.buyback.value.basisPoints
          : null,
      topChaseValueMinor:
        pack.topChase.status === "available" &&
        pack.topChase.value.usdComparison.status === "available"
          ? pack.topChase.value.usdComparison.value.minorUnits
          : null,
      topChaseReason:
        pack.topChase.status === "unavailable"
          ? pack.topChase.reason
          : pack.topChase.value.usdComparison.status === "unavailable"
            ? pack.topChase.value.usdComparison.reason
            : null,
    }),
  );
}

export async function recomputeMockCatalogHashes(
  snapshot = buildMockCatalogSnapshotV1(),
  queryRows: readonly CatalogQueryRow[] = buildMockCatalogQueryRows(snapshot),
) {
  const platformBodies = snapshot.platformConfigs.map(
    ({ contentHash: _contentHash, ...config }) => config,
  );
  const platformConfigHashes = await Promise.all(
    platformBodies.map((config) =>
      sha256CanonicalJson(MOCK_CATALOG_HASH_DOMAINS.platformConfig, config),
    ),
  );
  const imageOrigins = [
    ...new Set(snapshot.platformConfigs.flatMap(({ imageOrigins }) => imageOrigins)),
  ].sort();
  const manifest = {
    fixtureVersion: MOCK_CATALOG_FIXTURE_VERSION,
    publicationId: snapshot.metadata.publicationId,
    publicPackIds: snapshot.packs.map(({ publicPackId }) => publicPackId),
  };
  const snapshotContent = {
    schemaVersion: snapshot.metadata.schemaVersion,
    dataSource: snapshot.metadata.dataSource,
    publicConfigRevision: snapshot.metadata.publicConfigRevision,
    platformConfigs: snapshot.platformConfigs,
    packs: snapshot.packs,
    facets: snapshot.facets,
  };
  return {
    platformConfigHashes,
    publicConfigHash: await sha256CanonicalJson(
      MOCK_CATALOG_HASH_DOMAINS.publicConfig,
      snapshot.platformConfigs,
    ),
    originSetHash: await sha256CanonicalJson(
      MOCK_CATALOG_HASH_DOMAINS.originSet,
      imageOrigins,
    ),
    manifestFingerprint: await sha256CanonicalJson(
      MOCK_CATALOG_HASH_DOMAINS.manifest,
      manifest,
    ),
    contentHash: await sha256CanonicalJson(
      MOCK_CATALOG_HASH_DOMAINS.snapshotContent,
      snapshotContent,
    ),
    queryShardHash: await sha256CanonicalJson(
      MOCK_CATALOG_HASH_DOMAINS.queryShard,
      queryRows,
    ),
  };
}
