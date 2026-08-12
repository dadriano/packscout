import { Router } from "express";
import {
  createOperatorRequestSchema,
  listOperatorsQuerySchema,
  operatorIdSchema,
  updateOperatorRequestSchema,
} from "@packscout/contracts";
import type { AuthService } from "@packscout/services";
import type { RequestHandler } from "express";
import type { SessionCookiePolicy } from "../auth/cookies.ts";
import {
  createRequireSession,
  getAuthenticatedActor,
  sendAuthServiceError,
} from "../auth/middleware.ts";

export interface OperatorsRouterDependencies {
  service: Pick<
    AuthService,
    | "resolveSession"
    | "requirePermission"
    | "listOperators"
    | "provisionOperator"
    | "updateOperator"
  >;
  cookiePolicy: SessionCookiePolicy;
  sameOrigin: RequestHandler;
}

function sendValidationError(
  response: import("express").Response,
  fieldErrors: Record<string, string[] | undefined>,
): void {
  response.status(422).json({
    error: "Check the operator details and try again.",
    code: "VALIDATION_FAILED",
    details: fieldErrors,
  });
}

export function createOperatorsRouter({
  service,
  cookiePolicy,
  sameOrigin,
}: OperatorsRouterDependencies) {
  const router = Router();
  const requireAdmin = createRequireSession(service, cookiePolicy, {
    permission: "operators:manage",
  });
  const requireAdminMutation = createRequireSession(service, cookiePolicy, {
    csrf: true,
    permission: "operators:manage",
  });

  router.get("/", requireAdmin, async (request, response) => {
    const parsed = listOperatorsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendValidationError(response, parsed.error.flatten().fieldErrors);
      return;
    }
    try {
      const result = await service.listOperators(
        getAuthenticatedActor(response),
        parsed.data,
      );
      response.status(200).json(result);
    } catch (error) {
      sendAuthServiceError(response, error, cookiePolicy);
    }
  });

  router.post("/", sameOrigin, requireAdminMutation, async (request, response) => {
    const parsed = createOperatorRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error.flatten().fieldErrors);
      return;
    }
    try {
      const result = await service.provisionOperator(
        getAuthenticatedActor(response),
        parsed.data,
      );
      response.status(201).json(result);
    } catch (error) {
      sendAuthServiceError(response, error, cookiePolicy);
    }
  });

  router.patch(
    "/:operatorId",
    sameOrigin,
    requireAdminMutation,
    async (request, response) => {
      const operatorId = operatorIdSchema.safeParse(request.params.operatorId);
      const body = updateOperatorRequestSchema.safeParse(request.body);
      if (!operatorId.success || !body.success) {
        sendValidationError(response, {
          ...(operatorId.success
            ? {}
            : { operatorId: operatorId.error.issues.map((issue) => issue.message) }),
          ...(body.success ? {} : body.error.flatten().fieldErrors),
        });
        return;
      }
      try {
        const result = await service.updateOperator(
          getAuthenticatedActor(response),
          operatorId.data,
          body.data,
        );
        response.status(200).json(result);
      } catch (error) {
        sendAuthServiceError(response, error, cookiePolicy);
      }
    },
  );

  return router;
}
