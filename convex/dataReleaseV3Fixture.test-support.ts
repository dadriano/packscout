import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  packScoutPublicEvV3Schema,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailV3Schema,
  type PackScoutPublicEvV3,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
  DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
  DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN,
  EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
  MAX_DATA_RELEASE_V3_BATCH_RECORDS,
  type DataReleaseV3BatchKind,
} from "./dataReleaseV3Lifecycle";
import {
  DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
  MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
} from "./dataReleaseV3Search";

/** Deterministic, clock-relative fixtures for data_release_v3 tests. */

export const V3_FIXTURE_NOW = Date.now();
export const V3_OBSERVED_AT = new Date(V3_FIXTURE_NOW - 5 * 60_000).toISOString();
export const V3_EXPIRES_AT = new Date(
  Date.parse(V3_OBSERVED_AT) + 60 * 60_000,
).toISOString();
export const V3_SOLD_OUT_AT = new Date(V3_FIXTURE_NOW - 2 * 60_000).toISOString();
export const V3_PACK_PRICE_MINOR = 10_000;

export const V3_VENDOR_ID = "00000000-0000-5000-8000-000000000001";
export const V3_CATEGORY_ID = "00000000-0000-5000-8000-000000000101";
export const V3_COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000201";
export const V3_REPACK_ID_A = "00000000-0000-5000-8000-000000000301";
export const V3_REPACK_ID_B = "00000000-0000-5000-8000-000000000302";
export const V3_REPACK_ID_C = "00000000-0000-5000-8000-000000000303";

function usd(minorUnits: number) {
  return { minorUnits, currency: "USD" as const };
}

function halfUpReturnBasisPoints(gross: number, price: number): number {
  return Number((BigInt(gross) * 10_000n * 2n + BigInt(price)) / (BigInt(price) * 2n));
}

export function buildV3Metrics(gross: number, price = V3_PACK_PRICE_MINOR) {
  const grossReturnBasisPoints = halfUpReturnBasisPoints(gross, price);
  return {
    grossEvMoney: usd(gross),
    grossReturnBasisPoints,
    evDollars: { minorUnits: gross - price, currency: "USD" as const },
    evPercentBasisPoints: grossReturnBasisPoints - 10_000,
  };
}

const V3_CONFIDENCE = {
  policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  scoreBasisPoints: 10_000,
  band: "high" as const,
  limitationCodes: [],
};

export function buildV3CurrentEv(gross: number): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "current",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildV3Metrics(gross),
    confidence: V3_CONFIDENCE,
    calculatedAt: V3_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: V3_OBSERVED_AT },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    expiresAt: V3_EXPIRES_AT,
  });
}

export function buildV3SoldOutEv(gross = 8_500): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "sold_out_historical",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: buildV3Metrics(gross),
    confidence: V3_CONFIDENCE,
    calculatedAt: V3_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: V3_OBSERVED_AT },
    sourceAge: { milliseconds: 0, state: "fresh_within_15_minutes" },
    soldOutAt: V3_SOLD_OUT_AT,
    expiresAt: null,
  });
}

export function buildV3UnavailableEv(
  reason:
    | "BUYBACK_UNAVAILABLE"
    | "SOURCE_EVIDENCE_UNAVAILABLE"
    | "PRICE_UNAVAILABLE" = "BUYBACK_UNAVAILABLE",
): PackScoutPublicEvV3 {
  return packScoutPublicEvV3Schema.parse({
    status: "unavailable",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: null,
    confidence: null,
    calculatedAt: V3_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: V3_OBSERVED_AT },
    reason,
  });
}

export function buildV3Category(): PublicCategory {
  return publicCategorySchema.parse({
    publicCategoryId: V3_CATEGORY_ID,
    parentPublicCategoryId: null,
    categoryKey: "cards",
    name: "Cards",
    kind: "vertical",
    depth: 0,
    pathPublicCategoryIds: [V3_CATEGORY_ID],
    displayOrder: 0,
  });
}

