import type {
  AuthSessionResponse,
  LaunchProviderKey,
  ProviderSourceAdminCatalog,
  ProviderSourceDiagnosticHistory,
  ProviderSourceOperationsDetail,
  ProviderSourceOperationsOverview,
  ProviderSourceOperationsSource,
} from "@packscout/contracts";

export const operationsFixtureIds = {
  organization: "00000000-0000-4000-8000-000000000100",
  operator: "00000000-0000-4000-8000-000000000101",
  profile: "00000000-0000-4000-8000-000000000102",
  connectionRevision: "00000000-0000-4000-8000-000000000103",
  providers: [
    "00000000-0000-4000-8000-000000000110",
    "00000000-0000-4000-8000-000000000111",
    "00000000-0000-4000-8000-000000000112",
    "00000000-0000-4000-8000-000000000113",
  ],
  sources: [
    "00000000-0000-4000-8000-000000000120",
    "00000000-0000-4000-8000-000000000121",
    "00000000-0000-4000-8000-000000000122",
    "00000000-0000-4000-8000-000000000123",
  ],
  revisions: [
    "00000000-0000-4000-8000-000000000130",
    "00000000-0000-4000-8000-000000000131",
    "00000000-0000-4000-8000-000000000132",
    "00000000-0000-4000-8000-000000000133",
  ],
  schedules: [
    "00000000-0000-4000-8000-000000000140",
    "00000000-0000-4000-8000-000000000141",
    "00000000-0000-4000-8000-000000000142",
    "00000000-0000-4000-8000-000000000143",
  ],
  runs: [
    "00000000-0000-4000-8000-000000000150",
    "00000000-0000-4000-8000-000000000151",
    "00000000-0000-4000-8000-000000000152",
    "00000000-0000-4000-8000-000000000153",
  ],
} as const;

const now = "2026-08-21T12:00:00.000Z";
const providerKeys = [
  "courtyard",
  "collector_crypt",
  "phygitals",
  "clutchpacks",
] as const satisfies readonly LaunchProviderKey[];
const providerNames = ["Courtyard", "Collector Crypt", "Phygitals", "ClutchPacks"] as const;

export function operationsSession(
  role: "admin" | "data_operator" = "admin",
): AuthSessionResponse {
  return {
    operator: {
      id: operationsFixtureIds.operator,
      email: "operator@packscout.test",
      displayName: "Operations Fixture",
      state: "active",
    },
    membership: {
      organizationId: operationsFixtureIds.organization,
      organizationName: "PackScout",
      role,
    },
    permissions: role === "admin"
      ? [
          "providers:view",
          "providers:manage",
          "provider_secrets:manage",
          "imports:start",
          "imports:retry",
        ]
      : ["providers:view", "imports:start", "imports:retry"],
    csrfToken: "fixture-csrf",
  };
}

