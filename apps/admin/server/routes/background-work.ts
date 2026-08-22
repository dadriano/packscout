import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  recomputationRecoveryBulkRequestSchema,
  recomputationRecoveryRequestSchema,
  recomputationRequestIdSchema,
  type RecomputationBacklogEvaluation,
  type RecomputationQueueEntry,
  type RecomputationRecoveryAction,
  type RecomputationRecoveryResult,
  type RetentionCadenceEvaluation,
  type RetentionExecutionSummary,
} from "@packscout/contracts";
import type { AuthService, ProviderActor } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession, getAuthenticatedActor } from "../auth/middleware.ts";

const pageQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
const recomputationQuerySchema = pageQuerySchema
  .extend({
    state: z.enum(["pending", "claimed", "failed", "completed"]).optional(),
  })
  .strict();

interface Paginated<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface RecomputationQueuePage
  extends Paginated<RecomputationQueueEntry> {
  readonly backlog: RecomputationBacklogEvaluation;
}

export interface RetentionExecutionPage
  extends Paginated<RetentionExecutionSummary> {
  readonly cadence: RetentionCadenceEvaluation;
}

export interface BackgroundWorkRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly reads: {
    listRecomputations(input: {
      organizationId: string;
      cursor?: string;
      limit: number;
      state?: RecomputationQueueEntry["state"];
    }): Promise<RecomputationQueuePage>;
    listRetentionExecutions(input: {
      organizationId: string;
      cursor?: string;
      limit: number;
    }): Promise<RetentionExecutionPage>;
  };
  readonly recovery: {
    recover(input: {
      actor: ProviderActor;
      action: RecomputationRecoveryAction;
      requestIds: readonly string[];
    }): Promise<readonly RecomputationRecoveryResult[]>;
  };
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
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

const stableCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const workerIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const packReferencePattern = /^pack:[0-9a-f]{12}$/;

function stableCode(value: string | null, fallback: string): string | null {
  if (value === null) return null;
  return stableCodePattern.test(value) ? value : fallback;
}

/**
 * Bounded, browser-safe explanations. Queue and retention failures are stored
 * as stable codes, so the operator-facing sentence is derived from the code
 * rather than from any provider or exception text.
 */
function recomputationFailureSummary(code: string | null): string | null {
  if (code === null) return null;
  if (code.includes("CALCULATION") || code.includes("MAPPING")) {
    return "The pack's estimated value could not be recalculated from its current inputs.";
  }
  if (code.includes("PERSISTENCE")) {
    return "The recalculated value could not be committed safely.";
  }
  if (code.includes("CONTRACT") || code.includes("INVALID")) {
    return "The recalculation inputs did not satisfy the expected contract.";
  }
  return "The recalculation stopped with a bounded operational failure.";
}

function retentionFailureSummary(
  code: string | null,
  stored: string | null,
): string | null {
  if (code === null) return null;
  return stored === null
    ? "A bounded protected-data cleanup did not complete."
    : bounded(stored, 200);
}

function sanitizeEntry(entry: RecomputationQueueEntry): RecomputationQueueEntry {
  const failureCode = stableCode(
    entry.failureCode,
    "ESTIMATED_EV_RECOMPUTATION_FAILED",
  );
  return {
    id: entry.id,
    providerId: entry.providerId,
    platformKey: bounded(entry.platformKey, 128),
    state: entry.state,
    // Pack and EV-input external IDs stay server-side; the opaque reference
    // lets an operator correlate rows without exporting provider identifiers.
    packReference: packReferencePattern.test(entry.packReference)
      ? entry.packReference
      : "pack:000000000000",
    attemptCount: entry.attemptCount,
    createdAt: entry.createdAt,
    availableAt: entry.availableAt,
    completedAt: entry.completedAt,
    claimedBy:
      entry.claimedBy !== null && workerIdentityPattern.test(entry.claimedBy)
        ? entry.claimedBy
        : null,
    claimExpiresAt: entry.claimExpiresAt,
    claimAgeMs: entry.claimAgeMs,
    claimExpired: entry.claimExpired,
    failureCode,
    failureSummary: recomputationFailureSummary(failureCode),
  };
}

