import {
  CentralProviderObservationRepository,
  PrismaAdminProviderRuntimeRepository,
  type AdminLocalRunDetailRecord,
  type AdminLocalRunRecord,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
} from "@packscout/database";
import {
  QuarantineServiceError,
  type ProviderSourceQuarantineService,
} from "@packscout/services";
import type { QuarantineEntrySummary } from "@packscout/contracts";
import type {
  ImportOperationsRouterDependencies,
  ImportRunDetailView,
  ImportRunSummaryView,
} from "./routes/import-operations.ts";

interface ProviderIdentity {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
}

interface CursorPayload {
  readonly version: 1;
  readonly kind: "run" | "quarantine";
  readonly value: string;
  readonly id: string;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/u;
const PROVIDER_SCAN_LIMIT = 50;

export class ProviderReadUnavailableError extends Error {
  readonly code = "PROVIDER_DATABASE_UNREACHABLE";

  constructor() {
    super("Provider data is temporarily unavailable.");
    this.name = "ProviderReadUnavailableError";
  }
}

function encodeCursor(kind: CursorPayload["kind"], value: Date, id: string) {
  return Buffer.from(JSON.stringify({
    version: 1,
    kind,
    value: value.toISOString(),
    id,
  } satisfies CursorPayload), "utf8").toString("base64url");
}

function decodeCursor(
  kind: CursorPayload["kind"],
  cursor: string | undefined,
): CursorPayload | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      value.version !== 1 ||
      value.kind !== kind ||
      typeof value.value !== "string" ||
      !Number.isFinite(Date.parse(value.value)) ||
      typeof value.id !== "string" ||
      !uuidPattern.test(value.id)
    ) {
      throw new Error("invalid");
    }
    return value as CursorPayload;
  } catch {
    const error = new Error("The operation page cursor is invalid.") as Error & {
      code: string;
    };
    error.code = "INVALID_OPERATION_CURSOR";
    throw error;
  }
}

function configurationVersion(value: bigint): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProviderReadUnavailableError();
  }
  return version;
}

function failureClass(run: AdminLocalRunRecord): string {
  if (run.failureClass && /^[a-z][a-z0-9_]{0,63}$/u.test(run.failureClass)) {
    return run.failureClass;
  }
  const code = run.failureCode ?? "";
  if (code.includes("AUTHENTICATION")) return "authentication";
  if (code.includes("CONFIGURATION") || code.includes("DESTINATION")) {
    return "configuration";
  }
  if (code.includes("CONTRACT") || code.includes("CURSOR")) return "contract";
  if (code.includes("MAPPING")) return "mapping";
  if (code.includes("PERSISTENCE")) return "persistence";
  if (code.includes("RATE_LIMIT")) return "rate_limit";
  if (code.includes("TIMEOUT")) return "timeout";
  if (code.includes("UNREACHABLE") || code.includes("HTTP")) {
    return "unreachable";
  }
  return "unknown";
}

export function providerRunSummary(
  provider: ProviderIdentity,
  run: AdminLocalRunRecord,
): ImportRunSummaryView {
  return {
    id: run.id,
    providerId: provider.id,
    providerName: provider.displayName,
    platformKey: provider.key,
    configurationRevisionId: run.configVersionId,
    configurationVersion: configurationVersion(run.configVersionNumber),
    trigger: run.trigger,
    state: run.state,
    requestedAt: run.requestedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    lastProgressAt: run.lastProgressAt?.toISOString() ?? null,
    reachedProviderHead: run.reachedSourceHead,
    counters: {
      pages: run.pageCount,
      catalog: run.catalogCount,
      pulls: run.pullCount,
      trades: run.marketEventCount,
      accepted: run.acceptedCount,
      unchanged: run.duplicateCount,
      revised: run.materialChangeCount,
      quarantined: run.quarantinedCount,
      resolvedQuarantines: 0,
    },
    failure: run.failureCode === null
      ? null
      : {
          class: failureClass(run),
          code: safeCodePattern.test(run.failureCode)
            ? run.failureCode
            : "IMPORT_FAILURE_UNAVAILABLE",
          summary: "The import stopped with a bounded operational failure.",
        },
  };
}

