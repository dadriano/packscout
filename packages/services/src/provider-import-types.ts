import type {
  ProviderFeedValidatedPageV1,
  ProviderFeedRecordKind,
} from "@packscout/contracts";
import type {
  ProviderAdapterCandidate,
  ProviderConfigurationIdentity,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";
import type { EncryptedProviderCredential } from "./provider-credential-cipher.ts";

export type ProviderImportTrigger = "scheduled" | "manual";
export type ProviderImportRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "incomplete"
  | "failed";

export interface ProviderImportRunCounters {
  readonly accepted: number;
  readonly duplicate: number;
  readonly quarantined: number;
  readonly pages: number;
  readonly records: number;
  readonly requestAttempts: number;
  readonly transientRetries: number;
}

export interface ProviderImportRunSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly trigger: ProviderImportTrigger | "recovery";
  readonly state: ProviderImportRunState;
  readonly requestedCursor: string | null;
  readonly finalCursor: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly counters: ProviderImportRunCounters;
  readonly reachedProviderHead: boolean;
  readonly failureCode: string | null;
  readonly failureSummary: string | null;
}

export interface ClaimedProviderImportRun extends ProviderImportRunSummary {
  readonly state: "running";
  readonly workerId: string;
  readonly leaseExpiresAt: Date;
  readonly currentCursor: string | null;
  readonly nextPageNumber: number;
}

export type ProviderImportRequestPersistenceResult =
  | { readonly kind: "created"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "active"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "provider_unavailable" };

export type ProviderImportClaimPersistenceResult =
  | { readonly kind: "claimed"; readonly run: ClaimedProviderImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_claimable"; readonly run: ProviderImportRunSummary };

export type ProviderImportFinishPersistenceResult =
  | { readonly kind: "finished"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "ownership_lost" }
  | { readonly kind: "already_terminal"; readonly run: ProviderImportRunSummary };

export interface ProviderImportRunRepository {
  requestRun(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    trigger: ProviderImportTrigger;
    requestedByActorKey: string | null;
    requestedAt: Date;
  }): Promise<ProviderImportRequestPersistenceResult>;
  claimRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ProviderImportClaimPersistenceResult>;
  renewLease(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    renewedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  recordRequestAttempt(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    transientRetry: boolean;
  }): Promise<boolean>;
  finishRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    state: "succeeded" | "incomplete" | "failed";
    reachedProviderHead: boolean;
    failureCode: string | null;
    failureSummary: string | null;
    finishedAt: Date;
  }): Promise<ProviderImportFinishPersistenceResult>;
}

export interface ProviderImportRuntimeRevision {
  readonly organizationId: string;
  readonly providerId: string;
  readonly revisionId: string;
  readonly platformKey: string;
  readonly adapterKey: string;
  readonly endpoint: string;
  readonly authMode: "none" | "bearer";
  readonly scheduleSeconds: number;
  readonly encryptedCredential: EncryptedProviderCredential | null;
}

export interface ProviderImportRuntimeRevisionRepository {
  getImmutableRevisionForRuntime(input: {
    organizationId: string;
    providerId: string;
    revisionId: string;
  }): Promise<ProviderImportRuntimeRevision | null>;
}

export type ProviderCanonicalRecordKind =
  | "platform"
  | "pack"
  | "catalog_asset"
  | "pull"
  | "sale"
  | "estimated_ev";

export interface ProviderCanonicalRelationshipCommand {
  readonly relationshipKind: string;
  readonly targetPlatformKey: string;
  readonly targetRecordKind: ProviderCanonicalRecordKind;
  readonly targetExternalId: string | null;
}

export interface ProviderCanonicalProjectionCommand {
  readonly platformKey: string;
  readonly recordKind: ProviderCanonicalRecordKind;
  readonly externalId: string;
  readonly content: Record<string, unknown>;
  readonly provenance?: Record<string, unknown>;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly sourceActorIdentifier?: string;
  readonly relationships?: readonly ProviderCanonicalRelationshipCommand[];
}

