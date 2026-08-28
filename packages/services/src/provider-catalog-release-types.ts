import type {
  ApprovedPublicCatalogConfigurationV1,
  ApprovedPublicCollectibleMapping,
  ApprovedPublicPlatformConfiguration,
  ApprovedPublicRepackIdentityMapping,
  ProviderCatalogCompletedReleaseProofV1,
  ProviderCatalogReleaseGoverningHashesV1,
} from "@packscout/contracts";
import type {
  ProviderCatalogCheckpoint,
  SharedPublicConfigurationEpoch,
} from "./provider-catalog-settlement-service.ts";

export interface ProviderCatalogReleaseSnapshotCheckpoint {
  readonly platformKey: string;
  readonly sharedConfigurationEpoch: SharedPublicConfigurationEpoch;
  readonly settledSequence: bigint;
  readonly sourceHeadSequence: bigint;
  readonly settledAt: Date;
  readonly sourceHeadAt: Date;
}

export interface ProviderCatalogReleaseConfigurationSnapshot {
  readonly schemaVersion: ApprovedPublicCatalogConfigurationV1["schemaVersion"];
  readonly configurationKey: string;
  readonly revision: number;
  readonly approvedAt: string;
  readonly staleAfterSeconds: number;
  readonly confidencePolicy: ApprovedPublicCatalogConfigurationV1["confidencePolicy"];
  readonly publicAssetOrigins: readonly string[];
  readonly verifiedUsdStablecoins: readonly string[];
  readonly categories: readonly ApprovedPublicCatalogConfigurationV1["categories"][number][];
  readonly platform: ApprovedPublicPlatformConfiguration;
  readonly repacks: readonly ApprovedPublicRepackIdentityMapping[];
  readonly collectibles: readonly ApprovedPublicCollectibleMapping[];
  readonly configurationHash: string;
  readonly publicChangeSequence: bigint;
}

export interface ProviderCatalogReleaseReadinessSnapshot {
  readonly lifecycleState: string;
  readonly lifecycleSequence: bigint;
  readonly sourceRevisionId: string;
  readonly completedBackfillAt: Date;
}

export interface ProviderCatalogReleaseObservationSnapshot {
  readonly lastSuccessfulObservationAt: Date;
}

export interface ProviderCatalogCanonicalRevisionSnapshot {
  readonly entityId: string;
  readonly revisionId: string;
  readonly platformKey: string;
  readonly recordKind:
    | "platform"
    | "pack"
    | "catalog_asset"
    | "ev_input"
    | "estimated_ev";
  readonly externalId: string;
  readonly content: unknown;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
  readonly publicChangeSequence: bigint;
}

/**
 * One exact V1 card-to-pack association derived from the paired `card` and
 * `pack` relationships owned by a canonical pull entity. The source identity
 * remains present so malformed one-pull-to-many-target shapes fail closed,
 * while multiple pull entities may independently establish the same pair.
 */
export interface ProviderCatalogAssetPackAssociationSnapshot {
  readonly sourceEntityId: string;
  readonly platformKey: string;
  readonly assetExternalId: string;
  readonly packExternalId: string;
  readonly associatedAt: Date;
  readonly publicChangeSequence: bigint;
}

export interface ProviderGovernedPublicRepackIdentity {
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly publicRepackId: string;
  readonly approvedConfigurationKey: string;
  readonly publicChangeSequence: bigint;
  readonly approvedAt: Date;
}

export interface ProviderCatalogReleaseSourceSnapshot {
  readonly checkpoint: ProviderCatalogReleaseSnapshotCheckpoint;
  readonly configuration: ProviderCatalogReleaseConfigurationSnapshot;
  readonly readiness: ProviderCatalogReleaseReadinessSnapshot;
  readonly revisions: readonly ProviderCatalogCanonicalRevisionSnapshot[];
  readonly assetPackAssociations:
    readonly ProviderCatalogAssetPackAssociationSnapshot[];
  readonly repackIdentities: readonly ProviderGovernedPublicRepackIdentity[];
  readonly observation: ProviderCatalogReleaseObservationSnapshot;
}

export interface ProviderCatalogReleaseSourcePort {
  loadProviderSnapshot(input: Readonly<{
    checkpoint: ProviderCatalogCheckpoint;
  }>): Promise<ProviderCatalogReleaseSourceSnapshot>;
}

export interface ProviderCatalogReleaseCheckpointPort {
  getCheckpoint(): Promise<ProviderCatalogCheckpoint>;
}

export type ProviderCatalogReleaseGoverningHashes =
  ProviderCatalogReleaseGoverningHashesV1;

export type ProviderCatalogReleaseCompleteBaseline =
  ProviderCatalogCompletedReleaseProofV1;

export interface ProviderCatalogReleaseBaselinePort {
  findComplete(input: Readonly<{
    platformKey: string;
    sharedConfigurationEpoch: ProviderCatalogReleaseCompleteBaseline["sharedConfigurationEpoch"];
    publicProviderReleaseId: string;
    providerReleaseFingerprint: string;
  }>): Promise<ProviderCatalogReleaseCompleteBaseline | null>;
}

export interface AssembleProviderCatalogReleaseInput {
  readonly trigger: "full_rebuild" | "settled_change";
}
