import {
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  dataforrestEventsV1SourceAdapterManifests,
  launchProviderKeySchema,
  unavailableProviderSourceMeasurements,
  type ProviderSourceMeasurements,
  type ProviderSourceOperationsSource,
} from "@packscout/contracts";
import type {
  AdminLocalProviderOverview,
  AdminLocalRunDetailRecord,
  AdminLocalRunRecord,
} from "@packscout/database";
import {
  ProviderSourceOperationsError,
  type ProviderSourceIntegrationCapability,
} from "@packscout/services";

const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface CentralSourceProvider {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly lifecycle: "draft" | "active" | "disabled" | "archived";
  readonly activeConfig: null | Readonly<{
    id: string;
    adapterKey: string;
    scheduleSeconds: number;
    staleAfterSeconds: number;
  }>;
}

export interface LocalSourceEvidence {
  readonly overview: AdminLocalProviderOverview;
  readonly runs: readonly AdminLocalRunRecord[];
  readonly details: readonly AdminLocalRunDetailRecord[];
  readonly measurements: ProviderSourceMeasurements;
}

function safeCode(value: string | null, fallback: string): string | null {
  if (value === null) return null;
  return safeCodePattern.test(value) ? value : fallback;
}

export function runSummary(
  run: AdminLocalRunRecord | null,
  currentProfile: Readonly<{ configId: string; pageLimit: number }> | null,
) {
  if (run === null) return null;
  return {
    id: run.id,
    trigger: run.trigger,
    state: run.state,
    requestedAt: run.requestedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    lastProgressAt: (run.lastProgressAt ?? run.requestedAt).toISOString(),
    reachedHead: run.reachedSourceHead,
    failureCode: safeCode(run.failureCode, "IMPORT_FAILURE_UNAVAILABLE"),
    // Historical configurations may have different immutable profiles. Do not
    // report the current limit as the limit used by an older run.
    recordsPerRequest: run.configVersionId === currentProfile?.configId
      ? currentProfile.pageLimit
      : null,
  };
}

function elapsedMilliseconds(run: AdminLocalRunRecord | null, now: Date): number {
  if (run?.startedAt === null || run === null) return 0;
  return Math.max(0, (run.finishedAt ?? now).getTime() - run.startedAt.getTime());
}

function sourceLifecycle(provider: CentralSourceProvider):
  "active" | "disabled" {
  return provider.lifecycle === "active" ? "active" : "disabled";
}

function freshness(value: string | undefined): "fresh" | "stale" | "unknown" {
  if (value === "fresh" || value === "stale") return value;
  return "unknown";
}

function quality(value: string | undefined):
  "healthy" | "warning" | "degraded" | "unknown" {
  if (value === "healthy" || value === "warning" || value === "degraded") {
    return value;
  }
  return "unknown";
}

function processor(overview: AdminLocalProviderOverview | null) {
  if (overview === null) return null;
  const activeRun = overview.activeRun;
  if (overview.runtimeState === "error") {
    return {
      activity: "action_required" as const,
      phase: "action_required" as const,
      waitReason: null,
      actionRequiredCode: safeCode(
        overview.latestFailureCode,
        "PROVIDER_RUNTIME_ERROR",
      ) ?? "PROVIDER_RUNTIME_ERROR",
      continuation: null,
      retryCount: overview.consecutiveFailures,
      retryNotBefore: null,
      runLeaseAgeMilliseconds: null,
    };
  }
  if (overview.runtimeState === "paused") {
    return {
      activity: "paused" as const,
      phase: "paused" as const,
      waitReason: null,
      actionRequiredCode: null,
      continuation: null,
      retryCount: overview.consecutiveFailures,
      retryNotBefore: null,
      runLeaseAgeMilliseconds: null,
    };
  }
  if (activeRun?.state === "queued") {
    return {
      activity: "queued" as const,
      phase: "queued" as const,
      waitReason: null,
      actionRequiredCode: null,
      continuation: null,
      retryCount: overview.consecutiveFailures,
      retryNotBefore: null,
      runLeaseAgeMilliseconds: null,
    };
  }
  if (activeRun?.state === "running") {
    return {
      activity: "running" as const,
      phase: "claimed" as const,
      waitReason: null,
      actionRequiredCode: null,
      continuation: null,
      retryCount: overview.consecutiveFailures,
      retryNotBefore: null,
      runLeaseAgeMilliseconds: null,
    };
  }
  return {
    activity: "inactive" as const,
    phase: overview.runtimeState === "stopped" ? "terminal" as const : "idle" as const,
    waitReason: null,
    actionRequiredCode: null,
    continuation: null,
    retryCount: overview.consecutiveFailures,
    retryNotBefore: null,
    runLeaseAgeMilliseconds: null,
  };
}