export type ProviderProjectionOutcome =
  | {
      readonly status: "accepted";
      readonly projections: readonly ProviderCanonicalProjectionCommand[];
    }
  | {
      readonly status: "invalid";
      readonly reasonCode: string;
      readonly fieldPath?: string;
    };

export interface ProviderProjectionPort {
  project(input: {
    readonly configuration: ProviderConfigurationIdentity;
    readonly source: ProviderSourceIdentity;
    readonly candidates: readonly ProviderAdapterCandidate[];
  }): ProviderProjectionOutcome | Promise<ProviderProjectionOutcome>;
}

export interface ProviderImportSourceRecordInput {
  readonly recordKind: ProviderFeedRecordKind;
  readonly recordIndex: number;
  readonly externalId: string;
  readonly sourceTime: Date;
  readonly collectedAt: Date;
  readonly payload: Record<string, unknown>;
  readonly projections: readonly ProviderCanonicalProjectionCommand[];
  readonly quarantine?: {
    readonly reasonCode: string;
    readonly fieldPath?: string;
    readonly sanitizedSummary: string;
  };
}

export interface ProviderImportQuarantineInput {
  readonly recordKind: ProviderFeedRecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly reasonCode: string;
  readonly fieldPath?: string;
  readonly sanitizedSummary: string;
  readonly payload: unknown;
}

export interface ProviderImportCommitPageInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configRevisionId: string;
  readonly runId: string;
  readonly workerId: string;
  readonly pageNumber: number;
  readonly requestedCursor: string | null;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly payload: unknown;
  readonly records: readonly ProviderImportSourceRecordInput[];
  readonly quarantines: readonly ProviderImportQuarantineInput[];
  readonly committedAt: Date;
}

export interface ProviderImportCommitPageResult {
  readonly kind: "committed" | "already_committed";
  readonly pageId: string;
  readonly counters: ProviderImportRunCounters;
  readonly newCanonicalRevisions: number;
  readonly duplicateSourceRecords: number;
}

export interface ProviderImportPageRepository {
  commitPage(
    input: ProviderImportCommitPageInput,
  ): Promise<ProviderImportCommitPageResult>;
}

export interface ProviderImportMappedPage {
  readonly records: readonly ProviderImportSourceRecordInput[];
  readonly quarantines: readonly ProviderImportQuarantineInput[];
}

export interface ProviderImportPagePlanner {
  plan(input: {
    configuration: ProviderConfigurationIdentity;
    page: ProviderFeedValidatedPageV1;
  }): Promise<ProviderImportMappedPage>;
}

export type ProviderImportTerminalFailureCode =
  | "IMPORT_AUTHENTICATION_FAILED"
  | "IMPORT_CONFIGURATION_UNAVAILABLE"
  | "IMPORT_CURSOR_SAFETY_FAILED"
  | "IMPORT_DESTINATION_REJECTED"
  | "IMPORT_HTTP_ERROR"
  | "IMPORT_INVALID_CONTRACT"
  | "IMPORT_INVALID_JSON"
  | "IMPORT_MAPPING_FAILED"
  | "IMPORT_PERSISTENCE_FAILED"
  | "IMPORT_RATE_LIMITED"
  | "IMPORT_RESPONSE_TOO_LARGE"
  | "IMPORT_RETRY_EXHAUSTED"
  | "IMPORT_RUN_LIMIT_REACHED"
  | "IMPORT_TIMEOUT"
  | "IMPORT_UNREACHABLE";

export type ProviderImportServiceErrorCode =
  | "ACTIVE_IMPORT_RUN"
  | "IMPORT_RUN_NOT_CLAIMABLE"
  | "IMPORT_RUN_NOT_FOUND"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_NOT_IMPORTABLE"
  | "RUN_OWNERSHIP_LOST";
