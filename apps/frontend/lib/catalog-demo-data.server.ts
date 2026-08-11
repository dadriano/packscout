import {
  catalogSnapshotV1Schema,
  dashboardBundleSchema,
  listPublicPacksPageSchema,
  normalizeDashboardQueryInput,
  normalizeListPublicPacksInput,
  normalizePublicSearchText,
  publicPackSummarySchema,
  type CatalogSnapshotV1,
  type DashboardBundle,
  type DashboardQueryInput,
  type ListPublicPacksInput,
  type ListPublicPacksPage,
  type PublicCatalogFilters,
  type PublicPackDetail,
  type PublicPackSummary,
} from "@packscout/contracts";

function available<T>(value: T) {
  return { status: "available" as const, value, reason: null, nullRank: 0 as const };
}

const observedAt = "2026-08-11T12:00:00Z";

type DemoPackInput = Readonly<{
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

function demoPack(input: DemoPackInput): PublicPackDetail {
  const evDollarsMinor = input.grossMinor - input.priceMinor;
  const grossReturnBasisPoints = Math.round((input.grossMinor * 10_000) / input.priceMinor);
  const evBasisPoints = grossReturnBasisPoints - 10_000;
  const collector = input.platform === "collector_crypt";
  const packLink = input.soldOut
    ? undefined
    : {
        listingUrl: collector
          ? `https://collector.example/packs/demo-${input.id}`
          : `https://courtyard.example/packs/demo-${input.id}`,
        listingHost: collector ? "collector.example" : "courtyard.example",
        referralParameters: [
          collector
            ? { name: "ref", value: "packscout" }
            : { name: "utm_source", value: "packscout" },
        ],
      };
  const promo = collector && input.promo
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
      usdComparison: available({ minorUnits: input.priceMinor, currency: "USD" as const }),
    },
    estimatedEv: {
      grossEv: available({ minorUnits: input.grossMinor, currency: "USD" as const }),
      grossReturn: available({ basisPoints: grossReturnBasisPoints }),
      evDollars: available({ minorUnits: evDollarsMinor, currency: "USD" as const }),
      evPercent: available({ basisPoints: evBasisPoints }),
      calculatedAt: observedAt,
      coverage: {
        evidenceCompleteness: "complete",
        probabilityCoverageBasisPoints: 10_000,
      },
      limitations: ["Estimated outcomes are not guaranteed."],
    },
    buyback: available({
      basisPoints: input.buybackBasisPoints,
      sourceKind: collector ? "direct" as const : "derived" as const,
    }),
    primaryImage: null,
    topChase: available({
      publicChaseId: `10000000-0000-5000-8000-${suffix}`,
      name: input.chaseName,
      displayMoney: { minorUnits: input.chaseMinor, currency: "USD" },
      usdComparison: available({ minorUnits: input.chaseMinor, currency: "USD" as const }),
      primaryImage: null,
      evidenceKind: "canonical_asset_value" as const,
      observedAt,
    }),
    actionAvailability: { promo: promo !== undefined, packLink: packLink !== undefined },
    sourceFirstSeenAt: "2026-08-01T12:00:00Z",
    sourceCollectedAt: observedAt,
    description: `${input.name} is included only in PackScout's explicit local interface preview.`,
    actions: { ...(promo ? { promo } : {}), ...(packLink ? { packLink } : {}) },
  };
}

