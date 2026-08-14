import type {
  ProviderRecordKindV2,
  ProviderStreamRecordV2,
  ProviderStreamValidatedPageV2,
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
  readonly trigger: ProviderImportTrigger | "recovery" | "archive";
  readonly archiveSha256: string | null;
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
  /** Requested and returned cursors already committed for this run. */
  readonly committedCursors: readonly string[];
  /** Durable archive bytes committed by every prior attempt of this run. */
  readonly committedArchiveUncompressedBytes: number;
  /** Durable elapsed-time ceiling used to derive this archive run's deadline. */
  readonly archiveMaximumElapsedMs: number;
}

export type ProviderImportRequestPersistenceResult =
  | { readonly kind: "created"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "active"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "provider_unavailable" }
  | {
      readonly kind: "revision_conflict";
      readonly activeConfigurationRevisionId: string;
    };

export type ProviderImportClaimPersistenceResult =
  | { readonly kind: "claimed"; readonly run: ClaimedProviderImportRun }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_claimable"; readonly run: ProviderImportRunSummary };

export type ProviderImportQueueClaimPersistenceResult =
  | { readonly kind: "claimed"; readonly run: ClaimedProviderImportRun }
  | { readonly kind: "idle" };

export type ProviderImportQueueExecutionResult =
  | { readonly kind: "executed"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "idle" };

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
    expectedConfigurationRevisionId?: string;
  }): Promise<ProviderImportRequestPersistenceResult>;
  claimRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ProviderImportClaimPersistenceResult>;
  claimNextRun(input: {
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ProviderImportQueueClaimPersistenceResult>;
  hasCommittedTerminalPage(input: {
    organizationId: string;
    runId: string;
    pageNumber: number;
    finalCursor: string;
  }): Promise<boolean>;
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
  | "ev_input"
  | "pull"
  | "trade"
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
  readonly recordKind: ProviderRecordKindV2;
  readonly recordIndex: number;
  readonly externalId: string;
  readonly sourceTime: Date;
  readonly collectedAt: Date;
  readonly payload: ProviderStreamRecordV2;
  readonly projections: readonly ProviderCanonicalProjectionCommand[];
  readonly quarantine?: {
    readonly reasonCode: string;
    readonly fieldPath?: string;
    readonly sanitizedSummary: string;
  };
}

export interface ProviderImportQuarantineInput {
  readonly recordKind: ProviderRecordKindV2;
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
  readonly payloadHash?: string;
  /** Exact uncompressed NDJSON bytes represented by an archive page. */
  readonly archiveUncompressedBytes?: number;
  readonly checkpointMode: "provider" | "archive";
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
    page: ProviderStreamValidatedPageV2;
  }): Promise<ProviderImportMappedPage>;
}

export interface ProviderArchiveImportPagePlanner {
  /** Resolves the immutable mapper key stored with the archive revision. */
  planArchive(input: {
    configuration: ProviderConfigurationIdentity;
    page: ProviderStreamValidatedPageV2;
  }): Promise<ProviderImportMappedPage>;
}

export type ProviderArchiveImportRequestPersistenceResult =
  | { readonly kind: "created"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "existing"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "active"; readonly run: ProviderImportRunSummary }
  | { readonly kind: "not_found" | "provider_unavailable" | "revision_conflict" };

export interface ProviderArchiveImportRepository {
  ensureArchiveRevision(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    platformKey: string;
    mappingAdapterKey: string;
    actorPseudonymKeyFingerprint: string;
    archiveImporterBuildSha: string;
    archiveSha256: string;
    actorKey: string;
    createdAt: Date;
  }): Promise<{ readonly created: boolean }>;
  requestArchiveRun(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    runId: string;
    archiveSha256: string;
    requestedByActorKey: string;
    requestedAt: Date;
    initialCursor: string;
    maximumElapsedMs: number;
  }): Promise<ProviderArchiveImportRequestPersistenceResult>;
  claimArchiveRun(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    claimedAt: Date;
    leaseExpiresAt: Date;
  }): Promise<ProviderImportClaimPersistenceResult>;
  getArchiveRevision(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
  }): Promise<{
    readonly platformKey: string;
    readonly mappingAdapterKey: string;
  } | null>;
  hasCommittedTerminalPage(input: {
    organizationId: string;
    runId: string;
    pageNumber: number;
    finalCursor: string;
  }): Promise<boolean>;
  requeueFailedArchiveRun(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    archiveSha256: string;
    actorKey: string;
    requeuedAt: Date;
  }): Promise<
    | { readonly kind: "requeued" }
    | { readonly kind: "not_found" | "state_conflict" }
  >;
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
  | "CONFIG_REVISION_CONFLICT"
  | "IMPORT_TRIGGER_CONFLICT"
  | "IMPORT_RUN_NOT_CLAIMABLE"
  | "IMPORT_RUN_NOT_FOUND"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_NOT_IMPORTABLE"
  | "RUN_OWNERSHIP_LOST";
