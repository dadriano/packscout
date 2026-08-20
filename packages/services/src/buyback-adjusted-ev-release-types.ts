import type {
  PublicCategory,
  PublicCollectible,
  PublicRepackChase,
  PublicRepackDetailV3,
  PublicBuybackSummaryV3,
  VendorReportedEvV3,
} from "@packscout/contracts";
import type {
  PackScoutBuybackEvPublicationEligibilityV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";

/**
 * data_release_v3 publication protocol, canonical snapshot ports, and plan
 * types (task buyback-adjusted-ev/008).
 *
 * The wire protocol mirrors `convex/dataReleaseV3Lifecycle.ts` byte for byte:
 * both sides hash canonical JSON with the same domain strings, so a replayed
 * plan reproduces identical batch, chain, content, and fingerprint digests on
 * either side of the transport. The Convex module is the enforcement copy;
 * this module is the producer copy. Keep the constants in lockstep.
 */

export const DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION =
  "data_release_v3" as const;
export const DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION =
  "repack_ev_search_v3" as const;

export const DATA_RELEASE_V3_BATCH_HASH_DOMAIN =
  "packscout.data-release-v3.batch.v1" as const;
export const DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN =
  "packscout.data-release-v3.batch-chain.v1" as const;
export const DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN =
  "packscout.data-release-v3.entity-chain.v1" as const;
export const DATA_RELEASE_V3_CONTENT_HASH_DOMAIN =
  "packscout.data-release-v3.content.v1" as const;
export const DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN =
  "packscout.data-release-v3.release-fingerprint.v1" as const;
export const DATA_RELEASE_V3_RELEASE_ID_DOMAIN =
  "packscout.data-release-v3.release-id.v1" as const;
export const DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN =
  "packscout.data-release-v3.receipt.v1" as const;
export const EMPTY_DATA_RELEASE_V3_CHAIN_HASH = "0".repeat(64);

export const MAX_DATA_RELEASE_V3_REPACKS = 1_000;
export const MAX_DATA_RELEASE_V3_CATEGORIES = 512;
export const MAX_DATA_RELEASE_V3_COLLECTIBLES = 20_000;
export const MAX_DATA_RELEASE_V3_CHASES = 50_000;
export const MAX_DATA_RELEASE_V3_BATCH_RECORDS = 100;
export const MAX_ROWS_PER_DATA_RELEASE_V3_SHARD = 32;

export const DATA_RELEASE_V3_BATCH_KINDS = [
  "categories",
  "collectibles",
  "repacks",
  "chases",
] as const;
export type DataReleaseV3BatchKind = (typeof DATA_RELEASE_V3_BATCH_KINDS)[number];

export interface DataReleaseV3Counts {
  readonly categories: number;
  readonly collectibles: number;
  readonly repacks: number;
  readonly chases: number;
  readonly searchShards: number;
}

export interface DataReleaseV3EntityChainHashes {
  readonly categories: string;
  readonly collectibles: string;
  readonly repacks: string;
  readonly chases: string;
}

export interface DataReleaseV3StartManifest {
  readonly methodVersion: "packscout-buyback-adjusted-ev-v1";
  readonly confidencePolicyVersion:
    "packscout-buyback-adjusted-ev-confidence-v1";
  readonly dataAsOf: string;
  readonly contentHash: string;
  readonly searchAlgorithmVersion:
    typeof DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION;
  readonly counts: DataReleaseV3Counts;
  readonly entityChainHashes: DataReleaseV3EntityChainHashes;
  readonly topChaseCount: number;
  readonly batchCount: number;
  readonly batchChainHash: string;
}

interface DataReleaseV3OperationEnvelope {
  readonly schemaVersion: typeof DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION;
  readonly operationId: string;
  readonly idempotencyKey: string;
}

export type DataReleaseV3StartRequest = DataReleaseV3OperationEnvelope &
  Readonly<{
    publicReleaseId: string;
    releaseFingerprint: string;
    manifest: DataReleaseV3StartManifest;
  }>;

export interface DataReleaseV3BatchRecordMap {
  readonly categories: PublicCategory;
  readonly collectibles: PublicCollectible;
  readonly repacks: PublicRepackDetailV3;
  readonly chases: PublicRepackChase;
}

export type DataReleaseV3ApplyBatchRequest<
  K extends DataReleaseV3BatchKind = DataReleaseV3BatchKind,
> = K extends DataReleaseV3BatchKind
  ? DataReleaseV3OperationEnvelope &
      Readonly<{
        publicReleaseId: string;
        batchIndex: number;
        kind: K;
        batchHash: string;
        records: readonly DataReleaseV3BatchRecordMap[K][];
      }>
  : never;

export type DataReleaseV3FinalizeRequest = DataReleaseV3OperationEnvelope &
  Readonly<{
    publicReleaseId: string;
    releaseFingerprint: string;
    expectedCounts: DataReleaseV3Counts;
    expectedEntityChainHashes: DataReleaseV3EntityChainHashes;
    expectedTopChaseCount: number;
    expectedBatchCount: number;
    expectedBatchChainHash: string;
  }>;

export type DataReleaseV3ActivateRequest = DataReleaseV3OperationEnvelope &
  Readonly<{
    publicReleaseId: string;
    releaseFingerprint: string;
    expectedActivePublicReleaseId: string | null;
    /**
     * Operator-intentional override for the server-side dataAsOf
     * monotonicity guard (`PUBLICATION_DATA_REGRESSION`). Absent on every
     * normal forward publish; pointer reversal belongs to `rollback`.
     */
    allowDataAsOfRegression?: true;
  }>;

export type DataReleaseV3RollbackRequest = DataReleaseV3OperationEnvelope &
  Readonly<{
    expectedActivePublicReleaseId: string;
    targetPublicReleaseId: string;
  }>;

export interface DataReleaseV3Receipt {
  readonly schemaVersion: typeof DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION;
  readonly operationKind: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly publicReleaseId: string | null;
  readonly result: string;
  readonly serverTime: string;
  readonly requestDigest: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly receiptDigest: string;
}

export interface DataReleaseV3Pointer {
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly methodVersion: "packscout-buyback-adjusted-ev-v1";
  readonly confidencePolicyVersion:
    "packscout-buyback-adjusted-ev-confidence-v1";
  readonly dataAsOf: string;
  readonly completedAt: string;
  readonly counts: DataReleaseV3Counts;
}

export interface DataReleaseV3ActiveState {
  readonly generation: number;
  readonly activeRelease: DataReleaseV3Pointer | null;
  readonly previousRelease: DataReleaseV3Pointer | null;
}

export interface DataReleaseV3ReleaseStatus {
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly lifecycle: "staging" | "complete" | "failed";
  readonly acceptedCounts: DataReleaseV3Counts;
  readonly acceptedBatchCount: number;
  readonly acceptedBatchChainHash: string;
  readonly acceptedEntityChainHashes: DataReleaseV3EntityChainHashes;
  readonly acceptedSearchRowCount: number;
  readonly acceptedSearchRowSetHash: string;
  readonly acceptedTopChaseCount: number;
  readonly completedAt: string | null;
}

/**
 * Transport port to the data_release_v3 lifecycle. Implemented by the
 * authenticated Convex publication transport in production and by an
 * in-memory protocol double in tests. Every method resolves to the exact
 * server receipt or throws a `DataReleaseV3PublicationPortError`.
 */
export interface DataReleaseV3PublicationPort {
  activeState(): Promise<DataReleaseV3ActiveState>;
  status(publicReleaseId: string): Promise<DataReleaseV3ReleaseStatus | null>;
  start(request: DataReleaseV3StartRequest): Promise<DataReleaseV3Receipt>;
  applyBatch(
    request: DataReleaseV3ApplyBatchRequest,
  ): Promise<DataReleaseV3Receipt>;
  finalize(request: DataReleaseV3FinalizeRequest): Promise<DataReleaseV3Receipt>;
  activate(request: DataReleaseV3ActivateRequest): Promise<DataReleaseV3Receipt>;
  rollback(request: DataReleaseV3RollbackRequest): Promise<DataReleaseV3Receipt>;
}

export class DataReleaseV3PublicationPortError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DataReleaseV3PublicationPortError";
  }
}

