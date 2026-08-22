import {
  providerSourceControlPlaneRetry,
  providerSourceLaunchBounds,
  providerSourceRetention,
  providerSourceSingletonTiming,
  type ProviderSourceDiagnosticSeverity,
} from "@packscout/contracts";

export const PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS =
  providerSourceRetention.protectedRawPageDays;
export const PROVIDER_SOURCE_QUARANTINE_RETENTION_DAYS =
  providerSourceRetention.protectedQuarantineDays;
export const PROVIDER_SOURCE_DIAGNOSTIC_RETENTION_DAYS =
  providerSourceRetention.sanitizedDiagnosticDays;
export const PROVIDER_SOURCE_REQUEST_ATTEMPT_RETENTION_DAYS =
  providerSourceRetention.terminalRequestAttemptDays;

export const PROVIDER_SOURCE_SCHEDULE_BOUNDS = Object.freeze({
  defaultIntervalSeconds: providerSourceLaunchBounds.sourceIntervalSeconds.default,
  minimumIntervalSeconds: providerSourceLaunchBounds.sourceIntervalSeconds.minimum,
  maximumIntervalSeconds: providerSourceLaunchBounds.sourceIntervalSeconds.maximum,
  freshnessGraceSeconds: providerSourceLaunchBounds.freshnessGraceSeconds,
});

export const PROVIDER_SOURCE_SUPERVISOR_TIMING = Object.freeze({
  leaseSeconds: providerSourceSingletonTiming.leaseSeconds,
  renewalSeconds: providerSourceSingletonTiming.maximumRenewalIntervalSeconds,
  takeoverGraceSeconds: providerSourceSingletonTiming.takeoverGraceSeconds,
});

export const PROVIDER_SOURCE_CONTROL_PLANE_TRANSACTION = Object.freeze({
  maxWait: providerSourceControlPlaneRetry.transactionTimeoutMilliseconds,
  timeout: providerSourceControlPlaneRetry.transactionTimeoutMilliseconds,
});

export type ProviderSourceInstanceState =
  | "draft"
  | "paused"
  | "active"
  | "disabled"
  | "replaced";

export interface ProviderSourceRevisionPins {
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly normalizedContractVersion: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly identityNamespaceKey: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly checkpointCodecVersion: string;
  readonly checkpointGeneration: bigint;
}

export interface OpaqueCheckpoint {
  readonly bytes: Uint8Array | null;
  readonly fingerprint: string | null;
  readonly generation: bigint;
  readonly codecVersion: string;
}

export type SourceRequestOperation =
  | Readonly<{
      kind: "connection_test";
      connectionTestJobId: string;
      blockingEpisodeId?: string | null;
    }>
  | Readonly<{
      kind: "source_test";
      providerId: string;
      sourceInstanceId: string;
      sourceRevisionId: string;
      sourceTestJobId: string;
    }>
  | Readonly<{
      kind: "page_read";
      providerId: string;
      sourceInstanceId: string;
      sourceRevisionId: string;
      runId: string;
      pageNumber: number;
      checkpointGeneration: bigint;
      requestedCheckpointFingerprint: string | null;
    }>;

export type RequestAttemptTerminalState =
  | "captured"
  | "failed"
  | "connection_outcome_uncertain";

interface DiagnosticEventBase {
  id?: string;
  organizationId: string;
  severity: ProviderSourceDiagnosticSeverity;
  phase: string;
  safeCode: string;
  occurredAt: Date;
  sourceTypeKey: string;
  sourceAdapterVersion: string;
  connectionProfileId: string;
  connectionRevisionId: string;
  durationMs?: number | null;
  responseBytes?: number | null;
  retryDelayMs?: number | null;
  checkpointFingerprint?: string | null;
  continuation?:
    | Readonly<{ kind: "continue" }>
    | Readonly<{ kind: "poll_after"; minimumDelaySeconds: number }>
    | null;
  counters?: Readonly<Record<string, number>>;
  evidence?: Readonly<Record<string, string | number | boolean | null>>;
}