export function configuredSource(input: Readonly<{
  provider: CentralSourceProvider;
  evidence: LocalSourceEvidence | null;
  capability: ProviderSourceIntegrationCapability | null;
  now: Date;
}>): ProviderSourceOperationsSource {
  const config = input.provider.activeConfig;
  const configured = config !== null && input.capability !== null;
  const databaseUnreachable = configured && input.evidence === null;
  const manifest = config === null
    ? undefined
    : dataforrestEventsV1SourceAdapterManifests.find(
        (candidate) => candidate.adapterVersion === config.adapterKey,
      );
  const declaration = manifest?.supportedProviders.find(
    (candidate) => candidate.provider === input.provider.key,
  );
  if (configured && !declaration) {
    throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
  }
  const overview = input.evidence?.overview ?? null;
  const latest = input.evidence?.runs[0] ?? null;
  const active = overview?.activeRun
    ? input.evidence?.runs.find((run) => run.id === overview.activeRun?.id) ?? null
    : null;
  const progressRun = active ?? latest;
  const elapsed = elapsedMilliseconds(progressRun, input.now);
  const currentProfile = config && manifest
    ? { configId: config.id, pageLimit: manifest.requestBounds.pageLimit }
    : null;
  const totalRecords = progressRun === null
    ? 0
    : progressRun.catalogCount + progressRun.pullCount + progressRun.marketEventCount;
  return {
    providerId: input.provider.id,
    provider: launchProviderKeySchema.parse(input.provider.key),
    displayName: input.provider.displayName,
    configured,
    source: configured && config && input.capability && declaration
      ? {
          sourceInstanceId: input.provider.id,
          sourceRevisionId: config.id,
          sourceTypeKey: DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
          sourceAdapterVersion: config.adapterKey,
          normalizedContractVersion:
            input.capability.normalizedContractVersion,
          mapperKey: input.capability.mapperKey,
          mapperVersion: input.capability.mapperVersion,
          identityNamespaceKey: input.capability.identityNamespaceKey,
          recordIdScopes: declaration.recordIdScopes.map(
            ({ recordIdScopeKey }) => recordIdScopeKey,
          ),
          lifecycle: sourceLifecycle(input.provider),
          pauseRequested: false,
          recordsPerRequest: manifest!.requestBounds.pageLimit,
          requestSizePolicy: "adapter_profile",
          configuration: {
            validated: true,
            fields: [
              { label: "Provider binding", value: input.provider.key, masked: false },
              { label: "Capture adapter", value: config.adapterKey, masked: false },
            ],
          },
        }
      : null,
    schedule: configured && config
      ? {
          scheduleRevisionId: config.id,
          intervalSeconds: config.scheduleSeconds,
          freshnessGraceSeconds: config.staleAfterSeconds,
          nextDueAt: overview?.nextDueAt?.toISOString() ?? null,
        }
      : null,
    processor: configured
      ? databaseUnreachable
        ? {
            activity: "action_required",
            phase: "action_required",
            waitReason: null,
            actionRequiredCode: "PROVIDER_DATABASE_UNREACHABLE",
            continuation: null,
            retryCount: 0,
            retryNotBefore: null,
            runLeaseAgeMilliseconds: null,
          }
        : processor(overview)
      : null,
    freshness: {
      state: freshness(overview?.freshnessState),
      lastHeadReachedAt: overview?.lastHeadReachedAt?.toISOString() ?? null,
      lastProgressAt: progressRun?.lastProgressAt?.toISOString() ?? null,
    },
    quality: {
      state: databaseUnreachable ? "degraded" : quality(overview?.qualityState),
      consecutiveFailures: overview?.consecutiveFailures ?? 0,
      latestFailureCode: databaseUnreachable
        ? "PROVIDER_DATABASE_UNREACHABLE"
        : overview === null
          ? null
        : safeCode(overview.latestFailureCode, "PROVIDER_FAILURE_UNAVAILABLE"),
      recoveredAt: overview?.recoveredAt?.toISOString() ?? null,
    },
    cursor: null,
    progress: {
      pages: progressRun?.pageCount ?? 0,
      records: {
        catalog: progressRun?.catalogCount ?? 0,
        pulls: progressRun?.pullCount ?? 0,
        trades: progressRun?.marketEventCount ?? 0,
        total: totalRecords,
      },
      dispositions: {
        // The canonical run records combined material changes, not insert/update counts.
        inserted: null,
        revised: null,
        duplicate: progressRun?.duplicateCount ?? 0,
        quarantined: progressRun?.quarantinedCount ?? 0,
      },
      throughputRecordsPerSecond: elapsed > 0
        ? Number((totalRecords / (elapsed / 1_000)).toFixed(2))
        : null,
      elapsedMilliseconds: elapsed,
      openQuarantine: overview?.openQuarantineCount ?? 0,
      total: { kind: "unknown", label: "Total unknown" },
    },
    measurements: input.evidence?.measurements ?? unavailableProviderSourceMeasurements(
      config === null ? "not_configured"
        : input.capability === null ? "unsupported" : "database_unreachable",
    ),
    activeRun: runSummary(active, currentProfile),
    latestRun: runSummary(latest, currentProfile),
    connectionImpact: {
      state: "none",
      safeCode: null,
      healthGeneration: null,
    },
  };
}
