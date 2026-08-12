import { createHmac, randomUUID } from "node:crypto";
import {
  PrismaAdminImportRunRepository,
  PrismaAdminProviderOperationRepository,
  PrismaImportRunRepository,
  PrismaProviderConfigurationRepository,
  PrismaProviderHealthRepository,
  PrismaQuarantineRepository,
  IngestionPersistenceRepository,
  type AdminImportRunRecord,
  type AdminImportRunState,
  type PersistedQuarantineEntry,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CatalogProjectionService,
  createProviderMappingAdapterRegistryFromManifest,
  DefaultProviderImportPagePlanner,
  EventProjectionService,
  HmacProviderActorPseudonymizer,
  HttpCursorAdapter,
  ProviderHealthService,
  ProviderImportService,
  ProviderProjectionService,
  ProviderTransportAdapterRegistry,
  QuarantineService,
  type ProviderActorKeyer,
  type ProviderFreshnessOperationalHooks,
  type ProviderRuntimeEnvironment,
  type QuarantineOperationalHooks,
} from "@packscout/services";
import type { QuarantineEntrySummary } from "@packscout/contracts";
import type {
  ImportOperationsRouterDependencies,
  ImportRunDetailView,
  ImportRunSummaryView,
} from "./routes/import-operations.ts";

type AdminOperationsDatabase = ConstructorParameters<
  typeof PrismaAdminImportRunRepository
>[0];

export interface AdminImportOperationsRuntimeInput {
  readonly database: AdminOperationsDatabase;
  readonly actorPseudonymKey: Uint8Array;
  readonly credentialKey: Uint8Array;
  readonly credentialKeyVersion?: number;
  readonly environment: ProviderRuntimeEnvironment;
  readonly operational?: ProviderFreshnessOperationalHooks & QuarantineOperationalHooks;
}

export class InvalidOperationCursorError extends Error {
  readonly code = "INVALID_OPERATION_CURSOR";

  constructor() {
    super("The operation page cursor is invalid.");
    this.name = "InvalidOperationCursorError";
  }
}

type CursorKind = "provider" | "run" | "quarantine";

interface CursorPayload {
  readonly version: 1;
  readonly kind: CursorKind;
  readonly value: string;
  readonly id: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

function encodeCursor(kind: CursorKind, value: string, id: string): string {
  return Buffer.from(JSON.stringify({ version: 1, kind, value, id }), "utf8")
    .toString("base64url");
}

function decodeCursor(kind: CursorKind, cursor: string | undefined): CursorPayload | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (
      parsed.version !== 1 ||
      parsed.kind !== kind ||
      typeof parsed.value !== "string" ||
      parsed.value.length < 1 ||
      parsed.value.length > 128 ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    if (kind !== "provider" && !Number.isFinite(Date.parse(parsed.value))) {
      throw new Error("invalid");
    }
    return parsed as CursorPayload;
  } catch {
    throw new InvalidOperationCursorError();
  }
}

function actorKeyer(key: Uint8Array): ProviderActorKeyer {
  const secret = Buffer.from(key);
  if (secret.byteLength < 32) {
    throw new Error("Provider actor key must be at least 32 bytes.");
  }
  return {
    keyFor({ organizationId, operatorId }) {
      return `actor:v1:${createHmac("sha256", secret)
        .update(
          `packscout-provider-request:v1\u0000${organizationId}\u0000${operatorId}`,
        )
        .digest("hex")}`;
    },
  };
}

function failureClass(code: string): string {
  if (code.includes("AUTHENTICATION")) return "authentication";
  if (code.includes("CONFIGURATION") || code.includes("DESTINATION")) return "configuration";
  if (code.includes("CONTRACT") || code.includes("JSON") || code.includes("CURSOR")) return "contract";
  if (code.includes("MAPPING") || code.includes("CALCULATION")) return "mapping";
  if (code.includes("PERSISTENCE")) return "persistence";
  if (code.includes("RATE_LIMIT")) return "rate_limit";
  if (code.includes("TIMEOUT")) return "timeout";
  if (code.includes("UNREACHABLE") || code.includes("HTTP")) return "unreachable";
  return "unknown";
}