export function operationSource(
  index: number,
  overrides: Partial<ProviderSourceOperationsSource> = {},
): ProviderSourceOperationsSource {
  const source: ProviderSourceOperationsSource = {
    providerId: operationsFixtureIds.providers[index]!,
    provider: providerKeys[index]!,
    displayName: providerNames[index]!,
    configured: true,
    source: {
      sourceInstanceId: operationsFixtureIds.sources[index]!,
      sourceRevisionId: operationsFixtureIds.revisions[index]!,
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      normalizedContractVersion: "packscout.provider-observation.v1",
      mapperKey: `${providerKeys[index]}-provider-observation`,
      mapperVersion: "1",
      identityNamespaceKey: `dataforrest-${providerKeys[index]}-records-v1`,
      recordIdScopes: ["catalog-pack-v1", "pull-v1", "trade-v1"],
      lifecycle: index === 2 ? "paused" : "active",
      pauseRequested: false,
      recordsPerRequest: index === 0 ? 1_000 : 500,
      requestSizePolicy: "schedule_revision",
      configuration: {
        validated: true,
        fields: [
          { label: "Provider binding", value: providerKeys[index]!, masked: false },
          { label: "Credential", value: "••••••••", masked: true },
        ],
      },
    },
    schedule: {
      scheduleRevisionId: operationsFixtureIds.schedules[index]!,
      intervalSeconds: 300,
      freshnessGraceSeconds: 900,
      nextDueAt: "2026-08-21T12:05:00.000Z",
    },
    processor: {
      activity: index === 0 ? "running" : index === 1 ? "waiting" : index === 2 ? "paused" : "action_required",
      phase: index === 0 ? "requesting" : index === 1 ? "waiting" : index === 2 ? "paused" : "action_required",
      waitReason: index === 1 ? "request_lane_capacity" : index === 2 ? "paused" : index === 3 ? "action_required" : null,
      actionRequiredCode: index === 3 ? "SOURCE_ACTION_REQUIRED" : null,
      continuation: { kind: "continue" },
      retryCount: index === 0 ? 1 : 0,
      retryNotBefore: null,
      runLeaseAgeMilliseconds: index === 0 ? 12_000 : null,
    },
    freshness: {
      state: index === 3 ? "stale" : "fresh",
      lastHeadReachedAt: "2026-08-21T11:55:00.000Z",
      lastProgressAt: now,
    },
    quality: {
      state: index === 3 ? "degraded" : index === 1 ? "warning" : "healthy",
      consecutiveFailures: index === 3 ? 2 : 0,
      latestFailureCode: index === 3 ? "SOURCE_ACTION_REQUIRED" : null,
      recoveredAt: null,
    },
    cursor: {
      generation: String(index + 1),
      fingerprint: String(index + 1).repeat(64),
      resumeLabel: "Saved cursor",
    },
    progress: {
      pages: index + 4,
      records: {
        catalog: 10 + index,
        pulls: 20 + index,
        trades: 30 + index,
        total: 60 + index * 3,
      },
      dispositions: {
        inserted: 40 + index,
        revised: 5,
        duplicate: 10,
        quarantined: index,
      },
      throughputRecordsPerSecond: index === 2 ? null : 12.5,
      elapsedMilliseconds: 8_000 + index * 1_000,
      openQuarantine: index,
      total: { kind: "unknown", label: "Total unknown" },
    },
    activeRun: index === 0 ? {
      id: operationsFixtureIds.runs[index]!,
      trigger: "manual",
      state: "running",
      requestedAt: now,
      startedAt: now,
      finishedAt: null,
      lastProgressAt: now,
      reachedHead: false,
      failureCode: null,
      recordsPerRequest: 500,
    } : null,
    latestRun: index === 3 ? {
      id: operationsFixtureIds.runs[index]!,
      trigger: "scheduled",
      state: "failed",
      requestedAt: now,
      startedAt: now,
      finishedAt: now,
      lastProgressAt: now,
      reachedHead: false,
      failureCode: "SOURCE_ACTION_REQUIRED",
      recordsPerRequest: 500,
    } : null,
    connectionImpact: { state: "none", safeCode: null, healthGeneration: null },
  };
  return { ...source, ...overrides };
}

export function operationsOverview(): ProviderSourceOperationsOverview {
  return {
    version: "packscout.provider-source-operations.v1",
    refreshedAt: now,
    connectionMode: "shared",
    connection: {
      connectionProfileId: operationsFixtureIds.profile,
      displayName: "Shared DataForrest",
      sourceType: {
        sourceTypeKey: "dataforrest-events-v1",
        label: "DataForrest events",
        adapterVersion: "dataforrest-events-adapter-v1",
        normalizedContractVersion: "packscout.provider-observation.v1",
        capabilities: {
          connectionTest: true,
          sourceTest: true,
          pageRead: true,
          cancellation: false,
        },
      },
      state: "active",
      endpointHost: "198.204.245.26.sslip.io",
      credential: { configured: true, mask: "••••••••" },
      test: {
        state: "succeeded",
        outcome: "success",
        safeCode: "connection_valid",
        requestedAt: now,
        testedAt: now,
        current: true,
      },
      health: { generation: "2", state: "healthy", blocking: null },
      supervisor: {
        state: "active",
        lastRenewedAt: now,
        leaseExpiresAt: "2026-08-21T12:00:30.000Z",
        safeTakeoverAt: null,
        safeReasonCode: null,
      },
      capacity: {
        state: "available",
        safeCode: null,
        executionSlots: { used: 2, maximum: 4 },
        requestPermits: { used: 1, maximum: 2, waiting: 1 },
      },
    },
    sources: [0, 1, 2, 3].map((index) => operationSource(index)) as [
      ProviderSourceOperationsSource,
      ProviderSourceOperationsSource,
      ProviderSourceOperationsSource,
      ProviderSourceOperationsSource,
    ],
  };
}

