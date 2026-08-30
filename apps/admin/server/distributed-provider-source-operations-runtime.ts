import {
  DATAFORREST_EVENTS_V1_SOURCE_TYPE_KEY,
  PROVIDER_SOURCE_OPERATIONS_VERSION,
  dataforrestEventsV1SourceAdapterManifests,
  importRunDetailPath,
  launchProviderKeySchema,
  providerSourceDiagnosticHistorySchema,
  providerSourceOperationsDetailSchema,
  providerSourceOperationsOverviewSchema,
  type ProviderSourceDiagnosticFilter,
  type ProviderSourceOperationsSource,
} from "@packscout/contracts";
import {
  PrismaAdminProviderRuntimeRepository,
  type AdminLocalProviderOverview,
  type AdminLocalRunDetailRecord,
  type AdminLocalRunRecord,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
} from "@packscout/database";
import {
  ProviderSourceOperationsError,
  type ProviderSourceIntegrationCapability,
  type ProviderSourceIntegrationCapabilityRegistry,
} from "@packscout/services";
import type { ProviderSourceOperationsRouterDependencies } from
  "./routes/provider-source-operations.ts";

const PROVIDER_LIMIT = 50;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const registrationKeyPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

interface CentralSourceProvider {
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

interface LocalSourceEvidence {
  readonly overview: AdminLocalProviderOverview;
  readonly runs: readonly AdminLocalRunRecord[];
  readonly details: readonly AdminLocalRunDetailRecord[];
}

function safeCode(value: string | null, fallback: string): string | null {
  if (value === null) return null;
  return safeCodePattern.test(value) ? value : fallback;
}

function runSummary(run: AdminLocalRunRecord | null) {
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

function configuredSource(input: Readonly<{
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
  const elapsed = elapsedMilliseconds(latest, input.now);
  const totalRecords = latest === null
    ? 0
    : latest.catalogCount + latest.pullCount + latest.marketEventCount;
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
      lastProgressAt: latest?.lastProgressAt?.toISOString() ?? null,
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
      pages: latest?.pageCount ?? 0,
      records: {
        catalog: latest?.catalogCount ?? 0,
        pulls: latest?.pullCount ?? 0,
        trades: latest?.marketEventCount ?? 0,
        total: totalRecords,
      },
      dispositions: {
        // The canonical run records combined material changes, not insert/update counts.
        inserted: null,
        revised: null,
        duplicate: latest?.duplicateCount ?? 0,
        quarantined: latest?.quarantinedCount ?? 0,
      },
      throughputRecordsPerSecond: elapsed > 0
        ? Number((totalRecords / (elapsed / 1_000)).toFixed(2))
        : null,
      elapsedMilliseconds: elapsed,
      openQuarantine: overview?.openQuarantineCount ?? 0,
      total: { kind: "unknown", label: "Total unknown" },
    },
    activeRun: runSummary(active),
    latestRun: runSummary(latest),
    connectionImpact: {
      state: "none",
      safeCode: null,
      healthGeneration: null,
    },
  };
}

function registrationKey(value: string): string {
  const candidate = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "_")
    .replace(/^[_\-.]+|[_\-.]+$/gu, "").slice(0, 128);
  return registrationKeyPattern.test(candidate) ? candidate : "provider_activity";
}