function runTimeline(
  run: AdminLocalRunRecord,
): ImportRunDetailView["timeline"] {
  const timeline: Array<ImportRunDetailView["timeline"][number]> = [{
    state: "queued",
    occurredAt: run.requestedAt.toISOString(),
    summary: "queued",
  }];
  if (run.startedAt !== null) {
    timeline.push({
      state: "running",
      occurredAt: run.startedAt.toISOString(),
      summary: "running",
    });
  }
  if (
    run.finishedAt !== null &&
    run.state !== "queued" &&
    run.state !== "running"
  ) {
    timeline.push({
      state: run.state,
      occurredAt: run.finishedAt.toISOString(),
      summary: run.state,
    });
  }
  return timeline;
}

function quarantineSummary(input: Readonly<{
  provider: ProviderIdentity;
  configurationRevisionId: string;
  runId: string;
  row: Readonly<{
    id: string;
    provider_run_page_id: string;
    record_index: number;
    record_kind: string;
    external_id: string | null;
    reason_code: string;
    field_path: string | null;
    sanitized_summary: string;
    evidence_expires_at: Date;
    retry_count: number;
    last_retry_at: Date | null;
    resolved_at: Date | null;
    state: "open" | "resolved" | "expired";
    created_at: Date;
  }>;
}>): QuarantineEntrySummary {
  const kind = input.row.record_kind === "market_event"
    ? "trade" as const
    : ["catalog", "pull", "trade"].includes(input.row.record_kind)
      ? input.row.record_kind as "catalog" | "pull" | "trade"
      : "unknown" as const;
  return {
    id: input.row.id,
    providerId: input.provider.id,
    configurationRevisionId: input.configurationRevisionId,
    platformKey: input.provider.key,
    runId: input.runId,
    pageId: input.row.provider_run_page_id,
    recordKind: kind,
    recordIndex: input.row.record_index,
    externalId: input.row.external_id,
    reasonCode: safeCodePattern.test(input.row.reason_code)
      ? input.row.reason_code
      : "QUARANTINE_REASON_UNAVAILABLE",
    fieldPath: input.row.field_path,
    sanitizedSummary: input.row.sanitized_summary,
    state: input.row.state,
    attemptCount: input.row.retry_count,
    firstFailureAt: input.row.created_at.toISOString(),
    latestFailureAt: (input.row.last_retry_at ?? input.row.created_at).toISOString(),
    rawExpiresAt: input.row.evidence_expires_at.toISOString(),
    resolvedAt: input.row.resolved_at?.toISOString() ?? null,
    resolutionSummary: null,
  };
}

function runDetail(
  provider: ProviderIdentity,
  run: AdminLocalRunDetailRecord,
  relatedQuarantines: readonly QuarantineEntrySummary[],
): ImportRunDetailView {
  return {
    ...providerRunSummary(provider, run),
    cursor: {
      requestedPreview: run.requestedCursorHash,
      finalPreview: run.finalCursorHash,
    },
    pages: run.pages.map((page) => ({
      pageNumber: page.pageNumber,
      requestedCursorPreview: page.requestedCursorHash,
      nextCursorPreview: page.nextCursorHash,
      hasMore: page.continuation === "more",
      committedAt: page.committedAt.toISOString(),
      catalog: page.catalogCount,
      pulls: page.pullCount,
      trades: page.marketEventCount,
      accepted: page.acceptedCount,
      unchanged: page.duplicateCount,
      revised: page.materialChangeCount,
      quarantined: page.quarantinedCount,
    })),
    timeline: runTimeline(run),
    relatedQuarantines,
  };
}

function compareRuns(
  left: Readonly<{ run: AdminLocalRunRecord }>,
  right: Readonly<{ run: AdminLocalRunRecord }>,
): number {
  return right.run.requestedAt.getTime() - left.run.requestedAt.getTime() ||
    left.run.id.localeCompare(right.run.id);
}

async function mapBounded<T, U>(
  values: readonly T[],
  operation: (value: T) => Promise<U>,
  concurrency = 4,
): Promise<readonly U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index]!);
      }
    },
  ));
  return results;
}

function unavailableQuarantine(): never {
  throw new QuarantineServiceError(
    "QUARANTINE_NOT_FOUND",
    "Provider quarantine operations are not available in this checkpoint.",
    404,
  );
}

/**
 * Current-admin run reads over bounded, central-authorized provider routes.
 * Exact run ownership is resolved only from relayed central observation facts.
 */