/**
 * One repeatable canonical catalog product for the release read. Every field
 * is already sanitized, provider-neutral, and publication-shaped; the EV
 * estimates are deliberately absent because the assembler composes them from
 * the task-006 publication-eligible revision at the same read clock.
 */
export interface DataReleaseV3CanonicalProduct {
  readonly platformKey: string;
  readonly productKey: string;
  readonly publicRepackId: string;
  readonly publicVendorId: string;
  readonly vendorKey: string;
  readonly vendorDisplayName: string;
  readonly vendorLogoUrl: string | null;
  readonly name: string;
  readonly format: PublicRepackDetailV3["format"];
  readonly contentMode: PublicRepackDetailV3["contentMode"];
  readonly categories: PublicRepackDetailV3["categories"];
  readonly collectibleTypes: PublicRepackDetailV3["collectibleTypes"];
  readonly availability: PublicRepackDetailV3["availability"];
  readonly soldOutAt: string | null;
  readonly price: PublicRepackDetailV3["price"];
  readonly buyback: PublicBuybackSummaryV3;
  readonly vendorReportedEv: VendorReportedEvV3;
  readonly primaryImage: PublicRepackDetailV3["primaryImage"];
  readonly topChase: PublicRepackChase | null;
  readonly contentSummary: PublicRepackDetailV3["contentSummary"];
  readonly actionAvailability: PublicRepackDetailV3["actionAvailability"];
  readonly sourceUpdatedAt: string;
  readonly description: string | null;
  readonly actions: PublicRepackDetailV3["actions"];
}