export function operationsDetail(index = 0): ProviderSourceOperationsDetail {
  const overview = operationsOverview();
  const source = overview.sources[index]!;
  const run = source.activeRun ?? {
    id: operationsFixtureIds.runs[index]!,
    trigger: "scheduled" as const,
    state: "succeeded" as const,
    requestedAt: now,
    startedAt: now,
    finishedAt: now,
    lastProgressAt: now,
    reachedHead: true,
    failureCode: null,
    recordsPerRequest: source.source?.recordsPerRequest ?? 500,
  };
  return {
    version: overview.version,
    refreshedAt: overview.refreshedAt,
    connection: overview.connection,
    source,
    runHistory: [run],
    pageProgress: [{
      runId: run.id,
      pageNumber: 1,
      committedAt: now,
      records: { catalog: 10, pulls: 20, trades: 30, total: 60 },
      dispositions: { inserted: 44, revised: 5, duplicate: 10, quarantined: 1 },
      continuation: { kind: "continue" },
      cursorFingerprint: "a".repeat(64),
    }],
    sourceTest: {
      state: "succeeded",
      outcome: "success",
      safeCode: "source_valid",
      requestedAt: now,
      testedAt: now,
      current: true,
    },
  };
}

export function diagnosticHistory(
  index = 0,
  filter: ProviderSourceDiagnosticHistory["filter"] = {
    severity: null,
    phase: null,
    runId: null,
    contextEventsHidden: false,
  },
): ProviderSourceDiagnosticHistory {
  const source = operationSource(index);
  const events: ProviderSourceDiagnosticHistory["events"] = [
    {
      scope: "source",
      scopeLabel: "Selected source",
      eventKind: "page_committed",
      severity: "info",
      phase: "committing",
      safeCode: "PAGE_COMMITTED",
      occurredAt: now,
      durationMilliseconds: 250,
      responseBytes: 2_048,
      retryDelayMilliseconds: null,
      continuation: { kind: "continue" },
      cursorFingerprint: "a".repeat(64),
      counters: { records: 60 },
      references: [{ kind: "run", label: "Open run", href: `/runs/${operationsFixtureIds.runs[index]}?providerId=${source.providerId}` }],
    },
    ...(!filter.runId ? [{
      scope: "connection" as const,
      scopeLabel: "Shared connection" as const,
      eventKind: "connection_episode",
      severity: "warning" as const,
      phase: "requesting",
      safeCode: "CONNECTION_RETRY",
      occurredAt: "2026-08-21T11:59:00.000Z",
      durationMilliseconds: 1_000,
      responseBytes: null,
      retryDelayMilliseconds: 5_000,
      continuation: null,
      cursorFingerprint: null,
      counters: {},
      references: [],
    }] : []),
  ];
  return {
    version: "packscout.provider-source-operations.v1",
    refreshedAt: now,
    snapshot: source,
    events: events.filter((event) => (
      (!filter.severity || event.severity === filter.severity)
      && (!filter.phase || event.phase === filter.phase)
    )),
    nextCursor: "opaque-diagnostic-cursor",
    history: { state: "current" },
    filter,
    availablePhases: ["committing", "requesting"],
  };
}