export function createDistributedImportOperationsRuntime(input: Readonly<{
  central: CentralPrismaClient;
  gateway: Pick<
    BoundedProviderDatabaseGateway,
    "runWithAdminProviderDatabase"
  >;
  manualImports: ImportOperationsRouterDependencies["manualImports"];
  now?: () => Date;
}>): Omit<
  ImportOperationsRouterDependencies,
  "auth" | "cookiePolicy" | "sameOrigin"
> {
  const now = input.now ?? (() => new Date());
  const observations = new CentralProviderObservationRepository(input.central);

  async function listProviders(
    organizationId: string,
    providerId?: string,
  ): Promise<readonly ProviderIdentity[]> {
    const providers = await input.central.providers.findMany({
      where: {
        organization_id: organizationId,
        ...(providerId ? { id: providerId } : {}),
      },
      orderBy: [{ provider_key: "asc" }, { id: "asc" }],
      take: providerId ? 1 : PROVIDER_SCAN_LIMIT,
      select: { id: true, provider_key: true, display_name: true },
    });
    return providers.map((provider) => ({
      id: provider.id,
      key: provider.provider_key,
      displayName: provider.display_name,
    }));
  }

  const quarantine: Pick<
    ProviderSourceQuarantineService,
    "detail" | "retryOne" | "retryMany"
  > = {
    async detail(actor, quarantineId) {
      const owner = await observations.resolveQuarantineProvider({
        organizationId: actor.organizationId,
        localQuarantineId: quarantineId,
      });
      if (owner.status !== "resolved") unavailableQuarantine();
      return unavailableQuarantine();
    },
    async retryOne(actor, quarantineId) {
      const owner = await observations.resolveQuarantineProvider({
        organizationId: actor.organizationId,
        localQuarantineId: quarantineId,
      });
      if (owner.status !== "resolved") unavailableQuarantine();
      return unavailableQuarantine();
    },
    async retryMany(actor, request) {
      for (const quarantineId of request.quarantineIds) {
        const owner = await observations.resolveQuarantineProvider({
          organizationId: actor.organizationId,
          localQuarantineId: quarantineId,
        });
        if (owner.status !== "resolved") unavailableQuarantine();
      }
      return unavailableQuarantine();
    },
  };

  return {
    reads: {
      async listRuns(request) {
        const cursor = decodeCursor("run", request.cursor);
        if (request.trigger === "continuation") {
          return { items: [], nextCursor: null };
        }
        const trigger = request.trigger;
        const providers = await listProviders(
          request.organizationId,
          request.providerId,
        );
        const before = cursor
          ? { requestedAt: new Date(cursor.value), runId: cursor.id }
          : undefined;
        const pages = await mapBounded(providers, async (provider) => {
          const result = await input.gateway.runWithAdminProviderDatabase(
            {
              organizationId: request.organizationId,
              providerId: provider.id,
            },
            (database) => new PrismaAdminProviderRuntimeRepository(database)
              .listRuns({
                snapshotAt: now(),
                limit: Math.min(request.limit + 1, 50),
                ...(before ? { before } : {}),
                ...(request.state ? { state: request.state } : {}),
                ...(trigger ? { trigger } : {}),
              }),
          );
          return { provider, result };
        });
        const reachable = pages.filter((page) => page.result.state === "reachable");
        if (providers.length > 0 && reachable.length === 0) {
          throw new ProviderReadUnavailableError();
        }
        const merged = reachable.flatMap((page) =>
          page.result.state === "reachable"
            ? page.result.value.items.map((run) => ({ provider: page.provider, run }))
            : []
        ).sort(compareRuns);
        const items = merged.slice(0, request.limit);
        const last = items.at(-1);
        const hasMore = merged.length > request.limit || reachable.some(
          (page) => page.result.state === "reachable" && page.result.value.hasMore,
        );
        return {
          items: items.map(({ provider, run }) => providerRunSummary(provider, run)),
          nextCursor: hasMore && last
            ? encodeCursor("run", last.run.requestedAt, last.run.id)
            : null,
        };
      },

      async getRun(request) {
        const owner = await observations.resolveRunProvider({
          organizationId: request.organizationId,
          localRunId: request.runId,
        });
        if (owner.status !== "resolved") return null;
        const [provider] = await listProviders(
          request.organizationId,
          owner.providerId,
        );
        if (!provider) return null;
        const result = await input.gateway.runWithAdminProviderDatabase(
          {
            organizationId: request.organizationId,
            providerId: provider.id,
          },
          async (database) => {
            const [run, rows] = await Promise.all([
              new PrismaAdminProviderRuntimeRepository(database).getRun(
                request.runId,
              ),
              database.quarantine_records.findMany({
                where: { provider_run_id: request.runId },
                select: {
                  id: true,
                  provider_run_page_id: true,
                  record_index: true,
                  record_kind: true,
                  external_id: true,
                  reason_code: true,
                  field_path: true,
                  sanitized_summary: true,
                  evidence_expires_at: true,
                  retry_count: true,
                  last_retry_at: true,
                  resolved_at: true,
                  state: true,
                  created_at: true,
                },
                orderBy: [{ created_at: "desc" }, { id: "desc" }],
                take: 100,
              }),
            ]);
            if (run === null) return null;
            return runDetail(
              provider,
              run,
              rows.map((row) => quarantineSummary({
                provider,
                configurationRevisionId: run.configVersionId,
                runId: run.id,
                row,
              })),
            );
          },
        );
        if (result.state === "unreachable") {
          throw new ProviderReadUnavailableError();
        }
        return result.value;
      },

      async listQuarantines(request) {
        const cursor = decodeCursor("quarantine", request.cursor);
        if (request.state === "retrying") {
          return { items: [], nextCursor: null };
        }
        const quarantineState = request.state;
        let providerId = request.providerId;
        if (request.runId !== undefined) {
          const runOwner = await observations.resolveRunProvider({
            organizationId: request.organizationId,
            localRunId: request.runId,
          });
          if (runOwner.status !== "resolved") {
            return { items: [], nextCursor: null };
          }
          if (providerId !== undefined && providerId !== runOwner.providerId) {
            return { items: [], nextCursor: null };
          }
          providerId = runOwner.providerId;
        }
        const providers = await listProviders(request.organizationId, providerId);
        const pages = await mapBounded(providers, async (provider) => {
          const result = await input.gateway.runWithAdminProviderDatabase(
            {
              organizationId: request.organizationId,
              providerId: provider.id,
            },
            async (database) => {
              const rows = await database.quarantine_records.findMany({
                where: {
                  ...(request.runId ? { provider_run_id: request.runId } : {}),
                  ...(quarantineState ? { state: quarantineState } : {}),
                  ...(request.reasonCode
                    ? { reason_code: request.reasonCode }
                    : {}),
                  ...(request.recordKind === "trade"
                    ? { record_kind: { in: ["trade", "market_event"] } }
                    : request.recordKind
                      ? { record_kind: request.recordKind }
                      : {}),
                  ...(cursor
                    ? {
                        OR: [
                          { created_at: { lt: new Date(cursor.value) } },
                          {
                            created_at: new Date(cursor.value),
                            id: { lt: cursor.id },
                          },
                        ],
                      }
                    : {}),
                },
                select: {
                  id: true,
                  provider_run_id: true,
                  provider_run_page_id: true,
                  record_index: true,
                  record_kind: true,
                  external_id: true,
                  reason_code: true,
                  field_path: true,
                  sanitized_summary: true,
                  evidence_expires_at: true,
                  retry_count: true,
                  last_retry_at: true,
                  resolved_at: true,
                  state: true,
                  created_at: true,
                  provider_run: { select: { config_version_id: true } },
                },
                orderBy: [{ created_at: "desc" }, { id: "desc" }],
                take: Math.min(request.limit + 1, 51),
              });
              return rows.map((row) => ({
                createdAt: row.created_at,
                summary: quarantineSummary({
                  provider,
                  configurationRevisionId: row.provider_run.config_version_id,
                  runId: row.provider_run_id,
                  row,
                }),
              }));
            },
          );
          return result;
        });
        const reachable = pages.filter((page) => page.state === "reachable");
        if (providers.length > 0 && reachable.length === 0) {
          throw new ProviderReadUnavailableError();
        }
        const merged = reachable.flatMap((page) =>
          page.state === "reachable" ? page.value : []
        ).sort((left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.summary.id.localeCompare(left.summary.id)
        );
        const items = merged.slice(0, request.limit);
        const last = items.at(-1);
        const hasMore = merged.length > request.limit || reachable.some(
          (page) => page.state === "reachable" && page.value.length > request.limit,
        );
        return {
          items: items.map(({ summary }) => summary),
          nextCursor: hasMore && last
            ? encodeCursor("quarantine", last.createdAt, last.summary.id)
            : null,
        };
      },
    },
    manualImports: input.manualImports,
    quarantine,
  };
}