export interface DataReleaseV3CanonicalSnapshot {
  readonly organizationId: string;
  readonly products: readonly DataReleaseV3CanonicalProduct[];
  readonly categories: readonly PublicCategory[];
  readonly collectibles: readonly PublicCollectible[];
  readonly chases: readonly PublicRepackChase[];
}

/** One repeatable canonical state read, keyed only by the release read clock. */
export interface DataReleaseV3CanonicalCatalogPort {
  loadCatalogSnapshot(input: {
    readonly readAt: string;
  }): Promise<DataReleaseV3CanonicalSnapshot>;
}

/**
 * The task-006 recomputation boundary is the only eligible source of
 * completed buyback-adjusted revisions for publication.
 * `PackScoutBuybackAdjustedEvRecomputationService` satisfies this port.
 */
export interface DataReleaseV3EligibilityPort {
  getPublicationEligibleRevision(query: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly readAt: string;
  }): Promise<PackScoutBuybackEvPublicationEligibilityV1 | null>;
}

export type DataReleaseV3Batch = {
  readonly batchIndex: number;
  readonly kind: DataReleaseV3BatchKind;
  readonly batchHash: string;
  readonly records: readonly (
    | PublicCategory
    | PublicCollectible
    | PublicRepackDetailV3
    | PublicRepackChase
  )[];
};

export interface DataReleaseV3PublishPlan {
  readonly classification: "publish";
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly manifest: DataReleaseV3StartManifest;
  readonly batches: readonly DataReleaseV3Batch[];
}

export type DataReleaseV3AssemblyBlockReason =
  | "CAPACITY_EXCEEDED"
  | "CANONICAL_SNAPSHOT_INVALID"
  | "PUBLIC_CONTRACT_INVALID"
  | "PROTECTED_PUBLICATION_FIELD"
  | "MIXED_CALCULATION_VERSIONS"
  | "SOLD_OUT_FREEZE_INCOHERENT";

export interface DataReleaseV3BlockedPlan {
  readonly classification: "blocked";
  readonly reason: DataReleaseV3AssemblyBlockReason;
  readonly blockedProductKey: string | null;
}

export type DataReleaseV3Plan =
  | DataReleaseV3PublishPlan
  | DataReleaseV3BlockedPlan;
