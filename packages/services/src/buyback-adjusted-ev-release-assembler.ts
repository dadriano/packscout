import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3,
  containsProtectedEvPublicationKeyV3,
  containsProtectedPublicationField,
  parsePackScoutBuybackEvTimestampMillisV1,
  publicRepackDetailV3Schema,
  sha256CanonicalJson,
  type PackScoutPublicEvSourceAgeStateV3,
  type PackScoutPublicEvV3,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import type { PackScoutBuybackEvPublicationEligibilityV1 } from "./buyback-adjusted-ev-recomputation-contracts.ts";
import {
  DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
  DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
  DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN,
  DATA_RELEASE_V3_RELEASE_ID_DOMAIN,
  DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
  EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
  MAX_DATA_RELEASE_V3_BATCH_RECORDS,
  MAX_DATA_RELEASE_V3_CATEGORIES,
  MAX_DATA_RELEASE_V3_CHASES,
  MAX_DATA_RELEASE_V3_COLLECTIBLES,
  MAX_DATA_RELEASE_V3_REPACKS,
  MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
  type DataReleaseV3AssemblyBlockReason,
  type DataReleaseV3Batch,
  type DataReleaseV3BatchKind,
  type DataReleaseV3CanonicalCatalogPort,
  type DataReleaseV3CanonicalProduct,
  type DataReleaseV3EligibilityPort,
  type DataReleaseV3EntityChainHashes,
  type DataReleaseV3Plan,
} from "./buyback-adjusted-ev-release-types.ts";

/**
 * data_release_v3 release assembler (task buyback-adjusted-ev/008).
 *
 * Reads one repeatable canonical state — catalog products, prices, vendor
 * EV, availability, actions, categories, collectibles, chases, and the
 * task-006 publication-eligible completed EV revision per product, all at one
 * `readAt` clock — and emits a deterministic publish plan of sanitized
 * task-007 entities with reconciliation hashes. Identical inputs replay to a
 * byte-identical plan (same public release identity, batches, and
 * fingerprint); any incomplete, mixed-version, protected, or incoherent input
 * blocks the plan instead of degrading it.
 */

class AssemblyBlock extends Error {
  constructor(
    readonly reason: DataReleaseV3AssemblyBlockReason,
    readonly productKey: string | null,
  ) {
    super(reason);
    this.name = "DataReleaseV3AssemblyBlock";
  }
}

function block(
  reason: DataReleaseV3AssemblyBlockReason,
  productKey: string | null = null,
): never {
  throw new AssemblyBlock(reason, productKey);
}

function sourceAgeState(
  ageMilliseconds: number,
): PackScoutPublicEvSourceAgeStateV3 {
  if (ageMilliseconds > 30 * 60_000) {
    return "delayed_over_30_through_60_minutes";
  }
  if (ageMilliseconds > 15 * 60_000) {
    return "delayed_over_15_through_30_minutes";
  }
  return "fresh_within_15_minutes";
}

function requireTimestamp(value: string, productKey: string | null): number {
  const parsed = parsePackScoutBuybackEvTimestampMillisV1(value);
  if (parsed === null) block("CANONICAL_SNAPSHOT_INVALID", productKey);
  return parsed;
}

/**
 * Composes the public PackScout EV state for one product from its
 * publication-eligible revision at the release read clock.
 *
 * - A publishable available revision becomes the frozen `current` estimate.
 * - `expired_since_calculation` fails closed into the deterministic
 *   `SOURCE_DATA_STALE` state evaluated at the read clock, so a missed expiry
 *   transition can never publish a live estimate.
 * - A sold-out product freezes the last estimate that was still current at
 *   sellout as explicit history; an incoherent freeze blocks the release.
 * - A missing revision is an explicit unknown-time unavailable state.
 */