const DEMO_PACKS = Object.freeze([
  demoPack({ id: 1, name: "Mythic Pokemon Gacha", platform: "collector_crypt", category: "Pokemon", priceMinor: 250_000, grossMinor: 268_455, buybackBasisPoints: 9_300, chaseName: "Celestial Nexus", chaseMinor: 8_500_000, promo: true }),
  demoPack({ id: 2, name: "Pokemon Master Pack", platform: "courtyard", category: "Pokemon", priceMinor: 10_000, grossMinor: 9_700, buybackBasisPoints: 8_500, chaseName: "Moonbreon", chaseMinor: 155_200 }),
  demoPack({ id: 3, name: "Legends Booster Box", platform: "collector_crypt", category: "Pokemon", priceMinor: 29_900, grossMinor: 30_579, buybackBasisPoints: 8_800, chaseName: "First Edition Legend", chaseMinor: 325_000, promo: true }),
  demoPack({ id: 4, name: "Vintage Gym Heroes Pack", platform: "courtyard", category: "Pokemon", priceMinor: 24_900, grossMinor: 25_349, buybackBasisPoints: 8_200, chaseName: "Vintage Holo Dragon", chaseMinor: 215_000 }),
  demoPack({ id: 5, name: "Elite Trainer Box", platform: "collector_crypt", category: "Pokemon", priceMinor: 8_900, grossMinor: 8_953, buybackBasisPoints: 7_800, chaseName: "Evolving Skies Alt Art", chaseMinor: 89_000, promo: true }),
  demoPack({ id: 6, name: "Pikachu VMAX Special Box", platform: "courtyard", category: "Pokemon", priceMinor: 6_900, grossMinor: 6_914, buybackBasisPoints: 7_600, chaseName: "Rainbow Pikachu", chaseMinor: 67_500 }),
  demoPack({ id: 7, name: "Grand Line Treasure", platform: "collector_crypt", category: "One Piece", priceMinor: 15_000, grossMinor: 15_480, buybackBasisPoints: 8_000, chaseName: "Manga Rare Captain", chaseMinor: 190_000, promo: true, soldOut: true }),
  demoPack({ id: 8, name: "Arcane Vault", platform: "courtyard", category: "Magic", priceMinor: 12_500, grossMinor: 12_750, buybackBasisPoints: 7_500, chaseName: "Serialized Relic", chaseMinor: 120_000 }),
  demoPack({ id: 9, name: "Hall of Fame Hits", platform: "collector_crypt", category: "Sports", priceMinor: 20_000, grossMinor: 20_700, buybackBasisPoints: 8_100, chaseName: "Rookie Signature", chaseMinor: 240_000, promo: true }),
]);

function summary(pack: PublicPackDetail): PublicPackSummary {
  const topChase = pack.topChase.status === "available"
    ? available({
        publicChaseId: pack.topChase.value.publicChaseId,
        name: pack.topChase.value.name,
        displayMoney: pack.topChase.value.displayMoney,
        usdComparison: pack.topChase.value.usdComparison,
        primaryImage: pack.topChase.value.primaryImage,
      })
    : pack.topChase;
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
    topChase,
    actionAvailability: pack.actionAvailability,
    sourceFirstSeenAt: pack.sourceFirstSeenAt,
    sourceCollectedAt: pack.sourceCollectedAt,
  });
}

const metadata = {
  schemaVersion: "catalog_snapshot_v1" as const,
  publicationId: "20000000-0000-4000-8000-000000000001",
  sourceWatermark: "local-interface-preview-v1",
  manifestFingerprint: "4".repeat(64),
  contentHash: "5".repeat(64),
  publicConfigRevision: 1,
  publicConfigHash: "6".repeat(64),
  originSetHash: "7".repeat(64),
  createdAt: observedAt,
  completedAt: observedAt,
  dataAsOf: observedAt,
  lastSuccessfulObservationAt: observedAt,
  staleAt: "2026-08-11T12:15:00Z",
  freshness: "fresh" as const,
  delayedSourceCount: 0,
  platformConfigCount: 2,
  packCount: DEMO_PACKS.length,
  searchAlgorithmVersion: "packscout_relevance_v1" as const,
};

const platformConfigs = [
  {
    platformKey: "collector_crypt",
    revision: 1,
    contentHash: "1".repeat(64),
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
    contentHash: "2".repeat(64),
    displayName: "Courtyard",
    logoUrl: null,
    listingHosts: ["courtyard.example"],
    imageOrigins: [],
    referralParameters: [{ name: "utm_source", value: "packscout" }],
    publicPromo: null,
  },
] as const;

