import {
  PROVIDER_SOURCE_OPERATIONS_VERSION,
  launchProviderKeySchema,
  providerSourceDiagnosticHistorySchema,
  providerSourceOperationsDetailSchema,
  providerSourceOperationsOverviewSchema,
  providerSourceOperationsSourceTypeSchema,
  type ProviderSourceAdminCatalog,
  type ProviderSourceAdminSummary,
  type ProviderSourceDiagnosticFilter,
  type ProviderSourceDiagnosticHistory,
  type ProviderSourceOperationsConnection,
  type ProviderSourceOperationsDetail,
  type ProviderSourceOperationsOverview,
  type ProviderSourceOperationsSource,
  type ProviderSourceSupervisorSnapshot,
  type VersionedSourceAdapterManifest,
} from "@packscout/contracts";

interface CountersRecord {
  readonly pages: number;
  readonly records: number;
  readonly catalog: number;
  readonly pulls: number;
  readonly trades: number;
  readonly inserted: number;
  readonly revised: number;
  readonly duplicate: number;
  readonly quarantined: number;
}

interface RunRecord {
  readonly id: string;
  readonly sourceInstanceId: string;
  readonly trigger: "scheduled" | "manual" | "continuation" | "recovery";
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly requestedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly lastProgressAt: Date;
  readonly reachedHead: boolean;
  readonly failureCode: string | null;
  readonly counters: CountersRecord;
}

interface SourceFacts {
  readonly sourceInstanceId: string;
  readonly health: Readonly<{
    lastAttemptedAt: Date | null;
    lastHeadReachedAt: Date | null;
    consecutiveFailures: number;
    latestFailureCode: string | null;
    recoveredAt: Date | null;
  }> | null;
  readonly activeRun: RunRecord | null;
  readonly latestRun: RunRecord | null;
  readonly openQuarantine: number;
}

interface OverviewRecord {
  readonly providers: readonly Readonly<{
    providerId: string;
    provider: string;
    displayName: string;
  }>[];
  readonly sources: readonly SourceFacts[];
  readonly connectionEpisodes: readonly Readonly<{
    connectionProfileId: string;
    safeCode: string;
    openedAt: Date;
  }>[];
}

interface DetailRecord {
  readonly runs: readonly RunRecord[];
  readonly pages: readonly Readonly<{
    runId: string;
    pageNumber: number;
    committedAt: Date;
    records: CountersRecord;
    continuation: Readonly<{
      kind: "continue" | "poll_after";
      minimumDelaySeconds?: number;
    }> | null;
    cursorFingerprint: string | null;
  }>[];
}

interface DiagnosticHistoryEventRecord {
  readonly id: string;
  readonly scope: "source" | "connection";
  readonly correlationKind:
    | "lifecycle"
    | "connection_test"
    | "source_test"
    | "run"
    | "page"
    | "connection_episode";
  readonly eventKind: string;
  readonly severity: "info" | "warning" | "critical";
  readonly phase: string;
  readonly safeCode: string;
  readonly occurredAt: Date;
  readonly durationMilliseconds: number | null;
  readonly responseBytes: number | null;
  readonly retryDelayMilliseconds: number | null;
  readonly continuation: Readonly<{
    kind: "continue" | "poll_after";
    minimumDelaySeconds?: number;
  }> | null;
  readonly cursorFingerprint: string | null;
  readonly counters: Readonly<Record<string, number>>;
  readonly runId: string | null;
  readonly hasTestReference: boolean;
  readonly hasCommandReference: boolean;
  readonly quarantineId: string | null;
}

export interface ProviderSourceOperationsReadRepository {
  readOverview(input: Readonly<{
    organizationId: string;
    providerIds: readonly string[];
    sourceInstanceIds: readonly string[];
    connectionProfileIds: readonly string[];
  }>): Promise<OverviewRecord>;
  readDetail(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
  }>): Promise<DetailRecord | null>;
}

export interface ProviderSourceOperationsDiagnosticRepository {
  readHistoryPage(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    limit: number;
    severity?: "info" | "warning" | "critical";
    phase?: string;
    runId?: string;
    before?: Readonly<{ occurredAt: Date; id: string }>;
    asOf?: Date;
  }>): Promise<Readonly<{
    state: "current" | "expired";
    events: readonly DiagnosticHistoryEventRecord[];
    next: Readonly<{ occurredAt: Date; id: string }> | null;
    availablePhases: readonly string[];
  }> | null>;
}

