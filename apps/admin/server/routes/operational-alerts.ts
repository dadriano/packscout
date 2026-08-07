import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  OperationalAlertServiceError,
  type AuthService,
  type OperationalAlertService,
  type ProviderActor,
} from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

const alertIdSchema = z.string().uuid("Alert ID must be a UUID.");
const alertListQuerySchema = z
  .object({
    state: z.enum(["active", "acknowledged", "resolved"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export interface OperationalAlertsRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly alerts: Pick<
    OperationalAlertService,
    "list" | "detail" | "acknowledge" | "resolve"
  >;
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

function invalid(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the alert request and try again.",
    code: "INVALID_ALERT_REQUEST",
    details,
  });
}

function failure(response: Response, error: unknown): void {
  if (error instanceof OperationalAlertServiceError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  response.status(503).json({
    error: "Operational alerts are temporarily unavailable.",
    code: "SERVICE_UNAVAILABLE",
  });
}

export function createOperationalAlertsRouter(
  dependencies: OperationalAlertsRouterDependencies,
) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });
  const mutate = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { csrf: true, permission: "providers:view" },
  );

  router.get("/", read, async (request, response) => {
    const query = alertListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return invalid(response, query.error.flatten().fieldErrors);
    }
    try {
      const alerts = await dependencies.alerts.list(actor(response), query.data);
      response.status(200).json({ items: alerts });
    } catch (error) {
      failure(response, error);
    }
  });

  router.get("/:alertId", read, async (request, response) => {
    const alertId = alertIdSchema.safeParse(request.params.alertId);
    if (!alertId.success) return invalid(response, alertId.error.issues);
    try {
      const alert = await dependencies.alerts.detail(actor(response), alertId.data);
      response.status(200).json({ alert });
    } catch (error) {
      failure(response, error);
    }
  });

  for (const action of ["acknowledge", "resolve"] as const) {
    router.post(
      `/:alertId/${action}`,
      dependencies.sameOrigin,
      mutate,
      async (request, response) => {
        const alertId = alertIdSchema.safeParse(request.params.alertId);
        if (!alertId.success) return invalid(response, alertId.error.issues);
        try {
          const alert = await dependencies.alerts[action](
            actor(response),
            alertId.data,
          );
          response.status(200).json({ alert });
        } catch (error) {
          failure(response, error);
        }
      },
    );
  }

  return router;
}