function quarantineSummary(entry: PersistedQuarantineEntry): QuarantineEntrySummary {
  return {
    id: entry.id,
    providerId: entry.providerId,
    configurationRevisionId: entry.configurationRevisionId,
    platformKey: entry.platformKey,
    runId: entry.runId,
    pageId: entry.pageId,
    recordKind: entry.recordKind,
    recordIndex: entry.recordIndex,
    externalId: entry.externalId,
    reasonCode: safeCodePattern.test(entry.reasonCode)
      ? entry.reasonCode
      : "QUARANTINE_REASON_UNAVAILABLE",
    fieldPath: entry.fieldPath,
    sanitizedSummary: entry.sanitizedSummary,
    state: entry.state,
    attemptCount: entry.retryCount,
    firstFailureAt: entry.createdAt.toISOString(),
    latestFailureAt: (entry.lastRetryAt ?? entry.createdAt).toISOString(),
    rawExpiresAt: entry.expiresAt.toISOString(),
    resolvedAt: entry.resolvedAt?.toISOString() ?? null,
    resolutionSummary: entry.resolutionSummary,
  };
}

function runSummary(run: AdminImportRunRecord): ImportRunSummaryView {
  return {
    id: run.id,
    providerId: run.providerId,
    providerName: run.providerName,
    platformKey: run.platformKey,
    configurationRevisionId: run.configurationRevisionId,
    configurationVersion: run.configurationVersion,
    trigger: run.trigger,
    state: run.state,
    requestedAt: run.requestedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    lastProgressAt: run.lastProgressAt.toISOString(),
    reachedProviderHead: run.reachedProviderHead,
    counters: run.counters,
    failure: run.failureCode
      ? {
          class: failureClass(run.failureCode),
          code: safeCodePattern.test(run.failureCode)
            ? run.failureCode
            : "IMPORT_FAILURE_UNAVAILABLE",
          summary: "The import stopped with a bounded operational failure.",
        }
      : null,
  };
}

function timeline(run: AdminImportRunRecord): ImportRunDetailView["timeline"] {
  const events: Array<{
    state: AdminImportRunState;
    occurredAt: string;
    summary: string;
  }> = [{ state: "queued", occurredAt: run.requestedAt.toISOString(), summary: "queued" }];
  if (run.startedAt) {
    events.push({ state: "running", occurredAt: run.startedAt.toISOString(), summary: "running" });
  }
  if (run.finishedAt && run.state !== "queued" && run.state !== "running") {
    events.push({ state: run.state, occurredAt: run.finishedAt.toISOString(), summary: run.state });
  }
  return events;
}

function toRunDetail(
  run: AdminImportRunRecord,
  relatedQuarantines: readonly QuarantineEntrySummary[],
): ImportRunDetailView {
  return {
    ...runSummary(run),
    cursor: {
      requestedPreview: run.requestedCursor,
      finalPreview: run.finalCursor,
    },
    pages: run.pages.map((page) => ({
      pageNumber: page.pageNumber,
      requestedCursorPreview: page.requestedCursor,
      nextCursorPreview: page.nextCursor,
      hasMore: page.hasMore,
      committedAt: page.committedAt.toISOString(),
      catalog: page.catalog,
      pulls: page.pulls,
      sales: page.sales,
      accepted: page.accepted,
      unchanged: page.unchanged,
      revised: page.revised,
      quarantined: page.quarantined,
    })),
    timeline: timeline(run),
    relatedQuarantines,
  };
}

