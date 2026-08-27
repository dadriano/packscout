import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { ProviderConfigurationSummary } from "@packscout/contracts";
import {
  type AuthService,
} from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
} from "../auth/middleware.ts";

const providerIdSchema = z.string().uuid("Provider ID must be a UUID.");

export interface ProviderHealthView {
  readonly providerId: string;
  readonly freshnessState: "fresh" | "stale";
  readonly qualityState: "healthy" | "warning" | "degraded";
  readonly activeRun: { id: string; state: "queued" | "running" } | null;
  readonly latestRun: { id: string; state: string } | null;
  readonly lastHeadReachedAt: string | null;
  readonly nextDueAt: string | null;
  readonly openQuarantineCount: number;
  readonly consecutiveFailures: number;
  readonly latestFailureClass: string | null;
  readonly recoveryHint: string;
}

export interface ProviderAdminListItem {
  readonly provider: ProviderConfigurationSummary;
  readonly health: ProviderHealthView;
}

export interface ProvidersRouterDependencies {
  auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  catalog: {
    listProviders(organizationId: string): Promise<readonly ProviderAdminListItem[]>;
    getProvider(
      organizationId: string,
      providerId: string,
    ): Promise<ProviderConfigurationSummary | null>;
  };
  health: {
    getHealth(input: {
      organizationId: string;
      providerId: string;
    }): Promise<ProviderHealthView>;
  };
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
}

function validationError(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the provider configuration and try again.",
    code: "INVALID_PROVIDER_CONFIGURATION",
    details,
  });
}

function serviceError(response: Response, error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PROVIDER_NOT_FOUND"
  ) {
    response.status(404).json({ error: "Provider not found.", code: "PROVIDER_NOT_FOUND" });
    return;
  }
  response.status(503).json({
    error: "Provider operations are temporarily unavailable.",
    code: "SERVICE_UNAVAILABLE",
  });
}

const retiredMutationResponse = {
  error: "Legacy provider configuration mutations are retired. Use Provider Sources.",
  code: "LEGACY_PROVIDER_MUTATION_RETIRED",
  details: {
    replacement: "/api/provider-sources",
  },
} as const;

const retiredMutation: RequestHandler = (_request, response) => {
  response.status(410).json(retiredMutationResponse);
};

export function createProvidersRouter(dependencies: ProvidersRouterDependencies) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });

  router.get("/", read, async (_request, response) => {
    try {
      const authenticated = getAuthenticatedActor(response);
      response.status(200).json({
        items: await dependencies.catalog.listProviders(authenticated.organizationId),
      });
    } catch (error) {
      serviceError(response, error);
    }
  });

  router.get("/:providerId", read, async (request, response) => {
    const providerId = providerIdSchema.safeParse(request.params.providerId);
    if (!providerId.success) return validationError(response, { providerId: providerId.error.issues });
    try {
      const authenticated = getAuthenticatedActor(response);
      const [provider, health] = await Promise.all([
        dependencies.catalog.getProvider(
          authenticated.organizationId,
          providerId.data,
        ),
        dependencies.health.getHealth({
          organizationId: authenticated.organizationId,
          providerId: providerId.data,
        }),
      ]);
      if (!provider) {
        response.status(404).json({
          error: "Provider not found.",
          code: "PROVIDER_NOT_FOUND",
        });
        return;
      }
      response.status(200).json({ provider, health });
    } catch (error) {
      serviceError(response, error);
    }
  });

  // Keep every historical mutation path explicit. Old clients receive a
  // stable migration answer instead of falling through to an accidental 404,
  // while the sole live lifecycle writer remains /api/provider-sources.
  for (const path of [
    "/",
    "/:providerId/revisions",
    "/:providerId/revisions/:revisionId/test",
    "/:providerId/revisions/:revisionId/activate",
    "/:providerId/disable",
    "/:providerId/archive",
  ]) {
    router.post(path, dependencies.sameOrigin, read, retiredMutation);
  }
  return router;
}
