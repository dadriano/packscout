import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import {
  createProviderRequestSchema,
  providerRevisionCommandSchema,
  replaceProviderRevisionRequestSchema,
  type ProviderConfigurationSummary,
} from "@packscout/contracts";
import {
  ProviderConfigurationServiceError,
  type AuthService,
  type ProviderActor,
  type ProviderConfigurationService,
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
  configuration: Pick<
    ProviderConfigurationService,
    | "getProvider"
    | "createProvider"
    | "replaceRevision"
    | "testConnection"
    | "activateRevision"
    | "disableProvider"
    | "archiveProvider"
  >;
  catalog: {
    listProviders(organizationId: string): Promise<readonly ProviderAdminListItem[]>;
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

function actor(response: Response): ProviderActor {
  const authenticated = getAuthenticatedActor(response);
  return {
    operatorId: authenticated.operatorId,
    organizationId: authenticated.organizationId,
    role: authenticated.role,
  };
}

function validationError(response: Response, details: unknown): void {
  response.status(422).json({
    error: "Check the provider configuration and try again.",
    code: "INVALID_PROVIDER_CONFIGURATION",
    details,
  });
}

function serviceError(response: Response, error: unknown): void {
  if (error instanceof ProviderConfigurationServiceError) {
    response.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.current ? { details: { current: error.current } } : {}),
    });
    return;
  }
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

export function createProvidersRouter(dependencies: ProvidersRouterDependencies) {
  const router = Router();
  const read = createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
    permission: "providers:view",
  });
  const mutate = createRequireSession(
    dependencies.auth,
    dependencies.cookiePolicy,
    { csrf: true, permission: "providers:manage" },
  );

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
        dependencies.configuration.getProvider(actor(response), providerId.data),
        dependencies.health.getHealth({
          organizationId: authenticated.organizationId,
          providerId: providerId.data,
        }),
      ]);
      response.status(200).json({ provider, health });
    } catch (error) {
      serviceError(response, error);
    }
  });

  router.post("/", dependencies.sameOrigin, mutate, async (request, response) => {
    const parsed = createProviderRequestSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error.flatten().fieldErrors);
    try {
      const provider = await dependencies.configuration.createProvider(actor(response), parsed.data);
      response.status(201).json({ provider });
    } catch (error) {
      serviceError(response, error);
    }
  });

  router.post("/:providerId/revisions", dependencies.sameOrigin, mutate, async (request, response) => {
    const providerId = providerIdSchema.safeParse(request.params.providerId);
    const body = replaceProviderRevisionRequestSchema.safeParse(request.body);
    if (!providerId.success || !body.success) {
      return validationError(response, {
        ...(!providerId.success ? { providerId: providerId.error.issues } : {}),
        ...(!body.success ? body.error.flatten().fieldErrors : {}),
      });
    }
    try {
      const provider = await dependencies.configuration.replaceRevision(actor(response), providerId.data, body.data);
      response.status(201).json({ provider });
    } catch (error) {
      serviceError(response, error);
    }
  });

  router.post("/:providerId/revisions/:revisionId/test", dependencies.sameOrigin, mutate, async (request, response) => {
    const ids = z.object({ providerId: providerIdSchema, revisionId: z.string().uuid() }).safeParse(request.params);
    if (!ids.success) return validationError(response, ids.error.flatten().fieldErrors);
    try {
      const test = await dependencies.configuration.testConnection(actor(response), ids.data.providerId, ids.data.revisionId);
      response.status(200).json({ test });
    } catch (error) {
      serviceError(response, error);
    }
  });

  router.post(
    "/:providerId/revisions/:revisionId/activate",
    dependencies.sameOrigin,
    mutate,
    async (request, response) => {
      const ids = z.object({ providerId: providerIdSchema, revisionId: z.string().uuid() }).safeParse(request.params);
      if (!ids.success) return validationError(response, ids.error.flatten().fieldErrors);
      try {
        const provider = await dependencies.configuration.activateRevision(
          actor(response),
          ids.data.providerId,
          ids.data.revisionId,
        );
        response.status(200).json({ provider });
      } catch (error) {
        serviceError(response, error);
      }
    },
  );

  const lifecycle = (
    action: "disable" | "archive",
  ): RequestHandler => async (request, response) => {
    const providerId = providerIdSchema.safeParse(request.params.providerId);
    const body = providerRevisionCommandSchema.safeParse(request.body);
    if (!providerId.success || !body.success) {
      return validationError(response, {
        ...(!providerId.success ? { providerId: providerId.error.issues } : {}),
        ...(!body.success ? body.error.flatten().fieldErrors : {}),
      });
    }
    try {
      if (action === "archive") {
        const current = await dependencies.configuration.getProvider(actor(response), providerId.data);
        if (current.state !== "disabled") {
          response.status(409).json({
            error: "Disable the provider before archiving it.",
            code: "PROVIDER_LIFECYCLE_CONFLICT",
          });
          return;
        }
      }
      const provider = await dependencies.configuration[
        action === "disable" ? "disableProvider" : "archiveProvider"
      ](actor(response), providerId.data, body.data.expectedRevisionId);
      response.status(200).json({ provider });
    } catch (error) {
      serviceError(response, error);
    }
  };

  for (const action of ["disable", "archive"] as const) {
    router.post(
      `/:providerId/${action}`,
      dependencies.sameOrigin,
      mutate,
      lifecycle(action),
    );
  }
  return router;
}