function activitySafeCode(value: string): string {
  const candidate = value.toUpperCase().replace(/[^A-Z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "").slice(0, 128);
  return safeCodePattern.test(candidate) ? candidate : "PROVIDER_ACTIVITY";
}

/** Real, bounded operations projection over central configuration and local runtime evidence. */
export function createDistributedProviderSourceOperationsRuntime(
  input: Readonly<{
    central: CentralPrismaClient;
    gateway: Pick<
      BoundedProviderDatabaseGateway,
      "runWithAdminProviderDatabase"
    >;
    sourceIntegrations: Pick<
      ProviderSourceIntegrationCapabilityRegistry,
      "resolve"
    >;
    diagnosticCursorKey: Uint8Array;
    now?: () => Date;
  }>,
): Omit<ProviderSourceOperationsRouterDependencies, "auth" | "cookiePolicy"> {
  const now = input.now ?? (() => new Date());

  async function providers(
    organizationId: string,
    providerId?: string,
  ): Promise<readonly CentralSourceProvider[]> {
    const rows = await input.central.providers.findMany({
      where: {
        organization_id: organizationId,
        lifecycle: { not: "archived" },
        ...(providerId ? { id: providerId } : {}),
      },
      orderBy: [{ provider_key: "asc" }, { id: "asc" }],
      take: providerId ? 1 : PROVIDER_LIMIT,
      select: {
        id: true,
        provider_key: true,
        display_name: true,
        lifecycle: true,
        active_config_version: {
          select: {
            id: true,
            adapter_key: true,
            schedule_seconds: true,
            stale_after_seconds: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.provider_key,
      displayName: row.display_name,
      lifecycle: row.lifecycle,
      activeConfig: row.active_config_version === null
        ? null
        : {
            id: row.active_config_version.id,
            adapterKey: row.active_config_version.adapter_key,
            scheduleSeconds: row.active_config_version.schedule_seconds,
            staleAfterSeconds: row.active_config_version.stale_after_seconds,
          },
    }));
  }

  async function localEvidence(
    organizationId: string,
    provider: CentralSourceProvider,
    includeDetails: boolean,
  ): Promise<LocalSourceEvidence | null> {
    const result = await input.gateway.runWithAdminProviderDatabase(
      { organizationId, providerId: provider.id },
      async (database) => {
        const repository = new PrismaAdminProviderRuntimeRepository(database);
        const [overview, page] = await Promise.all([
          repository.overview(),
          repository.listRuns({ snapshotAt: now(), limit: 25 }),
        ]);
        const details = includeDetails
          ? (await Promise.all(page.items.map((run) => repository.getRun(run.id))))
              .filter((detail): detail is AdminLocalRunDetailRecord => detail !== null)
          : [];
        return { overview, runs: page.items, details };
      },
    );
    return result.state === "reachable" ? result.value : null;
  }

  async function sourceView(
    organizationId: string,
    provider: CentralSourceProvider,
    includeDetails: boolean,
  ) {
    if (!launchProviderKeySchema.safeParse(provider.key).success) {
      throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_UNAVAILABLE");
    }
    const capability = provider.activeConfig === null
      ? null
      : input.sourceIntegrations.resolve(
        provider.key,
        provider.activeConfig.adapterKey,
      );
    const evidence = capability !== null
      ? await localEvidence(organizationId, provider, includeDetails)
      : null;
    return {
      source: configuredSource({
        provider,
        evidence,
        capability,
        now: now(),
      }),
      evidence,
    };
  }

  const operations = {
    async overview(organizationId: string) {
      const registered = await providers(organizationId);
      const views = [];
      for (const provider of registered) {
        views.push((await sourceView(organizationId, provider, false)).source);
      }
      return providerSourceOperationsOverviewSchema.parse({
        version: PROVIDER_SOURCE_OPERATIONS_VERSION,
        refreshedAt: now().toISOString(),
        connectionMode: "none",
        connection: null,
        sources: views,
      });
    },

    async detail(organizationId: string, providerId: string) {
      const [provider] = await providers(organizationId, providerId);
      if (!provider) {
        throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_NOT_FOUND");
      }
      const view = await sourceView(organizationId, provider, true);
      if (!view.source.source) {
        throw new ProviderSourceOperationsError("SOURCE_OPERATIONS_NOT_FOUND");
      }
      const details = view.evidence?.details ?? [];
      const pages = details.flatMap((run) => run.pages.map((page) => ({
        runId: run.id,
        pageNumber: page.pageNumber,
        committedAt: page.committedAt.toISOString(),
        records: {
          catalog: page.catalogCount,
          pulls: page.pullCount,
          trades: page.marketEventCount,
          total: page.catalogCount + page.pullCount + page.marketEventCount,
        },
        dispositions: {
          inserted: null,
          revised: null,
          duplicate: page.duplicateCount,
          quarantined: page.quarantinedCount,
        },
        continuation: page.continuation === "more"
          ? { kind: "continue" as const }
          : null,
        cursorFingerprint: page.nextCursorHash,
      }))).slice(0, 50);
      return providerSourceOperationsDetailSchema.parse({
        version: PROVIDER_SOURCE_OPERATIONS_VERSION,
        refreshedAt: now().toISOString(),
        connection: null,
        source: view.source,
        runHistory: (view.evidence?.runs ?? []).map(runSummary),
        pageProgress: pages,
        sourceTest: null,
      });
    },

    async diagnostics(request: Readonly<{
      organizationId: string;
      providerId: string;
      filter: ProviderSourceDiagnosticFilter;
      limit: number;
      before?: Readonly<{ occurredAt: Date; id: string }>;
    }>) {
      const detail = await operations.detail(
        request.organizationId,
        request.providerId,
      );
      const phaseMatches = request.filter.phase === undefined ||
        request.filter.phase === "provider";
      const rows = phaseMatches
        ? await input.central.provider_activity_events.findMany({
            where: {
              organization_id: request.organizationId,
              provider_id: request.providerId,
              ...(request.filter.severity
                ? { severity: request.filter.severity }
                : {}),
              ...(request.filter.runId
                ? { local_run_id: request.filter.runId }
                : {}),
              ...(request.before
                ? {
                    OR: [
                      { event_at: { lt: request.before.occurredAt } },
                      {
                        event_at: request.before.occurredAt,
                        id: { lt: request.before.id },
                      },
                    ],
                  }
                : {}),
            },
            orderBy: [{ event_at: "desc" }, { id: "desc" }],
            take: request.limit + 1,
            select: {
              id: true,
              event_type: true,
              severity: true,
              event_at: true,
              local_run_id: true,
              local_quarantine_id: true,
            },
          })
        : [];
      const items = rows.slice(0, request.limit);
      const last = items.at(-1);
      return {
        response: providerSourceDiagnosticHistorySchema.parse({
          version: PROVIDER_SOURCE_OPERATIONS_VERSION,
          refreshedAt: detail.refreshedAt,
          snapshot: detail.source,
          events: items.map((event) => ({
            scope: "source",
            scopeLabel: "Selected source",
            eventKind: registrationKey(event.event_type),
            severity: event.severity,
            phase: "provider",
            safeCode: activitySafeCode(event.event_type),
            occurredAt: event.event_at.toISOString(),
            durationMilliseconds: null,
            responseBytes: null,
            retryDelayMilliseconds: null,
            continuation: null,
            cursorFingerprint: null,
            counters: {},
            references: [
              ...(event.local_run_id
                ? [{
                    kind: "run" as const,
                    label: "Open run",
                    href: importRunDetailPath({ providerId: request.providerId, runId: event.local_run_id }),
                  }]
                : []),
              ...(event.local_quarantine_id
                ? [{
                    kind: "quarantine" as const,
                    label: "Open quarantine",
                    href: `/quarantine/${event.local_quarantine_id}`,
                  }]
                : []),
            ],
          })),
          nextCursor: null,
          history: { state: "current" },
          filter: {
            severity: request.filter.severity ?? null,
            phase: request.filter.phase ?? null,
            runId: request.filter.runId ?? null,
            contextEventsHidden: request.filter.runId !== undefined,
          },
          availablePhases: ["provider"],
        }),
        next: rows.length > request.limit && last
          ? { occurredAt: last.event_at, id: last.id }
          : null,
      };
    },
  };

  return {
    operations,
    diagnosticCursorKey: input.diagnosticCursorKey,
  };
}
