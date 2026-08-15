import type {
  ApprovedPublicCatalogConfigurationV1,
  DataReleaseManifestV2,
  ProductionBatchKind,
  ProductionBatchRecordMap,
  ProductionFinalizeRequest,
  ProductionRefreshRequest,
  ProductionReleaseCounts,
  ProductionStartRequest,
} from "@packscout/contracts";
import type { PublicChangeCheckpoint } from "./public-change-settlement-service.ts";

export interface CatalogCanonicalRevisionSnapshot {
  readonly entityId: string;
  readonly platformKey: string;
  readonly recordKind:
    | "platform" | "pack" | "catalog_asset" | "ev_input" | "estimated_ev";
  readonly externalId: string;
  readonly content: unknown;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
  readonly publicChangeSequence: bigint;
}

export interface CatalogProviderReadinessSnapshot {
  readonly platformKey: string;
  readonly state: string | null;
  readonly lifecycleSequence: bigint | null;
  readonly configurationRevisionId: string | null;
  readonly completedBackfillAt: Date | null;
}

export interface GovernedPublicRepackIdentity {
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly publicRepackId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
}

export interface CatalogReleaseSourceSnapshot {
  readonly configuration: Readonly<{
    id: string;
    configuration: ApprovedPublicCatalogConfigurationV1;
    configurationHash: string;
    publicChangeSequence: bigint;
  }> | null;
  readonly revisions: readonly CatalogCanonicalRevisionSnapshot[];
  readonly providers: readonly CatalogProviderReadinessSnapshot[];
  readonly repackIdentities: readonly GovernedPublicRepackIdentity[];
}

export interface CatalogReleaseSourcePort {
  loadSnapshot(input: {
    throughSequence: bigint;
    throughOccurredAt: Date;
  }): Promise<CatalogReleaseSourceSnapshot>;
}

export interface CatalogSettlementPort {
  getCheckpoint(): Promise<PublicChangeCheckpoint>;
}

export type CatalogReleaseBlockReason =
  | "NO_SETTLED_PUBLIC_STATE"
  | "WATERMARK_UNSETTLED"
  | "WATERMARK_REGRESSED"
  | "OBSERVATION_SEQUENCE_UNSAFE"
  | "PUBLIC_CONFIGURATION_UNAPPROVED"
  | "PUBLIC_CONFIGURATION_INVALID"
  | "INITIAL_BACKFILL_INCOMPLETE"
  | "INITIAL_PROVIDER_DELAYED"
  | "PUBLIC_IDENTITY_MAPPING_MISSING"
  | "CANONICAL_PROJECTION_INVALID"
  | "PUBLIC_CONTRACT_INVALID"
  | "PUBLICATION_BATCH_TOO_LARGE"
  | "PROTECTED_PUBLICATION_FIELD";

export type CatalogReleaseBaseline = Readonly<{
  activePublicReleaseId: string;
  observationSequence: number;
  contentHash: string;
  publicConfigHash: string;
  repackSearchIndexHash: string;
  publicVendorKeys: readonly string[];
}>;

export type CatalogReleasePlanBatch = Readonly<{
  batchIndex: number;
  kind: ProductionBatchKind;
  batchHash: string;
  byteCount: number;
  records: readonly ProductionBatchRecordMap[ProductionBatchKind][];
}>;

type PlanCommon = Readonly<{
  requestedWatermark: bigint;
  expectedActivePublicReleaseId: string | null;
  expectedPredecessorPublicReleaseId: string | null;
}>;

export type CatalogReleasePublishPlan = PlanCommon & Readonly<{
  classification: "publish";
  publicReleaseId: string;
  observationSequence: number;
  contentHash: string;
  manifest: DataReleaseManifestV2;
  counts: ProductionReleaseCounts;
  entityHashes: Readonly<Record<ProductionBatchKind, string>>;
  publicVendorKeys: readonly string[];
  batches: readonly CatalogReleasePlanBatch[];
  startRequest: ProductionStartRequest;
  finalizeRequest: ProductionFinalizeRequest;
}>;

export type CatalogReleaseRefreshPlan = PlanCommon & Readonly<{
  classification: "refresh_unchanged";
  publicReleaseId: string;
  observationSequence: number;
  contentHash: string;
  publicVendorKeys: readonly string[];
  refreshRequest: ProductionRefreshRequest;
}>;

export type CatalogReleaseBlockedPlan = PlanCommon & Readonly<{
  classification: "blocked";
  reason: CatalogReleaseBlockReason;
}>;

export type CatalogReleasePlanV2 =
  | CatalogReleasePublishPlan
  | CatalogReleaseRefreshPlan
  | CatalogReleaseBlockedPlan;

export interface AssembleCatalogReleaseInput {
  readonly requestedWatermark: bigint;
  readonly baseline: CatalogReleaseBaseline | null;
  readonly trigger: "full_rebuild" | "settled_change";
}