function counts<T extends string>(values: readonly T[]): Map<T, number> {
  const result = new Map<T, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function snapshot(): CatalogSnapshotV1 {
  const platformCounts = counts(DEMO_PACKS.map((pack) => pack.platformKey));
  const categoryCounts = counts(DEMO_PACKS.map((pack) => pack.category));
  return catalogSnapshotV1Schema.parse({
    metadata,
    platformConfigs,
    packs: DEMO_PACKS,
    facets: {
      platforms: [
        { key: "collector_crypt", label: "Collector Crypt", packCount: platformCounts.get("collector_crypt") ?? 0 },
        { key: "courtyard", label: "Courtyard", packCount: platformCounts.get("courtyard") ?? 0 },
      ],
      categories: [
        { key: "magic", label: "Magic", packCount: categoryCounts.get("Magic") ?? 0 },
        { key: "one_piece", label: "One Piece", packCount: categoryCounts.get("One Piece") ?? 0 },
        { key: "pokemon", label: "Pokemon", packCount: categoryCounts.get("Pokemon") ?? 0 },
        { key: "sports", label: "Sports", packCount: categoryCounts.get("Sports") ?? 0 },
      ],
    },
  });
}

function categoryKey(category: string): string {
  return normalizePublicSearchText(category).replaceAll(" ", "_");
}

function matchesFilters(pack: PublicPackDetail, filters: PublicCatalogFilters): boolean {
  if (filters.platforms.length > 0 && !filters.platforms.includes(pack.platformKey)) return false;
  if (filters.categories.length > 0 && !filters.categories.includes(categoryKey(pack.category))) return false;
  if (filters.price.mode === "narrowed") {
    const price = pack.price.usdComparison;
    if (price.status !== "available") return false;
    if (price.value.minorUnits < filters.price.minMinor || price.value.minorUnits > filters.price.maxMinor) return false;
  }
  return true;
}

function matchesSearch(pack: PublicPackDetail, search: string): boolean {
  if (!search) return true;
  const haystack = normalizePublicSearchText(`${pack.name} ${pack.platformDisplayName} ${pack.category}`);
  return search.split(" ").every((token) => haystack.split(" ").some((candidate) => candidate.startsWith(token)));
}

function sortableNumber(pack: PublicPackDetail, sort: ListPublicPacksInput["sort"]): number | string {
  if (sort === "pack") return normalizePublicSearchText(pack.name);
  if (sort === "pack_price") return pack.price.usdComparison.status === "available" ? pack.price.usdComparison.value.minorUnits : Number.NaN;
  if (sort === "ev_dollars") return pack.estimatedEv.evDollars.status === "available" ? pack.estimatedEv.evDollars.value.minorUnits : Number.NaN;
  if (sort === "ev_percent") return pack.estimatedEv.evPercent.status === "available" ? pack.estimatedEv.evPercent.value.basisPoints : Number.NaN;
  if (sort === "buyback_percent") return pack.buyback.status === "available" ? pack.buyback.value.basisPoints : Number.NaN;
  if (sort === "gross_ev") return pack.estimatedEv.grossEv.status === "available" ? pack.estimatedEv.grossEv.value.minorUnits : Number.NaN;
  return pack.topChase.status === "available" && pack.topChase.value.usdComparison.status === "available"
    ? pack.topChase.value.usdComparison.value.minorUnits
    : Number.NaN;
}

function sortedPacks(packs: readonly PublicPackDetail[], input: ListPublicPacksInput): PublicPackDetail[] {
  if (input.search) return [...packs].sort((left, right) => left.name.localeCompare(right.name));
  return [...packs].sort((left, right) => {
    const a = sortableNumber(left, input.sort);
    const b = sortableNumber(right, input.sort);
    if (typeof a === "string" && typeof b === "string") {
      const order = a.localeCompare(b);
      return input.direction === "asc" ? order : -order;
    }
    const aMissing = typeof a === "number" && Number.isNaN(a);
    const bMissing = typeof b === "number" && Number.isNaN(b);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (a !== b) return input.direction === "asc" ? Number(a) - Number(b) : Number(b) - Number(a);
    return left.publicPackId.localeCompare(right.publicPackId);
  });
}

function contextualFacets(packs: readonly PublicPackDetail[], filters: PublicCatalogFilters) {
  const platformBase = packs.filter((pack) => {
    const withoutPlatforms = { ...filters, platforms: [] };
    return matchesFilters(pack, withoutPlatforms);
  });
  const categoryBase = packs.filter((pack) => {
    const withoutCategories = { ...filters, categories: [] };
    return matchesFilters(pack, withoutCategories);
  });
  return {
    platforms: [
      { key: "collector_crypt", label: "Collector Crypt", packCount: platformBase.filter((pack) => pack.platformKey === "collector_crypt").length, selected: filters.platforms.includes("collector_crypt") },
      { key: "courtyard", label: "Courtyard", packCount: platformBase.filter((pack) => pack.platformKey === "courtyard").length, selected: filters.platforms.includes("courtyard") },
    ],
    categories: ["Magic", "One Piece", "Pokemon", "Sports"].map((label) => ({
      key: categoryKey(label),
      label,
      packCount: categoryBase.filter((pack) => pack.category === label).length,
      selected: filters.categories.includes(categoryKey(label)),
    })),
  };
}

function medianBasisPoints(packs: readonly PublicPackDetail[]) {
  const values = packs
    .flatMap((pack) => pack.estimatedEv.evPercent.status === "available" ? [pack.estimatedEv.evPercent.value.basisPoints] : [])
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { status: "unavailable" as const, value: null, reason: "ESTIMATE_INPUT_INCOMPLETE" as const, nullRank: 1 as const };
  }
  return available({ basisPoints: values[Math.floor((values.length - 1) / 2)]! });
}