export function sourceAdminCatalog(): ProviderSourceAdminCatalog {
  const sources = [0, 1, 2, 3].map((index) => operationSource(index));
  const activeConnectionRevision = {
    id: operationsFixtureIds.connectionRevision,
    revisionNumber: 1,
    sourceAdapterVersion: "dataforrest-events-adapter-v1",
    state: "active" as const,
    endpointHost: "198.204.245.26.sslip.io",
    credentialConfigured: true as const,
    credentialMask: "••••••••" as const,
    encryptionKeyVersion: 1,
    healthGeneration: "2",
    revokedAt: null,
    test: {
      jobId: operationsFixtureIds.connectionRevision,
      connectionRevisionId: operationsFixtureIds.connectionRevision,
      current: true,
      state: "succeeded" as const,
      outcome: "success" as const,
      safeCode: "connection_valid" as const,
      requestedAt: now,
      testedAt: now,
    },
    createdAt: now,
  };
  return {
    availableSourceTypes: [{
      sourceTypeKey: "dataforrest-events-v1",
      sourceAdapterVersion: "dataforrest-events-adapter-v1",
      label: "DataForrest events",
    }],
    providers: sources.map((source) => ({
      id: source.providerId,
      provider: source.provider,
      sourceRegistration: {
        sourceTypeKey: source.source!.sourceTypeKey,
        sourceAdapterVersion: source.source!.sourceAdapterVersion,
        normalizedContractVersion: source.source!.normalizedContractVersion,
        mapperKey: source.source!.mapperKey,
        mapperVersion: source.source!.mapperVersion,
        identityNamespaceKey: source.source!.identityNamespaceKey,
        recordIdScopes: [...source.source!.recordIdScopes],
      },
    })),
    connections: [{
      id: operationsFixtureIds.profile,
      displayName: "Shared DataForrest",
      sourceTypeKey: "dataforrest-events-v1",
      connectionTypeKey: "dataforrest-events-connection-v1",
      state: "active",
      requestLimit: 2,
      activeRevisionId: operationsFixtureIds.connectionRevision,
      activeRevision: activeConnectionRevision,
      recoveryFence: null,
      latestRevision: activeConnectionRevision,
      createdAt: now,
      updatedAt: now,
    }],
    sources: sources.map((source) => ({
      providerId: source.providerId,
      provider: source.provider,
      sourceInstanceId: source.source!.sourceInstanceId,
      sourceRevisionId: source.source!.sourceRevisionId,
      sourceTypeKey: source.source!.sourceTypeKey,
      sourceAdapterVersion: source.source!.sourceAdapterVersion,
      connectionProfileId: operationsFixtureIds.profile,
      connectionRevisionId: operationsFixtureIds.connectionRevision,
      state: source.source!.lifecycle,
      pauseRequested: source.source!.pauseRequested,
      normalizedContractVersion: source.source!.normalizedContractVersion,
      mapperKey: source.source!.mapperKey,
      mapperVersion: source.source!.mapperVersion,
      identityNamespaceKey: source.source!.identityNamespaceKey,
      recordIdScopes: [...source.source!.recordIdScopes],
      intervalSeconds: source.schedule!.intervalSeconds,
      recordsPerRequest: source.source!.recordsPerRequest,
      activeRunRecordsPerRequest: source.activeRun?.recordsPerRequest ?? null,
      freshnessGraceSeconds: 900 as const,
      scheduleRevisionId: source.schedule!.scheduleRevisionId,
      cursor: {
        generation: source.cursor!.generation,
        fingerprint: source.cursor!.fingerprint,
        resumeLabel: source.cursor!.resumeLabel,
      },
      test: {
        jobId: source.source!.sourceRevisionId,
        connectionRevisionId: operationsFixtureIds.connectionRevision,
        current: true,
        state: "succeeded",
        outcome: "success",
        safeCode: "source_valid",
        requestedAt: now,
        testedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    })),
  };
}