export type ProviderSourceOperationsErrorCode =
  | "SOURCE_OPERATIONS_NOT_FOUND"
  | "SOURCE_OPERATIONS_UNAVAILABLE";

export class ProviderSourceOperationsError extends Error {
  constructor(readonly code: ProviderSourceOperationsErrorCode) {
    super(`provider_source_operations.${code.toLowerCase()}`);
    this.name = "ProviderSourceOperationsError";
  }
}

export interface ProviderSourceOperationsServiceDependencies {
  readonly environmentKey: string;
  readonly catalog: Readonly<{
    read(organizationId: string): Promise<ProviderSourceAdminCatalog>;
  }>;
  readonly snapshot: Readonly<{
    read(input: Readonly<{
      environmentKey: string;
      organizationId?: string;
    }>): Promise<ProviderSourceSupervisorSnapshot>;
  }>;
  readonly repository: ProviderSourceOperationsReadRepository;
  readonly diagnostics: ProviderSourceOperationsDiagnosticRepository;
  readonly sourceTypes: readonly Readonly<{
    label: string;
    manifest: VersionedSourceAdapterManifest;
  }>[];
}

export interface ProviderSourceDiagnosticServicePage {
  readonly response: ProviderSourceDiagnosticHistory;
  readonly next: Readonly<{ occurredAt: Date; id: string }> | null;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

function safeCode(value: string | null): string | null {
  return value !== null && SAFE_CODE.test(value) ? value : null;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function runSummary(run: RunRecord | null) {
  return run === null ? null : {
    id: run.id,
    trigger: run.trigger,
    state: run.state,
    requestedAt: run.requestedAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: iso(run.finishedAt),
    lastProgressAt: run.lastProgressAt.toISOString(),
    reachedHead: run.reachedHead,
    failureCode: safeCode(run.failureCode),
  };
}

function selectedSource(
  catalog: ProviderSourceAdminCatalog,
  providerId: string,
): ProviderSourceAdminSummary | null {
  const statePriority = new Map([
    ["active", 0],
    ["paused", 1],
    ["draft", 2],
    ["disabled", 3],
    ["replaced", 4],
  ]);
  return catalog.sources
    .filter((source) => source.providerId === providerId)
    .sort((left, right) =>
      (statePriority.get(left.state) ?? 9) -
        (statePriority.get(right.state) ?? 9) ||
      right.updatedAt.localeCompare(left.updatedAt)
    )[0] ?? null;
}

function elapsedMilliseconds(run: RunRecord | null, databaseTime: Date): number {
  if (!run?.startedAt) return 0;
  return Math.max(
    0,
    (run.finishedAt ?? databaseTime).getTime() - run.startedAt.getTime(),
  );
}

function sourceTypeSummary(
  dependencies: ProviderSourceOperationsServiceDependencies,
  sourceTypeKey: string,
  sourceAdapterVersion: string,
) {
  const registration = dependencies.sourceTypes.find(
    ({ manifest }) => manifest.sourceTypeKey === sourceTypeKey &&
      manifest.adapterVersion === sourceAdapterVersion,
  );
  if (!registration) {
    throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
  }
  const { manifest } = registration;
  return providerSourceOperationsSourceTypeSchema.parse({
    sourceTypeKey: manifest.sourceTypeKey,
    label: registration.label,
    adapterVersion: manifest.adapterVersion,
    normalizedContractVersion: manifest.normalizedContractVersion,
    capabilities: { ...manifest.capabilities },
  });
}

function connectionSummary(input: Readonly<{
  dependencies: ProviderSourceOperationsServiceDependencies;
  catalog: ProviderSourceAdminCatalog;
  snapshot: ProviderSourceSupervisorSnapshot;
  facts: OverviewRecord;
  source: ProviderSourceAdminSummary | null;
}>): ProviderSourceOperationsConnection | null {
  const preferredProfileId = input.source?.connectionProfileId;
  const connection = preferredProfileId === undefined
    ? input.catalog.connections.find(({ state }) => state === "active") ??
      input.catalog.connections[0] ?? null
    : input.catalog.connections.find(({ id }) => id === preferredProfileId) ??
      null;
  if (!connection) {
    if (preferredProfileId !== undefined) {
      throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
    }
    return null;
  }
  if (
    connection.activeRevisionId !== (connection.activeRevision?.id ?? null) ||
    (connection.activeRevision !== null &&
      (connection.activeRevision.state !== "active" ||
        connection.activeRevision.revokedAt !== null))
  ) {
    throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
  }
  const revision = connection.activeRevision ?? connection.latestRevision;
  const sourceUsesConnection = input.source !== null &&
    !["disabled", "replaced"].includes(input.source.state);
  if (
    sourceUsesConnection &&
    (input.source.sourceAdapterVersion !== revision.sourceAdapterVersion ||
      (input.source.connectionRevisionId === null &&
        input.source.state !== "draft") ||
      (input.source.connectionRevisionId !== null &&
        input.source.connectionRevisionId !== revision.id))
  ) {
    throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
  }
  const episode = input.facts.connectionEpisodes.find(
    ({ connectionProfileId }) => connectionProfileId === connection.id,
  );
  const reconnecting = connection.recoveryFence !== null &&
    ["candidate", "pending", "running"].includes(
      connection.latestRevision.state === "candidate"
        ? "candidate"
        : connection.latestRevision.test.state,
    );
  const profileCapacity = input.snapshot.capacity.profiles.find(
    ({ connectionProfileId }) => connectionProfileId === connection.id,
  );
  return {
    connectionProfileId: connection.id,
    displayName: connection.displayName,
    sourceType: sourceTypeSummary(
      input.dependencies,
      connection.sourceTypeKey,
      revision.sourceAdapterVersion,
    ),
    state: connection.state,
    endpointHost: revision.endpointHost,
    credential: {
      configured: revision.credentialConfigured,
      mask: revision.credentialMask,
    },
    test: {
      state: revision.test.state,
      outcome: revision.test.outcome,
      safeCode: revision.test.safeCode,
      requestedAt: revision.test.requestedAt,
      testedAt: revision.test.testedAt,
      current: revision.test.current,
    },
    health: {
      generation: revision.healthGeneration,
      state: reconnecting ? "reconnecting" : episode ? "blocked" : "healthy",
      blocking: episode
        ? {
            safeCode: safeCode(episode.safeCode) ?? "CONNECTION_BLOCKED",
            openedAt: episode.openedAt.toISOString(),
          }
        : null,
    },
    supervisor: {
      state: input.snapshot.presence.state,
      lastRenewedAt: input.snapshot.presence.lastRenewedAt,
      leaseExpiresAt: input.snapshot.presence.leaseExpiresAt,
      safeTakeoverAt: input.snapshot.presence.safeTakeoverAt,
      safeReasonCode: input.snapshot.presence.safeReasonCode,
    },
    capacity: {
      state: input.snapshot.capacity.state,
      safeCode: input.snapshot.capacity.safeCode,
      executionSlots: { ...input.snapshot.capacity.executionSlots },
      requestPermits: {
        used: profileCapacity?.used ?? 0,
        maximum: profileCapacity?.maximum ?? connection.requestLimit,
        waiting: profileCapacity?.waiting ?? 0,
      },
    },
  };
}

function sourceSummary(input: Readonly<{
  provider: ProviderSourceAdminCatalog["providers"][number];
  displayName: string;
  source: ProviderSourceAdminSummary | null;
  facts: SourceFacts | null;
  snapshot: ProviderSourceSupervisorSnapshot;
  connection: ProviderSourceOperationsConnection | null;
}>): ProviderSourceOperationsSource {
  const lane = input.source
    ? input.snapshot.sources.find(
        ({ sourceInstanceId }) =>
          sourceInstanceId === input.source!.sourceInstanceId,
      ) ?? null
    : null;
  const databaseTime = new Date(input.snapshot.presence.databaseTime);
  const run = input.facts?.activeRun ?? input.facts?.latestRun ?? null;
  const counters = run?.counters ?? {
    pages: lane?.progress.pagesCommitted ?? 0,
    records: lane?.progress.recordsCommitted ?? 0,
    catalog: 0,
    pulls: 0,
    trades: 0,
    inserted: 0,
    revised: 0,
    duplicate: 0,
    quarantined: 0,
  };
  const elapsed = elapsedMilliseconds(run, databaseTime);
  const due = input.source && lane?.nextDueAt
    ? new Date(lane.nextDueAt).getTime() +
      input.source.freshnessGraceSeconds * 1_000
    : null;
  const freshnessState = input.source === null || due === null ||
      input.facts?.health?.lastHeadReachedAt === null ||
      input.facts?.health === null
    ? "unknown" as const
    : databaseTime.getTime() > due
      ? "stale" as const
      : "fresh" as const;
  const localFailure = lane?.actionRequiredCode ??
    input.facts?.health?.latestFailureCode ?? null;
  const qualityState = input.source === null || input.facts?.health === null
    ? "unknown" as const
    : localFailure !== null
      ? "degraded" as const
      : ((input.facts?.openQuarantine ?? 0) > 0
          ? "warning" as const
          : "healthy" as const);
  const connectionHealth = input.connection?.health;
  const uncertain = connectionHealth?.blocking?.safeCode.includes("UNCERTAIN") ?? false;
  const connectionImpact = connectionHealth?.state === "blocked"
    ? {
        state: uncertain ? "uncertain" as const : "blocked" as const,
        safeCode: connectionHealth.blocking?.safeCode ?? "CONNECTION_BLOCKED",
        healthGeneration: connectionHealth.generation,
      }
    : connectionHealth?.state === "reconnecting"
      ? {
          state: "reconnecting" as const,
          safeCode: connectionHealth.blocking?.safeCode ?? null,
          healthGeneration: connectionHealth.generation,
        }
      : { state: "none" as const, safeCode: null, healthGeneration: null };
  return {
    providerId: input.provider.id,
    provider: input.provider.provider,
    displayName: input.displayName,
    configured: input.source !== null,
    source: input.source
      ? {
          sourceInstanceId: input.source.sourceInstanceId,
          sourceRevisionId: input.source.sourceRevisionId,
          sourceTypeKey: input.source.sourceTypeKey,
          sourceAdapterVersion: input.source.sourceAdapterVersion,
          normalizedContractVersion: input.source.normalizedContractVersion,
          mapperKey: input.source.mapperKey,
          mapperVersion: input.source.mapperVersion,
          identityNamespaceKey: input.source.identityNamespaceKey,
          recordIdScopes: [...input.source.recordIdScopes],
          lifecycle: input.source.state,
          pauseRequested: input.source.pauseRequested,
          configuration: {
            validated: true,
            fields: [
              { label: "Provider binding", value: input.provider.provider, masked: false },
              { label: "Source type", value: input.source.sourceTypeKey, masked: false },
            ],
          },
        }
      : null,
    schedule: input.source
      ? {
          scheduleRevisionId: input.source.scheduleRevisionId,
          intervalSeconds: input.source.intervalSeconds,
          freshnessGraceSeconds: input.source.freshnessGraceSeconds,
          nextDueAt: lane?.nextDueAt ?? null,
        }
      : null,
    processor: lane
      ? {
          activity: lane.activity,
          phase: lane.phase,
          waitReason: lane.waitReason,
          actionRequiredCode: lane.actionRequiredCode,
          continuation: lane.continuation,
          retryCount: lane.retry.attempt,
          retryNotBefore: lane.retry.notBefore,
          runLeaseAgeMilliseconds: lane.runLeaseAgeMilliseconds,
        }
      : null,
    freshness: {
      state: freshnessState,
      lastHeadReachedAt: iso(input.facts?.health?.lastHeadReachedAt ?? null),
      lastProgressAt: lane?.progress.lastProgressAt ??
        iso(run?.lastProgressAt ?? null),
    },
    quality: {
      state: qualityState,
      consecutiveFailures: input.facts?.health?.consecutiveFailures ?? 0,
      latestFailureCode: safeCode(localFailure),
      recoveredAt: iso(input.facts?.health?.recoveredAt ?? null),
    },
    cursor: input.source
      ? {
          generation: input.source.cursor.generation,
          fingerprint: input.source.cursor.fingerprint,
          resumeLabel: input.source.cursor.resumeLabel,
        }
      : null,
    progress: {
      pages: counters.pages,
      records: {
        catalog: counters.catalog,
        pulls: counters.pulls,
        trades: counters.trades,
        total: counters.records,
      },
      dispositions: {
        inserted: counters.inserted,
        revised: counters.revised,
        duplicate: counters.duplicate,
        quarantined: counters.quarantined,
      },
      throughputRecordsPerSecond: elapsed > 0
        ? Number((counters.records / (elapsed / 1_000)).toFixed(2))
        : null,
      elapsedMilliseconds: elapsed,
      openQuarantine: input.facts?.openQuarantine ?? 0,
      total: { kind: "unknown", label: "Total unknown" },
    },
    activeRun: runSummary(input.facts?.activeRun ?? null),
    latestRun: runSummary(input.facts?.latestRun ?? null),
    connectionImpact,
  };
}

export class ProviderSourceOperationsService {
  readonly #dependencies: ProviderSourceOperationsServiceDependencies;

  constructor(dependencies: ProviderSourceOperationsServiceDependencies) {
    if (!dependencies.environmentKey.trim() || dependencies.sourceTypes.length === 0) {
      throw new TypeError("Provider source operations dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  async #composeOverview(organizationId: string): Promise<Readonly<{
    catalog: ProviderSourceAdminCatalog;
    connections: readonly (ProviderSourceOperationsConnection | null)[];
    response: ProviderSourceOperationsOverview;
  }>> {
    const [catalog, snapshot] = await Promise.all([
      this.#dependencies.catalog.read(organizationId),
      this.#dependencies.snapshot.read({
        environmentKey: this.#dependencies.environmentKey,
        organizationId,
      }),
    ]);
    if (catalog.providers.length !== 4) {
      throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
    }
    const sources = catalog.providers.map(({ id }) => selectedSource(catalog, id));
    const facts = await this.#dependencies.repository.readOverview({
      organizationId,
      providerIds: catalog.providers.map(({ id }) => id),
      sourceInstanceIds: sources.flatMap((source) =>
        source ? [source.sourceInstanceId] : []
      ),
      connectionProfileIds: catalog.connections.map(({ id }) => id),
    });
    const connections = sources.map((source) =>
      source === null
        ? null
        : connectionSummary({
            dependencies: this.#dependencies,
            catalog,
            snapshot,
            facts,
            source,
          })
    );
    const configuredConnections = connections.filter(
      (connection): connection is ProviderSourceOperationsConnection =>
        connection !== null,
    );
    const connectionProfileIds = new Set(
      configuredConnections.map(({ connectionProfileId }) =>
        connectionProfileId
      ),
    );
    const connection = configuredConnections.length === 0
      ? connectionSummary({
          dependencies: this.#dependencies,
          catalog,
          snapshot,
          facts,
          source: null,
        })
      : connectionProfileIds.size === 1
        ? configuredConnections[0] ?? null
        : null;
    let connectionMode: "none" | "shared" | "split";
    if (configuredConnections.length === 0) {
      connectionMode = connection === null ? "none" : "shared";
    } else {
      connectionMode = connectionProfileIds.size === 1 ? "shared" : "split";
    }
    const summaries = catalog.providers.map((provider, index) => {
      const source = sources[index] ?? null;
      const providerRecord = facts.providers.find(
        ({ providerId }) => providerId === provider.id,
      );
      if (!providerRecord || !launchProviderKeySchema.safeParse(providerRecord.provider).success) {
        throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
      }
      return sourceSummary({
        provider,
        displayName: providerRecord.displayName,
        source,
        facts: source
            ? facts.sources.find(
              ({ sourceInstanceId }) => sourceInstanceId === source.sourceInstanceId,
            ) ?? null
          : null,
        snapshot,
        connection: connections[index] ?? null,
      });
    });
    const response = providerSourceOperationsOverviewSchema.parse({
      version: PROVIDER_SOURCE_OPERATIONS_VERSION,
      refreshedAt: snapshot.presence.databaseTime,
      connectionMode,
      connection,
      sources: summaries,
    });
    return { catalog, connections, response };
  }

