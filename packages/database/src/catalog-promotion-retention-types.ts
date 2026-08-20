import type {
  CatalogRetentionPostgresProofSnapshot,
  CatalogRetentionReceipt,
} from "@packscout/contracts";

export const CATALOG_PROMOTION_RETENTION_MAXIMUM_ROWS = 100;
export const CATALOG_PROMOTION_RETENTION_MINIMUM_ROWS = 10;

export type CatalogPromotionRetentionPersistenceErrorCode =
  | "CATALOG_PROMOTION_RETENTION_INPUT_INVALID"
  | "CATALOG_PROMOTION_RETENTION_BARRIER_INACTIVE"
  | "CATALOG_PROMOTION_RETENTION_TOKEN_INVALID"
  | "CATALOG_PROMOTION_RETENTION_OPERATION_CONFLICT"
  | "CATALOG_PROMOTION_RETENTION_OPERATION_ORDER"
  | "CATALOG_PROMOTION_RETENTION_PROOF_INCOMPLETE"
  | "CATALOG_PROMOTION_RETENTION_RECEIPT_INVALID"
  | "CATALOG_PROMOTION_RETENTION_STATE_CONFLICT"
  | "CATALOG_PROMOTION_RETENTION_UNSAFE";

export class CatalogPromotionRetentionPersistenceError extends Error {
  readonly code: CatalogPromotionRetentionPersistenceErrorCode;

  constructor(code: CatalogPromotionRetentionPersistenceErrorCode) {
    super(code);
    this.name = "CatalogPromotionRetentionPersistenceError";
    this.code = code;
  }
}

export interface CatalogPromotionRetentionScopeBinding {
  readonly organizationId: string;
  readonly deploymentKey: string;
}

export interface CatalogPromotionRetentionBarrierClaim {
  readonly barrierGeneration: bigint;
  readonly barrierToken: string;
  readonly retentionGeneration: number;
  readonly postgresProof: CatalogRetentionPostgresProofSnapshot;
  readonly canonicalPostgresProofBody: string;
  readonly resumed: boolean;
}

export interface CatalogPromotionRetentionOperationRecord {
  readonly operationIndex: number;
  readonly operationId: string;
  readonly operationKind: "retainManifests" | "retainProviderReleases";
  readonly phase: "manifests" | "provider_releases";
  readonly platformKey: string | null;
  readonly expectedRetentionGeneration: number;
  readonly canonicalRequestBody: string;
  readonly requestSha256: string;
  readonly state: "pending" | "sent" | "acknowledged";
  readonly sendCount: number;
  readonly lastSentAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly canonicalReceiptBody: string | null;
  readonly receiptSha256: string | null;
  readonly exactResponseBody: string | null;
  readonly responseSha256: string | null;
  readonly postgresCleanupComplete: boolean;
}

export interface CatalogPromotionRetentionReceiptEvidence {
  readonly canonicalReceiptBody: string;
  readonly exactResponseBody: string;
}

export interface CatalogPromotionRetentionAcknowledgement {
  readonly receipt: CatalogRetentionReceipt;
  readonly receiptSha256: string;
  readonly postgresCleanupPending: boolean;
}

export interface CatalogPromotionRetentionCleanupProgress {
  readonly deletedRowCount: number;
  readonly complete: boolean;
}
