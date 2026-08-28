import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  buildPublicCollectibleSearchText,
  canonicalJson,
  normalizePublicSearchText,
  sha256CanonicalJson,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
} from "@packscout/contracts";
import type {
  PackScoutBuybackEvPublicationEligibilityV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import {
  PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION,
  type PackScoutBuybackEvRevisionIdentityRecordV1,
  type PackScoutBuybackEvRevisionPublicationProjectionV1,
} from "./buyback-adjusted-ev-revision-contracts.ts";
import {
  DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
  DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
  DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
  EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
  MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
  type DataReleaseV3ActivateRequest,
  type DataReleaseV3ActiveState,
  type DataReleaseV3ApplyBatchRequest,
  type DataReleaseV3CanonicalProduct,
  type DataReleaseV3CanonicalSnapshot,
  type DataReleaseV3FinalizeRequest,
  type DataReleaseV3PublicationPort,
  type DataReleaseV3Pointer,
  type DataReleaseV3Receipt,
  type DataReleaseV3ReleaseStatus,
  type DataReleaseV3RollbackRequest,
  type DataReleaseV3StartRequest,
} from "./buyback-adjusted-ev-release-types.ts";

export const RELEASE_TEST_NOW = Date.now();
export const RELEASE_READ_AT = new Date(RELEASE_TEST_NOW).toISOString();
export const RELEASE_OBSERVED_AT = new Date(
  RELEASE_TEST_NOW - 5 * 60_000,
).toISOString();
export const RELEASE_EXPIRES_AT = new Date(
  Date.parse(RELEASE_OBSERVED_AT) + 60 * 60_000,
).toISOString();
export const RELEASE_SOLD_OUT_AT = new Date(
  RELEASE_TEST_NOW - 2 * 60_000,
).toISOString();

export const RELEASE_ORGANIZATION_ID = "20000000-0000-4000-8000-000000000009";
export const RELEASE_CATEGORY_ID = "00000000-0000-5000-8000-000000000101";
export const RELEASE_COLLECTIBLE_ID = "00000000-0000-5000-8000-000000000201";

function usd(minorUnits: number) {
  return { minorUnits, currency: "USD" as const };
}

export function buildReleaseCategory(): PublicCategory {
  return {
    publicCategoryId: RELEASE_CATEGORY_ID,
    parentPublicCategoryId: null,
    categoryKey: "cards",
    name: "Cards",
    kind: "vertical",
    depth: 0,
    pathPublicCategoryIds: [RELEASE_CATEGORY_ID],
    displayOrder: 0,
  };
}

export function buildReleaseCollectible(): PublicCollectible {
  const name = "Charizard ex #199";
  return {
    publicCollectibleId: RELEASE_COLLECTIBLE_ID,
    name,
    normalizedName: normalizePublicSearchText(name),
    aliases: [],
    normalizedAliases: [],
    collectibleType: "card",
    publicCategoryIds: [RELEASE_CATEGORY_ID],
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
      observedAt: RELEASE_OBSERVED_AT,
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
    dataAsOf: RELEASE_OBSERVED_AT,
  };
}

export function buildReleaseChase(publicRepackId: string): PublicRepackChase {
  const collectible = buildReleaseCollectible();
  return {
    publicRepackId,
    publicCollectibleId: RELEASE_COLLECTIBLE_ID,
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
    observedAt: RELEASE_OBSERVED_AT,
    displayOrder: 0,
  };
}

export function buildReleaseProduct(
  overrides: Partial<DataReleaseV3CanonicalProduct> = {},
): DataReleaseV3CanonicalProduct {
  const publicRepackId =
    overrides.publicRepackId ?? "00000000-0000-5000-8000-000000000301";
  return {
    platformKey: "collector_example",
    productKey: `product-${publicRepackId}`,
    publicRepackId,
    publicVendorId: "00000000-0000-5000-8000-000000000001",
    vendorKey: "collector_example",
    vendorDisplayName: "Collector Example",
    vendorLogoUrl: "https://assets.vendor.example/logo.webp",
    name: "Pokemon Grail Gacha",
    format: "gacha",
    contentMode: "focused",
    categories: [{ publicCategoryId: RELEASE_CATEGORY_ID, label: "Cards" }],
    collectibleTypes: ["card"],
    availability: "available",
    soldOutAt: null,
    price: {
      displayMoney: usd(10_000),
      usdComparison: { status: "available", value: usd(10_000) },
    },
    buyback: { kind: "uniform_rate", rateBasisPoints: 8_500 },
    vendorReportedEv: {
      status: "unavailable",
      sourceMoney: null,
      usdComparison: null,
      observedAt: null,
      reason: "NOT_REPORTED",
    },
    primaryImage: {
      url: "https://assets.vendor.example/repacks/pokemon.webp",
      alt: "Pokemon Grail Gacha",
    },
    topChase: buildReleaseChase(publicRepackId),
    contentSummary: {
      knownCollectibleCount: 1,
      chaseCount: 1,
      categoryCount: 1,
      collectibleTypeCount: 1,
      evidenceCompleteness: "complete",
      probabilityCoverageBasisPoints: 10_000,
    },
    actionAvailability: { promo: true, repackLink: true },
    sourceUpdatedAt: RELEASE_OBSERVED_AT,
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
  };
}

export function buildReleaseSnapshot(
  products: readonly DataReleaseV3CanonicalProduct[],
  overrides: Partial<DataReleaseV3CanonicalSnapshot> = {},
): DataReleaseV3CanonicalSnapshot {
  return {
    organizationId: RELEASE_ORGANIZATION_ID,
    products,
    categories: [buildReleaseCategory()],
    collectibles: [buildReleaseCollectible()],
    chases: products.flatMap((product) =>
      product.topChase === null ? [] : [product.topChase],
    ),
    ...overrides,
  };
}

function halfUpReturnBasisPoints(gross: number, price: number): number {
  return Number(
    (BigInt(gross) * 10_000n * 2n + BigInt(price)) / (BigInt(price) * 2n),
  );
}

export function buildAvailableProjection(
  gross = 8_500,
  price = 10_000,
): Extract<
  PackScoutBuybackEvRevisionPublicationProjectionV1,
  { status: "available" }
> {
  const grossReturnBasisPoints = halfUpReturnBasisPoints(gross, price);
  return {
    schemaVersion: PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION,
    status: "available",
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    metrics: {
      grossEvMoney: usd(gross),
      grossReturnBasisPoints,
      evDollars: { minorUnits: gross - price, currency: "USD" },
      evPercentBasisPoints: grossReturnBasisPoints - 10_000,
    },
    confidence: {
      policyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      scoreBasisPoints: 10_000,
      band: "high",
      limitationCodes: [],
    },
    calculatedAt: RELEASE_OBSERVED_AT,
    dataAsOf: { state: "known", observedAt: RELEASE_OBSERVED_AT },
    sourceAgeMilliseconds: 0,
    expiresAt: RELEASE_EXPIRES_AT,
  };
}

export function buildRevisionIdentity(
  status: "available" | "unavailable",
): PackScoutBuybackEvRevisionIdentityRecordV1 {
  return {
    revisionId: "30000000-0000-4000-8000-000000000001",
    revisionNumber: 1,
    status,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    calculationKey: "1".repeat(64),
    effectiveFingerprint: "2".repeat(64),
    resultHash: "3".repeat(64),
    calculatedAt: RELEASE_OBSERVED_AT,
  };
}

export function buildPublishableEligibility(
  gross = 8_500,
): PackScoutBuybackEvPublicationEligibilityV1 {
  return {
    revision: buildRevisionIdentity("available"),
    projection: buildAvailableProjection(gross),
    readState: { state: "publishable", availability: "AVAILABLE" },
    evaluatedAt: RELEASE_READ_AT,
  };
}

export function buildExpiredEligibility(): PackScoutBuybackEvPublicationEligibilityV1 {
  return {
    revision: buildRevisionIdentity("available"),
    projection: buildAvailableProjection(),
    readState: {
      state: "expired_since_calculation",
      staleSince: RELEASE_EXPIRES_AT,
    },
    evaluatedAt: RELEASE_READ_AT,
  };
}

export function buildUnavailableEligibility(
  publicReason:
    | "BUYBACK_UNAVAILABLE"
    | "PRICE_UNAVAILABLE"
    | "SOURCE_EVIDENCE_UNAVAILABLE" = "BUYBACK_UNAVAILABLE",
): PackScoutBuybackEvPublicationEligibilityV1 {
  return {
    revision: buildRevisionIdentity("unavailable"),
    projection: {
      schemaVersion: PACKSCOUT_BUYBACK_EV_REVISION_PROJECTION_SCHEMA_VERSION,
      status: "unavailable",
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      metrics: null,
      confidence: null,
      calculatedAt: RELEASE_OBSERVED_AT,
      dataAsOf: { state: "known", observedAt: RELEASE_OBSERVED_AT },
      publicReason,
    },
    readState: { state: "publishable", availability: "UNAVAILABLE" },
    evaluatedAt: RELEASE_READ_AT,
  };
}

/**
 * In-memory protocol double for the data_release_v3 publication port. It
 * mirrors the Convex lifecycle semantics the publisher depends on: exact
 * operation replay, conflicting-operation refusal, batch chaining, finalize
 * reconciliation, atomic activation with a retained predecessor, and
 * previous-only rollback.
 */
export class InMemoryDataReleaseV3Port implements DataReleaseV3PublicationPort {
  private readonly operations = new Map<string, DataReleaseV3Receipt>();
  private readonly operationDigests = new Map<string, string>();
  readonly releases = new Map<
    string,
    {
      request: DataReleaseV3StartRequest;
      lifecycle: "staging" | "complete" | "failed";
      acceptedBatchCount: number;
      acceptedBatchChainHash: string;
      acceptedEntityChainHashes: Record<string, string>;
      acceptedCounts: Record<string, number>;
      // The same split tally the real lifecycle keeps: `declared` is what the
      // staged repack details advertise, `verified` is what staged chase rows
      // canonically confirm. Modelling only the declared half would make this
      // double accept releases `convex/dataReleaseV3Lifecycle.ts` refuses at
      // finalize, so every services test would be validating against a more
      // permissive server than production.
      acceptedTopChaseCount: number;
      acceptedVerifiedTopChaseCount: number;
      /** publicRepackId -> canonical JSON of the top chase it declares. */
      declaredTopChases: Map<string, string>;
      acceptedSearchRowCount: number;
      acceptedSearchRowSetHash: string;
      completedAt: string | null;
    }
  >();
  state: DataReleaseV3ActiveState = {
    generation: 0,
    activeRelease: null,
    previousRelease: null,
  };
  failNextApplyBatch = false;
  tamperNextReceipt = false;

  private async receipt(
    input: Omit<DataReleaseV3Receipt, "receiptDigest" | "requestDigest"> & {
      request: unknown;
    },
  ): Promise<DataReleaseV3Receipt> {
    const { request, ...rest } = input;
    const requestDigest = await sha256CanonicalJson(
      "packscout.test.request",
      request,
    );
    const existingDigest = this.operationDigests.get(rest.operationId);
    if (existingDigest !== undefined) {
      if (existingDigest !== requestDigest) {
        throw new Error("PUBLICATION_OPERATION_CONFLICT");
      }
      return this.operations.get(rest.operationId)!;
    }
    const body = { ...rest, requestDigest };
    const receiptDigest = await sha256CanonicalJson(
      DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
      body,
    );
    let receipt: DataReleaseV3Receipt = { ...body, receiptDigest };
    if (this.tamperNextReceipt) {
      this.tamperNextReceipt = false;
      receipt = { ...receipt, result: `${receipt.result}-tampered` };
    }
    this.operations.set(rest.operationId, receipt);
    this.operationDigests.set(rest.operationId, requestDigest);
    return receipt;
  }

  async activeState(): Promise<DataReleaseV3ActiveState> {
    return this.state;
  }

  async status(
    publicReleaseId: string,
  ): Promise<DataReleaseV3ReleaseStatus | null> {
    const release = this.releases.get(publicReleaseId);
    if (release === undefined) return null;
    return {
      publicReleaseId,
      releaseFingerprint: release.request.releaseFingerprint,
      lifecycle: release.lifecycle,
      acceptedCounts:
        release.acceptedCounts as unknown as DataReleaseV3ReleaseStatus["acceptedCounts"],
      acceptedBatchCount: release.acceptedBatchCount,
      acceptedBatchChainHash: release.acceptedBatchChainHash,
      acceptedEntityChainHashes:
        release.acceptedEntityChainHashes as unknown as DataReleaseV3ReleaseStatus["acceptedEntityChainHashes"],
      acceptedSearchRowCount: release.acceptedSearchRowCount,
      acceptedSearchRowSetHash: release.acceptedSearchRowSetHash,
      acceptedTopChaseCount: release.acceptedTopChaseCount,
      acceptedVerifiedTopChaseCount: release.acceptedVerifiedTopChaseCount,
      completedAt: release.completedAt,
    };
  }

  async start(request: DataReleaseV3StartRequest): Promise<DataReleaseV3Receipt> {
    const existing = this.releases.get(request.publicReleaseId);
    if (
      existing !== undefined &&
      existing.request.releaseFingerprint !== request.releaseFingerprint
    ) {
      throw new Error("PUBLICATION_OPERATION_CONFLICT");
    }
    const result =
      existing === undefined
        ? "started"
        : existing.lifecycle === "complete"
          ? "already_complete"
          : "resumed";
    if (existing === undefined) {
      this.releases.set(request.publicReleaseId, {
        request,
        lifecycle: "staging",
        acceptedBatchCount: 0,
        acceptedBatchChainHash: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        acceptedEntityChainHashes: {
          categories: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
          collectibles: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
          repacks: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
          chases: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        },
        acceptedCounts: {
          categories: 0,
          collectibles: 0,
          repacks: 0,
          chases: 0,
          searchShards: 0,
        },
        acceptedTopChaseCount: 0,
        acceptedVerifiedTopChaseCount: 0,
        declaredTopChases: new Map(),
        acceptedSearchRowCount: 0,
        acceptedSearchRowSetHash: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
        completedAt: null,
      });
    }
    return this.receipt({
      schemaVersion: "data_release_v3",
      operationKind: "start",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result,
      serverTime: new Date().toISOString(),
      details: {},
      request,
    });
  }

  async applyBatch(
    request: DataReleaseV3ApplyBatchRequest,
  ): Promise<DataReleaseV3Receipt> {
    if (this.failNextApplyBatch) {
      this.failNextApplyBatch = false;
      throw new Error("PUBLICATION_INTERNAL_ERROR");
    }
    const release = this.releases.get(request.publicReleaseId);
    if (release === undefined || release.lifecycle !== "staging") {
      throw new Error("PUBLICATION_STATE_CONFLICT");
    }
    const replayDigest = this.operationDigests.get(request.operationId);
    if (replayDigest === undefined) {
      const declared = await sha256CanonicalJson(
        DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
        { kind: request.kind, records: request.records },
      );
      if (declared !== request.batchHash) {
        throw new Error("PUBLICATION_BATCH_CONFLICT");
      }
      if (request.batchIndex !== release.acceptedBatchCount) {
        throw new Error("PUBLICATION_BATCH_OUT_OF_ORDER");
      }
      release.acceptedBatchChainHash = await sha256CanonicalJson(
        DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
        {
          previousHash: release.acceptedBatchChainHash,
          batchIndex: request.batchIndex,
          kind: request.kind,
          batchHash: request.batchHash,
          recordCount: request.records.length,
        },
      );
      release.acceptedEntityChainHashes[request.kind] = await sha256CanonicalJson(
        DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
        {
          previousHash: release.acceptedEntityChainHashes[request.kind],
          batchHash: request.batchHash,
        },
      );
      release.acceptedCounts[request.kind] =
        (release.acceptedCounts[request.kind] ?? 0) + request.records.length;
      release.acceptedBatchCount += 1;
      if (request.kind === "repacks") {
        release.acceptedCounts.searchShards =
          (release.acceptedCounts.searchShards ?? 0) + 1;
        release.acceptedSearchRowCount += request.records.length;
        release.acceptedSearchRowSetHash = await sha256CanonicalJson(
          "packscout.test.search-row-set",
          { previous: release.acceptedSearchRowSetHash, batch: request.batchHash },
        );
        // A repack detail advertising a top chase only *declares* one; the
        // chase row that proves it arrives in a later batch.
        for (const record of request.records as readonly {
          publicRepackId: string;
          topChase: unknown | null;
        }[]) {
          if (record.topChase === null) continue;
          release.acceptedTopChaseCount += 1;
          release.declaredTopChases.set(
            record.publicRepackId,
            canonicalJson(record.topChase),
          );
        }
      } else if (request.kind === "chases") {
        // Mirrors `assertStagedReferences` in `convex/dataReleaseV3Lifecycle.ts`:
        // a chase row verifies a declared top chase only when it canonically
        // equals the repack detail's own `topChase`. Chase keys are unique per
        // (repack, collectible) across a release and a match requires equality
        // with that single declared value, so `verified` can never exceed
        // `declared`.
        for (const record of request.records as readonly {
          publicRepackId: string;
          role: string;
        }[]) {
          if (record.role !== "top_chase") continue;
          // Production refuses outright rather than merely declining to
          // count, so the double must too: a double that accepts a release
          // the real server rejects makes every test through it meaningless.
          if (
            release.declaredTopChases.get(record.publicRepackId) !==
            canonicalJson(record)
          ) {
            throw new Error("PUBLICATION_REFERENCE_INVALID");
          }
          release.acceptedVerifiedTopChaseCount += 1;
        }
      }
    }
    return this.receipt({
      schemaVersion: "data_release_v3",
      operationKind: "applyBatch",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result: "accepted",
      serverTime: new Date().toISOString(),
      details: { batchIndex: request.batchIndex },
      request,
    });
  }

  async finalize(
    request: DataReleaseV3FinalizeRequest,
  ): Promise<DataReleaseV3Receipt> {
    const release = this.releases.get(request.publicReleaseId);
    if (release === undefined) throw new Error("PUBLICATION_STATE_CONFLICT");
    if (this.operationDigests.get(request.operationId) === undefined) {
      if (release.lifecycle !== "staging") {
        throw new Error("PUBLICATION_STATE_CONFLICT");
      }
      const manifest = release.request.manifest;
      const reconciles =
        JSON.stringify(release.acceptedCounts) ===
          JSON.stringify(manifest.counts) &&
        JSON.stringify(release.acceptedCounts) ===
          JSON.stringify(request.expectedCounts) &&
        release.acceptedBatchCount === manifest.batchCount &&
        release.acceptedBatchChainHash === manifest.batchChainHash &&
        release.acceptedTopChaseCount === manifest.topChaseCount &&
        // The server-derived halves must agree with each other, not just with
        // the manifest — the guard at `convex/dataReleaseV3Lifecycle.ts`
        // finalize. Without it this double completes releases production
        // refuses.
        release.acceptedVerifiedTopChaseCount ===
          release.acceptedTopChaseCount &&
        JSON.stringify(release.acceptedEntityChainHashes) ===
          JSON.stringify(manifest.entityChainHashes);
      if (!reconciles) throw new Error("PUBLICATION_RECONCILIATION_FAILED");
      const contentHash = await sha256CanonicalJson(
        DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
        {
          counts: manifest.counts,
          entityChainHashes: manifest.entityChainHashes,
          topChaseCount: manifest.topChaseCount,
        },
      );
      if (contentHash !== manifest.contentHash) {
        throw new Error("PUBLICATION_RECONCILIATION_FAILED");
      }
      release.lifecycle = "complete";
      release.completedAt = new Date().toISOString();
    }
    return this.receipt({
      schemaVersion: "data_release_v3",
      operationKind: "finalize",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result: "complete",
      serverTime: new Date().toISOString(),
      details: {},
      request,
    });
  }

  private pointer(publicReleaseId: string): DataReleaseV3Pointer {
    const release = this.releases.get(publicReleaseId)!;
    return {
      publicReleaseId,
      releaseFingerprint: release.request.releaseFingerprint,
      methodVersion: release.request.manifest.methodVersion,
      confidencePolicyVersion:
        release.request.manifest.confidencePolicyVersion,
      publicEvPolicyVersion: release.request.manifest.publicEvPolicyVersion,
      dataAsOf: release.request.manifest.dataAsOf,
      completedAt: release.completedAt!,
      counts: release.request.manifest.counts,
    };
  }

  async activate(
    request: DataReleaseV3ActivateRequest,
  ): Promise<DataReleaseV3Receipt> {
    if (this.operationDigests.get(request.operationId) === undefined) {
      const release = this.releases.get(request.publicReleaseId);
      if (release === undefined || release.lifecycle !== "complete") {
        throw new Error("PUBLICATION_STATE_CONFLICT");
      }
      const active = this.state.activeRelease?.publicReleaseId ?? null;
      if (active !== request.expectedActivePublicReleaseId) {
        throw new Error("PUBLICATION_PREDECESSOR_CONFLICT");
      }
      // Mirror of the Convex dataAsOf monotonicity guard on activation.
      if (
        request.allowDataAsOfRegression !== true &&
        this.state.activeRelease !== null &&
        Date.parse(release.request.manifest.dataAsOf) <
          Date.parse(this.state.activeRelease.dataAsOf)
      ) {
        throw new Error("PUBLICATION_DATA_REGRESSION");
      }
      this.state = {
        generation: this.state.generation + 1,
        activeRelease: this.pointer(request.publicReleaseId),
        previousRelease: this.state.activeRelease,
      };
    }
    return this.receipt({
      schemaVersion: "data_release_v3",
      operationKind: "activate",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.publicReleaseId,
      result: "activated",
      serverTime: new Date().toISOString(),
      details: {},
      request,
    });
  }

  async rollback(
    request: DataReleaseV3RollbackRequest,
  ): Promise<DataReleaseV3Receipt> {
    if (this.operationDigests.get(request.operationId) === undefined) {
      if (
        this.state.activeRelease?.publicReleaseId !==
        request.expectedActivePublicReleaseId
      ) {
        throw new Error("PUBLICATION_PREDECESSOR_CONFLICT");
      }
      if (
        this.state.previousRelease?.publicReleaseId !==
        request.targetPublicReleaseId
      ) {
        throw new Error("PUBLICATION_ROLLBACK_UNSAFE");
      }
      this.state = {
        generation: this.state.generation + 1,
        activeRelease: this.state.previousRelease,
        previousRelease: this.state.activeRelease,
      };
    }
    return this.receipt({
      schemaVersion: "data_release_v3",
      operationKind: "rollback",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: request.targetPublicReleaseId,
      result: "rolled_back",
      serverTime: new Date().toISOString(),
      details: {},
      request,
    });
  }
}

export { MAX_ROWS_PER_DATA_RELEASE_V3_SHARD };