type SourceDiagnosticIdentity = Readonly<{
  scope: "source";
  normalizedContractVersion: string;
  providerId: string;
  sourceInstanceId: string;
  sourceRevisionId: string;
  blockingEpisodeId?: null;
  connectionTestJobId?: null;
}>;

type ConnectionDiagnosticIdentity = Readonly<{
  scope: "connection";
  normalizedContractVersion?: null;
  providerId?: null;
  sourceInstanceId?: null;
  sourceRevisionId?: null;
  sourceTestJobId?: null;
  runId?: null;
  pageId?: null;
  runTrigger?: null;
  commandCorrelationKey?: null;
  auditEventId?: null;
}>;

type LifecycleActorCorrelation =
  | Readonly<{ commandCorrelationKey: string; auditEventId?: null }>
  | Readonly<{ commandCorrelationKey?: null; auditEventId: string }>;

type LifecycleDiagnosticCorrelation = SourceDiagnosticIdentity
  & LifecycleActorCorrelation
  & Readonly<{
    correlationKind: "lifecycle";
    eventKind: "source_lifecycle";
    sourceTestJobId?: null;
    runId?: null;
    pageId?: null;
    requestAttemptId?: null;
    runTrigger?: null;
  }>;

type ConnectionTestDiagnosticCorrelation = ConnectionDiagnosticIdentity
  & Readonly<{
    correlationKind: "connection_test";
    eventKind: "connection_test";
    blockingEpisodeId?: string | null;
    connectionTestJobId: string;
    requestAttemptId?: string | null;
  }>;

type SourceTestDiagnosticCorrelation = SourceDiagnosticIdentity
  & Readonly<{
    correlationKind: "source_test";
    eventKind: "source_test";
    connectionTestJobId?: null;
    sourceTestJobId: string;
    runId?: null;
    pageId?: null;
    requestAttemptId?: string | null;
    runTrigger?: null;
    commandCorrelationKey?: null;
    auditEventId?: null;
  }>;

type RunDiagnosticCorrelation = SourceDiagnosticIdentity
  & Readonly<{
    correlationKind: "run";
    eventKind: "source_run";
    connectionTestJobId?: null;
    sourceTestJobId?: null;
    runId: string;
    pageId?: null;
    requestAttemptId?: null;
    runTrigger: "scheduled" | "manual" | "continuation" | "recovery";
    commandCorrelationKey?: null;
    auditEventId?: null;
  }>;

type PageDiagnosticReference =
  | Readonly<{ pageId: string; requestAttemptId?: string | null }>
  | Readonly<{ pageId?: null; requestAttemptId: string }>;

type PageDiagnosticCorrelation = SourceDiagnosticIdentity
  & PageDiagnosticReference
  & Readonly<{
    correlationKind: "page";
    eventKind: "source_page";
    connectionTestJobId?: null;
    sourceTestJobId?: null;
    runId: string;
    runTrigger: "scheduled" | "manual" | "continuation" | "recovery";
    commandCorrelationKey?: null;
    auditEventId?: null;
  }>;

type ConnectionEpisodeDiagnosticCorrelation = ConnectionDiagnosticIdentity
  & Readonly<{
    correlationKind: "connection_episode";
    eventKind: "connection_episode";
    blockingEpisodeId: string;
    connectionTestJobId?: null;
    requestAttemptId?: string | null;
  }>;

export type DiagnosticEventInput = Readonly<DiagnosticEventBase & (
  | LifecycleDiagnosticCorrelation
  | ConnectionTestDiagnosticCorrelation
  | SourceTestDiagnosticCorrelation
  | RunDiagnosticCorrelation
  | PageDiagnosticCorrelation
  | ConnectionEpisodeDiagnosticCorrelation
)>;
