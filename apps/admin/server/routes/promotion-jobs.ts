import { Router, type Response } from "express";
import { z } from "zod";
import {
  promotionJobHistoryPageSchema,
  promotionJobHistoryQuerySchema,
  promotionJobInvocationDetailSchema,
  promotionJobMonitoringIdSchema,
  promotionJobMonitoringOverviewSchema,
  type PromotionJobHistoryPage,
  type PromotionJobHistoryQuery,
  type PromotionJobInvocationDetail,
  type PromotionJobMonitoringOverview,
} from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

const emptyQuerySchema = z.object({}).strict();

export interface PromotionJobsRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly reads: {
    overview(input: {
      readonly organizationId: string;
    }): Promise<PromotionJobMonitoringOverview>;
    history(input: {
      readonly organizationId: string;
      readonly query: PromotionJobHistoryQuery;
    }): Promise<PromotionJobHistoryPage>;
    detail(input: {
      readonly organizationId: string;
      readonly monitoringId: string;
    }): Promise<PromotionJobInvocationDetail | null>;
  };
  readonly cookiePolicy: SessionCookiePolicy;
}

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the promotion job request and try again.",
    code: "INVALID_PROMOTION_JOB_REQUEST",
    details,
  });
}

function codeOf(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function failure(response: Response, error: unknown): void {
  const code = codeOf(error);
  if (code === "INVALID_PROMOTION_JOB_CURSOR") {
    response.status(422).json({
      error: "The promotion job history cursor is invalid.",
      code: "INVALID_PROMOTION_JOB_CURSOR",
    });
    return;
  }
  if (code === "PROMOTION_JOB_MONITORING_NOT_FOUND") {
    response.status(404).json({
      error: "The promotion job record was not found.",
      code: "PROMOTION_JOB_MONITORING_NOT_FOUND",
    });
    return;
  }
  if (code === "RATE_LIMITED") {
    response.status(429).json({
      error: "Too many monitoring requests. Try again later.",
      code: "RATE_LIMITED",
    });
    return;
  }
  response.status(503).json({
    error: "Promotion job monitoring is temporarily unavailable.",
    code: "SERVICE_UNAVAILABLE",
  });
}

/** Read-only, least-authority monitoring surface for distributed promotion. */
export function createPromotionJobsRouter(
  dependencies: PromotionJobsRouterDependencies,
) {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  const read = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { permission: "providers:view" },
  );

  router.get("/overview", read, async (request, response) => {
    const query = emptyQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(response, query.error.flatten().fieldErrors);
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.overview({
        organizationId: session.organizationId,
      });
      response.status(200).json(promotionJobMonitoringOverviewSchema.parse(result));
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/history", read, async (request, response) => {
    const query = promotionJobHistoryQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(response, query.error.flatten().fieldErrors);
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.history({
        organizationId: session.organizationId,
        query: query.data,
      });
      response.status(200).json(promotionJobHistoryPageSchema.parse(result));
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/history/:monitoringId", read, async (request, response) => {
    const monitoringId = promotionJobMonitoringIdSchema.safeParse(
      request.params.monitoringId,
    );
    if (!monitoringId.success) {
      return invalid(response, { monitoringId: monitoringId.error.issues });
    }
    try {
      const session = getAuthenticatedActor(response);
      const result = await dependencies.reads.detail({
        organizationId: session.organizationId,
        monitoringId: monitoringId.data,
      });
      if (result === null) {
        failure(response, { code: "PROMOTION_JOB_MONITORING_NOT_FOUND" });
        return;
      }
      response.status(200).json(promotionJobInvocationDetailSchema.parse(result));
    } catch (error) {
      failure(response, error);
    }
  });

  return router;
}