  async overview(organizationId: string): Promise<ProviderSourceOperationsOverview> {
    return (await this.#composeOverview(organizationId)).response;
  }

  async detail(
    organizationId: string,
    providerId: string,
  ): Promise<ProviderSourceOperationsDetail> {
    const overview = await this.#composeOverview(organizationId);
    const sourceIndex = overview.response.sources.findIndex(
      (candidate) => candidate.providerId === providerId,
    );
    const source = overview.response.sources[sourceIndex];
    if (!source?.source) {
      throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_NOT_FOUND");
    }
    const record = await this.#dependencies.repository.readDetail({
      organizationId,
      providerId,
      sourceInstanceId: source.source.sourceInstanceId,
    });
    if (!record) {
      throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_NOT_FOUND");
    }
    const adminSource = overview.catalog.sources.find(
      ({ sourceInstanceId }) =>
        sourceInstanceId === source.source!.sourceInstanceId,
    );
    return providerSourceOperationsDetailSchema.parse({
      version: PROVIDER_SOURCE_OPERATIONS_VERSION,
      refreshedAt: overview.response.refreshedAt,
      connection: overview.connections[sourceIndex] ?? null,
      source,
      runHistory: record.runs.map(runSummary),
      pageProgress: record.pages.map((page) => ({
        runId: page.runId,
        pageNumber: page.pageNumber,
        committedAt: page.committedAt.toISOString(),
        records: {
          catalog: page.records.catalog,
          pulls: page.records.pulls,
          trades: page.records.trades,
          total: page.records.records,
        },
        dispositions: {
          inserted: page.records.inserted,
          revised: page.records.revised,
          duplicate: page.records.duplicate,
          quarantined: page.records.quarantined,
        },
        continuation: page.continuation,
        cursorFingerprint: page.cursorFingerprint,
      })),
      sourceTest: adminSource ? {
        state: adminSource.test.state,
        outcome: adminSource.test.outcome,
        safeCode: adminSource.test.safeCode,
        requestedAt: adminSource.test.requestedAt,
        testedAt: adminSource.test.testedAt,
        current: adminSource.test.current,
      } : null,
    });
  }

  async diagnostics(input: Readonly<{
    organizationId: string;
    providerId: string;
    filter: ProviderSourceDiagnosticFilter;
    limit: number;
    before?: Readonly<{ occurredAt: Date; id: string }>;
  }>): Promise<ProviderSourceDiagnosticServicePage> {
    const detail = await this.detail(input.organizationId, input.providerId);
    if (!detail.source.source) {
      throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_NOT_FOUND");
    }
    const page = await this.#dependencies.diagnostics.readHistoryPage({
      organizationId: input.organizationId,
      providerId: input.providerId,
      sourceInstanceId: detail.source.source.sourceInstanceId,
      limit: input.limit,
      ...input.filter,
      ...(input.before ? { before: input.before } : {}),
      asOf: new Date(detail.refreshedAt),
    });
    if (!page) {
      throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_NOT_FOUND");
    }
    const response = providerSourceDiagnosticHistorySchema.parse({
      version: PROVIDER_SOURCE_OPERATIONS_VERSION,
      refreshedAt: detail.refreshedAt,
      snapshot: detail.source,
      events: page.events.map((event) => ({
        scope: event.scope,
        scopeLabel: event.scope === "connection"
          ? "Shared connection"
          : "Selected source",
        eventKind: event.eventKind,
        severity: event.severity,
        phase: event.phase,
        safeCode: event.safeCode,
        occurredAt: event.occurredAt.toISOString(),
        durationMilliseconds: event.durationMilliseconds,
        responseBytes: event.responseBytes,
        retryDelayMilliseconds: event.retryDelayMilliseconds,
        continuation: event.continuation,
        cursorFingerprint: event.cursorFingerprint,
        counters: event.counters,
        references: [
          ...(event.runId ? [{
            kind: "run" as const,
            label: "Open run",
            href: `/runs/${event.runId}`,
          }] : []),
          ...(event.quarantineId ? [{
            kind: "quarantine" as const,
            label: "Open quarantine",
            href: `/quarantine/${event.quarantineId}`,
          }] : []),
          ...(event.hasTestReference ? [{
            kind: "test" as const,
            label: "Source test evidence",
            href: `/providers/${input.providerId}`,
          }] : []),
          ...(event.hasCommandReference ? [{
            kind: "command" as const,
            label: "Source configuration",
            href: "/source-configuration",
          }] : []),
        ],
      })),
      nextCursor: null,
      history: page.state === "expired"
        ? {
            state: "expired",
            message:
              "Older diagnostic history has expired. Current source state is shown above.",
          }
        : { state: "current" },
      filter: {
        severity: input.filter.severity ?? null,
        phase: input.filter.phase ?? null,
        runId: input.filter.runId ?? null,
        contextEventsHidden: input.filter.runId !== undefined,
      },
      availablePhases: [...page.availablePhases],
    });
    return { response, next: page.next };
  }
}
