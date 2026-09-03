import type { LaunchProviderKey } from "@packscout/contracts";

export interface ProviderSourceSupervisorEpochFence {
  readonly epochId: string;
  readonly ownerKey: string;
  readonly leaseToken: string;
}

export interface ProviderSourceEncryptedConnectionConfiguration {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

interface ClaimedWorkBase {
  readonly id: string;
  readonly kind: "connection_test" | "source_test" | "page_read";
  readonly queuedAt: Date;
  readonly organizationId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly connectionHealthGeneration: bigint;
  readonly platformRequestLimit: number;
  readonly connectionConfiguration:
    ProviderSourceEncryptedConnectionConfiguration;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimLeaseId: string;
  readonly claimExpiresAt: Date;
}

export interface ClaimedConnectionTestWork extends ClaimedWorkBase {
  readonly kind: "connection_test";
  readonly recoveryEpisodeId: string | null;
}

interface ClaimedSourceWorkBase extends ClaimedWorkBase {
  readonly providerId: string;
  readonly provider: LaunchProviderKey;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  /** Immutable source-test or import-run request-size pin. */
  readonly recordsPerRequest: number;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly cursorCodecVersion: string;
  readonly sourceConfiguration: unknown;
  readonly recordIdScopes: unknown;
}

export interface ClaimedSourceTestWork extends ClaimedSourceWorkBase {
  readonly kind: "source_test";
}

export interface ClaimedPageReadWork extends ClaimedSourceWorkBase {
  readonly kind: "page_read";
  readonly runId: string;
  readonly runTrigger: "scheduled" | "manual" | "continuation" | "recovery";
  readonly runStartedAt: Date;
  readonly committedPages: number;
  readonly committedRecords: number;
  readonly retryAttempt: number;
  readonly pageNumber: number;
  readonly cursorGeneration: bigint;
  readonly requestedCursorValue: string | null;
  readonly requestedCursorFingerprint: string | null;
  readonly sourceIntervalSeconds: number;
}

export type ProviderSourceSupervisorClaimedWork =
  | ClaimedConnectionTestWork
  | ClaimedSourceTestWork
  | ClaimedPageReadWork;

export interface ProviderSourceDueLane {
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly dueAt: Date;
}

export type ProviderSourcePageTurnDecision =
  | Readonly<{
      kind: "continued";
      continuationRunId: string;
      cursorFingerprint: string;
      pagesCommitted: number;
      recordsCommitted: number;
    }>
  | Readonly<{
      kind: "reached_head";
      cursorFingerprint: string | null;
      minimumDelaySeconds: number;
      pagesCommitted: number;
      recordsCommitted: number;
    }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{
      kind: "retrying";
      retryAttempt: number;
      retryDelayMilliseconds: number;
      safeCode: string;
    }>
  | Readonly<{
      kind: "action_required";
      safeCode: string;
    }>;
