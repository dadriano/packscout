import { createHash } from "node:crypto";
import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  quarantineIdSchema,
  quarantineRetryBulkRequestSchema,
  type QuarantineEntryDetail,
  type QuarantineEntrySummary,
  type QuarantineRetryOutcome,
} from "@packscout/contracts";
import {
  ProviderImportServiceError,
  QuarantineServiceError,
  type AuthService,
  type ProviderActor,
  type QuarantineService,
} from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession, getAuthenticatedActor } from "../auth/middleware.ts";

const boundedCursorSchema = z.string().trim().min(1).max(512);
const providerIdSchema = z.string().uuid();
const runIdSchema = z.string().uuid();
const pageQuerySchema = z.object({
  cursor: boundedCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict();
const runListQuerySchema = pageQuerySchema.extend({
  providerId: providerIdSchema.optional(),
  state: z.enum(["queued", "running", "succeeded", "incomplete", "failed"]).optional(),
  trigger: z.enum(["scheduled", "manual", "recovery"]).optional(),
}).strict();
const quarantineListQuerySchema = pageQuerySchema.extend({
  providerId: providerIdSchema.optional(),
  runId: runIdSchema.optional(),
  state: z.enum(["open", "retrying", "resolved", "expired"]).optional(),
  recordKind: z.enum(["catalog", "pull", "sale"]).optional(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
}).strict();
const manualImportRequestSchema = z.object({
  expectedConfigurationRevisionId: z.string().uuid(),
}).strict();

type RunState = "queued" | "running" | "succeeded" | "incomplete" | "failed";

export interface ProviderOperationView {
  readonly providerId: string;
  readonly displayName: string;
  readonly platformKey: string;
  readonly lifecycleState: "draft" | "active" | "disabled" | "archived";
  readonly configurationRevisionId: string;
  readonly configurationVersion: number;
  readonly scheduleSeconds: number;
  readonly staleAfterSeconds: number;
  readonly nextDueAt: string | null;
  readonly lastAttemptedAt: string | null;
  readonly lastHeadReachedAt: string | null;
  readonly freshnessState: "fresh" | "stale";
  readonly qualityState: "healthy" | "warning" | "degraded";
  readonly activeRun: { id: string; state: "queued" | "running" } | null;
  readonly latestRun: { id: string; state: RunState } | null;
  readonly openQuarantineCount: number;
  readonly consecutiveFailures: number;
  readonly recoveredAt: string | null;
  readonly recoveryHint: string;
}

export interface ImportRunCountersView {
  readonly pages: number;
  readonly catalog: number;
  readonly pulls: number;
  readonly sales: number;
  readonly accepted: number;
  readonly unchanged: number;
  readonly revised: number;
  readonly quarantined: number;
  readonly resolvedQuarantines: number;
}

export interface ImportRunSummaryView {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly platformKey: string;
  readonly configurationRevisionId: string;
  readonly configurationVersion: number;
  readonly trigger: "scheduled" | "manual" | "recovery";
  readonly state: RunState;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastProgressAt: string | null;
  readonly reachedProviderHead: boolean;
  readonly counters: ImportRunCountersView;
  readonly failure: {
    readonly class: string;
    readonly code: string;
    readonly summary: string;
  } | null;
}

export interface ImportRunDetailView extends ImportRunSummaryView {
  readonly cursor: {
    readonly requestedPreview: string | null;
    readonly finalPreview: string | null;
  };
  readonly pages: readonly {
    readonly pageNumber: number;
    readonly requestedCursorPreview: string | null;
    readonly nextCursorPreview: string | null;
    readonly hasMore: boolean;
    readonly committedAt: string;
    readonly catalog: number;
    readonly pulls: number;
    readonly sales: number;
    readonly accepted: number;
    readonly unchanged: number;
    readonly revised: number;
    readonly quarantined: number;
  }[];
  readonly timeline: readonly {
    readonly state: RunState;
    readonly occurredAt: string;
    readonly summary: string;
  }[];
  readonly relatedQuarantines: readonly QuarantineEntrySummary[];
}

interface Paginated<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ImportOperationsRouterDependencies {
  auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  reads: {
    listProviders(input: {
      organizationId: string;
      cursor?: string;
      limit: number;
    }): Promise<Paginated<ProviderOperationView>>;
    listRuns(input: {
      organizationId: string;
      cursor?: string;
      limit: number;
      providerId?: string;
      state?: RunState;
      trigger?: "scheduled" | "manual" | "recovery";
    }): Promise<Paginated<ImportRunSummaryView>>;
    getRun(input: {
      organizationId: string;
      runId: string;
    }): Promise<ImportRunDetailView | null>;
    listQuarantines(input: {
      organizationId: string;
      cursor?: string;
      limit: number;
      providerId?: string;
      runId?: string;
      state?: QuarantineEntrySummary["state"];
      recordKind?: QuarantineEntrySummary["recordKind"];
      reasonCode?: string;
    }): Promise<Paginated<QuarantineEntrySummary>>;
  };
  manualImports: {
    request(input: {
      actor: ProviderActor;
      providerId: string;
      expectedConfigurationRevisionId: string;
    }): Promise<{
      run: Pick<
        ImportRunSummaryView,
        "id" | "providerId" | "configurationRevisionId" | "trigger" | "state"
      >;
      deduplicated: boolean;
    }>;
  };
  quarantine: Pick<QuarantineService, "detail" | "retryOne" | "retryMany">;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
}

function actor(response: Response): ProviderActor {
  const authenticated = getAuthenticatedActor(response);
  return {
    operatorId: authenticated.operatorId,
    organizationId: authenticated.organizationId,
    role: authenticated.role,
  };
}

function bounded(value: string, maximum = 500): string {
  return value.slice(0, maximum);
}

function cursorPreview(value: string | null): string | null {
  if (value === null) return null;
  return `cursor:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function failureSummary(failureClass: string): string {
  const summaries: Record<string, string> = {
    authentication: "Provider authentication prevented the import from continuing.",
    configuration: "Provider configuration prevented the import from continuing.",
    contract: "Provider data did not satisfy the expected feed contract.",
    mapping: "Provider records could not be mapped safely.",
    persistence: "Committed progress could not continue safely.",
    rate_limit: "Provider rate limiting interrupted the import.",
    timeout: "The provider did not respond within the allowed time.",
    unreachable: "The provider endpoint could not be reached.",
  };
  return summaries[failureClass] ?? "The import stopped with a bounded operational failure.";
}

function timelineSummary(state: RunState): string {
  if (state === "queued") return "Import request queued.";
  if (state === "running") return "A worker started the import.";
  if (state === "succeeded") return "The import reached provider head.";
  if (state === "incomplete") return "Durable progress was retained for recovery.";
  return "The import stopped with a terminal failure.";
}

function sanitizeCounters(counters: ImportRunCountersView): ImportRunCountersView {
  return {
    pages: counters.pages,
    catalog: counters.catalog,
    pulls: counters.pulls,
    sales: counters.sales,
    accepted: counters.accepted,
    unchanged: counters.unchanged,
    revised: counters.revised,
    quarantined: counters.quarantined,
    resolvedQuarantines: counters.resolvedQuarantines,
  };
}

function sanitizeQuarantine(entry: QuarantineEntrySummary): QuarantineEntrySummary {
  return {
    id: entry.id,
    providerId: entry.providerId,
    configurationRevisionId: entry.configurationRevisionId,
    platformKey: bounded(entry.platformKey, 128),
    runId: entry.runId,
    pageId: entry.pageId,
    recordKind: entry.recordKind,
    recordIndex: entry.recordIndex,
    // Source external IDs may encode usernames or wallet addresses. Record position
    // plus the opaque quarantine ID provides sufficient browser-safe identity.
    externalId: null,
    reasonCode: bounded(entry.reasonCode, 128),
    fieldPath: entry.fieldPath === null ? null : bounded(entry.fieldPath, 256),
    sanitizedSummary: bounded(entry.sanitizedSummary),
    state: entry.state,
    attemptCount: entry.attemptCount,
    firstFailureAt: entry.firstFailureAt,
    latestFailureAt: entry.latestFailureAt,
    rawExpiresAt: entry.rawExpiresAt,
    resolvedAt: entry.resolvedAt,
    resolutionSummary: entry.resolutionSummary === null ? null : bounded(entry.resolutionSummary),
  };
}

function sanitizeRun(run: ImportRunSummaryView): ImportRunSummaryView {
  return {
    id: run.id,
    providerId: run.providerId,
    providerName: bounded(run.providerName, 120),
    platformKey: bounded(run.platformKey, 128),
    configurationRevisionId: run.configurationRevisionId,
    configurationVersion: run.configurationVersion,
    trigger: run.trigger,
    state: run.state,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastProgressAt: run.lastProgressAt,
    reachedProviderHead: run.reachedProviderHead,
    counters: sanitizeCounters(run.counters),
    failure: run.failure
      ? {
          class: bounded(run.failure.class, 64),
          code: bounded(run.failure.code, 128),
          summary: failureSummary(run.failure.class),
        }
      : null,
  };
}

function sanitizeRunDetail(run: ImportRunDetailView): ImportRunDetailView {
  return {
    ...sanitizeRun(run),
    cursor: {
      requestedPreview: cursorPreview(run.cursor.requestedPreview),
      finalPreview: cursorPreview(run.cursor.finalPreview),
    },
    pages: run.pages.slice(0, 100).map((page) => ({
      pageNumber: page.pageNumber,
      requestedCursorPreview: cursorPreview(page.requestedCursorPreview),
      nextCursorPreview: cursorPreview(page.nextCursorPreview),
      hasMore: page.hasMore,
      committedAt: page.committedAt,
      catalog: page.catalog,
      pulls: page.pulls,
      sales: page.sales,
      accepted: page.accepted,
      unchanged: page.unchanged,
      revised: page.revised,
      quarantined: page.quarantined,
    })),
    timeline: run.timeline.slice(0, 50).map((event) => ({
      state: event.state,
      occurredAt: event.occurredAt,
      summary: timelineSummary(event.state),
    })),
    relatedQuarantines: run.relatedQuarantines.slice(0, 100).map(sanitizeQuarantine),
  };
}

function sanitizeProvider(provider: ProviderOperationView): ProviderOperationView {
  return {
    providerId: provider.providerId,
    displayName: bounded(provider.displayName, 120),
    platformKey: bounded(provider.platformKey, 128),
    lifecycleState: provider.lifecycleState,
    configurationRevisionId: provider.configurationRevisionId,
    configurationVersion: provider.configurationVersion,
    scheduleSeconds: provider.scheduleSeconds,
    staleAfterSeconds: provider.staleAfterSeconds,
    nextDueAt: provider.nextDueAt,
    lastAttemptedAt: provider.lastAttemptedAt,
    lastHeadReachedAt: provider.lastHeadReachedAt,
    freshnessState: provider.freshnessState,
    qualityState: provider.qualityState,
    activeRun: provider.activeRun ? { id: provider.activeRun.id, state: provider.activeRun.state } : null,
    latestRun: provider.latestRun ? { id: provider.latestRun.id, state: provider.latestRun.state } : null,
    openQuarantineCount: provider.openQuarantineCount,
    consecutiveFailures: provider.consecutiveFailures,
    recoveredAt: provider.recoveredAt,
    recoveryHint: bounded(provider.recoveryHint),
  };
}

function sanitizeDetail(detail: QuarantineEntryDetail): QuarantineEntryDetail {
  return {
    ...sanitizeQuarantine(detail),
    attempts: detail.attempts.slice(0, 100).map((attempt) => ({
      id: attempt.id,
      state: attempt.state,
      failureCode: attempt.failureCode === null ? null : bounded(attempt.failureCode, 128),
      fieldPath: attempt.fieldPath === null ? null : bounded(attempt.fieldPath, 256),
      sanitizedSummary: attempt.sanitizedSummary === null ? null : bounded(attempt.sanitizedSummary),
      canonicalRevisionCount: attempt.canonicalRevisionCount,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
    })),
  };
}

function sanitizeOutcome(outcome: QuarantineRetryOutcome): QuarantineRetryOutcome {
  return {
    quarantineId: outcome.quarantineId,
    outcome: outcome.outcome,
    entry: outcome.entry ? sanitizeQuarantine(outcome.entry) : null,
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the operation request and try again.",
    code: "INVALID_OPERATION_REQUEST",
    details,
  });
}

function failure(response: Response, error: unknown): void {
  if (error instanceof ProviderImportServiceError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof QuarantineServiceError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "INVALID_OPERATION_CURSOR") {
      response.status(422).json({
        error: "The operation page cursor is invalid.",
        code: "INVALID_OPERATION_CURSOR",
      });
      return;
    }
    if (error.code === "IMPORT_RUN_NOT_FOUND") {
      response.status(404).json({ error: "Import run not found.", code: "IMPORT_RUN_NOT_FOUND" });
      return;
    }
    if (error.code === "RATE_LIMITED") {
      response.status(429).json({ error: "Too many operation requests. Try again later.", code: "RATE_LIMITED" });
      return;
    }
  }
  response.status(503).json({
    error: "Import operations are temporarily unavailable.",
    code: "SERVICE_UNAVAILABLE",
  });
}

export function createImportOperationsRouter(dependencies: ImportOperationsRouterDependencies) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });
  const run = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    csrf: true,
    permission: "imports:start",
  });
  const retry = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    csrf: true,
    permission: "imports:retry",
  });

  router.get("/operations/providers", read, async (request, response) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(response, query.error.flatten().fieldErrors);
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listProviders({
        organizationId: session.organizationId,
        ...query.data,
      });
      response.status(200).json({
        items: result.items.slice(0, query.data.limit).map(sanitizeProvider),
        nextCursor: result.nextCursor === null ? null : bounded(result.nextCursor, 512),
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/import-runs", read, async (request, response) => {
    const query = runListQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(response, query.error.flatten().fieldErrors);
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listRuns({
        organizationId: session.organizationId,
        ...query.data,
      });
      response.status(200).json({
        items: result.items.slice(0, query.data.limit).map(sanitizeRun),
        nextCursor: result.nextCursor === null ? null : bounded(result.nextCursor, 512),
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/import-runs/:runId", read, async (request, response) => {
    const runId = runIdSchema.safeParse(request.params.runId);
    if (!runId.success) return invalid(response, runId.error.issues);
    try {
      const session = getAuthenticatedActor(response);
      const detail = await dependencies.reads.getRun({
        organizationId: session.organizationId,
        runId: runId.data,
      });
      if (!detail) {
        response.status(404).json({ error: "Import run not found.", code: "IMPORT_RUN_NOT_FOUND" });
        return;
      }
      response.status(200).json({ run: sanitizeRunDetail(detail) });
    } catch (error) {
      failure(response, error);
    }
  });

  router.post(
    "/data-providers/:providerId/import-runs",
    dependencies.sameOrigin,
    run,
    async (request, response) => {
      const providerId = providerIdSchema.safeParse(request.params.providerId);
      const body = manualImportRequestSchema.safeParse(request.body);
      if (!providerId.success || !body.success) {
        return invalid(response, {
          ...(!providerId.success ? { providerId: providerId.error.issues } : {}),
          ...(!body.success ? body.error.flatten().fieldErrors : {}),
        });
      }
      try {
        const result = await dependencies.manualImports.request({
          actor: actor(response),
          providerId: providerId.data,
          expectedConfigurationRevisionId: body.data.expectedConfigurationRevisionId,
        });
        response.status(result.deduplicated ? 200 : 202).json({
          run: {
            id: result.run.id,
            providerId: result.run.providerId,
            configurationRevisionId: result.run.configurationRevisionId,
            trigger: result.run.trigger,
            state: result.run.state,
          },
          deduplicated: result.deduplicated,
        });
      } catch (error) {
        failure(response, error);
      }
    },
  );

  router.get("/quarantine", read, async (request, response) => {
    const query = quarantineListQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(response, query.error.flatten().fieldErrors);
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listQuarantines({
        organizationId: session.organizationId,
        ...query.data,
      });
      response.status(200).json({
        items: result.items.slice(0, query.data.limit).map(sanitizeQuarantine),
        nextCursor: result.nextCursor === null ? null : bounded(result.nextCursor, 512),
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/quarantine/:quarantineId", read, async (request, response) => {
    const id = quarantineIdSchema.safeParse(request.params.quarantineId);
    if (!id.success) return invalid(response, id.error.issues);
    try {
      response.status(200).json({
        entry: sanitizeDetail(await dependencies.quarantine.detail(actor(response), id.data)),
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.post(
    "/quarantine/:quarantineId/retries",
    dependencies.sameOrigin,
    retry,
    async (request, response) => {
      const id = quarantineIdSchema.safeParse(request.params.quarantineId);
      if (!id.success) return invalid(response, id.error.issues);
      try {
        response.status(200).json({
          outcome: sanitizeOutcome(await dependencies.quarantine.retryOne(actor(response), id.data)),
        });
      } catch (error) {
        failure(response, error);
      }
    },
  );

  router.post(
    "/quarantine/retries",
    dependencies.sameOrigin,
    retry,
    async (request, response) => {
      const body = quarantineRetryBulkRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
      try {
        const outcomes = await dependencies.quarantine.retryMany(actor(response), body.data);
        response.status(200).json({ outcomes: outcomes.map(sanitizeOutcome) });
      } catch (error) {
        failure(response, error);
      }
    },
  );

  return router;
}