export function buildV3Collectible(): PublicCollectible {
  const name = "Charizard ex #199";
  return publicCollectibleSchema.parse({
    publicCollectibleId: V3_COLLECTIBLE_ID,
    name,
    normalizedName: normalizePublicSearchText(name),
    aliases: [],
    normalizedAliases: [],
    collectibleType: "card",
    publicCategoryIds: [V3_CATEGORY_ID],
    year: 2023,
    brand: "Pokemon",
    setOrSeries: "Obsidian Flames",
    cardNumber: "199",
    referenceNumber: null,
    subject: "Charizard",
    grade: null,
    grader: null,
    primaryImage: {
      url: "https://assets.vendor.example/collectibles/charizard.webp",
      alt: "Charizard ex card",
    },
    valuation: {
      displayMoney: usd(85_000),
      usdComparison: { status: "available", value: usd(85_000) },
      valuationType: "market_estimate",
      observedAt: V3_OBSERVED_AT,
    },
    searchText: buildPublicCollectibleSearchText({
      name,
      aliases: [],
      year: 2023,
      brand: "Pokemon",
      setOrSeries: "Obsidian Flames",
      cardNumber: "199",
      referenceNumber: null,
      subject: "Charizard",
      grade: null,
      grader: null,
    }),
    dataAsOf: V3_OBSERVED_AT,
  });
}

export function buildV3Chase(publicRepackId: string): PublicRepackChase {
  const collectible = buildV3Collectible();
  return publicRepackChaseSchema.parse({
    publicRepackId,
    publicCollectibleId: V3_COLLECTIBLE_ID,
    role: "top_chase",
    evidenceKinds: ["vendor_inventory", "vendor_odds"],
    probabilityBasisPoints: 50,
    collectible: {
      publicCollectibleId: collectible.publicCollectibleId,
      name: collectible.name,
      collectibleType: collectible.collectibleType,
      publicCategoryIds: collectible.publicCategoryIds,
      primaryImage: collectible.primaryImage,
      valuation: collectible.valuation,
    },
    matchConfidence: { scoreBasisPoints: 9_500, band: "high" },
    observedAt: V3_OBSERVED_AT,
    displayOrder: 0,
  });
}

