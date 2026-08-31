import { Router, type RequestHandler } from "express";
import { z } from "zod";
import {
  reviseDistributedProviderRequestSettingsRequestSchema,
  reviseDistributedProviderRequestSettingsResponseSchema,
  type ReviseDistributedProviderRequestSettingsRequest,
  type ReviseDistributedProviderRequestSettingsResponse,
} from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import { createRequireSession, getAuthenticatedActor } from "../auth/middleware.ts";

const paramsSchema = z.object({
  providerId: z.string().uuid(),
  sourceInstanceId: z.string().uuid(),
}).strict();

export class DistributedProviderRequestSettingsError extends Error {
  constructor(
    readonly code:
      | "SOURCE_NOT_FOUND"
      | "SOURCE_REVISION_CONFLICT"
      | "SOURCE_CONFLICT"
      | "SOURCE_OPERATIONS_UNAVAILABLE",
    readonly status: 404 | 409 | 503,
  ) {
    super("The provider request setting could not be changed.");
  }
}

export interface DistributedProviderRequestSettingsRouterDependencies {
  readonly auth: Pick<AuthService, "resolveSession" | "requirePermission">;
  readonly cookiePolicy: SessionCookiePolicy;
  readonly sameOrigin: RequestHandler;
  readonly requestSettings: Readonly<{
    revise(input: Readonly<{
      organizationId: string;
      operatorId: string;
      providerId: string;
      request: ReviseDistributedProviderRequestSettingsRequest;
    }>): Promise<ReviseDistributedProviderRequestSettingsResponse>;
  }>;
}

/** Only the distributed request-size command; never mounts legacy source actions. */
export function createDistributedProviderRequestSettingsRouter(
  dependencies: DistributedProviderRequestSettingsRouterDependencies,
) {
  const router = Router();
  router.post(
    "/providers/:providerId/sources/:sourceInstanceId/records-per-request",
    dependencies.sameOrigin,
    createRequireSession(dependencies.auth, dependencies.cookiePolicy, {
      csrf: true,
      permission: "providers:manage",
    }),
    async (request, response) => {
      const params = paramsSchema.safeParse(request.params);
      const body = reviseDistributedProviderRequestSettingsRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        response.status(422).json({
          error: "Check the source configuration and try again.",
          code: "INVALID_SOURCE_CONFIGURATION",
        });
        return;
      }
      if (params.data.providerId !== params.data.sourceInstanceId) {
        response.status(404).json({
          error: "The selected provider source was not found.",
          code: "SOURCE_NOT_FOUND",
        });
        return;
      }
      const actor = getAuthenticatedActor(response);
      try {
        const result = await dependencies.requestSettings.revise({
          organizationId: actor.organizationId,
          operatorId: actor.operatorId,
          providerId: params.data.providerId,
          request: body.data,
        });
        response.json(reviseDistributedProviderRequestSettingsResponseSchema.parse(result));
      } catch (error) {
        const known = error instanceof DistributedProviderRequestSettingsError;
        response.status(known ? error.status : 503).json({
          error: "The provider request setting could not be changed. Reload current settings before trying again.",
          code: known ? error.code : "SOURCE_OPERATIONS_UNAVAILABLE",
        });
      }
    },
  );
  return router;
}
