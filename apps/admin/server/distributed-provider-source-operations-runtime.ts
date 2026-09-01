import {
  PROVIDER_SOURCE_OPERATIONS_VERSION,
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
  PrismaProviderRequestSettingsRepository,
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
import {
  configuredSource as projectConfiguredSource,
  type CentralSourceProvider as ProjectedCentralSourceProvider,
  type LocalSourceEvidence as ProjectedLocalSourceEvidence,
} from "./distributed-provider-source-projection.ts";
import { ProviderPulseMeasurementReader } from "./provider-pulse-measurements.ts";

const PROVIDER_LIMIT = 50;
const PROVIDER_READ_CONCURRENCY = 4;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const registrationKeyPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;

interface CentralSourceProvider extends ProjectedCentralSourceProvider {
  readonly activeConfig: null | Readonly<{
    id: string;
    version: bigint;
    adapterKey: string;
    scheduleSeconds: number;
    staleAfterSeconds: number;
    expiresAt: Date | null;
  }>;
}

interface LocalSourceEvidence extends ProjectedLocalSourceEvidence {
  readonly configurationCurrent: boolean;
  readonly requestSettings: Readonly<{ id: string; recordsPerRequest: number }> | null;
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
    // Settings can change independently of source configuration. Only the
    // immutable run pin says what this run actually requested.
    recordsPerRequest: run.recordsPerRequest,
  };
}

function configuredSource(input: Readonly<{
  provider: CentralSourceProvider;
  evidence: LocalSourceEvidence | null;
  capability: ProviderSourceIntegrationCapability | null;
  now: Date;
}>): ProviderSourceOperationsSource {
  const projected = projectConfiguredSource(input);
  const overview = input.evidence?.overview ?? null;
  const latest = input.evidence?.runs[0] ?? null;
  const active = overview?.activeRun
    ? input.evidence?.runs.find((run) => run.id === overview.activeRun?.id) ?? null
    : null;
  const requestSettingsAvailable = input.evidence?.configurationCurrent === true;
  const requestSettings = requestSettingsAvailable ? input.evidence?.requestSettings : null;
  return {
    ...projected,
    source: projected.source === null
      ? null
      : {
          ...projected.source,
          recordsPerRequest: requestSettingsAvailable
            ? requestSettings?.recordsPerRequest ?? projected.source.recordsPerRequest
            : null,
          requestSizePolicy: requestSettingsAvailable && !requestSettings
            ? "adapter_profile"
            : "request_settings_revision",
          requestSettingsRevisionId: requestSettings?.id ?? null,
        },
    activeRun: runSummary(active),
    latestRun: runSummary(latest),
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
  const measurements = new ProviderPulseMeasurementReader(now);

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
            version_number: true,
            adapter_key: true,
            schedule_seconds: true,
            stale_after_seconds: true,
            expires_at: true,
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
            version: row.active_config_version.version_number,
            adapterKey: row.active_config_version.adapter_key,
            scheduleSeconds: row.active_config_version.schedule_seconds,
            staleAfterSeconds: row.active_config_version.stale_after_seconds,
            expiresAt: row.active_config_version.expires_at,
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
        const [overview, page, requestSettings, runtime, measured] = await Promise.all([
          repository.overview(),
          repository.listRuns({ snapshotAt: now(), limit: 25 }),
          new PrismaProviderRequestSettingsRepository(database).current({ providerId: provider.id }),
          database.provider_runtime.findUnique({
            where: { singleton_key: true },
            select: {
              central_provider_id: true,
              provider_key: true,
              cached_config_version_id: true,
              cached_config_version_number: true,
              cached_configuration: true,
              config_expires_at: true,
            },
          }),
          measurements.read(database, { organizationId, providerId: provider.id,
            configurationId: provider.activeConfig!.id }),
        ]);
        const observedAt = now().getTime();
        const config = provider.activeConfig;
        const cached = runtime?.cached_configuration;
        const configurationCurrent = !!config && !!runtime &&
          runtime.central_provider_id === provider.id && runtime.provider_key === provider.key &&
          runtime.cached_config_version_id === config.id &&
          runtime.cached_config_version_number === config.version &&
          typeof cached === "object" && cached !== null && !Array.isArray(cached) &&
          cached.adapterKey === config.adapterKey &&
          (runtime.config_expires_at === null || runtime.config_expires_at.getTime() > observedAt) &&
          (config.expiresAt === null || config.expiresAt.getTime() > observedAt);
        const details = includeDetails
          ? (await Promise.all(page.items.map((run) => repository.getRun(run.id))))
              .filter((detail): detail is AdminLocalRunDetailRecord => detail !== null)
          : [];
        return {
          overview,
          runs: page.items,
          details,
          measurements: measured,
          requestSettings,
          configurationCurrent,
        };
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
      const views = new Array<ProviderSourceOperationsSource>(registered.length);
      let next = 0;
      // Match the bounded fleet/import readers: refill free slots while keeping
      // central's order, without opening every provider database at once.
      await Promise.all(Array.from(
        { length: Math.min(PROVIDER_READ_CONCURRENCY, registered.length) },
        async () => {
          while (next < registered.length) {
            const index = next++;
            views[index] = (await sourceView(organizationId, registered[index]!, false)).source;
          }
        },
      ));
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
