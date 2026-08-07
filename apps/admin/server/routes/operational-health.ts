import { Router } from "express";
import type { AuthService, OperationalHealthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

export interface OperationalHealthRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly health: Pick<OperationalHealthService, "protectedDetail">;
  readonly cookiePolicy: SessionCookiePolicy;
}

export function createOperationalHealthRouter(
  dependencies: OperationalHealthRouterDependencies,
) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });
  router.get("/", read, async (_request, response) => {
    try {
      const actor = getAuthenticatedActor(response);
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({
        health: await dependencies.health.protectedDetail(actor.organizationId),
      });
    } catch {
      response.status(503).json({
        error: "Operational health is temporarily unavailable.",
        code: "SERVICE_UNAVAILABLE",
      });
    }
  });
  return router;
}