export function buildV3Detail(
  overrides: Partial<PublicRepackDetailV3> = {},
): PublicRepackDetailV3 {
  const publicRepackId = overrides.publicRepackId ?? V3_REPACK_ID_A;
  return publicRepackDetailV3Schema.parse({
    publicRepackId,
    publicVendorId: V3_VENDOR_ID,
    vendorKey: "collector_example",
    vendorDisplayName: "Collector Example",
    vendorLogoUrl: "https://assets.vendor.example/logo.webp",
    name: "Pokemon Grail Gacha",
    format: "gacha",
    contentMode: "focused",
    categories: [{ publicCategoryId: V3_CATEGORY_ID, label: "Cards" }],
    collectibleTypes: ["card"],
    availability: "available",
    price: {
      displayMoney: usd(V3_PACK_PRICE_MINOR),
      usdComparison: { status: "available", value: usd(V3_PACK_PRICE_MINOR) },
    },
    buyback: { kind: "uniform_rate", rateBasisPoints: 8_500 },
    primaryImage: {
      url: "https://assets.vendor.example/repacks/pokemon.webp",
      alt: "Pokemon Grail Gacha",
    },
    evEstimates: {
      packScout: buildV3CurrentEv(8_500),
      vendorReported: {
        status: "available",
        sourceMoney: { minorUnits: 8_500, currency: "USD" },
        usdComparison: { status: "available", value: usd(8_500) },
        observedAt: V3_OBSERVED_AT,
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
    sourceUpdatedAt: V3_OBSERVED_AT,
    description: "A focused Pokemon gacha.",
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

export function buildV3SoldOutDetail(
  overrides: Partial<PublicRepackDetailV3> = {},
): PublicRepackDetailV3 {
  return buildV3Detail({
    availability: "sold_out",
    evEstimates: {
      packScout: buildV3SoldOutEv(),
      vendorReported: {
        status: "unavailable",
        sourceMoney: null,
        usdComparison: null,
        observedAt: null,
        reason: "NOT_REPORTED",
      },
    },
    actionAvailability: { promo: true, repackLink: false },
    actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    ...overrides,
  });
}

/**
 * A pack in one of the two availability states the four-state public
 * vocabulary added. `unavailable` and `unknown` sit on the same exclusion side
 * as `sold_out` — discoverable, never ranked, never actionable — so the
 * fixture withholds the outbound repack link exactly as the sold-out fixture
 * does. The PackScout estimate stays deliberately current: pack availability
 * and EV availability are separate axes, so a fixture that nulled the estimate
 * would let an availability guard go dead without any test noticing.
 */
export function buildV3UnpurchasableDetail(
  availability: "unavailable" | "unknown",
  overrides: Partial<PublicRepackDetailV3> = {},
): PublicRepackDetailV3 {
  return buildV3Detail({
    availability,
    actionAvailability: { promo: true, repackLink: false },
    actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    ...overrides,
  });
}

export interface V3FixturePlan {
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly manifest: {
    readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
    readonly confidencePolicyVersion:
      typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
    readonly publicEvPolicyVersion:
      typeof PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3;
    readonly dataAsOf: string;
    readonly contentHash: string;
    readonly searchAlgorithmVersion:
      typeof DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION;
    readonly counts: {
      categories: number;
      collectibles: number;
      repacks: number;
      chases: number;
      searchShards: number;
    };
    readonly entityChainHashes: Record<DataReleaseV3BatchKind, string>;
    readonly topChaseCount: number;
    readonly batchCount: number;
    readonly batchChainHash: string;
  };
  readonly batches: readonly {
    readonly batchIndex: number;
    readonly kind: DataReleaseV3BatchKind;
    readonly batchHash: string;
    readonly records: readonly unknown[];
  }[];
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: (readonly T[])[] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function buildV3FixturePlan(input: {
  readonly publicReleaseId: string;
  readonly dataAsOf?: string;
  readonly details: readonly PublicRepackDetailV3[];
  readonly categories?: readonly PublicCategory[];
  readonly collectibles?: readonly PublicCollectible[];
  readonly chases?: readonly PublicRepackChase[];
  /**
   * Overrides the manifest's declared top-chase count, which otherwise follows
   * the staged repack details. Only a dishonest-publisher fixture should set
   * this; the manifest stays internally consistent because the content hash and
   * release fingerprint are derived from whatever value lands here.
   */
  readonly topChaseCount?: number;
}): Promise<V3FixturePlan> {
  const dataAsOf = input.dataAsOf ?? V3_OBSERVED_AT;
  const categories = input.categories ?? [buildV3Category()];
  const collectibles = input.collectibles ?? [buildV3Collectible()];
  const details = [...input.details].sort((left, right) =>
    left.publicRepackId < right.publicRepackId ? -1 : 1,
  );
  const chases =
    input.chases ??
    details.flatMap((detail) =>
      detail.topChase === null ? [] : [detail.topChase],
    );
  const sortedChases = [...chases].sort((left, right) =>
    `${left.publicRepackId}:${left.publicCollectibleId}` <
    `${right.publicRepackId}:${right.publicCollectibleId}`
      ? -1
      : 1,
  );
  const entities = {
    categories,
    collectibles,
    repacks: details,
    chases: sortedChases,
  } as const;
  const batches: V3FixturePlan["batches"][number][] = [];
  let batchChainHash = EMPTY_DATA_RELEASE_V3_CHAIN_HASH;
  const entityChainHashes: Record<DataReleaseV3BatchKind, string> = {
    categories: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
    collectibles: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
    repacks: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
    chases: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
  };
  for (const kind of [
    "categories",
    "collectibles",
    "repacks",
    "chases",
  ] as const) {
    const size =
      kind === "repacks"
        ? MAX_ROWS_PER_DATA_RELEASE_V3_SHARD
        : MAX_DATA_RELEASE_V3_BATCH_RECORDS;
    for (const records of chunk(entities[kind] as readonly unknown[], size)) {
      const batchHash = await sha256CanonicalJson(
        DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
        { kind, records },
      );
      const batchIndex = batches.length;
      batches.push({ batchIndex, kind, batchHash, records });
      batchChainHash = await sha256CanonicalJson(
        DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
        {
          previousHash: batchChainHash,
          batchIndex,
          kind,
          batchHash,
          recordCount: records.length,
        },
      );
      entityChainHashes[kind] = await sha256CanonicalJson(
        DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
        { previousHash: entityChainHashes[kind], batchHash },
      );
    }
  }
  const topChaseCount =
    input.topChaseCount ??
    details.filter(({ topChase }) => topChase !== null).length;
  const counts = {
    categories: categories.length,
    collectibles: collectibles.length,
    repacks: details.length,
    chases: sortedChases.length,
    searchShards: Math.ceil(details.length / MAX_ROWS_PER_DATA_RELEASE_V3_SHARD),
  };
  const contentHash = await sha256CanonicalJson(
    DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
    { counts, entityChainHashes, topChaseCount },
  );
  const releaseFingerprint = await sha256CanonicalJson(
    DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN,
    {
      schemaVersion: "data_release_v3",
      publicReleaseId: input.publicReleaseId,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
      dataAsOf,
      contentHash,
      searchAlgorithmVersion: DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
      batchCount: batches.length,
      batchChainHash,
    },
  );
  return {
    publicReleaseId: input.publicReleaseId,
    releaseFingerprint,
    manifest: {
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
      dataAsOf,
      contentHash,
      searchAlgorithmVersion: DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
      counts,
      entityChainHashes,
      topChaseCount,
      batchCount: batches.length,
      batchChainHash,
    },
    batches,
  };
}

export async function sha256HexOfText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface V3ExecutionBody {
  readonly bodyJson: string;
  readonly requestDigest: string;
}

export async function v3Body(request: unknown): Promise<V3ExecutionBody> {
  const bodyJson = JSON.stringify(request);
  return { bodyJson, requestDigest: await sha256HexOfText(bodyJson) };
}

export function v3StartRequest(plan: V3FixturePlan) {
  return {
    schemaVersion: "data_release_v3",
    operationId: `${plan.publicReleaseId}:start`,
    idempotencyKey: `${plan.publicReleaseId}:start`,
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    manifest: plan.manifest,
  };
}

export function v3BatchRequest(
  plan: V3FixturePlan,
  batch: V3FixturePlan["batches"][number],
) {
  return {
    schemaVersion: "data_release_v3",
    operationId: `${plan.publicReleaseId}:batch:${batch.batchIndex}`,
    idempotencyKey: `${plan.publicReleaseId}:batch:${batch.batchIndex}`,
    publicReleaseId: plan.publicReleaseId,
    batchIndex: batch.batchIndex,
    kind: batch.kind,
    batchHash: batch.batchHash,
    records: batch.records,
  };
}

export function v3FinalizeRequest(plan: V3FixturePlan) {
  return {
    schemaVersion: "data_release_v3",
    operationId: `${plan.publicReleaseId}:finalize`,
    idempotencyKey: `${plan.publicReleaseId}:finalize`,
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    expectedCounts: plan.manifest.counts,
    expectedEntityChainHashes: plan.manifest.entityChainHashes,
    expectedTopChaseCount: plan.manifest.topChaseCount,
    expectedBatchCount: plan.manifest.batchCount,
    expectedBatchChainHash: plan.manifest.batchChainHash,
  };
}

export function v3ActivateRequest(
  plan: V3FixturePlan,
  expectedActivePublicReleaseId: string | null,
) {
  return {
    schemaVersion: "data_release_v3",
    operationId: `${plan.publicReleaseId}:activate:${expectedActivePublicReleaseId ?? "genesis"}`,
    idempotencyKey: `${plan.publicReleaseId}:activate:${expectedActivePublicReleaseId ?? "genesis"}`,
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    expectedActivePublicReleaseId,
  };
}

export function v3RollbackRequest(
  expectedActivePublicReleaseId: string,
  targetPublicReleaseId: string,
) {
  return {
    schemaVersion: "data_release_v3",
    operationId: `rollback:${expectedActivePublicReleaseId}:${targetPublicReleaseId}`,
    idempotencyKey: `rollback:${expectedActivePublicReleaseId}:${targetPublicReleaseId}`,
    expectedActivePublicReleaseId,
    targetPublicReleaseId,
  };
}