function summaries(packs: readonly PublicPackDetail[], group: "platform" | "category") {
  const entries = group === "platform"
    ? [["collector_crypt", "Collector Crypt"], ["courtyard", "Courtyard"]] as const
    : [["magic", "Magic"], ["one_piece", "One Piece"], ["pokemon", "Pokemon"], ["sports", "Sports"]] as const;
  return entries
    .map(([key, label]) => {
      const grouped = packs.filter((pack) => group === "platform" ? pack.platformKey === key : categoryKey(pack.category) === key);
      return { key, label, packCount: grouped.length, medianEvPercent: medianBasisPoints(grouped) };
    })
    .filter(({ packCount }) => packCount > 0)
    .sort((left, right) => right.packCount - left.packCount || left.key.localeCompare(right.key));
}

export function catalogDemoIsEnabled(environment = process.env): boolean {
  return environment.NODE_ENV !== "production" && environment.PACKSCOUT_CATALOG_FIXTURE_MODE === "1";
}

export function buildDemoDashboard(input: unknown = {}): DashboardBundle {
  const request: DashboardQueryInput = normalizeDashboardQueryInput(input);
  const matching = DEMO_PACKS.filter((pack) => matchesFilters(pack, request.filters));
  const active = matching.filter((pack) => pack.availability === "active");
  const opportunities = sortedPacks(active, normalizeListPublicPacksInput({ filters: request.filters })).slice(0, 6);
  const selected = opportunities.find((pack) => pack.publicPackId === request.selectedPublicPackId) ?? opportunities[0] ?? null;
  const highest = active.reduce<PublicPackDetail | null>((best, pack) => {
    const value = pack.topChase.status === "available" && pack.topChase.value.usdComparison.status === "available" ? pack.topChase.value.usdComparison.value.minorUnits : -1;
    const bestValue = best?.topChase.status === "available" && best.topChase.value.usdComparison.status === "available" ? best.topChase.value.usdComparison.value.minorUnits : -1;
    return value > bestValue ? pack : best;
  }, null);
  return dashboardBundleSchema.parse({
    metadata,
    kpis: {
      totalPacks: active.length,
      positiveEvPacks: active.filter((pack) => pack.estimatedEv.evDollars.status === "available" && pack.estimatedEv.evDollars.value.minorUnits > 0).length,
      medianEvPercent: medianBasisPoints(active),
      highestChaseValue: highest?.topChase.status === "available" ? highest.topChase.value.usdComparison : { status: "unavailable", value: null, reason: "CHASE_UNAVAILABLE", nullRank: 1 },
    },
    opportunities: opportunities.map(summary),
    platformSummaries: summaries(active, "platform"),
    categorySummaries: summaries(active, "category"),
    facets: contextualFacets(DEMO_PACKS, request.filters),
    activeFilters: request.filters,
    selectedPack: selected,
  });
}

export function buildDemoCatalogPage(input: unknown = {}): ListPublicPacksPage {
  const request = normalizeListPublicPacksInput(input);
  const searched = DEMO_PACKS.filter((pack) => matchesSearch(pack, request.search));
  const matching = searched.filter((pack) => matchesFilters(pack, request.filters));
  const ordered = sortedPacks(matching, request);
  const selected = ordered.find((pack) => pack.publicPackId === request.selectedPublicPackId) ?? ordered[0] ?? null;
  return listPublicPacksPageSchema.parse({
    metadata,
    rows: ordered.slice(0, request.pageSize).map(summary),
    selectedPack: selected,
    selectedPackEligible: selected !== null,
    facets: contextualFacets(searched, request.filters),
    activeQuery: {
      search: request.search,
      filters: request.filters,
      sort: request.sort,
      direction: request.direction,
      pageSize: request.pageSize,
    },
    queryFingerprint: "a".repeat(64),
    nextCursor: null,
    hasPrevious: false,
    range: ordered.length === 0 ? { start: 0, end: 0, total: 0 } : { start: 1, end: Math.min(ordered.length, request.pageSize), total: ordered.length },
    paginationReset: null,
  });
}

export function buildDemoCatalogSnapshot(): CatalogSnapshotV1 {
  return snapshot();
}

export function demoPackDetails(): readonly PublicPackDetail[] {
  return DEMO_PACKS;
}
