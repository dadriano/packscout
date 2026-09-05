import type {
  ApprovedPublicCollectibleMapping,
  PublicCollectible,
  PublicRepackChase,
  PublicRepackDetail,
  PublicRepackDetailV3,
} from "@packscout/contracts";

export interface DistributedProviderCollectibleRow {
  readonly id: string;
  readonly rowVersion: bigint;
  readonly collectibleKey: string;
  readonly collectibleType: PublicCollectible["collectibleType"] | "art";
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly year: number | null;
  readonly brand: string | null;
  readonly setOrSeries: string | null;
  readonly cardNumber: string | null;
  readonly referenceNumber: string | null;
  readonly subject: string | null;
  readonly grade: string | null;
  readonly grader: string | null;
  readonly primaryImageUrl: string | null;
  readonly primaryImageAlt: string | null;
  readonly valuationAmount: string | null;
  readonly valuationCurrency: string | null;
  readonly valuationUsdAmount: string | null;
  readonly valuationUnavailableReason: string | null;
  readonly valuationType: string | null;
  readonly valuationObservedAt: Date | null;
  readonly dataAsOf: Date;
}

export interface DistributedProviderCollectibleInstanceRow {
  readonly id: string;
  readonly rowVersion: bigint;
  readonly collectibleId: string;
  readonly instanceKey: string;
  readonly certifier: string | null;
  readonly certificationNumber: string | null;
}

export interface DistributedProviderPackContentRow {
  readonly id: string;
  readonly rowVersion: bigint;
  readonly packId: string;
  readonly collectibleId: string;
  readonly collectibleInstanceId: string | null;
  readonly totalQuantity: bigint | null;
  readonly availableQuantity: bigint | null;
  readonly contentRole: "top_chase" | "featured_chase" | "possible_outcome" | "other";
  readonly probability: string | null;
  readonly statedValueAmount: string | null;
  readonly statedValueCurrency: string | null;
  readonly evidenceKinds: readonly string[];
  readonly matchConfidenceBasisPoints: number;
  readonly matchConfidenceBand: string;
  readonly observedAt: Date;
  readonly displayOrder: number;
}

export interface DistributedProviderContentPack {
  readonly id: string;
  readonly rowVersion: bigint;
  readonly packKey: string;
  readonly detail: PublicRepackDetail;
  /** Derived from the retained inventory snapshot, independently of EV evidence. */
  readonly evidenceCompleteness: "complete" | "partial" | "unknown";
}

export interface DistributedProviderContentPackV3 extends Omit<
  DistributedProviderContentPack,
  "detail"
> {
  readonly detail: PublicRepackDetailV3;
}

export interface DistributedProviderPackContentsProjection {
  readonly collectibles: readonly PublicCollectible[];
  readonly repacks: readonly PublicRepackDetail[];
  readonly repackChases: readonly PublicRepackChase[];
  readonly collectibleMappings: readonly ApprovedPublicCollectibleMapping[];
  readonly dataAsOf: Date;
}

export interface DistributedProviderPackContentsProjectionV3 extends Omit<
  DistributedProviderPackContentsProjection,
  "repacks"
> {
  readonly repacks: readonly PublicRepackDetailV3[];
}

export class DistributedProviderPackContentsError extends Error {
  constructor(readonly code:
    | "DISTRIBUTED_CONTENT_SNAPSHOT_INVALID"
    | "DISTRIBUTED_CONTENT_IDENTITY_INVALID"
    | "DISTRIBUTED_CONTENT_REFERENCE_INVALID"
    | "DISTRIBUTED_CONTENT_IMAGE_UNAPPROVED"
    | "DISTRIBUTED_CONTENT_VALUE_INVALID") {
    super("Distributed provider contents could not be projected safely.");
    this.name = "DistributedProviderPackContentsError";
  }
}