function composePackScoutPublicEv(
  product: DataReleaseV3CanonicalProduct,
  eligibility: PackScoutBuybackEvPublicationEligibilityV1 | null,
  readAt: string,
): PackScoutPublicEvV3 {
  const versions = {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  } as const;
  if (
    eligibility !== null &&
    (eligibility.revision.methodVersion !== versions.methodVersion ||
      eligibility.revision.confidencePolicyVersion !==
        versions.confidencePolicyVersion)
  ) {
    block("MIXED_CALCULATION_VERSIONS", product.productKey);
  }
  if (eligibility === null) {
    return {
      status: "unavailable",
      ...versions,
      metrics: null,
      confidence: null,
      calculatedAt: readAt,
      dataAsOf: { state: "unknown_source_time", observedAt: null },
      reason: "SOURCE_EVIDENCE_UNAVAILABLE",
    };
  }
  const projection = eligibility.projection;
  if (projection.status === "unavailable") {
    return {
      status: "unavailable",
      ...versions,
      metrics: null,
      confidence: null,
      calculatedAt: projection.calculatedAt,
      dataAsOf:
        projection.dataAsOf.state === "known"
          ? { state: "known", observedAt: projection.dataAsOf.observedAt }
          : { state: "unknown_source_time", observedAt: null },
      reason: projection.publicReason,
    };
  }
  const observedAt = projection.dataAsOf.observedAt;
  const violatesPublicEvPolicy =
    projection.metrics.grossReturnBasisPoints > 10_000 ||
    projection.metrics.evDollars.minorUnits > 0 ||
    projection.metrics.evPercentBasisPoints > 0;
  const unavailableByPublicEvPolicy = (): PackScoutPublicEvV3 => ({
    status: "unavailable",
    ...versions,
    metrics: null,
    confidence: null,
    calculatedAt: projection.calculatedAt,
    dataAsOf: { state: "known", observedAt },
    reason: "CALCULATION_UNAVAILABLE",
  });
  const frozenObservation = {
    metrics: {
      grossEvMoney: { ...projection.metrics.grossEvMoney },
      grossReturnBasisPoints: projection.metrics.grossReturnBasisPoints,
      evDollars: { ...projection.metrics.evDollars },
      evPercentBasisPoints: projection.metrics.evPercentBasisPoints,
    },
    confidence: {
      policyVersion: projection.confidence.policyVersion,
      scoreBasisPoints: projection.confidence.scoreBasisPoints,
      band: projection.confidence.band,
      limitationCodes: [...projection.confidence.limitationCodes],
    },
    calculatedAt: projection.calculatedAt,
    dataAsOf: { state: "known", observedAt } as const,
    sourceAge: {
      milliseconds: projection.sourceAgeMilliseconds,
      state: sourceAgeState(projection.sourceAgeMilliseconds),
    },
  };
  if (product.availability === "sold_out") {
    if (product.soldOutAt === null) {
      block("SOLD_OUT_FREEZE_INCOHERENT", product.productKey);
    }
    const soldOutMillis = requireTimestamp(product.soldOutAt, product.productKey);
    const observedMillis = requireTimestamp(observedAt, product.productKey);
    const calculatedMillis = requireTimestamp(
      projection.calculatedAt,
      product.productKey,
    );
    if (
      soldOutMillis >= calculatedMillis &&
      soldOutMillis - observedMillis <=
        PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3
    ) {
      if (violatesPublicEvPolicy) return unavailableByPublicEvPolicy();
      return {
        status: "sold_out_historical",
        ...versions,
        ...frozenObservation,
        soldOutAt: product.soldOutAt,
        expiresAt: null,
      };
    }
    if (
      requireTimestamp(readAt, product.productKey) - observedMillis <=
      PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3
    ) {
      // A sellout inside the freshness window with an unfreezable estimate is
      // an incoherent snapshot, never a silently degraded public state.
      block("SOLD_OUT_FREEZE_INCOHERENT", product.productKey);
    }
    return {
      status: "unavailable",
      ...versions,
      metrics: null,
      confidence: null,
      calculatedAt: readAt,
      dataAsOf: { state: "known", observedAt },
      reason: "SOURCE_DATA_STALE",
    };
  }
  if (eligibility.readState.state === "expired_since_calculation") {
    return {
      status: "unavailable",
      ...versions,
      metrics: null,
      confidence: null,
      calculatedAt: readAt,
      dataAsOf: { state: "known", observedAt },
      reason: "SOURCE_DATA_STALE",
    };
  }
  if (violatesPublicEvPolicy) return unavailableByPublicEvPolicy();
  return {
    status: "current",
    ...versions,
    ...frozenObservation,
    expiresAt: projection.expiresAt,
  };
}

function assertStrictlySortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  reason: DataReleaseV3AssemblyBlockReason,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) >= key(values[index]!)) block(reason);
  }
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: (readonly T[])[] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function uuidFromSha256(hex: string): string {
  // RFC 9562 version-8 UUID carved from a domain-separated digest: replay
  // deterministic, contract-valid, and never colliding with random v4 ids
  // minted by other release families.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class DataReleaseV3ReleaseAssembler {
  constructor(
    private readonly catalog: DataReleaseV3CanonicalCatalogPort,
    private readonly eligibility: DataReleaseV3EligibilityPort,
  ) {}

  async assemble(input: { readonly readAt: string }): Promise<DataReleaseV3Plan> {
    try {
      return await this.assembleOrBlock(input.readAt);
    } catch (error) {
      if (error instanceof AssemblyBlock) {
        return {
          classification: "blocked",
          reason: error.reason,
          blockedProductKey: error.productKey,
        };
      }
      throw error;
    }
  }

  private async assembleOrBlock(readAt: string): Promise<DataReleaseV3Plan> {
    requireTimestamp(readAt, null);
    const snapshot = await this.catalog.loadCatalogSnapshot({ readAt });
    if (
      snapshot.products.length > MAX_DATA_RELEASE_V3_REPACKS ||
      snapshot.categories.length > MAX_DATA_RELEASE_V3_CATEGORIES ||
      snapshot.collectibles.length > MAX_DATA_RELEASE_V3_COLLECTIBLES ||
      snapshot.chases.length > MAX_DATA_RELEASE_V3_CHASES
    ) {
      block("CAPACITY_EXCEEDED");
    }
    const products = [...snapshot.products].sort((left, right) =>
      left.publicRepackId < right.publicRepackId ? -1 : 1,
    );
    assertStrictlySortedUnique(
      products,
      ({ publicRepackId }) => publicRepackId,
      "CANONICAL_SNAPSHOT_INVALID",
    );
    const categories = [...snapshot.categories].sort((left, right) =>
      left.publicCategoryId < right.publicCategoryId ? -1 : 1,
    );
    assertStrictlySortedUnique(
      categories,
      ({ publicCategoryId }) => publicCategoryId,
      "CANONICAL_SNAPSHOT_INVALID",
    );
    const collectibles = [...snapshot.collectibles].sort((left, right) =>
      left.publicCollectibleId < right.publicCollectibleId ? -1 : 1,
    );
    assertStrictlySortedUnique(
      collectibles,
      ({ publicCollectibleId }) => publicCollectibleId,
      "CANONICAL_SNAPSHOT_INVALID",
    );
    const chaseKey = (chase: { publicRepackId: string; publicCollectibleId: string }) =>
      `${chase.publicRepackId}:${chase.publicCollectibleId}`;
    const chases = [...snapshot.chases].sort((left, right) =>
      chaseKey(left) < chaseKey(right) ? -1 : 1,
    );
    assertStrictlySortedUnique(chases, chaseKey, "CANONICAL_SNAPSHOT_INVALID");
    const chaseByKey = new Map(chases.map((chase) => [chaseKey(chase), chase]));

    const details: PublicRepackDetailV3[] = [];
    let topChaseCount = 0;
    for (const product of products) {
      const eligibility = await this.eligibility.getPublicationEligibleRevision({
        organizationId: snapshot.organizationId,
        platformKey: product.platformKey,
        productKey: product.productKey,
        readAt,
      });
      const packScout = composePackScoutPublicEv(product, eligibility, readAt);
      const parsed = publicRepackDetailV3Schema.safeParse({
        publicRepackId: product.publicRepackId,
        publicVendorId: product.publicVendorId,
        vendorKey: product.vendorKey,
        vendorDisplayName: product.vendorDisplayName,
        vendorLogoUrl: product.vendorLogoUrl,
        name: product.name,
        format: product.format,
        contentMode: product.contentMode,
        categories: product.categories,
        collectibleTypes: product.collectibleTypes,
        availability: product.availability,
        price: product.price,
        buyback: product.buyback,
        primaryImage: product.primaryImage,
        evEstimates: {
          packScout,
          vendorReported: product.vendorReportedEv,
        },
        topChase: product.topChase,
        contentSummary: product.contentSummary,
        actionAvailability: product.actionAvailability,
        sourceUpdatedAt: product.sourceUpdatedAt,
        description: product.description,
        actions: product.actions,
      });
      if (!parsed.success) {
        block("PUBLIC_CONTRACT_INVALID", product.productKey);
      }
      const detail = parsed.data;
      if (detail.topChase !== null) {
        const staged = chaseByKey.get(chaseKey(detail.topChase));
        if (
          staged === undefined ||
          JSON.stringify(staged) !== JSON.stringify(detail.topChase)
        ) {
          block("CANONICAL_SNAPSHOT_INVALID", product.productKey);
        }
        topChaseCount += 1;
      }
      details.push(detail);
    }
    const entities = {
      categories,
      collectibles,
      repacks: details,
      chases,
    } as const;
    if (
      containsProtectedEvPublicationKeyV3(entities) ||
      containsProtectedPublicationField(entities)
    ) {
      block("PROTECTED_PUBLICATION_FIELD");
    }

    const batches: DataReleaseV3Batch[] = [];
    let batchChainHash = EMPTY_DATA_RELEASE_V3_CHAIN_HASH;
    const entityChainHashes: Record<keyof DataReleaseV3EntityChainHashes, string> = {
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
    ] as const satisfies readonly DataReleaseV3BatchKind[]) {
      const size =
        kind === "repacks"
          ? MAX_ROWS_PER_DATA_RELEASE_V3_SHARD
          : MAX_DATA_RELEASE_V3_BATCH_RECORDS;
      const kindRecords = entities[kind] as DataReleaseV3Batch["records"];
      for (const records of chunk(kindRecords, size)) {
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
    const counts = {
      categories: categories.length,
      collectibles: collectibles.length,
      repacks: details.length,
      chases: chases.length,
      searchShards: Math.ceil(
        details.length / MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
      ),
    };
    const contentHash = await sha256CanonicalJson(
      DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
      { counts, entityChainHashes, topChaseCount },
    );
    const publicReleaseId = uuidFromSha256(
      await sha256CanonicalJson(DATA_RELEASE_V3_RELEASE_ID_DOMAIN, {
        methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
        confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
        dataAsOf: readAt,
        contentHash,
        searchAlgorithmVersion: DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
        batchCount: batches.length,
        batchChainHash,
      }),
    );
    const releaseFingerprint = await sha256CanonicalJson(
      DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN,
      {
        schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
        publicReleaseId,
        methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
        confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
        dataAsOf: readAt,
        contentHash,
        searchAlgorithmVersion: DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
        batchCount: batches.length,
        batchChainHash,
      },
    );
    return {
      classification: "publish",
      publicReleaseId,
      releaseFingerprint,
      manifest: {
        methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
        confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
        dataAsOf: readAt,
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
}