export function createAdminImportOperationsRuntime(
  input: AdminImportOperationsRuntimeInput,
): Omit<ImportOperationsRouterDependencies, "auth" | "cookiePolicy" | "sameOrigin"> {
  const clock = { now: () => new Date() };
  const keyer = actorKeyer(input.actorPseudonymKey);
  const providerReads = new PrismaAdminProviderOperationRepository(input.database);
  const runReads = new PrismaAdminImportRunRepository(input.database);
  const quarantineRepository = new PrismaQuarantineRepository(input.database);
  const health = new ProviderHealthService(
    new PrismaProviderHealthRepository(input.database),
    clock,
    input.operational,
  );
  const ingestion = new IngestionPersistenceRepository(input.database, {
    retentionDays: 90,
    actorPseudonymKey: input.actorPseudonymKey,
  });
  const mappings = createProviderMappingAdapterRegistryFromManifest();
  const projections = new ProviderProjectionService(
    new CatalogProjectionService(),
    new EventProjectionService(
      new HmacProviderActorPseudonymizer(input.actorPseudonymKey),
    ),
  );
  const imports = new ProviderImportService({
    runs: new PrismaImportRunRepository(input.database),
    revisions: new PrismaProviderConfigurationRepository(input.database),
    pages: ingestion,
    transportAdapters: new ProviderTransportAdapterRegistry([
      new HttpCursorAdapter(),
    ]),
    pagePlanner: new DefaultProviderImportPagePlanner(mappings, projections),
    credentialCipher: new AesGcmProviderCredentialCipher({
      primaryVersion: input.credentialKeyVersion ?? 1,
      keys: new Map([[input.credentialKeyVersion ?? 1, input.credentialKey]]),
    }),
    actorKeyer: keyer,
    clock,
    ids: { id: randomUUID },
    environment: input.environment,
  });
  const quarantine = new QuarantineService({
    repository: quarantineRepository,
    projectionRepository: ingestion,
    mappings,
    projections,
    actorKeyer: keyer,
    clock,
    ids: { id: randomUUID },
    operational: input.operational,
  });

  return {
    reads: {
      async listProviders(request) {
        const after = decodeCursor("provider", request.cursor);
        const page = await providerReads.listPage({
          organizationId: request.organizationId,
          limit: request.limit,
          ...(after
            ? {
                after: {
                  platformKey: after.value,
                  providerId: after.id,
                },
              }
            : {}),
        });
        const items = await Promise.all(
          page.items.map(async (provider) => {
            const status = await health.getHealth({
              organizationId: request.organizationId,
              providerId: provider.providerId,
            });
            return {
              providerId: provider.providerId,
              displayName: status.displayName,
              platformKey: status.platformKey,
              lifecycleState: status.providerState,
              configurationRevisionId: provider.configurationRevisionId,
              configurationVersion: provider.configurationVersion,
              scheduleSeconds: status.scheduleSeconds,
              staleAfterSeconds: status.staleAfterSeconds,
              nextDueAt: status.nextDueAt,
              lastAttemptedAt: status.lastAttemptedAt,
              lastHeadReachedAt: status.lastHeadReachedAt,
              freshnessState: status.freshnessState,
              qualityState: status.qualityState,
              activeRun: status.activeRun,
              latestRun: status.latestRun,
              openQuarantineCount: status.openQuarantineCount,
              consecutiveFailures: status.consecutiveFailures,
              recoveredAt: status.recoveredAt,
              recoveryHint: status.recoveryHint,
            };
          }),
        );
        const last = page.items.at(-1);
        return {
          items,
          nextCursor:
            page.hasMore && last
              ? encodeCursor("provider", last.platformKey, last.providerId)
              : null,
        };
      },
      async listRuns(request) {
        const after = decodeCursor("run", request.cursor);
        const page = await runReads.listPage({
          organizationId: request.organizationId,
          limit: request.limit,
          ...(request.providerId ? { providerId: request.providerId } : {}),
          ...(request.state ? { state: request.state } : {}),
          ...(request.trigger ? { trigger: request.trigger } : {}),
          ...(after
            ? {
                after: {
                  requestedAt: new Date(after.value),
                  runId: after.id,
                },
              }
            : {}),
        });
        const last = page.items.at(-1);
        return {
          items: page.items.map(runSummary),
          nextCursor:
            page.hasMore && last
              ? encodeCursor("run", last.requestedAt.toISOString(), last.id)
              : null,
        };
      },
      async getRun(request) {
        const run = await runReads.get(request);
        if (!run) return null;
        const related = await quarantineRepository.listEntriesPage(
          request.organizationId,
          { runId: request.runId, limit: 100 },
          clock.now(),
        );
        return toRunDetail(run, related.items.map(quarantineSummary));
      },
      async listQuarantines(request) {
        const after = decodeCursor("quarantine", request.cursor);
        const page = await quarantineRepository.listEntriesPage(
          request.organizationId,
          {
            limit: request.limit,
            ...(request.providerId ? { providerId: request.providerId } : {}),
            ...(request.runId ? { runId: request.runId } : {}),
            ...(request.state ? { state: request.state } : {}),
            ...(request.recordKind ? { recordKind: request.recordKind } : {}),
            ...(request.reasonCode ? { reasonCode: request.reasonCode } : {}),
            ...(after
              ? { before: { createdAt: new Date(after.value), id: after.id } }
              : {}),
          },
          clock.now(),
        );
        const last = page.items.at(-1);
        return {
          items: page.items.map(quarantineSummary),
          nextCursor:
            page.hasMore && last
              ? encodeCursor("quarantine", last.createdAt.toISOString(), last.id)
              : null,
        };
      },
    },
    manualImports: {
      async request(request) {
        const result = await imports.requestImport({
          trigger: "manual",
          actor: request.actor,
          providerId: request.providerId,
          expectedConfigurationRevisionId:
            request.expectedConfigurationRevisionId,
        });
        return {
          run: {
            id: result.run.id,
            providerId: result.run.providerId,
            configurationRevisionId: result.run.configRevisionId,
            trigger: result.run.trigger,
            state: result.run.state,
          },
          deduplicated: result.coalesced,
        };
      },
    },
    quarantine,
  };
}