function sanitizeExecution(
  execution: RetentionExecutionSummary,
): RetentionExecutionSummary {
  const failureCode = stableCode(execution.failureCode, "RETENTION_FAILED");
  return {
    id: execution.id,
    state: execution.state,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    durationMs: execution.durationMs,
    cutoffAt: execution.cutoffAt,
    pruned: {
      pages: execution.pruned.pages,
      sourceRecords: execution.pruned.sourceRecords,
      quarantines: execution.pruned.quarantines,
      total: execution.pruned.total,
    },
    alreadyExpired: execution.alreadyExpired,
    remaining: execution.remaining,
    failureCode,
    failureSummary: retentionFailureSummary(
      failureCode,
      execution.failureSummary,
    ),
  };
}

function sanitizeResult(
  result: RecomputationRecoveryResult,
): RecomputationRecoveryResult {
  return {
    requestId: result.requestId,
    outcome: result.outcome,
    entry: result.entry ? sanitizeEntry(result.entry) : null,
  };
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the background work request and try again.",
    code: "INVALID_BACKGROUND_WORK_REQUEST",
    details,
  });
}

function failure(response: Response, error: unknown): void {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "INVALID_OPERATION_CURSOR") {
      response.status(422).json({
        error: "The background work page cursor is invalid.",
        code: "INVALID_OPERATION_CURSOR",
      });
      return;
    }
    if (error.code === "RATE_LIMITED") {
      response.status(429).json({
        error: "Too many operation requests. Try again later.",
        code: "RATE_LIMITED",
      });
      return;
    }
  }
  response.status(503).json({
    error: "Background work is temporarily unavailable.",
    code: "SERVICE_UNAVAILABLE",
  });
}

export function createBackgroundWorkRouter(
  dependencies: BackgroundWorkRouterDependencies,
) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });
  const recover = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { csrf: true, permission: "imports:retry" },
  );

  router.get("/recomputations", read, async (request, response) => {
    const query = recomputationQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(response, query.error.flatten().fieldErrors);
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listRecomputations({
        organizationId: session.organizationId,
        ...query.data,
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        items: result.items.slice(0, query.data.limit).map(sanitizeEntry),
        nextCursor:
          result.nextCursor === null ? null : bounded(result.nextCursor, 512),
        backlog: result.backlog,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/retention-executions", read, async (request, response) => {
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(response, query.error.flatten().fieldErrors);
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.listRetentionExecutions({
        organizationId: session.organizationId,
        ...query.data,
      });
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        items: result.items.slice(0, query.data.limit).map(sanitizeExecution),
        nextCursor:
          result.nextCursor === null ? null : bounded(result.nextCursor, 512),
        cadence: result.cadence,
      });
    } catch (error) {
      failure(response, error);
    }
  });

  router.post(
    "/recomputations/recoveries",
    dependencies.sameOrigin,
    recover,
    async (request, response) => {
      const body = recomputationRecoveryBulkRequestSchema.safeParse(request.body);
      if (!body.success) return invalid(response, body.error.flatten().fieldErrors);
      try {
        const results = await dependencies.recovery.recover({
          actor: actor(response),
          action: body.data.action,
          requestIds: body.data.requestIds,
        });
        response.status(200).json({ results: results.map(sanitizeResult) });
      } catch (error) {
        failure(response, error);
      }
    },
  );

  router.post(
    "/recomputations/:requestId/recoveries",
    dependencies.sameOrigin,
    recover,
    async (request, response) => {
      const requestId = recomputationRequestIdSchema.safeParse(
        request.params.requestId,
      );
      const body = recomputationRecoveryRequestSchema.safeParse(request.body);
      if (!requestId.success || !body.success) {
        return invalid(response, {
          ...(!requestId.success ? { requestId: requestId.error.issues } : {}),
          ...(!body.success ? body.error.flatten().fieldErrors : {}),
        });
      }
      try {
        const [result] = await dependencies.recovery.recover({
          actor: actor(response),
          action: body.data.action,
          requestIds: [requestId.data],
        });
        if (!result) {
          response.status(200).json({
            result: {
              requestId: requestId.data,
              outcome: "not_found",
              entry: null,
            },
          });
          return;
        }
        response.status(200).json({ result: sanitizeResult(result) });
      } catch (error) {
        failure(response, error);
      }
    },
  );

  return router;
}
